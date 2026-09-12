import * as fs from "fs/promises"
import * as path from "path"
import * as yaml from "yaml"
import { SkillArchive } from "@opencode-ai/core/kilocode/skill-archive"
import type { SkillArchiveEntry } from "@opencode-ai/core/kilocode/skill-archive"
import type {
  MarketplaceItem,
  MarketplaceItemRef,
  SkillMarketplaceItem,
  McpMarketplaceItem,
  AgentMarketplaceItem,
  McpInstallationMethod,
  InstallMarketplaceItemOptions,
  InstallResult,
  RemoveResult,
} from "./types"
import { MarketplacePaths } from "./paths"
import type { ConfigConvergenceAdapter, ConvergenceDescriptor } from "../../config/convergence"
import { withFence } from "../../config/convergence-guard"

const FETCH_TIMEOUT = 30_000

export class MarketplaceInstaller {
  constructor(
    private paths: MarketplacePaths,
    private convergence?: ConfigConvergenceAdapter,
  ) {}

  setConvergence(next: ConfigConvergenceAdapter | undefined): void {
    this.convergence = next
  }

  async install(
    item: MarketplaceItem,
    options: InstallMarketplaceItemOptions,
    workspace?: string,
  ): Promise<InstallResult> {
    const scope = options.target ?? "project"
    if (item.type === "skill") return this.installSkill(item, scope, workspace)
    if (item.type === "mcp") return this.installMcp(item, options, scope, workspace)
    return this.installAgent(item, scope, workspace)
  }

  // ── MCP ─────────────────────────────────────────────────────────────

  async installMcp(
    item: McpMarketplaceItem,
    options: InstallMarketplaceItemOptions,
    scope: "project" | "global",
    workspace?: string,
  ): Promise<InstallResult> {
    if (scope === "project" && !workspace) {
      return { success: false, slug: item.id, error: "No workspace directory for project-scope install" }
    }

    const config = await this.readConfig(scope, workspace)
    if (!config.mcp) config.mcp = {}

    if (config.mcp[item.id]) {
      return { success: false, slug: item.id, error: "MCP server already installed. Remove it first." }
    }

    const content = this.resolveMcpContent(item, options)
    if (!content) {
      return { success: false, slug: item.id, error: "No installation content for MCP server" }
    }

    try {
      config.mcp[item.id] = this.buildMcpEntry(content, options.parameters)
    } catch (err) {
      return { success: false, slug: item.id, error: `Invalid MCP config: ${err}` }
    }

    const fenced = await this.fencedWrite(scope, workspace, config)
    if (!fenced.ok) return { success: false, slug: item.id, error: fenced.message }
    return { success: true, slug: item.id }
  }

  private resolveMcpContent(item: McpMarketplaceItem, options: InstallMarketplaceItemOptions): string | undefined {
    if (typeof item.content === "string") return item.content
    if (!Array.isArray(item.content) || item.content.length === 0) return undefined
    const name = options.parameters?.__method as string | undefined
    if (name) {
      const found = item.content.find((m: McpInstallationMethod) => m.name === name)
      if (found) return found.content
    }
    return item.content[0].content
  }

  private buildMcpEntry(content: string, params?: Record<string, unknown>): Record<string, unknown> {
    const filtered = Object.fromEntries(Object.entries(params ?? {}).filter(([k]) => k !== "__method"))
    const replaced = Object.keys(filtered).length > 0 ? substituteParams(content, filtered) : content
    const raw = JSON.parse(replaced) as Record<string, unknown>
    return normalizeMcpEntry(raw)
  }

  // ── Agent ───────────────────────────────────────────────────────────

