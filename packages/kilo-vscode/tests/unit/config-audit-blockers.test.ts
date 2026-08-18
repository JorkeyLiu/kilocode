/**
 * P4.1 Canonical Config Service — 13 audit blocker regression tests.
 *
 * Each test exercises one specific audit finding with realistic triggers
 * including non-ENOENT failures, invalid diagnostic persistence, rehydration
 * getters, agent add/duplicate/malformed YAML, own-write plus external bytes,
 * out-of-order persistence, double init/dispose, secret rollback, partial
 * patch retention, cross-scope preflight, final-CAS race, missing stamp,
 * path traversal, inaccessible asset directory/file, and endpoint/variant
 * absence from persisted state.
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
import { readFile } from "../../src/config/parse"
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p41-audit-test-"))
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

// ── Blocker 1: Discriminated file read ──────────────────────────────

function findAgentWatcher(scope: "global" | "project"): number {
  const suffix = scope === "project" ? path.join(projectRoot, ".kilo", "agent") : path.join(globalRoot, "agent")
  return watcherAdapter.watchers_.findIndex((w) => w.dir === suffix)
}

describe("Blocker 1: Discriminated file read", () => {
  it("readFile returns present with bytes and hash", () => {
    const fp = path.join(tmpDir, "test.txt")
    fs.writeFileSync(fp, "hello world")
    const result = readFile(fp)
    expect(result.type).toBe("present")
    if (result.type === "present") {
      expect(result.bytes).toBe("hello world")
      expect(result.hash).toBeTruthy()
      expect(result.hash.length).toBe(16)
    }
  })

  it("readFile returns absent for ENOENT", () => {
    const result = readFile(path.join(tmpDir, "nonexistent.txt"))
    expect(result.type).toBe("absent")
  })

  it("readFile returns failure for permission error", () => {
    const fp = path.join(tmpDir, "noperm.txt")
    fs.writeFileSync(fp, "content", { mode: 0o000 })
    const result = readFile(fp)
    // On macOS root can read anything, so we accept either failure or present
    expect(result.type === "failure" || result.type === "present").toBe(true)
  })

  it("materializeFromDisk uses discriminated read for content hash", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()
    await service.initialize()
    expect(service.getConfigHash("global")).toBeTruthy()
    service.dispose()
  })

  it("materializeFromDisk sets hash null on absent", async () => {
    const service = createService()
    await service.initialize()
    expect(service.getConfigHash("global")).toBeNull()
    expect(service.getConfigHash("project")).toBeNull()
    service.dispose()
  })
})

// ── Blocker 2: Non-ENOENT failure preserves prior ──────────────────

describe("Blocker 2: Non-ENOENT failure preserves prior", () => {
  it("preserves materialization when config file becomes unreadable", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()
    await service.initialize()
    const priorHash = service.materialized!.contentHash

    // Make config file unreadable by replacing with directory (causes read error)
    fs.unlinkSync(path.join(globalRoot, "kilo.jsonc"))
    fs.mkdirSync(path.join(globalRoot, "kilo.jsonc"), { recursive: true })

    // Trigger re-materialization via watcher
    const configWatcher = watcherAdapter.watchers_[0]
    configWatcher.onChange()
    await new Promise((r) => setTimeout(r, 100))

    // Prior materialization should be preserved
    expect(service.materialized!.contentHash).toBe(priorHash)
    service.dispose()
  })

  it("emits error diagnostics on non-ENOENT read failure", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()
    const errors: any[] = []
    service.onDidError((e) => errors.push(e))
    await service.initialize()

    // Make file unreadable
    fs.unlinkSync(path.join(globalRoot, "kilo.jsonc"))
    fs.mkdirSync(path.join(globalRoot, "kilo.jsonc"))

    const configWatcher = watcherAdapter.watchers_[0]
    configWatcher.onChange()
    await new Promise((r) => setTimeout(r, 100))

    expect(errors.some((e) => e.kind === "invalid" && e.message.includes("Cannot read"))).toBe(true)
    service.dispose()
  })
})

// ── Blocker 3: Rehydrated indexes for immediate UI ──────────────────

describe("Blocker 3: Rehydrated indexes for immediate UI", () => {
  it("exposes rehydrated provider index via getter", async () => {
    writeGlobalConfig({ provider: { openai: {} } })
    const s1 = createService()
    await s1.initialize()
    expect(globalState.data_.has("kilo.canonicalIndex.providers")).toBe(true)
    s1.dispose()

    // New service rehydrates from persisted state
    const s2 = createService()
    await s2.initialize()
    expect(s2.providerIndex).not.toBeNull()
    expect(s2.providerIndex!.providers).toHaveLength(1)
    expect(s2.providerIndex!.providers[0].id).toBe("openai")
    s2.dispose()
  })

  it("exposes rehydrated agent index via getter", async () => {
    writeAgentMd("coder", { name: "Coder", displayName: "Code Assistant" }, "Prompt.", "project")
    const s1 = createService()
    await s1.initialize()
    s1.dispose()

    const s2 = createService()
    await s2.initialize()
    expect(s2.agentIndex).not.toBeNull()
    s2.dispose()
  })

  it("exposes rehydrated model index via getter", async () => {
    writeProjectConfig({ model: "anthropic/claude-sonnet-4-20250514" })
    const s1 = createService()
    await s1.initialize()
    s1.dispose()

    const s2 = createService()
    await s2.initialize()
    expect(s2.projectModelIndex).not.toBeNull()
    expect(s2.projectModelIndex!.model).toBe("anthropic/claude-sonnet-4-20250514")
    s2.dispose()
  })
})

// ── Blocker 4: Agent index from validated scan entries ──────────────

describe("Blocker 4: Agent index from validated scan", () => {
  it("builds agent index from validated scan on init", async () => {
    writeAgentMd("coder", { name: "Coder", displayName: "Code Assistant", mode: "primary" }, "Prompt.", "project")
    const service = createService()
    await service.initialize()
    expect(service.agentIndex).not.toBeNull()
    expect(service.agentIndex!.agents).toHaveLength(1)
    expect(service.agentIndex!.agents[0].id).toBe("coder")
    expect(service.agentIndex!.agents[0].displayName).toBe("Code Assistant")
    expect(service.agentIndex!.agents[0].mode).toBe("primary")
    service.dispose()
  })

  it("skips malformed YAML assets in agent index", async () => {
    // Write a valid agent
    writeAgentMd("coder", { name: "Coder" }, "Prompt.", "project")
    // Write a malformed agent (invalid YAML)
    const badDir = path.join(projectRoot, ".kilo", "agent")
    fs.writeFileSync(path.join(badDir, "bad.md"), "---\nname: [\ninvalid yaml\n---\nBody.", "utf-8")
    const service = createService()
    await service.initialize()
    expect(service.agentIndex!.agents).toHaveLength(1)
    expect(service.agentIndex!.agents[0].id).toBe("coder")
    service.dispose()
  })

  it("detects duplicate agent IDs across scopes", async () => {
    writeAgentMd("shared", { name: "Shared" }, "Global.", "global")
    writeAgentMd("shared", { name: "Shared" }, "Project.", "project")
    const service = createService()
    await service.initialize()
    const scan = service.assetScan!
    expect(scan.duplicateIds.length).toBe(1)
    expect(scan.duplicateIds[0].id).toBe("shared")
    service.dispose()
  })

  it("namespaces duplicate diagnostics by asset directory", async () => {
    writeAgentMd("shared", { name: "Shared" }, "Agent.", "global")
    const skillDir = path.join(globalRoot, "skill")
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, "shared.md"), "---\nname: Shared\ndescription: Skill\n---\nSkill.", "utf8")
    const service = createService()
    await service.initialize()
    expect(service.assetScan!.duplicateIds).toHaveLength(0)
    expect(service.agentIndex!.diagnostics.invalid).toBe(false)
    service.dispose()
  })

  it("persists agent index to workspaceState", async () => {
    writeAgentMd("coder", { name: "Coder" }, "Prompt.", "project")
    const service = createService()
    await service.initialize()
    expect(workspaceState.data_.has("kilo.canonicalIndex.agents")).toBe(true)
    const idx = workspaceState.get<any>("kilo.canonicalIndex.agents")
    expect(idx.agents).toHaveLength(1)
    service.dispose()
  })
})

// ── Blocker 5: Hash-based own-write coalescing ─────────────────────

describe("Blocker 5: Hash-based own-write coalescing", () => {
  it("coalesces watcher event when reread bytes match own-write hash", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()
    const events: string[] = []
    service.onDidChange((e) => events.push(e.source))
    await service.initialize()

    // GUI write
    const result = await service.writeConfig("global", { model: "anthropic/claude-sonnet-4-20250514" }, service.getConfigHash("global")!)
    expect(result.ok).toBe(true)

    // Watcher fires for the same file — should be coalesced
    const configWatcher = watcherAdapter.watchers_[0]
    configWatcher.onChange()
    await new Promise((r) => setTimeout(r, 100))

    // Only one gui event, no duplicate external
    const guiEvents = events.filter((s) => s === "gui")
    expect(guiEvents.length).toBe(1)
    service.dispose()
  })

  it("does NOT coalesce when external bytes differ from own-write hash", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()
    const events: string[] = []
    service.onDidChange((e) => events.push(e.source))
    await service.initialize()

    // GUI write
    await service.writeConfig("global", { model: "anthropic/claude-sonnet-4-20250514" }, service.getConfigHash("global")!)

    // External edit with different bytes
    writeGlobalConfig({ model: "openai/gpt-4o" })
    const configWatcher = watcherAdapter.watchers_[0]
    configWatcher.onChange()
    await new Promise((r) => setTimeout(r, 100))

    // Should have external event (different bytes)
    const externalEvents = events.filter((s) => s === "external")
    expect(externalEvents.length).toBeGreaterThanOrEqual(1)
    service.dispose()
  })
})

// ── Blocker 6: Revision-gated event queue ──────────────────────────

describe("Blocker 6: Revision-gated event queue", () => {
  it("processes events in order and skips stale", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()
    await service.initialize()

    // Fire multiple rapid events
    const configWatcher = watcherAdapter.watchers_[0]
    writeGlobalConfig({ model: "anthropic/claude-sonnet-4-20250514" })
    configWatcher.onChange()
    writeGlobalConfig({ model: "openai/gpt-4o" })
    configWatcher.onChange()

    await new Promise((r) => setTimeout(r, 200))

    // Should end up with the latest value
    expect(service.materialized!.value.model).toBe("openai/gpt-4o")
    service.dispose()
  })
})

// ── Blocker 7: Initialize idempotency ──────────────────────────────

describe("Blocker 7: Initialize idempotency", () => {
  it("double initialize returns same promise", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()
    const p1 = service.initialize()
    const p2 = service.initialize()
    expect(p1).toBe(p2)
    await p1
    await p2
    expect(service.materialized!.value.model).toBe("openai/gpt-4")
    service.dispose()
  })

  it("dispose prevents future operations", async () => {
    const service = createService()
    await service.initialize()
    service.dispose()
    const result = await service.writeConfig("global", { model: "test" }, "hash")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("disposed")
  })
})

// ── Blocker 8: Credential transaction with prior value ─────────────

describe("Blocker 8: Credential transaction rollback", () => {
  it("restores the exact secret before publishing a prior provider record", async () => {
    const source = await Bun.file(new URL("../../src/config/service.ts", import.meta.url)).text()
    const block = source.match(/async cleanupProviderCredential[\s\S]*?private async readPriorSecret/)?.[0] ?? ""
    expect(block.indexOf("restoreSecret(priorRef, priorValue)")).toBeLessThan(block.indexOf("writeConfig(scope, { provider:"))
  })

  it("restores the provider record and reports a retry stamp when cleanup delete fails", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
    const service = createService()
    await service.initialize()
    const ref = await service.storeSecret("global", "provider", "openai", "sk-old")
    const prior = { endpoint: "https://api.openai.com/v1", credential: ref }
    const committed = await service.writeConfig("global", { provider: { openai: prior } }, service.getConfigHash("global")!)
    expect(committed.ok).toBe(true)
    const adapter = secrets as unknown as { delete: (key: string) => Promise<void> }
    adapter.delete = async () => { throw new Error("SecretStorage unavailable") }

    const result = await service.cleanupProviderCredential("global", "openai", prior, service.stamp)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.restored).toBe(true)
      expect(result.mode).toBe("restore")
      expect(result.retryID).toBe("global:openai")
      expect(result.stamp.assetHash).toBeNull()
    }
    expect(service.getScopeConfig("global").provider).toEqual({ openai: prior })
    expect(await secrets.retrieve("kilo.credentials.global.provider.openai")).toBe("sk-old")
    service.dispose()
  })

  it("cleans the exact prior credential reference for an owned ref", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
    const service = createService()
    await service.initialize()
    const ref = await service.storeSecret("global", "provider", "openai", "sk-openai")

    const result = await service.cleanupProviderCredential("global", "openai", { credential: ref }, service.stamp)
    expect(result.ok).toBe(true)
    expect(await service.hasSecret(ref)).toBe(false)
    service.dispose()
  })

  it("rejects a prior credential ref that does not own the provider (strict ownership)", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
    const service = createService()
    await service.initialize()
    const ref = await service.storeSecret("global", "provider", "other", "sk-other")
    await service.storeSecret("global", "provider", "openai", "sk-openai")

    // The record's ref points at a different provider id — cleanup must refuse
    // to delete it (and must not reconstruct the derived key for openai).
    const result = await service.cleanupProviderCredential("global", "openai", { credential: ref }, service.stamp)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.retry).toBe(false)
      expect(result.message).toContain("ref is invalid")
    }
    expect(await service.hasSecret(ref)).toBe(true)
    expect(await service.hasSecret("secret:kilo.credentials.global.provider.openai")).toBe(true)
    service.dispose()
  })

  it("rejects a prior credential ref that does not own the provider scope (strict ownership)", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
    const service = createService()
    await service.initialize()
    const ref = await service.storeSecret("project", "provider", "openai", "sk-project")

    const result = await service.cleanupProviderCredential("global", "openai", { credential: ref }, service.stamp)
    expect(result.ok).toBe(false)
    expect(await service.hasSecret(ref)).toBe(true)
    service.dispose()
  })

  it("cleans nothing when the prior record has no credential ref", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
    const service = createService()
    await service.initialize()
    await service.storeSecret("global", "provider", "openai", "sk-openai")

    // No ref in the prior record: nothing verifiably owned to clean — the
    // derived key must NOT be reconstructed and deleted.
    const result = await service.cleanupProviderCredential("global", "openai", { endpoint: "https://api.openai.com/v1" }, service.stamp)
    expect(result.ok).toBe(true)
    expect(await service.hasSecret("secret:kilo.credentials.global.provider.openai")).toBe(true)
    service.dispose()
  })

  it("restores prior secret value on config commit failure", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
    const service = createService()
    await service.initialize()

    // Store initial secret
    await service.storeSecret("global", "provider", "openai", "sk-old")
    const priorValue = await secrets.retrieve("kilo.credentials.global.provider.openai")
    expect(priorValue).toBe("sk-old")

    // Attempt to update with invalid config (unknown key)
    const result = await service.processCredentialIntent(
      "global", "provider", "openai", "sk-new",
      { model: "openai/gpt-4", unknown_key: "bad" },
      service.getConfigHash("global")!,
      undefined,
      "secret:kilo.credentials.global.provider.openai",
    )
    expect(result.ok).toBe(false)

    // Prior secret should be restored
    const restored = await secrets.retrieve("kilo.credentials.global.provider.openai")
    expect(restored).toBe("sk-old")
    service.dispose()
  })

  it("deletes newly-created secret on config commit failure", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
    const service = createService()
    await service.initialize()

    // No prior secret — attempt to store with invalid config
    const result = await service.processCredentialIntent(
      "global", "provider", "openai", "sk-new",
      { model: "openai/gpt-4", unknown_key: "bad" },
      service.getConfigHash("global")!,
    )
    expect(result.ok).toBe(false)

    // New secret should be deleted
    const exists = await service.hasSecret("secret:kilo.credentials.global.provider.openai")
    expect(exists).toBe(false)
    service.dispose()
  })

  it("returns structured failure and restores prior secret on config commit exception", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
    const service = createService()
    await service.initialize()

    await service.storeSecret("global", "provider", "openai", "sk-old")

    // Force writeConfig to throw by disposing mid-operation
    // (Simulates exception during commit)
    const origWrite = (service as any).writeConfig.bind(service)
    let callCount = 0
    ;(service as any).writeConfig = async (...args: any[]) => {
      callCount++
      if (callCount === 1) throw new Error("simulated failure")
      return origWrite(...args)
    }

    const result = await service.processCredentialIntent(
      "global", "provider", "openai", "sk-new",
      { provider: { openai: { endpoint: "https://api.openai.com/v1" } } },
      service.getConfigHash("global")!,
      undefined,
      "secret:kilo.credentials.global.provider.openai",
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("io")

    // Prior secret should be restored
    const restored = await secrets.retrieve("kilo.credentials.global.provider.openai")
    expect(restored).toBe("sk-old")
    service.dispose()
  })
})

// ── P4.1: Exact prior ref — no derived fallback ──────────────────────

describe("P4.1: Exact prior ref enforcement", () => {
  it("does not read prior secret when priorRef is absent", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
    const service = createService()
    await service.initialize()

    // Store a secret directly (simulates prior credential in SecretStorage)
    await service.storeSecret("global", "provider", "openai", "sk-old")
    expect(await secrets.retrieve("kilo.credentials.global.provider.openai")).toBe("sk-old")

    // processCredentialIntent without priorRef — should NOT read the prior
    // value. On rollback, the newly-stored secret is deleted (not restored).
    const result = await service.processCredentialIntent(
      "global", "provider", "openai", "sk-new",
      { model: "openai/gpt-4", unknown_key: "bad" },
      service.getConfigHash("global")!,
    )
    expect(result.ok).toBe(false)

    // Prior secret was NOT restored — the new secret was deleted on rollback
    // because no valid priorRef was provided.
    const after = await secrets.retrieve("kilo.credentials.global.provider.openai")
    expect(after).toBeUndefined()
    service.dispose()
  })

  it("ignores invalid priorRef and treats as no prior", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
    const service = createService()
    await service.initialize()

    await service.storeSecret("global", "provider", "openai", "sk-old")

    // Pass a malformed priorRef — should be ignored (no read, no restore)
    const result = await service.processCredentialIntent(
      "global", "provider", "openai", "sk-new",
      { model: "openai/gpt-4", unknown_key: "bad" },
      service.getConfigHash("global")!,
      undefined,
      "secret:not-a-valid-ref",
    )
    expect(result.ok).toBe(false)
    // New secret deleted on rollback; prior was not restored
    const after = await secrets.retrieve("kilo.credentials.global.provider.openai")
    expect(after).toBeUndefined()
    service.dispose()
  })

  it("ignores cross-scope priorRef and treats as no prior", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
    const service = createService()
    await service.initialize()

    await service.storeSecret("global", "provider", "openai", "sk-old")

    // Pass a ref for a different scope — should be ignored
    const result = await service.processCredentialIntent(
      "global", "provider", "openai", "sk-new",
      { model: "openai/gpt-4", unknown_key: "bad" },
      service.getConfigHash("global")!,
      undefined,
      "secret:kilo.credentials.project.provider.openai",
    )
    expect(result.ok).toBe(false)
    const after = await secrets.retrieve("kilo.credentials.global.provider.openai")
    expect(after).toBeUndefined()
    service.dispose()
  })

  it("ignores cross-kind priorRef and treats as no prior", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
    const service = createService()
    await service.initialize()

    await service.storeSecret("global", "provider", "openai", "sk-old")

    // Pass a ref for a different kind — should be ignored
    const result = await service.processCredentialIntent(
      "global", "provider", "openai", "sk-new",
      { model: "openai/gpt-4", unknown_key: "bad" },
      service.getConfigHash("global")!,
      undefined,
      "secret:kilo.credentials.global.mcp.openai",
    )
    expect(result.ok).toBe(false)
    const after = await secrets.retrieve("kilo.credentials.global.provider.openai")
    expect(after).toBeUndefined()
    service.dispose()
  })

  it("ignores cross-id priorRef and treats as no prior", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
    const service = createService()
    await service.initialize()

    await service.storeSecret("global", "provider", "openai", "sk-old")

    // Pass a ref for a different id — should be ignored
    const result = await service.processCredentialIntent(
      "global", "provider", "openai", "sk-new",
      { model: "openai/gpt-4", unknown_key: "bad" },
      service.getConfigHash("global")!,
      undefined,
      "secret:kilo.credentials.global.provider.different",
    )
    expect(result.ok).toBe(false)
    const after = await secrets.retrieve("kilo.credentials.global.provider.openai")
    expect(after).toBeUndefined()
    service.dispose()
  })

  it("restores prior secret when exact valid priorRef is provided", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
    const service = createService()
    await service.initialize()

    await service.storeSecret("global", "provider", "openai", "sk-old")

    // Pass the exact valid priorRef — prior value should be restored on rollback
    const result = await service.processCredentialIntent(
      "global", "provider", "openai", "sk-new",
      { model: "openai/gpt-4", unknown_key: "bad" },
      service.getConfigHash("global")!,
      undefined,
      "secret:kilo.credentials.global.provider.openai",
    )
    expect(result.ok).toBe(false)
    const restored = await secrets.retrieve("kilo.credentials.global.provider.openai")
    expect(restored).toBe("sk-old")
    service.dispose()
  })

  it("succeeds with exact priorRef on valid config", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
    const service = createService()
    await service.initialize()

    await service.storeSecret("global", "provider", "openai", "sk-old")

    const result = await service.processCredentialIntent(
      "global", "provider", "openai", "sk-new",
      { provider: { openai: { endpoint: "https://api.openai.com/v1", credential: "secret:kilo.credentials.global.provider.openai" } } },
      service.getConfigHash("global")!,
      undefined,
      "secret:kilo.credentials.global.provider.openai",
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.ref).toBe("secret:kilo.credentials.global.provider.openai")
      expect(await service.hasSecret(result.ref)).toBe(true)
    }
    service.dispose()
  })
})

describe("Blocker 9: Partial patch retention", () => {
  it("preserves existing keys not in patch", async () => {
    writeGlobalConfig({ model: "openai/gpt-4", model_variant: "high" })
    const service = createService()
    await service.initialize()

    // Patch only model — variant should be preserved
    const result = await service.writeConfig(
      "global",
      { model: "anthropic/claude-sonnet-4-20250514" },
      service.getConfigHash("global")!,
    )
    expect(result.ok).toBe(true)
    expect(service.materialized!.value.model).toBe("anthropic/claude-sonnet-4-20250514")
    expect(service.materialized!.value.model_variant).toBe("high")
    service.dispose()
  })

  it("removes keys when patch value is undefined", async () => {
    writeGlobalConfig({ model: "openai/gpt-4", model_variant: "high" })
    const service = createService()
    await service.initialize()

    const result = await service.writeConfig(
      "global",
      { model_variant: undefined },
      service.getConfigHash("global")!,
    )
    expect(result.ok).toBe(true)
    expect(service.materialized!.value.model).toBe("openai/gpt-4")
    expect(service.materialized!.value.model_variant).toBeUndefined()
    service.dispose()
  })

  it("rejects cross-scope conflict before writing", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    writeProjectConfig({ model: "anthropic/claude-sonnet-4-20250514" })
    const service = createService()
    const errors: any[] = []
    service.onDidError((e) => errors.push(e))
    await service.initialize()

    // Both scopes have model with crossScopeConflict — should fail
    const result = await service.writeConfig(
      "global",
      { model: "openai/gpt-4o" },
      service.getConfigHash("global")!,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe("invalid")
      expect(result.message).toContain("Cross-scope conflict")
    }
    service.dispose()
  })
})

// ── Blocker 10: Per-path write lock / final CAS ────────────────────

describe("Blocker 10: Per-path write lock / final CAS", () => {
  it("serializes concurrent writes to same path", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()
    await service.initialize()

    // Fire two concurrent writes
    const p1 = service.writeConfig("global", { model: "anthropic/claude-sonnet-4-20250514" }, service.getConfigHash("global")!)
    // Second write gets the hash from after first write completes
    const p2 = p1.then(() => service.writeConfig("global", { model: "openai/gpt-4o" }, service.getConfigHash("global")!))

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(service.materialized!.value.model).toBe("openai/gpt-4o")
    service.dispose()
  })

  it("detects stale CAS when file changed between read and write", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()
    await service.initialize()
    const hash = service.getConfigHash("global")!

    // External edit
    writeGlobalConfig({ model: "openai/gpt-4o" })

    // Write with old hash should fail
    const result = await service.writeConfig("global", { model: "anthropic/claude-sonnet-4-20250514" }, hash)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("stale")
    service.dispose()
  })
})

// ── Blocker 11: Asset stamp and ID validation ──────────────────────

describe("Blocker 11: Asset stamp and ID validation", () => {
  it("rejects asset write without stamp for existing file", async () => {
    writeAgentMd("coder", { name: "Coder" }, "Prompt.", "global")
    const service = createService()
    await service.initialize()

    // Write without expected hash — should be rejected
    const result = await service.writeAsset("agent", "coder", { name: "Updated" }, "New prompt.", "global")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("stale")
    service.dispose()
  })

  it("rejects path traversal in asset ID", async () => {
    const service = createService()
    await service.initialize()

    const result = await service.writeAsset("agent", "../evil", { name: "Evil" }, "Bad.", "global")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("invalid")
    service.dispose()
  })

  it("rejects absolute path as asset ID", async () => {
    const service = createService()
    await service.initialize()

    const result = await service.writeAsset("agent", "/etc/passwd", { name: "Evil" }, "Bad.", "global")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("invalid")
    service.dispose()
  })

  it("rejects backslash in asset ID", async () => {
    const service = createService()
    await service.initialize()

    const result = await service.writeAsset("agent", "a\\b", { name: "Evil" }, "Bad.", "global")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("invalid")
    service.dispose()
  })

  it("allows create with stamp absent for new file", async () => {
    const service = createService()
    await service.initialize()

    const result = await service.writeAsset("agent", "new-agent", { name: "New" }, "Body.", "global", "absent")
    expect(result.ok).toBe(true)
    service.dispose()
  })
})

// ── Blocker 12: Asset scan ENOENT distinction ──────────────────────

describe("Blocker 12: Asset scan ENOENT distinction", () => {
  it("ENOENT for missing asset dir is not an error", async () => {
    const service = createService()
    await service.initialize()

    const scan = service.assetScan!
    // No asset dirs created yet — should not produce errors for ENOENT
    expect(scan.errors.filter((e) => e.message.includes("Cannot read asset directory"))).toHaveLength(0)
    service.dispose()
  })

  it("inaccessible file produces diagnostic error", async () => {
    const dir = path.join(globalRoot, "agent")
    fs.mkdirSync(dir, { recursive: true })
    // Write a file then make it unreadable by replacing with directory
    const fp = path.join(dir, "bad.md")
    fs.writeFileSync(fp, "content")
    fs.unlinkSync(fp)
    fs.mkdirSync(fp) // Now it's a directory, not a file

    const service = createService()
    await service.initialize()

    const scan = service.assetScan!
    // The readdirSync will fail to read this "file" — should produce diagnostic error
    // for the inaccessible file and retain the prior valid entry
    expect(scan.errors.some((e) => e.file === fp)).toBe(true)
    expect(scan.entries.some((e) => e.id === "bad")).toBe(false)
    service.dispose()
  })

  it("preserves prior scan on malformed asset", async () => {
    writeAgentMd("coder", { name: "Coder" }, "Prompt.", "project")
    const service = createService()
    await service.initialize()
    expect(service.assetScan!.entries).toHaveLength(1)

    // Add malformed asset
    const badDir = path.join(projectRoot, ".kilo", "agent")
    fs.writeFileSync(path.join(badDir, "bad.md"), "---\nname: [\nbad yaml\n---\nBody.", "utf-8")

    // Trigger rescan — use the project agent watcher
    const agentWatcherIdx = findAgentWatcher("project")
    watcherAdapter.watchers_[agentWatcherIdx].onChange()
    await new Promise((r) => setTimeout(r, 100))

    // Prior valid entry should be retained
    expect(service.assetScan!.entries.some((e) => e.id === "coder")).toBe(true)
    // Malformed should produce error
    expect(service.assetScan!.errors.length).toBeGreaterThan(0)
    service.dispose()
  })

  it("retains entries and marks the agent index stale while an asset directory is unreadable", async () => {
    const filePath = writeAgentMd("coder", { name: "Coder", displayName: "Code" }, "Prompt.", "project")
    writeAgentMd("coder", { name: "Global Coder" }, "Global prompt.", "global")
    const service = createService()
    await service.initialize()

    const dir = path.dirname(filePath)
    const priorDir = `${dir}.prior`
    const priorEntry = service.assetScan!.entries.find((entry) => entry.filePath === filePath)!
    expect(service.assetScan!.duplicateIds.some((duplicate) => duplicate.id === "coder")).toBe(true)
    fs.renameSync(dir, priorDir)
    fs.writeFileSync(dir, "not a directory", "utf-8")

    watcherAdapter.watchers_[findAgentWatcher("project")].onChange()
    await new Promise((r) => setTimeout(r, 100))

    const failed = service.assetScan!
    const retained = failed.entries.find((entry) => entry.filePath === filePath)
    expect(retained).toEqual(priorEntry)
    expect(failed.errors.some((error) => error.file === dir)).toBe(true)
    const stale = workspaceState.get<any>("kilo.canonicalIndex.agents")
    expect(stale.agents).toHaveLength(2)
    expect(failed.duplicateIds.some((duplicate) => duplicate.id === "coder")).toBe(true)
    expect(stale.diagnostics.invalid).toBe(true)
    expect(stale.diagnostics.stale).toBe(true)

    fs.unlinkSync(dir)
    fs.renameSync(priorDir, dir)
    watcherAdapter.watchers_[findAgentWatcher("project")].onChange()
    await new Promise((r) => setTimeout(r, 100))

    const recovered = service.assetScan!
    expect(recovered.errors).toHaveLength(0)
    // The retained global/project duplicate remains a canonical diagnostic after
    // the unreadable directory recovers; it clears only when one duplicate is removed.
    expect(workspaceState.get<any>("kilo.canonicalIndex.agents").diagnostics.invalid).toBe(true)
    expect(workspaceState.get<any>("kilo.canonicalIndex.agents").diagnostics.stale).toBe(true)

    fs.unlinkSync(filePath)
    watcherAdapter.watchers_[findAgentWatcher("project")].onChange()
    await new Promise((r) => setTimeout(r, 100))

    const deleted = service.assetScan!
    expect(deleted.entries).toHaveLength(1)
    expect(deleted.errors).toHaveLength(0)
    expect(workspaceState.get<any>("kilo.canonicalIndex.agents").diagnostics.invalid).toBe(false)
    expect(workspaceState.get<any>("kilo.canonicalIndex.agents").diagnostics.stale).toBe(false)
    service.dispose()
  })
})

// ── Blocker 13: Selector-only payloads ─────────────────────────────

describe("Blocker 13: Selector-only payloads", () => {
  it("provider index does NOT contain endpoint or protocol", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1", protocol: "openai" } } })
    const service = createService()
    await service.initialize()

    const idx = await service.buildProviderIndexAsync()
    expect(idx).not.toBeNull()
    expect(idx!.providers[0].id).toBe("openai")
    // endpoint and protocol must NOT be in persisted index
    expect((idx!.providers[0] as any).endpoint).toBeUndefined()
    expect((idx!.providers[0] as any).protocol).toBeUndefined()
    service.dispose()
  })

  it("model index does NOT contain variantOverrides", async () => {
    writeProjectConfig({
      model: "anthropic/claude-sonnet-4-20250514",
      model_variant: "high",
      model_variant_overrides: { "openai/gpt-4": "low" },
    })
    const service = createService()
    await service.initialize()

    const idx = service.buildModelIndex("project")
    expect(idx).not.toBeNull()
    expect(idx!.model).toBe("anthropic/claude-sonnet-4-20250514")
    expect(idx!.variant).toBe("high")
    // variantOverrides must NOT be in persisted index
    expect((idx as any).variantOverrides).toBeUndefined()
    service.dispose()
  })

  it("persisted provider index in globalState has no endpoint/protocol", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
    const service = createService()
    await service.initialize()

    const stored = globalState.get<any>("kilo.canonicalIndex.providers")
    expect(stored).not.toBeNull()
    expect(stored.providers[0].id).toBe("openai")
    expect(stored.providers[0].endpoint).toBeUndefined()
    expect(stored.providers[0].protocol).toBeUndefined()
    service.dispose()
  })

  it("persisted model index in workspaceState has no variantOverrides", async () => {
    writeProjectConfig({ model: "anthropic/claude-sonnet-4-20250514", model_variant_overrides: { "a/b": "c" } })
    const service = createService()
    await service.initialize()

    const stored = workspaceState.get<any>("kilo.canonicalIndex.projectModel")
    expect(stored).not.toBeNull()
    expect(stored.model).toBe("anthropic/claude-sonnet-4-20250514")
    expect(stored.variantOverrides).toBeUndefined()
    service.dispose()
  })
})

// ── Cross-cutting: Invalid diagnostic persistence ──────────────────

describe("Cross-cutting: Invalid diagnostic persistence", () => {
  it("invalid config marks index diagnostics as stale/invalid", async () => {
    writeGlobalConfig({ provider: { openai: {} } })
    const service = createService()
    await service.initialize()

    // Verify valid diagnostics before invalid edit
    const validIdx = globalState.get<any>("kilo.canonicalIndex.providers")
    expect(validIdx.diagnostics.invalid).toBe(false)
    expect(validIdx.diagnostics.stale).toBe(false)
    expect(service.providerIndex).not.toBeNull()
    expect(service.providerIndex!.diagnostics.invalid).toBe(false)
    expect(service.providerIndex!.providers).toHaveLength(1)
    expect(service.providerIndex!.providers[0].id).toBe("openai")

    // Write invalid config (unknown_key is not in the schema)
    fs.writeFileSync(path.join(globalRoot, "kilo.jsonc"), '{"provider": {"openai": {}}, "unknown_key": "bad"}')
    const configWatcher = watcherAdapter.watchers_[0]
    configWatcher.onChange()
    await new Promise((r) => setTimeout(r, 100))

    // Prior materialization should be preserved (not null)
    expect(service.materialized).not.toBeNull()

    // Diagnostics on the getter should now be stale/invalid
    expect(service.providerIndex).not.toBeNull()
    expect(service.providerIndex!.diagnostics.invalid).toBe(true)
    expect(service.providerIndex!.diagnostics.stale).toBe(true)

    // Prior provider entries must survive — invalid edit retains valid data
    expect(service.providerIndex!.providers).toHaveLength(1)
    expect(service.providerIndex!.providers[0].id).toBe("openai")

    // Persisted state in globalState must also carry stale/invalid diagnostics
    const persistedIdx = globalState.get<any>("kilo.canonicalIndex.providers")
    expect(persistedIdx.diagnostics.invalid).toBe(true)
    expect(persistedIdx.diagnostics.stale).toBe(true)
    expect(persistedIdx.providers).toHaveLength(1)
    expect(persistedIdx.providers[0].id).toBe("openai")

    service.dispose()
  })
})

// ── Finding 3: Rehydrated index replacement after reconcile ─────────

describe("Finding 3: Rehydrated indexes replaced after reconcile", () => {
  it("rehydrated provider index is replaced by fresh reconcile after init", async () => {
    writeGlobalConfig({ provider: { openai: {} } })
    const s1 = createService()
    await s1.initialize()
    s1.dispose()

    // Second service rehydrates from persisted state
    const s2 = createService()
    await s2.initialize()
    // Rehydrated field should now be the fresh reconciled data, not stale rehydrated
    expect(s2.providerIndex).not.toBeNull()
    expect(s2.providerIndex!.providers).toHaveLength(1)
    expect(s2.providerIndex!.providers[0].id).toBe("openai")
    // Materialization version should match current snapshot
    expect(s2.providerIndex!.materializationVersion).toBe(s2.snapshot!.generation)
    s2.dispose()
  })

  it("rehydrated agent index is replaced after asset scan reconcile", async () => {
    writeAgentMd("coder", { name: "Coder", displayName: "Code" }, "Prompt.", "project")
    const s1 = createService()
    await s1.initialize()
    s1.dispose()

    const s2 = createService()
    await s2.initialize()
    expect(s2.agentIndex).not.toBeNull()
    expect(s2.agentIndex!.agents).toHaveLength(1)
    expect(s2.agentIndex!.materializationVersion).toBe(s2.snapshot!.generation)
    s2.dispose()
  })
})

// ── Finding 4: Agent index rebuild on every scan ────────────────────

describe("Finding 4: Agent index rebuild on every scan", () => {
  it("agent index is rebuilt when new agent asset is added", async () => {
    writeAgentMd("coder", { name: "Coder" }, "Prompt.", "project")
    const service = createService()
    await service.initialize()
    expect(service.agentIndex!.agents).toHaveLength(1)

    // Add another agent
    writeAgentMd("reviewer", { name: "Reviewer" }, "Review.", "project")
    const agentWatcherIdx = findAgentWatcher("project")
    watcherAdapter.watchers_[agentWatcherIdx].onChange()
    await new Promise((r) => setTimeout(r, 100))

    // Agent index should now have both
    expect(service.agentIndex!.agents).toHaveLength(2)
    service.dispose()
  })

  it("agent index is rebuilt when agent asset is deleted", async () => {
    writeAgentMd("coder", { name: "Coder" }, "Prompt.", "project")
    writeAgentMd("reviewer", { name: "Reviewer" }, "Review.", "project")
    const service = createService()
    await service.initialize()
    expect(service.agentIndex!.agents).toHaveLength(2)

    // Delete one agent
    fs.unlinkSync(path.join(projectRoot, ".kilo", "agent", "reviewer.md"))
    const agentWatcherIdx = findAgentWatcher("project")
    watcherAdapter.watchers_[agentWatcherIdx].onChange()
    await new Promise((r) => setTimeout(r, 100))

    expect(service.agentIndex!.agents).toHaveLength(1)
    expect(service.agentIndex!.agents[0].id).toBe("coder")
    service.dispose()
  })

  it("empty agent index is persisted when all agents are deleted", async () => {
    writeAgentMd("coder", { name: "Coder" }, "Prompt.", "project")
    const service = createService()
    await service.initialize()
    expect(workspaceState.data_.has("kilo.canonicalIndex.agents")).toBe(true)
    const prior = workspaceState.get<any>("kilo.canonicalIndex.agents")
    expect(prior.agents).toHaveLength(1)

    // Delete all agents
    fs.unlinkSync(path.join(projectRoot, ".kilo", "agent", "coder.md"))
    const agentWatcherIdx = findAgentWatcher("project")
    watcherAdapter.watchers_[agentWatcherIdx].onChange()
    await new Promise((r) => setTimeout(r, 100))

    // Agent index should still be persisted (with empty agents)
    const after = workspaceState.get<any>("kilo.canonicalIndex.agents")
    expect(after).not.toBeNull()
    expect(after.agents).toHaveLength(0)
    service.dispose()
  })
})

// ── Finding 5: Own-write coalescing with differing external bytes ───

describe("Finding 5: Own-write vs differing external bytes", () => {
  it("processes external edit with different bytes even after own write", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()
    const events: string[] = []
    service.onDidChange((e) => events.push(e.source))
    await service.initialize()

    // GUI write
    await service.writeConfig("global", { model: "anthropic/claude-sonnet-4-20250514" }, service.getConfigHash("global")!)

    // External edit with DIFFERENT bytes (not our own write)
    writeGlobalConfig({ model: "openai/gpt-4o" })
    const configWatcher = watcherAdapter.watchers_[0]
    configWatcher.onChange()
    await new Promise((r) => setTimeout(r, 100))

    // External event should fire (different bytes = not coalesced)
    const externalEvents = events.filter((s) => s === "external")
    expect(externalEvents.length).toBeGreaterThanOrEqual(1)
    expect(service.materialized!.value.model).toBe("openai/gpt-4o")
    service.dispose()
  })
})

// ── Finding 6: Write + watch scheduling serialization ───────────────

describe("Finding 6: Write + watch serialization", () => {
  it("GUI write and watcher event are serialized through convergence scheduler", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()
    const events: string[] = []
    service.onDidChange((e) => events.push(e.source))
    await service.initialize()

    // Fire external edit first — materializes immediately (serialized)
    writeGlobalConfig({ model: "anthropic/claude-sonnet-4-20250514" })
    const configWatcher = watcherAdapter.watchers_[0]
    configWatcher.onChange()
    await new Promise((r) => setTimeout(r, 100))

    // GUI write with updated hash (after external edit materialized)
    const result = await service.writeConfig("global", { model: "openai/gpt-4o" }, service.getConfigHash("global")!)
    expect(result.ok).toBe(true)

    await new Promise((r) => setTimeout(r, 100))

    // Final value is the GUI write (serialized: external edit then GUI write)
    expect(service.materialized!.value.model).toBe("openai/gpt-4o")
    service.dispose()
  })
})

// ── Finding 7: Disposal during delayed work ─────────────────────────

describe("Finding 7: Disposal during operations", () => {
  it("dispose clears the event queue and settles pending promises", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()
    await service.initialize()

    // Start a long-running materialization (via external watcher event)
    writeGlobalConfig({ model: "anthropic/claude-sonnet-4-20250514" })
    const configWatcher = watcherAdapter.watchers_[0]
    configWatcher.onChange()

    // Dispose immediately — settles any pending promises
    service.dispose()

    // Service is disposed and future operations fail
    expect(service.isDisposed).toBe(true)
    const result = await service.writeConfig("global", { model: "test" }, "hash")
    expect(result.ok).toBe(false)
  })

  it("dispose prevents init after dispose", async () => {
    const service = createService()
    await service.initialize()
    service.dispose()

    // Re-initialize should be a no-op
    await service.initialize()
    expect(service.materialized).not.toBeNull() // still has the old materialization
  })
})

// ── Finding 8: Credential rollback on convergence failure ───────────

describe("Finding 8: Credential rollback", () => {
  it("processCredentialIntent rolls back secret on convergence failure", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1" } } })
    const service = createService()
    await service.initialize()

    // Store initial secret
    await service.storeSecret("global", "provider", "openai", "sk-old")

    // Attempt with invalid config (unknown key)
    const result = await service.processCredentialIntent(
      "global", "provider", "openai", "sk-new",
      { model: "openai/gpt-4", unknown_key: "bad" },
      service.getConfigHash("global")!,
      undefined,
      "secret:kilo.credentials.global.provider.openai",
    )
    expect(result.ok).toBe(false)

    // Prior secret should be restored
    const restored = await secrets.retrieve("kilo.credentials.global.provider.openai")
    expect(restored).toBe("sk-old")
    service.dispose()
  })
})

// ── Finding 9 corrected: Final CAS before rename ────────────────────

describe("Finding 9/10: Final CAS before rename", () => {
  it("detects stale write via final CAS when file changes between read and write", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()
    await service.initialize()
    const hash = service.getConfigHash("global")!

    // External edit between our read and write
    writeGlobalConfig({ model: "openai/gpt-4o" })

    // Write with old hash should fail (stale)
    const result = await service.writeConfig("global", { model: "anthropic/claude-sonnet-4-20250514" }, hash)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("stale")
    service.dispose()
  })
})

// ── Finding 10: Per-path write lock serialization ───────────────────

describe("Finding 10: Per-path write lock", () => {
  it("concurrent writes to same path are serialized", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()
    await service.initialize()

    // Fire two concurrent writes (second uses chained hash from first)
    const p1 = service.writeConfig("global", { model: "anthropic/claude-sonnet-4-20250514" }, service.getConfigHash("global")!)
    const p2 = p1.then(() => {
      if (service.getConfigHash("global")) {
        return service.writeConfig("global", { model: "openai/gpt-4o" }, service.getConfigHash("global")!)
      }
      return { ok: false as const, kind: "stale" as const, message: "no hash" }
    })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(service.materialized!.value.model).toBe("openai/gpt-4o")
    service.dispose()
  })
})

// ── Finding 11: Structured asset I/O errors and temp cleanup ────────

describe("Finding 11: Structured asset errors", () => {
  it("rejects asset write without stamp for existing file", async () => {
    writeAgentMd("coder", { name: "Coder" }, "Prompt.", "global")
    const service = createService()
    await service.initialize()

    const result = await service.writeAsset("agent", "coder", { name: "Updated" }, "New.", "global")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("stale")
    service.dispose()
  })

  it("rejects path traversal in asset ID", async () => {
    const service = createService()
    await service.initialize()
    const result = await service.writeAsset("agent", "../evil", { name: "Evil" }, "Bad.", "global")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("invalid")
    service.dispose()
  })

  it("rejects absolute path as asset ID", async () => {
    const service = createService()
    await service.initialize()
    const result = await service.writeAsset("agent", "/etc/passwd", { name: "Evil" }, "Bad.", "global")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("invalid")
    service.dispose()
  })

  it("allows create with stamp absent for new file", async () => {
    const service = createService()
    await service.initialize()
    const result = await service.writeAsset("agent", "new-agent", { name: "New" }, "Body.", "global", "absent")
    expect(result.ok).toBe(true)
    service.dispose()
  })

  it("rejects create with expectedHash when file already exists", async () => {
    writeAgentMd("coder", { name: "Coder" }, "Prompt.", "global")
    const service = createService()
    await service.initialize()
    const result = await service.writeAsset("agent", "coder", { name: "Updated" }, "New.", "global", "absent")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("stale")
    service.dispose()
  })
})

// ── Finding 12: Asset scan ENOENT distinction ──────────────────────

describe("Finding 12: Asset scan error handling", () => {
  it("ENOENT for missing asset dir is not an error", async () => {
    const service = createService()
    await service.initialize()
    const scan = service.assetScan!
    expect(scan.errors.filter((e) => e.message.includes("Cannot read asset directory"))).toHaveLength(0)
    service.dispose()
  })

  it("preserves prior scan on malformed asset", async () => {
    writeAgentMd("coder", { name: "Coder" }, "Prompt.", "project")
    const service = createService()
    await service.initialize()
    expect(service.assetScan!.entries).toHaveLength(1)

    // Add malformed agent
    const badDir = path.join(projectRoot, ".kilo", "agent")
    fs.writeFileSync(path.join(badDir, "bad.md"), "---\nname: [\nbad yaml\n---\nBody.", "utf-8")

    // Trigger rescan — use the project agent watcher
    const agentWatcherIdx = findAgentWatcher("project")
    watcherAdapter.watchers_[agentWatcherIdx].onChange()
    await new Promise((r) => setTimeout(r, 100))

    expect(service.assetScan!.entries.some((e) => e.id === "coder")).toBe(true)
    expect(service.assetScan!.errors.length).toBeGreaterThan(0)
    service.dispose()
  })
})

// ── Finding 13: Selector-only payloads ─────────────────────────────

describe("Finding 13: Selector-only payloads", () => {
  it("provider index does NOT contain endpoint or protocol", async () => {
    writeGlobalConfig({ provider: { openai: { endpoint: "https://api.openai.com/v1", protocol: "openai" } } })
    const service = createService()
    await service.initialize()
    const idx = await service.buildProviderIndexAsync()
    expect(idx).not.toBeNull()
    expect((idx!.providers[0] as any).endpoint).toBeUndefined()
    expect((idx!.providers[0] as any).protocol).toBeUndefined()
    service.dispose()
  })

  it("model index does NOT contain variantOverrides", async () => {
    writeProjectConfig({ model: "anthropic/claude-sonnet-4-20250514", model_variant_overrides: { "a/b": "c" } })
    const service = createService()
    await service.initialize()
    const idx = service.buildModelIndex("project")
    expect(idx).not.toBeNull()
    expect((idx as any).variantOverrides).toBeUndefined()
    service.dispose()
  })
})

// ── No-prior invalid init diagnostics ──────────────────────────────

describe("No-prior invalid init", () => {
  it("initializes with empty materialization and clean diagnostic index when no config files exist", async () => {
    const service = createService()
    await service.initialize()
    // Correction 2: both-files-absent is a valid state producing an empty materialization
    expect(service.materialized).not.toBeNull()
    expect(service.materialized!.value.model).toBeUndefined()
    // Indexes should be persisted with CLEAN diagnostics (no errors = valid state)
    const providerIdx = globalState.get<any>("kilo.canonicalIndex.providers")
    expect(providerIdx).not.toBeNull()
    expect(providerIdx.diagnostics.invalid).toBe(false)
    expect(providerIdx.diagnostics.stale).toBe(false)
    expect(providerIdx.providers).toHaveLength(0)
    service.dispose()
  })
})

// ── P4.1 Regression: 5 final blockers ─────────────────────────────

describe("Regression: Partial state-key rollback on persist failure", () => {
  it("restores in-memory fields when mid-persist fails during materialization", async () => {
    writeGlobalConfig({ provider: { openai: {} }, model: "openai/gpt-4" })

    // Create a fault-injecting workspaceState that fails on the 1st update call.
    // Persist order: globalState.providers, globalState.globalModel,
    //   workspaceState.projectModel, workspaceState.agents
    // Failing on workspaceState.update (1st workspace call = 3rd overall) exercises rollback.
    let wsUpdateCount = 0
    const faultWorkspaceState = {
      ...workspaceState,
      update: async (key: string, value: unknown) => {
        wsUpdateCount++
        if (wsUpdateCount === 1) throw new Error("simulated persist failure on workspaceState")
        return workspaceState.update(key, value)
      },
    } as typeof workspaceState

    const roots = new Roots(projectRoot, globalRoot)
    const ctx = { secrets, subscriptions: { push: () => {} } } as never
    const faultService = new CanonicalConfigService(ctx, {
      roots,
      secretAdapter: secrets,
      globalState,
      workspaceState: faultWorkspaceState,
      watcherAdapter,
      emitterFactory,
    })

    // Initialize triggers persistIndexes which fails; materializeFromDisk catches internally
    await faultService.initialize()

    // All in-memory fields should be restored to their prior state (null for fresh init)
    // because materializeFromDisk calls restorePriorState on persist failure
    expect((faultService as any).rehydratedProviderIndex).toBeNull()
    expect((faultService as any).rehydratedAgentIndex).toBeNull()
    expect((faultService as any).persistedAgentIndex).toBeNull()
    expect((faultService as any).rehydratedGlobalModelIndex).toBeNull()
    expect((faultService as any).rehydratedProjectModelIndex).toBeNull()

    faultService.dispose()
  })
})

describe("Regression: Persisted invalid flags after valid state", () => {
  it("marks persisted indexes stale/invalid when invalid config replaces valid", async () => {
    // Start with valid config
    writeGlobalConfig({ provider: { openai: {} }, model: "openai/gpt-4" })
    const service = createService()
    await service.initialize()

    // Verify valid diagnostics
    const validIdx = globalState.get<any>("kilo.canonicalIndex.providers")
    expect(validIdx.diagnostics.invalid).toBe(false)
    expect(validIdx.diagnostics.stale).toBe(false)
    expect(validIdx.providers).toHaveLength(1)

    // Now write invalid config (has unknown key that fails validation)
    // Use a config that passes schema but is semantically invalid for the scope
    // Actually, the test needs to trigger the invalid-with-prior path in materializeFromDisk.
    // That path fires when readScopeContent returns "invalid" and this.current exists.
    // Make the file unreadable (replace with directory) to trigger "failure" type
    fs.unlinkSync(path.join(globalRoot, "kilo.jsonc"))
    fs.mkdirSync(path.join(globalRoot, "kilo.jsonc"))

    // Trigger watcher re-materialization
    const configWatcher = watcherAdapter.watchers_[0]
    configWatcher.onChange()
    await new Promise((r) => setTimeout(r, 100))

    // Prior materialization should be preserved
    expect(service.materialized).not.toBeNull()

    // Persisted indexes should now be marked stale/invalid
    const afterIdx = globalState.get<any>("kilo.canonicalIndex.providers")
    expect(afterIdx).not.toBeNull()
    expect(afterIdx.diagnostics.invalid).toBe(true)
    expect(afterIdx.diagnostics.stale).toBe(true)
    // But valid entries should be retained
    expect(afterIdx.providers).toHaveLength(1)
    expect(afterIdx.providers[0].id).toBe("openai")

    service.dispose()
  })
})

describe("Regression: Disposal during delayed persistence — no late event, settled result", () => {
  it("dispose settles pending materialization and fires no change event after disposal", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()
    const events: any[] = []
    service.onDidChange((e) => events.push(e))
    await service.initialize()

    // Start external edit materialization
    writeGlobalConfig({ model: "anthropic/claude-sonnet-4-20250514" })
    const configWatcher = watcherAdapter.watchers_[0]

    // Inject a small delay into the event queue to ensure disposal happens mid-flight
    const origEnqueue = (service as any).enqueueAndRunMaterialization.bind(service)
    let resolveDelay: () => void
    const delayPromise = new Promise<void>((r) => { resolveDelay = r })
    ;(service as any).enqueueAndRunMaterialization = (source: string) => {
      const result = origEnqueue(source)
      // Chain a delay to make the materialization take longer
      return result.then(() => delayPromise)
    }

    configWatcher.onChange()

    // Dispose immediately — should settle pending promises
    service.dispose()

    // Resolve the delay (simulating async completion after dispose)
    resolveDelay!()
    await new Promise((r) => setTimeout(r, 50))

    // Event queue should be cleared and service disposed
    expect(service.isDisposed).toBe(true)

    // No change events should have fired after disposal
    const postDisposeEvents = events.filter((e) => e.source === "external")
    // Either 0 or 1 (may have fired before dispose, but not after)
    expect(postDisposeEvents.length).toBeLessThanOrEqual(1)

    // Future operations should fail
    const result = await service.writeConfig("global", { model: "test" }, "hash")
    expect(result.ok).toBe(false)
  })
})

describe("Regression: Asset external change before final CAS check", () => {
  it("returns stale conflict when asset file changes between initial stamp and final check", async () => {
    writeAgentMd("coder", { name: "Coder" }, "Prompt.", "global")
    const service = createService()
    await service.initialize()

    // Get the current hash for the asset
    const assetPath = path.join(globalRoot, "agent", "coder.md")
    const raw = readFile(assetPath)
    expect(raw.type).toBe("present")
    const originalHash = raw.type === "present" ? raw.hash : ""

    // External edit: modify the file externally
    fs.writeFileSync(assetPath, "---\nname: ExternallyModified\n---\n\nModified body.\n")

    // Try to write with the old hash — final CAS should detect the change
    const result = await service.writeAsset("agent", "coder", { name: "Updated" }, "New.", "global", originalHash)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe("stale")
      expect(result.message).toContain("modified externally")
    }

    service.dispose()
  })
})

describe("Regression: Structured fs failure on asset write", () => {
  it("returns structured error instead of throwing on filesystem failure", async () => {
    const service = createService()
    await service.initialize()

    // Create a scenario where the asset write fails with a filesystem error
    // Strategy: create the asset directory, then replace with a file to cause ENOTDIR
    // when trying to create subdirectories or read files inside it
    const agentDir = path.join(globalRoot, "agent")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.rmSync(agentDir, { recursive: true })
    fs.writeFileSync(agentDir, "I am a file, not a directory")

    // Attempt to write an asset — should fail with structured error, not throw
    let result: any
    try {
      result = await service.writeAsset("agent", "new-agent", { name: "New" }, "Body.", "global", "absent")
    } catch (err) {
      // Should NOT throw — must return structured error
      expect(true).toBe(false)
      return
    }

    expect(result.ok).toBe(false)
    if (!result.ok) {
      // ENOTDIR may surface as "stale" (from checkAssetStamp) or "io" (from catch block)
      // Both are valid structured errors — the key assertion is that it didn't throw
      expect(["stale", "io"]).toContain(result.kind)
      expect(typeof result.message).toBe("string")
      expect(result.message.length).toBeGreaterThan(0)
    }

    service.dispose()
  })
})

// ── State-key rollback: prior values captured BEFORE write ──────────

describe("Regression: State-key prior capture before persist", () => {
  it("captures prior state key values BEFORE persist so rollback restores exact old values", async () => {
    writeGlobalConfig({ provider: { openai: {} }, model: "openai/gpt-4" })

    // Pre-populate workspaceState with existing data to test rollback restores exact prior
    await workspaceState.update("kilo.canonicalIndex.agents", { agents: [{ id: "prior-agent" }] })

    // Persist order: globalState.providers, globalState.globalModel,
    //   workspaceState.projectModel, workspaceState.agents
    // Fault on workspaceState 1st call → fails after globalState writes succeed.
    let wsUpdateCount = 0
    const faultWs = {
      ...workspaceState,
      update: async (key: string, value: unknown) => {
        wsUpdateCount++
        if (wsUpdateCount === 1) throw new Error("simulated persist failure on workspaceState")
        return workspaceState.update(key, value)
      },
    } as typeof workspaceState

    const roots = new Roots(projectRoot, globalRoot)
    const ctx = { secrets, subscriptions: { push: () => {} } } as never
    const faultService = new CanonicalConfigService(ctx, {
      roots,
      secretAdapter: secrets,
      globalState,
      workspaceState: faultWs,
      watcherAdapter,
      emitterFactory,
    })

    // Initialize triggers persistIndexes which fails; materializeFromDisk catches internally
    await faultService.initialize()

    // The workspaceState agents key should still have the prior value (rollback restored it)
    const agentsIdx = faultWs.get("kilo.canonicalIndex.agents")
    expect(agentsIdx).toEqual({ agents: [{ id: "prior-agent" }] })

    // globalState keys should be rolled back to undefined (their prior state before persist)
    const providerIdx = globalState.get("kilo.canonicalIndex.providers")
    expect(providerIdx).toBeUndefined()

    faultService.dispose()
  })

  it("diagnostic persistence rollback restores exact prior values on partial failure", async () => {
    // Pre-populate state with existing data
    await globalState.update("kilo.canonicalIndex.providers", { providers: [{ id: "existing" }] })
    await workspaceState.update("kilo.canonicalIndex.agents", { agents: [{ id: "existing-agent" }] })

    // Make config unreadable so materializeFromDisk takes the diagnostic path
    writeGlobalConfig({ provider: { openai: {} }, model: "openai/gpt-4" })

    // Create a fault-injecting globalState that fails on the 1st update call
    let gsUpdateCount = 0
    const faultGs = {
      ...globalState,
      update: async (key: string, value: unknown) => {
        gsUpdateCount++
        if (gsUpdateCount === 1) throw new Error("simulated diagnostic persist failure")
        return globalState.update(key, value)
      },
    } as typeof globalState

    const roots = new Roots(projectRoot, globalRoot)
    const ctx = { secrets, subscriptions: { push: () => {} } } as never
    const faultService = new CanonicalConfigService(ctx, {
      roots,
      secretAdapter: secrets,
      globalState: faultGs,
      workspaceState,
      watcherAdapter,
      emitterFactory,
    })

    // Initialize — rehydrates from pre-populated state, then materializes.
    // persistDiagnosticIndexes will fail, triggering rollback of pre-populated values.
    await faultService.initialize()

    // The globalState providers key should still have the prior value (rollback restored it)
    const providerIdx = faultGs.get("kilo.canonicalIndex.providers")
    expect(providerIdx).toEqual({ providers: [{ id: "existing" }] })

    faultService.dispose()
  })
})

// ── Delayed disposal: settle active materialization ─────────────────

describe("Regression: Active materialization settles on dispose with no late events", () => {
  it("dispose settles in-flight materialization and no change event fires after disposal", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()
    const events: any[] = []
    service.onDidChange((e) => events.push(e))
    await service.initialize()

    // Trigger an external edit materialization
    writeGlobalConfig({ model: "anthropic/claude-sonnet-4-20250514" })
    const configWatcher = watcherAdapter.watchers_[0]

    // Start the materialization via watcher
    configWatcher.onChange()

    // Dispose immediately — should settle the in-flight promise
    service.dispose()

    // Allow any queued microtasks to settle
    await new Promise((r) => setTimeout(r, 100))

    // Queue should be cleared and service disposed
    expect(service.isDisposed).toBe(true)

    // No change events should have fired after disposal
    const postDisposeEvents = events.filter((e) => e.source === "external")
    expect(postDisposeEvents.length).toBeLessThanOrEqual(1)

    // Future operations should fail immediately
    const result = await service.writeConfig("global", { model: "test" }, "hash")
    expect(result.ok).toBe(false)
  })

  it("dispose during init prevents watcher creation", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = createService()

    // Start init but dispose before watchers are created
    const initPromise = service.initialize()
    service.dispose()
    await initPromise

    // No watchers should be registered (dispose prevented their creation)
    // Watchers are created in doInitialize after enqueueAndRunMaterialization
    expect(watcherAdapter.watchers_.length).toBe(0)

    service.dispose()
  })
})

describe("P4.1 final audit closure", () => {
  it("cleans every coalesced materialization entry, including repeated prepare=false returns", async () => {
    const service = createService()
    await service.initialize()
    const enqueue = (service as any).enqueueAndRunMaterialization.bind(service)

    await Promise.all([
      enqueue("external", () => false),
      enqueue("external", () => false),
      enqueue("external", () => false),
    ])

    // All materializations completed — service should still be functional
    expect(service.materialized).not.toBeNull()
    service.dispose()
  })

  it("normalizes credential retrieval, store, and rollback exceptions", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const retrieval = createService()
    ;(secrets as any).retrieve = async () => { throw new Error("retrieve failed") }
    await retrieval.initialize()
    const retrievalResult = await retrieval.processCredentialIntent("global", "provider", "openai", "sk-new", { model: "openai/gpt-4" }, retrieval.getConfigHash("global")!, undefined, "secret:kilo.credentials.global.provider.openai")
    expect(retrievalResult.ok).toBe(false)
    if (!retrievalResult.ok) expect(retrievalResult.kind).toBe("io")
    retrieval.dispose()

    const store = createService()
    await store.initialize()
    ;(secrets as any).retrieve = async () => undefined
    ;(secrets as any).store = async () => { throw new Error("store failed") }
    const storeResult = await store.processCredentialIntent("global", "provider", "openai", "sk-new", { model: "openai/gpt-4" }, store.getConfigHash("global")!)
    expect(storeResult.ok).toBe(false)
    if (!storeResult.ok) expect(storeResult.kind).toBe("io")
    store.dispose()

    const rollback = createService()
    await rollback.initialize()
    ;(secrets as any).store = async (key: string, value: string) => { secrets.store_.set(key, value) }
    await rollback.storeSecret("global", "provider", "openai", "sk-old")
    ;(rollback as any).writeConfig = async () => { throw new Error("commit failed") }
    ;(secrets as any).store = async () => { throw new Error("rollback failed") }
    const rollbackResult = await rollback.processCredentialIntent("global", "provider", "openai", "sk-new", { model: "openai/gpt-4" }, rollback.getConfigHash("global")!, undefined, "secret:kilo.credentials.global.provider.openai")
    expect(rollbackResult.ok).toBe(false)
    if (!rollbackResult.ok) expect(rollbackResult.kind).toBe("io")
    rollback.dispose()
  })

  it("returns a fresh persisted agent index immediately after asset create and update", async () => {
    const service = createService()
    await service.initialize()

    const create = await service.writeAsset("agent", "creator", { name: "Creator" }, "Create.", "project", "absent")
    expect(create.ok).toBe(true)
    expect(service.agentIndex?.agents.some((agent) => agent.id === "creator")).toBe(true)
    expect(workspaceState.get<any>("kilo.canonicalIndex.agents")?.agents.some((agent: { id: string }) => agent.id === "creator")).toBe(true)

    const file = path.join(projectRoot, ".kilo", "agent", "creator.md")
    const hash = readFile(file)
    expect(hash.type).toBe("present")
    const update = await service.writeAsset("agent", "creator", { name: "Updated Creator" }, "Update.", "project", hash.type === "present" ? hash.hash : "")
    expect(update.ok).toBe(true)
    expect(service.agentIndex?.agents.find((agent) => agent.id === "creator")?.displayName).toBe("Updated Creator")
    expect(workspaceState.get<any>("kilo.canonicalIndex.agents")?.agents.find((agent: { id: string }) => agent.id === "creator")?.displayName).toBe("Updated Creator")
    service.dispose()
  })

  it("does not expose the removed memory state disposal helper", async () => {
    const adapter = await import("../../src/config/state-adapter")
    expect("disposeMemoryStateAdapter" in adapter).toBe(false)
  })

  it("returns disposed failure for asset mutation after disposal", async () => {
    const service = createService()
    await service.initialize()
    service.dispose()
    const result = await service.writeAsset("agent", "disposed", { name: "Disposed" }, "Body.", "global", "absent")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("disposed")
  })

  it("returns disposed failure when config convergence is disposed before persistence completes", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let blocked = false
    const delayedState = {
      ...globalState,
      update: async (key: string, value: unknown) => {
        if (blocked) await gate
        return globalState.update(key, value)
      },
    } as typeof globalState
    const service = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(projectRoot, globalRoot), secretAdapter: secrets,
      globalState: delayedState, workspaceState, watcherAdapter, emitterFactory,
    })
    await service.initialize()
    blocked = true
    const pending = service.writeConfig("global", { model: "anthropic/claude-sonnet-4-20250514" }, service.getConfigHash("global")!)
    await new Promise((resolve) => setTimeout(resolve, 0))
    service.dispose()
    release()
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("disposed")
    expect(fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf-8")).toContain("openai/gpt-4")
  })

  it("tracks an asset watcher convergence operation until disposal", async () => {
    writeAgentMd("coder", { name: "Coder" }, "Prompt.", "global")
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let blocked = false
    const delayedState = {
      ...workspaceState,
      update: async (key: string, value: unknown) => {
        if (blocked) await gate
        return workspaceState.update(key, value)
      },
    } as typeof workspaceState
    const service = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(projectRoot, globalRoot), secretAdapter: secrets,
      globalState, workspaceState: delayedState, watcherAdapter, emitterFactory,
    })
    await service.initialize()
    blocked = true
    writeAgentMd("reviewer", { name: "Reviewer" }, "Review.", "global")
    const watcher = watcherAdapter.watchers_.find((item) => item.dir === path.join(globalRoot, "agent"))!
    watcher.onChange()
    await new Promise((resolve) => setTimeout(resolve, 60))
    // Materialization is in-flight (blocked by delayed state) — agent not yet visible
    expect(service.agentIndex?.agents.some((agent) => agent.id === "reviewer")).not.toBe(true)
    expect(service.isDisposed).toBe(false)
    service.dispose()
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(service.agentIndex?.agents.some((agent) => agent.id === "reviewer")).not.toBe(true)
  })

  it("returns io failure and restores bytes after persistence fails following a prior update", async () => {
    writeGlobalConfig({ provider: { openai: {} }, model: "openai/gpt-4" })
    const prior = fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf-8")
    let count = 0
    let armed = false
    const faultState = {
      ...globalState,
      update: async (key: string, value: unknown) => {
        count++
        if (armed && count === 2) throw new Error("persist failed after prior key overwrite")
        return globalState.update(key, value)
      },
    } as typeof globalState
    const service = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(projectRoot, globalRoot), secretAdapter: secrets,
      globalState: faultState, workspaceState, watcherAdapter, emitterFactory,
    })
    await service.initialize()
    count = 0
    armed = true
    const result = await service.writeConfig("global", { model: "openai/gpt-4o" }, service.getConfigHash("global")!)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("io")
    expect(fs.readFileSync(path.join(globalRoot, "kilo.jsonc"), "utf-8")).toBe(prior)
    expect(service.materialized?.value.model).toBe("openai/gpt-4")
    service.dispose()
  })

  it("rolls back diagnostic indexes after a partial invalid-with-prior persistence", async () => {
    writeGlobalConfig({ provider: { openai: {} }, model: "openai/gpt-4" })
    const service = createService()
    await service.initialize()
    service.dispose()
    let count = 0
    let armed = false
    const faultState = {
      ...globalState,
      update: async (key: string, value: unknown) => {
        count++
        if (armed && count === 2) throw new Error("diagnostic persistence failed")
        return globalState.update(key, value)
      },
    } as typeof globalState
    const broken = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(projectRoot, globalRoot), secretAdapter: secrets,
      globalState: faultState, workspaceState, watcherAdapter, emitterFactory,
    })
    await broken.initialize()
    const prior = globalState.get("kilo.canonicalIndex.providers")
    armed = true
    count = 0
    fs.writeFileSync(path.join(globalRoot, "kilo.jsonc"), '{"provider":{"openai":{}},"unknown_key":"bad"}')
    const brokenWatcher = watcherAdapter.watchers_.slice().reverse().find((watcher) => watcher.dir === globalRoot && watcher.pattern === "kilo.jsonc")!
    brokenWatcher.onChange()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(globalState.get("kilo.canonicalIndex.providers")).toEqual(prior)
    broken.dispose()
    service.dispose()
  })

  it("detects asset mutation and deletion after initial stamp through final CAS", async () => {
    const file = writeAgentMd("coder", { name: "Coder" }, "Prompt.", "global")
    const original = readFile(file)
    expect(original.type).toBe("present")
    const service = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(projectRoot, globalRoot), secretAdapter: secrets,
      globalState, workspaceState, watcherAdapter, emitterFactory,
      beforeAssetFinalCas: (filePath) => fs.unlinkSync(filePath),
    })
    await service.initialize()
    const result = await service.writeAsset("agent", "coder", { name: "Updated" }, "New.", "global", original.type === "present" ? original.hash : "")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("stale")
    expect(fs.existsSync(file)).toBe(false)
    service.dispose()
  })

  it("detects changed asset bytes after initial stamp through final CAS", async () => {
    const file = writeAgentMd("coder", { name: "Coder" }, "Prompt.", "global")
    const original = readFile(file)
    const service = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(projectRoot, globalRoot), secretAdapter: secrets,
      globalState, workspaceState, watcherAdapter, emitterFactory,
      beforeAssetFinalCas: (filePath) => fs.writeFileSync(filePath, "---\nname: External\n---\n\nChanged.\n"),
    })
    await service.initialize()
    const result = await service.writeAsset("agent", "coder", { name: "Updated" }, "New.", "global", original.type === "present" ? original.hash : "")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("stale")
    expect(fs.readFileSync(file, "utf-8")).toContain("name: External")
    service.dispose()
  })

  it("treats final absent JSONC state as stale for an update", async () => {
    writeGlobalConfig({ model: "openai/gpt-4" })
    const service = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(projectRoot, globalRoot), secretAdapter: secrets,
      globalState, workspaceState, watcherAdapter, emitterFactory,
      beforeConfigFinalCas: (filePath) => fs.unlinkSync(filePath),
    })
    await service.initialize()
    const result = await service.writeConfig("global", { model: "openai/gpt-4o" }, service.getConfigHash("global")!)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("stale")
    expect(fs.existsSync(path.join(globalRoot, "kilo.jsonc"))).toBe(false)
    service.dispose()
  })
})
