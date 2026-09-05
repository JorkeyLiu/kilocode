import { describe, expect, test } from "bun:test"
import {
  assertGenerationNotRequestIdentity,
  canonicalAbortOpId,
  checkAbortScope,
  isAbortReceipt,
  isAbortTerminal,
  makeAbortReceipt,
  makeAbortTerminalFixture,
  parseAbortOpId,
  validateAbortContractRequest,
  validateAffectedGeneration,
} from "./serve-private-abort-contract"

const SID = "ses_abort00000000000000001"
const OTHER = "ses_other00000000000000001"

function makeReq(over: Record<string, unknown> = {}) {
  const opId = canonicalAbortOpId(SID, "tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "session/abort" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp", sessionId: SID },
    payload: {},
    ...over,
  }
}

describe("B9 abort cancellation-request identity envelope contract", () => {
  test("canonicalAbortOpId binds session and token with colon-free grammar", () => {
    expect(canonicalAbortOpId(SID, "t1")).toBe(`abort:${SID}:t1`)
    expect(() => canonicalAbortOpId(SID, "")).toThrow()
    expect(() => canonicalAbortOpId(SID, "a:b")).toThrow()
    expect(() => canonicalAbortOpId("", "t1")).toThrow()
    expect(() => canonicalAbortOpId("ses:a", "t1")).toThrow()
    expect(parseAbortOpId(canonicalAbortOpId(SID, "t1"))).toEqual({ sessionId: SID, token: "t1" })
    expect(() => parseAbortOpId(`get:${SID}:t1`)).toThrow()
  })

  test("validateAbortContractRequest enforces v1 envelope with idempotency equality", () => {
    const req = makeReq()
    expect(() => validateAbortContractRequest(req)).not.toThrow()
    const out = validateAbortContractRequest(req)
    expect(out.opId).toBe(canonicalAbortOpId(SID, "tok1"))
    expect(out.idempotencyKey).toBe(out.opId)
    expect(() => validateAbortContractRequest({ ...req, v: 2 })).toThrow()
    expect(() => validateAbortContractRequest({ ...req, idempotencyKey: canonicalAbortOpId(SID, "other") })).toThrow()
    expect(() =>
      validateAbortContractRequest({ ...req, opId: canonicalAbortOpId(OTHER, "tok1") }),
    ).toThrow()
    expect(() =>
      validateAbortContractRequest({ ...req, context: { directory: "relative", sessionId: SID } }),
    ).toThrow()
    expect(() =>
      validateAbortContractRequest({ ...req, context: { directory: "/tmp", sessionId: "bad" } }),
    ).toThrow()
    expect(() => validateAbortContractRequest({ ...req, payload: { reason: "x" } })).toThrow()
    expect(() => validateAbortContractRequest({ ...req, extra: 1 })).toThrow()
    expect(() =>
      validateAbortContractRequest({
        ...req,
        opId: `abort:${SID}:a:b`,
        idempotencyKey: `abort:${SID}:a:b`,
      }),
    ).toThrow()
  })

  test("directory conflict yields scope_mismatch including canonical spellings", () => {
    const req = validateAbortContractRequest(makeReq())
    const same = checkAbortScope(req, { directory: "/tmp", sessionId: SID, token: "tok1" })
    expect(same).toEqual({ ok: true })
    // Canonical spelling agrees: trailing slash normalizes to the same dir.
    const canon = checkAbortScope(req, { directory: "/tmp/", sessionId: SID, token: "tok1" })
    expect(canon).toEqual({ ok: true })
    const other = checkAbortScope(req, { directory: "/other", sessionId: SID, token: "tok1" })
    expect(other).toEqual({ ok: false, code: "scope_mismatch", which: "directory" })
  })

  test("session conflict yields scope_mismatch", () => {
    const req = validateAbortContractRequest(makeReq())
    const mismatch = checkAbortScope(req, { directory: "/tmp", sessionId: OTHER, token: "tok1" })
    expect(mismatch).toEqual({ ok: false, code: "scope_mismatch", which: "session" })
  })

  test("request-identity conflict yields scope_mismatch", () => {
    const req = validateAbortContractRequest(makeReq())
    const mismatch = checkAbortScope(req, { directory: "/tmp", sessionId: SID, token: "tok2" })
    expect(mismatch).toEqual({ ok: false, code: "scope_mismatch", which: "request" })
  })

  test("generation identity stays affected-set association and cannot replace request identity", () => {
    const req = validateAbortContractRequest(makeReq())
    const affected = [
      { kind: "generation" as const, generationId: "gen_001", sessionId: SID },
      { kind: "generation" as const, generationId: "gen_002", sessionId: SID },
    ]
    for (const ref of affected) expect(() => validateAffectedGeneration(ref)).not.toThrow()
    expect(() => assertGenerationNotRequestIdentity(req, affected)).not.toThrow()
    // Supplying a generation identity as the request token is rejected.
    const genOpId = canonicalAbortOpId(SID, "gen_001")
    const genReq = validateAbortContractRequest(
      makeReq({ opId: genOpId, idempotencyKey: genOpId }),
    )
    expect(() => assertGenerationNotRequestIdentity(genReq, affected)).toThrow(
      "generation identity must not be the abort request identity",
    )
    // Affected refs never carry the request op shape themselves.
    for (const ref of affected) {
      expect("opId" in ref).toBeFalse()
      expect("requestId" in ref).toBeFalse()
    }
  })

  test("receipt and terminal convergence are distinct contract shapes", () => {
    const req = validateAbortContractRequest(makeReq())
    const receipt = makeAbortReceipt(req)
    const terminal = makeAbortTerminalFixture(req, [
      { kind: "generation", generationId: "gen_001", sessionId: SID },
    ])
    expect(isAbortReceipt(receipt)).toBeTrue()
    expect(isAbortTerminal(receipt)).toBeFalse()
    expect(isAbortTerminal(terminal)).toBeTrue()
    expect(isAbortReceipt(terminal)).toBeFalse()
    expect(receipt.terminal).toBeFalse()
    expect(terminal.terminal).toBeTrue()
    expect(receipt.kind).not.toBe(terminal.kind)
    // Receipt carries no outcome aggregation; terminal carries the affected set.
    expect("affected" in receipt).toBeFalse()
    expect(terminal.affected.length).toBe(1)
    expect(terminal.opId).toBe(req.opId)
    expect(receipt.opId).toBe(req.opId)
  })
})
