import { describe, it, expect, afterEach } from "bun:test"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { gzipSync } from "node:zlib"
import { MarketplaceInstaller } from "../../src/services/marketplace/installer"
import { MarketplacePaths } from "../../src/services/marketplace/paths"
import type { AgentMarketplaceItem } from "../../src/services/marketplace/types"
import { FakeConvergenceAdapter } from "../../src/config/convergence"
import * as yaml from "yaml"

const tmpDir = path.join(os.tmpdir(), `kilo-test-${Date.now()}`)
const RELEASE_FINAL = "https://release-assets.githubusercontent.com/abc/skill.tar.gz"

class TestPaths extends MarketplacePaths {
  override configPath(scope: "project" | "global", workspace?: string): string {
    if (scope === "global") return path.join(tmpDir, "global", "kilo.json")
    return path.join(tmpDir, "project", ".kilo", "kilo.json")
  }
  override skillsDir(scope: "project" | "global", workspace?: string): string {
    return path.join(tmpDir, "skills")
  }
}

function skill(content: string, id = "test-skill") {
  return {
    type: "skill" as const,
    id,
    name: "Test Skill",
    description: "test",
    category: "test",
    githubUrl: "https://example.com",
    content,
    displayName: "Test Skill",
    displayCategory: "Test",
  }
}

function skillUrl(id = "test-skill"): string {
  return `https://github.com/Kilo-Org/kilo-marketplace/releases/download/skills-latest/${encodeURIComponent(id)}.tar.gz`
}

function agent(content: AgentMarketplaceItem["content"], id = "test-agent"): AgentMarketplaceItem {
  return {
    type: "agent",
    id,
    name: "Test Agent",
    description: "test",
    category: "development",
    content,
  }
}

async function frontmatter(file: string) {
  const content = await fs.readFile(file, "utf-8")
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  expect(match).not.toBeNull()
  return yaml.parse(match?.[1] ?? "") as Record<string, unknown>
}

// ── Pure in-test tar+gzip writer (no system tar) ───────────────────────

const enc = new TextEncoder()

type Spec = { raw: string; flag: string; data?: Uint8Array }

function writeText(buf: Uint8Array, off: number, len: number, text: string): void {
  buf.set(enc.encode(text).subarray(0, len), off)
}

function writeOctal(buf: Uint8Array, off: number, len: number, value: number): void {
  writeText(buf, off, len, `${value.toString(8).padStart(len - 1, "0")}\0`)
}