  async installAgent(
    item: AgentMarketplaceItem,
    scope: "project" | "global",
    workspace?: string,
  ): Promise<InstallResult> {
    if (scope === "project" && !workspace) {
      return { success: false, slug: item.id, error: "No workspace directory for project-scope install" }
    }

    if (!isSafeId(item.id)) {
      return { success: false, slug: item.id, error: "Invalid agent id" }
    }

    const dir = this.paths.agentsDir(scope, workspace)
    await fs.mkdir(dir, { recursive: true })

    const filepath = path.join(dir, `${item.id}.md`)
    if (!contains(dir, filepath)) {
      return { success: false, slug: item.id, error: "Invalid agent id" }
    }

    try {
      await fs.access(filepath)
      return { success: false, slug: item.id, error: "Agent already installed. Remove it first." }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }

    const { prompt, ...front } = item.content
    const frontmatter = yaml.stringify(front).trimEnd()
    const content = `---\n${frontmatter}\n---\n\n${prompt}\n`
    await fs.writeFile(filepath, content, "utf-8")

    // Migration: remove stale kilo.json agent entry with same id if present
    const config = await this.readConfig(scope, workspace)
    if (config.agent?.[item.id]) {
      delete (config.agent as Record<string, unknown>)[item.id]
      if (Object.keys(config.agent as object).length === 0) delete config.agent
      const fenced = await this.fencedWrite(scope, workspace, config)
      if (!fenced.ok) return { success: false, slug: item.id, error: fenced.message }
    }

    return { success: true, slug: item.id, filePath: filepath, line: 1 }
  }

  async removeAgent(
    item: Pick<AgentMarketplaceItem, "id">,
    scope: "project" | "global",
    workspace?: string,
  ): Promise<RemoveResult> {
    if (scope === "project" && !workspace) {
      return { success: false, slug: item.id, error: "No workspace directory for project-scope removal" }
    }

    if (!isSafeId(item.id)) {
      return { success: false, slug: item.id, error: "Invalid agent id" }
    }

    const dir = this.paths.agentsDir(scope, workspace)
    const filepath = path.join(dir, `${item.id}.md`)
    if (!contains(dir, filepath)) {
      return { success: false, slug: item.id, error: "Invalid agent id" }
    }

    try {
      await fs.unlink(filepath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return { success: false, slug: item.id, error: String(err) }
      }
    }

    // Also clean up any stale kilo.json agent entry
    const config = await this.readConfig(scope, workspace)
    if (config.agent?.[item.id]) {
      delete (config.agent as Record<string, unknown>)[item.id]
      if (Object.keys(config.agent as object).length === 0) delete config.agent
      const fenced = await this.fencedWrite(scope, workspace, config)
      if (!fenced.ok) return { success: false, slug: item.id, error: fenced.message }
    }

    return { success: true, slug: item.id }
  }

  // ── Skill ───────────────────────────────────────────────────────────
  // Skill tarballs are fetched only from the kilo-marketplace
  // `skills-latest` GitHub release over https (redirects must land on
  // release-assets.githubusercontent.com), parsed fully in memory by the
  // bounded shared parser, then written with fixed modes into staging
  // beside the skills directory — never inside it, so discovery can never
  // observe a half-written SKILL.md — before one atomic rename. Release
  // assets are mutable, so this claims transport allowlisting plus archive
  // bounds, not authenticity or integrity.

