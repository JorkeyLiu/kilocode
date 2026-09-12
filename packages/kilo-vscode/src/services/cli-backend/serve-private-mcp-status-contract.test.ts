import { describe, expect, test } from "bun:test"
import {
  canonicalMcpStatusOpId,
  isMcpStatusValidationError,
  isSettledMcpStatusResult,
  makeMcpStatusAmbiguous,
  normalizePrivateMcpStatusWire,
  parseMcpStatusOpId,
  validateMcpServerStatus,
  validateMcpStatusContractRequest,
  validateMcpStatusFailure,
  validateMcpStatusMap,
  validateMcpStatusResult,
} from "./serve-private-mcp-status-contract"

const DIR = "/tmp"

function req(token = "tok1") {
  const opId = canonicalMcpStatusOpId(token)
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "mcp/status" as const,
    idempotencyKey: opId,
    context: { directory: DIR },
    payload: {},
  }
}

function okFor(r: ReturnType<typeof req>, status: unknown = { docs: { status: "connected" } }) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "mcp/status",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { status },
  }
}

function failedFor(r: ReturnType<typeof req>, code = "validation.failed", retryable = false) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "mcp/status",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable } },
    accepted: false,
    failure: { code, message: "m", retryable },
  }
}

function ambiguousFor(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "mcp/status",
    idempotencyKey: r.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

describe("mcp-status private contract", () => {
  test("opId binds a single colon-free path-free token with idempotency equality", () => {
    expect(canonicalMcpStatusOpId("t1")).toBe("mcp-status:t1")
    expect(() => canonicalMcpStatusOpId("")).toThrow()
    expect(() => canonicalMcpStatusOpId("a:b")).toThrow()
    expect(() => canonicalMcpStatusOpId("a/b")).toThrow()
    expect(parseMcpStatusOpId("mcp-status:t1")).toEqual({ token: "t1" })
    expect(() => parseMcpStatusOpId("permission-list:t1")).toThrow()
    expect(() => parseMcpStatusOpId("mcp-status:a:b")).toThrow()
  })

  test("request accepts strict shape and rejects violations", () => {
    const r = req()
    expect(() => validateMcpStatusContractRequest(r)).not.toThrow()
    expect(() => validateMcpStatusContractRequest({ ...r, opId: "mcp-status:a:b" })).toThrow()
    expect(() => validateMcpStatusContractRequest({ ...r, op: "session/command" })).toThrow()
    expect(() => validateMcpStatusContractRequest({ ...r, idempotencyKey: "mcp-status:other" })).toThrow()
    expect(() => validateMcpStatusContractRequest({ ...r, context: { directory: "relative" } })).toThrow()
    expect(() => validateMcpStatusContractRequest({ ...r, payload: { filter: {} } })).toThrow()
    expect(() => validateMcpStatusContractRequest({ ...r, context: { directory: DIR, extra: 1 } })).toThrow()
    expect(() => validateMcpStatusContractRequest({ ...r, extra: 1 })).toThrow()
    expect(() => validateMcpStatusContractRequest({ ...r, v: 2 })).toThrow()
  })

  test("five-state payload validates each state and rejects extras", () => {
    expect(() => validateMcpServerStatus({ status: "connected" })).not.toThrow()
    expect(() => validateMcpServerStatus({ status: "disabled" })).not.toThrow()
    expect(() => validateMcpServerStatus({ status: "failed", error: "boom" })).not.toThrow()
    expect(() => validateMcpServerStatus({ status: "needs_auth" })).not.toThrow()
    expect(() => validateMcpServerStatus({ status: "needs_client_registration", error: "reg" })).not.toThrow()
    expect(() => validateMcpServerStatus({ status: "failed" })).toThrow()
    expect(() => validateMcpServerStatus({ status: "failed", error: "" })).toThrow()
    expect(() => validateMcpServerStatus({ status: "needs_client_registration" })).toThrow()
    expect(() => validateMcpServerStatus({ status: "connected", error: "x" })).toThrow()
    expect(() => validateMcpServerStatus({ status: "needs_auth", error: "x" })).toThrow()
    expect(() => validateMcpServerStatus({ status: "restarting" })).toThrow()
    expect(() => validateMcpServerStatus("connected")).toThrow()
    expect(() =>
      validateMcpStatusMap({ a: { status: "connected" }, b: { status: "failed", error: "e" } }),
    ).not.toThrow()
    expect(() => validateMcpStatusMap({ "": { status: "connected" } })).toThrow()
    expect(() => validateMcpStatusMap([])).toThrow()
  })

  test("result enforces per-status shape with identity binding", () => {
    const r = req()
    expect(() => validateMcpStatusResult(okFor(r), r)).not.toThrow()
    expect(() => validateMcpStatusResult(okFor(r, {}), r)).not.toThrow()
    expect(() => validateMcpStatusResult({ ...okFor(r), requestId: "r2" }, r)).toThrow()
    expect(() => validateMcpStatusResult({ ...okFor(r), data: { status: { a: { status: "nope" } } } }, r)).toThrow()
    expect(() => validateMcpStatusResult({ ...okFor(r), data: { statuses: {} } }, r)).toThrow()
    expect(() => validateMcpStatusResult(failedFor(r), r)).not.toThrow()
    expect(() => validateMcpStatusResult(failedFor(r, "InstanceUnavailableDuringConfigRebuild", true), r)).not.toThrow()
    expect(() => validateMcpStatusResult(ambiguousFor(r), r)).not.toThrow()
    expect(() => validateMcpStatusFailure({ code: "c", message: "m", retryable: false })).not.toThrow()
    expect(() => validateMcpStatusFailure({ code: "c", message: "m", retryable: false, status: "x" })).toThrow()
    expect(() => validateMcpStatusFailure({ code: "c", message: "m" })).toThrow()
  })

  test("normalize maps malformed wire to invalid with detail", () => {
    const r = req()
    expect(normalizePrivateMcpStatusWire(okFor(r), r).kind).toBe("valid")
    const bad = normalizePrivateMcpStatusWire({ ...okFor(r), accepted: false }, r)
    expect(bad.kind).toBe("invalid")
    if (bad.kind !== "invalid") throw new Error("expected invalid wire outcome")
    expect(bad.detail.length).toBeGreaterThan(0)
    expect(isMcpStatusValidationError({ kind: "private-mcp-status-validation" })).toBeTrue()
    expect(isMcpStatusValidationError({ kind: "other" })).toBeFalse()
  })

  test("settled keeps succeeded and terminal failed, drops retryable and ambiguous", () => {
    const r = req()
    expect(isSettledMcpStatusResult(okFor(r), r)).toBeTrue()
    expect(isSettledMcpStatusResult(failedFor(r, "validation.failed", false), r)).toBeTrue()
    expect(isSettledMcpStatusResult(failedFor(r, "InstanceUnavailableDuringConfigRebuild", true), r)).toBeFalse()
    expect(isSettledMcpStatusResult(ambiguousFor(r), r)).toBeFalse()
    expect(isSettledMcpStatusResult({ status: "succeeded" }, r)).toBeFalse()
    const vague = makeMcpStatusAmbiguous(r, true)
    expect(vague.status).toBe("ambiguous")
    expect(vague.accepted).toBeFalse()
    expect(isSettledMcpStatusResult(vague, r)).toBeFalse()
  })
})
