import { describe, expect, test } from "bun:test"

function mcpOk(req: { requestId: string; opId: string; idempotencyKey: string }) {
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

function mcpTerminal(req: { requestId: string; opId: string; idempotencyKey: string }) {
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

function mcpRetryable(req: { requestId: string; opId: string; idempotencyKey: string }) {
  const failure = { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true }
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

async function snapshotWith(mcpImpl: (req: never) => unknown, connOver: Record<string, unknown> = {}) {
  const { AgentManagerProvider } = await import("../../src/agent-manager/AgentManagerProvider")
  let sdkMcpCalls = 0
  const seen: string[] = []
  const fakeClient = {
    session: {
      list: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
      children: async () => ({ data: [] }),
    },
    app: { agents: async () => ({ data: [] }) },
    provider: { catalog: async () => ({ data: { connected: [] } }) },
    mcp: {
      status: async () => {
        sdkMcpCalls += 1
        return { data: { docs: { status: "connected" } } }
      },
    },
    permission: { list: async () => ({ data: [] }) },
    question: { list: async () => ({ data: [] }) },
  }
  const conn = {
    getClientAsync: async () => fakeClient,
    isPrivateAvailable: () => true,
    getPrivatePeer: () => null,
    getPrivateEpoch: () => 7,
    privateMcpStatusOutcomeWithHandle: (req: never) => {
      const r = req as { opId: string; requestId: string; idempotencyKey: string }
      seen.push(r.opId)
      return { id: seen.length, promise: Promise.resolve({ kind: "valid", result: mcpImpl(req) }), cancel: () => true }
    },
    ...connOver,
  }
  const provider = Object.create(AgentManagerProvider.prototype) as {
    backendSnapshotForFixture(): Promise<{ mcp?: Record<string, string> }>
  } & Record<string, unknown>
  provider.host = { workspacePath: () => "/tmp" }
  provider.connectionService = conn
  provider.outputChannel = { appendLine: () => {} }
  const snap = await provider.backendSnapshotForFixture()
  return { snap, sdkMcpCalls, seen }
}

describe("fixture backendSnapshot MCP private authority", () => {
  test("private success projects exact map with zero SDK", async () => {
    const { snap, sdkMcpCalls, seen } = await snapshotWith(mcpOk as never)
    expect(snap.mcp).toEqual({ docs: "connected" })
    expect(sdkMcpCalls).toBe(0)
    expect(seen.length).toBe(1)
    expect(seen[0]?.startsWith("mcp-status:")).toBeTrue()
  })

  test("terminal omits MCP status with zero SDK", async () => {
    const { snap, sdkMcpCalls, seen } = await snapshotWith(mcpTerminal as never)
    expect(snap.mcp).toBeUndefined()
    expect(sdkMcpCalls).toBe(0)
    expect(seen.length).toBe(1)
  })

  test("retryable fence omits MCP status with zero SDK and no retry", async () => {
    const { snap, sdkMcpCalls, seen } = await snapshotWith(mcpRetryable as never)
    expect(snap.mcp).toBeUndefined()
    expect(sdkMcpCalls).toBe(0)
    expect(seen.length).toBe(1)
  })

  test("unavailable omits MCP status with zero SDK", async () => {
    const { AgentManagerProvider } = await import("../../src/agent-manager/AgentManagerProvider")
    let sdkMcpCalls = 0
    const fakeClient = {
      session: {
        list: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
        children: async () => ({ data: [] }),
      },
      app: { agents: async () => ({ data: [] }) },
      provider: { catalog: async () => ({ data: { connected: [] } }) },
      mcp: {
        status: async () => {
          sdkMcpCalls += 1
          return { data: {} }
        },
      },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
    }
    const conn = {
      getClientAsync: async () => fakeClient,
      isPrivateAvailable: () => false,
      getPrivatePeer: () => null,
      getPrivateEpoch: () => 7,
    }
    const provider = Object.create(AgentManagerProvider.prototype) as {
      backendSnapshotForFixture(): Promise<{ mcp?: Record<string, string> }>
    } & Record<string, unknown>
    provider.host = { workspacePath: () => "/tmp" }
    provider.connectionService = conn
    provider.outputChannel = { appendLine: () => {} }
    const snap = await provider.backendSnapshotForFixture()
    expect(snap.mcp).toBeUndefined()
    expect(sdkMcpCalls).toBe(0)
  })
})