function block(spec: Spec): Uint8Array {
  const head = new Uint8Array(512)
  const clean = spec.flag === "5" && spec.raw.endsWith("/") ? spec.raw.slice(0, -1) : spec.raw
  const slash = clean.length > 100 ? clean.lastIndexOf("/") : -1
  const name = slash > 0 ? clean.slice(slash + 1) : clean
  const prefix = slash > 0 ? clean.slice(0, slash) : ""
  writeText(head, 0, 100, name)
  writeText(head, 100, 8, "0000777\0")
  writeText(head, 108, 8, "0000000\0")
  writeText(head, 116, 8, "0000000\0")
  writeOctal(head, 124, 12, spec.data?.byteLength ?? 0)
  writeOctal(head, 136, 12, 0)
  for (let i = 148; i < 156; i += 1) head[i] = 0x20
  head[156] = enc.encode(spec.flag)[0]!
  writeText(head, 257, 6, "ustar\0")
  writeText(head, 263, 2, "00")
  writeText(head, 345, 155, prefix)
  let sum = 0
  for (let i = 0; i < 512; i += 1) sum += head[i]!
  writeText(head, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
  const parts = [head]
  if (spec.data?.byteLength) {
    parts.push(spec.data)
    parts.push(new Uint8Array((512 - (spec.data.byteLength % 512)) % 512))
  }
  const total = parts.reduce((n, b) => n + b.byteLength, 0)
  const joined = new Uint8Array(total)
  let off = 0
  for (const b of parts) {
    joined.set(b, off)
    off += b.byteLength
  }
  return joined
}

function archiveBytes(specs: Spec[]): Uint8Array {
  const parts = [...specs.map(block), new Uint8Array(512), new Uint8Array(512)]
  const total = parts.reduce((n, b) => n + b.byteLength, 0)
  const joined = new Uint8Array(total)
  let off = 0
  for (const b of parts) {
    joined.set(b, off)
    off += b.byteLength
  }
  const out = gzipSync(Buffer.from(joined))
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
}

function validBytes(): Uint8Array {
  return archiveBytes([
    { raw: "skill/", flag: "5" },
    { raw: "skill/SKILL.md", flag: "0", data: enc.encode("# Test Skill\n") },
  ])
}

function file(raw: string, text: string): Spec {
  return { raw, flag: "0", data: enc.encode(text) }
}

// ── Fetch stub ─────────────────────────────────────────────────────────

function streamBytes(
  bytes: Uint8Array,
  chunkSize = 65536,
  tracker?: { reads: number; cancelled: boolean },
): ReadableStream<Uint8Array> {
  let off = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (off >= bytes.byteLength) {
        ctrl.close()
        return
      }
      const end = Math.min(off + chunkSize, bytes.byteLength)
      ctrl.enqueue(bytes.slice(off, end))
      off = end
    },
    cancel() {
      if (tracker) tracker.cancelled = true
    },
  })
  if (tracker) {
    const origGetReader = stream.getReader.bind(stream)
    stream.getReader = (() => {
      const reader = origGetReader()
      const origRead = reader.read.bind(reader)
      const origCancel = reader.cancel.bind(reader)
      reader.read = (async () => {
        tracker.reads += 1
        return origRead()
      }) as typeof reader.read
      reader.cancel = (async (reason?: unknown) => {
        tracker.cancelled = true
        return origCancel(reason)
      }) as typeof reader.cancel
      return reader
    }) as typeof stream.getReader
  }
  return stream
}

function stubFetch(
  bytes: Uint8Array,
  opts?: {
    url?: string | null
    contentLength?: string | null
    status?: number
    calls?: { n: number; href: string; aborted: boolean }
    chunkSize?: number
    tracker?: { reads: number; cancelled: boolean }
    arrayBufferCalls?: { n: number }
    body?: ReadableStream<Uint8Array> | null
  },
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (href: unknown, init?: { signal?: AbortSignal }) => {
    if (opts?.calls) {
      opts.calls.n += 1
      opts.calls.href = String(href)
      opts.calls.aborted = init?.signal?.aborted ?? false
    }
    const body = opts && "body" in opts ? opts.body! : streamBytes(bytes, opts?.chunkSize ?? 65536, opts?.tracker)
    return {
      ok: (opts?.status ?? 200) >= 200 && (opts?.status ?? 200) < 300,
      status: opts?.status ?? 200,
      url: opts?.url === null ? undefined : (opts?.url ?? RELEASE_FINAL),
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? (opts?.contentLength ?? null) : null) },
      body,
      arrayBuffer: async () => {
        if (opts?.arrayBufferCalls) opts.arrayBufferCalls.n += 1
        return bytes.slice().buffer as ArrayBuffer
      },
    }
  }) as unknown as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

