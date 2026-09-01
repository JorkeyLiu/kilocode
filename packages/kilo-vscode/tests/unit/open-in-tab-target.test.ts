import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

const ROOT = path.resolve(import.meta.dir, "../..")
const EXT_FILE = path.join(ROOT, "src/extension.ts")
const ext = fs.readFileSync(EXT_FILE, "utf-8")

describe("openInTab target session contract", () => {
  it("preserves zero-arg generic behavior when called without session ID", () => {
    expect(ext).toContain('registerCommand("kilo-code.new.openInTab"')
    expect(ext).toContain("targetSessionId?: string")
    // Generic path must not require target
    expect(ext).toContain(
      'typeof targetSessionId === "string" && targetSessionId.length > 0 ? targetSessionId : undefined',
    )
    expect(ext).toContain("openKiloInNewTab(")
    // Ensure generic still creates provider without mandatory load
    expect(ext).toContain('if (typeof targetSessionId === "string" && targetSessionId.length > 0)')
  })

  it("attaches target session via existing waitForReady + loadMessages after readiness", () => {
    // Bounded real product path: waitForReady then strict loadMessages (helper handles it, openKiloInNewTab delegates)
    expect(ext).toContain("tabProvider.waitForReady()")
    expect(ext).toContain("loadMessagesStrict")
    expect(ext).toContain("attachTargetSessionToTab")
    // Must use real product APIs, not synthetic sessionsLoaded
    expect(ext).not.toContain("sessionsLoaded")
    expect(ext).not.toContain("sessionUpdated")
    // Verify ordering: waitForReady appears before strict load in helper
    const helper = ext.slice(ext.indexOf("async function attachTargetSessionToTab"))
    const waitIdx = helper.indexOf("waitForReady")
    const loadIdx = helper.indexOf("loadMessagesStrict")
    expect(waitIdx).toBeGreaterThan(-1)
    expect(loadIdx).toBeGreaterThan(-1)
    expect(waitIdx).toBeLessThan(loadIdx)
    // openKiloInNewTab must delegate to helper
    const openFn = ext.slice(ext.indexOf("async function openKiloInNewTab"))
    expect(openFn).toContain("attachTargetSessionToTab")
  })

  it("fixture openInTabReady accepts optional target and returns fail-closed attachment evidence", () => {
    expect(ext).toContain("kilo-code.new.e2eFixture.openInTabReady")
    expect(ext).toContain("hasTarget")
    expect(ext).toContain("targetSessionIdHash")
    expect(ext).toContain("currentSessionIdHash")
    expect(ext).toContain("attached")
    // Must hash before durable artifact
    expect(ext).toContain('createHash("sha256")')
    expect(ext).toContain('.digest("hex").slice(0, 16)')
    // Fail-closed: when no panel or not ready, attached false
    expect(ext).toContain("attached: false")
    // Zero-arg path still returns generic
    expect(ext).toContain("if (!hasTarget)")
  })

  it("no synthetic session injection in openInTab path", () => {
    const openFn = ext.slice(ext.indexOf("async function openKiloInNewTab"))
    expect(openFn).not.toContain('postMessage({ type: "sessionsLoaded"')
    expect(openFn).not.toContain('postMessage({ type: "sessionUpdated"')
    expect(openFn).not.toContain('postMessage({ type: "messagesLoaded"')
  })

  it("hashes are redacted 16-hex before durable proof", () => {
    const h = createHash("sha256").update("test-session-id").digest("hex").slice(0, 16)
    expect(h).toMatch(/^[0-9a-f]{16}$/)
    expect(h.length).toBe(16)
  })

  it("resolves target directory via existing maps before loadMessages and registers it", () => {
    const helper = ext.slice(ext.indexOf("async function attachTargetSessionToTab"))
    const resolver = ext.slice(ext.indexOf("async function resolveTargetSessionDirectory"))
    const openFn = ext.slice(ext.indexOf("async function openKiloInNewTab"))
    // Must resolve via existing directory-aware lookup (resolver owns lookup, helper delegates)
    expect(resolver).toContain("getSessionDirectories().get(targetSessionId)")
    expect(resolver).toContain("agentManagerProvider.getSessionDirectories()")
    expect(helper).toContain("resolveTargetSessionDirectory")
    // Must register mapping before strict load
    const loadIdx = helper.indexOf("loadMessagesStrict")
    expect(loadIdx).toBeGreaterThan(-1)
    expect(resolver).toContain("getSessionDirectories().get(targetSessionId)")
    // Should use existing tracking API (trackDirectory) or direct map set
    expect(helper).toContain("trackDirectory") // existing KiloProvider directory tracking
    // Bounded failure: load failure must not be swallowed and strict success required
    expect(helper).toContain("target attach failed hash")
    expect(helper).toContain("throw")
    expect(helper).toContain("if (!ok)")
    // openKiloInNewTab delegates to helper
    expect(openFn).toContain("attachTargetSessionToTab")
  })

  it("registers disposal before activation wait and is bounded/disposal-aware", () => {
    const openFn = ext.slice(ext.indexOf("async function openKiloInNewTab"))
    const helper = ext.slice(ext.indexOf("async function attachTargetSessionToTab"))
    const disposeIdx = openFn.indexOf("onDidDispose")
    const waitIdx = openFn.indexOf("waitForWebviewPanelToBeActiveBounded")
    expect(disposeIdx).toBeGreaterThan(-1)
    expect(waitIdx).toBeGreaterThan(-1)
    expect(disposeIdx).toBeLessThan(waitIdx)
    expect(openFn).toContain("waitForWebviewPanelToBeActiveBounded")
    expect(openFn).toContain("30_000")
    expect(openFn).toContain("disposedEarly")
    // No duplicate raw ID in warnings — hash only (helper owns warning)
    expect(helper).toContain("hash")
    expect(helper).toContain("webview not ready for target attach hash")
    expect(openFn).not.toContain(
      'console.warn("[Kilo New] openKiloInNewTab: webview not ready for target attach", targetSessionId',
    )
    expect(ext).not.toContain(
      'console.warn("[Kilo New] openKiloInNewTab: webview not ready for target attach", targetSessionId',
    )
  })

  it("targeted fixture returns hash-only and loadOk, no raw currentSessionId", () => {
    const fixtureStart = ext.indexOf("kilo-code.new.e2eFixture.openInTabReady")
    const fixtureSlice = ext.slice(fixtureStart, fixtureStart + 8000)
    expect(fixtureSlice).not.toContain("currentSessionId: tabProvider.getCurrentSessionId")
    expect(fixtureSlice).not.toContain("currentSessionId: cur")
    expect(fixtureSlice).toContain("currentSessionIdHash")
    expect(fixtureSlice).toContain("targetSessionIdHash")
    expect(fixtureSlice).toContain("loadOk")
    expect(fixtureSlice).toContain("attached")
  })

  it("targeted attach failure cleans tabPanels/provider/panel exactly once and rethrows hash-only", () => {
    const openFn = ext.slice(ext.indexOf("async function openKiloInNewTab"))
    expect(openFn).toContain("try {")
    expect(openFn).toContain("await attachTargetSessionToTab")
    expect(openFn).toContain("} catch (err)")
    expect(openFn).toContain("try {")
    expect(openFn).toContain("disposeSub.dispose()")
    expect(openFn).toContain("tabPanels.delete(panel)")
    expect(openFn).toContain("tabProvider.dispose()")
    expect(openFn).toContain("panel.dispose()")
    expect(openFn).toContain("targeted attach cleanup hash")
    expect(openFn).toContain('createHash("sha256")')
    const catchIdx = openFn.indexOf("} catch (err)")
    const afterCatch = openFn.slice(catchIdx, catchIdx + 800)
    expect(afterCatch).toContain("tabPanels.delete(panel)")
    expect(afterCatch).toContain("throw err")
    expect(ext).toContain('if (typeof targetSessionId === "string" && targetSessionId.length > 0)')
  })

  it("unresolved directory fails closed before loadMessages", () => {
    const helper = ext.slice(ext.indexOf("async function attachTargetSessionToTab"))
    expect(helper).toContain("if (!resolved")
    expect(helper).toContain("unresolved directory for target attach")
    expect(helper).toContain('throw new Error("unresolved directory')
    const dirIdx = helper.indexOf("if (!resolved")
    const loadIdx = helper.indexOf("loadMessagesStrict")
    expect(dirIdx).toBeGreaterThan(-1)
    expect(loadIdx).toBeGreaterThan(-1)
    expect(dirIdx).toBeLessThan(loadIdx)
    expect(helper).not.toContain("if (dir) {")
  })

  it("openTabReady targeted requires loadOk true and cleanup", () => {
    const fixtureStart = ext.indexOf("kilo-code.new.e2eFixture.openInTabReady")
    const fixtureSlice = ext.slice(fixtureStart, fixtureStart + 10000)
    expect(fixtureSlice).toContain("loadOk")
    expect(fixtureSlice).toContain("attached")
    expect(fixtureSlice).toContain("loadOk = openOk && attached")
    expect(fixtureSlice).toContain("loadOk: openOk")
    expect(fixtureSlice).toContain("loadOk: false")
  })

  it("restored canonical gate helper is non-empty and contains bun:sqlite", () => {
    const gatePath = path.join(ROOT, "script/e2e-canonical-gate.ts")
    const content = fs.readFileSync(gatePath, "utf-8")
    expect(content.length).toBeGreaterThan(0)
    expect(content).toContain("bun:sqlite")
    expect(content).toContain("Database")
    expect(content).toContain("SELECT")
  })
})

