import { describe, expect, it, mock } from "bun:test"
import type { NotebookRequest } from "@kilocode/sdk/v2/client"
import { NotebookBridge, type NotebookBridgeContext } from "../../src/services/notebook/bridge"
import {
  replyNotebookPrivateFirst,
  rejectNotebookPrivateFirst,
} from "../../src/kilo-provider/notebook-privatefirst"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"

const RID = "nbr_unres00000000001"
const DIR = "/repo"

const read: NotebookRequest = {
  id: RID,
  sessionID: "ses_root1",
  operation: "read",
  path: "book.ipynb",
  includeOutputs: true,
} as NotebookRequest

const result = {
  operation: "read",
  path: "book.ipynb",
  requestPath: "book.ipynb",
  revision: "content:2",
  cells: [],
} as never

const failure = { code: "execution_failed", message: "boom" } as never

function terminal(req: Record<string, unknown>) {
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    sessionID: "ses_root1",
    requestID: RID,
  }
}

function vague(req: Record<string, unknown>) {
  return {
    kind: "ambiguous",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: false,
    transportUnknown: true,
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function bridgeHarness(opts: {
  privateReply?: (req: Record<string, unknown>) => unknown
  pending?: NotebookRequest[]
  available?: boolean
  sdkReplyError?: unknown
}) {
  const sdkReplies: unknown[] = []
  const privateCalls: { op: string; req: unknown }[] = []
  const handlers: {
    event?: (event: SSEPayload, directory?: string) => void
    state?: (state: "connecting" | "connected" | "disconnected" | "error") => void
  } = {}
  const readMock = mock(async () => ({
    operation: "read" as const,
    path: "book.ipynb",
    requestPath: "book.ipynb",
    revision: "content:2",
    cells: [],
  }))
  const context: NotebookBridgeContext = {
    adapter: {
      read: readMock as never,
      edit: mock(async () => {
        throw new Error("unused")
      }) as never,
      execute: mock(async () => {
        throw new Error("unused")
      }) as never,
    },
    refresh: async () => undefined,
    dispose: () => undefined,
  }
  const client = {
    kilocode: {
      notebook: {
        list: async () => ({ data: opts.pending ?? [] }),
        reply: async (args: unknown) => {
          sdkReplies.push(args)
          if (opts.sdkReplyError) throw opts.sdkReplyError
          return { data: true }
        },
        reject: async () => ({ data: true }),
      },
    },
  }
  const connection = {
    onEvent: (listener: typeof handlers.event) => {
      handlers.event = listener
      return () => {
        handlers.event = undefined
      }
    },
    onStateChange: (listener: typeof handlers.state) => {
      handlers.state = listener
      return () => {
        handlers.state = undefined
      }
    },
    getClient: () => client,
    getKnownDirectories: () => [DIR],
    isPrivateAvailable: () => opts.available !== false,
    privateNotebookReplyWithHandle: opts.privateReply
      ? (req: Record<string, unknown>) => {
          privateCalls.push({ op: "notebook/reply", req })
          return { id: 1, promise: Promise.resolve(opts.privateReply!(req)), cancel: () => true }
        }
      : undefined,
  }
  const bridge = new NotebookBridge(connection as never, {
    create: async () => context,
    canonical: async (directory) => directory,
  })
  const request = (value: NotebookRequest = read, directory = DIR) =>
    handlers.event?.(
      { id: `event-${value.id}`, type: "kilocode.notebook.requested", properties: value } as SSEPayload,
      directory,
    )
  const internals = () =>
    bridge as unknown as {
      outcomes: Map<string, unknown>
      settled: Set<string>
      unresolved: Map<string, { opId: string; reason: string; requestID: string; sessionID: string; directory: string }>
      origins: Map<string, { directory: string; root: string; sessionID: string }>
    }
  return { bridge, handlers, privateCalls, readMock, request, sdkReplies, internals }
}

describe("notebook accepted-only unresolved", () => {
  it("normal private terminal reply settles with zero SDK", async () => {
    const conn = {
      isPrivateAvailable: () => true,
      privateNotebookReplyWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(terminal(req)),
        cancel: () => true,
      }),
    } as never
    let sdk = 0
    const client = {
      kilocode: { notebook: { reply: async () => ({ data: true }) } },
    } as never
    const { outcome, req } = await replyNotebookPrivateFirst({
      connection: conn,
      client: { kilocode: { notebook: { reply: async () => ({ data: true, sdk: sdk++ }) } } } as never,
      directory: DIR,
      requestID: RID,
      result,
    })
    expect(outcome.kind).toBe("settled")
    expect(sdk).toBe(0)
    expect(req.context.requestID).toBe(RID)
    void client
  })

  it("proven pre-send unavailable takes exactly one SDK dispatch", async () => {
    let sdk = 0
    const { outcome } = await replyNotebookPrivateFirst({
      connection: null,
      client: {
        kilocode: {
          notebook: {
            reply: async () => {
              sdk += 1
              return { data: true }
            },
          },
        },
      } as never,
      directory: DIR,
      requestID: RID,
      result,
    })
    expect(outcome.kind).toBe("settled")
    expect(sdk).toBe(1)
  })

  it("proven pre-send missing-capability takes exactly one SDK dispatch", async () => {
    let sdk = 0
    const conn = { isPrivateAvailable: () => true } as never
    const { outcome } = await replyNotebookPrivateFirst({
      connection: conn,
      client: {
        kilocode: {
          notebook: {
            reply: async () => {
              sdk += 1
              return { data: true }
            },
          },
        },
      } as never,
      directory: DIR,
      requestID: RID,
      result,
    })
    expect(outcome.kind).toBe("settled")
    expect(sdk).toBe(1)
  })

  it("after-send ambiguous yields explicit unresolved with zero SDK", async () => {
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateNotebookReplyWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(vague(req)),
        cancel: () => true,
      }),
    } as never
    const { outcome, req } = await replyNotebookPrivateFirst({
      connection: conn,
      client: {
        kilocode: {
          notebook: {
            reply: async () => {
              sdk += 1
              return { data: true }
            },
          },
        },
      } as never,
      directory: DIR,
      requestID: RID,
      result,
    })
    expect(outcome.kind).toBe("unresolved")
    if (outcome.kind === "unresolved") {
      expect(outcome.requestID).toBe(RID)
      expect(outcome.opId).toBe(req.opId)
      expect(outcome.reason.length).toBeGreaterThan(0)
    }
    expect(sdk).toBe(0)
  })

  it("after-send timeout, closed, and invalid each yield unresolved with zero SDK", async () => {
    const cases: Array<{ label: string; conn: never }> = [
      {
        label: "timeout",
        conn: {
          isPrivateAvailable: () => true,
          privateNotebookReplyWithHandle: () => ({
            id: 1,
            promise: Promise.reject(new Error("private notebook timeout after 3000ms")),
            cancel: () => true,
          }),
        } as never,
      },
      {
        label: "closed",
        conn: {
          isPrivateAvailable: () => true,
          privateNotebookReplyWithHandle: () => {
            throw new Error("Peer closed")
          },
        } as never,
      },
      {
        label: "invalid",
        conn: {
          isPrivateAvailable: () => true,
          privateNotebookReplyWithHandle: (req: Record<string, unknown>) => ({
            id: 1,
            promise: Promise.resolve({ ...terminal(req), requestId: "wrong" }),
            cancel: () => true,
          }),
        } as never,
      },
    ]
    for (const entry of cases) {
      let sdk = 0
      const { outcome, req } = await replyNotebookPrivateFirst({
        connection: entry.conn,
        client: {
          kilocode: {
            notebook: {
              reply: async () => {
                sdk += 1
                return { data: true }
              },
            },
          },
        } as never,
        directory: DIR,
        requestID: RID,
        result,
      })
      expect([entry.label, outcome.kind]).toEqual([entry.label, "unresolved"])
      if (outcome.kind === "unresolved") {
        expect([entry.label, outcome.requestID]).toEqual([entry.label, RID])
        expect([entry.label, outcome.opId]).toEqual([entry.label, req.opId])
      }
      expect([entry.label, sdk]).toEqual([entry.label, 0])
    }
  })

  it("reject ambiguous yields unresolved with zero SDK", async () => {
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateNotebookRejectWithHandle: (req: Record<string, unknown>) => ({
        id: 2,
        promise: Promise.resolve(vague(req)),
        cancel: () => true,
      }),
    } as never
    const { outcome, req } = await rejectNotebookPrivateFirst({
      connection: conn,
      client: {
        kilocode: {
          notebook: {
            reject: async () => {
              sdk += 1
              return { data: true }
            },
          },
        },
      } as never,
      directory: DIR,
      requestID: RID,
      error: failure,
    })
    expect(outcome.kind).toBe("unresolved")
    if (outcome.kind === "unresolved") {
      expect(outcome.requestID).toBe(RID)
      expect(outcome.opId).toBe(req.opId)
    }
    expect(sdk).toBe(0)
  })
})

