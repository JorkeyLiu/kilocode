import { describe, expect, test } from "bun:test"
import {
  canonicalOrganizationSetOpId,
  isSettledOrganizationSetResult,
  makeOrganizationSetAmbiguous,
  parseOrganizationSetOpId,
  validateOrganizationSetContractRequest,
  validateOrganizationSetFailure,
  validateOrganizationSetResult,
} from "./serve-private-organization-set-contract"

function req(token = "tok-contract", organizationId: string | null = "org-1", overrides: Record<string, unknown> = {}) {
  const opId = canonicalOrganizationSetOpId(token)
  return {
    v: 1 as const,
    requestId: `req-${token}`,
    opId,
    op: "kilo/organization/set" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: { organizationId },
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
      data: { updated: true },
    },
  }
}

function terminalFor(token = "tok-term", code = "unauthorized") {
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

describe("organization-set private contract", () => {
  test("fresh organization-set identity validates (string and null)", () => {
    expect(canonicalOrganizationSetOpId("tok")).toBe("organization-set:tok")
    expect(parseOrganizationSetOpId("organization-set:tok")).toEqual({ token: "tok" })
    const r = validateOrganizationSetContractRequest(req("tok", "org-1"))
    expect(r.op).toBe("kilo/organization/set")
    expect(r.idempotencyKey).toBe(r.opId)
    expect(r.payload.organizationId).toBe("org-1")
    const n = validateOrganizationSetContractRequest(req("tok-null", null))
    expect(n.payload.organizationId).toBeNull()
  })

  test("strict binding rejects mismatched and malformed identities", () => {
    const base = req("tok-strict")
    expect(() => validateOrganizationSetContractRequest({ ...base, op: "remote/enable" })).toThrow()
    expect(() =>
      validateOrganizationSetContractRequest({ ...base, opId: "organization-set:tok-strict", idempotencyKey: "organization-set:other" }),
    ).toThrow()
    expect(() => validateOrganizationSetContractRequest({ ...base, opId: "organization-set:", idempotencyKey: "organization-set:" })).toThrow()
    expect(() => validateOrganizationSetContractRequest({ ...base, opId: "remote-enable:t", idempotencyKey: "remote-enable:t" })).toThrow()
    expect(() => validateOrganizationSetContractRequest({ ...base, context: { directory: "relative" } })).toThrow()
    expect(() => validateOrganizationSetContractRequest({ ...base, context: { directory: "/tmp", extra: 1 } })).toThrow()
    expect(() => validateOrganizationSetContractRequest({ ...base, payload: {} })).toThrow()
    expect(() => validateOrganizationSetContractRequest({ ...base, payload: { organizationId: "" } })).toThrow()
    expect(() =>
      validateOrganizationSetContractRequest({ ...base, payload: { organizationId: "org-1", extra: 1 } }),
    ).toThrow()
    expect(() => validateOrganizationSetContractRequest({ ...base, extra: 1 })).toThrow()
  })

  test("succeeded result echoes the request identity", () => {
    const { req: r, raw } = okFor("tok-echo")
    const out = validateOrganizationSetResult(raw, r as never)
    expect(out.status).toBe("succeeded")
    if (out.status === "succeeded") expect(out.data).toEqual({ updated: true })
    expect(() => validateOrganizationSetResult({ ...raw, requestId: "other" }, r as never)).toThrow()
    expect(() => validateOrganizationSetResult({ ...raw, opId: r.idempotencyKey.replace("tok-echo", "other") }, r as never)).toThrow()
  })

  test("terminal failure echoes and only CLI-authoritative codes validate", () => {
    const { req: r, raw } = terminalFor("tok-fail", "unauthorized")
    const out = validateOrganizationSetResult(raw, r as never)
    expect(out.status).toBe("failed")
    expect(() => validateOrganizationSetFailure({ code: "auth.missing", message: "m", retryable: false })).toThrow()
    expect(() => validateOrganizationSetFailure({ code: "unauthorized", message: "m", retryable: false, organizationId: "org-1" })).toThrow()
    const bad = { ...raw, failure: { code: "bogus", message: "m", retryable: false } }
    expect(() => validateOrganizationSetResult(bad, r as never)).toThrow()
  })

  test("ambiguous result validates with transportUnknown and never settles", () => {
    const r = req("tok-amb")
    const amb = makeOrganizationSetAmbiguous(r as never, true)
    expect(amb.status).toBe("ambiguous")
    expect(validateOrganizationSetResult(amb, r as never).status).toBe("ambiguous")
    expect(isSettledOrganizationSetResult(amb, r as never)).toBeFalse()
  })

  test("settled outcomes are success plus non-retryable terminal only", () => {
    const { req: okReq, raw: okRaw } = okFor("tok-settled-ok")
    expect(isSettledOrganizationSetResult(okRaw, okReq as never)).toBeTrue()
    const { req: termReq, raw: termRaw } = terminalFor("tok-settled-term", "validation.failed")
    expect(isSettledOrganizationSetResult(termRaw, termReq as never)).toBeTrue()
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
    expect(isSettledOrganizationSetResult(retryable, retryReq as never)).toBeFalse()
  })
})
