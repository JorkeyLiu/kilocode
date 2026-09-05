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

function makeSucceededCursor(req: ReturnType<typeof validateSessionListContractRequest>, nextCursor: unknown) {
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
      nextCursor,
    },
  }
}

function sdkWithCursor(data: unknown, cursor: string | null) {
  return {
    data,
    response: { status: 200, headers: { get: (k: string) => (k === "x-next-cursor" ? cursor : null) } },
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

  test("result validation binds identity and enforces strict nextCursor shape", () => {
    const req = validateSessionListContractRequest(makeReq())
    expect(() => validateSessionListResult(makeSucceeded(req), req)).not.toThrow()
    expect(() => validateSessionListResult({ ...makeSucceeded(req), op: "session/get" }, req)).toThrow()
    // Inline optional numeric nextCursor is the production x-next-cursor equivalent.
    expect(() => validateSessionListResult(makeSucceededCursor(req, 42), req)).not.toThrow()
    expect(() => validateSessionListResult(makeSucceededCursor(req, 0), req)).not.toThrow()
    expect(() => validateSessionListResult(makeSucceededCursor(req, null), req)).toThrow()
    expect(() => validateSessionListResult(makeSucceededCursor(req, "42"), req)).toThrow()
    expect(() => validateSessionListResult(makeSucceededCursor(req, Number.NaN), req)).toThrow()
    expect(() => validateSessionListResult(makeSucceededCursor(req, -1), req)).toThrow()
    expect(() => validateSessionListResult(makeSucceededCursor(req, Number.POSITIVE_INFINITY), req)).toThrow()
    expect(() => validateSessionListResult({ ...makeSucceeded(req), data: { sessions: [], extra: 1 } }, req)).toThrow()
    const badOrder = { ...makeSucceeded(req), data: { sessions: [{ id: "ses_abc", directory: "/tmp", title: "t", updated: 7 }] }, ordering: "updated-desc" }
    expect(() => validateSessionListResult(badOrder, req)).toThrow()
    const amb = makeSessionListAmbiguous(req)
    expect(() => validateSessionListResult(amb, req)).not.toThrow()
    const wire = normalizePrivateSessionListWire(makeSucceeded(req), req)
    expect(wire.kind).toBe("valid")
    expect(normalizePrivateSessionListWire(makeSucceededCursor(req, 42), req).kind).toBe("valid")
    expect(normalizePrivateSessionListWire(makeSucceededCursor(req, "42"), req).kind).toBe("invalid")
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

  test("parity compares cursor presence/value for the same request without ordering claims", () => {
    const req = validateSessionListContractRequest(makeReq())
    const noCursor = validateSessionListResult(makeSucceeded(req), req)
    // Both sides absent: match.
    expect(compareSessionListParity(noCursor, sdkWithCursor([{ id: "ses_abc", directory: "/tmp", title: "t" }], null)).divergence).toBeNull()
    // Both sides present with equal value: match.
    const withCursor = validateSessionListResult(makeSucceededCursor(req, 7), req)
    expect(compareSessionListParity(withCursor, sdkWithCursor([{ id: "ses_abc", directory: "/tmp", title: "t" }], "7")).divergence).toBeNull()
    // Presence mismatch: divergence without cursor values in details.
    const presence = compareSessionListParity(withCursor, sdkWithCursor([{ id: "ses_abc", directory: "/tmp", title: "t" }], null))
    expect(presence.divergence).toBe("session-list-cursor-mismatch")
    expect(JSON.stringify(presence.details).includes("7")).toBeFalse()
    const presenceOther = compareSessionListParity(noCursor, sdkWithCursor([{ id: "ses_abc", directory: "/tmp", title: "t" }], "9"))
    expect(presenceOther.divergence).toBe("session-list-cursor-mismatch")
    expect(JSON.stringify(presenceOther.details).includes("9")).toBeFalse()
    // Value mismatch: divergence without cursor values in details.
    const value = compareSessionListParity(withCursor, sdkWithCursor([{ id: "ses_abc", directory: "/tmp", title: "t" }], "8"))
    expect(value.divergence).toBe("session-list-cursor-mismatch")
    expect(JSON.stringify(value.details).includes("secret")).toBeFalse()
    expect((value.details as Record<string, unknown>).orderingUnknown).toBe(true)
    expect((value.details as Record<string, unknown>).freshnessUnknown).toBe(true)
    expect((value.details as Record<string, unknown>).lifecycleUnknown).toBe(true)
  })

  test("malformed present SDK cursor is invalid diagnostic, never absent parity", () => {
    const req = validateSessionListContractRequest(makeReq())
    const noCursor = validateSessionListResult(makeSucceeded(req), req)
    const withCursor = validateSessionListResult(makeSucceededCursor(req, 7), req)
    const items = [{ id: "ses_abc", directory: "/tmp", title: "t" }]
    for (const bad of ["not-a-number", "NaN", "-1", "Infinity", "", " ", "   ", "\t\n "]) {
      const a = compareSessionListParity(noCursor, sdkWithCursor(items, bad))
      expect(a.divergence).toBe("session-list-cursor-invalid")
      if (bad.length > 0) expect(JSON.stringify(a.details).includes(bad.trim().length > 0 ? bad : JSON.stringify(bad))).toBeFalse()
      expect((a.details as Record<string, unknown>).invalid).toBe(true)
      const b = compareSessionListParity(withCursor, sdkWithCursor(items, bad))
      expect(b.divergence).toBe("session-list-cursor-invalid")
      if (bad.length > 0) expect(JSON.stringify(b.details).includes(bad.trim().length > 0 ? bad : JSON.stringify(bad))).toBeFalse()
      expect(JSON.stringify(b.details).includes("7")).toBeFalse()
    }
    const numericBad = {
      data: items,
      response: { status: 200, headers: { get: (k: string) => (k === "x-next-cursor" ? Number.NaN : null) } },
    }
    expect(compareSessionListParity(noCursor, numericBad).divergence).toBe("session-list-cursor-invalid")
    const throwing = {
      data: items,
      response: {
        status: 200,
        headers: {
          get: () => {
            throw new Error("header boom")
          },
        },
      },
    }
    expect(compareSessionListParity(noCursor, throwing).divergence).toBe("session-list-cursor-invalid")
  })
})
