import { describe, expect, it, mock } from "bun:test"
import type { PanelContext, Store } from "../../src/agent-manager/host"
import { KEY } from "../../src/agent-manager/persistence"

mock.module("../../src/agent-manager/terminal-host", () => ({
  createTerminalHost: () => ({
    createTerminal: () => ({ show: () => {}, dispose: () => {}, exitStatus: undefined }),
    activeTerminal: () => undefined,
    repoPath: () => "/tmp",
    showWarning: () => {},
    setContext: () => {},
    onTerminalClosed: () => ({ dispose: () => {} }),
    onActiveTerminalChanged: () => ({ dispose: () => {} }),
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: async () => {},
  }),
}))
mock.module("../../src/agent-manager/terminal-font", () => ({
  readTerminalFont: () => undefined,
  watchTerminalFont: () => () => {},
}))

const { AgentManagerProvider } = await import("../../src/agent-manager/AgentManagerProvider")
const { KiloProvider } = await import("../../src/KiloProvider")
const { VscodeHost } = await import("../../src/agent-manager/vscode-host")

function fakeStore(initial?: unknown): Store {
  const data = new Map<string, unknown>()
  if (initial !== undefined) data.set(KEY, initial)
  return {
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: (k, v) => {
      data.set(k, v)
      return Promise.resolve()
    },
  }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Lifecycle-capable fake vscode.WebviewPanel that retains onDidDispose and onDidChangeViewState
// and captures the actual onDidReceiveMessage callback for real webviewReady testing
function makeLifecyclePanel() {
  const disposeCbs: Array<() => void> = []
  const viewStateDisposables: Array<ReturnType<typeof mock>> = []
  const viewStateCbs: Array<(e: { webviewPanel: { active: boolean; visible: boolean } }) => void> = []
  let disposed = false
  let messageHandler: ((msg: unknown) => unknown) | undefined
  const messages: unknown[] = []
  const webview: any = {
    html: "",
    options: {},
    cspSource: "vscode-webview://",
    asWebviewUri: (uri: any) => uri,
    onDidReceiveMessage: (cb: (msg: unknown) => unknown) => {
      messageHandler = cb
      return { dispose: mock(() => {}) }
    },
    postMessage: async (msg: unknown) => {
      messages.push(msg)
      return true
    },
    _getMessageHandler: () => messageHandler,
    _messages: messages,
  }
  const panel: any = {
    webview,
    active: true,
    visible: true,
    get _disposed() {
      return disposed
    },
    get disposed() {
      return disposed
    },
    onDidDispose(cb: () => void) {
      disposeCbs.push(cb)
      return {
        dispose: mock(() => {
          const idx = disposeCbs.indexOf(cb)
          if (idx >= 0) disposeCbs.splice(idx, 1)
        }),
      }
    },
    onDidChangeViewState(cb: (e: { webviewPanel: { active: boolean; visible: boolean } }) => void) {
      viewStateCbs.push(cb)
      const d = mock(() => {
        const idx = viewStateCbs.indexOf(cb)
        if (idx >= 0) viewStateCbs.splice(idx, 1)
      })
      viewStateDisposables.push(d)
      return { dispose: d }
    },
    reveal: mock(() => {}),
    dispose() {
      if (disposed) return
      disposed = true
      let first: unknown
      for (const cb of [...disposeCbs]) {
        try {
          cb()
        } catch (e) {
          if (first === undefined) first = e
        }
      }
      disposeCbs.length = 0
      if (first !== undefined) throw first
    },
    _disposeCbs: disposeCbs,
    _viewStateCbs: viewStateCbs,
    _viewStateDisposables: viewStateDisposables,
    _webview: webview,
    _getMessageHandler: () => messageHandler,
    _messages: messages,
  }
  return panel
}

function createValidClient() {
  return {
    project: {
      current: async () => ({ data: { vcs: "git" } }),
    },
    session: {
      list: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
      children: async () => ({ data: [] }),
      fork: async () => ({ data: { id: "forked" } }),
      create: async () => ({ data: { id: "new" } }),
      get: async () => ({ data: null }),
      promptAsync: async () => ({}),
    },
    provider: {
      list: async () => ({ data: { all: [], connected: [], default: {} } }),
      auth: async () => ({ data: {} }),
    },
    app: {
      agents: async () => ({ data: [] }),
      skills: async () => ({ data: [] }),
      commands: async () => ({ data: [] }),
    },
    config: {
      get: async () => ({ data: {} }),
      warnings: async () => ({ data: [] }),
      overlay: async () => ({ data: {} }),
    },
    global: {
      config: {
        get: async () => ({ data: {} }),
      },
    },
    command: {
      list: async () => ({ data: [] }),
    },
    suggestion: {
      list: async () => ({ data: [] }),
    },
    indexing: {
      status: async () => ({ data: { state: "disabled" } }),
    },
    kilo: {
      profile: async () => ({ data: null }),
      authStatus: async () => ({ data: { authenticated: false, type: null } }),
    },
    mcp: {
      status: async () => ({ data: {} }),
      disconnect: async () => ({}),
    },
    permission: {
      list: async () => ({ data: [] }),
    },
    question: {
      list: async () => ({ data: [] }),
    },
    remote: {
      status: async () => ({ data: { enabled: false, connected: false } }),
    },
    experimental: {
      session: {
        list: async () => ({ data: [] }),
      },
    },
  }
}

function fakeConn() {
  const base: Record<string, unknown> = {
    onEventFiltered: () => () => {},
    onEvent: () => () => {},
    onStateChange: () => () => {},
    onLanguageChanged: () => () => {},
    onProfileChanged: () => () => {},
    onFavoritesChanged: () => () => {},
    onModelSelectorExpandedChanged: () => () => {},
    onConfigRevision: () => () => {},
    registerDirectoryProvider: () => () => {},
    onDidChange: () => () => {},
    getClient: () => {
      throw new Error("not connected")
    },
    getClientAsync: async () => {
      throw new Error("not connected")
    },
    getServerInfo: () => undefined,
    getServerConfig: () => undefined,
    getConnectionState: () => "disconnected",
    getConnectionError: () => undefined,
    registerVisible: mock(() => {}),
    registerAttached: mock(() => {}),
    unregisterVisible: mock(() => {}),
    unregisterAttached: mock(() => {}),
    getConfigRevision: () => 0,
    getQuestionRevision: () => 0,
    getPermissionDirectory: () => undefined,
    recordPermissionDirectory: () => {},
    clearPermissionDirectory: () => {},
    prunePermissionDirectories: () => {},
    recordQuestionDirectory: () => {},
    getQuestionDirectory: () => undefined,
    clearQuestionDirectory: () => {},
    pruneQuestionDirectories: () => {},
    recordMessageSessionId: () => {},
    resolveEventSessionId: () => undefined,
    pruneSession: () => {},
    notifyLanguageChanged: () => {},
    notifyProfileChanged: () => {},
    notifyFavoritesChanged: () => {},
    notifyModelSelectorExpandedChanged: () => {},
    connect: async () => {},
    sandboxPreference: {
      onChange: () => () => {},
      resolve: () => false,
      set: async () => {},
    },
  }
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop]
      return mock(() => {})
    },
  }) as unknown as import("../../src/services/cli-backend").KiloConnectionService
}

