// kilocode_change - shared bounded skill tar.gz parser (pure leaf)
// Single source for safe marketplace skill archive parsing. Pure: only
// node:zlib plus byte/string logic. No Effect, fs, or fetch. Importable by
// the VS Code extension now (`@opencode-ai/core/kilocode/skill-archive`)
// and the CLI later. Owners validate bytes first, then write.

import { gunzipSync } from "node:zlib"

export const SKILL_ARCHIVE_LIMITS = {
  maxCompressedBytes: 8 * 1024 * 1024,
  maxDecompressedBytes: 32 * 1024 * 1024,
  maxEntries: 512,
  maxFileBytes: 8 * 1024 * 1024,
  maxPathChars: 512,
  maxDepth: 16,
  maxBasenameChars: 255,
} as const

export type SkillArchiveLimits = {
  readonly maxCompressedBytes?: number
  readonly maxDecompressedBytes?: number
  readonly maxEntries?: number
  readonly maxFileBytes?: number
  readonly maxPathChars?: number
  readonly maxDepth?: number
  readonly maxBasenameChars?: number
}

export type SkillArchiveEntryType = "file" | "directory"

export interface SkillArchiveEntry {
  readonly name: string
  readonly type: SkillArchiveEntryType
  readonly data?: Uint8Array
}

export const SKILL_ARCHIVE_ERROR_CODES = [
  "compressed-too-large",
  "decompressed-too-large",
  "invalid-gzip",
  "truncated",
  "bad-checksum",
  "invalid-header",
  "unsupported-entry",
  "unsupported-metadata",
  "multi-root",
  "flat-archive",
  "empty-archive",
  "unsafe-path",
  "path-too-long",
  "path-too-deep",
  "duplicate-path",
  "file-too-large",
  "too-many-entries",
] as const

export type SkillArchiveErrorCode = (typeof SKILL_ARCHIVE_ERROR_CODES)[number]

export class SkillArchiveError extends Error {
  readonly code: SkillArchiveErrorCode
  constructor(code: SkillArchiveErrorCode, message: string) {
    super(message)
    this.name = "SkillArchiveError"
    this.code = code
  }
}

type ResolvedLimits = {
  readonly maxCompressedBytes: number
  readonly maxDecompressedBytes: number
  readonly maxEntries: number
  readonly maxFileBytes: number
  readonly maxPathChars: number
  readonly maxDepth: number
  readonly maxBasenameChars: number
}

function resolve(opts?: SkillArchiveLimits): ResolvedLimits {
  return {
    maxCompressedBytes: opts?.maxCompressedBytes ?? SKILL_ARCHIVE_LIMITS.maxCompressedBytes,
    maxDecompressedBytes: opts?.maxDecompressedBytes ?? SKILL_ARCHIVE_LIMITS.maxDecompressedBytes,
    maxEntries: opts?.maxEntries ?? SKILL_ARCHIVE_LIMITS.maxEntries,
    maxFileBytes: opts?.maxFileBytes ?? SKILL_ARCHIVE_LIMITS.maxFileBytes,
    maxPathChars: opts?.maxPathChars ?? SKILL_ARCHIVE_LIMITS.maxPathChars,
    maxDepth: opts?.maxDepth ?? SKILL_ARCHIVE_LIMITS.maxDepth,
    maxBasenameChars: opts?.maxBasenameChars ?? SKILL_ARCHIVE_LIMITS.maxBasenameChars,
  }
}

function fail(code: SkillArchiveErrorCode, message: string): never {
  throw new SkillArchiveError(code, message)
}

const decoder = new TextDecoder()

