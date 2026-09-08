import { describe, it, expect } from "bun:test"
import { KiloProvider } from "./KiloProvider"
import type { KiloConnectionService } from "./services/cli-backend/connection-service"

function msg(id: string, time: number, sid: string) {
  return {
    info: {
      id,
      sessionID: sid,
      role: "user",
      time: { created: time },
      agent: "a",
      model: { providerID: "p", modelID: "m" },
    },
    parts: [{ id: `prt_${id}`, sessionID: sid, messageID: id, type: "text", text: "hi" }],
  }
}

function makeSdkSession(id: string, dir: string) {
  return {
    id,
    directory: dir,
    title: "hello",
    parentID: null,
    projectID: "proj_test",
    time: { created: 1000, updated: 2000 },
    summary: { additions: 1, deletions: 2, files: 1 },
    revert: { messageID: "msg_1" },
    agent: "agentX",
  }
}

function makePrivateFound(id: string, dir: string) {
  return {
    v: "1.0" as const,
    status: "found" as const,
    session: {
      id,
      title: "hello",
      parentID: null,
      directory: dir,
      projectID: "proj_test",
      createdAt: 1000,
      updatedAt: 2000,
      agent: "agentX",
      summary: { additions: 1, deletions: 2, files: 1 },
      revert: { messageID: "msg_1" },
    },
  }
}

