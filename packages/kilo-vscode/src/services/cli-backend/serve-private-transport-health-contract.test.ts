import { describe, expect, test } from "bun:test"
import {
  isTransportHealthSuccess,
  validateTransportHealthContractRequest,
  validateTransportHealthResult,
} from "./serve-private-transport-health-contract"

describe("transport/health contract", () => {
  test("strict request rejects directory/opId/unknown fields", () => {
    const good = { v: 1, requestId: "h1", op: "transport/health", context: {}, payload: {} }
    expect(() => validateTransportHealthContractRequest(good)).not.toThrow()
    const bad: unknown[] = [
      { v: 1, requestId: "h2", op: "transport/health", context: { directory: "/tmp" }, payload: {} },
      { v: 1, requestId: "h3", op: "transport/health", opId: "x", context: {}, payload: {} },
      { v: 1, requestId: "h4", op: "transport/health", context: {}, payload: {}, extra: 1 },
      { v: 1, requestId: "h5", op: "transport/health", context: {}, payload: { q: 1 } },
      { v: 1, requestId: "a/b", op: "transport/health", context: {}, payload: {} },
    ]
    for (const b of bad) {
      expect(() => validateTransportHealthContractRequest(b)).toThrow()
    }
  })

  test("success exact {ok:true} strict", () => {
    const req = validateTransportHealthContractRequest({ v: 1, requestId: "h1", op: "transport/health", context: {}, payload: {} })
    const raw = { v: 1, requestId: "h1", op: "transport/health", status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { ok: true } }
    expect(isTransportHealthSuccess(raw, req)).toBeTrue()
    expect(() => validateTransportHealthResult(raw, req)).not.toThrow()
    const badData = { v: 1, requestId: "h1", op: "transport/health", status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { ok: false } }
    expect(isTransportHealthSuccess(badData, req)).toBeFalse()
    const failed = { v: 1, requestId: "h1", op: "transport/health", status: "failed", outcome: { type: "failed", time: Date.now(), failure: { code: "internal", message: "internal error", retryable: false } }, accepted: false, failure: { code: "internal", message: "internal error", retryable: false } }
    expect(isTransportHealthSuccess(failed, req)).toBeFalse()
  })
})
