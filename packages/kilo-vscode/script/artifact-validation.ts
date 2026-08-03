/**
 * Native CLI artifact + VSIX archive validation for production packaging.
 *
 * Kilo-owned extension script (packages/kilo-vscode). Uses only Node built-in
 * APIs (fs, zlib) — no Bun `$`, no external `file`/`unzip` binaries — so it
 * runs identically on every build platform and is directly unit-testable.
 *
 * Purpose (LOCK-005 / LOCK-006):
 *   - reject source wrappers and the `.cli-version` development marker that
 *     local-bin.ts stages into bin/,
 *   - verify the staged native binary magic, architecture, and ELF libc ABI
 *     (glibc vs musl) match the target,
 *   - inspect the produced .vsix archive (ZIP central directory) for required
 *     entries, absence of `.cli-version`, duplicate names, structural bounds,
 *     and packaged CLI content/magic with CRC-32 integrity on every required
 *     entry.
 *
 * The ELF libc check is structural, not heuristic: it parses the ELF program
 * header table for PT_INTERP and classifies glibc vs musl from the interpreter
 * path. This matches the production pipeline, which patches these exact
 * interpreters (packages/opencode/script/build.ts): glibc
 * `/lib64/ld-linux-x86-64.so.2` / `/lib/ld-linux-aarch64.so.1`, musl
 * `/lib/ld-musl-x86_64.so.1` / `/lib/ld-musl-aarch64.so.1`. An ELF without a
 * provable interpreter is rejected rather than silently accepted.
 */

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"

export interface TargetConfig {
  /** Canonical extension target, e.g. "darwin-arm64". */
  target: string
  /** Package directory under opencode dist/, e.g. "@kilocode/cli-darwin-arm64". */
  cliDir: string
  /** Binary name staged into bin/, e.g. "kilo" or "kilo.exe". */
  binary: string
}

/** Canonical production target matrix shared by the builder and validation. */
export const VSIX_TARGET_CONFIGS: readonly TargetConfig[] = [
  { target: "linux-x64", cliDir: "@kilocode/cli-linux-x64", binary: "kilo" },
  { target: "linux-arm64", cliDir: "@kilocode/cli-linux-arm64", binary: "kilo" },
  { target: "alpine-x64", cliDir: "@kilocode/cli-linux-x64-musl", binary: "kilo" },
  { target: "alpine-arm64", cliDir: "@kilocode/cli-linux-arm64-musl", binary: "kilo" },
  { target: "darwin-x64", cliDir: "@kilocode/cli-darwin-x64", binary: "kilo" },
  { target: "darwin-arm64", cliDir: "@kilocode/cli-darwin-arm64", binary: "kilo" },
  { target: "win32-x64", cliDir: "@kilocode/cli-windows-x64", binary: "kilo.exe" },
  { target: "win32-arm64", cliDir: "@kilocode/cli-windows-arm64", binary: "kilo.exe" },
]

export class ValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ValidationError"
  }
}

export function isKnownTarget(raw: string): boolean {
  return VSIX_TARGET_CONFIGS.some((c) => c.target === raw)
}

/** Resolve the canonical target config, throwing on unknown targets. */
export function targetConfig(target: string): TargetConfig {
  const config = VSIX_TARGET_CONFIGS.find((c) => c.target === target)
  if (!config) throw new ValidationError("target", `Unknown VSIX target "${target}"`)
  return config
}

/** Canonical form of a requested `--target` value (LOCK-008 selection). */
export function normalizeTarget(raw: string): string {
  return targetConfig(raw).target
}

/** Current Bun platform as an extension target, e.g. "darwin-arm64". */
export function currentPlatformTarget(): string {
  const os = process.platform === "win32" ? "win32" : process.platform
  return `${os}-${process.arch}`
}

export function expectedFormat(target: string): BinaryFormat {
  if (target.startsWith("darwin")) return "mach-o"
  if (target.startsWith("win32")) return "pe"
  if (target.startsWith("linux") || target.startsWith("alpine")) return "elf"
  throw new ValidationError("target", `Unknown VSIX target "${target}"`)
}

