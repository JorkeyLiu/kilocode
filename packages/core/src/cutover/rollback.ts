import fs from "fs/promises"
import path from "path"
import { createArchive, verifyArchive, deriveArchive, checkpointAndVerify, makeArchiveID } from "./archive"
import { fsyncDir, fsyncFile, sha256File, assertValidArchiveID, isConfinedPosixRel, isValidArchiveID } from "./util"
import { acquireLease } from "./lease"

function markerPath(dataRoot: string): string {
  const { parent, base } = deriveArchive(dataRoot)
  return path.join(parent, `.rollback-${base}.marker.json`)
}

function rollbackStagedPath(dataRoot: string, archiveID: string): string {
  const { parent, base } = deriveArchive(dataRoot)
  return path.join(parent, `.rollback-staged-${base}-${archiveID}`)
}

function expectedRollbackStagedPath(dataRoot: string, archiveID: string): string {
  return path.resolve(rollbackStagedPath(dataRoot, archiveID))
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function validateRollbackMarker(raw: string, dataRoot: string): { archiveID: string; stagedPath: string; dataRoot: string } {
  let m: any
  try {
    m = JSON.parse(raw)
  } catch {
    throw new Error(`rollback marker corrupt at ${markerPath(dataRoot)} - fail closed`)
  }
  if (!m || typeof m.archiveID !== "string" || typeof m.stagedPath !== "string") {
    throw new Error(`rollback marker invalid schema at ${markerPath(dataRoot)} - fail closed`)
  }
  if (!isValidArchiveID(m.archiveID)) throw new Error(`rollback marker invalid archiveID ${m.archiveID} - fail closed`)
  const staged = path.resolve(m.stagedPath)
  const expectedParent = path.resolve(path.dirname(path.resolve(dataRoot)))
  if (!staged.startsWith(expectedParent + path.sep)) {
    throw new Error(`rollback marker stagedPath not confined ${staged} - fail closed`)
  }
  const expectedStaged = expectedRollbackStagedPath(dataRoot, m.archiveID)
  if (staged !== expectedStaged) {
    throw new Error(`rollback marker stagedPath mismatch ${staged} != ${expectedStaged} - fail closed`)
  }
  if (m.dataRoot !== undefined) {
    if (typeof m.dataRoot !== "string") throw new Error(`rollback marker invalid dataRoot schema at ${markerPath(dataRoot)} - fail closed`)
    const markerRoot = path.resolve(String(m.dataRoot))
    const expectedRoot = path.resolve(dataRoot)
    if (markerRoot !== expectedRoot) throw new Error(`rollback marker dataRoot mismatch ${markerRoot} != ${expectedRoot} - fail closed`)
  }
  if (m.phase !== undefined && m.phase !== "staged" && m.phase !== "handoff") {
    throw new Error(`rollback marker invalid phase ${m.phase} - fail closed`)
  }
  return { archiveID: m.archiveID, stagedPath: staged, dataRoot: path.resolve(m.dataRoot ?? dataRoot) }
}

async function recoverIfNeeded(dataRoot: string): Promise<void> {
  const mp = markerPath(dataRoot)
  if (!(await fileExists(mp))) return
  const raw = await fs.readFile(mp, "utf8")
  const marker = validateRollbackMarker(raw, dataRoot)
  const staged = marker.stagedPath
  const archiveID = marker.archiveID
  const abs = path.resolve(dataRoot)
  const backup = `${abs}.rollback-backup-${archiveID}`
  const stagedExists = await fileExists(staged)
  const backupExists = await fileExists(backup)
  const dataExists = await fileExists(abs)
  // If backup exists, we were in handoff phase. Try to recover deterministically.
  if (backupExists) {
    // if data exists and integrity passes, handoff had succeeded -> cleanup backup and marker
    if (dataExists) {
      try {
        await checkpointAndVerify(path.join(abs, "kilo.db"))
        await fs.rm(backup, { recursive: true, force: true })
        await fsyncDir(path.dirname(abs))
        await fs.rm(mp, { force: true })
        await fsyncDir(path.dirname(mp))
        if (stagedExists) {
          await fs.rm(staged, { recursive: true, force: true })
          await fsyncDir(path.dirname(staged))
        }
        return
      } catch {}
    }
    // otherwise restore backup
    if (dataExists) {
      await fs.rm(abs, { recursive: true, force: true })
      await fsyncDir(path.dirname(abs))
    }
    await fs.rename(backup, abs)
    await fsyncDir(path.dirname(abs))
    if (stagedExists) {
      await fs.rm(staged, { recursive: true, force: true })
      await fsyncDir(path.dirname(staged))
    }
    await fs.rm(mp, { force: true })
    await fsyncDir(path.dirname(mp))
    return
  }
  // No backup -> we were before handoff (staging). Cleanup staged and marker
  // But if data still exists and no backup, just cleanup
  if (stagedExists) {
    await fs.rm(staged, { recursive: true, force: true })
    await fsyncDir(path.dirname(staged))
  }
  await fs.rm(mp, { force: true })
  await fsyncDir(path.dirname(mp))
}

async function preflightArchivePath(root: string, archivePathInput: string): Promise<string> {
  if (!path.isAbsolute(archivePathInput)) throw new Error(`archivePath must be absolute ${archivePathInput}`)
  const resolved = path.resolve(archivePathInput)
  const { p4 } = deriveArchive(root)
  const p4Resolved = path.resolve(p4)
  if (resolved === p4Resolved) throw new Error(`archivePath outside expected boundary ${resolved} not in ${p4Resolved}`)
  if (!resolved.startsWith(p4Resolved + path.sep)) throw new Error(`archivePath outside expected boundary ${resolved} not in ${p4Resolved}`)
  const rel = path.relative(p4Resolved, resolved)
  if (!rel || rel.includes(path.sep) || rel.includes("/") || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`archivePath traversal or unknown archive dir ${resolved}`)
  }
  const base = path.basename(resolved)
  if (!isValidArchiveID(base)) throw new Error(`archivePath invalid archiveID ${base}`)
  let st: any
  try {
    await fs.access(resolved)
  } catch {
    throw new Error(`archive not found ${resolved}`)
  }
  try {
    st = await fs.stat(resolved)
  } catch {
    throw new Error(`archive not found ${resolved}`)
  }
  if (!st.isDirectory()) throw new Error(`archivePath not a directory ${resolved}`)
  // reject symlink archive dir
  try {
    const lst = await fs.lstat(resolved)
    if (lst.isSymbolicLink()) throw new Error(`archivePath symlink not allowed ${resolved}`)
  } catch (e: any) {
    if (e.message?.includes("symlink not allowed")) throw e
  }
  return resolved
}

