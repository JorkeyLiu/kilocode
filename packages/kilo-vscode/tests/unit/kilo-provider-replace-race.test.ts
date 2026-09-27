import { describe, it, expect } from "bun:test"
import type { PartUpdate } from "../../src/shared/stream-messages"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider } = await import("../../src/KiloProvider")

type State = "connecting" | "connected" | "disconnected" | "error"

const DIR = "/tmp/ws"
const SES1 = "ses_1"
const SES2 = "ses_2"
const CHILD = "ses_child"
const STRICT = "ses_strict"

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

function textPart(id: string, sid: string, mid: string, text: string, time?: unknown) {
  const part: Record<string, unknown> = { id, sessionID: sid, messageID: mid, type: "text", text }
  if (time !== undefined) part.time = time
  return part
}

function userMessage(sid: string, id: string, time: number, parts: unknown[] = []) {
  return {
    info: { id, sessionID: sid, role: "user", time: { created: time }, agent: "a", model: { providerID: "p", modelID: "m" } },
    parts,
  }
}

function assistantMessage(sid: string, id: string, time: number, parts: unknown[] = [], parent = "msg_0") {
  return {
    info: {
      id,
      sessionID: sid,
      role: "assistant",
      time: { created: time },
      parentID: parent,
      modelID: "m",
      providerID: "p",
      mode: "default",
      agent: "a",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  }
}

function privateMessagesFound(sid: string, items: unknown[]) {
  return { v: "1.0", status: "found", messages: items }
}

function privateGetFound(sid: string, dir: string) {
  return {
    v: "1.0",
    status: "found",
    session: {
      id: sid,
      title: "child",
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

type PrivateReaderOptions = {
  messagesDeferred?: Deferred<unknown>
  messagesData?: unknown[]
  messagesFn?: (input: { directory: string; sessionId: string; limit: number; cursor?: string; signal?: AbortSignal }) => Promise<unknown>
  getDeferred?: Deferred<unknown>
  getData?: unknown
  getFn?: (input: { directory: string; sessionId: string; signal?: AbortSignal }) => Promise<unknown>
}

function createPrivateReader(sid: string, options?: PrivateReaderOptions) {
  return {
    isEnabled: () => true,
    isStarted: () => true,
    list: async () => ({ v: "1.0", entries: [], nextCursor: undefined }),
    get: async (input: { directory: string; sessionId: string; signal?: AbortSignal }) => {
      if (options?.getFn) return options.getFn(input)
      if (options?.getDeferred) return options.getDeferred.promise
      if (options?.getData !== undefined) return options.getData
      return privateGetFound(input.sessionId, input.directory)
    },
    messages: async (input: { directory: string; sessionId: string; limit: number; cursor?: string; signal?: AbortSignal }) => {
      if (options?.messagesFn) return options.messagesFn(input)
      if (options?.messagesDeferred) return options.messagesDeferred.promise
      if (options?.messagesData !== undefined) return privateMessagesFound(input.sessionId, options.messagesData)
      return privateMessagesFound(input.sessionId, [])
    },
    __sid: sid,
  }
}

function createClient() {
  return {
    session: {
      list: async () => ({ data: [] }),
      create: async () => ({ data: { id: "created", title: "Created", time: { created: 0, updated: 0 } } }),
      get: async () => {
        throw new Error("SDK session.get must not be used (private-authority)")
      },
      status: async () => ({ data: {} }),
      revert: async () => ({ data: {} }),
      promptAsync: async () => ({ data: undefined }),
      abort: async () => ({ data: true }),
      messages: async (): Promise<never> => {
        throw new Error("SDK session.messages must not be used (private-authority)")
      },
      delete: async () => ({ data: true }),
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
    isPrivateAvailable: () => true,
    privateDeleteWithHandle: (req: { requestId: unknown; opId: unknown; idempotencyKey: unknown }) => ({
      id: 1,
      promise: Promise.resolve({
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/delete",
        idempotencyKey: req.idempotencyKey,
        status: "succeeded",
        accepted: true,
        outcome: { type: "succeeded", time: 1 },
        data: {},
      }),
    }),
  }
}

function makeProvider(client: ReturnType<typeof createClient>, reader: ReturnType<typeof createPrivateReader>) {
  const connection = createConnection(client)
  const provider = new KiloProvider({} as never, connection as never, undefined, {
    projectDirectory: DIR,
    privateSessionReader: reader as never,
  } as never)
  Object.defineProperty(provider, "getWorkspaceDirectory", { value: () => DIR, configurable: true })
  Object.defineProperty(provider, "client", { get: () => client })
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
    const pending = defer<unknown>()
    const reader = createPrivateReader(SES1, { messagesDeferred: pending })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)

    const load = internal.handleLoadMessages(SES1, { mode: "replace" })
    // Queued after fetch starts (since already captured synchronously).
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: {
        id: "prt_p2",
        sessionID: SES1,
        messageID: "msg_2",
        type: "text",
        text: "final summary",
        time: { start: Date.now() + 1000 },
      },
    })
    pending.resolve(
      privateMessagesFound(SES1, [
        userMessage(SES1, "msg_1", 1),
        assistantMessage(SES1, "msg_2", 2, [textPart("prt_p1", SES1, "msg_2", "tool done", { start: 1, end: 2 })], "msg_1"),
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
    expect(flat.some((u) => (u.part as { id?: string }).id === "prt_p2")).toBe(true)
    internal.streams.dispose?.()
  })

  it("(b) drops a delta to an existing snapshot part as ambiguous without text inspection", async () => {
    const pending = defer<unknown>()
    const reader = createPrivateReader(SES1, { messagesDeferred: pending })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)

    const load = internal.handleLoadMessages(SES1, { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: {
        id: "prt_p1",
        sessionID: SES1,
        messageID: "msg_2",
        type: "text",
        text: "hello world",
        time: { start: 1 },
      },
      delta: { type: "text-delta", textDelta: " world" },
    })
    pending.resolve(
      privateMessagesFound(SES1, [
        userMessage(SES1, "msg_1", 1),
        assistantMessage(SES1, "msg_2", 2, [textPart("prt_p1", SES1, "msg_2", "hello", { start: 1 })], "msg_1"),
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
    const pending = defer<unknown>()
    const reader = createPrivateReader(SES1, { messagesDeferred: pending })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)

    const load = internal.handleLoadMessages(SES1, { mode: "replace" })
    // Chunk-only delta shape for a part the snapshot does not contain.
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: { id: "prt_p2", sessionID: SES1, messageID: "msg_2", type: "text", text: "tail", time: { start: 1 } },
      delta: { type: "text-delta", textDelta: "tail" },
    })
    pending.resolve(
      privateMessagesFound(SES1, [
        assistantMessage(SES1, "msg_2", 2, [textPart("prt_p1", SES1, "msg_2", "hello", { start: 1 })], "msg_1"),
      ]),
    )
    await load

    const t = types(sent)
    expect(t.indexOf("messagesLoaded")).toBeGreaterThanOrEqual(0)
    expect(t.findIndex((type) => type === "partUpdated" || type === "partsUpdated")).toBeGreaterThan(
      t.indexOf("messagesLoaded"),
    )
    const flat = updates(sent)
    expect(flat.some((u) => (u.part as { id?: string }).id === "prt_p2")).toBe(true)
    internal.streams.dispose?.()
  })

  it("(b3) emits an authoritative full update for an existing snapshot part", async () => {
    const pending = defer<unknown>()
    const reader = createPrivateReader(SES1, { messagesDeferred: pending })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)

    const load = internal.handleLoadMessages(SES1, { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: {
        id: "prt_p1",
        sessionID: SES1,
        messageID: "msg_2",
        type: "text",
        text: "hello world",
        time: { start: 1 },
      },
    })
    pending.resolve(
      privateMessagesFound(SES1, [
        assistantMessage(SES1, "msg_2", 2, [textPart("prt_p1", SES1, "msg_2", "hello", { start: 1 })], "msg_1"),
      ]),
    )
    await load

    const t = types(sent)
    expect(t.findIndex((type) => type === "partUpdated" || type === "partsUpdated")).toBeGreaterThan(
      t.indexOf("messagesLoaded"),
    )
    const flat = updates(sent)
    const p1 = flat.find((u) => (u.part as { id?: string }).id === "prt_p1")
    expect((p1?.part as { text?: string }).text).toBe("hello world")
    internal.streams.dispose?.()
  })

  it("(c) drops a post-boundary duplicate delta already contained in the snapshot", async () => {
    const pending = defer<unknown>()
    const reader = createPrivateReader(SES1, { messagesDeferred: pending })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)

    const load = internal.handleLoadMessages(SES1, { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: {
        id: "prt_p1",
        sessionID: SES1,
        messageID: "msg_2",
        type: "text",
        text: "hello world",
        time: { start: 1 },
      },
      delta: { type: "text-delta", textDelta: " world" },
    })
    // Snapshot already contains the queued update.
    pending.resolve(
      privateMessagesFound(SES1, [
        assistantMessage(SES1, "msg_2", 2, [textPart("prt_p1", SES1, "msg_2", "hello world", { start: 1 })], "msg_1"),
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
    const pending = defer<unknown>()
    const reader = createPrivateReader(SES1, { messagesDeferred: pending })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)
    internal.trackedSessionIds.add(SES1)

    const load = internal.handleLoadMessages(SES1, { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: { id: "prt_p9", sessionID: SES1, messageID: "msg_2", type: "text", text: "late" },
    })
    await internal.handleDeleteSession(SES1)
    pending.resolve(privateMessagesFound(SES1, [userMessage(SES1, "msg_1", 10)]))
    await load

    expect(
      sent.filter((msg) => typeof msg === "object" && msg && (msg as { type?: string }).type === "messagesLoaded"),
    ).toEqual([])
    expect(updates(sent)).toEqual([])
    internal.streams.dispose?.()
  })

  it("(reconcile) preserves post-boundary parts with a since boundary", async () => {
    const pending = defer<unknown>()
    const reader = createPrivateReader(SES1, { messagesDeferred: pending })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)
    internal.trackedSessionIds.add(SES1)

    const load = internal.handleLoadMessages(SES1, { mode: "reconcile" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: {
        id: "prt_p2",
        sessionID: SES1,
        messageID: "msg_2",
        type: "text",
        text: "tail",
        time: { start: Date.now() + 1000 },
      },
    })
    pending.resolve(privateMessagesFound(SES1, [userMessage(SES1, "msg_1", 1)]))
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
    const pending = defer<unknown>()
    const reader = createPrivateReader(SES1, { messagesDeferred: pending })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)

    const load = internal.handleLoadMessages(SES1, { mode: "replace" })
    // Production shape: part.text equals delta.textDelta (chunk-only, not full target).
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: { id: "prt_p1", sessionID: SES1, messageID: "msg_2", type: "text", text: " world", time: { start: 1 } },
      delta: { type: "text-delta", textDelta: " world" },
    })
    // Snapshot already contains the chunk plus a later suffix.
    pending.resolve(
      privateMessagesFound(SES1, [
        assistantMessage(SES1, "msg_2", 2, [textPart("prt_p1", SES1, "msg_2", "hello world!", { start: 1 })], "msg_1"),
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
    const pending = defer<unknown>()
    const reader = createPrivateReader(SES1, { messagesDeferred: pending })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)

    const load = internal.handleLoadMessages(SES1, { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: {
        id: "prt_p2",
        sessionID: SES1,
        messageID: "msg_2",
        type: "text",
        text: "late tail",
        time: { start: 1 },
      },
    })
    pending.resolve(privateMessagesFound(SES1, [userMessage(SES1, "msg_1", 1)]))
    await load

    const t = types(sent)
    expect(t.findIndex((type) => type === "partUpdated" || type === "partsUpdated")).toBeGreaterThan(
      t.indexOf("messagesLoaded"),
    )
    expect(updates(sent).some((u) => (u.part as { id?: string }).id === "prt_p2")).toBe(true)
    internal.streams.dispose?.()
  })

  it("(preserveStream) replace with token replays only post-token entries", async () => {
    const pending = defer<unknown>()
    const reader = createPrivateReader(SES1, { messagesDeferred: pending })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)

    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_1",
      part: { id: "prt_pre", sessionID: SES1, messageID: "msg_1", type: "text", text: "stale" },
    })
    const load = internal.handleLoadMessages(SES1, { mode: "replace", preserveStream: true })
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_1",
      part: { id: "prt_post", sessionID: SES1, messageID: "msg_1", type: "text", text: "fresh" },
    })
    pending.resolve(privateMessagesFound(SES1, [userMessage(SES1, "msg_1", 1)]))
    await load

    const loaded = loadedMsg(sent)
    expect(typeof loaded?.since).toBe("number")
    const snapshot = types(sent).indexOf("messagesLoaded")
    expect(snapshot).toBeGreaterThanOrEqual(0)
    const after = sent.slice(snapshot + 1)
    const ids = updates(after).map((u) => (u.part as { id?: string }).id)
    expect(ids).toEqual(["prt_post"])
    internal.streams.dispose?.()
  })

  it("(child sync) delete while detail/messages pending posts nothing and allows retry", async () => {
    const getPending = defer<unknown>()
    const msgPending = defer<unknown>()
    const reader = createPrivateReader(CHILD, { getDeferred: getPending, messagesDeferred: msgPending })
    const client = createClient()
    const { internal, sent, anyInternal } = makeProvider(client, reader)

    const sync = anyInternal.handleSyncSession(CHILD, SES1)
    // Stream state queued while the fetch is in flight.
    internal.streams.push({
      type: "partUpdated",
      sessionID: CHILD,
      messageID: "msg_1",
      part: { id: "prt_p1", sessionID: CHILD, messageID: "msg_1", type: "text", text: "live" },
    })
    // A delete racing the fetch wins: prune runs before the fetch settles.
    anyInternal.pruneDeletedSession(CHILD)
    getPending.resolve(privateGetFound(CHILD, DIR))
    msgPending.resolve(
      privateMessagesFound(CHILD, [
        assistantMessage(
          CHILD,
          "msg_1",
          2,
          [textPart("prt_p1", CHILD, "msg_1", "live")],
          "msg_0",
        ),
      ]),
    )
    await sync

    const childPosts = sent.filter(
      (msg) =>
        typeof msg === "object" &&
        msg &&
        (msg as { sessionID?: string }).sessionID === CHILD &&
        ["sessionUpdated", "messagesLoaded"].includes((msg as { type: string }).type),
    )
    expect(childPosts).toEqual([])
    expect(updates(sent).filter((u) => u.sessionID === CHILD)).toEqual([])
    expect(anyInternal.syncedChildSessions.has(CHILD)).toBe(false)
    expect(anyInternal.trackedSessionIds.has(CHILD)).toBe(false)

    // A later legitimate retry can run and posts normally.
    const retry = anyInternal.handleSyncSession(CHILD, SES1)
    await retry
    const retried = sent.filter(
      (msg) =>
        typeof msg === "object" &&
        msg &&
        (msg as { sessionID?: string }).sessionID === CHILD &&
        (msg as { type: string }).type === "messagesLoaded",
    )
    expect(retried.length).toBeGreaterThan(0)
    internal.streams.dispose?.()
  })

  it("(delta→full race) queued delta superseded by full emits one authoritative full after messagesLoaded", async () => {
    const pending = defer<unknown>()
    const reader = createPrivateReader(SES1, { messagesDeferred: pending })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)

    const load = internal.handleLoadMessages(SES1, { mode: "replace" })
    // Ambiguous delta arrives while the snapshot fetch is pending.
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: {
        id: "prt_p1",
        sessionID: SES1,
        messageID: "msg_2",
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
      sessionID: SES1,
      messageID: "msg_2",
      part: {
        id: "prt_p1",
        sessionID: SES1,
        messageID: "msg_2",
        type: "text",
        text: "hello world",
        time: { start: 1 },
      },
    })
    // No part update may leak before the snapshot posts.
    expect(types(sent).filter((t) => t === "partUpdated" || t === "partsUpdated")).toEqual([])
    pending.resolve(
      privateMessagesFound(SES1, [
        assistantMessage(SES1, "msg_2", 2, [textPart("prt_p1", SES1, "msg_2", "hello", { start: 1 })], "msg_1"),
      ]),
    )
    await load

    // Session-scoped view for ses_1. Part batches carry no top-level sessionID,
    // so attribute a partsUpdated batch to ses_1 when any contained update targets ses_1.
    // Unrelated provider diagnostics / non-session messages (no sessionID and no ses_1
    // update, e.g. workspaceDirectoryChanged) are filtered out here; every
    // session-scoped message for ses_1 is asserted below.
    const sessionMsgs = sent.filter((msg) => {
      if (typeof msg !== "object" || !msg) return false
      const m = msg as { type?: string; sessionID?: unknown; updates?: Array<{ sessionID?: unknown }> }
      if (m.sessionID === SES1) return true
      if (m.type === "partsUpdated" && Array.isArray(m.updates)) return m.updates.some((u) => u.sessionID === SES1)
      return false
    })
    const sessionTypes = sessionMsgs.map((msg) => (msg as { type: string }).type)
    // Exact relevant outgoing sequence for ses_1: one messagesLoaded followed
    // immediately by exactly one single part update. No other partUpdated /
    // partsUpdated between them or extra afterward, and no second messagesLoaded.
    expect(sessionTypes).toEqual(["messagesLoaded", "partUpdated"])
    const loaded = sessionMsgs[0] as { type: string; sessionID: string }
    expect(loaded.sessionID).toBe(SES1)
    const emission = sessionMsgs[1] as PartUpdate
    expect(emission.sessionID).toBe(SES1)
    expect(emission.messageID).toBe("msg_2")
    expect((emission.part as { id?: string }).id).toBe("prt_p1")
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
        if (m.sessionID === SES1) return true
        if (m.type === "partsUpdated" && Array.isArray(m.updates)) return m.updates.some((u) => u.sessionID === SES1)
        return m.type === "partUpdated" || m.type === "partsUpdated"
      }),
    )
    expect(flatAfter).toHaveLength(1)
    expect(updates(sent).filter((u) => u.sessionID === SES1)).toHaveLength(1)
    internal.streams.dispose?.()
  })

  it("(flushed full) post-token full flushed before snapshot replays after messagesLoaded", async () => {
    const pending = defer<unknown>()
    const reader = createPrivateReader(SES1, { messagesDeferred: pending })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)
    const flushable = internal.streams as unknown as { flush: (sid: string) => void }

    const load = internal.handleLoadMessages(SES1, { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: { id: "prt_p1", sessionID: SES1, messageID: "msg_2", type: "text", text: "hello world" },
    })
    flushable.flush(SES1)
    const preCount = updates(sent).filter((u) => u.sessionID === SES1).length
    expect(preCount).toBe(1)
    pending.resolve(
      privateMessagesFound(SES1, [
        assistantMessage(SES1, "msg_2", 2, [textPart("prt_p1", SES1, "msg_2", "hello")], "msg_1"),
      ]),
    )
    await load
    const t = types(sent)
    const snapshot = t.indexOf("messagesLoaded")
    expect(snapshot).toBeGreaterThanOrEqual(0)
    const after = updates(sent.slice(snapshot + 1)).filter((u) => u.sessionID === SES1)
    expect(after).toHaveLength(1)
    expect((after[0]!.part as { text?: string }).text).toBe("hello world")
    internal.streams.dispose?.()
  })

  it("(flushed delta) post-token present-part delta flushed before snapshot is not replayed", async () => {
    const pending = defer<unknown>()
    const reader = createPrivateReader(SES1, { messagesDeferred: pending })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)
    const flushable = internal.streams as unknown as { flush: (sid: string) => void }

    const load = internal.handleLoadMessages(SES1, { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: { id: "prt_p1", sessionID: SES1, messageID: "msg_2", type: "text", text: " world" },
      delta: { type: "text-delta", textDelta: " world" },
    })
    flushable.flush(SES1)
    expect(updates(sent).filter((u) => u.sessionID === SES1)).toHaveLength(1)
    pending.resolve(
      privateMessagesFound(SES1, [
        assistantMessage(SES1, "msg_2", 2, [textPart("prt_p1", SES1, "msg_2", "hello")], "msg_1"),
      ]),
    )
    await load
    const t = types(sent)
    const snapshot = t.indexOf("messagesLoaded")
    expect(snapshot).toBeGreaterThanOrEqual(0)
    expect(updates(sent.slice(snapshot + 1)).filter((u) => u.sessionID === SES1)).toEqual([])
    internal.streams.dispose?.()
  })

  it("(accumulate) early flush then same-key second delta replays only pending when absent", async () => {
    const pending = defer<unknown>()
    const reader = createPrivateReader(SES1, { messagesDeferred: pending })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)
    const flushable = internal.streams as unknown as { flush: (sid: string) => void }

    const load = internal.handleLoadMessages(SES1, { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: { id: "prt_p1", sessionID: SES1, messageID: "msg_2", type: "text", text: "hello" },
      delta: { type: "text-delta", textDelta: "hello" },
    })
    flushable.flush(SES1)
    expect(updates(sent).filter((u) => u.sessionID === SES1)).toHaveLength(1)
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: { id: "prt_p1", sessionID: SES1, messageID: "msg_2", type: "text", text: " world" },
      delta: { type: "text-delta", textDelta: " world" },
    })
    pending.resolve(privateMessagesFound(SES1, [userMessage(SES1, "msg_1", 1)]))
    await load
    const t = types(sent)
    const snapshot = t.indexOf("messagesLoaded")
    expect(snapshot).toBeGreaterThanOrEqual(0)
    const after = updates(sent.slice(snapshot + 1)).filter((u) => u.sessionID === SES1)
    expect(after).toHaveLength(1)
    expect((after[0]!.part as { text?: string }).text).toBe(" world")
    expect(after[0]!.delta).toEqual({ type: "text-delta", textDelta: " world" })
    internal.streams.dispose?.()
  })

  it("(accumulate) early flush then same-key second delta drops when present (no duplication)", async () => {
    const pending = defer<unknown>()
    const reader = createPrivateReader(SES1, { messagesDeferred: pending })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)
    const flushable = internal.streams as unknown as { flush: (sid: string) => void }

    const load = internal.handleLoadMessages(SES1, { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: { id: "prt_p1", sessionID: SES1, messageID: "msg_2", type: "text", text: "hello" },
      delta: { type: "text-delta", textDelta: "hello" },
    })
    flushable.flush(SES1)
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: { id: "prt_p1", sessionID: SES1, messageID: "msg_2", type: "text", text: " world" },
      delta: { type: "text-delta", textDelta: " world" },
    })
    pending.resolve(
      privateMessagesFound(SES1, [
        assistantMessage(SES1, "msg_2", 2, [textPart("prt_p1", SES1, "msg_2", "hello")], "msg_1"),
      ]),
    )
    await load
    const t = types(sent)
    const snapshot = t.indexOf("messagesLoaded")
    expect(snapshot).toBeGreaterThanOrEqual(0)
    expect(updates(sent.slice(snapshot + 1)).filter((u) => u.sessionID === SES1)).toEqual([])
    expect(updates(sent.slice(0, snapshot)).filter((u) => u.sessionID === SES1)).toHaveLength(1)
    internal.streams.dispose?.()
  })

  it("(accumulate) early flush full then delta then real full replays authoritative full", async () => {
    const pending = defer<unknown>()
    const reader = createPrivateReader(SES1, { messagesDeferred: pending })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)
    const flushable = internal.streams as unknown as { flush: (sid: string) => void }

    const load = internal.handleLoadMessages(SES1, { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: { id: "prt_p1", sessionID: SES1, messageID: "msg_2", type: "text", text: "hello" },
    })
    flushable.flush(SES1)
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: { id: "prt_p1", sessionID: SES1, messageID: "msg_2", type: "text", text: " world" },
      delta: { type: "text-delta", textDelta: " world" },
    })
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: { id: "prt_p1", sessionID: SES1, messageID: "msg_2", type: "text", text: "done" },
    })
    pending.resolve(
      privateMessagesFound(SES1, [
        assistantMessage(SES1, "msg_2", 2, [textPart("prt_p1", SES1, "msg_2", "hello")], "msg_1"),
      ]),
    )
    await load
    const t = types(sent)
    const snapshot = t.indexOf("messagesLoaded")
    expect(snapshot).toBeGreaterThanOrEqual(0)
    const after = updates(sent.slice(snapshot + 1)).filter((u) => u.sessionID === SES1)
    expect(after).toHaveLength(1)
    expect((after[0]!.part as { text?: string }).text).toBe("done")
    expect(after[0]!.delta).toBeUndefined()
    internal.streams.dispose?.()
  })

  it("(lineage) full-before-token plus delta-after-token drops when snapshot contains key", async () => {
    const pending = defer<unknown>()
    const reader = createPrivateReader(SES1, { messagesDeferred: pending })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: { id: "prt_p1", sessionID: SES1, messageID: "msg_2", type: "text", text: "hello" },
    })
    const load = internal.handleLoadMessages(SES1, { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: { id: "prt_p1", sessionID: SES1, messageID: "msg_2", type: "text", text: "hello world" },
      delta: { type: "text-delta", textDelta: " world" },
    })
    pending.resolve(
      privateMessagesFound(SES1, [
        assistantMessage(SES1, "msg_2", 2, [textPart("prt_p1", SES1, "msg_2", "hello")], "msg_1"),
      ]),
    )
    await load
    const t = types(sent)
    expect(t.indexOf("messagesLoaded")).toBeGreaterThanOrEqual(0)
    expect(updates(sent.slice(t.indexOf("messagesLoaded") + 1)).filter((u) => u.sessionID === SES1)).toEqual([])
    internal.streams.dispose?.()
  })

  it("(stale) aborted replace discards its capture without replay", async () => {
    const first = defer<unknown>()
    const second = defer<unknown>()
    let calls = 0
    const reader = createPrivateReader(SES1, {
      messagesFn: async () => {
        calls += 1
        if (calls === 1) return first.promise
        return second.promise
      },
    })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)
    const loadA = internal.handleLoadMessages(SES1, { mode: "replace" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: { id: "prt_pa", sessionID: SES1, messageID: "msg_2", type: "text", text: "stale" },
    })
    const loadB = internal.handleLoadMessages(SES1, { mode: "replace" })
    first.resolve(privateMessagesFound(SES1, [userMessage(SES1, "msg_1", 1)]))
    second.resolve(privateMessagesFound(SES1, [userMessage(SES1, "msg_1", 1)]))
    await loadA
    await loadB
    const loads = sent.filter((m) => typeof m === "object" && m && (m as { type?: string }).type === "messagesLoaded")
    expect(loads).toHaveLength(1)
    // Capture flushes pre-token state: prt_pa was queued before B's token, so it
    // was delivered live before B's snapshot and never replayed after it.
    const t = types(sent)
    const snapshot = t.indexOf("messagesLoaded")
    expect(snapshot).toBeGreaterThanOrEqual(0)
    const before = updates(sent.slice(0, snapshot)).filter((u) => (u.part as { id?: string }).id === "prt_pa")
    expect(before).toHaveLength(1)
    expect(updates(sent.slice(snapshot + 1)).filter((u) => (u.part as { id?: string }).id === "prt_pa")).toEqual([])
    internal.streams.dispose?.()
  })

  it("(latest-wins) overlapping same-session reconcile: old fetch posts nothing, delta emits once", async () => {
    const first = defer<unknown>()
    const second = defer<unknown>()
    let calls = 0
    const reader = createPrivateReader(SES1, {
      messagesFn: async () => {
        calls += 1
        if (calls === 1) return first.promise
        return second.promise
      },
    })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)
    // Reconcile exercises the token-currency check without the replace abort
    // controller masking it; pre-track so the tracked guard passes.
    const tracked = (internal as unknown as { trackedSessionIds: Set<string> }).trackedSessionIds
    tracked.add(SES1)
    const loadA = internal.handleLoadMessages(SES1, { mode: "reconcile" })
    const loadB = internal.handleLoadMessages(SES1, { mode: "reconcile" })
    // Post-token absent-part delta under the current (B) capture.
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_2",
      part: { id: "prt_post", sessionID: SES1, messageID: "msg_2", type: "text", text: "fresh" },
      delta: { type: "text-delta", textDelta: "fresh" },
    })
    first.resolve(privateMessagesFound(SES1, [userMessage(SES1, "msg_1", 1)]))
    second.resolve(privateMessagesFound(SES1, [userMessage(SES1, "msg_1", 1)]))
    await loadA
    await loadB
    const loads = sent.filter((m) => typeof m === "object" && m && (m as { type?: string }).type === "messagesLoaded")
    // Old fetch posted no snapshot; winner posted once and replayed once.
    expect(loads).toHaveLength(1)
    expect(updates(sent).filter((u) => (u.part as { id?: string }).id === "prt_post")).toHaveLength(1)
    internal.streams.dispose?.()
  })

  it("(sessions) overlapping reconciles for different sessions stay independent", async () => {
    const reader = createPrivateReader(SES1, {
      messagesFn: async (input) => privateMessagesFound(input.sessionId, [userMessage(input.sessionId, "msg_1", 1)]),
    })
    const client = createClient()
    const { internal, sent } = makeProvider(client, reader)
    const tracked = (internal as unknown as { trackedSessionIds: Set<string> }).trackedSessionIds
    tracked.add(SES1)
    tracked.add(SES2)
    const loadA = internal.handleLoadMessages(SES1, { mode: "reconcile" })
    const loadB = internal.handleLoadMessages(SES2, { mode: "reconcile" })
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES1,
      messageID: "msg_1",
      part: { id: "prt_pa", sessionID: SES1, messageID: "msg_1", type: "text", text: "a" },
      delta: { type: "text-delta", textDelta: "a" },
    })
    internal.streams.push({
      type: "partUpdated",
      sessionID: SES2,
      messageID: "msg_1",
      part: { id: "prt_pb", sessionID: SES2, messageID: "msg_1", type: "text", text: "b" },
      delta: { type: "text-delta", textDelta: "b" },
    })
    await loadA
    await loadB
    const loads = sent.filter((m) => typeof m === "object" && m && (m as { type?: string }).type === "messagesLoaded")
    expect(loads).toHaveLength(2)
    expect(updates(sent).filter((u) => (u.part as { id?: string }).id === "prt_pa")).toHaveLength(1)
    expect(updates(sent).filter((u) => (u.part as { id?: string }).id === "prt_pb")).toHaveLength(1)
    internal.streams.dispose?.()
  })

  it("(invalid) strict load with a superseded capture throws without posting a snapshot", async () => {
    const pending = defer<unknown>()
    const reader = createPrivateReader(STRICT, { messagesDeferred: pending })
    const client = createClient()
    const { provider, internal, sent } = makeProvider(client, reader)
    const strict = provider as unknown as { loadMessagesStrict: (sid: string) => Promise<boolean> }
    const load = strict.loadMessagesStrict(STRICT)
    // Let the strict prelude + capture run until the fetch parks, then a newer
    // same-session capture supersedes the load's token mid-flight.
    await new Promise((r) => setTimeout(r, 5))
    ;(internal.streams as unknown as { capture: (sid: string) => number }).capture(STRICT)
    pending.resolve(privateMessagesFound(STRICT, [userMessage(STRICT, "msg_1", 1)]))
    // Latest-wins: a superseded replace attempt stays silent (resolves false)
    // so a newer load wins without competition; no snapshot may post.
    const ok = await load
    expect(ok).toBe(false)
    expect(types(sent).filter((t) => t === "messagesLoaded")).toEqual([])
    internal.streams.dispose?.()
  })

  it("(child sync) A-delete-B-A-resolves: stale fetch posts nothing after retry re-tracks", async () => {
    const getPending = defer<unknown>()
    const msgPending = defer<unknown>()
    const reader = createPrivateReader(CHILD, { getDeferred: getPending, messagesDeferred: msgPending })
    const client = createClient()
    const { internal, sent, anyInternal } = makeProvider(client, reader)

    const syncA = anyInternal.handleSyncSession(CHILD, SES1)
    internal.streams.push({
      type: "partUpdated",
      sessionID: CHILD,
      messageID: "msg_1",
      part: { id: "prt_old", sessionID: CHILD, messageID: "msg_1", type: "text", text: "stale" },
      delta: { type: "text-delta", textDelta: "stale" },
    })
    // Delete racing the fetch wins: prune drops A's capture and queue.
    anyInternal.pruneDeletedSession(CHILD)
    // Retry re-tracks with a new token; A can never post after this.
    const syncB = anyInternal.handleSyncSession(CHILD, SES1)
    internal.streams.push({
      type: "partUpdated",
      sessionID: CHILD,
      messageID: "msg_2",
      part: { id: "prt_new", sessionID: CHILD, messageID: "msg_2", type: "text", text: "live" },
      delta: { type: "text-delta", textDelta: "live" },
    })
    getPending.resolve(privateGetFound(CHILD, DIR))
    msgPending.resolve(
      privateMessagesFound(CHILD, [
        assistantMessage(CHILD, "msg_1", 2, [textPart("prt_p1", CHILD, "msg_1", "snap")], "msg_0"),
      ]),
    )
    await syncA
    await syncB

    const childLoads = sent.filter(
      (msg) =>
        typeof msg === "object" &&
        msg &&
        (msg as { sessionID?: string }).sessionID === CHILD &&
        (msg as { type: string }).type === "messagesLoaded",
    )
    // Exactly one snapshot (B); A posted nothing after B re-tracked.
    expect(childLoads).toHaveLength(1)
    const childUpdates = updates(sent).filter((u) => u.sessionID === CHILD)
    expect(childUpdates.filter((u) => (u.part as { id?: string }).id === "prt_new")).toHaveLength(1)
    expect(childUpdates.filter((u) => (u.part as { id?: string }).id === "prt_old")).toEqual([])
    expect(anyInternal.syncedChildSessions.has(CHILD)).toBe(true)
    expect(anyInternal.trackedSessionIds.has(CHILD)).toBe(true)
    internal.streams.dispose?.()
  })
})
