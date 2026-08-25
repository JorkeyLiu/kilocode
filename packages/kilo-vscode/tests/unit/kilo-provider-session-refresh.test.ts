import { describe, it, expect } from "bun:test"
import {
  loadSessions,
  flushPendingSessionRefresh,
  SESSION_INITIAL_LIMIT,
  SESSION_LOAD_MORE_LIMIT,
  type SessionRefreshContext,
} from "../../src/kilo-provider-utils"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider } = await import("../../src/KiloProvider")

type State = "connecting" | "connected" | "disconnected" | "error"

type ProviderInternals = {
  connectionState: State
  pendingSessionRefresh: boolean
  webview: { postMessage: (message: unknown) => Promise<unknown> } | null
  initializeConnection: () => Promise<void>
  handleLoadSessions: (cursor?: number) => Promise<void>
  sessionDirectories: Map<string, string>
}

function createContext(overrides?: Partial<SessionRefreshContext>): SessionRefreshContext & { sent: unknown[] } {
  const sent: unknown[] = []
  return {
    pendingSessionRefresh: false,
    connectionState: "connecting",
    listSessions: null,
    loadedCount: 0,
    cursor: null,
    postMessage: (msg: unknown) => sent.push(msg),
    sent,
    ...overrides,
  }
}

type ListInput = { limit: number; cursor?: number }

/**
 * Build a `listSessions` stub matching the new cursor-based contract and record
 * every call's input so tests can assert the requested limit/cursor. The single
 * endpoint returns the same page regardless of input — the util is responsible
 * for paging bookkeeping, not the fixture.
 */
function recordingList(sessions: unknown[], cursor: number | null = null) {
  const calls: ListInput[] = []
  const fn = async (input: ListInput) => {
    calls.push(input)
    return { sessions: sessions as never, cursor }
  }
  return { calls, fn }
}

function session(id: string, projectID: string, directory: string, time: number) {
  return { id, projectID, title: id, directory, time: { created: time, updated: time } }
}

function createClient() {
  const calls: string[] = []
  return {
    calls,
    experimental: {
      session: {
        // Single worktree-aware endpoint. Records the directory it was called
        // with so tests can prove there is no per-directory fan-out.
        list: async (params: { directory: string }) => {
          calls.push(params.directory)
          return { data: [], response: { headers: { get: () => null } } }
        },
      },
    },
    session: {
      list: async () => ({ data: [] }),
    },
    provider: {
      list: async () => ({ data: { all: [], connected: {}, default: {} } }),
    },
    app: {
      agents: async () => ({ data: [] }),
      skills: async () => ({ data: [] }),
    },
    config: {
      get: async () => ({ data: {} }),
    },
    indexing: {
      status: async () => ({ data: { state: "disabled" } }),
    },
    kilo: {
      profile: async () => ({ data: {} }),
    },
  }
}