export function expectedArch(target: string): ArchKind {
  if (target.endsWith("-arm64")) return "arm64"
  if (target.endsWith("-x64")) return "x64"
  throw new ValidationError("target", `Unknown VSIX target "${target}"`)
}

// ---------------------------------------------------------------------------
// Binary format detection (magic + architecture, never file size)
// ---------------------------------------------------------------------------

export type BinaryFormat = "mach-o" | "elf" | "pe" | "wrapper" | "unknown"
export type ArchKind = "x64" | "arm64" | "x86" | "arm" | "other"

export interface BinaryInfo {
  format: BinaryFormat
  /** Architectures present in the artifact (fat Mach-O may carry several). */
  archs: readonly ArchKind[]
  /**
   * ELF libc family proven from the PT_INTERP program header (LOCK-005).
   * Present only when the ELF exposes an unambiguous interpreter; undefined
   * for Mach-O/PE and for ELF whose interpreter cannot be proven (absent or
   * unrecognized path).
   */
  abi?: "glibc" | "musl"
}

const CPU_X86_64 = 0x01000007
const CPU_ARM64 = 0x0100000c
const CPU_X86 = 0x00000007
const CPU_ARM = 0x0000000c
const EM_X86_64 = 62
const EM_AARCH64 = 183
const EM_386 = 3
const EM_ARM = 40
const PE_X64 = 0x8664
const PE_ARM64 = 0xaa64
const PE_I386 = 0x014c
const PE_ARM = 0x01c4
const ELF_CLASS32 = 1
const ELF_CLASS64 = 2
const ELF_DATA_LSB = 1
const ELF_DATA_MSB = 2
const PT_INTERP = 3

function matches(buf: Uint8Array, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false
  for (let i = 0; i < bytes.length; i++) {
    if (buf[i] !== bytes[i]) return false
  }
  return true
}

function cpuArch(cpu: number): ArchKind {
  if (cpu === CPU_ARM64) return "arm64"
  if (cpu === CPU_X86_64) return "x64"
  if (cpu === CPU_ARM) return "arm"
  if (cpu === CPU_X86) return "x86"
  return "other"
}

function machineArch(machine: number): ArchKind {
  if (machine === EM_AARCH64) return "arm64"
  if (machine === EM_X86_64) return "x64"
  if (machine === EM_ARM) return "arm"
  if (machine === EM_386) return "x86"
  return "other"
}

function peArch(machine: number): ArchKind {
  if (machine === PE_ARM64) return "arm64"
  if (machine === PE_X64) return "x64"
  if (machine === PE_ARM) return "arm"
  if (machine === PE_I386) return "x86"
  return "other"
}

/**
 * Classify a CLI artifact from its header bytes.
 *
 * Order matters: shebang and binary magics are checked before any text marker
 * scan, so a genuine ELF/PE/Mach-O payload can never be mistaken for a
 * wrapper even if it embeds wrapper-like strings.
 */
export function detectBinary(buf: Uint8Array): BinaryInfo {
  if (matches(buf, [0x23, 0x21])) return { format: "wrapper", archs: [] }
  if (matches(buf, [0x7f, 0x45, 0x4c, 0x46])) return detectElf(buf)
  if (matches(buf, [0x4d, 0x5a])) return detectPe(buf)
  if (buf.length >= 8) {
    // Fat Mach-O: `ca fe ba be` is the canonical big-endian magic; the byte
    // order of the cputype fields follows whichever spelling matched.
    const fatBe = matches(buf, [0xca, 0xfe, 0xba, 0xbe])
    const fatLe = matches(buf, [0xbe, 0xba, 0xfe, 0xca])
    if (fatBe || fatLe) return detectMachoFat(buf, fatLe)
    // Mach-O 64/32 magics as they appear on disk. `cf fa ed fe` is the
    // little-endian spelling of MH_MAGIC_64 (header fields little-endian);
    // `fe ed fa cf` is the big-endian spelling (fields big-endian). Bun's
    // compiled binaries use the little-endian spelling on Apple Silicon.
    const macho64Le = matches(buf, [0xcf, 0xfa, 0xed, 0xfe])
    const macho64Be = matches(buf, [0xfe, 0xed, 0xfa, 0xcf])
    const macho32Le = matches(buf, [0xce, 0xfa, 0xed, 0xfe])
    const macho32Be = matches(buf, [0xfe, 0xed, 0xfa, 0xce])
    if (macho64Le || macho64Be || macho32Le || macho32Be) {
      const is64 = macho64Le || macho64Be
      const little = macho64Le || macho32Le
      return detectMachoThin(buf, is64, little)
    }
  }
  // Text wrappers that somehow lack a shebang (e.g. generated on Windows).
  const head = new TextDecoder().decode(buf.subarray(0, 512))
  if (head.includes("src/index.ts") || head.includes("--conditions=browser") || head.includes("KILO_MODELS_PATH")) {
    return { format: "wrapper", archs: [] }
  }
  return { format: "unknown", archs: [] }
}

