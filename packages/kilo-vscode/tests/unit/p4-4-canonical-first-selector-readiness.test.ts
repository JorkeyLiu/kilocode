import { describe, expect, it, afterEach } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { CanonicalConfigService } from "../../src/config/service"
import { Roots } from "../../src/config/paths"
import { createMemorySecretAdapter } from "../../src/config/secret-adapter"
import { createMemoryStateAdapter } from "../../src/config/state-adapter"

const { KiloProvider } = await import("../../src/KiloProvider")

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function makeCanonical(): CanonicalConfigService {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-p44-t22-"))
  dirs.push(root)
  const global = path.join(root, "global")
  const project = path.join(root, "project")
  fs.mkdirSync(global, { recursive: true })
  fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
  fs.writeFileSync(
    path.join(global, "kilo.jsonc"),
    JSON.stringify({
      model: "custom/model",
      provider: { custom: { name: "Custom", endpoint: "https://example.com" } },
    }),
  )
  fs.writeFileSync(path.join(project, ".kilo", "kilo.jsonc"), JSON.stringify({}))
  const secrets = createMemorySecretAdapter()
  const svc = new CanonicalConfigService({ secrets } as never, {
    roots: new Roots(project, global),
    secretAdapter: secrets,
    globalState: createMemoryStateAdapter(),
    workspaceState: createMemoryStateAdapter(),
  })
  return svc
}

