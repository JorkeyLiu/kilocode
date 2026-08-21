import fs from "fs"
import fsp from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { Database } from "bun:sqlite"
import { sha256File, fsyncFile, fsyncDir, posixRel, isValidArchiveID, assertValidArchiveID, isConfinedPosixRel, assertNoSymlink } from "./util"
import type { ManifestV1, ManifestFile } from "./manifest"
import { aggregate, parseAndValidateManifest } from "./manifest"

export type FixedMember = {
  rel: string
  required: boolean
  isDir: boolean
}

const FIXED: FixedMember[] = [
  { rel: "kilo.db", required: true, isDir: false },
  { rel: "kilo.db-wal", required: false, isDir: false },
  { rel: "kilo.db-shm", required: false, isDir: false },
  { rel: "storage/session_diff", required: false, isDir: true },
  { rel: "storage/session_diff_base", required: false, isDir: true },
  { rel: "storage/session_share", required: false, isDir: true },
  { rel: "session-export.db", required: false, isDir: false },
  { rel: "session-export.db-wal", required: false, isDir: false },
  { rel: "session-export.db-shm", required: false, isDir: false },
]

export function deriveArchive(dataRoot: string) {
  const abs = path.resolve(dataRoot)
  const parent = path.dirname(abs)
  const base = path.basename(abs)
  const archiveRoot = path.join(parent, `${base}-archive`)
  const p4 = path.join(archiveRoot, "p4.2")
  return { abs, parent, base, archiveRoot, p4 }
}

export function makeArchiveID(): string {
  const utc = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z")
  const ts = utc.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, "$1$2$3T$4$5$6Z")
  return `${ts}-${randomUUID()}`
}

