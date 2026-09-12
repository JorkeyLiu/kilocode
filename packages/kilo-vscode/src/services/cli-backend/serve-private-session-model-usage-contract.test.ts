import { describe, expect, test } from "bun:test"
import {
  canonicalSessionModelUsageOpId,
  checkSessionModelUsageScope,
  isSessionModelUsageValidationError,
  makeSessionModelUsageAmbiguous,
  normalizePrivateSessionModelUsageWire,
  parseSessionModelUsageOpId,
  SESSION_MODEL_USAGE_FAILED_CODE,
  SESSION_MODEL_USAGE_FAILED_MESSAGE,
  SESSION_MODEL_USAGE_INVALID_DETAIL,
  SessionModelUsageValidationError,
  validateSessionModelUsageContractRequest,
  validateSessionModelUsageFailure,
  validateSessionModelUsagePayload,
  validateSessionModelUsageResult,
} from "./serve-private-session-model-usage-contract"

const SID = "ses_abc123"
const DIR = "/tmp"

function makeReq(over: Record<string, unknown> = {}) {
  const opId = canonicalSessionModelUsageOpId(SID, "tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "session/model-usage" as const,
    idempotencyKey: opId,
    context: { directory: DIR, sessionId: SID },
    payload: {},
    ...over,
  }
}

