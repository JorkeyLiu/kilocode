import fs from "fs/promises"
import path from "path"
import { existsSync, statSync } from "fs"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../database/database"
import * as Artifact from "../retention/artifact"

export type FileReport = {
  path: string
  exists: boolean
  bytes: number
  mtimeMs?: number
}

export type TableReport = {
  rows: number
  bytes: number
}

export type ArtifactFamilyReport = {
  files: number
  bytes: number
}

export type BaselineReport = {
  version: 1
  timestamp: string
  dataRoot: string
  db: {
    main: FileReport
    wal: FileReport
    shm: FileReport
    export: FileReport
    exportWal: FileReport
    exportShm: FileReport
  }
  tables: Record<string, TableReport>
  artifacts: Record<string, ArtifactFamilyReport> & { snapshot: ArtifactFamilyReport }
  families: {
    total: number
    roots: string[]
  }
  changefeed: {
    latestSeq: number
    retainedRows: number
    retainedBytes: number
  }
  storageIdentity: {
    exists: boolean
    uuid?: string
    schemaVersion?: string
    cutoverArchiveId?: string
    createdAt?: number
  } | null
}

function safeBytes(p: string): number {
  try {
    if (!existsSync(p)) return 0
    return statSync(p).size
  } catch {
    return 0
  }
}

function fileReport(p: string): FileReport {
  try {
    if (!existsSync(p)) return { path: p, exists: false, bytes: 0 }
    const s = statSync(p)
    return { path: p, exists: true, bytes: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return { path: p, exists: false, bytes: 0 }
  }
}

async function artifactFamilyReport(storageDir: string, kind: string): Promise<ArtifactFamilyReport> {
  const dir = path.join(storageDir, kind)
  try {
    await fs.access(dir)
  } catch {
    return { files: 0, bytes: 0 }
  }
  try {
    const entries = await fs.readdir(dir)
    let bytes = 0
    let count = 0
    for (const e of entries) {
      const full = path.join(dir, e)
      try {
        const st = await fs.stat(full)
        if (st.isFile()) {
          count += 1
          bytes += st.size
        }
      } catch {}
    }
    return { files: count, bytes }
  } catch {
    return { files: 0, bytes: 0 }
  }
}

async function snapshotReport(dataRoot: string): Promise<ArtifactFamilyReport> {
  const dir = path.join(dataRoot, "snapshot")
  try {
    await fs.access(dir)
  } catch {
    return { files: 0, bytes: 0 }
  }
  let files = 0
  let bytes = 0
  async function walk(cur: string) {
    let entries: import("fs").Dirent[]
    try {
      entries = (await fs.readdir(cur, { withFileTypes: true } as any)) as any
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile()) {
        files += 1
        try {
          bytes += (await fs.stat(full)).size
        } catch {}
      }
    }
  }
  await walk(dir)
  return { files, bytes }
}

type TableSpec = { name: string; payloadColumn?: string }

const TABLE_SPECS: TableSpec[] = [
  { name: "session" },
  { name: "message", payloadColumn: "data" },
  { name: "part", payloadColumn: "data" },
  { name: "event", payloadColumn: "data" },
  { name: "event_sequence" },
  { name: "session_message" },
  { name: "session_input" },
  { name: "session_context_epoch" },
  { name: "todo" },
  { name: "session_share" },
  { name: "session_changefeed" },
  { name: "session_changefeed_state" },
  { name: "retention_obligation" },
  { name: "session_operation" },
  { name: "session_delete_tombstone" },
  { name: "project" },
  { name: "storage_identity" },
  { name: "migration" },
]

function tableReportEffect(db: Database.Interface["db"], spec: TableSpec) {
  return Effect.gen(function* () {
    const countEff = db.get<{ c: number }>(sql.raw(`SELECT count(*) as c FROM "${spec.name}"`)).pipe(
      Effect.map((r) => (r as any)?.c ?? 0),
      Effect.catch(() => Effect.succeed(0)),
    )
    const rows = yield* countEff
    if (!spec.payloadColumn) return { rows, bytes: 0 } as TableReport
    const bytesEff = db
      .get<{ b: number }>(sql.raw(`SELECT coalesce(sum(length("${spec.payloadColumn}")),0) as b FROM "${spec.name}"`))
      .pipe(
        Effect.map((r) => (r as any)?.b ?? 0),
        Effect.catch(() => Effect.succeed(0)),
      )
    const bytes = yield* bytesEff
    return { rows, bytes } as TableReport
  })
}

