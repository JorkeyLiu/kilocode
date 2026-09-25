import fsp from "fs/promises"
import fs from "fs"
import path from "path"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../database/database"
import { createArchive, deriveArchive, makeArchiveID } from "./archive"
import { createIdentity, verifyGate } from "./identity"
import { fsyncDir, fsyncFile, isValidArchiveID } from "./util"
import { acquireLease } from "./lease"

export type CutoverResult = {
  archiveID: string
  archivePath: string
}

function markerPath(dataRoot: string): string {
  const { parent, base } = deriveArchive(dataRoot)
  return path.join(parent, `.cutover-${base}.marker.json`)
}

function stagedPath(dataRoot: string, archiveID: string): string {
  const { parent, base } = deriveArchive(dataRoot)
  return path.join(parent, `.staged-${base}-${archiveID}`)
}

function backupPath(dataRoot: string, archiveID: string): string {
  const abs = path.resolve(dataRoot)
  return `${abs}.backup-${archiveID}`
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

async function hasIdentity(dataRoot: string): Promise<boolean> {
  const dbPath = path.join(path.resolve(dataRoot), "kilo.db")
  if (!(await fileExists(dbPath))) return false
  const layer = Database.layerNoLease(dbPath)
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const row = yield* db.get<{ id: number }>(sql`SELECT id FROM storage_identity WHERE id = 1`).pipe(Effect.orDie)
      return !!row
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
  if (Exit.isSuccess(exit)) return exit.value as boolean
  return false
}

async function isGateOk(dataRoot: string): Promise<boolean> {
  const dbPath = path.join(path.resolve(dataRoot), "kilo.db")
  if (!(await fileExists(dbPath))) return false
  const layer = Database.layerNoLease(dbPath)
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* verifyGate(db, path.resolve(dataRoot))
      return true
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
  if (Exit.isSuccess(exit)) return true
  return false
}

// Unconditional canonical-identity probe: read-only, no migrations/PRAGMAs side-effect.
// Returns "canonical" when storage_identity row exists and passes uuid/schema/archive/autovacuum checks,
// "malformed" when row exists but fails validation (fail-closed), "none" when legacy (no DB, no table, no row).
async function probeCanonicalIdentity(dataRoot: string): Promise<{ kind: "canonical" | "malformed" | "none"; error?: string; archiveID?: string }> {
  const dbPath = path.join(path.resolve(dataRoot), "kilo.db")
  if (!(await fileExists(dbPath))) return { kind: "none" }
  let db: any
  try {
    const { Database: BunDB } = await import("bun:sqlite")
    db = new (BunDB as any)(dbPath, { readonly: true, create: false } as any)
  } catch (e: any) {
    throw new Error(`canonical DB open failed fail-closed at ${dbPath}: ${String(e?.message ?? e)}`)
  }
  try {
    let row: any
    try {
      row = db.query("SELECT uuid, schema_version, cutover_archive_id FROM storage_identity WHERE id = 1").get() as any
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      if (msg.includes("no such table")) return { kind: "none" }
      return { kind: "malformed", error: `storage_identity probe failed: ${msg}` }
    }
    if (!row) return { kind: "none" }
    const isUUID = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    const isValidArchiveID = (id: string) => /^\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    if (!isUUID(row.uuid)) return { kind: "malformed", error: `invalid storage uuid ${row.uuid}` }
    if (row.schema_version !== "1") return { kind: "malformed", error: `schema version mismatch ${row.schema_version}` }
    if (!row.cutover_archive_id || !isValidArchiveID(row.cutover_archive_id)) return { kind: "malformed", error: `invalid cutover archive id ${row.cutover_archive_id}` }
    let av: any
    try {
      av = db.query("PRAGMA auto_vacuum").get() as any
    } catch (e: any) {
      return { kind: "malformed", error: `auto_vacuum probe failed: ${String(e?.message ?? e)}` }
    }
    const avVal = (av as any)?.auto_vacuum
    if (avVal !== 2) return { kind: "malformed", error: `auto_vacuum must be 2, got ${avVal}` }
    try {
      const cnt = db.query("SELECT count(*) as c FROM storage_identity").get() as any
      if ((cnt as any)?.c !== 1) return { kind: "malformed", error: `storage_identity must have 1 row, got ${(cnt as any)?.c}` }
    } catch (e: any) {
      return { kind: "malformed", error: `storage_identity count failed: ${String(e?.message ?? e)}` }
    }
    return { kind: "canonical", archiveID: row.cutover_archive_id }
  } finally {
    try {
      db.close()
    } catch {}
  }
}

export async function bootstrapFreshStaged(stagedRoot: string, archiveID: string): Promise<void> {
  const root = path.resolve(stagedRoot)
  await fsp.mkdir(root, { recursive: true })
  for (const k of ["session_diff", "session_diff_base", "session_share"]) {
    const dir = path.join(root, "storage", k)
    await fsp.mkdir(dir, { recursive: true })
  }
  for (const k of ["session_diff", "session_diff_base", "session_share"]) {
    const dir = path.join(root, "storage", k)
    const entries = await fsp.readdir(dir).catch((e: any) => {
      if (e.code === "ENOENT") return [] as string[]
      throw e
    })
    if (entries.length !== 0) throw new Error(`staged family artifact not empty ${k}`)
  }
  const dbPath = path.join(root, "kilo.db")
  const layer = Database.layerNoLease(dbPath)
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* createIdentity(db, archiveID)
      yield* verifyGate(db, root, archiveID)
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
  )
  await fsyncDir(root)
  await fsyncDir(path.join(root, "storage"))
  for (const k of ["session_diff", "session_diff_base", "session_share"]) {
    await fsyncDir(path.join(root, "storage", k))
  }
  await fsyncDir(path.dirname(root))
}

