import { describe, expect, test } from "bun:test"
import {
  canonicalRemoteDisableOpId,
  canonicalRemoteEnableOpId,
  checkRemoteToggleScope,
  validateRemoteToggleContractRequest,
  validateRemoteToggleFailure,
  validateRemoteToggleResult,
} from "./serve-private-remote-toggle-contract"

function enableReq(token = "t1", dir = "/tmp") {
  const opId = canonicalRemoteEnableOpId(token)
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "remote/enable" as const,
    idempotencyKey: opId,
    context: { directory: dir },
    payload: {},
  }
}

function disableReq(token = "t1", dir = "/tmp") {
  const opId = canonicalRemoteDisableOpId(token)
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "remote/disable" as const,
    idempotencyKey: opId,
    context: { directory: dir },
    payload: {},
  }
}

function okFor(req: ReturnType<typeof enableReq>, enabled = true, connected = false) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { status: { enabled, connected } },
  }
}

describe("remote-toggle contract", () => {
  test("canonical opIds bind fresh token identity per action", () => {
    expect(canonicalRemoteEnableOpId("a")).toBe("remote-enable:a")
    expect(canonicalRemoteDisableOpId("a")).toBe("remote-disable:a")
    expect(() => canonicalRemoteEnableOpId("a:b")).toThrow()
    expect(() => canonicalRemoteDisableOpId("")).toThrow()
  })

  test("strict envelope rejects unknown fields and cross-action op", () => {
    const req = enableReq()
    expect(() => validateRemoteToggleContractRequest(req)).not.toThrow()
    expect(() => validateRemoteToggleContractRequest({ ...req, extra: 1 })).toThrow()
    expect(() => validateRemoteToggleContractRequest({ ...req, context: { directory: "/tmp", x: 1 } })).toThrow()
    expect(() => validateRemoteToggleContractRequest({ ...req, payload: { a: 1 } })).toThrow()
    expect(() =>
      validateRemoteToggleContractRequest({ ...req, op: "remote/disable" as never }),
    ).toThrow()
    expect(() =>
      validateRemoteToggleContractRequest({ ...req, idempotencyKey: canonicalRemoteEnableOpId("other") }),
    ).toThrow()
    expect(() => validateRemoteToggleContractRequest({ ...disableReq(), op: "remote/enable" as never })).toThrow()
  })

  test("scope binds directory plus action, not payload state", () => {
    const req = enableReq("tok", "/tmp")
    expect(
      checkRemoteToggleScope(req, { directory: "/tmp", token: "tok", action: "enable" }),
    ).toEqual({ ok: true })
    expect(
      checkRemoteToggleScope(req, { directory: "/other", token: "tok", action: "enable" }),
    ).toEqual({ ok: false, code: "scope_mismatch", which: "directory" })
    expect(
      checkRemoteToggleScope(req, { directory: "/tmp", token: "tok", action: "disable" }),
    ).toEqual({ ok: false, code: "scope_mismatch", which: "request" })
  })

  test("succeeded result carries strict status payload", () => {
    const req = enableReq()
    const out = validateRemoteToggleResult(okFor(req, true, false), req)
    expect(out.status).toBe("succeeded")
    if (out.status === "succeeded") expect(out.data.status).toEqual({ enabled: true, connected: false })
    expect(() => validateRemoteToggleResult({ ...okFor(req), accepted: false }, req)).toThrow()
  })

  test("failure redacts to code/message/retryable only", () => {
    expect(() =>
      validateRemoteToggleFailure({ code: "x", message: "y", retryable: false, token: "t" }),
    ).toThrow()
    expect(() =>
      validateRemoteToggleFailure({ code: "x", message: "y", retryable: false, url: "wss://h" }),
    ).toThrow()
    expect(() =>
      validateRemoteToggleFailure({ code: "x", message: "y", retryable: false, directory: "/tmp" }),
    ).toThrow()
    const ok = validateRemoteToggleFailure({ code: "auth.missing", message: "no Kilo credentials found", retryable: false })
    expect(ok.code).toBe("auth.missing")
  })
})
