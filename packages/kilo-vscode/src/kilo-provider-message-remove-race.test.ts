import { describe, it, expect } from "bun:test"
import { KiloProvider } from "./KiloProvider"
import type { KiloConnectionService } from "./services/cli-backend/connection-service"

function msg(id: string, time: number, sid: string, text = "hi") {
  return {
    info: {
      id,
      sessionID: sid,
      role: "user",
      time: { created: time },
      agent: "a",
      model: { providerID: "p", modelID: "m" },
    },
    parts: [{ id: `prt_${id}`, sessionID: sid, messageID: id, type: "text", text }],
  }
}

function found(sid: string, items: unknown[]) {
  return { v: "1.0", status: "found", messages: items }
}

function makeHarness(
  opts: {
    sid?: string
    dir?: string
    privateMessages?: (input: { directory: string; sessionId: string; limit: number; cursor?: string }) => Promise<unknown>
  } = {},
) {
  const sid = opts.sid ?? "ses_race1"
  const dir = opts.dir ?? "/tmp/ws"
  const privateCalls: unknown[] = []
  const sdkCalls: unknown[] = []
  const client = {
    session: {
      get: async () => ({ data: null, error: undefined, response: { status: 200, headers: { get: () => null } } }),
      messages: async (p: unknown) => {
        sdkCalls.push(p)
        return { data: [], error: undefined, response: { status: 200, headers: { get: () => null } } }
      },
      status: async () => ({ data: {}, response: { status: 200 } }),
      create: async () => ({ data: null, error: undefined, response: { status: 200 } }),
      delete: async () => ({ error: undefined }),
      revert: async () => ({ data: null, error: undefined }),
      unrevert: async () => ({ data: null, error: undefined }),
    },
    backgroundProcess: { stopSession: async () => {} },
    instance: { reload: async () => {} },
  } as unknown as import("@kilocode/sdk/v2/client").KiloClient
  const reader: Record<string, unknown> = {
    isEnabled: () => true,
    isStarted: () => true,
    list: async () => ({ v: "1.0", entries: [] }),
    get: async () => ({ v: "1.0", status: "not_found" }),
    messages: async (input: { directory: string; sessionId: string; limit: number; cursor?: string }) => {
      privateCalls.push(input)
      if (opts.privateMessages) return opts.privateMessages(input)
      return found(input.sessionId, [msg("msg_keep", 100, input.sessionId)])
    },
  }
  const connection = {
    isPrivateAvailable: () => true,
    getPrivateEpoch: () => 1,
    privateMessagesOutcomeWithHandle: () => ({
      id: 1,
      promise: Promise.resolve({ kind: "valid", result: { v: 1 } }),
    }),
    privateMessagesWithHandle: () => ({ id: 1, promise: Promise.resolve({ v: 1 }) }),
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
  return { provider, sid, dir, privateCalls, sdkCalls }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

type Post = Record<string, unknown>

describe("message/part remove vs in-flight snapshot race", () => {
  it("messageRemoved voids stale snapshot, retries once, posts remove before fresh load without resurrection", async () => {
    const gate = deferred<unknown>()
    let calls = 0
    const h = makeHarness({
      privateMessages: async (input) => {
        calls += 1
        if (calls === 1) return gate.promise
        return found(input.sessionId, [msg("msg_keep", 100, input.sessionId)])
      },
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>([h.sid])
    ;(anyP["lastReconciledAt"] as unknown) = new Map<string, number>()
    const posts: Post[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m as Post)
    const api = h.provider as unknown as {
      doLoadMessages: (id: string, opts: unknown, strict: boolean) => Promise<boolean>
      handleEvent: (e: unknown) => void
    }
    const load = api.doLoadMessages(h.sid, { mode: "replace" }, false)
    await tick()
    const streams = anyP["streams"] as {
      push: (m: { type: string; sessionID: string; messageID: string; part: unknown }) => void
    }
    streams.push({
      type: "partUpdated",
      sessionID: h.sid,
      messageID: "msg_keep",
      part: { id: "prt_msg_keep", messageID: "msg_keep", type: "text", text: "old" },
    })
    api.handleEvent({ id: "e1", type: "message.removed", properties: { sessionID: h.sid, messageID: "msg_gone" } })
    gate.resolve(found(h.sid, [msg("msg_keep", 100, h.sid), msg("msg_gone", 200, h.sid)]))
    const ok = await load
    expect(ok).toBeTrue()
    expect(calls).toBe(2)
    const types = posts.map((p) => String(p.type))
    expect(types).toContain("messageRemoved")
    const loaded = posts.filter((p) => p.type === "messagesLoaded")
    expect(loaded).toHaveLength(1)
    const fresh = loaded[0]!["messages"] as Array<{ id: string }>
    expect(fresh.map((m) => m.id)).toEqual(["msg_keep"])
    expect(types.indexOf("messageRemoved")).toBeLessThan(types.indexOf("messagesLoaded"))
    const stale = posts.filter(
      (p) => p.type === "messagesLoaded" && (p["messages"] as Array<{ id: string }>).some((m) => m.id === "msg_gone"),
    )
    expect(stale).toHaveLength(0)
  })

  it("partRemoved voids stale snapshot, retries once, posts remove before fresh load", async () => {
    const gate = deferred<unknown>()
    let calls = 0
    const h = makeHarness({
      privateMessages: async (input) => {
        calls += 1
        if (calls === 1) return gate.promise
        return found(input.sessionId, [msg("msg_1", 100, input.sessionId, "kept")])
      },
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>([h.sid])
    ;(anyP["lastReconciledAt"] as unknown) = new Map<string, number>()
    const posts: Post[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m as Post)
    const api = h.provider as unknown as {
      doLoadMessages: (id: string, opts: unknown, strict: boolean) => Promise<boolean>
      handleEvent: (e: unknown) => void
    }
    const load = api.doLoadMessages(h.sid, { mode: "replace" }, false)
    await tick()
    api.handleEvent({
      id: "e2",
      type: "message.part.removed",
      properties: { sessionID: h.sid, messageID: "msg_1", partID: "prt_msg_1" },
    })
    gate.resolve(found(h.sid, [msg("msg_1", 100, h.sid, "stale")]))
    const ok = await load
    expect(ok).toBeTrue()
    expect(calls).toBe(2)
    const types = posts.map((p) => String(p.type))
    expect(types).toContain("partRemoved")
    expect(types).toContain("messagesLoaded")
    expect(types.indexOf("partRemoved")).toBeLessThan(types.indexOf("messagesLoaded"))
    expect(posts.filter((p) => p.type === "messagesLoaded")).toHaveLength(1)
  })

  it("superseded replace stays silent without retry", async () => {
    const gate = deferred<unknown>()
    let calls = 0
    const h = makeHarness({
      privateMessages: async (input) => {
        calls += 1
        if (calls === 1) return gate.promise
        return found(input.sessionId, [msg("msg_1", 100, input.sessionId)])
      },
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>([h.sid])
    ;(anyP["lastReconciledAt"] as unknown) = new Map<string, number>()
    const posts: Post[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m as Post)
    const api = h.provider as unknown as {
      doLoadMessages: (id: string, opts: unknown, strict: boolean) => Promise<boolean>
    }
    const load = api.doLoadMessages(h.sid, { mode: "replace" }, false)
    await tick()
    const streams = anyP["streams"] as { capture: (s: string) => number }
    streams.capture(h.sid)
    gate.resolve(found(h.sid, [msg("msg_1", 100, h.sid)]))
    const ok = await load
    expect(ok).toBeFalse()
    expect(calls).toBe(1)
    expect(posts.some((p) => p.type === "messagesLoaded")).toBeFalse()
  })

  it("double latest invalidation throws once with bounded fetches; handleLoadMessages posts error", async () => {
    const h = makeHarness({
      privateMessages: async (input) => {
        const anyP = h.provider as unknown as Record<string, unknown>
        const streams = anyP["streams"] as { retire: (s: string) => void }
        streams.retire(input.sessionId)
        return found(input.sessionId, [msg("msg_1", 100, input.sessionId)])
      },
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>([h.sid])
    ;(anyP["lastReconciledAt"] as unknown) = new Map<string, number>()
    const posts: Post[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m as Post)
    const api = h.provider as unknown as {
      doLoadMessages: (id: string, opts: unknown, strict: boolean) => Promise<boolean>
      handleLoadMessages: (id: string, opts: unknown) => Promise<void>
    }
    let threw: unknown = null
    try {
      await api.doLoadMessages(h.sid, { mode: "replace" }, false)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeDefined()
    expect(String((threw as Error).message)).toContain("snapshot expired")
    expect(h.privateCalls).toHaveLength(2)
    expect(posts.some((p) => p.type === "messagesLoaded")).toBeFalse()
    await api.handleLoadMessages(h.sid, { mode: "replace" })
    expect(h.privateCalls).toHaveLength(4)
    expect(posts.some((p) => p.type === "error")).toBeTrue()
    expect(posts.filter((p) => p.type === "messagesLoaded")).toHaveLength(0)
  })

  it("reconcile invalidation stays fail-soft without lastReconciledAt so focus refetches", async () => {
    let voidNext = true
    const h = makeHarness({
      privateMessages: async (input) => {
        if (voidNext) {
          const anyP = h.provider as unknown as Record<string, unknown>
          const streams = anyP["streams"] as { retire: (s: string) => void }
          streams.retire(input.sessionId)
        }
        return found(input.sessionId, [msg("msg_1", 100, input.sessionId)])
      },
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>([h.sid])
    const stamp = new Map<string, number>()
    ;(anyP["lastReconciledAt"] as unknown) = stamp
    const posts: Post[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m as Post)
    const api = h.provider as unknown as {
      doLoadMessages: (id: string, opts: unknown, strict: boolean) => Promise<boolean>
    }
    const first = await api.doLoadMessages(h.sid, { mode: "reconcile" }, false)
    expect(first).toBeFalse()
    expect(stamp.has(h.sid)).toBeFalse()
    expect(h.privateCalls).toHaveLength(1)
    expect(posts.some((p) => p.type === "messagesLoaded")).toBeFalse()
    voidNext = false
    const second = await api.doLoadMessages(h.sid, { mode: "reconcile" }, false)
    expect(second).toBeTrue()
    expect(stamp.has(h.sid)).toBeTrue()
    expect(h.privateCalls).toHaveLength(2)
    expect(posts.filter((p) => p.type === "messagesLoaded")).toHaveLength(1)
  })
})
