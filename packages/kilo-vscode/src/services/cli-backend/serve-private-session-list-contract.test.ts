import { describe, expect, test } from "bun:test"
import {
  canonicalSessionListOpId,
  checkSessionListScope,
  compareSessionListParity,
  isSessionListValidationError,
  makeSessionListAmbiguous,
  normalizePrivateSessionListWire,
  parseSessionListOpId,
  SessionListValidationError,
  validateSessionListContractRequest,
  validateSessionListFailure,
  validateSessionListResult,
  validateSessionListSummaries,
  validateSessionListSummary,
} from "./serve-private-session-list-contract"

function makeReq(over: Record<string, unknown> = {}) {
  const opId = canonicalSessionListOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "experimental/session/list" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: { filter: {} },
    ...over,
  }
}

function makeSucceeded(req: ReturnType<typeof validateSessionListContractRequest>) {
  return {
    v: 1 as const,
    requestId: req.requestId,
    opId: req.opId,
    op: "experimental/session/list" as const,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded" as const,
    outcome: { type: "succeeded" as const, time: 1 },
    accepted: true as const,
    data: {
      sessions: [{ id: "ses_abc", directory: "/tmp", title: "t", updated: 7 }],
    },
  }
}

describe("Gate B experimental/session/list candidate contract", () => {
  test("opId grammar is experimental-session-list single token with idempotency equality", () => {
    expect(canonicalSessionListOpId("t1")).toBe("experimental-session-list:t1")
    expect(() => canonicalSessionListOpId("")).toThrow()
    expect(() => canonicalSessionListOpId("a:b")).toThrow()
    expect(parseSessionListOpId(canonicalSessionListOpId("t1"))).toEqual({ token: "t1" })
    expect(() => parseSessionListOpId("session-list:t1")).toThrow()
    expect(() => parseSessionListOpId("get:ses_x:t1")).toThrow()
    expect(() => parseSessionListOpId("experimental-session-list:a:b")).toThrow()
  })

  test("request validation enforces v1 experimental op with routing identity and filter payload", () => {
    const req = makeReq()
    expect(() => validateSessionListContractRequest(req)).not.toThrow()
    expect(() => validateSessionListContractRequest({ ...req, v: 2 })).toThrow()
    expect(() => validateSessionListContractRequest({ ...req, op: "session/get" })).toThrow()
    expect(() => validateSessionListContractRequest({ ...req, op: "session/list" })).toThrow()
    expect(() => validateSessionListContractRequest({ ...req, context: { directory: "rel" }, payload: { filter: {} } })).toThrow()
    expect(() => validateSessionListContractRequest({ ...req, payload: {} })).toThrow()
    expect(() => validateSessionListContractRequest({ ...req, payload: { filter: { limit: 0 } } })).toThrow()
    expect(() => validateSessionListContractRequest({ ...req, payload: { filter: { limit: 5, bogus: 1 } } })).toThrow()
    const withFilter = makeReq({ payload: { filter: { limit: 10, cursor: 3, search: "hi" } } })
    expect(() => validateSessionListContractRequest(withFilter)).not.toThrow()
  })

  test("scope check guards directory/workspace/request identity with scope_mismatch", () => {
    const req = validateSessionListContractRequest(makeReq())
    expect(checkSessionListScope(req, { directory: "/tmp", token: "tok1" })).toEqual({ ok: true })
    expect(checkSessionListScope(req, { directory: "/other", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "directory",
    })
    expect(checkSessionListScope(req, { directory: "/tmp", workspace: "w", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "workspace",
    })
    expect(checkSessionListScope(req, { directory: "/tmp", token: "tok2" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "request",
    })
  })

  test("summary projection keeps only id/directory/title/updated and rejects secret fields", () => {
    expect(() => validateSessionListSummary({ id: "ses_a", directory: "/tmp", title: "t", updated: 1 })).not.toThrow()
    expect(() => validateSessionListSummary({ id: "x", directory: "/tmp", title: "t", updated: 1 })).toThrow()
    expect(() => validateSessionListSummary({ id: "ses_a", directory: "/tmp", title: "t", updated: 1, metadata: {} })).toThrow()
    expect(() => validateSessionListSummary({ id: "ses_a", directory: "/tmp", title: "t", updated: 1, project: null })).toThrow()
    expect(() => validateSessionListSummary({ id: "ses_a", directory: "/tmp", title: "t" })).toThrow()
    expect(() => validateSessionListSummaries("nope")).toThrow()
  })

  test("failure shape is redacted code/message/retryable without secret or cursor echo", () => {
    expect(() => validateSessionListFailure({ code: "c", message: "m", retryable: true })).not.toThrow()
    expect(() => validateSessionListFailure({ code: "c", message: "m", retryable: true, sessions: [] })).toThrow()
    expect(() => validateSessionListFailure({ code: "c", message: "m", retryable: true, cursor: 1 })).toThrow()
    expect(() => validateSessionListFailure({ code: "c", message: "m", retryable: true, detail: "x" })).toThrow()
  })

  test("result validation binds identity and rejects unknown ordering/pagination claims", () => {
    const req = validateSessionListContractRequest(makeReq())
    expect(() => validateSessionListResult(makeSucceeded(req), req)).not.toThrow()
    expect(() => validateSessionListResult({ ...makeSucceeded(req), op: "session/get" }, req)).toThrow()
    expect(() => validateSessionListResult({ ...makeSucceeded(req), data: { sessions: [], nextCursor: 1 } }, req)).toThrow()
    const badOrder = { ...makeSucceeded(req), data: { sessions: [{ id: "ses_abc", directory: "/tmp", title: "t", updated: 7 }] }, ordering: "updated-desc" }
    expect(() => validateSessionListResult(badOrder, req)).toThrow()
    const amb = makeSessionListAmbiguous(req)
    expect(() => validateSessionListResult(amb, req)).not.toThrow()
    const wire = normalizePrivateSessionListWire(makeSucceeded(req), req)
    expect(wire.kind).toBe("valid")
    expect(normalizePrivateSessionListWire({ nope: 1 }, req).kind).toBe("invalid")
    expect(new SessionListValidationError("x").kind).toBe("private-session-list-validation")
    expect(isSessionListValidationError(new SessionListValidationError("x"))).toBe(true)
  })

  test("parity compares only shared-id projection and reports membership as unknown", () => {
    const req = validateSessionListContractRequest(makeReq())
    const priv = validateSessionListResult(makeSucceeded(req), req)
    const same = compareSessionListParity(priv, {
      data: [{ id: "ses_abc", directory: "/tmp", title: "t", time: { updated: 999 } }],
    })
    expect(same.divergence).toBeNull()
    expect((same.details as Record<string, unknown>).orderingUnknown).toBe(true)
    expect((same.details as Record<string, unknown>).paginationUnknown).toBe(true)
    // Order-insensitive: reversed sdk order still matches.
    const priv2 = validateSessionListResult(
      { ...makeSucceeded(req), data: { sessions: [{ id: "ses_a", directory: "/tmp", title: "a", updated: 1 }, { id: "ses_b", directory: "/tmp", title: "b", updated: 2 }] } },
      req,
    )
    const reversed = compareSessionListParity(priv2, { data: [{ id: "ses_b", directory: "/tmp", title: "b" }, { id: "ses_a", directory: "/tmp", title: "a" }] })
    expect(reversed.divergence).toBeNull()
    // updated/freshness never compared.
    const stale = compareSessionListParity(priv, { data: [{ id: "ses_abc", directory: "/tmp", title: "t", time: { updated: 1 } }] })
    expect(stale.divergence).toBeNull()
    // Membership gaps are unknown, not silent match.
    const missing = compareSessionListParity(priv, { data: [] })
    expect(missing.divergence?.startsWith("session-list-membership-unknown")).toBe(true)
    const extra = compareSessionListParity(priv, {
      data: [
        { id: "ses_abc", directory: "/tmp", title: "t" },
        { id: "ses_extra", directory: "/tmp", title: "e" },
      ],
    })
    expect(extra.divergence?.startsWith("session-list-membership-unknown")).toBe(true)
    const dirMismatch = compareSessionListParity(priv, { data: [{ id: "ses_abc", directory: "/other", title: "t" }] })
    expect(dirMismatch.divergence).toBe("session-list-directory-mismatch")
    expect(compareSessionListParity(priv, { error: { message: "boom" } }).divergence?.startsWith("status-mismatch")).toBe(true)
    expect(compareSessionListParity(makeSessionListAmbiguous(req), { data: [] }).divergence).toBe("transport-unknown")
  })
})
