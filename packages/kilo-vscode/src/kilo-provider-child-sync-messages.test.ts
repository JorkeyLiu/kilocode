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

  it("messagesLoaded then drain ordering remains", async () => {
    const h = makeHarness({})
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["syncedChildSessions"] as unknown) = new Set<string>()
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    const order: string[] = []
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => {
      posts.push(m)
      if ((m as Record<string, unknown>).type === "messagesLoaded") order.push("messagesLoaded")
    }
    const streams = anyP["streams"] as { drainSince: (...a: unknown[]) => unknown }
    const orig = streams.drainSince.bind(streams)
    streams.drainSince = ((...a: unknown[]) => {
      order.push("drain")
      return orig(...a)
    }) as typeof streams.drainSince
    await sync(h)
    expect(order).toEqual(["messagesLoaded", "drain"])
    const loaded = posts.find((p) => (p as Record<string, unknown>).type === "messagesLoaded") as Record<
      string,
      unknown
    >
    expect(loaded?.mode).toBe("replace")
    expect(loaded?.hasMore).toBeFalse()
  })
})
