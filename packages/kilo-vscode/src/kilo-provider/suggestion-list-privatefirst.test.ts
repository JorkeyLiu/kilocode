import { describe, expect, test, spyOn } from "bun:test"
import {
  buildSuggestionListIdentity,
  listSuggestionsPrivateFirst,
  readSuggestionsForDir,
} from "./suggestion-privatefirst"
import {
  canonicalSuggestionListOpId,
  isSuggestionListValidationError,
  SuggestionListValidationError,
  validateSuggestionListContractRequest,
  validateSuggestionListResult,
} from "../services/cli-backend/serve-private-suggestion-list-contract"

const DIR = "/workspace/suggestion-list-origin"

function entry(id: string, sessionID: string) {
  return {
    id,
    sessionID,
    text: "Run tests?",
    actions: [{ label: "Run", prompt: "Run the test suite" }],
  }
}

function succeeded(req: Record<string, unknown>, items: unknown[]) {
  return {
    kind: "valid",
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "suggestion/list",
      idempotencyKey: req.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { suggestions: items },
    },
  }
}

function failed(req: Record<string, unknown>, code: string, retryable: boolean) {
  return {
    kind: "valid",
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "suggestion/list",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable } },
      accepted: false,
      failure: { code, message: "m", retryable },
    },
  }
}

function vague(req: Record<string, unknown>) {
  return {
    kind: "valid",
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "suggestion/list",
      idempotencyKey: req.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    },
  }
}

