import { describe, expect, it } from "bun:test"
import { KiloProvider } from "./KiloProvider"

type State = "connecting" | "connected" | "disconnected" | "error"

type Internals = {
  connectionState: State
  connectionGeneration: number
  pendingSessionRefresh: boolean
  initConnectionPromise: Promise<void> | null
  webview: { postMessage: (message: unknown) => Promise<unknown> } | null
  disposed: boolean
  catalogProgressCbs: Array<() => void>
  enqueueSessionLoad: (task: () => Promise<void>) => Promise<void>
  handleLoadSessions: (cursor?: string) => Promise<void>
  flushPendingSessionRefresh: (reason: string) => Promise<void>
  refreshSessions: () => Promise<void>
  dispose: () => void
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms))

function createClient() {
  const calls: Array<{ limit: number; cursor?: string }> = []
  const client = {
    _calls: calls,
    experimental: {
      session: {
        list: async (params: { directory: string; limit: number; cursor?: string }) => {
          calls.push({ limit: params.limit, cursor: params.cursor })
          return { data: [], response: { headers: { get: () => null } } }
        },
      },
    },
    session: { list: async () => ({ data: [] }), get: async () => ({ data: undefined }) },
    provider: { list: async () => ({ data: { all: [], connected: {}, default: {} } }) },
    app: { agents: async () => ({ data: [] }), skills: async () => ({ data: [] }) },
    config: { get: async () => ({ data: {} }) },
    indexing: { status: async () => ({ data: { state: "disabled" } }) },
    kilo: { profile: async () => ({ data: {} }) },
  }
  return client as unknown as typeof client & { _calls: typeof calls }
}