export async function checkpointAndVerify(dbPath: string): Promise<void> {
  const dir = path.dirname(dbPath)
  await fsp.mkdir(dir, { recursive: true })
  try {
    await fsp.access(dbPath)
  } catch {
    throw new Error(`kilo.db missing at ${dbPath}`)
  }
  const db = new Database(dbPath, { readwrite: true, create: false })
  try {
    const chk = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number; log: number; checkpointed: number } | undefined
    if (!chk) throw new Error("wal_checkpoint(TRUNCATE) returned no result")
    if (chk.busy !== 0) throw new Error(`wal_checkpoint busy=${chk.busy} log=${chk.log} checkpointed=${chk.checkpointed} - quiescence not proven`)
    if (chk.log !== 0) throw new Error(`wal_checkpoint log=${chk.log} not zero after TRUNCATE busy=${chk.busy}`)
    const rows = db.query("PRAGMA integrity_check").all() as any[]
    const ok = rows.length === 1 && (rows[0].integrity_check === "ok" || rows[0]["integrity_check"] === "ok")
    if (!ok) throw new Error(`integrity_check failed: ${JSON.stringify(rows)}`)
    const fk = db.query("PRAGMA foreign_key_check").all() as any[]
    if (fk.length !== 0) throw new Error(`foreign_key_check failed: ${JSON.stringify(fk)}`)
  } finally {
    db.close()
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

export async function collectFixed(dataRoot: string): Promise<{ present: string[]; absent: string[]; emptyDirs: string[] }> {
  const present: string[] = []
  const absent: string[] = []
  const emptyDirs: string[] = []
  for (const m of FIXED) {
    const full = path.join(dataRoot, m.rel)
    const exists = await fileExists(full)
    if (!exists) {
      absent.push(m.rel)
      continue
    }
    if (m.isDir) {
      const lst = await fsp.lstat(full)
      if (lst.isSymbolicLink()) throw new Error(`symlink not allowed for fixed member ${m.rel}`)
      const st = await fsp.stat(full)
      if (!st.isDirectory()) {
        present.push(m.rel)
        continue
      }
      const entries = await fsp.readdir(full)
      if (entries.length === 0) emptyDirs.push(m.rel)
      else {
        const files = await walkRec(full, dataRoot)
        present.push(...files)
        if (files.length === 0) emptyDirs.push(m.rel)
      }
    } else {
      const lst = await fsp.lstat(full)
      if (lst.isSymbolicLink()) throw new Error(`symlink not allowed for fixed member ${m.rel}`)
      present.push(m.rel)
    }
  }
  const exportPresent = present.includes("session-export.db")
  if (!exportPresent) {
    for (const w of ["session-export.db-wal", "session-export.db-shm"]) {
      const idx = present.indexOf(w)
      if (idx >= 0) present.splice(idx, 1)
      if (!absent.includes(w)) absent.push(w)
    }
  }
  present.sort()
  absent.sort()
  emptyDirs.sort()
  return { present, absent, emptyDirs }
}

async function walkRec(dir: string, base: string): Promise<string[]> {
  const out: string[] = []
  async function rec(cur: string) {
    const entries = await fsp.readdir(cur, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(cur, e.name)
      const lst = await fsp.lstat(full)
      if (lst.isSymbolicLink()) throw new Error(`symlink not allowed ${posixRel(base, full)}`)
      if (e.isDirectory()) await rec(full)
      else if (e.isFile()) {
        const rel = posixRel(base, full)
        if (!isConfinedPosixRel(rel)) throw new Error(`unconfined path ${rel}`)
        out.push(rel)
      } else {
        throw new Error(`unknown entry type ${full}`)
      }
    }
  }
  await rec(dir)
  out.sort()
  return out
}

export async function createArchive(opts: { dataRoot: string; archiveID?: string }): Promise<{ archiveID: string; archivePath: string; manifest: ManifestV1 }> {
  const realRoot = path.resolve(opts.dataRoot)
  const { p4, archiveRoot } = deriveArchive(realRoot)
  const archiveID = opts.archiveID ?? makeArchiveID()
  assertValidArchiveID(archiveID)
  await fsp.mkdir(p4, { recursive: true })
  // same-filesystem check: compare dev of dataRoot parent and archive parent
  try {
    const a = await fsp.stat(realRoot)
    const b = await fsp.stat(p4)
    if ((a as any).dev !== (b as any).dev) throw new Error(`EXDEV cross-device archive not allowed`)
  } catch (e: any) {
    if (e.message?.includes("EXDEV")) throw e
    const parentStat = await fsp.stat(path.dirname(realRoot))
    const archiveParentStat = await fsp.stat(path.dirname(archiveRoot))
    if ((parentStat as any).dev !== (archiveParentStat as any).dev) throw new Error(`EXDEV cross-device archive not allowed`)
  }
  const dbPath = path.join(realRoot, "kilo.db")
  await checkpointAndVerify(dbPath)
  const snapshotPath = path.join(realRoot, "snapshot")
  if (await fileExists(snapshotPath)) {
    // ensure snapshot not archived; no action
  }
  const { present, absent, emptyDirs } = await collectFixed(realRoot)
  const tmp = path.join(p4, `.tmp-${archiveID}`)
  const final = path.join(p4, archiveID)
  if (await fileExists(final)) throw new Error(`archive already exists ${final}`)
  if (await fileExists(tmp)) await fsp.rm(tmp, { recursive: true, force: true })
  await fsp.mkdir(tmp, { recursive: true })
  let success = false
  try {
    const files: ManifestFile[] = []
    for (const rel of present) {
      if (!isConfinedPosixRel(rel)) throw new Error(`unconfined present path ${rel}`)
      const src = path.join(realRoot, rel)
      // verify no symlink and confined
      await assertNoSymlink(src)
      const dst = path.join(tmp, rel)
      // ensure dst is confined within tmp
      const relCheck = path.relative(tmp, dst)
      if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) throw new Error(`path traversal dst ${rel}`)
      await fsp.mkdir(path.dirname(dst), { recursive: true })
      await fsp.copyFile(src, dst)
      const bytes = (await fsp.stat(src)).size
      const hash = await sha256File(src)
      files.push({ path: rel, bytes, sha256: hash })
      await fsyncFile(dst)
    }
    for (const d of emptyDirs) {
      if (!isConfinedPosixRel(d)) throw new Error(`unconfined empty dir ${d}`)
      const dst = path.join(tmp, d)
      const relCheck = path.relative(tmp, dst)
      if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) throw new Error(`path traversal empty ${d}`)
      await fsp.mkdir(dst, { recursive: true })
      await fsyncDir(dst)
    }
    files.sort((a, b) => a.path.localeCompare(b.path))
    const agg = aggregate(files)
    const manifest: ManifestV1 = {
      version: 1,
      archive_id: archiveID,
      created_at: new Date().toISOString(),
      source_data_root: realRoot,
      files,
      absent: [...absent].sort(),
      aggregate_sha256: agg,
      empty_dirs: [...emptyDirs].sort(),
      note: "snapshot excluded; not rollback material under this cutover decision",
    }
    // validate manifest before writing
    parseAndValidateManifest(JSON.stringify(manifest))
    const manifestPath = path.join(tmp, "manifest.json")
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8")
    await fsyncFile(manifestPath)
    await fsyncDir(tmp)
    for (const f of files) {
      const p = path.join(tmp, f.path)
      await assertNoSymlink(p)
      const h = await sha256File(p)
      if (h !== f.sha256) throw new Error(`reverify failed for ${f.path}`)
      const s = (await fsp.stat(p)).size
      if (s !== f.bytes) throw new Error(`reverify size failed for ${f.path}`)
    }
    if (await fileExists(path.join(tmp, "snapshot"))) throw new Error(`snapshot must not be archived`)
    // undeclared entries check: ensure tmp contains only expected files+empty_dirs+manifest
    const actual = await walkFilesCollect(tmp)
    const expectedSet = new Set<string>([...files.map((f) => f.path), ...emptyDirs.map((d) => d + "/"), "manifest.json"])
    // walkFilesCollect returns files only; need to check no extra files beyond manifest
    for (const a of actual) {
      if (!expectedSet.has(a) && !expectedSet.has(a + "/")) {
        // if a is manifest.json it's already in set
        if (a !== "manifest.json" && !files.some((f) => f.path === a)) throw new Error(`undeclared entry in archive ${a}`)
      }
    }
    try {
      await fsp.rename(tmp, final)
    } catch (e: any) {
      if (e.code === "EXDEV") throw new Error(`EXDEV cross-device rename not allowed`)
      throw e
    }
    await fsyncDir(p4)
    // verify final via parse
    const raw = await fsp.readFile(path.join(final, "manifest.json"), "utf8")
    parseAndValidateManifest(raw)
    success = true
    return { archiveID, archivePath: final, manifest }
  } finally {
    if (!success) {
      try {
        await fsp.rm(tmp, { recursive: true, force: true })
      } catch {}
      try {
        await fsyncDir(p4)
      } catch {}
    }
  }
}

