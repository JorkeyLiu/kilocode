import { describe, expect, it } from "bun:test"
import {
  canonicalPtyRemoveOpId,
  canonicalPtyUpdateOpId,
  validatePtyRemoveContractRequest,
  validatePtyRemoveResult,
  validatePtyUpdateContractRequest,
  validatePtyUpdateResult,
} from "./serve-private-pty-contract"

const DIR = "/tmp/kilo-pty"
const PTY = "pty_aaaaaaaaaaaaaaaaaaaaaaaaaa"
const OTHER = "pty_bbbbbbbbbbbbbbbbbbbbbbbbbb"

function updateReq(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opId = canonicalPtyUpdateOpId(PTY, "tok1")
  return {
    v: 1,
    requestId: "8f3c2a1b4d5e6f708192a3b4c5d6e7f8",
    opId,
    op: "pty/update",
    idempotencyKey: opId,
    context: { directory: DIR, ptyID: PTY },
    payload: { size: { rows: 24, cols: 80 } },
    ...overrides,
  }
}

function removeReq(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opId = canonicalPtyRemoveOpId(PTY, "tok1")
  return {
    v: 1,
    requestId: "8f3c2a1b4d5e6f708192a3b4c5d6e7f8",
    opId,
    op: "pty/remove",
    idempotencyKey: opId,
    context: { directory: DIR, ptyID: PTY },
    payload: {},
    ...overrides,
  }
}

describe("serve-private-pty-contract", () => {
  it("accepts strict update and remove requests with opaque pathless IDs", () => {
    const upd = validatePtyUpdateContractRequest(updateReq())
    expect(upd.opId).toBe(upd.idempotencyKey)
    expect(upd.context.ptyID).toBe(PTY)
    expect(upd.payload.size).toEqual({ rows: 24, cols: 80 })
    const rem = validatePtyRemoveContractRequest(removeReq())
    expect(rem.opId).toBe(rem.idempotencyKey)
    expect(rem.context.ptyID).toBe(PTY)
  })

  it("rejects opId/idempotencyKey mismatch and ptyID binding mismatch", () => {
    const base = updateReq() as Record<string, unknown>
    expect(() =>
      validatePtyUpdateContractRequest({ ...base, idempotencyKey: canonicalPtyUpdateOpId(PTY, "other") }),
    ).toThrow()
    const otherOp = canonicalPtyUpdateOpId(OTHER, "tok1")
    expect(() => validatePtyUpdateContractRequest({ ...base, opId: otherOp, idempotencyKey: otherOp })).toThrow()
  })

  it("rejects non-absolute directory and bad size", () => {
    expect(() =>
      validatePtyUpdateContractRequest(updateReq({ context: { directory: "relative", ptyID: PTY } })),
    ).toThrow()
    expect(() => validatePtyUpdateContractRequest(updateReq({ payload: { size: { rows: 0, cols: 80 } } }))).toThrow()
    expect(() => validatePtyRemoveContractRequest(removeReq({ payload: { extra: true } }))).toThrow()
  })

  it("rejects path material in IDs", () => {
    const base = updateReq() as Record<string, unknown>
    expect(() => validatePtyUpdateContractRequest({ ...base, requestId: "a/b" })).toThrow()
    expect(() => validatePtyUpdateContractRequest({ ...base, opId: "pty-update:a/b:tok" })).toThrow()
  })

  it("validates update success and terminal pty.not_found", () => {
    const req = validatePtyUpdateContractRequest(updateReq())
    const ok = {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "pty/update",
      idempotencyKey: req.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { updated: true },
    }
    expect(validatePtyUpdateResult(ok, req).status).toBe("succeeded")
    const nf = {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "pty/update",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: {
        type: "failed",
        time: 1,
        failure: { code: "pty.not_found", message: "pty not found", retryable: false },
      },
      accepted: false,
      failure: { code: "pty.not_found", message: "pty not found", retryable: false },
    }
    const parsed = validatePtyUpdateResult(nf, req)
    expect(parsed.status).toBe("failed")
    if (parsed.status === "failed") expect(parsed.failure.code).toBe("pty.not_found")
  })

  it("accepts the local fixed transport fallback code", () => {
    const req = validatePtyUpdateContractRequest(updateReq())
    const failure = { code: "transport", message: "private pty-update transport failed", retryable: false }
    const wire = {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "pty/update",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure },
      accepted: false,
      failure,
    }
    const parsed = validatePtyUpdateResult(wire, req)
    expect(parsed.status).toBe("failed")
    if (parsed.status === "failed") expect(parsed.failure.code).toBe("transport")
  })

  it("rejects non-allowlisted failure codes and raw payload echo", () => {
    const req = validatePtyRemoveContractRequest(removeReq())
    const bad = {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "pty/remove",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "bogus", message: "x", retryable: false } },
      accepted: false,
      failure: { code: "bogus", message: "x", retryable: false },
    }
    expect(() => validatePtyRemoveResult(bad, req)).toThrow()
    const raw = {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "pty/remove",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: {
        type: "failed",
        time: 1,
        failure: { code: "internal", message: "x", retryable: false, directory: DIR },
      },
      accepted: false,
      failure: { code: "internal", message: "x", retryable: false },
    }
    expect(() => validatePtyRemoveResult(raw, req)).toThrow()
  })
})
