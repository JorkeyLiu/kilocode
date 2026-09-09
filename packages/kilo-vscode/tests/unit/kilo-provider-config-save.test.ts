import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { CanonicalConfigService } from "../../src/config/service"
import { Roots } from "../../src/config/paths"
import { createMemorySecretAdapter } from "../../src/config/secret-adapter"
import { createMemoryStateAdapter } from "../../src/config/state-adapter"
import type { CanonicalStamp } from "../../src/config/types"

const { KiloProvider } = await import("../../src/KiloProvider")

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

type Posted = Record<string, unknown>

type Internals = {
  postMessage: (message: unknown) => void
  handleUpdateConfigMessage: (message: Record<string, unknown>) => Promise<void>
  handleCanonicalConfigUpdate: (
    partial: Record<string, unknown>,
    project: Record<string, unknown>,
    globalUnset: string[][],
    projectUnset: string[][],
    saveID: string | undefined,
    stamp: CanonicalStamp,
  ) => Promise<void>
  fetchAndSendConfig: () => Promise<void>
  fetchAndSendGlobalConfig: () => Promise<void>
  dispose: () => void
  canonicalReady: boolean
}

async function setupCanonical(globalConfig: Record<string, unknown> = { model: "custom/model" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-config-save-"))
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
  return { canonical, global, project }
}

function setupProvider(canonical: CanonicalConfigService | null, calls: string[]) {
  const connection = new KiloConnectionService({} as never)
  ;(connection as unknown as { client: unknown }).client = {
    config: {
      get: async () => {
        calls.push("config.get")
        throw new Error("backend config read must not run")
      },
      transaction: async () => {
        calls.push("config.transaction")
        throw new Error("backend config write must not run")
      },
    },
    global: {
      config: {
        get: async () => {
          calls.push("global.config.get")
          throw new Error("backend global read must not run")
        },
      },
    },
  }
  const provider = new KiloProvider(
    {} as never,
    connection,
    undefined,
    canonical ? { canonicalConfig: canonical } : {},
  )
  const internal = provider as unknown as Internals
  const messages: Posted[] = []
  internal.postMessage = (message) => messages.push(message as Posted)
  return { provider, internal, messages }
}

describe("KiloProvider canonical Settings save", () => {
  it("canonical save writes the file, acks with stamp, and never calls SDK transaction", async () => {
    const { canonical, global } = await setupCanonical()
    const calls: string[] = []
    const { internal, messages } = setupProvider(canonical, calls)

    await internal.handleUpdateConfigMessage({
      type: "updateConfig",
      canonical: true,
      config: { model: "custom/next" },
      projectConfig: {},
      globalUnset: [],
      projectUnset: [],
      saveID: "s1",
      stamp: canonical.stamp,
    })

    expect(calls).toEqual([])
    expect(fs.readFileSync(path.join(global, "kilo.jsonc"), "utf8")).toContain("custom/next")
    const ack = messages.find((m) => m.type === "configUpdated" && m.saveID === "s1")
    expect(ack).toMatchObject({
      type: "configUpdated",
      canonical: true,
      ready: true,
      saveID: "s1",
      diagnostics: [],
      stamp: canonical.stamp,
    })
    expect(ack?.contentHash).toBe(canonical.snapshot?.contentHash)
    expect(ack?.materializationVersion).toBe(canonical.snapshot?.generation)
    internal.dispose()
    canonical.dispose()
  })

  it("not-ready canonical save fails fast with structured not-ready", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-config-save-notready-"))
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
    // Intentionally not initialized: materializationReady stays false.
    const calls: string[] = []
    const { internal, messages } = setupProvider(canonical, calls)

    await internal.handleUpdateConfigMessage({
      type: "updateConfig",
      canonical: true,
      config: { model: "custom/next" },
      saveID: "s1",
      stamp: { globalHash: null, projectHash: null, materializationVersion: 0, assetHash: null },
    })

    expect(calls).toEqual([])
    const failed = messages.find((m) => m.type === "configUpdateFailed")
    expect(failed).toMatchObject({ canonical: true, kind: "not-ready", saveID: "s1" })
    expect(fs.readFileSync(path.join(global, "kilo.jsonc"), "utf8")).toContain("custom/model")
    internal.dispose()
    canonical.dispose()
  })

  it("stale stamp save fails fast with structured stale", async () => {
    const { canonical, global } = await setupCanonical()
    const calls: string[] = []
    const { internal, messages } = setupProvider(canonical, calls)

    await internal.handleUpdateConfigMessage({
      type: "updateConfig",
      canonical: true,
      config: { model: "custom/next" },
      saveID: "s1",
      stamp: { ...canonical.stamp, globalHash: "stale-hash" },
    })

    expect(calls).toEqual([])
    const failed = messages.find((m) => m.type === "configUpdateFailed")
    expect(failed).toMatchObject({ canonical: true, kind: "stale", saveID: "s1" })
    expect(fs.readFileSync(path.join(global, "kilo.jsonc"), "utf8")).toContain("custom/model")
    internal.dispose()
    canonical.dispose()
  })

  it("missing stamp fails fast instead of silently waiting", async () => {
    const { canonical } = await setupCanonical()
    const calls: string[] = []
    const { internal, messages } = setupProvider(canonical, calls)

    await internal.handleUpdateConfigMessage({
      type: "updateConfig",
      canonical: true,
      config: { model: "custom/next" },
      saveID: "s1",
    })

    expect(calls).toEqual([])
    const failed = messages.find((m) => m.type === "configUpdateFailed")
    expect(failed).toMatchObject({ canonical: true, kind: "stale", saveID: "s1" })
    internal.dispose()
    canonical.dispose()
  })

  it("legacy non-canonical updateConfig fails fast and never touches SDK or disk", async () => {
    const { canonical, global } = await setupCanonical()
    const calls: string[] = []
    const { internal, messages } = setupProvider(canonical, calls)

    await internal.handleUpdateConfigMessage({
      type: "updateConfig",
      config: { model: "custom/next" },
      saveID: "legacy-1",
    })

    expect(calls).toEqual([])
    const failed = messages.find((m) => m.type === "configUpdateFailed")
    expect(failed).toMatchObject({ canonical: true, kind: "invalid", saveID: "legacy-1" })
    expect(messages.some((m) => m.type === "configUpdated")).toBe(false)
    expect(fs.readFileSync(path.join(global, "kilo.jsonc"), "utf8")).toContain("custom/model")
    internal.dispose()
    canonical.dispose()
  })

  it("config reads without canonical return explicit empty without SDK competition", async () => {
    const calls: string[] = []
    const { internal, messages } = setupProvider(null, calls)

    await internal.fetchAndSendConfig()
    await internal.fetchAndSendGlobalConfig()

    expect(calls).toEqual([])
    const loaded = messages.find((m) => m.type === "configLoaded")
    expect(loaded).toMatchObject({ config: {}, globalConfig: {}, projectConfig: {} })
    const global = messages.find((m) => m.type === "globalConfigLoaded")
    expect(global).toMatchObject({ config: {} })
    internal.dispose()
  })

describe("KiloProvider canonical nested patch/unset", () => {
  it("patches one nested permission leaf and keeps siblings", async () => {
    const { canonical, global } = await setupCanonical({
      model: "custom/model",
      permission: { read: "allow", bash: "ask" },
    })
    const calls: string[] = []
    const { internal, messages } = setupProvider(canonical, calls)
    const seen: unknown[] = []
    const sub = canonical.onDidChange((event) => seen.push(event))

    await internal.handleUpdateConfigMessage({
      type: "updateConfig",
      canonical: true,
      config: { permission: { bash: "deny" } },
      projectConfig: {},
      globalUnset: [],
      projectUnset: [],
      saveID: "nested-1",
      stamp: canonical.stamp,
    })

    expect(calls).toEqual([])
    const file = JSON.parse(fs.readFileSync(path.join(global, "kilo.jsonc"), "utf8"))
    expect(file.permission).toEqual({ read: "allow", bash: "deny" })
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "configUpdated", canonical: true, ready: true, saveID: "nested-1" }),
    )
    expect(seen.some((event) => (event as { source?: string }).source === "gui")).toBe(true)
    expect(internal.canonicalReady).toBe(true)
    sub.dispose()
    internal.dispose()
    canonical.dispose()
  })

  it("nested unset deletes only the targeted leaf", async () => {
    const { canonical, global } = await setupCanonical({
      model: "custom/model",
      permission: { read: "allow", bash: "ask" },
    })
    const calls: string[] = []
    const { internal } = setupProvider(canonical, calls)

    await internal.handleUpdateConfigMessage({
      type: "updateConfig",
      canonical: true,
      config: {},
      projectConfig: {},
      globalUnset: [["permission", "bash"]],
      projectUnset: [],
      saveID: "nested-2",
      stamp: canonical.stamp,
    })

    const file = JSON.parse(fs.readFileSync(path.join(global, "kilo.jsonc"), "utf8"))
    expect(file.permission).toEqual({ read: "allow" })
    internal.dispose()
    canonical.dispose()
  })

  it("nested keyed-map patch preserves other variants and replaces arrays wholesale", async () => {
    const { canonical, global } = await setupCanonical({
      model: "custom/model",
      model_variant_overrides: { "openai/gpt-4": "thinking", "anthropic/claude": "default" },
      instructions: ["a"],
    })
    const calls: string[] = []
    const { internal } = setupProvider(canonical, calls)

    await internal.handleUpdateConfigMessage({
      type: "updateConfig",
      canonical: true,
      config: {
        model_variant_overrides: { "openai/gpt-4": "fast" },
        instructions: ["b", "c"],
      },
      projectConfig: {},
      globalUnset: [["model_variant_overrides", "anthropic/claude"]],
      projectUnset: [],
      saveID: "nested-3",
      stamp: canonical.stamp,
    })

    const file = JSON.parse(fs.readFileSync(path.join(global, "kilo.jsonc"), "utf8"))
    expect(file.model_variant_overrides).toEqual({ "openai/gpt-4": "fast" })
    expect(file.instructions).toEqual(["b", "c"])
    internal.dispose()
    canonical.dispose()
  })

  it("project patch leaves the global file untouched and vice versa", async () => {
    const { canonical, global, project } = await setupCanonical({
      model: "custom/model",
      permission: { read: "allow", bash: "ask" },
    })
    const calls: string[] = []
    const { internal } = setupProvider(canonical, calls)

    await internal.handleUpdateConfigMessage({
      type: "updateConfig",
      canonical: true,
      config: {},
      projectConfig: { permission: { bash: "deny" } },
      globalUnset: [],
      projectUnset: [],
      saveID: "nested-4",
      stamp: canonical.stamp,
    })

    const globalFile = JSON.parse(fs.readFileSync(path.join(global, "kilo.jsonc"), "utf8"))
    expect(globalFile.permission).toEqual({ read: "allow", bash: "ask" })
    const projectFile = JSON.parse(
      fs.readFileSync(path.join(project, ".kilo", "kilo.jsonc"), "utf8"),
    )
    expect(projectFile.permission).toEqual({ bash: "deny" })
    internal.dispose()
    canonical.dispose()
  })

  it("stale stamp never writes nested changes", async () => {
    const { canonical, global } = await setupCanonical({
      model: "custom/model",
      permission: { read: "allow", bash: "ask" },
    })
    const calls: string[] = []
    const { internal, messages } = setupProvider(canonical, calls)

    await internal.handleUpdateConfigMessage({
      type: "updateConfig",
      canonical: true,
      config: { permission: { bash: "deny" } },
      projectConfig: {},
      globalUnset: [["permission", "read"]],
      projectUnset: [],
      saveID: "nested-stale",
      stamp: { ...canonical.stamp, globalHash: "stale-hash" },
    })

    expect(messages).toContainEqual(
      expect.objectContaining({ type: "configUpdateFailed", canonical: true, kind: "stale" }),
    )
    const file = JSON.parse(fs.readFileSync(path.join(global, "kilo.jsonc"), "utf8"))
    expect(file.permission).toEqual({ read: "allow", bash: "ask" })
    internal.dispose()
    canonical.dispose()
  })
})

describe("KiloProvider canonical Settings surface", () => {
  it("exposes no legacy transaction/reconcile surface", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    expect(source).not.toContain("client.config.transaction")
    expect(source).not.toContain("private async handleUpdateConfig(")
    expect(source).not.toContain("private queueReconcile")
    expect(source).not.toContain("private async reconcileConfig")
    expect(source).not.toContain("scheduleReconcileRetry")
    expect(source).not.toContain("cancelReconcileRetry")
    expect(source).not.toContain("private reconcileGuard")
    expect(source).not.toContain("private configGuard")
    expect(source).not.toContain("private postConfigFailure")
    expect(source).not.toContain("LegacyUpdateConfigMessage")
  })
})
})