async function stagingResidue(): Promise<string[]> {
  const found: string[] = []
  for (const dir of [path.join(tmpDir, "skills"), tmpDir]) {
    const names = await fs.readdir(dir).catch(() => [] as string[])
    for (const name of names) {
      if (name.startsWith(".staging-skills-") || name.startsWith(".staging-")) found.push(path.join(dir, name))
    }
  }
  return found
}

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("MarketplaceInstaller MCP format normalization", () => {
  it("converts local command+args+env format to CLI format", async () => {
    const installer = new MarketplaceInstaller(new TestPaths(), new FakeConvergenceAdapter())
    const item = {
      type: "mcp" as const,
      id: "memory",
      name: "Memory",
      description: "test",
      category: "development",
      url: "https://example.com",
      content: JSON.stringify({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        env: { MY_KEY: "my-value" },
      }),
    }
    const result = await installer.install(item, { target: "global" }, undefined)
    expect(result.success).toBe(true)

    const written = JSON.parse(await fs.readFile(new TestPaths().configPath("global"), "utf-8"))
    const mcp = written.mcp?.memory
    expect(mcp.type).toBe("local")
    expect(mcp.command).toEqual(["npx", "-y", "@modelcontextprotocol/server-memory"])
    expect(mcp.environment).toEqual({ MY_KEY: "my-value" })
    expect(mcp.args).toBeUndefined()
    expect(mcp.env).toBeUndefined()
  })

  it("converts sse type to remote type", async () => {
    const installer = new MarketplaceInstaller(new TestPaths(), new FakeConvergenceAdapter())
    const item = {
      type: "mcp" as const,
      id: "myremote",
      name: "Remote",
      description: "test",
      category: "development",
      url: "https://example.com",
      content: JSON.stringify({
        type: "sse",
        url: "https://example.com/sse",
        headers: { Authorization: "Bearer token" },
      }),
    }
    const result = await installer.install(item, { target: "global" }, undefined)
    expect(result.success).toBe(true)

    const written = JSON.parse(await fs.readFile(new TestPaths().configPath("global"), "utf-8"))
    const mcp = written.mcp?.myremote
    expect(mcp.type).toBe("remote")
    expect(mcp.url).toBe("https://example.com/sse")
    expect(mcp.headers).toEqual({ Authorization: "Bearer token" })
  })

  it("keeps already-normalized local format unchanged", async () => {
    const installer = new MarketplaceInstaller(new TestPaths(), new FakeConvergenceAdapter())
    const item = {
      type: "mcp" as const,
      id: "already",
      name: "Already Done",
      description: "test",
      category: "development",
      url: "https://example.com",
      content: JSON.stringify({
        type: "local",
        command: ["npx", "-y", "someserver"],
        environment: { KEY: "val" },
      }),
    }
    const result = await installer.install(item, { target: "global" }, undefined)
    expect(result.success).toBe(true)

    const written = JSON.parse(await fs.readFile(new TestPaths().configPath("global"), "utf-8"))
    const mcp = written.mcp?.already
    expect(mcp).toEqual({ type: "local", command: ["npx", "-y", "someserver"], environment: { KEY: "val" } })
  })
})

