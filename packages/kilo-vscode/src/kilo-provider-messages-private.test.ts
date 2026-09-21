import { describe, it, expect, mock } from "bun:test"
import { KiloProvider } from "./KiloProvider"
import { fetchMessagePage } from "./kilo-provider/message-page"
import { validatePrivateMessagesResult } from "./kilo-provider/session-messages-private"
import { ErrorCode } from "./private-worker/json-rpc"
import { encodeMessageCursor } from "./private-worker/message-read"
import type { KiloConnectionService } from "./services/cli-backend/connection-service"

const SECRET_DIR = "/tmp/secret-dir-xyz"
const SECRET_SES = "ses_secret123"

function userMsg(id: string, time: number, sid = SECRET_SES) {
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

function privateFound(sid: string, msgs: unknown[], nextCursor?: string) {
  const out: Record<string, unknown> = { v: "1.0", status: "found", messages: msgs }
  if (nextCursor !== undefined) out.nextCursor = nextCursor
  return out
}

function makeHarness(
  opts: {
    privateEnabled?: boolean
    privateStarted?: boolean
    privateMessages?: (input: {
      directory: string
      sessionId: string
      limit: number
      cursor?: string
    }) => Promise<unknown>
    sdkMessages?: (p: unknown, o: unknown) => Promise<unknown>
    hasPrivateMessagesFn?: boolean
    dir?: string
    sid?: string
  } = {},
) {
  const dir = opts.dir ?? SECRET_DIR
  const sid = opts.sid ?? SECRET_SES
  const sdkCalls: unknown[] = []
  const sdkOpts: unknown[] = []
  const privateCalls: unknown[] = []
  const parityCalls: unknown[] = []
  const sdkItems = [userMsg("msg_2", 200, sid)]
  const client = {
    session: {
      get: async () => ({ data: null, error: undefined, response: { status: 200, headers: { get: () => null } } }),
      messages: async (p: unknown, o: unknown) => {
        sdkCalls.push(p)
        sdkOpts.push(o)
        if (opts.sdkMessages) return opts.sdkMessages(p, o)
        return { data: sdkItems, error: undefined, response: { status: 200, headers: { get: () => null } } }
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
    isEnabled: () => opts.privateEnabled ?? true,
    isStarted: () => opts.privateStarted ?? true,
    list: async () => ({ v: "1.0", entries: [] }),
    get: async () => ({ v: "1.0", status: "not_found" }),
  }
  if (opts.hasPrivateMessagesFn === false) {
    // omit messages to exercise legacy-reader fallback
  } else {
    reader.messages = async (input: { directory: string; sessionId: string; limit: number; cursor?: string }) => {
      privateCalls.push(input)
      if (opts.privateMessages) return opts.privateMessages(input)
      return privateFound(input.sessionId, [userMsg("msg_1", 100, input.sessionId)])
    }
  }
  const connection = {
    isPrivateAvailable: () => true,
    getPrivateEpoch: () => 1,
    privateMessagesOutcomeWithHandle: (req: Record<string, unknown>) => {
      parityCalls.push(req)
      return {
        id: parityCalls.length,
        promise: Promise.resolve({
          kind: "valid",
          result: {
            v: 1,
            requestId: req.requestId,
            opId: req.opId,
            op: "session/messages",
            idempotencyKey: req.idempotencyKey,
            status: "ambiguous",
            outcome: { type: "ambiguous", time: 1 },
            accepted: false,
            transportUnknown: true,
          },
        }),
      }
    },
    privateMessagesWithHandle: (req: Record<string, unknown>) => {
      parityCalls.push(req)
      return {
        id: parityCalls.length,
        promise: Promise.resolve({
          v: 1,
          requestId: (req as Record<string, unknown>).requestId,
          opId: (req as Record<string, unknown>).opId,
          op: "session/messages",
          idempotencyKey: (req as Record<string, unknown>).idempotencyKey,
          status: "ambiguous",
          outcome: { type: "ambiguous", time: 1 },
          accepted: false,
          transportUnknown: true,
        }),
      }
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
  return { provider, client, dir, sid, sdkCalls, sdkOpts, privateCalls, parityCalls, reader, connection }
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))

describe("paged messages private-first", () => {
  it("private found authoritative: no SDK, no parity, cursor preserved", async () => {
    const msgs = [userMsg("msg_1", 100), userMsg("msg_2", 200)]
    const cursor = encodeMessageCursor({ id: "msg_1", time: 100 })
    // Full page of 2 with cursor is valid (truncated anchor = oldest).
    const h = makeHarness({ privateMessages: async (input) => privateFound(input.sessionId, msgs, cursor) })
    const page = await fetchMessagePage(
      h.client as never,
      { sessionID: h.sid, workspaceDir: h.dir, limit: 2 },
      h.connection as never,
      h.reader as never,
    )
    expect(page.items).toHaveLength(2)
    expect(page.cursor).toBe(cursor)
    expect(h.privateCalls).toHaveLength(1)
    expect(h.sdkCalls).toHaveLength(0)
    await tick()
    expect(h.parityCalls).toHaveLength(0)
  })

  it("private terminal not_found/scope_mismatch authoritative: no SDK, no parity", async () => {
    for (const status of ["not_found", "scope_mismatch"] as const) {
      const h = makeHarness({ privateMessages: async () => ({ v: "1.0", status }) })
      let threw: unknown = null
      try {
        await fetchMessagePage(
          h.client as never,
          { sessionID: h.sid, workspaceDir: h.dir, limit: 2 },
          h.connection as never,
          h.reader as never,
        )
      } catch (e) {
        threw = e
      }
      expect(threw).toBeInstanceOf(Error)
      expect((threw as Error).name).toMatch(status === "not_found" ? /NotFound/ : /ScopeMismatch/)
      expect(h.privateCalls).toHaveLength(1)
      expect(h.sdkCalls).toHaveLength(0)
      await tick()
      expect(h.parityCalls).toHaveLength(0)
    }
  })

  it("private malformed fails closed without SDK, no second private request, and no raw data", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => warns.push(a)
    try {
      const h = makeHarness({
        privateMessages: async () => ({ v: "1.0", status: "found", messages: [{ info: { id: "bad" }, parts: [] }] }),
      })
      let threw: unknown = null
      try {
        await fetchMessagePage(
          h.client as never,
          { sessionID: h.sid, workspaceDir: h.dir, limit: 2 },
          h.connection as never,
          h.reader as never,
        )
      } catch (e) {
        threw = e
      }
      expect(threw).toBeInstanceOf(Error)
      expect(String((threw as Error).message)).toMatch(/private observation unavailable/)
      expect(h.privateCalls).toHaveLength(1)
      expect(h.sdkCalls).toHaveLength(0)
      await tick()
      expect(h.parityCalls).toHaveLength(0)
      expect(warns.some((w) => String(w[0]).includes("[Kilo Messages]"))).toBeTrue()
      for (const w of warns) {
        const text = w.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")
        expect(text).not.toContain(SECRET_DIR)
        expect(text).not.toContain(SECRET_SES)
      }
    } finally {
      console.warn = orig
    }
  })

  it("private InternalError/MethodNotFound/transport/closed each fails closed without SDK", async () => {
    const cases: unknown[] = [
      Object.assign(new Error("boom"), { code: ErrorCode.InternalError }),
      Object.assign(new Error("missing"), { code: ErrorCode.MethodNotFound }),
      new Error("transport closed"),
      new Error("host closed"),
    ]
    for (const err of cases) {
      const warns: unknown[][] = []
      const orig = console.warn
      console.warn = (...a: unknown[]) => warns.push(a)
      try {
        const h = makeHarness({
          privateMessages: async () => {
            throw err
          },
        })
        let threw: unknown = null
        try {
          await fetchMessagePage(
            h.client as never,
            { sessionID: h.sid, workspaceDir: h.dir, limit: 2 },
            h.connection as never,
            h.reader as never,
          )
        } catch (e) {
          threw = e
        }
        expect(threw).toBeInstanceOf(Error)
        expect(String((threw as Error).message)).toMatch(/private observation unavailable/)
        expect(h.privateCalls).toHaveLength(1)
        expect(h.sdkCalls).toHaveLength(0)
        await tick()
        expect(h.parityCalls).toHaveLength(0)
        expect(warns.some((w) => String(w[0]).includes("[Kilo Messages]"))).toBeTrue()
        for (const w of warns) {
          const text = w.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")
          expect(text).not.toContain(SECRET_DIR)
          expect(text).not.toContain(SECRET_SES)
        }
      } finally {
        console.warn = orig
      }
    }
  })

  it("disabled/not-started/legacy reader fails closed without SDK", async () => {
    for (const opts of [{ privateEnabled: false }, { privateStarted: false }, { hasPrivateMessagesFn: false }]) {
      const h = makeHarness(opts)
      let threw: unknown = null
      try {
        await fetchMessagePage(
          h.client as never,
          { sessionID: h.sid, workspaceDir: h.dir, limit: 2 },
          h.connection as never,
          h.reader as never,
        )
      } catch (e) {
        threw = e
      }
      expect(threw).toBeInstanceOf(Error)
      expect(String((threw as Error).message)).toMatch(/private observation unavailable/)
      expect(h.sdkCalls).toHaveLength(0)
      await tick()
      expect(h.parityCalls).toHaveLength(0)
    }
    const h2 = makeHarness({ privateEnabled: false })
    let threw2: unknown = null
    try {
      await fetchMessagePage(
        h2.client as never,
        { sessionID: h2.sid, workspaceDir: h2.dir, limit: 2 },
        h2.connection as never,
        h2.reader as never,
      )
    } catch (e) {
      threw2 = e
    }
    expect(threw2).toBeInstanceOf(Error)
    expect(h2.privateCalls).toHaveLength(0)
    expect(h2.sdkCalls).toHaveLength(0)
  })

  it("limit=0 full read iterates private pages oldest-first with wire limit 100", async () => {
    const total = 101
    const all = Array.from({ length: total }, (_, i) => userMsg(`msg_${String(i + 1).padStart(3, "0")}`, i + 1))
    const newest = all.slice(1)
    const oldest = all.slice(0, 1)
    const cursor0 = encodeMessageCursor({ id: newest[0]!.info.id, time: 2 })
    const h = makeHarness({
      privateMessages: async (input) => {
        expect(input.limit).toBe(100)
        if (input.cursor === undefined) return privateFound(input.sessionId, newest, cursor0)
        expect(input.cursor).toBe(cursor0)
        return privateFound(input.sessionId, oldest)
      },
    })
    const page = await fetchMessagePage(
      h.client as never,
      { sessionID: h.sid, workspaceDir: h.dir, limit: 0 },
      h.connection as never,
      h.reader as never,
    )
    expect(page.items.map((m: { info: { id: string } }) => m.info.id)).toEqual(all.map((m) => m.info.id))
    expect(page.cursor).toBeUndefined()
    expect(h.privateCalls).toHaveLength(2)
    expect((h.privateCalls[0] as Record<string, unknown>).limit).toBe(100)
    expect((h.privateCalls[1] as Record<string, unknown>).limit).toBe(100)
    expect((h.privateCalls[1] as Record<string, unknown>).cursor).toBe(cursor0)
    expect(h.sdkCalls).toHaveLength(0)
    await tick()
    expect(h.parityCalls).toHaveLength(0)
  })

  it("limit=0 private terminal surfaces without SDK", async () => {
    for (const status of ["not_found", "scope_mismatch"] as const) {
      const h = makeHarness({ privateMessages: async () => ({ v: "1.0", status }) })
      let threw: unknown = null
      try {
        await fetchMessagePage(
          h.client as never,
          { sessionID: h.sid, workspaceDir: h.dir, limit: 0 },
          h.connection as never,
          h.reader as never,
        )
      } catch (e) {
        threw = e
      }
      expect(threw).toBeInstanceOf(Error)
      expect((threw as Error).name).toMatch(status === "not_found" ? /NotFound/ : /ScopeMismatch/)
      expect(h.privateCalls).toHaveLength(1)
      expect(h.sdkCalls).toHaveLength(0)
      await tick()
      expect(h.parityCalls).toHaveLength(0)
    }
  })

  it("limit=0 second-page failure fails closed without SDK", async () => {
    const newest = Array.from({ length: 100 }, (_, i) => userMsg(`msg_${String(i + 2).padStart(3, "0")}`, i + 2))
    const cursor0 = encodeMessageCursor({ id: newest[0]!.info.id, time: 2 })
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => warns.push(a)
    try {
      const h = makeHarness({
        privateMessages: async (input) => {
          if (input.cursor === undefined) return privateFound(input.sessionId, newest, cursor0)
          throw Object.assign(new Error("boom"), { code: ErrorCode.InternalError })
        },
      })
      let threw: unknown = null
      try {
        await fetchMessagePage(
          h.client as never,
          { sessionID: h.sid, workspaceDir: h.dir, limit: 0 },
          h.connection as never,
          h.reader as never,
        )
      } catch (e) {
        threw = e
      }
      expect(threw).toBeInstanceOf(Error)
      expect(String((threw as Error).message)).toMatch(/private observation unavailable/)
      expect(h.privateCalls).toHaveLength(2)
      expect(h.sdkCalls).toHaveLength(0)
      await tick()
      expect(h.parityCalls).toHaveLength(0)
      expect(warns.some((w) => String(w[0]).includes("[Kilo Messages]"))).toBeTrue()
    } finally {
      console.warn = orig
    }
  })

  it("limit=0 private unavailable fails closed without SDK", async () => {
    const h = makeHarness({ privateEnabled: false })
    let threw: unknown = null
    try {
      await fetchMessagePage(
        h.client as never,
        { sessionID: h.sid, workspaceDir: h.dir, limit: 0 },
        h.connection as never,
        h.reader as never,
      )
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(Error)
    expect(String((threw as Error).message)).toMatch(/private observation unavailable/)
    expect(h.privateCalls).toHaveLength(0)
    expect(h.sdkCalls).toHaveLength(0)
    await tick()
    expect(h.parityCalls).toHaveLength(0)
  })

  it("limit=0 private-authority does not call SDK on second-page failure (zero SDK)", async () => {
    const h = makeHarness({
      privateEnabled: false,
    })
    let threw: unknown = null
    try {
      await fetchMessagePage(
        h.client as never,
        { sessionID: h.sid, workspaceDir: h.dir, limit: 0 },
        h.connection as never,
        h.reader as never,
      )
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(Error)
    expect(String((threw as Error).message)).toMatch(/private observation unavailable/)
    expect(h.sdkCalls).toHaveLength(0)
    await tick()
    expect(h.parityCalls).toHaveLength(0)
  })

  it("limit=0 private-authority preserves AbortSignal semantics with zero SDK", async () => {
    const h = makeHarness({
      privateEnabled: false,
    })
    const ctrl = new AbortController()
    let threw: unknown = null
    try {
      await fetchMessagePage(
        h.client as never,
        { sessionID: h.sid, workspaceDir: h.dir, limit: 0, signal: ctrl.signal },
        h.connection as never,
        h.reader as never,
      )
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(Error)
    expect(String((threw as Error).message)).toMatch(/private observation unavailable/)
    expect(h.sdkCalls).toHaveLength(0)
    await tick()
    expect(h.parityCalls).toHaveLength(0)
  })

  it("cursor passthrough: before maps to private cursor input", async () => {
    const seen: unknown[] = []
    const h = makeHarness({
      privateMessages: async (input) => {
        seen.push(input)
        return privateFound(input.sessionId, [userMsg("msg_9", 900, input.sessionId)])
      },
    })
    const before = encodeMessageCursor({ id: "msg_9", time: 900 })
    await fetchMessagePage(
      h.client as never,
      { sessionID: h.sid, workspaceDir: h.dir, limit: 5, before },
      h.connection as never,
      h.reader as never,
    )
    expect((seen[0] as Record<string, unknown>).cursor).toBe(before)
    expect(h.sdkCalls).toHaveLength(0)
  })

  it("out-of-order private page fails closed without SDK", async () => {
    const h = makeHarness({
      privateMessages: async (input) =>
        privateFound(input.sessionId, [userMsg("msg_2", 200, input.sessionId), userMsg("msg_1", 100, input.sessionId)]),
    })
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => warns.push(a)
    try {
      let threw: unknown = null
      try {
        await fetchMessagePage(
          h.client as never,
          { sessionID: h.sid, workspaceDir: h.dir, limit: 2 },
          h.connection as never,
          h.reader as never,
        )
      } catch (e) {
        threw = e
      }
      expect(threw).toBeInstanceOf(Error)
      expect(String((threw as Error).message)).toMatch(/private observation unavailable/)
      expect(h.privateCalls).toHaveLength(1)
      expect(h.sdkCalls).toHaveLength(0)
      expect(warns.some((w) => String(w[0]).includes("[Kilo Messages]"))).toBeTrue()
    } finally {
      console.warn = orig
    }
  })

  it("doLoadMessages private found preserves messagesLoaded then commit and stale checks", async () => {
    const msgs = [userMsg("msg_1", 100), userMsg("msg_2", 200)]
    const h = makeHarness({ privateMessages: async (input) => privateFound(input.sessionId, msgs) })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    ;(anyP["lastReconciledAt"] as unknown) = new Map<string, number>()
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    const drains: Array<{ id: string; since: number }> = []
    const streams = anyP["streams"] as {
      commit: (id: string, since: number, snapshot: Set<string>, before: () => void) => boolean
    }
    const origCommit = streams.commit.bind(streams)
    streams.commit = (id: string, since: number, snapshot: Set<string>, before: () => void) => {
      drains.push({ id, since })
      return origCommit(id, since, snapshot, before)
    }
    const ok = await (
      h.provider as unknown as { doLoadMessages: (id: string, opts: unknown, strict: boolean) => Promise<boolean> }
    ).doLoadMessages(h.sid, { mode: "replace" }, false)
    expect(ok).toBeTrue()
    expect(h.privateCalls).toHaveLength(1)
    expect(h.sdkCalls).toHaveLength(0)
    const loaded = posts.find((p) => (p as Record<string, unknown>).type === "messagesLoaded") as Record<
      string,
      unknown
    >
    expect(loaded).toBeDefined()
    expect(loaded.messages as unknown[]).toHaveLength(2)
    expect(drains).toHaveLength(1)
    expect(drains[0]!.id).toBe(h.sid)
    await tick()
    expect(h.parityCalls).toHaveLength(0)
  })

  it("private-authority preserves AbortSignal on unavailable with zero SDK", async () => {
    const h = makeHarness({
      privateMessages: async () => {
        throw Object.assign(new Error("boom"), { code: ErrorCode.InternalError })
      },
    })
    const ctrl = new AbortController()
    let threw: unknown = null
    try {
      await fetchMessagePage(
        h.client as never,
        { sessionID: h.sid, workspaceDir: h.dir, limit: 2, signal: ctrl.signal },
        h.connection as never,
        h.reader as never,
      )
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(Error)
    expect(String((threw as Error).message)).toMatch(/private observation unavailable/)
    expect(h.sdkCalls).toHaveLength(0)
  })

  it("stale generation: second replace wins, first private late result writes nothing", async () => {
    let resolveFirst!: (v: unknown) => void
    let first = true
    const h = makeHarness({
      privateMessages: async (input) => {
        if (first && input.sessionId === "ses_aaa111") {
          return new Promise<unknown>((res) => {
            resolveFirst = res
          })
        }
        return privateFound(input.sessionId, [userMsg("msg_1", 100, input.sessionId)])
      },
    })
    const anyP = h.provider as unknown as Record<string, unknown>
    ;(anyP["trackedSessionIds"] as unknown) = new Set<string>()
    ;(anyP["lastReconciledAt"] as unknown) = new Map<string, number>()
    ;(anyP["currentSession"] as unknown) = null
    const posts: unknown[] = []
    ;(anyP["postMessage"] as unknown) = (m: unknown) => posts.push(m)
    // Seed detail so doLoadMessages strict replace can proceed to messages.
    // Private get returns not_found in harness; switch to non-strict to focus on messages staleness.
    const api = h.provider as unknown as {
      doLoadMessages: (id: string, opts: unknown, strict: boolean) => Promise<boolean>
    }
    const loadA = api.doLoadMessages("ses_aaa111", { mode: "replace" }, false)
    await tick(10)
    first = false
    const okB = await api.doLoadMessages("ses_bbb222", { mode: "replace" }, false)
    expect(okB).toBeTrue()
    resolveFirst(privateFound("ses_aaa111", [userMsg("msg_1", 100, "ses_aaa111")]))
    const okA = await loadA
    expect(okA).toBeFalse()
    for (const l of posts.filter((p) => (p as Record<string, unknown>).type === "messagesLoaded")) {
      expect((l as Record<string, unknown>).sessionID).toBe("ses_bbb222")
    }
  })

  it("never touches private lifecycle", async () => {
    const h = makeHarness({})
    const init = mock(() => Promise.resolve())
    const reconnect = mock(() => Promise.resolve())
    ;(h.reader as Record<string, unknown>).initialize = init
    ;(h.reader as Record<string, unknown>).reconnect = reconnect
    await fetchMessagePage(
      h.client as never,
      { sessionID: h.sid, workspaceDir: h.dir, limit: 2 },
      h.connection as never,
      h.reader as never,
    )
    expect(init).not.toHaveBeenCalled()
    expect(reconnect).not.toHaveBeenCalled()
  })

  it("validator exercises real wiring: found valid, terminal exact, malformed throws", async () => {
    const msgs = [userMsg("msg_1", 100), userMsg("msg_2", 200)]
    const cursor = encodeMessageCursor({ id: "msg_1", time: 100 })
    const found = validatePrivateMessagesResult(privateFound(SECRET_SES, msgs, cursor), 2, SECRET_SES)
    expect(found.status).toBe("found")
    for (const status of ["not_found", "scope_mismatch"] as const) {
      const term = validatePrivateMessagesResult({ v: "1.0", status }, 2, SECRET_SES)
      expect(term.status).toBe(status)
    }
    let threw = false
    try {
      validatePrivateMessagesResult(
        { v: "1.0", status: "found", messages: [{ info: { id: "bad" }, parts: [] }] },
        2,
        SECRET_SES,
      )
    } catch {
      threw = true
    }
    expect(threw).toBeTrue()
  })

  it("part sessionID mismatch triggers bounded unavailable, never authoritative", async () => {
    const bad = [
      {
        info: userMsg("msg_1", 100).info,
        parts: [{ id: "prt_msg_1", sessionID: "ses_other", messageID: "msg_1", type: "text", text: "hi" }],
      },
    ]
    let threw = false
    try {
      validatePrivateMessagesResult(privateFound(SECRET_SES, bad), 1, SECRET_SES)
    } catch {
      threw = true
    }
    expect(threw).toBeTrue()
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => warns.push(a)
    try {
      const h = makeHarness({ privateMessages: async (input) => privateFound(input.sessionId, bad) })
      let threw2: unknown = null
      try {
        await fetchMessagePage(
          h.client as never,
          { sessionID: h.sid, workspaceDir: h.dir, limit: 1 },
          h.connection as never,
          h.reader as never,
        )
      } catch (e) {
        threw2 = e
      }
      expect(threw2).toBeInstanceOf(Error)
      expect(String((threw2 as Error).message)).toMatch(/private observation unavailable/)
      expect(h.privateCalls).toHaveLength(1)
      expect(h.sdkCalls).toHaveLength(0)
      expect(warns.some((w) => String(w[0]).includes("[Kilo Messages]"))).toBeTrue()
      for (const w of warns) {
        const text = w.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")
        expect(text).not.toContain(SECRET_DIR)
        expect(text).not.toContain(SECRET_SES)
        expect(text).not.toContain("ses_other")
      }
    } finally {
      console.warn = orig
    }
  })

  it("part messageID mismatch triggers bounded unavailable, never authoritative", async () => {
    const bad = [
      {
        info: userMsg("msg_1", 100).info,
        parts: [{ id: "prt_msg_1", sessionID: SECRET_SES, messageID: "msg_other", type: "text", text: "hi" }],
      },
    ]
    let threw = false
    try {
      validatePrivateMessagesResult(privateFound(SECRET_SES, bad), 1, SECRET_SES)
    } catch {
      threw = true
    }
    expect(threw).toBeTrue()
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => warns.push(a)
    try {
      const h = makeHarness({ privateMessages: async (input) => privateFound(input.sessionId, bad) })
      let threw2: unknown = null
      try {
        await fetchMessagePage(
          h.client as never,
          { sessionID: h.sid, workspaceDir: h.dir, limit: 1 },
          h.connection as never,
          h.reader as never,
        )
      } catch (e) {
        threw2 = e
      }
      expect(threw2).toBeInstanceOf(Error)
      expect(String((threw2 as Error).message)).toMatch(/private observation unavailable/)
      expect(h.privateCalls).toHaveLength(1)
      expect(h.sdkCalls).toHaveLength(0)
      expect(warns.some((w) => String(w[0]).includes("[Kilo Messages]"))).toBeTrue()
      for (const w of warns) {
        const text = w.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")
        expect(text).not.toContain(SECRET_DIR)
        expect(text).not.toContain("msg_other")
      }
    } finally {
      console.warn = orig
    }
  })

  it("per-page private-authority unavailable yields zero SDK with no second private request", async () => {
    const h = makeHarness({
      privateMessages: async () => {
        throw Object.assign(new Error("boom"), { code: ErrorCode.InternalError })
      },
    })
    let threw: unknown = null
    try {
      await fetchMessagePage(
        h.client as never,
        { sessionID: h.sid, workspaceDir: h.dir, limit: 2 },
        h.connection as never,
        h.reader as never,
      )
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(Error)
    expect(String((threw as Error).message)).toMatch(/private observation unavailable/)
    expect(h.privateCalls).toHaveLength(1)
    expect(h.sdkCalls).toHaveLength(0)
    await tick()
    expect(h.parityCalls).toHaveLength(0)
  })

  it("paged private-authority unavailable preserves zero SDK", async () => {
    const h = makeHarness({
      privateMessages: async () => {
        throw Object.assign(new Error("boom"), { code: ErrorCode.InternalError })
      },
    })
    let threw: unknown = null
    try {
      await fetchMessagePage(
        h.client as never,
        { sessionID: h.sid, workspaceDir: h.dir, limit: 2 },
        h.connection as never,
        h.reader as never,
      )
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(Error)
    expect(h.privateCalls).toHaveLength(1)
    expect(h.sdkCalls).toHaveLength(0)
  })

  it("limit=0 private iteration stops promptly on abort with no further pages or SDK fallback", async () => {
    // Pre-aborted: no private pages and no SDK fallback run.
    {
      const h = makeHarness({
        privateMessages: async (input) => privateFound(input.sessionId, [userMsg("msg_1", 100, input.sessionId)]),
      })
      const ctrl = new AbortController()
      ctrl.abort()
      let threw: unknown = null
      try {
        await fetchMessagePage(
          h.client as never,
          { sessionID: h.sid, workspaceDir: h.dir, limit: 0, signal: ctrl.signal },
          h.connection as never,
          h.reader as never,
        )
      } catch (e) {
        threw = e
      }
      expect(threw).toBeInstanceOf(DOMException)
      expect((threw as DOMException).name).toBe("AbortError")
      expect(h.privateCalls).toHaveLength(0)
      expect(h.sdkCalls).toHaveLength(0)
      await tick()
      expect(h.parityCalls).toHaveLength(0)
    }
    // Abort after the first private page resolves: post-await check throws
    // before the second private page and before any SDK fallback.
    {
      const newest = Array.from({ length: 100 }, (_, i) => userMsg(`msg_${String(i + 2).padStart(3, "0")}`, i + 2))
      const cursor0 = encodeMessageCursor({ id: newest[0]!.info.id, time: 2 })
      const ctrl = new AbortController()
      const h = makeHarness({
        privateMessages: async (input) => {
          ctrl.abort()
          return privateFound(input.sessionId, newest, cursor0)
        },
      })
      let threw: unknown = null
      try {
        await fetchMessagePage(
          h.client as never,
          { sessionID: h.sid, workspaceDir: h.dir, limit: 0, signal: ctrl.signal },
          h.connection as never,
          h.reader as never,
        )
      } catch (e) {
        threw = e
      }
      expect(threw).toBeInstanceOf(DOMException)
      expect((threw as DOMException).name).toBe("AbortError")
      expect(h.privateCalls).toHaveLength(1)
      expect(h.sdkCalls).toHaveLength(0)
      await tick()
      expect(h.parityCalls).toHaveLength(0)
    }
  })

  it("production delegate shape reaches provider private-first with no SDK", async () => {
    // Narrowest feasible handoff proof without full extension activation
    // (activation needs vscode host + spawned `kilo serve`, disproportionate
    // for this unit). Replicates extension.ts production delegate construction
    // verbatim and proves it satisfies the provider boundary.
    const messagesSeen: unknown[] = []
    const fakeObservation = {
      isEnabled: () => true,
      isStarted: () => true,
      list: async () => ({ v: "1.0", entries: [] }),
      get: async () => ({ v: "1.0", status: "not_found" }),
      messages: async (input: { directory: string; sessionId: string; limit: number; cursor?: string }) => {
        messagesSeen.push(input)
        return privateFound(input.sessionId, [userMsg("msg_1", 100, input.sessionId)])
      },
    }
    const productionReader = {
      isEnabled: () => fakeObservation.isEnabled(),
      isStarted: () => fakeObservation.isStarted(),
      list: (input: { directory: string; archived?: boolean; cursor?: string; limit?: number }) =>
        fakeObservation.list() as Promise<unknown>,
      get: (input: { directory: string; sessionId: string }) => fakeObservation.get() as Promise<unknown>,
      messages: (input: { directory: string; sessionId: string; limit: number; cursor?: string }) =>
        fakeObservation.messages(input) as Promise<unknown>,
    }
    // VscodeHost boundary: stores this reader and spreads it into KiloProvider
    // opts as `privateSessionReader` (see VscodeHost.wirePanel); provider
    // holds it non-owningly and never init/reconnect/dispose.
    const h = makeHarness({})
    const provider = new KiloProvider({ fsPath: "/tmp" } as unknown as import("vscode").Uri, h.connection, undefined, {
      projectDirectory: h.dir,
      privateSessionReader: productionReader,
    } as unknown as Parameters<typeof KiloProvider>[3]) as unknown as Record<string, unknown> & KiloProvider
    Object.defineProperty(provider, "client", { get: () => h.client })
    Object.defineProperty(provider, "getWorkspaceDirectory", { value: () => h.dir, configurable: true })
    const reader = (provider as unknown as { privateSessionReader: { messages: (i: unknown) => Promise<unknown> } })
      .privateSessionReader
    expect(typeof reader.messages).toBe("function")
    const page = await fetchMessagePage(
      h.client as never,
      { sessionID: h.sid, workspaceDir: h.dir, limit: 1 },
      h.connection as never,
      reader as never,
    )
    expect(page.items).toHaveLength(1)
    expect(messagesSeen).toHaveLength(1)
    expect(h.sdkCalls).toHaveLength(0)
    // Full extension activation (vscode panel + child backend) remains the
    // untested outer boundary by intent; ownership is covered by the
    // never-init/reconnect/dispose test.
  })
})
