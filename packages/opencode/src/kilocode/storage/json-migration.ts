import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite"
import { Database as BunDatabase } from "bun:sqlite"
import { Global } from "@opencode-ai/core/global"
import { Database } from "@opencode-ai/core/database/database"
import * as Log from "@opencode-ai/core/util/log"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable, MessageTable, PartTable, TodoTable } from "@opencode-ai/core/session/sql"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import path from "path"
import { existsSync } from "fs"
import { Filesystem } from "@/util/filesystem"
import { Glob } from "@opencode-ai/core/util/glob"
import { EOL } from "os"
import { Effect } from "effect"
import { errorMessage } from "@/util/error"

const log = Log.create({ service: "json-migration" })

const usage = `
  UPDATE session
  SET
    cost = coalesce((
      SELECT sum(coalesce(json_extract(message.data, '$.cost'), 0))
      FROM message
      WHERE message.session_id = session.id
        AND json_extract(message.data, '$.role') = 'assistant'
    ), 0),
    tokens_input = coalesce((
      SELECT sum(coalesce(json_extract(message.data, '$.tokens.input'), 0))
      FROM message
      WHERE message.session_id = session.id
        AND json_extract(message.data, '$.role') = 'assistant'
    ), 0),
    tokens_output = coalesce((
      SELECT sum(coalesce(json_extract(message.data, '$.tokens.output'), 0))
      FROM message
      WHERE message.session_id = session.id
        AND json_extract(message.data, '$.role') = 'assistant'
    ), 0),
    tokens_reasoning = coalesce((
      SELECT sum(coalesce(json_extract(message.data, '$.tokens.reasoning'), 0))
      FROM message
      WHERE message.session_id = session.id
        AND json_extract(message.data, '$.role') = 'assistant'
    ), 0),
    tokens_cache_read = coalesce((
      SELECT sum(coalesce(json_extract(message.data, '$.tokens.cache.read'), 0))
      FROM message
      WHERE message.session_id = session.id
        AND json_extract(message.data, '$.role') = 'assistant'
    ), 0),
    tokens_cache_write = coalesce((
      SELECT sum(coalesce(json_extract(message.data, '$.tokens.cache.write'), 0))
      FROM message
      WHERE message.session_id = session.id
        AND json_extract(message.data, '$.role') = 'assistant'
    ), 0)
`

export type Progress = {
  current: number
  total: number
  label: string
}

type Options = {
  progress?: (event: Progress) => void
}