export function collectBaseline(dataRoot: string, db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    const absRoot = path.resolve(dataRoot)
    const dbMain = path.join(absRoot, "kilo.db")
    const dbWal = dbMain + "-wal"
    const dbShm = dbMain + "-shm"
    const exportDb = path.join(absRoot, "session-export.db")
    const exportWal = exportDb + "-wal"
    const exportShm = exportDb + "-shm"
    const storageDir = path.join(absRoot, "storage")

    const dbFiles = {
      main: fileReport(dbMain),
      wal: fileReport(dbWal),
      shm: fileReport(dbShm),
      export: fileReport(exportDb),
      exportWal: fileReport(exportWal),
      exportShm: fileReport(exportShm),
    }

    const tables: Record<string, TableReport> = {}
    for (const spec of TABLE_SPECS) {
      const rep = yield* tableReportEffect(db, spec)
      tables[spec.name] = rep
    }

    // families: count roots + list
    let familiesTotal = 0
    let roots: string[] = []
    const rootsEff = db.all<{ id: string }>(sql`SELECT id FROM session WHERE parent_id IS NULL`).pipe(
      Effect.map((rows) => rows.map((r) => r.id)),
      Effect.catch(() => Effect.succeed([] as string[])),
    )
    roots = yield* rootsEff
    familiesTotal = roots.length

    // changefeed state
    let changefeed = { latestSeq: 0, retainedRows: 0, retainedBytes: 0 }
    const cfState = yield* db
      .get<{
        latest_seq: number
        retained_rows: number
        retained_bytes: number
      }>(sql`SELECT latest_seq, retained_rows, retained_bytes FROM session_changefeed_state WHERE id = 1`)
      .pipe(
        Effect.map((r) => r as any),
        Effect.catch(() => Effect.succeed(undefined)),
      )
    if (cfState) {
      changefeed = {
        latestSeq: (cfState as any).latest_seq ?? 0,
        retainedRows: (cfState as any).retained_rows ?? 0,
        retainedBytes: (cfState as any).retained_bytes ?? 0,
      }
    }

    // storage identity
    let storageIdentity: BaselineReport["storageIdentity"] = null
    const ident = yield* db
      .get<{
        uuid: string
        schema_version: string
        cutover_archive_id: string
        created_at: number
      }>(sql`SELECT uuid, schema_version, cutover_archive_id, created_at FROM storage_identity WHERE id = 1`)
      .pipe(
        Effect.map((r) => r as any),
        Effect.catch(() => Effect.succeed(undefined)),
      )
    if (ident) {
      storageIdentity = {
        exists: true,
        uuid: (ident as any).uuid,
        schemaVersion: (ident as any).schema_version,
        cutoverArchiveId: (ident as any).cutover_archive_id,
        createdAt: (ident as any).created_at,
      }
    } else {
      const hasTable = tables["storage_identity"]?.rows ?? 0
      storageIdentity = hasTable === 0 ? null : { exists: false }
    }

    // artifacts (fs)
    const artifacts: BaselineReport["artifacts"] = {
      snapshot: { files: 0, bytes: 0 },
    } as any
    for (const kind of Artifact.FamilyArtifactKind) {
      const rep = yield* Effect.promise(() => artifactFamilyReport(storageDir, kind))
      artifacts[kind] = rep
    }
    const snap = yield* Effect.promise(() => snapshotReport(absRoot))
    artifacts["snapshot"] = snap
    // also report raw storage dir missing as zero
    // ensure snapshot note is not mutated; baseline is pure

    const report: BaselineReport = {
      version: 1,
      timestamp: new Date().toISOString(),
      dataRoot: absRoot,
      db: dbFiles,
      tables,
      artifacts: artifacts as any,
      families: { total: familiesTotal, roots: [...roots].sort() },
      changefeed,
      storageIdentity,
    }
    return report
  })
}

