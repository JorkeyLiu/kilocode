import { describe, expect, test } from "bun:test"
import {
  ABORT_TARGET_KINDS,
  assertAbortSuccessExcludesNotAffected,
  assertGenerationNotRequestIdentity,
  canonicalAbortOpId,
  checkAbortScope,
  countAbortCancelled,
  isAbortCancellationSuccess,
  isAbortNotFoundTerminal,
  isAbortReceipt,
  isAbortTerminal,
  makeAbortDispositionTerminal,
  makeAbortNotFoundFixture,
  makeAbortReceipt,
  makeAbortTerminalFixture,
  makeAbortTerminalFailure,
  parseAbortOpId,
  reobserveAbortTerminal,
  validateAbortContractRequest,
  validateAbortDiagnostic,
  validateAbortDispositionEntry,
  validateAbortDispositionTerminal,
  validateAbortNotFoundTerminal,
  validateAbortTerminalFailure,
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

describe("B9-P2.3 outcome disposition and terminal idempotency fixtures", () => {
  test("closed per-target kind vocabulary matches the locked set", () => {
    expect([...ABORT_TARGET_KINDS].sort()).toEqual(
      ["background", "descendant", "event-publication", "followup", "intake", "queued", "root"].sort(),
    )
    const req = validateAbortContractRequest(makeReq())
    for (const kind of ABORT_TARGET_KINDS) {
      const terminal = makeAbortDispositionTerminal(req, [
        { kind, disposition: "cancelled", generationId: "gen_001", sessionId: SID },
      ])
      expect(() => validateAbortDispositionTerminal(terminal)).not.toThrow()
    }
    expect(() =>
      validateAbortDispositionEntry({
        kind: "generation",
        disposition: "cancelled",
        generationId: "gen_001",
        sessionId: SID,
      }),
    ).toThrow()
  })

  test("dispositions distinguish cancelled, succeeded, and not_affected", () => {
    const req = validateAbortContractRequest(makeReq())
    const terminal = makeAbortDispositionTerminal(req, [
      { kind: "root", disposition: "cancelled", generationId: "gen_001", sessionId: SID },
      { kind: "queued", disposition: "succeeded", generationId: "gen_002", sessionId: SID },
      { kind: "descendant", disposition: "not_affected", generationId: "gen_003", sessionId: SID },
    ])
    const out = validateAbortDispositionTerminal(terminal)
    expect(out.affected.map((entry) => entry.disposition)).toEqual(["cancelled", "succeeded", "not_affected"])
    expect(isAbortCancellationSuccess(out.affected[0]!)).toBeTrue()
    expect(isAbortCancellationSuccess(out.affected[1]!)).toBeFalse()
    expect(isAbortCancellationSuccess(out.affected[2]!)).toBeFalse()
    expect(countAbortCancelled(out.affected)).toBe(1)
    expect(() =>
      validateAbortDispositionEntry({
        kind: "root",
        disposition: "unknown",
        generationId: "gen_001",
        sessionId: SID,
      }),
    ).toThrow()
  })

  test("not_affected cannot be counted as cancellation success", () => {
    const req = validateAbortContractRequest(makeReq())
    const terminal = makeAbortDispositionTerminal(req, [
      { kind: "root", disposition: "cancelled", generationId: "gen_001", sessionId: SID },
      { kind: "descendant", disposition: "not_affected", generationId: "gen_002", sessionId: SID },
      { kind: "queued", disposition: "succeeded", generationId: "gen_003", sessionId: SID },
    ])
    expect(() => assertAbortSuccessExcludesNotAffected(terminal.affected, [terminal.affected[0]!])).not.toThrow()
    expect(() => assertAbortSuccessExcludesNotAffected(terminal.affected, [terminal.affected[1]!])).toThrow(
      "not_affected must not be counted as cancellation success",
    )
    expect(() => assertAbortSuccessExcludesNotAffected(terminal.affected, [terminal.affected[2]!])).toThrow()
    expect(countAbortCancelled(terminal.affected)).toBe(1)
  })

  test("session.not_found terminal fixture is redacted and side-effect-free", () => {
    const req = validateAbortContractRequest(makeReq())
    const fixture = makeAbortNotFoundFixture(req, { code: "session.not_found", retryable: false, time: 1 })
    expect(isAbortNotFoundTerminal(fixture)).toBeTrue()
    expect(isAbortTerminal(fixture)).toBeFalse()
    expect(fixture.sideEffect).toBeFalse()
    expect(fixture.accepted).toBeFalse()
    expect(fixture.terminal).toBeTrue()
    expect(() => validateAbortNotFoundTerminal(fixture)).not.toThrow()
    expect(() => makeAbortNotFoundFixture(req, { code: "stale", retryable: false, time: 1 })).toThrow()
    expect("sessionId" in fixture).toBeFalse()
    expect("prompt" in fixture).toBeFalse()
  })

  test("terminal success requires accepted true", () => {
    const req = validateAbortContractRequest(makeReq())
    const terminal = makeAbortDispositionTerminal(req, [
      { kind: "root", disposition: "cancelled", generationId: "gen_001", sessionId: SID },
    ])
    expect(() => validateAbortDispositionTerminal(terminal)).not.toThrow()
    expect(() => validateAbortDispositionTerminal({ ...terminal, accepted: false })).toThrow(
      "terminal accepted must be true",
    )
  })

  test("scope_mismatch terminal failure shares the redacted side-effect-free shape", () => {
    const req = validateAbortContractRequest(makeReq())
    const failure = makeAbortTerminalFailure(req, "scope_mismatch", 2)
    expect(failure.accepted).toBeFalse()
    expect(failure.terminal).toBeTrue()
    expect(failure.sideEffect).toBeFalse()
    expect(failure.failure.code).toBe("scope_mismatch")
    expect(failure.failure.retryable).toBeFalse()
    expect(() => validateAbortTerminalFailure(failure, req)).not.toThrow()
    expect(() => validateAbortTerminalFailure({ ...failure, failure: { code: "stale", retryable: false, time: 1 } }, req)).toThrow()
    expect(() =>
      validateAbortTerminalFailure({ ...failure, failure: { code: "scope_mismatch", retryable: true, time: 1 } }, req),
    ).toThrow()
  })

  test("terminal re-observation returns deep-equal facts and rejects mismatched identity", () => {
    const req = validateAbortContractRequest(makeReq())
    const terminal = makeAbortDispositionTerminal(
      req,
      [{ kind: "root", disposition: "cancelled", generationId: "gen_001", sessionId: SID }],
      { code: "cancelled", retryable: false, time: 7 },
    )
    const again = reobserveAbortTerminal(terminal, { opId: req.opId, idempotencyKey: req.idempotencyKey })
    expect(again).toEqual(terminal)
    expect(again).not.toBe(terminal)
    expect(again.affected).not.toBe(terminal.affected)
    // Stored fixture is not mutated by re-observation.
    expect(terminal.affected.length).toBe(1)
    expect(() =>
      reobserveAbortTerminal(terminal, {
        opId: canonicalAbortOpId(SID, "other"),
        idempotencyKey: canonicalAbortOpId(SID, "other"),
      }),
    ).toThrow("re-observation opId mismatch")
    expect(() =>
      reobserveAbortTerminal(terminal, { opId: req.opId, idempotencyKey: canonicalAbortOpId(SID, "other") }),
    ).toThrow("re-observation idempotencyKey mismatch")
  })

  test("diagnostics allow code, retryable, and time but reject raw echo", () => {
    expect(() =>
      validateAbortDiagnostic({ code: "cancelled", retryable: false, time: 1, message: "redacted" }),
    ).not.toThrow()
    for (const key of ["session", "sessionId", "prompt", "tool", "error", "output"]) {
      expect(() => validateAbortDiagnostic({ code: "x", retryable: false, time: 1, [key]: "raw" })).toThrow()
    }
    expect(() => validateAbortDiagnostic({ code: "x", retryable: false, time: 1, extra: 1 })).toThrow()
  })
})