function gunzip(input: Uint8Array, lim: ResolvedLimits): Uint8Array {
  if (input.byteLength > lim.maxCompressedBytes) fail("compressed-too-large", "Compressed archive exceeds the size limit")
  if (input.byteLength === 0) fail("invalid-gzip", "Archive is empty")
  let out: Uint8Array
  try {
    const raw = gunzipSync(input as unknown as Parameters<typeof gunzipSync>[0], {
      maxOutputLength: lim.maxDecompressedBytes,
    } as unknown as Parameters<typeof gunzipSync>[1])
    out = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  } catch (err) {
    if (err instanceof SkillArchiveError) throw err
    const code = (err as { code?: unknown }).code
    const message = err instanceof Error ? err.message : String(err)
    if (code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|max output|too large/i.test(message)) {
      fail("decompressed-too-large", "Decompressed archive exceeds the size limit")
    }
    fail("invalid-gzip", "Archive is not valid gzip")
  }
  // Defense in depth: runtimes without maxOutputLength enforcement still cap here.
  if (out!.byteLength > lim.maxDecompressedBytes) fail("decompressed-too-large", "Decompressed archive exceeds the size limit")
  return out!
}

function readText(buf: Uint8Array, off: number, len: number): string {
  let end = off
  while (end < off + len && buf[end] !== 0) end += 1
  for (let i = end; i < off + len; i += 1) {
    if (buf[i] !== 0) fail("invalid-header", "Tar header string is not NUL-padded")
  }
  return decoder.decode(buf.subarray(off, end))
}

function readOctal(buf: Uint8Array, off: number, len: number, label: string): number {
  const slice = buf.subarray(off, off + len)
  if (slice.length !== len) fail("truncated", `Tar header ${label} is truncated`)
  if (slice[0] === 0x80 || slice[0] === 0xff) fail("unsupported-metadata", `Tar base-256 ${label} is not supported`)
  const text = decoder.decode(slice).replace(/\0/g, "").replace(/ /g, "")
  if (text.length === 0) return 0
  if (!/^[0-7]+$/.test(text)) fail("invalid-header", `Tar header ${label} is not octal`)
  const value = parseInt(text, 8)
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid-header", `Tar header ${label} is out of range`)
  return value
}

function isZeroBlock(buf: Uint8Array, off: number): boolean {
  for (let i = 0; i < 512; i += 1) {
    if (buf[off + i] !== 0) return false
  }
  return true
}

function allZero(buf: Uint8Array, off: number): boolean {
  for (let i = off; i < buf.length; i += 1) {
    if (buf[i] !== 0) return false
  }
  return true
}

type Raw = {
  readonly raw: string
  readonly type: SkillArchiveEntryType
  readonly data: Uint8Array
}

const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

function checkSegment(seg: string): void {
  if (seg.length === 0 || seg === "." || seg === "..") fail("unsafe-path", "Archive path escapes its directory")
  for (let i = 0; i < seg.length; i += 1) {
    const c = seg.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) fail("unsafe-path", "Archive path contains control characters")
  }
  if (seg.includes(":")) fail("unsafe-path", "Archive path contains a drive or stream separator")
  if (seg.endsWith(".") || seg.endsWith(" ")) fail("unsafe-path", "Archive path has a trailing dot or space")
  if (DEVICE.test(seg)) fail("unsafe-path", "Archive path targets a reserved device name")
}

function normKey(name: string): string {
  return name.normalize("NFC").toLowerCase()
}

