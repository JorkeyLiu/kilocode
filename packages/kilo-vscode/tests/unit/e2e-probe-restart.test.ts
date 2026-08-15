import { describe, expect, it } from "bun:test"
import { restartSessionReason } from "../../script/e2e-probe-restart"
import { SCRIPTED } from "../../script/e2e-scripted-model"
import { modelLabelShows } from "../../script/e2e-probe-dom"
import type { BackendSnapshot, MessageTruth } from "../../src/agent-manager/fixture-backend"
import type { E2EPlan } from "../../script/e2e-probe-dom"

/** The restart prompt the real scenario types into the Agent Manager input. */
const PROMPT = `${SCRIPTED.restartMarker}: call the user tool and wait for the result`

/** Minimal plan with the real-restart custom identities (e2e-local/e2e-model). */
const plan = {
  customProvider: "e2e-local",
  customModel: "e2e-model",
  customAgent: "e2e-agent",
  customAgentLabel: "E2E Agent",
  customVariantA: "Low",
  realUserTool: "e2e_marker",
} as E2EPlan

/** The gateway fallback the webview resolves before configLoaded (LOCK-006). */
const FALLBACK = { providerID: "kilo", modelID: "kilo-auto/free" } as const

function snap(msgs: MessageTruth[]): BackendSnapshot {
  return {
    requestedAt: "2026-01-01T00:00:00.000Z",
    sessions: [
      {
        id: "s1",
        title: "E2E restart",
        agent: plan.customAgent,
        model: { providerID: plan.customProvider, modelID: plan.customModel },
        parentID: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    messages: { s1: msgs },
    statuses: { s1: "idle" },
    agents: [plan.customAgent],
    connectedProviders: [plan.customProvider],
  }
}

function userMsg(over: Partial<MessageTruth> = {}): MessageTruth {
  return {
    id: "m-user",
    role: "user",
    agent: plan.customAgent,
    model: { providerID: plan.customProvider, modelID: plan.customModel, variant: "low" },
    text: PROMPT,
    ...over,
  }
}

/** Assistant turn carrying the completed user-tool call and the final text. */
function assistantMsg(): MessageTruth {
  return {
    id: "m-assistant",
    role: "assistant",
    text: SCRIPTED.restartFinal,
    tools: [{ tool: plan.realUserTool, status: "completed", callID: "call_e2e_restart_1" }],
  }
}

describe("modelLabelShows (model selector readiness gate)", () => {
  it("matches the catalog-resolved provider/model names", () => {
    expect(modelLabelShows("e2e-local", "e2e-model", "E2E Local / E2E Model")).toBe(true)
  })

  it("matches the raw pinned form", () => {
    expect(modelLabelShows("e2e-local", "e2e-model", "e2e-local / e2e-model")).toBe(true)
  })

  it("rejects the gateway fallback / unloaded selector labels", () => {
    expect(modelLabelShows("e2e-local", "e2e-model", "Kilo Auto Free")).toBe(false)
    expect(modelLabelShows("e2e-local", "e2e-model", "Select model")).toBe(false)
    expect(modelLabelShows("e2e-local", "e2e-model", "No providers")).toBe(false)
  })
})

describe("restartSessionReason (shared backend pin predicate)", () => {
  it("passes when the first user message is pinned to the custom provider/model/variant", () => {
    expect(restartSessionReason(snap([userMsg(), assistantMsg()]), "s1", plan, PROMPT)).toBeUndefined()
  })

  it("fails when the first user message was routed to the gateway fallback (LOCK-006)", () => {
    const reason = restartSessionReason(snap([userMsg({ model: FALLBACK }), assistantMsg()]), "s1", plan, PROMPT)
    expect(reason).toContain("pin mismatch")
    expect(reason).toContain("kilo-auto/free")
  })

  it("fails when the first user message carries the wrong variant", () => {
    const reason = restartSessionReason(
      snap([userMsg({ model: { providerID: plan.customProvider, modelID: plan.customModel, variant: "high" } }), assistantMsg()]),
      "s1",
      plan,
      PROMPT,
    )
    expect(reason).toContain("pin mismatch")
    expect(reason).toContain("high")
  })

  it("fails when the first user message carries no model at all", () => {
    const reason = restartSessionReason(snap([userMsg({ model: undefined }), assistantMsg()]), "s1", plan, PROMPT)
    expect(reason).toContain("pin mismatch")
    expect(reason).toContain("model=<none>")
  })

  it("fails when the first user message agent does not match", () => {
    const reason = restartSessionReason(
      snap([userMsg({ agent: "code", model: FALLBACK }), assistantMsg()]),
      "s1",
      plan,
      PROMPT,
    )
    expect(reason).toContain("pin mismatch")
    expect(reason).toContain("user message m-user agent=")
  })

  it("a later retry with the correct model cannot mask a wrong first message", () => {
    // The bug: the first send raced webview config (gateway fallback), a retry
    // then sent with the custom model and completed the turn. The FIRST user
    // message's model is immutable, so the pin must keep failing forever.
    const retried = [userMsg({ id: "m-wrong", model: FALLBACK }), userMsg({ id: "m-retry" }), assistantMsg()]
    const reason = restartSessionReason(snap(retried), "s1", plan, PROMPT)
    expect(reason).toContain("pin mismatch")
    expect(reason).toContain("kilo-auto/free")
  })

  it("still fails when the session record itself is pinned to the fallback", () => {
    const bad = snap([userMsg(), assistantMsg()])
    bad.sessions[0]!.model = { providerID: FALLBACK.providerID, modelID: FALLBACK.modelID }
    const reason = restartSessionReason(bad, "s1", plan, PROMPT)
    expect(reason).toContain("pin mismatch")
    expect(reason).toContain("session s1 model=")
  })

  it("treats a missing session and a missing user message as transient (not pin failures)", () => {
    expect(restartSessionReason(snap([]), "missing", plan, PROMPT)).toContain("missing from backend")
    expect(restartSessionReason(snap([]), "s1", plan, PROMPT)).toContain("no UI-submitted user message")
  })
})
