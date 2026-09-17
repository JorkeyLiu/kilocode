import { describe, expect, it } from "bun:test"
import { readFile } from "fs/promises"
import { join } from "path"
import { startSession } from "../../src/agent-manager/mcp-warmup"
import type { buildMcpStatusReq } from "../../src/kilo-provider/mcp-status-private"

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

function retryableWire(r: Req) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "mcp/status",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: {
      type: "failed",
      time: 1,
      failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
    },
    accepted: false,
    failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
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
  it("private unavailable degrades to logged failure with zero SDK and still creates the session", async () => {
    const calls: string[] = []
    const logs: unknown[][] = []
    const result = await startSession(
      "/repo/session-feature",
      async () => {
        calls.push("session")
        return "created"
      },
      (...args) => logs.push(args),
      { isPrivateAvailable: () => false } as never,
    )
    await flush()

    expect(result).toBe("created")
    expect(calls).toEqual(["session"])
    expect(logs[0]).toEqual(["[MCPWarmup] Starting for /repo/session-feature"])
    expect(logs[1]?.[0]).toBe("[MCPWarmup] Failed for /repo/session-feature:")
  })

  it("does not wait for MCP warmup before creating the session", async () => {
    const calls: string[] = []
    const pending = new Promise<unknown>(() => {})
    const conn = {
      isPrivateAvailable: () => true,
      privateMcpStatusOutcomeWithHandle: () => ({ id: 1, promise: pending, cancel: () => true }),
    }

    const result = await startSession(
      "/repo/session-feature",
      async () => {
        calls.push("session")
        return "created"
      },
      () => {},
      conn as never,
    )

    expect(result).toBe("created")
    expect(calls).toEqual(["session"])
  })

  it("logs and contains MCP warmup failures", async () => {
    const logs: unknown[][] = []
    const conn = {
      isPrivateAvailable: () => true,
      privateMcpStatusOutcomeWithHandle: () => ({
        id: 1,
        promise: Promise.reject(new Error("connection failed")),
        cancel: () => true,
      }),
    }

    const result = await startSession(
      "/repo/session-feature",
      async () => "created",
      (...args) => logs.push(args),
      conn as never,
    )
    await flush()

    expect(result).toBe("created")
    expect(logs[0]).toEqual(["[MCPWarmup] Starting for /repo/session-feature"])
    expect(logs[1]?.[0]).toBe("[MCPWarmup] Failed for /repo/session-feature:")
    expect(logs[1]?.[1]).toBeInstanceOf(Error)
  })

  it("private success completes with zero SDK calls", async () => {
    const dir = "/repo/session-feature"
    const calls: unknown[][] = []
    const logs: unknown[][] = []

    const result = await startSession(
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
    const logs: unknown[][] = []

    const result = await startSession(
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

  it("retryable fence degrades to logged failure with zero SDK and still creates the session", async () => {
    const dir = "/repo/session-feature"
    const calls: unknown[][] = []
    const logs: unknown[][] = []

    const result = await startSession(
      dir,
      async () => {
        calls.push(["session"])
        return "created"
      },
      (...args) => logs.push(args),
      privateConn((q) => retryableWire(q)) as never,
    )
    await flush()

    expect(result).toBe("created")
    expect(calls).toEqual([["session"]])
    expect(logs[0]).toEqual(["[MCPWarmup] Starting for /repo/session-feature"])
    expect(logs[1]?.[0]).toBe("[MCPWarmup] Failed for /repo/session-feature:")
  })

  it("warmup module has zero direct SDK status calls", async () => {
    const text = await readFile(join(import.meta.dir, "..", "..", "src", "agent-manager", "mcp-warmup.ts"), "utf8")
    expect(text.match(/\.mcp\.status\s*\(/g)?.length ?? 0).toBe(0)
    expect(text).toContain("fetchMcpStatusPrivate")
    expect(text).not.toContain("fetchMcpStatusPrivateFirst")
  })
})