describe("NotebookBridge unresolved replay guard", () => {
  it("unresolved then reconnect present issues zero re-dispatch and stays unresolved", async () => {
    const test = bridgeHarness({ privateReply: vague, pending: [read] })
    test.request()
    await flush()
    expect(test.readMock).toHaveBeenCalledTimes(1)
    expect(test.sdkReplies).toHaveLength(0)
    expect(test.privateCalls).toHaveLength(1)
    expect(test.internals().settled.has(RID)).toBe(false)
    expect(test.internals().outcomes.size).toBe(1)
    expect(test.internals().unresolved.has(RID)).toBe(true)
    const detail = test.internals().unresolved.get(RID)!
    expect(detail.requestID).toBe(RID)
    expect(detail.opId.length).toBeGreaterThan(0)

    // Reconnect re-lists the same pending request: must not silently replay
    // the same semantic op. Adapter stays at one run, no new private or SDK.
    test.handlers.state?.("connected")
    await flush()
    expect(test.readMock).toHaveBeenCalledTimes(1)
    expect(test.privateCalls).toHaveLength(1)
    expect(test.sdkReplies).toHaveLength(0)
    expect(test.internals().settled.has(RID)).toBe(false)
    expect(test.internals().outcomes.size).toBe(1)
    expect(test.internals().unresolved.has(RID)).toBe(true)
    test.bridge.dispose()
  })

  it("unresolved then reconnect absent issues zero re-dispatch and absence is not acceptance", async () => {
    const test = bridgeHarness({ privateReply: vague, pending: [] })
    test.request()
    await flush()
    expect(test.internals().unresolved.has(RID)).toBe(true)
    expect(test.internals().settled.has(RID)).toBe(false)

    test.handlers.state?.("connected")
    await flush()
    expect(test.readMock).toHaveBeenCalledTimes(1)
    expect(test.privateCalls).toHaveLength(1)
    expect(test.sdkReplies).toHaveLength(0)
    expect(test.internals().settled.has(RID)).toBe(false)
    expect(test.internals().unresolved.has(RID)).toBe(true)
    expect(test.internals().outcomes.size).toBe(1)
    test.bridge.dispose()
  })

  it("SDK-dispatch failure stays unresolved and never reissues on reconnect", async () => {
    const test = bridgeHarness({ pending: [read], sdkReplyError: new Error("offline") })
    test.request()
    await flush()
    expect(test.readMock).toHaveBeenCalledTimes(1)
    expect(test.sdkReplies).toHaveLength(1)
    expect(test.internals().settled.has(RID)).toBe(false)
    // Acceptance is unknown after an SDK dispatch failure: fail closed as
    // unresolved instead of silently replaying the cached semantic action.
    expect(test.internals().unresolved.has(RID)).toBe(true)
    expect(test.internals().unresolved.get(RID)!.reason).toBe("retry-unknown")
    expect(test.internals().outcomes.size).toBe(1)

    test.handlers.state?.("connected")
    await flush()
    expect(test.readMock).toHaveBeenCalledTimes(1)
    expect(test.sdkReplies).toHaveLength(1)
    expect(test.internals().unresolved.has(RID)).toBe(true)
    test.bridge.dispose()
  })

  it("normal private success settles with zero SDK and no unresolved", async () => {
    const test = bridgeHarness({ privateReply: terminal })
    test.request()
    await flush()
    expect(test.sdkReplies).toHaveLength(0)
    expect(test.internals().settled.has(RID)).toBe(true)
    expect(test.internals().unresolved.has(RID)).toBe(false)
    expect(test.internals().outcomes.size).toBe(0)
    test.bridge.dispose()
  })
})

