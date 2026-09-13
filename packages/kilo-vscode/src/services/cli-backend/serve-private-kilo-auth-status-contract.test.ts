import { describe, expect, it } from "bun:test"
import {
  makeKiloAuthStatusAmbiguous,
  normalizePrivateKiloAuthStatusWire,
  validateKiloAuthStatusContractRequest,
  validateKiloAuthStatusData,
  validateKiloAuthStatusResult,
} from "./serve-private-kilo-auth-status-contract"
import type { KiloAuthStatusContractRequest } from "./serve-private-kilo-auth-status-contract"

function req(): KiloAuthStatusContractRequest {
  return {
    v: 1,
    requestId: "req-1",
    op: "kilo/auth-status",
    context: { directory: "/tmp" },
    payload: {},
  }
}

function okResult(r: KiloAuthStatusContractRequest, data: unknown) {
  return {
    v: 1,
    requestId: r.requestId,
    op: "kilo/auth-status",
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data,
  }
}

function failedResult(r: KiloAuthStatusContractRequest, code: string, message: string, retryable: boolean) {
  const failure = { code, message, retryable }
  return {
    v: 1,
    requestId: r.requestId,
    op: "kilo/auth-status",
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

describe("kilo/auth-status contract", () => {
  it("accepts api/oauth/signed-out SDK-equivalent data with no cross-field constraint", () => {
    expect(validateKiloAuthStatusData({ authenticated: true, type: "api" })).toEqual({
      authenticated: true,
      type: "api",
    })
    expect(validateKiloAuthStatusData({ authenticated: true, type: "oauth" })).toEqual({
      authenticated: true,
      type: "oauth",
    })
    expect(validateKiloAuthStatusData({ authenticated: false })).toEqual({ authenticated: false })
    // Shape-only: `type` presence while signed out is still valid wire.
    expect(validateKiloAuthStatusData({ authenticated: false, type: "api" })).toEqual({
      authenticated: false,
      type: "api",
    })
  })

  it("rejects unknown/secret fields and null/non-enum type", () => {
    const r = req()
    expect(() => validateKiloAuthStatusContractRequest({ ...r, extra: 1 })).toThrow("unexpected field")
    expect(() => validateKiloAuthStatusContractRequest({ ...r, opId: "x", idempotencyKey: "x" })).toThrow(
      "unexpected field",
    )
    expect(() => validateKiloAuthStatusData({ authenticated: true, type: "oauth", token: "s" })).toThrow(
      "unexpected data field",
    )
    expect(() => validateKiloAuthStatusData({ authenticated: true, type: "oauth", key: "s" })).toThrow()
    expect(() => validateKiloAuthStatusData({ authenticated: false, type: null })).toThrow()
    expect(() => validateKiloAuthStatusData({ authenticated: true, type: "wellknown" })).toThrow()
    expect(() => validateKiloAuthStatusData({ authenticated: "yes" })).toThrow()
    expect(() => validateKiloAuthStatusData({})).toThrow()
  })

  it("validates success and failure taxonomy with fixed messages", () => {
    const r = req()
    expect(validateKiloAuthStatusResult(okResult(r, { authenticated: true, type: "oauth" }), r).status).toBe(
      "succeeded",
    )
    expect(validateKiloAuthStatusResult(okResult(r, { authenticated: false }), r).status).toBe("succeeded")
    expect(
      validateKiloAuthStatusResult(
        failedResult(r, "validation.failed", "invalid kilo-auth-status request", false),
        r,
      ).status,
    ).toBe("failed")
    expect(validateKiloAuthStatusResult(failedResult(r, "internal", "internal error", false), r).status).toBe(
      "failed",
    )
    // Wrong retryable/message for a code is invalid wire.
    expect(
      normalizePrivateKiloAuthStatusWire(failedResult(r, "internal", "internal error", true), r).kind,
    ).toBe("invalid")
    expect(normalizePrivateKiloAuthStatusWire(failedResult(r, "nope", "x", false), r).kind).toBe("invalid")
  })

  it("rejects unknown outer result fields and echoes requestId", () => {
    const r = req()
    expect(normalizePrivateKiloAuthStatusWire({ ...okResult(r, { authenticated: false }), extra: 1 }, r).kind).toBe(
      "invalid",
    )
    expect(
      normalizePrivateKiloAuthStatusWire({ ...okResult(r, { authenticated: false }), requestId: "other" }, r).kind,
    ).toBe("invalid")
    expect(makeKiloAuthStatusAmbiguous(r, true).status).toBe("ambiguous")
  })

  it("requires absolute directory and empty payload", () => {
    const r = req()
    expect(() =>
      validateKiloAuthStatusContractRequest({ ...r, context: { directory: "relative" } }),
    ).toThrow()
    expect(() => validateKiloAuthStatusContractRequest({ ...r, payload: { x: 1 } })).toThrow()
  })
})
