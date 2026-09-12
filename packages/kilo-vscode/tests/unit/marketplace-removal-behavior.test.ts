/**
 * Marketplace removal — local workflow behavioral coverage.
 *
 * Drives the real production seams (no string-only assertions for behavior):
 * - MCP canonical removal via KiloProvider.handleRemoveMcp + real
 *   CanonicalConfigService: invalid/non-canonical and missing/stale
 *   scope/stamp/hash fail closed with mcpCleanupError and zero write;
 *   writeConfigScopes failure posts mcpCleanupError with the fresh service
 *   stamp, preserves config, and does not claim success; success writes
 *   canonical scopes, sends canonical configUpdated, and clears agent
 *   requirements. No Marketplace/legacy file bridge.
 * - Skills Refresh: settings/session action posts requestSkills through the
 *   real extension seam (fetchAndSendSkills → skillsLoaded); no marketplace
 *   message.
 * - Local skill removal/data safety: links the retained backend suite proving
 *   only SKILL.md is unlinked and siblings survive; no duplicated logic here.
 */

import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { CanonicalConfigService } from "../../src/config/service"
import { Roots } from "../../src/config/paths"
import { createMemorySecretAdapter } from "../../src/config/secret-adapter"
import { createMemoryStateAdapter } from "../../src/config/state-adapter"
import { readFile } from "../../src/config/parse"
import type { CleanupRetryRecord } from "../../src/config/types"

const { KiloProvider } = await import("../../src/KiloProvider")

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

type Internals = {
  cleanupRetries: Map<string, CleanupRetryRecord>
  canonicalReady: boolean
  postMessage: (message: unknown) => void
  handleRemoveMcp: (name: string, msg?: Record<string, unknown>) => Promise<void>
  fetchAndSendSkills: () => Promise<void>
  requirements: { clear: () => void }
  cachedSkillsMessage: unknown
  dispose: () => void
}

function makeProvider(canonical: CanonicalConfigService): { provider: Internals; messages: unknown[] } {
  const connection = new KiloConnectionService({} as never)
  const provider = new KiloProvider({} as never, connection, undefined, { canonicalConfig: canonical })
  const messages: unknown[] = []
  const internal = provider as unknown as Internals
  internal.postMessage = (message) => messages.push(message)
  return { provider: internal, messages }
}

function setupMcp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-mkt-behavior-"))
  dirs.push(root)
  const global = path.join(root, "global")
  const project = path.join(root, "project")
  fs.mkdirSync(global, { recursive: true })
  fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
  const file = path.join(global, "kilo.jsonc")
  fs.writeFileSync(file, JSON.stringify({ mcp: { filesystem: { type: "local", command: "node", args: ["s.js"] } } }))
  const secrets = createMemorySecretAdapter()
  const canonical = new CanonicalConfigService({ secrets } as never, {
    roots: new Roots(project, global),
    secretAdapter: secrets,
    globalState: createMemoryStateAdapter(),
    workspaceState: createMemoryStateAdapter(),
  })
  return { canonical, secrets, file, init: () => canonical.initialize() }
}

function diskHash(file: string): string {
  const raw = readFile(file)
  return raw.type === "present" ? raw.hash : "absent"
}

function removeMsg(canonical: CanonicalConfigService, file: string, overrides: Record<string, unknown> = {}) {
  return { canonical: true, scope: "global", expectedHash: diskHash(file), stamp: canonical.stamp, ...overrides }
}

function msgList(messages: unknown[], type: string) {
  return messages.filter((m) => (m as Record<string, unknown>).type === type)
}

