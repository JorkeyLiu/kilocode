import { describe, expect, test } from "bun:test"
import {
  canonicalQuestionOpId,
  makeQuestionAmbiguous,
  makeQuestionTerminalFailure,
  parseQuestionOpId,
  validateQuestionRejectContractRequest,
  validateQuestionReplyContractRequest,
  validateQuestionRejectResult,
  validateQuestionReplyResult,
  validateQuestionTerminalFailure,
} from "./serve-private-question-contract"

const DIR = "/tmp/work"
const RID = "que_contract000000000001"

function replyReq() {
  const token = "tok-reply"
  const opId = canonicalQuestionOpId(RID, token)
  return {
    v: 1 as const,
    requestId: "req-1",
    opId,
    op: "question/reply" as const,
    idempotencyKey: opId,
    context: { directory: DIR, requestID: RID },
    payload: { answers: [["Yes"], []] },
  }
}

function rejectReq() {
  const token = "tok-reject"
  const opId = canonicalQuestionOpId(RID, token)
  return {
    v: 1 as const,
    requestId: "req-2",
    opId,
    op: "question/reject" as const,
    idempotencyKey: opId,
    context: { directory: DIR, requestID: RID },
    payload: {},
  }
}

describe("question contract", () => {
  test("opId binds question tuple", () => {
    const opId = canonicalQuestionOpId(RID, "tok")
    expect(opId).toBe(`question:${RID}:tok`)
    expect(parseQuestionOpId(opId)).toEqual({ requestID: RID, token: "tok" })
  })

  test("reply request validates and rejects unknown fields", () => {
    const req = replyReq()
    expect(validateQuestionReplyContractRequest(req)).toEqual(req)
    expect(() => validateQuestionReplyContractRequest({ ...req, extra: 1 })).toThrow()
    expect(() => validateQuestionReplyContractRequest({ ...req, context: { ...req.context, extra: 1 } })).toThrow()
    expect(() => validateQuestionReplyContractRequest({ ...req, payload: { answers: "bad" } })).toThrow()
    expect(() => validateQuestionReplyContractRequest({ ...req, op: "question/reject" })).toThrow()
  })

  test("reject request validates empty payload", () => {
    const req = rejectReq()
    expect(validateQuestionRejectContractRequest(req)).toEqual(req)
    expect(() => validateQuestionRejectContractRequest({ ...req, payload: { answers: [] } })).toThrow()
    expect(() => validateQuestionRejectContractRequest({ ...req, op: "question/reply" })).toThrow()
  })

  test("reply terminal binds answers and identity", () => {
    const req = replyReq()
    const terminal = {
      kind: "terminal",
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      idempotencyKey: req.idempotencyKey,
      accepted: true,
      terminal: true,
      sessionID: "ses_root00000000000000001",
      requestID: RID,
      answers: [["Yes"], []],
    }
    expect(validateQuestionReplyResult(terminal, req)).toEqual(terminal)
    expect(() => validateQuestionReplyResult({ ...terminal, answers: [["No"], []] }, req)).toThrow()
    expect(() => validateQuestionReplyResult({ ...terminal, sessionID: "bad" }, req)).toThrow()
  })

  test("reject terminal binds identity without answers", () => {
    const req = rejectReq()
    const terminal = {
      kind: "terminal",
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      idempotencyKey: req.idempotencyKey,
      accepted: true,
      terminal: true,
      sessionID: "ses_root00000000000000001",
      requestID: RID,
    }
    expect(validateQuestionRejectResult(terminal, req)).toEqual(terminal)
    expect(() => validateQuestionRejectResult({ ...terminal, answers: [] }, req)).toThrow()
  })

  test("terminal-failure allows only question.not_found and scope_mismatch", () => {
    const req = replyReq()
    const failure = makeQuestionTerminalFailure(req, "question.not_found", 1)
    expect(failure.failure.code).toBe("question.not_found")
    expect(failure.accepted).toBeFalse()
    expect(failure.terminal).toBeTrue()
    expect(failure.sideEffect).toBeFalse()
    expect(validateQuestionTerminalFailure(failure, req)).toEqual(failure)
    const scoped = makeQuestionTerminalFailure(req, "scope_mismatch", 1)
    expect(validateQuestionTerminalFailure(scoped, req)).toEqual(scoped)
    expect(() =>
      validateQuestionTerminalFailure({ ...failure, failure: { code: "internal", retryable: false, time: 1 } }, req),
    ).toThrow()
    expect(() =>
      validateQuestionTerminalFailure({ ...failure, failure: { code: "question.not_found", retryable: true, time: 1 } }, req),
    ).toThrow()
  })

  test("ambiguous carries transportUnknown", () => {
    const req = replyReq()
    const vague = makeQuestionAmbiguous(req)
    expect(vague.kind).toBe("ambiguous")
    expect(vague.transportUnknown).toBeTrue()
    expect(vague.accepted).toBeFalse()
    expect(vague.terminal).toBeFalse()
  })

  test("null byte opId fails on both validators", () => {
    const req = replyReq()
    const badToken = "tok\0bad"
    expect(() => canonicalQuestionOpId(RID, badToken)).toThrow()
    expect(() => parseQuestionOpId(`question:${RID}:${badToken}`)).toThrow()
    expect(() => parseQuestionOpId(`question:${RID}:tok\0`)).toThrow()
    const badReq = { ...req, opId: `question:${RID}:tok\0`, idempotencyKey: `question:${RID}:tok\0` }
    expect(() => validateQuestionReplyContractRequest(badReq)).toThrow()
    const badRid = { ...req, context: { ...req.context, requestID: `que_bad\0` } }
    expect(() => validateQuestionReplyContractRequest(badRid)).toThrow()
    const badId = { ...req, requestId: "req\0bad" }
    expect(() => validateQuestionReplyContractRequest(badId)).toThrow()
  })
})