async function walkFilesCollect(root: string): Promise<string[]> {
  const out: string[] = []
  async function rec(cur: string) {
    const entries = await fsp.readdir(cur, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(cur, e.name)
      const lst = await fsp.lstat(full)
      if (lst.isSymbolicLink()) {
        out.push(posixRel(root, full))
      } else if (e.isDirectory()) await rec(full)
      else if (e.isFile()) out.push(posixRel(root, full))
    }
  }
  await rec(root)
  out.sort()
  return out
}

async function collectEmptyDirs(root: string): Promise<Set<string>> {
  const out = new Set<string>()
  async function rec(cur: string) {
    const entries = await fsp.readdir(cur, { withFileTypes: true })
    if (entries.length === 0) {
      const rel = posixRel(root, cur)
      if (rel !== "" && rel !== ".") out.add(rel)
      return
    }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      const lst = await fsp.lstat(full)
      if (lst.isSymbolicLink()) continue
      if (e.isDirectory()) await rec(full)
    }
  }
  await rec(root)
  return out
}

async function collectAllDirs(root: string): Promise<Set<string>> {
  const out = new Set<string>()
  async function rec(cur: string) {
    const entries = await fsp.readdir(cur, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) {
        const full = path.join(cur, e.name)
        const lst = await fsp.lstat(full)
        if (lst.isSymbolicLink()) continue
        const rel = posixRel(root, full)
        out.add(rel)
        await rec(full)
      }
    }
  }
  await rec(root)
  return out
}

