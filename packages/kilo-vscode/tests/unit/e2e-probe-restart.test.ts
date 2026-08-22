import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { restartSessionReason } from "../../script/e2e-probe-restart"
import { SCRIPTED } from "../../script/e2e-scripted-model"
import { modelLabelShows, agentOptionFailure } from "../../script/e2e-probe-dom"
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

describe("restart probe isolation (normalized helper)", () => {
  it("uses the shared normalized isolation helper, not raw startsWith", () => {
    const src = readFileSync(join(import.meta.dirname, "../../script/e2e-probe-restart.ts"), "utf8")
    expect(src).toContain("isIsolatedDataRoot")
    expect(src).not.toContain("dataRoot.startsWith(scratch)")
    expect(src).not.toContain("!dataRoot.startsWith")
  })
  // Prefix-attack cases for isIsolatedDataRoot itself are covered in
  // tests/unit/e2e-canonical.test.ts and are intentionally not duplicated here.
})

describe("agentOptionFailure (ModeSwitcher distinction)", () => {
  it("distinguishes a never-rendered trigger from an empty rendered list", () => {
    const unrendered = agentOptionFailure({ triggerRendered: false, variant: "absent", options: [] }, "E2E Agent")
    expect(unrendered).toContain("trigger never rendered")
    const empty = agentOptionFailure({ triggerRendered: true, variant: "interactive", options: [] }, "E2E Agent")
    expect(empty).toContain("0 visible option(s)")
    expect(empty).not.toContain("never rendered")
  })

  it("requires >= 2 visible options even when the expected label is present", () => {
    const single = agentOptionFailure({ triggerRendered: true, variant: "interactive", options: ["E2E Agent"] }, "E2E Agent")
    expect(single).toContain("1 visible option(s)")
    expect(single).toContain("expected >= 2")
    expect(agentOptionFailure({ triggerRendered: true, variant: "interactive", options: ["E2E Agent", "E2E Agent B"] }, "E2E Agent")).toBeUndefined()
  })

  it("fails when the expected label is missing from a populated list", () => {
    const reason = agentOptionFailure({ triggerRendered: true, variant: "interactive", options: ["Ask", "Code"] }, "E2E Agent")
    expect(reason).toContain("expected label not listed")
    expect(reason).toContain("options=[Ask, Code]")
  })

  it("restartPhase0 probes canonical state BEFORE the agent-list assertion and the runner services the marker", () => {
    const probeSrc = readFileSync(join(import.meta.dirname, "../../script/e2e-probe-restart.ts"), "utf8")
    const cstateAt = probeSrc.indexOf("await requestCanonicalState(scratch")
    const agentAt = probeSrc.indexOf("await waitForAgentOption(frame, plan.customAgentLabel, timeout)")
    expect(cstateAt).toBeGreaterThan(-1)
    expect(agentAt).toBeGreaterThan(cstateAt)
    const runnerSrc = readFileSync(join(import.meta.dirname, "../e2e/runner.ts"), "utf8")
    expect(runnerSrc).toContain('"kilo-code.new.e2eFixture.canonicalState"')
    expect(runnerSrc).toContain('rr-cstate-request')
    expect(runnerSrc).toContain('rr-cstate.json')
  })
})
