/**
 * Focused tests for production artifact validation (LOCK-005 / LOCK-006 / LOCK-008).
 *
 * Exercises the actual implementation in script/artifact-validation.ts:
 * target parsing/mapping, native binary magic + architecture detection
 * (Mach-O incl. fat/arm64/x64, ELF, PE), staged bin/ rejection of source
 * wrappers and `.cli-version`, and ZIP/VSIX archive inspection with
 * packaged CLI content validation. Negative fixtures are synthesized inline
 * (native headers + deflate ZIP); the real freshly packaged `out/` VSIX is
 * validated as a positive artifact only when it exists on disk (LOCK-006).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { deflateRawSync } from "node:zlib"
import {
  VSIX_TARGET_CONFIGS,
  crc32,
  currentPlatformTarget,
  detectBinary,
  expectedArch,
  expectedFormat,
  isKnownTarget,
  listZipEntries,
  normalizeTarget,
  readZipEntry,
  requiredStagedFiles,
  requiredVsixEntries,
  targetConfig,
  ValidationError,
  validateNativeBinary,
  validateStagedBinDir,
  validateVsixBuffer,
  validateVsixFile,
} from "../../script/artifact-validation"
import type { ArchKind, BinaryFormat } from "../../script/artifact-validation"

const CPU_X86_64 = 0x01000007
const CPU_ARM64 = 0x0100000c
const EM_X86_64 = 62
const EM_AARCH64 = 183

const ELF_INTERPS: Record<"glibc" | "musl" | "weird", string> = {
  glibc: "/lib64/ld-linux-x86-64.so.2",
  musl: "/lib/ld-musl-x86_64.so.1",
  weird: "/lib/ld-uClibc.so.0",
}

interface ElfOpts {
  /**
   * e_ident class byte (1 = 32-bit, 2 = 64-bit). Other values are written
   * verbatim to synthesize malformed headers for negative tests.
   */
  cls?: number
  /**
   * e_ident data byte (1 = LSB, 2 = MSB). Other values are written verbatim
   * to synthesize malformed headers for negative tests.
   */
  data?: number
  /**
   * PT_INTERP policy: "glibc"/"musl" write a matching interpreter program
   * header, "none" writes no program header, "weird" writes an interpreter
   * that matches neither family.
   */
  abi?: "glibc" | "musl" | "none" | "weird"
}

/**
 * Structurally valid minimal ELF with an optional PT_INTERP program header.
 * Defaults mirror Bun-compiled binaries: ELF64, LSB, glibc interpreter.
 */
function elf(machine: number, opts: ElfOpts = {}): Buffer {
  const cls = opts.cls ?? 2
  const data = opts.data ?? 1
  const abi = opts.abi ?? "glibc"
  const is64 = cls === 2
  const little = data === 1
  const ehsize = is64 ? 64 : 52
  const phentsize = is64 ? 56 : 32
  const interpPath = abi === "none" ? "" : ELF_INTERPS[abi]
  const interp = Buffer.from(interpPath ? `${interpPath}\0` : "")
  const phnum = interp.length ? 1 : 0
  const phoff = ehsize
  const buf = Buffer.alloc(ehsize + phnum * phentsize + interp.length)
  buf[0] = 0x7f
  buf[1] = 0x45
  buf[2] = 0x4c
  buf[3] = 0x46
  buf[4] = cls
  buf[5] = data
  const w16 = (off: number, v: number) => (little ? buf.writeUInt16LE(v, off) : buf.writeUInt16BE(v, off))
  const w32 = (off: number, v: number) => (little ? buf.writeUInt32LE(v, off) : buf.writeUInt32BE(v, off))
  w16(18, machine)
  if (is64) {
    w16(52, ehsize)
    w16(54, phentsize)
    w16(56, phnum)
    w32(32, phoff)
    if (phnum) {
      w32(phoff, 3) // PT_INTERP
      w32(phoff + 8, ehsize + phentsize) // p_offset -> interpreter string
      w32(phoff + 32, interp.length) // p_filesz
      w32(phoff + 40, interp.length) // p_memsz
    }
  } else {
    w16(40, ehsize)
    w16(42, phentsize)
    w16(44, phnum)
    w32(28, phoff)
    if (phnum) {
      w32(phoff, 3) // PT_INTERP
      w32(phoff + 4, ehsize + phentsize) // p_offset -> interpreter string
      w32(phoff + 16, interp.length) // p_filesz
      w32(phoff + 20, interp.length) // p_memsz
    }
  }
  interp.copy(buf, ehsize + phnum * phentsize)
  return buf
}

function le32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

function be32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

function u16le(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}

/**
 * Minimal thin Mach-O header with a given cputype.
 * `littleEndian` selects the on-disk magic spelling: `cf fa ed fe` (LE fields,
 * as Bun compiles) or `fe ed fa cf` (BE fields). `is32` switches to the 32-bit
 * magics (`ce fa ed fe` / `fe ed fa ce`).
 */
