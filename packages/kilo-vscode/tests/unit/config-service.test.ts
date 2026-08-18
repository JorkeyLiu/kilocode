/**
 * P4.1 Canonical Config Service integration tests.
 *
 * Tests the service lifecycle with real temp filesystem operations
 * and in-memory VS Code state/secret adapters.
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
  createMemoryEmitterFactory,
} from "../../src/config/state-adapter"
import { CanonicalConfigService } from "../../src/config/service"

// ── Test fixtures ────────────────────────────────────────────────────

let tmpDir: string
let globalRoot: string
let projectRoot: string
let secrets: ReturnType<typeof createMemorySecretAdapter>
let globalState: ReturnType<typeof createMemoryStateAdapter>
let workspaceState: ReturnType<typeof createMemoryStateAdapter>
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
  emitterFactory = createMemoryEmitterFactory()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function createService(): CanonicalConfigService {
  const roots = new Roots(projectRoot, globalRoot)
  const context = { secrets, subscriptions: { push: () => {} } }
  return new CanonicalConfigService(context, {
    roots,
    secretAdapter: secrets,
    globalState,
    workspaceState,
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

describe("CanonicalConfigService", () => {
  it("writes global and project patches as one stamped transaction", async () => {
    const service = createService()
    await service.initialize()
    const result = await service.writeConfigScopes({
      global: { patch: { instructions: ["global.md"] }, expectedHash: "absent" },
      project: { patch: { default_agent: "reviewer" }, expectedHash: "absent" },
    })
    expect(result.ok).toBe(true)
    expect(service.getScopeConfig("global").instructions).toEqual(["global.md"])
    expect(service.getScopeConfig("project").default_agent).toBe("reviewer")
    service.dispose()
  })

  it("rejects a stale composite scope without changing either file", async () => {
    const service = createService()
    await service.initialize()
    const result = await service.writeConfigScopes({
      global: { patch: { instructions: ["global.md"] }, expectedHash: "wrong" },
      project: { patch: { default_agent: "reviewer" }, expectedHash: "absent" },
    })
    expect(result).toMatchObject({ ok: false, kind: "stale", scope: "global" })
    expect(service.getScopeConfig("global")).toEqual({})
    expect(service.getScopeConfig("project")).toEqual({})
    service.dispose()
  })

  it("rejects composite write when single field conflicts across scopes", async () => {
    // Pre-populate both scopes with conflicting model values
    writeGlobalConfig({ model: "openai/gpt-4" })
    writeProjectConfig({ model: "anthropic/claude-sonnet-4-20250514" })
    const service = createService()
    await service.initialize()
    const priorHash = service.getConfigHash("global")!
    const priorProjectHash = service.getConfigHash("project")!

    // Attempt composite write — should fail due to cross-scope single-field conflict
    const result = await service.writeConfigScopes({
      global: { patch: { model: "openai/gpt-4o" }, expectedHash: priorHash },
      project: { patch: { model: "anthropic/claude-sonnet-4-20250514" }, expectedHash: priorProjectHash },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe("conflict")
      expect(result.message).toContain("Cross-scope conflict")
    }
    // Verify neither file was modified
    expect(service.getConfigHash("global")).toBe(priorHash)
    expect(service.getConfigHash("project")).toBe(priorProjectHash)
    service.dispose()
  })

  it("rejects composite write when subagent_model conflicts across scopes", async () => {
    writeGlobalConfig({ subagent_model: "openai/gpt-4" })
    writeProjectConfig({ subagent_model: "anthropic/claude-sonnet-4-20250514" })
    const service = createService()
    await service.initialize()
    const priorHash = service.getConfigHash("global")!
    const priorProjectHash = service.getConfigHash("project")!

    const result = await service.writeConfigScopes({
      global: { patch: { subagent_model: "openai/gpt-4o" }, expectedHash: priorHash },
      project: { patch: { subagent_model: "anthropic/claude-sonnet-4-20250514" }, expectedHash: priorProjectHash },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe("conflict")
      expect(result.message).toContain("Cross-scope conflict")
    }
    // Verify neither file was modified
    expect(service.getConfigHash("global")).toBe(priorHash)
    expect(service.getConfigHash("project")).toBe(priorProjectHash)
    service.dispose()
  })

  it("allows composite write with single field in only one scope", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()
    await service.initialize()
    const priorHash = service.getConfigHash("global")!

    const result = await service.writeConfigScopes({
      global: { patch: { model: "openai/gpt-4o" }, expectedHash: priorHash },
    })
    expect(result.ok).toBe(true)
    expect(service.materialized!.value.model).toBe("openai/gpt-4o")
    service.dispose()
  })
  describe("initialization", () => {
    it("materializes from empty state without error", async () => {
      const service = createService()
      await service.initialize()
      expect(service.materialized).not.toBeNull()
      expect(service.snapshot).not.toBeNull()
      service.dispose()
    })

    it("materializes from a global config file", async () => {
      writeGlobalConfig({ model: "openai/gpt-4" })
      const service = createService()
      await service.initialize()
      expect(service.materialized!.value.model).toBe("openai/gpt-4")
      service.dispose()
    })

    it("materializes from a project config file", async () => {
      writeProjectConfig({ model: "anthropic/claude-sonnet-4-20250514" })
      const service = createService()
      await service.initialize()
      expect(service.materialized!.value.model).toBe("anthropic/claude-sonnet-4-20250514")
      service.dispose()
    })
  })

  describe("materialization", () => {
    it("produces a valid materialization from global config", async () => {
      writeGlobalConfig({ model: "openai/gpt-4" })
      const service = createService()
      await service.initialize()
      expect(service.materialized!.value.model).toBe("openai/gpt-4")
      expect(service.materialized!.contentHash).toBeTruthy()
      expect(service.materialized!.version).toBeGreaterThan(0)
      service.dispose()
    })

    it("merges global and project configs (project-only wins for single fields)", async () => {
      writeProjectConfig({ model: "anthropic/claude-sonnet-4-20250514" })
      const service = createService()
      await service.initialize()
      expect(service.materialized!.value.model).toBe("anthropic/claude-sonnet-4-20250514")
      service.dispose()
    })

    it("detects cross-scope conflicts for single fields", async () => {
      writeGlobalConfig({ model: "openai/gpt-4" })
      writeProjectConfig({ model: "anthropic/claude-sonnet-4-20250514" })
      const service = createService()
      const errors: any[] = []
      service.onDidError((e) => errors.push(e))
      await service.initialize()
      // model has crossScopeConflict: true, so both explicit = error
      expect(errors.length).toBeGreaterThan(0)
      service.dispose()
    })

    it("returns project value when only project provides a single field", async () => {
      writeProjectConfig({ model: "anthropic/claude-sonnet-4-20250514" })
      const service = createService()
      await service.initialize()
      expect(service.materialized!.value.model).toBe("anthropic/claude-sonnet-4-20250514")
      service.dispose()
    })
  })

  describe("credential handling", () => {
    it("stores and retrieves credentials via the service", async () => {
      const service = createService()
      await service.initialize()
      const ref = await service.storeSecret("global", "provider", "openai", "sk-123")
      expect(ref).toBe("secret:kilo.credentials.global.provider.openai")

      const exists = await service.hasSecret(ref)
      expect(exists).toBe(true)

      const stored = await (service as any).secrets.retrieve("kilo.credentials.global.provider.openai")
      expect(stored).toBe("sk-123")

      await service.removeSecret("global", "provider", "openai")
      const existsAfter = await service.hasSecret(ref)
      expect(existsAfter).toBe(false)

      service.dispose()
    })

    it("lists stored provider IDs", async () => {
      const service = createService()
      await service.initialize()
      await service.storeSecret("global", "provider", "openai", "sk-1")
      await service.storeSecret("global", "provider", "anthropic", "sk-2")
      await service.storeSecret("project", "provider", "openai", "sk-3")

      const globalIds = await service.listStoredProviders("global")
      expect(globalIds).toEqual(new Set(["openai", "anthropic"]))

      const projectIds = await service.listStoredProviders("project")
      expect(projectIds).toEqual(new Set(["openai"]))

      service.dispose()
    })
  })

  describe("index building", () => {
    it("builds a provider index from the materialization", async () => {
      writeProjectConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1", credential: "secret:kilo.credentials.project.provider.openai" } } })
      const service = createService()
      await service.initialize()

      await service.storeSecret("project", "provider", "openai", "sk-123")
      const idx = await service.buildProviderIndexAsync("openai")
      expect(idx).not.toBeNull()
      expect(idx!.providers).toHaveLength(1)
      expect(idx!.providers[0].id).toBe("openai")
      expect(idx!.providers[0].hasCredential).toBe(true)
      expect(idx!.selectedId).toBe("openai")
      service.dispose()
    })

    it("builds a model index from the materialization", async () => {
      writeProjectConfig({ model: "anthropic/claude-sonnet-4-20250514", model_variant: "high" })
      const service = createService()
      await service.initialize()

      const idx = service.buildModelIndex("project", "anthropic/claude-sonnet-4-20250514", "high")
      expect(idx).not.toBeNull()
      expect(idx!.model).toBe("anthropic/claude-sonnet-4-20250514")
      expect(idx!.variant).toBe("high")
      expect(idx!.selectedModel).toBe("anthropic/claude-sonnet-4-20250514")
      expect(idx!.selectedVariant).toBe("high")
      service.dispose()
    })
  })

  describe("disposal", () => {
    it("marks as disposed and prevents further operations", async () => {
      const service = createService()
      await service.initialize()
      service.dispose()
      expect((service as any).disposed).toBe(true)
    })

    it("disposes cleanly when called multiple times", async () => {
      const service = createService()
      await service.initialize()
      service.dispose()
      service.dispose() // should not throw
    })
  })

  describe("MCP credential cleanup", () => {
    it("cleanupMcpCredential returns ok:true when prior record has no credential ref", async () => {
      const service = createService()
      await service.initialize()
      const priorRecord = { type: "local", command: "node" }
      const result = await service.cleanupMcpCredential(
        "global", "filesystem", priorRecord, service.stamp,
      )
      expect(result.ok).toBe(true)
      service.dispose()
    })

    it("cleanupMcpCredential rejects when prior record has provider-kind ref", async () => {
      const service = createService()
      await service.initialize()
      const priorRecord = { type: "local", command: "node", credential: "secret:kilo.credentials.global.provider.filesystem" }
      const result = await service.cleanupMcpCredential(
        "global", "filesystem", priorRecord, service.stamp,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toContain("invalid")
      }
      service.dispose()
    })

    it("cleanupMcpCredential removes exact stored ref on success", async () => {
      const service = createService()
      await service.initialize()
      const ref = "secret:kilo.credentials.global.mcp.filesystem"
      await service.storeSecret("global", "mcp", "filesystem", "mcp-secret")
      const priorRecord = { type: "local", command: "node", credential: ref }
      const result = await service.cleanupMcpCredential(
        "global", "filesystem", priorRecord, service.stamp,
      )
      expect(result.ok).toBe(true)
      expect(await service.hasSecret(ref)).toBe(false)
      service.dispose()
    })

    it("cleanupMcpCredential rejects wrong-scope ref", async () => {
      const service = createService()
      await service.initialize()
      const priorRecord = { type: "local", command: "node", credential: "secret:kilo.credentials.project.mcp.filesystem" }
      const result = await service.cleanupMcpCredential(
        "global", "filesystem", priorRecord, service.stamp,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toContain("invalid")
      }
      service.dispose()
    })
  })

  describe("orphaned credential ref behavior", () => {
    it("orphaned secret in SecretStorage is not reflected in provider index", async () => {
      const writeProjectConfigPath = path.join(projectRoot, ".kilo", "kilo.jsonc")
      fs.writeFileSync(writeProjectConfigPath, JSON.stringify({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } }), "utf-8")
      const service = createService()
      await service.initialize()
      // Store a secret that the record does NOT reference (orphaned)
      await service.storeSecret("global", "provider", "openai", "sk-orphaned")
      const idx = await service.buildProviderIndexAsync()
      expect(idx).not.toBeNull()
      const openai = idx!.providers.find((p) => p.id === "openai")
      expect(openai).toBeDefined()
      expect(openai!.hasCredential).toBe(false)
      service.dispose()
    })

    it("exact record ref with matching stored secret is reflected in provider index", async () => {
      writeProjectConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1", credential: "secret:kilo.credentials.project.provider.openai" } } })
      const service = createService()
      await service.initialize()
      await service.storeSecret("project", "provider", "openai", "sk-real")
      const idx = await service.buildProviderIndexAsync()
      expect(idx).not.toBeNull()
      const openai = idx!.providers.find((p) => p.id === "openai")
      expect(openai).toBeDefined()
      expect(openai!.hasCredential).toBe(true)
      service.dispose()
    })

    it("exact record ref with missing stored secret shows hasCredential false", async () => {
      writeProjectConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1", credential: "secret:kilo.credentials.project.provider.openai" } } })
      const service = createService()
      await service.initialize()
      // Do NOT store the secret — ref is valid format but secret is missing
      const idx = await service.buildProviderIndexAsync()
      expect(idx).not.toBeNull()
      const openai = idx!.providers.find((p) => p.id === "openai")
      expect(openai).toBeDefined()
      expect(openai!.hasCredential).toBe(false)
      service.dispose()
    })
  })
})