export async function bootstrap() {
  const marker = Database.path()
  if (marker === ":memory:") return
  const pending = marker + ".json-migration"
  if ((await Filesystem.exists(marker)) && !(await Filesystem.exists(pending))) return
  await Filesystem.write(pending, "1")

  const tty = process.stderr.isTTY
  process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
  const width = 36
  const orange = "\x1b[38;5;214m"
  const muted = "\x1b[0;2m"
  const reset = "\x1b[0m"
  let last = -1
  if (tty) process.stderr.write("\x1b[?25l")
  try {
    await Effect.runPromise(Database.Service.use(() => Effect.void).pipe(Effect.provide(Database.defaultLayer)))
    const sqlite = new BunDatabase(marker)
    try {
      const stats = await run(drizzle({ client: sqlite }), {
        progress: (event) => {
          const percent = Math.floor((event.current / event.total) * 100)
          if (percent === last && event.current !== event.total) return
          last = percent
          if (tty) {
            const fill = Math.round((percent / 100) * width)
            const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
            process.stderr.write(
              `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
            )
            if (event.current === event.total) process.stderr.write(EOL)
            return
          }
          process.stderr.write(`sqlite-migration:${percent}${EOL}`)
        },
      })
      if (stats.errors.length > 0) {
        process.stderr.write("Database migration incomplete; retrying on next start." + EOL)
        return
      }
    } finally {
      sqlite.close()
    }
  } finally {
    if (tty) process.stderr.write("\x1b[?25h")
    else process.stderr.write(`sqlite-migration:done${EOL}`)
  }
  await Bun.file(pending).delete()
  process.stderr.write("Database migration complete." + EOL)
}

export async function run(db: SQLiteBunDatabase | NodeSQLiteDatabase, options?: Options) {
  const storageDir = path.join(Global.Path.data, "storage")

  if (!existsSync(storageDir)) {
    log.info("storage directory does not exist, skipping migration")
    return {
      projects: 0,
      sessions: 0,
      messages: 0,
      parts: 0,
      todos: 0,
      permissions: 0,
      shares: 0,
      errors: [] as string[],
    }
  }

  log.info("starting json to sqlite migration", { storageDir })
  const start = performance.now()

  // Optimize SQLite for bulk inserts
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA synchronous = OFF")
  db.run("PRAGMA cache_size = 10000")
  db.run("PRAGMA temp_store = MEMORY")
  db.run("PRAGMA foreign_keys = ON")
  const stats = {
    projects: 0,
    sessions: 0,
    messages: 0,
    parts: 0,
    todos: 0,
    permissions: 0,
    shares: 0,
    errors: [] as string[],
  }
  const orphans = {
    sessions: 0,
    todos: 0,
    shares: 0,
  }
  const errs = stats.errors

  const batchSize = 1000
  const now = Date.now()

  async function list(pattern: string) {
    return Glob.scan(pattern, { cwd: storageDir, absolute: true })
  }

  // Read files, throwing on any failure. Used inside family SAVEPOINTs
  // so that a single unreadable child rolls back the entire family.
  async function readOrThrow(files: string[]) {
    if (files.length === 0) return []
    const tasks = files.map((f) => Filesystem.readJson(f))
    const results = await Promise.allSettled(tasks)
    // oxlint-disable-next-line unicorn/no-new-array -- pre-allocated for index-based fill, returns any[] for property access
    const items = new Array(results.length)
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === "fulfilled") {
        items[i] = r.value
        continue
      }
      throw new Error(`failed to read ${files[i]}: ${r.reason}`)
    }
    return items
  }

  // Read files, collecting errors without throwing. Used for non-family
  // entities (projects, shares) where individual read failures are logged
  // and skipped rather than fatal. Preserves index alignment: items[i]
  // corresponds to files[i], with undefined for failed reads.
  async function readLenient(files: string[]) {
    if (files.length === 0) return []
    const tasks = files.map((f) => Filesystem.readJson(f))
    const results = await Promise.allSettled(tasks)
    // oxlint-disable-next-line unicorn/no-new-array -- pre-allocated for index-aligned fill
    const items = new Array(results.length)
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === "fulfilled") {
        items[i] = r.value
        continue
      }
      errs.push(`failed to read ${files[i]}: ${r.reason}`)
    }
    return items
  }

  // Insert that throws on failure. Used inside family SAVEPOINTs so that
  // constraint violations or other DB errors trigger family rollback.
  function insertRows(values: unknown[], table: Parameters<typeof db.insert>[0]) {
    if (values.length === 0) return 0
    db.insert(table).values(values).onConflictDoNothing().run()
    return values.length
  }

  // Insert that catches and logs errors. Used for non-family entities
  // (projects, shares) where individual insert failures are non-fatal.
  function insertSafe(values: unknown[], table: Parameters<typeof db.insert>[0], label: string) {
    if (values.length === 0) return 0
    try {
      db.insert(table).values(values).onConflictDoNothing().run()
      return values.length
    } catch (e) {
      errs.push(`failed to migrate ${label} batch: ${errorMessage(e)}`)
      return 0
    }
  }

  // Scan only projects, sessions, permissions, and shares upfront.
  // Message, part, and todo files are enumerated per-family during the
  // session loop, keeping memory bounded by family size rather than the
  // total store.
  log.info("scanning files...")
  const [projectFiles, sessionFiles, permFiles, shareFiles] = await Promise.all([
    list("project/*.json"),
    list("session/*/*.json"),
    list("permission/*.json"),
    list("session_share/*.json"),
  ])

  log.info("file scan complete", {
    projects: projectFiles.length,
    sessions: sessionFiles.length,
    permissions: permFiles.length,
    shares: shareFiles.length,
  })

  const total = Math.max(1, projectFiles.length + sessionFiles.length + permFiles.length + shareFiles.length)
  const progress = options?.progress
  let current = 0
  const step = (label: string, count: number) => {
    current = Math.min(total, current + count)
    progress?.({ current, total, label })
  }

  progress?.({ current, total, label: "starting" })

  db.run("BEGIN TRANSACTION")
  try {
    // Migrate projects first (no FK deps). Reads are lenient: a broken
    // project file is logged and skipped; it does not abort the migration.
    const projectIds = new Set<string>()
    const projectValues: unknown[] = []
    for (let i = 0; i < projectFiles.length; i += batchSize) {
      const end = Math.min(i + batchSize, projectFiles.length)
      const batch = await readLenient(projectFiles.slice(i, end))
      projectValues.length = 0
      for (let j = 0; j < batch.length; j++) {
        const data = batch[j]
        if (!data) continue
        const id = path.basename(projectFiles[i + j], ".json")
        projectIds.add(id)
        projectValues.push({
          id,
          worktree: data.worktree ?? "/",
          vcs: data.vcs,
          name: data.name ?? undefined,
          icon_url: data.icon?.url,
          icon_url_override: data.icon?.override,
          icon_color: data.icon?.color,
          time_created: data.time?.created ?? now,
          time_updated: data.time?.updated ?? now,
          time_initialized: data.time?.initialized,
          sandboxes: data.sandboxes ?? [],
          commands: data.commands,
        })
      }
      stats.projects += insertSafe(projectValues, ProjectTable, "project")
      step("projects", end - i)
    }
    log.info("migrated projects", { count: stats.projects, duration: Math.round(performance.now() - start) })

    // Migrate session families atomically. Each family = session + its
    // messages + its parts + its todos. A SAVEPOINT wraps each family:
    // on any read or insert failure within the family, ROLLBACK TO SAVEPOINT
    // removes all writes for that family. Later families are unaffected.
    // Message, part, and todo files are enumerated per-family from the
    // filesystem layout (message/{sessionID}/*.json, part/{messageID}/*.json,
    // todo/{sessionID}.json), keeping memory bounded.
    const sessionIds = new Set<string>()

    for (let i = 0; i < sessionFiles.length; i++) {
      const sessionFile = sessionFiles[i]
      const projectID = path.basename(path.dirname(sessionFile))
      const sessionID = path.basename(sessionFile, ".json")

      if (!projectIds.has(projectID)) {
        orphans.sessions++
        step("sessions", 1)
        continue
      }

      const sp = `fam_${i}`
      db.run(`SAVEPOINT ${sp}`)
      let failed = false
      let failMsg = ""

      // Per-family local counters: only committed to stats on success.
      let fSessions = 0
      let fMessages = 0
      let fParts = 0
      let fTodos = 0

      try {
        // Read session data
        const [sessionData] = await readOrThrow([sessionFile])
        if (!sessionData) throw new Error(`session unreadable: ${sessionFile}`)

        // Insert session row
        fSessions += insertRows(
          [
            {
              id: sessionID,
              project_id: projectID,
              parent_id: sessionData.parentID ?? null,
              slug: sessionData.slug ?? "",
              directory: sessionData.directory ?? "",
              path: sessionData.path ?? null,
              title: sessionData.title ?? "",
              version: sessionData.version ?? "",
              share_url: sessionData.share?.url ?? null,
              summary_additions: sessionData.summary?.additions ?? null,
              summary_deletions: sessionData.summary?.deletions ?? null,
              summary_files: sessionData.summary?.files ?? null,
              summary_diffs: sessionData.summary?.diffs ?? null,
              cost: 0,
              tokens_input: 0,
              tokens_output: 0,
              tokens_reasoning: 0,
              tokens_cache_read: 0,
              tokens_cache_write: 0,
              revert: sessionData.revert ?? null,
              permission: sessionData.permission ?? null,
              time_created: sessionData.time?.created ?? now,
              time_updated: sessionData.time?.updated ?? now,
              time_compacting: sessionData.time?.compacting ?? null,
              time_archived: sessionData.time?.archived ?? null,
            },
          ],
          SessionTable,
        )

        // Enumerate and insert messages for this session.
        // Glob is scoped to message/{sessionID}/*.json — bounded by family.
        const msgFiles = await list(`message/${sessionID}/*.json`)
        if (msgFiles.length > 0) {
          const msgDataBatch = await readOrThrow(msgFiles)
          // oxlint-disable-next-line unicorn/no-new-array -- pre-allocated for index-based fill
          const msgValues = new Array(msgFiles.length)
          let msgCount = 0
          for (let j = 0; j < msgFiles.length; j++) {
            const data = msgDataBatch[j]
            if (!data) continue
            const id = path.basename(msgFiles[j], ".json")
            const rest = data
            delete rest.id
            delete rest.sessionID
            msgValues[msgCount++] = {
              id,
              session_id: sessionID,
              time_created: data.time?.created ?? now,
              time_updated: data.time?.updated ?? now,
              data: rest,
            }
          }
          msgValues.length = msgCount
          fMessages += insertRows(msgValues, MessageTable)
        }

        // Enumerate and insert parts for this session's messages.
        // Glob is scoped to part/{messageID}/*.json per message — bounded.
        for (const msgFile of msgFiles) {
          const msgId = path.basename(msgFile, ".json")
          const partFilesForMsg = await list(`part/${msgId}/*.json`)
          if (partFilesForMsg.length > 0) {
            const partDataBatch = await readOrThrow(partFilesForMsg)
            // oxlint-disable-next-line unicorn/no-new-array -- pre-allocated for index-based fill
            const partValues = new Array(partFilesForMsg.length)
            let partCount = 0
            for (let j = 0; j < partFilesForMsg.length; j++) {
              const data = partDataBatch[j]
              if (!data) continue
              const id = path.basename(partFilesForMsg[j], ".json")
              const rest = data
              delete rest.id
              delete rest.messageID
              delete rest.sessionID
              partValues[partCount++] = {
                id,
                message_id: msgId,
                session_id: sessionID,
                time_created: data.time?.created ?? now,
                time_updated: data.time?.updated ?? now,
                data: rest,
              }
            }
            partValues.length = partCount
            fParts += insertRows(partValues, PartTable)
          }
        }

        // Enumerate and insert todos for this session.
        // Glob is scoped to todo/{sessionID}.json — bounded.
        const todoMatch = await list(`todo/${sessionID}.json`)
        if (todoMatch.length > 0) {
          const [todoData] = await readOrThrow(todoMatch)
          if (Array.isArray(todoData)) {
            const todoValues: unknown[] = []
            for (let position = 0; position < todoData.length; position++) {
              const todo = todoData[position]
              if (!todo?.content || !todo?.status || !todo?.priority) continue
              todoValues.push({
                session_id: sessionID,
                content: todo.content,
                status: todo.status,
                priority: todo.priority,
                position,
                time_created: now,
                time_updated: now,
              })
            }
            fTodos += insertRows(todoValues, TodoTable)
          } else if (todoData !== undefined) {
            throw new Error(`todo not an array: ${todoMatch[0]}`)
          }
        }
      } catch (e) {
        failed = true
        failMsg = errorMessage(e)
      }

      if (failed) {
        // Rollback and release the family savepoint. After a successful
        // ROLLBACK TO SAVEPOINT the savepoint must be RELEASEd so no stale
        // savepoint remains active. Both rollback and release failures are
        // captured alongside the original family error so nothing is lost.
        // If rollback fails, the transaction is in an undefined state:
        // throw to the outer catch so it executes ROLLBACK and COMMIT is
        // impossible. Same if rollback succeeds but release fails — a
        // stale savepoint makes later operations unsafe.
        let rbErr = ""
        try {
          db.run(`ROLLBACK TO SAVEPOINT ${sp}`)
        } catch (rb) {
          rbErr = errorMessage(rb)
          errs.push(`family ${sessionID}: rollback failed: ${rbErr}; original: ${failMsg}`)
        }
        let relErr = ""
        try {
          db.run(`RELEASE SAVEPOINT ${sp}`)
        } catch (rel) {
          relErr = errorMessage(rel)
          errs.push(`family ${sessionID}: release failed: ${relErr}; original: ${failMsg}`)
        }
        errs.push(`family ${sessionID}: ${failMsg}`)

        if (rbErr) {
          throw new Error(
            `family ${sessionID}: rollback failed: ${rbErr}; release: ${relErr || "ok"}; original: ${failMsg}`,
          )
        }
        if (relErr) {
          throw new Error(`family ${sessionID}: release after rollback failed: ${relErr}; original: ${failMsg}`)
        }

        orphans.sessions++
      } else {
        db.run(`RELEASE SAVEPOINT ${sp}`)
        sessionIds.add(sessionID)
        stats.sessions += fSessions
        stats.messages += fMessages
        stats.parts += fParts
        stats.todos += fTodos
      }

      step("sessions", 1)
    }
    log.info("migrated sessions", { count: stats.sessions })
    if (orphans.sessions > 0) {
      log.warn("skipped orphaned sessions", { count: orphans.sessions })
    }

    // Compute usage aggregates from migrated messages
    db.run(usage)
    log.info("migrated todos", { count: stats.todos })
    if (orphans.todos > 0) {
      log.warn("skipped orphaned todos", { count: orphans.todos })
    }

    // The current permission table stores saved resource approvals, not legacy
    // allow/ask/deny rules. Existing SQLite upgrades drop those old rules too.
    if (permFiles.length > 0) log.info("skipped incompatible legacy permission rules", { count: permFiles.length })
    step("permissions", permFiles.length)

    // Migrate session shares. Reads are lenient; shares for families that
    // failed to migrate are treated as orphans.
    const shareSessions = shareFiles.map((file) => path.basename(file, ".json"))
    const shareValues: unknown[] = []
    for (let i = 0; i < shareFiles.length; i += batchSize) {
      const end = Math.min(i + batchSize, shareFiles.length)
      const batch = await readLenient(shareFiles.slice(i, end))
      shareValues.length = 0
      for (let j = 0; j < batch.length; j++) {
        const data = batch[j]
        if (!data) continue
        const sessionID = shareSessions[i + j]
        if (!sessionIds.has(sessionID)) {
          orphans.shares++
          continue
        }
        if (!data?.id || !data?.secret || !data?.url) {
          errs.push(`session_share missing id/secret/url: ${shareFiles[i + j]}`)
          continue
        }
        shareValues.push({ session_id: sessionID, id: data.id, secret: data.secret, url: data.url })
      }
      stats.shares += insertSafe(shareValues, SessionShareTable, "session_share")
      step("shares", end - i)
    }
    log.info("migrated session shares", { count: stats.shares })
    if (orphans.shares > 0) {
      log.warn("skipped orphaned session shares", { count: orphans.shares })
    }

    db.run("COMMIT")
  } catch (e) {
    // Outer transaction safety: if anything above the per-family SAVEPOINTs
    // throws (e.g. project insert, share insert, COMMIT itself), roll back
    // the entire outer transaction. Per-family failures are caught by their
    // own SAVEPOINTs and do not reach here.
    let rollbackErr: unknown
    try {
      db.run("ROLLBACK")
    } catch (rb) {
      rollbackErr = rb
      log.error("outer transaction rollback failed", {
        rollbackError: errorMessage(rb),
        originalError: errorMessage(e),
      })
    }
    if (rollbackErr !== undefined) {
      throw new Error(
        `outer transaction failed: ${errorMessage(e)}; rollback also failed: ${errorMessage(rollbackErr)}`,
      )
    }
    throw e
  }

  log.info("json migration complete", {
    projects: stats.projects,
    sessions: stats.sessions,
    messages: stats.messages,
    parts: stats.parts,
    todos: stats.todos,
    permissions: stats.permissions,
    shares: stats.shares,
    errorCount: stats.errors.length,
    duration: Math.round(performance.now() - start),
  })

  if (stats.errors.length > 0) {
    log.warn("migration errors", { errors: stats.errors.slice(0, 20) })
  }

  progress?.({ current: total, total, label: "complete" })

  return stats
}

export * as JsonMigration from "./json-migration"
