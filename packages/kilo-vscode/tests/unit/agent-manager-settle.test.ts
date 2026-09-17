import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test"

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

function fakeStore() {
  const data = new Map<string, unknown>()
  return {
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: (k: string, v: unknown) => {
      data.set(k, v)
      return Promise.resolve()
    },
  }
}

function fakeConn() {
  const base: Record<string, unknown> = {
    onEventFiltered: () => () => {},
    onStateChange: () => () => {},
    getConnectionState: () => "disconnected",
    registerVisible: mock(() => {}),
    registerAttached: mock(() => {}),
    getClient: () => {
      throw new Error("not connected")
    },
    getClientAsync: mock(async () => {
      throw new Error("not connected")
    }),
  }
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop]
      return mock(() => {})
    },
  }) as any
}

function fakeHost(store: any) {
  return {
    workspaceStore: store,
    workspacePath: () => "/tmp/ws",
    createOutput: () => ({ appendLine: () => {}, dispose: () => {} }),
    capture: () => {},
    showError: () => {},
    openFile: () => {},
    extensionKeybindings: () => [],
    serverPort: () => undefined,
    copyToClipboard: () => {},
    openExternal: () => {},
    dispose: () => {},
  } as any
}

function fakeSessions(order: string[], opts?: { settledError?: Error; catalog?: boolean }) {
  const sessions: any = {
    getSessionDirectories: () => new Map(),
    trackSession: () => {},
    refreshSessions: async () => {
      order.push("refresh")
    },
    registerSession: () => {},
    recoverPendingPrompts: () => {},
    onFollowupAdopted: () => ({ dispose: () => {} }),
    acknowledgeDraft: () => {},
    abortSessions: async () => {},
    dispose: () => {},
  }
  if (opts?.catalog !== false) {
    sessions.waitForCatalogSettled = async () => {
      order.push("catalog")
      if (opts?.settledError) throw opts.settledError
    }
  }
  return sessions
}

function attachPanel(provider: any, sessions: any) {
  const ctx: any = {
    visible: true,
    active: true,
    postMessage: () => {},
    waitForReady: async () => {},
    waitForActive: async () => {},
    reveal: () => {},
    sessions,
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
    dispose: () => {},
  }
  provider.panel = ctx
  return ctx
}

