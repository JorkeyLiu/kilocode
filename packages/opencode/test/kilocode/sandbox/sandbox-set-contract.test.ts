import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SandboxSetPayload } from "@/kilocode/server/httpapi/groups/sandbox"
import {
  canonicalSandboxSetOpId,
  parseSandboxSetOpId,
  validateSandboxSetRequest,
  validateSandboxSetResult,
} from "@/kilocode/sandbox-set-private"

describe("sandbox set contract", () => {
  test("payload accepts boolean and rejects non-boolean", () => {
    expect(Schema.decodeUnknownSync(SandboxSetPayload)({ enabled: true })).toEqual({ enabled: true })
    expect(Schema.decodeUnknownSync(SandboxSetPayload)({ enabled: false })).toEqual({ enabled: false })
    expect(() => Schema.decodeUnknownSync(SandboxSetPayload)({})).toThrow()
    expect(() => Schema.decodeUnknownSync(SandboxSetPayload)({ enabled: "yes" })).toThrow()
    expect(Schema.decodeUnknownSync(SandboxSetPayload)({ enabled: true, extra: 1 })).toEqual({ enabled: true })
  })

  test("opId binds session and token", () => {
    const op = canonicalSandboxSetOpId("ses_abc", "tok123")
    expect(op).toBe("sandbox-set:ses_abc:tok123")
    expect(parseSandboxSetOpId(op)).toEqual({ sessionId: "ses_abc", token: "tok123" })
    expect(() => parseSandboxSetOpId("sandbox-set:ses_abc")).toThrow()
    expect(() => canonicalSandboxSetOpId("ses_abc", "a:b")).toThrow()
  })

  test("request rejects mismatched session and unknown fields", () => {
    const base = {
      v: 1,
      requestId: "r1",
      opId: "sandbox-set:ses_a:t1",
      op: "sandbox/set",
      idempotencyKey: "sandbox-set:ses_a:t1",
      context: { directory: "/tmp", sessionId: "ses_a" },
      payload: { enabled: true, sessionId: "ses_a" },
    }
    expect(validateSandboxSetRequest(base).payload.enabled).toBe(true)
    expect(() => validateSandboxSetRequest({ ...base, payload: { enabled: true, sessionId: "ses_b" } })).toThrow()
    expect(() => validateSandboxSetRequest({ ...base, opId: "sandbox-set:ses_b:t1" })).toThrow()
    expect(() => validateSandboxSetRequest({ ...base, payload: { enabled: "yes", sessionId: "ses_a" } })).toThrow()
    expect(() => validateSandboxSetRequest({ ...base, extra: 1 })).toThrow()
  })

  test("result validates identity and closed shapes", () => {
    const req = validateSandboxSetRequest({
      v: 1,
      requestId: "r1",
      opId: "sandbox-set:ses_a:t1",
      op: "sandbox/set",
      idempotencyKey: "sandbox-set:ses_a:t1",
      context: { directory: "/tmp", sessionId: "ses_a" },
      payload: { enabled: true, sessionId: "ses_a" },
    })
    const ok = {
      v: 1,
      requestId: "r1",
      opId: "sandbox-set:ses_a:t1",
      op: "sandbox/set",
      idempotencyKey: "sandbox-set:ses_a:t1",
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { status: { directory: "/tmp", enabled: true, available: true, version: 1 } },
    }
    expect(validateSandboxSetResult(ok, req).status).toBe("succeeded")
    expect(() => validateSandboxSetResult({ ...ok, requestId: "r2" }, req)).toThrow()
    expect(() => validateSandboxSetResult({ ...ok, data: { status: { directory: "/tmp", enabled: "yes", available: true, version: 1 } } }, req)).toThrow()
    const bad = { ...ok, status: "failed", outcome: { type: "failed", time: 1, failure: { code: "x", message: "y", retryable: false } }, accepted: false, failure: { code: "x", message: "y", retryable: false } }
    expect(() => validateSandboxSetResult(bad, req)).toThrow()
  })

  test("SDK and OpenAPI expose closed sandbox.set", async () => {
    const spec = await Bun.file("/Users/jorkeyliu/workspace/repos/kilocode/packages/sdk/openapi.json").json()
    expect(spec.paths["/session/{sessionID}/sandbox/set"]).toBeDefined()
    const sdk = await Bun.file("/Users/jorkeyliu/workspace/repos/kilocode/packages/sdk/js/src/v2/gen/sdk.gen.ts").text()
    expect(sdk).toContain("/session/{sessionID}/sandbox/set")
    expect(sdk).toContain("Set session sandbox")
  })
})