/**
 * Structurally validate a PE container.
 *
 * Guards the DOS header minimum length (e_lfanew lives at 0x3c, so the DOS
 * header is at least 64 bytes), the e_lfanew offset, the "PE\0\0" signature,
 * and the full 20-byte COFF header that follows it. Malformed/truncated PE
 * inputs throw a controlled ValidationError("pe") instead of a raw RangeError
 * (LOCK-005). An MZ image that never claims a PE signature stays "unknown".
 */
function detectPe(buf: Uint8Array): BinaryInfo {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf.length < 0x40) {
    throw new ValidationError("pe", "PE DOS header truncated")
  }
  const pe = dv.getUint32(0x3c, true)
  if (pe < 0x40 || pe + 4 > buf.length || !matches(buf.subarray(pe), [0x50, 0x45, 0, 0])) {
    return { format: "unknown", archs: [] }
  }
  if (pe + 24 > buf.length) {
    throw new ValidationError("pe", "PE COFF header truncated")
  }
  return { format: "pe", archs: [peArch(dv.getUint16(pe + 4, true))] }
}

/**
 * Structurally validate a fat Mach-O header.
 *
 * Bounds the architecture table (8 + count*20 bytes) and every slice's
 * offset+size range against the file, so a truncated fat binary is rejected
 * with a controlled ValidationError("mach-o") instead of a raw RangeError
 * from an out-of-bounds table read (LOCK-005).
 */
function detectMachoFat(buf: Uint8Array, little: boolean): BinaryInfo {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const count = dv.getUint32(4, little)
  if (buf.length < 8 + count * 20) {
    throw new ValidationError("mach-o", "fat Mach-O architecture table truncated")
  }
  const archs: ArchKind[] = []
  for (let i = 0; i < count; i++) {
    const base = 8 + i * 20
    const kind = cpuArch(dv.getUint32(base, little))
    const offset = dv.getUint32(base + 8, little)
    const size = dv.getUint32(base + 12, little)
    if (offset > buf.length || size > buf.length - offset) {
      throw new ValidationError("mach-o", "fat Mach-O slice exceeds file bounds")
    }
    if (!archs.includes(kind)) archs.push(kind)
  }
  return { format: "mach-o", archs }
}

/**
 * Structurally validate a thin Mach-O header (32/64-bit).
 *
 * Enforces the full header length — an 8-byte magic+cputype fragment is not a
 * Mach-O (LOCK-005) — then bounds the load-command table (headerLen +
 * sizeofcmds) against the file and walks every load command to prove it stays
 * inside sizeofcmds.
 */
