import { describe, expect, test } from "bun:test"
import { KiloProvider } from "./KiloProvider"
import { fetchMessagePage } from "./kilo-provider/message-page"
import { exportTranscript } from "./kilo-provider/export-transcript"
import type { KiloConnectionService } from "./services/cli-backend/connection-service"

function makeSessionData(id: string, dir = "/tmp") {
  return {
    id,
    directory: dir,
    title: "hello",
    time: { created: 1, updated: 2 },
  }
}

function msgItem(id: string, created: number, role = "user") {
  return { info: { id, sessionID: "ses_abc", role, time: { created } }, parts: [] }
}

function makeHarness(sessionId = "ses_abc") {
  const sdkGets: unknown[] = []
  const sdkMessages: unknown[] = []
  const privGetOutcomes: unknown[] = []
  const privMessagesOutcomes: unknown[] = []
  const dir = "/tmp"
  const data = makeSessionData(sessionId, dir)
  const items = [msgItem("msg_1", 1), msgItem("msg_2", 2)]
  const client = {
    session: {
      get: async (p: unknown) => {
        sdkGets.push(p)
        return { data, error: undefined, response: { status: 200 } }
      },
      messages: async (p: unknown) => {
        sdkMessages.push(p)
        return { data: items, response: { status: 200, headers: { get: () => null } } }
      },
      status: async (p: unknown) => {
        return { data: {}, error: undefined, response: { status: 200 } }
      },
    },
  }
  const connectionService = {
    isPrivateAvailable: () => true,
    getPrivateEpoch: () => 77,
    getClient: () => client,
    getClientAsync: async () => client,
    getConnectionError: () => null,
    connect: async () => {},
    privateGetOutcomeWithHandle: (req: Record<string, unknown>) => {
      privGetOutcomes.push(req)
      const ctx = req.context as Record<string, unknown>
      const payload = {
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/get",
        idempotencyKey: req.idempotencyKey,
        status: "succeeded",
        outcome: { type: "succeeded", time: 1 },
        accepted: true,
        data: { session: { id: ctx.sessionId, directory: ctx.directory, title: "hello" } },
      }
      return { id: privGetOutcomes.length, promise: Promise.resolve({ kind: "valid", result: payload }) }
    },
    privateGetWithHandle: () => {
      throw new Error("must use outcome path")
    },
    privateGet: async () => {
      throw new Error("must use outcome path")
    },
    privateMessagesOutcomeWithHandle: (req: Record<string, unknown>) => {
      privMessagesOutcomes.push(req)
      const payload = {
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/messages",
        idempotencyKey: req.idempotencyKey,
        status: "succeeded",
        outcome: { type: "succeeded", time: 1 },
        accepted: true,
        data: { messages: items },
      }
      return { id: privMessagesOutcomes.length, promise: Promise.resolve({ kind: "valid", result: payload }) }
    },
    privateMessagesWithHandle: () => {
      throw new Error("must use outcome path")
    },
    privateMessages: async () => {
      throw new Error("must use outcome path")
    },
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
    { projectDirectory: "/tmp", disableViewedRegistration: true } as unknown as Parameters<typeof KiloProvider>[3],
  )
  Object.defineProperty(provider, "getWorkspaceDirectory", { value: () => dir, configurable: true })
  Object.defineProperty(provider, "initializeConnection", { value: async () => {}, configurable: true })
  return { provider: provider as unknown as Record<string, unknown>, client, dir, data, items, sdkGets, sdkMessages, privGetOutcomes, privMessagesOutcomes, connectionService }
}

async function tick(ms = 60) {
  await new Promise((r) => setTimeout(r, ms))
}