function parseTar(buf: Uint8Array, lim: ResolvedLimits): Raw[] {
  if (buf.byteLength % 512 !== 0) fail("truncated", "Tar stream length is not block-aligned")
  if (buf.byteLength < 512) fail("truncated", "Tar stream is truncated")
  const raws: Raw[] = []
  let off = 0
  while (off + 512 <= buf.byteLength) {
    if (isZeroBlock(buf, off)) {
      if (!allZero(buf, off)) fail("invalid-header", "Tar stream has data after the end marker")
      break
    }
    if (raws.length >= lim.maxEntries) fail("too-many-entries", "Archive has too many entries")
    const name = readText(buf, off, 100)
    const size = readOctal(buf, off + 124, 12, "size")
    const checksum = readOctal(buf, off + 148, 8, "checksum")
    let sum = 0
    for (let i = 0; i < 512; i += 1) {
      sum += i >= 148 && i < 156 ? 0x20 : buf[off + i]!
    }
    if (sum !== checksum) fail("bad-checksum", "Tar header checksum mismatch")
    const flag = buf[off + 156]!
    const link = readText(buf, off + 157, 100)
    // ustar magic: "ustar" + NUL/space. Covers marketplace GNU tars and plain ustar.
    const magic =
      buf[off + 257] === 0x75 &&
      buf[off + 258] === 0x73 &&
      buf[off + 259] === 0x74 &&
      buf[off + 260] === 0x61 &&
      buf[off + 261] === 0x72 &&
      (buf[off + 262] === 0x00 || buf[off + 262] === 0x20)
    if (!magic) fail("invalid-header", "Tar header is not ustar")
    const prefix = readText(buf, off + 345, 155)
    const full = prefix.length > 0 ? `${prefix}/${name}` : name
    const dataStart = off + 512
    const dataEnd = dataStart + size
    if (dataEnd > buf.byteLength) fail("truncated", "Tar entry data is truncated")
    if (flag === 0x67 || flag === 0x78 || flag === 0x4c || flag === 0x4b) {
      fail("unsupported-metadata", "Tar PAX or GNU longname metadata is not supported")
    }
    const isFile = flag === 0x00 || flag === 0x30
    const isDir = flag === 0x35
    if (!isFile && !isDir) {
      if (flag === 0x31 || flag === 0x32) fail("unsupported-entry", "Tar hardlink or symlink entries are not allowed")
      if (flag === 0x33 || flag === 0x34) fail("unsupported-entry", "Tar device entries are not allowed")
      if (flag === 0x36) fail("unsupported-entry", "Tar fifo entries are not allowed")
      fail("unsupported-entry", "Tar entry type is not allowed")
    }
    if (link.length > 0) fail("unsupported-entry", "Tar link entries are not allowed")
    if (isDir && size !== 0) fail("invalid-header", "Tar directory entry must have zero size")
    if (isFile && size > lim.maxFileBytes) fail("file-too-large", "Archive file exceeds the size limit")
    const pad = (512 - (size % 512)) % 512
    for (let i = 0; i < pad; i += 1) {
      if (buf[dataEnd + i] !== 0) fail("invalid-header", "Tar entry padding is not zero")
    }
    const data = isFile ? buf.slice(dataStart, dataEnd) : new Uint8Array(0)
    raws.push({ raw: full, type: isFile ? "file" : "directory", data })
    off = dataEnd + pad
  }
  if (raws.length === 0) fail("empty-archive", "Archive has no entries")
  return raws
}

function stripRoot(raws: readonly Raw[]): { root: string; stripped: { name: string; type: SkillArchiveEntryType; data: Uint8Array }[] } {
  const roots = new Set<string>()
  const bases: string[] = []
  for (const entry of raws) {
    if (entry.raw.includes("\\")) fail("unsafe-path", "Archive path contains a backslash")
    if (entry.raw.startsWith("/")) fail("unsafe-path", "Archive path is absolute")
    const base = entry.type === "directory" && entry.raw.endsWith("/") ? entry.raw.slice(0, -1) : entry.raw
    if (base.length === 0) fail("unsafe-path", "Archive path is empty")
    bases.push(base)
    const slash = base.indexOf("/")
    roots.add(slash < 0 ? base : base.slice(0, slash))
  }
  if (roots.size > 1) fail("multi-root", "Archive has more than one top-level directory")
  const root = [...roots][0]!
  if (root.length === 0 || root === "." || root === "..") fail("unsafe-path", "Archive root is not usable")
  if (root.includes(":") || DEVICE.test(root)) fail("unsafe-path", "Archive root is not usable")
  if (root.endsWith(".") || root.endsWith(" ")) fail("unsafe-path", "Archive root is not usable")
  for (let i = 0; i < root.length; i += 1) {
    const c = root.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) fail("unsafe-path", "Archive root is not usable")
  }
  const stripped: { name: string; type: SkillArchiveEntryType; data: Uint8Array }[] = []
  for (let i = 0; i < raws.length; i += 1) {
    const entry = raws[i]!
    const base = bases[i]!
    if (base === root) {
      if (entry.type !== "directory") fail("flat-archive", "Archive has no top-level directory")
      continue
    }
    if (!base.startsWith(`${root}/`)) fail("multi-root", "Archive has more than one top-level directory")
    const name = base.slice(root.length + 1)
    if (name.length === 0) continue
    stripped.push({ name, type: entry.type, data: entry.data })
  }
  if (stripped.length === 0) fail("empty-archive", "Archive has no entries")
  return { root, stripped }
}

