import { describe, expect, test } from "bun:test"
import { KiloProvider } from "./KiloProvider"
import type { KiloConnectionService } from "./services/cli-backend/connection-service"
import { loadSessions, normalizeSessionListNextCursor, type SessionRefreshContext } from "./kilo-provider-utils"
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

describe("session-list paging header gate and terminal append", () => {
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

  test("empty terminal append clears hasMore and cursor", async () => {
    const posted: unknown[] = []
    const ctx = ctxWith(async () => ({ sessions: [], cursor: null }), {
      loadedCount: 2,
      cursor: OPAQUE(9, "ses_x"),
      postMessage: (m: unknown) => posted.push(m),
    })
    await loadSessions(ctx, OPAQUE(9, "ses_x"))
    expect(ctx.cursor).toBeNull()
    expect(ctx.loadedCount).toBe(2)
    expect(posted).toHaveLength(1)
    const msg = posted[0] as Record<string, unknown>
    expect(msg.append).toBe(true)
    expect(msg.hasMore).toBe(false)
    expect(msg.nextCursor).toBeNull()
    expect(msg.sessions).toEqual([])
  })

  test("append with terminal null cursor accumulates count without hasMore", async () => {
    const posted: unknown[] = []
    const session = {
      id: "ses_a",
      directory: "/tmp",
      title: "t",
      time: { created: 1, updated: 2 },
      projectID: "p1",
    }
    const ctx = ctxWith(null, {
      loadedCount: 2,
      cursor: OPAQUE(9, "ses_x"),
      postMessage: (m: unknown) => posted.push(m),
    })
    // Rebind with a correctly typed single-session page to avoid generic drift.
    ctx.listSessions = (async () => ({
      sessions: [session],
      cursor: null,
    })) as unknown as SessionRefreshContext["listSessions"]
    await loadSessions(ctx, OPAQUE(9, "ses_x"))
    expect(ctx.cursor).toBeNull()
    expect(ctx.loadedCount).toBe(3)
    const msg = posted[0] as Record<string, unknown>
    expect(msg.append).toBe(true)
    expect(msg.hasMore).toBe(false)
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
      { projectDirectory: "/tmp", privateSessionReader: privateReader } as unknown as Parameters<typeof KiloProvider>[3],
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
