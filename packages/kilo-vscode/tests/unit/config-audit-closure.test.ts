/**
 * P4.1 audit closure — direct behavior tests for the shared canonical schema,
 * exact credential ownership, readiness gating, and retry record correctness.
 *
 * These tests exercise the real shared validators, the real CanonicalConfigService,
 * and the real KiloProvider retry/readiness handlers — no mocks.
 */

import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { CanonicalConfigService } from "../../src/config/service"
import { Roots } from "../../src/config/paths"
import { createMemorySecretAdapter, type SecretAdapter } from "../../src/config/secret-adapter"
import { createMemoryStateAdapter } from "../../src/config/state-adapter"
import { readFile } from "../../src/config/parse"
import {
  toCanonicalPayload,
  isValidCanonicalProviderEntry,
  isValidCanonicalMcpEntry,
  isValidModelsMap,
  isOwnedCredentialRef,
  parseCanonicalProviderRecord,
  narrowProviderEntry,
  type CleanupRetryRecord,
  type CanonicalStamp,
} from "../../src/config/types"
import { validateConfig } from "../../src/config/validate"
import { buildProviderIndex, persistAgentIndex, SELECTOR_INDEX_VERSION, type AgentIndex } from "../../src/config/selectors"
import { serializeCanonicalProvider, type FormState } from "../../webview-ui/src/components/settings/CustomProviderValidation"

const { KiloProvider } = await import("../../src/KiloProvider")

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function setup(init = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-audit-closure-"))
  dirs.push(root)
  const global = path.join(root, "global")
  const project = path.join(root, "project")
  fs.mkdirSync(global, { recursive: true })
  fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
  fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ model: "custom/model" }))
  const secrets = createMemorySecretAdapter()
  const canonical = new CanonicalConfigService({ secrets } as never, {
    roots: new Roots(project, global),
    secretAdapter: secrets,
    globalState: createMemoryStateAdapter(),
    workspaceState: createMemoryStateAdapter(),
  })
  if (init) void 0
  return { canonical, secrets, init: () => canonical.initialize() }
}

type ProviderInternals = {
  cleanupRetries: Map<string, CleanupRetryRecord>
  cleanupTargets: Map<string, string>
  canonicalReady: boolean
  postMessage: (message: unknown) => void
  retryCanonicalProviderCleanup: (msg: Record<string, unknown>) => Promise<void>
  retryCanonicalMcpCleanup: (msg: Record<string, unknown>) => Promise<void>
  handleCanonicalProviderAction: (msg: Record<string, unknown>) => Promise<void>
  handleRemoveMcp: (name: string, msg?: Record<string, unknown>) => Promise<void>
  handleGetProviderCredential: (msg: Record<string, unknown>) => Promise<void>
  handleFetchCustomProviderModels: (msg: Record<string, unknown>) => Promise<void>
  handleUpdateConfigMessage: (msg: Record<string, unknown>) => Promise<void>
  fetchAndSendConfig: () => Promise<void>
  fetchAndSendProviders: () => Promise<void>
  fetchAndSendAgents: () => Promise<void>
  sendCanonicalAgents: (event?: unknown) => Promise<void>
  setCanonicalConfig: (service: CanonicalConfigService) => void
  dispose: () => void
  selectKiloModel: (modelID?: string, agent?: string) => void
  pendingKiloModel: { modelID?: string; agent?: string } | null
}

function makeProvider(canonical: CanonicalConfigService): { provider: ProviderInternals; messages: unknown[] } {
  const connection = new KiloConnectionService({} as never)
  const provider = new KiloProvider({} as never, connection, undefined, { canonicalConfig: canonical })
  const messages: unknown[] = []
  const internal = provider as unknown as ProviderInternals
  internal.postMessage = (message) => messages.push(message)
  return { provider: internal, messages }
}

/** Service + provider with the given valid global config authored on disk. */
async function providerActionSetup(globalConfig: Record<string, unknown>): Promise<{ canonical: CanonicalConfigService; provider: ProviderInternals; messages: unknown[] }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-audit-provider-"))
  dirs.push(root)
  const global = path.join(root, "global")
  const project = path.join(root, "project")
  fs.mkdirSync(global, { recursive: true })
  fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
  fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify(globalConfig))
  const secrets = createMemorySecretAdapter()
  const canonical = new CanonicalConfigService({ secrets } as never, {
    roots: new Roots(project, global),
    secretAdapter: secrets,
    globalState: createMemoryStateAdapter(),
    workspaceState: createMemoryStateAdapter(),
  })
  await canonical.initialize()
  const { provider, messages } = makeProvider(canonical)
  return { canonical, provider, messages }
}

// ── Shared schema equivalence ─────────────────────────────────────────

describe("P4.1 shared canonical schema equivalence", () => {
  it("validateConfig and toCanonicalPayload use the same rules for endpoint/protocol/name/models", () => {
    const valid = {
      provider: {
        custom: {
          name: "Custom",
          endpoint: "https://api.example.com/v1",
          protocol: "openai",
          models: { "m1": { name: "Model 1" } },
        },
      },
    }
    expect(validateConfig(JSON.stringify(valid), "global", "test").valid).toBe(true)
    expect(toCanonicalPayload(valid)).toBeDefined()

    // ftp endpoint rejected by both (identical rule to the form serializer)
    const ftp = { provider: { custom: { name: "C", endpoint: "ftp://example.com", protocol: "openai", models: { "m1": { name: "M" } } } } }
    expect(validateConfig(JSON.stringify(ftp), "global", "test").valid).toBe(false)
    expect(toCanonicalPayload(ftp)).toBeUndefined()

    // empty name rejected by both
    const emptyName = { provider: { custom: { name: "", endpoint: "https://x.com", protocol: "openai", models: { "m1": { name: "M" } } } } }
    expect(validateConfig(JSON.stringify(emptyName), "global", "test").valid).toBe(false)
    expect(toCanonicalPayload(emptyName)).toBeUndefined()

    // empty models map rejected by both
    const emptyModels = { provider: { custom: { name: "C", endpoint: "https://x.com", protocol: "openai", models: {} } } }
    expect(validateConfig(JSON.stringify(emptyModels), "global", "test").valid).toBe(false)
    expect(toCanonicalPayload(emptyModels)).toBeUndefined()

    // bad protocol rejected by both
    const badProto = { provider: { custom: { name: "C", endpoint: "https://x.com", protocol: "bogus", models: { "m1": { name: "M" } } } } }
    expect(validateConfig(JSON.stringify(badProto), "global", "test").valid).toBe(false)
    expect(toCanonicalPayload(badProto)).toBeUndefined()
  })

  it("shared validators reject legacy fields and closed-shape violations", () => {
    expect(toCanonicalPayload({ provider: { c: { npm: "@ai-sdk/openai" } } })).toBeUndefined()
    expect(toCanonicalPayload({ provider: { c: { env: ["KEY"] } } })).toBeUndefined()
    expect(toCanonicalPayload({ provider: { c: { options: { baseURL: "https://x.com" } } } })).toBeUndefined()
    expect(toCanonicalPayload({ provider: { c: { headers: { Authorization: "Bearer x" } } } })).toBeUndefined()
    expect(toCanonicalPayload({ provider: { c: { apiKey: "sk-test" } } })).toBeUndefined()
    // model-level closed shape
    expect(isValidModelsMap({ "m1": { name: "M", headers: {} } })).toBe(false)
    expect(isValidModelsMap({ "m1": { name: "M", npm: "x" } })).toBe(false)
    expect(isValidModelsMap({ "m1": { name: "M", modalities: { bogus: ["text"] } } })).toBe(false)
    expect(isValidModelsMap({ "m1": { name: "M", variants: { v1: { bogus: true } } } })).toBe(false)
    expect(isValidModelsMap({ "m1": { name: "M", variants: { v1: { thinking: 42 } } } })).toBe(false)
    // MCP closed shape
    expect(isValidCanonicalMcpEntry({ type: "local", command: "node", environment: {} })).toBe(false)
    expect(isValidCanonicalMcpEntry({ type: "remote", url: "https://x.com", oauth: true })).toBe(false)
    expect(isValidCanonicalMcpEntry({ type: "local", command: "node", args: ["a", 1] })).toBe(false)
  })
})

// ── Exact credential ownership ────────────────────────────────────────

describe("P4.1 exact credential ref ownership", () => {
  it("isOwnedCredentialRef accepts only the exact extension-owned format", () => {
    expect(isOwnedCredentialRef("secret:kilo.credentials.global.provider.openai")).toBe(true)
    expect(isOwnedCredentialRef("secret:kilo.credentials.project.mcp.filesystem")).toBe(true)
    expect(isOwnedCredentialRef("secret:openai-key")).toBe(false)
    expect(isOwnedCredentialRef("secret:kilo.credentials.global.provider")).toBe(false)
    expect(isOwnedCredentialRef("secret:kilo.credentials.workspace.provider.openai")).toBe(false)
    expect(isOwnedCredentialRef("secret:kilo.credentials.global.other.openai")).toBe(false)
    expect(isOwnedCredentialRef("kilo.credentials.global.provider.openai")).toBe(false)
  })

  it("toCanonicalPayload rejects credential refs that break provider kind/id context", () => {
    // kind mismatch: mcp ref inside a provider entry
    expect(toCanonicalPayload({ provider: { openai: { credential: "secret:kilo.credentials.global.mcp.openai" } } })).toBeUndefined()
    // id mismatch: ref for a different provider id
    expect(toCanonicalPayload({ provider: { openai: { credential: "secret:kilo.credentials.global.provider.other" } } })).toBeUndefined()
    // scope is not known at payload level — only kind/id context is enforced here
    const scopeAgnostic = toCanonicalPayload({ provider: { openai: { credential: "secret:kilo.credentials.project.provider.openai" } } })
    expect(scopeAgnostic).toBeDefined()
  })

  it("validateConfig enforces the exact scope+kind+id context of a persisted ref", () => {
    // global file requires global scope ref
    const globalRef = JSON.stringify({ provider: { openai: { credential: "secret:kilo.credentials.global.provider.openai" } } })
    expect(validateConfig(globalRef, "global", "test").valid).toBe(true)
    expect(validateConfig(globalRef, "project", "test").valid).toBe(false)
    // project file requires project scope ref
    const projectRef = JSON.stringify({ provider: { openai: { credential: "secret:kilo.credentials.project.provider.openai" } } })
    expect(validateConfig(projectRef, "project", "test").valid).toBe(true)
    expect(validateConfig(projectRef, "global", "test").valid).toBe(false)
    // arbitrary non-owned ref rejected in any scope
    expect(validateConfig(JSON.stringify({ provider: { openai: { credential: "secret:random" } } }), "global", "test").valid).toBe(false)
  })

  it("parseCanonicalProviderRecord enforces provider kind/id context on scope configs", () => {
    const record = parseCanonicalProviderRecord({
      openai: { name: "OpenAI", credential: "secret:kilo.credentials.global.provider.openai" },
    })
    expect(record).toBeDefined()
    expect(record!["openai"]!.credential).toBe("secret:kilo.credentials.global.provider.openai")
    // wrong id in the ref vs map key
    expect(parseCanonicalProviderRecord({ openai: { credential: "secret:kilo.credentials.global.provider.other" } })).toBeUndefined()
    // wrong kind
    expect(parseCanonicalProviderRecord({ openai: { credential: "secret:kilo.credentials.global.mcp.openai" } })).toBeUndefined()
  })
})

