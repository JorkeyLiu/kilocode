import { describe, expect, test } from "bun:test"
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
})