function validateNames(items: { name: string; type: SkillArchiveEntryType; data: Uint8Array }[], lim: ResolvedLimits): SkillArchiveEntry[] {
  const seen = new Map<string, SkillArchiveEntryType>()
  const files = new Set<string>()
  const out: SkillArchiveEntry[] = []
  for (const item of items) {
    const name = item.name
    if (name.includes("\\")) fail("unsafe-path", "Archive path contains a backslash")
    if (name.startsWith("/")) fail("unsafe-path", "Archive path is absolute")
    if (name.length > lim.maxPathChars) fail("path-too-long", "Archive path exceeds the length limit")
    const segs = name.split("/")
    if (segs.length > lim.maxDepth) fail("path-too-deep", "Archive path exceeds the depth limit")
    for (const seg of segs) checkSegment(seg)
    const base = segs[segs.length - 1]!
    if (base.length > lim.maxBasenameChars) fail("path-too-long", "Archive file name exceeds the length limit")
    const lower = normKey(name)
    if (seen.has(lower)) fail("duplicate-path", "Archive has duplicate paths")
    // Parent must not be a file.
    let prefix = ""
    for (let i = 0; i < segs.length - 1; i += 1) {
      prefix = i === 0 ? segs[0]! : `${prefix}/${segs[i]!}`
      if (files.has(normKey(prefix))) fail("duplicate-path", "Archive path conflicts with a file")
    }
    // A new file must not shadow an existing directory tree.
    if (item.type === "file") {
      for (const key of seen.keys()) {
        if (key.startsWith(`${lower}/`)) fail("duplicate-path", "Archive path conflicts with a directory")
      }
    }
    seen.set(lower, item.type)
    if (item.type === "file") files.add(lower)
    out.push(item.type === "file" ? { name, type: "file", data: item.data.slice() } : { name, type: "directory" })
  }
  return out
}

/**
 * Parse bounded skill tar.gz bytes into normalized root-stripped entries.
 * Throws SkillArchiveError with a user-mappable code on any violation.
 */
export function parseSkillArchive(input: Uint8Array, opts?: SkillArchiveLimits): readonly SkillArchiveEntry[] {
  const lim = resolve(opts)
  const raw = gunzip(input, lim)
  const parsed = parseTar(raw, lim)
  if (parsed.length > lim.maxEntries) fail("too-many-entries", "Archive has too many entries")
  const { stripped } = stripRoot(parsed)
  if (stripped.length > lim.maxEntries) fail("too-many-entries", "Archive has too many entries")
  return validateNames(stripped, lim)
}

export function isSkillArchiveError(err: unknown): err is SkillArchiveError {
  return err instanceof SkillArchiveError
}

export const SkillArchive = {
  LIMITS: SKILL_ARCHIVE_LIMITS,
  ERROR_CODES: SKILL_ARCHIVE_ERROR_CODES,
  parse: parseSkillArchive,
  isError: isSkillArchiveError,
}
