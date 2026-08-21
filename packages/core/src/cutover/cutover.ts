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

export async function bootstrapFreshStaged(stagedRoot: string, archiveID: string): Promise<void> {
  const root = path.resolve(stagedRoot)
  await fsp.mkdir(root, { recursive: true })
  for (const k of ["session_diff", "session_diff_base", "session_share"]) {
    const dir = path.join(root, "storage", k)
    await fsp.mkdir(dir, { recursive: true })
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
  for (const k of ["session_diff", "session_diff_base", "session_share"]) {
    const dir = path.join(root, "storage", k)
    const entries = await fsp.readdir(dir).catch((e: any) => {
      if (e.code === "ENOENT") return [] as string[]
      throw e
    })
    if (entries.length !== 0) throw new Error(`staged family artifact not empty ${k}`)
  }
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
    if (await hasIdentity(root)) {
      if (await isGateOk(root)) throw new Error(`cutover rerun blocked: fresh canonical DB already active`)
    }
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
  if (await hasIdentity(staged)) {
    if (await isGateOk(staged)) throw new Error("fresh DB already active")
  }
  const parent = path.dirname(staged)
  const tmpStaged = path.join(parent, `.tmp-bootstrap-${archiveID}-${Date.now()}`)
  await bootstrapFreshStaged(tmpStaged, archiveID)
  const backup = `${staged}.bootstrap-backup-${Date.now()}`
  let moved = false
  try {
    await fsp.rename(staged, backup)
    moved = true
    await fsp.rename(tmpStaged, staged)
    await fsyncDir(parent)
    const ok = await isGateOk(staged)
    if (!ok) throw new Error("bootstrap gate failed")
    await fsp.rm(backup, { recursive: true, force: true })
    await fsyncDir(parent)
  } catch (e) {
    if (moved) {
      await fsp.rm(staged, { recursive: true, force: true }).catch(() => {})
      await fsp.rename(backup, staged).catch(() => {})
      await fsyncDir(parent).catch(() => {})
    }
    await fsp.rm(tmpStaged, { recursive: true, force: true }).catch(() => {})
    throw e
  }
}
