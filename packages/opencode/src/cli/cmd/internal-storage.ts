import type { Argv } from "yargs"
import { cmd } from "./cmd"
import path from "path"
import fsp from "fs/promises"

/**
 * Hidden internal storage cutover command.
 * Not a public product surface. Resolve same data path as normal runtime,
 * acquire cross-process lease before any DB work, emit actionable JSON.
 * Hidden via describe:false so help omits it and no SDK generation picks it up.
 */
export const InternalStorageCommand = cmd<{}, { op: string; dataRoot?: string; archivePath?: string; archiveID?: string }>({
  command: "__internal-storage-cutover <op>",
  describe: false as unknown as string,
  builder: (yargs: Argv) =>
    yargs
      .positional("op", {
        describe: "cutover | recover | rollback",
        type: "string",
        demandOption: true,
      } as any)
      .option("data-root", {
        type: "string",
        describe: "data root dir (defaults to production path)",
      })
      .option("archive-path", {
        type: "string",
        describe: "archive path for rollback",
      })
      .option("archive-id", {
        type: "string",
        describe: "archive id for cutover",
      } as any)
      .strict(false) as Argv<any>,
  handler: async (args: any) => {
    const op = String(args.op)
    // Resolve dataRoot same as normal runtime, without loading AppLayer
    let dataRoot: string
    if (args.dataRoot) {
      dataRoot = path.resolve(String(args.dataRoot))
    } else {
      const { Database } = await import("@opencode-ai/core/database/database")
      const file = Database.path()
      if (file === ":memory:") throw new Error("in-memory DB not supported for internal cutover")
      dataRoot = path.dirname(path.resolve(file))
    }

    // No AppLayer loaded before this point - acquire lease inside cutover/rollback modules

    if (op === "status") {
      const { deriveArchive } = await import("@opencode-ai/core/cutover/archive-path")
      const { leasePathFor } = await import("@opencode-ai/core/cutover/lease")
      const root = path.resolve(dataRoot)
      const { parent, base } = deriveArchive(root)
      const cutoverMarker = path.join(parent, `.cutover-${base}.marker.json`)
      const rollbackMarker = path.join(parent, `.rollback-${base}.marker.json`)
      const leasePath = leasePathFor(root)
      const exists = async (p: string) => {
        try {
          await fsp.access(p)
          return true
        } catch {
          return false
        }
      }
      if (await exists(cutoverMarker)) throw new Error(`DB activation blocked: marker exists at ${cutoverMarker} - recovery required`)
      if (await exists(rollbackMarker)) throw new Error(`DB activation blocked: marker exists at ${rollbackMarker} - recovery required`)
      if (await exists(leasePath)) {
        let raw: string
        try {
          raw = await fsp.readFile(leasePath, "utf8")
        } catch {
          throw new Error(`lease read failed ${leasePath} - fail closed`)
        }
        let data: any
        try {
          data = JSON.parse(raw)
        } catch {
          throw new Error(`lease corrupt ${leasePath} - fail closed, manual recovery required`)
        }
        if (!data || typeof data.pid !== "number" || typeof data.token !== "string") {
          throw new Error(`lease corrupt ${leasePath} - fail closed`)
        }
        let alive = false
        try {
          process.kill(data.pid, 0)
          alive = true
        } catch (e: any) {
          if (e.code === "ESRCH") alive = false
          else if (e.code === "EPERM") alive = true
          else alive = true
        }
        if (alive) throw new Error(`lease held by live PID ${data.pid} at ${leasePath} - exclusivity cannot be proven`)
      }
      const dbPath = path.join(root, "kilo.db")
      let hasDb = false
      try {
        await fsp.access(dbPath)
        hasDb = true
      } catch {
        hasDb = false
      }
      if (!hasDb) {
        console.log(JSON.stringify({ ok: true, op, hasDb: false, hasIdentity: false, canonical: false, dataRoot: root, dbPath }))
        return
      }
      // Genuinely read-only: Bun sqlite readonly, no create, no migrations/PRAGMAs side-effect, no user DB modifications.
      // Inspect identity table if present, reject malformed with explicit checks, recognize legacy read-only.
      let hasIdentity = false
      let canonical = false
      let archiveID: string | undefined
      let statusError: unknown
      let dbRO: any = undefined
      try {
        const { Database: BunDB } = await import("bun:sqlite")
        try {
          dbRO = new (BunDB as any)(dbPath, { readonly: true, create: false } as any)
        } catch (e) {
          throw new Error(`status check failed for ${dbPath}: readonly open failed ${String((e as any)?.message ?? e)}`)
        }
        let row: any
        try {
          row = dbRO.query("SELECT uuid, schema_version, cutover_archive_id FROM storage_identity WHERE id = 1").get() as any
        } catch (e: any) {
          const msg = String(e?.message ?? e)
          if (msg.includes("no such table")) {
            row = undefined
          } else {
            throw new Error(`status check failed for ${dbPath}: ${msg}`)
          }
        }
        if (!row) {
          hasIdentity = false
          canonical = false
        } else {
          const isUUID = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
          const isValidArchiveID = (id: string) => /^\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
          if (!isUUID(row.uuid)) throw new Error(`invalid storage uuid ${row.uuid}`)
          if (row.schema_version !== "1") throw new Error(`schema version mismatch ${row.schema_version}`)
          if (!row.cutover_archive_id || !isValidArchiveID(row.cutover_archive_id)) throw new Error(`invalid cutover archive id ${row.cutover_archive_id}`)
          let av: any
          try {
            av = dbRO.query("PRAGMA auto_vacuum").get() as any
          } catch (e: any) {
            throw new Error(`status check failed for ${dbPath}: ${String(e?.message ?? e)}`)
          }
          if ((av as any)?.auto_vacuum !== 2) throw new Error(`auto_vacuum must be 2, got ${(av as any)?.auto_vacuum}`)
          try {
            const cnt = dbRO.query("SELECT count(*) as c FROM storage_identity").get() as any
            if ((cnt as any)?.c !== 1) throw new Error(`storage_identity must have 1 row, got ${(cnt as any)?.c}`)
          } catch (e: any) {
            const msg = String(e?.message ?? e)
            if (msg.includes("storage_identity must have 1 row")) throw e
            throw new Error(`status check failed for ${dbPath}: ${msg}`)
          }
          hasIdentity = true
          canonical = true
          archiveID = row.cutover_archive_id as string
        }
      } catch (e) {
        statusError = e
      } finally {
        try {
          if (dbRO) dbRO.close()
        } catch {}
      }
      if (statusError) {
        const msg = String((statusError as any)?.message ?? statusError)
        if (msg.includes("invalid storage uuid") || msg.includes("schema version") || msg.includes("invalid cutover") || msg.includes("auto_vacuum") || msg.includes("storage_identity must have 1 row")) {
          throw statusError
        }
        throw new Error(`status check failed for ${dbPath}: ${msg}`)
      }
      console.log(
        JSON.stringify({ ok: true, op, hasDb: true, hasIdentity, canonical, dataRoot: root, dbPath, archiveID: archiveID ?? undefined }),
      )
      return
    }

    if (op === "cutover") {
      const archiveID = args.archiveID ? String(args.archiveID) : undefined
      const { isValidArchiveID } = await import("@opencode-ai/core/cutover/util")
      if (archiveID && !isValidArchiveID(archiveID)) throw new Error(`invalid archiveID ${archiveID}`)
      const dbPath = path.join(path.resolve(dataRoot), "kilo.db")
      let hasDb = false
      try {
        await fsp.access(dbPath)
        hasDb = true
      } catch {
        hasDb = false
      }
      if (!hasDb) {
        // Fresh first-time startup: initialize canonical without archive under lease
        const { makeArchiveID } = await import("@opencode-ai/core/cutover/archive-path")
        const { acquireLease } = await import("@opencode-ai/core/cutover/lease")
        const { bootstrapFreshStaged } = await import("@opencode-ai/core/cutover/cutover")
        const { fsyncDir } = await import("@opencode-ai/core/cutover/util")
        const freshID = archiveID ?? makeArchiveID()
        if (!isValidArchiveID(freshID)) throw new Error(`invalid archiveID ${freshID}`)
        const lease = await acquireLease(path.resolve(dataRoot))
        try {
          const { recoverCutover } = await import("@opencode-ai/core/cutover/cutover")
          const { recoverRollback } = await import("@opencode-ai/core/cutover/rollback")
          await recoverCutover(path.resolve(dataRoot))
          await recoverRollback(path.resolve(dataRoot))
          // Re-check if now has DB (race)
          let stillNoDb = false
          try {
            await fsp.access(dbPath)
            stillNoDb = false
          } catch {
            stillNoDb = true
          }
          if (!stillNoDb) {
            // Another process created DB, delegate to normal cutover path
            const { runCutover } = await import("@opencode-ai/core/cutover/cutover")
            const res = await runCutover({ dataRoot, archiveID: freshID })
            console.log(JSON.stringify({ ok: true, op, archiveID: res.archiveID, archivePath: res.archivePath }))
            return
          }
          // Ensure parent exists
          await fsp.mkdir(path.dirname(path.resolve(dataRoot)), { recursive: true })
          await bootstrapFreshStaged(path.resolve(dataRoot), freshID)
          // Verify gate implicitly via bootstrapFreshStaged's internal verifyGate
          await fsyncDir(path.dirname(path.resolve(dataRoot)))
          console.log(JSON.stringify({ ok: true, op, archiveID: freshID, archivePath: "", fresh: true }))
          return
        } finally {
          await lease.release()
        }
      }
      const { runCutover } = await import("@opencode-ai/core/cutover/cutover")
      const res = await runCutover({ dataRoot, archiveID })
      console.log(JSON.stringify({ ok: true, op, archiveID: res.archiveID, archivePath: res.archivePath }))
      return
    }
    if (op === "recover") {
      const { recoverCutover } = await import("@opencode-ai/core/cutover/cutover")
      const { recoverRollback } = await import("@opencode-ai/core/cutover/rollback")
      await recoverCutover(dataRoot)
      await recoverRollback(dataRoot)
      console.log(JSON.stringify({ ok: true, op }))
      return
    }
    if (op === "rollback") {
      const archivePath = args.archivePath ? String(args.archivePath) : args._?.[1] ? String(args._[1]) : undefined
      if (!archivePath) throw new Error("rollback requires --archive-path <path>")
      const { verifyAndRollback } = await import("@opencode-ai/core/cutover/rollback")
      const res = await verifyAndRollback({ dataRoot, archivePath: path.resolve(archivePath) })
      console.log(JSON.stringify({ ok: true, op, rollbackArchivePath: res.rollbackArchivePath }))
      return
    }
    throw new Error(`unknown op ${op} - expected status|cutover|recover|rollback`)
  },
})
