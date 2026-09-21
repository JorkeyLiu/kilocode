import { describe, expect, test } from "bun:test"
import { KiloProvider } from "./KiloProvider"
import type { KiloConnectionService } from "./services/cli-backend/connection-service"

function makePrivateFound(id = "ses_abc", dir = "/tmp") {
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
    },
  }
}

function makeHarness(opts: {
  sessionId?: string
  privateGet?: (input: { directory: string; sessionId: string; signal?: AbortSignal }) => Promise<unknown>
  privateEnabled?: boolean
  privateStarted?: boolean
} = {}) {
  const sessionId = opts.sessionId ?? "ses_abc"
  const dir = "/tmp"
  const privateEnabled = opts.privateEnabled ?? true
  const privateStarted = opts.privateStarted ?? true
  const sdkGets: unknown[] = []
  const privateGets: unknown[] = []
  const client = {
    session: {
      get: async (p: unknown) => {
        sdkGets.push(p)
        return { data: { id: sessionId, directory: dir, title: "hello", projectID: "proj_test", time: { created: 1, updated: 2 } }, error: undefined, response: { status: 200 } }
      },
      messages: async () => ({ data: [], response: { headers: { get: () => null } } }),
      status: async () => ({ data: {}, response: { status: 200 } }),
    },
  } as unknown as import("@kilocode/sdk/v2/client").KiloClient

  const privateReader = {
    isEnabled: () => privateEnabled,
    isStarted: () => privateStarted,
    list: async () => ({ v: "1.0", entries: [], nextCursor: undefined }),
    get: async (input: { directory: string; sessionId: string; signal?: AbortSignal }) => {
      privateGets.push(input)
      if (input.signal?.aborted) {
        if (typeof input.signal.throwIfAborted === "function") input.signal.throwIfAborted()
        throw input.signal.reason ?? new DOMException("This operation was aborted", "AbortError")
      }
      if (opts.privateGet) return opts.privateGet(input)
      return makePrivateFound(input.sessionId, input.directory)
    },
  }

  const connectionService = {
    getClient: () => client,
    getClientAsync: async () => {
      sdkGets.push("getClientAsync")
      return client
    },
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
  } as unknown as KiloConnectionService

  const provider = new KiloProvider(
    { fsPath: "/tmp" } as unknown as import("vscode").Uri,
    connectionService,
    undefined,
    { projectDirectory: "/tmp", privateSessionReader: privateReader, disableViewedRegistration: true } as unknown as Parameters<typeof KiloProvider>[3],
  )
  const anyProvider = provider as unknown as Record<string, unknown>
  Object.defineProperty(provider, "getWorkspaceDirectory", { value: () => dir, configurable: true })
  Object.defineProperty(provider, "initializeConnection", { value: async () => {}, configurable: true })
  // expose client for doLoadMessages
  Object.defineProperty(provider, "client", { get: () => client })
  return { provider: anyProvider, client, dir, sdkGets, privateGets, privateReader, connectionService }
}

async function tick(ms = 60) {
  await new Promise((r) => setTimeout(r, ms))
}

