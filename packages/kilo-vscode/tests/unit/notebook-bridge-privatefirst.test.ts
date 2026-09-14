import { describe, expect, it, mock } from "bun:test"
import type { NotebookRequest } from "@kilocode/sdk/v2/client"
import { NotebookBridge, type NotebookBridgeContext } from "../../src/services/notebook/bridge"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"

const RID = "nbr_bridge00000000001"
const DIR = "/repo"

const read: NotebookRequest = {
  id: RID,
  sessionID: "ses_root1",
  operation: "read",
  path: "book.ipynb",
  includeOutputs: true,
} as NotebookRequest

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

function terminalFailure(req: Record<string, unknown>, code: string) {
  return {
    kind: "terminal-failure",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: true,
    failure: { code, retryable: false, time: 1 },
    sideEffect: false,
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function harness(opts: {
  privateReply?: (req: Record<string, unknown>) => unknown
  privateReject?: (req: Record<string, unknown>) => unknown
  privateList?: (req: Record<string, unknown>) => unknown
  sdkReplyError?: unknown
  sdkRejectError?: unknown
  pending?: NotebookRequest[]
  available?: boolean
}) {
  const sdkReplies: unknown[] = []
  const sdkRejects: unknown[] = []
  const sdkLists: unknown[] = []
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
        list: async (args: unknown) => {
          sdkLists.push(args)
          return { data: opts.pending ?? [] }
        },
        reply: async (args: unknown) => {
          sdkReplies.push(args)
          if (opts.sdkReplyError) throw opts.sdkReplyError
          return { data: true }
        },
        reject: async (args: unknown) => {
          sdkRejects.push(args)
          if (opts.sdkRejectError) throw opts.sdkRejectError
          return { data: true }
        },
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
    privateNotebookRejectWithHandle: opts.privateReject
      ? (req: Record<string, unknown>) => {
          privateCalls.push({ op: "notebook/reject", req })
          return { id: 2, promise: Promise.resolve(opts.privateReject!(req)), cancel: () => true }
        }
      : undefined,
    privateNotebookListWithHandle: opts.privateList
      ? (req: Record<string, unknown>) => {
          privateCalls.push({ op: "notebook/list", req })
          return { id: 3, promise: Promise.resolve(opts.privateList!(req)), cancel: () => true }
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
  const cancel = (id = RID, directory = DIR) =>
    handlers.event?.(
      {
        id: `cancel-${id}`,
        type: "kilocode.notebook.cancelled",
        properties: { requestID: id, sessionID: "ses_root1", reason: "cancelled" },
      } as SSEPayload,
      directory,
    )
  const internals = () => bridge as unknown as { outcomes: Map<string, unknown>; settled: Set<string> }
  return {
    bridge,
    cancel,
    client,
    handlers,
    privateCalls,
    readMock,
    request,
    sdkLists,
    sdkRejects,
    sdkReplies,
    internals,
  }
}

describe("NotebookBridge private-first", () => {
  it("settles a private terminal reply with zero SDK calls", async () => {
    const test = harness({ privateReply: terminal })
    test.request()
    await flush()
    expect(test.readMock).toHaveBeenCalledTimes(1)
    expect(test.sdkReplies).toHaveLength(0)
    expect(test.privateCalls.filter((c) => c.op === "notebook/reply")).toHaveLength(1)
    const req = test.privateCalls[0]!.req as Record<string, unknown>
    expect((req.context as Record<string, unknown>).directory).toBe(DIR)
    expect((req.context as Record<string, unknown>).requestID).toBe(RID)
    expect(test.internals().settled.has(RID)).toBe(true)
    expect(test.internals().outcomes.size).toBe(0)
    test.bridge.dispose()
  })

  it("normalizes private not_found to stale accepted success with zero SDK", async () => {
    const test = harness({ privateReply: (req) => terminalFailure(req, "notebook.not_found") })
    test.request()
    await flush()
    expect(test.sdkReplies).toHaveLength(0)
    expect(test.internals().settled.has(RID)).toBe(true)
    expect(test.internals().outcomes.size).toBe(0)
    test.bridge.dispose()
  })

  it("keeps the cached outcome on invalid_reply and settles on retry without rerunning the adapter", async () => {
    let mode: "invalid" | "ok" = "invalid"
    const test = harness({
      pending: [read],
      privateReply: (req) => (mode === "invalid" ? terminalFailure(req, "notebook.invalid_reply") : terminal(req)),
    })
    test.request()
    await flush()
    // First attempt: terminal invalid_reply closes with zero SDK as failure.
    expect(test.sdkReplies).toHaveLength(0)
    expect(test.internals().settled.has(RID)).toBe(false)
    expect(test.internals().outcomes.size).toBe(1)
    expect(test.readMock).toHaveBeenCalledTimes(1)
    // Recovery replays the pending request; the cached outcome is reused so
    // the adapter does not run again, and the second private attempt settles.
    mode = "ok"
    test.handlers.state?.("connected")
    await flush()
    expect(test.readMock).toHaveBeenCalledTimes(1)
    expect(test.privateCalls.filter((c) => c.op === "notebook/reply")).toHaveLength(2)
    expect(test.sdkReplies).toHaveLength(0)
    expect(test.internals().settled.has(RID)).toBe(true)
    test.bridge.dispose()
  })

  it("retries a transport failure without rerunning the adapter", async () => {
    const test = harness({ pending: [read], sdkReplyError: new Error("offline") })
    test.request()
    await flush()
    expect(test.readMock).toHaveBeenCalledTimes(1)
    expect(test.sdkReplies).toHaveLength(1)
    expect(test.internals().settled.has(RID)).toBe(false)
    expect(test.internals().outcomes.size).toBe(1)
    // Recovery via reconnect uses the cached outcome: adapter stays at one
    // execution while the SDK fallback is attempted exactly once more.
    test.handlers.state?.("connected")
    await flush()
    expect(test.readMock).toHaveBeenCalledTimes(1)
    expect(test.sdkReplies).toHaveLength(2)
    // The harness SDK keeps failing, so the outcome stays cached for retry.
    expect(test.internals().outcomes.size).toBe(1)
    test.bridge.dispose()
  })

  it("aborts a cancelled request without a late private or SDK reply", async () => {
    let release!: (value: never) => void
    const gate = new Promise<never>((resolve) => {
      release = resolve as unknown as (value: never) => void
    })
    const readMock = mock(() => gate)
    const context: NotebookBridgeContext = {
      adapter: { read: readMock as never, edit: undefined as never, execute: undefined as never },
      refresh: async () => undefined,
      dispose: () => undefined,
    }
    const sdkReplies: unknown[] = []
    const privateCalls: unknown[] = []
    const handlers: {
      event?: (event: SSEPayload, directory?: string) => void
      state?: (state: "connecting" | "connected" | "disconnected" | "error") => void
    } = {}
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
      getClient: () => ({
        kilocode: {
          notebook: {
            list: async () => ({ data: [] }),
            reply: async (a: unknown) => {
              sdkReplies.push(a)
              return { data: true }
            },
            reject: async () => ({ data: true }),
          },
        },
      }),
      getKnownDirectories: () => [DIR],
      isPrivateAvailable: () => true,
      privateNotebookReplyWithHandle: (req: unknown) => {
        privateCalls.push(req)
        return { id: 1, promise: Promise.resolve(terminal(req as Record<string, unknown>)), cancel: () => true }
      },
    }
    const bridge = new NotebookBridge(connection as never, {
      create: async () => context,
      canonical: async (directory) => directory,
    })
    handlers.event?.({ id: `event-${RID}`, type: "kilocode.notebook.requested", properties: read } as SSEPayload, DIR)
    await flush()
    handlers.event?.(
      {
        id: `cancel-${RID}`,
        type: "kilocode.notebook.cancelled",
        properties: { requestID: RID, sessionID: "ses_root1", reason: "cancelled" },
      } as SSEPayload,
      DIR,
    )
    release(undefined as never)
    await flush()
    expect(readMock).toHaveBeenCalledTimes(1)
    expect(privateCalls).toHaveLength(0)
    expect(sdkReplies).toHaveLength(0)
    bridge.dispose()
  })

  it("recovers per-directory pending requests through the private list", async () => {
    const seen: unknown[] = []
    const entry = { ...read }
    const wire = (req: Record<string, unknown>) => ({
      kind: "valid",
      result: {
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "notebook/list",
        idempotencyKey: req.idempotencyKey,
        status: "succeeded",
        outcome: { type: "succeeded", time: 1 },
        accepted: true,
        data: { notebooks: [entry] },
      },
    })
    const test = harness({
      privateReply: terminal,
      privateList: (req) => {
        seen.push(req)
        return wire(req)
      },
    })
    test.handlers.state?.("connected")
    await flush()
    expect(seen).toHaveLength(1)
    expect(((seen[0] as Record<string, unknown>).context as Record<string, unknown>).directory).toBe(DIR)
    expect(test.sdkLists).toHaveLength(0)
    expect(test.readMock).toHaveBeenCalledTimes(1)
    expect(test.internals().settled.has(RID)).toBe(true)
    test.bridge.dispose()
  })
})