describe("settleSessionsForFixture", () => {
  it("barriers, refreshes explicitly, then barriers again", async () => {
    const order: string[] = []
    const conn = fakeConn()
    const provider = new AgentManagerProvider(fakeHost(fakeStore()), conn)
    attachPanel(provider, fakeSessions(order))
    await (provider as any).settleSessionsForFixture()
    expect(order).toEqual(["catalog", "refresh", "catalog"])
    // The old getClientAsync crutch is gone: the provider-owned barrier owns
    // connection readiness, so the fixture path never touches the client.
    expect(conn.getClientAsync).toHaveBeenCalledTimes(0)
  })

  it("fails fast on terminal barrier failure instead of seeding", async () => {
    const order: string[] = []
    const provider = new AgentManagerProvider(fakeHost(fakeStore()), fakeConn())
    attachPanel(provider, fakeSessions(order, { settledError: new Error("catalog settled: timeout after 1ms") }))
    await expect((provider as any).settleSessionsForFixture()).rejects.toThrow("timeout")
    // Explicit refresh never runs when the first barrier rejects.
    expect(order).toEqual(["catalog"])
  })

  it("falls back to a single refresh when the host predates the barrier", async () => {
    const order: string[] = []
    const provider = new AgentManagerProvider(fakeHost(fakeStore()), fakeConn())
    attachPanel(provider, fakeSessions(order, { catalog: false }))
    await (provider as any).settleSessionsForFixture()
    expect(order).toEqual(["refresh"])
  })

  it("is a no-op without a panel", async () => {
    const provider = new AgentManagerProvider(fakeHost(fakeStore()), fakeConn())
    await (provider as any).settleSessionsForFixture()
  })

  it("drains in-flight close work before the first catalog barrier", async () => {
    const order: string[] = []
    const provider = new AgentManagerProvider(fakeHost(fakeStore()), fakeConn())
    const sessions = fakeSessions(order)
    attachPanel(provider, sessions)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tracked = (provider as any).trackOwned(gate.then(() => void order.push("close")))
    const settling = (provider as any).settleSessionsForFixture()
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual([])
    release()
    await tracked
    await settling
    expect(order).toEqual(["close", "catalog", "refresh", "catalog"])
    expect((provider as any).ownedOps?.size ?? 0).toBe(0)
    expect((provider as any).refreshPromise).toBeNull()
  })

  it("drains observation singleflight refreshes started before settle", async () => {
    const order: string[] = []
    const provider = new AgentManagerProvider(fakeHost(fakeStore()), fakeConn())
    let calls = 0
    let releaseRefresh!: () => void
    const sessions: any = {
      getSessionDirectories: () => new Map(),
      trackSession: () => {},
      refreshSessions: () => {
        calls += 1
        if (calls === 1) {
          return new Promise<void>((resolve) => {
            releaseRefresh = resolve
          }).then(() => void order.push("refresh"))
        }
        order.push("refresh")
        return Promise.resolve()
      },
      registerSession: () => {},
      recoverPendingPrompts: () => {},
      onFollowupAdopted: () => ({ dispose: () => {} }),
      acknowledgeDraft: () => {},
      abortSessions: async () => {},
      dispose: () => {},
      waitForCatalogSettled: async () => {
        order.push("catalog")
      },
    }
    attachPanel(provider, sessions)
    const pending = (provider as any).handleObservationRefresh()
    const settling = (provider as any).settleSessionsForFixture()
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual([])
    releaseRefresh()
    await pending
    await settling
    expect(order.filter((e) => e === "refresh").length).toBeGreaterThanOrEqual(1)
    expect(order[order.length - 1]).toBe("catalog")
    expect((provider as any).refreshPromise).toBeNull()
  })

  it("drains work spawned while draining to a stable generation", async () => {
    const order: string[] = []
    const provider = new AgentManagerProvider(fakeHost(fakeStore()), fakeConn())
    const sessions = fakeSessions(order)
    attachPanel(provider, sessions)
    let releaseSecond!: () => void
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstTracked = (provider as any).trackOwned(
      first.then(() => {
        order.push("first")
        void (provider as any).trackOwned(second.then(() => void order.push("second"))).catch(() => {})
      }),
    )
    const settling = (provider as any).settleSessionsForFixture()
    await Promise.resolve()
    await Promise.resolve()
    releaseFirst()
    await firstTracked
    expect(order).toEqual(["first"])
    releaseSecond()
    await settling
    expect(order).toEqual(["first", "second", "catalog", "refresh", "catalog"])
  })

  it("leaves no owned work that could post prior-phase state after return", async () => {
    const order: string[] = []
    const provider = new AgentManagerProvider(fakeHost(fakeStore()), fakeConn())
    const posted: unknown[] = []
    const sessions = fakeSessions(order)
    const ctx = attachPanel(provider, sessions)
    ctx.postMessage = (msg: unknown) => void posted.push(msg)
    await (provider as any).settleSessionsForFixture()
    expect((provider as any).ownedOps?.size ?? 0).toBe(0)
    expect((provider as any).refreshPromise).toBeNull()
    expect((provider as any).persistInFlight).toBeNull()
    expect((provider as any).pendingSnapshot).toBeNull()
  })

  it("times out when owned work never settles", async () => {
    const provider = new AgentManagerProvider(fakeHost(fakeStore()), fakeConn())
    attachPanel(provider, fakeSessions([]))
    void (provider as any).trackOwned(new Promise<void>(() => {}))
    await expect((provider as any).drainOwnedForFixture(10)).rejects.toThrow("timeout")
  })

  it("rejects the drain when the panel is disposed mid-drain", async () => {
    const provider = new AgentManagerProvider(fakeHost(fakeStore()), fakeConn())
    attachPanel(provider, fakeSessions([]))
    void (provider as any).trackOwned(new Promise<void>(() => {}))
    const draining = (provider as any).drainOwnedForFixture(200)
    ;(provider as any).panel = undefined
    await expect(draining).rejects.toThrow("disposed")
  })

  it("propagates owned-work errors instead of seeding on top", async () => {
    const provider = new AgentManagerProvider(fakeHost(fakeStore()), fakeConn())
    attachPanel(provider, fakeSessions([]))
    const failing = (provider as any).trackOwned(Promise.reject(new Error("close failed")))
    void failing.catch(() => {})
    await expect((provider as any).drainOwnedForFixture(1000)).rejects.toThrow("close failed")
  })
})
