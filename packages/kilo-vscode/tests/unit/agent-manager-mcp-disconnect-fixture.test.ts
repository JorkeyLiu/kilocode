import { describe, expect, test } from "bun:test"

function disconnectOk(req: { requestId: string; opId: string; idempotencyKey: string }) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/disconnect",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { disconnected: true },
  }
}

function disconnectFailed(req: { requestId: string; opId: string; idempotencyKey: string }) {
  const failure = { code: "mcp.not_found", message: "m", retryable: false }
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/disconnect",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { ...failure } },
    accepted: false,
    failure: { ...failure },
  }
}

function statusOk(req: { requestId: string; opId: string; idempotencyKey: string }) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/status",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { status: { docs: { status: "connected" } } },
  }
}

function statusTerminal(req: { requestId: string; opId: string; idempotencyKey: string }) {
  const failure = { code: "validation.failed", message: "m", retryable: false }
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/status",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { ...failure } },
    accepted: false,
    failure: { ...failure },
  }
}

async function disconnectWith(opts: {
  disconnectImpl?: (req: never) => unknown
  statusImpl?: (req: never) => unknown
  connOver?: Record<string, unknown>
}) {
  const { AgentManagerProvider } = await import("../../src/agent-manager/AgentManagerProvider")
  let sdkCalls = 0
  let disconnectCalls = 0
  let statusCalls = 0
  const seenDisconnect: Array<{ op: string; dir: string; name: string }> = []
  const conn = {
    getClientAsync: async () => {
      sdkCalls += 1
      throw new Error("fixture must not reach the SDK client")
    },
    isPrivateAvailable: () => true,
    getPrivatePeer: () => null,
    getPrivateEpoch: () => 7,
    privateMcpDisconnectOutcomeWithHandle: (req: never) => {
      disconnectCalls += 1
      if (disconnectCalls > 1) throw new Error("private disconnect must be called exactly once")
      const r = req as { op: string; context: { directory: string }; payload: { name: string } }
      seenDisconnect.push({ op: r.op, dir: r.context.directory, name: r.payload.name })
      const impl = opts.disconnectImpl ?? disconnectOk
      return {
        id: disconnectCalls,
        promise: Promise.resolve({ kind: "valid", result: impl(req) }),
        cancel: () => true,
      }
    },
    privateMcpStatusOutcomeWithHandle: (req: never) => {
      statusCalls += 1
      if (statusCalls > 1) throw new Error("private status must be called exactly once")
      const impl = opts.statusImpl ?? statusOk
      return {
        id: 100 + statusCalls,
        promise: Promise.resolve({ kind: "valid", result: impl(req) }),
        cancel: () => true,
      }
    },
    ...(opts.connOver ?? {}),
  }
  const logs: string[] = []
  const provider = Object.create(AgentManagerProvider.prototype) as {
    mcpDisconnectForFixture(name: string): Promise<Record<string, string>>
  } & Record<string, unknown>
  provider.host = { workspacePath: () => "/tmp" }
  provider.connectionService = conn
  provider.outputChannel = { appendLine: () => {} }
  provider.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
  }
  const out = await provider.mcpDisconnectForFixture("docs")
  return { out, sdkCalls, disconnectCalls, statusCalls, seenDisconnect, logs }
}

describe("fixture mcpDisconnect private authority", () => {
  test("private disconnect success converges private status with zero SDK", async () => {
    const { out, sdkCalls, disconnectCalls, statusCalls, seenDisconnect } = await disconnectWith({})
    expect(out).toEqual({ docs: "connected" })
    expect(sdkCalls).toBe(0)
    expect(disconnectCalls).toBe(1)
    expect(statusCalls).toBe(1)
    expect(seenDisconnect).toEqual([{ op: "mcp/disconnect", dir: "/tmp", name: "docs" }])
  })

  test("failed disconnect stays warn-only and still converges private status", async () => {
    const { out, sdkCalls, disconnectCalls, statusCalls, logs } = await disconnectWith({
      disconnectImpl: disconnectFailed as never,
    })
    expect(out).toEqual({ docs: "connected" })
    expect(sdkCalls).toBe(0)
    expect(disconnectCalls).toBe(1)
    expect(statusCalls).toBe(1)
    expect(logs.some((l) => l.includes("fixture mcpDisconnect(docs) failed"))).toBeTrue()
  })

  test("terminal status falls back to the empty map with zero SDK", async () => {
    const { out, sdkCalls, disconnectCalls, statusCalls } = await disconnectWith({
      statusImpl: statusTerminal as never,
    })
    expect(out).toEqual({})
    expect(sdkCalls).toBe(0)
    expect(disconnectCalls).toBe(1)
    expect(statusCalls).toBe(1)
  })

  test("unavailable private authority falls back to the empty map with zero SDK", async () => {
    const { AgentManagerProvider } = await import("../../src/agent-manager/AgentManagerProvider")
    let sdkCalls = 0
    const conn = {
      getClientAsync: async () => {
        sdkCalls += 1
        throw new Error("fixture must not reach the SDK client")
      },
      isPrivateAvailable: () => false,
      getPrivatePeer: () => null,
      getPrivateEpoch: () => 7,
    }
    const provider = Object.create(AgentManagerProvider.prototype) as {
      mcpDisconnectForFixture(name: string): Promise<Record<string, string>>
    } & Record<string, unknown>
    provider.host = { workspacePath: () => "/tmp" }
    provider.connectionService = conn
    provider.outputChannel = { appendLine: () => {} }
    provider.log = () => {}
    const out = await provider.mcpDisconnectForFixture("docs")
    expect(out).toEqual({})
    expect(sdkCalls).toBe(0)
  })
})