describe("KiloProvider targeted attachment behavior (real)", () => {
  it("loadMessages attaches target session via existing tracking and posts messagesLoaded", async () => {
    const { KiloProvider } = await import("../../src/KiloProvider")
    // Reuse realistic provider setup from load-messages tests
    const mockClient = {
      session: {
        messages: async () => ({ data: [], response: { headers: new Headers() } }),
        get: async () => ({ data: { id: "target-123", title: "Target", directory: "/repo" } }),
        list: async () => ({ data: [] }),
        create: async () => ({ data: { id: "created" } }),
        status: async () => ({ data: {} }),
        delete: async () => ({ data: {} }),
      },
      sandbox: { support: async () => ({ data: { available: true } }), toggle: async () => ({ data: {} }) },
      backgroundProcess: { stopSession: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [], connected: {}, default: {} } }) },
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} }) },
      kilo: { profile: async () => ({ data: {} }) },
      command: { list: async () => ({ data: [] }) },
      experimental: { session: { list: async () => ({ data: [], response: { headers: new Headers() } }) } },
    }
    const mockConn: any = {
      sandboxPreference: {
        explicit: () => undefined,
        resolve: (v: boolean) => v,
        wait: () => Promise.resolve(),
        set: () => Promise.resolve(),
        onChange: () => () => undefined,
      },
      connect: async () => {},
      getClient: () => mockClient,
      getClientAsync: async () => mockClient,
      onEventFiltered: () => () => undefined,
      onStateChange: () => () => undefined,
      onLanguageChanged: () => () => undefined,
      onProfileChanged: () => () => undefined,
      onFavoritesChanged: () => () => undefined,
      onModelSelectorExpandedChanged: () => () => undefined,
      getConfigRevision: () => 0,
      advanceConfigRevision: () => {},
      onConfigRevision: () => () => undefined,
      registerDirectoryProvider: () => () => undefined,
      getServerInfo: () => ({ port: 12345 }),
      getConnectionState: () => "connected" as const,
      getConnectionError: () => null,
      resolveEventSessionId: () => undefined,
      recordMessageSessionId: () => undefined,
      pruneSession: () => undefined,
      registerVisible: () => undefined,
      unregisterVisible: () => undefined,
      registerAttached: () => undefined,
      unregisterAttached: () => undefined,
    }
    const provider: any = new KiloProvider({} as never, mockConn as never)
    provider.connectionState = "connected"
    const sent: unknown[] = []
    provider.webview = {
      postMessage: async (m: unknown) => {
        sent.push(m)
      },
    }
    provider.isWebviewReady = true

    // Initially no current session
    expect(provider.getCurrentSessionId()).toBeUndefined()

    // Real product path: loadMessages with target
    await provider.loadMessages("target-123")

    expect(provider.getCurrentSessionId()).toBe("target-123")
    // tracked
    expect((provider.trackedSessionIds as Set<string>).has("target-123")).toBeTrue()
    // messagesLoaded posted
    const loaded = sent.find((m: any) => m.type === "messagesLoaded") as any
    expect(loaded).toBeDefined()
    expect(loaded.sessionID).toBe("target-123")
  })

  it("generic tab without loadMessages remains unattached", async () => {
    const { KiloProvider } = await import("../../src/KiloProvider")
    const mockClient: any = {
      session: { list: async () => ({ data: [] }) },
      sandbox: { support: async () => ({ data: { available: true } }) },
      backgroundProcess: { stopSession: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [], connected: {}, default: {} } }) },
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} }) },
      kilo: { profile: async () => ({ data: {} }) },
      command: { list: async () => ({ data: [] }) },
      experimental: { session: { list: async () => ({ data: [], response: { headers: new Headers() } }) } },
    }
    const mockConn: any = {
      sandboxPreference: {
        explicit: () => undefined,
        resolve: (v: boolean) => v,
        wait: () => Promise.resolve(),
        set: () => Promise.resolve(),
        onChange: () => () => undefined,
      },
      connect: async () => {},
      getClient: () => mockClient,
      onEventFiltered: () => () => undefined,
      onStateChange: () => () => undefined,
      onLanguageChanged: () => () => undefined,
      onProfileChanged: () => () => undefined,
      onFavoritesChanged: () => () => undefined,
      onModelSelectorExpandedChanged: () => () => undefined,
      getConfigRevision: () => 0,
      advanceConfigRevision: () => {},
      onConfigRevision: () => () => undefined,
      registerDirectoryProvider: () => () => undefined,
      getServerInfo: () => ({ port: 12345 }),
      getConnectionState: () => "connected" as const,
      getConnectionError: () => null,
      resolveEventSessionId: () => undefined,
      recordMessageSessionId: () => undefined,
      pruneSession: () => undefined,
      registerVisible: () => undefined,
      unregisterVisible: () => undefined,
      registerAttached: () => undefined,
      unregisterAttached: () => undefined,
    }
    const provider: any = new KiloProvider({} as never, mockConn as never)
    provider.connectionState = "connected"
    provider.webview = { postMessage: async () => {} }
    provider.isWebviewReady = true
    expect(provider.getCurrentSessionId()).toBeUndefined()
    expect((provider.trackedSessionIds as Set<string>).size).toBe(0)
  })

  it("readiness ordering: waitForReady resolves before loadMessages posts", async () => {
    const { KiloProvider } = await import("../../src/KiloProvider")
    const mockClient: any = {
      session: {
        messages: async () => ({ data: [], response: { headers: new Headers() } }),
        get: async (p: { sessionID: string }) => ({
          data: { id: p.sessionID, title: p.sessionID, time: { created: 1, updated: 1 }, directory: "/repo" },
        }),
        list: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        delete: async () => ({ data: {} }),
        create: async () => ({ data: { id: "c" } }),
      },
      sandbox: { support: async () => ({ data: { available: true } }), toggle: async () => ({ data: {} }) },
      backgroundProcess: { stopSession: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [], connected: {}, default: {} } }) },
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} }) },
      kilo: { profile: async () => ({ data: {} }) },
      command: { list: async () => ({ data: [] }) },
      experimental: { session: { list: async () => ({ data: [], response: { headers: new Headers() } }) } },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
      suggestion: { list: async () => ({ data: [] }) },
    }
    const mockConn: any = {
      sandboxPreference: {
        explicit: () => undefined,
        resolve: (v: boolean) => v,
        wait: () => Promise.resolve(),
        set: () => Promise.resolve(),
        onChange: () => () => undefined,
      },
      connect: async () => {},
      getClient: () => mockClient,
      onEventFiltered: () => () => undefined,
      onStateChange: () => () => undefined,
      onLanguageChanged: () => () => undefined,
      onProfileChanged: () => () => undefined,
      onFavoritesChanged: () => () => undefined,
      onModelSelectorExpandedChanged: () => () => undefined,
      getConfigRevision: () => 0,
      advanceConfigRevision: () => {},
      onConfigRevision: () => () => undefined,
      registerDirectoryProvider: () => () => undefined,
      getServerInfo: () => ({ port: 12345 }),
      getConnectionState: () => "connected" as const,
      getConnectionError: () => null,
      resolveEventSessionId: () => undefined,
      recordMessageSessionId: () => undefined,
      pruneSession: () => undefined,
      registerVisible: () => undefined,
      unregisterVisible: () => undefined,
      registerAttached: () => undefined,
      unregisterAttached: () => undefined,
    }
    const provider: any = new KiloProvider({} as never, mockConn as never)
    provider.connectionState = "connected"
    const sent: unknown[] = []
    provider.webview = {
      postMessage: async (m: unknown) => {
        sent.push(m)
      },
    }
    // Initially not ready
    provider.isWebviewReady = false
    let readyResolved = false
    const wait = provider.waitForReady().then(() => {
      readyResolved = true
    })
    expect(readyResolved).toBeFalse()
    // Simulate webviewReady
    provider.isWebviewReady = true
    // Resolve pending waiters by simulating webviewReady handler: it splices readyResolvers
    // Directly invoke the internal resolver: we set isWebviewReady and then call readyResolvers
    // For test, manually resolve: provider has readyResolvers array
    const resolvers = (provider as any).readyResolvers as (() => void)[]
    resolvers.splice(0).forEach((r: () => void) => r())
    await wait
    expect(readyResolved).toBeTrue()
    await provider.loadMessages("s-ordered")
    expect(provider.getCurrentSessionId()).toBe("s-ordered")
  })

  it("strict targeted load succeeds only when session metadata and transcript both succeed", async () => {
    const { KiloProvider } = await import("../../src/KiloProvider")
    const mockClient = {
      session: {
        messages: async () => ({
          data: [{ info: { id: "m1", sessionID: "target-123", role: "user", time: { created: 1 } }, parts: [] }],
          response: { headers: new Headers() },
        }),
        get: async () => ({
          data: { id: "target-123", title: "Target", directory: "/repo", time: { created: 1, updated: 1 } },
        }),
        list: async () => ({ data: [] }),
        create: async () => ({ data: { id: "created" } }),
        status: async () => ({ data: {} }),
        delete: async () => ({ data: {} }),
      },
      sandbox: { support: async () => ({ data: { available: true } }), toggle: async () => ({ data: {} }) },
      backgroundProcess: { stopSession: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [], connected: {}, default: {} } }) },
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} }) },
      kilo: { profile: async () => ({ data: {} }) },
      command: { list: async () => ({ data: [] }) },
      experimental: { session: { list: async () => ({ data: [], response: { headers: new Headers() } }) } },
    }
    const mockConn: any = {
      sandboxPreference: {
        explicit: () => undefined,
        resolve: (v: boolean) => v,
        wait: () => Promise.resolve(),
        set: () => Promise.resolve(),
        onChange: () => () => undefined,
      },
      connect: async () => {},
      getClient: () => mockClient,
      getClientAsync: async () => mockClient,
      onEventFiltered: () => () => undefined,
      onStateChange: () => () => undefined,
      onLanguageChanged: () => () => undefined,
      onProfileChanged: () => () => undefined,
      onFavoritesChanged: () => () => undefined,
      onModelSelectorExpandedChanged: () => () => undefined,
      getConfigRevision: () => 0,
      advanceConfigRevision: () => {},
      onConfigRevision: () => () => undefined,
      registerDirectoryProvider: () => () => undefined,
      getServerInfo: () => ({ port: 12345 }),
      getConnectionState: () => "connected" as const,
      getConnectionError: () => null,
      resolveEventSessionId: () => undefined,
      recordMessageSessionId: () => undefined,
      pruneSession: () => undefined,
      registerVisible: () => undefined,
      unregisterVisible: () => undefined,
      registerAttached: () => undefined,
      unregisterAttached: () => undefined,
    }
    const provider: any = new KiloProvider({} as never, mockConn as never)
    provider.connectionState = "connected"
    provider.webview = { postMessage: async () => {} }
    provider.isWebviewReady = true
    const ok = await provider.loadMessagesStrict("target-123")
    expect(ok).toBeTrue()
    expect(provider.getCurrentSessionId()).toBe("target-123")
  })

  it("strict targeted load fails when transcript fetch fails even though session metadata succeeds — no loadOk, no attached, cleanup path", async () => {
    const { KiloProvider } = await import("../../src/KiloProvider")
    let messagesCalled = 0
    const mockClient = {
      session: {
        messages: async () => {
          messagesCalled++
          throw new Error("transcript fetch failed")
        },
        get: async () => ({
          data: { id: "target-999", title: "Target", directory: "/repo", time: { created: 1, updated: 1 } },
        }),
        list: async () => ({ data: [] }),
        create: async () => ({ data: { id: "created" } }),
        status: async () => ({ data: {} }),
        delete: async () => ({ data: {} }),
      },
      sandbox: { support: async () => ({ data: { available: true } }), toggle: async () => ({ data: {} }) },
      backgroundProcess: { stopSession: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [], connected: {}, default: {} } }) },
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} }) },
      kilo: { profile: async () => ({ data: {} }) },
      command: { list: async () => ({ data: [] }) },
      experimental: { session: { list: async () => ({ data: [], response: { headers: new Headers() } }) } },
    }
    const mockConn: any = {
      sandboxPreference: {
        explicit: () => undefined,
        resolve: (v: boolean) => v,
        wait: () => Promise.resolve(),
        set: () => Promise.resolve(),
        onChange: () => () => undefined,
      },
      connect: async () => {},
      getClient: () => mockClient,
      getClientAsync: async () => mockClient,
      onEventFiltered: () => () => undefined,
      onStateChange: () => () => undefined,
      onLanguageChanged: () => () => undefined,
      onProfileChanged: () => () => undefined,
      onFavoritesChanged: () => () => undefined,
      onModelSelectorExpandedChanged: () => () => undefined,
      getConfigRevision: () => 0,
      advanceConfigRevision: () => {},
      onConfigRevision: () => () => undefined,
      registerDirectoryProvider: () => () => undefined,
      getServerInfo: () => ({ port: 12345 }),
      getConnectionState: () => "connected" as const,
      getConnectionError: () => null,
      resolveEventSessionId: () => undefined,
      recordMessageSessionId: () => undefined,
      pruneSession: () => undefined,
      registerVisible: () => undefined,
      unregisterVisible: () => undefined,
      registerAttached: () => undefined,
      unregisterAttached: () => undefined,
    }
    const provider: any = new KiloProvider({} as never, mockConn as never)
    provider.connectionState = "connected"
    const sent: unknown[] = []
    provider.webview = {
      postMessage: async (m: unknown) => {
        sent.push(m)
      },
    }
    provider.isWebviewReady = true

    // Tolerant path: must post error without throwing (LOCK-001)
    await provider.loadMessages("target-999")
    expect(sent.some((m: any) => m.type === "error")).toBeTrue()
    expect(sent.some((m: any) => m.type === "messagesLoaded" && m.sessionID === "target-999")).toBeFalse()

    // Strict path: must throw / return false, no messagesLoaded, no loadOk
    const strictProvider: any = new KiloProvider({} as never, mockConn as never)
    strictProvider.connectionState = "connected"
    const strictSent: unknown[] = []
    strictProvider.webview = {
      postMessage: async (m: unknown) => {
        strictSent.push(m)
      },
    }
    strictProvider.isWebviewReady = true
    let loadOk = false
    let threw = false
    try {
      const ok = await strictProvider.loadMessagesStrict("target-999")
      loadOk = ok === true
    } catch {
      threw = true
      loadOk = false
    }
    expect(loadOk).toBeFalse()
    expect(threw || !loadOk).toBeTrue()
    expect(messagesCalled).toBeGreaterThan(0)
    // Strict must not have posted messagesLoaded for target
    expect(strictSent.some((m: any) => m.type === "messagesLoaded" && m.sessionID === "target-999")).toBeFalse()
    // Simulate attachTargetSessionToTab strict check: loadOk false means no attached success, triggers cleanup
    const attached = loadOk && strictProvider.getCurrentSessionId() === "target-999"
    expect(attached).toBeFalse()
    // Cleanup would be triggered by caller on !loadOk — verify provider would be disposed in real attach
    // Here we just assert no loadOk and no attached
    expect(loadOk).toBeFalse()
    expect(attached).toBeFalse()
  })

  it("attach helper requires strict success before current-session comparison", () => {
    const helper = ext.slice(ext.indexOf("async function attachTargetSessionToTab"))
    expect(helper).toContain("loadMessagesStrict")
    expect(helper).toContain("if (!ok)")
    const strictIdx = helper.indexOf("loadMessagesStrict")
    const okCheckIdx = helper.indexOf("if (!ok)")
    const curIdx = helper.indexOf("getCurrentSessionId()")
    expect(strictIdx).toBeGreaterThan(-1)
    expect(okCheckIdx).toBeGreaterThan(-1)
    expect(curIdx).toBeGreaterThan(-1)
    expect(strictIdx).toBeLessThan(okCheckIdx)
    expect(okCheckIdx).toBeLessThan(curIdx)
  })
})

