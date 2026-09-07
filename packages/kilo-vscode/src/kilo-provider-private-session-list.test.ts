import { describe, it, expect, mock } from "bun:test"
import { encodeGlobalListCursor } from "./private-worker/session-cursor"
import { isEventFromForeignProject, normalizeSessionListNextCursor } from "./kilo-provider-utils"
import { KiloProvider } from "./KiloProvider"
import { observeSessionListParityDetached, type SessionListParityConnection } from "./kilo-provider/session-list-parity"

type State = "connecting" | "connected" | "disconnected" | "error"

type ProviderInternals = {
  connectionState: State
  pendingSessionRefresh: boolean
  webview: { postMessage: (message: unknown) => Promise<unknown> } | null
  postMessage: (msg: unknown) => void
  projectID: string | undefined
  sessionCursor: string | null
  sessionCount: number
  handleLoadSessions: (cursor?: string) => Promise<void>
  refreshSessions: () => Promise<void>
  getSessionDirectories: () => Map<string, string>
}

function opaque(updated = 7, id = "ses_abc"): string {
  return encodeGlobalListCursor(updated, id)
}

function createPrivateMock(over: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ directory: string; archived?: boolean; limit?: number; cursor?: string }> = []
  const listMock = mock(async (input: { directory: string; archived?: boolean; cursor?: string; limit?: number }) => {
    calls.push(input)
    return over.listImpl ? (over.listImpl as (i: typeof input) => unknown)(input) : { v: "1.0", entries: [], nextCursor: undefined }
  })
  let enabled = (over.enabled as boolean | undefined) ?? true
  let started = (over.started as boolean | undefined) ?? true
  const isEnabled = mock(() => enabled)
  const isStarted = mock(() => started)
  const initialize = mock(async () => {})
  const reconnect = mock(async () => {})
  const dispose = mock(() => {})
  const svc = {
    isEnabled,
    isStarted,
    list: listMock,
    initialize,
    reconnect,
    dispose,
    _calls: calls,
    _setEnabled: (v: boolean) => (enabled = v),
    _setStarted: (v: boolean) => (started = v),
  }
  return svc as unknown as {
    isEnabled: () => boolean
    isStarted: () => boolean
    list: (input: { directory: string; archived?: boolean; cursor?: string; limit?: number }) => Promise<unknown>
    initialize: () => Promise<void>
    reconnect: () => Promise<void>
    dispose: () => void
    _calls: typeof calls
    _setEnabled: (v: boolean) => void
    _setStarted: (v: boolean) => void
  } & { isEnabled: ReturnType<typeof mock>; isStarted: ReturnType<typeof mock>; list: ReturnType<typeof mock> }
}

