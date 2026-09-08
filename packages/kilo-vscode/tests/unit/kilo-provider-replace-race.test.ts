import { describe, it, expect } from "bun:test"
import type { PartUpdate } from "../../src/shared/stream-messages"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider } = await import("../../src/KiloProvider")

type State = "connecting" | "connected" | "disconnected" | "error"

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function mkMessage(id: string, role: "user" | "assistant", time = 0, parts: unknown[] = []) {
  return {
    info: { id, sessionID: "s1", role, time: { created: time } },
    parts,
  }
}

function mkResult(items: unknown[]) {
  return { data: items, response: { headers: new Headers() } }
}

function mkSession(id: string, dir = "/tmp/ws") {
  return {
    id,
    directory: dir,
    title: "child",
    parentID: null,
    projectID: "proj_test",
    time: { created: 1000, updated: 2000 },
    summary: { additions: 1, deletions: 2, files: 1 },
    revert: { messageID: "msg_1" },
    agent: "agentX",
  }
}

function createClient(options?: {
  messagesDeferred?: Deferred<{ data: unknown[]; response: { headers: Headers } }>
  messagesData?: unknown[]
  getDeferred?: Deferred<{ data: unknown }>
  getData?: unknown
}) {
  return {
    session: {
      list: async () => ({ data: [] }),
      create: async () => ({ data: { id: "created", title: "Created", time: { created: 0, updated: 0 } } }),
      get: async () => {
        if (options?.getDeferred) return options.getDeferred.promise
        return { data: options?.getData ?? null }
      },
      status: async () => ({ data: {} }),
      revert: async () => ({ data: {} }),
      promptAsync: async () => ({ data: undefined }),
      abort: async () => ({ data: true }),
      messages: async () => {
        if (options?.messagesDeferred) return options.messagesDeferred.promise
        return mkResult(options?.messagesData ?? [])
      },
      delete: async () => ({ data: {} }),
    },
    backgroundProcess: { stopSession: async () => ({ data: {} }) },
    provider: { list: async () => ({ data: { all: [], connected: {}, default: {} } }) },
    app: { agents: async () => ({ data: [] }) },
    config: { get: async () => ({ data: {} }) },
    kilo: { profile: async () => ({ data: {} }) },
    command: { list: async () => ({ data: [] }) },
  }
}

function createConnection(client: ReturnType<typeof createClient>) {
  return {
    sandboxPreference: {
      explicit: () => undefined,
      resolve: (fallback: boolean) => fallback,
      wait: () => Promise.resolve(),
      set: async () => undefined,
      onChange: () => () => undefined,
    },
    connect: async () => {},
    getClient: () => client,
    onEventFiltered: () => () => undefined,
    onStateChange: (_l: (s: State) => void) => () => undefined,
    onLanguageChanged: () => () => undefined,
    onProfileChanged: () => () => undefined,
    onFavoritesChanged: () => () => undefined,
    onModelSelectorExpandedChanged: () => () => undefined,
    getConfigRevision: () => 0,
    advanceConfigRevision: () => {},
    onConfigRevision: () => () => undefined,
    registerDirectoryProvider: () => () => undefined,
    getServerInfo: () => ({ port: 12345 }),
    getConnectionState: () => "connected" as const,
    getConnectionError: () => null,
    resolveEventSessionId: () => undefined,
    recordMessageSessionId: () => undefined,
    pruneSession: () => undefined,
    registerVisible: () => undefined,
    unregisterVisible: () => undefined,
    registerAttached: () => undefined,
    unregisterAttached: () => undefined,
  }
}

function makeProvider(client: ReturnType<typeof createClient>) {
  const connection = createConnection(client)
  const provider = new KiloProvider({} as never, connection as never)
  const internal = provider as unknown as {
    connectionState: State
    webview: { postMessage: (message: unknown) => Promise<unknown> } | null
    trackedSessionIds: Set<string>
    streams: { push: (msg: PartUpdate) => void; dispose?: () => void }
    handleLoadMessages: (sid: string, opts?: { mode?: string; preserveStream?: boolean }) => Promise<void>
    handleDeleteSession: (sid: string) => Promise<void>
  }
  internal.connectionState = "connected"
  const sent: unknown[] = []
  internal.webview = {
    postMessage: async (message: unknown) => {
      sent.push(message)
    },
  }
  const anyInternal = internal as unknown as {
    syncedChildSessions: Set<string>
    trackedSessionIds: Set<string>
    handleSyncSession: (sid: string, parent?: string) => Promise<void>
    pruneDeletedSession: (sid: string) => void
  }
  return { provider, internal, sent, anyInternal }
}