function makeUsage(over: Record<string, unknown> = {}) {
  return {
    sessionIDs: [SID],
    totals: { steps: 2, cost: 1.5, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
    models: [
      {
        providerID: "prov-a",
        modelID: "model-x",
        steps: 2,
        cost: 1.5,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ],
    ...over,
  }
}

function makeSucceeded(req: ReturnType<typeof validateSessionModelUsageContractRequest>, over: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/model-usage" as const,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded" as const,
    outcome: { type: "succeeded" as const, time: 1 },
    accepted: true as const,
    data: { usage: makeUsage(over) },
  }
}

describe("sessionModelUsage private-first contract", () => {
  test("opId grammar binds sessionId with idempotency equality", () => {
    expect(canonicalSessionModelUsageOpId(SID, "t1")).toBe(`session-model-usage:${SID}:t1`)
    expect(() => canonicalSessionModelUsageOpId("", "t1")).toThrow()
    expect(() => canonicalSessionModelUsageOpId(SID, "")).toThrow()
    expect(() => canonicalSessionModelUsageOpId(SID, "a:b")).toThrow()
    expect(parseSessionModelUsageOpId(canonicalSessionModelUsageOpId(SID, "t1"))).toEqual({
      sessionId: SID,
      token: "t1",
    })
    expect(() => parseSessionModelUsageOpId("session-model-usage:t1")).toThrow()
    expect(() => parseSessionModelUsageOpId("session/model-usage:a:b")).toThrow()
  })

  test("request validation enforces v1 envelope with routing-only directory/sessionId and empty payload", () => {
    const req = makeReq()
    expect(() => validateSessionModelUsageContractRequest(req)).not.toThrow()
    expect(() => validateSessionModelUsageContractRequest({ ...req, v: 2 })).toThrow()
    expect(() => validateSessionModelUsageContractRequest({ ...req, op: "session/get" })).toThrow()
    expect(() =>
      validateSessionModelUsageContractRequest({
        ...req,
        idempotencyKey: canonicalSessionModelUsageOpId(SID, "other"),
      }),
    ).toThrow()
    expect(() =>
      validateSessionModelUsageContractRequest({ ...req, context: { directory: "relative", sessionId: SID } }),
    ).toThrow()
    expect(() =>
      validateSessionModelUsageContractRequest({ ...req, context: { directory: DIR, sessionId: "bad" } }),
    ).toThrow()
    expect(() =>
      validateSessionModelUsageContractRequest({
        ...req,
        context: { directory: DIR, sessionId: SID, workspace: "ws1" },
      }),
    ).toThrow()
    expect(() => validateSessionModelUsageContractRequest({ ...req, payload: { filter: {} } })).toThrow()
    expect(() => validateSessionModelUsageContractRequest({ ...req, extra: 1 })).toThrow()
  })

  test("opId session binding must match context sessionId", () => {
    const req = makeReq()
    expect(() =>
      validateSessionModelUsageContractRequest({
        ...req,
        opId: canonicalSessionModelUsageOpId("ses_other", "tok1"),
        idempotencyKey: canonicalSessionModelUsageOpId("ses_other", "tok1"),
      }),
    ).toThrow()
  })

  test("scope mismatch covers directory, session, and request", () => {
    const req = validateSessionModelUsageContractRequest(makeReq())
    expect(checkSessionModelUsageScope(req, { directory: "/tmp/", sessionId: SID, token: "tok1" })).toEqual({
      ok: true,
    })
    expect(checkSessionModelUsageScope(req, { directory: "/other", sessionId: SID, token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "directory",
    })
    expect(checkSessionModelUsageScope(req, { directory: DIR, sessionId: "ses_other", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "session",
    })
    expect(checkSessionModelUsageScope(req, { directory: DIR, sessionId: SID, token: "tok2" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "request",
    })
  })

  test("payload projection requires exactly sessionIDs/totals/models with numeric shapes", () => {
    expect(() => validateSessionModelUsagePayload(makeUsage())).not.toThrow()
    expect(() => validateSessionModelUsagePayload({ ...makeUsage(), totals: undefined })).toThrow()
    expect(() =>
      validateSessionModelUsagePayload({ ...makeUsage(), sessionIDs: ["bad"] }),
    ).toThrow()
    expect(() =>
      validateSessionModelUsagePayload({
        ...makeUsage(),
        totals: { steps: -1, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
      }),
    ).toThrow()
    expect(() =>
      validateSessionModelUsagePayload({
        ...makeUsage(),
        models: [{ providerID: 1, modelID: "m", steps: 0, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }],
      }),
    ).toThrow()
    // Authority (SDK/server ModelUsage.Info: ProviderV2.ID/ModelV2.ID are plain
    // branded strings) accepts empty-string IDs; shape-only must not add a
    // non-empty constraint beyond authority.
    expect(() =>
      validateSessionModelUsagePayload({
        ...makeUsage(),
        models: [{ providerID: "", modelID: "", steps: 0, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }],
      }),
    ).not.toThrow()
    expect(() => validateSessionModelUsagePayload({ ...makeUsage(), extra: 1 })).toThrow()
    expect(() =>
      validateSessionModelUsagePayload({ ...makeUsage(), totals: { ...(makeUsage().totals as object), prompt: "x" } }),
    ).toThrow()
  })

  test("extra sensitive fields are rejected from usage models", () => {
    const bad = makeUsage({
      models: [
        {
          providerID: "p",
          modelID: "m",
          steps: 1,
          cost: 0,
          tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          prompt: "secret",
        },
      ],
    })
    expect(() => validateSessionModelUsagePayload(bad)).toThrow()
  })

  test("failures are redacted; usage/session echo keys rejected", () => {
    expect(() =>
      validateSessionModelUsageFailure({ code: "x", message: "m", retryable: false }),
    ).not.toThrow()
    for (const key of ["sessionId", "sessionIDs", "totals", "models", "usage", "directory", "cost", "tokens"]) {
      expect(() =>
        validateSessionModelUsageFailure({ code: "x", message: "m", retryable: false, [key]: "raw" }),
      ).toThrow()
    }
    const req = validateSessionModelUsageContractRequest(makeReq())
    const failed = {
      v: 1 as const,
      requestId: req.requestId,
      opId: req.opId,
      op: "session/model-usage" as const,
      idempotencyKey: req.idempotencyKey,
      status: "failed" as const,
      outcome: {
        type: "failed" as const,
        time: 1,
        failure: { code: "upstream.boom", message: "raw detail", retryable: true },
      },
      accepted: false as const,
      failure: { code: "upstream.boom", message: "raw detail", retryable: true },
    }
    expect(() => validateSessionModelUsageResult(failed, req)).not.toThrow()
    const wire = normalizePrivateSessionModelUsageWire(failed, req)
    expect(wire.kind).toBe("valid")
    if (wire.kind === "valid" && wire.result.status === "failed") {
      expect(wire.result.failure.code).toBe(SESSION_MODEL_USAGE_FAILED_CODE)
      expect(wire.result.failure.message).toBe(SESSION_MODEL_USAGE_FAILED_MESSAGE)
      expect(wire.result.failure.retryable).toBeTrue()
      expect(wire.result.outcome.failure.code).toBe(SESSION_MODEL_USAGE_FAILED_CODE)
      expect(wire.result.outcome.failure.message).toBe(SESSION_MODEL_USAGE_FAILED_MESSAGE)
      expect(wire.result.outcome.failure.retryable).toBeTrue()
    } else {
      throw new Error("expected redacted failed wire")
    }
  })

  test("wire normalization separates invalid wire from normal failure; ambiguous validates", () => {
    const req = validateSessionModelUsageContractRequest(makeReq())
    const ok = validateSessionModelUsageResult(makeSucceeded(req), req)
    expect(normalizePrivateSessionModelUsageWire(makeSucceeded(req), req)).toEqual({ kind: "valid", result: ok })
    const invalid = normalizePrivateSessionModelUsageWire({ bogus: true }, req)
    expect(invalid).toEqual({ kind: "invalid", detail: SESSION_MODEL_USAGE_INVALID_DETAIL })
    if (invalid.kind === "invalid") {
      expect(new SessionModelUsageValidationError(invalid.detail)).toSatisfy((e) =>
        isSessionModelUsageValidationError(e),
      )
    }
    const amb = makeSessionModelUsageAmbiguous(req)
    expect(amb.status).toBe("ambiguous")
    expect(() => validateSessionModelUsageResult(amb, req)).not.toThrow()
    expect(() =>
      validateSessionModelUsageResult({ ...makeSucceeded(req), data: { usage: makeUsage() }, failure: { code: "x", message: "m", retryable: false } }, req),
    ).toThrow()
  })

  test("succeeded preserves exact usage shape", () => {
    const req = validateSessionModelUsageContractRequest(makeReq())
    const ok = validateSessionModelUsageResult(makeSucceeded(req), req)
    expect(ok.status).toBe("succeeded")
    if (ok.status === "succeeded") {
      expect(ok.data.usage.sessionIDs).toEqual([SID])
      expect(ok.data.usage.models).toHaveLength(1)
    }
  })
})