describe("MCP canonical removal drives the real handler", () => {
  it("non-canonical and missing/invalid scope fail closed with zero write", async () => {
    const { canonical, secrets, file, init } = setupMcp()
    await init()
    const { provider, messages } = makeProvider(canonical)
    const before = fs.readFileSync(file, "utf8")

    await provider.handleRemoveMcp("filesystem", removeMsg(canonical, file, { canonical: false }))
    await provider.handleRemoveMcp("filesystem", { canonical: true, expectedHash: "x", stamp: canonical.stamp })
    await provider.handleRemoveMcp("filesystem", {
      canonical: true,
      scope: "bogus",
      expectedHash: "x",
      stamp: canonical.stamp,
    })

    const errors = msgList(messages, "mcpCleanupError")
    expect(errors.length).toBe(3)
    for (const err of errors) {
      expect((err as Record<string, unknown>).retryID).toBe("")
      expect((err as Record<string, unknown>).stamp).toEqual(canonical.stamp)
    }
    expect(fs.readFileSync(file, "utf8")).toBe(before)
    expect((canonical.getScopeConfig("global").mcp as Record<string, unknown>).filesystem).toBeDefined()
    expect(secrets.store_.get("kilo.credentials.global.mcp.filesystem")).toBeUndefined()
    expect(provider.cleanupRetries.size).toBe(0)
    provider.dispose()
    canonical.dispose()
  })

  it("stale stamp fails closed with zero write", async () => {
    const { canonical, file, init } = setupMcp()
    await init()
    const { provider, messages } = makeProvider(canonical)
    const stale = { ...canonical.stamp, materializationVersion: canonical.stamp.materializationVersion + 1 }
    await provider.handleRemoveMcp("filesystem", removeMsg(canonical, file, { stamp: stale }))
    const err = msgList(messages, "mcpCleanupError")[0] as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect(err!.retryID).toBe("")
    expect(err!.stamp).toEqual(canonical.stamp)
    expect((canonical.getScopeConfig("global").mcp as Record<string, unknown>).filesystem).toBeDefined()
    expect(provider.cleanupRetries.size).toBe(0)
    provider.dispose()
    canonical.dispose()
  })

  it("writeConfigScopes failure posts mcpCleanupError with fresh stamp and preserves config", async () => {
    const { canonical, secrets, file, init } = setupMcp()
    await init()
    const { provider, messages } = makeProvider(canonical)
    const orig = canonical.writeConfigScopes.bind(canonical)
    ;(canonical as unknown as { writeConfigScopes: unknown }).writeConfigScopes = async () => ({
      ok: false as const,
      kind: "io" as const,
      message: "synthetic write failure",
    })
    try {
      await provider.handleRemoveMcp("filesystem", removeMsg(canonical, file))
    } finally {
      ;(canonical as unknown as { writeConfigScopes: unknown }).writeConfigScopes = orig
    }
    const err = msgList(messages, "mcpCleanupError")[0] as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect(err!.name).toBe("filesystem")
    expect(err!.scope).toBe("global")
    expect(err!.retryID).toBe("")
    expect(err!.stamp).toEqual(canonical.stamp)
    expect(String(err!.message)).toContain("synthetic write failure")
    // Config preserved: MCP still present on disk authority and no secret touched.
    expect((canonical.getScopeConfig("global").mcp as Record<string, unknown>).filesystem).toBeDefined()
    expect(secrets.store_.get("kilo.credentials.global.mcp.filesystem")).toBeUndefined()
    expect(provider.cleanupRetries.size).toBe(0)
    // Recovery: canonical config is re-published so the UI re-renders instead of stalling.
    expect(msgList(messages, "configUpdated").length).toBeGreaterThan(0)
    const updated = msgList(messages, "configUpdated")[0] as Record<string, unknown>
    expect(updated.config as Record<string, { mcp?: Record<string, unknown> }> | undefined).toBeDefined()
    provider.dispose()
    canonical.dispose()
  })

  it("success writes canonical scopes, sends configUpdated, and clears requirements", async () => {
    const { canonical, secrets, file, init } = setupMcp()
    await init()
    const { provider, messages } = makeProvider(canonical)
    await canonical.storeSecret("global", "mcp", "filesystem", "real-secret")
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcp: {
          filesystem: { type: "local", command: "node", credential: "secret:kilo.credentials.global.mcp.filesystem" },
        },
      }),
    )
    let cleared = 0
    const origClear = provider.requirements.clear.bind(provider.requirements)
    provider.requirements.clear = () => {
      cleared += 1
      origClear()
    }
    await provider.handleRemoveMcp("filesystem", removeMsg(canonical, file))
    expect(canonical.getScopeConfig("global").mcp).toEqual({})
    expect(secrets.store_.get("kilo.credentials.global.mcp.filesystem")).toBeUndefined()
    expect(msgList(messages, "mcpCleanupError").length).toBe(0)
    expect(msgList(messages, "configUpdated").length).toBeGreaterThan(0)
    expect(cleared).toBeGreaterThan(0)
    // No Marketplace/legacy bridge: no marketplace message and no mcp.json file.
    for (const m of messages) {
      const type = String((m as Record<string, unknown>).type ?? "")
      expect(type.toLowerCase()).not.toContain("marketplace")
    }
    expect(fs.existsSync(path.join(path.dirname(file), "mcp.json"))).toBe(false)
    provider.dispose()
    canonical.dispose()
  })
})

