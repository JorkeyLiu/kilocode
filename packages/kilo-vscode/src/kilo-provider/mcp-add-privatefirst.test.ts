import { describe, expect, test } from "bun:test"
import {
  MCP_ADD_TIMEOUT_MS,
  attemptMcpAddPrivate,
  buildMcpAddReq,
  mcpAddFailureMessage,
} from "./mcp-add-privatefirst"
import { canonicalMcpAddOpId } from "../services/cli-backend/serve-private-mcp-add-contract"

const DIR = "/repo"
const CONFIG = {
  type: "local",
  command: ["npx", "@playwright/mcp@latest"],
  enabled: true,
  timeout: 60000,
} as const

function okFor(r: ReturnType<typeof buildMcpAddReq>, status: Record<string, unknown> = {}) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "mcp/add",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { status },
  }
}

function failedFor(r: ReturnType<typeof buildMcpAddReq>, code = "internal", retryable = false) {
  const failure = { code, message: "m", retryable }
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "mcp/add",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { ...failure } },
    accepted: false,
    failure: { ...failure },
  }
}

describe("mcp-add private-only (once, no SDK)", () => {
  test("identity binds the mcp-add tuple with directory, name, and config", () => {
    const r = buildMcpAddReq(DIR, "kilo-playwright", { ...CONFIG })
    expect(r.op).toBe("mcp/add")
    expect(r.opId).toBe(r.idempotencyKey)
    expect(r.opId.startsWith("mcp-add:")).toBeTrue()
    expect(canonicalMcpAddOpId(r.opId.split(":")[1]!)).toBe(r.opId)
    expect(r.context.directory).toBe(DIR)
    expect(r.payload.name).toBe("kilo-playwright")
    expect(r.payload.config).toEqual({ ...CONFIG })
    expect(MCP_ADD_TIMEOUT_MS).toBe(3000)
    expect(mcpAddFailureMessage("validation.failed").length).toBeGreaterThan(0)
  })

  test("succeeded accepted resolves ok with exactly one private call and zero SDK", async () => {
    const r = buildMcpAddReq(DIR, "kilo-playwright", { ...CONFIG })
    let calls = 0
    const connection = {
      isPrivateAvailable: () => true,
      privateMcpAddOutcomeWithHandle: (seen: typeof r) => {
        calls += 1
        expect(seen.opId).toBe(r.opId)
        return {
          id: 7,
          promise: Promise.resolve({ kind: "valid", result: okFor(r, { "kilo-playwright": { status: "connected" } }) }),
          cancel: () => true,
        }
      },
    }
    const out = await attemptMcpAddPrivate(connection as never, r)
    expect(calls).toBe(1)
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") expect(out.status["kilo-playwright"]).toEqual({ status: "connected" })
  })

  test("terminal failure closes with zero SDK and retryable fence is closed", async () => {
    const r = buildMcpAddReq(DIR, "kilo-playwright", { ...CONFIG })
    const terminal = {
      isPrivateAvailable: () => true,
      privateMcpAddOutcomeWithHandle: () => ({
        id: 1,
        promise: Promise.resolve({ kind: "valid", result: failedFor(r, "validation.failed", false) }),
        cancel: () => true,
      }),
    }
    expect(await attemptMcpAddPrivate(terminal as never, r)).toEqual({ kind: "failed", code: "validation.failed" })
    const fence = {
      isPrivateAvailable: () => true,
      privateMcpAddOutcomeWithHandle: () => ({
        id: 2,
        promise: Promise.resolve({
          kind: "valid",
          result: failedFor(r, "InstanceUnavailableDuringConfigRebuild", true),
        }),
        cancel: () => true,
      }),
    }
    expect(await attemptMcpAddPrivate(fence as never, r)).toEqual({
      kind: "closed",
      reason: "InstanceUnavailableDuringConfigRebuild",
    })
  })

  test("unavailable/invalid/ambiguous close without a second attempt", async () => {
    const r = buildMcpAddReq(DIR, "kilo-playwright", { ...CONFIG })
    expect(await attemptMcpAddPrivate(null, r)).toEqual({ kind: "closed", reason: "unavailable" })
    expect(await attemptMcpAddPrivate({ isPrivateAvailable: () => false } as never, r)).toEqual({
      kind: "closed",
      reason: "unavailable",
    })
    const invalid = {
      isPrivateAvailable: () => true,
      privateMcpAddOutcomeWithHandle: () => ({
        id: 3,
        promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
        cancel: () => true,
      }),
    }
    expect(await attemptMcpAddPrivate(invalid as never, r)).toEqual({ kind: "closed", reason: "invalid" })
  })

  test("timeout cancels the exact id and closes", async () => {
    const r = buildMcpAddReq(DIR, "kilo-playwright", { ...CONFIG })
    let cancelled = 0
    const hanging = {
      isPrivateAvailable: () => true,
      privateMcpAddOutcomeWithHandle: () => ({
        id: 9,
        promise: new Promise(() => {}),
        cancel: () => {
          cancelled += 1
          return true
        },
      }),
    }
    const out = await attemptMcpAddPrivate(hanging as never, r, 10)
    expect(out).toEqual({ kind: "closed", reason: "timeout" })
    expect(cancelled).toBe(1)
  })
})