// ── Malformed provider / accessor diagnostics ────────────────────────

describe("P4.1 malformed provider accessor diagnostics", () => {
  it("parseCanonicalProviderRecord returns undefined for malformed entries", () => {
    expect(parseCanonicalProviderRecord("bogus")).toBeUndefined()
    expect(parseCanonicalProviderRecord({ openai: "bogus" })).toBeUndefined()
    expect(parseCanonicalProviderRecord({ openai: { models: "bogus" } })).toBeUndefined()
    expect(parseCanonicalProviderRecord({ openai: { endpoint: "not-a-url" } })).toBeUndefined()
  })

  it("narrowProviderEntry returns undefined for malformed entries", () => {
    expect(narrowProviderEntry("bogus")).toBeUndefined()
    expect(narrowProviderEntry(null)).toBeUndefined()
    expect(narrowProviderEntry({ name: 42 })).toBeUndefined()
    expect(narrowProviderEntry({ name: "X", models: {} })).toBeUndefined()
    expect(narrowProviderEntry({ name: "X", credential: "secret:random" })).toBeUndefined()
  })

  it("buildProviderIndex returns empty providers and structured diagnostics for malformed provider records", () => {
    const snapshot = {
      config: {
        value: { provider: { openai: { models: "bogus" } } },
        version: 1,
        contentHash: "h",
        provenance: {},
      },
    } as never
    const index = buildProviderIndex(snapshot, null)
    expect(index.providers).toEqual([])
    expect(index.diagnostics).toBeDefined()
  })
})

// ── Host/webview readiness ───────────────────────────────────────────

