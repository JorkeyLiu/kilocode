import { describe, expect, it } from "bun:test"
import { startSession } from "../../src/agent-manager/mcp-warmup"
import type { buildMcpStatusReq } from "../../src/kilo-provider/mcp-status-privatefirst"

type Req = ReturnType<typeof buildMcpStatusReq>

function tick(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve))
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await tick()
}

function okWire(r: Req) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "mcp/status",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { status: { docs: { status: "connected" } } },
  }
}

function terminalWire(r: Req) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "mcp/status",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code: "validation.failed", message: "m", retryable: false } },
    accepted: false,
    failure: { code: "validation.failed", message: "m", retryable: false },
  }
}

function privateConn(build: (r: Req) => unknown) {
  return {
    isPrivateAvailable: () => true,
    privateMcpStatusOutcomeWithHandle: (q: Req) => ({
      id: 1,
      promise: Promise.resolve({ kind: "valid", result: build(q) }),
      cancel: () => true,
    }),
  }
}

describe("Agent Manager MCP warmup", () => {
  it("falls back to exactly one same-directory SDK status without a private channel", async () => {
    const calls: unknown[][] = []
    const client = {
      mcp: {
        status: (input: unknown) => {
          calls.push(["warm", input])
          return Promise.resolve({ data: {} })
        },
      },
    }

    const result = await startSession(
      client as never,
      "/repo/session-feature",
      async () => {
        calls.push(["session"])
        return "created"
      },
      () => {},
    )

    expect(result).toBe("created")
    expect(calls.filter((c) => c[0] === "warm")).toEqual([["warm", { directory: "/repo/session-feature" }]])
    expect(calls).toContainEqual(["session"])
  })

  it("does not wait for MCP warmup before creating the session", async () => {
    const calls: string[] = []
    const warmup = new Promise<unknown>(() => {})
    const client = {
      mcp: {
        status: () => {
          calls.push("warm")
          return warmup
        },
      },
    }

    const result = await startSession(
      client as never,
      "/repo/session-feature",
      async () => {
        calls.push("session")
        return "created"
      },
      () => {},
    )

    expect(result).toBe("created")
    expect([...calls].sort()).toEqual(["session", "warm"])
  })

  it("logs and contains MCP warmup failures", async () => {
    const logs: unknown[][] = []
    const client = {
      mcp: {
        status: () => {
          throw new Error("connection failed")
        },
      },
    }

    const result = await startSession(
      client as never,
      "/repo/session-feature",
      async () => "created",
      (...args) => logs.push(args),
    )
    await tick()

    expect(result).toBe("created")
    expect(logs[0]).toEqual(["[MCPWarmup] Starting for /repo/session-feature"])
    expect(logs[1]?.[0]).toBe("[MCPWarmup] Failed for /repo/session-feature:")
    expect(logs[1]?.[1]).toBeInstanceOf(Error)
  })

  it("private success completes with zero SDK calls", async () => {
    const dir = "/repo/session-feature"
    const calls: unknown[][] = []
    const client = {
      mcp: {
        status: (input: unknown) => {
          calls.push(["warm", input])
          return Promise.resolve({ data: {} })
        },
      },
    }
    const logs: unknown[][] = []

    const result = await startSession(
      client as never,
      dir,
      async () => {
        calls.push(["session"])
        return "created"
      },
      (...args) => logs.push(args),
      privateConn((q) => okWire(q)) as never,
    )
    await flush()

    expect(result).toBe("created")
    expect(calls).toEqual([["session"]])
    expect(logs[0]).toEqual(["[MCPWarmup] Starting for /repo/session-feature"])
    expect(logs[1]).toEqual(["[MCPWarmup] Completed for /repo/session-feature"])
  })

  it("private terminal closes with zero SDK calls and still creates the session", async () => {
    const dir = "/repo/session-feature"
    const calls: unknown[][] = []
    const client = {
      mcp: {
        status: (input: unknown) => {
          calls.push(["warm", input])
          return Promise.resolve({ data: {} })
        },
      },
    }
    const logs: unknown[][] = []

    const result = await startSession(
      client as never,
      dir,
      async () => {
        calls.push(["session"])
        return "created"
      },
      (...args) => logs.push(args),
      privateConn((q) => terminalWire(q)) as never,
    )
    await flush()

    expect(result).toBe("created")
    expect(calls).toEqual([["session"]])
    expect(logs[0]).toEqual(["[MCPWarmup] Starting for /repo/session-feature"])
    expect(logs[1]?.[0]).toBe("[MCPWarmup] Failed for /repo/session-feature:")
  })
})
