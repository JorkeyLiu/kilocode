import { describe, it, expect } from "bun:test"
import {
  loadSessions,
  flushPendingSessionRefresh,
  SESSION_INITIAL_LIMIT,
  SESSION_LOAD_MORE_LIMIT,
  type SessionRefreshContext,
} from "../../src/kilo-provider-utils"
import type { CatalogUpdate } from "../../src/agent-manager/host"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider } = await import("../../src/KiloProvider")

type State = "connecting" | "connected" | "disconnected" | "error"

type ProviderInternals = {
  connectionState: State
  pendingSessionRefresh: boolean
  webview: { postMessage: (message: unknown) => Promise<unknown> } | null
  initializeConnection: () => Promise<void>
  handleLoadSessions: (cursor?: string) => Promise<void>
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

type ListInput = { limit: number; cursor?: string }
function opaqueCursor(updated = 7, id = "ses_abc"): string {
  return Buffer.from(JSON.stringify({ v: 1, updated, id }), "utf8").toString("base64url")
}

/**
 * Build a `listSessions` stub matching the new cursor-based contract and record
 * every call's input so tests can assert the requested limit/cursor. The single
 * endpoint returns the same page regardless of input — the util is responsible
 * for paging bookkeeping, not the fixture.
 */
function recordingList(sessions: unknown[], cursor: string | null = null) {
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
    const msg = ctx.sent[0] as { sessions: unknown[]; hasMore: boolean; nextCursor: string | null }
    expect(msg.sessions).toEqual([])
    expect(msg.hasMore).toBe(false)
    expect(msg.nextCursor).toBeNull()
  })

  it("refresh re-fetches everything loaded so far via max(pageLimit, loadedCount) with append=false", async () => {
    // Replaces the preserveSessionIds fan-out failure case. A refresh (no
    // cursor) must request at least everything already shown so nothing drops
    // out of the list, and must reset paging state from the fresh page.
    const { calls, fn } = recordingList([session("ses_root", "project", "/repo", 1)], null)
    const ctx = createContext({
      connectionState: "connected",
      listSessions: fn,
      loadedCount: 50,
      cursor: opaqueCursor(99, "ses_old"),
    })

    await loadSessions(ctx)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.limit).toBe(500) // max(SESSION_INITIAL_LIMIT, loadedCount) — initial limit wins
    expect(calls[0]!.cursor).toBeUndefined()
    const msg = ctx.sent[0] as { append: boolean; nextCursor: string | null; hasMore: boolean }
    expect(msg.append).toBe(false)
    expect(msg.nextCursor).toBeNull()
    expect(msg.hasMore).toBe(false)
    expect(ctx.loadedCount).toBe(1) // reset to the fresh page length
    expect(ctx.cursor).toBeNull()
  })

  it("drains two pages and publishes one complete snapshot", async () => {
    // Complete inventory: transport stays paged but the webview receives one
    // coherent snapshot (append false, hasMore false).
    const next = opaqueCursor(40, "ses_next")
    const calls: ListInput[] = []
    const fn = async (input: ListInput) => {
      calls.push(input)
      if (input.cursor === undefined) return { sessions: [session("ses_a", "project", "/repo", 3)] as never, cursor: next }
      return { sessions: [session("ses_b", "project", "/repo", 2)] as never, cursor: null }
    }
    const ctx = createContext({ connectionState: "connected", listSessions: fn, loadedCount: 0, cursor: null })

    await loadSessions(ctx)

    expect(calls).toHaveLength(2)
    expect(calls[0]!.limit).toBe(SESSION_INITIAL_LIMIT)
    expect(calls[0]!.cursor).toBeUndefined()
    expect(calls[1]!.limit).toBe(SESSION_LOAD_MORE_LIMIT)
    expect(calls[1]!.cursor).toBe(next)
    const msg = ctx.sent[0] as {
      append: boolean
      nextCursor: string | null
      hasMore: boolean
      sessions: { id: string }[]
    }
    expect(msg.append).toBe(false)
    expect(msg.nextCursor).toBeNull()
    expect(msg.hasMore).toBe(false)
    expect(msg.sessions.map((s) => s.id)).toEqual(["ses_a", "ses_b"])
    expect(ctx.loadedCount).toBe(2)
    expect(ctx.cursor).toBeNull()
  })

  it("never emits preserveSessionIds on the sessionsLoaded message", async () => {
    // The preserveSessionIds contract was removed with the fan-out; guard that
    // it does not reappear on a complete snapshot.
    const refresh = createContext({
      connectionState: "connected",
      listSessions: recordingList([session("ses_root", "project", "/repo", 1)]).fn,
    })
    await loadSessions(refresh)

    expect(refresh.sent).toHaveLength(1)
    expect(refresh.sent[0] as object).not.toHaveProperty("preserveSessionIds")
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

describe("KiloProvider catalog forwarding", () => {
  function catalogProvider() {
    const client = createClient()
    const connection = createConnection(client)
    const provider = new KiloProvider({} as never, connection as never)
    const internal = provider as unknown as ProviderInternals & {
      webview: { postMessage: (message: unknown) => Promise<unknown> } | null
      onCatalog: (cb: (update: CatalogUpdate) => void) => { dispose(): void }
      postMessage: (msg: unknown) => void
    }
    // Ensure postMessage has a webview so it actually posts and also notifies catalog
    internal.webview = { postMessage: async () => ({}) } as unknown as {
      postMessage: (message: unknown) => Promise<unknown>
    }
    return { provider, internal }
  }

  it("forwards every sessionsLoaded to onCatalog including empty append final page", () => {
    const { provider, internal } = catalogProvider()
    const seen: CatalogUpdate[] = []
    const sub = (
      provider as unknown as { onCatalog: (cb: (u: CatalogUpdate) => void) => { dispose(): void } }
    ).onCatalog((u) => seen.push(u))

    // First page full refresh
    internal.postMessage({ type: "sessionsLoaded", sessions: [{ id: "ses_a" }], append: false, hasMore: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ ids: ["ses_a"], append: false, hasMore: true })

    // Second page append with ids
    internal.postMessage({ type: "sessionsLoaded", sessions: [{ id: "ses_b" }], append: true, hasMore: true })
    expect(seen).toHaveLength(2)
    expect(seen[1]).toEqual({ ids: ["ses_b"], append: true, hasMore: true })

    // Empty append final page must still notify
    internal.postMessage({ type: "sessionsLoaded", sessions: [], append: true, hasMore: false })
    expect(seen).toHaveLength(3)
    expect(seen[2]).toEqual({ ids: [], append: true, hasMore: false })

    // Full refresh empty should also notify (append false)
    internal.postMessage({ type: "sessionsLoaded", sessions: [], append: false, hasMore: false })
    expect(seen).toHaveLength(4)
    expect(seen[3]).toEqual({ ids: [], append: false, hasMore: false })

    sub.dispose()
    internal.postMessage({ type: "sessionsLoaded", sessions: [{ id: "ses_c" }], append: false, hasMore: false })
    expect(seen).toHaveLength(4)
  })

  it("uses CatalogUpdate shape without broad cast", () => {
    const { internal } = catalogProvider()
    const seen: CatalogUpdate[] = []
    ;(internal as unknown as { onCatalog: (cb: (u: CatalogUpdate) => void) => { dispose(): void } }).onCatalog(
      (u: CatalogUpdate) => seen.push(u),
    )
    internal.postMessage({ type: "sessionsLoaded", sessions: [{ id: "ses_x" }], append: false, hasMore: false })
    const first = seen[0] as CatalogUpdate
    // Type shape must be CatalogUpdate, not a bare string[] cast
    expect(Array.isArray(first.ids)).toBe(true)
    expect(first.ids).toEqual(["ses_x"])
    expect(typeof first.append).toBe("boolean")
    expect(typeof first.hasMore).toBe("boolean")
  })
})