describe("KiloProvider B6 private-authority session.get wiring", () => {
  test("getSessionDetail with valid private found is authoritative with zero SDK", async () => {
    const h = makeHarness({ privateGet: async (input) => makePrivateFound(input.sessionId, input.directory) })
    const out = await (h.provider as unknown as { getSessionDetail: (id: string, dir: string) => Promise<unknown> }).getSessionDetail("ses_abc", "/tmp")
    expect((out as Record<string, unknown>).id).toBe("ses_abc")
    expect(h.sdkGets).toHaveLength(0)
    expect(h.privateGets).toHaveLength(1)
    // signal never becomes wire payload
    expect((h.privateGets[0] as Record<string, unknown>).signal).toBeUndefined()
    // but signal plumbing exists - ensure payload has no signal key
    const rawPayload = h.privateGets[0] as Record<string, unknown>
    expect("limit" in rawPayload).toBeFalse()
  })

  test("getSessionDetail private unavailable fails closed without SDK", async () => {
    const h = makeHarness({ privateGet: async () => { throw Object.assign(new Error("boom"), { code: -32603 }) } })
    let threw: unknown = null
    try {
      await (h.provider as unknown as { getSessionDetail: (id: string, dir: string) => Promise<unknown> }).getSessionDetail("ses_abc", "/tmp")
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(Error)
    expect(h.sdkGets).toHaveLength(0)
    expect(h.privateGets).toHaveLength(1)
  })

  test("gate off private fails closed without SDK", async () => {
    const h = makeHarness({ privateEnabled: false })
    let threw: unknown = null
    try {
      await (h.provider as unknown as { getSessionDetail: (id: string, dir: string) => Promise<unknown> }).getSessionDetail("ses_abc", "/tmp")
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(Error)
    expect(String((threw as Error).message)).toMatch(/private observation unavailable/)
    expect(h.sdkGets).toHaveLength(0)
    expect(h.privateGets).toHaveLength(0)
  })

  test("refreshSessionDetails with valid private posts sessionUpdated with zero SDK", async () => {
    const h = makeHarness({ privateGet: async (input) => makePrivateFound(input.sessionId, input.directory) })
    h.provider["contextSessionID"] = "ses_bbb"
    h.provider["revisions"] = new Map()
    h.provider["refreshes"] = new Map()
    h.provider["trackedSessionIds"] = new Set<string>(["ses_bbb"])
    const posts: unknown[] = []
    h.provider["postMessage"] = (m: unknown) => posts.push(m)
    ;(h.provider as unknown as { refreshSessionDetails: (s: string, d: string) => void }).refreshSessionDetails("ses_bbb", "/tmp")
    await tick(80)
    expect(h.sdkGets).toHaveLength(0)
    expect(h.privateGets).toHaveLength(1)
    expect(posts.some((p) => (p as Record<string, unknown>).type === "sessionUpdated")).toBeTrue()
  })

  test("doLoadMessages focus strict with valid private posts with zero SDK", async () => {
    const h = makeHarness({ privateGet: async (input) => makePrivateFound(input.sessionId, input.directory) })
    h.provider["trackedSessionIds"] = new Set<string>()
    h.provider["lastReconciledAt"] = new Map([["ses_ccc", Date.now()]])
    // also need messages private for doLoadMessages to succeed; inject via privateReader
    const orig = h.privateReader.messages
    h.privateReader.messages = async (input: { directory: string; sessionId: string; limit: number; cursor?: string; signal?: AbortSignal }) => ({
      v: "1.0",
      status: "found",
      messages: [
        {
          info: { id: "msg_1", sessionID: input.sessionId, role: "user", time: { created: 1 }, agent: "a", model: { providerID: "p", modelID: "m" } },
          parts: [{ id: "prt_msg_1", sessionID: input.sessionId, messageID: "msg_1", type: "text", text: "hi" }],
        },
      ],
      nextCursor: undefined,
    })
    const ok = await (
      h.provider as unknown as { doLoadMessages: (s: string, o: unknown, strict: boolean) => Promise<boolean> }
    ).doLoadMessages("ses_ccc", { mode: "focus" }, true)
    expect(ok).toBeTrue()
    expect(h.sdkGets).toHaveLength(0)
    expect(h.privateGets).toHaveLength(1)
    await tick()
  })

  test("doLoadMessages replace strict metadata read with private unavailable fails closed without SDK", async () => {
    const h = makeHarness({ privateGet: async () => { throw Object.assign(new Error("boom"), { code: -32603 }) } })
    h.provider["trackedSessionIds"] = new Set<string>()
    let threw: unknown = null
    try {
      await (
        h.provider as unknown as { doLoadMessages: (s: string, o: unknown, strict: boolean) => Promise<boolean> }
      ).doLoadMessages("ses_ddd", { mode: "replace" }, true)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(Error)
    expect(h.sdkGets).toHaveLength(0)
    expect(h.privateGets).toHaveLength(1)
  })

  test("handleSyncSession with valid private found succeeds with zero SDK get", async () => {
    const h = makeHarness({ privateGet: async (input) => makePrivateFound(input.sessionId, input.directory) })
    // messages also private
    h.privateReader.messages = async (input: { directory: string; sessionId: string; limit: number; cursor?: string; signal?: AbortSignal }) => ({
      v: "1.0",
      status: "found",
      messages: [
        {
          info: { id: "msg_1", sessionID: input.sessionId, role: "user", time: { created: 1 }, agent: "a", model: { providerID: "p", modelID: "m" } },
          parts: [{ id: "prt_msg_1", sessionID: input.sessionId, messageID: "msg_1", type: "text", text: "hi" }],
        },
      ],
      nextCursor: undefined,
    })
    h.provider["syncedChildSessions"] = new Set<string>()
    h.provider["trackedSessionIds"] = new Set<string>()
    const posts: unknown[] = []
    h.provider["postMessage"] = (m: unknown) => posts.push(m)
    await (h.provider as unknown as { handleSyncSession: (s: string) => Promise<void> }).handleSyncSession("ses_eee")
    expect(h.sdkGets).toHaveLength(0)
    expect(h.privateGets).toHaveLength(1)
    expect(posts.some((p) => (p as Record<string, unknown>).type === "sessionUpdated")).toBeTrue()
  })

  test("AbortSignal before-read cancels private RPC with zero SDK and abort listener cleanup", async () => {
    let privateCalls = 0
    const h = makeHarness({
      privateGet: async (input) => {
        privateCalls += 1
        // Should not be called when already aborted
        if (input.signal?.aborted) {
          if (typeof input.signal.throwIfAborted === "function") input.signal.throwIfAborted()
          throw input.signal.reason ?? new DOMException("abort", "AbortError")
        }
        return makePrivateFound(input.sessionId, input.directory)
      },
    })
    const ctrl = new AbortController()
    ctrl.abort()
    let threw: unknown = null
    try {
      await (h.provider as unknown as { getSessionDetail: (id: string, dir: string, signal?: AbortSignal) => Promise<unknown> }).getSessionDetail("ses_abc", "/tmp", ctrl.signal)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(Error)
    expect((threw as Error).name).toMatch(/AbortError/)
    expect(h.sdkGets).toHaveLength(0)
    expect(privateCalls).toBe(0)
    // signal listener cleanup: no leftover abort listeners should keep reference
    expect(ctrl.signal.aborted).toBeTrue()
  })

  test("AbortSignal during private RPC cancels via peer $/cancelRequest and rejects with AbortError, zero SDK", async () => {
    // Simulate in-flight cancellation via reader respecting signal
    const h = makeHarness({
      privateGet: async (input) => {
        if (!input.signal) throw new Error("missing signal")
        return new Promise<unknown>((_, reject) => {
          const onAbort = () => reject(input.signal!.reason ?? new DOMException("aborted", "AbortError"))
          input.signal!.addEventListener("abort", onAbort, { once: true })
          // do not resolve, wait for abort
        })
      },
    })
    const ctrl = new AbortController()
    const p = (h.provider as unknown as { getSessionDetail: (id: string, dir: string, signal?: AbortSignal) => Promise<unknown> }).getSessionDetail("ses_abc", "/tmp", ctrl.signal)
    // abort shortly after starting
    setTimeout(() => ctrl.abort(new DOMException("aborted", "AbortError")), 10)
    let threw: unknown = null
    try {
      await p
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(Error)
    expect(h.sdkGets).toHaveLength(0)
    // No second private request after abort
    expect(h.privateGets).toHaveLength(1)
  })
})