describe("NotebookBridge unresolved origin and bounds", () => {
  function idAt(index: number): string {
    return `nbr_ev${String(index).padStart(9, "0")}00001`
  }

  it("same ID cross-origin never executes and keeps the original guard", async () => {
    const test = bridgeHarness({ privateReply: vague, pending: [] })
    test.request()
    await flush()
    expect(test.internals().unresolved.has(RID)).toBe(true)
    const reads = test.readMock.mock.calls.length
    const privates = test.privateCalls.length

    // Same ID, different session: collision, fail closed, never retryable.
    test.request({ ...read, sessionID: "ses_other" })
    await flush()
    expect(test.readMock.mock.calls.length).toBe(reads)
    expect(test.privateCalls.length).toBe(privates)
    expect(test.sdkReplies).toHaveLength(0)
    expect(test.internals().unresolved.get(RID)!.sessionID).toBe("ses_root1")

    // Same ID, different directory: same fail-closed suppression.
    test.request(read, "/elsewhere")
    await flush()
    expect(test.readMock.mock.calls.length).toBe(reads)
    expect(test.privateCalls.length).toBe(privates)
    expect(test.internals().unresolved.has(RID)).toBe(true)
    test.bridge.dispose()
  })

  it("matching cancel clears the guard and settles; cross-origin cancel is ignored", async () => {
    const test = bridgeHarness({ privateReply: vague, pending: [] })
    test.request()
    await flush()
    expect(test.internals().unresolved.has(RID)).toBe(true)
    const cancel = (sessionID: string, directory = DIR) =>
      test.handlers.event?.(
        {
          id: `cancel-${RID}`,
          type: "kilocode.notebook.cancelled",
          properties: { requestID: RID, sessionID, reason: "cancelled" },
        } as SSEPayload,
        directory,
      )
    cancel("ses_other")
    await flush()
    expect(test.internals().unresolved.has(RID)).toBe(true)
    expect(test.internals().settled.has(RID)).toBe(false)

    cancel("ses_root1")
    await flush()
    expect(test.internals().unresolved.has(RID)).toBe(false)
    expect(test.internals().settled.has(RID)).toBe(true)
    expect(test.privateCalls).toHaveLength(1)
    expect(test.sdkReplies).toHaveLength(0)
    test.bridge.dispose()
  })

  it("overflow past 1000 unresolved suppresses the evicted ID and still admits new IDs", async () => {
    const test = bridgeHarness({ privateReply: vague, pending: [] })
    const ids: string[] = []
    for (let i = 0; i < 1001; i++) {
      const id = idAt(i)
      ids.push(id)
      test.request({ ...read, id })
    }
    for (let i = 0; i < 50; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const state = test.internals()
    expect(state.unresolved.size).toBe(1000)
    expect(state.outcomes.size).toBeLessThanOrEqual(1000)
    expect(state.origins.size).toBeLessThanOrEqual(1000)
    expect(state.settled.size).toBeLessThanOrEqual(1000)
    // Exactly one guard overflowed and fails closed into the settled tombstone.
    const evicted = ids.filter((id) => !state.unresolved.has(id))
    expect(evicted).toHaveLength(1)
    expect(state.settled.has(evicted[0]!)).toBe(true)
    const reads = test.readMock.mock.calls.length
    const privates = test.privateCalls.length

    // Re-observing the evicted ID must not silently replay it.
    test.request({ ...read, id: evicted[0]! })
    await flush()
    expect(test.readMock.mock.calls.length).toBe(reads)
    expect(test.privateCalls.length).toBe(privates)
    expect(test.sdkReplies).toHaveLength(0)

    // A genuinely new ID is still admitted and executed.
    test.request({ ...read, id: "nbr_evnew000000001" })
    await flush()
    expect(test.readMock.mock.calls.length).toBeGreaterThan(reads)
    expect(test.internals().unresolved.has("nbr_evnew000000001")).toBe(true)
    test.bridge.dispose()
  }, 30000)
})