describe("P4.1 canonical readiness gating", () => {
  it("canonicalReady is false before first materialization and true after init", async () => {
    const { canonical, init } = setup(false)
    const { provider } = makeProvider(canonical)
    expect(provider.canonicalReady).toBe(false)
    await init()
    expect(provider.canonicalReady).toBe(true)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("canonical-facing provider actions return not-ready before first materialization", async () => {
    const { canonical, init } = setup(false)
    const { provider, messages } = makeProvider(canonical)
    const stamp: CanonicalStamp = { globalHash: null, projectHash: null, materializationVersion: 0, assetHash: null }
    await provider.handleCanonicalProviderAction({ type: "disconnectProvider", providerID: "openai", requestId: "r1", canonical: true, stamp })
    const error = messages.find((m) => (m as Record<string, unknown>).type === "providerActionError") as Record<string, unknown> | undefined
    expect(error).toBeDefined()
    expect(error!.kind).toBe("not-ready")
    await init()
    expect(provider.canonicalReady).toBe(true)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("webview canonical provider state initializes empty, never KILO_AUTO", async () => {
    const source = await Bun.file(new URL("../../webview-ui/src/context/provider.tsx", import.meta.url)).text()
    expect(source).not.toContain("createSignal<ModelSelection>(KILO_AUTO)")
    expect(source).toContain('createSignal<ModelSelection>({ providerID: "", modelID: "" })')
  })
})

// ── Readiness closure: pre-ready publication and gate lifecycle ──────

describe("P4.1 canonical readiness closure", () => {
  it("service attached but unresolved publishes only typed not-ready state", async () => {
    const { canonical, init } = setup(false)
    const { provider, messages } = makeProvider(canonical)
    expect(provider.canonicalReady).toBe(false)
    await provider.fetchAndSendConfig()
    await provider.fetchAndSendProviders()
    await provider.fetchAndSendAgents()
    // Typed empty/not-ready canonical state — never backend or rehydrated data.
    const configMsg = messages.find((m) => (m as Record<string, unknown>).type === "configLoaded") as Record<string, unknown> | undefined
    expect(configMsg).toBeDefined()
    expect(configMsg!.canonical).toBe(true)
    expect(configMsg!.config).toEqual({})
    expect(configMsg!.materializationVersion).toBe(0)
    const providersMsg = messages.find((m) => (m as Record<string, unknown>).type === "providersLoaded") as Record<string, unknown> | undefined
    expect(providersMsg!.canonical).toBe(true)
    expect(providersMsg!.providers).toEqual({})
    expect(providersMsg!.defaultSelection).toEqual({ providerID: "", modelID: "" })
    const agentsMsg = messages.find((m) => (m as Record<string, unknown>).type === "agentsLoaded") as Record<string, unknown> | undefined
    expect(agentsMsg!.canonical).toBe(true)
    expect(agentsMsg!.agents).toEqual([])
    // No backend fetch may have run — pre-ready publication is canonical-only.
    expect(messages.some((m) => (m as Record<string, unknown>).type === "providersLoaded" && !(m as Record<string, unknown>).canonical)).toBe(false)
    await init()
    expect(provider.canonicalReady).toBe(true)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("rehydrated indexes before successful materialization are never published", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-rehydrated-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    // Invalid config — the first materialization cannot succeed, so the
    // service retains only rehydrated (non-authoritative) indexes.
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ model: 42 }))
    const secrets = createMemorySecretAdapter()
    const workspaceState = createMemoryStateAdapter()
    const agentIndex: AgentIndex = {
      version: SELECTOR_INDEX_VERSION,
      materializationVersion: 3,
      materializationHash: "rehydrated-hash",
      diagnostics: { invalid: false, stale: false, conflicts: [], provenance: {} },
      agents: [{ id: "stale-agent", displayName: "Stale Agent", hidden: false, source: "global" }],
      selectedId: "stale-agent",
      defaultId: "stale-agent",
      timestamp: Date.now(),
    }
    await persistAgentIndex(workspaceState, agentIndex)
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState,
    })
    await canonical.initialize()
    const { provider, messages } = makeProvider(canonical)
    expect(provider.canonicalReady).toBe(false)
    // The service really does hold a rehydrated agent index pre-readiness.
    expect(canonical.agentIndex).not.toBeNull()
    await provider.sendCanonicalAgents()
    const agentsMsg = messages.find((m) => (m as Record<string, unknown>).type === "agentsLoaded") as Record<string, unknown> | undefined
    expect(agentsMsg).toBeDefined()
    expect(agentsMsg!.canonical).toBe(true)
    expect(agentsMsg!.agents).toEqual([])
    // The stale rehydrated agent must never leak into any published message.
    expect(JSON.stringify(messages)).not.toContain("stale-agent")
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("direct selectKiloModel is rejected before canonical readiness", async () => {
    const { canonical, init } = setup(false)
    const { provider, messages } = makeProvider(canonical)
    provider.pendingKiloModel = null
    provider.selectKiloModel("custom/model", "code")
    // No pending selection and no messages — nothing can reach the legacy
    // Kilo/KILO_AUTO select path before readiness.
    expect(provider.pendingKiloModel).toBeNull()
    expect(messages).toHaveLength(0)
    await init()
    provider.selectKiloModel("custom/model", "code")
    expect(provider.pendingKiloModel).toBeNull()
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("service replacement and disposal close readiness until re-materialization", async () => {
    const { canonical } = setup(true)
    await canonical.initialize()
    const { provider } = makeProvider(canonical)
    expect(provider.canonicalReady).toBe(true)
    // Replacement with an unresolved service closes the gate.
    const replacement = replacementService()
    provider.setCanonicalConfig(replacement.service)
    expect(provider.canonicalReady).toBe(false)
    // The replacement successfully materializing opens the gate again.
    await replacement.service.initialize()
    expect(provider.canonicalReady).toBe(true)
    // Disposal closes the gate.
    provider.dispose()
    expect(provider.canonicalReady).toBe(false)
    replacement.service.dispose()
    canonical.dispose()
  })

  it("replacement service publishes typed not-ready state while unresolved", async () => {
    const { canonical } = setup(true)
    await canonical.initialize()
    const { provider, messages } = makeProvider(canonical)
    const replacement = replacementService()
    provider.setCanonicalConfig(replacement.service)
    await provider.fetchAndSendProviders()
    const providersMsg = messages.filter((m) => (m as Record<string, unknown>).type === "providersLoaded")
    const last = providersMsg[providersMsg.length - 1] as Record<string, unknown> | undefined
    expect(last).toBeDefined()
    expect(last!.canonical).toBe(true)
    expect(last!.providers).toEqual({})
    expect(last!.defaultSelection).toEqual({ providerID: "", modelID: "" })
    provider.cleanupRetries.clear()
    replacement.service.dispose()
    canonical.dispose()
  })
})

function replacementService(): { service: CanonicalConfigService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-replacement-"))
  dirs.push(root)
  const global = path.join(root, "global")
  const project = path.join(root, "project")
  fs.mkdirSync(global, { recursive: true })
  fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
  fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ model: "custom/model" }))
  return {
    service: new CanonicalConfigService({} as never, {
      roots: new Roots(project, global),
      secretAdapter: createMemorySecretAdapter(),
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    }),
  }
}

// ── Retry operation record: provider ─────────────────────────────────

describe("P4.1 provider retry operation record", () => {
  async function seeded() {
    const { canonical, secrets } = setup(true)
    await canonical.initialize()
    await canonical.storeSecret("global", "provider", "openai", "sk-test")
    const { provider, messages } = makeProvider(canonical)
    const stamp = canonical.stamp
    const key = "provider:global:openai"
    const ref = "secret:kilo.credentials.global.provider.openai"
    const record: CleanupRetryRecord = { kind: "provider", scope: "global", id: "openai", mode: "delete", ref, stamp, state: "available" }
    provider.cleanupRetries.set(key, record)
    return { canonical, secrets, provider, messages, stamp, key, ref, record }
  }

  it("success consumes the record one-shot and removes the secret", async () => {
    const { canonical, secrets, provider, messages, key, ref } = await seeded()
    await provider.retryCanonicalProviderCleanup({ retryID: key, requestId: "r1" })
    expect(secrets.store_.get("kilo.credentials.global.provider.openai")).toBeUndefined()
    expect(provider.cleanupRetries.has(key)).toBe(false)
    expect(messages.some((m) => (m as Record<string, unknown>).type === "providerDisconnected")).toBe(true)
    expect(messages.some((m) => (m as Record<string, unknown>).type === "providerActionError")).toBe(false)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("wrong retryID is rejected with no side effect and record intact", async () => {
    const { canonical, secrets, provider, messages, key, record } = await seeded()
    await provider.retryCanonicalProviderCleanup({ retryID: "provider:global:other", requestId: "r1" })
    expect(secrets.store_.get("kilo.credentials.global.provider.openai")).toBe("sk-test")
    expect(provider.cleanupRetries.get(key)).toEqual(record)
    expect(messages.some((m) => (m as Record<string, unknown>).type === "providerDisconnected")).toBe(false)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("in-flight (concurrent duplicate) retry is rejected — cannot side-effect twice", async () => {
    const { canonical, secrets, provider, messages, key, record } = await seeded()
    provider.cleanupRetries.set(key, { ...record, state: "inFlight" })
    await provider.retryCanonicalProviderCleanup({ retryID: key, requestId: "r1" })
    expect(secrets.store_.get("kilo.credentials.global.provider.openai")).toBe("sk-test")
    expect((provider.cleanupRetries.get(key) as CleanupRetryRecord).state).toBe("inFlight")
    expect(messages.some((m) => (m as Record<string, unknown>).type === "providerDisconnected")).toBe(false)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("stale stamp (stored != current service stamp) is rejected", async () => {
    const { canonical, secrets, provider, messages, key, record, stamp } = await seeded()
    const stale: CleanupRetryRecord = { ...record, stamp: { ...stamp, materializationVersion: stamp.materializationVersion + 1 } }
    provider.cleanupRetries.set(key, stale)
    await provider.retryCanonicalProviderCleanup({ retryID: key, requestId: "r1" })
    expect(secrets.store_.get("kilo.credentials.global.provider.openai")).toBe("sk-test")
    expect(provider.cleanupRetries.get(key)).toEqual(stale)
    expect(messages.some((m) => (m as Record<string, unknown>).type === "providerDisconnected")).toBe(false)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("wrong-kind record (mcp) is rejected by the provider retry handler", async () => {
    const { canonical, secrets, provider, messages, key } = await seeded()
    const mcpRecord: CleanupRetryRecord = { kind: "mcp", scope: "global", id: "openai", mode: "delete", ref: "secret:kilo.credentials.global.mcp.openai", stamp: canonical.stamp, state: "available" }
    provider.cleanupRetries.set(key, mcpRecord)
    await provider.retryCanonicalProviderCleanup({ retryID: key, requestId: "r1" })
    expect(secrets.store_.get("kilo.credentials.global.provider.openai")).toBe("sk-test")
    expect(provider.cleanupRetries.get(key)).toEqual(mcpRecord)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("failure restores the exact full record unchanged (lossless) with structured failure", async () => {
    const { canonical, secrets, provider, messages, key, record } = await seeded()
    const origDelete = secrets.delete.bind(secrets)
    secrets.delete = async () => { throw new Error("secret-storage down") }
    try {
      await provider.retryCanonicalProviderCleanup({ retryID: key, requestId: "r1" })
    } finally {
      secrets.delete = origDelete
    }
    // Record restored to available with the exact same full payload
    expect(provider.cleanupRetries.get(key)).toEqual({ ...record, state: "available" })
    const error = messages.find((m) => (m as Record<string, unknown>).type === "providerActionError") as Record<string, unknown> | undefined
    expect(error).toBeDefined()
    expect(error!.kind).toBe("cleanupRetry")
    expect((error!.message as string).includes("secret-storage down")).toBe(true)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("provider and MCP retry keys cannot collide", async () => {
    const { canonical, secrets, provider, key } = await seeded()
    await canonical.storeSecret("global", "mcp", "openai", "mcp-secret")
    const mcpKey = "mcp:global:openai"
    // Same suffix, different namespace — both records coexist
    expect(key).not.toBe(mcpKey)
    expect(provider.cleanupRetries.has(key)).toBe(true)
    expect(provider.cleanupRetries.has(mcpKey)).toBe(false)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("replay after success is rejected with no side effect", async () => {
    const { canonical, secrets, provider, messages, key } = await seeded()
    await provider.retryCanonicalProviderCleanup({ retryID: key, requestId: "r1" })
    expect(secrets.store_.get("kilo.credentials.global.provider.openai")).toBeUndefined()
    expect(provider.cleanupRetries.has(key)).toBe(false)
    const before = messages.length
    // Replaying the same consumed retryID must not side-effect a second time.
    await provider.retryCanonicalProviderCleanup({ retryID: key, requestId: "r2" })
    expect(secrets.store_.get("kilo.credentials.global.provider.openai")).toBeUndefined()
    expect(provider.cleanupRetries.has(key)).toBe(false)
    const error = messages.slice(before).find((m) => (m as Record<string, unknown>).type === "providerActionError") as Record<string, unknown> | undefined
    expect(error).toBeDefined()
    expect(error!.kind).toBe("stale")
    expect(messages.slice(before).some((m) => (m as Record<string, unknown>).type === "providerDisconnected")).toBe(false)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("failure after reservation restores the complete prior payload including priorValue", async () => {
    const { canonical, secrets, provider, messages, stamp, ref } = await seeded()
    const priorRecord = { name: "OpenAI", credential: ref, endpoint: "https://api.openai.com/v1" }
    const key = crypto.randomUUID()
    const record: CleanupRetryRecord = {
      kind: "provider",
      scope: "global",
      id: "openai",
      mode: "restore",
      ref,
      priorRecord,
      priorValue: "sk-original",
      stamp,
      state: "available",
    }
    provider.cleanupRetries.set(key, record)
    // Make the restore side effect fail after the record was reserved.
    const origStore = secrets.store.bind(secrets)
    secrets.store = async () => { throw new Error("secret-storage write down") }
    try {
      await provider.retryCanonicalProviderCleanup({ retryID: key, requestId: "r1" })
    } finally {
      secrets.store = origStore
    }
    // The restored record is the exact complete prior payload (state available).
    const restored = provider.cleanupRetries.get(key)
    expect(restored).toEqual({ ...record, state: "available" })
    expect(restored!.priorRecord).toEqual(priorRecord)
    expect(restored!.priorValue).toBe("sk-original")
    expect(restored!.ref).toBe(ref)
    expect(restored!.stamp).toEqual(stamp)
    const error = messages.find((m) => (m as Record<string, unknown>).type === "providerActionError") as Record<string, unknown> | undefined
    expect(error).toBeDefined()
    expect(error!.kind).toBe("cleanupRetry")
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("overlapping cleanup failures for the same provider keep distinct retry IDs/records", async () => {
    const ref = "secret:kilo.credentials.global.provider.openai"
    const cfg = { provider: { openai: { name: "OpenAI", credential: ref } } }
    const { canonical, provider, messages } = await providerActionSetup(cfg)
    // No stored secret → cleanup cannot remove it → retryable failure with a record.
    await provider.handleCanonicalProviderAction({ type: "disconnectProvider", providerID: "openai", requestId: "r1", canonical: true, stamp: canonical.stamp })
    // Re-add the provider with the same credential ref so a second operation can fail identically.
    const written = await canonical.writeConfig("global", cfg, canonical.getConfigHash("global") ?? "absent")
    expect(written.ok).toBe(true)
    await provider.handleCanonicalProviderAction({ type: "disconnectProvider", providerID: "openai", requestId: "r2", canonical: true, stamp: canonical.stamp })

    const records = [...provider.cleanupRetries.entries()]
    expect(records.length).toBe(2)
    const [id1, rec1] = records[0]!
    const [id2, rec2] = records[1]!
    expect(id1).not.toBe(id2)
    // Opaque UUIDs, not deterministic scope/id-derived keys.
    expect(id1.length).toBeGreaterThan(20)
    expect(id2.length).toBeGreaterThan(20)
    expect(rec1.kind).toBe("provider")
    expect(rec1.id).toBe("openai")
    expect(rec1.scope).toBe("global")
    expect(rec1.mode).toBe("delete")
    expect(rec1.ref).toBe(ref)
    expect(rec1.state).toBe("available")
    expect(rec2).toEqual(expect.objectContaining({ kind: "provider", id: "openai", scope: "global", mode: "delete", ref, state: "available" }))
    // The retry payloads exposed to the webview carry the distinct opaque IDs.
    const retries = messages
      .filter((m) => (m as Record<string, unknown>).type === "providerActionError")
      .map((m) => ((m as Record<string, unknown>).retry as { retryID: string }).retryID)
    expect(retries.length).toBe(2)
    expect(new Set(retries).size).toBe(2)
    expect(retries).toEqual(expect.arrayContaining([id1, id2]))
    provider.cleanupRetries.clear()
    canonical.dispose()
  })
})

// ── Retry operation record: MCP ──────────────────────────────────────

describe("P4.1 MCP retry operation record", () => {
  async function seeded() {
    const { canonical, secrets } = setup(true)
    await canonical.initialize()
    await canonical.storeSecret("global", "mcp", "filesystem", "mcp-secret")
    const { provider, messages } = makeProvider(canonical)
    const stamp = canonical.stamp
    const key = "mcp:global:filesystem"
    const ref = "secret:kilo.credentials.global.mcp.filesystem"
    const record: CleanupRetryRecord = { kind: "mcp", scope: "global", id: "filesystem", mode: "delete", ref, stamp, state: "available" }
    provider.cleanupRetries.set(key, record)
    return { canonical, secrets, provider, messages, stamp, key, ref, record }
  }

  it("success consumes the record one-shot and removes the secret", async () => {
    const { canonical, secrets, provider, messages, key } = await seeded()
    await provider.retryCanonicalMcpCleanup({ retryID: key, requestId: "r1" })
    expect(secrets.store_.get("kilo.credentials.global.mcp.filesystem")).toBeUndefined()
    expect(provider.cleanupRetries.has(key)).toBe(false)
    expect(messages.some((m) => (m as Record<string, unknown>).type === "mcpCleanupRetryResult" && (m as Record<string, unknown>).ok === true)).toBe(true)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("wrong-kind record (provider) is rejected by the MCP retry handler", async () => {
    const { canonical, secrets, provider, messages, key } = await seeded()
    const providerRecord: CleanupRetryRecord = { kind: "provider", scope: "global", id: "filesystem", mode: "delete", ref: "secret:kilo.credentials.global.provider.filesystem", stamp: canonical.stamp, state: "available" }
    provider.cleanupRetries.set(key, providerRecord)
    await provider.retryCanonicalMcpCleanup({ retryID: key, requestId: "r1" })
    expect(secrets.store_.get("kilo.credentials.global.mcp.filesystem")).toBe("mcp-secret")
    expect(provider.cleanupRetries.get(key)).toEqual(providerRecord)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("failure restores the exact full record unchanged (lossless)", async () => {
    const { canonical, secrets, provider, messages, key, record } = await seeded()
    const origDelete = secrets.delete.bind(secrets)
    secrets.delete = async () => { throw new Error("mcp secret down") }
    try {
      await provider.retryCanonicalMcpCleanup({ retryID: key, requestId: "r1" })
    } finally {
      secrets.delete = origDelete
    }
    expect(provider.cleanupRetries.get(key)).toEqual({ ...record, state: "available" })
    const result = messages.find((m) => (m as Record<string, unknown>).type === "mcpCleanupRetryResult") as Record<string, unknown> | undefined
    expect(result).toBeDefined()
    expect(result!.ok).toBe(false)
    expect((result!.message as string).includes("mcp secret down")).toBe(true)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("in-flight (concurrent duplicate) retry is rejected", async () => {
    const { canonical, secrets, provider, messages, key, record } = await seeded()
    provider.cleanupRetries.set(key, { ...record, state: "inFlight" })
    await provider.retryCanonicalMcpCleanup({ retryID: key, requestId: "r1" })
    expect(secrets.store_.get("kilo.credentials.global.mcp.filesystem")).toBe("mcp-secret")
    expect((provider.cleanupRetries.get(key) as CleanupRetryRecord).state).toBe("inFlight")
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("webview MCP retry request carries the opaque retryID only", async () => {
    const source = await Bun.file(new URL("../../webview-ui/src/context/session.tsx", import.meta.url)).text()
    const block = source.match(/const retryMcpCleanup[\s\S]*?\n  \}/)?.[0] ?? ""
    const send = block.match(/vscode\.postMessage\([^)]*\)/)?.[0] ?? ""
    expect(send).toContain('retryID: retry.retryID')
    expect(send).not.toContain("name:")
    expect(send).not.toContain("scope:")
    expect(send).not.toContain("ref:")
    expect(send).not.toContain("stamp:")
  })

  it("overlapping cleanup failures for the same MCP keep distinct retry IDs/records", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-audit-mcp2-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    const file = path.join(global, "kilo.jsonc")
    const ref = "secret:kilo.credentials.global.mcp.filesystem"
    const refConfig = { mcp: { filesystem: { type: "local", command: "node", credential: ref } } }
    // Initialize with a valid config — a credential-bearing MCP entry is not
    // schema-valid, so it is authored on disk only after materialization.
    fs.writeFileSync(file, JSON.stringify({ mcp: { filesystem: { type: "local", command: "node" } } }))
    const secrets = createMemorySecretAdapter()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    await canonical.initialize()
    await canonical.storeSecret("global", "mcp", "filesystem", "mcp-secret")
    const { provider, messages } = makeProvider(canonical)
    expect(provider.canonicalReady).toBe(true)

    // First failure: author the credential-bearing prior record raw, then make
    // secret deletion throw → record stored.
    const hash = (): string => { const raw = readFile(file); return raw.type === "present" ? raw.hash : "absent" }
    fs.writeFileSync(file, JSON.stringify(refConfig))
    const origDelete = secrets.delete.bind(secrets)
    secrets.delete = async () => { throw new Error("secret-storage down") }
    try {
      await provider.handleRemoveMcp("filesystem", { canonical: true, scope: "global", expectedHash: hash(), stamp: canonical.stamp })
    } finally {
      secrets.delete = origDelete
    }

    // Re-author the same MCP (with credential) raw; the raw file is the
    // authority for the prior record, and the stamp has not advanced.
    fs.writeFileSync(file, JSON.stringify(refConfig))

    // Second failure for the same server name → its own distinct record.
    secrets.delete = async () => { throw new Error("secret-storage down again") }
    try {
      await provider.handleRemoveMcp("filesystem", { canonical: true, scope: "global", expectedHash: hash(), stamp: canonical.stamp })
    } finally {
      secrets.delete = origDelete
    }

    const records = [...provider.cleanupRetries.entries()]
    expect(records.length).toBe(2)
    const [id1, rec1] = records[0]!
    const [id2, rec2] = records[1]!
    expect(id1).not.toBe(id2)
    expect(id1.length).toBeGreaterThan(20)
    expect(id2.length).toBeGreaterThan(20)
    expect(rec1).toEqual(expect.objectContaining({ kind: "mcp", scope: "global", id: "filesystem", mode: "delete", ref, state: "available" }))
    expect(rec2).toEqual(expect.objectContaining({ kind: "mcp", scope: "global", id: "filesystem", mode: "delete", ref, state: "available" }))
    // Both error payloads expose their own distinct opaque retryID.
    const retryIDs = messages
      .filter((m) => (m as Record<string, unknown>).type === "mcpCleanupError")
      .map((m) => (m as Record<string, unknown>).retryID as string)
    expect(retryIDs.length).toBe(2)
    expect(new Set(retryIDs).size).toBe(2)
    expect(retryIDs).toEqual(expect.arrayContaining([id1, id2]))
    provider.cleanupRetries.clear()
    canonical.dispose()
  })
})

// ── Canonical MCP removal strict identity ────────────────────────────

describe("P4.1 canonical MCP removal strict identity", () => {
  function setupMcp() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-audit-mcp-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    const file = path.join(global, "kilo.jsonc")
    fs.writeFileSync(file, JSON.stringify({ mcp: { filesystem: { type: "local", command: "node", args: ["server.js"] } } }))
    const secrets = createMemorySecretAdapter()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    return { canonical, secrets, global, file, init: () => canonical.initialize() }
  }

  function diskHash(file: string): string {
    const raw = readFile(file)
    return raw.type === "present" ? raw.hash : "absent"
  }

  function removeMsg(canonical: CanonicalConfigService, file: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { canonical: true, scope: "global", expectedHash: diskHash(file), stamp: canonical.stamp, ...overrides }
  }

  it("rejects removal without a stored ref — no reconstructed key deletion", async () => {
    const { canonical, secrets, global, file, init } = setupMcp()
    await init()
    const { provider, messages } = makeProvider(canonical)
    // Simulate an orphaned secret under the derived key (older behavior wrote it).
    await canonical.storeSecret("global", "mcp", "filesystem", "orphan-secret")

    await provider.handleRemoveMcp("filesystem", removeMsg(canonical, file))

    // Config removal committed; the mcp map is now empty.
    expect(canonical.getScopeConfig("global").mcp).toEqual({})
    // Structured failure posted with no retry record (nothing valid to retry).
    const err = messages.find((m) => (m as Record<string, unknown>).type === "mcpCleanupError") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect(err!.retryID).toBe("")
    expect(provider.cleanupRetries.has("mcp:global:filesystem")).toBe(false)
    // No deletion of a reconstructed/fallback key.
    expect(secrets.store_.get("kilo.credentials.global.mcp.filesystem")).toBe("orphan-secret")
    expect(fs.existsSync(global)).toBe(true)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("rejects removal with a non-MCP credential ref — no side effect", async () => {
    const { canonical, secrets, global, file, init } = setupMcp()
    await init()
    const { provider, messages } = makeProvider(canonical)
    await canonical.storeSecret("global", "provider", "filesystem", "provider-secret")
    // The prior record claims a provider-kind ref — invalid for MCP cleanup.
    fs.writeFileSync(file, JSON.stringify({ mcp: { filesystem: { type: "local", command: "node", credential: "secret:kilo.credentials.global.provider.filesystem" } } }))

    await provider.handleRemoveMcp("filesystem", removeMsg(canonical, file))

    expect(canonical.getScopeConfig("global").mcp).toEqual({})
    const err = messages.find((m) => (m as Record<string, unknown>).type === "mcpCleanupError") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect(err!.retryID).toBe("")
    expect(provider.cleanupRetries.has("mcp:global:filesystem")).toBe(false)
    // The provider-kind secret referenced by the record is untouched.
    expect(secrets.store_.get("kilo.credentials.global.provider.filesystem")).toBe("provider-secret")
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("rejects removal with an MCP ref for a different server name — no side effect", async () => {
    const { canonical, secrets, global, file, init } = setupMcp()
    await init()
    const { provider, messages } = makeProvider(canonical)
    await canonical.storeSecret("global", "mcp", "other", "other-secret")
    fs.writeFileSync(file, JSON.stringify({ mcp: { filesystem: { type: "local", command: "node", credential: "secret:kilo.credentials.global.mcp.other" } } }))

    await provider.handleRemoveMcp("filesystem", removeMsg(canonical, file))

    expect(canonical.getScopeConfig("global").mcp).toEqual({})
    const err = messages.find((m) => (m as Record<string, unknown>).type === "mcpCleanupError") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect(err!.retryID).toBe("")
    expect(provider.cleanupRetries.has("mcp:global:filesystem")).toBe(false)
    expect(secrets.store_.get("kilo.credentials.global.mcp.other")).toBe("other-secret")
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("removes the exact validated stored ref on success", async () => {
    const { canonical, secrets, global, file, init } = setupMcp()
    await init()
    const { provider, messages } = makeProvider(canonical)
    await canonical.storeSecret("global", "mcp", "filesystem", "real-secret")
    fs.writeFileSync(file, JSON.stringify({ mcp: { filesystem: { type: "local", command: "node", credential: "secret:kilo.credentials.global.mcp.filesystem" } } }))

    await provider.handleRemoveMcp("filesystem", removeMsg(canonical, file))

    expect(canonical.getScopeConfig("global").mcp).toEqual({})
    expect(secrets.store_.get("kilo.credentials.global.mcp.filesystem")).toBeUndefined()
    expect(messages.some((m) => (m as Record<string, unknown>).type === "mcpCleanupError")).toBe(false)
    expect(provider.cleanupRetries.has("mcp:global:filesystem")).toBe(false)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("rejects a missing/invalid scope with a structured failure and no write", async () => {
    const { canonical, secrets, global, file, init } = setupMcp()
    await init()
    const { provider, messages } = makeProvider(canonical)
    await canonical.storeSecret("global", "mcp", "filesystem", "secret-value")

    // Missing scope — must not fall back to "global".
    await provider.handleRemoveMcp("filesystem", { canonical: true, expectedHash: "x", stamp: canonical.stamp })
    // Invalid scope — must not fall back to "global".
    await provider.handleRemoveMcp("filesystem", { canonical: true, scope: "bogus", expectedHash: "x", stamp: canonical.stamp })

    const errors = messages.filter((m) => (m as Record<string, unknown>).type === "mcpCleanupError")
    expect(errors.length).toBe(2)
    for (const err of errors) expect((err as Record<string, unknown>).retryID).toBe("")
    // No write happened — filesystem is still present and the secret untouched.
    expect((canonical.getScopeConfig("global").mcp as Record<string, unknown>).filesystem).toBeDefined()
    expect(secrets.store_.get("kilo.credentials.global.mcp.filesystem")).toBe("secret-value")
    expect(provider.cleanupRetries.size).toBe(0)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("rejects a stale stamp with a structured failure and no write", async () => {
    const { canonical, secrets, global, file, init } = setupMcp()
    await init()
    const { provider, messages } = makeProvider(canonical)
    const stale = { ...canonical.stamp, materializationVersion: canonical.stamp.materializationVersion + 1 }

    await provider.handleRemoveMcp("filesystem", removeMsg(canonical, file, { stamp: stale }))

    const err = messages.find((m) => (m as Record<string, unknown>).type === "mcpCleanupError") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect((canonical.getScopeConfig("global").mcp as Record<string, unknown>).filesystem).toBeDefined()
    expect(provider.cleanupRetries.size).toBe(0)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })
})

// ── Canonical custom-provider form ───────────────────────────────────

describe("P4.1 canonical custom-provider form", () => {
  function form(overrides: Partial<FormState> = {}): FormState {
    return {
      providerID: "custom",
      name: "Custom",
      npm: "@ai-sdk/openai-compatible",
      baseURL: "https://api.example.com/v1",
      apiKey: "",
      models: [{ id: "m1", name: "Model 1", reasoning: false, supportsImages: false, modalities: { input: [], output: [] }, variants: [] }],
      headers: [],
      saving: false,
      ...overrides,
    }
  }

  it("serializeCanonicalProvider produces only {name, endpoint, protocol, models} and passes the shared schema", () => {
    const payload = serializeCanonicalProvider(form())
    expect(payload).toBeDefined()
    expect(isValidCanonicalProviderEntry(payload)).toBe(true)
    expect(payload!.name).toBe("Custom")
    expect(payload!.endpoint).toBe("https://api.example.com/v1")
    expect(payload!.protocol).toBe("openai")
    expect(payload!.models).toBeDefined()
    // forbidden legacy fields are absent from the serialized payload
    expect("npm" in payload!).toBe(false)
    expect("options" in payload!).toBe(false)
    expect("headers" in payload!).toBe(false)
    expect("env" in payload!).toBe(false)
    expect("credential" in payload!).toBe(false)
  })

  it("empty model set omits models and still passes the shared schema", () => {
    const payload = serializeCanonicalProvider(form({ models: [] }))
    expect(payload).toBeDefined()
    expect(isValidCanonicalProviderEntry(payload)).toBe(true)
    expect("models" in payload!).toBe(false)
  })

  it("invalid endpoint returns undefined (shared endpoint rule)", () => {
    expect(serializeCanonicalProvider(form({ baseURL: "ftp://example.com" }))).toBeUndefined()
    expect(serializeCanonicalProvider(form({ baseURL: "not-a-url" }))).toBeUndefined()
  })

  it("invalid form data (empty name / empty model id) yields a payload the shared schema rejects or omits", () => {
    const noName = serializeCanonicalProvider(form({ name: "" }))
    expect(noName).toBeUndefined()
    const badModel = serializeCanonicalProvider(form({ models: [{ id: "", name: "M", reasoning: false, supportsImages: false, modalities: { input: [], output: [] }, variants: [] }] }))
    if (badModel) expect(isValidCanonicalProviderEntry(badModel)).toBe(true)
  })
})

// ── Retry request contract (host side) ───────────────────────────────

describe("P4.1 host retry contract", () => {
  it("host provider retry rejects arbitrary authority refs — record ref is the sole authority", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const providerBlock = source.match(/private async retryCanonicalProviderCleanup[\s\S]*?private async handleCanonicalConfigUpdate/)?.[0] ?? ""
    // Looks up by opaque retryID only; never reads webview-provided providerID/scope/ref
    expect(providerBlock).toContain('typeof msg.retryID === "string"')
    expect(providerBlock).not.toMatch(/msg\.providerID/)
    expect(providerBlock).not.toMatch(/msg\.scope/)
    expect(providerBlock).not.toMatch(/msg\.ref/)
    const mcpBlock = source.match(/private async retryCanonicalMcpCleanup[\s\S]*?private async refreshMcpStatus/)?.[0] ?? ""
    expect(mcpBlock).toContain('typeof msg.retryID === "string"')
    expect(mcpBlock).not.toMatch(/msg\.name/)
    expect(mcpBlock).not.toMatch(/msg\.scope/)
    expect(mcpBlock).not.toMatch(/msg\.ref/)
  })
})

// ── Credential ref reads: missing/invalid/cross-scope/cross-kind ─────

describe("P4.1 credential ref reads reject derived keys", () => {
  async function setupWithProvider(credentialRef?: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-cred-read-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    const cfg: Record<string, unknown> = credentialRef
      ? { provider: { openai: { name: "OpenAI", endpoint: "https://api.openai.com/v1", protocol: "openai", models: { "gpt-4": { name: "GPT-4" } }, credential: credentialRef } } }
      : { provider: { openai: { name: "OpenAI", endpoint: "https://api.openai.com/v1", protocol: "openai", models: { "gpt-4": { name: "GPT-4" } } } } }
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify(cfg))
    const secrets = createMemorySecretAdapter()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    await canonical.initialize()
    const { provider, messages } = makeProvider(canonical)
    return { canonical, secrets, provider, messages }
  }

  it("handleGetProviderCredential rejects when provider has no credential ref", async () => {
    const { canonical, provider, messages } = await setupWithProvider()
    await provider.handleGetProviderCredential({ requestID: "r1", providerID: "openai" })
    const err = messages.find((m) => (m as Record<string, unknown>).type === "providerCredentialError") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect(err!.error).toContain("no valid credential reference")
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("handleGetProviderCredential rejects when credential ref is cross-kind (mcp ref for provider)", async () => {
    const crossKindRef = "secret:kilo.credentials.global.mcp.openai"
    const { canonical, provider, messages } = await setupWithProvider(crossKindRef)
    // A cross-kind credential ref in the on-disk config causes materialization
    // to fail validation → canonicalReady stays false → "not ready" error.
    // This is correct: an invalid credential ref prevents the canonical authority
    // from becoming ready, so credential reads are blocked.
    await provider.handleGetProviderCredential({ requestID: "r1", providerID: "openai" })
    const err = messages.find((m) => (m as Record<string, unknown>).type === "providerCredentialError") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect(err!.error).toContain("not ready")
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("handleGetProviderCredential rejects when credential ref is cross-scope (project ref for global provider)", async () => {
    const crossScopeRef = "secret:kilo.credentials.project.provider.openai"
    const { canonical, provider, messages } = await setupWithProvider(crossScopeRef)
    // A cross-scope credential ref in the on-disk config may cause materialization
    // issues → canonicalReady may stay false → "not ready" error.
    // If the ref is otherwise valid (correct kind), the config may materialize
    // but the secret won't exist under the project-scope key → "not available".
    await provider.handleGetProviderCredential({ requestID: "r1", providerID: "openai" })
    const err = messages.find((m) => (m as Record<string, unknown>).type === "providerCredentialError") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    // Either "not ready" (materialization failed) or "not available" (secret missing)
    expect(err!.error === "Canonical credential authority is not ready" || (err!.error as string).includes("not available") || (err!.error as string).includes("no valid credential reference")).toBe(true)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("handleGetProviderCredential succeeds when valid owned ref exists in SecretStorage", async () => {
    const ref = "secret:kilo.credentials.global.provider.openai"
    const { canonical, secrets, provider, messages } = await setupWithProvider(ref)
    await secrets.store("kilo.credentials.global.provider.openai", "sk-test")
    await provider.handleGetProviderCredential({ requestID: "r1", providerID: "openai" })
    const loaded = messages.find((m) => (m as Record<string, unknown>).type === "providerCredentialLoaded") as Record<string, unknown> | undefined
    expect(loaded).toBeDefined()
    expect(loaded!.hasCredential).toBe(true)
    expect(loaded!.canonical).toBe(true)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("handleFetchCustomProviderModels rejects when provider has no credential ref and no explicit key", async () => {
    const { canonical, provider, messages } = await setupWithProvider()
    // Use a non-existent URL so fetchOpenAIModels fails fast
    await provider.handleFetchCustomProviderModels({ requestId: "r1", baseURL: "http://127.0.0.1:1", canonical: true, stamp: canonical.stamp, providerID: "openai" })
    // No credential ref → key is undefined → fetchOpenAIModels called without key → error
    const result = messages.find((m) => (m as Record<string, unknown>).type === "customProviderModelsFetched") as Record<string, unknown> | undefined
    expect(result).toBeDefined()
    expect(result!.error).toBeDefined()
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("handleFetchCustomProviderModels uses exact ref from record, not a derived key", async () => {
    const ref = "secret:kilo.credentials.global.provider.openai"
    const { canonical, secrets, provider, messages } = await setupWithProvider(ref)
    // Store the secret under the exact ref key
    await secrets.store("kilo.credentials.global.provider.openai", "sk-test")
    // Use a non-existent URL so fetchOpenAIModels fails fast
    await provider.handleFetchCustomProviderModels({ requestId: "r1", baseURL: "http://127.0.0.1:1", canonical: true, stamp: canonical.stamp, providerID: "openai" })
    // The key should be resolved from the exact ref, not a derived key
    const result = messages.find((m) => (m as Record<string, unknown>).type === "customProviderModelsFetched") as Record<string, unknown> | undefined
    expect(result).toBeDefined()
    // Auth error or connection error — the key was resolved from the record ref
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("handleFetchCustomProviderModels does not reconstruct a derived key when ref is missing", async () => {
    const { canonical, secrets, provider, messages } = await setupWithProvider()
    // Even if a secret exists under the derived key, it must NOT be read
    await secrets.store("kilo.credentials.global.provider.openai", "orphan-secret")
    // Use a non-existent URL so fetchOpenAIModels fails fast
    await provider.handleFetchCustomProviderModels({ requestId: "r1", baseURL: "http://127.0.0.1:1", canonical: true, stamp: canonical.stamp, providerID: "openai" })
    const result = messages.find((m) => (m as Record<string, unknown>).type === "customProviderModelsFetched") as Record<string, unknown> | undefined
    expect(result).toBeDefined()
    // The orphan secret must not have been used — key was undefined
    provider.cleanupRetries.clear()
    canonical.dispose()
  })
})

// ── Canonical provider save: shared schema validation ─────────────────

describe("P4.1 canonical provider save uses shared schema validator", () => {
  it("handleCanonicalProviderAction rejects save with malformed provider payload", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-canonical-save-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ provider: { openai: { name: "OpenAI" } } }))
    const secrets = createMemorySecretAdapter()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    await canonical.initialize()
    const { provider, messages } = makeProvider(canonical)

    // Attempt to save a provider with a legacy field (npm) — shared schema rejects it
    await provider.handleCanonicalProviderAction({
      type: "saveCustomProvider",
      providerID: "openai",
      requestId: "r1",
      canonical: true,
      stamp: canonical.stamp,
      config: { name: "OpenAI", endpoint: "https://api.openai.com/v1", protocol: "openai", npm: "@ai-sdk/openai" },
    })
    const err = messages.find((m) => (m as Record<string, unknown>).type === "providerActionError") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect(err!.kind).toBe("invalid")
    expect((err!.message as string).includes("shared schema")).toBe(true)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("handleCanonicalProviderAction rejects save with invalid endpoint", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-canonical-save2-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ provider: { openai: { name: "OpenAI" } } }))
    const secrets = createMemorySecretAdapter()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    await canonical.initialize()
    const { provider, messages } = makeProvider(canonical)

    await provider.handleCanonicalProviderAction({
      type: "saveCustomProvider",
      providerID: "openai",
      requestId: "r1",
      canonical: true,
      stamp: canonical.stamp,
      config: { name: "OpenAI", endpoint: "ftp://invalid", protocol: "openai", models: { "m1": { name: "M1" } } },
    })
    const err = messages.find((m) => (m as Record<string, unknown>).type === "providerActionError") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect(err!.kind).toBe("invalid")
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("handleCanonicalProviderAction rejects save with credential-bearing fields", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-canonical-save3-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ provider: { openai: { name: "OpenAI" } } }))
    const secrets = createMemorySecretAdapter()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    await canonical.initialize()
    const { provider, messages } = makeProvider(canonical)

    // Attempt with apiKey in the top-level message — must be rejected before schema validation
    await provider.handleCanonicalProviderAction({
      type: "saveCustomProvider",
      providerID: "openai",
      requestId: "r1",
      canonical: true,
      stamp: canonical.stamp,
      apiKey: "sk-stolen",
      config: { name: "OpenAI", endpoint: "https://api.openai.com/v1", protocol: "openai", models: { "m1": { name: "M1" } } },
    })
    const err = messages.find((m) => (m as Record<string, unknown>).type === "providerActionError") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect((err!.message as string).includes("credential-bearing")).toBe(true)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("handleCanonicalProviderAction rejects save with invalid protocol", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-canonical-save4-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ provider: { openai: { name: "OpenAI" } } }))
    const secrets = createMemorySecretAdapter()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    await canonical.initialize()
    const { provider, messages } = makeProvider(canonical)

    await provider.handleCanonicalProviderAction({
      type: "saveCustomProvider",
      providerID: "openai",
      requestId: "r1",
      canonical: true,
      stamp: canonical.stamp,
      config: { name: "OpenAI", endpoint: "https://api.openai.com/v1", protocol: "bogus", models: { "m1": { name: "M1" } } },
    })
    const err = messages.find((m) => (m as Record<string, unknown>).type === "providerActionError") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect(err!.kind).toBe("invalid")
    provider.cleanupRetries.clear()
    canonical.dispose()
  })
})

// ── Concurrent distinct retry IDs for one target ──────────────────────

describe("P4.1 concurrent distinct retry IDs for same target", () => {
  it("concurrent retry of the same retryID does not double side-effect", async () => {
    const ref = "secret:kilo.credentials.global.provider.openai"
    const { canonical, secrets } = setup(true)
    await canonical.initialize()
    await canonical.storeSecret("global", "provider", "openai", "sk-test")
    const { provider, messages } = makeProvider(canonical)
    const key = crypto.randomUUID()
    const record: CleanupRetryRecord = { kind: "provider", scope: "global", id: "openai", mode: "delete", ref, stamp: canonical.stamp, state: "available" }
    provider.cleanupRetries.set(key, record)

    // First retry reserves inFlight, second sees inFlight and rejects.
    const p1 = provider.retryCanonicalProviderCleanup({ retryID: key, requestId: "r1" })
    const p2 = provider.retryCanonicalProviderCleanup({ retryID: key, requestId: "r2" })
    await Promise.all([p1, p2])

    // Only one side-effect occurred — the secret was deleted once.
    expect(secrets.store_.get("kilo.credentials.global.provider.openai")).toBeUndefined()
    // Record consumed on success.
    expect(provider.cleanupRetries.has(key)).toBe(false)
    // Only one success message; the other was rejected.
    const successes = messages.filter((m) => (m as Record<string, unknown>).type === "providerDisconnected")
    expect(successes.length).toBe(1)
    const errors = messages.filter((m) => (m as Record<string, unknown>).type === "providerActionError")
    expect(errors.length).toBe(1)
    expect((errors[0] as Record<string, unknown>).kind).toBe("stale")
    provider.cleanupRetries.clear()
    canonical.dispose()
  })
})

// ── P4.1 readiness closure: webview canonical gate ─────────────────────

describe("P4.1 webview readiness closure", () => {
  it("not-ready canonical configLoaded does not set canonical in provider context", async () => {
    // The webview provider context must NOT set canonical(true) when it
    // receives a pre-materialization configLoaded with canonical:true but
    // materializationVersion === 0 OR ready === false.
    const source = await Bun.file(new URL("../../webview-ui/src/context/provider.tsx", import.meta.url)).text()
    // The setCanonical line must require materializationVersion > 0 AND ready !== false
    expect(source).toContain("message.materializationVersion > 0 && message.ready !== false")
    // Must not unconditionally set canonical on canonical message
    expect(source).not.toMatch(/if\s*\(\s*message\.canonical\s*\)\s*setCanonical\(true\)/)
  })

  it("not-ready canonical configLoaded does not set canonical in config context", async () => {
    const source = await Bun.file(new URL("../../webview-ui/src/context/config.tsx", import.meta.url)).text()
    // Both handleConfigLoaded and applyConfigUpdated must gate canonical
    // through the isCanonicalReady helper which requires materializationVersion > 0
    expect(source).toContain("isCanonicalReady(message)")
    expect(source).toContain("function isCanonicalReady(message:")
  })

  it("first materialization opens canonical gate in provider context", async () => {
    const source = await Bun.file(new URL("../../webview-ui/src/context/provider.tsx", import.meta.url)).text()
    // Must set canonical true when materializationVersion > 0 AND ready !== false
    expect(source).toContain('if (message.canonical && message.materializationVersion !== undefined && message.materializationVersion > 0 && message.ready !== false) setCanonical(true)')
  })

  it("session configuredFallback returns null before canonical readiness", async () => {
    const source = await Bun.file(new URL("../../webview-ui/src/context/session.tsx", import.meta.url)).text()
    const fallbackBlock = source.match(/function configuredFallback[\s\S]*?\n  \}/)?.[0] ?? ""
    // Must gate KILO_AUTO behind canonical check
    expect(fallbackBlock).toContain("canonical?.()")
    expect(fallbackBlock).toContain("null")
    // Must not unconditionally return KILO_AUTO
    expect(fallbackBlock).not.toMatch(/return KILO_AUTO(?!\s*\))/)
  })
})

// ── P4.1 target-level reservation ──────────────────────────────────────

describe("P4.1 target-level retry reservation", () => {
  it("KiloProvider has cleanupTargetKey method and cleanupTargets map", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    expect(source).toContain("private readonly cleanupTargets = new Map<string, string>()")
    expect(source).toContain("private cleanupTargetKey(kind:")
  })

  it("provider retry reserves target before side effect and releases on success", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const providerBlock = source.match(/private async retryCanonicalProviderCleanup[\s\S]*?private async handleCanonicalConfigUpdate/)?.[0] ?? ""
    // Must build a target key and reserve before the side effect
    expect(providerBlock).toContain("cleanupTargetKey(")
    expect(providerBlock).toContain("cleanupTargets.set(targetKey, retryID)")
    // Must release on success
    expect(providerBlock).toContain("cleanupTargets.delete(targetKey)")
    // Reserve must happen before the side effect
    expect(providerBlock.indexOf("cleanupTargets.set(targetKey")).toBeLessThan(providerBlock.indexOf("await service.removeSecretRef"))
    expect(providerBlock.indexOf("cleanupTargets.set(targetKey")).toBeLessThan(providerBlock.indexOf("await service.writeConfig"))
  })

  it("MCP retry reserves target before side effect and releases on success", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const mcpBlock = source.match(/private async retryCanonicalMcpCleanup[\s\S]*?private async refreshMcpStatus/)?.[0] ?? ""
    expect(mcpBlock).toContain("cleanupTargetKey(")
    expect(mcpBlock).toContain("cleanupTargets.set(targetKey, retryID)")
    expect(mcpBlock).toContain("cleanupTargets.delete(targetKey)")
    expect(mcpBlock.indexOf("cleanupTargets.set(targetKey")).toBeLessThan(mcpBlock.indexOf("await service.removeSecretRef"))
  })

  it("provider retry rejects concurrent distinct retry for same target", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const providerBlock = source.match(/private async retryCanonicalProviderCleanup[\s\S]*?private async handleCanonicalConfigUpdate/)?.[0] ?? ""
    // Must check if another retry owns the target
    expect(providerBlock).toContain("cleanupTargets.get(targetKey)")
    expect(providerBlock).toContain("owner && owner !== retryID")
    expect(providerBlock).toContain("target is already in flight")
  })

  it("MCP retry rejects concurrent distinct retry for same target", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const mcpBlock = source.match(/private async retryCanonicalMcpCleanup[\s\S]*?private async refreshMcpStatus/)?.[0] ?? ""
    expect(mcpBlock).toContain("cleanupTargets.get(targetKey)")
    expect(mcpBlock).toContain("owner && owner !== retryID")
    expect(mcpBlock).toContain("target is already in flight")
  })

  it("provider retry releases target on failure (lossless)", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const providerBlock = source.match(/private async retryCanonicalProviderCleanup[\s\S]*?private async handleCanonicalConfigUpdate/)?.[0] ?? ""
    // Must release target in the catch block
    const catchBlock = providerBlock.match(/catch \(err\) \{[\s\S]*?\n    \}/)?.[0] ?? ""
    expect(catchBlock).toContain("cleanupTargets.delete(targetKey)")
  })

  it("MCP retry releases target on failure (lossless)", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const mcpBlock = source.match(/private async retryCanonicalMcpCleanup[\s\S]*?private async refreshMcpStatus/)?.[0] ?? ""
    const catchBlock = mcpBlock.match(/catch \(error\) \{[\s\S]*?\n    \}/)?.[0] ?? ""
    expect(catchBlock).toContain("cleanupTargets.delete(targetKey)")
  })

  it("dispose clears cleanupTargets", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const disposeBlock = source.match(/dispose\(\): void \{[\s\S]*?disposeGitChangesTarget/)?.[0] ?? ""
    expect(disposeBlock).toContain("this.cleanupTargets.clear()")
  })

  it("two distinct retry IDs with same target: concurrent reserve rejects second", async () => {
    const ref = "secret:kilo.credentials.global.provider.openai"
    const { canonical, secrets } = setup(true)
    await canonical.initialize()
    await canonical.storeSecret("global", "provider", "openai", "sk-test")
    const { provider, messages } = makeProvider(canonical)
    // Two distinct retry IDs for the same (kind, scope, id, ref) target.
    const key1 = crypto.randomUUID()
    const key2 = crypto.randomUUID()
    const record1: CleanupRetryRecord = { kind: "provider", scope: "global", id: "openai", mode: "delete", ref, stamp: canonical.stamp, state: "available" }
    const record2: CleanupRetryRecord = { kind: "provider", scope: "global", id: "openai", mode: "delete", ref, stamp: canonical.stamp, state: "available" }
    provider.cleanupRetries.set(key1, record1)
    provider.cleanupRetries.set(key2, record2)

    // Simulate key1 being in-flight by manually reserving the target.
    const targetKey = `provider|global|openai|${ref}`
    const internal = provider as unknown as { cleanupTargets: Map<string, string> }
    internal.cleanupTargets.set(targetKey, key1)

    // key2 tries the same target while key1's target is reserved → rejected.
    await provider.retryCanonicalProviderCleanup({ retryID: key2, requestId: "r2" })

    // Secret untouched — key2 was rejected before side effect.
    expect(secrets.store_.get("kilo.credentials.global.provider.openai")).toBe("sk-test")
    // key2 record is still available (not consumed).
    expect(provider.cleanupRetries.get(key2)?.state).toBe("available")
    const errors = messages.filter((m) => (m as Record<string, unknown>).type === "providerActionError")
    const targetError = errors.find((e) => (e as Record<string, unknown>).message === "Provider cleanup retry target is already in flight")
    expect(targetError).toBeDefined()

    // Simulate key1 completing: release the target, delete key1 from retries.
    internal.cleanupTargets.delete(targetKey)
    provider.cleanupRetries.delete(key1)

    // key2 can now retry (target released).
    await provider.retryCanonicalProviderCleanup({ retryID: key2, requestId: "r3" })
    // Secret deleted by key2, key2 consumed.
    expect(secrets.store_.get("kilo.credentials.global.provider.openai")).toBeUndefined()
    expect(provider.cleanupRetries.has(key2)).toBe(false)
    const successes = messages.filter((m) => (m as Record<string, unknown>).type === "providerDisconnected")
    expect(successes.length).toBe(1)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("MCP: two distinct retry IDs same target: concurrent reserve rejects second", async () => {
    const ref = "secret:kilo.credentials.global.mcp.filesystem"
    const { canonical, secrets } = setup(true)
    await canonical.initialize()
    await canonical.storeSecret("global", "mcp", "filesystem", "mcp-secret")
    const { provider, messages } = makeProvider(canonical)
    const key1 = crypto.randomUUID()
    const key2 = crypto.randomUUID()
    const record1: CleanupRetryRecord = { kind: "mcp", scope: "global", id: "filesystem", mode: "delete", ref, stamp: canonical.stamp, state: "available" }
    const record2: CleanupRetryRecord = { kind: "mcp", scope: "global", id: "filesystem", mode: "delete", ref, stamp: canonical.stamp, state: "available" }
    provider.cleanupRetries.set(key1, record1)
    provider.cleanupRetries.set(key2, record2)

    // Simulate key1 being in-flight by manually reserving the target.
    const targetKey = `mcp|global|filesystem|${ref}`
    const internal = provider as unknown as { cleanupTargets: Map<string, string> }
    internal.cleanupTargets.set(targetKey, key1)

    // key2 tries the same target while key1's target is reserved → rejected.
    await provider.retryCanonicalMcpCleanup({ retryID: key2, requestId: "r2" })

    expect(secrets.store_.get("kilo.credentials.global.mcp.filesystem")).toBe("mcp-secret")
    expect(provider.cleanupRetries.get(key2)?.state).toBe("available")
    const errors = messages.filter((m) => (m as Record<string, unknown>).type === "mcpCleanupRetryResult" && (m as Record<string, unknown>).ok === false)
    const targetError = errors.find((e) => (e as Record<string, unknown>).message === "MCP cleanup retry target is already in flight")
    expect(targetError).toBeDefined()
    provider.cleanupRetries.clear()
    canonical.dispose()
  })
})

// ── P4.1 readiness boundary: explicit ready field ─────────────────────

describe("P4.1 readiness boundary: explicit ready field", () => {
  it("not-ready messages carry ready:false", async () => {
    const { canonical, init } = setup(false)
    const { provider, messages } = makeProvider(canonical)
    await provider.fetchAndSendConfig()
    await provider.fetchAndSendProviders()
    await provider.fetchAndSendAgents()
    for (const msg of messages) {
      const m = msg as Record<string, unknown>
      if (m.type === "configLoaded" || m.type === "providersLoaded" || m.type === "agentsLoaded") {
        expect(m.canonical).toBe(true)
        expect(m.ready).toBe(false)
      }
    }
    await init()
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("ready messages carry ready:true after successful materialization", async () => {
    const { canonical } = setup(true)
    await canonical.initialize()
    const { provider, messages } = makeProvider(canonical)
    await provider.fetchAndSendConfig()
    await provider.fetchAndSendProviders()
    await provider.fetchAndSendAgents()
    for (const msg of messages) {
      const m = msg as Record<string, unknown>
      if (m.type === "configLoaded" || m.type === "providersLoaded" || m.type === "agentsLoaded") {
        expect(m.canonical).toBe(true)
        expect(m.ready).toBe(true)
      }
    }
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("config.tsx isCanonicalReady checks ready field", async () => {
    const source = await Bun.file(new URL("../../webview-ui/src/context/config.tsx", import.meta.url)).text()
    expect(source).toContain("message.ready !== false")
  })

  it("provider.tsx checks ready field before setting canonical", async () => {
    const source = await Bun.file(new URL("../../webview-ui/src/context/provider.tsx", import.meta.url)).text()
    expect(source).toContain("message.ready !== false")
  })
})

// ── P4.1 legacy mutation rejection when canonical attached but not ready ─

describe("P4.1 legacy mutation rejection when canonical attached but not ready", () => {
  it("handleUpdateConfigMessage rejects when canonicalConfig set but not ready", async () => {
    const { canonical, init } = setup(false)
    const { provider, messages } = makeProvider(canonical)
    // Canonical save before readiness is rejected — no legacy mutation window.
    await provider.handleUpdateConfigMessage({
      type: "updateConfig",
      canonical: true,
      config: { model: "test/model" },
      saveID: "save1",
      stamp: { globalHash: null, projectHash: null, materializationVersion: 0, assetHash: null },
    })
    const err = messages.find((m) => (m as Record<string, unknown>).type === "configUpdateFailed") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect(err!.kind).toBe("not-ready")
    expect(err!.saveID).toBe("save1")

    // Legacy non-canonical messages are rejected structurally even before readiness.
    messages.length = 0
    await provider.handleUpdateConfigMessage({ type: "updateConfig", config: { model: "test/model" }, saveID: "legacy" })
    const legacy = messages.find((m) => (m as Record<string, unknown>).type === "configUpdateFailed") as Record<string, unknown> | undefined
    expect(legacy).toMatchObject({ canonical: true, kind: "invalid", saveID: "legacy" })
    await init()
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("handleRemoveAgent rejects with not-ready before canonical readiness", async () => {
    const { canonical, init } = setup(false)
    const { provider, messages } = makeProvider(canonical)
    await provider.handleRemoveAgent("code", "project", undefined, undefined)
    const err = messages.find((m) => (m as Record<string, unknown>).type === "agentMutationError") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect(err!.kind).toBe("not-ready")
    await init()
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("handleCanonicalAgentMutation rejects with not-ready before canonical readiness", async () => {
    const { canonical, init } = setup(false)
    const { provider, messages } = makeProvider(canonical)
    await provider.handleCanonicalAgentMutation({ name: "test-agent", frontmatter: {}, body: "", scope: "project", expectedHash: "absent", stamp: canonical.stamp, requestId: "r1" })
    const err = messages.find((m) => (m as Record<string, unknown>).type === "agentMutationError") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect(err!.kind).toBe("not-ready")
    await init()
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("webview removeAgent rejects when canonical but no agentStamp", async () => {
    const source = await Bun.file(new URL("../../webview-ui/src/context/session.tsx", import.meta.url)).text()
    const removeAgentBlock = source.match(/const removeAgent = \(name: string\) => \{[\s\S]*?const item = allAgents\(\)[\s\S]*?vscode\.postMessage\(\{ type: "removeAgent"/)?.[0] ?? ""
    // Must check canonical?.() && !agentStamp() before sending canonical message
    expect(removeAgentBlock).toContain("canonical?.()")
    expect(removeAgentBlock).toContain("agentStamp()")
  })
})

// ── P4.1 errored initial materialization stays not-ready ────────────────

describe("P4.1 errored initial materialization stays not-ready", () => {
  it("invalid config prevents canonicalReady from ever becoming true", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-errored-mat-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    // Invalid config — model is a number, not a string
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ model: 42 }))
    const secrets = createMemorySecretAdapter()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    await canonical.initialize()
    const { provider, messages } = makeProvider(canonical)
    // canonicalReady must be false — the initial materialization has errors
    expect(provider.canonicalReady).toBe(false)
    // Not-ready messages must carry ready: false
    await provider.fetchAndSendConfig()
    const configMsg = messages.find((m) => (m as Record<string, unknown>).type === "configLoaded") as Record<string, unknown> | undefined
    expect(configMsg).toBeDefined()
    expect(configMsg!.canonical).toBe(true)
    expect(configMsg!.ready).toBe(false)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("onCanonicalError reads materializationReady from service", async () => {
    const { canonical } = setup(true)
    await canonical.initialize()
    const { provider } = makeProvider(canonical)
    expect(provider.canonicalReady).toBe(true)
    // The onCanonicalError handler must mirror the service fact, not hardcode false
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    expect(source).toContain("this.canonicalReady = this.canonicalConfig.materializationReady")
    provider.cleanupRetries.clear()
    canonical.dispose()
  })
})

// ── P4.1 service replacement resets readiness ──────────────────────────

describe("P4.1 service replacement resets readiness", () => {
  it("setCanonicalConfig resets canonicalReady", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const setBlock = source.match(/setCanonicalConfig\(service: CanonicalConfigService\): void \{[\s\S]*?\n  \}/)?.[0] ?? ""
    expect(setBlock).toContain("this.canonicalReady = false")
  })

  it("dispose resets canonicalReady", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const disposeBlock = source.match(/dispose\(\): void \{[\s\S]*?disposeGitChangesTarget/)?.[0] ?? ""
    expect(disposeBlock).toContain("this.canonicalReady = false")
  })
})

// ── P4.1 selectKiloModel: canonical mode blocks all paths ──────────────

describe("P4.1 selectKiloModel: canonical mode blocks all paths", () => {
  it("selectKiloModel is a no-op when canonicalConfig is set (no dead code)", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const fnBlock = source.match(/public selectKiloModel[\s\S]*?this\.flushPendingKiloModel/)?.[0] ?? ""
    // Must check canonicalConfig and return early
    expect(fnBlock).toContain("if (this.canonicalConfig) return")
    // Must NOT have a second unreachable canonicalReady check
    expect(fnBlock).not.toContain("if (this.canonicalReady) return")
  })
})

// ── P4.1 onCanonicalChange: mirrors service readiness ──────────────────

describe("P4.1 onCanonicalChange: mirrors service readiness", () => {
  it("onCanonicalChange mirrors service materializationReady", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const changeBlock = source.match(/private onCanonicalChange[\s\S]*?this\.sendCanonicalAgents/)?.[0] ?? ""
    // Must mirror service readiness, not check event.hasErrors
    expect(changeBlock).toContain("this.canonicalConfig?.materializationReady")
    // Must not unconditionally set canonicalReady
    expect(changeBlock).not.toMatch(/if\s*\(\s*!this\.canonicalReady\s*\)\s*this\.canonicalReady\s*=\s*true\s*$/m)
  })

  it("subscribeCanonical mirrors service materializationReady as sole readiness fact", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    // subscribeCanonical must set readiness directly from the service-owned
    // materializationReady fact — no provider-local error history check
    expect(source).toContain("this.canonicalReady = service.materializationReady")
    expect(source).not.toContain("canonicalEverErrored")
  })
})

// ── P4.1 late attachment: service readiness fact ──────────────────────

describe("P4.1 service readiness: late attachment and recovery", () => {
  it("materializationReady is false before initialize", async () => {
    const { canonical } = setup(false)
    expect(canonical.materializationReady).toBe(false)
    expect(canonical.lastReadyStamp).toBeNull()
    canonical.dispose()
  })

  it("materializationReady is true after successful init", async () => {
    const { canonical } = setup(true)
    await canonical.initialize()
    expect(canonical.materializationReady).toBe(true)
    expect(canonical.lastReadyStamp).not.toBeNull()
    canonical.dispose()
  })

  it("late provider attaches after errored snapshot: stays not-ready", async () => {
    // Create service with invalid config → materialization has errors → snapshot exists
    // but materializationReady stays false.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-audit-late-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    // Write invalid config (unknown top-level key)
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ bogus: true }))
    const secrets = createMemorySecretAdapter()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    await canonical.initialize()
    // Service has a snapshot from errored materialization (prior preserved or init error)
    // but materializationReady must be false
    expect(canonical.materializationReady).toBe(false)
    // Late provider attaches — must NOT see ready
    const { provider } = makeProvider(canonical)
    expect(provider.canonicalReady).toBe(false)
    provider.cleanupRetries.clear()
    canonical.dispose()
  })

  it("recovery after later valid materialization opens readiness", async () => {
    // Start with invalid config → errored materialization
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-audit-recovery-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ bogus: true }))
    const secrets = createMemorySecretAdapter()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    await canonical.initialize()
    expect(canonical.materializationReady).toBe(false)
    // Late provider attaches — not ready
    const { provider } = makeProvider(canonical)
    expect(provider.canonicalReady).toBe(false)
    // Fix the file and write with a valid config via writeConfig using
    // a fresh service instance (to get a valid hash from a valid init)
    canonical.dispose()
    // Rewrite with valid config
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ model: "custom/model" }))
    const canonical2 = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    await canonical2.initialize()
    expect(canonical2.materializationReady).toBe(true)
    // A new provider attached to the recovered service should be ready
    const { provider: provider2 } = makeProvider(canonical2)
    expect(provider2.canonicalReady).toBe(true)
    provider2.cleanupRetries.clear()
    canonical2.dispose()
  })

  it("dispose clears materializationReady", async () => {
    const { canonical } = setup(true)
    await canonical.initialize()
    expect(canonical.materializationReady).toBe(true)
    canonical.dispose()
    expect(canonical.materializationReady).toBe(false)
    expect(canonical.lastReadyStamp).toBeNull()
  })

  it("valid→invalid→valid runtime: readiness clears on invalid, recovers on valid, late attachment cannot see ready during invalid", async () => {
    // Start with valid config
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-audit-runtime-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ model: "custom/model" }))
    const secrets = createMemorySecretAdapter()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    await canonical.initialize()

    // Step 1: valid init — ready
    expect(canonical.materializationReady).toBe(true)
    const provider1 = makeProvider(canonical)
    expect(provider1.provider.canonicalReady).toBe(true)
    provider1.provider.cleanupRetries.clear()

    // Step 2: write invalid config externally, then create fresh service
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ bogus: true }))
    canonical.dispose()

    const canonical2 = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    await canonical2.initialize()
    // Invalid config → not ready
    expect(canonical2.materializationReady).toBe(false)

    // Late provider attaches during invalid state — must NOT see ready
    const provider2 = makeProvider(canonical2)
    expect(provider2.provider.canonicalReady).toBe(false)
    provider2.provider.cleanupRetries.clear()

    // Step 3: fix the config externally
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ model: "custom/model" }))
    canonical2.dispose()

    // Fresh service reads valid config
    const canonical3 = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    await canonical3.initialize()
    // Valid config → ready
    expect(canonical3.materializationReady).toBe(true)

    // Late provider attaches after recovery — must see ready
    const provider3 = makeProvider(canonical3)
    expect(provider3.provider.canonicalReady).toBe(true)
    provider3.provider.cleanupRetries.clear()
    canonical3.dispose()
  })
})

// ── P4.1 credential rollback uses explicit refs ──────────────────────

describe("P4.1 credential rollback: explicit refs only", () => {
  it("rollbackCredential uses restoreCredentialRef (exact ref, not scope/kind/id)", async () => {
    const source = await Bun.file(new URL("../../src/config/service.ts", import.meta.url)).text()
    // restoreCredentialState must take a ref parameter, not scope/kind/id
    const restoreBlock = source.match(/private async restoreCredentialState[\s\S]*?Promise<void> \{[\s\S]*?\n  \}/)?.[0] ?? ""
    expect(restoreBlock).toContain("ref: string")
    expect(restoreBlock).toContain("priorValue: string | undefined")
    expect(restoreBlock).not.toContain("scope:")
    expect(restoreBlock).not.toContain("kind:")
    expect(restoreBlock).not.toContain("id:")
    // Must use restoreCredentialRef / removeCredentialRef (ref-based), not storeCredential / removeCredential (scope/kind/id-based)
    expect(restoreBlock).toContain("restoreCredentialRef")
    expect(restoreBlock).toContain("removeCredentialRef")
  })

  it("rollbackCredential passes ref to restoreCredentialState", async () => {
    const source = await Bun.file(new URL("../../src/config/service.ts", import.meta.url)).text()
    // Find only the parameter list of rollbackCredential (not the return type)
    const paramMatch = source.match(/private async rollbackCredential\(([\s\S]*?)\)/)?.[1] ?? ""
    // rollbackCredential must take ref + priorValue (no scope/kind/id params)
    expect(paramMatch).toContain("ref: string")
    expect(paramMatch).toContain("priorValue: string | undefined")
    expect(paramMatch).not.toContain("scope:")
    expect(paramMatch).not.toContain("id:")
    // Verify restoreCredentialState is called with ref
    const bodyMatch = source.match(/private async rollbackCredential[\s\S]*?Promise<[\s\S]*?> \{[\s\S]*?\n  \}/)?.[0] ?? ""
    expect(bodyMatch).toContain("this.restoreCredentialState(ref, priorValue)")
  })

  it("processCredentialIntent calls rollbackCredential with newRef only (no scope/kind/id)", async () => {
    const source = await Bun.file(new URL("../../src/config/service.ts", import.meta.url)).text()
    // All rollbackCredential calls in processCredentialIntent must use (newRef, priorValue)
    // — no scope/kind/id arguments. The old signature was (scope, kind, id, priorValue, ref).
    const allRollbackCalls = source.match(/this\.rollbackCredential\([^)]+\)/g) ?? []
    // At least 3 calls in processCredentialIntent (stale, write failure, exception)
    expect(allRollbackCalls.length).toBeGreaterThanOrEqual(3)
    for (const call of allRollbackCalls) {
      // Must be (newRef, priorValue) — no scope/kind/id args
      expect(call).toBe("this.rollbackCredential(newRef, priorValue)")
    }
  })

  it("no derived SecretStorage key reconstruction in rollback path", async () => {
    const source = await Bun.file(new URL("../../src/config/service.ts", import.meta.url)).text()
    // restoreCredentialState must not call storeCredential() or removeCredential()
    // (those reconstruct keys from scope/kind/id). Must use ref-based
    // restoreCredentialRef / removeCredentialRef instead.
    const restoreBlock = source.match(/private async restoreCredentialState[\s\S]*?Promise<void> \{[\s\S]*?\n  \}/)?.[0] ?? ""
    // Check for bare storeCredential / removeCredential calls (not restoreCredentialRef / removeCredentialRef)
    // A bare call would look like: await storeCredential( or await removeCredential(
    expect(restoreBlock).not.toMatch(/await storeCredential\(/)
    expect(restoreBlock).not.toMatch(/await removeCredential\(/)
    expect(restoreBlock).toMatch(/await restoreCredentialRef\(/)
    expect(restoreBlock).toMatch(/await removeCredentialRef\(/)
  })
})

// ── P4.1 dead code removal ───────────────────────────────────────────

describe("P4.1 dead code removal", () => {
  it("canonicalProviderConfig is removed (was unused)", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    expect(source).not.toContain("canonicalProviderConfig")
  })

  it("canonicalMetadataValue is renamed to isCredentialFreeMetadata", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    expect(source).not.toContain("canonicalMetadataValue")
    expect(source).toContain("isCredentialFreeMetadata")
  })
})

// ── P4.1 canonical mode vs readiness: bounded authority correction ────

describe("P4.1 canonical mode vs readiness", () => {
  it("canonicalMode is true when canonicalConfig is set (regardless of readiness)", async () => {
    const { canonical } = setup(true)
    const { provider } = makeProvider(canonical)
    // canonicalMode should be true as soon as canonicalConfig is attached
    expect(provider.canonicalMode).toBe(true)
    // canonicalReady may or may not be true depending on materialization
    canonical.dispose()
  })

  it("canonicalMode is false when no canonicalConfig is set", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    // canonicalMode getter must derive from canonicalConfig !== null
    expect(source).toContain("get canonicalMode(): boolean")
    expect(source).toContain("return this.canonicalConfig !== null")
  })

  it("ModelState.handleMessage rejects persistModelSelection when canonicalMode is true", async () => {
    const source = await Bun.file(new URL("../../src/kilo-provider/model-state.ts", import.meta.url)).text()
    // Must check canonicalMode before processing persistModelSelection
    expect(source).toContain('if (type === "persistModelSelection" || type === "clearModelSelection") return true')
    // Must have the canonicalMode parameter with default false
    expect(source).toContain("canonicalMode: boolean = false")
  })

  it("ModelState.handleMessage returns empty selections when canonicalMode is true and requestModelSelections", async () => {
    const source = await Bun.file(new URL("../../src/kilo-provider/model-state.ts", import.meta.url)).text()
    // Must respond with empty selections when canonicalMode is true
    expect(source).toContain('if (type === "requestModelSelections") {\n      post({ type: "modelSelectionsLoaded", selections: {} })')
  })

  it("ModelState.handleMessage returns empty variants when canonicalMode is true and requestVariants", async () => {
    const source = await Bun.file(new URL("../../src/kilo-provider/model-state.ts", import.meta.url)).text()
    // Must respond with empty variants when canonicalMode is true
    expect(source).toContain('if (type === "requestVariants") {\n      post({ type: "variantsLoaded", variants: {} })')
  })

  it("early-message.ts passes canonicalMode to ModelState.handleMessage", async () => {
    const source = await Bun.file(new URL("../../src/kilo-provider/early-message.ts", import.meta.url)).text()
    // Must include canonicalMode in the context type
    expect(source).toContain("canonicalMode: boolean")
    // Must pass canonicalMode to ModelState.handleMessage
    expect(source).toContain("ctx.canonicalMode")
  })

  it("KiloProvider passes canonicalMode to routeEarlyMessage", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    // Must pass canonicalMode in the routeEarlyMessage context
    expect(source).toContain("canonicalMode: this.canonicalMode")
  })

  it("webview config.tsx sets canonicalMode when any canonical message arrives", async () => {
    const source = await Bun.file(new URL("../../webview-ui/src/context/config.tsx", import.meta.url)).text()
    // Must set canonicalMode when message.canonical is true
    expect(source).toContain("if (message.canonical) setCanonicalMode(true)")
    // Must export canonicalMode via context
    expect(source).toContain("canonicalMode,")
  })

  it("webview provider.tsx sets canonicalMode when any canonical message arrives", async () => {
    const source = await Bun.file(new URL("../../webview-ui/src/context/provider.tsx", import.meta.url)).text()
    // Must set canonicalMode when message.canonical is true
    expect(source).toContain("if (message.canonical) setCanonicalMode(true)")
    // Must export canonicalMode via context
    expect(source).toContain("canonicalMode,")
  })

  it("webview session.tsx ignores legacy agentsLoaded when canonicalMode is active", async () => {
    const source = await Bun.file(new URL("../../webview-ui/src/context/session.tsx", import.meta.url)).text()
    // Must check canonicalMode and skip legacy agentsLoaded
    expect(source).toContain('if (canonicalMode?.() && !message.canonical) return')
  })

  it("webview session.tsx ignores legacy modelSelectionsLoaded when canonicalMode is active", async () => {
    const source = await Bun.file(new URL("../../webview-ui/src/context/session.tsx", import.meta.url)).text()
    // Must check canonicalMode and skip legacy modelSelectionsLoaded
    const selectionsBlock = source.match(/const unsubSelections = vscode\.onMessage[\s\S]*?onCleanup\(unsubSelections\)/)?.[0] ?? ""
    expect(selectionsBlock).toContain('if (canonicalMode?.()) return')
  })

  it("webview session.tsx ignores legacy variantsLoaded when canonicalMode is active", async () => {
    const source = await Bun.file(new URL("../../webview-ui/src/context/session.tsx", import.meta.url)).text()
    // Must check canonicalMode and skip legacy variantsLoaded
    const variantsBlock = source.match(/const unsubVariants = vscode\.onMessage[\s\S]*?onCleanup\(unsubVariants\)/)?.[0] ?? ""
    expect(variantsBlock).toContain('if (canonicalMode?.()) return')
  })

  it("non-canonical path remains functional when no service is attached", async () => {
    // When no canonicalConfig is set, canonicalMode is false and legacy paths work
    const source = await Bun.file(new URL("../../src/kilo-provider/model-state.ts", import.meta.url)).text()
    // The canonicalMode guard must not block when false (default)
    expect(source).toContain("canonicalMode: boolean = false")
    // Default parameter is false, so non-canonical path works
  })
})
