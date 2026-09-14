import { describe, expect, test } from "bun:test"
import {
  canonicalNotebookListOpId,
  isNotebookListValidationError,
  NotebookListValidationError,
  parseNotebookListOpId,
  validateNotebookListContractRequest,
  validateNotebookListEntries,
  validateNotebookListFailure,
  validateNotebookListResult,
} from "./serve-private-notebook-list-contract"

const DIR = "/tmp/work"

function entry(id: string, sessionID: string) {
  return { id, sessionID, operation: "read", path: "b.ipynb", includeOutputs: true }
}

function req() {
  const opId = canonicalNotebookListOpId("tok-list")
  return {
    v: 1 as const,
    requestId: "req-1",
    opId,
    op: "notebook/list" as const,
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
    op: "notebook/list",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { notebooks: items },
  }
}

function failed(r: Record<string, unknown>, code: string, retryable: boolean) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "notebook/list",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable } },
    accepted: false,
    failure: { code, message: "m", retryable },
  }
}

describe("notebook-list contract", () => {
  test("opId binds colon-free token", () => {
    const opId = canonicalNotebookListOpId("tok")
    expect(opId).toBe("notebook-list:tok")
    expect(parseNotebookListOpId(opId)).toEqual({ token: "tok" })
    expect(() => canonicalNotebookListOpId("bad:tok")).toThrow()
    expect(() => canonicalNotebookListOpId("bad/tok")).toThrow()
  })

  test("request validates and rejects unknown fields", () => {
    const r = req()
    expect(validateNotebookListContractRequest(r)).toEqual(r)
    expect(() => validateNotebookListContractRequest({ ...r, extra: 1 })).toThrow()
    expect(() => validateNotebookListContractRequest({ ...r, payload: { filter: {} } })).toThrow()
    expect(() => validateNotebookListContractRequest({ ...r, context: { directory: DIR, extra: 1 } })).toThrow()
  })

  test("entry shape validates pending requests and never carries cell material", () => {
    const r = req() as unknown as Parameters<typeof validateNotebookListResult>[1]
    const good = succeeded(r as unknown as Record<string, unknown>, [entry("nbr_good0000000000001", "ses_1")])
    expect(() => validateNotebookListResult(good, r)).not.toThrow()
    const badId = structuredClone(good) as unknown as Record<string, unknown>
    ;(badId.data as Record<string, unknown>).notebooks = [{ ...entry("nbr_good0000000000001", "ses_1"), id: "bad" }]
    expect(() => validateNotebookListResult(badId, r)).toThrow()
    const badSession = structuredClone(good) as unknown as Record<string, unknown>
    ;(badSession.data as Record<string, unknown>).notebooks = [
      { ...entry("nbr_good0000000000001", "ses_1"), sessionID: "bad" },
    ]
    expect(() => validateNotebookListResult(badSession, r)).toThrow()
    for (const field of ["cells", "source", "outputs", "result", "cell"]) {
      const withCells = structuredClone(good) as unknown as Record<string, unknown>
      ;(withCells.data as Record<string, unknown>).notebooks = [
        { ...entry("nbr_good0000000000001", "ses_1"), [field]: [] },
      ]
      expect(() => validateNotebookListResult(withCells, r)).toThrow()
    }
  })

  test("entries helper rejects non-array and malformed operation", () => {
    expect(() => validateNotebookListEntries("bad")).toThrow()
    expect(() =>
      validateNotebookListEntries([{ id: "nbr_good0000000000001", sessionID: "ses_1", operation: "bake" }]),
    ).toThrow()
  })

  test("failure redacts sensitive carriers", () => {
    expect(() => validateNotebookListFailure({ code: "c", message: "m", retryable: false, directory: DIR })).toThrow()
    expect(() =>
      validateNotebookListFailure({ code: "c", message: "m", retryable: false, requestID: "nbr_1" }),
    ).toThrow()
    expect(validateNotebookListFailure({ code: "validation.failed", message: "m", retryable: false })).toEqual({
      code: "validation.failed",
      message: "m",
      retryable: false,
    })
  })

  test("response identity mismatch throws", () => {
    const r = req() as unknown as Parameters<typeof validateNotebookListResult>[1]
    const good = succeeded(r as unknown as Record<string, unknown>, [])
    expect(() => validateNotebookListResult({ ...good, requestId: "other" }, r)).toThrow()
  })

  test("failed terminal and ambiguous shapes", () => {
    const r = req() as unknown as Parameters<typeof validateNotebookListResult>[1]
    const f = failed(r as unknown as Record<string, unknown>, "validation.failed", false)
    expect(() => validateNotebookListResult(f, r)).not.toThrow()
    const fence = failed(r as unknown as Record<string, unknown>, "InstanceUnavailableDuringConfigRebuild", true)
    expect(() => validateNotebookListResult(fence, r)).not.toThrow()
  })

  test("validation error brand is detectable", () => {
    expect(isNotebookListValidationError(new NotebookListValidationError("bad"))).toBeTrue()
    expect(isNotebookListValidationError({ kind: "other" })).toBeFalse()
  })
})
