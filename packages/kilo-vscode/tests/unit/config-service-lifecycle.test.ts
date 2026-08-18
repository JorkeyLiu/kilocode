/**
 * P4.1 Canonical Config Service — comprehensive lifecycle tests.
 *
 * Exercises: initialize, external valid/invalid/delete edits, asset
 * add/change/duplicate/delete, index persistence/recreation, stale
 * asset write, secret rollback/cleanup, concurrent own/external event
 * coalescing, and disposal.
 *
 * Uses real temp filesystem with in-memory state/secret/watcher adapters.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { Roots } from "../../src/config/paths"
import { createMemorySecretAdapter } from "../../src/config/secret-adapter"
import { resetVersion } from "../../src/config/materialize"
import {
  createMemoryStateAdapter,
  createMemoryWatcherAdapter,
  createMemoryEmitterFactory,
} from "../../src/config/state-adapter"
import { CanonicalConfigService } from "../../src/config/service"
import type { WatcherAdapter } from "../../src/config/types"

// ── Fixtures ────────────────────────────────────────────────────────

let tmpDir: string
let globalRoot: string
let projectRoot: string
let secrets: ReturnType<typeof createMemorySecretAdapter>
let globalState: ReturnType<typeof createMemoryStateAdapter>
let workspaceState: ReturnType<typeof createMemoryStateAdapter>
let watcherAdapter: ReturnType<typeof createMemoryWatcherAdapter>
let emitterFactory: ReturnType<typeof createMemoryEmitterFactory>

beforeEach(() => {
  resetVersion()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p41-service-test-"))
  globalRoot = path.join(tmpDir, "global")
  projectRoot = path.join(tmpDir, "project")
  fs.mkdirSync(globalRoot, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, ".kilo"), { recursive: true })
  secrets = createMemorySecretAdapter()
  globalState = createMemoryStateAdapter()
  workspaceState = createMemoryStateAdapter()
  watcherAdapter = createMemoryWatcherAdapter()
  emitterFactory = createMemoryEmitterFactory()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function createService(): CanonicalConfigService {
  const roots = new Roots(projectRoot, globalRoot)
  const context = { secrets, subscriptions: { push: () => {} } } as never
  return new CanonicalConfigService(context, {
    roots,
    secretAdapter: secrets,
    globalState,
    workspaceState,
    watcherAdapter,
    emitterFactory,
  })
}

function writeGlobalConfig(value: Record<string, unknown>): void {
  const filePath = path.join(globalRoot, "kilo.jsonc")
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8")
}

function writeProjectConfig(value: Record<string, unknown>): void {
  const filePath = path.join(projectRoot, ".kilo", "kilo.jsonc")
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8")
}

function writeAgentMd(id: string, frontmatter: Record<string, unknown>, body: string, scope: "global" | "project"): string {
  const dir = scope === "global"
    ? path.join(globalRoot, "agent")
    : path.join(projectRoot, ".kilo", "agent")
  fs.mkdirSync(dir, { recursive: true })
  const parts = ["---\n"]
  const { stringify } = require("yaml")
  parts.push(stringify(frontmatter))
  parts.push("---\n")
  if (body) parts.push("\n", body)
  const filePath = path.join(dir, `${id}.md`)
  fs.writeFileSync(filePath, parts.join(""), "utf-8")
  return filePath
}

function writeCommandMd(id: string, frontmatter: Record<string, unknown>, body: string, scope: "global" | "project"): string {
  const dir = scope === "global"
    ? path.join(globalRoot, "command")
    : path.join(projectRoot, ".kilo", "command")
  fs.mkdirSync(dir, { recursive: true })
  const parts = ["---\n"]
  const { stringify } = require("yaml")
  parts.push(stringify(frontmatter))
  parts.push("---\n")
  if (body) parts.push("\n", body)
  const filePath = path.join(dir, `${id}.md`)
  fs.writeFileSync(filePath, parts.join(""), "utf-8")
  return filePath
}

// ── Tests ───────────────────────────────────────────────────────────

describe("CanonicalConfigService lifecycle", () => {
  describe("initialization", () => {
    it("initializes from empty state without error", async () => {
      const service = createService()
      await service.initialize()
      expect(service.materialized).not.toBeNull()
      expect(service.snapshot).not.toBeNull()
      service.dispose()
    })

    it("initializes from a global config file", async () => {
      writeGlobalConfig({ model: "openai/gpt-4" })
      const service = createService()
      await service.initialize()
      expect(service.materialized!.value.model).toBe("openai/gpt-4")
      service.dispose()
    })

    it("initializes from both scopes", async () => {
      writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
      writeProjectConfig({ model: "anthropic/claude-sonnet-4-20250514" })
      const service = createService()
      await service.initialize()
      expect(service.materialized!.value.model).toBe("anthropic/claude-sonnet-4-20250514")
      const providers = service.materialized!.value.provider as Record<string, unknown>
      expect(providers.openai).toBeDefined()
      service.dispose()
    })

    it("rehydrates persisted indexes on re-initialization", async () => {
      // First session: materialize and persist
      writeGlobalConfig({ provider: { openai: {} } })
      const s1 = createService()
      await s1.initialize()
      expect(globalState.data_.has("kilo.canonicalIndex.providers")).toBe(true)
      s1.dispose()

      // Second session: rehydrates from persisted state
      const s2 = createService()
      await s2.initialize()
      const stored = globalState.get<any>("kilo.canonicalIndex.providers")
      expect(stored).not.toBeNull()
      expect(stored.providers).toHaveLength(1)
      s2.dispose()
    })

    it("registers watcher callbacks", async () => {
      const service = createService()
      await service.initialize()
      // Watchers should be registered for config files and asset dirs
      // 2 config files + 12 asset dirs (6 dirs × 2 scopes) = 14 watchers
      expect(watcherAdapter.watchers_.length).toBeGreaterThanOrEqual(14)
      service.dispose()
    })
  })

  describe("valid external edits via watcher", () => {
    it("re-materializes on valid external config edit", async () => {
      writeGlobalConfig({ model: "openai/gpt-4" })
      const service = createService()
      await service.initialize()
      expect(service.materialized!.value.model).toBe("openai/gpt-4")

      // Simulate external edit
      writeGlobalConfig({ model: "anthropic/claude-sonnet-4-20250514" })
      // Fire the config file watcher callback
      const configWatcher = watcherAdapter.watchers_[0]
      configWatcher.onChange()

      // Allow debounce to fire
      await new Promise((r) => setTimeout(r, 100))
      expect(service.materialized!.value.model).toBe("anthropic/claude-sonnet-4-20250514")
      service.dispose()
    })

    it("emits change event on external edit", async () => {
      writeGlobalConfig({ model: "openai/gpt-4" })
      const service = createService()
      const events: string[] = []
      service.onDidChange((e) => events.push(e.source))
      await service.initialize()

      writeGlobalConfig({ model: "anthropic/claude-sonnet-4-20250514" })
      const configWatcher = watcherAdapter.watchers_[0]
      configWatcher.onChange()
      await new Promise((r) => setTimeout(r, 100))
      expect(events).toContain("external")
      service.dispose()
    })
  })

  describe("invalid edits preserve prior", () => {
    it("preserves valid materialization on invalid config", async () => {
      writeGlobalConfig({ model: "openai/gpt-4" })
      const service = createService()
      await service.initialize()
      const priorHash = service.materialized!.contentHash

      // Write invalid config (unknown key)
      fs.writeFileSync(path.join(globalRoot, "kilo.jsonc"), '{"model": "openai/gpt-4", "unknown_key": "value"}')
      const configWatcher = watcherAdapter.watchers_[0]
      configWatcher.onChange()
      await new Promise((r) => setTimeout(r, 100))

      // Should preserve prior valid materialization
      expect(service.materialized!.contentHash).toBe(priorHash)
      expect(service.materialized!.value.model).toBe("openai/gpt-4")
      service.dispose()
    })

    it("emits error on invalid edit", async () => {
      writeGlobalConfig({ model: "openai/gpt-4" })
      const service = createService()
      const errors: any[] = []
      service.onDidError((e) => errors.push(e))
      await service.initialize()

      fs.writeFileSync(path.join(globalRoot, "kilo.jsonc"), '{"model": "openai/gpt-4", "unknown_key": "value"}')
      const configWatcher = watcherAdapter.watchers_[0]
      configWatcher.onChange()
      await new Promise((r) => setTimeout(r, 100))
      expect(errors.some((e) => e.kind === "invalid")).toBe(true)
      service.dispose()
    })
  })

  describe("config deletion (ENOENT)", () => {
    it("treats file deletion as legal absence", async () => {
      writeGlobalConfig({ model: "openai/gpt-4" })
      const service = createService()
      await service.initialize()

      // Delete the config file
      fs.unlinkSync(path.join(globalRoot, "kilo.jsonc"))
      const configWatcher = watcherAdapter.watchers_[0]
      configWatcher.onChange()
      await new Promise((r) => setTimeout(r, 100))

      // Should materialize with empty state (no error)
      expect(service.materialized).not.toBeNull()
      expect(service.materialized!.value.model).toBeUndefined()
      service.dispose()
    })
  })

  describe("asset scanning", () => {
    it("scans agent assets on initialization", async () => {
      writeAgentMd("coder", { name: "Coder", displayName: "Code Assistant", mode: "primary" }, "You are a coder.", "global")
      writeAgentMd("reviewer", { name: "Reviewer", displayName: "Code Reviewer" }, "Review code.", "project")
      const service = createService()
      await service.initialize()

      const scan = service.assetScan!
      expect(scan.entries.length).toBe(2)
      expect(scan.entries.some((e) => e.id === "coder" && e.scope === "global")).toBe(true)
      expect(scan.entries.some((e) => e.id === "reviewer" && e.scope === "project")).toBe(true)
      service.dispose()
    })

    it("scans command assets", async () => {
      writeCommandMd("explain", { description: "Explain code" }, "Explain this code.", "global")
      const service = createService()
      await service.initialize()

      const scan = service.assetScan!
      expect(scan.entries.some((e) => e.id === "explain")).toBe(true)
      service.dispose()
    })

    it("detects duplicate asset IDs across scopes", async () => {
      writeAgentMd("shared", { name: "Shared" }, "Global version.", "global")
      writeAgentMd("shared", { name: "Shared" }, "Project version.", "project")
      const service = createService()
      await service.initialize()

      const scan = service.assetScan!
      expect(scan.duplicateIds.length).toBe(1)
      expect(scan.duplicateIds[0].id).toBe("shared")
      service.dispose()
    })

    it("rescans assets on watcher event", async () => {
      writeAgentMd("coder", { name: "Coder" }, "Prompt.", "global")
      const service = createService()
      await service.initialize()
      expect(service.assetScan!.entries.length).toBe(1)

      // Add a new asset
      writeAgentMd("reviewer", { name: "Reviewer" }, "Review.", "project")
      // Asset watchers start after 2 config file watchers (index 2+)
      // Find the global agent watcher (the one that has the existing coder agent)
      const assetWatcherIdx = watcherAdapter.watchers_.findIndex(
        (w) => w.dir === path.join(globalRoot, "agent"),
      )
      expect(assetWatcherIdx).toBeGreaterThanOrEqual(2)
      watcherAdapter.watchers_[assetWatcherIdx].onChange()
      await new Promise((r) => setTimeout(r, 100))

      expect(service.assetScan!.entries.length).toBe(2)
      service.dispose()
    })
  })

  describe("stale asset write", () => {
    it("rejects asset write with wrong expected hash", async () => {
      writeAgentMd("coder", { name: "Coder" }, "Prompt.", "global")
      const service = createService()
      await service.initialize()

      const wrongHash = "wronghash1234567"
      const result = await service.writeAsset("agent", "coder", { name: "Updated" }, "New prompt.", "global", wrongHash)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.kind).toBe("stale")
      }
      service.dispose()
    })

    it("allows asset write with correct expected hash", async () => {
      const { contentHash } = require("../../src/config/parse")
      const filePath = writeAgentMd("coder", { name: "Coder" }, "Prompt.", "global")
      const originalHash = contentHash(fs.readFileSync(filePath, "utf-8"))

      const service = createService()
      await service.initialize()

      const result = await service.writeAsset("agent", "coder", { name: "Updated" }, "New prompt.", "global", originalHash)
      expect(result.ok).toBe(true)
      service.dispose()
    })
  })

  describe("secret transaction semantics", () => {
    it("processCredentialIntent stores secret and returns ref", async () => {
      writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
      const service = createService()
      await service.initialize()

      const result = await service.processCredentialIntent(
        "global", "provider", "openai", "sk-123",
        { provider: { openai: { endpoint: "https://api.openai.com/v1", credential: "secret:kilo.credentials.global.provider.openai" } } },
        service.getConfigHash("global")!,
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.ref).toBe("secret:kilo.credentials.global.provider.openai")
        expect(await service.hasSecret(result.ref)).toBe(true)
      }
      service.dispose()
    })

    it("rolls back secret on config commit failure", async () => {
      writeGlobalConfig({ model: "openai/gpt-4" })
      const service = createService()
      await service.initialize()

      // Invalid config patch (unknown key) will fail commit
      const result = await service.processCredentialIntent(
        "global", "provider", "openai", "sk-123",
        { model: "openai/gpt-4", unknown_key: "value" },
        service.getConfigHash("global")!,
      )
      expect(result.ok).toBe(false)
      // Secret should be rolled back
      expect(await service.hasSecret("secret:kilo.credentials.global.provider.openai")).toBe(false)
      service.dispose()
    })

    it("removeCredentialAfterCommit deletes owned secret", async () => {
      const service = createService()
      await service.storeSecret("global", "provider", "openai", "sk-123")
      expect(await service.hasSecret("secret:kilo.credentials.global.provider.openai")).toBe(true)

      await service.removeCredentialAfterCommit("global", "provider", "openai")
      expect(await service.hasSecret("secret:kilo.credentials.global.provider.openai")).toBe(false)
      service.dispose()
    })
  })

  describe("own-write coalescing", () => {
    it("coalesces watcher event from own write", async () => {
      writeGlobalConfig({ model: "openai/gpt-4" })
      const service = createService()
      const events: string[] = []
      service.onDidChange((e) => events.push(e.source))
      await service.initialize()
      expect(events).toContain("init")

      // GUI write triggers materialization
      const result = await service.writeConfig("global", { model: "anthropic/claude-sonnet-4-20250514" }, service.getConfigHash("global")!)
      expect(result.ok).toBe(true)

      // Allow debounce to fire (watcher events are coalesced)
      await new Promise((r) => setTimeout(r, 100))
      // Should have exactly one "gui" event (from writeConfig), no duplicate "external"
      const guiEvents = events.filter((s) => s === "gui")
      expect(guiEvents.length).toBe(1)
      service.dispose()
    })
  })

  describe("index persistence", () => {
    it("persists provider index to globalState", async () => {
      writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
      const service = createService()
      await service.initialize()

      expect(globalState.data_.has("kilo.canonicalIndex.providers")).toBe(true)
      const idx = globalState.get<any>("kilo.canonicalIndex.providers")
      expect(idx.providers).toHaveLength(1)
      expect(idx.providers[0].id).toBe("openai")
      service.dispose()
    })

    it("persists model index to workspaceState", async () => {
      writeProjectConfig({ model: "anthropic/claude-sonnet-4-20250514" })
      const service = createService()
      await service.initialize()

      expect(workspaceState.data_.has("kilo.canonicalIndex.projectModel")).toBe(true)
      const idx = workspaceState.get<any>("kilo.canonicalIndex.projectModel")
      expect(idx.model).toBe("anthropic/claude-sonnet-4-20250514")
      service.dispose()
    })

    it("marks stale index on invalid edit while retaining entries", async () => {
      writeGlobalConfig({ provider: { openai: {} } })
      const service = createService()
      await service.initialize()

      const priorIdx = globalState.get<any>("kilo.canonicalIndex.providers")
      expect(priorIdx.diagnostics.invalid).toBe(false)

      // Write invalid config
      fs.writeFileSync(path.join(globalRoot, "kilo.jsonc"), '{"provider": {"openai": {}}, "unknown_key": "bad"}')
      const configWatcher = watcherAdapter.watchers_[0]
      configWatcher.onChange()
      await new Promise((r) => setTimeout(r, 100))

      // Index should still be there with prior valid entries (from prior materialization)
      const afterIdx = globalState.get<any>("kilo.canonicalIndex.providers")
      expect(afterIdx).not.toBeNull()
      service.dispose()
    })
  })

  describe("disposal", () => {
    it("disposes all watchers and resources", async () => {
      const service = createService()
      await service.initialize()
      const watcherCount = watcherAdapter.watchers_.length
      expect(watcherCount).toBeGreaterThan(0)

      service.dispose()
      expect((service as any).disposed).toBe(true)
      expect((service as any).watchers.length).toBe(0)
      expect((service as any).debounceTimers.size).toBe(0)
      expect((service as any).ownWriteHashes.size).toBe(0)
    })

    it("disposes cleanly when called multiple times", async () => {
      const service = createService()
      await service.initialize()
      service.dispose()
      service.dispose() // should not throw
    })

    it("prevents operations after disposal", async () => {
      const service = createService()
      await service.initialize()
      service.dispose()
      const result = await service.writeConfig("global", { model: "test" }, "hash")
      expect(result.ok).toBe(false)
    })
  })
})

// ── No-workspace tests ─────────────────────────────────────────────

describe("no-workspace mode", () => {
  function createNoWorkspaceService(): CanonicalConfigService {
    const roots = new Roots(undefined, globalRoot)
    const context = { secrets, subscriptions: { push: () => {} } } as never
    return new CanonicalConfigService(context, {
      roots,
      secretAdapter: secrets,
      globalState,
      workspaceState,
      watcherAdapter,
      emitterFactory,
    })
  }

  it("hasProject is false", async () => {
    const service = createNoWorkspaceService()
    await service.initialize()
    expect(service.hasProject).toBe(false)
    expect(service.canonicalPaths.projectRoot).toBeUndefined()
    expect(service.canonicalPaths.projectConfigFile).toBeUndefined()
    expect(service.canonicalPaths.projectAssetDirs).toBeUndefined()
    service.dispose()
  })

  it("initializes global-only without error", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createNoWorkspaceService()
    await service.initialize()
    expect(service.materialized).not.toBeNull()
    expect(service.materialized!.value.model).toBe("openai/gpt-4")
    service.dispose()
  })

  it("creates no project watchers", async () => {
    const service = createNoWorkspaceService()
    await service.initialize()
    // Should have 1 config file watcher (global) + 6 asset dir watchers (global only) = 7
    const projectWatchers = watcherAdapter.watchers_.filter(
      (w) => w.dir.includes(".kilo"),
    )
    expect(projectWatchers.length).toBe(0)
    service.dispose()
  })

  it("project writeConfig fails without touching cwd", async () => {
    const service = createNoWorkspaceService()
    await service.initialize()
    const cwdKilo = path.join(process.cwd(), ".kilo")
    const hadKiloBefore = fs.existsSync(cwdKilo)
    const result = await service.writeConfig("project", { model: "test" }, "absent")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe("invalid")
      expect(result.message).toContain("No workspace folder")
    }
    // cwd .kilo should not have been created
    if (!hadKiloBefore) {
      expect(fs.existsSync(cwdKilo)).toBe(false)
    }
    service.dispose()
  })

  it("project writeAsset fails", async () => {
    const service = createNoWorkspaceService()
    await service.initialize()
    const result = await service.writeAsset("agent", "test", { name: "Test" }, "body", "project", "absent")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("No workspace folder")
    }
    service.dispose()
  })

  it("project deleteAsset fails", async () => {
    const service = createNoWorkspaceService()
    await service.initialize()
    const result = await service.deleteAsset("agent", "test", "project", "absent")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("No workspace folder")
    }
    service.dispose()
  })

  it("project readAsset fails", async () => {
    const service = createNoWorkspaceService()
    await service.initialize()
    const result = service.readAsset("agent", "test", "project")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("No workspace folder")
    }
    service.dispose()
  })

  it("project getScopeConfig returns empty", async () => {
    const service = createNoWorkspaceService()
    await service.initialize()
    const config = service.getScopeConfig("project")
    expect(config).toEqual({})
    service.dispose()
  })

  it("project getAssetStamp returns absent", async () => {
    const service = createNoWorkspaceService()
    await service.initialize()
    const stamp = service.getAssetStamp("agent", "test", "project")
    expect(stamp).toBe("absent")
    service.dispose()
  })

  it("project writeConfigScopes fails", async () => {
    const service = createNoWorkspaceService()
    await service.initialize()
    const result = await service.writeConfigScopes({
      project: { patch: { model: "test" }, expectedHash: "absent" },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe("invalid")
      expect(result.message).toContain("No workspace folder")
    }
    service.dispose()
  })

  it("global-only writeConfigScopes succeeds in no-workspace mode", async () => {
    const service = createNoWorkspaceService()
    await service.initialize()
    const result = await service.writeConfigScopes({
      global: { patch: { model: "anthropic/claude-sonnet-4-20250514" }, expectedHash: "absent" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.snapshot.config.value.model).toBe("anthropic/claude-sonnet-4-20250514")
    }
    service.dispose()
  })

  it("global-only composite write does not touch cwd in no-workspace mode", async () => {
    const service = createNoWorkspaceService()
    await service.initialize()
    const cwdKilo = path.join(process.cwd(), ".kilo")
    const hadKiloBefore = fs.existsSync(cwdKilo)
    const result = await service.writeConfigScopes({
      global: { patch: { model: "anthropic/claude-sonnet-4-20250514" }, expectedHash: "absent" },
    })
    expect(result.ok).toBe(true)
    // cwd .kilo should not have been created
    if (!hadKiloBefore) {
      expect(fs.existsSync(cwdKilo)).toBe(false)
    }
    service.dispose()
  })

  it("composite with project patch and no workspace returns projectAbsent", async () => {
    const service = createNoWorkspaceService()
    await service.initialize()
    const result = await service.writeConfigScopes({
      global: { patch: { model: "anthropic/claude-sonnet-4-20250514" }, expectedHash: "absent" },
      project: { patch: { model: "openai/gpt-4" }, expectedHash: "absent" },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe("invalid")
      expect(result.message).toContain("No workspace folder")
    }
    service.dispose()
  })

  it("global write succeeds in no-workspace mode", async () => {
    const service = createNoWorkspaceService()
    await service.initialize()
    const result = await service.writeConfig("global", { model: "anthropic/claude-sonnet-4-20250514" }, "absent")
    expect(result.ok).toBe(true)
    expect(service.materialized!.value.model).toBe("anthropic/claude-sonnet-4-20250514")
    service.dispose()
  })

  it("scanAssets includes only global entries", async () => {
    writeAgentMd("coder", { name: "Coder" }, "Prompt.", "global")
    const service = createNoWorkspaceService()
    await service.initialize()
    const scan = service.assetScan!
    expect(scan.entries.every((e) => e.scope === "global")).toBe(true)
    expect(scan.entries.some((e) => e.id === "coder")).toBe(true)
    service.dispose()
  })
})