function fakeConnWithValidClient() {
  const client = createValidClient()
  const base: Record<string, unknown> = {
    onEventFiltered: () => () => {},
    onEvent: () => () => {},
    onStateChange: () => () => {},
    onLanguageChanged: () => () => {},
    onProfileChanged: () => () => {},
    onFavoritesChanged: () => () => {},
    onModelSelectorExpandedChanged: () => () => {},
    onConfigRevision: () => () => {},
    registerDirectoryProvider: () => () => {},
    onDidChange: () => () => {},
    getClient: () => client,
    getClientAsync: async () => client,
    getServerInfo: () => ({ port: 12345 }),
    getServerConfig: () => ({ baseUrl: "http://127.0.0.1:12345", password: "test" }),
    getConnectionState: () => "connected" as const,
    getConnectionError: () => undefined,
    registerVisible: mock(() => {}),
    registerAttached: mock(() => {}),
    unregisterVisible: mock(() => {}),
    unregisterAttached: mock(() => {}),
    getConfigRevision: () => 0,
    getQuestionRevision: () => 0,
    getPermissionDirectory: () => undefined,
    recordPermissionDirectory: () => {},
    clearPermissionDirectory: () => {},
    prunePermissionDirectories: () => {},
    recordQuestionDirectory: () => {},
    getQuestionDirectory: () => undefined,
    clearQuestionDirectory: () => {},
    pruneQuestionDirectories: () => {},
    recordMessageSessionId: () => {},
    resolveEventSessionId: () => undefined,
    pruneSession: () => {},
    notifyLanguageChanged: () => {},
    notifyProfileChanged: () => {},
    notifyFavoritesChanged: () => {},
    notifyModelSelectorExpandedChanged: () => {},
    connect: async () => {},
    sandboxPreference: {
      onChange: () => () => {},
      resolve: () => false,
      set: async () => {},
    },
  }
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop]
      return mock(() => {})
    },
  }) as unknown as import("../../src/services/cli-backend").KiloConnectionService
}