function detectMachoThin(buf: Uint8Array, is64: boolean, little: boolean): BinaryInfo {
  const headerLen = is64 ? 32 : 28
  if (buf.length < headerLen) {
    throw new ValidationError("mach-o", `Mach-O ${is64 ? 64 : 32}-bit header truncated`)
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const ncmds = dv.getUint32(16, little)
  const sizeofcmds = dv.getUint32(20, little)
  if (headerLen + sizeofcmds > buf.length) {
    throw new ValidationError("mach-o", "Mach-O load commands exceed file bounds")
  }
  let p = 0
  for (let i = 0; i < ncmds; i++) {
    if (p + 8 > sizeofcmds) {
      throw new ValidationError("mach-o", "Mach-O load command table truncated")
    }
    const cmdsize = dv.getUint32(headerLen + p + 4, little)
    if (cmdsize < 8 || p + cmdsize > sizeofcmds) {
      throw new ValidationError("mach-o", "Mach-O load command exceeds file bounds")
    }
    p += cmdsize
  }
  return { format: "mach-o", archs: [cpuArch(dv.getUint32(4, little))] }
}

/**
 * Structurally validate an ELF and derive format/archs/libc ABI.
 *
 * Checks the e_ident class + data encoding, header size, program header table
 * bounds, and PT_INTERP segment bounds. Malformed/truncated ELF inputs throw a
 * controlled ValidationError("elf") instead of an uncaught RangeError.
 */
function detectElf(buf: Uint8Array): BinaryInfo {
  if (buf.length < 20) {
    throw new ValidationError("elf", "ELF header truncated")
  }
  const cls = buf[4]
  const data = buf[5]
  if (cls !== ELF_CLASS32 && cls !== ELF_CLASS64) {
    throw new ValidationError("elf", `Unsupported ELF class ${cls}`)
  }
  if (data !== ELF_DATA_LSB && data !== ELF_DATA_MSB) {
    throw new ValidationError("elf", `Unsupported ELF data encoding ${data}`)
  }
  const little = data === ELF_DATA_LSB
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return {
    format: "elf",
    archs: [machineArch(dv.getUint16(18, little))],
    abi: parseElfAbi(buf, dv, cls === ELF_CLASS64, little),
  }
}

/**
 * Parse the ELF program header table and classify the libc family from the
 * PT_INTERP interpreter path. Returns undefined when the interpreter is absent
 * or unrecognized so callers can reject an unprovable ABI (LOCK-005).
 */
function parseElfAbi(buf: Uint8Array, dv: DataView, is64: boolean, little: boolean): "glibc" | "musl" | undefined {
  const minEhsize = is64 ? 64 : 52
  // Guard every fixed-offset read below: a file long enough for e_ident but
  // too short for the full header previously threw a raw RangeError
  // (LOCK-005).
  if (buf.length < minEhsize) {
    throw new ValidationError("elf", "ELF header truncated")
  }
  const ehsize = dv.getUint16(is64 ? 52 : 40, little)
  if (ehsize < minEhsize) {
    throw new ValidationError("elf", `ELF header size ${ehsize} is smaller than the ${is64 ? "64" : "32"}-bit minimum`)
  }
  if (buf.length < ehsize) {
    throw new ValidationError("elf", "ELF header truncated")
  }
  const phentsize = dv.getUint16(is64 ? 54 : 42, little)
  const phnum = dv.getUint16(is64 ? 56 : 44, little)
  const minPhentsize = is64 ? 56 : 32
  if (phnum > 0 && phentsize < minPhentsize) {
    throw new ValidationError(
      "elf",
      `ELF program header size ${phentsize} is smaller than the ${is64 ? "64" : "32"}-bit minimum`,
    )
  }
  const phoff = is64 ? dv.getUint32(32, little) + dv.getUint32(36, little) * 0x100000000 : dv.getUint32(28, little)
  if (phnum > 0 && phoff + phnum * phentsize > buf.length) {
    throw new ValidationError("elf", "ELF program header table exceeds file bounds")
  }
  let interp: string | undefined
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize
    if (dv.getUint32(p, little) !== PT_INTERP) continue
    const poff = is64
      ? dv.getUint32(p + 8, little) + dv.getUint32(p + 12, little) * 0x100000000
      : dv.getUint32(p + 4, little)
    const psz = is64
      ? dv.getUint32(p + 32, little) + dv.getUint32(p + 36, little) * 0x100000000
      : dv.getUint32(p + 16, little)
    if (poff + psz > buf.length) {
      throw new ValidationError("elf", "ELF PT_INTERP segment exceeds file bounds")
    }
    const bytes = buf.subarray(poff, poff + psz)
    let nul = bytes.indexOf(0)
    if (nul < 0) nul = bytes.length
    interp = new TextDecoder().decode(bytes.subarray(0, nul)).trim()
    break
  }
  if (!interp) return undefined
  // glibc loaders are `ld-linux-*` / `ld64.so`; musl loaders are `ld-musl-*`.
  // Anything else (e.g. uClibc, bionic) is ambiguous and must not be accepted.
  if (interp.includes("musl")) return "musl"
  if (interp.includes("ld-linux") || interp.includes("ld64.so") || interp.includes("ld-lsb")) return "glibc"
  return undefined
}

