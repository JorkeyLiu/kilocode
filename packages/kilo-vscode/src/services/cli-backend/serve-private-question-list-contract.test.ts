import { describe, expect, test } from "bun:test"
import {
  canonicalQuestionListOpId,
  isQuestionListValidationError,
  parseQuestionListOpId,
  QuestionListValidationError,
  validateQuestionListContractRequest,
  validateQuestionListEntries,
  validateQuestionListFailure,
  validateQuestionListResult,
} from "./serve-private-question-list-contract"

const DIR = "/tmp/work"

function entry(id: string, sessionID: string) {
  return {
    id,
    sessionID,
    questions: [{ question: "Proceed?", header: "Go", options: [{ label: "Yes", description: "Go" }] }],
    blocking: false,
    tool: undefined,
  }
}

function req() {
  const opId = canonicalQuestionListOpId("tok-list")
  return {
    v: 1 as const,
    requestId: "req-1",
    opId,
    op: "question/list" as const,
    idempotencyKey: opId,
    context: { directory: DIR },
    payload: {},
  }
}

function succeeded(r: Record<string, unknown>, items: unknown[]) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "question/list",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { questions: items },
  }
}

function failed(r: Record<string, unknown>, code: string, retryable: boolean) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "question/list",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable } },
    accepted: false,
    failure: { code, message: "m", retryable },
  }
}

describe("question-list contract", () => {
  test("opId binds colon-free token", () => {
    const opId = canonicalQuestionListOpId("tok")
    expect(opId).toBe("question-list:tok")
    expect(parseQuestionListOpId(opId)).toEqual({ token: "tok" })
    expect(() => canonicalQuestionListOpId("bad:tok")).toThrow()
    expect(() => canonicalQuestionListOpId("bad/tok")).toThrow()
  })

  test("request validates and rejects unknown fields", () => {
    const r = req()
    expect(validateQuestionListContractRequest(r)).toEqual(r)
    expect(() => validateQuestionListContractRequest({ ...r, extra: 1 })).toThrow()
    expect(() => validateQuestionListContractRequest({ ...r, payload: { filter: {} } })).toThrow()
    expect(() =>
      validateQuestionListContractRequest({ ...r, context: { directory: DIR, extra: 1 } }),
    ).toThrow()
  })

  test("entry shape validates Question.Request and rejects unknown directory trust", () => {
    const r = req() as unknown as Parameters<typeof validateQuestionListResult>[1]
    const good = succeeded(r as unknown as Record<string, unknown>, [entry("que_good00000000000000001", "ses_1")])
    expect(() => validateQuestionListResult(good, r)).not.toThrow()
    const badId = structuredClone(good) as unknown as Record<string, unknown>
    ;(badId.data as Record<string, unknown>).questions = [{ ...entry("que_good00000000000000001", "ses_1"), id: "bad" }]
    expect(() => validateQuestionListResult(badId, r)).toThrow()
    const badSession = structuredClone(good) as unknown as Record<string, unknown>
    ;(badSession.data as Record<string, unknown>).questions = [
      { ...entry("que_good00000000000000001", "ses_1"), sessionID: "bad" },
    ]
    expect(() => validateQuestionListResult(badSession, r)).toThrow()
    const withDir = structuredClone(good) as unknown as Record<string, unknown>
    ;(withDir.data as Record<string, unknown>).questions = [
      { ...entry("que_good00000000000000001", "ses_1"), directory: DIR } as unknown,
    ]
    expect(() => validateQuestionListResult(withDir, r)).toThrow()
  })

  test("entries helper rejects non-array and malformed option", () => {
    expect(() => validateQuestionListEntries("bad")).toThrow()
    expect(() =>
      validateQuestionListEntries([
        {
          id: "que_good00000000000000001",
          sessionID: "ses_1",
          questions: [{ question: "Q", header: "H", options: [{ label: "Yes" }] }],
        },
      ]),
    ).toThrow()
  })

  test("failure redacts sensitive carriers", () => {
    expect(() => validateQuestionListFailure({ code: "c", message: "m", retryable: false, directory: DIR })).toThrow()
    expect(() => validateQuestionListFailure({ code: "c", message: "m", retryable: false, sessionID: "ses_1" })).toThrow()
    expect(validateQuestionListFailure({ code: "validation.failed", message: "m", retryable: false })).toEqual({
      code: "validation.failed",
      message: "m",
      retryable: false,
    })
  })

  test("response identity mismatch throws", () => {
    const r = req() as unknown as Parameters<typeof validateQuestionListResult>[1]
    const good = succeeded(r as unknown as Record<string, unknown>, [])
    expect(() => validateQuestionListResult({ ...good, requestId: "other" }, r)).toThrow()
  })

  test("failed terminal and ambiguous shapes", () => {
    const r = req() as unknown as Parameters<typeof validateQuestionListResult>[1]
    const f = failed(r as unknown as Record<string, unknown>, "validation.failed", false)
    expect(() => validateQuestionListResult(f, r)).not.toThrow()
    const fence = failed(r as unknown as Record<string, unknown>, "InstanceUnavailableDuringConfigRebuild", true)
    expect(() => validateQuestionListResult(fence, r)).not.toThrow()
  })

  test("validation error brand is detectable", () => {
    expect(isQuestionListValidationError(new QuestionListValidationError("bad"))).toBeTrue()
    expect(isQuestionListValidationError({ kind: "other" })).toBeFalse()
  })
})
