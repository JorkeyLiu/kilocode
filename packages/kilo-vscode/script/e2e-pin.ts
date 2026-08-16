/**
 * Shared backend-observable pin predicate for the real E2E scenarios
 * (LOCK-006): every UI-submitted user message must be pinned to the run-owned
 * custom provider/model with the expected reasoning variant and the selected
 * custom agent. Pure — no Playwright/vscode import — so the focused unit tests
 * run it directly and every real scenario (real-session, real-completed,
 * real-overflow, real-restart) shares the SAME typed assertion.
 *
 * A pin is the served-backend record (session model/agent + user-message
 * model/agent) proving a UI-submitted prompt ran on the run-owned custom
 * provider/model/variant — never the gateway KILO_AUTO free fallback
 * (kilo/kilo-auto/free) or any non-run-owned provider. Wrong-pin failures are
 * PERMANENT: every failure string carries the exact token `pin mismatch`, and
 * every retry helper treats any failure containing it as non-retryable — the
 * FIRST user message's model is immutable in the served transcript, so a wrong
 * first send can never be masked by a later correct retry (LOCK-008).
 *
 * Backend-generated synthetic messages are never UI-submitted: the
 * automatic-continuation user message (compaction_continue → `continuation`
 * truth) and the auto-compaction record message (compaction part) are excluded
 * from the submitted set so they can never be mistaken for a UI send (H-13).
 */

import type { BackendSnapshot, MessageTruth, SessionTruth } from "../src/agent-manager/fixture-backend"

/** The exact pin one UI send must produce (custom agent + provider/model + variant). */
export interface PinExpectation {
  agent: string
  provider: string
  model: string
  /** Display label ("Low"); compared case-insensitively to the pinned variant id. */
  variant: string
}

/** The real-session pinned expectation for a send: custom agent + model + variant. */
export function pinExpect(plan: { customProvider: string; customModel: string }, agent: string, variant: string): PinExpectation {
  return { agent, provider: plan.customProvider, model: plan.customModel, variant }
}

/** Backend-generated synthetic user messages are never UI-submitted. */
export function isSyntheticUser(m: MessageTruth): boolean {
  return m.continuation === true || m.compaction !== undefined
}

/** The UI-submitted user messages of one session whose text contains the prompt. */
export function submittedUserMessages(snap: BackendSnapshot, sessionID: string, prompt: string): MessageTruth[] {
  return (snap.messages[sessionID] ?? []).filter(
    (m) => m.role === "user" && !isSyntheticUser(m) && m.text.includes(prompt),
  )
}

/**
 * Message-level pin check: agent + providerID/modelID + expected variant.
 * Returns the permanent failure reason (always carrying `pin mismatch`) or
 * undefined when the message is pinned exactly as the UI send must have made
 * it. Exported for the focused unit tests and the per-send evidence report.
 */
export function userPinReason(m: MessageTruth, exp: PinExpectation): string | undefined {
  if (m.agent !== exp.agent) {
    return `pin mismatch: user message ${m.id} agent="${m.agent}" expected "${exp.agent}"`
  }
  const expectedVariant = exp.variant.toLowerCase()
  const md = m.model
  if (!md) {
    return `pin mismatch: user message ${m.id} model=<none> expected ${exp.provider}/${exp.model}/${expectedVariant}`
  }
  if (md.providerID !== exp.provider || md.modelID !== exp.model || md.variant !== expectedVariant) {
    return `pin mismatch: user message ${m.id} model=${JSON.stringify(md)} expected ${exp.provider}/${exp.model}/${expectedVariant}`
  }
  return undefined
}

/** Session-record pin check (agent + provider/model; the variant lives per message). */
export function sessionPinReason(s: SessionTruth, exp: PinExpectation): string | undefined {
  if (s.agent !== exp.agent) {
    return `pin mismatch: session ${s.id} agent="${s.agent}" expected "${exp.agent}"`
  }
  const md = s.model
  if (!md) {
    return `pin mismatch: session ${s.id} model=<none> expected ${exp.provider}/${exp.model}`
  }
  if (md.providerID !== exp.provider || md.modelID !== exp.model) {
    return `pin mismatch: session ${s.id} model=${JSON.stringify(md)} expected ${exp.provider}/${exp.model}`
  }
  return undefined
}

/**
 * The typed pin predicate for one UI send: the session record AND EVERY
 * UI-submitted user message carrying `prompt` must be pinned to the expected
 * agent + provider/model + variant. A wrong pin on ANY submitted message
 * (including the first, which is immutable) is a permanent failure — even when
 * a later retry sent correctly. Missing sessions/messages are transient states
 * (retryable); they never carry the `pin mismatch` token. Exported for the
 * focused unit tests and every real scenario.
 */
export function pinnedReason(
  snap: BackendSnapshot,
  sessionID: string,
  exp: PinExpectation,
  prompt: string,
): string | undefined {
  const s = snap.sessions.find((x) => x.id === sessionID)
  if (!s) return `session ${sessionID} missing from backend`
  const sess = sessionPinReason(s, exp)
  if (sess) return sess
  const users = submittedUserMessages(snap, sessionID, prompt)
  if (users.length === 0) {
    return `session ${sessionID} has no UI-submitted user message for prompt "${prompt}" yet`
  }
  for (const m of users) {
    const bad = userPinReason(m, exp)
    if (bad) return bad
  }
  return undefined
}

/**
 * Compose a scenario probe with the pin predicate. The pin is checked FIRST so
 * a wrong-pinned first send is detected on the first snapshot that carries the
 * message — even while the underlying probe (tool parts, status, transcript)
 * has not converged — and the failure is permanent (fatal), never masked by a
 * retry. Transient pin states (session/message not yet written) fall through
 * to the scenario probe.
 */
export function withPin(
  probe: (s: BackendSnapshot) => string | undefined,
  exp: PinExpectation,
  prompt: string,
  sessionID: (s: BackendSnapshot) => string | undefined,
): (s: BackendSnapshot) => string | undefined {
  return (s) => {
    const id = sessionID(s)
    if (id) {
      const bad = pinnedReason(s, id, exp, prompt)
      if (bad) return bad
    }
    return probe(s)
  }
}

/** True when a probe failure is a permanent wrong-pin violation (non-retryable). */
export function isWrongPin(failure: string): boolean {
  return failure.includes("pin mismatch")
}

/** Compact per-send pin evidence for the dom-evidence files (LOCK-008). */
export function pinReport(snap: BackendSnapshot, sessionID: string, exp: PinExpectation, prompt: string) {
  const users = submittedUserMessages(snap, sessionID, prompt)
  return {
    prompt,
    expected: {
      agent: exp.agent,
      model: `${exp.provider}/${exp.model}`,
      variant: exp.variant.toLowerCase(),
    },
    users: users.map((m) => ({
      id: m.id,
      agent: m.agent ?? null,
      model: m.model
        ? `${m.model.providerID}/${m.model.modelID}${m.model.variant ? `/${m.model.variant}` : ""}`
        : null,
      pass: userPinReason(m, exp) === undefined,
    })),
  }
}