export async function verifyArchive(archivePath: string): Promise<ManifestV1> {
  const manifestPath = path.join(archivePath, "manifest.json")
  let raw: string
  try {
    raw = await fsp.readFile(manifestPath, "utf8")
  } catch (e: any) {
    throw new Error(`manifest missing ${manifestPath}: ${e.message}`)
  }
  const m = parseAndValidateManifest(raw)
  // verify each file confined and no symlink
  for (const f of m.files) {
    if (!isConfinedPosixRel(f.path)) throw new Error(`unconfined manifest path ${f.path}`)
    const p = path.join(archivePath, f.path)
    const rel = path.relative(archivePath, p)
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path traversal ${f.path}`)
    let lst: any
    try {
      lst = await fsp.lstat(p)
    } catch {
      throw new Error(`missing archived file ${f.path}`)
    }
    if (lst.isSymbolicLink()) throw new Error(`symlink not allowed in archive ${f.path}`)
    if (!lst.isFile()) throw new Error(`not a file ${f.path}`)
    const h = await sha256File(p)
    if (h !== f.sha256) throw new Error(`hash mismatch ${f.path}`)
    const s = (await fsp.stat(p)).size
    if (s !== f.bytes) throw new Error(`size mismatch ${f.path}`)
  }
  for (const d of m.empty_dirs) {
    if (!isConfinedPosixRel(d)) throw new Error(`unconfined empty dir ${d}`)
    const p = path.join(archivePath, d)
    const rel = path.relative(archivePath, p)
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path traversal empty ${d}`)
    let lst: any
    try {
      lst = await fsp.lstat(p)
    } catch {
      throw new Error(`empty dir missing ${d}`)
    }
    if (lst.isSymbolicLink()) throw new Error(`symlink not allowed empty dir ${d}`)
    const st = await fsp.stat(p)
    if (!st.isDirectory()) throw new Error(`empty dir missing ${d}`)
    const entries = await fsp.readdir(p)
    if (entries.length !== 0) throw new Error(`empty dir not empty ${d}`)
  }
  if (await fileExists(path.join(archivePath, "snapshot"))) throw new Error(`snapshot should not be in archive`)
  // check no undeclared entries beyond manifest + empty_dirs, including empty dirs and parent dirs
  const allFiles = await walkFilesCollect(archivePath)
  const allowed = new Set<string>([...m.files.map((f) => f.path), "manifest.json"])
  for (const f of allFiles) {
    if (!allowed.has(f)) throw new Error(`undeclared file in archive ${f}`)
  }
  // verify exact empty dirs: no extra empty leaf directories beyond manifest.empty_dirs
  const actualEmpty = await collectEmptyDirs(archivePath)
  const expectedEmpty = new Set(m.empty_dirs)
  for (const a of actualEmpty) {
    if (!expectedEmpty.has(a)) throw new Error(`undeclared empty dir in archive ${a}`)
  }
  for (const e of expectedEmpty) {
    if (!actualEmpty.has(e) && !(await fileExists(path.join(archivePath, e)))) throw new Error(`empty dir missing ${e}`)
  }
  // also verify no extra top-level directories beyond those required for files/empty
  // walk for any dir that is not parent of a file nor empty should be undeclared
  const allowedDirs = new Set<string>()
  for (const f of m.files) {
    let dir = path.posix.dirname(f.path)
    while (dir !== "." && dir !== "/") {
      allowedDirs.add(dir)
      dir = path.posix.dirname(dir)
    }
  }
  for (const d of m.empty_dirs) {
    let dir = d
    while (dir !== "." && dir !== "/") {
      allowedDirs.add(dir)
      dir = path.posix.dirname(dir)
    }
    // also parent of empty
    const parent = path.posix.dirname(d)
    if (parent !== "." && parent !== "/") allowedDirs.add(parent)
  }
  // storage parent itself is allowed if any child exists
  const allDirs = await collectAllDirs(archivePath)
  for (const dir of allDirs) {
    if (dir === "." || dir === "") continue
    if (!allowedDirs.has(dir) && !expectedEmpty.has(dir)) throw new Error(`undeclared directory in archive ${dir}`)
  }
  return m
}

export async function deleteArchive(archivePath: string, opts: { maintainerAuthorization: boolean }): Promise<void> {
  if (!opts.maintainerAuthorization) throw new Error(`archive deletion requires separate explicit maintainer authorization`)
  // validate path is under an archive p4.2 to avoid accidental deletion elsewhere
  const resolved = path.resolve(archivePath)
  if (!resolved.includes("-archive/p4.2/")) throw new Error(`archive path not in expected location ${resolved}`)
  await fsp.rm(archivePath, { recursive: true, force: true })
  await fsyncDir(path.dirname(archivePath))
}
