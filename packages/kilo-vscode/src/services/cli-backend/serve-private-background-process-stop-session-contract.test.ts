import { describe, expect, test } from "bun:test"
import {
  canonicalBackgroundStopSessionOpId,
  validateBackgroundStopSessionContractRequest,
  validateBackgroundStopSessionResult,
} from "./serve-private-background-process-stop-session-contract"

const DIR = "/tmp"
const SID = "ses_ffffffffffffffffffffffff"

function req(token = "tok1", overrides: Record<string, unknown> = {}) {
  const opId = canonicalBackgroundStopSessionOpId(token)
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "background-process/stop-session" as const,
    idempotencyKey: opId,
    context: { directory: DIR, sessionId: SID },
    payload: {},
    ...overrides,
  }
}

function okFor(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: r.op,
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { stopped: true },
  }
}

describe("background stop-session contract", () => {
  test("opId is opaque single-token with no session material", () => {
    const opId = canonicalBackgroundStopSessionOpId("abc123")
    expect(opId).toBe("background-process-stop-session:abc123")
    expect(opId.includes(SID)).toBeFalse()
    expect(opId.includes("/")).toBeFalse()
  })

  test("valid request passes with session+directory context", () => {
    const r = validateBackgroundStopSessionContractRequest(req())
    expect(r.context.sessionId).toBe(SID)
    expect(r.context.directory).toBe(DIR)
  })

  test("unknown root field fails closed", () => {
    expect(() => validateBackgroundStopSessionContractRequest(req("tok-x", { extra: true } as never))).toThrow()
  })

  test("idempotency mismatch fails closed", () => {
    const a = canonicalBackgroundStopSessionOpId("tok-a")
    const b = canonicalBackgroundStopSessionOpId("tok-b")
    expect(() =>
      validateBackgroundStopSessionContractRequest({
        v: 1,
        requestId: "r1",
        opId: a,
        op: "background-process/stop-session",
        idempotencyKey: b,
        context: { directory: DIR, sessionId: SID },
        payload: {},
      }),
    ).toThrow()
  })

  test("non-empty payload fails closed", () => {
    const r = req()
    expect(() => validateBackgroundStopSessionContractRequest({ ...r, payload: { extra: 1 } })).toThrow()
  })

  test("relative directory fails closed", () => {
    const r = req()
    expect(() =>
      validateBackgroundStopSessionContractRequest({ ...r, context: { directory: "relative/path", sessionId: SID } }),
    ).toThrow()
  })

  test("non-sessionId fails closed", () => {
    const r = req()
    expect(() =>
      validateBackgroundStopSessionContractRequest({ ...r, context: { directory: DIR, sessionId: "bad" } }),
    ).toThrow()
  })

  test("succeeded result validates with stopped:true", () => {
    const r = req("tok-ok")
    const parsed = validateBackgroundStopSessionContractRequest(r)
    expect(validateBackgroundStopSessionResult(okFor(r), parsed).status).toBe("succeeded")
  })

  test("failure with raw session field is rejected", () => {
    const r = req("tok-raw")
    const parsed = validateBackgroundStopSessionContractRequest(r)
    const bad = {
      v: 1,
      requestId: parsed.requestId,
      opId: parsed.opId,
      op: parsed.op,
      idempotencyKey: parsed.idempotencyKey,
      status: "failed",
      outcome: {
        type: "failed",
        time: 1,
        failure: { code: "internal", message: "m", retryable: false, sessionId: SID },
      },
      accepted: false,
      failure: { code: "internal", message: "m", retryable: false, sessionId: SID },
    }
    expect(() => validateBackgroundStopSessionResult(bad, parsed)).toThrow()
  })

  test("unknown failure code is rejected", () => {
    const r = req("tok-code")
    const parsed = validateBackgroundStopSessionContractRequest(r)
    const bad = {
      v: 1,
      requestId: parsed.requestId,
      opId: parsed.opId,
      op: parsed.op,
      idempotencyKey: parsed.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "nope", message: "m", retryable: false } },
      accepted: false,
      failure: { code: "nope", message: "m", retryable: false },
    }
    expect(() => validateBackgroundStopSessionResult(bad, parsed)).toThrow()
  })
})
