import { sha256Bytes, isConfinedPosixRel, isValidArchiveID } from "./util"

export type ManifestFile = {
  path: string
  bytes: number
  sha256: string
}

export type ManifestV1 = {
  version: 1
  archive_id: string
  created_at: string
  source_data_root: string
  files: ManifestFile[]
  absent: string[]
  aggregate_sha256: string
  empty_dirs: string[]
  note: string
}

const FIXED_FILES = [
  "kilo.db",
  "kilo.db-wal",
  "kilo.db-shm",
  "session-export.db",
  "session-export.db-wal",
  "session-export.db-shm",
] as const

const FIXED_DIRS = ["storage/session_diff", "storage/session_diff_base", "storage/session_share"] as const

export const FIXED_MEMBERS = [...FIXED_FILES, ...FIXED_DIRS] as const

export function aggregate(files: ManifestFile[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  let buf = ""
  for (const f of sorted) buf += `${f.path}:${f.bytes}:${f.sha256}\n`
  return sha256Bytes(buf)
}

export function verifyAggregate(m: ManifestV1): boolean {
  return aggregate(m.files) === m.aggregate_sha256
}

export function sortFiles(files: ManifestFile[]): ManifestFile[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path))
}

export function parseAndValidateManifest(raw: string): ManifestV1 {
  let m: any
  try {
    m = JSON.parse(raw)
  } catch {
    throw new Error("manifest json parse failed")
  }
  if (m.version !== 1) throw new Error(`unsupported manifest version ${m.version}`)
  if (typeof m.archive_id !== "string" || !isValidArchiveID(m.archive_id)) throw new Error(`invalid archive_id ${m.archive_id}`)
  if (typeof m.aggregate_sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(m.aggregate_sha256)) throw new Error("invalid aggregate_sha256")
  if (!Array.isArray(m.files) || !Array.isArray(m.absent) || !Array.isArray(m.empty_dirs)) throw new Error("manifest arrays missing")
  if (typeof m.source_data_root !== "string") throw new Error("invalid source_data_root")
  if (typeof m.created_at !== "string") throw new Error("invalid created_at")
  const files: ManifestFile[] = m.files
  const absent: string[] = m.absent
  const empty: string[] = m.empty_dirs
  // exact member count checks: files+absent+empty must not exceed fixed, but we verify membership precisely below
  const seen = new Set<string>()
  for (const f of files) {
    if (typeof f.path !== "string" || typeof f.bytes !== "number" || typeof f.sha256 !== "string") throw new Error(`invalid file entry ${JSON.stringify(f)}`)
    if (!isConfinedPosixRel(f.path)) throw new Error(`path traversal or unconfined ${f.path}`)
    if (!/^[0-9a-f]{64}$/i.test(f.sha256)) throw new Error(`invalid sha256 ${f.path}`)
    if (!Number.isInteger(f.bytes) || f.bytes < 0) throw new Error(`invalid bytes ${f.path}`)
    if (seen.has(f.path)) throw new Error(`duplicate manifest path ${f.path}`)
    seen.add(f.path)
    // unknown path check
    const isFixedFile = (FIXED_FILES as readonly string[]).includes(f.path)
    const isUnderFixedDir = (FIXED_DIRS as readonly string[]).some((d) => f.path === d || f.path.startsWith(d + "/"))
    if (!isFixedFile && !isUnderFixedDir) throw new Error(`unknown manifest path ${f.path}`)
    // for fixed file, ensure not also in absent/empty conflict later
  }
  // validate absent entries
  const absentSet = new Set<string>()
  for (const a of absent) {
    if (typeof a !== "string") throw new Error("invalid absent entry")
    if (!isConfinedPosixRel(a)) throw new Error(`absent traversal ${a}`)
    if (absentSet.has(a)) throw new Error(`duplicate absent ${a}`)
    absentSet.add(a)
    if (seen.has(a)) throw new Error(`conflicting path present and absent ${a}`)
    if (!(FIXED_MEMBERS as readonly string[]).includes(a)) throw new Error(`unknown absent member ${a}`)
  }
  const emptySet = new Set<string>()
  for (const e of empty) {
    if (typeof e !== "string") throw new Error("invalid empty_dirs entry")
    if (!isConfinedPosixRel(e)) throw new Error(`empty_dirs traversal ${e}`)
    if (emptySet.has(e)) throw new Error(`duplicate empty_dirs ${e}`)
    emptySet.add(e)
    if (seen.has(e)) throw new Error(`conflicting path present and empty ${e}`)
    if (absentSet.has(e)) throw new Error(`conflicting absent and empty ${e}`)
    if (!(FIXED_DIRS as readonly string[]).includes(e)) throw new Error(`unknown empty_dirs ${e}`)
  }
  // complete present/absent accounting: each FIXED member must be accounted
  for (const fixed of FIXED_FILES) {
    const present = files.some((f) => f.path === fixed)
    const isAbsent = absentSet.has(fixed)
    // session-export wal/shm dependency: if main absent, wal/shm must be absent (already enforced via absent membership), but also ensure not present when main absent
    if (fixed === "session-export.db-wal" || fixed === "session-export.db-shm") {
      const mainPresent = files.some((f) => f.path === "session-export.db")
      const mainAbsent = absentSet.has("session-export.db")
      if (mainAbsent && present) throw new Error(`conflicting wal present while main absent ${fixed}`)
      // otherwise one of present/absent
    }
    if (present && isAbsent) throw new Error(`fixed member both present and absent ${fixed}`)
    if (!present && !isAbsent) throw new Error(`fixed member not accounted ${fixed}`)
  }
  for (const dir of FIXED_DIRS) {
    const hasFiles = files.some((f) => f.path.startsWith(dir + "/"))
    const isAbsent = absentSet.has(dir)
    const isEmpty = emptySet.has(dir)
    const count = (hasFiles ? 1 : 0) + (isAbsent ? 1 : 0) + (isEmpty ? 1 : 0)
    if (count !== 1) throw new Error(`fixed dir not exactly accounted ${dir} count=${count}`)
  }
  // sorted check
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  for (let i = 0; i < sorted.length; i++) if (sorted[i]!.path !== files[i]!.path) throw new Error("files not sorted")
  const calc = aggregate(files)
  if (calc !== m.aggregate_sha256) throw new Error("aggregate mismatch")
  return m as ManifestV1
}

export function isValidManifestPath(p: string): boolean {
  return isConfinedPosixRel(p)
}
