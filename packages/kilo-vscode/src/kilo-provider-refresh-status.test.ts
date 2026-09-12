import { describe, expect, it } from "bun:test"
import { KiloProvider } from "./KiloProvider"
import type { KiloConnectionService } from "./services/cli-backend/connection-service"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)

function found(id = "ses_abc", dir = "/tmp/ws") {
  return {
    v: "1.0" as const,
    status: "found" as const,
    session: {
      id,
      title: "priv",
      parentID: null,
      directory: dir,
      projectID: "proj_test",
      createdAt: 1000,
      updatedAt: 2000,
    },
  }
}

function statusOk(statuses: Record<string, unknown>, req: Record<string, unknown>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/status",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { statuses },
  }
}

function statusRetryable(req: Record<string, unknown>) {
  const failure = { code: "InstanceUnavailableDuringConfigRebuild", message: "fence", retryable: true }
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/status",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

function harness(opts: {
  dir?: string
  statuses?: (req: Record<string, unknown>) => unknown
  sdkStatuses?: Record<string, unknown>
} = {}) {
  const dir = opts.dir ?? "/tmp/ws"
  const gets: unknown[] = []
  const stats: unknown[] = []
  const statReqs: unknown[] = []
  const client = {
    session: {
      get: async (p: unknown) => {
        gets.push(p)
        return { data: null, error: undefined, response: { status: 200 } }
      },
      status: async (p: unknown) => {
        stats.push(p)
        return { data: opts.sdkStatuses ?? {}, error: undefined, response: { status: 200 } }
      },
    },
  }
  const reader = {
    isEnabled: () => true,
    isStarted: () => true,
    list: async () => ({ v: "1.0", entries: [], nextCursor: undefined }),
    get: async (input: { directory: string; sessionId: string }) => found(input.sessionId, input.directory),
  }
  const connection = {
    isPrivateAvailable: () => true,
    privateStatusOutcomeWithHandle: (req: Record<string, unknown>) => {
      statReqs.push(req)
      const result = opts.statuses ? opts.statuses(req) : statusOk({}, req)
      return { id: statReqs.length, promise: Promise.resolve({ kind: "valid", result }) }
    },
    privateGetOutcomeWithHandle: () => {
      throw new Error("no parity on this path")
    },
    getPrivateEpoch: () => 1,
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
  const provider = new KiloProvider(
    { fsPath: "/tmp" } as unknown as import("vscode").Uri,
    connection,
    undefined,
    { projectDirectory: dir, privateSessionReader: reader } as unknown as Parameters<typeof KiloProvider>[3],
  ) as unknown as Record<string, unknown> & KiloProvider
  Object.defineProperty(provider, "client", { get: () => client })
  Object.defineProperty(provider, "getWorkspaceDirectory", { value: () => dir, configurable: true })
  Object.defineProperty(provider, "initializeConnection", { value: async () => {}, configurable: true })
  const anyP = provider as unknown as Record<string, unknown>
  anyP["contextSessionID"] = "ses_abc"
  anyP["revisions"] = new Map()
  anyP["refreshes"] = new Map()
  anyP["trackedSessionIds"] = new Set(["ses_abc", "ses_retry"])
  const posts: unknown[] = []
  anyP["postMessage"] = (m: unknown) => posts.push(m)
  return { provider, dir, gets, stats, statReqs, posts }
}

const tick = () => new Promise((r) => setTimeout(r, 80))

describe("refreshSessionDetails session/status private-first", () => {
  it("private accepted posts tracked only with zero SDK status", async () => {
    const h = harness({
      statuses: (req) =>
        statusOk(
          {
            ses_abc: { type: "busy" },
            ses_retry: { type: "retry", attempt: 2, message: "wait", next: 7 },
            ses_other: { type: "busy" },
          },
          req,
        ),
    })
    ;(h.provider as unknown as { refreshSessionDetails: (id: string, dir: string) => void }).refreshSessionDetails("ses_abc", h.dir)
    await tick()
    expect(h.stats).toHaveLength(0)
    expect(h.statReqs).toHaveLength(1)
    expect(h.gets).toHaveLength(0)
    const msgs = h.posts.filter((p) => (p as Record<string, unknown>).type === "sessionStatus") as Record<string, unknown>[]
    const ids = msgs.map((m) => m.sessionID).sort()
    expect(ids).toEqual(["ses_abc", "ses_retry"])
    const busy = msgs.find((m) => m.sessionID === "ses_abc")
    expect(busy?.status).toBe("busy")
    const retry = msgs.find((m) => m.sessionID === "ses_retry")
    expect(retry?.status).toBe("retry")
    expect(retry?.attempt).toBe(2)
    expect(retry?.message).toBe("wait")
    expect(retry?.next).toBe(7)
  })

  it("retryable private falls back to exactly one same-dir SDK read", async () => {
    const h = harness({
      statuses: (req) => statusRetryable(req),
      sdkStatuses: { ses_abc: { type: "busy" }, ses_other: { type: "idle" } },
    })
    ;(h.provider as unknown as { refreshSessionDetails: (id: string, dir: string) => void }).refreshSessionDetails("ses_abc", h.dir)
    await tick()
    expect(h.statReqs).toHaveLength(1)
    expect(h.stats).toHaveLength(1)
    expect((h.stats[0] as Record<string, unknown>).directory).toBe(h.dir)
    const msgs = h.posts.filter((p) => (p as Record<string, unknown>).type === "sessionStatus") as Record<string, unknown>[]
    expect(msgs.map((m) => m.sessionID)).toEqual(["ses_abc"])
    expect(msgs[0]?.status).toBe("busy")
  })
})
