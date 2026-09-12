import { describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import fs from "node:fs"
import path from "node:path"
import {
  SkillArchive,
  SKILL_ARCHIVE_LIMITS,
  SkillArchiveError,
  parseSkillArchive,
} from "../../src/kilocode/skill-archive"

type Spec = {
  raw: string
  flag: string
  data?: Uint8Array
  magic?: string
  badChecksum?: boolean
  base256?: boolean
  dirSize?: number
  badPad?: boolean
  link?: string
}

const enc = new TextEncoder()

function writeText(buf: Uint8Array, off: number, len: number, text: string): void {
  const bytes = enc.encode(text)
  buf.set(bytes.subarray(0, len), off)
}

function writeOctal(buf: Uint8Array, off: number, len: number, value: number): void {
  const text = value.toString(8).padStart(len - 1, "0") + "\0"
  writeText(buf, off, len, text)
}

function split(raw: string): { name: string; prefix: string } {
  if (raw.length <= 100) return { name: raw, prefix: "" }
  const slash = raw.lastIndexOf("/", raw.length - 1)
  if (slash > 0 && raw.length - slash - 1 <= 100 && slash <= 155) {
    return { name: raw.slice(slash + 1), prefix: raw.slice(0, slash) }
  }
  throw new Error("test path does not fit ustar")
}

function block(spec: Spec): Uint8Array {
  const out: Uint8Array[] = []
  const head = new Uint8Array(512)
  const dir = spec.flag === "5"
  const clean = dir && spec.raw.endsWith("/") ? spec.raw.slice(0, -1) : spec.raw
  const { name, prefix } = split(dir ? clean : spec.raw)
  writeText(head, 0, 100, name)
  writeText(head, 100, 8, "0000777\0")
  writeText(head, 108, 8, "0000000\0")
  writeText(head, 116, 8, "0000000\0")
  const size = spec.dirSize ?? spec.data?.byteLength ?? 0
  if (spec.base256) {
    head[124] = 0x80
    for (let i = 125; i < 136; i += 1) head[i] = 0x01
  } else {
    writeOctal(head, 124, 12, size)
  }
  writeOctal(head, 136, 12, 0)
  for (let i = 148; i < 156; i += 1) head[i] = 0x20
  head[156] = enc.encode(spec.flag)[0]!
  writeText(head, 157, 100, spec.link ?? "")
  writeText(head, 257, 6, spec.magic ?? "ustar\0")
  writeText(head, 263, 2, "00")
  writeText(head, 345, 155, prefix)
  let sum = 0
  for (let i = 0; i < 512; i += 1) sum += head[i]!
  const text = sum.toString(8).padStart(6, "0") + "\0 "
  writeText(head, 148, 8, text)
  if (spec.badChecksum) head[0] = (head[0]! + 1) % 256
  out.push(head)
  if (spec.data && spec.data.byteLength > 0) {
    out.push(spec.data)
    const pad = (512 - (spec.data.byteLength % 512)) % 512
    const filler = new Uint8Array(pad)
    if (spec.badPad && pad > 0) filler[0] = 0x41
    out.push(filler)
  } else if (dir && (spec.dirSize ?? 0) > 0) {
    out.push(new Uint8Array(512))
  }
  const total = out.reduce((n, b) => n + b.byteLength, 0)
  const joined = new Uint8Array(total)
  let off = 0
  for (const b of out) {
    joined.set(b, off)
    off += b.byteLength
  }
  return joined
}

function tar(specs: Spec[], trailers = 2): Uint8Array {
  const parts = specs.map(block)
  for (let i = 0; i < trailers; i += 1) parts.push(new Uint8Array(512))
  const total = parts.reduce((n, b) => n + b.byteLength, 0)
  const joined = new Uint8Array(total)
  let off = 0
  for (const b of parts) {
    joined.set(b, off)
    off += b.byteLength
  }
  return joined
}

function gz(specs: Spec[], trailers = 2): Uint8Array {
  const out = gzipSync(Buffer.from(tar(specs, trailers)))
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
}

function file(raw: string, text: string, extra?: Partial<Spec>): Spec {
  return { raw, flag: "0", data: enc.encode(text), ...extra }
}

function dir(raw: string, extra?: Partial<Spec>): Spec {
  return { raw, flag: "5", ...extra }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof SkillArchiveError) return err.code
    throw err
  }
  throw new Error("expected SkillArchiveError")
}

