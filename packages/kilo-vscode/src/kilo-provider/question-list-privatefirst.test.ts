import { describe, expect, test, spyOn } from "bun:test"
import {
  buildQuestionListIdentity,
  listQuestionsPrivateFirst,
  readQuestionsForDir,
} from "./question-privatefirst"
import {
  canonicalQuestionListOpId,
  isQuestionListValidationError,
  QuestionListValidationError,
  validateQuestionListContractRequest,
  validateQuestionListResult,
} from "../services/cli-backend/serve-private-question-list-contract"

const DIR = "/workspace/question-list-origin"

function entry(id: string, sessionID: string) {
  return {
    id,
    sessionID,
    questions: [{ question: "Proceed?", header: "Go", options: [{ label: "Yes", description: "Go" }] }],
    blocking: false,
    tool: undefined,
  }
}

function succeeded(req: Record<string, unknown>, items: unknown[]) {
  return {
    kind: "valid",
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "question/list",
      idempotencyKey: req.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { questions: items },
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
      op: "question/list",
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
      op: "question/list",
      idempotencyKey: req.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    },
  }
}

describe("question-list private-first", () => {
  test("validation error brand is detectable", () => {
    expect(isQuestionListValidationError(new QuestionListValidationError("bad"))).toBeTrue()
    expect(isQuestionListValidationError({ kind: "other" })).toBeFalse()
  })

  test("identity binds question-list token and validators accept it", () => {
    const ids = buildQuestionListIdentity()
    expect(ids.opId).toBe(ids.idempotencyKey)
    expect(ids.opId.startsWith("question-list:")).toBeTrue()
    const token = ids.opId.split(":")[1]!
    expect(canonicalQuestionListOpId(token)).toBe(ids.opId)
    const req = {
      v: 1,
      requestId: ids.requestId,
      opId: ids.opId,
      op: "question/list",
      idempotencyKey: ids.idempotencyKey,
      context: { directory: DIR },
      payload: {},
    }
    expect(() => validateQuestionListContractRequest(req)).not.toThrow()
  })

  test("strict request rejects unknown fields and non-empty payload", () => {
    const ids = buildQuestionListIdentity()
    const base = {
      v: 1,
      requestId: ids.requestId,
      opId: ids.opId,
      op: "question/list",
      idempotencyKey: ids.idempotencyKey,
      context: { directory: DIR },
      payload: {},
    }
    expect(() => validateQuestionListContractRequest({ ...base, extra: 1 })).toThrow()
    expect(() => validateQuestionListContractRequest({ ...base, payload: { filter: {} } })).toThrow()
    expect(() =>
      validateQuestionListContractRequest({ ...base, context: { directory: DIR, workspace: "w" } }),
    ).toThrow()
  })

  test("full entry shape validated and directory never trusted from payload", () => {
    const ids = buildQuestionListIdentity()
    const req = {
      v: 1,
      requestId: ids.requestId,
      opId: ids.opId,
      op: "question/list",
      idempotencyKey: ids.idempotencyKey,
      context: { directory: DIR },
      payload: {},
    } as unknown as Parameters<typeof validateQuestionListResult>[1]
    const good = {
      v: 1,
      requestId: ids.requestId,
      opId: ids.opId,
      op: "question/list",
      idempotencyKey: ids.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { questions: [entry("que_good00000000000000001", "ses_1")] },
    }
    expect(() => validateQuestionListResult(good, req)).not.toThrow()
    const badId = structuredClone(good) as unknown as Record<string, unknown>
    const data = badId.data as Record<string, unknown>
    data.questions = [{ ...entry("que_good00000000000000001", "ses_1"), id: "bad" }]
    expect(() => validateQuestionListResult(badId, req)).toThrow()
    const badSession = structuredClone(good) as unknown as Record<string, unknown>
    ;(badSession.data as Record<string, unknown>).questions = [
      { ...entry("que_good00000000000000001", "ses_1"), sessionID: "bad" },
    ]
    expect(() => validateQuestionListResult(badSession, req)).toThrow()
    const withDir = structuredClone(good) as unknown as Record<string, unknown>
    ;(withDir.data as Record<string, unknown>).questions = [
      { ...entry("que_good00000000000000001", "ses_1"), directory: DIR } as unknown,
    ]
    expect(() => validateQuestionListResult(withDir, req)).toThrow()
  })

  test("accepted success uses zero SDK including empty", async () => {
    for (const items of [[entry("que_ok000000000000000001", "ses_1")], []] as const) {
      let sdk = 0
      const conn = {
        isPrivateAvailable: () => true,
        privateQuestionListOutcomeWithHandle: (req: Record<string, unknown>) => ({
          id: 1,
          promise: Promise.resolve(succeeded(req, [...items])),
          cancel: () => true,
        }),
      } as unknown as Parameters<typeof listQuestionsPrivateFirst>[0]["connection"]
      const client = {
        question: {
          list: async () => {
            sdk += 1
            return { data: [], error: undefined }
          },
        },
      }
      const out = await readQuestionsForDir({ connection: conn, client, directory: DIR })
      expect(out.kind).toBe("ok")
      expect(sdk).toBe(0)
      if (out.kind === "ok") expect(out.items).toHaveLength(items.length)
    }
  })

  test("terminal non-retryable yields unknown with zero SDK, not known empty", async () => {
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateQuestionListOutcomeWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(failed(req, "validation.failed", false)),
        cancel: () => true,
      }),
    } as unknown as Parameters<typeof listQuestionsPrivateFirst>[0]["connection"]
    const client = {
      question: {
        list: async () => {
          sdk += 1
          return { data: [], error: undefined }
        },
      },
    }
    const out = await readQuestionsForDir({ connection: conn, client, directory: DIR })
    expect(out).toEqual({ kind: "unknown" })
    expect(sdk).toBe(0)
  })

  test("fallback-eligible takes exactly one SDK list, never retry", async () => {
    for (const mode of ["fence", "ambiguous", "invalid", "timeout", "unavailable"] as const) {
      let sdk = 0
      const conn =
        mode === "unavailable"
          ? ({ isPrivateAvailable: () => false } as unknown as Parameters<typeof listQuestionsPrivateFirst>[0]["connection"])
          : ({
              isPrivateAvailable: () => true,
              privateQuestionListOutcomeWithHandle: (req: Record<string, unknown>) => {
                if (mode === "fence") return { id: 1, promise: Promise.resolve(failed(req, "InstanceUnavailableDuringConfigRebuild", true)), cancel: () => true }
                if (mode === "ambiguous") return { id: 1, promise: Promise.resolve(vague(req)), cancel: () => true }
                if (mode === "invalid") return { id: 1, promise: Promise.resolve({ kind: "invalid", detail: "bad" }), cancel: () => true }
                return { id: 1, promise: Promise.reject(new Error("private parity timeout after 3000ms")), cancel: () => true }
              },
            } as unknown as Parameters<typeof listQuestionsPrivateFirst>[0]["connection"])
      const client = {
        question: {
          list: async (args: { directory: string }) => {
            sdk += 1
            expect(args.directory).toBe(DIR)
            return { data: [entry("que_sdk00000000000000001", "ses_1")], error: undefined }
          },
        },
      }
      const out = await readQuestionsForDir({ connection: conn, client, directory: DIR })
      expect(out.kind).toBe("ok")
      expect(sdk).toBe(1)
    }
  })

  test("timeout cancels the exact pending", async () => {
    const cancelled: string[] = []
    const conn = {
      isPrivateAvailable: () => true,
      privateQuestionListOutcomeWithHandle: () => ({
        id: 9,
        promise: Promise.reject(new Error("private parity timeout after 3000ms")),
        cancel: (msg?: string) => {
          cancelled.push(String(msg))
          return true
        },
      }),
    } as unknown as Parameters<typeof listQuestionsPrivateFirst>[0]["connection"]
    const client = { question: { list: async () => ({ data: [], error: undefined }) } }
    const out = await readQuestionsForDir({ connection: conn, client, directory: DIR })
    expect(out.kind).toBe("ok")
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]!.includes("question-list:")).toBeTrue()
  })

  test("response identity mismatch falls back, never trusts payload directory", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {})
    try {
      const conn = {
        isPrivateAvailable: () => true,
        privateQuestionListOutcomeWithHandle: (req: Record<string, unknown>) => ({
          id: 1,
          promise: Promise.resolve(succeeded({ ...req, requestId: "other" }, [])),
          cancel: () => true,
        }),
      } as unknown as Parameters<typeof listQuestionsPrivateFirst>[0]["connection"]
      let sdk = 0
      const client = {
        question: {
          list: async () => {
            sdk += 1
            return { data: [], error: undefined }
          },
        },
      }
      const out = await readQuestionsForDir({ connection: conn, client, directory: DIR })
      expect(out.kind).toBe("ok")
      expect(sdk).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})
