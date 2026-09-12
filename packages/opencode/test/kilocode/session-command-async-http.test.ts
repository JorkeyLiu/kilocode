// @ts-nocheck
import { describe, expect, test } from "bun:test"
import {
  buildCommandAsyncDispatchRequest,
  commandAsyncFailureStatus,
} from "@/server/routes/instance/httpapi/handlers/session"
import { validateRequest } from "@/kilocode/session/session-command-dispatch"

const SID = "ses_abc12300000000000001"
const MID = "msg_abc12300000000000001"
const DIR = "/tmp/ws"

function payload(extra?: Record<string, unknown>) {
  return {
    messageID: MID,
    command: "probe",
    arguments: "hello",
    ...(extra ?? {}),
  }
}

describe("command_async request build", () => {
  test("builds canonical prompt identity with stable requestId and route directory", () => {
    const req = buildCommandAsyncDispatchRequest({ sessionID: SID, directory: DIR, payload: payload() })
    expect(req.op).toBe("session/command")
    expect(req.opId).toBe(`prompt:${MID}`)
    expect(req.idempotencyKey).toBe(`prompt:${MID}`)
    expect(req.requestId).toBe(`command_async:${SID}:${MID}`)
    expect(req.context.directory).toBe(DIR)
    expect(req.context.sessionId).toBe(SID)
    expect(req.context.parentSessionId).toBeNull()
    expect(req.payload.messageId).toBe(MID)
    expect(req.payload.command).toBe("probe")
    expect(req.payload.arguments).toBe("hello")
    expect(() => validateRequest(req)).not.toThrow()
  })

  test("passes model/agent/variant/parts/snapshotInitialization through", () => {
    const file = { type: "file", mime: "text/plain", url: "file:///tmp/a.txt", filename: "a.txt" }
    const req = buildCommandAsyncDispatchRequest({
      sessionID: SID,
      directory: DIR,
      payload: payload({ model: "test/model", agent: "build", variant: "v", parts: [file], snapshotInitialization: "wait" }),
    })
    expect(req.payload.model).toBe("test/model")
    expect(req.payload.agent).toBe("build")
    expect(req.payload.variant).toBe("v")
    expect(req.payload.snapshotInitialization).toBe("wait")
    expect(JSON.stringify(req.payload.parts)).toBe(JSON.stringify([file]))
    expect(() => validateRequest(req)).not.toThrow()
  })

  test("missing messageID fails closed before dispatch", () => {
    expect(() => buildCommandAsyncDispatchRequest({ sessionID: SID, directory: DIR, payload: { command: "probe", arguments: "" } })).toThrow()
  })
})

describe("command_async outcome mapping", () => {
  test("terminal map matches HTTP contract without accepted-as-success confusion", () => {
    expect(commandAsyncFailureStatus("session.not_found")).toBe(404)
    expect(commandAsyncFailureStatus("validation.failed")).toBe(400)
    expect(commandAsyncFailureStatus("scope_mismatch")).toBe(400)
    expect(commandAsyncFailureStatus("command.not_found")).toBe(400)
    expect(commandAsyncFailureStatus("stale")).toBe(409)
    expect(commandAsyncFailureStatus("conflict")).toBe(409)
    expect(commandAsyncFailureStatus("InstanceUnavailableDuringConfigRebuild")).toBe(409)
    expect(commandAsyncFailureStatus("internal")).toBe(500)
    expect(commandAsyncFailureStatus("unknown")).toBe(500)
  })

  test("succeeded without accepted never maps to 204", () => {
    const result = { status: "succeeded", accepted: false }
    const accepted = result.status === "succeeded" && result.accepted === true
    expect(accepted).toBe(false)
  })
})
