import { describe, expect, test } from "bun:test"
import { KiloProvider } from "./KiloProvider"
import type { KiloConnectionService } from "./services/cli-backend/connection-service"
import {
  loadSessions,
  normalizeSessionListNextCursor,
  MAX_SESSION_LIST_PAGES,
  type SessionRefreshContext,
} from "./kilo-provider-utils"
import { encodeSessionListCursor } from "./services/cli-backend/serve-private-session-list-contract"

const OPAQUE = (updated = 7, id = "ses_abc"): string => encodeSessionListCursor(updated, id)

function ctxWith(
  list: SessionRefreshContext["listSessions"],
  over: Partial<SessionRefreshContext> = {},
): SessionRefreshContext {
  return {
    pendingSessionRefresh: false,
    connectionState: "connected",
    listSessions: list,
    loadedCount: 0,
    cursor: null,
    postMessage: () => {},
    ...over,
  }
}

function webviewSession(id: string, updated = 2) {
  return { id, directory: "/tmp", title: "t", time: { created: 1, updated }, projectID: "p1" }
}

describe("session-list complete inventory drain", () => {
  test("malformed and legacy x-next-cursor headers never become usable state", () => {
    expect(normalizeSessionListNextCursor(OPAQUE(7, "ses_abc"))).toBe(OPAQUE(7, "ses_abc"))
    expect(normalizeSessionListNextCursor(null)).toBeNull()
    expect(normalizeSessionListNextCursor(undefined)).toBeNull()
    expect(normalizeSessionListNextCursor("")).toBeNull()
    expect(normalizeSessionListNextCursor("7")).toBeNull()
    expect(normalizeSessionListNextCursor("42")).toBeNull()
    expect(normalizeSessionListNextCursor("1700000000000")).toBeNull()
    expect(normalizeSessionListNextCursor("not-a-cursor")).toBeNull()
    expect(normalizeSessionListNextCursor(7)).toBeNull()
    const nul = Buffer.from(JSON.stringify({ v: 1, updated: 7, id: "ses_ab\0c" }), "utf8").toString("base64url")
    expect(normalizeSessionListNextCursor(nul)).toBeNull()
    const extra = Buffer.from(JSON.stringify({ v: 1, updated: 7, id: "ses_abc", extra: 1 }), "utf8").toString(
      "base64url",
    )
    expect(normalizeSessionListNextCursor(extra)).toBeNull()
    const badVer = Buffer.from(JSON.stringify({ v: 2, updated: 7, id: "ses_abc" }), "utf8").toString("base64url")
    expect(normalizeSessionListNextCursor(badVer)).toBeNull()
  })

  test("empty inventory publishes one complete snapshot", async () => {
    const posted: unknown[] = []
    const calls: unknown[] = []
    const ctx = ctxWith(
      (async (input: { limit: number; cursor?: string }) => {
        calls.push(input)
        return { sessions: [], cursor: null }
      }) as unknown as SessionRefreshContext["listSessions"],
      { loadedCount: 2, cursor: OPAQUE(9, "ses_x"), postMessage: (m: unknown) => posted.push(m) },
    )
    await loadSessions(ctx)
    expect(ctx.cursor).toBeNull()
    expect(ctx.loadedCount).toBe(0)
    expect(calls).toHaveLength(1)
    expect(posted).toHaveLength(1)
    const msg = posted[0] as Record<string, unknown>
    expect(msg.append).toBe(false)
    expect(msg.hasMore).toBe(false)
    expect(msg.nextCursor).toBeNull()
    expect(msg.sessions).toEqual([])
  })

  test("multi-page drain accumulates and publishes once with complete snapshot", async () => {
    const posted: unknown[] = []
    const calls: Array<{ limit: number; cursor?: string }> = []
    const c1 = OPAQUE(20, "ses_page1")
    const list = (async (input: { limit: number; cursor?: string }) => {
      calls.push(input)
      if (input.cursor === undefined) return { sessions: [webviewSession("ses_a")], cursor: c1 }
      return { sessions: [webviewSession("ses_b")], cursor: null }
    }) as unknown as SessionRefreshContext["listSessions"]
    const ctx = ctxWith(list, { postMessage: (m: unknown) => posted.push(m) })
    await loadSessions(ctx)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.cursor).toBeUndefined()
    expect(calls[1]!.cursor).toBe(c1)
    expect(ctx.cursor).toBeNull()
    expect(ctx.loadedCount).toBe(2)
    expect(posted).toHaveLength(1)
    const msg = posted[0] as {
      append: boolean
      hasMore: boolean
      nextCursor: string | null
      sessions: { id: string }[]
    }
    expect(msg.append).toBe(false)
    expect(msg.hasMore).toBe(false)
    expect(msg.nextCursor).toBeNull()
    expect(msg.sessions.map((s) => s.id)).toEqual(["ses_a", "ses_b"])
  })

  test("deprecated cursor argument is ignored and still drains from the start", async () => {
    const posted: unknown[] = []
    const calls: Array<{ limit: number; cursor?: string }> = []
    const list = (async (input: { limit: number; cursor?: string }) => {
      calls.push(input)
      return { sessions: [webviewSession("ses_a")], cursor: null }
    }) as unknown as SessionRefreshContext["listSessions"]
    const ctx = ctxWith(list, { postMessage: (m: unknown) => posted.push(m) })
    await loadSessions(ctx, OPAQUE(9, "ses_x"))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.cursor).toBeUndefined()
    expect(posted).toHaveLength(1)
    expect((posted[0] as { append: boolean }).append).toBe(false)
  })

  test("repeating cursor throws without publishing a false complete inventory", async () => {
    const posted: unknown[] = []
    const c1 = OPAQUE(20, "ses_loop")
    const list = (async () => ({
      sessions: [webviewSession("ses_a")],
      cursor: c1,
    })) as unknown as SessionRefreshContext["listSessions"]
    const ctx = ctxWith(list, { postMessage: (m: unknown) => posted.push(m) })
    await expect(loadSessions(ctx)).rejects.toThrow("session list cursor stalled")
    expect(posted).toHaveLength(0)
  })

  test("non-exhausting cursor chain throws after the page bound", async () => {
    const posted: unknown[] = []
    let n = 0
    const list = (async () => {
      n++
      return { sessions: [webviewSession(`ses_${n}`)], cursor: OPAQUE(n, `ses_${n}`) }
    }) as unknown as SessionRefreshContext["listSessions"]
    const ctx = ctxWith(list, { postMessage: (m: unknown) => posted.push(m) })
    await expect(loadSessions(ctx)).rejects.toThrow("session list did not exhaust")
    expect(n).toBe(MAX_SESSION_LIST_PAGES)
    expect(posted).toHaveLength(0)
  }, 15000)

  describe("non-authoritative preview protocol (refreshId)", () => {
    test("page deltas emit in order as sessionsProgress; final stays one complete snapshot", async () => {
      const posted: Array<Record<string, unknown>> = []
      const c1 = OPAQUE(20, "ses_page1")
      const list = (async (input: { limit: number; cursor?: string }) => {
        if (input.cursor === undefined) return { sessions: [webviewSession("ses_a", 3)], cursor: c1 }
        return { sessions: [webviewSession("ses_b", 5)], cursor: null }
      }) as unknown as SessionRefreshContext["listSessions"]
      const ctx = ctxWith(list, {
        refreshId: 7,
        postMessage: (m: unknown) => posted.push(m as Record<string, unknown>),
      })
      await loadSessions(ctx)
      expect(posted.map((m) => m.type)).toEqual(["sessionsProgress", "sessionsProgress", "sessionsLoaded"])
      const first = posted[0]!
      expect(first.refreshId).toBe(7)
      expect((first.sessions as { id: string }[]).map((s) => s.id)).toEqual(["ses_a"])
      const second = posted[1]!
      expect(second.refreshId).toBe(7)
      expect((second.sessions as { id: string }[]).map((s) => s.id)).toEqual(["ses_b"])
      const finals = posted.filter((m) => m.type === "sessionsLoaded")
      expect(finals).toHaveLength(1)
      expect(finals[0]!.refreshId).toBe(7)
      expect((finals[0]!.sessions as { id: string }[]).map((s) => s.id)).toEqual(["ses_a", "ses_b"])
      expect(finals[0]!.append).toBe(false)
      expect(finals[0]!.hasMore).toBe(false)
    })

    test("tail failure posts scoped sessionCatalogLoadFailed and no final", async () => {
      const posted: Array<Record<string, unknown>> = []
      const c1 = OPAQUE(20, "ses_page1")
      let n = 0
      const list = (async (input: { limit: number; cursor?: string }) => {
        n++
        if (n === 1) return { sessions: [webviewSession("ses_a", 3)], cursor: c1 }
        throw new Error("backend down")
      }) as unknown as SessionRefreshContext["listSessions"]
      const ctx = ctxWith(list, {
        refreshId: 9,
        postMessage: (m: unknown) => posted.push(m as Record<string, unknown>),
      })
      await expect(loadSessions(ctx)).rejects.toThrow("backend down")
      expect(posted.map((m) => m.type)).toEqual(["sessionsProgress", "error"])
      const err = posted[1]!
      expect(err.code).toBe("sessionCatalogLoadFailed")
      expect(err.refreshId).toBe(9)
      expect(posted.some((m) => m.type === "sessionsLoaded")).toBe(false)
    })

    test("cursor stall with refreshId posts scoped error and no final", async () => {
      const posted: Array<Record<string, unknown>> = []
      const c1 = OPAQUE(20, "ses_loop")
      const list = (async () => ({
        sessions: [webviewSession("ses_a")],
        cursor: c1,
      })) as unknown as SessionRefreshContext["listSessions"]
      const ctx = ctxWith(list, {
        refreshId: 11,
        postMessage: (m: unknown) => posted.push(m as Record<string, unknown>),
      })
      await expect(loadSessions(ctx)).rejects.toThrow("session list cursor stalled")
      const last = posted[posted.length - 1]!
      expect(last.type).toBe("error")
      expect(last.code).toBe("sessionCatalogLoadFailed")
      expect(last.refreshId).toBe(11)
      expect(posted.some((m) => m.type === "sessionsLoaded")).toBe(false)
    })
  })

  test("private-first list SDK fallback issues exactly one SDK read with no second private request", async () => {
    const parity: unknown[] = []
    const sdkCalls: unknown[] = []
    const privateCalls: unknown[] = []
    const client = {
      experimental: {
        session: {
          list: async (p: unknown) => {
            sdkCalls.push(p)
            return { data: [], response: { headers: { get: () => null } } }
          },
        },
      },
    } as unknown as import("@kilocode/sdk/v2/client").KiloClient
    const privateReader = {
      isEnabled: () => true,
      isStarted: () => true,
      list: async (input: unknown) => {
        privateCalls.push(input)
        throw new Error("private failed")
      },
      get: async () => ({ v: "1.0", status: "not_found" }),
    }
    const connectionService = {
      isPrivateAvailable: () => true,
      getPrivateEpoch: () => 1,
      privateSessionListOutcomeWithHandle: (req: unknown) => {
        parity.push(req)
        return { id: 1, promise: new Promise(() => {}) }
      },
      getClient: () => client,
      getClientAsync: async () => client,
      getConnectionError: () => null,
      sandboxPreference: { onChange: () => ({ dispose: () => {} }) },
      onEvent: () => () => {},
      onEventFiltered: () => () => {},
      onStateChange: () => () => {},
      getConfigRevision: () => 0,
      onConfigRevision: () => () => {},
      registerDirectoryProvider: () => () => {},
      registerVisible: () => {},
      registerAttached: () => {},
      unregisterVisible: () => {},
      unregisterAttached: () => {},
      recordMessageSessionId: () => {},
      pruneSession: () => {},
    } as unknown as KiloConnectionService
    const provider = new KiloProvider(
      { fsPath: "/tmp" } as unknown as import("vscode").Uri,
      connectionService,
      undefined,
      { projectDirectory: "/tmp", privateSessionReader: privateReader } as unknown as Parameters<
        typeof KiloProvider
      >[3],
    )
    Object.defineProperty(provider, "client", { get: () => client })
    Object.defineProperty(provider, "getWorkspaceDirectory", { value: () => "/tmp", configurable: true })
    Object.defineProperty(provider, "initializeConnection", { value: async () => {}, configurable: true })
    const ctx = (provider as unknown as { sessionRefreshContext: SessionRefreshContext }).sessionRefreshContext
    const out = await ctx.listSessions!({ limit: 10 })
    expect(out.sessions).toEqual([])
    expect(out.cursor).toBeNull()
    expect(privateCalls).toHaveLength(1)
    expect(sdkCalls).toHaveLength(1)
    expect((sdkCalls[0] as Record<string, unknown>).limit).toBe(10)
    await new Promise((r) => setTimeout(r, 60))
    expect(parity).toHaveLength(0)
  })
})