function machoThin(cpu: number, littleEndian = true, is32 = false): Buffer {
  const magic = littleEndian
    ? is32
      ? [0xce, 0xfa, 0xed, 0xfe]
      : [0xcf, 0xfa, 0xed, 0xfe]
    : is32
      ? [0xfe, 0xed, 0xfa, 0xce]
      : [0xfe, 0xed, 0xfa, 0xcf]
  const head = Buffer.from(magic)
  const cpuBytes = littleEndian ? le32(cpu) : be32(cpu)
  return Buffer.concat([head, cpuBytes, Buffer.alloc(128)])
}

/**
 * Minimal fat Mach-O with the given big-endian cputypes. Slices are laid out
 * inside the buffer with real offsets/sizes so the structural bounds checks
 * accept them.
 */
function machoFat(cpus: number[]): Buffer {
  const head = Buffer.concat([be32(0xcafebabe), be32(cpus.length)])
  const slices = cpus.map((cpu) => Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), le32(cpu), Buffer.alloc(128)]))
  const tableBase = 8 + cpus.length * 20
  const arches = cpus.map((cpu, i) => {
    const offset = tableBase + slices.slice(0, i).reduce((sum, s) => sum + s.length, 0)
    return Buffer.concat([be32(cpu), be32(0), be32(offset), be32(slices[i].length), be32(12)])
  })
  return Buffer.concat([head, ...arches, ...slices])
}

/** Minimal PE header with the given COFF machine. */
function pe(machine: number): Buffer {
  const buf = Buffer.alloc(192)
  buf.write("MZ", 0)
  buf.writeUInt32LE(0x80, 0x3c)
  buf.write("PE\0\0", 0x80)
  buf.writeUInt16LE(machine, 0x84)
  return buf
}

const WRAPPER = Buffer.from(
  '#!/usr/bin/env bash\nset -euo pipefail\ncd "/Users/x/repos/kilocode/packages/opencode"\n' +
    'export KILO_MODELS_PATH="${KILO_MODELS_PATH:-/Users/x/.../models-api.json}"\n' +
    'exec "/usr/local/bin/bun" --conditions=browser src/index.ts "$@"\n',
)

function expectValidation(fn: () => void, code: string) {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as ValidationError).code).toBe(code)
    return
  }
  throw new Error(`expected ValidationError with code "${code}", but validation passed`)
}

// ---------------------------------------------------------------------------
// Target parsing / mapping (LOCK-008)
// ---------------------------------------------------------------------------

