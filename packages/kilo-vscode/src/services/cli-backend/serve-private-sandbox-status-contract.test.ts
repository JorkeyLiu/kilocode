import { describe, expect, test } from "bun:test"
import {
  SANDBOX_STATUS_FAILURE_MESSAGES,
  isSettledSandboxStatusResult,
  makeSandboxStatusAmbiguous,
  normalizePrivateSandboxStatusWire,
  validateSandboxStatusContractRequest,
  validateSandboxStatusData,
  validateSandboxStatusFailure,
  validateSandboxStatusResult,
} from "./serve-private-sandbox-status-contract"

function req() {
  return { v: 1 as const, requestId: "r1", op: "sandbox/status" as const, context: { directory: "/tmp", sessionId: "ses_abc123" }, payload: {} }
}

function status(overrides: Record<string, unknown> = {}) {
  return { directory: "/tmp", enabled: true, available: true, version: 3, ...overrides }
}

describe("sandbox-status contract", () => {
  test("request strict: absolute directory, SessionID, empty payload, no opId", () => {
    expect(() => validateSandboxStatusContractRequest(req())).not.toThrow()
    expect(() => validateSandboxStatusContractRequest({ ...req(), context: { directory: "rel", sessionId: "ses_a" } })).toThrow()
    expect(() => validateSandboxStatusContractRequest({ ...req(), context: { directory: "/tmp", sessionId: "bad" } })).toThrow()
    expect(() => validateSandboxStatusContractRequest({ ...req(), payload: { x: 1 } })).toThrow()
    expect(() => validateSandboxStatusContractRequest({ ...req(), opId: "x" } as never)).toThrow()
    expect(() => validateSandboxStatusContractRequest({ ...req(), idempotencyKey: "x" } as never)).toThrow()
    expect(() => validateSandboxStatusContractRequest({ ...req(), requestId: "/tmp/x" })).toThrow()
  })

  test("status strict: exact shape with available:false as succeeded data", () => {
    expect(() => validateSandboxStatusData(status())).not.toThrow()
    expect(() => validateSandboxStatusData(status({ available: false, enabled: false, reason: "no backend" }))).not.toThrow()
    expect(() => validateSandboxStatusData(status({ reason: "r" }))).not.toThrow()
    expect(() => validateSandboxStatusData({ ...status(), extra: 1 })).toThrow()
    expect(() => validateSandboxStatusData({ ...status(), version: -1 })).toThrow()
    expect(() => validateSandboxStatusData({ ...status(), reason: 1 })).toThrow()
  })

  test("failure strict: fixed code/message/retryable taxonomy", () => {
    for (const [code, message, retryable] of [
      ["validation.failed", SANDBOX_STATUS_FAILURE_MESSAGES["validation.failed"], false],
      ["scope_mismatch", SANDBOX_STATUS_FAILURE_MESSAGES["scope_mismatch"], false],
      ["session.not_found", SANDBOX_STATUS_FAILURE_MESSAGES["session.not_found"], false],
      ["InstanceUnavailableDuringConfigRebuild", SANDBOX_STATUS_FAILURE_MESSAGES["InstanceUnavailableDuringConfigRebuild"], true],
      ["internal", SANDBOX_STATUS_FAILURE_MESSAGES["internal"], true],
    ] as const) {
      expect(() => validateSandboxStatusFailure({ code, message, retryable })).not.toThrow()
    }
    expect(() => validateSandboxStatusFailure({ code: "other", message: "m", retryable: false })).toThrow()
    expect(() => validateSandboxStatusFailure({ code: "internal", message: "wrong", retryable: true })).toThrow()
    expect(() => validateSandboxStatusFailure({ code: "internal", message: "internal error", retryable: false })).toThrow()
  })

  test("result strict: succeeded/failed/ambiguous binding", () => {
    const r = req()
    const ok = {
      v: 1,
      requestId: "r1",
      op: "sandbox/status",
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { status: status() },
    }
    expect(() => validateSandboxStatusResult(ok, r)).not.toThrow()
    expect(normalizePrivateSandboxStatusWire(ok, r).kind).toBe("valid")
    const unavailable = {
      v: 1,
      requestId: "r1",
      op: "sandbox/status",
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { status: status({ available: false, enabled: false }) },
    }
    expect(() => validateSandboxStatusResult(unavailable, r)).not.toThrow()
    const bad = { ...ok, data: { status: { ...status(), version: "x" } } }
    expect(normalizePrivateSandboxStatusWire(bad, r).kind).toBe("invalid")
    const failed = {
      v: 1,
      requestId: "r1",
      op: "sandbox/status",
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "session.not_found", message: "session not found", retryable: false } },
      accepted: false,
      failure: { code: "session.not_found", message: "session not found", retryable: false },
    }
    expect(() => validateSandboxStatusResult(failed, r)).not.toThrow()
    expect(isSettledSandboxStatusResult(ok, r)).toBeTrue()
    expect(isSettledSandboxStatusResult(failed, r)).toBeTrue()
    const retryable = {
      v: 1,
      requestId: "r1",
      op: "sandbox/status",
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "internal", message: "internal error", retryable: true } },
      accepted: false,
      failure: { code: "internal", message: "internal error", retryable: true },
    }
    expect(isSettledSandboxStatusResult(retryable, r)).toBeFalse()
    const amb = makeSandboxStatusAmbiguous(r, true)
    expect(isSettledSandboxStatusResult(amb, r)).toBeFalse()
  })
})