describe("MarketplaceInstaller skills", () => {
  it("rejects project installs without a workspace directory", async () => {
    const installer = new MarketplaceInstaller(new TestPaths())
    const result = await installer.installSkill(skill("https://example.com/skill.tar.gz"), "project")

    expect(result).toEqual({
      success: false,
      slug: "test-skill",
      error: "No workspace directory for project-scope install",
    })
  })

  it("rejects project removals without a workspace directory", async () => {
    const installer = new MarketplaceInstaller(new TestPaths())
    const result = await installer.remove({ id: "test-skill", type: "skill" }, "project")

    expect(result).toEqual({
      success: false,
      slug: "test-skill",
      error: "No workspace directory for project-scope removal",
    })
  })

  it("rejects project MCP and agent removals without a workspace directory", async () => {
    const installer = new MarketplaceInstaller(new TestPaths())
    const results = await Promise.all([
      installer.remove(
        {
          type: "mcp",
          id: "test-mcp",
          name: "Test MCP",
          description: "test",
          category: "development",
          url: "https://example.com",
          content: "{}",
        },
        "project",
      ),
      installer.remove(
        {
          type: "agent",
          id: "test-agent",
          name: "Test Agent",
          description: "test",
          category: "development",
          content: { mode: "all", description: "test", prompt: "test" },
        },
        "project",
      ),
    ])

    expect(results).toEqual([
      { success: false, slug: "test-mcp", error: "No workspace directory for project-scope removal" },
      { success: false, slug: "test-agent", error: "No workspace directory for project-scope removal" },
    ])
  })

  it("has no recursive skill removal path: skill remove fails closed and preserves files", async () => {
    const paths = new TestPaths()
    const dir = path.join(paths.skillsDir("project", tmpDir), "installed")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "SKILL.md"), "# Installed\n")
    await fs.writeFile(path.join(dir, "KEEP.txt"), "keep\n")
    const installer = new MarketplaceInstaller(paths)

    expect("removeSkill" in installer).toBe(false)
    const result = await installer.remove({ id: "installed", type: "skill" }, "project", tmpDir)
    expect(result.success).toBe(false)
    expect(await fs.readFile(path.join(dir, "SKILL.md"), "utf-8")).toBe("# Installed\n")
    expect(await fs.readFile(path.join(dir, "KEEP.txt"), "utf-8")).toBe("keep\n")
  })

  it("fails closed on global skill installs without writing files", async () => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      throw new Error("global skill install must not fetch")
    }
    try {
      const paths = new TestPaths()
      const installer = new MarketplaceInstaller(paths)
      const before = await fs
        .readdir(paths.skillsDir("global"))
        .then((names) => names)
        .catch(() => null)
      const result = await installer.installSkill(skill("https://example.com/skill.tar.gz"), "global")

      expect(result.success).toBe(false)
      expect(result.error).toContain("Global skill install is temporarily unavailable")
      expect(calls).toBe(0)
      const after = await fs
        .readdir(paths.skillsDir("global"))
        .then((names) => names)
        .catch(() => null)
      expect(after).toEqual(before)
      if (after) {
        expect(after.filter((name) => name.startsWith(".staging-"))).toEqual([])
      }
    } finally {
      globalThis.fetch = original
    }
  })

  it("installs a validated project skill without shelling out or staging residue", async () => {
    const restore = stubFetch(validBytes())
    try {
      const paths = new TestPaths()
      const installer = new MarketplaceInstaller(paths)
      const result = await installer.installSkill(skill(skillUrl()), "project", tmpDir)

      expect(result.success).toBe(true)
      expect(await fs.readFile(path.join(paths.skillsDir("project", tmpDir), "test-skill", "SKILL.md"), "utf-8")).toBe(
        "# Test Skill\n",
      )
      expect(await stagingResidue()).toEqual([])
    } finally {
      restore()
    }
  })

  it("rejects non-allowlisted download URLs without fetching", async () => {
    for (const content of [
      "https://example.com/skill.tar.gz",
      "http://github.com/Kilo-Org/kilo-marketplace/releases/download/skills-latest/test-skill.tar.gz",
      "data:application/gzip;base64,AAAA",
      "file:///tmp/skill.tar.gz",
      "https://github.com/other/repo/releases/download/skills-latest/test-skill.tar.gz",
      "https://github.com/Kilo-Org/kilo-marketplace/releases/download/skills-latest/other-skill.tar.gz",
      "https://github.com/Kilo-Org/kilo-marketplace/releases/download/skills-latest/test-skill.tar.gz?x=1",
    ]) {
      const calls = { n: 0, href: "", aborted: false }
      const restore = stubFetch(validBytes(), { calls })
      try {
        const installer = new MarketplaceInstaller(new TestPaths())
        const result = await installer.installSkill(skill(content), "project", tmpDir)
        expect(result.success).toBe(false)
        expect(result.error).toBe("Invalid skill download URL")
        expect(calls.n).toBe(0)
      } finally {
        restore()
      }
    }
    expect(await stagingResidue()).toEqual([])
  })

  it("rejects redirects landing off the release hosts", async () => {
    const restore = stubFetch(validBytes(), { url: "https://evil.example.com/skill.tar.gz" })
    try {
      const installer = new MarketplaceInstaller(new TestPaths())
      const result = await installer.installSkill(skill(skillUrl()), "project", tmpDir)
      expect(result.success).toBe(false)
      expect(result.error).toBe("Unexpected download redirect")
      expect(await stagingResidue()).toEqual([])
    } finally {
      restore()
    }
  })

  it("rejects oversized content-length before reading the body", async () => {
    const tracker = { reads: 0, cancelled: false }
    const arrayBufferCalls = { n: 0 }
    const restore = stubFetch(validBytes(), {
      contentLength: String(64 * 1024 * 1024),
      tracker,
      arrayBufferCalls,
    })
    try {
      const installer = new MarketplaceInstaller(new TestPaths())
      const result = await installer.installSkill(skill(skillUrl()), "project", tmpDir)
      expect(result.success).toBe(false)
      expect(result.error).toBe("Download too large")
      expect(tracker.reads).toBe(0)
      expect(arrayBufferCalls.n).toBe(0)
      expect(await stagingResidue()).toEqual([])
    } finally {
      restore()
    }
  })

  it("rejects oversized bodies after download", async () => {
    const big = crypto.getRandomValues(new Uint8Array(8 * 1024 * 1024 + 1))
    const tracker = { reads: 0, cancelled: false }
    const arrayBufferCalls = { n: 0 }
    const restore = stubFetch(big, { tracker, arrayBufferCalls, chunkSize: 65536 })
    try {
      const installer = new MarketplaceInstaller(new TestPaths())
      const result = await installer.installSkill(skill(skillUrl()), "project", tmpDir)
      expect(result.success).toBe(false)
      expect(result.error).toBe("Download too large")
      expect(tracker.cancelled).toBe(true)
      expect(arrayBufferCalls.n).toBe(0)
      expect(await stagingResidue()).toEqual([])
    } finally {
      restore()
    }
  })

  it("rejects archives missing SKILL.md without installing", async () => {
    const bytes = archiveBytes([file("skill/notes.md", "notes")])
    const restore = stubFetch(bytes)
    try {
      const paths = new TestPaths()
      const installer = new MarketplaceInstaller(paths)
      const result = await installer.installSkill(skill(skillUrl()), "project", tmpDir)
      expect(result.success).toBe(false)
      expect(result.error).toBe("Extracted archive missing SKILL.md")
      expect(
        await fs
          .access(path.join(paths.skillsDir("project", tmpDir), "test-skill"))
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
      expect(await stagingResidue()).toEqual([])
    } finally {
      restore()
    }
  })

  it("rejects unsafe archives without writes or staging residue", async () => {
    const bytes = archiveBytes([{ raw: "skill/", flag: "5" }, file("skill/../evil.md", "evil")])
    const restore = stubFetch(bytes)
    try {
      const paths = new TestPaths()
      const installer = new MarketplaceInstaller(paths)
      const result = await installer.installSkill(skill(skillUrl()), "project", tmpDir)
      expect(result.success).toBe(false)
      expect(result.error).toContain("unsafe-path")
      expect(
        await fs
          .access(path.join(tmpDir, "evil.md"))
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
      expect(
        await fs
          .access(path.join(paths.skillsDir("project", tmpDir), "test-skill"))
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
      expect(await stagingResidue()).toEqual([])
    } finally {
      restore()
    }
  })

  it("surfaces fetch aborts as timeouts and cleans up staging", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      const err = new Error("aborted")
      err.name = "AbortError"
      throw err
    }) as unknown as typeof fetch
    try {
      const installer = new MarketplaceInstaller(new TestPaths())
      const result = await installer.installSkill(skill(skillUrl()), "project", tmpDir)
      expect(result.success).toBe(false)
      expect(result.error).toBe("Download timed out")
      expect(await stagingResidue()).toEqual([])
    } finally {
      globalThis.fetch = original
    }
  })

  it("handles concurrent installs without sharing temporary paths", async () => {
    const buffer = validBytes()
    const original = globalThis.fetch
    const paths = new TestPaths()
    const installer = new MarketplaceInstaller(paths)
    const item = skill(skillUrl())
    const gate = Promise.withResolvers<void>()
    let count = 0
    globalThis.fetch = (async () => {
      count += 1
      if (count === 2) gate.resolve()
      await gate.promise
      return {
        ok: true,
        status: 200,
        url: RELEASE_FINAL,
        headers: { get: () => null },
        body: streamBytes(buffer),
        arrayBuffer: async () => buffer.slice().buffer as ArrayBuffer,
      }
    }) as unknown as typeof fetch

    try {
      const results = await Promise.all([
        installer.installSkill(item, "project", tmpDir),
        installer.installSkill(item, "project", tmpDir),
      ])
      expect(count).toBe(2)
      expect(results.filter((result) => result.success)).toHaveLength(1)
      expect(results.find((result) => !result.success)?.error).toBe(
        "Skill already installed. Uninstall it before installing again.",
      )
      expect(await fs.readFile(path.join(paths.skillsDir("project", tmpDir), "test-skill", "SKILL.md"), "utf-8")).toBe(
        "# Test Skill\n",
      )
      expect(await stagingResidue()).toEqual([])
    } finally {
      globalThis.fetch = original
    }
  })
})

