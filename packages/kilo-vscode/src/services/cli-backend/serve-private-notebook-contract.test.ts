import { describe, expect, test } from "bun:test"
import {
  canonicalNotebookListOpId,
  canonicalNotebookOpId,
  makeNotebookAmbiguous,
  makeNotebookTerminalFailure,
  parseNotebookListOpId,
  parseNotebookOpId,
  validateNotebookListContractRequest,
  validateNotebookRejectContractRequest,
  validateNotebookRejectResult,
  validateNotebookReplyContractRequest,
  validateNotebookReplyResult,
  validateNotebookTerminalFailure,
} from "./serve-private-notebook-contract"

const RID = "nbr_abc123def456"
const DIR = "/workspace/origin"

function replyReq(opId: string, over: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    requestId: "req-1",
    opId,
    op: "notebook/reply" as const,
    idempotencyKey: opId,
    context: { directory: DIR, requestID: RID },
    payload: { result: { operation: "read", requestPath: "b.ipynb" } },
    ...over,
  }
}

function rejectReq(opId: string) {
  return {
    v: 1 as const,
    requestId: "req-2",
    opId,
    op: "notebook/reject" as const,
    idempotencyKey: opId,
    context: { directory: DIR, requestID: RID },
    payload: { error: { code: "timeout", message: "timed out" } },
  }
}

function terminalFor(req: Record<string, unknown>) {
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    sessionID: "ses_root1",
    requestID: (req.context as Record<string, unknown>).requestID,
  }
}

function failureFor(req: Record<string, unknown>, code = "notebook.not_found") {
  return {
    kind: "terminal-failure",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: true,
    failure: { code, retryable: false, time: 1 },
    sideEffect: false,
  }
}

describe("notebook contract", () => {
  test("opId builders bind request identity and reject path material", () => {
    const opId = canonicalNotebookOpId(RID, "tok")
    expect(opId).toBe(`notebook:${RID}:tok`)
    expect(parseNotebookOpId(opId)).toEqual({ requestID: RID, token: "tok" })
    expect(canonicalNotebookListOpId("t")).toBe("notebook-list:t")
    expect(parseNotebookListOpId("notebook-list:t")).toEqual({ token: "t" })
    expect(() => canonicalNotebookOpId("que_1", "tok")).toThrow()
    expect(() => canonicalNotebookOpId(RID, "a/b")).toThrow()
    expect(() => canonicalNotebookOpId(RID, "a:b")).toThrow()
    expect(() => parseNotebookOpId("suggestion:x:tok")).toThrow()
    expect(() => parseNotebookOpId(`notebook:${RID}`)).toThrow()
    expect(() => parseNotebookListOpId("notebook:t")).toThrow()
  })

  test("reply and reject accept strict envelopes", () => {
    const opId = canonicalNotebookOpId(RID, "tok")
    expect(() => validateNotebookReplyContractRequest(replyReq(opId))).not.toThrow()
    expect(() => validateNotebookRejectContractRequest(rejectReq(opId))).not.toThrow()
    expect(() =>
      validateNotebookListContractRequest({
        v: 1,
        requestId: "r",
        opId: "notebook-list:t",
        op: "notebook/list",
        idempotencyKey: "notebook-list:t",
        context: { directory: DIR },
        payload: {},
      }),
    ).not.toThrow()
  })

  test("envelopes reject op crossover, extra fields, and content-free payloads", () => {
    const opId = canonicalNotebookOpId(RID, "tok")
    expect(() => validateNotebookReplyContractRequest({ ...replyReq(opId), op: "notebook/reject" })).toThrow()
    expect(() => validateNotebookRejectContractRequest({ ...rejectReq(opId), op: "notebook/reply" })).toThrow()
    expect(() => validateNotebookReplyContractRequest({ ...replyReq(opId), extra: 1 })).toThrow()
    expect(() => validateNotebookReplyContractRequest({ ...replyReq(opId), payload: {} })).toThrow()
    expect(() => validateNotebookReplyContractRequest({ ...replyReq(opId), payload: { result: 42 } })).toThrow()
    expect(() =>
      validateNotebookReplyContractRequest({ ...replyReq(opId), payload: { result: { operation: "bake" } } }),
    ).toThrow()
    expect(() =>
      validateNotebookRejectContractRequest({ ...rejectReq(opId), payload: { error: { code: "x" } } }),
    ).toThrow()
    expect(() =>
      validateNotebookReplyContractRequest({
        ...replyReq(opId),
        context: { directory: DIR, requestID: "que_1" },
      }),
    ).toThrow()
    expect(() =>
      validateNotebookReplyContractRequest({ ...replyReq(opId), context: { directory: "relative" } }),
    ).toThrow()
    expect(() => validateNotebookReplyContractRequest({ ...replyReq(opId), idempotencyKey: "other" })).toThrow()
  })

  test("terminal bindings require exact identity with no echoed payload", () => {
    const req = replyReq(canonicalNotebookOpId(RID, "tok"))
    const parsed = validateNotebookReplyContractRequest(req)
    expect(() => validateNotebookReplyResult(terminalFor(req), parsed)).not.toThrow()
    const rej = rejectReq(canonicalNotebookOpId(RID, "tok2"))
    const parsedRej = validateNotebookRejectContractRequest(rej)
    expect(() => validateNotebookRejectResult(terminalFor(rej), parsedRej)).not.toThrow()
    expect(() => validateNotebookReplyResult({ ...terminalFor(req), requestID: "nbr_other1" }, parsed)).toThrow()
    expect(() => validateNotebookReplyResult({ ...terminalFor(req), answers: [] }, parsed)).toThrow()
    expect(() => validateNotebookReplyResult({ ...terminalFor(req), result: {} }, parsed)).toThrow()
  })

  test("terminal failures admit only the locked codes with retryable false", () => {
    const req = replyReq(canonicalNotebookOpId(RID, "tok"))
    const parsed = validateNotebookReplyContractRequest(req)
    for (const code of ["notebook.not_found", "notebook.invalid_reply", "scope_mismatch"]) {
      expect(() => validateNotebookTerminalFailure(failureFor(req, code), parsed)).not.toThrow()
    }
    expect(() => validateNotebookTerminalFailure(failureFor(req, "question.not_found"), parsed)).toThrow()
    expect(() =>
      validateNotebookTerminalFailure(
        { ...failureFor(req), failure: { code: "notebook.not_found", retryable: true, time: 1 } },
        parsed,
      ),
    ).toThrow()
    expect(makeNotebookTerminalFailure(parsed, "notebook.invalid_reply", 7).failure.code).toBe("notebook.invalid_reply")
    expect(makeNotebookAmbiguous(parsed).kind).toBe("ambiguous")
  })
})
