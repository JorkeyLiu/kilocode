import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { loadSessions, type SessionRefreshContext } from "../../src/kilo-provider-utils"
import { deriveTopics } from "../../webview-ui/agent-manager/topics"
import { encodeSessionListCursor } from "../../src/services/cli-backend/serve-private-session-list-contract"

const ROOT = path.join(__dirname, "../..")
const OPAQUE = (updated: number, id: string) => encodeSessionListCursor(updated, id)

function session(
  id: string,
  opts: { parentID?: string | null; updated?: number; title?: string } = {},
) {
  return {
    id,
    parentID: opts.parentID ?? null,
    title: opts.title ?? id,
    directory: "/repo",
    projectID: "proj",
    time: { created: 1, updated: opts.updated ?? 1 },
  }
}

function ctxFor(pages: Map<string | undefined, { sessions: ReturnType<typeof session>[]; cursor: string | null }>) {
  const posted: unknown[] = []
  const calls: Array<{ limit: number; cursor?: string }> = []
  const list = (async (input: { limit: number; cursor?: string }) => {
    calls.push(input)
    const key = input.cursor as string | undefined
    const page = pages.get(key)
    if (!page) throw new Error(`unexpected cursor ${String(key)}`)
    return page as never
  }) as unknown as SessionRefreshContext["listSessions"]
  const ctx: SessionRefreshContext = {
    pendingSessionRefresh: false,
    connectionState: "connected",
    listSessions: list,
    loadedCount: 0,
    cursor: null,
    root: "/repo",
    postMessage: (m: unknown) => posted.push(m),
  }
  return { ctx, posted, calls }
}

function toTopicInput(sessions: { id: string; parentID: string | null; title: string; createdAt?: string; updatedAt?: string; time?: { created: number; updated: number } }[]) {
  return sessions.map((s) => ({
    id: s.id,
    parentID: s.parentID,
    title: s.title,
    createdAt: s.createdAt ?? new Date(s.time!.created).toISOString(),
    updatedAt: s.updatedAt ?? new Date(s.time!.updated).toISOString(),
  }))
}