/**
 * Validate native binary bytes against a target: not a wrapper, correct
 * container format, the target architecture present, and (for ELF targets)
 * the libc ABI proven from PT_INTERP.
 */
export function validateNativeBinary(buf: Uint8Array, target: string): void {
  const info = detectBinary(buf)
  if (info.format === "wrapper") {
    throw new ValidationError("wrapper", `CLI artifact is a source wrapper, not a native binary (target ${target})`)
  }
  const want = expectedFormat(target)
  if (info.format !== want) {
    throw new ValidationError("format", `CLI artifact is ${info.format}, expected ${want} for target ${target}`)
  }
  const arch = expectedArch(target)
  if (!info.archs.includes(arch)) {
    throw new ValidationError(
      "arch",
      `CLI artifact architectures ${info.archs.join(",") || "unknown"} do not include ${arch} for target ${target}`,
    )
  }
  const wantAbi = expectedAbi(target)
  if (wantAbi) {
    if (!info.abi) {
      throw new ValidationError(
        "abi",
        `CLI artifact does not expose a PT_INTERP program interpreter, so its libc ABI for target ${target} cannot be proven`,
      )
    }
    if (info.abi !== wantAbi) {
      throw new ValidationError("abi", `CLI artifact libc ABI is ${info.abi}, expected ${wantAbi} for target ${target}`)
    }
  }
}

/** Required ELF libc family for a target; undefined for non-ELF targets. */
function expectedAbi(target: string): "glibc" | "musl" | undefined {
  if (target.startsWith("linux")) return "glibc"
  if (target.startsWith("alpine")) return "musl"
  return undefined
}

export function validateNativeBinaryFile(file: string, target: string): void {
  validateNativeBinary(readFileSync(file), target)
}

// ---------------------------------------------------------------------------
// Staged bin/ validation (runs before `vsce package`)
// ---------------------------------------------------------------------------

const TREE_SITTER_DIR = "tree-sitter"
const TREE_SITTER_RUNTIME = "tree-sitter.wasm"
const SANDBOX_WORKER = "kilo-sandbox-mutation-worker.js"

function ffmpegName(target: string): string {
  return target.startsWith("win32") ? "ffmpeg.exe" : "ffmpeg"
}

/** Required staged files, relative to binDir, mirroring the production copy steps. */
export function requiredStagedFiles(target: string): string[] {
  const cfg = targetConfig(target)
  const files = [join(TREE_SITTER_DIR, TREE_SITTER_RUNTIME), SANDBOX_WORKER]
  if (cfg.target !== "win32-arm64") files.push(ffmpegName(cfg.target))
  return files
}

/**
 * Validate the staged bin/ directory before packaging (LOCK-005): native
 * binary present with correct magic/arch, no `.cli-version` marker, and all
 * required staged resources present.
 */
export function validateStagedBinDir(binDir: string, target: string): void {
  const cfg = targetConfig(target)
  const binary = join(binDir, cfg.binary)
  if (!existsSync(binary)) {
    throw new ValidationError("missing-binary", `CLI binary not found at ${binary}`)
  }
  const marker = join(binDir, ".cli-version")
  if (existsSync(marker)) {
    throw new ValidationError("marker", `Source build marker ${marker} must not be staged for production`)
  }
  validateNativeBinaryFile(binary, target)
  for (const file of requiredStagedFiles(target)) {
    const staged = join(binDir, file)
    if (!existsSync(staged)) {
      throw new ValidationError("missing-staged", `Required staged file not found: ${staged}`)
    }
  }
}