function validateMarker(raw: string, dataRoot: string): { archiveID: string; stagedPath: string; phase: string } {
  let m: any
  try {
    m = JSON.parse(raw)
  } catch {
    throw new Error(`cutover marker corrupt at ${markerPath(dataRoot)} - fail closed, manual recovery required`)
  }
  if (!m || typeof m.archiveID !== "string" || typeof m.stagedPath !== "string" || typeof m.phase !== "string") {
    throw new Error(`cutover marker invalid schema at ${markerPath(dataRoot)} - fail closed`)
  }
  if (!isValidArchiveID(m.archiveID)) throw new Error(`cutover marker invalid archiveID ${m.archiveID} - fail closed`)
  const staged = path.resolve(m.stagedPath)
  if (!staged.startsWith(path.resolve(path.dirname(path.resolve(dataRoot))) + path.sep))
    throw new Error(`cutover marker stagedPath not confined ${staged}`)
  if (m.phase !== "staged" && m.phase !== "handoff") throw new Error(`cutover marker invalid phase ${m.phase}`)
  return { archiveID: m.archiveID, stagedPath: staged, phase: m.phase }
}

async function recoverIfNeeded(dataRoot: string): Promise<void> {
  const mp = markerPath(dataRoot)
  if (!(await fileExists(mp))) return
  const raw = await fsp.readFile(mp, "utf8")
  const marker = validateMarker(raw, dataRoot)
  const archiveID = marker.archiveID
  const staged = marker.stagedPath
  const phase = marker.phase
  const abs = path.resolve(dataRoot)
  const backup = backupPath(dataRoot, archiveID)
  const stagedExists = await fileExists(staged)
  const backupExists = await fileExists(backup)
  const dataExists = await fileExists(abs)
  if (phase === "staged" || (phase === "handoff" && !backupExists)) {
    if (stagedExists) {
      await fsp.rm(staged, { recursive: true, force: true })
      await fsyncDir(path.dirname(staged))
    }
    await fsp.rm(mp, { force: true })
    await fsyncDir(path.dirname(mp))
    return
  }
  if (backupExists) {
    const gateOk = await isGateOk(abs)
    if (gateOk && dataExists) {
      await fsp.rm(backup, { recursive: true, force: true })
      await fsyncDir(path.dirname(abs))
      await fsp.rm(mp, { force: true })
      await fsyncDir(path.dirname(mp))
      if (stagedExists) {
        await fsp.rm(staged, { recursive: true, force: true })
        await fsyncDir(path.dirname(staged))
      }
      return
    }
    if (dataExists) {
      await fsp.rm(abs, { recursive: true, force: true })
      await fsyncDir(path.dirname(abs))
    }
    await fsp.rename(backup, abs)
    await fsyncDir(path.dirname(abs))
    if (stagedExists) {
      await fsp.rm(staged, { recursive: true, force: true })
      await fsyncDir(path.dirname(staged))
    }
    await fsp.rm(mp, { force: true })
    await fsyncDir(path.dirname(mp))
    return
  }
}

