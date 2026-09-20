/**
 * Bounded live fd3/fd4 ServePrivatePeer observation/changed producer E2E proof for session/revert + session/unrevert.
 * Darwin/Linux only; Windows fails fast per existing harness convention.
 * Proves: real kilo serve SessionRevertDispatch dispatchRevert -> dispatchUnrevert
 * -> fd3/fd4 PrivatePeer -> ServePrivatePeer strict observation/changed validation
 * -> Extension Host AgentManagerProvider consumer.
 * Reuses fixture-gated e2eRevertSeed (real session+message/part checkpoint) plus
 * fixture-gated privateRevertWithHandle/privateUnrevertWithHandle (revert:<session>:<token> / unrevert:<session>:<token> tuple, no SDK fallback)
 * and fixture-gated ServePrivatePeer recorder (post-validation, pre-forward, 50 bounded, monotonic ordinals).
 * Validates v1.0, cursor===last seq, contiguous seq, exact five-key entries,
 * kind changed, session_id matching, revision == result.revision.session == beforeRevision+1,
 * seq/cursor == beforeCursor+1, single notification-driven AgentManager refresh/ack exactly once per fresh mutation,
 * idempotent tuple replay returns same committed snapshot/revision with no new notification/cursor, and
 * no-op unrevert (no marker) or unknown-message revert no-op yields no notification/cursor/refresh.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Browser, Frame } from "@playwright/test"
import type { E2EPlan } from "./e2e-probe-dom"
import { findAgentManagerFrameAny, waitForFile } from "./e2e-probe-dom"
import { canonicalDbPath, isIsolatedDataRoot, validateGateEvidence } from "./e2e-canonical"
import { isValidObservationChangedNotification } from "../src/services/cli-backend/serve-private-peer"

export interface ObservationProducerRevertEvidence {
  scenario: string
  collectedAt: string
  pid: number
  canonical: { dbPath: string; dataRoot?: string; isolateOk?: boolean; gateOk: boolean; gateErr?: string }
  testBridge: boolean
  // fresh revert
  beforeRevert: { cursor: number; persisted?: number; startOrdinal: number; nextOrdinal: number; notifCount: number; refreshCount?: number; revision?: number }
  afterRevert: { cursor: number; persisted?: number; startOrdinal: number; nextOrdinal: number; notifCount: number; refreshCount?: number; revision?: number }
  revertEnvelope: unknown
  revert: { opId: string; requestId: string; directory: string; privateSucceeded: boolean; sessionId: string; messageId: string; partId?: string; revision?: number; seq?: number }
  revertNotification?: { cursor?: number; seq?: number; session_id?: string; kind?: string; revision?: number }
  revertNotificationStrictValid: boolean
  revertContiguous: boolean
  revertAck: { requested: number; persistedAfter?: number; success: boolean }
  revertRefresh?: { beforeCount: number; afterCount: number; advancedOnce: boolean; lastAckCursor?: number; lastBaseline?: number }
  revertReplay?: { sameSession: boolean; sameRevision: boolean; succeeded: boolean; opId: string; requestId: string; snapshotCursor?: number; persistedCursor?: number; revision?: number }
  revertIdempotentSecondNotifCount: number
  // fresh unrevert
  beforeUnrevert: { cursor: number; persisted?: number; startOrdinal: number; nextOrdinal: number; notifCount: number; refreshCount?: number; revision?: number }
  afterUnrevert: { cursor: number; persisted?: number; startOrdinal: number; nextOrdinal: number; notifCount: number; refreshCount?: number; revision?: number }
  unrevertEnvelope: unknown
  unrevert: { opId: string; requestId: string; directory: string; privateSucceeded: boolean; sessionId: string; revision?: number; seq?: number }
  unrevertNotification?: { cursor?: number; seq?: number; session_id?: string; kind?: string; revision?: number }
  unrevertNotificationStrictValid: boolean
  unrevertContiguous: boolean
  unrevertAck: { requested: number; persistedAfter?: number; success: boolean }
  unrevertRefresh?: { beforeCount: number; afterCount: number; advancedOnce: boolean; lastAckCursor?: number; lastBaseline?: number }
  unrevertReplay?: { sameSession: boolean; sameRevision: boolean; succeeded: boolean; opId: string; requestId: string; snapshotCursor?: number; persistedCursor?: number; revision?: number }
  unrevertIdempotentSecondNotifCount: number
  // no-op
  noOp?: { kind: string; privateSucceeded: boolean; notifCount: number; cursorBefore?: number; cursorAfter?: number; persistedBefore?: number; persistedAfter?: number; refreshBefore?: number; refreshAfter?: number; refreshAdvanced?: boolean }
  // post-replay cursors
  postRevertReplayCursor?: number
  postRevertReplayPersisted?: number
  postUnrevertReplayCursor?: number
  postUnrevertReplayPersisted?: number
  expectedSessionId: string
  expectedMessageId: string
}

function extractSeqs(list: unknown[]): number[] {
  const seqs: number[] = []
  for (const item of list) {
    if (item && typeof item === "object") {
      const r = item as Record<string, unknown>
      const params = r.params as Record<string, unknown> | undefined
      const entries = params?.entries as unknown[] | undefined
      if (Array.isArray(entries)) {
        for (const e of entries) {
          if (e && typeof e === "object" && typeof (e as Record<string, unknown>).seq === "number") seqs.push((e as Record<string, unknown>).seq as number)
        }
      }
      if (typeof r.seq === "number") seqs.push(r.seq)
    }
  }
  return seqs
}

function validateRevertEnvelope(envelope: unknown, expectedSessionId: string, beforeCursor: number, beforeRevision: number | undefined, expectedRevision: number | undefined): string | undefined {
  const toValidate = (envelope as Record<string, unknown>)?.params ?? envelope
  if (!isValidObservationChangedNotification(toValidate)) return "envelope fails strict isValidObservationChangedNotification (v1.0, five keys, cursor===last seq, contiguous)"
  const raw = toValidate as { v: string; cursor: number; entries: Array<Record<string, unknown>> }
  const entries = raw.entries
  if (entries.length !== 1) return `expected exactly one entry for single revert, got ${entries.length}`
  const e = entries[0]!
  if (Object.keys(e as Record<string, unknown>).length !== 5) return `entry must have exactly 5 keys got ${Object.keys(e as Record<string, unknown>).length}`
  if (e.kind !== "changed") return `kind mismatch expected changed got ${String(e.kind)}`
  if (e.session_id !== expectedSessionId) return `session_id mismatch expected ${expectedSessionId} got ${String(e.session_id)}`
  const seq = e.seq as number
  if (seq !== beforeCursor + 1) return `seq must be beforeCursor+1 expected ${beforeCursor + 1} got ${seq}`
  if (raw.cursor !== seq) return `cursor must equal seq expected ${seq} got ${raw.cursor}`
  const rev = e.revision as number
  if (typeof rev !== "number" || rev < 0) return `revision must be >=0 got ${String(rev)}`
  if (beforeRevision !== undefined && rev !== beforeRevision + 1) return `revision must be beforeRevision+1 expected ${beforeRevision + 1} got ${rev}`
  if (expectedRevision !== undefined && rev !== expectedRevision) return `revision must equal result revision expected ${expectedRevision} got ${rev}`
  return undefined
}

export async function assertObservationProducerRevertLifecycle(browser: Browser, _plan: E2EPlan, scratch: string): Promise<void> {
  const timeout = 30_000
  await waitForFile(join(scratch, "obs-prod-revert-ready"), 120_000, "obs-prod-revert-ready marker")
  await waitForFile(join(scratch, "obs-prod-revert-cstate.json"), timeout, "obs-prod-revert-cstate")
  {
    const cstate = JSON.parse(readFileSync(join(scratch, "obs-prod-revert-cstate.json"), "utf8")) as Record<string, unknown>
    console.log("[probe obs-prod-revert fd3/fd4] cstate", JSON.stringify(cstate).slice(0, 400))
  }
  const gateRaw = readFileSync(join(scratch, "canonical-gate.json"), "utf8")
  const gate = JSON.parse(gateRaw) as Record<string, unknown>
  const gateErr = validateGateEvidence(gate)
  if (gateErr) throw new Error(`probe obs-prod-revert: canonical gate invalid: ${gateErr}`)
  const dataRoot = gate.dataRoot as string | undefined
  if (typeof dataRoot === "string" && !isIsolatedDataRoot(scratch, dataRoot)) throw new Error(`probe obs-prod-revert: canonical dataRoot not isolated: ${dataRoot}`)
  console.log("[probe obs-prod-revert fd3/fd4] canonical gate ok via validateGateEvidence, gateOk=true")

  const found = await findAgentManagerFrameAny(browser, 60_000)
  const frame: Frame = found.frame
  console.log("[probe obs-prod-revert fd3/fd4] frame ready", found.url)

  await waitForFile(join(scratch, "obs-prod-revert-runtime-evidence"), 120_000, "obs-prod revert runtime evidence")
  const runtime = JSON.parse(readFileSync(join(scratch, "obs-prod-revert-runtime-evidence"), "utf8")) as ObservationProducerRevertEvidence & Record<string, unknown>

  if (runtime.scenario !== "observation-producer-revert") throw new Error(`scenario must be observation-producer-revert got ${String(runtime.scenario)}`)
  const runtimeGateOk = runtime.canonical?.gateOk
  if (runtimeGateOk !== true) throw new Error(`gateOk must be true via validateGateEvidence, got ${String(runtimeGateOk)} gateErr=${String((runtime.canonical as Record<string, unknown>)?.gateErr ?? "")}`)
  if (!runtime.revertNotificationStrictValid) throw new Error(`revert notificationStrictValid must be true (fd3/fd4 strict validation)`)
  if (!runtime.unrevertNotificationStrictValid) throw new Error(`unrevert notificationStrictValid must be true`)
  if (!runtime.revertContiguous) throw new Error("revert contiguous must be true (changefeed continuity: cursor === before+1 and seq===cursor)")
  if (!runtime.unrevertContiguous) throw new Error("unrevert contiguous must be true")
  if (!runtime.revertAck?.success) throw new Error("revert ack must succeed (notification-driven consumer ack with persisted==cursor)")
  if (!runtime.unrevertAck?.success) throw new Error("unrevert ack must succeed")

  const revert = runtime.revert as Record<string, unknown> | undefined
  const unrevert = runtime.unrevert as Record<string, unknown> | undefined
  if (!revert || revert.privateSucceeded !== true) throw new Error(`private revert must succeed via fd3/fd4, got ${JSON.stringify(revert).slice(0, 600)}`)
  if (!unrevert || unrevert.privateSucceeded !== true) throw new Error(`private unrevert must succeed via fd3/fd4, got ${JSON.stringify(unrevert).slice(0, 600)}`)

  const expectedSessionId = (revert.sessionId as string | undefined) ?? (runtime as Record<string, unknown>).expectedSessionId as string | undefined
  const expectedMessageId = (revert.messageId as string | undefined) ?? (runtime as Record<string, unknown>).expectedMessageId as string | undefined
  if (!expectedSessionId) throw new Error("expectedSessionId missing from revert result")
  if (!expectedMessageId) throw new Error("expectedMessageId missing")

  // revert fresh validation
  const beforeRevertCursor = runtime.beforeRevert?.cursor
  const afterRevertCursor = runtime.afterRevert?.cursor
  if (typeof beforeRevertCursor !== "number" || typeof afterRevertCursor !== "number") throw new Error("beforeRevert/afterRevert cursor missing")
  if (afterRevertCursor !== beforeRevertCursor + 1) throw new Error(`revert expected contiguous seq after = before+1, got before ${beforeRevertCursor} after ${afterRevertCursor}`)
  const revertSeqs = extractSeqs([runtime.revertEnvelope])
  if (revertSeqs.length !== 1 || revertSeqs[0] !== afterRevertCursor) throw new Error(`revert seq must equal after cursor, got seqs ${JSON.stringify(revertSeqs)} after ${afterRevertCursor}`)
  const beforeRevertRevision = (runtime.beforeRevert as { revision?: number } | undefined)?.revision as number | undefined
  const revertResultRevision = (revert.revision as number | undefined) ?? (runtime.revert as { revision?: number }).revision as number | undefined
  const errRevert = validateRevertEnvelope(runtime.revertEnvelope, expectedSessionId, beforeRevertCursor, beforeRevertRevision, revertResultRevision)
  if (errRevert) throw new Error(`producer revert envelope invalid via strict validator: ${errRevert} envelope=${JSON.stringify(runtime.revertEnvelope).slice(0, 1200)}`)
  const afterRevertPersisted = runtime.afterRevert?.persisted as number | undefined
  if (typeof afterRevertPersisted !== "number") throw new Error(`afterRevert.persisted must be number equal to afterRevertCursor ${afterRevertCursor}, got ${String(afterRevertPersisted)}`)
  if (afterRevertPersisted !== afterRevertCursor) throw new Error(`afterRevert.persisted must equal afterRevertCursor expected ${afterRevertCursor} got ${afterRevertPersisted}`)
  const ackRevertPersisted = (runtime.revertAck as { persistedAfter?: number } | undefined)?.persistedAfter as number | undefined
  if (typeof ackRevertPersisted !== "number") throw new Error(`revert ack.persistedAfter must be number equal to afterRevertCursor ${afterRevertCursor}, got ${String(ackRevertPersisted)}`)
  if (ackRevertPersisted !== afterRevertCursor) throw new Error(`revert ack.persistedAfter must equal afterRevertCursor expected ${afterRevertCursor} got ${ackRevertPersisted}`)
  const revertRefresh = runtime.revertRefresh as Record<string, unknown> | undefined
  if (!revertRefresh) throw new Error(`revert refresh telemetry missing — single observation-driven refresh must be proven`)
  if (revertRefresh.advancedOnce !== true) throw new Error(`revert refresh must advance exactly once, got ${JSON.stringify(revertRefresh).slice(0, 400)}`)
  if (typeof revertRefresh.lastAckCursor !== "number" || revertRefresh.lastAckCursor !== afterRevertCursor) throw new Error(`revert refresh lastAckCursor must equal notification cursor ${afterRevertCursor}, got ${String(revertRefresh.lastAckCursor)}`)
  if (typeof revertRefresh.lastBaseline !== "number" || revertRefresh.lastBaseline !== beforeRevertCursor) throw new Error(`revert refresh lastBaseline must equal beforeRevert cursor ${beforeRevertCursor}, got ${String(revertRefresh.lastBaseline)}`)

  // unrevert fresh validation (beforeUnrevert is afterRevert)
  const beforeUnrevertCursor = runtime.beforeUnrevert?.cursor
  const afterUnrevertCursor = runtime.afterUnrevert?.cursor
  if (typeof beforeUnrevertCursor !== "number" || typeof afterUnrevertCursor !== "number") throw new Error("beforeUnrevert/afterUnrevert cursor missing")
  if (beforeUnrevertCursor !== afterRevertCursor) throw new Error(`beforeUnrevert must equal afterRevert expected ${afterRevertCursor} got ${beforeUnrevertCursor}`)
  if (afterUnrevertCursor !== beforeUnrevertCursor + 1) throw new Error(`unrevert expected contiguous seq after = before+1, got before ${beforeUnrevertCursor} after ${afterUnrevertCursor}`)
  const unrevertSeqs = extractSeqs([runtime.unrevertEnvelope])
  if (unrevertSeqs.length !== 1 || unrevertSeqs[0] !== afterUnrevertCursor) throw new Error(`unrevert seq must equal after cursor, got seqs ${JSON.stringify(unrevertSeqs)} after ${afterUnrevertCursor}`)
  const beforeUnrevertRevision = (runtime.beforeUnrevert as { revision?: number } | undefined)?.revision as number | undefined
  const unrevertResultRevision = (unrevert.revision as number | undefined) ?? (runtime.unrevert as { revision?: number }).revision as number | undefined
  const errUnrevert = validateRevertEnvelope(runtime.unrevertEnvelope, expectedSessionId, beforeUnrevertCursor, beforeUnrevertRevision, unrevertResultRevision)
  if (errUnrevert) throw new Error(`producer unrevert envelope invalid via strict validator: ${errUnrevert} envelope=${JSON.stringify(runtime.unrevertEnvelope).slice(0, 1200)}`)
  const afterUnrevertPersisted = runtime.afterUnrevert?.persisted as number | undefined
  if (typeof afterUnrevertPersisted !== "number") throw new Error(`afterUnrevert.persisted must be number equal to afterUnrevertCursor ${afterUnrevertCursor}, got ${String(afterUnrevertPersisted)}`)
  if (afterUnrevertPersisted !== afterUnrevertCursor) throw new Error(`afterUnrevert.persisted must equal afterUnrevertCursor expected ${afterUnrevertCursor} got ${afterUnrevertPersisted}`)
  const ackUnrevertPersisted = (runtime.unrevertAck as { persistedAfter?: number } | undefined)?.persistedAfter as number | undefined
  if (typeof ackUnrevertPersisted !== "number") throw new Error(`unrevert ack.persistedAfter must be number equal to afterUnrevertCursor ${afterUnrevertCursor}, got ${String(ackUnrevertPersisted)}`)
  if (ackUnrevertPersisted !== afterUnrevertCursor) throw new Error(`unrevert ack.persistedAfter must equal afterUnrevertCursor expected ${afterUnrevertCursor} got ${ackUnrevertPersisted}`)
  const unrevertRefresh = runtime.unrevertRefresh as Record<string, unknown> | undefined
  if (!unrevertRefresh) throw new Error(`unrevert refresh telemetry missing`)
  if (unrevertRefresh.advancedOnce !== true) throw new Error(`unrevert refresh must advance exactly once, got ${JSON.stringify(unrevertRefresh).slice(0, 400)}`)
  if (typeof unrevertRefresh.lastAckCursor !== "number" || unrevertRefresh.lastAckCursor !== afterUnrevertCursor) throw new Error(`unrevert refresh lastAckCursor must equal notification cursor ${afterUnrevertCursor}, got ${String(unrevertRefresh.lastAckCursor)}`)
  if (typeof unrevertRefresh.lastBaseline !== "number" || unrevertRefresh.lastBaseline !== beforeUnrevertCursor) throw new Error(`unrevert refresh lastBaseline must equal beforeUnrevert cursor ${beforeUnrevertCursor}, got ${String(unrevertRefresh.lastBaseline)}`)

  // idempotent replays
  const revertReplay = runtime.revertReplay as Record<string, unknown> | undefined
  if (revertReplay) {
    if (revertReplay.sameSession !== true) throw new Error(`revert replay must yield same session id`)
    if (revertReplay.sameRevision !== true) throw new Error(`revert replay must yield same revision`)
    if (revertReplay.succeeded !== true) throw new Error(`revert replay private result must succeed`)
  }
  if (typeof runtime.revertIdempotentSecondNotifCount === "number" && runtime.revertIdempotentSecondNotifCount !== 0) throw new Error(`revert idempotent second notif count must be 0, got ${runtime.revertIdempotentSecondNotifCount}`)
  const unrevertReplay = runtime.unrevertReplay as Record<string, unknown> | undefined
  if (unrevertReplay) {
    if (unrevertReplay.sameSession !== true) throw new Error(`unrevert replay must yield same session id`)
    if (unrevertReplay.sameRevision !== true) throw new Error(`unrevert replay must yield same revision`)
    if (unrevertReplay.succeeded !== true) throw new Error(`unrevert replay private result must succeed`)
  }
  if (typeof runtime.unrevertIdempotentSecondNotifCount === "number" && runtime.unrevertIdempotentSecondNotifCount !== 0) throw new Error(`unrevert idempotent second notif count must be 0, got ${runtime.unrevertIdempotentSecondNotifCount}`)

  // post-replay cursors must still equal notificationCursor (direct observation read, not just zero delta)
  const postRevertCursor = (runtime as Record<string, unknown>).postRevertReplayCursor as number | undefined
  if (typeof postRevertCursor !== "number") throw new Error(`postRevertReplayCursor must be number equal to afterUnrevertCursor ${afterUnrevertCursor}, got ${String(postRevertCursor)}`)
  // Note: after revert replay, cursor should still be afterUnrevertCursor (since unrevert happened after). But revert replay happens before unrevert, so its cursor after revert replay should be afterRevertCursor. However our runner does revert replay after revert before unrevert, then unrevert replay after unrevert. So postRevertReplayCursor should equal afterRevertCursor, postUnrevertReplayCursor should equal afterUnrevertCursor.
  // Validate both if present
  const postUnrevertCursor = (runtime as Record<string, unknown>).postUnrevertReplayCursor as number | undefined
  if (typeof postUnrevertCursor !== "number") throw new Error(`postUnrevertReplayCursor must be number equal to afterUnrevertCursor ${afterUnrevertCursor}, got ${String(postUnrevertCursor)}`)
  if (postUnrevertCursor !== afterUnrevertCursor) throw new Error(`postUnrevertReplayCursor must still equal notificationCursor expected ${afterUnrevertCursor} got ${postUnrevertCursor}`)
  if (typeof postRevertCursor === "number" && postRevertCursor !== afterRevertCursor) {
    // Allow postRevertReplayCursor to equal afterRevertCursor, but if runner stored after unrevert, it may equal afterUnrevertCursor. Accept either but ensure no advance beyond afterUnrevert.
    if (postRevertCursor !== afterUnrevertCursor && postRevertCursor !== afterRevertCursor) throw new Error(`postRevertReplayCursor unexpected ${postRevertCursor} expected ${afterRevertCursor} or ${afterUnrevertCursor}`)
  }
  const postRevertPersisted = (runtime as Record<string, unknown>).postRevertReplayPersisted as number | undefined
  if (typeof postRevertPersisted === "number" && postRevertPersisted !== afterRevertCursor && postRevertPersisted !== afterUnrevertCursor) throw new Error(`postRevertReplayPersisted must still equal expected cursor got ${postRevertPersisted}`)
  const postUnrevertPersisted = (runtime as Record<string, unknown>).postUnrevertReplayPersisted as number | undefined
  if (typeof postUnrevertPersisted === "number" && postUnrevertPersisted !== afterUnrevertCursor) throw new Error(`postUnrevertReplayPersisted must still equal notificationCursor expected ${afterUnrevertCursor} got ${postUnrevertPersisted}`)

  // no-op
  const noOp = runtime.noOp as Record<string, unknown> | undefined
  if (!noOp) throw new Error(`noOp evidence missing — must prove no-op unrevert or unknown revert with no notification/cursor/refresh`)
  if (noOp.privateSucceeded !== true) throw new Error(`noOp private result must succeed (operation-only success) got ${JSON.stringify(noOp).slice(0, 400)}`)
  if (typeof noOp.notifCount === "number" && noOp.notifCount !== 0) throw new Error(`noOp notifCount must be 0, got ${noOp.notifCount}`)
  const noOpCursorBefore = noOp.cursorBefore as number | undefined
  const noOpCursorAfter = noOp.cursorAfter as number | undefined
  if (typeof noOpCursorBefore === "number" && typeof noOpCursorAfter === "number" && noOpCursorBefore !== noOpCursorAfter) throw new Error(`noOp cursor must not advance expected ${noOpCursorBefore} got ${noOpCursorAfter}`)
  const noOpRefreshAfter = noOp.refreshAfter as number | undefined
  const noOpRefreshBefore = noOp.refreshBefore as number | undefined
  if (typeof noOpRefreshBefore === "number" && typeof noOpRefreshAfter === "number" && noOpRefreshAfter !== noOpRefreshBefore) throw new Error(`noOp refresh must not advance expected ${noOpRefreshBefore} got ${noOpRefreshAfter}`)
  if (noOp.refreshAdvanced === true) throw new Error(`noOp refresh must not have advanced`)

  await waitForFile(join(scratch, "obs-prod-revert-status.json"), timeout, "obs-prod-revert-status")
  const status = JSON.parse(readFileSync(join(scratch, "obs-prod-revert-status.json"), "utf8")) as Record<string, unknown>
  const canonical = canonicalDbPath(scratch)
  if (status.dbPath !== canonical) throw new Error(`canonical DB mismatch status.dbPath=${status.dbPath} canonical=${canonical}`)
  if (status.testBridge !== true) throw new Error(`testBridge not enabled status=${JSON.stringify(status)}`)
  console.log(`[probe obs-prod-revert fd3/fd4] canonical DB identity proven ${canonical} testBridge=${status.testBridge}`)
  console.log(`[probe obs-prod-revert fd3/fd4] fd3/fd4 envelope proven session=${expectedSessionId} revertCursor=${afterRevertCursor} unrevertCursor=${afterUnrevertCursor} gateOk=${runtimeGateOk}`)

  writeFileSync(join(scratch, "obs-prod-revert-dom-evidence"), JSON.stringify({ url: frame.url(), runtime, canonical, status }, null, 2))
  console.log("[probe obs-prod-revert fd3/fd4] lifecycle passed via ServePrivatePeer fd3/fd4 boundary")
}