// ---------------------------------------------------------------------------
// ZIP / VSIX archive inspection (pure JS + node:zlib)
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  /** CRC-32 from the central directory, verified against decompressed data. */
  crc: number
}

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
/** General-purpose bit 3: local header sizes are zero, central is authoritative. */
const FLAG_DATA_DESCRIPTOR = 0x08

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (IEEE, reflected, ZIP conventions) over a byte span; no I/O. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** List entries by reading the ZIP central directory (no external `unzip`). */
export function listZipEntries(buf: Uint8Array): ZipEntry[] {
  if (buf.length < 22) {
    throw new ValidationError("zip", "ZIP end-of-central-directory record not found")
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = -1
  const min = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ValidationError("zip", "ZIP end-of-central-directory record not found")
  const commentLen = dv.getUint16(eocd + 20, true)
  if (eocd + 22 + commentLen > buf.length) {
    throw new ValidationError("zip", "ZIP EOCD comment exceeds file bounds")
  }
  const count = dv.getUint16(eocd + 10, true)
  const cdSize = dv.getUint32(eocd + 12, true)
  const cdOffset = dv.getUint32(eocd + 16, true)
  if (cdOffset + cdSize > buf.length) {
    throw new ValidationError("zip", "ZIP central directory exceeds file bounds")
  }
  const entries: ZipEntry[] = []
  const seen = new Set<string>()
  let p = cdOffset
  const end = cdOffset + cdSize
  while (p < end) {
    if (p + 46 > end) {
      throw new ValidationError("zip", "ZIP central directory entry truncated")
    }
    if (dv.getUint32(p, true) !== CD_SIG) {
      throw new ValidationError("zip", `Invalid central directory signature at offset ${p}`)
    }
    const method = dv.getUint16(p + 10, true)
    const crc = dv.getUint32(p + 16, true)
    const compressedSize = dv.getUint32(p + 20, true)
    const uncompressedSize = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const entryCommentLen = dv.getUint16(p + 32, true)
    const localHeaderOffset = dv.getUint32(p + 42, true)
    if (p + 46 + nameLen + extraLen + entryCommentLen > end) {
      throw new ValidationError("zip", "ZIP central directory entry exceeds file bounds")
    }
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen)).replaceAll("\\", "/")
    if (seen.has(name)) {
      throw new ValidationError("duplicate", `ZIP contains duplicate entry name "${name}"`)
    }
    seen.add(name)
    if (localHeaderOffset >= buf.length) {
      throw new ValidationError("zip", `ZIP entry "${name}" has an invalid local header offset`)
    }
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset, crc })
    p += 46 + nameLen + extraLen + entryCommentLen
  }
  if (entries.length !== count) {
    throw new ValidationError("zip", `Central directory has ${entries.length} entries, EOCD claims ${count}`)
  }
  return entries
}

/**
 * Extract and inflate one entry (store or deflate) using node:zlib, validating
 * local-header bounds, local/central filename + method + size consistency, and
 * CRC-32 of the decompressed data.
 */