  async installSkill(
    item: SkillMarketplaceItem,
    scope: "project" | "global",
    workspace?: string,
  ): Promise<InstallResult> {
    if (scope === "project" && !workspace) {
      return { success: false, slug: item.id, error: "No workspace directory for project-scope install" }
    }

    // Global skill installs would land in `~/.kilo/skills`, which the CLI
    // runtime does not discover (it scans the global config `skills/`
    // roots, `skills.paths`, and external `.claude/.agents` roots). Writing
    // there creates undiscoverable files, so fail closed with no files
    // written until runtime-owned install lands.
    if (scope === "global") {
      return {
        success: false,
        slug: item.id,
        error:
          "Global skill install is temporarily unavailable until runtime-owned install lands. Install to the project scope instead.",
      }
    }

    if (!item.content) {
      return { success: false, slug: item.id, error: "Skill has no tarball URL" }
    }

    if (!isSafeSkillId(item.id)) {
      return { success: false, slug: item.id, error: "Invalid skill id" }
    }

    const base = this.paths.skillsDir(scope, workspace)
    const dir = path.join(base, item.id)
    if (!contains(base, dir)) {
      return { success: false, slug: item.id, error: "Invalid skill id" }
    }

    if (await exists(dir)) {
      return { success: false, slug: item.id, error: "Skill already installed. Uninstall it before installing again." }
    }

    let url: URL
    try {
      url = skillUrl(item.id, item.content)
    } catch (err) {
      return { success: false, slug: item.id, error: err instanceof Error ? err.message : String(err) }
    }

    // Stage beside `base` (same filesystem, so rename never crosses devices)
    // and outside the skills directory, so skill discovery cannot observe
    // staging as an installed skill before the atomic rename.
    await fs.mkdir(base, { recursive: true })
    const staging = await fs.mkdtemp(path.join(path.dirname(base), `.staging-skills-${item.id}-`))

    try {
      const bytes = await download(url)
      let entries: readonly SkillArchiveEntry[]
      try {
        entries = SkillArchive.parse(bytes)
      } catch (err) {
        return {
          success: false,
          slug: item.id,
          error: SkillArchive.isError(err) ? `Skill archive invalid (${err.code}): ${err.message}` : String(err),
        }
      }

      if (!entries.some((entry) => entry.type === "file" && entry.name === "SKILL.md")) {
        return { success: false, slug: item.id, error: "Extracted archive missing SKILL.md" }
      }

      await writeEntries(staging, entries)
      await fs.rename(staging, dir)

      return { success: true, slug: item.id, filePath: path.join(dir, "SKILL.md"), line: 1 }
    } catch (err) {
      if (await exists(dir)) {
        return {
          success: false,
          slug: item.id,
          error: "Skill already installed. Uninstall it before installing again.",
        }
      }
      console.warn(`Failed to install skill ${item.id}:`, err)
      return { success: false, slug: item.id, error: err instanceof Error ? err.message : String(err) }
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch((err) => {
        console.warn(`Failed to clean up staging directory ${staging}:`, err)
      })
    }
  }

  // ── Remove ──────────────────────────────────────────────────────────
  // Skill removal is owned exclusively by the CLI runtime (private
  // `skill/remove`): the extension never deletes skill files. There is no
  // recursive skill removal path here by design.

  async remove(item: MarketplaceItemRef, scope: "project" | "global", workspace?: string): Promise<RemoveResult> {
    if (scope === "project" && !workspace) {
      return { success: false, slug: item.id, error: "No workspace directory for project-scope removal" }
    }
    if (item.type === "skill") {
      return {
        success: false,
        slug: item.id,
        error: "Skill removal is owned by the CLI runtime and never deletes files from the extension",
      }
    }
    if (item.type === "mcp") return this.removeMcp(item, scope, workspace)
    return this.removeAgent(item, scope, workspace)
  }

  async removeMcp(
    item: Pick<McpMarketplaceItem, "id">,
    scope: "project" | "global",
    workspace?: string,
  ): Promise<RemoveResult> {
    if (scope === "project" && !workspace) {
      return { success: false, slug: item.id, error: "No workspace directory for project-scope removal" }
    }

    const config = await this.readConfig(scope, workspace)
    if (!config.mcp?.[item.id]) {
      return { success: true, slug: item.id }
    }
    delete config.mcp[item.id]
    if (Object.keys(config.mcp).length === 0) delete config.mcp
    const fenced = await this.fencedWrite(scope, workspace, config)
    if (!fenced.ok) return { success: false, slug: item.id, error: fenced.message }
    return { success: true, slug: item.id }
  }

  // ── Config helpers ──────────────────────────────────────────────────

  private async readConfig(
    scope: "project" | "global",
    workspace?: string,
  ): Promise<Record<string, Record<string, unknown>>> {
    const filepath = this.paths.configPath(scope, workspace)
    try {
      const content = await fs.readFile(filepath, "utf-8")
      return JSON.parse(content)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw err
    }
  }

  private async writeConfig(
    scope: "project" | "global",
    workspace: string | undefined,
    config: Record<string, unknown>,
  ): Promise<void> {
    const filepath = this.paths.configPath(scope, workspace)
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    await fs.writeFile(filepath, JSON.stringify(config, null, 2) + "\n", "utf-8")
  }

