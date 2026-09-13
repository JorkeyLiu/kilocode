import { describe, expect, test } from "bun:test"
import {
  canonicalInstanceReloadOpId,
  isSettledInstanceReloadResult,
  makeInstanceReloadAmbiguous,
  parseInstanceReloadOpId,
  validateInstanceReloadContractRequest,
  validateInstanceReloadFailure,
  validateInstanceReloadResult,
} from "./serve-private-instance-reload-contract"

function req(token = "tok-contract", overrides: Record<string, unknown> = {}) {
  const opId = canonicalInstanceReloadOpId(token)
  return {
    v: 1 as const,
    requestId: `req-${token}`,
    opId,
    op: "instance/reload" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
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
      data: { reloaded: true },
    },
  }
}

function terminalFor(token = "tok-term", code = "conflict") {
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

describe("instance-reload private contract", () => {
  test("fresh instance-reload identity validates with empty payload", () => {
    expect(canonicalInstanceReloadOpId("tok")).toBe("instance-reload:tok")
    expect(parseInstanceReloadOpId("instance-reload:tok")).toEqual({ token: "tok" })
    const r = validateInstanceReloadContractRequest(req("tok"))
    expect(r.op).toBe("instance/reload")
    expect(r.idempotencyKey).toBe(r.opId)
    expect(r.payload).toEqual({})
  })

  test("strict binding rejects mismatched and malformed identities", () => {
    const base = req("tok-strict")
    expect(() => validateInstanceReloadContractRequest({ ...base, op: "remote/enable" })).toThrow()
    expect(() =>
      validateInstanceReloadContractRequest({ ...base, opId: "instance-reload:tok-strict", idempotencyKey: "instance-reload:other" }),
    ).toThrow()
    expect(() => validateInstanceReloadContractRequest({ ...base, opId: "instance-reload:", idempotencyKey: "instance-reload:" })).toThrow()
    expect(() => validateInstanceReloadContractRequest({ ...base, opId: "remote-enable:t", idempotencyKey: "remote-enable:t" })).toThrow()
    expect(() => validateInstanceReloadContractRequest({ ...base, context: { directory: "relative" } })).toThrow()
    expect(() => validateInstanceReloadContractRequest({ ...base, context: { directory: "/tmp", extra: 1 } })).toThrow()
    expect(() => validateInstanceReloadContractRequest({ ...base, payload: { extra: 1 } })).toThrow()
    expect(() => validateInstanceReloadContractRequest({ ...base, extra: 1 })).toThrow()
  })

  test("succeeded result echoes the request identity", () => {
    const { req: r, raw } = okFor("tok-echo")
    const out = validateInstanceReloadResult(raw, r as never)
    expect(out.status).toBe("succeeded")
    if (out.status === "succeeded") expect(out.data).toEqual({ reloaded: true })
    expect(() => validateInstanceReloadResult({ ...raw, requestId: "other" }, r as never)).toThrow()
    expect(() => validateInstanceReloadResult({ ...raw, opId: r.idempotencyKey.replace("tok-echo", "other") }, r as never)).toThrow()
  })

  test("terminal failure echoes and only CLI-authoritative codes validate", () => {
    const { req: r, raw } = terminalFor("tok-fail", "conflict")
    const out = validateInstanceReloadResult(raw, r as never)
    expect(out.status).toBe("failed")
    expect(() => validateInstanceReloadFailure({ code: "bogus", message: "m", retryable: false })).toThrow()
    expect(() => validateInstanceReloadFailure({ code: "conflict", message: "m", retryable: false, directory: "/tmp" })).toThrow()
    const bad = { ...raw, failure: { code: "bogus", message: "m", retryable: false } }
    expect(() => validateInstanceReloadResult(bad, r as never)).toThrow()
    for (const code of ["validation.failed", "scope_mismatch", "conflict", "internal"]) {
      const t = terminalFor(`tok-${code}`, code)
      expect(validateInstanceReloadResult(t.raw, t.req as never).status).toBe("failed")
    }
    const fence = terminalFor("tok-fence", "InstanceUnavailableDuringConfigRebuild")
    const fenceRaw = {
      ...fence.raw,
      outcome: { type: "failed", time: 1, failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "m", retryable: true } },
      failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "m", retryable: true },
    }
    expect(validateInstanceReloadResult(fenceRaw, fence.req as never).status).toBe("failed")
  })

  test("ambiguous result validates with transportUnknown and never settles", () => {
    const r = req("tok-amb")
    const amb = makeInstanceReloadAmbiguous(r as never, true)
    expect(amb.status).toBe("ambiguous")
    expect(validateInstanceReloadResult(amb, r as never).status).toBe("ambiguous")
    expect(isSettledInstanceReloadResult(amb, r as never)).toBeFalse()
  })

  test("settled outcomes are success plus non-retryable terminal only", () => {
    const { req: okReq, raw: okRaw } = okFor("tok-settled-ok")
    expect(isSettledInstanceReloadResult(okRaw, okReq as never)).toBeTrue()
    const { req: termReq, raw: termRaw } = terminalFor("tok-settled-term", "conflict")
    expect(isSettledInstanceReloadResult(termRaw, termReq as never)).toBeTrue()
    const fence = terminalFor("tok-settled-fence", "InstanceUnavailableDuringConfigRebuild")
    const fenceRaw = {
      ...fence.raw,
      outcome: { type: "failed", time: 1, failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "m", retryable: true } },
      failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "m", retryable: true },
    }
    expect(isSettledInstanceReloadResult(fenceRaw, fence.req as never)).toBeFalse()
  })
})
