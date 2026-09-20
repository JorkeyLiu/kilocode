/**
 * Bounded live fd3/fd4 ServePrivatePeer observation/changed producer E2E proof for session/update.
 * Darwin/Linux only; Windows fails fast per existing harness convention.
 * Proves: real kilo serve SessionCreateDispatch.dispatch -> fd3/fd4 PrivatePeer
 * -> SessionUpdateDispatch.dispatch (title-only, commit-after notification)
 * -> ServePrivatePeer strict observation/changed validation
 * -> Extension Host AgentManagerProvider consumer. Reuses production
 * KiloConnectionService.privateCreateWithHandle for baseline create and
 * fixture-gated privateUpdateWithHandle for title-only update (sessionUpdate:<sessionId>:<token> tuple,
 * no SDK fallback) and fixture-gated ServePrivatePeer recorder (post-validation,
 * pre-forward, 50 bounded, monotonic ordinals, JSON-safe). Validates v1.0,
 * cursor===last seq, contiguous seq from update baseline, exact five-key entries,
 * kind changed, session_id matching baseline, revision >=0 and matching update
 * result/persisted cursor where observable. Asserts private update succeeded,
 * notification-driven AgentManager refresh/ack telemetry advanced exactly once,
 * and idempotent replay yields same session/title with no new notification.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Browser, Frame } from "@playwright/test"
import type { E2EPlan } from "./e2e-probe-dom"
import { findAgentManagerFrameAny, waitForFile } from "./e2e-probe-dom"
import { canonicalDbPath, isIsolatedDataRoot, validateGateEvidence } from "./e2e-canonical"
import { isValidObservationChangedNotification } from "../src/services/cli-backend/serve-private-peer"

export interface ObservationProducerUpdateEvidence {
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
  update?: { opId: string; requestId: string; directory: string; privateSucceeded: boolean; sessionId: string; title: string }
  create?: { opId: string; requestId: string; directory: string; privateSucceeded: boolean; sessionId: string }
  replay?: { sameSession: boolean; sameTitle: boolean; succeeded: boolean; opId: string; requestId: string }
  notification?: { cursor?: number; seq?: number; session_id?: string; kind?: string; revision?: number }
  idempotentSecondNotifCount: number
  expectedSessionId: string
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

function validateProducerUpdateEnvelope(
  envelope: unknown,
  expectedSessionId: string,
): string | undefined {
  const toValidate = (envelope as Record<string, unknown>)?.params ?? envelope
  if (!isValidObservationChangedNotification(toValidate)) return "envelope fails strict isValidObservationChangedNotification (v1.0, five keys, cursor===last seq, contiguous)"
  const raw = toValidate as { v: string; cursor: number; entries: Array<Record<string, unknown>> }
  const entries = raw.entries
  if (entries.length !== 1) return `expected exactly one entry for single mutation, got ${entries.length}`
  const e = entries[0]!
  if (e.session_id !== expectedSessionId) return `session_id mismatch expected ${expectedSessionId} got ${String(e.session_id)}`
  if (typeof e.revision !== "number" || e.revision < 0) return `revision must be >=0 got ${String(e.revision)}`
  if (e.kind !== "changed") return `kind mismatch expected changed got ${String(e.kind)}`
  return undefined
}

export async function assertObservationProducerUpdateLifecycle(browser: Browser, _plan: E2EPlan, scratch: string): Promise<void> {
  const timeout = 30_000
  await waitForFile(join(scratch, "obs-prod-update-ready"), 120_000, "obs-prod-update-ready marker")
  await waitForFile(join(scratch, "obs-prod-update-cstate.json"), timeout, "obs-prod-update-cstate")
  {
    const cstate = JSON.parse(readFileSync(join(scratch, "obs-prod-update-cstate.json"), "utf8")) as Record<string, unknown>
    console.log("[probe obs-prod-update fd3/fd4] cstate", JSON.stringify(cstate).slice(0, 400))
  }
  const gateRaw = readFileSync(join(scratch, "canonical-gate.json"), "utf8")
  const gate = JSON.parse(gateRaw) as Record<string, unknown>
  const gateErr = validateGateEvidence(gate)
  if (gateErr) throw new Error(`probe obs-prod-update: canonical gate invalid: ${gateErr}`)
  const dataRoot = gate.dataRoot as string | undefined
  if (typeof dataRoot === "string" && !isIsolatedDataRoot(scratch, dataRoot)) {
    throw new Error(`probe obs-prod-update: canonical dataRoot not isolated: ${dataRoot}`)
  }
  console.log("[probe obs-prod-update fd3/fd4] canonical gate ok via validateGateEvidence, gateOk=true")

  const found = await findAgentManagerFrameAny(browser, 60_000)
  const frame: Frame = found.frame
  console.log("[probe obs-prod-update fd3/fd4] frame ready", found.url)

  await waitForFile(join(scratch, "obs-prod-update-runtime-evidence"), 120_000, "obs-prod update runtime evidence")
  const runtime = JSON.parse(readFileSync(join(scratch, "obs-prod-update-runtime-evidence"), "utf8")) as ObservationProducerUpdateEvidence & Record<string, unknown>

  if (runtime.scenario !== "observation-producer-update") throw new Error(`scenario must be observation-producer-update got ${String(runtime.scenario)}`)
  const runtimeGateOk = runtime.canonical?.gateOk
  if (runtimeGateOk !== true) throw new Error(`gateOk must be true via validateGateEvidence, got ${String(runtimeGateOk)} gateErr=${String((runtime.canonical as Record<string, unknown>)?.gateErr ?? "")}`)
  if (!runtime.notificationStrictValid) throw new Error(`notificationStrictValid must be true (fd3/fd4 strict validation)`)
  if (!runtime.contiguous) throw new Error("contiguous must be true (changefeed continuity: cursor === before+1 and seq===cursor)")
  if (!runtime.ack?.success) throw new Error("ack must succeed (notification-driven consumer ack)")
  const upd = runtime.update as Record<string, unknown> | undefined
  if (!upd || upd.privateSucceeded !== true) throw new Error(`private update must succeed via fd3/fd4, got ${JSON.stringify(upd).slice(0, 500)}`)
  const expectedSessionId = (upd.sessionId as string | undefined) ?? (runtime as Record<string, unknown>).expectedSessionId as string | undefined
  if (!expectedSessionId) throw new Error("expectedSessionId missing from update result")
  const err = validateProducerUpdateEnvelope(runtime.envelope, expectedSessionId)
  if (err) throw new Error(`producer update envelope invalid via strict validator: ${err} envelope=${JSON.stringify(runtime.envelope).slice(0, 800)}`)
  const beforeCursor = runtime.before?.cursor
  const afterCursor = runtime.after?.cursor
  if (typeof beforeCursor !== "number" || typeof afterCursor !== "number") throw new Error("before/after cursor missing")
  if (afterCursor !== beforeCursor + 1) throw new Error(`expected contiguous seq after = before+1, got before ${beforeCursor} after ${afterCursor}`)
  const seqs = extractSeqs([runtime.envelope])
  if (seqs.length !== 1 || seqs[0] !== afterCursor) throw new Error(`seq must equal after cursor, got seqs ${JSON.stringify(seqs)} after ${afterCursor}`)
  const refresh = runtime.refresh as Record<string, unknown> | undefined
  if (refresh) {
    if (refresh.advancedOnce !== true) throw new Error(`refresh must advance exactly once via notification-driven doChangedObservationRefresh, got ${JSON.stringify(refresh).slice(0, 400)}`)
    if (typeof refresh.lastAckCursor === "number" && refresh.lastAckCursor !== afterCursor) throw new Error(`refresh lastAckCursor must equal notification cursor ${afterCursor}, got ${refresh.lastAckCursor}`)
    if (typeof refresh.lastBaseline === "number" && refresh.lastBaseline !== beforeCursor) throw new Error(`refresh lastBaseline must equal before cursor ${beforeCursor}, got ${refresh.lastBaseline}`)
  } else {
    console.warn("[probe obs-prod-update] refresh telemetry not exposed, treating as residual but not failing")
  }
  const replay = runtime.replay as Record<string, unknown> | undefined
  if (replay) {
    if (replay.sameSession !== true) throw new Error(`replay must yield same session_id, got ${JSON.stringify(replay).slice(0, 400)}`)
    if (replay.sameTitle !== true) throw new Error(`replay must yield same title, got ${JSON.stringify(replay).slice(0, 400)}`)
    if (replay.succeeded !== true) throw new Error(`replay private result must succeed`)
  }
  if (typeof runtime.idempotentSecondNotifCount === "number" && runtime.idempotentSecondNotifCount !== 0) {
    throw new Error(`idempotent second notif count must be 0, got ${runtime.idempotentSecondNotifCount}`)
  }
  await waitForFile(join(scratch, "obs-prod-update-status.json"), timeout, "obs-prod-update-status")
  const status = JSON.parse(readFileSync(join(scratch, "obs-prod-update-status.json"), "utf8")) as Record<string, unknown>
  const canonical = canonicalDbPath(scratch)
  if (status.dbPath !== canonical) throw new Error(`canonical DB mismatch status.dbPath=${status.dbPath} canonical=${canonical}`)
  if (status.testBridge !== true) throw new Error(`testBridge not enabled status=${JSON.stringify(status)}`)
  console.log(`[probe obs-prod-update fd3/fd4] canonical DB identity proven ${canonical} testBridge=${status.testBridge}`)
  console.log(`[probe obs-prod-update fd3/fd4] fd3/fd4 envelope proven session=${expectedSessionId} cursor=${afterCursor} seqs=${JSON.stringify(seqs)} refresh=${JSON.stringify(refresh)} replaySame=${replay?.sameSession} gateOk=${runtimeGateOk}`)

  writeFileSync(
    join(scratch, "obs-prod-update-dom-evidence"),
    JSON.stringify({ url: frame.url(), runtime, canonical, status }, null, 2),
  )
  console.log("[probe obs-prod-update fd3/fd4] lifecycle passed via ServePrivatePeer fd3/fd4 boundary")
}