  private async fencedWrite(
    scope: "project" | "global",
    workspace: string | undefined,
    config: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!this.convergence) {
      return {
        ok: false as const,
        message: "Runtime convergence fence unavailable; write blocked: convergence adapter unavailable",
      }
    }
    const desc: ConvergenceDescriptor =
      scope === "global"
        ? { kind: "config", scope: "global" }
        : { kind: "config", scope: "project", directory: workspace! }
    return withFence<{ ok: true } | { ok: false; message: string }>(
      this.convergence,
      [desc],
      async () => {
        await this.writeConfig(scope, workspace, config)
        return { ok: true as const }
      },
      (message) => ({ ok: false as const, message }),
    )
  }
}

// ── Skill download ────────────────────────────────────────────────────

function skillUrl(id: string, content: string): URL {
  let url: URL
  try {
    url = new URL(content)
  } catch {
    throw new Error("Invalid skill download URL")
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port !== "") throw new Error("Invalid skill download URL")
  if (url.username !== "" || url.password !== "") throw new Error("Invalid skill download URL")
  if (url.search !== "" || url.hash !== "") throw new Error("Invalid skill download URL")
  const want = `/Kilo-Org/kilo-marketplace/releases/download/skills-latest/${encodeURIComponent(id)}.tar.gz`
  if (url.pathname !== want) throw new Error("Invalid skill download URL")
  return url
}

function finalUrl(initial: URL, responseUrl: unknown): URL {
  if (typeof responseUrl !== "string" || responseUrl.length === 0) throw new Error("Unexpected download redirect")
  let url: URL
  try {
    url = new URL(responseUrl)
  } catch {
    throw new Error("Unexpected download redirect")
  }
  if (url.protocol !== "https:") throw new Error("Unexpected download redirect")
  if (url.username !== "" || url.password !== "") throw new Error("Unexpected download redirect")
  if (url.port !== "") throw new Error("Unexpected download redirect")
  if (url.hostname === "github.com") {
    if (url.href !== initial.href) throw new Error("Unexpected download redirect")
    return url
  }
  if (url.hostname === "release-assets.githubusercontent.com") {
    if (url.hash !== "") throw new Error("Unexpected download redirect")
    return url
  }
  throw new Error("Unexpected download redirect")
}

function throwIfContentLengthTooLarge(headers: { get?: (name: string) => string | null } | undefined): void {
  const len = headers?.get?.("content-length")
  if (len === null || len === undefined) return
  const n = Number(len)
  if (Number.isFinite(n) && n > SkillArchive.LIMITS.maxCompressedBytes) throw new Error("Download too large")
}

async function readBounded(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ctrl: AbortController,
): Promise<{ chunks: Uint8Array[]; total: number }> {
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await readChunk(reader, ctrl)
      if (!next) return { chunks, total }
      total += next.byteLength
      if (total > SkillArchive.LIMITS.maxCompressedBytes) {
        ctrl.abort()
        try {
          await reader.cancel()
        } catch {}
        throw new Error("Download too large")
      }
      chunks.push(next)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ctrl: AbortController,
): Promise<Uint8Array | undefined> {
  let next: ReadableStreamReadResult<Uint8Array>
  try {
    next = await reader.read()
  } catch (err) {
    if (ctrl.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw new Error("Download timed out")
    }
    throw err
  }
  if (next.done) return undefined
  const value = next.value
  if (!value || value.byteLength === 0) return new Uint8Array(0)
  return value.slice()
}

function join(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let off = 0
  for (const chunk of chunks) {
    if (chunk.byteLength === 0) continue
    out.set(chunk, off)
    off += chunk.byteLength
  }
  return out
}

