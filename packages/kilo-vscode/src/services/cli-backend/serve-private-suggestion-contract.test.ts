import { describe, expect, test } from "bun:test"
import {
  canonicalSuggestionOpId,
  isSettledSuggestionResult,
  makeSuggestionAmbiguous,
  makeSuggestionTerminalFailure,
  parseSuggestionOpId,
  validateSuggestionAcceptContractRequest,
  validateSuggestionAcceptResult,
  validateSuggestionDismissContractRequest,
  validateSuggestionDismissResult,
  validateSuggestionTerminalFailure,
} from "./serve-private-suggestion-contract"

const DIR = "/tmp/work"
const RID = "sug_contract000000000001"

function acceptReq() {
  const token = "tok-accept"
  const opId = canonicalSuggestionOpId(RID, token)
  return {
    v: 1 as const,
    requestId: "req-1",
    opId,
    op: "suggestion/accept" as const,
    idempotencyKey: opId,
    context: { directory: DIR, requestID: RID },
    payload: { index: 1 },
  }
}

function dismissReq() {
  const token = "tok-dismiss"
  const opId = canonicalSuggestionOpId(RID, token)
  return {
    v: 1 as const,
    requestId: "req-2",
    opId,
    op: "suggestion/dismiss" as const,
    idempotencyKey: opId,
    context: { directory: DIR, requestID: RID },
    payload: {},
  }
}

describe("suggestion contract", () => {
  test("opId binds suggestion tuple", () => {
    const opId = canonicalSuggestionOpId(RID, "tok")
    expect(opId).toBe(`suggestion:${RID}:tok`)
    expect(parseSuggestionOpId(opId)).toEqual({ requestID: RID, token: "tok" })
    expect(() => canonicalSuggestionOpId("que_bad", "tok")).toThrow()
    expect(() => canonicalSuggestionOpId(RID, "a:b")).toThrow()
    expect(() => canonicalSuggestionOpId(RID, "a/b")).toThrow()
  })

  test("accept request validates index and rejects unknown fields", () => {
    const req = acceptReq()
    expect(validateSuggestionAcceptContractRequest(req)).toEqual(req)
    expect(() => validateSuggestionAcceptContractRequest({ ...req, extra: 1 })).toThrow()
    expect(() => validateSuggestionAcceptContractRequest({ ...req, context: { ...req.context, extra: 1 } })).toThrow()
    expect(() => validateSuggestionAcceptContractRequest({ ...req, payload: { index: -1 } })).toThrow()
    expect(() => validateSuggestionAcceptContractRequest({ ...req, payload: {} })).toThrow()
    expect(() => validateSuggestionAcceptContractRequest({ ...req, op: "suggestion/dismiss" })).toThrow()
  })

  test("dismiss request validates empty payload", () => {
    const req = dismissReq()
    expect(validateSuggestionDismissContractRequest(req)).toEqual(req)
    expect(() => validateSuggestionDismissContractRequest({ ...req, payload: { index: 0 } })).toThrow()
    expect(() => validateSuggestionDismissContractRequest({ ...req, op: "suggestion/accept" })).toThrow()
  })

  test("accept terminal binds index/action and identity", () => {
    const req = acceptReq()
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
      index: 1,
      action: { label: "Run", prompt: "Run tests" },
    }
    expect(validateSuggestionAcceptResult(terminal, req)).toEqual(terminal)
    expect(() => validateSuggestionAcceptResult({ ...terminal, index: 0 }, req)).toThrow()
    expect(() => validateSuggestionAcceptResult({ ...terminal, requestID: "sug_other" }, req)).toThrow()
    expect(() => validateSuggestionAcceptResult({ ...terminal, action: { label: "", prompt: "x" } }, req)).toThrow()
  })

  test("dismiss terminal binds identity", () => {
    const req = dismissReq()
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
    expect(validateSuggestionDismissResult(terminal, req)).toEqual(terminal)
    expect(() => validateSuggestionDismissResult({ ...terminal, requestID: "sug_other" }, req)).toThrow()
  })

  test("terminal-failure allows only suggestion.not_found and scope_mismatch", () => {
    const req = acceptReq()
    const failure = makeSuggestionTerminalFailure(req, "suggestion.not_found", 7)
    expect(failure.failure.code).toBe("suggestion.not_found")
    expect(validateSuggestionTerminalFailure(failure, req)).toEqual(failure)
    const scope = makeSuggestionTerminalFailure(req, "scope_mismatch", 7)
    expect(validateSuggestionTerminalFailure(scope, req)).toEqual(scope)
    expect(() =>
      validateSuggestionTerminalFailure({ ...failure, failure: { code: "internal", retryable: false, time: 7 } }, req),
    ).toThrow()
  })

  test("ambiguous and settled predicates follow question semantics", () => {
    const req = acceptReq()
    const vague = makeSuggestionAmbiguous(req)
    expect(vague.kind).toBe("ambiguous")
    expect(isSettledSuggestionResult(vague, req)).toBeFalse()
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
      index: 1,
      action: { label: "Run", prompt: "Run tests" },
    }
    expect(isSettledSuggestionResult(terminal, req)).toBeTrue()
    expect(isSettledSuggestionResult(makeSuggestionTerminalFailure(req, "suggestion.not_found", 1), req)).toBeTrue()
  })
})
