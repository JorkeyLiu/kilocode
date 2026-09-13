import { describe, expect, test } from "bun:test"
import {
  canonicalAuthRemoveOpId,
  isSettledAuthRemoveResult,
  makeAuthRemoveAmbiguous,
  parseAuthRemoveOpId,
  validateAuthRemoveContractRequest,
  validateAuthRemoveFailure,
  validateAuthRemoveResult,
} from "./serve-private-auth-remove-contract"

function req(token = "tok-contract", overrides: Record<string, unknown> = {}) {
  const opId = canonicalAuthRemoveOpId(token)
  return {
    v: 1 as const,
    requestId: `req-${token}`,
    opId,
    op: "auth/remove" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: { providerID: "kilo" },
    ...overrides,
  }
}

function okFor(token = "tok-ok") {
  const r = req(token)
  return {
    req: r,
    raw: {
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: r.op,
      idempotencyKey: r.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { removed: true },
    },
  }
}

function terminalFor(token = "tok-term", code = "internal") {
  const r = req(token)
  return {
    req: r,
    raw: {
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: r.op,
      idempotencyKey: r.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable: false } },
      accepted: false,
      failure: { code, message: "m", retryable: false },
    },
  }
}

describe("auth-remove private contract", () => {
  test("fresh auth-remove identity validates", () => {
    expect(canonicalAuthRemoveOpId("tok")).toBe("auth-remove:tok")
    expect(parseAuthRemoveOpId("auth-remove:tok")).toEqual({ token: "tok" })
    const r = validateAuthRemoveContractRequest(req("tok"))
    expect(r.op).toBe("auth/remove")
    expect(r.idempotencyKey).toBe(r.opId)
    expect(r.payload.providerID).toBe("kilo")
  })

  test("strict binding rejects mismatched and malformed identities", () => {
    const base = req("tok-strict")
    expect(() => validateAuthRemoveContractRequest({ ...base, op: "remote/enable" })).toThrow()
    expect(() =>
      validateAuthRemoveContractRequest({ ...base, opId: "auth-remove:tok-strict", idempotencyKey: "auth-remove:other" }),
    ).toThrow()
    expect(() => validateAuthRemoveContractRequest({ ...base, opId: "auth-remove:", idempotencyKey: "auth-remove:" })).toThrow()
    expect(() => validateAuthRemoveContractRequest({ ...base, opId: "remote-enable:t", idempotencyKey: "remote-enable:t" })).toThrow()
    expect(() => validateAuthRemoveContractRequest({ ...base, context: { directory: "relative" } })).toThrow()
    expect(() => validateAuthRemoveContractRequest({ ...base, context: { directory: "/tmp", extra: 1 } })).toThrow()
    expect(() => validateAuthRemoveContractRequest({ ...base, payload: {} })).toThrow()
    expect(() => validateAuthRemoveContractRequest({ ...base, payload: { providerID: "" } })).toThrow()
    expect(() =>
      validateAuthRemoveContractRequest({ ...base, payload: { providerID: "kilo", extra: 1 } }),
    ).toThrow()
    expect(() => validateAuthRemoveContractRequest({ ...base, extra: 1 })).toThrow()
  })

  test("succeeded result echoes the request identity", () => {
    const { req: r, raw } = okFor("tok-echo")
    const out = validateAuthRemoveResult(raw, r as never)
    expect(out.status).toBe("succeeded")
    if (out.status === "succeeded") expect(out.data).toEqual({ removed: true })
    expect(() => validateAuthRemoveResult({ ...raw, requestId: "other" }, r as never)).toThrow()
    expect(() => validateAuthRemoveResult({ ...raw, opId: r.idempotencyKey.replace("tok-echo", "other") }, r as never)).toThrow()
  })

  test("terminal failure echoes and only CLI-authoritative codes validate", () => {
    const { req: r, raw } = terminalFor("tok-fail", "internal")
    const out = validateAuthRemoveResult(raw, r as never)
    expect(out.status).toBe("failed")
    expect(() => validateAuthRemoveFailure({ code: "auth.missing", message: "m", retryable: false })).toThrow()
    expect(() => validateAuthRemoveFailure({ code: "internal", message: "m", retryable: false, providerID: "kilo" })).toThrow()
    const bad = { ...raw, failure: { code: "bogus", message: "m", retryable: false } }
    expect(() => validateAuthRemoveResult(bad, r as never)).toThrow()
  })

  test("ambiguous result validates with transportUnknown and never settles", () => {
    const r = req("tok-amb")
    const amb = makeAuthRemoveAmbiguous(r as never, true)
    expect(amb.status).toBe("ambiguous")
    expect(validateAuthRemoveResult(amb, r as never).status).toBe("ambiguous")
    expect(isSettledAuthRemoveResult(amb, r as never)).toBeFalse()
  })

  test("settled outcomes are success plus non-retryable terminal only", () => {
    const { req: okReq, raw: okRaw } = okFor("tok-settled-ok")
    expect(isSettledAuthRemoveResult(okRaw, okReq as never)).toBeTrue()
    const { req: termReq, raw: termRaw } = terminalFor("tok-settled-term", "validation.failed")
    expect(isSettledAuthRemoveResult(termRaw, termReq as never)).toBeTrue()
    const retryReq = req("tok-retry")
    const retryable = {
      v: 1,
      requestId: retryReq.requestId,
      opId: retryReq.opId,
      op: retryReq.op,
      idempotencyKey: retryReq.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "internal", message: "m", retryable: true } },
      accepted: false,
      failure: { code: "internal", message: "m", retryable: true },
    }
    expect(isSettledAuthRemoveResult(retryable, retryReq as never)).toBeFalse()
  })
})