describe("target parsing and mapping", () => {
  it("accepts every canonical target unchanged", () => {
    for (const cfg of VSIX_TARGET_CONFIGS) {
      expect(normalizeTarget(cfg.target)).toBe(cfg.target)
      expect(isKnownTarget(cfg.target)).toBe(true)
    }
  })

  it("rejects unknown targets", () => {
    for (const bad of ["darwin-ppc", "linux-riscv64", "win32-ia32", "bogus", "", "darwin-ARM64"]) {
      expect(isKnownTarget(bad)).toBe(false)
      expect(() => normalizeTarget(bad)).toThrow(ValidationError)
      expect(() => targetConfig(bad)).toThrow(ValidationError)
    }
  })

  it("maps each target to the opencode dist cliDir and binary name", () => {
    const expectConfig = (target: string, cliDir: string, binary: string) => {
      expect(targetConfig(target)).toEqual({ target, cliDir, binary })
    }
    expectConfig("linux-x64", "@kilocode/cli-linux-x64", "kilo")
    expectConfig("linux-arm64", "@kilocode/cli-linux-arm64", "kilo")
    expectConfig("alpine-x64", "@kilocode/cli-linux-x64-musl", "kilo")
    expectConfig("alpine-arm64", "@kilocode/cli-linux-arm64-musl", "kilo")
    expectConfig("darwin-x64", "@kilocode/cli-darwin-x64", "kilo")
    expectConfig("darwin-arm64", "@kilocode/cli-darwin-arm64", "kilo")
    expectConfig("win32-x64", "@kilocode/cli-windows-x64", "kilo.exe")
    expectConfig("win32-arm64", "@kilocode/cli-windows-arm64", "kilo.exe")
  })

  it("maps expected format and arch per target", () => {
    const cases: [string, BinaryFormat, ArchKind][] = [
      ["linux-x64", "elf", "x64"],
      ["linux-arm64", "elf", "arm64"],
      ["alpine-x64", "elf", "x64"],
      ["alpine-arm64", "elf", "arm64"],
      ["darwin-x64", "mach-o", "x64"],
      ["darwin-arm64", "mach-o", "arm64"],
      ["win32-x64", "pe", "x64"],
      ["win32-arm64", "pe", "arm64"],
    ]
    for (const [target, format, arch] of cases) {
      expect(expectedFormat(target)).toBe(format)
      expect(expectedArch(target)).toBe(arch)
    }
  })

  it("currentPlatformTarget is a known target matching the Bun runtime", () => {
    const current = currentPlatformTarget()
    const os = process.platform === "win32" ? "win32" : process.platform
    expect(current).toBe(`${os}-${process.arch}`)
    expect(isKnownTarget(current)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Native binary detection (magic + architecture)
// ---------------------------------------------------------------------------

describe("native binary detection", () => {
  it("detects thin Mach-O arm64 and x64", () => {
    expect(detectBinary(machoThin(CPU_ARM64))).toEqual({ format: "mach-o", archs: ["arm64"] })
    expect(detectBinary(machoThin(CPU_X86_64))).toEqual({ format: "mach-o", archs: ["x64"] })
  })

  it("detects little-endian magic (Bun-compiled layout) and big-endian magic", () => {
    // `cf fa ed fe` + LE cputype is what Bun compiles on Apple Silicon.
    expect(detectBinary(machoThin(CPU_ARM64)).format).toBe("mach-o")
    expect(detectBinary(machoThin(CPU_ARM64)).archs).toEqual(["arm64"])
    // `fe ed fa cf` + BE cputype is the true big-endian spelling.
    const info = detectBinary(machoThin(CPU_ARM64, false))
    expect(info.format === "mach-o").toBe(true)
    expect(info.archs.includes("arm64")).toBe(true)
  })

  it("detects fat Mach-O with multiple architectures", () => {
    expect(detectBinary(machoFat([CPU_ARM64, CPU_X86_64]))).toEqual({
      format: "mach-o",
      archs: ["arm64", "x64"],
    })
    expect(detectBinary(machoFat([CPU_ARM64])).archs).toEqual(["arm64"])
  })

  it("detects 32-bit Mach-O with the 32-bit header layout", () => {
    expect(detectBinary(machoThin(CPU_ARM64, true, true))).toEqual({ format: "mach-o", archs: ["arm64"] })
  })

  it("rejects truncated thin Mach-O headers that are magic-valid (LOCK-005)", () => {
    // Magic + cputype only (8 bytes) is not a Mach-O, for 64-bit and 32-bit.
    expectValidation(() => detectBinary(machoThin(CPU_ARM64).subarray(0, 8)), "mach-o")
    expectValidation(() => detectBinary(machoThin(CPU_ARM64, true, true).subarray(0, 8)), "mach-o")
    expectValidation(() => detectBinary(machoThin(CPU_ARM64).subarray(0, 31)), "mach-o")
  })

  it("rejects a Mach-O whose load-command table exceeds the file bounds", () => {
    const thin = machoThin(CPU_ARM64)
    thin.writeUInt32LE(0xffffffff, 20) // sizeofcmds -> huge
    expectValidation(() => detectBinary(thin), "mach-o")
  })

  it("rejects a Mach-O load-command table that walks out of bounds", () => {
    const thin = machoThin(CPU_ARM64)
    thin.writeUInt32LE(1, 16) // ncmds = 1
    thin.writeUInt32LE(8, 20) // sizeofcmds = 8 (one command slot)
    thin.writeUInt32LE(0xffff, 32 + 4) // first load command cmdsize -> huge
    expectValidation(() => detectBinary(thin), "mach-o")
  })

  it("rejects a fat Mach-O with a truncated architecture table", () => {
    expectValidation(() => detectBinary(machoFat([CPU_ARM64, CPU_X86_64]).subarray(0, 12)), "mach-o")
  })

  it("rejects a fat Mach-O slice that exceeds the file bounds", () => {
    const fat = machoFat([CPU_ARM64])
    fat.writeUInt32BE(0x7fffffff, 8 + 8) // first arch offset -> far past EOF
    expectValidation(() => detectBinary(fat), "mach-o")
  })

  it("detects ELF64 x64 and arm64 with their libc ABI", () => {
    expect(detectBinary(elf(EM_X86_64))).toEqual({ format: "elf", archs: ["x64"], abi: "glibc" })
    expect(detectBinary(elf(EM_AARCH64, { abi: "musl" }))).toEqual({ format: "elf", archs: ["arm64"], abi: "musl" })
  })

  it("distinguishes glibc from musl via PT_INTERP and leaves unprovable ABI unset", () => {
    expect(detectBinary(elf(EM_X86_64, { abi: "musl" }))).toEqual({ format: "elf", archs: ["x64"], abi: "musl" })
    expect(detectBinary(elf(EM_AARCH64))).toEqual({ format: "elf", archs: ["arm64"], abi: "glibc" })
    // No PT_INTERP program header -> ABI cannot be proven.
    expect(detectBinary(elf(EM_X86_64, { abi: "none" }))).toEqual({ format: "elf", archs: ["x64"], abi: undefined })
    // An interpreter that matches neither glibc nor musl is ambiguous.
    expect(detectBinary(elf(EM_X86_64, { abi: "weird" })).abi).toBeUndefined()
  })

  it("detects ELF32 and big-endian ELF64 with correct field decoding", () => {
    expect(detectBinary(elf(EM_X86_64, { cls: 1 }))).toEqual({ format: "elf", archs: ["x64"], abi: "glibc" })
    expect(detectBinary(elf(EM_AARCH64, { data: 2, abi: "musl" }))).toEqual({
      format: "elf",
      archs: ["arm64"],
      abi: "musl",
    })
  })

  it("rejects malformed or truncated ELF headers with controlled ValidationErrors", () => {
    expectValidation(() => detectBinary(elf(EM_X86_64, { cls: 3 })), "elf")
    expectValidation(() => detectBinary(elf(EM_X86_64, { data: 3 })), "elf")
    // Truncated ELF header (magic + class/data but far too short).
    expectValidation(() => detectBinary(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01])), "elf")
    // Program header table extends past the end of the file.
    expectValidation(() => detectBinary(elf(EM_X86_64).subarray(0, 64)), "elf")
    // 20-byte ELF64: fixed-offset header reads used to throw a raw RangeError.
    expectValidation(() => detectBinary(elf(EM_X86_64).subarray(0, 20)), "elf")
    expectValidation(() => detectBinary(elf(EM_X86_64, { cls: 1 }).subarray(0, 20)), "elf")
  })

  it("detects PE x64 and arm64", () => {
    expect(detectBinary(pe(0x8664))).toEqual({ format: "pe", archs: ["x64"] })
    expect(detectBinary(pe(0xaa64))).toEqual({ format: "pe", archs: ["arm64"] })
  })

  it("rejects a truncated PE DOS header that is magic-valid (LOCK-005)", () => {
    // "MZ" + e_lfanew but far too short to read the offset safely.
    expectValidation(() => detectBinary(Buffer.concat([Buffer.from("MZ"), le32(0x80)])), "pe")
  })

  it("rejects a PE whose COFF header is truncated past the signature", () => {
    const buf = Buffer.alloc(0x46)
    buf.write("MZ", 0)
    buf.writeUInt32LE(0x40, 0x3c)
    buf.write("PE\0\0", 0x40)
    buf.writeUInt16LE(0x8664, 0x44)
    expectValidation(() => detectBinary(buf), "pe")
  })

  it("classifies source wrappers (shebang and marker text)", () => {
    expect(detectBinary(WRAPPER).format).toBe("wrapper")
    const noShebang = Buffer.from('cd "/x"\nexec "/usr/local/bin/bun" --conditions=browser src/index.ts "$@"\n')
    expect(detectBinary(noShebang).format).toBe("wrapper")
  })

  it("classifies plain text and short garbage as unknown", () => {
    expect(detectBinary(Buffer.from("hello world, definitely not a binary"))).toEqual({
      format: "unknown",
      archs: [],
    })
    expect(detectBinary(Buffer.from([1, 2, 3]))).toEqual({ format: "unknown", archs: [] })
  })

  it("treats MZ without a PE signature as unknown, not PE", () => {
    const mz = Buffer.alloc(200)
    mz.write("MZ", 0)
    expect(detectBinary(mz).format).toBe("unknown")
  })
})

describe("validateNativeBinary", () => {
  it("accepts matching format + architecture per target", () => {
    validateNativeBinary(machoThin(CPU_ARM64), "darwin-arm64")
    validateNativeBinary(machoThin(CPU_X86_64), "darwin-x64")
    validateNativeBinary(machoFat([CPU_ARM64, CPU_X86_64]), "darwin-arm64")
    validateNativeBinary(elf(EM_X86_64), "linux-x64")
    validateNativeBinary(elf(EM_AARCH64), "linux-arm64")
    validateNativeBinary(elf(EM_X86_64, { abi: "musl" }), "alpine-x64")
    validateNativeBinary(elf(EM_AARCH64, { abi: "musl" }), "alpine-arm64")
    validateNativeBinary(pe(0x8664), "win32-x64")
    validateNativeBinary(pe(0xaa64), "win32-arm64")
  })

  it("rejects a wrong or unprovable libc ABI with the abi code", () => {
    // glibc binary staged for Alpine.
    expectValidation(() => validateNativeBinary(elf(EM_X86_64), "alpine-x64"), "abi")
    expectValidation(() => validateNativeBinary(elf(EM_AARCH64), "alpine-arm64"), "abi")
    // musl binary staged for glibc Linux.
    expectValidation(() => validateNativeBinary(elf(EM_X86_64, { abi: "musl" }), "linux-x64"), "abi")
    expectValidation(() => validateNativeBinary(elf(EM_AARCH64, { abi: "musl" }), "linux-arm64"), "abi")
    // No PT_INTERP -> cannot prove the ABI.
    expectValidation(() => validateNativeBinary(elf(EM_X86_64, { abi: "none" }), "linux-x64"), "abi")
    expectValidation(() => validateNativeBinary(elf(EM_X86_64, { abi: "none" }), "alpine-x64"), "abi")
    // Ambiguous interpreter -> cannot prove the ABI.
    expectValidation(() => validateNativeBinary(elf(EM_X86_64, { abi: "weird" }), "alpine-x64"), "abi")
    expectValidation(() => validateNativeBinary(elf(EM_X86_64, { abi: "weird" }), "linux-x64"), "abi")
  })

  it("rejects a source wrapper with the wrapper code", () => {
    expectValidation(() => validateNativeBinary(WRAPPER, "darwin-arm64"), "wrapper")
  })

  it("rejects unknown content with the format code", () => {
    expectValidation(() => validateNativeBinary(Buffer.from("plain text payload"), "darwin-arm64"), "format")
    expectValidation(() => validateNativeBinary(machoThin(CPU_ARM64), "linux-arm64"), "format")
    expectValidation(() => validateNativeBinary(elf(EM_AARCH64), "win32-arm64"), "format")
  })

  it("rejects a wrong-architecture binary with the arch code", () => {
    expectValidation(() => validateNativeBinary(machoThin(CPU_X86_64), "darwin-arm64"), "arch")
    expectValidation(() => validateNativeBinary(machoThin(CPU_ARM64), "darwin-x64"), "arch")
    expectValidation(() => validateNativeBinary(elf(EM_AARCH64), "linux-x64"), "arch")
    expectValidation(() => validateNativeBinary(elf(EM_X86_64, { abi: "musl" }), "alpine-arm64"), "arch")
    expectValidation(() => validateNativeBinary(pe(0x8664), "win32-arm64"), "arch")
  })

  it("rejects truncated magic-valid artifacts fail-closed with controlled errors (LOCK-005)", () => {
    expectValidation(() => validateNativeBinary(machoThin(CPU_ARM64).subarray(0, 8), "darwin-arm64"), "mach-o")
    expectValidation(() => validateNativeBinary(machoFat([CPU_ARM64]).subarray(0, 12), "darwin-arm64"), "mach-o")
    expectValidation(() => validateNativeBinary(Buffer.concat([Buffer.from("MZ"), le32(0x80)]), "win32-x64"), "pe")
    expectValidation(() => validateNativeBinary(elf(EM_X86_64).subarray(0, 20), "linux-x64"), "elf")
  })
})

// ---------------------------------------------------------------------------
// Staged bin/ validation
// ---------------------------------------------------------------------------

describe("validateStagedBinDir", () => {
  let root: string

  function stageDir(target: string, binary: Buffer, extra: string[] = []): string {
    const cfg = targetConfig(target)
    const dir = path.join(root, target)
    fs.mkdirSync(path.join(dir, "tree-sitter"), { recursive: true })
    fs.writeFileSync(path.join(dir, cfg.binary), binary)
    fs.writeFileSync(path.join(dir, "tree-sitter", "tree-sitter.wasm"), "wasm")
    fs.writeFileSync(path.join(dir, "kilo-sandbox-mutation-worker.js"), "worker")
    fs.writeFileSync(path.join(dir, "ffmpeg"), "ffmpeg")
    fs.writeFileSync(path.join(dir, "ffmpeg.exe"), "ffmpeg")
    for (const file of extra) fs.writeFileSync(path.join(dir, file), "extra")
    return dir
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-validation-"))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("accepts a complete staged dir with a native arm64 binary", () => {
    const dir = stageDir("darwin-arm64", machoThin(CPU_ARM64))
    validateStagedBinDir(dir, "darwin-arm64")
    expect(requiredStagedFiles("darwin-arm64")).toEqual([
      "tree-sitter/tree-sitter.wasm",
      "kilo-sandbox-mutation-worker.js",
      "ffmpeg",
    ])
  })

  it("rejects the .cli-version development marker", () => {
    const dir = stageDir("darwin-arm64", machoThin(CPU_ARM64), [".cli-version"])
    expectValidation(() => validateStagedBinDir(dir, "darwin-arm64"), "marker")
  })

  it("rejects a missing native binary", () => {
    const cfg = targetConfig("darwin-arm64")
    const dir = path.join(root, "no-bin")
    fs.mkdirSync(dir, { recursive: true })
    fs.mkdirSync(path.join(dir, "tree-sitter"), { recursive: true })
    fs.writeFileSync(path.join(dir, "tree-sitter", "tree-sitter.wasm"), "wasm")
    fs.writeFileSync(path.join(dir, "kilo-sandbox-mutation-worker.js"), "worker")
    fs.writeFileSync(path.join(dir, "ffmpeg"), "ffmpeg")
    // no bin/kilo written
    expectValidation(() => validateStagedBinDir(dir, "darwin-arm64"), "missing-binary")
    expect(cfg.binary).toBe("kilo")
  })

  it("rejects a source wrapper staged as the binary", () => {
    const dir = stageDir("darwin-arm64", WRAPPER)
    expectValidation(() => validateStagedBinDir(dir, "darwin-arm64"), "wrapper")
  })

  it("rejects a wrong-architecture staged binary", () => {
    const dir = stageDir("darwin-arm64", machoThin(CPU_X86_64))
    expectValidation(() => validateStagedBinDir(dir, "darwin-arm64"), "arch")
  })

  it("rejects missing required staged files", () => {
    const cfg = targetConfig("darwin-arm64")
    const dir = path.join(root, "partial")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, cfg.binary), machoThin(CPU_ARM64))
    // no tree-sitter.wasm, no worker, no ffmpeg
    expectValidation(() => validateStagedBinDir(dir, "darwin-arm64"), "missing-staged")
  })

  it("does not require ffmpeg.exe for win32-arm64", () => {
    const cfg = targetConfig("win32-arm64")
    const dir = path.join(root, "win32-arm64")
    fs.mkdirSync(path.join(dir, "tree-sitter"), { recursive: true })
    fs.writeFileSync(path.join(dir, cfg.binary), pe(0xaa64))
    fs.writeFileSync(path.join(dir, "tree-sitter", "tree-sitter.wasm"), "wasm")
    fs.writeFileSync(path.join(dir, "kilo-sandbox-mutation-worker.js"), "worker")
    validateStagedBinDir(dir, "win32-arm64")
    expect(requiredStagedFiles("win32-arm64")).toEqual([
      "tree-sitter/tree-sitter.wasm",
      "kilo-sandbox-mutation-worker.js",
    ])
  })

  it("requires ffmpeg.exe for win32-x64", () => {
    const dir = path.join(root, "win32-x64-no-ffmpeg")
    fs.mkdirSync(path.join(dir, "tree-sitter"), { recursive: true })
    fs.writeFileSync(path.join(dir, "kilo.exe"), pe(0x8664))
    fs.writeFileSync(path.join(dir, "tree-sitter", "tree-sitter.wasm"), "wasm")
    fs.writeFileSync(path.join(dir, "kilo-sandbox-mutation-worker.js"), "worker")
    expectValidation(() => validateStagedBinDir(dir, "win32-x64"), "missing-staged")
  })
})