describe("suggestion-list private-first", () => {
  test("validation error brand is detectable", () => {
    expect(isSuggestionListValidationError(new SuggestionListValidationError("bad"))).toBeTrue()
    expect(isSuggestionListValidationError({ kind: "other" })).toBeFalse()
  })

  test("identity binds suggestion-list token and validators accept it", () => {
    const ids = buildSuggestionListIdentity()
    expect(ids.opId).toBe(ids.idempotencyKey)
    expect(ids.opId.startsWith("suggestion-list:")).toBeTrue()
    const token = ids.opId.split(":")[1]!
    expect(canonicalSuggestionListOpId(token)).toBe(ids.opId)
    const req = {
      v: 1,
      requestId: ids.requestId,
      opId: ids.opId,
      op: "suggestion/list",
      idempotencyKey: ids.idempotencyKey,
      context: { directory: DIR },
      payload: {},
    }
    expect(() => validateSuggestionListContractRequest(req)).not.toThrow()
  })

  test("strict request rejects unknown fields and non-empty payload", () => {
    const ids = buildSuggestionListIdentity()
    const base = {
      v: 1,
      requestId: ids.requestId,
      opId: ids.opId,
      op: "suggestion/list",
      idempotencyKey: ids.idempotencyKey,
      context: { directory: DIR },
      payload: {},
    }
    expect(() => validateSuggestionListContractRequest({ ...base, extra: 1 })).toThrow()
    expect(() => validateSuggestionListContractRequest({ ...base, payload: { filter: {} } })).toThrow()
    expect(() =>
      validateSuggestionListContractRequest({ ...base, context: { directory: DIR, workspace: "w" } }),
    ).toThrow()
  })

  test("full entry shape validated and directory never trusted from payload", () => {
    const ids = buildSuggestionListIdentity()
    const req = {
      v: 1,
      requestId: ids.requestId,
      opId: ids.opId,
      op: "suggestion/list",
      idempotencyKey: ids.idempotencyKey,
      context: { directory: DIR },
      payload: {},
    } as unknown as Parameters<typeof validateSuggestionListResult>[1]
    const good = {
      v: 1,
      requestId: ids.requestId,
      opId: ids.opId,
      op: "suggestion/list",
      idempotencyKey: ids.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { suggestions: [entry("sug_good00000000000000001", "ses_1")] },
    }
    expect(() => validateSuggestionListResult(good, req)).not.toThrow()
    const badId = structuredClone(good) as unknown as Record<string, unknown>
    const data = badId.data as Record<string, unknown>
    data.suggestions = [{ ...entry("sug_good00000000000000001", "ses_1"), id: "bad" }]
    expect(() => validateSuggestionListResult(badId, req)).toThrow()
    const badSession = structuredClone(good) as unknown as Record<string, unknown>
    ;(badSession.data as Record<string, unknown>).suggestions = [
      { ...entry("sug_good00000000000000001", "ses_1"), sessionID: "bad" },
    ]
    expect(() => validateSuggestionListResult(badSession, req)).toThrow()
    const withDir = structuredClone(good) as unknown as Record<string, unknown>
    ;(withDir.data as Record<string, unknown>).suggestions = [
      { ...entry("sug_good00000000000000001", "ses_1"), directory: DIR } as unknown,
    ]
    expect(() => validateSuggestionListResult(withDir, req)).toThrow()
  })

  test("accepted success uses zero SDK including empty", async () => {
    for (const items of [[entry("sug_ok000000000000000001", "ses_1")], []] as const) {
      let sdk = 0
      const conn = {
        isPrivateAvailable: () => true,
        privateSuggestionListOutcomeWithHandle: (req: Record<string, unknown>) => ({
          id: 1,
          promise: Promise.resolve(succeeded(req, [...items])),
          cancel: () => true,
        }),
      } as unknown as Parameters<typeof listSuggestionsPrivateFirst>[0]["connection"]
      const client = {
        suggestion: {
          list: async () => {
            sdk += 1
            return { data: [], error: undefined }
          },
        },
      }
      const out = await readSuggestionsForDir({ connection: conn, client, directory: DIR })
      expect(out.kind).toBe("ok")
      expect(sdk).toBe(0)
      if (out.kind === "ok") expect(out.items).toHaveLength(items.length)
    }
  })

  test("nonretryable failure falls back to exactly one same-directory SDK list", async () => {
    for (const code of ["validation.failed", "scope_mismatch", "internal"] as const) {
      let sdk = 0
      let seenDir = ""
      const conn = {
        isPrivateAvailable: () => true,
        privateSuggestionListOutcomeWithHandle: (req: Record<string, unknown>) => ({
          id: 1,
          promise: Promise.resolve(failed(req, code, false)),
          cancel: () => true,
        }),
      } as unknown as Parameters<typeof listSuggestionsPrivateFirst>[0]["connection"]
      const client = {
        suggestion: {
          list: async (args: { directory: string }) => {
            sdk += 1
            seenDir = args.directory
            return { data: [entry("sug_sdk00000000000000001", "ses_1")], error: undefined }
          },
        },
      }
      const out = await readSuggestionsForDir({ connection: conn, client, directory: DIR })
      expect(out.kind).toBe("ok")
      expect(sdk).toBe(1)
      expect(seenDir).toBe(DIR)
      if (out.kind === "ok") expect(out.items).toHaveLength(1)
    }
  })

  test("SDK failure after private failure yields unknown", async () => {
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateSuggestionListOutcomeWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(failed(req, "validation.failed", false)),
        cancel: () => true,
      }),
    } as unknown as Parameters<typeof listSuggestionsPrivateFirst>[0]["connection"]
    const client = {
      suggestion: {
        list: async () => {
          sdk += 1
          throw new Error("sdk down")
        },
      },
    }
    const out = await readSuggestionsForDir({ connection: conn, client, directory: DIR })
    expect(out).toEqual({ kind: "unknown" })
    expect(sdk).toBe(1)
  })

  test("fallback-eligible takes exactly one SDK list, never retry", async () => {
    for (const mode of ["fence", "ambiguous", "invalid", "timeout", "unavailable"] as const) {
      let sdk = 0
      const conn =
        mode === "unavailable"
          ? ({ isPrivateAvailable: () => false } as unknown as Parameters<typeof listSuggestionsPrivateFirst>[0]["connection"])
          : ({
              isPrivateAvailable: () => true,
              privateSuggestionListOutcomeWithHandle: (req: Record<string, unknown>) => {
                if (mode === "fence") return { id: 1, promise: Promise.resolve(failed(req, "InstanceUnavailableDuringConfigRebuild", true)), cancel: () => true }
                if (mode === "ambiguous") return { id: 1, promise: Promise.resolve(vague(req)), cancel: () => true }
                if (mode === "invalid") return { id: 1, promise: Promise.resolve({ kind: "invalid", detail: "bad" }), cancel: () => true }
                return { id: 1, promise: Promise.reject(new Error("private parity timeout after 3000ms")), cancel: () => true }
              },
            } as unknown as Parameters<typeof listSuggestionsPrivateFirst>[0]["connection"])
      const client = {
        suggestion: {
          list: async (args: { directory: string }) => {
            sdk += 1
            expect(args.directory).toBe(DIR)
            return { data: [entry("sug_sdk00000000000000001", "ses_1")], error: undefined }
          },
        },
      }
      const out = await readSuggestionsForDir({ connection: conn, client, directory: DIR })
      expect(out.kind).toBe("ok")
      expect(sdk).toBe(1)
    }
  })

  test("timeout cancels the exact pending", async () => {
    const cancelled: string[] = []
    const conn = {
      isPrivateAvailable: () => true,
      privateSuggestionListOutcomeWithHandle: () => ({
        id: 9,
        promise: Promise.reject(new Error("private parity timeout after 3000ms")),
        cancel: (msg?: string) => {
          cancelled.push(String(msg))
          return true
        },
      }),
    } as unknown as Parameters<typeof listSuggestionsPrivateFirst>[0]["connection"]
    const client = { suggestion: { list: async () => ({ data: [], error: undefined }) } }
    const out = await readSuggestionsForDir({ connection: conn, client, directory: DIR })
    expect(out.kind).toBe("ok")
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]!.includes("suggestion-list:")).toBeTrue()
  })

  test("response identity mismatch falls back, never trusts payload directory", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {})
    try {
      const conn = {
        isPrivateAvailable: () => true,
        privateSuggestionListOutcomeWithHandle: (req: Record<string, unknown>) => ({
          id: 1,
          promise: Promise.resolve(succeeded({ ...req, requestId: "other" }, [])),
          cancel: () => true,
        }),
      } as unknown as Parameters<typeof listSuggestionsPrivateFirst>[0]["connection"]
      let sdk = 0
      const client = {
        suggestion: {
          list: async () => {
            sdk += 1
            return { data: [], error: undefined }
          },
        },
      }
      const out = await readSuggestionsForDir({ connection: conn, client, directory: DIR })
      expect(out.kind).toBe("ok")
      expect(sdk).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})