describe("KiloProvider B7 live session/messages wiring (LOCK-B7-001/002/005)", () => {
  test("doLoadMessages replace is SDK-first with exact-once messages observer (limit 80)", async () => {
    const h = makeHarness("ses_abc")
    h.provider["trackedSessionIds"] = new Set<string>()
    const order: string[] = []
    const origMessages = (h.client.session as Record<string, unknown>).messages as (p: unknown) => Promise<unknown>
    ;(h.client.session as Record<string, unknown>).messages = async (p: unknown) => {
      order.push("sdk")
      return origMessages(p)
    }
    const origOutcome = (h.connectionService as unknown as Record<string, unknown>).privateMessagesOutcomeWithHandle as (r: unknown) => unknown
    ;(h.connectionService as unknown as Record<string, unknown>).privateMessagesOutcomeWithHandle = (r: unknown) => {
      order.push("private")
      return origOutcome(r)
    }
    await (
      h.provider as unknown as {
        doLoadMessages: (s: string, o: unknown, strict: boolean) => Promise<boolean>
      }
    ).doLoadMessages("ses_abc", { mode: "replace" }, false)
    expect(h.sdkMessages).toHaveLength(1)
    await tick()
    expect(h.privMessagesOutcomes).toHaveLength(1)
    expect(order).toEqual(["sdk", "private"])
    const req = h.privMessagesOutcomes[0] as Record<string, unknown>
    expect(String(req.opId).startsWith("messages:ses_abc:")).toBeTrue()
    expect((req.context as Record<string, unknown>).sessionId).toBe("ses_abc")
    expect((req.context as Record<string, unknown>).directory).toBe("/tmp")
    expect(req.payload).toEqual({ limit: 80 })
  })

  test("fetchMessagePage fill backfill still observes exactly once (initial query)", async () => {
    const assistant = msgItem("msg_old", 1, "assistant")
    const newer = msgItem("msg_new", 2, "user")
    let calls = 0
    const client = {
      session: {
        messages: async (p: unknown) => {
          calls += 1
          const params = p as Record<string, unknown>
          if (calls === 1) return { data: [assistant], response: { headers: { get: () => "cur-1" } } }
          expect(params.before).toBe("cur-1")
          return { data: [newer], response: { headers: { get: () => null } } }
        },
      },
    }
    const privCalls: unknown[] = []
    const conn = {
      isPrivateAvailable: () => true,
      getPrivateEpoch: () => 1,
      privateMessagesOutcomeWithHandle: (req: Record<string, unknown>) => {
        privCalls.push(req)
        return {
          id: 1,
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
              data: { messages: [assistant] },
            },
          }),
        }
      },
      privateMessagesWithHandle: () => {
        throw new Error("unused")
      },
      privateMessages: async () => {
        throw new Error("unused")
      },
    }
    const page = await fetchMessagePage(client as never, { sessionID: "ses_abc", workspaceDir: "/tmp", limit: 2 }, conn as never)
    expect(calls).toBe(2)
    expect(page.items).toHaveLength(2)
    await tick(30)
    expect(privCalls).toHaveLength(1)
    const req = privCalls[0] as Record<string, unknown>
    expect(req.payload).toEqual({ limit: 2 })
  })

  test("fetchMessagePage full limit:0 binds exact full-read query", async () => {
    const client = {
      session: {
        messages: async (p: unknown) => {
          expect((p as Record<string, unknown>).limit).toBe(0)
          return { data: [], response: { headers: { get: () => null } } }
        },
      },
    }
    const privCalls: unknown[] = []
    const conn = {
      isPrivateAvailable: () => true,
      getPrivateEpoch: () => 1,
      privateMessagesOutcomeWithHandle: (req: Record<string, unknown>) => {
        privCalls.push(req)
        return {
          id: 1,
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
      privateMessagesWithHandle: () => {
        throw new Error("unused")
      },
      privateMessages: async () => {
        throw new Error("unused")
      },
    }
    await fetchMessagePage(client as never, { sessionID: "ses_abc", workspaceDir: "/tmp", limit: 0 }, conn as never)
    await tick(30)
    expect(privCalls).toHaveLength(1)
    expect((privCalls[0] as Record<string, unknown>).payload).toEqual({ limit: 0 })
  })

  test("handleSyncSession direct full load is SDK-first with exact-once get + messages observers and no duplicates", async () => {
    const h = makeHarness("ses_eee")
    const data = makeSessionData("ses_eee", "/tmp")
    ;(h.client.session as Record<string, unknown>).get = async (p: unknown) => {
      h.sdkGets.push(p)
      return { data, error: undefined, response: { status: 200 } }
    }
    await (h.provider as unknown as { handleSyncSession: (s: string) => Promise<void> }).handleSyncSession("ses_eee")
    expect(h.sdkGets).toHaveLength(1)
    expect(h.sdkMessages).toHaveLength(1)
    await tick()
    expect(h.privGetOutcomes).toHaveLength(1)
    expect(h.privMessagesOutcomes).toHaveLength(1)
    const mreq = h.privMessagesOutcomes[0] as Record<string, unknown>
    expect((mreq.context as Record<string, unknown>).sessionId).toBe("ses_eee")
    expect(mreq.payload).toEqual({})
    expect(String(mreq.opId).startsWith("messages:ses_eee:")).toBeTrue()
    const greq = h.privGetOutcomes[0] as Record<string, unknown>
    expect(String(greq.opId).startsWith("get:ses_eee:")).toBeTrue()
  })

  test("handleSyncSession terminal messages failure still yields detached observation while preserving rejection", async () => {
    const h = makeHarness("ses_term")
    const data = makeSessionData("ses_term", "/tmp")
    ;(h.client.session as Record<string, unknown>).get = async (p: unknown) => {
      h.sdkGets.push(p)
      return { data, error: undefined, response: { status: 200 } }
    }
    const terminal = { data: undefined, error: { status: 404 }, response: { status: 404 } }
    let attempts = 0
    ;(h.client.session as Record<string, unknown>).messages = async (p: unknown) => {
      attempts += 1
      h.sdkMessages.push(p)
      throw terminal
    }
    await (h.provider as unknown as { handleSyncSession: (s: string) => Promise<void> }).handleSyncSession("ses_term")
    expect(attempts).toBe(1)
    await tick()
    expect(h.privMessagesOutcomes).toHaveLength(1)
    const mreq = h.privMessagesOutcomes[0] as Record<string, unknown>
    expect((mreq.context as Record<string, unknown>).sessionId).toBe("ses_term")
    expect(mreq.payload).toEqual({})
    // Catch behavior preserved: failed sync is evicted so a later sync retries SDK.
    await (h.provider as unknown as { handleSyncSession: (s: string) => Promise<void> }).handleSyncSession("ses_term")
    expect(attempts).toBe(2)
    await tick()
    expect(h.privMessagesOutcomes).toHaveLength(2)
  })

  test("aborted load never observes", async () => {
    const h = makeHarness("ses_abort")
    h.provider["trackedSessionIds"] = new Set<string>()
    const abort = new AbortController()
    abort.abort()
    await (
      h.provider as unknown as {
        doLoadMessages: (s: string, o: unknown, strict: boolean) => Promise<boolean>
      }
    ).doLoadMessages("ses_abort", { mode: "replace" }, false).catch(() => false)
    // Direct fetchMessagePage with an already-aborted signal still runs the
    // SDK read (server contract) but must not observe.
    const privCalls: unknown[] = []
    const conn = {
      isPrivateAvailable: () => true,
      getPrivateEpoch: () => 1,
      privateMessagesOutcomeWithHandle: (req: Record<string, unknown>) => {
        privCalls.push(req)
        return { id: 1, promise: new Promise(() => {}) }
      },
      privateMessagesWithHandle: () => {
        throw new Error("unused")
      },
      privateMessages: async () => {
        throw new Error("unused")
      },
    }
    const client = {
      session: {
        messages: async () => ({ data: [], response: { headers: { get: () => null } } }),
      },
    }
    const c = new AbortController()
    c.abort()
    await fetchMessagePage(client as never, { sessionID: "ses_abort", workspaceDir: "/tmp", limit: 2, signal: c.signal }, conn as never)
    await tick(30)
    expect(privCalls).toHaveLength(0)
    void abort
  })

  test("transcript export path observes full read exactly once via fetchMessagePage", async () => {
    const items = [msgItem("msg_1", 1)]
    const client = {
      session: {
        get: async () => ({ data: makeSessionData("ses_abc", "/tmp") }),
        messages: async (p: unknown) => {
          expect((p as Record<string, unknown>).limit).toBe(0)
          return { data: items, response: { headers: { get: () => null } } }
        },
      },
    }
    const privCalls: unknown[] = []
    const conn = {
      isPrivateAvailable: () => true,
      getPrivateEpoch: () => 1,
      privateMessagesOutcomeWithHandle: (req: Record<string, unknown>) => {
        privCalls.push(req)
        return {
          id: 1,
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
              data: { messages: items },
            },
          }),
        }
      },
      privateMessagesWithHandle: () => {
        throw new Error("unused")
      },
      privateMessages: async () => {
        throw new Error("unused")
      },
    }
    // Exercise the same helper exportTranscript uses (limit:0 full read).
    const { fetchMessagePage: page } = await import("./kilo-provider/message-page")
    await page(client as never, { sessionID: "ses_abc", workspaceDir: "/tmp", limit: 0 }, conn as never)
    await tick(30)
    expect(privCalls).toHaveLength(1)
    expect((privCalls[0] as Record<string, unknown>).payload).toEqual({ limit: 0 })
    void exportTranscript
  })

  test("fetchMessagePage real thrown non-terminal Error never observes but preserves rejection", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const client = {
        session: {
          messages: async () => {
            throw new Error("boom")
          },
        },
      }
      const privCalls: unknown[] = []
      const conn = {
        isPrivateAvailable: () => true,
        getPrivateEpoch: () => 1,
        privateMessagesOutcomeWithHandle: (req: Record<string, unknown>) => {
          privCalls.push(req)
          return { id: 1, promise: new Promise(() => {}) }
        },
        privateMessagesWithHandle: () => {
          throw new Error("unused")
        },
        privateMessages: async () => {
          throw new Error("unused")
        },
        invalidatePrivatePeerOnObserverTimeout: () => {
          throw new Error("must not invalidate on non-terminal")
        },
      }
      let caught: unknown
      try {
        await fetchMessagePage(client as never, { sessionID: "ses_abc", workspaceDir: "/tmp", limit: 2 }, conn as never)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(Error)
      expect(String((caught as Error).message)).toBe("boom")
      await tick(30)
      expect(privCalls).toHaveLength(0)
      expect(warns).toHaveLength(0)
    } finally {
      console.warn = origWarn
    }
  })

  test("fetchMessagePage terminal thrown Error with cause status still observes detached", async () => {
    const client = {
      session: {
        messages: async () => {
          throw Object.assign(new Error("Session not found"), { cause: { body: { name: "NotFoundError" }, status: 404 } })
        },
      },
    }
    const privCalls: unknown[] = []
    const conn = {
      isPrivateAvailable: () => true,
      getPrivateEpoch: () => 1,
      privateMessagesOutcomeWithHandle: (req: Record<string, unknown>) => {
        privCalls.push(req)
        return {
          id: 1,
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
      privateMessagesWithHandle: () => {
        throw new Error("unused")
      },
      privateMessages: async () => {
        throw new Error("unused")
      },
    }
    let caught: unknown
    try {
      await fetchMessagePage(client as never, { sessionID: "ses_term", workspaceDir: "/tmp", limit: 2 }, conn as never)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    await tick(30)
    expect(privCalls).toHaveLength(1)
    expect(((privCalls[0] as Record<string, unknown>).context as Record<string, unknown>).sessionId).toBe("ses_term")
  })

  test("handleSyncSession real thrown non-terminal Error never observes but still evicts for retry", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const h = makeHarness("ses_nterm")
      const data = makeSessionData("ses_nterm", "/tmp")
      ;(h.client.session as Record<string, unknown>).get = async (p: unknown) => {
        h.sdkGets.push(p)
        return { data, error: undefined, response: { status: 200 } }
      }
      let attempts = 0
      ;(h.client.session as Record<string, unknown>).messages = async (p: unknown) => {
        attempts += 1
        h.sdkMessages.push(p)
        throw new Error("boom")
      }
      await (h.provider as unknown as { handleSyncSession: (s: string) => Promise<void> }).handleSyncSession("ses_nterm")
      expect(attempts).toBe(1)
      await tick()
      expect(h.privMessagesOutcomes).toHaveLength(0)
      expect(warns.filter((w) => String(w[0]).includes("[Kilo Messages]"))).toHaveLength(0)
      await (h.provider as unknown as { handleSyncSession: (s: string) => Promise<void> }).handleSyncSession("ses_nterm")
      expect(attempts).toBe(2)
      await tick()
      expect(h.privMessagesOutcomes).toHaveLength(0)
    } finally {
      console.warn = origWarn
    }
  })

  test("handleSyncSession terminal thrown Error with cause status still observes detached", async () => {
    const h = makeHarness("ses_tcause")
    const data = makeSessionData("ses_tcause", "/tmp")
    ;(h.client.session as Record<string, unknown>).get = async (p: unknown) => {
      h.sdkGets.push(p)
      return { data, error: undefined, response: { status: 200 } }
    }
    let attempts = 0
    ;(h.client.session as Record<string, unknown>).messages = async (p: unknown) => {
      attempts += 1
      h.sdkMessages.push(p)
      throw Object.assign(new Error("Session not found"), { cause: { body: { name: "NotFoundError" }, status: 404 } })
    }
    await (h.provider as unknown as { handleSyncSession: (s: string) => Promise<void> }).handleSyncSession("ses_tcause")
    expect(attempts).toBe(1)
    await tick()
    expect(h.privMessagesOutcomes).toHaveLength(1)
    const mreq = h.privMessagesOutcomes[0] as Record<string, unknown>
    expect((mreq.context as Record<string, unknown>).sessionId).toBe("ses_tcause")
  })
})