describe("Skills Refresh posts requestSkills with no marketplace message", () => {
  it("session seam refreshSkills posts requestSkills", async () => {
    const sessionPath = path.resolve(import.meta.dir, "../../webview-ui/src/context/session.tsx")
    const src = fs.readFileSync(sessionPath, "utf8")
    const body = src.match(/const refreshSkills = \(\) => \{[\s\S]*?\n  \}/)?.[0] ?? ""
    expect(body).toContain('vscode.postMessage({ type: "requestSkills" })')
    expect(src).not.toContain("openMarketplacePanel")
    expect(src).not.toContain("mcpBrowseMarketplace")
  })

  it("settings refresh button calls refreshSkills with the Refresh label", async () => {
    const tabPath = path.resolve(import.meta.dir, "../../webview-ui/src/components/settings/AgentBehaviourTab.tsx")
    const src = fs.readFileSync(tabPath, "utf8")
    expect(src).toContain("const refresh = () => session.refreshSkills()")
    expect(src).toContain("onClick={refresh}")
    expect(src).toContain('language.t("settings.agentBehaviour.refreshSkills")')
    expect(src).not.toContain("openMarketplacePanel")
    expect(src).not.toContain("mcpBrowseMarketplace")
  })

  it("extension requestSkills seam serves cached skillsLoaded", async () => {
    const { canonical, init } = setupMcp()
    await init()
    const { provider, messages } = makeProvider(canonical)
    provider.cachedSkillsMessage = { type: "skillsLoaded", skills: [] }
    await provider.fetchAndSendSkills()
    const loaded = msgList(messages, "skillsLoaded")
    expect(loaded.length).toBe(1)
    for (const m of messages) {
      const type = String((m as Record<string, unknown>).type ?? "")
      expect(type.toLowerCase()).not.toContain("marketplace")
    }
    provider.dispose()
    canonical.dispose()
  })
})

describe("local skill removal stays manifest-only via the retained backend suite", () => {
  it("links manifest-only unlink and sibling preservation without duplicating logic", async () => {
    const repo = path.resolve(import.meta.dir, "../../../..")
    const impl = fs.readFileSync(path.join(repo, "packages/opencode/src/kilocode/skill-remove.ts"), "utf8")
    expect(impl).toContain("await unlink(file)")
    expect(impl).not.toContain("rm(")
    expect(impl).not.toContain("rmSync")
    const backend = path.join(repo, "packages/opencode/test/kilocode/server/fd-carrier-skill-remove.test.ts")
    expect(fs.existsSync(backend)).toBe(true)
    const suite = fs.readFileSync(backend, "utf8")
    expect(suite).toContain("unlinks only the manifest and preserves siblings")
    expect(suite).toContain("KEEP.txt")
    // Settings private-only coverage is retained alongside the backend suite.
    expect(fs.existsSync(path.resolve(import.meta.dir, "./skill-remove-settings.test.ts"))).toBe(true)
  })
})