function createClient(sdkFn?: (params: { directory: string; limit: number; cursor?: string }) => Promise<unknown>) {
  const calls: Array<{ directory: string; limit: number; cursor?: string }> = []
  const data: unknown[] = (sdkFn as unknown) ? [] : []
  const fn = sdkFn
    ? async (params: { directory: string; limit: number; cursor?: string }) => {
        calls.push(params)
        return (await sdkFn(params)) as { data: unknown[]; response: { headers: { get: (k: string) => string | null } } }
      }
    : async (params: { directory: string; limit: number; cursor?: string }) => {
        calls.push(params)
        return { data: [], response: { headers: { get: () => null } } }
      }
  const client = {
    _calls: calls,
    experimental: {
      session: {
        list: fn,
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

function createConnection(client: ReturnType<typeof createClient>) {
  let current: ReturnType<typeof createClient> | null = client
  return {
    connect: async () => {
      current = client
    },
    getClient: () => {
      if (!current) throw new Error("Not connected")
      return current
    },
    onEventFiltered: () => () => undefined,
    onStateChange: (_listener: (state: State) => void) => () => undefined,
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
    getConnectionState: () => "connected" as const,
    getConnectionError: () => null,
    resolveEventSessionId: () => undefined,
    recordMessageSessionId: () => undefined,
    sandboxPreference: undefined as unknown as never,
  }
}

describe("KiloProvider private-first session list paging", () => {
  it("private initial page success => no SDK, maps projectID and directory/limit", async () => {
    const privateSvc = createPrivateMock({
      listImpl: (input) => ({
        v: "1.0",
        entries: [
          { id: "ses_a", title: "a", parentID: null, directory: "/repo", projectID: "proj_ro", createdAt: 100, updatedAt: 200 },
          { id: "ses_b", title: "b", parentID: "ses_a", directory: "/repo", projectID: "proj_ro", createdAt: 90, updatedAt: 190 },
        ],
        nextCursor: undefined,
      }),
    })
    const client = createClient()
    const connection = createConnection(client)
    const provider = new KiloProvider({} as never, connection as never, undefined, { privateSessionList: privateSvc as unknown as never })
    const internal = provider as unknown as ProviderInternals
    const sent: unknown[] = []
    internal.webview = { postMessage: async (msg: unknown) => { sent.push(msg); return {} } }
    internal.connectionState = "connected"
    await internal.handleLoadSessions()
    expect(privateSvc._calls).toHaveLength(1)
    expect(privateSvc._calls[0]!.directory).toBe("/repo")
    expect(privateSvc._calls[0]!.archived).toBe(false)
    expect(privateSvc._calls[0]!.limit).toBe(500)
    expect(privateSvc._calls[0]!.cursor).toBeUndefined()
    expect(client._calls).toHaveLength(0)
    // sessionsLoaded posted with mapped fields and projectID pin
    const msg = sent.find((m) => (m as { type?: string }).type === "sessionsLoaded") as { sessions: Array<{ id: string }>; hasMore: boolean } | undefined
    expect(msg).toBeDefined()
    expect(msg!.sessions.map((s) => s.id)).toEqual(["ses_a", "ses_b"])
    expect(msg!.hasMore).toBe(false)
    expect(internal.projectID).toBe("proj_ro")
    expect(internal.sessionCount).toBe(2)
    expect(internal.sessionCursor).toBeNull()
    // no lifecycle calls
    expect((privateSvc.isEnabled as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0)
    expect((privateSvc as unknown as { initialize: { mock: { calls: unknown[] } } }).initialize.mock.calls).toHaveLength(0)
    expect((privateSvc as unknown as { reconnect: { mock: { calls: unknown[] } } }).reconnect.mock.calls).toHaveLength(0)
    expect((privateSvc as unknown as { dispose: { mock: { calls: unknown[] } } }).dispose.mock.calls).toHaveLength(0)
  })

  it("private load-more forwards cursor/limit/directory and handles nextCursor/hasMore", async () => {
    const next = opaque(40, "ses_next")
    const prev = opaque(20, "ses_prev")
    const privateSvc = createPrivateMock({
      listImpl: () => ({
        v: "1.0",
        entries: [{ id: "ses_page2", title: "p2", parentID: null, directory: "/repo", projectID: "proj_ro", createdAt: 1, updatedAt: 3 }],
        nextCursor: next,
      }),
    })
    const client = createClient()
    const connection = createConnection(client)
    const provider = new KiloProvider({} as never, connection as never, undefined, { privateSessionList: privateSvc as unknown as never })
    const internal = provider as unknown as ProviderInternals & { sessionCursor: string | null; sessionCount: number }
    internal.sessionCount = 20
    internal.sessionCursor = prev
    const sent: unknown[] = []
    internal.webview = { postMessage: async (msg: unknown) => { sent.push(msg); return {} } }
    internal.connectionState = "connected"
    await internal.handleLoadSessions(prev)
    expect(privateSvc._calls).toHaveLength(1)
    expect(privateSvc._calls[0]!.limit).toBe(300)
    expect(privateSvc._calls[0]!.cursor).toBe(prev)
    expect(privateSvc._calls[0]!.directory).toBe("/repo")
    const msg = sent.find((m) => (m as { append?: boolean }).append === true) as { append: boolean; nextCursor: string | null; hasMore: boolean; sessions: Array<{ id: string }> } | undefined
    expect(msg).toBeDefined()
    expect(msg!.append).toBe(true)
    expect(msg!.nextCursor).toBe(next)
    expect(msg!.hasMore).toBe(true)
    expect(msg!.sessions[0]!.id).toBe("ses_page2")
    expect(internal.sessionCount).toBe(21)
    expect(internal.sessionCursor).toBe(next)
    expect(client._calls).toHaveLength(0)
  })

  it("gate-off/not-started/throw => exactly one SDK call", async () => {
    const cases: Array<{ enabled: boolean; started: boolean; throw?: boolean }> = [
      { enabled: false, started: true },
      { enabled: true, started: false },
      { enabled: true, started: true, throw: true },
    ]
    for (const c of cases) {
      const privateSvc = createPrivateMock({
        enabled: c.enabled,
        started: c.started,
        listImpl: c.throw
          ? () => {
              throw new Error("worker error")
            }
          : () => ({ v: "1.0", entries: [] }),
      })
      const client = createClient(async () => ({ data: [{ id: "ses_sdk", projectID: "proj_sdk", directory: "/repo", title: "sdk", time: { created: 1, updated: 1 } }], response: { headers: { get: () => null } } }))
      const connection = createConnection(client)
      const provider = new KiloProvider({} as never, connection as never, undefined, { privateSessionList: privateSvc as unknown as never })
      const internal = provider as unknown as ProviderInternals
      const sent: unknown[] = []
      internal.webview = { postMessage: async (msg: unknown) => { sent.push(msg); return {} } }
      internal.connectionState = "connected"
      await internal.handleLoadSessions()
      // private may have been called 0 or 1 times depending on gate, but SDK exactly 1
      expect(client._calls).toHaveLength(1)
      // reset for next case
    }
  })

  it("private empty success => no SDK", async () => {
    const privateSvc = createPrivateMock({ listImpl: () => ({ v: "1.0", entries: [] }) })
    const client = createClient()
    const connection = createConnection(client)
    const provider = new KiloProvider({} as never, connection as never, undefined, { privateSessionList: privateSvc as unknown as never })
    const internal = provider as unknown as ProviderInternals
    const sent: unknown[] = []
    internal.webview = { postMessage: async (msg: unknown) => { sent.push(msg); return {} } }
    internal.connectionState = "connected"
    await internal.handleLoadSessions()
    expect(privateSvc._calls).toHaveLength(1)
    expect(client._calls).toHaveLength(0)
    const msg = sent.find((m) => (m as { type?: string }).type === "sessionsLoaded") as { sessions: unknown[] } | undefined
    expect(msg!.sessions).toEqual([])
  })

  it("invalid private nextCursor falls back to SDK and SDK malformed cursor normalizes to null", async () => {
    const privateSvc = createPrivateMock({ listImpl: () => ({ v: "1.0", entries: [{ id: "ses_a", title: "a", parentID: null, directory: "/repo", projectID: "proj_ro", createdAt: 1, updatedAt: 2 }], nextCursor: "bad" }) })
    const client = createClient(async () => ({ data: [{ id: "ses_a", projectID: "proj_ro", directory: "/repo", title: "a", time: { created: 1, updated: 2 } }], response: { headers: { get: () => "bad" } } }))
    const connection = createConnection(client)
    const provider = new KiloProvider({} as never, connection as never, undefined, { privateSessionList: privateSvc as unknown as never })
    const internal = provider as unknown as ProviderInternals
    const sent: unknown[] = []
    internal.webview = { postMessage: async (msg: unknown) => { sent.push(msg); return {} } }
    internal.connectionState = "connected"
    await internal.handleLoadSessions()
    expect(privateSvc._calls).toHaveLength(1)
    expect(client._calls).toHaveLength(1)
    const msg = sent.find((m) => (m as { type?: string }).type === "sessionsLoaded") as { nextCursor: string | null; hasMore: boolean } | undefined
    expect(msg!.nextCursor).toBeNull()
    expect(msg!.hasMore).toBe(false)
    expect(normalizeSessionListNextCursor("bad")).toBeNull()
    expect(normalizeSessionListNextCursor(msg!.nextCursor as unknown)).toBeNull()
  })

  it("invalid private shape falls back to SDK exactly once", async () => {
    const privateSvc = createPrivateMock({ listImpl: () => ({ v: "9.9", entries: [] }) })
    const client = createClient(async () => ({ data: [], response: { headers: { get: () => null } } }))
    const connection = createConnection(client)
    const provider = new KiloProvider({} as never, connection as never, undefined, { privateSessionList: privateSvc as unknown as never })
    const internal = provider as unknown as ProviderInternals
    internal.webview = { postMessage: async () => ({}) } as unknown as never
    internal.connectionState = "connected"
    await internal.handleLoadSessions()
    expect(client._calls).toHaveLength(1)
  })

  it("projectID pin enables foreign-project SSE filtering", async () => {
    const privateSvc = createPrivateMock({
      listImpl: () => ({
        v: "1.0",
        entries: [
          { id: "ses_root", title: "root", parentID: null, directory: "/repo", projectID: "proj_new", createdAt: 1, updatedAt: 10 },
          { id: "ses_other", title: "other", parentID: null, directory: "/repo", projectID: "proj_old", createdAt: 2, updatedAt: 20 },
        ],
      }),
    })
    const client = createClient()
    const connection = createConnection(client)
    const provider = new KiloProvider({} as never, connection as never, undefined, { privateSessionList: privateSvc as unknown as never })
    const internal = provider as unknown as ProviderInternals
    internal.webview = { postMessage: async () => ({}) } as unknown as never
    internal.connectionState = "connected"
    await internal.handleLoadSessions()
    expect(internal.projectID).toBe("proj_new")
    // verify filtering uses resolved projectID
    const foreign = isEventFromForeignProject({ type: "sync", name: "session.created.1", data: { info: { projectID: "proj_old" } } } as unknown as never, internal.projectID)
    expect(foreign).toBe(true)
    const same = isEventFromForeignProject({ type: "sync", name: "session.created.1", data: { info: { projectID: "proj_new" } } } as unknown as never, internal.projectID)
    expect(same).toBe(false)
  })

  it("no lifecycle calls on injected service across refreshes", async () => {
    const privateSvc = createPrivateMock({ listImpl: () => ({ v: "1.0", entries: [] }) })
    const client = createClient()
    const connection = createConnection(client)
    const provider = new KiloProvider({} as never, connection as never, undefined, { privateSessionList: privateSvc as unknown as never })
    const internal = provider as unknown as ProviderInternals
    internal.webview = { postMessage: async () => ({}) } as unknown as never
    internal.connectionState = "connected"
    await internal.handleLoadSessions()
    await internal.handleLoadSessions()
    expect((privateSvc as unknown as { initialize: { mock: { calls: unknown[] } } }).initialize.mock.calls).toHaveLength(0)
    expect((privateSvc as unknown as { reconnect: { mock: { calls: unknown[] } } }).reconnect.mock.calls).toHaveLength(0)
    expect((privateSvc as unknown as { dispose: { mock: { calls: unknown[] } } }).dispose.mock.calls).toHaveLength(0)
  })

  it("malformed private entries fall back to SDK exactly once (id/parent/project/timestamp/directory)", async () => {
    const malformedEntries: Array<Record<string, unknown>> = [
      // invalid id: empty, non-ses prefix, NUL
      { id: "", title: "t", parentID: null, directory: "/repo", projectID: "proj_a", createdAt: 1, updatedAt: 2 },
      { id: "bad_id", title: "t", parentID: null, directory: "/repo", projectID: "proj_a", createdAt: 1, updatedAt: 2 },
      { id: "ses\0bad", title: "t", parentID: null, directory: "/repo", projectID: "proj_a", createdAt: 1, updatedAt: 2 },
      // invalid parentID
      { id: "ses_a1", title: "t", parentID: "bad_parent", directory: "/repo", projectID: "proj_a", createdAt: 1, updatedAt: 2 },
      { id: "ses_a2", title: "t", parentID: "ses\0bad", directory: "/repo", projectID: "proj_a", createdAt: 1, updatedAt: 2 },
      // invalid projectID: empty, NUL
      { id: "ses_b1", title: "t", parentID: null, directory: "/repo", projectID: "", createdAt: 1, updatedAt: 2 },
      { id: "ses_b2", title: "t", parentID: null, directory: "/repo", projectID: "proj\0_a", createdAt: 1, updatedAt: 2 },
      // invalid directory: foreign, non-canonical, NUL, non-absolute
      { id: "ses_c1", title: "t", parentID: null, directory: "/other", projectID: "proj_a", createdAt: 1, updatedAt: 2 },
      { id: "ses_c2", title: "t", parentID: null, directory: "/repo/../repo", projectID: "proj_a", createdAt: 1, updatedAt: 2 },
      { id: "ses_c3", title: "t", parentID: null, directory: "/repo/", projectID: "proj_a", createdAt: 1, updatedAt: 2 },
      { id: "ses_c4", title: "t", parentID: null, directory: "relative/path", projectID: "proj_a", createdAt: 1, updatedAt: 2 },
      // invalid timestamps: non-finite, non-safe, negative, out-of-range, float
      { id: "ses_d1", title: "t", parentID: null, directory: "/repo", projectID: "proj_a", createdAt: 1, updatedAt: NaN },
      { id: "ses_d2", title: "t", parentID: null, directory: "/repo", projectID: "proj_a", createdAt: 1, updatedAt: Infinity },
      { id: "ses_d3", title: "t", parentID: null, directory: "/repo", projectID: "proj_a", createdAt: -1, updatedAt: 2 },
      { id: "ses_d4", title: "t", parentID: null, directory: "/repo", projectID: "proj_a", createdAt: 1.5, updatedAt: 2 },
      { id: "ses_d5", title: "t", parentID: null, directory: "/repo", projectID: "proj_a", createdAt: 1, updatedAt: Number.MAX_SAFE_INTEGER + 10 },
      { id: "ses_d6", title: "t", parentID: null, directory: "/repo", projectID: "proj_a", createdAt: 1, updatedAt: 8640000000000001 },
    ]
    for (const bad of malformedEntries) {
      const privateSvc = createPrivateMock({ listImpl: () => ({ v: "1.0", entries: [bad] }) })
      const client = createClient(async () => ({
        data: [{ id: "ses_sdk", projectID: "proj_a", directory: "/repo", title: "sdk", time: { created: 1, updated: 1 } }],
        response: { headers: { get: () => null } },
      }))
      const connection = createConnection(client)
      const provider = new KiloProvider({} as never, connection as never, undefined, { privateSessionList: privateSvc as unknown as never })
      const internal = provider as unknown as ProviderInternals
      internal.webview = { postMessage: async () => ({}) } as unknown as never
      internal.connectionState = "connected"
      await internal.handleLoadSessions()
      expect(privateSvc._calls).toHaveLength(1)
      expect(client._calls).toHaveLength(1)
      // reset not needed as new provider per iteration
    }
  })

  it("unsafe private nextCursor causes fallback exactly once", async () => {
    const unsafeCursors = [
      // updated not safe integer
      Buffer.from(JSON.stringify({ v: 1, updated: Number.MAX_SAFE_INTEGER + 10, id: "ses_a" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, updated: -1, id: "ses_a" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, updated: 1.5, id: "ses_a" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, updated: 8640000000000001, id: "ses_a" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, updated: 1, id: "bad_id" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, updated: 1, id: "ses\0a" }), "utf8").toString("base64url"),
    ]
    for (const badCursor of unsafeCursors) {
      const privateSvc = createPrivateMock({
        listImpl: () => ({
          v: "1.0",
          entries: [{ id: "ses_a", title: "a", parentID: null, directory: "/repo", projectID: "proj_a", createdAt: 1, updatedAt: 2 }],
          nextCursor: badCursor,
        }),
      })
      const client = createClient(async () => ({
        data: [{ id: "ses_sdk", projectID: "proj_a", directory: "/repo", title: "sdk", time: { created: 1, updated: 1 } }],
        response: { headers: { get: () => null } },
      }))
      const connection = createConnection(client)
      const provider = new KiloProvider({} as never, connection as never, undefined, { privateSessionList: privateSvc as unknown as never })
      const internal = provider as unknown as ProviderInternals
      internal.webview = { postMessage: async () => ({}) } as unknown as never
      internal.connectionState = "connected"
      await internal.handleLoadSessions()
      expect(privateSvc._calls).toHaveLength(1)
      expect(client._calls).toHaveLength(1)
    }
  })

  it("valid private nextCursor and normalize regression: valid cursor remains accepted", async () => {
    const valid = opaque(100, "ses_valid")
    const privateSvc = createPrivateMock({
      listImpl: () => ({
        v: "1.0",
        entries: [{ id: "ses_a", title: "a", parentID: null, directory: "/repo", projectID: "proj_a", createdAt: 1, updatedAt: 2 }],
        nextCursor: valid,
      }),
    })
    const client = createClient()
    const connection = createConnection(client)
    const provider = new KiloProvider({} as never, connection as never, undefined, { privateSessionList: privateSvc as unknown as never })
    const internal = provider as unknown as ProviderInternals
    const sent: unknown[] = []
    internal.webview = { postMessage: async (msg: unknown) => { sent.push(msg); return {} } }
    internal.connectionState = "connected"
    await internal.handleLoadSessions()
    expect(privateSvc._calls).toHaveLength(1)
    expect(client._calls).toHaveLength(0)
    const msg = sent.find((m) => (m as { type?: string }).type === "sessionsLoaded") as { nextCursor: string | null } | undefined
    expect(msg!.nextCursor).toBe(valid)
    expect(normalizeSessionListNextCursor(valid)).toBe(valid)
    // invalid remains null
    expect(normalizeSessionListNextCursor("bad")).toBeNull()
    expect(normalizeSessionListNextCursor(Buffer.from(JSON.stringify({ v: 1, updated: Number.MAX_SAFE_INTEGER + 10, id: "ses_a" }), "utf8").toString("base64url"))).toBeNull()
  })

  it("private throws while disconnected with no client preserves pending; later connected flush refreshes once", async () => {
    const privateSvc = createPrivateMock({
      listImpl: () => {
        throw new Error("worker error")
      },
    })
    // connection initially with no client (getClient throws)
    let currentClient: ReturnType<typeof createClient> | null = null
    const sdkClient = createClient(async () => ({
      data: [{ id: "ses_sdk", projectID: "proj_sdk", directory: "/repo", title: "sdk", time: { created: 1, updated: 1 } }],
      response: { headers: { get: () => null } },
    }))
    const connection = {
      connect: async () => {
        currentClient = sdkClient
      },
      getClient: () => {
        if (!currentClient) throw new Error("Not connected")
        return currentClient
      },
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
      getServerConfig: () => ({ baseUrl: "http://127.0.0.1:12345", password: "test" }),
      getConnectionState: () => "connected" as const,
      getConnectionError: () => null,
      resolveEventSessionId: () => undefined,
      recordMessageSessionId: () => undefined,
      sandboxPreference: undefined as unknown as never,
    }
    const provider = new KiloProvider({} as never, connection as never, undefined, { privateSessionList: privateSvc as unknown as never })
    const internal = provider as unknown as ProviderInternals & { flushPendingSessionRefresh: (reason: string) => Promise<void> }
    const sent: unknown[] = []
    internal.webview = { postMessage: async (msg: unknown) => { sent.push(msg); return {} } }
    internal.connectionState = "disconnected"
    internal.pendingSessionRefresh = false
    // initial attempt while disconnected, private throws, no client -> should preserve pending
    await internal.handleLoadSessions()
    expect(privateSvc._calls).toHaveLength(1)
    expect(sdkClient._calls).toHaveLength(0)
    expect(internal.pendingSessionRefresh).toBe(true)
    // verify no spin/reconnect/start was called
    expect((privateSvc as unknown as { initialize: { mock: { calls: unknown[] } } }).initialize.mock.calls).toHaveLength(0)
    expect((privateSvc as unknown as { reconnect: { mock: { calls: unknown[] } } }).reconnect.mock.calls).toHaveLength(0)
    // now simulate connection established
    currentClient = sdkClient
    internal.connectionState = "connected"
    const beforeCalls = sdkClient._calls.length
    // flush pending via provider's flush (which uses the new client)
    await internal.flushPendingSessionRefresh("test-reconnect")
    expect(sdkClient._calls).toHaveLength(beforeCalls + 1)
    expect(internal.pendingSessionRefresh).toBe(false)
    // successful private read while disconnected should be preserved if design allows: verify a successful private read while disconnected still posts without needing client
    const privateSuccess = createPrivateMock({
      listImpl: () => ({
        v: "1.0",
        entries: [{ id: "ses_ok", title: "ok", parentID: null, directory: "/repo", projectID: "proj_ok", createdAt: 1, updatedAt: 2 }],
      }),
    })
    let current2: ReturnType<typeof createClient> | null = null
    const conn2 = {
      connect: async () => {},
      getClient: () => {
        if (!current2) throw new Error("Not connected")
        return current2 as never
      },
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
      getServerConfig: () => ({ baseUrl: "http://127.0.0.1:12345", password: "test" }),
      getConnectionState: () => "connected" as const,
      getConnectionError: () => null,
      resolveEventSessionId: () => undefined,
      recordMessageSessionId: () => undefined,
      sandboxPreference: undefined as unknown as never,
    }
    const provider2 = new KiloProvider({} as never, conn2 as never, undefined, { privateSessionList: privateSuccess as unknown as never })
    const internal2 = provider2 as unknown as ProviderInternals
    const sent2: unknown[] = []
    internal2.webview = { postMessage: async (msg: unknown) => { sent2.push(msg); return {} } }
    internal2.connectionState = "disconnected"
    await internal2.handleLoadSessions()
    expect(privateSuccess._calls).toHaveLength(1)
    expect(sent2.find((m) => (m as { type?: string }).type === "sessionsLoaded")).toBeDefined()
    expect(internal2.pendingSessionRefresh).toBe(false)
  })

  it("private fallback warning is fixed and does not expose thrown message, falls back exactly once", async () => {
    const secret = "SECRET_PAYLOAD_ses_leak_/tmp/private-data_should_not_appear"
    const privateSvc = createPrivateMock({
      listImpl: () => {
        throw new Error(secret)
      },
    })
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const client = createClient(async () => ({
        data: [{ id: "ses_sdk", projectID: "proj_a", directory: "/repo", title: "sdk", time: { created: 1, updated: 1 } }],
        response: { headers: { get: () => null } },
      }))
      const connection = createConnection(client)
      const provider = new KiloProvider({} as never, connection as never, undefined, { privateSessionList: privateSvc as unknown as never })
      const internal = provider as unknown as ProviderInternals
      internal.webview = { postMessage: async () => ({}) } as unknown as never
      internal.connectionState = "connected"
      await internal.handleLoadSessions()
      expect(client._calls).toHaveLength(1)
      expect(privateSvc._calls).toHaveLength(1)
      const flat = JSON.stringify(warns)
      expect(flat.includes(secret)).toBeFalse()
      expect(flat.includes("SECRET_PAYLOAD")).toBeFalse()
      const fallbackWarn = warns.find((a) => String(a[0]).includes("private projection invalid"))
      expect(fallbackWarn).toBeDefined()
      expect(JSON.stringify(fallbackWarn)).toContain("fallback")
      expect(JSON.stringify(fallbackWarn).includes(secret)).toBeFalse()
    } finally {
      console.warn = orig
    }
  })

  it("detached parity rejects unsafe/out-of-range cursor and accepts generated valid cursor", async () => {
    const valid = opaque(100, "ses_valid")
    const unsafeCursors = [
      Buffer.from(JSON.stringify({ v: 1, updated: Number.MAX_SAFE_INTEGER + 10, id: "ses_a" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, updated: -1, id: "ses_a" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, updated: 1.5, id: "ses_a" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, updated: 8640000000000001, id: "ses_a" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, updated: 1, id: "bad_id" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 1, updated: 1, id: "ses\0a" }), "utf8").toString("base64url"),
      "!!invalid_base64!!",
      "",
      "bad",
    ]
    const sdkOk = { data: [], error: undefined, response: { status: 200, headers: { get: () => null } } }
    for (const bad of unsafeCursors) {
      let called = false
      const conn: SessionListParityConnection = {
        isPrivateAvailable: () => true,
        privateSessionListOutcomeWithHandle: () => {
          called = true
          return { id: 1, promise: Promise.resolve({ kind: "valid", result: {} as never }) }
        },
        getPrivateEpoch: () => 1,
      }
      const warns: unknown[][] = []
      const orig = console.warn
      console.warn = (...a: unknown[]) => { warns.push(a) }
      try {
        observeSessionListParityDetached(conn, sdkOk as never, "/tmp", undefined, { limit: 10, cursor: bad }, 50)
        await new Promise((r) => setTimeout(r, 25))
        expect(called).toBeFalse()
      } finally {
        console.warn = orig
      }
    }
    let validCalled = false
    const validConn: SessionListParityConnection = {
      isPrivateAvailable: () => true,
      privateSessionListOutcomeWithHandle: () => {
        validCalled = true
        return {
          id: 1,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 2,
              requestId: "r1",
              opId: "experimental-session-list:tok1",
              op: "experimental/session/list",
              idempotencyKey: "experimental-session-list:tok1",
              status: "succeeded",
              outcome: { type: "succeeded", time: 1 },
              accepted: true,
              data: { sessions: [] },
            },
          }),
        }
      },
      getPrivateEpoch: () => 1,
    }
    const orig2 = console.warn
    const warns2: unknown[][] = []
    console.warn = (...a: unknown[]) => { warns2.push(a) }
    try {
      observeSessionListParityDetached(validConn, sdkOk as never, "/tmp", undefined, { limit: 10, cursor: valid }, 50)
      await new Promise((r) => setTimeout(r, 40))
      expect(validCalled).toBeTrue()
    } finally {
      console.warn = orig2
    }
  })
})