async function download(url: URL): Promise<Uint8Array> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT)
  try {
    const response = await fetch(url.toString(), { signal: ctrl.signal })
    finalUrl(url, (response as { url?: unknown }).url)
    if (!response.ok) throw new Error(`Download failed: ${response.status}`)
    throwIfContentLengthTooLarge(response.headers)
    const body = (response as { body?: unknown }).body as ReadableStream<Uint8Array> | null | undefined
    if (!body || typeof (body as ReadableStream<Uint8Array>).getReader !== "function") {
      throw new Error("Download is empty")
    }
    const { chunks, total } = await readBounded(body.getReader(), ctrl)
    if (total === 0) throw new Error("Download is empty")
    const out = join(chunks, total)
    if (out.byteLength > SkillArchive.LIMITS.maxCompressedBytes) throw new Error("Download too large")
    if (out.byteLength === 0) throw new Error("Download is empty")
    return out
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("Download timed out")
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function writeEntries(staging: string, entries: readonly SkillArchiveEntry[]): Promise<void> {
  const dirs = entries.filter((entry) => entry.type === "directory").sort((a, b) => a.name.length - b.name.length)
  for (const entry of dirs) {
    const full = path.join(staging, entry.name)
    if (!contains(staging, full)) throw new Error("Skill archive contains unsafe paths")
    await fs.mkdir(full, { recursive: true, mode: 0o755 })
  }
  for (const entry of entries) {
    if (entry.type !== "file") continue
    const full = path.join(staging, entry.name)
    if (!contains(staging, full)) throw new Error("Skill archive contains unsafe paths")
    await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o755 })
    await fs.writeFile(full, entry.data ?? new Uint8Array(0), { mode: 0o644, flag: "wx" })
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

async function exists(filepath: string): Promise<boolean> {
  try {
    await fs.access(filepath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false
    throw err
  }
}

function contains(dir: string, filepath: string): boolean {
  return path.resolve(filepath).startsWith(path.resolve(dir) + path.sep)
}

/**
 * Normalize a marketplace MCP entry from the old Kilocode format to the CLI's expected format.
 *
 * Old format (from marketplace API):
 *   { "command": "npx", "args": [...], "env": {...} }
 *   { "type": "sse"|"streamable-http", "url": "...", "headers": {...} }
 *
 * New format (CLI Config.Mcp schema):
 *   { "type": "local", "command": ["npx", ...], "environment": {...} }
 *   { "type": "remote", "url": "...", "headers": {...} }
 */
function normalizeMcpEntry(raw: Record<string, unknown>): Record<string, unknown> {
  // Already in new format
  if (raw.type === "local" || raw.type === "remote") return raw

  // Remote MCP (sse / streamable-http) → type: "remote"
  if (typeof raw.url === "string") {
    const { type: _type, url, headers, ...rest } = raw
    const entry: Record<string, unknown> = { type: "remote", url }
    if (headers && typeof headers === "object") entry.headers = headers
    // Carry through any other recognized fields (enabled, timeout, oauth)
    for (const key of ["enabled", "timeout", "oauth"] as const) {
      if (key in rest) entry[key] = rest[key]
    }
    return entry
  }

  // Local MCP (command string + args array) → type: "local", command array
  if (typeof raw.command === "string") {
    const args = (raw.args as string[] | undefined) ?? []
    const env = raw.env
    const entry: Record<string, unknown> = { type: "local", command: [raw.command, ...args] }
    if (env && typeof env === "object" && Object.keys(env as object).length > 0) entry.environment = env
    for (const key of ["enabled", "timeout"] as const) {
      if (key in raw) entry[key] = raw[key]
    }
    return entry
  }

  return raw
}

function isSafeId(id: string): boolean {
  if (!id || id === "." || id.includes("..") || id.includes("/") || id.includes("\\") || id.endsWith(".")) return false
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(id)) return false
  return /^[\w\-@.]+$/.test(id)
}

function isSafeSkillId(id: string): boolean {
  if (!id || id.length > 64) return false
  if (!/^[a-z0-9-]+$/.test(id)) return false
  if (id.startsWith("-") || id.endsWith("-")) return false
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) return false
  return true
}

function escapeJsonValue(raw: string): string {
  return raw
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
}

function substituteParams(template: string, params: Record<string, unknown>): string {
  let result = template
  for (const [key, value] of Object.entries(params)) {
    const escaped = escapeJsonValue(String(value ?? ""))
    result = result.replaceAll(`{{${key}}}`, escaped)
    result = result.replaceAll(`\${${key}}`, escaped)
  }
  return result
}