function makeHost(panel: any, store?: Store, connOverride?: import("../../src/services/cli-backend").KiloConnectionService) {
  const extUri: any = { fsPath: "/tmp/ext", scheme: "file", path: "/tmp/ext" }
  const ws = store ?? fakeStore()
  const ctx: any = {
    subscriptions: [],
    workspaceState: ws,
    globalState: fakeStore(),
    extensionUri: extUri,
  }
  const conn = connOverride ?? fakeConn()
  const remote: any = {
    onChange: () => () => {},
    getState: () => ({ enabled: false, connected: false }),
    updateFromEvent: () => {},
    clearState: () => {},
    refresh: async () => {},
    handleMessage: async () => null,
  }
  const canonical: any = null
  const host = new VscodeHost(extUri, conn as any, ctx, remote, canonical)
  return { host, ctx, conn, ws }
}

describe("KiloProvider fixture reload ownership", () => {
  it("validates webview, resets readiness, coalesces overlapping", async () => {
    const provider = Object.create(KiloProvider.prototype) as any
    provider.webview = { postMessage: async () => true }
    provider.disposed = false
    provider.isWebviewReady = true
    provider.readyResolvers = []
    provider.reloadInFlight = null
    provider.waitForReady = KiloProvider.prototype.waitForReady.bind(provider)
    provider.reloadWebviewForFixture = KiloProvider.prototype.reloadWebviewForFixture.bind(provider)
    provider.getReadyResolverCountForFixture = KiloProvider.prototype.getReadyResolverCountForFixture.bind(provider)

    let html = "v1"
    const assign = () => {
      html = "v2-agent-manager.js"
    }
    const p1 = provider.reloadWebviewForFixture(assign)
    expect(provider.isWebviewReady).toBe(false)
    expect(html).toBe("v2-agent-manager.js")
    expect(provider.getReadyResolverCountForFixture()).toBe(1)
    const p2 = provider.reloadWebviewForFixture(() => {
      html = "v3"
    })
    expect(p2).toBe(p1)
    expect(html).toBe("v2-agent-manager.js")
    expect(provider.getReadyResolverCountForFixture()).toBe(1)

    let resolved = false
    p1.then(() => (resolved = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(false)

    provider.isWebviewReady = true
    provider.readyResolvers.splice(0).forEach((fn: () => void) => fn())
    await p1
    expect(resolved).toBe(true)
    expect(provider.reloadInFlight).toBeNull()
    expect(provider.getReadyResolverCountForFixture()).toBe(0)

    provider.disposed = true
    expect(() => provider.reloadWebviewForFixture(() => {})).toThrow()
    provider.disposed = false
    provider.webview = null
    expect(() => provider.reloadWebviewForFixture(() => {})).toThrow()
  })

  it("pending reload then dispose aborts with webview reload aborted not success", async () => {
    const provider = Object.create(KiloProvider.prototype) as any
    provider.webview = { postMessage: async () => true }
    provider.disposed = false
    provider.isWebviewReady = true
    provider.readyResolvers = []
    provider.reloadInFlight = null
    provider.waitForReady = KiloProvider.prototype.waitForReady.bind(provider)
    provider.reloadWebviewForFixture = KiloProvider.prototype.reloadWebviewForFixture.bind(provider)
    provider.dispose = KiloProvider.prototype.dispose.bind(provider)
    provider.connectionService = { unregisterVisible: () => {}, unregisterAttached: () => {} } as any
    provider.streams = { dispose: () => {}, focus: () => {} } as any
    provider.visibleTaskStreams = { clear: () => {} } as any
    provider.aborts = { clear: () => {} } as any
    provider.trackedSessionIds = new Set()
    provider.syncedChildSessions = new Set()
    provider.draftSessions = new Map()
    provider.sessionDirectories = new Map()
    provider.sessionStatusMap = new Map()
    provider.cleanupRetries = new Map()
    provider.cleanupTargets = new Map()
    provider.anacondaDesktop = { dispose: () => {} } as any
    provider.requirements = { dispose: () => {} } as any
    provider.ignoreController = null

    let html = "v1"
    const p = provider.reloadWebviewForFixture(() => {
      html = "v2"
    })
    expect(html).toBe("v2")
    expect(provider.isWebviewReady).toBe(false)
    // Simulate panel close that disposes provider before webviewReady
    provider.dispose()
    // dispose wakes resolver
    let rejected: Error | undefined
    try {
      await p
    } catch (e) {
      rejected = e as Error
    }
    expect(rejected?.message).toBe("webview reload aborted")
    expect(provider.reloadInFlight).toBeNull()
  })

  it("assign throws removes exact waiter and permits clean retry", async () => {
    const provider = Object.create(KiloProvider.prototype) as any
    provider.webview = { postMessage: async () => true }
    provider.disposed = false
    provider.isWebviewReady = true
    provider.readyResolvers = []
    provider.reloadInFlight = null
    provider.waitForReady = KiloProvider.prototype.waitForReady.bind(provider)
    provider.reloadWebviewForFixture = KiloProvider.prototype.reloadWebviewForFixture.bind(provider)
    provider.getReadyResolverCountForFixture = KiloProvider.prototype.getReadyResolverCountForFixture.bind(provider)

    const before = provider.getReadyResolverCountForFixture()
    let err: Error | undefined
    try {
      await provider.reloadWebviewForFixture(() => {
        throw new Error("assign fail")
      })
    } catch (e) {
      err = e as Error
    }
    expect(err?.message).toBe("webview reload assign failed")
    expect(provider.getReadyResolverCountForFixture()).toBe(before)
    expect(provider.reloadInFlight).toBeNull()

    // retry succeeds after real ready
    let html = "v1"
    const p2 = provider.reloadWebviewForFixture(() => {
      html = "v2"
    })
    expect(html).toBe("v2")
    provider.isWebviewReady = true
    provider.readyResolvers.splice(0).forEach((fn: () => void) => fn())
    await p2
    expect(html).toBe("v2")
    expect(provider.reloadInFlight).toBeNull()
  })

  it("overlap coalesces same rejection and same success", async () => {
    const provider = Object.create(KiloProvider.prototype) as any
    provider.webview = { postMessage: async () => true }
    provider.disposed = false
    provider.isWebviewReady = true
    provider.readyResolvers = []
    provider.reloadInFlight = null
    provider.waitForReady = KiloProvider.prototype.waitForReady.bind(provider)
    provider.reloadWebviewForFixture = KiloProvider.prototype.reloadWebviewForFixture.bind(provider)
    provider.getReadyResolverCountForFixture = KiloProvider.prototype.getReadyResolverCountForFixture.bind(provider)
    provider.connectionService = { unregisterVisible: () => {}, unregisterAttached: () => {} } as any
    provider.streams = { dispose: () => {}, focus: () => {} } as any
    provider.visibleTaskStreams = { clear: () => {} } as any
    provider.aborts = { clear: () => {} } as any
    provider.trackedSessionIds = new Set()
    provider.syncedChildSessions = new Set()
    provider.draftSessions = new Map()
    provider.sessionDirectories = new Map()
    provider.sessionStatusMap = new Map()
    provider.cleanupRetries = new Map()
    provider.cleanupTargets = new Map()
    provider.anacondaDesktop = { dispose: () => {} } as any
    provider.requirements = { dispose: () => {} } as any
    provider.ignoreController = null
    provider.dispose = KiloProvider.prototype.dispose.bind(provider)

    // success coalesce
    let v = 1
    const p1 = provider.reloadWebviewForFixture(() => {
      v = 2
    })
    const p2 = provider.reloadWebviewForFixture(() => {
      v = 3
    })
    expect(p2).toBe(p1)
    expect(v).toBe(2)
    provider.isWebviewReady = true
    provider.readyResolvers.splice(0).forEach((fn: () => void) => fn())
    await Promise.all([p1, p2])
    expect(v).toBe(2)

    // reset for rejection coalesce
    provider.disposed = false
    provider.webview = { postMessage: async () => true }
    provider.isWebviewReady = true
    provider.readyResolvers = []
    provider.reloadInFlight = null
    const q1 = provider.reloadWebviewForFixture(() => {})
    const q2 = provider.reloadWebviewForFixture(() => {})
    expect(q2).toBe(q1)
    // abort via dispose
    provider.dispose()
    let e1: Error | undefined
    let e2: Error | undefined
    try {
      await q1
    } catch (e) {
      e1 = e as Error
    }
    try {
      await q2
    } catch (e) {
      e2 = e as Error
    }
    expect(e1?.message).toBe("webview reload aborted")
    expect(e2?.message).toBe("webview reload aborted")
  })

  it("VscodeHost missing atomic API rejects fixed category", async () => {
    const panel = makeLifecyclePanel()
    const { host } = makeHost(panel)
    const providerStub: any = {
      waitForReady: async () => {},
      dispose: () => {},
    }
    // Simulate host with panel but provider lacking reload method
    ;(host as any).amPanel = panel
    ;(host as any).amProvider = providerStub
    ;(host as any).amContext = { dispose: () => {} } as any
    ;(host as any).amStreams = { dispose: () => {} }
    let err: Error | undefined
    try {
      await (host as any).reloadAgentManagerPanelForFixture()
    } catch (e) {
      err = e as Error
    }
    expect(err?.message).toContain("Host does not support AM reload")
  })
})

describe("AgentManagerProvider targeted AM reload", () => {
  it("preserves same PanelContext/provider/streams, html changes, waits for real ready, no synthetic injection", async () => {
    const persisted = { v: 1, sessions: ["ses_a", "ses_b"], order: ["ses_a", "ses_b"], active: "ses_a" }
    const store = fakeStore(persisted)
    const panel = makeLifecyclePanel()
    const conn = fakeConnWithValidClient()
    const { host } = makeHost(panel, store, conn)
    const ctx = host.wrapExistingPanel(panel as any, { onBeforeMessage: async (m) => m })
    const provider = (host as any).amProvider as InstanceType<typeof KiloProvider>
    const amStreams = (host as any).amStreams
    const streamsDispose = amStreams.dispose as unknown as ReturnType<typeof mock>
    // Attach AgentManagerProvider
    const ag = new AgentManagerProvider(host as any, conn)
    ;(ag as any).attachPanel(ctx)
    // Wire real production path: KiloProvider's captured webview handler must delegate agentManager.* to AgentManagerProvider
    ;(provider as any).onBeforeMessage = (msg: Record<string, unknown>) => (ag as any).onMessage(msg)
    // Wait for initial state hydration via real webviewReady handler
    const initialHandler = panel._getMessageHandler()
    expect(initialHandler).toBeDefined()
    // Capture console errors to ensure no unexpected TypeError
    const errLogs: unknown[] = []
    const origError = console.error
    const origWarn = console.warn
    console.error = (...args: unknown[]) => errLogs.push(args)
    console.warn = (...args: unknown[]) => {
      const text = String(args[0] ?? "")
      // Allow expected logs but not TypeError null connection
      if (text.includes("TypeError") || text.includes("not connected")) errLogs.push(args)
    }
    await initialHandler!({ type: "webviewReady" })
    // Allow async stateReady to settle
    await new Promise((r) => setTimeout(r, 10))
    await (ag as any).stateReady
    console.error = origError
    console.warn = origWarn
    expect(errLogs).toEqual([])

    expect([...(ag as any).managedSessions.keys()].sort()).toEqual(["ses_a", "ses_b"])
    const oldHtml = panel.webview.html
    const oldCtx = ctx
    const oldProvider = provider

    // Track dispose counts before reload
    const beforeStreamsCalls = (amStreams.dispose as unknown as { mock: { calls: unknown[] } }).mock.calls.length

    // Clear captured messages before reload to isolate reload effects
    panel._messages.length = 0
    const reloadPromise = (host as any).reloadAgentManagerPanelForFixture()
    // html reassigned synchronously (provider sets isWebviewReady false before assign)
    expect(panel.webview.html).not.toBe(oldHtml)
    expect(panel.webview.html).toContain("<html")
    // same identities preserved
    expect((host as any).amPanel).toBe(panel)
    expect((host as any).amProvider).toBe(oldProvider)
    expect((host as any).amContext).toBe(oldCtx)
    expect((ag as any).panel).toBe(oldCtx)
    // no disposals during reload
    expect((amStreams.dispose as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(beforeStreamsCalls)

    let resolved = false
    reloadPromise.then(() => (resolved = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(false)

    // real webviewReady via stored handler
    const reloadHandler = panel._getMessageHandler()
    expect(reloadHandler).toBeDefined()
    errLogs.length = 0
    console.error = (...args: unknown[]) => errLogs.push(args)
    console.warn = (...args: unknown[]) => {
      const text = String(args[0] ?? "")
      if (text.includes("TypeError") || text.includes("not connected")) errLogs.push(args)
    }
    await reloadHandler!({ type: "webviewReady" })
    await reloadPromise
    console.error = origError
    console.warn = origWarn
    expect(errLogs).toEqual([])
    expect(resolved).toBe(true)
    // still same identities
    expect((host as any).amPanel).toBe(panel)
    expect((host as any).amProvider).toBe(oldProvider)
    // request normal state after reload - verify real provider output mandatory via real requestState path
    panel._messages.length = 0
    errLogs.length = 0
    console.error = (...args: unknown[]) => errLogs.push(args)
    console.warn = (...args: unknown[]) => {
      const text = String(args[0] ?? "")
      if (text.includes("TypeError") || text.includes("not connected")) errLogs.push(args)
    }
    await reloadHandler!({ type: "agentManager.requestState" })
    // bounded wait for real provider output: onRequestState pushes via stateReady.then and postMessage
    const deadline = Date.now() + 500
    let stateMsgs: unknown[] = []
    while (Date.now() < deadline) {
      stateMsgs = panel._messages.filter((m: any) => m && m.type === "agentManager.state")
      if (stateMsgs.length > 0) break
      await new Promise((r) => setTimeout(r, 10))
    }
    console.error = origError
    console.warn = origWarn
    expect(errLogs).toEqual([])
    expect(stateMsgs.length).toBeGreaterThan(0)
    const latest = stateMsgs[stateMsgs.length - 1] as any
    expect(latest.type).toBe("agentManager.state")
    expect([...latest.sessions].map((s: any) => s.id).sort()).toEqual(["ses_a", "ses_b"])
    expect(latest.tabOrder).toEqual({ local: ["ses_a", "ses_b"] })
    expect(latest.activeSessionId).toBe("ses_a")
    expect(latest.isGitRepo).toBe(true)
    // allow legitimate real sessionsLoaded per production catalog path; forbid runner/test synthetic injection (preserveSessionIds marker)
    const syntheticTagged = panel._messages.filter(
      (m: any) => m && m.type === "sessionsLoaded" && (m as any).preserveSessionIds !== undefined,
    )
    expect(syntheticTagged.length).toBe(0)
    expect([...(ag as any).managedSessions.keys()].sort()).toEqual(["ses_a", "ses_b"])
  })

  it("pending reload then panel close aborts, host streams once, provider once, refs cleared, later reload rejects", async () => {
    const panel = makeLifecyclePanel()
    const conn = fakeConnWithValidClient()
    const { host } = makeHost(panel, undefined, conn)
    const ctx = host.wrapExistingPanel(panel as any, { onBeforeMessage: async (m) => m })
    const provider = (host as any).amProvider as InstanceType<typeof KiloProvider>
    const ag = new AgentManagerProvider(host as any, conn)
    ;(ag as any).attachPanel(ctx)
    const h = panel._getMessageHandler()
    await h!({ type: "webviewReady" })
    await new Promise((r) => setTimeout(r, 10))
    await (ag as any).stateReady

    // intercept provider dispose count and streams dispose count
    const origDispose = (provider as any).dispose.bind(provider)
    let providerDisposeCalls = 0
    ;(provider as any).dispose = () => {
      providerDisposeCalls++
      return origDispose()
    }
    const streams = (host as any).amStreams
    let streamsCalls = 0
    const origStreamsDispose = streams.dispose.bind(streams)
    streams.dispose = () => {
      streamsCalls++
      return origStreamsDispose()
    }

    const pending = (host as any).reloadAgentManagerPanelForFixture()
    let pendingErr: Error | undefined
    pending.catch((e: Error) => (pendingErr = e))
    await new Promise((r) => setTimeout(r, 5))
    expect((provider as any).reloadInFlight).not.toBeNull()

    // actual panel close while reload pending
    panel.dispose()

    // pending should reject with aborted
    let err: Error | undefined
    try {
      await pending
    } catch (e) {
      err = e as Error
    }
    expect(err?.message).toBe("webview reload aborted")
    // streams disposed exactly once by host
    expect(streamsCalls).toBe(1)
    // provider disposed once via AgentManagerProvider ctx.sessions.dispose (not host)
    expect(providerDisposeCalls).toBe(1)
    // host refs cleared
    expect((host as any).amPanel).toBeUndefined()
    expect((host as any).amProvider).toBeUndefined()
    expect((host as any).amContext).toBeUndefined()
    expect((host as any).amStreams).toBeUndefined()

    // later reload must reject (no live panel)
    let laterErr: Error | undefined
    try {
      await (host as any).reloadAgentManagerPanelForFixture()
    } catch (e) {
      laterErr = e as Error
    }
    expect(laterErr).toBeDefined()
  })

  it("explicit context.dispose then panel onDidDispose no double streams/provider", async () => {
    const panel = makeLifecyclePanel()
    const conn = fakeConnWithValidClient()
    const { host } = makeHost(panel, undefined, conn)
    const ctx = host.wrapExistingPanel(panel as any, { onBeforeMessage: async (m) => m })
    const provider = (host as any).amProvider as InstanceType<typeof KiloProvider>
    const ag = new AgentManagerProvider(host as any, conn)
    ;(ag as any).attachPanel(ctx)
    const h = panel._getMessageHandler()
    await h!({ type: "webviewReady" })
    await new Promise((r) => setTimeout(r, 5))
    await (ag as any).stateReady

    const streams = (host as any).amStreams
    let streamsCalls = 0
    const origStreamsDispose = streams.dispose.bind(streams)
    streams.dispose = () => {
      streamsCalls++
      return origStreamsDispose()
    }
    let providerCalls = 0
    const origProvDispose = (provider as any).dispose.bind(provider)
    ;(provider as any).dispose = () => {
      providerCalls++
      return origProvDispose()
    }

    // explicit dispose via PanelContext
    ctx.dispose()
    expect(streamsCalls).toBe(1)
    expect(providerCalls).toBe(1)
    expect((host as any).amPanel).toBeUndefined()
    // second firing of panel onDidDispose (host and ag callbacks) should be no-ops
    panel.dispose()
    expect(streamsCalls).toBe(1)
    expect(providerCalls).toBe(1)
  })

  it("same panel-dispose callback invoked twice and context.dispose twice are idempotent", async () => {
    const panel = makeLifecyclePanel()
    const conn = fakeConnWithValidClient()
    const { host } = makeHost(panel, undefined, conn)
    const ctx = host.wrapExistingPanel(panel as any, { onBeforeMessage: async (m) => m })
    const provider = (host as any).amProvider as InstanceType<typeof KiloProvider>
    const ag = new AgentManagerProvider(host as any, conn)
    ;(ag as any).attachPanel(ctx)
    const h = panel._getMessageHandler()
    await h!({ type: "webviewReady" })
    await new Promise((r) => setTimeout(r, 5))
    await (ag as any).stateReady

    const streams = (host as any).amStreams
    let streamsCalls = 0
    const origStreamsDispose = streams.dispose.bind(streams)
    streams.dispose = () => {
      streamsCalls++
      return origStreamsDispose()
    }
    let providerCalls = 0
    const origProvDispose = (provider as any).dispose.bind(provider)
    ;(provider as any).dispose = () => {
      providerCalls++
      return origProvDispose()
    }

    // Capture both onDidDispose callbacks (host + AgentManagerProvider) and invoke each twice
    const cbs = [...(panel as any)._disposeCbs] as Array<() => void>
    expect(cbs.length).toBeGreaterThanOrEqual(2) // host + ag
    for (const cb of cbs) {
      cb()
      cb()
    }
    expect(providerCalls).toBe(1)
    expect(streamsCalls).toBe(1)
    expect((host as any).amPanel).toBeUndefined()

    // Now create fresh panel/context to test double context.dispose
    const panel2 = makeLifecyclePanel()
    const { host: host2 } = makeHost(panel2, undefined, fakeConnWithValidClient())
    const ctx2 = host2.wrapExistingPanel(panel2 as any, { onBeforeMessage: async (m) => m })
    const provider2 = (host2 as any).amProvider as InstanceType<typeof KiloProvider>
    const ag2 = new AgentManagerProvider(host2 as any, fakeConnWithValidClient())
    ;(ag2 as any).attachPanel(ctx2)
    const h2 = panel2._getMessageHandler()
    await h2!({ type: "webviewReady" })
    await new Promise((r) => setTimeout(r, 5))
    await (ag2 as any).stateReady
    const streams2 = (host2 as any).amStreams
    let streamsCalls2 = 0
    const origStreamsDispose2 = streams2.dispose.bind(streams2)
    streams2.dispose = () => {
      streamsCalls2++
      return origStreamsDispose2()
    }
    let providerCalls2 = 0
    const origProvDispose2 = (provider2 as any).dispose.bind(provider2)
    ;(provider2 as any).dispose = () => {
      providerCalls2++
      return origProvDispose2()
    }
    ctx2.dispose()
    ctx2.dispose()
    expect(streamsCalls2).toBe(1)
    expect(providerCalls2).toBe(1)
    expect((host2 as any).amPanel).toBeUndefined()
    expect((host2 as any).amProvider).toBeUndefined()
    expect((host2 as any).amContext).toBeUndefined()
  })

  it("overlapping reload coalesces same result", async () => {
    const panel = makeLifecyclePanel()
    const conn = fakeConnWithValidClient()
    const { host } = makeHost(panel, undefined, conn)
    host.wrapExistingPanel(panel as any, { onBeforeMessage: async (m) => m })
    const handler = panel._getMessageHandler()
    await handler!({ type: "webviewReady" })
    await new Promise((r) => setTimeout(r, 5))
    const provider = (host as any).amProvider as InstanceType<typeof KiloProvider>

    const p1 = (host as any).reloadAgentManagerPanelForFixture()
    const p2 = (host as any).reloadAgentManagerPanelForFixture()
    // Host wraps provider promise, so p1/p2 are distinct async wrappers but share same inner reloadInFlight
    const inner = (provider as any).reloadInFlight
    expect(inner).not.toBeNull()
    const htmlAfter = panel.webview.html
    // trigger ready via real handler
    const h = panel._getMessageHandler()
    await h!({ type: "webviewReady" })
    await Promise.all([p1, p2])
    expect(panel.webview.html).toBe(htmlAfter)
  })

  it("runner lc-reload does not post synthetic state, only targeted reload path pushes", async () => {
    const src = await Bun.file(`${import.meta.dir}/../../tests/e2e/runner.ts`).text()
    const fnStart = src.indexOf("async function serviceRealLifecycleBoundary")
    const fnSlice = src.slice(fnStart, fnStart + 15000)
    const lcIdx = fnSlice.indexOf("lc-reload-request")
    const lcBlock = fnSlice.slice(lcIdx, lcIdx + 2000)
    const hasTargeted = lcBlock.includes("reloadAgentManagerWebview") || lcBlock.includes("CMD_RELOAD_AM")
    expect(hasTargeted).toBeTrue()
    expect(lcBlock).not.toContain("post(")
    expect(lcBlock).not.toContain("sessionsLoaded")
    expect(lcBlock).toContain("CMD_SETTLE")
  })
})