// Non-Effect helper for scripts: uses bun:sqlite readonly if available, else falls back to fs-only
export async function collectBaselineFsOnly(dataRoot: string): Promise<BaselineReport> {
  const absRoot = path.resolve(dataRoot)
  const dbMain = path.join(absRoot, "kilo.db")
  const dbWal = dbMain + "-wal"
  const dbShm = dbMain + "-shm"
  const exportDb = path.join(absRoot, "session-export.db")
  const storageDir = path.join(absRoot, "storage")

  const dbFiles = {
    main: fileReport(dbMain),
    wal: fileReport(dbWal),
    shm: fileReport(dbShm),
    export: fileReport(exportDb),
    exportWal: fileReport(exportDb + "-wal"),
    exportShm: fileReport(exportDb + "-shm"),
  }

  // tables via readonly sqlite if db exists
  const tables: Record<string, TableReport> = {}
  for (const spec of TABLE_SPECS) tables[spec.name] = { rows: 0, bytes: 0 }
  let families = { total: 0, roots: [] as string[] }
  let changefeed = { latestSeq: 0, retainedRows: 0, retainedBytes: 0 }
  let storageIdentity: BaselineReport["storageIdentity"] = null

  if (dbFiles.main.exists) {
    try {
      const { Database } = await import("bun:sqlite")
      const db = new Database(dbMain, { readonly: true, create: false } as any)
      try {
        for (const spec of TABLE_SPECS) {
          try {
            const row = db.query(`SELECT count(*) as c FROM "${spec.name}"`).get() as any
            const c = row?.c ?? row?.["count(*)"] ?? 0
            tables[spec.name]!.rows = Number(c) || 0
            if (spec.payloadColumn) {
              try {
                const bRow = db
                  .query(`SELECT coalesce(sum(length("${spec.payloadColumn}")),0) as b FROM "${spec.name}"`)
                  .get() as any
                tables[spec.name]!.bytes = Number(bRow?.b ?? 0) || 0
              } catch {}
            }
          } catch {}
        }
        try {
          const rows = db.query(`SELECT id FROM session WHERE parent_id IS NULL`).all() as any[]
          families = { total: rows.length, roots: rows.map((r) => r.id).sort() }
        } catch {}
        try {
          const cf = db
            .query(`SELECT latest_seq, retained_rows, retained_bytes FROM session_changefeed_state WHERE id = 1`)
            .get() as any
          if (cf)
            changefeed = {
              latestSeq: cf.latest_seq ?? 0,
              retainedRows: cf.retained_rows ?? 0,
              retainedBytes: cf.retained_bytes ?? 0,
            }
        } catch {}
        try {
          const ident = db
            .query(`SELECT uuid, schema_version, cutover_archive_id, created_at FROM storage_identity WHERE id = 1`)
            .get() as any
          if (ident)
            storageIdentity = {
              exists: true,
              uuid: ident.uuid,
              schemaVersion: ident.schema_version,
              cutoverArchiveId: ident.cutover_archive_id,
              createdAt: ident.created_at,
            }
          else storageIdentity = null
        } catch {
          storageIdentity = null
        }
      } finally {
        try {
          db.close()
        } catch {}
      }
    } catch {}
  }

  const artifacts: any = {}
  for (const kind of Artifact.FamilyArtifactKind) {
    artifacts[kind] = await artifactFamilyReport(storageDir, kind)
  }
  artifacts.snapshot = await snapshotReport(absRoot)

  return {
    version: 1,
    timestamp: new Date().toISOString(),
    dataRoot: absRoot,
    db: dbFiles,
    tables,
    artifacts,
    families,
    changefeed,
    storageIdentity,
  }
}

export function formatBaseline(report: BaselineReport): string {
  return JSON.stringify(report, null, 2)
}

export * as Baseline from "./baseline"