describe("complete inventory Topic convergence (real drain + pure derivation)", () => {
  it("parent on a later page converges into one Topic", async () => {
    const c1 = OPAQUE(20, "ses_child")
    const pages = new Map<string | undefined, { sessions: never[]; cursor: string | null }>([
      [undefined, { sessions: [session("ses_child", { parentID: "ses_root", updated: 5 })] as never[], cursor: c1 }],
      [c1, { sessions: [session("ses_root", { updated: 1 })] as never[], cursor: null }],
    ])
    const { ctx, posted } = ctxFor(pages)
    await loadSessions(ctx)
    expect(posted).toHaveLength(1)
    const msg = posted[0] as { append: boolean; hasMore: boolean; sessions: Parameters<typeof toTopicInput>[0] }
    expect(msg.append).toBe(false)
    expect(msg.hasMore).toBe(false)
    const topics = deriveTopics(toTopicInput(msg.sessions))
    expect(topics).toHaveLength(1)
    expect(topics[0]!.id).toBe("ses_root")
    expect(topics[0]!.members.map((m) => m.id).sort()).toEqual(["ses_child", "ses_root"])
    // Activity is max member updatedAt across the former page boundary.
    expect(topics[0]!.activity).toBe(new Date(5).toISOString())
  })

  it("cross-page activity ordering and ID tie-break are correct", async () => {
    const c1 = OPAQUE(30, "ses_m1")
    const pages = new Map<string | undefined, { sessions: never[]; cursor: string | null }>([
      [undefined, { sessions: [session("ses_b", { updated: 10 }), session("ses_m1", { updated: 20 })] as never[], cursor: c1 }],
      [c1, { sessions: [session("ses_a", { updated: 20 }), session("ses_old", { updated: 1 })] as never[], cursor: null }],
    ])
    const { ctx, posted } = ctxFor(pages)
    await loadSessions(ctx)
    const msg = posted[0] as { sessions: Parameters<typeof toTopicInput>[0] }
    const topics = deriveTopics(toTopicInput(msg.sessions))
    // ses_a and ses_m1 tie at updated 20 -> ID ascending; then ses_b, then ses_old.
    expect(topics.map((t) => t.id)).toEqual(["ses_a", "ses_m1", "ses_b", "ses_old"])
  })

  it("orphan after exhaustion stays independent only when the parent is truly absent", async () => {
    const c1 = OPAQUE(20, "ses_x")
    // Complete inventory truly lacks the parent.
    const pages = new Map<string | undefined, { sessions: never[]; cursor: string | null }>([
      [undefined, { sessions: [session("ses_orphan", { parentID: "ses_missing", updated: 5 })] as never[], cursor: c1 }],
      [c1, { sessions: [session("ses_root", { updated: 1 })] as never[], cursor: null }],
    ])
    const { ctx, posted } = ctxFor(pages)
    await loadSessions(ctx)
    const msg = posted[0] as { sessions: Parameters<typeof toTopicInput>[0] }
    const topics = deriveTopics(toTopicInput(msg.sessions))
    expect(topics.map((t) => t.id).sort()).toEqual(["ses_orphan", "ses_root"])
    // And when the parent arrives on the last page, the orphan converges.
    const c2 = OPAQUE(20, "ses_y")
    const pages2 = new Map<string | undefined, { sessions: never[]; cursor: string | null }>([
      [undefined, { sessions: [session("ses_orphan", { parentID: "ses_root", updated: 5 })] as never[], cursor: c2 }],
      [c2, { sessions: [session("ses_root", { updated: 1 })] as never[], cursor: null }],
    ])
    const second = ctxFor(pages2)
    await loadSessions(second.ctx)
    const msg2 = second.posted[0] as { sessions: Parameters<typeof toTopicInput>[0] }
    expect(deriveTopics(toTopicInput(msg2.sessions))).toHaveLength(1)
  })

  it("cursor stall fails without publishing a false complete inventory", async () => {
    const c1 = OPAQUE(20, "ses_loop")
    const pages = new Map<string | undefined, { sessions: never[]; cursor: string | null }>([
      [undefined, { sessions: [session("ses_a")] as never[], cursor: c1 }],
      [c1, { sessions: [session("ses_b")] as never[], cursor: c1 }],
    ])
    const { ctx, posted } = ctxFor(pages)
    await expect(loadSessions(ctx)).rejects.toThrow("session list cursor stalled")
    expect(posted).toHaveLength(0)
  })

  it("refresh/reconnect coherence: successive drains replace, failure preserves", async () => {
    const c1 = OPAQUE(20, "ses_p1")
    const first = new Map<string | undefined, { sessions: never[]; cursor: string | null }>([
      [undefined, { sessions: [session("ses_a", { updated: 1 })] as never[], cursor: c1 }],
      [c1, { sessions: [session("ses_b", { updated: 2 })] as never[], cursor: null }],
    ])
    const { ctx, posted } = ctxFor(first)
    await loadSessions(ctx)
    expect((posted[0] as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual(["ses_a", "ses_b"])
    expect(ctx.loadedCount).toBe(2)
    // Second refresh sees a new session and replaces coherently.
    const c2 = OPAQUE(20, "ses_q1")
    const secondPages = new Map<string | undefined, { sessions: never[]; cursor: string | null }>([
      [undefined, { sessions: [session("ses_c", { updated: 3 })] as never[], cursor: c2 }],
      [c2, { sessions: [session("ses_a", { updated: 1 })] as never[], cursor: null }],
    ])
    const calls2: unknown[] = []
    ctx.listSessions = (async (input: { limit: number; cursor?: string }) => {
      calls2.push(input)
      return secondPages.get(input.cursor as string | undefined) as never
    }) as unknown as SessionRefreshContext["listSessions"]
    await loadSessions(ctx)
    expect(posted).toHaveLength(2)
    expect((posted[1] as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual(["ses_c", "ses_a"])
    // Failed refresh publishes nothing, preserving the last complete snapshot.
    ctx.listSessions = (async () => {
      throw new Error("backend down")
    }) as unknown as SessionRefreshContext["listSessions"]
    await expect(loadSessions(ctx)).rejects.toThrow("backend down")
    expect(posted).toHaveLength(2)
  })
})

describe("Topic absence of persistence/API/messages (architecture)", () => {
  const TOPICS = fs.readFileSync(path.join(ROOT, "webview-ui/agent-manager/topics.ts"), "utf-8")
  const SIDEBAR = fs.readFileSync(path.join(ROOT, "webview-ui/agent-manager/SidebarSessionList.tsx"), "utf-8")
  const UTILS = fs.readFileSync(path.join(ROOT, "src/kilo-provider-utils.ts"), "utf-8")
  const PROVIDER = fs.readFileSync(path.join(ROOT, "src/KiloProvider.ts"), "utf-8")

  it("Topic derivation stays pure with no persistence or messaging", () => {
    for (const src of [TOPICS, SIDEBAR]) {
      expect(src).not.toContain("localStorage")
    }
    expect(TOPICS).not.toContain("postMessage")
    expect(TOPICS).not.toContain("vscode")
    expect(TOPICS).toContain("export function deriveTopics")
    expect(SIDEBAR).not.toContain("postMessage")
    expect(SIDEBAR).toContain("deriveTopics(")
  })

  it("no Topic-specific protocol, persistence, or children endpoint", () => {
    for (const src of [UTILS, PROVIDER, TOPICS, SIDEBAR]) {
      expect(src).not.toContain("session/children")
      expect(src).not.toContain("Topic persistence")
      expect(src).not.toContain("topicPersistence")
    }
    expect(PROVIDER).not.toContain("/topic")
    // Complete inventory publishes no intermediate append pages.
    expect(UTILS).toContain("append: false")
    expect(UTILS).not.toContain("append,")
  })

  it("obsolete load-more UI is gone from Topic surfaces", () => {
    expect(SIDEBAR).not.toContain("loadMoreSessions")
    expect(SIDEBAR).not.toContain("sessionsHasMore")
    expect(SIDEBAR).not.toContain("common.loadMore")
  })
})
