import { describe, expect, test } from "bun:test"
import {
  canonicalSandboxSetOpId,
  validateSandboxSetContractRequest,
  validateSandboxSetResult,
} from "./serve-private-sandbox-set-contract"

const SID = "ses_xyz"

function req(enabled = true, token = "t1") {
  const opId = canonicalSandboxSetOpId(SID, token)
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "sandbox/set" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp", sessionId: SID },
    payload: { enabled, sessionId: SID },
  }
}

describe("sandbox-set contract", () => {
  test("validates closed request with target", () => {
    expect(validateSandboxSetContractRequest(req(true)).payload.enabled).toBe(true)
    expect(() => validateSandboxSetContractRequest({ ...req(), payload: { enabled: "x", sessionId: SID } })).toThrow()
    expect(() => validateSandboxSetContractRequest({ ...req(), payload: { enabled: true, sessionId: "ses_other" } })).toThrow()
    expect(() => validateSandboxSetContractRequest({ ...req(), extra: 1 })).toThrow()
  })

  test("validates closed result identity", () => {
    const r = req(false)
    const ok = {
      v: 1,
      requestId: "r1",
      opId: r.opId,
      op: "sandbox/set",
      idempotencyKey: r.opId,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { status: { directory: "/tmp", enabled: false, available: true, version: 1 } },
    }
    expect(validateSandboxSetResult(ok, r).status).toBe("succeeded")
    expect(() => validateSandboxSetResult({ ...ok, requestId: "r2" }, r)).toThrow()
    expect(() =>
      validateSandboxSetResult({ ...ok, data: { status: { directory: "/tmp", enabled: false, available: true } } }, r),
    ).toThrow()
    const withReason = {
      ...ok,
      data: { status: { directory: "/tmp", enabled: true, available: false, reason: "no backend", version: 1 } },
    }
    const parsed = validateSandboxSetResult(withReason, r)
    if (parsed.status !== "succeeded") throw new Error("expected succeeded")
    expect(parsed.data.status.reason).toBe("no backend")
    expect(() =>
      validateSandboxSetResult(
        { ...ok, data: { status: { directory: "/tmp", enabled: true, available: false, reason: 1, version: 1 } } },
        r,
      ),
    ).toThrow()
  })
})