function types(sent: unknown[]) {
  return sent.map((msg) => (typeof msg === "object" && msg ? (msg as { type?: string }).type : undefined))
}

function loadedMsg(sent: unknown[]) {
  return sent.find((msg) => typeof msg === "object" && msg && (msg as { type?: unknown }).type === "messagesLoaded") as
    | { mode?: string; since?: unknown; messages: Array<{ id: string; parts?: Array<{ id: string; text?: string }> }> }
    | undefined
}

function updates(sent: unknown[]) {
  return sent.flatMap((msg) => {
    if (typeof msg !== "object" || !msg) return []
    const m = msg as { type?: string; updates?: PartUpdate[] }
    if (m.type === "partsUpdated") return m.updates ?? []
    if (m.type === "partUpdated") return [msg as PartUpdate]
    return []
  })
}

describe("KiloProvider replace snapshot / SSE race", () => {
  it("(a) preserves a new tail part queued after fetch starts", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending })
    const { internal, sent } = makeProvider(client)

    const load = internal.handleLoadMessages("s1", { mode: "replace" })
    // Queued after fetch starts (since already captured synchronously).
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: {
        id: "p2",
        sessionID: "s1",
        messageID: "m2",
        type: "text",
        text: "final summary",
        time: { start: Date.now() + 1000 },
      },
    })
    pending.resolve(
      mkResult([
        mkMessage("m1", "user", 1),
        mkMessage("m2", "assistant", 2, [
          { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "tool done", time: { start: 1, end: 2 } },
        ]),
      ]),
    )
    await load

    const loaded = loadedMsg(sent)
    expect(loaded?.mode).toBe("replace")
    expect(typeof loaded?.since).toBe("number")
    const t = types(sent)
    const snapshot = t.indexOf("messagesLoaded")
    const update = t.findIndex((type) => type === "partUpdated" || type === "partsUpdated")
    expect(snapshot).toBeGreaterThanOrEqual(0)
    expect(update).toBeGreaterThan(snapshot)
    const flat = updates(sent)
    expect(flat.some((u) => (u.part as { id?: string }).id === "p2")).toBe(true)
    internal.streams.dispose?.()
  })

  it("(b) drops a delta to an existing snapshot part as ambiguous without text inspection", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending })
    const { internal, sent } = makeProvider(client)

    const load = internal.handleLoadMessages("s1", { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: {
        id: "p1",
        sessionID: "s1",
        messageID: "m2",
        type: "text",
        text: "hello world",
        time: { start: 1 },
      },
      delta: { type: "text-delta", textDelta: " world" },
    })
    pending.resolve(
      mkResult([
        mkMessage("m1", "user", 1),
        mkMessage("m2", "assistant", 2, [
          { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello", time: { start: 1 } },
        ]),
      ]),
    )
    await load

    // Deterministic rule C: the part exists in the snapshot, so the delta is
    // dropped even though its receipt is post-boundary. It converges on the
    // backend's subsequent durable full message.part.updated.1.
    const t = types(sent)
    expect(t.indexOf("messagesLoaded")).toBeGreaterThanOrEqual(0)
    expect(updates(sent)).toEqual([])
    internal.streams.dispose?.()
  })

  it("(b2) emits a new-tail delta absent from the snapshot after messagesLoaded", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending })
    const { internal, sent } = makeProvider(client)

    const load = internal.handleLoadMessages("s1", { mode: "replace" })
    // Chunk-only delta shape for a part the snapshot does not contain.
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { id: "p2", sessionID: "s1", messageID: "m2", type: "text", text: "tail", time: { start: 1 } },
      delta: { type: "text-delta", textDelta: "tail" },
    })
    pending.resolve(
      mkResult([
        mkMessage("m2", "assistant", 2, [
          { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello", time: { start: 1 } },
        ]),
      ]),
    )
    await load

    const t = types(sent)
    expect(t.indexOf("messagesLoaded")).toBeGreaterThanOrEqual(0)
    expect(t.findIndex((type) => type === "partUpdated" || type === "partsUpdated")).toBeGreaterThan(
      t.indexOf("messagesLoaded"),
    )
    const flat = updates(sent)
    expect(flat.some((u) => (u.part as { id?: string }).id === "p2")).toBe(true)
    internal.streams.dispose?.()
  })

  it("(b3) emits an authoritative full update for an existing snapshot part", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending })
    const { internal, sent } = makeProvider(client)

    const load = internal.handleLoadMessages("s1", { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: {
        id: "p1",
        sessionID: "s1",
        messageID: "m2",
        type: "text",
        text: "hello world",
        time: { start: 1 },
      },
    })
    pending.resolve(
      mkResult([
        mkMessage("m2", "assistant", 2, [
          { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello", time: { start: 1 } },
        ]),
      ]),
    )
    await load

    const t = types(sent)
    expect(t.findIndex((type) => type === "partUpdated" || type === "partsUpdated")).toBeGreaterThan(
      t.indexOf("messagesLoaded"),
    )
    const flat = updates(sent)
    const p1 = flat.find((u) => (u.part as { id?: string }).id === "p1")
    expect((p1?.part as { text?: string }).text).toBe("hello world")
    internal.streams.dispose?.()
  })

  it("(c) drops a post-boundary duplicate delta already contained in the snapshot", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending })
    const { internal, sent } = makeProvider(client)

    const load = internal.handleLoadMessages("s1", { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: {
        id: "p1",
        sessionID: "s1",
        messageID: "m2",
        type: "text",
        text: "hello world",
        time: { start: 1 },
      },
      delta: { type: "text-delta", textDelta: " world" },
    })
    // Snapshot already contains the queued update.
    pending.resolve(
      mkResult([
        mkMessage("m2", "assistant", 2, [
          { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello world", time: { start: 1 } },
        ]),
      ]),
    )
    await load

    // Deterministic rule C: the snapshot already contains the part, so the
    // queued delta is dropped without substring comparison. A true repeat
    // converges via the next durable full part update.
    expect(updates(sent)).toEqual([])
    internal.streams.dispose?.()
  })

  it("(d) stale delete posts nothing and emits no parts", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending })
    const { internal, sent } = makeProvider(client)
    internal.trackedSessionIds.add("s1")

    const load = internal.handleLoadMessages("s1", { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { id: "p9", sessionID: "s1", messageID: "m2", type: "text", text: "late" },
    })
    await internal.handleDeleteSession("s1")
    pending.resolve(mkResult([mkMessage("m1", "user", 10)]))
    await load

    expect(
      sent.filter((msg) => typeof msg === "object" && msg && (msg as { type?: string }).type === "messagesLoaded"),
    ).toEqual([])
    expect(updates(sent)).toEqual([])
    internal.streams.dispose?.()
  })

  it("(reconcile) preserves post-boundary parts with a since boundary", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending })
    const { internal, sent } = makeProvider(client)
    internal.trackedSessionIds.add("s1")

    const load = internal.handleLoadMessages("s1", { mode: "reconcile" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: {
        id: "p2",
        sessionID: "s1",
        messageID: "m2",
        type: "text",
        text: "tail",
        time: { start: Date.now() + 1000 },
      },
    })
    pending.resolve(mkResult([mkMessage("m1", "user", 1)]))
    await load

    const loaded = loadedMsg(sent)
    expect(loaded?.mode).toBe("reconcile")
    expect(typeof loaded?.since).toBe("number")
    const t = types(sent)
    expect(t.findIndex((type) => type === "partUpdated" || type === "partsUpdated")).toBeGreaterThan(
      t.indexOf("messagesLoaded"),
    )
    internal.streams.dispose?.()
  })

  it("(production chunk) drops a chunk-only delta for a part present in the snapshot", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending })
    const { internal, sent } = makeProvider(client)

    const load = internal.handleLoadMessages("s1", { mode: "replace" })
    // Production shape: part.text equals delta.textDelta (chunk-only, not full target).
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: " world", time: { start: 1 } },
      delta: { type: "text-delta", textDelta: " world" },
    })
    // Snapshot already contains the chunk plus a later suffix.
    pending.resolve(
      mkResult([
        mkMessage("m2", "assistant", 2, [
          { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello world!", time: { start: 1 } },
        ]),
      ]),
    )
    await load

    // Deterministic rule C: the part exists in the snapshot, so the
    // chunk-only delta is dropped without inspecting text overlap.
    expect(types(sent).indexOf("messagesLoaded")).toBeGreaterThanOrEqual(0)
    expect(updates(sent)).toEqual([])
    internal.streams.dispose?.()
  })

  it("(old-start tail) post-boundary tail with an old time.start still emits; receipts are the boundary", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending })
    const { internal, sent } = makeProvider(client)

    const load = internal.handleLoadMessages("s1", { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: {
        id: "p2",
        sessionID: "s1",
        messageID: "m2",
        type: "text",
        text: "late tail",
        time: { start: 1 },
      },
    })
    pending.resolve(mkResult([mkMessage("m1", "user", 1)]))
    await load

    const t = types(sent)
    expect(t.findIndex((type) => type === "partUpdated" || type === "partsUpdated")).toBeGreaterThan(
      t.indexOf("messagesLoaded"),
    )
    expect(updates(sent).some((u) => (u.part as { id?: string }).id === "p2")).toBe(true)
    internal.streams.dispose?.()
  })

  it("(preserveStream) replace with token replays only post-token entries", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending })
    const { internal, sent } = makeProvider(client)

    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m1",
      part: { id: "p-pre", sessionID: "s1", messageID: "m1", type: "text", text: "stale" },
    })
    const load = internal.handleLoadMessages("s1", { mode: "replace", preserveStream: true })
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m1",
      part: { id: "p-post", sessionID: "s1", messageID: "m1", type: "text", text: "fresh" },
    })
    pending.resolve(mkResult([mkMessage("m1", "user", 1)]))
    await load

    const loaded = loadedMsg(sent)
    expect(typeof loaded?.since).toBe("number")
    const snapshot = types(sent).indexOf("messagesLoaded")
    expect(snapshot).toBeGreaterThanOrEqual(0)
    const after = sent.slice(snapshot + 1)
    const ids = updates(after).map((u) => (u.part as { id?: string }).id)
    expect(ids).toEqual(["p-post"])
    internal.streams.dispose?.()
  })

  it("(child sync) delete while detail/messages pending posts nothing and allows retry", async () => {
    const getPending = defer<{ data: unknown }>()
    const msgPending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ getDeferred: getPending, messagesDeferred: msgPending })
    const { internal, sent, anyInternal } = makeProvider(client)

    const sync = anyInternal.handleSyncSession("ses_child", "s1")
    // Stream state queued while the fetch is in flight.
    internal.streams.push({
      type: "partUpdated",
      sessionID: "ses_child",
      messageID: "m1",
      part: { id: "p1", sessionID: "ses_child", messageID: "m1", type: "text", text: "live" },
    })
    // A delete racing the fetch wins: prune runs before the fetch settles.
    anyInternal.pruneDeletedSession("ses_child")
    getPending.resolve({ data: mkSession("ses_child") })
    msgPending.resolve(
      mkResult([
        {
          info: { id: "m1", sessionID: "ses_child", role: "assistant", time: { created: 2 } },
          parts: [{ id: "p1", sessionID: "ses_child", messageID: "m1", type: "text", text: "live" }],
        },
      ]),
    )
    await sync

    const childPosts = sent.filter(
      (msg) =>
        typeof msg === "object" &&
        msg &&
        (msg as { sessionID?: string }).sessionID === "ses_child" &&
        ["sessionUpdated", "messagesLoaded"].includes((msg as { type: string }).type),
    )
    expect(childPosts).toEqual([])
    expect(updates(sent).filter((u) => u.sessionID === "ses_child")).toEqual([])
    expect(anyInternal.syncedChildSessions.has("ses_child")).toBe(false)
    expect(anyInternal.trackedSessionIds.has("ses_child")).toBe(false)

    // A later legitimate retry can run and posts normally.
    const retry = anyInternal.handleSyncSession("ses_child", "s1")
    await retry
    const retried = sent.filter(
      (msg) =>
        typeof msg === "object" &&
        msg &&
        (msg as { sessionID?: string }).sessionID === "ses_child" &&
        (msg as { type: string }).type === "messagesLoaded",
    )
    expect(retried.length).toBeGreaterThan(0)
    internal.streams.dispose?.()
  })

  it("(delta→full race) queued delta superseded by full emits one authoritative full after messagesLoaded", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending })
    const { internal, sent } = makeProvider(client)

    const load = internal.handleLoadMessages("s1", { mode: "replace" })
    // Ambiguous delta arrives while the snapshot fetch is pending.
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: {
        id: "p1",
        sessionID: "s1",
        messageID: "m2",
        type: "text",
        text: "hello",
        time: { start: 1 },
      },
      delta: { type: "text-delta", textDelta: "hello" },
    })
    // Authoritative full for the same key arrives before messagesLoaded.
    // It must supersede the queued delta in place without flushing early.
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: {
        id: "p1",
        sessionID: "s1",
        messageID: "m2",
        type: "text",
        text: "hello world",
        time: { start: 1 },
      },
    })
    // No part update may leak before the snapshot posts.
    expect(types(sent).filter((t) => t === "partUpdated" || t === "partsUpdated")).toEqual([])
    pending.resolve(
      mkResult([
        mkMessage("m2", "assistant", 2, [
          { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello", time: { start: 1 } },
        ]),
      ]),
    )
    await load

    // Session-scoped view for s1. Part batches carry no top-level sessionID,
    // so attribute a partsUpdated batch to s1 when any contained update targets s1.
    // Unrelated provider diagnostics / non-session messages (no sessionID and no s1
    // update, e.g. workspaceDirectoryChanged) are filtered out here; every
    // session-scoped message for s1 is asserted below.
    const sessionMsgs = sent.filter((msg) => {
      if (typeof msg !== "object" || !msg) return false
      const m = msg as { type?: string; sessionID?: unknown; updates?: Array<{ sessionID?: unknown }> }
      if (m.sessionID === "s1") return true
      if (m.type === "partsUpdated" && Array.isArray(m.updates)) return m.updates.some((u) => u.sessionID === "s1")
      return false
    })
    const sessionTypes = sessionMsgs.map((msg) => (msg as { type: string }).type)
    // Exact relevant outgoing sequence for s1: one messagesLoaded followed
    // immediately by exactly one single part update. No other partUpdated /
    // partsUpdated between them or extra afterward, and no second messagesLoaded.
    expect(sessionTypes).toEqual(["messagesLoaded", "partUpdated"])
    const loaded = sessionMsgs[0] as { type: string; sessionID: string }
    expect(loaded.sessionID).toBe("s1")
    const emission = sessionMsgs[1] as PartUpdate
    expect(emission.sessionID).toBe("s1")
    expect(emission.messageID).toBe("m2")
    expect((emission.part as { id?: string }).id).toBe("p1")
    expect((emission.part as { text?: string }).text).toBe("hello world")
    expect(emission.delta).toBeUndefined()
    // Raw-order guard: no partUpdated/partsUpdated leaks before the snapshot and
    // nothing extra emits after the single authoritative full.
    const t = types(sent)
    const snapshot = t.indexOf("messagesLoaded")
    expect(snapshot).toBeGreaterThanOrEqual(0)
    expect(t.slice(0, snapshot).filter((type) => type === "partUpdated" || type === "partsUpdated")).toEqual([])
    const rawAfter = sent.slice(snapshot + 1)
    const flatAfter = updates(
      rawAfter.filter((msg) => {
        if (typeof msg !== "object" || !msg) return false
        const m = msg as { type?: string; sessionID?: unknown; updates?: Array<{ sessionID?: unknown }> }
        if (m.sessionID === "s1") return true
        if (m.type === "partsUpdated" && Array.isArray(m.updates)) return m.updates.some((u) => u.sessionID === "s1")
        return m.type === "partUpdated" || m.type === "partsUpdated"
      }),
    )
    expect(flatAfter).toHaveLength(1)
    expect(updates(sent).filter((u) => u.sessionID === "s1")).toHaveLength(1)
    internal.streams.dispose?.()
  })

  it("(flushed full) post-token full flushed before snapshot replays after messagesLoaded", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending })
    const { internal, sent } = makeProvider(client)
    const flushable = internal.streams as unknown as { flush: (sid: string) => void }

    const load = internal.handleLoadMessages("s1", { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello world" },
    })
    flushable.flush("s1")
    const preCount = updates(sent).filter((u) => u.sessionID === "s1").length
    expect(preCount).toBe(1)
    pending.resolve(
      mkResult([
        mkMessage("m2", "assistant", 2, [{ id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello" }]),
      ]),
    )
    await load
    const t = types(sent)
    const snapshot = t.indexOf("messagesLoaded")
    expect(snapshot).toBeGreaterThanOrEqual(0)
    const after = updates(sent.slice(snapshot + 1)).filter((u) => u.sessionID === "s1")
    expect(after).toHaveLength(1)
    expect((after[0]!.part as { text?: string }).text).toBe("hello world")
    internal.streams.dispose?.()
  })

  it("(flushed delta) post-token present-part delta flushed before snapshot is not replayed", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending })
    const { internal, sent } = makeProvider(client)
    const flushable = internal.streams as unknown as { flush: (sid: string) => void }

    const load = internal.handleLoadMessages("s1", { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: " world" },
      delta: { type: "text-delta", textDelta: " world" },
    })
    flushable.flush("s1")
    expect(updates(sent).filter((u) => u.sessionID === "s1")).toHaveLength(1)
    pending.resolve(
      mkResult([
        mkMessage("m2", "assistant", 2, [{ id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello" }]),
      ]),
    )
    await load
    const t = types(sent)
    const snapshot = t.indexOf("messagesLoaded")
    expect(snapshot).toBeGreaterThanOrEqual(0)
    expect(updates(sent.slice(snapshot + 1)).filter((u) => u.sessionID === "s1")).toEqual([])
    internal.streams.dispose?.()
  })

  it("(accumulate) early flush then same-key second delta replays only pending when absent", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending })
    const { internal, sent } = makeProvider(client)
    const flushable = internal.streams as unknown as { flush: (sid: string) => void }

    const load = internal.handleLoadMessages("s1", { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello" },
      delta: { type: "text-delta", textDelta: "hello" },
    })
    flushable.flush("s1")
    expect(updates(sent).filter((u) => u.sessionID === "s1")).toHaveLength(1)
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: " world" },
      delta: { type: "text-delta", textDelta: " world" },
    })
    pending.resolve(mkResult([mkMessage("m1", "user", 1)]))
    await load
    const t = types(sent)
    const snapshot = t.indexOf("messagesLoaded")
    expect(snapshot).toBeGreaterThanOrEqual(0)
    const after = updates(sent.slice(snapshot + 1)).filter((u) => u.sessionID === "s1")
    expect(after).toHaveLength(1)
    expect((after[0]!.part as { text?: string }).text).toBe(" world")
    expect(after[0]!.delta).toEqual({ type: "text-delta", textDelta: " world" })
    internal.streams.dispose?.()
  })

  it("(accumulate) early flush then same-key second delta drops when present (no duplication)", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending })
    const { internal, sent } = makeProvider(client)
    const flushable = internal.streams as unknown as { flush: (sid: string) => void }

    const load = internal.handleLoadMessages("s1", { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello" },
      delta: { type: "text-delta", textDelta: "hello" },
    })
    flushable.flush("s1")
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: " world" },
      delta: { type: "text-delta", textDelta: " world" },
    })
    pending.resolve(
      mkResult([
        mkMessage("m2", "assistant", 2, [{ id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello" }]),
      ]),
    )
    await load
    const t = types(sent)
    const snapshot = t.indexOf("messagesLoaded")
    expect(snapshot).toBeGreaterThanOrEqual(0)
    expect(updates(sent.slice(snapshot + 1)).filter((u) => u.sessionID === "s1")).toEqual([])
    expect(updates(sent.slice(0, snapshot)).filter((u) => u.sessionID === "s1")).toHaveLength(1)
    internal.streams.dispose?.()
  })

  it("(accumulate) early flush full then delta then real full replays authoritative full", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending })
    const { internal, sent } = makeProvider(client)
    const flushable = internal.streams as unknown as { flush: (sid: string) => void }

    const load = internal.handleLoadMessages("s1", { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello" },
    })
    flushable.flush("s1")
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: " world" },
      delta: { type: "text-delta", textDelta: " world" },
    })
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "done" },
    })
    pending.resolve(
      mkResult([
        mkMessage("m2", "assistant", 2, [{ id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello" }]),
      ]),
    )
    await load
    const t = types(sent)
    const snapshot = t.indexOf("messagesLoaded")
    expect(snapshot).toBeGreaterThanOrEqual(0)
    const after = updates(sent.slice(snapshot + 1)).filter((u) => u.sessionID === "s1")
    expect(after).toHaveLength(1)
    expect((after[0]!.part as { text?: string }).text).toBe("done")
    expect(after[0]!.delta).toBeUndefined()
    internal.streams.dispose?.()
  })

  it("(lineage) full-before-token plus delta-after-token drops when snapshot contains key", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending })
    const { internal, sent } = makeProvider(client)
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello" },
    })
    const load = internal.handleLoadMessages("s1", { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello world" },
      delta: { type: "text-delta", textDelta: " world" },
    })
    pending.resolve(
      mkResult([
        mkMessage("m2", "assistant", 2, [{ id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello" }]),
      ]),
    )
    await load
    const t = types(sent)
    expect(t.indexOf("messagesLoaded")).toBeGreaterThanOrEqual(0)
    expect(updates(sent.slice(t.indexOf("messagesLoaded") + 1)).filter((u) => u.sessionID === "s1")).toEqual([])
    internal.streams.dispose?.()
  })

  it("(stale) aborted replace discards its capture without replay", async () => {
    const first = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const second = defer<{ data: unknown[]; response: { headers: Headers } }>()
    let calls = 0
    const client = createClient({})
    client.session.messages = async () => {
      calls += 1
      if (calls === 1) return first.promise
      return second.promise
    }
    const { internal, sent } = makeProvider(client)
    const loadA = internal.handleLoadMessages("s1", { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { id: "pa", sessionID: "s1", messageID: "m2", type: "text", text: "stale" },
    })
    const loadB = internal.handleLoadMessages("s1", { mode: "replace" })
    first.resolve(mkResult([mkMessage("m1", "user", 1)]))
    second.resolve(mkResult([mkMessage("m1", "user", 1)]))
    await loadA
    await loadB
    const loads = sent.filter((m) => typeof m === "object" && m && (m as { type?: string }).type === "messagesLoaded")
    expect(loads).toHaveLength(1)
    // Capture flushes pre-token state: pa was queued before B's token, so it
    // was delivered live before B's snapshot and never replayed after it.
    const t = types(sent)
    const snapshot = t.indexOf("messagesLoaded")
    expect(snapshot).toBeGreaterThanOrEqual(0)
    const before = updates(sent.slice(0, snapshot)).filter((u) => (u.part as { id?: string }).id === "pa")
    expect(before).toHaveLength(1)
    expect(updates(sent.slice(snapshot + 1)).filter((u) => (u.part as { id?: string }).id === "pa")).toEqual([])
    internal.streams.dispose?.()
  })

  it("(latest-wins) overlapping same-session reconcile: old fetch posts nothing, delta emits once", async () => {
    const first = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const second = defer<{ data: unknown[]; response: { headers: Headers } }>()
    let calls = 0
    const client = createClient({})
    client.session.messages = async () => {
      calls += 1
      if (calls === 1) return first.promise
      return second.promise
    }
    const { internal, sent } = makeProvider(client)
    // Reconcile exercises the token-currency check without the replace abort
    // controller masking it; pre-track so the tracked guard passes.
    const tracked = (internal as unknown as { trackedSessionIds: Set<string> }).trackedSessionIds
    tracked.add("s1")
    const loadA = internal.handleLoadMessages("s1", { mode: "reconcile" })
    const loadB = internal.handleLoadMessages("s1", { mode: "reconcile" })
    // Post-token absent-part delta under the current (B) capture.
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m2",
      part: { id: "p-post", sessionID: "s1", messageID: "m2", type: "text", text: "fresh" },
      delta: { type: "text-delta", textDelta: "fresh" },
    })
    first.resolve(mkResult([mkMessage("m1", "user", 1)]))
    second.resolve(mkResult([mkMessage("m1", "user", 1)]))
    await loadA
    await loadB
    const loads = sent.filter((m) => typeof m === "object" && m && (m as { type?: string }).type === "messagesLoaded")
    // Old fetch posted no snapshot; winner posted once and replayed once.
    expect(loads).toHaveLength(1)
    expect(updates(sent).filter((u) => (u.part as { id?: string }).id === "p-post")).toHaveLength(1)
    internal.streams.dispose?.()
  })

  it("(sessions) overlapping reconciles for different sessions stay independent", async () => {
    const client = createClient({ messagesData: [mkMessage("m1", "user", 1)] })
    const { internal, sent } = makeProvider(client)
    const tracked = (internal as unknown as { trackedSessionIds: Set<string> }).trackedSessionIds
    tracked.add("s1")
    tracked.add("s2")
    const loadA = internal.handleLoadMessages("s1", { mode: "reconcile" })
    const loadB = internal.handleLoadMessages("s2", { mode: "reconcile" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s1",
      messageID: "m1",
      part: { id: "pa", sessionID: "s1", messageID: "m1", type: "text", text: "a" },
      delta: { type: "text-delta", textDelta: "a" },
    })
    internal.streams.push({
      type: "partUpdated",
      sessionID: "s2",
      messageID: "m1",
      part: { id: "pb", sessionID: "s2", messageID: "m1", type: "text", text: "b" },
      delta: { type: "text-delta", textDelta: "b" },
    })
    await loadA
    await loadB
    const loads = sent.filter((m) => typeof m === "object" && m && (m as { type?: string }).type === "messagesLoaded")
    expect(loads).toHaveLength(2)
    expect(updates(sent).filter((u) => (u.part as { id?: string }).id === "pa")).toHaveLength(1)
    expect(updates(sent).filter((u) => (u.part as { id?: string }).id === "pb")).toHaveLength(1)
    internal.streams.dispose?.()
  })

  it("(invalid) strict load with a superseded capture throws without posting a snapshot", async () => {
    const pending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ messagesDeferred: pending, getData: mkSession("ses_strict") })
    const { provider, internal, sent } = makeProvider(client)
    const strict = provider as unknown as { loadMessagesStrict: (sid: string) => Promise<boolean> }
    const load = strict.loadMessagesStrict("ses_strict")
    // Let the strict prelude + capture run until the fetch parks, then a newer
    // same-session capture supersedes the load's token mid-flight.
    await new Promise((r) => setTimeout(r, 5))
    ;(internal.streams as unknown as { capture: (sid: string) => number }).capture("ses_strict")
    pending.resolve(mkResult([mkMessage("m1", "user", 1)]))
    await expect(load).rejects.toThrow("expired before replay")
    expect(types(sent).filter((t) => t === "messagesLoaded")).toEqual([])
    internal.streams.dispose?.()
  })

  it("(child sync) A-delete-B-A-resolves: stale fetch posts nothing after retry re-tracks", async () => {
    const getPending = defer<{ data: unknown }>()
    const msgPending = defer<{ data: unknown[]; response: { headers: Headers } }>()
    const client = createClient({ getDeferred: getPending, messagesDeferred: msgPending })
    const { internal, sent, anyInternal } = makeProvider(client)

    const syncA = anyInternal.handleSyncSession("ses_child", "s1")
    internal.streams.push({
      type: "partUpdated",
      sessionID: "ses_child",
      messageID: "m1",
      part: { id: "p-old", sessionID: "ses_child", messageID: "m1", type: "text", text: "stale" },
      delta: { type: "text-delta", textDelta: "stale" },
    })
    // Delete racing the fetch wins: prune drops A's capture and queue.
    anyInternal.pruneDeletedSession("ses_child")
    // Retry re-tracks with a new token; A can never post after this.
    const syncB = anyInternal.handleSyncSession("ses_child", "s1")
    internal.streams.push({
      type: "partUpdated",
      sessionID: "ses_child",
      messageID: "m2",
      part: { id: "p-new", sessionID: "ses_child", messageID: "m2", type: "text", text: "live" },
      delta: { type: "text-delta", textDelta: "live" },
    })
    getPending.resolve({ data: mkSession("ses_child") })
    msgPending.resolve(
      mkResult([
        {
          info: { id: "m1", sessionID: "ses_child", role: "assistant", time: { created: 2 } },
          parts: [{ id: "p1", sessionID: "ses_child", messageID: "m1", type: "text", text: "snap" }],
        },
      ]),
    )
    await syncA
    await syncB

    const childLoads = sent.filter(
      (msg) =>
        typeof msg === "object" &&
        msg &&
        (msg as { sessionID?: string }).sessionID === "ses_child" &&
        (msg as { type: string }).type === "messagesLoaded",
    )
    // Exactly one snapshot (B); A posted nothing after B re-tracked.
    expect(childLoads).toHaveLength(1)
    const childUpdates = updates(sent).filter((u) => u.sessionID === "ses_child")
    expect(childUpdates.filter((u) => (u.part as { id?: string }).id === "p-new")).toHaveLength(1)
    expect(childUpdates.filter((u) => (u.part as { id?: string }).id === "p-old")).toEqual([])
    expect(anyInternal.syncedChildSessions.has("ses_child")).toBe(true)
    expect(anyInternal.trackedSessionIds.has("ses_child")).toBe(true)
    internal.streams.dispose?.()
  })
})