function makeHarness(
  opts: {
    sid?: string
    dir?: string
    privateGet?: (input: { directory: string; sessionId: string }) => Promise<unknown>
    privateMessages?: (input: {
      directory: string
      sessionId: string
      limit: number
      cursor?: string
    }) => Promise<unknown>
    privateEnabled?: boolean
    privateStarted?: boolean
    hasMessagesFn?: boolean
    sdkMessages?: (p: unknown, o: unknown) => Promise<unknown>
  } = {},
) {
  const sid = opts.sid ?? "ses_child"
  const dir = opts.dir ?? "/tmp/ws"
  const sdkGets: unknown[] = []
  const sdkMessagesCalls: unknown[] = []
  const sdkMessagesOpts: unknown[] = []
  const privateGets: unknown[] = []
  const privateMessagesCalls: unknown[] = []
  const parityMessages: unknown[] = []
  const sdkItems = [msg("msg_1", 100, sid), msg("msg_2", 200, sid)]
  const client = {
    session: {
      get: async (p: unknown) => {
        sdkGets.push(p)
        return {
          data: makeSdkSession(sid, dir),
          error: undefined,
          response: { status: 200, headers: { get: () => null } },
        }
      },
      messages: async (p: unknown, o: unknown) => {
        sdkMessagesCalls.push(p)
        sdkMessagesOpts.push(o)
        if (opts.sdkMessages) return opts.sdkMessages(p, o)
        return { data: sdkItems, error: undefined, response: { status: 200, headers: { get: () => null } } }
      },
      status: async () => ({ data: {}, response: { status: 200 } }),
      create: async () => ({ data: makeSdkSession(sid, dir), error: undefined, response: { status: 200 } }),
      delete: async () => ({ error: undefined }),
      revert: async () => ({ data: makeSdkSession(sid, dir), error: undefined }),
      unrevert: async () => ({ data: makeSdkSession(sid, dir), error: undefined }),
    },
    backgroundProcess: { stopSession: async () => {} },
    instance: { reload: async () => {} },
  } as unknown as import("@kilocode/sdk/v2/client").KiloClient
  const reader: Record<string, unknown> = {
    isEnabled: () => opts.privateEnabled ?? true,
    isStarted: () => opts.privateStarted ?? true,
    list: async () => ({ v: "1.0", entries: [], nextCursor: undefined }),
    get: async (input: { directory: string; sessionId: string }) => {
      privateGets.push(input)
      if (opts.privateGet) return opts.privateGet(input)
      return makePrivateFound(input.sessionId, input.directory)
    },
  }
  if (opts.hasMessagesFn !== false) {
    reader.messages = async (input: { directory: string; sessionId: string; limit: number; cursor?: string }) => {
      privateMessagesCalls.push(input)
      if (opts.privateMessages) return opts.privateMessages(input)
      return {
        v: "1.0",
        status: "found",
        messages: [msg("msg_1", 100, input.sessionId), msg("msg_2", 200, input.sessionId)],
      }
    }
  }
  const connection = {
    isPrivateAvailable: () => true,
    getPrivateEpoch: () => 1,
    privateMessagesOutcomeWithHandle: (req: Record<string, unknown>) => {
      parityMessages.push(req)
      return {
        id: parityMessages.length,
        promise: Promise.resolve({
          kind: "valid",
          result: {
            v: 1,
            requestId: req.requestId,
            opId: req.opId,
            op: "session/messages",
            idempotencyKey: req.idempotencyKey,
            status: "succeeded",
            outcome: { type: "succeeded", time: 1 },
            accepted: true,
            data: { messages: [] },
          },
        }),
      }
    },
    privateMessagesWithHandle: (req: Record<string, unknown>) => {
      parityMessages.push(req)
      return { id: parityMessages.length, promise: Promise.resolve({ v: 1 }) }
    },
    privateMessages: async () => {
      throw new Error("unused")
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
  const provider = new KiloProvider({ fsPath: "/tmp" } as unknown as import("vscode").Uri, connection, undefined, {
    projectDirectory: dir,
    privateSessionReader: reader,
  } as unknown as Parameters<typeof KiloProvider>[3]) as unknown as Record<string, unknown> & KiloProvider
  Object.defineProperty(provider, "client", { get: () => client })
  Object.defineProperty(provider, "getWorkspaceDirectory", { value: () => dir, configurable: true })
  Object.defineProperty(provider, "initializeConnection", { value: async () => {}, configurable: true })
  return {
    provider,
    client,
    sid,
    dir,
    sdkGets,
    sdkMessagesCalls,
    sdkMessagesOpts,
    privateGets,
    privateMessagesCalls,
    parityMessages,
    sdkItems,
  }
}

const sync = (h: ReturnType<typeof makeHarness>, id?: string) =>
  (h.provider as unknown as { handleSyncSession: (s: string) => Promise<void> }).handleSyncSession(id ?? h.sid)

describe("KiloProvider child-sync full-history boundary", () => {
  it("private found avoids SDK messages", async () => {
    const h = makeHarness({})
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["syncedChildSessions"] as unknown) = new Set<string>()
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    await sync(h)
    expect(h.privateGets).toHaveLength(1)
    expect(h.privateMessagesCalls).toHaveLength(1)
    expect((h.privateMessagesCalls[0] as Record<string, unknown>).limit).toBe(100)
    expect(h.sdkMessagesCalls).toHaveLength(0)
    expect(h.sdkGets).toHaveLength(0)
    expect(posts.some((p) => (p as Record<string, unknown>).type === "sessionUpdated")).toBeTrue()
    const loaded = posts.find((p) => (p as Record<string, unknown>).type === "messagesLoaded") as Record<
      string,
      unknown
    >
    expect(loaded?.sessionID).toBe(h.sid)
    expect(loaded?.messages as unknown[]).toHaveLength(2)
    await new Promise((r) => setTimeout(r, 30))
    expect(h.parityMessages).toHaveLength(0)
  })

  it("private terminal avoids SDK and does not post stale data", async () => {
    for (const status of ["not_found", "scope_mismatch"] as const) {
      const h = makeHarness({
        privateMessages: async () => ({ v: "1.0", status }),
      })
      const anyP = h.provider as unknown as Record<string, unknown>
      ;(anyP["syncedChildSessions"] as unknown) = new Set<string>()
      ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
      const posts: unknown[] = []
      ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
      await sync(h)
      expect(h.privateMessagesCalls).toHaveLength(1)
      expect(h.sdkMessagesCalls).toHaveLength(0)
      expect(posts).toHaveLength(0)
      expect((anyP["syncedChildSessions"] as Set<string>).has(h.sid)).toBeFalse()
      await new Promise((r) => setTimeout(r, 20))
      expect(h.parityMessages).toHaveLength(0)
    }
  })

  it("fallback uses the existing full-read one-SDK behavior", async () => {
    const h = makeHarness({ hasMessagesFn: false })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["syncedChildSessions"] as unknown) = new Set<string>()
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    await sync(h)
    expect(h.sdkMessagesCalls).toHaveLength(1)
    expect((h.sdkMessagesCalls[0] as Record<string, unknown>).limit).toBe(0)
    expect(posts.some((p) => (p as Record<string, unknown>).type === "sessionUpdated")).toBeTrue()
    expect(posts.some((p) => (p as Record<string, unknown>).type === "messagesLoaded")).toBeTrue()
  })

  it("child sync replays post-token authoritative full after messagesLoaded", async () => {
    const h = makeHarness({})
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["syncedChildSessions"] as unknown) = new Set<string>()
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    const streams = anyP["streams"] as {
      push: (m: unknown) => void
      flush: (id: string) => void
    }
    const syncP = sync(h)
    streams.push({
      type: "partUpdated",
      sessionID: h.sid,
      messageID: "msg_2",
      part: { id: "prt_msg_2", sessionID: h.sid, messageID: "msg_2", type: "text", text: "live full" },
    })
    // Flush before the snapshot lands; capture history must still replay it.
    streams.flush(h.sid)
    await syncP
    const order = posts.map((p) => (p as Record<string, unknown>).type)
    expect(order.indexOf("messagesLoaded")).toBeGreaterThanOrEqual(0)
    const after = posts.slice(order.indexOf("messagesLoaded") + 1)
    const replayed = after.flatMap((m) => {
      const r = m as Record<string, unknown>
      if (r.type === "partUpdated") return [m]
      if (r.type === "partsUpdated") return (r.updates as unknown[]) ?? []
      return []
    })
    expect(
      replayed.some((u) => ((u as Record<string, unknown>).part as Record<string, unknown>).id === "prt_msg_2"),
    ).toBeTrue()
  })

  it("child sync posts sessionUpdated then messagesLoaded then replay inside commit", async () => {
    const h = makeHarness({})
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["syncedChildSessions"] as unknown) = new Set<string>()
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    const order: string[] = []
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => {
      posts.push(m)
      const t = (m as Record<string, unknown>).type
      if (t === "sessionUpdated" || t === "messagesLoaded" || t === "partUpdated" || t === "partsUpdated") {
        order.push(t as string)
      }
    }
    const streams = anyP["streams"] as {
      push: (m: unknown) => void
      commit: (sid: string, token: number, snapshot: Set<string>, before: () => void) => boolean
    }
    const orig = streams.commit.bind(streams)
    let beforeOrder: string[] = []
    streams.commit = ((sid: string, token: number, snapshot: Set<string>, before: () => void) => {
      const wrapped = () => {
        const beforePosts = posts.length
        before()
        beforeOrder = (posts.slice(beforePosts) as Array<Record<string, unknown>>).map((p) => p.type as string)
      }
      const ok = orig(sid, token, snapshot, wrapped)
      if (ok) order.push("replay")
      return ok
    }) as typeof streams.commit
    const syncP = sync(h)
    streams.push({
      type: "partUpdated",
      sessionID: h.sid,
      messageID: "msg_2",
      part: { id: "prt_msg_2", sessionID: h.sid, messageID: "msg_2", type: "text", text: "live full" },
    })
    await syncP
    expect(beforeOrder).toEqual(["sessionUpdated", "messagesLoaded"])
    expect(order.slice(0, 2)).toEqual(["sessionUpdated", "messagesLoaded"])
    expect(order[order.length - 1]).toBe("replay")
    const loaded = posts.find((p) => (p as Record<string, unknown>).type === "messagesLoaded") as Record<
      string,
      unknown
    >
    expect(loaded?.mode).toBe("replace")
    expect(loaded?.hasMore).toBeFalse()
  })

  it("authoritative terminal untracks only the child and drops its queue; parent untouched", async () => {
    for (const status of ["not_found", "scope_mismatch"] as const) {
      const h = makeHarness({
        privateMessages: async () => ({ v: "1.0", status }),
      })
      const anyP = h.provider as unknown as Record<string, unknown>
      const parent = "ses_parent"
      ;(anyP["syncedChildSessions"] as unknown) = new Set<string>()
      const tracked = new Set<string>([parent, h.sid])
      ;(anyP["trackedSessionIds"] as unknown) = tracked
      const posts: unknown[] = []
      ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
      const streams = anyP["streams"] as {
        push: (m: unknown) => void
        flush: (id: string) => void
      }
      // Queue child state after capture while the terminal fetch is in flight;
      // the terminal path must drop it without posts.
      const pending = sync(h)
      streams.push({
        type: "partUpdated",
        sessionID: h.sid,
        messageID: "msg_1",
        part: { id: "prt_stale", sessionID: h.sid, messageID: "msg_1", type: "text", text: "stale" },
        delta: { type: "text-delta", textDelta: "stale" },
      })
      await pending
      expect(posts).toHaveLength(0)
      expect(tracked.has(h.sid)).toBeFalse()
      expect((anyP["syncedChildSessions"] as Set<string>).has(h.sid)).toBeFalse()
      // Parent/current-adjacent state is preserved.
      expect(tracked.has(parent)).toBeTrue()
      // Dropped queue emits nothing for the stale child on flush.
      streams.flush(h.sid)
      expect(posts).toHaveLength(0)
    }
  })

  it("stale terminal leaves newer tracking/capture/queue intact (A-delete-B-A-terminal)", async () => {
    let calls = 0
    const aGate = (() => {
      let resolve!: () => void
      const promise = new Promise<void>((r) => (resolve = r))
      return { promise, resolve }
    })()
    const bGate = (() => {
      let resolve!: () => void
      const promise = new Promise<void>((r) => (resolve = r))
      return { promise, resolve }
    })()
    const h = makeHarness({
      privateMessages: async () => {
        calls += 1
        if (calls === 1) {
          await aGate.promise
          return { v: "1.0", status: "not_found" }
        }
        await bGate.promise
        return {
          v: "1.0",
          status: "found",
          messages: [msg("msg_1", 100, h.sid), msg("msg_2", 200, h.sid)],
        }
      },
    })
    const anyP = h.provider as unknown as Record<string, unknown> & {
      pruneDeletedSession: (s: string) => void
      handleSyncSession: (s: string, p?: string) => Promise<void>
      handleEvent: (e: unknown, d?: string) => void
    }
    const parent = "ses_parent"
    ;(anyP["syncedChildSessions"] as unknown) = new Set<string>()
    const tracked = new Set<string>([parent])
    ;(anyP["trackedSessionIds"] as unknown) = tracked
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    const streams = anyP["streams"] as {
      push: (m: unknown) => void
      flush: (id: string) => void
      isLatestAttempt: (sid: string, token: number) => boolean
    }

    const syncA = anyP.handleSyncSession(h.sid)
    streams.push({
      type: "partUpdated",
      sessionID: h.sid,
      messageID: "msg_1",
      part: { id: "prt_old", sessionID: h.sid, messageID: "msg_1", type: "text", text: "stale" },
      delta: { type: "text-delta", textDelta: "stale" },
    })
    anyP.pruneDeletedSession(h.sid)
    expect(tracked.has(h.sid)).toBeFalse()
    const syncB = anyP.handleSyncSession(h.sid, parent)
    streams.push({
      type: "partUpdated",
      sessionID: h.sid,
      messageID: "msg_2",
      part: { id: "prt_new", sessionID: h.sid, messageID: "msg_2", type: "text", text: "live" },
      delta: { type: "text-delta", textDelta: "live" },
    })
    aGate.resolve()
    await new Promise((r) => setTimeout(r, 5))
    expect(tracked.has(h.sid)).toBeTrue()
    expect((anyP["syncedChildSessions"] as Set<string>).has(h.sid)).toBeTrue()
    expect(tracked.has(parent)).toBeTrue()
    bGate.resolve()
    await syncA
    await syncB

    const childLoads = posts.filter(
      (m) =>
        typeof m === "object" &&
        m &&
        (m as { sessionID?: string }).sessionID === h.sid &&
        (m as { type: string }).type === "messagesLoaded",
    )
    expect(childLoads).toHaveLength(1)
    const flat = posts.flatMap((m) => {
      const r = m as Record<string, unknown>
      if (r.type === "partUpdated") return [m]
      if (r.type === "partsUpdated") return (r.updates as unknown[]) ?? []
      return []
    }) as Array<Record<string, unknown>>
    expect(flat.some((u) => (u.part as Record<string, unknown>).id === "prt_new")).toBeTrue()
    expect(flat.some((u) => (u.part as Record<string, unknown>).id === "prt_old")).toBeFalse()
    expect((anyP["syncedChildSessions"] as Set<string>).has(h.sid)).toBeTrue()
    expect(tracked.has(h.sid)).toBeTrue()
    expect(tracked.has(parent)).toBeTrue()
  })

  it("latest expired terminal still performs session-wide cleanup; parent intact, stale SSE dropped", async () => {
    const h = makeHarness({
      privateMessages: async () => ({ v: "1.0", status: "not_found" }),
    })
    const anyP = h.provider as unknown as Record<string, unknown> & {
      handleSyncSession: (s: string, p?: string) => Promise<void>
      handleEvent: (e: unknown, d?: string) => void
      sessionToWebview?: unknown
    }
    const parent = "ses_parent"
    ;(anyP["syncedChildSessions"] as unknown) = new Set<string>()
    const tracked = new Set<string>([parent])
    ;(anyP["trackedSessionIds"] as unknown) = tracked
    const dirs = anyP["sessionDirectories"] as Map<string, string>
    dirs.set(parent, "/tmp/ws")
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    const streams = anyP["streams"] as {
      push: (m: unknown) => void
      flush: (id: string) => void
    }

    const pending = anyP.handleSyncSession(h.sid, parent)
    for (let i = 0; i < 201; i++) {
      streams.push({
        type: "partUpdated",
        sessionID: h.sid,
        messageID: `mx${i}`,
        part: { id: `px${i}`, sessionID: h.sid, messageID: `mx${i}`, type: "text", text: `t${i}` },
        delta: { type: "text-delta", textDelta: `t${i}` },
      })
    }
    await pending
    expect(posts).toHaveLength(0)
    expect(tracked.has(h.sid)).toBeFalse()
    expect(tracked.has(parent)).toBeTrue()
    expect((anyP["syncedChildSessions"] as Set<string>).has(h.sid)).toBeFalse()
    expect(dirs.has(h.sid)).toBeFalse()
    expect(dirs.get(parent)).toBe("/tmp/ws")
    streams.flush(h.sid)
    expect(posts).toHaveLength(0)
    const before = posts.length
    anyP.handleEvent(
      {
        id: "e-stale",
        type: "message.part.updated",
        properties: {
          sessionID: h.sid,
          part: { id: "p-stale", messageID: "m1", sessionID: h.sid, type: "text", text: "stale" },
        },
      },
      "/tmp/ws",
    )
    expect(posts).toHaveLength(before)
    expect(tracked.has(h.sid)).toBeFalse()
    expect(tracked.has(parent)).toBeTrue()
  })

  it("transient child-sync failure keeps tracking and allows retry", async () => {
    let calls = 0
    const h = makeHarness({
      hasMessagesFn: false,
      sdkMessages: async () => {
        calls += 1
        if (calls === 1) throw new Error("transient")
        return { data: [], error: undefined, response: { status: 200, headers: { get: () => null } } }
      },
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["syncedChildSessions"] as unknown) = new Set<string>()
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    await sync(h)
    // Failed sync posts nothing but stays tracked with the marker evicted.
    expect(posts).toHaveLength(0)
    expect((anyP["trackedSessionIds"] as Set<string>).has(h.sid)).toBeTrue()
    expect((anyP["syncedChildSessions"] as Set<string>).has(h.sid)).toBeFalse()
    await sync(h)
    expect(calls).toBe(2)
    expect(posts.some((p) => (p as Record<string, unknown>).type === "messagesLoaded")).toBeTrue()
  })
  it("latest child terminal clears usage marker while parent and unrelated markers remain", async () => {
    for (const status of ["not_found", "scope_mismatch"] as const) {
      const h = makeHarness({
        privateMessages: async () => ({ v: "1.0", status }),
      })
      const anyP = h.provider as unknown as Record<string, unknown>
      const parent = "ses_parent"
      const unrelated = "ses_other"
      ;(anyP["syncedChildSessions"] as unknown) = new Set<string>()
      ;(anyP["trackedSessionIds"] as unknown) = new Set<string>([parent, h.sid])
      ;(anyP["modelUsageSessionIds"] as unknown) = new Set<string>([parent, h.sid, unrelated])
      const posts: unknown[] = []
      ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
      await (
        h.provider as unknown as { handleSyncSession: (s: string, p?: string) => Promise<void> }
      ).handleSyncSession(h.sid, parent)
      expect(posts).toHaveLength(0)
      const usage = anyP["modelUsageSessionIds"] as Set<string>
      expect(usage.has(h.sid)).toBeFalse()
      expect(usage.has(parent)).toBeTrue()
      expect(usage.has(unrelated)).toBeTrue()
      expect((anyP["trackedSessionIds"] as Set<string>).has(parent)).toBeTrue()
    }
  })

  it("ordinary session.deleted prune clears usage marker and stays symmetric", async () => {
    const h = makeHarness({})
    const anyP = h.provider as unknown as Record<string, unknown> & {
      pruneDeletedSession: (s: string) => void
    }
    const parent = "ses_parent"
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>([parent, h.sid])
    ;(anyP["modelUsageSessionIds"] as unknown) = new Set<string>([parent, h.sid])
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    anyP.pruneDeletedSession(h.sid)
    const usage = anyP["modelUsageSessionIds"] as Set<string>
    expect(usage.has(h.sid)).toBeFalse()
    expect(usage.has(parent)).toBeTrue()
    expect((anyP["trackedSessionIds"] as Set<string>).has(h.sid)).toBeFalse()
    expect((anyP["trackedSessionIds"] as Set<string>).has(parent)).toBeTrue()
  })

  it("latest expired commit false clears synced marker and next call retries successfully", async () => {
    const h = makeHarness({})
    const anyP = h.provider as unknown as Record<string, unknown>
    const parent = "ses_parent"
    ;(anyP["syncedChildSessions"] as unknown) = new Set<string>()
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>([parent])
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    const streams = anyP["streams"] as {
      commit: (sid: string, token: number, snapshot: Set<string>, before: () => void) => boolean
      discard: (sid: string, token: number) => void
      isLatestAttempt: (sid: string, token: number) => boolean
    }
    const orig = streams.commit.bind(streams)
    let calls = 0
    streams.commit = ((sid: string, token: number, snapshot: Set<string>, before: () => void) => {
      calls += 1
      if (calls === 1 && sid === h.sid) {
        // Simulate scheduler expiry: capture invalidated just before commit
        // while the latest attempt identity still points at this token.
        streams.discard(sid, token)
        const ok = orig(sid, token, snapshot, before)
        expect(ok).toBeFalse()
        expect(streams.isLatestAttempt(sid, token)).toBeTrue()
        return ok
      }
      return orig(sid, token, snapshot, before)
    }) as typeof streams.commit
    await (h.provider as unknown as { handleSyncSession: (s: string, p?: string) => Promise<void> }).handleSyncSession(
      h.sid,
      parent,
    )
    expect(posts).toHaveLength(0)
    expect((anyP["trackedSessionIds"] as Set<string>).has(h.sid)).toBeTrue()
    expect((anyP["trackedSessionIds"] as Set<string>).has(parent)).toBeTrue()
    expect((anyP["syncedChildSessions"] as Set<string>).has(h.sid)).toBeFalse()
    streams.commit = orig
    await (h.provider as unknown as { handleSyncSession: (s: string, p?: string) => Promise<void> }).handleSyncSession(
      h.sid,
      parent,
    )
    expect(posts.some((p) => (p as Record<string, unknown>).type === "messagesLoaded")).toBeTrue()
    expect((anyP["syncedChildSessions"] as Set<string>).has(h.sid)).toBeTrue()
    expect((anyP["trackedSessionIds"] as Set<string>).has(h.sid)).toBeTrue()
    expect((anyP["trackedSessionIds"] as Set<string>).has(parent)).toBeTrue()
  })

  it("latest overflow commit false clears synced marker and retry succeeds without pruning", async () => {
    let release!: (v: unknown) => void
    const gate = new Promise<unknown>((r) => (release = r))
    const h = makeHarness({
      privateMessages: async (input) => {
        await gate
        return {
          v: "1.0",
          status: "found",
          messages: [msg("msg_1", 100, input.sessionId), msg("msg_2", 200, input.sessionId)],
        }
      },
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    const parent = "ses_parent"
    ;(anyP["syncedChildSessions"] as unknown) = new Set<string>()
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>([parent])
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    const streams = anyP["streams"] as {
      push: (m: unknown) => void
      isLatestAttempt: (sid: string, token: number) => boolean
    }
    const pending = (
      h.provider as unknown as { handleSyncSession: (s: string, p?: string) => Promise<void> }
    ).handleSyncSession(h.sid, parent)
    for (let i = 0; i < 201; i++) {
      streams.push({
        type: "partUpdated",
        sessionID: h.sid,
        messageID: `mx${i}`,
        part: { id: `px${i}`, sessionID: h.sid, messageID: `mx${i}`, type: "text", text: `t${i}` },
        delta: { type: "text-delta", textDelta: `t${i}` },
      })
    }
    release(null)
    await pending
    expect(posts).toHaveLength(0)
    expect((anyP["trackedSessionIds"] as Set<string>).has(h.sid)).toBeTrue()
    expect((anyP["trackedSessionIds"] as Set<string>).has(parent)).toBeTrue()
    expect((anyP["syncedChildSessions"] as Set<string>).has(h.sid)).toBeFalse()
    await (h.provider as unknown as { handleSyncSession: (s: string, p?: string) => Promise<void> }).handleSyncSession(
      h.sid,
      parent,
    )
    expect(posts.some((p) => (p as Record<string, unknown>).type === "messagesLoaded")).toBeTrue()
    expect((anyP["syncedChildSessions"] as Set<string>).has(h.sid)).toBeTrue()
    expect((anyP["trackedSessionIds"] as Set<string>).has(parent)).toBeTrue()
  })

  it("stale commit false does not clear newer marker or start duplicate; parent/tracking remains", async () => {
    let release!: (v: unknown) => void
    const gate = new Promise<unknown>((r) => (release = r))
    const h = makeHarness({
      privateMessages: async (input) => {
        await gate
        return {
          v: "1.0",
          status: "found",
          messages: [msg("msg_1", 100, input.sessionId), msg("msg_2", 200, input.sessionId)],
        }
      },
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    const parent = "ses_parent"
    ;(anyP["syncedChildSessions"] as unknown) = new Set<string>()
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>([parent])
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    const streams = anyP["streams"] as {
      capture: (sid: string) => number
      isLatestAttempt: (sid: string, token: number) => boolean
    }
    const pending = (
      h.provider as unknown as { handleSyncSession: (s: string, p?: string) => Promise<void> }
    ).handleSyncSession(h.sid, parent)
    // Newer same-session capture supersedes the in-flight sync token mid-fetch.
    const newer = streams.capture(h.sid)
    expect(streams.isLatestAttempt(h.sid, newer)).toBeTrue()
    const callsBefore = h.privateMessagesCalls.length
    release(null)
    await pending
    expect(posts).toHaveLength(0)
    expect((anyP["syncedChildSessions"] as Set<string>).has(h.sid)).toBeTrue()
    expect((anyP["trackedSessionIds"] as Set<string>).has(h.sid)).toBeTrue()
    expect((anyP["trackedSessionIds"] as Set<string>).has(parent)).toBeTrue()
    // A retry while the newer marker is held does not start a duplicate fetch.
    await (h.provider as unknown as { handleSyncSession: (s: string, p?: string) => Promise<void> }).handleSyncSession(
      h.sid,
      parent,
    )
    expect(h.privateMessagesCalls.length).toBe(callsBefore)
    expect(posts).toHaveLength(0)
    expect((anyP["syncedChildSessions"] as Set<string>).has(h.sid)).toBeTrue()
  })
})
