/**
 * Bounded live fd3/fd4 ServePrivatePeer observation/changed producer E2E proof for session/fork.
 * Darwin/Linux only; Windows fails fast per existing harness convention.
 * Proves: real kilo serve SessionCreateDispatch (source) -> SessionForkDispatch fork (fresh child)
 * -> fd3/fd4 PrivatePeer -> ServePrivatePeer strict observation/changed validation
 * -> Extension Host AgentManagerProvider notification-driven refresh consumer.
 * Reuses production KiloConnectionService.fixtureSessionCreate for source and
 * fixture-gated sessionForkPrivate for fork (fork:<source>:<token> tuple, no SDK fallback)
 * and fixture-gated ServePrivatePeer recorder (post-validation, pre-forward, 50 bounded, monotonic ordinals).
 * Validates v1.0, cursor===last seq, contiguous seq from fork baseline, exact five-key entry,
 * kind changed, revision 0, session_id == child, source not notified, parentID==source where observable,
 * single notification-driven AgentManager refresh/ack telemetry exactly once, and idempotent tuple replay.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Browser, Frame } from "@playwright/test"
import type { E2EPlan } from "./e2e-probe-dom"
import { findAgentManagerFrameAny, waitForFile } from "./e2e-probe-dom"
import { canonicalDbPath, isIsolatedDataRoot, validateGateEvidence } from "./e2e-canonical"
import { isValidObservationChangedNotification } from "../src/services/cli-backend/serve-private-peer"

export interface ObservationProducerForkEvidence {
  scenario: string
  collectedAt: string
  pid: number
  canonical: { dbPath: string; dataRoot?: string; isolateOk?: boolean; gateOk: boolean; gateErr?: string }
  testBridge: boolean
  before: { cursor: number; persisted?: number; startOrdinal: number; nextOrdinal: number; notifCount: number; refreshCount?: number }
  after: { cursor: number; persisted?: number; startOrdinal: number; nextOrdinal: number; notifCount: number; refreshCount?: number }
  envelope: unknown
  notificationStrictValid: boolean
  envelopeValid: boolean
  contiguous: boolean
  ack: { requested: number; persistedAfter?: number; success: boolean }
  refresh?: { beforeCount: number; afterCount: number; advancedOnce: boolean; lastAckCursor?: number; lastBaseline?: number }
  create?: { sourceSessionId: string }
  fork?: { opId: string; requestId: string; directory: string; privateSucceeded: boolean; sessionId: string; childSessionId: string; parentID?: string | null; revision?: number }
  replay?: { sameChild: boolean; succeeded: boolean; opId: string; requestId: string; snapshotCursor?: number; persistedCursor?: number }
  notification?: { cursor?: number; seq?: number; session_id?: string; kind?: string; revision?: number }
  idempotentSecondNotifCount: number
  postReplayCursor?: number
  postReplayPersisted?: number
  expectedChildId: string
  expectedSourceId: string
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
          if (e && typeof e === "object" && typeof (e as Record<string, unknown>).seq === "number") {
            seqs.push((e as Record<string, unknown>).seq as number)
          }
        }
      }
      if (typeof r.seq === "number") seqs.push(r.seq)
    }
  }
  return seqs
}

function validateForkEnvelope(
  envelope: unknown,
  expectedChildId: string,
  expectedSourceId: string,
  beforeCursor: number,
): string | undefined {
  const toValidate = (envelope as Record<string, unknown>)?.params ?? envelope
  if (!isValidObservationChangedNotification(toValidate)) return "envelope fails strict isValidObservationChangedNotification (v1.0, five keys, cursor===last seq, contiguous)"
  const raw = toValidate as { v: string; cursor: number; entries: Array<Record<string, unknown>> }
  const entries = raw.entries
  if (entries.length !== 1) return `expected exactly one entry for single fork, got ${entries.length}`
  const e = entries[0]!
  if (Object.keys(e as Record<string, unknown>).length !== 5) return `entry must have exactly 5 keys got ${Object.keys(e as Record<string, unknown>).length}`
  if (e.kind !== "changed") return `kind mismatch expected changed got ${String(e.kind)}`
  if (e.session_id !== expectedChildId) return `session_id mismatch expected child ${expectedChildId} got ${String(e.session_id)}`
  if (e.session_id === expectedSourceId) return `source must not be notification target (session_id == source)`
  if (typeof e.revision !== "number" || e.revision !== 0) return `revision must be exactly 0 for fresh fork got ${String(e.revision)}`
  const seq = e.seq as number
  if (seq !== beforeCursor + 1) return `seq must be beforeCursor+1 expected ${beforeCursor + 1} got ${seq}`
  if (raw.cursor !== seq) return `cursor must equal seq expected ${seq} got ${raw.cursor}`
  return undefined
}

export async function assertObservationProducerForkLifecycle(browser: Browser, _plan: E2EPlan, scratch: string): Promise<void> {
  const timeout = 30_000
  await waitForFile(join(scratch, "obs-prod-fork-ready"), 120_000, "obs-prod-fork-ready marker")
  await waitForFile(join(scratch, "obs-prod-fork-cstate.json"), timeout, "obs-prod-fork-cstate")
  {
    const cstate = JSON.parse(readFileSync(join(scratch, "obs-prod-fork-cstate.json"), "utf8")) as Record<string, unknown>
    console.log("[probe obs-prod-fork fd3/fd4] cstate", JSON.stringify(cstate).slice(0, 400))
  }
  const gateRaw = readFileSync(join(scratch, "canonical-gate.json"), "utf8")
  const gate = JSON.parse(gateRaw) as Record<string, unknown>
  const gateErr = validateGateEvidence(gate)
  if (gateErr) throw new Error(`probe obs-prod-fork: canonical gate invalid: ${gateErr}`)
  const dataRoot = gate.dataRoot as string | undefined
  if (typeof dataRoot === "string" && !isIsolatedDataRoot(scratch, dataRoot)) {
    throw new Error(`probe obs-prod-fork: canonical dataRoot not isolated: ${dataRoot}`)
  }
  console.log("[probe obs-prod-fork fd3/fd4] canonical gate ok via validateGateEvidence, gateOk=true")

  const found = await findAgentManagerFrameAny(browser, 60_000)
  const frame: Frame = found.frame
  console.log("[probe obs-prod-fork fd3/fd4] frame ready", found.url)

  await waitForFile(join(scratch, "obs-prod-fork-runtime-evidence"), 120_000, "obs-prod fork runtime evidence")
  const runtime = JSON.parse(readFileSync(join(scratch, "obs-prod-fork-runtime-evidence"), "utf8")) as ObservationProducerForkEvidence & Record<string, unknown>

  if (runtime.scenario !== "observation-producer-fork") throw new Error(`scenario must be observation-producer-fork got ${String(runtime.scenario)}`)
  const runtimeGateOk = runtime.canonical?.gateOk
  if (runtimeGateOk !== true) throw new Error(`gateOk must be true via validateGateEvidence, got ${String(runtimeGateOk)} gateErr=${String((runtime.canonical as Record<string, unknown>)?.gateErr ?? "")}`)
  if (!runtime.notificationStrictValid) throw new Error(`notificationStrictValid must be true (fd3/fd4 strict validation)`)
  if (!runtime.contiguous) throw new Error("contiguous must be true (changefeed continuity: cursor === before+1 and seq===cursor)")
  if (!runtime.ack?.success) throw new Error("ack must succeed (notification-driven consumer ack with persisted==cursor)")
  const fork = runtime.fork as Record<string, unknown> | undefined
  if (!fork || fork.privateSucceeded !== true) throw new Error(`private fork must succeed via fd3/fd4, got ${JSON.stringify(fork).slice(0, 600)}`)
  const expectedChildId = (fork.childSessionId as string | undefined) ?? (runtime as Record<string, unknown>).expectedChildId as string | undefined
  const expectedSourceId = (fork.sessionId as string | undefined) ?? (runtime as Record<string, unknown>).expectedSourceId as string | undefined
  if (!expectedChildId) throw new Error("expectedChildId missing from fork result")
  if (!expectedSourceId) throw new Error("expectedSourceId missing from fork result")
  if (expectedChildId === expectedSourceId) throw new Error(`child must not equal source child=${expectedChildId} source=${expectedSourceId}`)
  // optional parentID and revision checks where observable without fragile overhead
  if (typeof fork.parentID === "string" && fork.parentID !== expectedSourceId) throw new Error(`fork parentID must equal source expected ${expectedSourceId} got ${String(fork.parentID)}`)
  if (typeof fork.revision === "number" && fork.revision !== 0) throw new Error(`fork child revision must be 0 got ${String(fork.revision)}`)
  const beforeCursor = runtime.before?.cursor
  const afterCursor = runtime.after?.cursor
  if (typeof beforeCursor !== "number" || typeof afterCursor !== "number") throw new Error("before/after cursor missing")
  if (afterCursor !== beforeCursor + 1) throw new Error(`expected contiguous seq after = before+1, got before ${beforeCursor} after ${afterCursor}`)
  const seqs = extractSeqs([runtime.envelope])
  if (seqs.length !== 1 || seqs[0] !== afterCursor) throw new Error(`seq must equal after cursor, got seqs ${JSON.stringify(seqs)} after ${afterCursor}`)
  const err = validateForkEnvelope(runtime.envelope, expectedChildId, expectedSourceId, beforeCursor)
  if (err) throw new Error(`producer fork envelope invalid via strict validator: ${err} envelope=${JSON.stringify(runtime.envelope).slice(0, 1200)}`)
  // gap-1: persistedCursor must equal notificationCursor within deadline — fail-closed
  const afterPersisted = runtime.after?.persisted as number | undefined
  if (typeof afterPersisted !== "number") throw new Error(`after.persisted must be number equal to afterCursor ${afterCursor}, got ${String(afterPersisted)}`)
  if (afterPersisted !== afterCursor) throw new Error(`after.persisted must equal afterCursor expected ${afterCursor} got ${afterPersisted} (persistedCursor deadline fail-closed)`)
  const ackPersistedAfter = (runtime.ack as { persistedAfter?: number } | undefined)?.persistedAfter as number | undefined
  if (typeof ackPersistedAfter !== "number") throw new Error(`ack.persistedAfter must be number equal to afterCursor ${afterCursor}, got ${String(ackPersistedAfter)}`)
  if (ackPersistedAfter !== afterCursor) throw new Error(`ack.persistedAfter must equal afterCursor expected ${afterCursor} got ${ackPersistedAfter} (ack persisted deadline fail-closed)`)
  const refresh = runtime.refresh as Record<string, unknown> | undefined
  if (!refresh) throw new Error(`refresh telemetry missing — single observation-driven refresh must be proven, got ${JSON.stringify(refresh)}`)
  if (refresh.advancedOnce !== true) throw new Error(`refresh must advance exactly once via notification-driven doChangedObservationRefresh, got ${JSON.stringify(refresh).slice(0, 400)}`)
  if (typeof refresh.lastAckCursor !== "number") throw new Error(`refresh lastAckCursor must be number equal to notification cursor ${afterCursor}, got ${String(refresh.lastAckCursor)}`)
  if (refresh.lastAckCursor !== afterCursor) throw new Error(`refresh lastAckCursor must equal notification cursor ${afterCursor}, got ${refresh.lastAckCursor}`)
  if (typeof refresh.lastBaseline !== "number") throw new Error(`refresh lastBaseline must be number equal to before cursor ${beforeCursor}, got ${String(refresh.lastBaseline)}`)
  if (refresh.lastBaseline !== beforeCursor) throw new Error(`refresh lastBaseline must equal before cursor ${beforeCursor}, got ${refresh.lastBaseline}`)
  const replay = runtime.replay as Record<string, unknown> | undefined
  if (replay) {
    if (replay.sameChild !== true) throw new Error(`replay must yield same child id, got ${JSON.stringify(replay).slice(0, 400)}`)
    if (replay.succeeded !== true) throw new Error(`replay private result must succeed`)
  }
  if (typeof runtime.idempotentSecondNotifCount === "number" && runtime.idempotentSecondNotifCount !== 0) {
    throw new Error(`idempotent second notif count must be 0, got ${runtime.idempotentSecondNotifCount}`)
  }
  // gap-2: post-replay snapshot cursor must still equal notificationCursor (direct observation read, not just zero delta)
  const postReplayCursor = (runtime as Record<string, unknown>).postReplayCursor as number | undefined
  if (typeof postReplayCursor !== "number") throw new Error(`postReplayCursor must be number equal to afterCursor ${afterCursor}, got ${String(postReplayCursor)}`)
  if (postReplayCursor !== afterCursor) throw new Error(`postReplayCursor must still equal notificationCursor expected ${afterCursor} got ${postReplayCursor}`)
  const postReplayPersisted = (runtime as Record<string, unknown>).postReplayPersisted as number | undefined
  if (typeof postReplayPersisted === "number" && postReplayPersisted !== afterCursor) {
    throw new Error(`postReplayPersisted must still equal notificationCursor expected ${afterCursor} got ${postReplayPersisted}`)
  }
  const replaySnapshot = (replay as Record<string, unknown> | undefined)?.snapshotCursor as number | undefined
  if (typeof replaySnapshot === "number" && replaySnapshot !== afterCursor) {
    throw new Error(`replay.snapshotCursor must still equal notificationCursor expected ${afterCursor} got ${replaySnapshot}`)
  }
  const replayPersisted = (replay as Record<string, unknown> | undefined)?.persistedCursor as number | undefined
  if (typeof replayPersisted === "number" && replayPersisted !== afterCursor) {
    throw new Error(`replay.persistedCursor must still equal notificationCursor expected ${afterCursor} got ${replayPersisted}`)
  }
  await waitForFile(join(scratch, "obs-prod-fork-status.json"), timeout, "obs-prod-fork-status")
  const status = JSON.parse(readFileSync(join(scratch, "obs-prod-fork-status.json"), "utf8")) as Record<string, unknown>
  const canonical = canonicalDbPath(scratch)
  if (status.dbPath !== canonical) throw new Error(`canonical DB mismatch status.dbPath=${status.dbPath} canonical=${canonical}`)
  if (status.testBridge !== true) throw new Error(`testBridge not enabled status=${JSON.stringify(status)}`)
  console.log(`[probe obs-prod-fork fd3/fd4] canonical DB identity proven ${canonical} testBridge=${status.testBridge}`)
  console.log(`[probe obs-prod-fork fd3/fd4] fd3/fd4 envelope proven fork source=${expectedSourceId} child=${expectedChildId} cursor=${afterCursor} seqs=${JSON.stringify(seqs)} refresh=${JSON.stringify(refresh)} replaySame=${replay?.sameChild} gateOk=${runtimeGateOk}`)

  writeFileSync(
    join(scratch, "obs-prod-fork-dom-evidence"),
    JSON.stringify({ url: frame.url(), runtime, canonical, status }, null, 2),
  )
  console.log("[probe obs-prod-fork fd3/fd4] lifecycle passed via ServePrivatePeer fd3/fd4 boundary")
}