export function readZipEntry(buf: Uint8Array, entry: ZipEntry): Uint8Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (entry.localHeaderOffset + 30 > buf.length) {
    throw new ValidationError("zip", `Local header for ${entry.name} exceeds file bounds`)
  }
  if (dv.getUint32(entry.localHeaderOffset, true) !== LOCAL_SIG) {
    throw new ValidationError("zip", `Invalid local header for ${entry.name}`)
  }
  const localFlags = dv.getUint16(entry.localHeaderOffset + 6, true)
  const localMethod = dv.getUint16(entry.localHeaderOffset + 8, true)
  const localCompressed = dv.getUint32(entry.localHeaderOffset + 18, true)
  const localUncompressed = dv.getUint32(entry.localHeaderOffset + 22, true)
  const nameLen = dv.getUint16(entry.localHeaderOffset + 26, true)
  const extraLen = dv.getUint16(entry.localHeaderOffset + 28, true)
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen
  if (dataStart + entry.compressedSize > buf.length) {
    throw new ValidationError("zip", `Data for ${entry.name} exceeds file bounds`)
  }
  const localName = new TextDecoder()
    .decode(buf.subarray(entry.localHeaderOffset + 30, entry.localHeaderOffset + 30 + nameLen))
    .replaceAll("\\", "/")
  if (localName !== entry.name) {
    throw new ValidationError("zip", `Local header name "${localName}" does not match central "${entry.name}"`)
  }
  if (localMethod !== entry.method) {
    throw new ValidationError(
      "zip",
      `Local header method ${localMethod} does not match central ${entry.method} for ${entry.name}`,
    )
  }
  // Without a data descriptor (general-purpose bit 3) local sizes are
  // authoritative and must agree with the central directory.
  if ((localFlags & FLAG_DATA_DESCRIPTOR) === 0) {
    if (localCompressed !== entry.compressedSize || localUncompressed !== entry.uncompressedSize) {
      throw new ValidationError("zip", `Local header sizes do not match central directory for ${entry.name}`)
    }
  }
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize)
  let out: Uint8Array
  if (entry.method === 0) {
    out = raw
  } else if (entry.method === 8) {
    try {
      out = inflateRawSync(raw)
    } catch {
      throw new ValidationError("zip", `Corrupt deflate stream for ${entry.name}`)
    }
  } else {
    throw new ValidationError("zip", `Unsupported compression method ${entry.method} for ${entry.name}`)
  }
  if (out.length !== entry.uncompressedSize) {
    throw new ValidationError("zip", `Uncompressed size mismatch for ${entry.name}`)
  }
  if (crc32(out) !== entry.crc) {
    throw new ValidationError("zip", `CRC-32 mismatch for ${entry.name}`)
  }
  return out
}

export function zipEntryNames(buf: Uint8Array): string[] {
  return listZipEntries(buf).map((e) => e.name)
}

/** Required VSIX entries (paths inside the archive, `extension/` prefix). */
export function requiredVsixEntries(target: string): string[] {
  const cfg = targetConfig(target)
  const files = [
    "extension/package.json",
    "extension/dist/extension.js",
    `extension/bin/${cfg.binary}`,
    "extension/bin/tree-sitter/tree-sitter.wasm",
    "extension/bin/kilo-sandbox-mutation-worker.js",
  ]
  if (cfg.target !== "win32-arm64") {
    files.push(`extension/bin/${ffmpegName(cfg.target)}`)
  }
  return files
}

/**
 * Validate a produced .vsix archive for a target: required entries present,
 * no `.cli-version` marker, every required entry passing local/central
 * consistency, size, and CRC-32 checks, and the packaged CLI being a native
 * binary matching the target format, architecture, and libc ABI
 * (LOCK-005 / LOCK-006).
 */
export function validateVsixBuffer(buf: Uint8Array, target: string): void {
  const cfg = targetConfig(target)
  const entries = listZipEntries(buf)
  const names = new Set(entries.map((e) => e.name))
  for (const name of requiredVsixEntries(target)) {
    if (!names.has(name)) {
      throw new ValidationError("missing-entry", `VSIX is missing required entry ${name}`)
    }
  }
  if (names.has("extension/bin/.cli-version")) {
    throw new ValidationError(
      "marker",
      "VSIX contains extension/bin/.cli-version; the source build marker must not ship",
    )
  }
  const binaryName = `extension/bin/${cfg.binary}`
  for (const name of requiredVsixEntries(target)) {
    const zipEntry = entries.find((e) => e.name === name)
    if (!zipEntry) throw new ValidationError("missing-entry", `VSIX is missing required entry ${name}`)
    const content = readZipEntry(buf, zipEntry)
    if (name === binaryName) {
      validateNativeBinary(content, target)
    }
  }
}

export function validateVsixFile(file: string, target: string): void {
  validateVsixBuffer(readFileSync(file), target)
}