describe("skill-archive limits", () => {
  test("defaults match the locked bounds", () => {
    expect(SKILL_ARCHIVE_LIMITS.maxCompressedBytes).toBe(8 * 1024 * 1024)
    expect(SKILL_ARCHIVE_LIMITS.maxDecompressedBytes).toBe(32 * 1024 * 1024)
    expect(SKILL_ARCHIVE_LIMITS.maxEntries).toBe(512)
    expect(SKILL_ARCHIVE_LIMITS.maxFileBytes).toBe(8 * 1024 * 1024)
    expect(SKILL_ARCHIVE_LIMITS.maxPathChars).toBe(512)
    expect(SKILL_ARCHIVE_LIMITS.maxDepth).toBe(16)
    expect(SKILL_ARCHIVE_LIMITS.maxBasenameChars).toBe(255)
  })

  test("module stays a pure leaf", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "../../src/kilocode/skill-archive.ts"), "utf-8")
    expect(src).toContain("node:zlib")
    expect(src).not.toContain("from \"effect\"")
    expect(src).not.toContain("from 'effect'")
    expect(src).not.toContain("node:fs")
    expect(src).not.toContain("node:fetch")
    expect(src).not.toMatch(/\bfetch\(/)
  })
})

describe("skill-archive valid archives", () => {
  test("parses a rooted archive and strips the root", () => {
    const bytes = gz([dir("skill/"), file("skill/SKILL.md", "# S\n"), file("skill/docs/a.md", "a"), dir("skill/empty/")])
    const entries = parseSkillArchive(bytes)
    expect(entries.map((e) => `${e.type}:${e.name}`).sort()).toEqual(
      ["directory:empty", "file:SKILL.md", "file:docs/a.md"].sort(),
    )
    const skill = entries.find((e) => e.name === "SKILL.md")
    expect(skill?.type).toBe("file")
    expect(new TextDecoder().decode(skill?.data)).toBe("# S\n")
  })

  test("accepts a missing root directory entry with a single root", () => {
    const bytes = gz([file("skill/SKILL.md", "# S\n")])
    const entries = parseSkillArchive(bytes)
    expect(entries.map((e) => e.name)).toEqual(["SKILL.md"])
  })

  test("supports ustar prefix for long paths", () => {
    const seg = "p".repeat(100)
    const base = `${"n".repeat(90)}.md`
    const long = `skill/${seg}/${base}`
    const bytes = gz([file(long, "x")])
    const entries = parseSkillArchive(bytes)
    expect(entries.map((e) => e.name)).toEqual([long.slice("skill/".length)])
  })
})

describe("skill-archive path safety", () => {
  const cases: [string, Spec][] = [
    ["traversal", file("skill/../evil.md", "x")],
    ["nested dotdot", file("skill/a/../../evil.md", "x")],
    ["absolute", { raw: "/evil.md", flag: "0", data: enc.encode("x") }],
    ["backslash", file("skill\\evil.md", "x")],
    ["drive", file("skill/C:/evil.md", "x")],
    ["colon stream", file("skill/a:b.md", "x")],
    ["unc", { raw: "//server/share.md", flag: "0", data: enc.encode("x") }],
    ["device", file("skill/CON.md", "x")],
    ["control", file("skill/a\x01b.md", "x")],
    ["empty segment", file("skill/a//b.md", "x")],
    ["dot segment", file("skill/./b.md", "x")],
  ]
  for (const [label, spec] of cases) {
    test(`rejects ${label}`, () => {
      expect(codeOf(() => parseSkillArchive(gz([spec])))).toBe("unsafe-path")
    })
  }

  test("rejects overlong stripped paths", () => {
    // Ustar caps raw paths at 255 chars, so exercise the stripped-path cap
    // through a stricter configured limit.
    const bytes = gz([file("skill/docs/note.md", "x")])
    expect(codeOf(() => parseSkillArchive(bytes, { maxPathChars: 5 }))).toBe("path-too-long")
  })

  test("rejects overlong basenames", () => {
    const bytes = gz([file("skill/averylongname.md", "x")])
    expect(codeOf(() => parseSkillArchive(bytes, { maxBasenameChars: 5 }))).toBe("path-too-long")
  })

  test("rejects excessive depth", () => {
    const deep = `skill/${Array.from({ length: 17 }, (_, i) => `d${i}`).join("/")}.md`
    expect(codeOf(() => parseSkillArchive(gz([file(deep, "x")])))).toBe("path-too-deep")
  })
})