function createConnection() {
  let current: ReturnType<typeof createClient> | null = null
  let state: State = "connecting"
  let error: Error | null = null
  const listeners = new Set<(s: State) => void>()
  const conn = {
    connect: async () => {},
    getClient: () => {
      if (!current) throw new Error("Not connected")
      return current
    },
    onEventFiltered: () => () => undefined,
    onStateChange: (listener: (s: State) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onLanguageChanged: () => () => undefined,
    onProfileChanged: () => () => undefined,
    onFavoritesChanged: () => () => undefined,
    onModelSelectorExpandedChanged: () => () => undefined,
    getConfigRevision: () => 0,
    advanceConfigRevision: () => {},
    onConfigRevision: () => () => undefined,
    registerDirectoryProvider: () => () => undefined,
    getServerInfo: () => ({ port: 12345 }),
    getServerConfig: () => ({ baseUrl: "http://127.0.0.1:12345", password: "test" }),
    unregisterVisible: () => {},
    unregisterAttached: () => {},
    getConnectionState: () => state,
    getConnectionError: () => error,
    resolveEventSessionId: () => undefined,
    recordMessageSessionId: () => undefined,
    sandboxPreference: undefined as unknown as never,
    _setClient: (c: ReturnType<typeof createClient> | null) => {
      current = c
    },
    _setState: (s: State) => {
      state = s
      for (const l of [...listeners]) l(s)
    },
    _setError: (e: Error | null) => {
      error = e
    },
    _stateListeners: () => listeners.size,
  }
  return conn
}

function makeProvider(conn: ReturnType<typeof createConnection>) {
  const provider = new KiloProvider({} as never, conn as never)
  const internal = provider as unknown as Internals
  const posted: unknown[] = []
  internal.webview = {
    postMessage: async (msg: unknown) => {
      posted.push(msg)
      return {}
    },
  }
  return { provider, internal, posted }
}

function catalogPosts(posted: unknown[]) {
  return posted.filter((m) => (m as { type?: string }).type === "sessionsLoaded")
}

describe("KiloProvider.waitForCatalogSettled", () => {
  it("stays pending while connecting until the initialize tail flush posts", async () => {
    const conn = createConnection()
    const { provider, internal, posted } = makeProvider(conn)
    try {
      internal.connectionState = "connecting"
      // Real deferral path: no client/private list while connecting.
      await internal.handleLoadSessions()
      expect(internal.pendingSessionRefresh).toBe(true)

      const order: string[] = []
      let done = false
      const waiter = provider.waitForCatalogSettled({ timeoutMs: 5_000 }).then(() => {
        done = true
        order.push("settled")
      })
      await tick(25)
      expect(done).toBe(false)

      // Simulate the initialize tail: connection comes up...
      const client = createClient()
      conn._setClient(client)
      internal.connectionState = "connected"
      conn._setState("connected")
      await tick(25)
      // ...but the pending flush has not posted yet, so still pending.
      expect(done).toBe(false)

      // Simulate the tail flush posting the authoritative catalog.
      const flush = internal.flushPendingSessionRefresh("test-tail")
      await flush
      order.push("posted")
      await waiter
      expect(done).toBe(true)
      expect(order).toEqual(["posted", "settled"])
      expect(catalogPosts(posted)).toHaveLength(1)
      expect(internal.pendingSessionRefresh).toBe(false)

      // No catalog post lands after the settle return.
      await tick(25)
      expect(catalogPosts(posted)).toHaveLength(1)
    } finally {
      provider.dispose()
    }
  })

  it("settles immediately when already connected and drains queued loads first", async () => {
    const conn = createConnection()
    const { provider, internal } = makeProvider(conn)
    try {
      const client = createClient()
      conn._setClient(client)
      internal.connectionState = "connected"

      // Empty chain resolves without waiting.
      await provider.waitForCatalogSettled({ timeoutMs: 1_000 })

      // A queued load is drained before the barrier resolves.
      const gate = deferred()
      const order: string[] = []
      void internal.enqueueSessionLoad(() => gate.promise.then(() => {
        order.push("task")
      }))
      let done = false
      const waiter = provider.waitForCatalogSettled({ timeoutMs: 5_000 }).then(() => {
        done = true
        order.push("settled")
      })
      await tick(25)
      expect(done).toBe(false)
      gate.resolve()
      await waiter
      expect(order).toEqual(["task", "settled"])
    } finally {
      provider.dispose()
    }
  })

  it("repeats across a generation bump and returns only after the latest generation settles", async () => {
    const conn = createConnection()
    const { provider, internal } = makeProvider(conn)
    try {
      const client = createClient()
      conn._setClient(client)
      internal.connectionState = "connecting"
      const gen0 = internal.connectionGeneration

      const init1 = deferred()
      internal.initConnectionPromise = init1.promise
      const order: string[] = []
      let done = false
      const waiter = provider.waitForCatalogSettled({ timeoutMs: 5_000 }).then(() => {
        done = true
        order.push("settled")
      })
      await tick(10)
      expect(done).toBe(false)

      // Replacement starts: generation moves and a new init is active.
      internal.connectionGeneration = gen0 + 1
      const init2 = deferred()
      internal.initConnectionPromise = init2.promise
      init1.resolve()
      order.push("init1done")
      await tick(25)
      expect(done).toBe(false)

      // Latest generation settles: init clears, connected, drained.
      internal.connectionState = "connected"
      internal.initConnectionPromise = null
      init2.resolve()
      order.push("init2done")
      await waiter
      expect(done).toBe(true)
      expect(order).toEqual(["init1done", "init2done", "settled"])
      expect(internal.connectionGeneration).toBe(gen0 + 1)
    } finally {
      provider.dispose()
    }
  })

  it("rejects on terminal connection error and cleans listeners", async () => {
    const conn = createConnection()
    const { provider, internal } = makeProvider(conn)
    try {
      internal.connectionState = "error"
      conn._setError(new Error("boom"))
      await expect(provider.waitForCatalogSettled({ timeoutMs: 1_000 })).rejects.toThrow("boom")
      expect(internal.catalogProgressCbs).toHaveLength(0)
      expect(conn._stateListeners()).toBe(0)
    } finally {
      provider.dispose()
    }
  })

  it("rejects on timeout and cleans listeners/timers", async () => {
    const conn = createConnection()
    const { provider, internal } = makeProvider(conn)
    try {
      internal.connectionState = "connecting"
      await expect(provider.waitForCatalogSettled({ timeoutMs: 30 })).rejects.toThrow("timeout after 30ms")
      expect(internal.catalogProgressCbs).toHaveLength(0)
      expect(conn._stateListeners()).toBe(0)
    } finally {
      provider.dispose()
    }
  })

  it("rejects on dispose and cleans listeners", async () => {
    const conn = createConnection()
    const { provider, internal } = makeProvider(conn)
    internal.connectionState = "connecting"
    const waiter = provider.waitForCatalogSettled({ timeoutMs: 2_000 })
    await tick(10)
    provider.dispose()
    await expect(waiter).rejects.toThrow("disposed")
    expect(internal.catalogProgressCbs).toHaveLength(0)
    expect(conn._stateListeners()).toBe(0)
  })

  it("rejects on abort, pre-aborted signal, and pre-disposed provider", async () => {
    const conn = createConnection()
    const { provider } = makeProvider(conn)
    try {
      const ctl = new AbortController()
      const waiter = provider.waitForCatalogSettled({ timeoutMs: 2_000, signal: ctl.signal })
      await tick(10)
      ctl.abort()
      await expect(waiter).rejects.toThrow("aborted")

      const ctl2 = new AbortController()
      ctl2.abort()
      await expect(provider.waitForCatalogSettled({ signal: ctl2.signal })).rejects.toThrow("aborted")
    } finally {
      provider.dispose()
    }
    await expect(provider.waitForCatalogSettled({ timeoutMs: 100 })).rejects.toThrow("disposed")
  })
})
