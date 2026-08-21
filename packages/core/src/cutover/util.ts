import { createHash } from "crypto"
import fs from "fs"
import fsp from "fs/promises"
import path from "path"

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256")
    const s = fs.createReadStream(file)
    s.on("error", reject)
    s.on("data", (c) => h.update(c))
    s.on("end", () => resolve(h.digest("hex")))
  })
}

export function sha256Bytes(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex")
}

export async function fsyncFile(file: string): Promise<void> {
  const fd = await fsp.open(file, "r+")
  try {
    await fd.sync()
  } finally {
    await fd.close()
  }
}

export async function fsyncFileStrict(file: string): Promise<void> {
  const fd = await fsp.open(file, "r+")
  try {
    await fd.sync()
  } finally {
    await fd.close()
  }
}

export async function fsyncDir(dir: string): Promise<void> {
  const fd = await fsp.open(dir, "r")
  try {
    await fd.sync()
  } finally {
    await fd.close()
  }
}

export async function ensureDir(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true })
  await fsyncDir(path.dirname(p))
}

const ARCHIVE_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidArchiveID(id: string): boolean {
  return ARCHIVE_ID_RE.test(id)
}

export function assertValidArchiveID(id: string): void {
  if (!isValidArchiveID(id)) throw new Error(`invalid archive id ${id}`)
}

export function isConfinedPosixRel(p: string): boolean {
  if (!p || p.length === 0) return false
  if (p.includes("\\")) return false
  if (path.isAbsolute(p)) return false
  if (p.startsWith("/")) return false
  if (p.split("/").includes("..")) return false
  if (p.split("/").includes(".")) return false
  // normalized must equal original with posix
  const normalized = path.posix.normalize(p)
  if (normalized !== p) return false
  // no empty segments
  if (p.includes("//")) return false
  if (p.endsWith("/")) return false
  return true
}

export async function assertNoSymlink(fullPath: string): Promise<void> {
  const lst = await fsp.lstat(fullPath)
  if (lst.isSymbolicLink()) throw new Error(`symlink not allowed ${fullPath}`)
}

export function posixRel(base: string, target: string): string {
  const rel = path.relative(base, target)
  return rel.split(path.sep).join(path.posix.sep)
}

export async function walkFiles(root: string, base: string): Promise<string[]> {
  const out: string[] = []
  async function rec(dir: string) {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await rec(full)
      else if (e.isFile()) out.push(posixRel(base, full))
    }
  }
  await rec(root)
  out.sort()
  return out
}

export async function statBytes(file: string): Promise<number> {
  const s = await fsp.stat(file)
  return s.size
}

export function isSameFilesystem(a: string, b: string): Promise<boolean> {
  return Promise.all([fsp.stat(a), fsp.stat(b)])
    .then(([sa, sb]) => (sa as any).dev === (sb as any).dev)
    .catch(() => false)
}
