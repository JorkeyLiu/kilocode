import { describe, expect, test } from "bun:test"
import {
  canonicalRemoteStatusOpId,
  checkRemoteStatusScope,
  compareRemoteStatusParity,
  isRemoteStatusProcessGlobalField,
  isRemoteStatusValidationError,
  makeRemoteStatusAmbiguous,
  normalizePrivateRemoteStatusWire,
  parseRemoteStatusOpId,
  RemoteStatusValidationError,
  validateRemoteStatusContractRequest,
  validateRemoteStatusFailure,
  validateRemoteStatusPayload,
  validateRemoteStatusResult,
} from "./serve-private-remote-status-contract"

function makeReq(over: Record<string, unknown> = {}) {
  const opId = canonicalRemoteStatusOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "remote/status" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
    ...over,
  }
}

function makeSucceeded(req: ReturnType<typeof validateRemoteStatusContractRequest>, over: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    requestId: req.requestId,
    opId: req.opId,
    op: "remote/status" as const,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded" as const,
    outcome: { type: "succeeded" as const, time: 1 },
    accepted: true as const,
    data: { status: { enabled: true, connected: false, ...over } },
  }
}

describe("Gate B remote.status candidate contract", () => {
  test("opId grammar is single token with idempotency equality", () => {
    expect(canonicalRemoteStatusOpId("t1")).toBe("remote-status:t1")
    expect(() => canonicalRemoteStatusOpId("")).toThrow()
    expect(() => canonicalRemoteStatusOpId("a:b")).toThrow()
    expect(parseRemoteStatusOpId(canonicalRemoteStatusOpId("t1"))).toEqual({ token: "t1" })
    expect(() => parseRemoteStatusOpId("remote:t1")).toThrow()
    expect(() => parseRemoteStatusOpId("remote-status:a:b")).toThrow()
  })

  test("request validation enforces v1 envelope with absolute directory and empty payload", () => {
    const req = makeReq()
    expect(() => validateRemoteStatusContractRequest(req)).not.toThrow()
    expect(() => validateRemoteStatusContractRequest({ ...req, v: 2 })).toThrow()
    expect(() => validateRemoteStatusContractRequest({ ...req, op: "session/get" })).toThrow()
    expect(() =>
      validateRemoteStatusContractRequest({ ...req, idempotencyKey: canonicalRemoteStatusOpId("other") }),
    ).toThrow()
    expect(() =>
      validateRemoteStatusContractRequest({ ...req, context: { directory: "relative" } }),
    ).toThrow()
    expect(() => validateRemoteStatusContractRequest({ ...req, payload: { reason: "x" } })).toThrow()
    expect(() => validateRemoteStatusContractRequest({ ...req, extra: 1 })).toThrow()
    expect(() =>
      validateRemoteStatusContractRequest({ ...req, context: { directory: "/tmp", sessionId: "ses_x" } }),
    ).toThrow()
  })

  test("workspace binding is optional but scope-checked when present", () => {
    const req = validateRemoteStatusContractRequest(
      makeReq({ context: { directory: "/tmp", workspace: "ws1" } }),
    )
    expect(checkRemoteStatusScope(req, { directory: "/tmp", workspace: "ws1", token: "tok1" })).toEqual({
      ok: true,
    })
    expect(checkRemoteStatusScope(req, { directory: "/tmp", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "workspace",
    })
    expect(checkRemoteStatusScope(req, { directory: "/tmp", workspace: "ws2", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "workspace",
    })
    const bare = validateRemoteStatusContractRequest(makeReq())
    expect(checkRemoteStatusScope(bare, { directory: "/tmp", token: "tok1" })).toEqual({ ok: true })
  })

  test("directory scope binds canonical spellings; token conflict is request mismatch", () => {
    const req = validateRemoteStatusContractRequest(makeReq())
    expect(checkRemoteStatusScope(req, { directory: "/tmp/", token: "tok1" })).toEqual({ ok: true })
    expect(checkRemoteStatusScope(req, { directory: "/other", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "directory",
    })
    expect(checkRemoteStatusScope(req, { directory: "/tmp", token: "tok2" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "request",
    })
  })

  test("both status fields are process-global; directory is routing-only", () => {
    expect(isRemoteStatusProcessGlobalField("enabled")).toBeTrue()
    expect(isRemoteStatusProcessGlobalField("connected")).toBeTrue()
    expect(isRemoteStatusProcessGlobalField("directory")).toBeFalse()
    expect(isRemoteStatusProcessGlobalField("workspace")).toBeFalse()
    // Scope binds per-directory routing while payload ownership stays global.
    const a = validateRemoteStatusContractRequest(makeReq({ context: { directory: "/a" } }))
    const b = validateRemoteStatusContractRequest(makeReq({ requestId: "r2", context: { directory: "/b" } }))
    expect(checkRemoteStatusScope(a, { directory: "/a", token: "tok1" })).toEqual({ ok: true })
    expect(checkRemoteStatusScope(a, { directory: "/b", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "directory",
    })
    expect(checkRemoteStatusScope(b, { directory: "/b", token: "tok1" })).toEqual({ ok: true })
  })

  test("payload projection requires exactly the two booleans", () => {
    expect(() => validateRemoteStatusPayload({ enabled: true, connected: false })).not.toThrow()
    expect(() => validateRemoteStatusPayload({ enabled: true })).toThrow()
    expect(() => validateRemoteStatusPayload({ enabled: "yes", connected: false })).toThrow()
    expect(() => validateRemoteStatusPayload({ enabled: true, connected: false, extra: 1 })).toThrow()
  })

  test("succeeded result asserts no directory binding; same payload validates under any directory", () => {
    const a = validateRemoteStatusContractRequest(makeReq({ context: { directory: "/a" } }))
    const b = validateRemoteStatusContractRequest(makeReq({ requestId: "r2", context: { directory: "/b" } }))
    const okA = makeSucceeded(a, { enabled: false, connected: false })
    expect(() => validateRemoteStatusResult(okA, a)).not.toThrow()
    // Identical process-global payload under a different request directory is
    // still shape-valid; the contract claims no directory isolation.
    const samePayloadOtherDir = { ...makeSucceeded(b), data: okA.data }
    expect(() => validateRemoteStatusResult(samePayloadOtherDir, b)).not.toThrow()
  })

  test("failures are redacted; raw status/session/directory echo keys rejected", () => {
    expect(() =>
      validateRemoteStatusFailure({ code: "validation.failed", message: "bad", retryable: false }),
    ).not.toThrow()
    for (const key of ["enabled", "connected", "status", "directory", "workspace", "sessionId", "error"]) {
      expect(() =>
        validateRemoteStatusFailure({ code: "x", message: "m", retryable: false, [key]: "raw" }),
      ).toThrow()
    }
    const req = validateRemoteStatusContractRequest(makeReq())
    const failed = {
      v: 1 as const,
      requestId: req.requestId,
      opId: req.opId,
      op: "remote/status" as const,
      idempotencyKey: req.idempotencyKey,
      status: "failed" as const,
      outcome: {
        type: "failed" as const,
        time: 1,
        failure: { code: "validation.failed", message: "bad", retryable: false },
      },
      accepted: false as const,
      failure: { code: "validation.failed", message: "bad", retryable: false },
    }
    expect(() => validateRemoteStatusResult(failed, req)).not.toThrow()
    expect(() => validateRemoteStatusResult({ ...failed, data: { status: { enabled: true, connected: false } } }, req)).toThrow()
  })

  test("wire normalization separates invalid wire from normal failure; parity is process-global only", () => {
    const req = validateRemoteStatusContractRequest(makeReq())
    const ok = validateRemoteStatusResult(makeSucceeded(req), req)
    expect(normalizePrivateRemoteStatusWire(makeSucceeded(req), req)).toEqual({ kind: "valid", result: ok })
    const invalid = normalizePrivateRemoteStatusWire({ bogus: true }, req)
    expect(invalid.kind).toBe("invalid")
    if (invalid.kind === "invalid") {
      expect(new RemoteStatusValidationError(invalid.detail)).toSatisfy((e) => isRemoteStatusValidationError(e))
    }
    const amb = makeRemoteStatusAmbiguous(req)
    expect(amb.status).toBe("ambiguous")
    expect(() => validateRemoteStatusResult(amb, req)).not.toThrow()
    const parity = compareRemoteStatusParity(ok, { data: { enabled: true, connected: false } })
    expect(parity.divergence).toBeNull()
    expect(parity.details.processGlobal).toBeTrue()
    expect(parity.details.globalExcluded).toBeTrue()
    // Cross-directory equality is expected: parity compares booleans only and
    // never the request directory, so identical globals under another
    // directory still hold.
    const otherDir = validateRemoteStatusContractRequest(makeReq({ requestId: "r2", context: { directory: "/b" } }))
    const okOther = validateRemoteStatusResult(makeSucceeded(otherDir, { enabled: true, connected: false }), otherDir)
    expect(compareRemoteStatusParity(okOther, { data: { enabled: true, connected: false } }).divergence).toBeNull()
    const enabledMismatch = compareRemoteStatusParity(ok, { data: { enabled: false, connected: false } })
    expect(enabledMismatch.divergence).toBe("remote-status-enabled-mismatch")
    const connectedMismatch = compareRemoteStatusParity(ok, { data: { enabled: true, connected: true } })
    expect(connectedMismatch.divergence).toBe("remote-status-connected-mismatch")
    const statusMismatch = compareRemoteStatusParity(ok, { error: { message: "boom" } })
    expect(statusMismatch.divergence).toContain("status-mismatch")
  })
})