describe("MarketplaceInstaller skill security architecture", () => {
  it("no longer shells out to tar or scans for escapes post-hoc", async () => {
    const src = await fs.readFile(new URL("../../src/services/marketplace/installer.ts", import.meta.url), "utf-8")
    expect(src).not.toContain("util/process")
    expect(src).not.toContain("child_process")
    expect(src).not.toMatch(/require\s*\(\s*["']child_process["']/)
    expect(src).not.toMatch(/from\s+["'][^"']*child_process["']/)
    expect(src).not.toMatch(/\bexecFile\b/)
    expect(src).not.toMatch(/\bexec\s*\(/)
    expect(src).not.toMatch(/\bspawn\b/)
    expect(src).not.toMatch(/Bun\s*\.\s*spawn/)
    expect(src).not.toContain("findEscapedPaths")
    expect(src).not.toContain("os.tmpdir")
    expect(src).not.toContain("randomUUID")
    expect(src).not.toMatch(/exec\(\s*["'`]tar/)
    expect(src).not.toContain('"tar"')
    expect(src).not.toContain("'tar'")
    expect(src).not.toContain("`tar`")
    expect(src).not.toContain("arrayBuffer")
    expect(src).toContain("skill-archive")
    expect(src).toContain("release-assets.githubusercontent.com")
    expect(src).toContain("AbortController")
    expect(src).toContain("getReader")
    expect(src).toContain('flag: "wx"')
  })
})

describe("MarketplaceInstaller skill download hardening", () => {
  it("caps a lying content-length via streaming, cancels the reader, and writes nothing", async () => {
    let chunks = 0
    let cancelled = false
    const lying = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        chunks += 1
        ctrl.enqueue(new Uint8Array(64 * 1024))
      },
      cancel() {
        cancelled = true
      },
    })
    const original = globalThis.fetch
    let arrayBufferCalls = 0
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      url: RELEASE_FINAL,
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "1024" : null) },
      body: lying,
      arrayBuffer: async () => {
        arrayBufferCalls += 1
        return new Uint8Array(0).buffer as ArrayBuffer
      },
    })) as unknown as typeof fetch
    try {
      const paths = new TestPaths()
      const installer = new MarketplaceInstaller(paths)
      const result = await installer.installSkill(skill(skillUrl()), "project", tmpDir)
      expect(result.success).toBe(false)
      expect(result.error).toBe("Download too large")
      expect(cancelled).toBe(true)
      expect(chunks).toBeLessThanOrEqual(130)
      expect(arrayBufferCalls).toBe(0)
      expect(
        await fs
          .access(path.join(paths.skillsDir("project", tmpDir), "test-skill"))
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
      expect(await stagingResidue()).toEqual([])
    } finally {
      globalThis.fetch = original
    }
  })

  it("rejects missing and empty response.url without reading the body", async () => {
    for (const url of [null, ""]) {
      const arrayBufferCalls = { n: 0 }
      const restore = stubFetch(validBytes(), { url: url as unknown as string, arrayBufferCalls })
      try {
        const installer = new MarketplaceInstaller(new TestPaths())
        const result = await installer.installSkill(skill(skillUrl()), "project", tmpDir)
        expect(result.success).toBe(false)
        expect(result.error).toBe("Unexpected download redirect")
        expect(arrayBufferCalls.n).toBe(0)
        expect(await stagingResidue()).toEqual([])
      } finally {
        restore()
      }
    }
  })

  it("rejects a same-github-host redirect with a different path", async () => {
    const other = skillUrl().replace("test-skill.tar.gz", "other-skill.tar.gz")
    const restore = stubFetch(validBytes(), { url: other })
    try {
      const installer = new MarketplaceInstaller(new TestPaths())
      const result = await installer.installSkill(skill(skillUrl()), "project", tmpDir)
      expect(result.success).toBe(false)
      expect(result.error).toBe("Unexpected download redirect")
      expect(await stagingResidue()).toEqual([])
    } finally {
      restore()
    }
  })

  it("rejects release-asset redirects with username, port, or hash", async () => {
    for (const url of [
      "https://user@release-assets.githubusercontent.com/abc/skill.tar.gz?sig=1",
      "https://release-assets.githubusercontent.com:8443/abc/skill.tar.gz?sig=1",
      "https://release-assets.githubusercontent.com/abc/skill.tar.gz?sig=1#frag",
      "http://release-assets.githubusercontent.com/abc/skill.tar.gz?sig=1",
    ]) {
      const restore = stubFetch(validBytes(), { url })
      try {
        const installer = new MarketplaceInstaller(new TestPaths())
        const result = await installer.installSkill(skill(skillUrl()), "project", tmpDir)
        expect(result.success).toBe(false)
        expect(result.error).toBe("Unexpected download redirect")
        expect(await stagingResidue()).toEqual([])
      } finally {
        restore()
      }
    }
  })

  it("accepts a signed release-asset query and rejects skill ids with @", async () => {
    const signed = `${RELEASE_FINAL}?sig=abc&se=123`
    const restore = stubFetch(validBytes(), { url: signed })
    try {
      const paths = new TestPaths()
      const installer = new MarketplaceInstaller(paths)
      const result = await installer.installSkill(skill(skillUrl()), "project", tmpDir)
      expect(result.success).toBe(true)
      expect(await fs.readFile(path.join(paths.skillsDir("project", tmpDir), "test-skill", "SKILL.md"), "utf-8")).toBe(
        "# Test Skill\n",
      )
    } finally {
      restore()
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
    for (const id of ["evil@x", "Bad_ID", "bad id", "a/b", "-lead", "trail-", "UPPER"]) {
      const calls = { n: 0, href: "", aborted: false }
      const noFetch = stubFetch(validBytes(), { calls })
      try {
        const installer = new MarketplaceInstaller(new TestPaths())
        const result = await installer.installSkill(skill(skillUrl(id), id), "project", tmpDir)
        expect(result.success).toBe(false)
        expect(result.error).toBe("Invalid skill id")
        expect(calls.n).toBe(0)
      } finally {
        noFetch()
      }
    }
    expect(await stagingResidue()).toEqual([])
  })

  it("rejects missing, unreadable, and empty bodies without installing", async () => {
    const nullRestore = stubFetch(validBytes(), { body: null })
    try {
      const installer = new MarketplaceInstaller(new TestPaths())
      const result = await installer.installSkill(skill(skillUrl()), "project", tmpDir)
      expect(result.success).toBe(false)
      expect(result.error).toBe("Download is empty")
    } finally {
      nullRestore()
    }
    const emptyRestore = stubFetch(new Uint8Array(0))
    try {
      const installer = new MarketplaceInstaller(new TestPaths())
      const result = await installer.installSkill(skill(skillUrl()), "project", tmpDir)
      expect(result.success).toBe(false)
      expect(result.error).toBe("Download is empty")
    } finally {
      emptyRestore()
    }
    const original = globalThis.fetch
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      url: RELEASE_FINAL,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("boom")
        },
      }),
      arrayBuffer: async () => new Uint8Array(0).buffer as ArrayBuffer,
    })) as unknown as typeof fetch
    try {
      const installer = new MarketplaceInstaller(new TestPaths())
      const result = await installer.installSkill(skill(skillUrl()), "project", tmpDir)
      expect(result.success).toBe(false)
      expect(result.error).toBe("boom")
      expect(await stagingResidue()).toEqual([])
    } finally {
      globalThis.fetch = original
    }
  })
})

describe("MarketplaceInstaller agents", () => {
  it("preserves requirements in installed agent frontmatter", async () => {
    const installer = new MarketplaceInstaller(new TestPaths())
    const item = agent({
      mode: "all",
      description: "Requires local setup",
      prompt: "Use the available project tools.",
      requirements: {
        skills: ["project-skill"],
        mcps: ["project-mcp"],
        vscode_extensions: [{ name: "Project Helper", id: "publisher.project-helper" }],
      },
    })

    const result = await installer.installAgent(item, "project", tmpDir)

    expect(result.success).toBe(true)
    expect(result.filePath).toBeDefined()
    if (!result.filePath) throw new Error("agent install did not return a file path")
    const data = await frontmatter(result.filePath)
    expect(data.requirements).toEqual(item.content.requirements)
  })
})