export async function runCutover(opts: { dataRoot: string; archiveID?: string }): Promise<CutoverResult> {
  const root = path.resolve(opts.dataRoot)
  // validate before lock
  if (opts.archiveID && !isValidArchiveID(opts.archiveID)) throw new Error(`invalid archiveID ${opts.archiveID}`)
  const lease = await acquireLease(root)
  let markerWritten = false
  let staged: string | undefined
  let archiveID = opts.archiveID
  try {
    await recoverIfNeeded(root)
    const probe = await probeCanonicalIdentity(root)
    if (probe.kind === "malformed") throw new Error(probe.error)
    if (probe.kind === "canonical") throw new Error(`cutover rerun blocked: fresh canonical DB already active ${probe.archiveID ?? ""}`.trim())
    let created: { archiveID: string; archivePath: string; manifest: any } | undefined
    try {
      created = await createArchive({ dataRoot: root, archiveID })
      archiveID = created.archiveID
    } catch (e) {
      if (archiveID) {
        const { p4 } = deriveArchive(root)
        const tmp = path.join(p4, `.tmp-${archiveID}`)
        try {
          await fsp.rm(tmp, { recursive: true, force: true })
          await fsyncDir(p4)
        } catch {}
      }
      throw e
    }
    staged = stagedPath(root, archiveID!)
    const mp = markerPath(root)
    if (await fileExists(staged)) {
      await fsp.rm(staged, { recursive: true, force: true })
      await fsyncDir(path.dirname(staged))
    }
    await fsp.writeFile(mp, JSON.stringify({ archiveID, stagedPath: staged, dataRoot: root, phase: "staged" }, null, 2), "utf8")
    await fsyncDir(path.dirname(mp))
    // strict file fsync for marker
    await fsyncFile(mp)
    markerWritten = true
    try {
      await bootstrapFreshStaged(staged, archiveID!)
    } catch (e) {
      await fsp.rm(staged, { recursive: true, force: true })
      await fsyncDir(path.dirname(staged))
      await fsp.rm(mp, { force: true })
      await fsyncDir(path.dirname(mp))
      markerWritten = false
      throw e
    }
    const backup = backupPath(root, archiveID!)
    await fsp.writeFile(mp, JSON.stringify({ archiveID, stagedPath: staged, dataRoot: root, phase: "handoff" }, null, 2), "utf8")
    await fsyncDir(path.dirname(mp))
    await fsyncFile(mp)
    await fsp.rename(root, backup)
    await fsyncDir(path.dirname(root))
    try {
      await fsp.rename(staged, root)
    } catch (e: any) {
      try {
        await fsp.rename(backup, root)
        await fsyncDir(path.dirname(root))
      } catch {}
      throw e
    }
    await fsyncDir(path.dirname(root))
    const gateOk = await isGateOk(root)
    if (!gateOk) {
      await fsp.rm(root, { recursive: true, force: true })
      await fsyncDir(path.dirname(root))
      await fsp.rename(backup, root)
      await fsyncDir(path.dirname(root))
      await fsp.rm(mp, { force: true })
      await fsyncDir(path.dirname(mp))
      throw new Error("fresh gate verification failed after handoff - restored legacy")
    }
    await fsp.rm(backup, { recursive: true, force: true })
    await fsyncDir(path.dirname(root))
    await fsp.rm(mp, { force: true })
    await fsyncDir(path.dirname(mp))
    markerWritten = false
    return { archiveID: archiveID!, archivePath: created!.archivePath }
  } finally {
    await lease.release()
  }
}

export async function isFresh(dataRoot: string): Promise<boolean> {
  return isGateOk(dataRoot)
}

export async function recoverCutover(dataRoot: string): Promise<void> {
  const lease = await acquireLease(path.resolve(dataRoot))
  try {
    await recoverIfNeeded(path.resolve(dataRoot))
  } finally {
    await lease.release()
  }
}

export async function bootstrapFreshDB(dataRoot: string, archiveID: string): Promise<void> {
  const staged = path.resolve(dataRoot)
  const probe = await probeCanonicalIdentity(staged)
  if (probe.kind === "malformed") throw new Error(probe.error)
  if (probe.kind === "canonical") throw new Error(`fresh canonical DB already active ${probe.archiveID ?? ""}`.trim())
  const lease = await acquireLease(staged)
  try {
    const probe2 = await probeCanonicalIdentity(staged)
    if (probe2.kind === "malformed") throw new Error(probe2.error)
    if (probe2.kind === "canonical") throw new Error(`fresh canonical DB already active ${probe2.archiveID ?? ""}`.trim())
    // Fresh no-DB bootstrap must check family artifact dirs empty BEFORE creating identity/DB, otherwise fail closed without leaving activated canonical identity.
    for (const k of ["session_diff", "session_diff_base", "session_share"]) {
      const dir = path.join(staged, "storage", k)
      const entries = await fsp.readdir(dir).catch((e: any) => {
        if (e.code === "ENOENT") return [] as string[]
        throw e
      })
      if (entries.length !== 0) throw new Error(`staged family artifact not empty ${k}`)
    }
    const parent = path.dirname(staged)
    const tmpStaged = path.join(parent, `.tmp-bootstrap-${archiveID}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await bootstrapFreshStaged(tmpStaged, archiveID)
    const backup = `${staged}.bootstrap-backup-${Date.now()}-${Math.random().toString(16).slice(2)}`
    let moved = false
    try {
      const stagedExists = await fileExists(staged)
      if (stagedExists) {
        await fsp.rename(staged, backup)
        moved = true
      }
      await fsp.rename(tmpStaged, staged)
      await fsyncDir(parent)
      const ok = await isGateOk(staged)
      if (!ok) throw new Error("bootstrap gate failed")
      if (moved) {
        await fsp.rm(backup, { recursive: true, force: true })
        await fsyncDir(parent)
      }
    } catch (e) {
      if (moved) {
        await fsp.rm(staged, { recursive: true, force: true }).catch(() => {})
        await fsp.rename(backup, staged).catch(() => {})
        await fsyncDir(parent).catch(() => {})
      }
      await fsp.rm(tmpStaged, { recursive: true, force: true }).catch(() => {})
      throw e
    }
  } finally {
    await lease.release()
  }
}