// ---------------------------------------------------------------------------
// ZIP / VSIX archive validation
// ---------------------------------------------------------------------------

interface ZipSourceEntry {
  name: string
  content: Buffer
  /** CRC-32 written into both headers (default: real CRC of content). */
  crc?: number
  /** Compressed size written into both headers (default: actual). */
  compressedSize?: number
  /** Uncompressed size written into both headers (default: actual). */
  uncompressedSize?: number
  /** Compression method for both headers (default 8 = deflate; 0 = store). */
  method?: number
  /** Method written only into the local header, to force a mismatch. */
  localMethod?: number
}

/** Minimal ZIP writer for fixtures (deflate via node:zlib, real CRC32). */
function makeZip(entries: ZipSourceEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const method = entry.method ?? 8
    const localMethod = entry.localMethod ?? method
    const compressed = method === 0 ? entry.content : deflateRawSync(entry.content)
    const crc = entry.crc ?? crc32(entry.content)
    const csize = entry.compressedSize ?? compressed.length
    const usize = entry.uncompressedSize ?? entry.content.length
    const flags = 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(localMethod, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(csize, 18)
    local.writeUInt32LE(usize, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(csize, 20)
    central.writeUInt32LE(usize, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + compressed.length
  }

  const centralStart = offset
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(centralStart, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

const VSIX_COMMON = (kilo: Buffer): ZipSourceEntry[] => [
  { name: "extension.vsixmanifest", content: Buffer.from("<manifest/>") },
  { name: "[Content_Types].xml", content: Buffer.from("<types/>") },
  { name: "extension/package.json", content: Buffer.from('{"name":"kilo-code"}') },
  { name: "extension/dist/extension.js", content: Buffer.from("module.exports = {}") },
  { name: "extension/bin/kilo", content: kilo },
  { name: "extension/bin/tree-sitter/tree-sitter.wasm", content: Buffer.from("wasm") },
  { name: "extension/bin/kilo-sandbox-mutation-worker.js", content: Buffer.from("worker") },
  { name: "extension/bin/ffmpeg", content: Buffer.from("ffmpeg") },
]

describe("ZIP archive inspection", () => {
  it("lists and extracts deflated entries round-trip", () => {
    const archive = makeZip([
      { name: "a.txt", content: Buffer.from("hello zip") },
      { name: "bin/kilo", content: machoThin(CPU_ARM64) },
      { name: "empty", content: Buffer.alloc(0) },
    ])
    const entries = listZipEntries(archive)
    expect(entries.map((e) => e.name).sort()).toEqual(["a.txt", "bin/kilo", "empty"].sort())
    expect(readZipEntry(archive, entries.find((e) => e.name === "bin/kilo")!).length).toBe(machoThin(CPU_ARM64).length)
    const text = new TextDecoder().decode(readZipEntry(archive, entries.find((e) => e.name === "a.txt")!))
    expect(text).toBe("hello zip")
    expect(readZipEntry(archive, entries.find((e) => e.name === "empty")!).length).toBe(0)
  })

  it("rejects a non-ZIP buffer", () => {
    expectValidation(() => listZipEntries(Buffer.from("this is not a zip file at all")), "zip")
  })

  it("rejects a buffer too short to hold an EOCD record", () => {
    expectValidation(() => listZipEntries(Buffer.alloc(21)), "zip")
  })

  it("rejects duplicate central directory names", () => {
    const archive = makeZip([
      { name: "dup.txt", content: Buffer.from("one") },
      { name: "dup.txt", content: Buffer.from("two") },
    ])
    expectValidation(() => listZipEntries(archive), "duplicate")
    expectValidation(() => validateVsixBuffer(archive, "darwin-arm64"), "duplicate")
  })

  it("rejects a central directory that exceeds the file bounds", () => {
    const archive = makeZip([{ name: "a.txt", content: Buffer.from("hello") }])
    archive.writeUInt32LE(0xffff, archive.length - 22 + 12) // EOCD cdSize -> huge
    expectValidation(() => listZipEntries(archive), "zip")
  })

  it("rejects an EOCD entry count that does not match the central directory", () => {
    const archive = makeZip([{ name: "a.txt", content: Buffer.from("hello") }])
    archive.writeUInt16LE(0xffff, archive.length - 22 + 10) // EOCD total entry count -> huge
    expectValidation(() => listZipEntries(archive), "zip")
  })

  it("rejects a truncated archive that still contains the EOCD record", () => {
    const archive = makeZip([{ name: "a.txt", content: Buffer.from("hello") }])
    // Cut 10 bytes out of the middle; the trailing EOCD is still present.
    const cut = Buffer.concat([archive.subarray(0, 10), archive.subarray(20)])
    expectValidation(() => listZipEntries(cut), "zip")
  })

  it("rejects entry data that exceeds the file bounds", () => {
    const archive = makeZip([{ name: "a.txt", content: Buffer.from("hello") }])
    const entries = listZipEntries(archive)
    entries[0].compressedSize = 0xffffffff
    expectValidation(() => readZipEntry(archive, entries[0]), "zip")
  })

  it("rejects a CRC-32 mismatch", () => {
    const archive = makeZip([{ name: "a.txt", content: Buffer.from("hello") }])
    const entries = listZipEntries(archive)
    entries[0].crc = 0xdeadbeef
    expectValidation(() => readZipEntry(archive, entries[0]), "zip")
  })

  it("rejects an uncompressed size mismatch", () => {
    const archive = makeZip([{ name: "a.txt", content: Buffer.from("hello") }])
    const entries = listZipEntries(archive)
    entries[0].uncompressedSize = entries[0].uncompressedSize + 1
    expectValidation(() => readZipEntry(archive, entries[0]), "zip")
  })

  it("rejects a local/central filename mismatch", () => {
    const archive = makeZip([{ name: "a.txt", content: Buffer.from("hello") }])
    archive.write("b.txt", 30) // local header name only; central keeps "a.txt"
    const entries = listZipEntries(archive)
    expect(entries[0].name).toBe("a.txt")
    expectValidation(() => readZipEntry(archive, entries[0]), "zip")
  })

  it("rejects a local/central method mismatch", () => {
    const archive = makeZip([{ name: "a.txt", content: Buffer.from("hello"), localMethod: 0 }])
    const entries = listZipEntries(archive)
    expect(entries[0].method).toBe(8)
    expectValidation(() => readZipEntry(archive, entries[0]), "zip")
  })

  it("rejects an unsupported compression method", () => {
    const archive = makeZip([{ name: "a.txt", content: Buffer.from("hello"), method: 12 }])
    const entries = listZipEntries(archive)
    expectValidation(() => readZipEntry(archive, entries[0]), "zip")
  })

  it("reads stored (method 0) entries with correct CRC", () => {
    const archive = makeZip([{ name: "stored.txt", content: Buffer.from("raw store"), method: 0 }])
    const entries = listZipEntries(archive)
    expect(new TextDecoder().decode(readZipEntry(archive, entries[0]))).toBe("raw store")
  })
})

describe("validateVsixBuffer", () => {
  it("accepts a valid archive with a native arm64 binary", () => {
    validateVsixBuffer(makeZip(VSIX_COMMON(machoThin(CPU_ARM64))), "darwin-arm64")
  })

  it("accepts a valid win32-arm64 archive without ffmpeg", () => {
    const cfg = targetConfig("win32-arm64")
    const entries = VSIX_COMMON(pe(0xaa64)).filter((e) => e.name !== "extension/bin/ffmpeg")
    entries.find((e) => e.name === "extension/bin/kilo")!.name = `extension/bin/${cfg.binary}`
    validateVsixBuffer(makeZip(entries), "win32-arm64")
  })

  it("accepts a linux-x64 archive packaging a glibc ELF", () => {
    validateVsixBuffer(makeZip(VSIX_COMMON(elf(EM_X86_64))), "linux-x64")
  })

  it("accepts an alpine-x64 archive packaging a musl ELF", () => {
    validateVsixBuffer(makeZip(VSIX_COMMON(elf(EM_X86_64, { abi: "musl" }))), "alpine-x64")
  })

  it("accepts an alpine-arm64 archive packaging a musl ELF", () => {
    validateVsixBuffer(makeZip(VSIX_COMMON(elf(EM_AARCH64, { abi: "musl" }))), "alpine-arm64")
  })

  it("rejects a linux archive packaging a musl ELF", () => {
    expectValidation(
      () => validateVsixBuffer(makeZip(VSIX_COMMON(elf(EM_X86_64, { abi: "musl" }))), "linux-x64"),
      "abi",
    )
  })

  it("rejects an alpine archive packaging a glibc ELF", () => {
    expectValidation(() => validateVsixBuffer(makeZip(VSIX_COMMON(elf(EM_X86_64))), "alpine-x64"), "abi")
  })

  it("rejects an alpine archive packaging an ELF without a provable ABI", () => {
    expectValidation(
      () => validateVsixBuffer(makeZip(VSIX_COMMON(elf(EM_X86_64, { abi: "none" }))), "alpine-x64"),
      "abi",
    )
  })

  it("rejects a required entry with a corrupt CRC-32", () => {
    const entries = VSIX_COMMON(machoThin(CPU_ARM64))
    const pkg = entries.find((e) => e.name === "extension/package.json")!
    pkg.crc = 0xbadc0de
    expectValidation(() => validateVsixBuffer(makeZip(entries), "darwin-arm64"), "zip")
  })

  it("rejects a required entry with an uncompressed size mismatch", () => {
    const entries = VSIX_COMMON(machoThin(CPU_ARM64))
    const pkg = entries.find((e) => e.name === "extension/package.json")!
    pkg.uncompressedSize = pkg.content.length + 1
    expectValidation(() => validateVsixBuffer(makeZip(entries), "darwin-arm64"), "zip")
  })

  it("rejects a required entry whose data exceeds the archive bounds", () => {
    const entries = VSIX_COMMON(machoThin(CPU_ARM64))
    const pkg = entries.find((e) => e.name === "extension/package.json")!
    pkg.compressedSize = pkg.content.length + 1000
    expectValidation(() => validateVsixBuffer(makeZip(entries), "darwin-arm64"), "zip")
  })

  it("requires the documented VSIX entries", () => {
    const want = requiredVsixEntries("darwin-arm64")
    expect(want).toContain("extension/bin/kilo")
    expect(want).toContain("extension/bin/tree-sitter/tree-sitter.wasm")
    expect(want).toContain("extension/bin/kilo-sandbox-mutation-worker.js")
    expect(want).toContain("extension/dist/extension.js")
    expect(want).toContain("extension/bin/ffmpeg")
    const entries = VSIX_COMMON(machoThin(CPU_ARM64)).filter(
      (e) => e.name !== "extension/bin/tree-sitter/tree-sitter.wasm",
    )
    expectValidation(() => validateVsixBuffer(makeZip(entries), "darwin-arm64"), "missing-entry")
  })

  it("rejects an archive containing the .cli-version marker", () => {
    const entries = [
      ...VSIX_COMMON(machoThin(CPU_ARM64)),
      { name: "extension/bin/.cli-version", content: Buffer.from("hash") },
    ]
    expectValidation(() => validateVsixBuffer(makeZip(entries), "darwin-arm64"), "marker")
  })

  it("rejects an archive packaging a source wrapper as the CLI", () => {
    expectValidation(() => validateVsixBuffer(makeZip(VSIX_COMMON(WRAPPER)), "darwin-arm64"), "wrapper")
  })

  it("rejects an archive packaging a wrong-architecture CLI", () => {
    expectValidation(() => validateVsixBuffer(makeZip(VSIX_COMMON(machoThin(CPU_X86_64))), "darwin-arm64"), "arch")
  })

  it("validates a real .vsix file on disk", () => {
    const file = path.join(os.tmpdir(), `kilo-vscode-validation-${process.pid}.vsix`)
    fs.writeFileSync(file, makeZip(VSIX_COMMON(machoThin(CPU_ARM64))))
    try {
      validateVsixFile(file, "darwin-arm64")
    } finally {
      fs.rmSync(file, { force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// VSIX negative + real-artifact coverage (LOCK-006)
// ---------------------------------------------------------------------------

// Deterministic negative fixtures built in memory with the same ZIP builder
// used above: they never read a mutable production `out/` path, so they pass
// identically before and after the canonical package command.
describe("synthetic invalid VSIX", () => {
  it("rejects an archive packaging a wrapper CLI plus the .cli-version marker", () => {
    const entries = [...VSIX_COMMON(WRAPPER), { name: "extension/bin/.cli-version", content: Buffer.from("hash") }]
    expectValidation(() => validateVsixBuffer(makeZip(entries), "darwin-arm64"), "marker")
  })

  it("rejects an archive packaging a truncated magic-valid native CLI", () => {
    const entries = VSIX_COMMON(machoThin(CPU_ARM64).subarray(0, 8))
    expectValidation(() => validateVsixBuffer(makeZip(entries), "darwin-arm64"), "mach-o")
  })
})

// Real freshly packaged VSIX: only present after the canonical package command
// ran. Validated as a positive artifact without stale expectations — a stale
// marker/wrapper archive fails this, which is exactly the production check.
const REAL_VSIX = path.resolve(import.meta.dir, "../../out/kilo-vscode-darwin-arm64.vsix")
const realVsixPresent = fs.existsSync(REAL_VSIX)

describe.skipIf(!realVsixPresent)("real out/ VSIX", () => {
  it(
    "passes validation as a fresh darwin-arm64 package",
    () => {
      validateVsixFile(REAL_VSIX, "darwin-arm64")
    },
    // Reading + CRC-32 validating the 119 MB real VSIX exceeds the 5s default per-test timeout.
    { timeout: 30_000 },
  )
})