describe("P4.4-T22 canonical-first selector readiness decoupling", () => {
  it("canonical providers publish while backend connection remains unresolved (client null)", async () => {
    const svc = makeCanonical()
    await svc.initialize()
    expect(svc.materializationReady).toBe(true)
    const conn = new KiloConnectionService({} as never)
    // Keep client null to simulate unresolved connection
    const provider = new KiloProvider({} as never, conn as never, undefined, { canonicalConfig: svc } as never)
    const internal = provider as unknown as {
      fetchAndSendProviders: () => Promise<void>
      fetchAndSendAgents: () => Promise<void>
      fetchAndSendConfig: () => Promise<void>
      postMessage: (m: unknown) => void
      isWebviewReady: boolean
    }
    const msgs: unknown[] = []
    internal.postMessage = (m) => msgs.push(m)
    internal.isWebviewReady = true

    await internal.fetchAndSendProviders()
    const prov = msgs.find((m) => (m as Record<string, unknown>).type === "providersLoaded") as
      | Record<string, unknown>
      | undefined
    expect(prov).toBeDefined()
    expect(prov!.canonical).toBe(true)
    expect(prov!.ready).toBe(true)

    msgs.length = 0
    await internal.fetchAndSendAgents()
    const agents = msgs.find((m) => (m as Record<string, unknown>).type === "agentsLoaded") as
      | Record<string, unknown>
      | undefined
    expect(agents).toBeDefined()
    expect(agents!.canonical).toBe(true)
    expect(agents!.ready).toBe(true)

    msgs.length = 0
    await internal.fetchAndSendConfig()
    const cfg = msgs.find((m) => (m as Record<string, unknown>).type === "configLoaded") as
      | Record<string, unknown>
      | undefined
    expect(cfg).toBeDefined()
    expect(cfg!.canonical).toBe(true)
    expect(cfg!.ready).toBe(true)

    provider.dispose()
    svc.dispose()
  })

  it("canonical providers publish after failed connection (error state) preserves last-known valid", async () => {
    const svc = makeCanonical()
    await svc.initialize()
    const conn = new KiloConnectionService({} as never)
    // Simulate failed connection: state error, no client
    ;(conn as unknown as { state: string }).state = "error"
    const provider = new KiloProvider({} as never, conn as never, undefined, { canonicalConfig: svc } as never)
    const internal = provider as unknown as {
      fetchAndSendProviders: () => Promise<void>
      postMessage: (m: unknown) => void
      isWebviewReady: boolean
    }
    const msgs: unknown[] = []
    internal.postMessage = (m) => msgs.push(m)
    internal.isWebviewReady = true
    await internal.fetchAndSendProviders()
    const first = msgs.find((m) => (m as Record<string, unknown>).type === "providersLoaded") as
      | Record<string, unknown>
      | undefined
    expect(first).toBeDefined()
    expect(first!.canonical).toBe(true)
    // Second reconcile should preserve valid state, not blank
    msgs.length = 0
    await internal.fetchAndSendProviders()
    const second = msgs.find((m) => (m as Record<string, unknown>).type === "providersLoaded") as
      | Record<string, unknown>
      | undefined
    expect(second).toBeDefined()
    expect(second!.providers as Record<string, unknown>).toEqual(first!.providers)
    provider.dispose()
    svc.dispose()
  })

  it("webviewReady publishes canonical selectors without waiting for connection (initializeConnection hanging)", async () => {
    const svc = makeCanonical()
    await svc.initialize()
    const conn = new KiloConnectionService({} as never)
    // Make connect hang forever
    ;(conn as unknown as { connect: () => Promise<void> }).connect = () => new Promise(() => {})
    const provider = new KiloProvider({} as never, conn as never, undefined, { canonicalConfig: svc } as never)
    const internal = provider as unknown as {
      postMessage: (m: unknown) => void
      isWebviewReady: boolean
      initializeConnection: () => Promise<void>
      sendCanonicalProviders: () => Promise<void>
    }
    const msgs: unknown[] = []
    internal.postMessage = (m) => msgs.push(m)
    // Start initializeConnection (will hang on connect)
    const init = (provider as unknown as { initializeConnection: () => Promise<void> }).initializeConnection()
    // Give it a tick to enter hanging state
    await new Promise((r) => setTimeout(r, 10))
    // Simulate webviewReady arriving while connect still hanging
    internal.isWebviewReady = true
    // Directly invoke the webviewReady canonical publish path (as setupWebviewMessageHandler does after fix)
    ;(provider as unknown as { sendCanonicalConfig: (t: string) => void }).sendCanonicalConfig("configLoaded")
    await (provider as unknown as { sendCanonicalProviders: () => Promise<void> }).sendCanonicalProviders()
    await (provider as unknown as { sendCanonicalAgents: () => Promise<void> }).sendCanonicalAgents()
    const prov = msgs.find((m) => (m as Record<string, unknown>).type === "providersLoaded")
    expect(prov).toBeDefined()
    expect((prov as Record<string, unknown>).canonical).toBe(true)
    // Do not await init (it hangs); just dispose
    provider.dispose()
    svc.dispose()
    // Prevent unhandled hang
    void init.catch(() => {})
  })

  it("webview provider/config/agent contexts no longer depend on global extensionDataReady", async () => {
    const providerSrc = await Bun.file(new URL("../../webview-ui/src/context/provider.tsx", import.meta.url)).text()
    const configSrc = await Bun.file(new URL("../../webview-ui/src/context/config.tsx", import.meta.url)).text()
    const sessionSrc = await Bun.file(new URL("../../webview-ui/src/context/session.tsx", import.meta.url)).text()
    // provider and config should not subscribe to extensionDataReady for retry (canonical-first)
    // Check there is no onMessage handler for extensionDataReady that retries providers/config
    expect(providerSrc.match(/extensionDataReady/g)?.length ?? 0).toBe(0)
    expect(configSrc.match(/extensionDataReady/g)?.length ?? 0).toBe(0)
    // session should not retry agents on extensionDataReady, only MCP retains it
    const sessionReadyBlock = sessionSrc.match(/unsubReady[\s\S]*?onCleanup/)?.[0] ?? ""
    expect(sessionReadyBlock).not.toContain("requestAgents")
    expect(sessionReadyBlock).toContain("requestMcpStatus")
    expect(sessionReadyBlock).toContain("extensionDataReady")
  })

  it("noncanonical fallback still uses SDK bridge (code path retains generated-SDK fetch)", async () => {
    const src = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    // Noncanonical branch must still call fetchProviderData / SDK-based fetches
    expect(src).toContain("fetchProviderData")
    expect(src).toContain("app.agents")
    expect(src).toContain("config.get")
    // extensionDataReady must still be posted for SDK-only consumers (skills/commands/MCP)
    expect(src).toContain('type: "extensionDataReady"')
    expect(src).toContain("fetchAndSendSkills")
    expect(src).toContain("fetchAndSendCommands")
  })

  it("KiloProvider webviewReady publishes canonical before syncWebviewState", async () => {
    const src = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const block = src.match(/case "webviewReady":[\s\S]*?break/)?.[0] ?? ""
    expect(block).toContain("sendCanonicalConfig")
    expect(block).toContain("await this.syncWebviewState")
    // Ensure canonical publish appears before the awaited syncWebviewState
    const canonIdx = block.indexOf("sendCanonicalConfig")
    const syncIdx = block.indexOf("await this.syncWebviewState")
    expect(canonIdx).toBeGreaterThan(-1)
    expect(syncIdx).toBeGreaterThan(-1)
    expect(canonIdx).toBeLessThan(syncIdx)
    expect(block).toContain("P4.4-T22")
  })

  it("KiloProvider doInitializeConnection decouples canonical fetches from extensionDataReady barrier", async () => {
    const src = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const block = src.match(/p0Stage\("dataReady\.start"\)[\s\S]*?p0Stage\("dataReady\.done"\)/)?.[0] ?? ""
    expect(block).toContain("if (this.canonicalConfig)")
    expect(block).toContain("void Promise.all")
    expect(block).toContain("fetchAndSendProviders")
    expect(block).toContain("fetchAndSendAgents")
    expect(block).toContain("fetchAndSendConfig")
    expect(block).toContain('type: "extensionDataReady"')
    // extensionDataReady must be posted in both branches (canonical and noncanonical)
    expect(block.match(/extensionDataReady/g)!.length).toBe(1)
  })

  it("audit correction: stale canonical provider publish discarded after disposal/materialization/webview lifecycle change", async () => {
    const src = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const block = src.match(/private async sendCanonicalProviders[\s\S]*?this\.cachedProvidersMessage = message/)?.[0] ?? ""
    expect(block).toContain("capturedService")
    expect(block).toContain("capturedStamp")
    expect(block).toContain("capturedReady")
    expect(block).toContain("capturedDisposed")
    expect(block).toContain("capturedWebviewReady")
    expect(block).toContain("sameStamp(capturedStamp")
    expect(block).toContain("this.canonicalConfig !== capturedService")
    expect(block).toContain("this.isWebviewReady !== capturedWebviewReady")
    expect(block).toContain("this.disposed")
  })

  it("audit correction: stale provider publish is actually discarded when service is replaced mid-flight", async () => {
    const svc = makeCanonical()
    await svc.initialize()
    const conn = new KiloConnectionService({} as never)
    const provider = new KiloProvider({} as never, conn as never, undefined, { canonicalConfig: svc } as never)
    const internal = provider as unknown as {
      sendCanonicalProviders: () => Promise<void>
      postMessage: (m: unknown) => void
      isWebviewReady: boolean
      cachedProvidersMessage: unknown
    }
    const msgs: unknown[] = []
    internal.postMessage = (m) => msgs.push(m)
    internal.isWebviewReady = true
    // Delay the async index work to create a window for lifecycle change
    const orig = svc.buildProviderIndexAsync.bind(svc)
    let delayed = false
    svc.buildProviderIndexAsync = async (arg) => {
      delayed = true
      await new Promise((r) => setTimeout(r, 60))
      return orig(arg)
    }
    const promise = internal.sendCanonicalProviders()
    await new Promise((r) => setTimeout(r, 10))
    expect(delayed).toBe(true)
    // Simulate service replacement during async work
    const svc2 = makeCanonical()
    await svc2.initialize()
    ;(provider as unknown as { canonicalConfig: unknown }).canonicalConfig = svc2
    // Also flip readiness to simulate materialization change
    await promise
    // The stale svc result must not have been cached or posted as canonical ready with old data
    // No new providersLoaded from the stale svc should appear after replacement
    const stale = msgs.filter((m) => (m as Record<string, unknown>).type === "providersLoaded" && (m as Record<string, unknown>).canonical === true && (m as Record<string, unknown>).ready === true)
    // The stale publish should have been discarded, so zero stale posts during replacement window
    // (the only allowed publish is from the new service via subscription, not the stale promise)
    expect(stale.length).toBe(0)
    // Fresh publish after replacement should succeed
    msgs.length = 0
    const internal2 = provider as unknown as { sendCanonicalProviders: () => Promise<void>; isWebviewReady: boolean }
    internal2.isWebviewReady = true
    // Restore normal behavior for svc2
    await internal2.sendCanonicalProviders()
    const fresh = msgs.find((m) => (m as Record<string, unknown>).type === "providersLoaded" && (m as Record<string, unknown>).canonical === true)
    expect(fresh).toBeDefined()
    provider.dispose()
    svc.dispose()
    svc2.dispose()
  })

  it("audit correction: stale provider publish discarded after disposal mid-flight", async () => {
    const svc = makeCanonical()
    await svc.initialize()
    const conn = new KiloConnectionService({} as never)
    const provider = new KiloProvider({} as never, conn as never, undefined, { canonicalConfig: svc } as never)
    const internal = provider as unknown as {
      sendCanonicalProviders: () => Promise<void>
      postMessage: (m: unknown) => void
      isWebviewReady: boolean
      disposed: boolean
    }
    const msgs: unknown[] = []
    internal.postMessage = (m) => msgs.push(m)
    internal.isWebviewReady = true
    const orig = svc.buildProviderIndexAsync.bind(svc)
    svc.buildProviderIndexAsync = async (arg) => {
      await new Promise((r) => setTimeout(r, 50))
      return orig(arg)
    }
    const promise = internal.sendCanonicalProviders()
    await new Promise((r) => setTimeout(r, 10))
    provider.dispose()
    await promise
    // After disposal, the stale publish must not post providersLoaded
    const stale = msgs.filter((m) => (m as Record<string, unknown>).type === "providersLoaded")
    expect(stale.length).toBe(0)
    svc.dispose()
  })

  it("audit correction: stale provider publish discarded after webview becomes not ready", async () => {
    const svc = makeCanonical()
    await svc.initialize()
    const conn = new KiloConnectionService({} as never)
    const provider = new KiloProvider({} as never, conn as never, undefined, { canonicalConfig: svc } as never)
    const internal = provider as unknown as {
      sendCanonicalProviders: () => Promise<void>
      postMessage: (m: unknown) => void
      isWebviewReady: boolean
    }
    const msgs: unknown[] = []
    internal.postMessage = (m) => msgs.push(m)
    internal.isWebviewReady = true
    const orig = svc.buildProviderIndexAsync.bind(svc)
    svc.buildProviderIndexAsync = async (arg) => {
      await new Promise((r) => setTimeout(r, 50))
      return orig(arg)
    }
    const promise = internal.sendCanonicalProviders()
    await new Promise((r) => setTimeout(r, 10))
    internal.isWebviewReady = false
    await promise
    const stale = msgs.filter((m) => (m as Record<string, unknown>).type === "providersLoaded")
    expect(stale.length).toBe(0)
    provider.dispose()
    svc.dispose()
  })

  it("audit correction: session separates agent and MCP fallback timers so dataReady does not cancel agent retry", async () => {
    const src = await Bun.file(new URL("../../webview-ui/src/context/session.tsx", import.meta.url)).text()
    expect(src).toContain("agentFallback")
    expect(src).toContain("mcpFallback")
    // extensionDataReady handler must clear only mcpFallback, not agentFallback
    const readyHandler = src.match(/const unsubReady[\s\S]*?clearTimeout\(mcpFallback\)[\s\S]*?}\)/)?.[0] ?? ""
    expect(readyHandler).toContain("clearTimeout(mcpFallback)")
    expect(readyHandler).not.toContain("clearTimeout(agentFallback)")
    // Cleanup must clear both timers
    const cleanup = src.match(/onCleanup\(\(\) => \{[\s\S]*?clearTimeout\(agentFallback\)[\s\S]*?clearTimeout\(mcpFallback\)[\s\S]*?\}\)/)?.[0] ?? ""
    expect(cleanup).toContain("clearTimeout(agentFallback)")
    expect(cleanup).toContain("clearTimeout(mcpFallback)")
    // Verify fallback definitions are separate
    expect(src).toContain("if (agents().length === 0) vscode.postMessage({ type: \"requestAgents\" })")
    expect(src).toContain("if (Object.keys(mcpStatus()).length === 0) vscode.postMessage({ type: \"requestMcpStatus\" })")
    // Ensure the shared fallback variable no longer exists
    expect(src).not.toMatch(/\n\s*const fallback = setTimeout/)
  })

  it("audit correction: stale provider publish discarded when service clears materializationReady mid-flight (active fence)", async () => {
    const svc = makeCanonical()
    await svc.initialize()
    expect(svc.materializationReady).toBe(true)
    const conn = new KiloConnectionService({} as never)
    const provider = new KiloProvider({} as never, conn as never, undefined, { canonicalConfig: svc } as never)
    const internal = provider as unknown as {
      sendCanonicalProviders: () => Promise<void>
      postMessage: (m: unknown) => void
      isWebviewReady: boolean
      cachedProvidersMessage: unknown
      canonicalReady: boolean
    }
    const msgs: unknown[] = []
    internal.postMessage = (m) => msgs.push(m)
    internal.isWebviewReady = true
    expect(internal.canonicalReady).toBe(true)
    const orig = svc.buildProviderIndexAsync.bind(svc)
    svc.buildProviderIndexAsync = async (arg) => {
      await new Promise((r) => setTimeout(r, 50))
      return orig(arg)
    }
    const promise = internal.sendCanonicalProviders()
    await new Promise((r) => setTimeout(r, 10))
    // Active materialization fence: service clears authoritative readiness
    // before the later changed event updates stamp/provider readiness (service.ts:1776-1783).
    // Provider-local canonicalReady still true at this instant — stale result must not publish.
    ;(svc as unknown as { successfulMaterializationStamp: null }).successfulMaterializationStamp = null
    expect(svc.materializationReady).toBe(false)
    expect(internal.canonicalReady).toBe(true)
    await promise
    const stale = msgs.filter(
      (m) => (m as Record<string, unknown>).type === "providersLoaded" && (m as Record<string, unknown>).canonical === true && (m as Record<string, unknown>).ready === true,
    )
    expect(stale.length).toBe(0)
    expect(internal.cachedProvidersMessage).toBeNull()
    // Restoring error-free materialization reopens authoritative readiness — fresh publish must succeed
    ;(svc as unknown as { successfulMaterializationStamp: object }).successfulMaterializationStamp = {} as never
    // Re-enter ready mirroring as onCanonicalChange would after successful materialization
    ;(provider as unknown as { canonicalReady: boolean }).canonicalReady = true
    // Restore direct index path for fresh publish
    svc.buildProviderIndexAsync = orig
    msgs.length = 0
    await internal.sendCanonicalProviders()
    const fresh = msgs.find(
      (m) => (m as Record<string, unknown>).type === "providersLoaded" && (m as Record<string, unknown>).canonical === true && (m as Record<string, unknown>).ready === true,
    )
    expect(fresh).toBeDefined()
    provider.dispose()
    svc.dispose()
  })

  it("audit correction: sendCanonicalProviders guards authoritative service readiness after await", async () => {
    const src = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const block = src.match(/private async sendCanonicalProviders[\s\S]*?this\.cachedProvidersMessage = message/)?.[0] ?? ""
    expect(block).toContain("capturedService.materializationReady")
    expect(block).toContain("this.canonicalConfig.materializationReady")
  })
})
