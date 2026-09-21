/**
 * Bounded live fd3/fd4 durable operation -> private observation -> AgentManager recentOperations/OperationStatus E2E probe.
 * Darwin/Linux only; Windows fails fast per existing harness convention.
 * Proves: real kilo serve SessionPromptDispatch via fd3/fd4 PrivatePeer -> observation/operations panel projection -> AgentManager recentOperations -> OperationStatus hidden/visible.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Browser, Frame } from "@playwright/test"
import type { E2EPlan } from "./e2e-probe-dom"
import { findAgentManagerFrameAny, waitForFile } from "./e2e-probe-dom"
import { canonicalDbPath, validateGateEvidence } from "./e2e-canonical"

export interface OperationProjectionEvidence {
  scenario: string
  collectedAt: string
  pid: number
  canonical: { dbPath: string; gateOk: boolean; gateErr?: string }
  testBridge: boolean
  create: { opId: string; requestId: string; directory: string; privateSucceeded: boolean; sessionId: string }
  prompt: { opId: string; requestId: string; directory: string; messageId: string; privateSucceeded: boolean; accepted: boolean; sessionId: string }
  operations: { opId: string; outcome: string; found: boolean; safe: boolean; finite: boolean; outcomeLegal: boolean; limit: number }
  replay: { sameMessage: boolean; succeeded: boolean; opId: string; requestId: string; accepted: boolean }
  observation: { userCount: number; hasMarker: boolean; sessionExists: boolean }
  replayObservation: { userCountAfterReplay: number; hasMarker: boolean; noDuplicate: boolean }
  notifications: { beforeLen: number; afterLen: number; notifValidationBefore: unknown; notifValidationAfter: unknown; extraAllowed: boolean }
  recentOperations: { before: unknown; afterReplay: unknown; closeVerified: boolean | null; closeDetail?: string }
  statusTextExpect?: string
  shouldBeHidden?: boolean
}

// eslint-disable-next-line complexity
export async function assertOperationProjectionLifecycle(browser: Browser, _plan: E2EPlan, scratch: string): Promise<void> {
  const timeout = 30_000
  await waitForFile(join(scratch, "operation-projection-ready"), 120_000, "operation-projection-ready marker")
  await waitForFile(join(scratch, "operation-projection-cstate.json"), timeout, "operation-projection-cstate")
  {
    const cstate = JSON.parse(readFileSync(join(scratch, "operation-projection-cstate.json"), "utf8")) as Record<string, unknown>
    console.log("[probe operation-projection fd3/fd4] cstate", JSON.stringify(cstate).slice(0, 400))
  }
  const gateRaw = readFileSync(join(scratch, "canonical-gate.json"), "utf8")
  const gate = JSON.parse(gateRaw) as Record<string, unknown>
  const gateErr = validateGateEvidence(gate)
  if (gateErr) throw new Error(`probe operation-projection: canonical gate invalid: ${gateErr}`)
  console.log("[probe operation-projection fd3/fd4] canonical gate ok via validateGateEvidence, gateOk=true")

  const found = await findAgentManagerFrameAny(browser, 60_000)
  const frame: Frame = found.frame
  console.log("[probe operation-projection fd3/fd4] frame ready", found.url)

  await waitForFile(join(scratch, "operation-projection-runtime-evidence"), 120_000, "operation-projection runtime evidence")
  const runtime = JSON.parse(readFileSync(join(scratch, "operation-projection-runtime-evidence"), "utf8")) as OperationProjectionEvidence & Record<string, unknown>

  if (runtime.scenario !== "operation-projection") throw new Error(`scenario must be operation-projection got ${String(runtime.scenario)}`)
  if (runtime.canonical?.gateOk !== true) throw new Error(`gateOk must be true, got ${String(runtime.canonical?.gateOk)}`)
  const create = runtime.create as Record<string, unknown> | undefined
  if (!create || create.privateSucceeded !== true) throw new Error(`private create must succeed via fd3/fd4, got ${JSON.stringify(create).slice(0, 500)}`)
  const sessionId = create.sessionId as string | undefined
  if (!sessionId || !sessionId.startsWith("ses")) throw new Error(`sessionId must be ses*, got ${String(sessionId)}`)
  const prompt = runtime.prompt as Record<string, unknown> | undefined
  if (!prompt || prompt.privateSucceeded !== true) throw new Error(`private prompt must succeed via fd3/fd4, got ${JSON.stringify(prompt).slice(0, 800)}`)
  if (prompt.accepted !== true) throw new Error(`prompt accepted must be true, got ${String(prompt.accepted)}`)
  const messageId = prompt.messageId as string | undefined
  if (!messageId || !messageId.startsWith("msg")) throw new Error(`messageId must be msg*, got ${String(messageId)}`)
  const expectedOpId = `prompt:${messageId}`
  if (prompt.opId !== expectedOpId) throw new Error(`opId must be canonical ${expectedOpId}, got ${String(prompt.opId)}`)
  const obs = runtime.observation as Record<string, unknown> | undefined
  if (!obs) throw new Error("observation missing")
  if (obs.hasMarker !== true) throw new Error(`observation hasMarker must be true, got ${String(obs.hasMarker)}`)
  if (typeof obs.userCount !== "number" || obs.userCount < 1) throw new Error(`userCount must be >=1, got ${String(obs.userCount)}`)
  if (obs.sessionExists !== true) throw new Error("sessionExists must be true")
  const ops = runtime.operations as Record<string, unknown> | undefined
  if (!ops || ops.found !== true) throw new Error(`operations found must be true, got ${JSON.stringify(ops).slice(0, 600)}`)
  if (ops.opId !== expectedOpId) throw new Error(`operations opId must be ${expectedOpId}, got ${String(ops.opId)}`)
  if (ops.safe !== true) throw new Error(`operations safe must be true (no detail/stack leak), got ${JSON.stringify(ops).slice(0, 600)}`)
  if (ops.finite !== true) throw new Error(`operations finite must be true, got ${JSON.stringify(ops).slice(0, 600)}`)
  if (ops.outcomeLegal !== true) throw new Error(`operations outcomeLegal must be true, got ${JSON.stringify(ops).slice(0, 600)}`)
  const outcome = ops.outcome as string | undefined
  const allowed = new Set(["succeeded", "failed", "ambiguous", "in-flight", "superseded", "abandoned"])
  if (!outcome || !allowed.has(outcome)) throw new Error(`outcome must be legal ${Array.from(allowed).join(",")} got ${String(outcome)}`)
  // notification snapshot validation: if harness could read it, it must be valid
  const notifs = runtime.notifications as Record<string, unknown> | undefined
  if (notifs) {
    const vBefore = notifs.notifValidationBefore as Record<string, unknown> | undefined
    if (vBefore && typeof vBefore.valid === "boolean" && vBefore.valid === false) {
      const reason = (vBefore as Record<string, unknown>).reason as string | undefined
      // only fail if there were entries and validation failed
      const beforeLen = notifs.beforeLen as number | undefined
      if (typeof beforeLen === "number" && beforeLen > 0) throw new Error(`notification before validation failed: ${String(reason).slice(0, 400)}`)
    }
    const afterLen = notifs.afterLen as number | undefined
    const beforeLen = notifs.beforeLen as number | undefined
    if (typeof beforeLen === "number" && typeof afterLen === "number" && afterLen !== -1 && beforeLen !== -1) {
      if (afterLen > beforeLen + 1) throw new Error(`replay produced too many notifications before=${beforeLen} after=${afterLen} (max +1 allowed)`)
    }
  }

  const replay = runtime.replay as Record<string, unknown> | undefined
  if (!replay || replay.succeeded !== true) throw new Error(`replay must succeed, got ${JSON.stringify(replay).slice(0, 400)}`)
  if (replay.sameMessage !== true) throw new Error("replay sameMessage must be true")
  if (replay.accepted !== true) throw new Error("replay accepted must be true")
  if (replay.opId !== expectedOpId) throw new Error(`replay opId must equal ${expectedOpId}`)
  const replayObs = runtime.replayObservation as Record<string, unknown> | undefined
  if (!replayObs || replayObs.noDuplicate !== true) throw new Error(`replay noDuplicate must be true, got ${JSON.stringify(replayObs).slice(0, 400)}`)
  if (replayObs.userCountAfterReplay !== obs.userCount) throw new Error(`userCount after replay must equal before ${obs.userCount}, got ${replayObs.userCountAfterReplay}`)

  await waitForFile(join(scratch, "operation-projection-status.json"), timeout, "operation-projection-status")
  const status = JSON.parse(readFileSync(join(scratch, "operation-projection-status.json"), "utf8")) as Record<string, unknown>
  const canonical = canonicalDbPath(scratch)
  if (status.dbPath !== canonical) throw new Error(`canonical DB mismatch status.dbPath=${status.dbPath} canonical=${canonical}`)
  if (status.testBridge !== true) throw new Error(`testBridge not enabled status=${JSON.stringify(status)}`)

  // ---- AgentManager recentOperations via probe-side inspection ----
  // Use the harnessed recentOps snapshot already validated in boundary, but re-assert here:
  // The boundary already checked recentOperations[sessionId] same opId. Here we double-check via reading the scratch recentOps file
  // and via DOM for OperationStatus visibility.
  let recentOpsSnapshot: Record<string, unknown> | null = null
  try {
    const raw = readFileSync(join(scratch, "operation-projection-recentops-before.json"), "utf8")
    recentOpsSnapshot = JSON.parse(raw) as Record<string, unknown>
  } catch {}
  if (recentOpsSnapshot) {
    const map = (recentOpsSnapshot as Record<string, unknown>).recentOperations as Record<string, unknown> | undefined ?? recentOpsSnapshot as Record<string, unknown> | undefined
    const entry = map?.[sessionId] as Record<string, unknown> | undefined
    if (!entry) throw new Error(`probe: recentOperations missing for ${sessionId} in scratch snapshot`)
    if (entry.opId !== expectedOpId) throw new Error(`probe: recentOperations opId must be ${expectedOpId}, got ${String(entry.opId)}`)
    if ("detail" in entry || "stack" in entry) throw new Error(`probe: recentOperations leaked detail/stack`)
  }

  // ---- DOM OperationStatus verification ----
  // Need to ensure the session is active in the webview to see its TaskHeader OperationStatus
  // Click the tab if it exists, else continue (some harnesses may have no tab open yet)
  try {
    const tab = frame.locator(`.am-tab-sortable[data-tab-id="${sessionId}"]`).first()
    const count = await tab.count()
    if (count > 0) {
      await tab.locator(".am-tab-target").first().click({ timeout: 5_000 }).catch(() => {})
      await frame.waitForTimeout(600)
    }
  } catch {}
  // OperationStatus component: data-component="am-operation-status" with data-tone and text in data-slot="am-operation-text"
  // For succeeded, it should be hidden (no element). For other outcomes, it should be visible with safe text.
  const opStatus = frame.locator('[data-component="am-operation-status"]').first()
  const count = await opStatus.count().catch(() => 0)
  const shouldBeHidden = runtime.shouldBeHidden === true
  if (shouldBeHidden) {
    if (count !== 0) {
      const text = await frame.locator('[data-slot="am-operation-text"]').first().textContent().catch(() => "<unreadable>")
      throw new Error(`OperationStatus should be hidden for succeeded outcome but found visible count=${count} text=${String(text).slice(0, 200)} (must not misjudge hidden as failure)`)
    }
    console.log(`[probe operation-projection fd3/fd4] OperationStatus correctly hidden for succeeded outcome`)
  } else {
    if (count === 0) throw new Error(`OperationStatus should be visible for outcome=${String(outcome)} but found hidden (count=0)`)
    const text = await frame.locator('[data-slot="am-operation-text"]').first().textContent().catch(() => "")
    if (!text || text.length === 0) throw new Error(`OperationStatus text empty for outcome=${String(outcome)}`)
    if (text.includes("detail") || text.includes("stack") || text.includes("[redacted]")) throw new Error(`OperationStatus leaked detail/stack text=${text.slice(0, 200)}`)
    console.log(`[probe operation-projection fd3/fd4] OperationStatus visible for outcome=${String(outcome)} text=${text.slice(0, 120)}`)
  }

  // ---- close/forget verification (if bridge available) ----
  const closeVerified = (runtime.recentOperations as Record<string, unknown> | undefined)?.closeVerified as boolean | null | undefined
  const closeDetail = (runtime.recentOperations as Record<string, unknown> | undefined)?.closeDetail as string | undefined
  if (closeVerified === true) {
    console.log(`[probe operation-projection fd3/fd4] close/forget cleared recentOperations verified`)
  } else if (closeVerified === false) {
    console.warn(`[probe operation-projection fd3/fd4] close/forget did not clear recentOperations: ${String(closeDetail).slice(0, 400)}`)
    // don't fail if close not clearing yet? Spec says if bridge easy then verify cleared; if we verified false, that's a failure to report but not necessarily fatal if unverified
    // However our boundary marked closeVerified false only when after forget still contains entry — that's an error in recentOps prune logic, so fail
    throw new Error(`close/forget verification failed: ${String(closeDetail).slice(0, 400)}`)
  } else {
    console.log(`[probe operation-projection fd3/fd4] close/forget unverified (no easy bridge): ${String(closeDetail ?? "no detail").slice(0, 300)}`)
  }

  console.log(`[probe operation-projection fd3/fd4] proven session=${sessionId} msg=${messageId} opId=${expectedOpId} outcome=${String(outcome)} userCount=${obs.userCount} replaySame=${replay.sameMessage} gateOk=${runtime.canonical?.gateOk}`)

  writeFileSync(join(scratch, "operation-projection-dom-evidence"), JSON.stringify({ url: frame.url(), runtime, canonical, status }, null, 2))
  console.log("[probe operation-projection fd3/fd4] lifecycle passed via ServePrivatePeer fd3/fd4 boundary")
}
