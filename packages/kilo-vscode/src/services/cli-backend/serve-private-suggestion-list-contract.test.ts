import { describe, expect, test } from "bun:test"
import {
  canonicalSuggestionListOpId,
  isSuggestionListValidationError,
  parseSuggestionListOpId,
  SuggestionListValidationError,
  validateSuggestionListContractRequest,
  validateSuggestionListEntries,
  validateSuggestionListFailure,
  validateSuggestionListResult,
} from "./serve-private-suggestion-list-contract"

const DIR = "/tmp/work"

function entry(id: string, sessionID: string, over: Record<string, unknown> = {}) {
  return {
    id,
    sessionID,
    text: "Run tests?",
    actions: [{ label: "Run", prompt: "Run the test suite" }],
    ...over,
  }
}

function req() {
  const opId = canonicalSuggestionListOpId("tok-list")
  return {
    v: 1 as const,
    requestId: "req-1",
    opId,
    op: "suggestion/list" as const,
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
    op: "suggestion/list",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { suggestions: items },
  }
}

function failed(r: Record<string, unknown>, code: string, retryable: boolean) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "suggestion/list",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable } },
    accepted: false,
    failure: { code, message: "m", retryable },
  }
}

describe("suggestion-list contract", () => {
  test("opId binds colon-free token", () => {
    const opId = canonicalSuggestionListOpId("tok")
    expect(opId).toBe("suggestion-list:tok")
    expect(parseSuggestionListOpId(opId)).toEqual({ token: "tok" })
    expect(() => canonicalSuggestionListOpId("bad:tok")).toThrow()
    expect(() => canonicalSuggestionListOpId("bad/tok")).toThrow()
  })

  test("request validates and rejects unknown fields", () => {
    const r = req()
    expect(validateSuggestionListContractRequest(r)).toEqual(r)
    expect(() => validateSuggestionListContractRequest({ ...r, extra: 1 })).toThrow()
    expect(() => validateSuggestionListContractRequest({ ...r, payload: { filter: {} } })).toThrow()
    expect(() =>
      validateSuggestionListContractRequest({ ...r, context: { directory: DIR, extra: 1 } }),
    ).toThrow()
  })

  test("entry shape validates Suggestion.Request and rejects unknown directory trust", () => {
    const r = req() as unknown as Parameters<typeof validateSuggestionListResult>[1]
    const good = succeeded(r as unknown as Record<string, unknown>, [
      entry("sug_good00000000000000001", "ses_1"),
    ])
    expect(() => validateSuggestionListResult(good, r)).not.toThrow()
    const badId = structuredClone(good) as unknown as Record<string, unknown>
    ;(badId.data as Record<string, unknown>).suggestions = [{ ...entry("sug_good00000000000000001", "ses_1"), id: "bad" }]
    expect(() => validateSuggestionListResult(badId, r)).toThrow()
    const badSession = structuredClone(good) as unknown as Record<string, unknown>
    ;(badSession.data as Record<string, unknown>).suggestions = [
      { ...entry("sug_good00000000000000001", "ses_1"), sessionID: "bad" },
    ]
    expect(() => validateSuggestionListResult(badSession, r)).toThrow()
    const withDir = structuredClone(good) as unknown as Record<string, unknown>
    ;(withDir.data as Record<string, unknown>).suggestions = [
      { ...entry("sug_good00000000000000001", "ses_1"), directory: DIR } as unknown,
    ]
    expect(() => validateSuggestionListResult(withDir, r)).toThrow()
  })

  test("entry validates action/text/blocking/tool shapes and order preserved", () => {
    const r = req() as unknown as Parameters<typeof validateSuggestionListResult>[1]
    const items = [
      entry("sug_ord000000000000000001", "ses_1", { text: "First", blocking: false }),
      entry("sug_ord000000000000000002", "ses_1", {
        text: "Second",
        actions: [
          { label: "A", prompt: "Do A" },
          { label: "B", description: "Does B", prompt: "Do B" },
        ],
        blocking: true,
        tool: { messageID: "m1", callID: "c1" },
      }),
    ]
    const good = succeeded(r as unknown as Record<string, unknown>, items)
    expect(() => validateSuggestionListResult(good, r)).not.toThrow()
    const badActions = structuredClone(good) as unknown as Record<string, unknown>
    ;(badActions.data as Record<string, unknown>).suggestions = [
      { ...entry("sug_ord000000000000000001", "ses_1"), actions: [] },
    ]
    expect(() => validateSuggestionListResult(badActions, r)).toThrow()
    const badText = structuredClone(good) as unknown as Record<string, unknown>
    ;(badText.data as Record<string, unknown>).suggestions = [
      { ...entry("sug_ord000000000000000001", "ses_1"), text: "" },
    ]
    expect(() => validateSuggestionListResult(badText, r)).toThrow()
    const badTool = structuredClone(good) as unknown as Record<string, unknown>
    ;(badTool.data as Record<string, unknown>).suggestions = [
      { ...entry("sug_ord000000000000000001", "ses_1"), tool: { messageID: "m1" } },
    ]
    expect(() => validateSuggestionListResult(badTool, r)).toThrow()
  })

  test("entries helper rejects non-array and malformed action", () => {
    expect(() => validateSuggestionListEntries("bad")).toThrow()
    expect(() =>
      validateSuggestionListEntries([
        {
          id: "sug_good00000000000000001",
          sessionID: "ses_1",
          text: "Run tests?",
          actions: [{ label: "Run" }],
        },
      ]),
    ).toThrow()
  })

  test("failure redacts sensitive carriers", () => {
    expect(() => validateSuggestionListFailure({ code: "c", message: "m", retryable: false, directory: DIR })).toThrow()
    expect(() => validateSuggestionListFailure({ code: "c", message: "m", retryable: false, sessionID: "ses_1" })).toThrow()
    expect(() => validateSuggestionListFailure({ code: "c", message: "m", retryable: false, text: "t" })).toThrow()
    expect(validateSuggestionListFailure({ code: "validation.failed", message: "m", retryable: false })).toEqual({
      code: "validation.failed",
      message: "m",
      retryable: false,
    })
  })

  test("result identity mismatch rejected", () => {
    const r = req() as unknown as Parameters<typeof validateSuggestionListResult>[1]
    const good = succeeded(r as unknown as Record<string, unknown>, [])
    const mismatched = structuredClone(good) as unknown as Record<string, unknown>
    mismatched.requestId = "other"
    expect(() => validateSuggestionListResult(mismatched, r)).toThrow()
    const badOp = structuredClone(good) as unknown as Record<string, unknown>
    badOp.op = "question/list"
    expect(() => validateSuggestionListResult(badOp, r)).toThrow()
  })

  test("retryable fence stays retryable and nonretryable terminal distinct", () => {
    const r = req() as unknown as Parameters<typeof validateSuggestionListResult>[1]
    const fence = failed(r as unknown as Record<string, unknown>, "InstanceUnavailableDuringConfigRebuild", true)
    const out = validateSuggestionListResult(fence, r)
    if (out.status !== "failed") throw new Error("expected failed")
    expect(out.failure.retryable).toBeTrue()
    const terminal = failed(r as unknown as Record<string, unknown>, "validation.failed", false)
    const term = validateSuggestionListResult(terminal, r)
    if (term.status !== "failed") throw new Error("expected failed")
    expect(term.failure.retryable).toBeFalse()
  })

  test("validation error brand is detectable", () => {
    expect(isSuggestionListValidationError(new SuggestionListValidationError("bad"))).toBeTrue()
    expect(isSuggestionListValidationError({ kind: "other" })).toBeFalse()
  })
})
