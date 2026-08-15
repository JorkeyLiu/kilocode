import { describe, expect, it } from "bun:test"
import {
  isSyntheticUser,
  isWrongPin,
  pinnedReason,
  pinReport,
  submittedUserMessages,
  userPinReason,
  withPin,
  type PinExpectation,
} from "../../script/e2e-pin"
import { SCRIPTED } from "../../script/e2e-scripted-model"
import type { BackendSnapshot, MessageTruth } from "../../src/agent-manager/fixture-backend"
import type { E2EPlan } from "../../script/e2e-probe-dom"

/** The run-owned custom identities every real scenario pins to. */
const plan = {
  customProvider: "e2e-local",
  customModel: "e2e-model",
  customAgent: "e2e-agent",
  customVariantA: "Low",
} as E2EPlan

const exp: PinExpectation = {
  agent: plan.customAgent,
  provider: plan.customProvider,
  model: plan.customModel,
  variant: plan.customVariantA,
}

/** The gateway free-model fallback the webview resolves before config (LOCK-006). */
const FALLBACK = { providerID: "kilo", modelID: "kilo-auto/free" } as const

const PROMPT = "E2E prompt A"

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

function snapWith(msgs: MessageTruth[], sessionOver: Partial<{ agent: string | null; model: object }> = {}): BackendSnapshot {
  return {
    requestedAt: "2026-01-01T00:00:00.000Z",
    sessions: [
      {
        id: "s1",
        title: "E2E session",
        agent: sessionOver.agent === undefined ? plan.customAgent : sessionOver.agent,
        model:
          sessionOver.model === undefined
            ? { providerID: plan.customProvider, modelID: plan.customModel }
            : sessionOver.model,
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

describe("pinnedReason (shared typed pin predicate)", () => {
  it("passes when the session record and the submitted user message are pinned exactly", () => {
    expect(pinnedReason(snapWith([userMsg()]), "s1", exp, PROMPT)).toBeUndefined()
  })

  it("fails when the FIRST message was routed to the gateway fallback even after a correct retry (LOCK-006)", () => {
    // The first send raced webview config (kilo/kilo-auto/free); a later retry
    // sent correctly and the turn completed. The first message's model is
    // immutable, so the pin must keep failing forever — never masked.
    const retried = [userMsg({ id: "m-wrong", model: FALLBACK }), userMsg({ id: "m-retry" })]
    const reason = pinnedReason(snapWith(retried), "s1", exp, PROMPT)
    expect(reason).toContain("pin mismatch")
    expect(reason).toContain("kilo-auto/free")
  })

  it("fails on a wrong variant on the user message", () => {
    const wrong = userMsg({ model: { providerID: exp.provider, modelID: exp.model, variant: "high" } })
    const reason = pinnedReason(snapWith([wrong]), "s1", exp, PROMPT)
    expect(reason).toContain("pin mismatch")
    expect(reason).toContain("high")
  })

  it("fails when the user message carries no model at all", () => {
    const reason = pinnedReason(snapWith([userMsg({ model: undefined })]), "s1", exp, PROMPT)
    expect(reason).toContain("pin mismatch")
    expect(reason).toContain("model=<none>")
  })

  it("fails on a wrong agent on the user message", () => {
    const reason = pinnedReason(snapWith([userMsg({ agent: "code" })]), "s1", exp, PROMPT)
    expect(reason).toContain("pin mismatch")
    expect(reason).toContain("user message m-user agent=")
  })

  it("fails on a wrong agent on the session record", () => {
    const reason = pinnedReason(snapWith([userMsg()], { agent: "code" }), "s1", exp, PROMPT)
    expect(reason).toContain("pin mismatch")
    expect(reason).toContain("session s1 agent=")
  })

  it("fails on a wrong provider/model on the session record", () => {
    const reason = pinnedReason(snapWith([userMsg()], { model: FALLBACK }), "s1", exp, PROMPT)
    expect(reason).toContain("pin mismatch")
    expect(reason).toContain("session s1 model=")
    expect(reason).toContain("kilo-auto/free")
  })

  it("H-12: matches only the user message(s) carrying the given prompt (reopened-panel per-send pins)", () => {
    // The H-12 edit turn and the summary turn share ONE session after the panel
    // reopen. Each send's pin only inspects the messages for ITS prompt: a
    // wrong-pinned EDIT message must not fail the SUMMARY send's pin, and vice
    // versa — while the edit send's own pin keeps failing forever.
    const editPrompt = `${SCRIPTED.rollbackMarker}: edit the tracked file`
    const summaryPrompt = `${SCRIPTED.rollbackSummaryMarker}: summarize the edit`
    const editWrong = userMsg({ id: "m-edit", model: FALLBACK, text: editPrompt })
    const summaryRight = userMsg({ id: "m-summary", text: summaryPrompt })
    const snap = snapWith([editWrong, summaryRight])
    expect(pinnedReason(snap, "s1", exp, summaryPrompt)).toBeUndefined()
    const editReason = pinnedReason(snap, "s1", exp, editPrompt)
    expect(editReason).toContain("pin mismatch")
    expect(editReason).toContain("kilo-auto/free")
  })

  it("distinguishes backend-generated synthetic continuation messages (never UI-submitted)", () => {
    // H-13: the backend writes a synthetic automatic-continuation user message
    // (compaction_continue) with no model pin. It must be excluded from the
    // submitted set — otherwise a real overflow turn would look unpinned.
    const synthetic = userMsg({
      id: "m-cont",
      model: undefined,
      agent: undefined,
      text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
      continuation: true,
    })
    const snap = snapWith([synthetic, userMsg({ id: "m-real" })])
    expect(isSyntheticUser(synthetic)).toBe(true)
    expect(pinnedReason(snap, "s1", exp, PROMPT)).toBeUndefined()
  })

  it("also excludes the auto-compaction record message from the submitted set", () => {
    const compaction = userMsg({
      id: "m-compact",
      model: undefined,
      agent: undefined,
      text: "",
      compaction: { auto: true },
    })
    expect(isSyntheticUser(compaction)).toBe(true)
    expect(submittedUserMessages(snapWith([compaction]), "s1", PROMPT)).toEqual([])
  })

  it("reports a missing session and a missing user message as transient (no pin token)", () => {
    expect(pinnedReason(snapWith([]), "missing", exp, PROMPT)).toContain("missing from backend")
    expect(pinnedReason(snapWith([]), "s1", exp, PROMPT)).toContain("no UI-submitted user message")
  })

  it("fails when ANY submitted message for the prompt is wrong, not just the first", () => {
    const second = [userMsg({ id: "m-first" }), userMsg({ id: "m-second", model: FALLBACK })]
    const reason = pinnedReason(snapWith(second), "s1", exp, PROMPT)
    expect(reason).toContain("pin mismatch")
    expect(reason).toContain("m-second")
  })
})

describe("isWrongPin (fatal matcher coverage)", () => {
  it("matches every session-level and message-level wrong-pin error form", () => {
    expect(isWrongPin(`pin mismatch: session s1 agent="code" expected "e2e-agent"`)).toBe(true)
    expect(isWrongPin(`pin mismatch: session s1 model=${JSON.stringify(FALLBACK)} expected e2e-local/e2e-model`)).toBe(true)
    expect(isWrongPin(`pin mismatch: session s1 model=<none> expected e2e-local/e2e-model`)).toBe(true)
    expect(isWrongPin(`pin mismatch: user message m1 agent="code" expected "e2e-agent"`)).toBe(true)
    expect(isWrongPin(`pin mismatch: user message m1 model=${JSON.stringify(FALLBACK)} expected e2e-local/e2e-model/low`)).toBe(true)
    expect(isWrongPin(`pin mismatch: user message m1 model=<none> expected e2e-local/e2e-model/low`)).toBe(true)
  })

  it("never matches transient failures (retryable)", () => {
    expect(isWrongPin("session s1 missing from backend")).toBe(false)
    expect(isWrongPin('session s1 has no UI-submitted user message for prompt "x" yet')).toBe(false)
    expect(isWrongPin("no root session yet")).toBe(false)
    expect(isWrongPin("child session missing (delegation did not create one)")).toBe(false)
    expect(isWrongPin("task tool part missing in parent transcript")).toBe(false)
    expect(isWrongPin("parent status=busy expected idle")).toBe(false)
  })
})

describe("withPin (pin composed before the scenario probe)", () => {
  it("returns the pin failure FIRST even when the scenario probe would pass", () => {
    const combined = withPin(
      () => undefined,
      exp,
      PROMPT,
      (s) => s.sessions[0]?.id,
    )
    const wrong = snapWith([userMsg({ model: FALLBACK })])
    expect(combined(wrong)).toContain("pin mismatch")
    expect(combined(wrong)).toContain("kilo-auto/free")
  })

  it("falls through to the scenario probe on transient pin states", () => {
    const combined = withPin(
      (s) => (s.sessions.length === 0 ? "no root session yet" : undefined),
      exp,
      PROMPT,
      (s) => s.sessions[0]?.id,
    )
    const empty = snapWith([])
    empty.sessions = []
    expect(combined(empty)).toBe("no root session yet")
    // Session exists but the message has not been written yet: the transient
    // pin state surfaces a retryable failure (never `pin mismatch`), which the
    // polling loop retries instead of treating as a permanent violation.
    const noMsg = combined(snapWith([]))
    expect(noMsg).toContain("no UI-submitted user message")
    expect(isWrongPin(noMsg!)).toBe(false)
  })
})

describe("pinReport (per-send backend pin evidence)", () => {
  it("reports the expected pin and every submitted message's actual pin", () => {
    const snap = snapWith([userMsg({ id: "m-a" }), userMsg({ id: "m-b", model: FALLBACK })])
    const report = pinReport(snap, "s1", exp, PROMPT)
    expect(report.expected).toEqual({ agent: "e2e-agent", model: "e2e-local/e2e-model", variant: "low" })
    expect(report.users).toEqual([
      { id: "m-a", agent: "e2e-agent", model: "e2e-local/e2e-model/low", pass: true },
      { id: "m-b", agent: "e2e-agent", model: "kilo/kilo-auto/free", pass: false },
    ])
  })

  it("excludes synthetic continuation messages from the reported submitted set", () => {
    const snap = snapWith([userMsg({ id: "m-cont", continuation: true, model: undefined })])
    expect(pinReport(snap, "s1", exp, PROMPT).users).toEqual([])
  })

  it("reports a message with no model as unpinned (pass false)", () => {
    const report = pinReport(snapWith([userMsg({ model: undefined })]), "s1", exp, PROMPT)
    expect(report.users).toEqual([{ id: "m-user", agent: "e2e-agent", model: null, pass: false }])
  })
})

describe("userPinReason (message-level)", () => {
  it("accepts the exact custom pin with the lowercase variant id", () => {
    expect(userPinReason(userMsg(), exp)).toBeUndefined()
  })

  it("rejects a wrong providerID/modelID and a wrong variant", () => {
    expect(userPinReason(userMsg({ model: { providerID: "kilo", modelID: "e2e-probe", variant: "low" } }), exp)).toContain(
      "pin mismatch",
    )
    expect(userPinReason(userMsg({ model: { providerID: exp.provider, modelID: exp.model, variant: "medium" } }), exp)).toContain(
      "pin mismatch",
    )
  })
})
