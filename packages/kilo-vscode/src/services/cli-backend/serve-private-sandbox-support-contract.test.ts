import { describe, expect, test } from "bun:test"
import {
  isSettledSandboxSupportResult,
  makeSandboxSupportAmbiguous,
  normalizePrivateSandboxSupportWire,
  validateSandboxSupportContractRequest,
  validateSandboxSupportData,
  validateSandboxSupportFailure,
  validateSandboxSupportResult,
} from "./serve-private-sandbox-support-contract"

function req() {
  return { v: 1 as const, requestId: "r1", op: "sandbox/support" as const, context: { directory: "/tmp" }, payload: {} }
}

function support(overrides: Record<string, unknown> = {}) {
  return { available: true, ...overrides }
}

describe("sandbox-support contract", () => {
  test("request is requestId-only directory-scoped", () => {
    expect(() => validateSandboxSupportContractRequest(req())).not.toThrow()
    expect(() => validateSandboxSupportContractRequest({ ...req(), context: { directory: "rel" } })).toThrow()
    expect(() => validateSandboxSupportContractRequest({ ...req(), context: { directory: "/tmp", sessionId: "ses_x" } } as never)).toThrow()
    expect(() => validateSandboxSupportContractRequest({ ...req(), payload: { x: 1 } })).toThrow()
    expect(() => validateSandboxSupportContractRequest({ ...req(), opId: "x" } as never)).toThrow()
    expect(() => validateSandboxSupportContractRequest({ ...req(), idempotencyKey: "x" } as never)).toThrow()
    expect(() => validateSandboxSupportContractRequest({ ...req(), requestId: "/tmp/x" })).toThrow()
  })

  test("exact available/reason payload; available:false stays success", () => {
    expect(() => validateSandboxSupportData(support())).not.toThrow()
    expect(() => validateSandboxSupportData(support({ available: false, reason: "no backend" }))).not.toThrow()
    expect(() => validateSandboxSupportData(support({ available: false }))).not.toThrow()
    expect(() => validateSandboxSupportData({ ...support(), extra: 1 })).toThrow()
    expect(() => validateSandboxSupportData({ ...support(), reason: 1 })).toThrow()
    expect(() => validateSandboxSupportData({ available: "yes" })).toThrow()
  })

  test("fixed failure taxonomy", () => {
    for (const [code, message, retryable] of [
      ["validation.failed", "invalid sandbox support request", false],
      ["scope_mismatch", "directory mismatch", false],
      ["InstanceUnavailableDuringConfigRebuild", "Instance is unavailable during config rebuild; no active runtime for this request", true],
      ["internal", "internal error", true],
    ] as const) {
      expect(() => validateSandboxSupportFailure({ code, message, retryable })).not.toThrow()
    }
    expect(() => validateSandboxSupportFailure({ code: "other", message: "m", retryable: false })).toThrow()
    expect(() => validateSandboxSupportFailure({ code: "internal", message: "wrong", retryable: true })).toThrow()
    expect(() => validateSandboxSupportFailure({ code: "internal", message: "internal error", retryable: false })).toThrow()
  })

  test("result validation and settled semantics", () => {
    const r = req()
    const ok = {
      v: 1,
      requestId: r.requestId,
      op: "sandbox/support",
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: support(),
    }
    expect(() => validateSandboxSupportResult(ok, r)).not.toThrow()
    expect(normalizePrivateSandboxSupportWire(ok, r).kind).toBe("valid")
    const unavailable = {
      v: 1,
      requestId: r.requestId,
      op: "sandbox/support",
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: support({ available: false, reason: "no backend" }),
    }
    expect(() => validateSandboxSupportResult(unavailable, r)).not.toThrow()
    const failure = { code: "validation.failed", message: "invalid sandbox support request", retryable: false }
    const failed = {
      v: 1,
      requestId: r.requestId,
      op: "sandbox/support",
      status: "failed",
      outcome: { type: "failed", time: 1, failure },
      accepted: false,
      failure,
    }
    expect(() => validateSandboxSupportResult(failed, r)).not.toThrow()
    expect(isSettledSandboxSupportResult(ok, r)).toBeTrue()
    expect(isSettledSandboxSupportResult(failed, r)).toBeTrue()
    const retryable = {
      v: 1,
      requestId: r.requestId,
      op: "sandbox/support",
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "internal", message: "internal error", retryable: true } },
      accepted: false,
      failure: { code: "internal", message: "internal error", retryable: true },
    }
    expect(isSettledSandboxSupportResult(retryable, r)).toBeFalse()
    const amb = makeSandboxSupportAmbiguous(r, true)
    expect(isSettledSandboxSupportResult(amb, r)).toBeFalse()
  })
})
