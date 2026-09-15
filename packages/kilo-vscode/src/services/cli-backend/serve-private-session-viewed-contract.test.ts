import { describe, expect, test } from "bun:test"
import {
  isSettledSessionViewedResult,
  makeSessionViewedAmbiguous,
  normalizePrivateSessionViewedWire,
  validateSessionViewedContractRequest,
  validateSessionViewedResult,
} from "./serve-private-session-viewed-contract"

const uid = "11111111-1111-4111-8111-111111111111"

function req(sequence = 1): Parameters<typeof validateSessionViewedContractRequest>[0] {
  return {
    v: 1,
    requestId: "r1",
    op: "session/viewed",
    context: { directory: "/tmp" },
    payload: { viewer: { id: uid, active: true, sequence }, attached: ["ses_a"], visible: ["ses_a"] },
  } as unknown as Parameters<typeof validateSessionViewedContractRequest>[0]
}

describe("session/viewed contract", () => {
  test("accepts requestId-only identity and rejects opId", () => {
    const out = validateSessionViewedContractRequest(req())
    expect(out.requestId).toBe("r1")
    expect(() => validateSessionViewedContractRequest({ ...req(), opId: "x" } as never)).toThrow("unexpected field")
  })

  test("rejects unknown fields at every level", () => {
    expect(() => validateSessionViewedContractRequest({ ...req(), extra: 1 } as never)).toThrow("unexpected field")
    const badCtx = req()
    ;(badCtx.context as Record<string, unknown>).extra = 1
    expect(() => validateSessionViewedContractRequest(badCtx)).toThrow("unexpected context field")
    const badPayload = req()
    ;(badPayload.payload as Record<string, unknown>).extra = 1
    expect(() => validateSessionViewedContractRequest(badPayload)).toThrow("unexpected payload field")
    const badViewer = req()
    ;((badViewer.payload as Record<string, unknown>).viewer as Record<string, unknown>).extra = 1
    expect(() => validateSessionViewedContractRequest(badViewer)).toThrow("unexpected viewer field")
  })

  test("rejects bad UUID, sequence, active, lists, caps", () => {
    const badId = req()
    badId.payload.viewer.id = "not-a-uuid"
    expect(() => validateSessionViewedContractRequest(badId)).toThrow()
    expect(() => validateSessionViewedContractRequest(req(-1))).toThrow()
    expect(() => validateSessionViewedContractRequest(req(1.5))).toThrow()
    const badActive = req()
    ;((badActive.payload as Record<string, unknown>).viewer as Record<string, unknown>).active = 1
    expect(() => validateSessionViewedContractRequest(badActive)).toThrow()
    const badList = req()
    ;(badList.payload as Record<string, unknown>).attached = ["nope"]
    expect(() => validateSessionViewedContractRequest(badList)).toThrow()
    const over = req()
    ;(over.payload as Record<string, unknown>).attached = Array.from({ length: 1001 }, () => "ses_a")
    expect(() => validateSessionViewedContractRequest(over)).toThrow()
    const overVisible = req()
    ;(overVisible.payload as Record<string, unknown>).visible = Array.from({ length: 200 }, () => "ses_a")
    expect(() => validateSessionViewedContractRequest(overVisible)).toThrow()
  })

  test("validates result shape and settle semantics", () => {
    const base = validateSessionViewedContractRequest(req())
    const ok = {
      v: 1,
      requestId: "r1",
      op: "session/viewed",
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { applied: true },
    } as never
    expect(validateSessionViewedResult(ok, base).status).toBe("succeeded")
    expect(isSettledSessionViewedResult(ok, base)).toBe(true)
    const terminal = {
      v: 1,
      requestId: "r1",
      op: "session/viewed",
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "validation.failed", message: "m", retryable: false } },
      accepted: false,
      failure: { code: "validation.failed", message: "m", retryable: false },
    } as never
    expect(isSettledSessionViewedResult(terminal, base)).toBe(true)
    const retryable = {
      v: 1,
      requestId: "r1",
      op: "session/viewed",
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "x", message: "m", retryable: true } },
      accepted: false,
      failure: { code: "x", message: "m", retryable: true },
    } as never
    expect(isSettledSessionViewedResult(retryable, base)).toBe(false)
    expect(normalizePrivateSessionViewedWire({ bogus: true }, base).kind).toBe("invalid")
  })

  test("malformed failed with accepted:true is invalid, matching backend", () => {
    const base = validateSessionViewedContractRequest(req())
    const malformed = {
      v: 1,
      requestId: "r1",
      op: "session/viewed",
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "validation.failed", message: "m", retryable: false } },
      accepted: true,
      failure: { code: "validation.failed", message: "m", retryable: false },
    } as never
    expect(() => validateSessionViewedResult(malformed, base)).toThrow("failed accepted must be false")
    expect(normalizePrivateSessionViewedWire(malformed, base).kind).toBe("invalid")
    expect(isSettledSessionViewedResult(malformed, base)).toBe(false)
  })
})
