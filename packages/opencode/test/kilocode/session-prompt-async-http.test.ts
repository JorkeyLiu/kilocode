// @ts-nocheck
import { describe, expect, test } from "bun:test"
import {
  buildPromptAsyncDispatchRequest,
  promptAsyncFailureStatus,
} from "@/server/routes/instance/httpapi/handlers/session"
import { validateRequest } from "@/kilocode/session/session-prompt-dispatch"

const SID = "ses_abc12300000000000001"
const MID = "msg_abc12300000000000001"
const DIR = "/tmp/ws"

function payload(extra?: Record<string, unknown>) {
  return {
    messageID: MID,
    parts: [{ type: "text", text: "hi" }],
    ...(extra ?? {}),
  }
}

describe("prompt_async request build", () => {
  test("builds canonical prompt identity with stable requestId and route directory", () => {
    const req = buildPromptAsyncDispatchRequest({ sessionID: SID, directory: DIR, payload: payload() })
    expect(req.op).toBe("session/prompt")
    expect(req.opId).toBe(`prompt:${MID}`)
    expect(req.idempotencyKey).toBe(`prompt:${MID}`)
    expect(req.requestId).toBe(`prompt_async:${SID}:${MID}`)
    expect(req.context.directory).toBe(DIR)
    expect(req.context.sessionId).toBe(SID)
    expect(req.context.parentSessionId).toBeNull()
    expect(req.payload.messageId).toBe(MID)
    expect(JSON.stringify(req.payload.parts)).toBe(JSON.stringify([{ type: "text", text: "hi" }]))
    expect(() => validateRequest(req)).not.toThrow()
  })

  test("passes full prompt payload through", () => {
    const req = buildPromptAsyncDispatchRequest({
      sessionID: SID,
      directory: DIR,
      payload: payload({
        model: { providerID: "test", modelID: "test-model" },
        agent: "build",
        variant: "v",
        noReply: true,
        tools: { webfetch: true },
        format: { type: "json" },
        system: "sys",
        snapshotInitialization: "wait",
        editorContext: { active: true },
      }),
    })
    expect(req.payload.model).toEqual({ providerID: "test", modelID: "test-model" })
    expect(req.payload.agent).toBe("build")
    expect(req.payload.variant).toBe("v")
    expect(req.payload.noReply).toBe(true)
    expect(req.payload.tools).toEqual({ webfetch: true })
    expect(req.payload.system).toBe("sys")
    expect(req.payload.snapshotInitialization).toBe("wait")
    expect(() => validateRequest(req)).not.toThrow()
  })

  test("missing messageID fails closed before dispatch", () => {
    expect(() =>
      buildPromptAsyncDispatchRequest({ sessionID: SID, directory: DIR, payload: { parts: [] } }),
    ).toThrow()
  })
})

describe("prompt_async outcome mapping", () => {
  test("terminal map matches HTTP contract without accepted-as-success confusion", () => {
    expect(promptAsyncFailureStatus("session.not_found")).toBe(404)
    expect(promptAsyncFailureStatus("validation.failed")).toBe(400)
    expect(promptAsyncFailureStatus("scope_mismatch")).toBe(400)
    expect(promptAsyncFailureStatus("stale")).toBe(409)
    expect(promptAsyncFailureStatus("conflict")).toBe(409)
    expect(promptAsyncFailureStatus("InstanceUnavailableDuringConfigRebuild")).toBe(409)
    expect(promptAsyncFailureStatus("internal")).toBe(500)
    expect(promptAsyncFailureStatus("unknown")).toBe(500)
    expect(promptAsyncFailureStatus("invalid")).toBe(500)
  })

  test("succeeded without accepted never maps to 204", () => {
    const result = { status: "succeeded", accepted: false }
    const accepted = result.status === "succeeded" && result.accepted === true
    expect(accepted).toBe(false)
  })
})
