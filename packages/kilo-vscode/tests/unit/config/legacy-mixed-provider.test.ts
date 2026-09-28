import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { Roots } from "../../../src/config/paths"
import { createMemorySecretAdapter } from "../../../src/config/secret-adapter"
import { createMemoryStateAdapter, createMemoryEmitterFactory } from "../../../src/config/state-adapter"
import { CanonicalConfigService } from "../../../src/config/service"
import { resetVersion } from "../../../src/config/materialize"
import { validateConfig } from "../../../src/config/validate"
import { parseJsonc } from "../../../src/config/parse"
import { isLegacyInertProviderEntry, partitionProviderRecord } from "../../../src/config/types"
import { buildProviderIndex } from "../../../src/config/selectors"
import { snapshot as makeSnapshot } from "../../../src/config/snapshot"

let tmp: string
let globalRoot: string
let projectRoot: string

beforeEach(() => {
  resetVersion()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-mixed-"))
  globalRoot = path.join(tmp, "global")
  projectRoot = path.join(tmp, "workspace")
  fs.mkdirSync(globalRoot, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, ".kilo"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function svc(): CanonicalConfigService {
  return new CanonicalConfigService({ secrets: createMemorySecretAdapter() } as never, {
    roots: new Roots(projectRoot, globalRoot),
    secretAdapter: createMemorySecretAdapter(),
    globalState: createMemoryStateAdapter(),
    workspaceState: createMemoryStateAdapter(),
    emitterFactory: createMemoryEmitterFactory(),
  })
}

// Real old-style credentialless entry: pure npm/api/options without any
// plaintext credential. Entries carrying apiKey/options.apiKey/
// headers.Authorization stay invalid (see validate.test.ts) and are never
// silently preserved.
const LEGACY = {
  name: "Legacy",
  npm: "@ai-sdk/openai-compatible",
  api: "https://legacy.test/v1",
  models: { m: { name: "M" } },
  options: { baseURL: "https://legacy.test/v1" },
}

const CUSTOM = {
  name: "Custom",
  endpoint: "https://api.example.com/v1",
  protocol: "openai/completions",
  models: { m1: { name: "M1" } },
}

describe("legacy-inert partitioning", () => {
  it("classifies pure npm/api without definitive signal as legacy", () => {
    expect(isLegacyInertProviderEntry(LEGACY)).toBe(true)
    expect(isLegacyInertProviderEntry(CUSTOM)).toBe(false)
    expect(isLegacyInertProviderEntry({ ...CUSTOM, npm: "@ai-sdk/openai" })).toBe(false)
    expect(isLegacyInertProviderEntry({ apiKey: "sk-x" })).toBe(false)
    expect(isLegacyInertProviderEntry({ name: "Minimal" })).toBe(false)
  })

  it("partitions mixed provider maps", () => {
    const part = partitionProviderRecord({ legacy: LEGACY, custom: CUSTOM })
    expect(Object.keys(part.canonical)).toEqual(["custom"])
    expect(Object.keys(part.legacy)).toEqual(["legacy"])
  })
})

describe("cold-start mixed files", () => {
  it("materializes canonical custom while legacy stays inert", async () => {
    fs.writeFileSync(
      path.join(globalRoot, "kilo.jsonc"),
      JSON.stringify({ provider: { legacy: LEGACY, custom: CUSTOM } }, null, 2),
      "utf-8",
    )
    const service = svc()
    await service.initialize()
    expect(service.materializationReady).toBe(true)
    const snap = service.snapshot!
    const providers = snap.config.value.provider as Record<string, unknown>
    expect(Object.keys(providers)).toEqual(["custom"])
    expect(providers.custom).toMatchObject({ endpoint: CUSTOM.endpoint })
    const index = service.providerIndex ?? service.buildProviderIndex(null)
    expect(index!.providers.map((p) => p.id)).toEqual(["custom"])
    service.dispose()
  })

  it("cross-scope legacy same ID does not block canonical", async () => {
    fs.writeFileSync(
      path.join(globalRoot, "kilo.jsonc"),
      JSON.stringify({ provider: { same: LEGACY } }, null, 2),
      "utf-8",
    )
    fs.writeFileSync(
      path.join(projectRoot, ".kilo", "kilo.jsonc"),
      JSON.stringify({ provider: { same: CUSTOM } }, null, 2),
      "utf-8",
    )
    const service = svc()
    await service.initialize()
    expect(service.materializationReady).toBe(true)
    const providers = service.snapshot!.config.value.provider as Record<string, unknown>
    expect(Object.keys(providers)).toEqual(["same"])
    expect((providers.same as Record<string, unknown>).endpoint).toBe(CUSTOM.endpoint)
    service.dispose()
  })

  it("canonical-canonical same ID still conflicts", async () => {
    fs.writeFileSync(
      path.join(globalRoot, "kilo.jsonc"),
      JSON.stringify({ provider: { dup: CUSTOM } }, null, 2),
      "utf-8",
    )
    fs.writeFileSync(
      path.join(projectRoot, ".kilo", "kilo.jsonc"),
      JSON.stringify({ provider: { dup: CUSTOM } }, null, 2),
      "utf-8",
    )
    const service = svc()
    await service.initialize()
    expect(service.materializationReady).toBe(false)
    service.dispose()
  })

  it("malformed hybrid still rejects cold start", async () => {
    fs.writeFileSync(
      path.join(globalRoot, "kilo.jsonc"),
      JSON.stringify({ provider: { hybrid: { ...CUSTOM, npm: "@ai-sdk/openai" } } }, null, 2),
      "utf-8",
    )
    const service = svc()
    await service.initialize()
    expect(service.materializationReady).toBe(false)
    service.dispose()
  })
})

describe("canonical writes preserve legacy bytes (real host path)", () => {
  // Behavior regression through the real KiloProvider canonical handler +
  // CanonicalConfigService: no hand-rolled merge in the test. Each action
  // goes through handleCanonicalProviderAction and the on-disk legacy entry
  // must survive verbatim.
  it("saveCustomProvider alongside legacy preserves legacy verbatim", async () => {
    const file = path.join(globalRoot, "kilo.jsonc")
    fs.writeFileSync(file, JSON.stringify({ provider: { legacy: LEGACY } }, null, 2), "utf-8")
    const service = svc()
    await service.initialize()
    expect(service.materializationReady).toBe(true)
    const { KiloProvider } = await import("../../../src/KiloProvider")
    const { KiloConnectionService } = await import("../../../src/services/cli-backend/connection-service")
    const connection = new KiloConnectionService({} as never)
    const host = new KiloProvider({} as never, connection, undefined, { canonicalConfig: service }) as unknown as {
      handleCanonicalProviderAction: (msg: Record<string, unknown>) => Promise<void>
      postMessage: (m: unknown) => void
      dispose: () => void
    }
    const messages: unknown[] = []
    host.postMessage = (m) => messages.push(m)
    await host.handleCanonicalProviderAction({
      type: "saveCustomProvider",
      providerID: "custom",
      requestId: "r-legacy-save",
      canonical: true,
      stamp: service.stamp,
      config: CUSTOM,
    })
    const connected = messages.find((m) => (m as Record<string, unknown>).type === "providerConnected")
    expect(connected).toBeDefined()
    const after = parseJsonc(fs.readFileSync(file, "utf-8"))
    if (!after.ok) throw new Error("parse failed")
    const providers = after.value.provider as Record<string, unknown>
    expect(providers.legacy).toEqual(LEGACY)
    expect(providers.custom).toMatchObject({ endpoint: CUSTOM.endpoint })
    host.dispose()
    service.dispose()
  })

  it("deleteCustomProvider removes only the custom entry, legacy stays", async () => {
    const file = path.join(globalRoot, "kilo.jsonc")
    fs.writeFileSync(file, JSON.stringify({ provider: { legacy: LEGACY, custom: CUSTOM } }, null, 2), "utf-8")
    const service = svc()
    await service.initialize()
    expect(service.materializationReady).toBe(true)
    const { KiloProvider } = await import("../../../src/KiloProvider")
    const { KiloConnectionService } = await import("../../../src/services/cli-backend/connection-service")
    const connection = new KiloConnectionService({} as never)
    const host = new KiloProvider({} as never, connection, undefined, { canonicalConfig: service }) as unknown as {
      handleCanonicalProviderAction: (msg: Record<string, unknown>) => Promise<void>
      postMessage: (m: unknown) => void
      dispose: () => void
    }
    const messages: unknown[] = []
    host.postMessage = (m) => messages.push(m)
    await host.handleCanonicalProviderAction({
      type: "deleteCustomProvider",
      providerID: "custom",
      requestId: "r-legacy-delete",
      canonical: true,
      stamp: service.stamp,
    })
    const deleted = messages.find((m) => (m as Record<string, unknown>).type === "providerDeleted")
    expect(deleted).toBeDefined()
    const after = parseJsonc(fs.readFileSync(file, "utf-8"))
    if (!after.ok) throw new Error("parse failed")
    const providers = after.value.provider as Record<string, unknown>
    expect(providers.legacy).toEqual(LEGACY)
    expect("custom" in providers).toBe(false)
    host.dispose()
    service.dispose()
  })

  it("cross-scope legacy same ID: edit targets canonical scope, other raw legacy unchanged", async () => {
    const globalFile = path.join(globalRoot, "kilo.jsonc")
    const projectFile = path.join(projectRoot, ".kilo", "kilo.jsonc")
    fs.writeFileSync(globalFile, JSON.stringify({ provider: { same: LEGACY } }, null, 2), "utf-8")
    fs.writeFileSync(projectFile, JSON.stringify({ provider: { same: CUSTOM } }, null, 2), "utf-8")
    const service = svc()
    await service.initialize()
    expect(service.materializationReady).toBe(true)
    const { KiloProvider } = await import("../../../src/KiloProvider")
    const { KiloConnectionService } = await import("../../../src/services/cli-backend/connection-service")
    const connection = new KiloConnectionService({} as never)
    const host = new KiloProvider({} as never, connection, undefined, { canonicalConfig: service }) as unknown as {
      handleCanonicalProviderAction: (msg: Record<string, unknown>) => Promise<void>
      postMessage: (m: unknown) => void
      dispose: () => void
    }
    const messages: unknown[] = []
    host.postMessage = (m) => messages.push(m)
    const edited = { ...CUSTOM, name: "Edited" }
    await host.handleCanonicalProviderAction({
      type: "saveCustomProvider",
      providerID: "same",
      requestId: "r-cross-save",
      canonical: true,
      stamp: service.stamp,
      config: edited,
    })
    const connected = messages.find((m) => (m as Record<string, unknown>).type === "providerConnected")
    expect(connected).toBeDefined()
    const globalAfter = parseJsonc(fs.readFileSync(globalFile, "utf-8"))
    if (!globalAfter.ok) throw new Error("parse failed")
    expect((globalAfter.value.provider as Record<string, unknown>).same).toEqual(LEGACY)
    const projectAfter = parseJsonc(fs.readFileSync(projectFile, "utf-8"))
    if (!projectAfter.ok) throw new Error("parse failed")
    expect((projectAfter.value.provider as Record<string, unknown>).same).toMatchObject({ name: "Edited" })
    host.dispose()
    service.dispose()
  })

  it("save over a configured non-custom ID fails without writing", async () => {
    const file = path.join(globalRoot, "kilo.jsonc")
    fs.writeFileSync(file, JSON.stringify({ provider: { plain: { name: "Plain" } } }, null, 2), "utf-8")
    const service = svc()
    await service.initialize()
    expect(service.materializationReady).toBe(true)
    const before = fs.readFileSync(file, "utf-8")
    const { KiloProvider } = await import("../../../src/KiloProvider")
    const { KiloConnectionService } = await import("../../../src/services/cli-backend/connection-service")
    const connection = new KiloConnectionService({} as never)
    const host = new KiloProvider({} as never, connection, undefined, { canonicalConfig: service }) as unknown as {
      handleCanonicalProviderAction: (msg: Record<string, unknown>) => Promise<void>
      postMessage: (m: unknown) => void
      dispose: () => void
    }
    const messages: unknown[] = []
    host.postMessage = (m) => messages.push(m)
    await host.handleCanonicalProviderAction({
      type: "saveCustomProvider",
      providerID: "plain",
      requestId: "r-noncustom-save",
      canonical: true,
      stamp: service.stamp,
      config: CUSTOM,
    })
    const err = messages.find((m) => (m as Record<string, unknown>).type === "providerActionError") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect(err!.kind).toBe("unsupported")
    expect(fs.readFileSync(file, "utf-8")).toBe(before)
    host.dispose()
    service.dispose()
  })

  it("external edit CAS still conflicts", async () => {
    const file = path.join(globalRoot, "kilo.jsonc")
    fs.writeFileSync(file, JSON.stringify({ provider: { custom: CUSTOM } }, null, 2), "utf-8")
    const service = svc()
    await service.initialize()
    const hash = service.getConfigHash("global")!
    fs.writeFileSync(file, JSON.stringify({ provider: { custom: CUSTOM }, model: "anthropic/m" }, null, 2), "utf-8")
    const result = await service.writeConfig("global", { provider: { custom: CUSTOM } }, hash)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe("stale")
    service.dispose()
  })
})

describe("selector index excludes legacy", () => {
  it("buildProviderIndex contains only canonical IDs", () => {
    const validation = validateConfig(JSON.stringify({ provider: { legacy: LEGACY, custom: CUSTOM } }), "global", "test")
    expect(validation.valid).toBe(true)
    const snap = makeSnapshot({ value: validation.parsed!, fields: [], contentHash: "h", version: 1, provenance: {}, schemaVersion: 1 })
    const index = buildProviderIndex(snap, null)
    expect(index.providers.map((p) => p.id)).toEqual(["custom"])
  })
})