function createConnection(client: ReturnType<typeof createClient>) {
  let current: ReturnType<typeof createClient> | null = null
  return {
    connect: async () => {
      current = client
    },
    getClient: () => {
      if (!current) {
        throw new Error("Not connected")
      }
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
  }
}

describe("KiloProvider pending session refresh", () => {
  it("posts every session from the single endpoint and resolves the project from the first", async () => {
    // Was: merged per-directory fan-out results (root + worktree listings) and
    // asserted worktree sessions survived. Now the worktree-aware endpoint
    // returns the merged list in one call, so we assert that single call plus
    // ordering and project resolution.
    const { calls, fn } = recordingList([
      session("ses_root", "project-new", "/repo", 1),
      session("ses_worktree", "project-old", "/worktree", 2),
    ])
    const ctx = createContext({ connectionState: "connected", listSessions: fn })

    const project = await loadSessions(ctx)

    expect(project).toBe("project-new")
    expect(calls).toHaveLength(1) // one endpoint call — no per-directory fan-out
    expect(calls[0]!.cursor).toBeUndefined()
    expect(calls[0]!.limit).toBe(SESSION_INITIAL_LIMIT)
    expect(ctx.sent).toHaveLength(1)
    const msg = ctx.sent[0] as { type: string; append: boolean; sessions: { id: string }[] }
    expect(msg.type).toBe("sessionsLoaded")
    expect(msg.append).toBe(false)
    expect(msg.sessions.map((s) => s.id)).toEqual(["ses_root", "ses_worktree"])
    expect(ctx.loadedCount).toBe(2)
  })

  it("resolves an undefined project and reports no more pages when the list is empty", async () => {
    // Was: proved a lone legacy worktree session was not adopted as the
    // canonical project. That reconciliation moved server-side; the util now
    // resolves the project from the first returned session, so an empty page
    // yields an undefined project and hasMore=false.
    const { fn } = recordingList([])
    const ctx = createContext({ connectionState: "connected", listSessions: fn })

    const project = await loadSessions(ctx)

    expect(project).toBeUndefined()
    expect(ctx.sent).toHaveLength(1)
    const msg = ctx.sent[0] as { sessions: unknown[]; hasMore: boolean; nextCursor: number | null }
    expect(msg.sessions).toEqual([])
    expect(msg.hasMore).toBe(false)
    expect(msg.nextCursor).toBeNull()
  })

  it("refresh re-fetches everything loaded so far via max(pageLimit, loadedCount) with append=false", async () => {
    // Replaces the preserveSessionIds fan-out failure case. A refresh (no
    // cursor) must request at least everything already shown so nothing drops
    // out of the list, and must reset paging state from the fresh page.
    const { calls, fn } = recordingList([session("ses_root", "project", "/repo", 1)], null)
    const ctx = createContext({ connectionState: "connected", listSessions: fn, loadedCount: 50, cursor: 99 })

    await loadSessions(ctx)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.limit).toBe(500) // max(SESSION_INITIAL_LIMIT, loadedCount) — initial limit wins
    expect(calls[0]!.cursor).toBeUndefined()
    const msg = ctx.sent[0] as { append: boolean; nextCursor: number | null; hasMore: boolean }
    expect(msg.append).toBe(false)
    expect(msg.nextCursor).toBeNull()
    expect(msg.hasMore).toBe(false)
    expect(ctx.loadedCount).toBe(1) // reset to the fresh page length
    expect(ctx.cursor).toBeNull()
  })

  it("load-more appends the next page, forwards the cursor, and reports hasMore", async () => {
    // Replaces the "omits preserveSessionIds when all directories succeed" case.
    // The new analogue is the paging append path: a cursor request uses
    // SESSION_LOAD_MORE_LIMIT, appends, and surfaces the next cursor.
    const { calls, fn } = recordingList([session("ses_page2", "project", "/repo", 3)], 40)
    const ctx = createContext({ connectionState: "connected", listSessions: fn, loadedCount: 20, cursor: 20 })

    await loadSessions(ctx, 20)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.limit).toBe(SESSION_LOAD_MORE_LIMIT)
    expect(calls[0]!.cursor).toBe(20)
    const msg = ctx.sent[0] as {
      append: boolean
      nextCursor: number | null
      hasMore: boolean
      sessions: { id: string }[]
    }
    expect(msg.append).toBe(true)
    expect(msg.nextCursor).toBe(40)
    expect(msg.hasMore).toBe(true)
    expect(msg.sessions.map((s) => s.id)).toEqual(["ses_page2"])
    expect(ctx.loadedCount).toBe(21) // previous 20 + this page's 1
    expect(ctx.cursor).toBe(40)
  })

  it("never emits preserveSessionIds on the sessionsLoaded message", async () => {
    // The preserveSessionIds contract was removed with the fan-out; guard that
    // it does not reappear on either a refresh or a load-more.
    const refresh = createContext({
      connectionState: "connected",
      listSessions: recordingList([session("ses_root", "project", "/repo", 1)]).fn,
    })
    await loadSessions(refresh)
    const more = createContext({
      connectionState: "connected",
      loadedCount: 20,
      cursor: 20,
      listSessions: recordingList([session("ses_page2", "project", "/repo", 2)], 40).fn,
    })
    await loadSessions(more, 20)

    for (const ctx of [refresh, more]) {
      expect(ctx.sent).toHaveLength(1)
      expect(ctx.sent[0] as object).not.toHaveProperty("preserveSessionIds")
    }
  })

  it("flushes deferred refresh via flushPendingSessionRefresh", async () => {
    const { calls, fn } = recordingList([])
    const ctx = createContext()

    await loadSessions(ctx)
    expect(ctx.pendingSessionRefresh).toBe(true)
    expect(calls).toHaveLength(0)

    ctx.listSessions = fn
    ctx.connectionState = "connected"

    await flushPendingSessionRefresh(ctx)

    expect(calls).toHaveLength(1) // single cursor-less refresh call
    expect(calls[0]!.cursor).toBeUndefined()
    expect(ctx.pendingSessionRefresh).toBe(false)
  })

  it("flushes deferred refresh in initializeConnection without relying on connected event callback", async () => {
    const client = createClient()
    const connection = createConnection(client)
    const provider = new KiloProvider({} as never, connection as never)
    const internal = provider as unknown as ProviderInternals

    // A tracked session directory must NOT trigger a per-directory list call.
    internal.sessionDirectories.set("ses_1", "/worktree")

    await internal.handleLoadSessions()
    expect(internal.pendingSessionRefresh).toBe(true)

    await internal.initializeConnection()

    expect(client.calls).toEqual(["/repo"]) // one call, workspace root only
    expect(internal.pendingSessionRefresh).toBe(false)
  })

  it("does not post not-connected errors while still connecting", async () => {
    const client = createClient()
    const connection = createConnection(client)
    const provider = new KiloProvider({} as never, connection as never)
    const internal = provider as unknown as ProviderInternals
    const sent: unknown[] = []

    internal.webview = {
      postMessage: async (message: unknown) => {
        sent.push(message)
      },
    }

    internal.connectionState = "connecting"
    await internal.handleLoadSessions()

    const errors = sent.filter((msg) => {
      if (typeof msg !== "object" || !msg) {
        return false
      }

      return "type" in msg && (msg as { type?: unknown }).type === "error"
    })

    expect(errors).toEqual([])
  })
})