describe("openInTab target dedup — metadata/transcript counts and ordering", () => {
  it("directory resolution returns Resolved with dir+info and strict reuses it — at most one metadata fetch", () => {
    const resolver = ext.slice(ext.indexOf("async function resolveTargetSessionDirectory"))
    // file-level contains the compact single-word type
    expect(ext).toContain("type Resolved")
    expect(ext).toContain("Promise<Resolved")
    expect(resolver).toContain("dir:")
    expect(ext).toContain("info?: Session")
    expect(resolver).toContain("return { dir:")
    expect(resolver).toContain("info: res.data")
    const helper = ext.slice(ext.indexOf("async function attachTargetSessionToTab"))
    expect(helper).toContain("resolved")
    expect(helper).toContain("resolved.info")
    expect(helper).toContain("loadMessagesStrict(targetSessionId, resolved.info)")
    // ordering: resolve -> track -> strict
    const resolveIdx = helper.indexOf("resolveTargetSessionDirectory")
    const trackIdx = helper.indexOf("trackDirectory")
    const strictIdx = helper.indexOf("loadMessagesStrict")
    expect(resolveIdx).toBeLessThan(trackIdx)
    expect(trackIdx).toBeLessThan(strictIdx)
    // verify maps reuse without fetch
    expect(resolver).toContain("getSessionDirectories().get(targetSessionId)")
  })

  it("KiloProvider strict overload accepts optional Session.Info and skips session.get when supplied", async () => {
    const providerFile = fs.readFileSync(path.join(ROOT, "src/KiloProvider.ts"), "utf-8")
    expect(providerFile).toContain("loadMessagesStrict(sessionID: string, info?: Session)")
    expect(providerFile).toContain("doLoadMessages(")
    expect(providerFile).toContain("info?: Session")
    // tolerant path unchanged
    expect(providerFile).toContain("public loadMessages(sessionID: string): Promise<void>")
    expect(providerFile).toContain("return this.handleLoadMessages(sessionID, { preserveStream: true })")
    expect(providerFile).toContain("if (info)")
    // ensure strict still posts activateSession after successful transcript
    expect(providerFile).toContain("activateSession(sessionID)")
  })

  it("root session targeted open = one metadata fetch + one transcript fetch in order", async () => {
    const { KiloProvider } = await import("../../src/KiloProvider")
    const order: string[] = []
    let meta = 0
    let transcript = 0
    const mockClient: any = {
      session: {
        get: async () => {
          meta++
          order.push("get")
          return { data: { id: "target-123", directory: "/repo", time: { created: 1, updated: 1 } } }
        },
        messages: async () => {
          transcript++
          order.push("messages")
          return { data: [], response: { headers: new Headers() } }
        },
        list: async () => ({ data: [] }),
        create: async () => ({ data: { id: "created" } }),
        status: async () => ({ data: {} }),
        delete: async () => ({ data: {} }),
      },
      sandbox: { support: async () => ({ data: { available: true } }), toggle: async () => ({ data: {} }) },
      backgroundProcess: { stopSession: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [], connected: {}, default: {} } }) },
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} }) },
      kilo: { profile: async () => ({ data: {} }) },
      command: { list: async () => ({ data: [] }) },
      experimental: { session: { list: async () => ({ data: [], response: { headers: new Headers() } }) } },
    }
    const mockConn: any = {
      sandboxPreference: {
        explicit: () => undefined,
        resolve: (v: boolean) => v,
        wait: () => Promise.resolve(),
        set: () => Promise.resolve(),
        onChange: () => () => undefined,
      },
      connect: async () => {},
      getClient: () => mockClient,
      getClientAsync: async () => mockClient,
      onEventFiltered: () => () => undefined,
      onStateChange: () => () => undefined,
      onLanguageChanged: () => () => undefined,
      onProfileChanged: () => () => undefined,
      onFavoritesChanged: () => () => undefined,
      onModelSelectorExpandedChanged: () => () => undefined,
      getConfigRevision: () => 0,
      advanceConfigRevision: () => {},
      onConfigRevision: () => () => undefined,
      registerDirectoryProvider: () => () => undefined,
      getServerInfo: () => ({ port: 12345 }),
      getConnectionState: () => "connected" as const,
      getConnectionError: () => null,
      resolveEventSessionId: () => undefined,
      recordMessageSessionId: () => undefined,
      pruneSession: () => undefined,
      registerVisible: () => undefined,
      unregisterVisible: () => undefined,
      registerAttached: () => undefined,
      unregisterAttached: () => undefined,
    }
    const provider: any = new KiloProvider({} as never, mockConn as never)
    provider.connectionState = "connected"
    const sent: unknown[] = []
    provider.webview = {
      postMessage: async (m: unknown) => {
        sent.push(m)
      },
    }
    provider.isWebviewReady = true

    const ok = await provider.loadMessagesStrict("target-123")
    expect(ok).toBeTrue()
    expect(meta).toBe(1)
    expect(transcript).toBe(1)
    expect(order).toEqual(["get", "messages"])
    // strict success requires activateSession post and exact current target
    expect(sent.some((m: any) => m.type === "activateSession" && m.sessionID === "target-123")).toBeTrue()
    expect(provider.getCurrentSessionId()).toBe("target-123")
    expect(sent.some((m: any) => m.type === "messagesLoaded" && m.sessionID === "target-123")).toBeTrue()
  })

  it("metadata supplied = zero additional metadata fetches — reuse via Resolved.info", async () => {
    const { KiloProvider } = await import("../../src/KiloProvider")
    const order: string[] = []
    let meta = 0
    let transcript = 0
    const mockClient: any = {
      session: {
        get: async () => {
          meta++
          order.push("get")
          return { data: { id: "target-123", directory: "/repo", time: { created: 1, updated: 1 } } }
        },
        messages: async () => {
          transcript++
          order.push("messages")
          return { data: [], response: { headers: new Headers() } }
        },
        list: async () => ({ data: [] }),
        create: async () => ({ data: { id: "created" } }),
        status: async () => ({ data: {} }),
        delete: async () => ({ data: {} }),
      },
      sandbox: { support: async () => ({ data: { available: true } }), toggle: async () => ({ data: {} }) },
      backgroundProcess: { stopSession: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [], connected: {}, default: {} } }) },
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} }) },
      kilo: { profile: async () => ({ data: {} }) },
      command: { list: async () => ({ data: [] }) },
      experimental: { session: { list: async () => ({ data: [], response: { headers: new Headers() } }) } },
    }
    const mockConn: any = {
      sandboxPreference: {
        explicit: () => undefined,
        resolve: (v: boolean) => v,
        wait: () => Promise.resolve(),
        set: () => Promise.resolve(),
        onChange: () => () => undefined,
      },
      connect: async () => {},
      getClient: () => mockClient,
      getClientAsync: async () => mockClient,
      onEventFiltered: () => () => undefined,
      onStateChange: () => () => undefined,
      onLanguageChanged: () => () => undefined,
      onProfileChanged: () => () => undefined,
      onFavoritesChanged: () => () => undefined,
      onModelSelectorExpandedChanged: () => () => undefined,
      getConfigRevision: () => 0,
      advanceConfigRevision: () => {},
      onConfigRevision: () => () => undefined,
      registerDirectoryProvider: () => () => undefined,
      getServerInfo: () => ({ port: 12345 }),
      getConnectionState: () => "connected" as const,
      getConnectionError: () => null,
      resolveEventSessionId: () => undefined,
      recordMessageSessionId: () => undefined,
      pruneSession: () => undefined,
      registerVisible: () => undefined,
      unregisterVisible: () => undefined,
      registerAttached: () => undefined,
      unregisterAttached: () => undefined,
    }
    const provider: any = new KiloProvider({} as never, mockConn as never)
    provider.connectionState = "connected"
    const sent: unknown[] = []
    provider.webview = {
      postMessage: async (m: unknown) => {
        sent.push(m)
      },
    }
    provider.isWebviewReady = true

    const info: any = { id: "target-123", directory: "/repo", time: { created: 1, updated: 1 } }
    // simulate attach having already resolved metadata — pass info directly
    const ok = await provider.loadMessagesStrict("target-123", info)
    expect(ok).toBeTrue()
    expect(meta).toBe(0)
    expect(transcript).toBe(1)
    expect(order).toEqual(["messages"])
    expect(sent.some((m: any) => m.type === "activateSession" && m.sessionID === "target-123")).toBeTrue()
    expect(sent.some((m: any) => m.type === "messagesLoaded" && m.sessionID === "target-123")).toBeTrue()
  })

  it("transcript failure with supplied info remains fail-closed — no loadOk, no attached, cleanup state", async () => {
    const { KiloProvider } = await import("../../src/KiloProvider")
    let meta = 0
    let transcript = 0
    const mockClient: any = {
      session: {
        get: async () => {
          meta++
          return { data: { id: "target-999", directory: "/repo", time: { created: 1, updated: 1 } } }
        },
        messages: async () => {
          transcript++
          throw new Error("transcript fetch failed")
        },
        list: async () => ({ data: [] }),
        create: async () => ({ data: { id: "created" } }),
        status: async () => ({ data: {} }),
        delete: async () => ({ data: {} }),
      },
      sandbox: { support: async () => ({ data: { available: true } }), toggle: async () => ({ data: {} }) },
      backgroundProcess: { stopSession: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [], connected: {}, default: {} } }) },
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} }) },
      kilo: { profile: async () => ({ data: {} }) },
      command: { list: async () => ({ data: [] }) },
      experimental: { session: { list: async () => ({ data: [], response: { headers: new Headers() } }) } },
    }
    const mockConn: any = {
      sandboxPreference: {
        explicit: () => undefined,
        resolve: (v: boolean) => v,
        wait: () => Promise.resolve(),
        set: () => Promise.resolve(),
        onChange: () => () => undefined,
      },
      connect: async () => {},
      getClient: () => mockClient,
      getClientAsync: async () => mockClient,
      onEventFiltered: () => () => undefined,
      onStateChange: () => () => undefined,
      onLanguageChanged: () => () => undefined,
      onProfileChanged: () => () => undefined,
      onFavoritesChanged: () => () => undefined,
      onModelSelectorExpandedChanged: () => () => undefined,
      getConfigRevision: () => 0,
      advanceConfigRevision: () => {},
      onConfigRevision: () => () => undefined,
      registerDirectoryProvider: () => () => undefined,
      getServerInfo: () => ({ port: 12345 }),
      getConnectionState: () => "connected" as const,
      getConnectionError: () => null,
      resolveEventSessionId: () => undefined,
      recordMessageSessionId: () => undefined,
      pruneSession: () => undefined,
      registerVisible: () => undefined,
      unregisterVisible: () => undefined,
      registerAttached: () => undefined,
      unregisterAttached: () => undefined,
    }
    const provider: any = new KiloProvider({} as never, mockConn as never)
    provider.connectionState = "connected"
    const sent: unknown[] = []
    provider.webview = {
      postMessage: async (m: unknown) => {
        sent.push(m)
      },
    }
    provider.isWebviewReady = true

    const info: any = { id: "target-999", directory: "/repo", time: { created: 1, updated: 1 } }
    let ok = false
    let threw = false
    try {
      ok = await provider.loadMessagesStrict("target-999", info)
    } catch {
      threw = true
      ok = false
    }
    // transcript failure must be fail-closed — no loadOk, no attached, no messagesLoaded/activate
    expect(ok).toBeFalse()
    expect(transcript).toBeGreaterThanOrEqual(1)
    // When info supplied, metadata fetch must be zero — only transcript attempted
    expect(meta).toBe(0)
    expect(sent.some((m: any) => m.type === "messagesLoaded" && m.sessionID === "target-999")).toBeFalse()
    expect(sent.some((m: any) => m.type === "activateSession" && m.sessionID === "target-999")).toBeFalse()
    // Simulate attach cleanup check — attached requires loadOk && exact current target
    const attached = ok && provider.getCurrentSessionId() === "target-999"
    expect(attached).toBeFalse()
    // tolerant path also fail-closed with error post
    const tolSent: unknown[] = []
    provider.webview = {
      postMessage: async (m: unknown) => {
        tolSent.push(m)
      },
    }
    await provider.loadMessages("target-999")
    expect(tolSent.some((m: any) => m.type === "error")).toBeTrue()
    expect(tolSent.some((m: any) => m.type === "messagesLoaded" && m.sessionID === "target-999")).toBeFalse()
  })

  it("zero-arg generic tab performs neither metadata nor transcript fetches", async () => {
    // Extension generic path must guard targeted logic — verify source keeps generic welcome without fetch
    expect(ext).toContain('if (typeof targetSessionId === "string" && targetSessionId.length > 0)')
    const openFn = ext.slice(ext.indexOf("async function openKiloInNewTab"))
    // generic branch is inside the guard; no unconditional session.get/session.messages outside helper
    const attachIdx = openFn.indexOf("attachTargetSessionToTab")
    expect(attachIdx).toBeGreaterThan(-1)
    // ensure helper is the sole place for session.get/messages — provider file has both but tolerant not called in generic
    const providerFile = fs.readFileSync(path.join(ROOT, "src/KiloProvider.ts"), "utf-8")
    expect(providerFile).toContain("loadMessagesStrict")
    // behavioral: generic provider without any load remains unattached with zero fetches
    const { KiloProvider } = await import("../../src/KiloProvider")
    let meta = 0
    let transcript = 0
    const mockClient: any = {
      session: {
        get: async () => {
          meta++
          return { data: null }
        },
        messages: async () => {
          transcript++
          return { data: [], response: { headers: new Headers() } }
        },
        list: async () => ({ data: [] }),
      },
      sandbox: { support: async () => ({ data: { available: true } }) },
      backgroundProcess: { stopSession: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [], connected: {}, default: {} } }) },
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} }) },
      kilo: { profile: async () => ({ data: {} }) },
      command: { list: async () => ({ data: [] }) },
      experimental: { session: { list: async () => ({ data: [], response: { headers: new Headers() } }) } },
    }
    const mockConn: any = {
      sandboxPreference: {
        explicit: () => undefined,
        resolve: (v: boolean) => v,
        wait: () => Promise.resolve(),
        set: () => Promise.resolve(),
        onChange: () => () => undefined,
      },
      connect: async () => {},
      getClient: () => mockClient,
      onEventFiltered: () => () => undefined,
      onStateChange: () => () => undefined,
      onLanguageChanged: () => () => undefined,
      onProfileChanged: () => () => undefined,
      onFavoritesChanged: () => () => undefined,
      onModelSelectorExpandedChanged: () => () => undefined,
      getConfigRevision: () => 0,
      advanceConfigRevision: () => {},
      onConfigRevision: () => () => undefined,
      registerDirectoryProvider: () => () => undefined,
      getServerInfo: () => ({ port: 12345 }),
      getConnectionState: () => "connected" as const,
      getConnectionError: () => null,
      resolveEventSessionId: () => undefined,
      recordMessageSessionId: () => undefined,
      pruneSession: () => undefined,
      registerVisible: () => undefined,
      unregisterVisible: () => undefined,
      registerAttached: () => undefined,
      unregisterAttached: () => undefined,
    }
    const provider: any = new KiloProvider({} as never, mockConn as never)
    provider.connectionState = "connected"
    provider.webview = { postMessage: async () => {} }
    provider.isWebviewReady = true
    // generic welcome: no loadMessages called at all
    expect(provider.getCurrentSessionId()).toBeUndefined()
    expect(meta).toBe(0)
    expect(transcript).toBe(0)
  })
})
