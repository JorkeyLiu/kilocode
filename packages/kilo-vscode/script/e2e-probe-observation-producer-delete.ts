/**
 * Bounded live fd3/fd4 ServePrivatePeer observation/changed producer E2E proof for session/delete family.
 * Darwin/Linux only; Windows fails fast per existing harness convention.
 * Proves: real kilo serve SessionCreateDispatch.dispatch (parent) -> child create -> SessionDeleteDispatch.dispatch (parent family)
 * -> fd3/fd4 PrivatePeer -> ServePrivatePeer strict observation/changed validation
 * -> Extension Host AgentManagerProvider consumer.
 * Reuses production KiloConnectionService.privateCreateWithHandle for parent/child and
 * fixture-gated privateDeleteWithHandle for delete (delete:<sessionId>:<token> tuple, no SDK fallback)
 * and fixture-gated ServePrivatePeer recorder (post-validation, pre-forward, 50 bounded, monotonic ordinals, JSON-safe).
 * Validates v1.0, cursor===last seq, contiguous seq from delete baseline, exact five-key entries,
 * kind deleted for every entry, session_id set covers parent+child, revision >=0, entries ordered strictly ascending by seq.
 * Asserts private delete succeeded, notification-driven AgentManager refresh/ack telemetry advanced exactly once,
 * and idempotent replay yields same session with no new notification.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Browser, Frame } from "@playwright/test"
import type { E2EPlan } from "./e2e-probe-dom"
import { findAgentManagerFrameAny, waitForFile } from "./e2e-probe-dom"
import { canonicalDbPath, isIsolatedDataRoot, validateGateEvidence } from "./e2e-canonical"
import { isValidObservationChangedNotification } from "../src/services/cli-backend/serve-private-peer"

export interface ObservationProducerDeleteEvidence {
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
  create?: { parentSessionId: string; childSessionId: string }
  delete?: { opId: string; requestId: string; directory: string; privateSucceeded: boolean; sessionId: string }
  replay?: { sameSession: boolean; succeeded: boolean; opId: string; requestId: string }
  notification?: { cursor?: number; entries?: Array<Record<string, unknown>> }
  idempotentSecondNotifCount: number
  expectedSessionIds: string[]
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

function validateDeleteEnvelope(
  envelope: unknown,
  expectedIds: string[],
  beforeCursor: number,
): string | undefined {
  const toValidate = (envelope as Record<string, unknown>)?.params ?? envelope
  if (!isValidObservationChangedNotification(toValidate)) return "envelope fails strict isValidObservationChangedNotification (v1.0, five keys, cursor===last seq, contiguous)"
  const raw = toValidate as { v: string; cursor: number; entries: Array<Record<string, unknown>> }
  const entries = raw.entries
  if (entries.length < 2) return `expected at least 2 entries for family delete, got ${entries.length}`
  const ids = entries.map((e) => String(e.session_id))
  const missing = expectedIds.filter((id) => !ids.includes(id))
  if (missing.length > 0) return `missing expected session_ids ${missing.join(",")} in entries [${ids.join(",")}]`
  const extra = ids.filter((id) => !expectedIds.includes(id))
  if (extra.length > 0) return `unexpected session_ids ${extra.join(",")} in entries [${ids.join(",")}]`
  for (const e of entries) {
    if (e.kind !== "deleted") return `kind mismatch expected deleted got ${String(e.kind)} for ${String(e.session_id)}`
    if (typeof e.revision !== "number" || e.revision < 0) return `revision must be >=0 got ${String(e.revision)}`
    if (Object.keys(e as Record<string, unknown>).length !== 5) return `entry must have exactly 5 keys got ${Object.keys(e as Record<string, unknown>).length}`
  }
  const seqs = entries.map((e) => e.seq as number)
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] !== seqs[i - 1]! + 1) return `seq not contiguous ${seqs.join(",")}`
  }
  if (seqs[0] !== beforeCursor + 1) return `first seq must be beforeCursor+1 expected ${beforeCursor + 1} got ${seqs[0]}`
  if (raw.cursor !== seqs[seqs.length - 1]) return `cursor must equal last seq expected ${seqs[seqs.length - 1]} got ${raw.cursor}`
  return undefined
}

export async function assertObservationProducerDeleteLifecycle(browser: Browser, _plan: E2EPlan, scratch: string): Promise<void> {
  const timeout = 30_000
  await waitForFile(join(scratch, "obs-prod-delete-ready"), 120_000, "obs-prod-delete-ready marker")
  await waitForFile(join(scratch, "obs-prod-delete-cstate.json"), timeout, "obs-prod-delete-cstate")
  {
    const cstate = JSON.parse(readFileSync(join(scratch, "obs-prod-delete-cstate.json"), "utf8")) as Record<string, unknown>
    console.log("[probe obs-prod-delete fd3/fd4] cstate", JSON.stringify(cstate).slice(0, 400))
  }
  const gateRaw = readFileSync(join(scratch, "canonical-gate.json"), "utf8")
  const gate = JSON.parse(gateRaw) as Record<string, unknown>
  const gateErr = validateGateEvidence(gate)
  if (gateErr) throw new Error(`probe obs-prod-delete: canonical gate invalid: ${gateErr}`)
  const dataRoot = gate.dataRoot as string | undefined
  if (typeof dataRoot === "string" && !isIsolatedDataRoot(scratch, dataRoot)) {
    throw new Error(`probe obs-prod-delete: canonical dataRoot not isolated: ${dataRoot}`)
  }
  console.log("[probe obs-prod-delete fd3/fd4] canonical gate ok via validateGateEvidence, gateOk=true")

  const found = await findAgentManagerFrameAny(browser, 60_000)
  const frame: Frame = found.frame
  console.log("[probe obs-prod-delete fd3/fd4] frame ready", found.url)

  await waitForFile(join(scratch, "obs-prod-delete-runtime-evidence"), 120_000, "obs-prod delete runtime evidence")
  const runtime = JSON.parse(readFileSync(join(scratch, "obs-prod-delete-runtime-evidence"), "utf8")) as ObservationProducerDeleteEvidence & Record<string, unknown>

  if (runtime.scenario !== "observation-producer-delete") throw new Error(`scenario must be observation-producer-delete got ${String(runtime.scenario)}`)
  const runtimeGateOk = runtime.canonical?.gateOk
  if (runtimeGateOk !== true) throw new Error(`gateOk must be true via validateGateEvidence, got ${String(runtimeGateOk)} gateErr=${String((runtime.canonical as Record<string, unknown>)?.gateErr ?? "")}`)
  if (!runtime.notificationStrictValid) throw new Error(`notificationStrictValid must be true (fd3/fd4 strict validation)`)
  if (!runtime.contiguous) throw new Error("contiguous must be true (changefeed continuity: seq contiguous from beforeCursor+1 and cursor===last seq)")
  if (!runtime.ack?.success) throw new Error("ack must succeed (notification-driven consumer ack)")
  const del = runtime.delete as Record<string, unknown> | undefined
  if (!del || del.privateSucceeded !== true) throw new Error(`private delete must succeed via fd3/fd4, got ${JSON.stringify(del).slice(0, 500)}`)
  const expectedIds = (runtime as Record<string, unknown>).expectedSessionIds as string[] | undefined ?? (runtime as unknown as { expectedSessionIds?: string[] }).expectedSessionIds
  if (!expectedIds || expectedIds.length < 2) throw new Error("expectedSessionIds missing or too short for family delete")
  const beforeCursor = runtime.before?.cursor
  const afterCursor = runtime.after?.cursor
  if (typeof beforeCursor !== "number" || typeof afterCursor !== "number") throw new Error("before/after cursor missing")
  const env = runtime.envelope as Record<string, unknown> | null
  const params = (env?.params as unknown) ?? runtime.envelope
  const raw = params as { cursor: number; entries: Array<Record<string, unknown>> }
  const entries = raw?.entries ?? []
  const seqs = entries.map((e) => e.seq as number)
  if (seqs.length < 2) throw new Error(`expected at least 2 seqs for family delete, got ${JSON.stringify(seqs)}`)
  if (afterCursor !== seqs[seqs.length - 1]) throw new Error(`afterCursor must equal last seq got after ${afterCursor} seqs ${JSON.stringify(seqs)}`)
  if (seqs[0] !== beforeCursor + 1) throw new Error(`first seq must be before+1 expected ${beforeCursor + 1} got ${seqs[0]}`)
  if (afterCursor !== beforeCursor + seqs.length) throw new Error(`expected after = before + N (N=${seqs.length}), got before ${beforeCursor} after ${afterCursor}`)
  const seqsFromExtract = extractSeqs([runtime.envelope])
  if (seqsFromExtract.length < 2) throw new Error(`extract seqs failed got ${JSON.stringify(seqsFromExtract)}`)
  const err = validateDeleteEnvelope(runtime.envelope, expectedIds, beforeCursor)
  if (err) throw new Error(`producer delete envelope invalid via strict validator: ${err} envelope=${JSON.stringify(runtime.envelope).slice(0, 1200)}`)
  const refresh = runtime.refresh as Record<string, unknown> | undefined
  if (!refresh) throw new Error(`refresh telemetry missing — single observation-driven refresh must be proven, got ${JSON.stringify(refresh)}`)
  if (refresh.advancedOnce !== true) throw new Error(`refresh must advance exactly once via notification-driven doChangedObservationRefresh, got ${JSON.stringify(refresh).slice(0, 400)}`)
  if (typeof refresh.lastAckCursor !== "number") throw new Error(`refresh lastAckCursor must be number equal to notification cursor ${afterCursor}, got ${String(refresh.lastAckCursor)}`)
  if (refresh.lastAckCursor !== afterCursor) throw new Error(`refresh lastAckCursor must equal notification cursor ${afterCursor}, got ${refresh.lastAckCursor}`)
  if (typeof refresh.lastBaseline !== "number") throw new Error(`refresh lastBaseline must be number equal to before cursor ${beforeCursor}, got ${String(refresh.lastBaseline)}`)
  if (refresh.lastBaseline !== beforeCursor) throw new Error(`refresh lastBaseline must equal before cursor ${beforeCursor}, got ${refresh.lastBaseline}`)
  const replay = runtime.replay as Record<string, unknown> | undefined
  if (replay) {
    if (replay.sameSession !== true) throw new Error(`replay must yield same session_id, got ${JSON.stringify(replay).slice(0, 400)}`)
    if (replay.succeeded !== true) throw new Error(`replay private result must succeed`)
  }
  if (typeof runtime.idempotentSecondNotifCount === "number" && runtime.idempotentSecondNotifCount !== 0) {
    throw new Error(`idempotent second notif count must be 0, got ${runtime.idempotentSecondNotifCount}`)
  }
  await waitForFile(join(scratch, "obs-prod-delete-status.json"), timeout, "obs-prod-delete-status")
  const status = JSON.parse(readFileSync(join(scratch, "obs-prod-delete-status.json"), "utf8")) as Record<string, unknown>
  const canonical = canonicalDbPath(scratch)
  if (status.dbPath !== canonical) throw new Error(`canonical DB mismatch status.dbPath=${status.dbPath} canonical=${canonical}`)
  if (status.testBridge !== true) throw new Error(`testBridge not enabled status=${JSON.stringify(status)}`)
  console.log(`[probe obs-prod-delete fd3/fd4] canonical DB identity proven ${canonical} testBridge=${status.testBridge}`)
  console.log(`[probe obs-prod-delete fd3/fd4] fd3/fd4 envelope proven family=${expectedIds.join(",")} cursor=${afterCursor} seqs=${JSON.stringify(seqs)} refresh=${JSON.stringify(refresh)} replaySame=${replay?.sameSession} gateOk=${runtimeGateOk}`)

  writeFileSync(
    join(scratch, "obs-prod-delete-dom-evidence"),
    JSON.stringify({ url: frame.url(), runtime, canonical, status }, null, 2),
  )
  console.log("[probe obs-prod-delete fd3/fd4] lifecycle passed via ServePrivatePeer fd3/fd4 boundary")
}