describe("skill-archive entry types", () => {
  test("rejects links, devices, fifos, and unknown types", () => {
    for (const flag of ["1", "2", "3", "4", "6", "9"]) {
      expect(codeOf(() => parseSkillArchive(gz([{ raw: "skill/evil", flag, data: enc.encode("x") }])))).toBe(
        "unsupported-entry",
      )
    }
  })

  test("rejects PAX and GNU longname metadata explicitly", () => {
    for (const flag of ["g", "x", "L", "K"]) {
      expect(codeOf(() => parseSkillArchive(gz([{ raw: "skill/meta", flag, data: enc.encode("x") }])))).toBe(
        "unsupported-metadata",
      )
    }
  })

  test("rejects base-256 sizes", () => {
    expect(codeOf(() => parseSkillArchive(gz([file("skill/a.md", "x", { base256: true })])))).toBe("unsupported-metadata")
  })

  test("rejects non-ustar headers", () => {
    expect(codeOf(() => parseSkillArchive(gz([file("skill/a.md", "x", { magic: "gnu   " })])))).toBe("invalid-header")
  })
})

describe("skill-archive structure", () => {
  test("rejects multi-root archives", () => {
    expect(codeOf(() => parseSkillArchive(gz([file("a/SKILL.md", "x"), file("b/SKILL.md", "y")])))).toBe("multi-root")
  })

  test("rejects flat archives", () => {
    expect(codeOf(() => parseSkillArchive(gz([file("SKILL.md", "x")])))).toBe("flat-archive")
  })

  test("rejects duplicate and case-colliding destinations", () => {
    expect(codeOf(() => parseSkillArchive(gz([file("skill/a.md", "x"), file("skill/a.md", "y")])))).toBe("duplicate-path")
    expect(codeOf(() => parseSkillArchive(gz([file("skill/A.md", "x"), file("skill/a.md", "y")])))).toBe("duplicate-path")
    expect(codeOf(() => parseSkillArchive(gz([file("skill/a", "x"), dir("skill/a/")])))).toBe("duplicate-path")
  })

  test("rejects file-parent conflicts", () => {
    expect(codeOf(() => parseSkillArchive(gz([file("skill/a", "x"), file("skill/a/b.md", "y")])))).toBe("duplicate-path")
    expect(codeOf(() => parseSkillArchive(gz([dir("skill/a/b/"), file("skill/a", "x")])))).toBe("duplicate-path")
  })

  test("rejects corrupt checksums and truncated streams", () => {
    expect(codeOf(() => parseSkillArchive(gz([file("skill/a.md", "x", { badChecksum: true })])))).toBe("bad-checksum")
    const full = gz([file("skill/SKILL.md", "# S\n")])
    expect(codeOf(() => parseSkillArchive(full.subarray(0, full.byteLength - 100)))).toBe("invalid-gzip")
    const raw = tar([file("skill/SKILL.md", "# S\n")])
    const cut = gzipSync(Buffer.from(raw.subarray(0, raw.byteLength - 100)))
    expect(codeOf(() => parseSkillArchive(new Uint8Array(cut.buffer, cut.byteOffset, cut.byteLength)))).toBe(
      "truncated",
    )
  })

  test("rejects empty archives", () => {
    expect(codeOf(() => parseSkillArchive(gz([])))).toBe("empty-archive")
  })

  test("rejects directory entries with nonzero size", () => {
    expect(codeOf(() => parseSkillArchive(gz([dir("skill/a/", { dirSize: 512 })])))).toBe("invalid-header")
  })

  test("rejects nonzero padding", () => {
    expect(codeOf(() => parseSkillArchive(gz([file("skill/a.md", "x", { badPad: true })])))).toBe("invalid-header")
  })

  test("enforces entry, file, and decompressed caps", () => {
    const many = Array.from({ length: 5 }, (_, i) => file(`skill/f${i}.md`, "x"))
    expect(codeOf(() => parseSkillArchive(gz(many), { maxEntries: 3 }))).toBe("too-many-entries")
    expect(codeOf(() => parseSkillArchive(gz([file("skill/big.md", "x".repeat(1024))]), { maxFileBytes: 10 }))).toBe(
      "file-too-large",
    )
    expect(codeOf(() => parseSkillArchive(gz([file("skill/a.md", "x")]), { maxDecompressedBytes: 10 }))).toBe(
      "decompressed-too-large",
    )
    expect(codeOf(() => parseSkillArchive(gz([file("skill/a.md", "x")]), { maxCompressedBytes: 10 }))).toBe(
      "compressed-too-large",
    )
  })

  test("rejects invalid gzip", () => {
    expect(codeOf(() => parseSkillArchive(enc.encode("not gzip")))).toBe("invalid-gzip")
  })

  test("rejects empty input", () => {
    expect(codeOf(() => parseSkillArchive(new Uint8Array(0)))).toBe("invalid-gzip")
  })

  test("rejects nonzero data after the tar end marker", () => {
    const base = tar([file("skill/SKILL.md", "# S\n")], 1)
    const trailer = new Uint8Array(512)
    trailer[0] = 0x41
    const joined = new Uint8Array(base.byteLength + trailer.byteLength)
    joined.set(base, 0)
    joined.set(trailer, base.byteLength)
    const out = gzipSync(Buffer.from(joined))
    expect(codeOf(() => parseSkillArchive(new Uint8Array(out.buffer, out.byteOffset, out.byteLength)))).toBe(
      "invalid-header",
    )
  })

  test("caps concatenated gzip members", () => {
    const first = gzipSync(Buffer.from(tar([file("skill/a.md", "x".repeat(64))])))
    const second = gzipSync(Buffer.from(tar([file("skill/b.md", "y".repeat(64))])))
    const joined = new Uint8Array(first.byteLength + second.byteLength)
    joined.set(new Uint8Array(first.buffer, first.byteOffset, first.byteLength), 0)
    joined.set(new Uint8Array(second.buffer, second.byteOffset, second.byteLength), first.byteLength)
    expect(codeOf(() => parseSkillArchive(joined, { maxDecompressedBytes: 512 }))).toBe("decompressed-too-large")
  })

  test("rejects regular files carrying a linkname", () => {
    expect(codeOf(() => parseSkillArchive(gz([file("skill/a.md", "x", { link: "target" })])))).toBe(
      "unsupported-entry",
    )
  })

  test("rejects root, device, and control edges", () => {
    expect(codeOf(() => parseSkillArchive(gz([dir("CON/"), file("CON/SKILL.md", "x")])))).toBe("unsafe-path")
    expect(codeOf(() => parseSkillArchive(gz([file("skill\x01/SKILL.md", "x")])))).toBe("unsafe-path")
    expect(codeOf(() => parseSkillArchive(gz([file("skill/C:/x.md", "x")])))).toBe("unsafe-path")
  })

  test("rejects trailing dot and space segments", () => {
    expect(codeOf(() => parseSkillArchive(gz([file("skill/a./b.md", "x")])))).toBe("unsafe-path")
    expect(codeOf(() => parseSkillArchive(gz([file("skill/a /b.md", "x")])))).toBe("unsafe-path")
    expect(codeOf(() => parseSkillArchive(gz([file("skill./SKILL.md", "x")])))).toBe("unsafe-path")
  })

  test("rejects unicode normalization collisions", () => {
    const nfc = "caf\u00e9.md"
    const nfd = "cafe\u0301.md"
    expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"))
    expect(codeOf(() => parseSkillArchive(gz([file(`skill/${nfc}`, "x"), file(`skill/${nfd}`, "y")])))).toBe(
      "duplicate-path",
    )
  })

  test("exposes the namespace API", () => {
    expect(SkillArchive.parse).toBe(parseSkillArchive)
    expect(SkillArchive.isError(new SkillArchiveError("truncated", "t"))).toBe(true)
  })
})