export async function verifyAndRollback(opts: { dataRoot: string; archivePath: string }): Promise<{ rollbackArchivePath: string }> {
  const root = path.resolve(opts.dataRoot)
  const archivePath = await preflightArchivePath(root, opts.archivePath)
  const lease = await acquireLease(root)
  const { parent, base } = deriveArchive(root)
  const mp = markerPath(root)
  let staged: string | undefined
  let backup: string | undefined
  let rollbackArchivePath: string | undefined
  try {
    await recoverIfNeeded(root)
    const manifest = await verifyArchive(archivePath)
    assertValidArchiveID(manifest.archive_id)
    const realRollbackID = makeArchiveID()
    const rollback = await createArchive({ dataRoot: root, archiveID: realRollbackID })
    rollbackArchivePath = rollback.archivePath
    const stagedRoot = rollbackStagedPath(root, manifest.archive_id)
    staged = stagedRoot
    if (await fileExists(staged)) {
      await fs.rm(staged, { recursive: true, force: true })
      await fsyncDir(path.dirname(staged))
    }
    await fs.mkdir(staged, { recursive: true })
    await fs.writeFile(mp, JSON.stringify({ archiveID: manifest.archive_id, stagedPath: staged, dataRoot: root, rollbackArchivePath }, null, 2), "utf8")
    await fsyncDir(path.dirname(mp))
    await fsyncFile(mp)
    // copy files
    for (const f of manifest.files) {
      if (!isConfinedPosixRel(f.path)) throw new Error(`unconfined manifest path ${f.path}`)
      const src = path.join(archivePath, f.path)
      const dst = path.join(staged, f.path)
      const rel = path.relative(staged, dst)
      if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path traversal rollback ${f.path}`)
      const lst = await fs.lstat(src)
      if (lst.isSymbolicLink()) throw new Error(`symlink not allowed ${f.path}`)
      await fs.mkdir(path.dirname(dst), { recursive: true })
      await fs.copyFile(src, dst)
      const h = await sha256File(dst)
      if (h !== f.sha256) throw new Error(`rollback hash mismatch ${f.path}`)
      await fsyncFile(dst)
    }
    for (const d of manifest.empty_dirs) {
      if (!isConfinedPosixRel(d)) throw new Error(`unconfined empty dir ${d}`)
      const dst = path.join(staged, d)
      const rel = path.relative(staged, dst)
      if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path traversal empty ${d}`)
      await fs.mkdir(dst, { recursive: true })
      await fsyncDir(dst)
    }
    await fsyncDir(staged)
    await fsyncDir(path.join(staged, "storage")).catch(() => {})
    for (const k of ["session_diff", "session_diff_base", "session_share"]) {
      await fsyncDir(path.join(staged, "storage", k)).catch(() => {})
    }
    const stagedDb = path.join(staged, "kilo.db")
    if (await fileExists(stagedDb)) {
      await checkpointAndVerify(stagedDb)
    } else {
      throw new Error("staged kilo.db missing")
    }
    const backupPath = `${root}.rollback-backup-${manifest.archive_id}`
    backup = backupPath
    if (await fileExists(backup)) {
      await fs.rm(backup, { recursive: true, force: true })
      await fsyncDir(path.dirname(root))
    }
    await fs.rename(root, backup)
    await fsyncDir(path.dirname(root))
    try {
      await fs.rename(staged, root)
    } catch (e: any) {
      await fs.rename(backup, root)
      await fsyncDir(path.dirname(root))
      throw e
    }
    await fsyncDir(path.dirname(root))
    await checkpointAndVerify(path.join(root, "kilo.db"))
    await fs.rm(backup, { recursive: true, force: true })
    await fsyncDir(path.dirname(root))
    await fs.rm(mp, { force: true })
    await fsyncDir(path.dirname(mp))
    staged = undefined
    backup = undefined
    return { rollbackArchivePath: rollbackArchivePath! }
  } catch (e) {
    const backupExists = backup ? await fileExists(backup).catch(() => false) : false
    if (staged && !backupExists) {
      try {
        if (await fileExists(staged)) {
          await fs.rm(staged, { recursive: true, force: true })
          await fsyncDir(path.dirname(staged))
        }
      } catch {}
      try {
        if (await fileExists(mp)) {
          let shouldClean = true
          try {
            const raw = await fs.readFile(mp, "utf8")
            validateRollbackMarker(raw, root)
          } catch {
            shouldClean = false
          }
          if (shouldClean) {
            await fs.rm(mp, { force: true })
            await fsyncDir(path.dirname(mp))
          }
        }
      } catch {}
    }
    throw e
  } finally {
    await lease.release()
  }
}

export async function recoverRollback(dataRoot: string): Promise<void> {
  const lease = await acquireLease(path.resolve(dataRoot))
  try {
    await recoverIfNeeded(path.resolve(dataRoot))
  } finally {
    await lease.release()
  }
}
