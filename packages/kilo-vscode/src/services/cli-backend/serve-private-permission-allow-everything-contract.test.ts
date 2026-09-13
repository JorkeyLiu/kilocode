import { describe, expect, test } from "bun:test"
import {
  canonicalPermissionAllowEverythingOpId,
  isSettledPermissionAllowEverythingResult,
  makePermissionAllowEverythingAmbiguous,
  parsePermissionAllowEverythingOpId,
  validatePermissionAllowEverythingContractRequest,
  validatePermissionAllowEverythingResult,
  validatePermissionAllowEverythingTerminalFailure,
} from "./serve-private-permission-allow-everything-contract"
import type { PermissionAllowEverythingContractRequest } from "./serve-private-permission-allow-everything-contract"

const DIR = "/workspace/allow-everything"
const SES = "ses_root00000000000000001"
const PID = "per_test00000000000000001"

function req(over: Record<string, unknown> = {}): PermissionAllowEverythingContractRequest {
  const opId = canonicalPermissionAllowEverythingOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "permission/allow-everything" as const,
    idempotencyKey: opId,
    context: { directory: DIR },
    payload: { enable: true },
    ...over,
  } as PermissionAllowEverythingContractRequest
}

function terminalFor(r: PermissionAllowEverythingContractRequest) {
  return {
    kind: "terminal",
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    idempotencyKey: r.idempotencyKey,
    accepted: true,
    terminal: true,
    enable: r.payload.enable,
  }
}

function failureFor(r: PermissionAllowEverythingContractRequest, code = "internal") {
  return {
    kind: "terminal-failure",
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    idempotencyKey: r.idempotencyKey,
    accepted: false,
    terminal: true,
    failure: { code, retryable: false, time: 1 },
    sideEffect: false,
  }
}

describe("permission/allow-everything private contract", () => {
  test("opId binds the allow-everything token with idempotency tuple", () => {
    const opId = canonicalPermissionAllowEverythingOpId("tok1")
    expect(opId).toBe("permission-allow-everything:tok1")
    expect(parsePermissionAllowEverythingOpId(opId)).toEqual({ token: "tok1" })
    expect(() => canonicalPermissionAllowEverythingOpId("a:b")).toThrow()
    expect(() => canonicalPermissionAllowEverythingOpId("a/b")).toThrow()
    const r = req()
    expect(r.opId).toBe(r.idempotencyKey)
    expect(() => validatePermissionAllowEverythingContractRequest(r)).not.toThrow()
  })

  test("request carries directory routing with optional session/request scope and boolean enable", () => {
    const scoped = req({ context: { directory: DIR, sessionID: SES, requestID: PID } })
    expect(() => validatePermissionAllowEverythingContractRequest(scoped)).not.toThrow()
    const badEnable = req({ payload: { enable: "yes" } })
    expect(() => validatePermissionAllowEverythingContractRequest(badEnable)).toThrow()
    const badSession = req({ context: { directory: DIR, sessionID: "bad" } })
    expect(() => validatePermissionAllowEverythingContractRequest(badSession)).toThrow()
    const badRequest = req({ context: { directory: DIR, requestID: "bad" } })
    expect(() => validatePermissionAllowEverythingContractRequest(badRequest)).toThrow()
  })

  test("strict unknown-field reject on envelope, context, and payload", () => {
    expect(() => validatePermissionAllowEverythingContractRequest({ ...req(), extra: 1 })).toThrow()
    expect(() => validatePermissionAllowEverythingContractRequest(req({ context: { directory: DIR, bogus: 1 } }))).toThrow()
    expect(() => validatePermissionAllowEverythingContractRequest(req({ payload: { enable: true, bogus: 1 } }))).toThrow()
    const mismatched = req({ idempotencyKey: canonicalPermissionAllowEverythingOpId("other") })
    expect(() => validatePermissionAllowEverythingContractRequest(mismatched)).toThrow()
  })

  test("terminal echoes enable and scope binding; failure codes are redacted", () => {
    const r = req({ context: { directory: DIR, sessionID: SES } })
    const ok = { ...terminalFor(r), sessionID: SES }
    expect(validatePermissionAllowEverythingResult(ok, r).enable).toBe(true)
    const wrongEnable = { ...terminalFor(r), enable: false, sessionID: SES }
    expect(() => validatePermissionAllowEverythingResult(wrongEnable, r)).toThrow()
    const wrongScope = { ...terminalFor(r), sessionID: "ses_other000000000000001" }
    expect(() => validatePermissionAllowEverythingResult(wrongScope, r)).toThrow()
    expect(validatePermissionAllowEverythingTerminalFailure(failureFor(r, "scope_mismatch"), r).failure.code).toBe(
      "scope_mismatch",
    )
    expect(() => validatePermissionAllowEverythingTerminalFailure(failureFor(r, "permission.not_found"), r)).toThrow()
  })

  test("ambiguous preserves the idempotency tuple and settles only terminal shapes", () => {
    const r = req()
    const vague = makePermissionAllowEverythingAmbiguous(r)
    expect(vague.opId).toBe(r.opId)
    expect(vague.idempotencyKey).toBe(r.idempotencyKey)
    expect(isSettledPermissionAllowEverythingResult(terminalFor(r), r)).toBeTrue()
    expect(isSettledPermissionAllowEverythingResult(failureFor(r), r)).toBeTrue()
    expect(isSettledPermissionAllowEverythingResult(vague, r)).toBeFalse()
  })
})
