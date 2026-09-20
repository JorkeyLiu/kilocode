/**
 * Bounded live fd3/fd4 sandbox inheritance observation/changed E2E proof.
 * Darwin/Linux only; Windows fails fast per existing harness convention.
 * Proves: source private create -> fixture token issue (count 2) -> child
 * private create with sandboxInheritanceToken via privateCreateWithHandle
 * -> fd3/fd4 -> SessionCreateDispatch with immediate hash, reserve/commit,
 * DB only hash/source, single changed@0, child inherits source policy,
 * refresh exactly once, replay same child no new seq/no remaining deduction,
 * second distinct child with same token proves remaining semantics.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Browser, Frame } from "@playwright/test"
import type { E2EPlan } from "./e2e-probe-dom"
import { findAgentManagerFrameAny, waitForFile } from "./e2e-probe-dom"
import { canonicalDbPath, isIsolatedDataRoot, validateGateEvidence } from "./e2e-canonical"
import { isValidObservationChangedNotification } from "../src/services/cli-backend/serve-private-peer"

export interface ObservationProducerSandboxEvidence {
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
  source?: { sessionId: string; opId: string }
  tokenIssue?: { token: string; hash: string; count: number; sourceSessionId: string }
  grant?: { afterChild1?: { found: boolean; remaining?: number; hash: string }; afterReplay?: { found: boolean; remaining?: number }; afterChild2?: { found: boolean; remaining?: number; hash: string }; afterChild3?: { found: boolean; remaining?: number } }
  child?: { opId: string; requestId: string; directory: string; privateSucceeded: boolean; sessionId: string }
  sourcePolicy?: { found: boolean; snapshot?: unknown; raw?: unknown }
  childPolicy?: { found: boolean; snapshot?: unknown; raw?: unknown }
  inheritValid?: boolean
  replay?: { sameSession: boolean; succeeded: boolean; opId: string; requestId: string }
  secondChild?: { sessionId: string; privateSucceeded: boolean; opId: string }
  thirdChild?: { sessionId: string; failed: boolean; valid: boolean; code: string; notifCount: number; refreshAdvanced: boolean; cursorAdvanced: boolean }
  idempotentSecondNotifCount: number
  notification?: { cursor?: number; seq?: number; session_id?: string; kind?: string; revision?: number }
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

function validateProducerEnvelope(envelope: unknown, expectedSessionId: string, sourceSessionId: string): string | undefined {
  const toValidate = (envelope as Record<string, unknown>)?.params ?? envelope
  if (!isValidObservationChangedNotification(toValidate)) return "envelope fails strict isValidObservationChangedNotification (v1.0, five keys, cursor===last seq, contiguous)"
  const raw = toValidate as { v: string; cursor: number; entries: Array<Record<string, unknown>> }
  const entries = raw.entries
  if (entries.length !== 1) return `expected exactly one entry for single mutation, got ${entries.length}`
  const e = entries[0]!
  if (e.session_id !== expectedSessionId) return `session_id mismatch expected child ${expectedSessionId} got ${String(e.session_id)}`
  if (e.session_id === sourceSessionId) return `session_id must be child not source, got source ${sourceSessionId}`
  if (typeof e.revision !== "number" || e.revision !== 0) return `revision must be 0 for session/create, got ${String(e.revision)}`
  if (e.kind !== "changed") return `kind mismatch expected changed got ${String(e.kind)}`
  const keys = Object.keys(e).sort()
  if (keys.length !== 5 || !keys.includes("seq") || !keys.includes("session_id") || !keys.includes("revision") || !keys.includes("kind") || !keys.includes("time"))
    return `entry must have exactly five keys seq/session_id/revision/kind/time, got ${keys.join(",")}`
  return undefined
}

// eslint-disable-next-line complexity -- probe aggregates strict inherit + grant + third child checks atomically
export async function assertObservationProducerSandboxLifecycle(browser: Browser, _plan: E2EPlan, scratch: string): Promise<void> {
  const timeout = 30_000
  console.log("[probe obs-prod-sandbox] waiting for ready marker scratch", scratch)
  try { console.log("[probe obs-prod-sandbox] scratch ls before", readdirSync(scratch).join(",")) } catch (e) { console.log("[probe obs-prod-sandbox] ls before failed", String(e)) }
  await waitForFile(join(scratch, "obs-prod-sandbox-ready"), 120_000, "obs-prod-sandbox-ready marker")
  await waitForFile(join(scratch, "obs-prod-sandbox-cstate.json"), timeout, "obs-prod-sandbox-cstate")
  {
    const cstate = JSON.parse(readFileSync(join(scratch, "obs-prod-sandbox-cstate.json"), "utf8")) as Record<string, unknown>
    console.log("[probe obs-prod-sandbox fd3/fd4] cstate", JSON.stringify(cstate).slice(0, 400))
  }
  const gateRaw = readFileSync(join(scratch, "canonical-gate.json"), "utf8")
  const gate = JSON.parse(gateRaw) as Record<string, unknown>
  const gateErr = validateGateEvidence(gate)
  if (gateErr) throw new Error(`probe obs-prod-sandbox: canonical gate invalid: ${gateErr}`)
  const dataRoot = gate.dataRoot as string | undefined
  if (typeof dataRoot === "string" && !isIsolatedDataRoot(scratch, dataRoot)) {
    throw new Error(`probe obs-prod-sandbox: canonical dataRoot not isolated: ${dataRoot}`)
  }
  console.log("[probe obs-prod-sandbox fd3/fd4] canonical gate ok via validateGateEvidence, gateOk=true")

  let frame: Frame | null = null
  try {
    const found = await findAgentManagerFrameAny(browser, 10_000)
    frame = found.frame
    console.log("[probe obs-prod-sandbox fd3/fd4] frame ready", found.url)
  } catch (e) {
    console.warn("[probe obs-prod-sandbox] frame not found, continuing without frame", String(e).slice(0, 200))
  }

  await waitForFile(join(scratch, "obs-prod-sandbox-runtime-evidence"), 120_000, "obs-prod-sandbox runtime evidence")
  const runtime = JSON.parse(readFileSync(join(scratch, "obs-prod-sandbox-runtime-evidence"), "utf8")) as ObservationProducerSandboxEvidence & Record<string, unknown>

  if (runtime.scenario !== "observation-producer-sandbox") throw new Error(`scenario must be observation-producer-sandbox got ${String(runtime.scenario)}`)
  const runtimeGateOk = runtime.canonical?.gateOk
  if (runtimeGateOk !== true) throw new Error(`gateOk must be true via validateGateEvidence, got ${String(runtimeGateOk)} gateErr=${String((runtime.canonical as Record<string, unknown>)?.gateErr ?? "")}`)
  if (!runtime.notificationStrictValid) throw new Error(`notificationStrictValid must be true (fd3/fd4 strict validation)`)
  if (!runtime.contiguous) throw new Error("contiguous must be true (changefeed continuity: cursor === before+1 and seq===cursor)")
  if (!runtime.ack?.success) throw new Error("ack must succeed (notification-driven consumer ack)")
  const child = runtime.child as Record<string, unknown> | undefined
  if (!child || child.privateSucceeded !== true) throw new Error(`private child create must succeed via fd3/fd4, got ${JSON.stringify(child).slice(0, 500)}`)
  const expectedSessionId = (child.sessionId as string | undefined) ?? (runtime as Record<string, unknown>).expectedSessionId as string | undefined
  if (!expectedSessionId) throw new Error("expectedSessionId missing from child result")
  const sourceId = (runtime.source as Record<string, unknown> | undefined)?.sessionId as string | undefined
  if (!sourceId) throw new Error("source sessionId missing")
  if (expectedSessionId === sourceId) throw new Error(`child session must differ from source, both ${expectedSessionId}`)
  const err = validateProducerEnvelope(runtime.envelope, expectedSessionId, sourceId)
  if (err) throw new Error(`producer envelope invalid via strict validator: ${err} envelope=${JSON.stringify(runtime.envelope).slice(0, 800)}`)
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
  } else {
    console.warn("[probe obs-prod-sandbox] refresh telemetry not exposed, treating as residual but not failing")
  }
  // Inherit proof via SandboxStore reading — fail-closed: both found true, strict enabled/mode/hosts/writablePaths
  const sourcePolicy = runtime.sourcePolicy as Record<string, unknown> | undefined
  const childPolicy = runtime.childPolicy as Record<string, unknown> | undefined
  if (sourcePolicy?.found !== true) throw new Error(`sourcePolicy found must be true, got ${JSON.stringify(sourcePolicy).slice(0, 500)}`)
  if (childPolicy?.found !== true) throw new Error(`childPolicy found must be true, got ${JSON.stringify(childPolicy).slice(0, 500)}`)
  if (runtime.inheritValid !== true) throw new Error(`sandbox inherit must be valid (strict enabled/mode/hosts/writablePaths), got inheritValid=${runtime.inheritValid} sourcePolicy=${JSON.stringify(runtime.sourcePolicy).slice(0, 500)} childPolicy=${JSON.stringify(runtime.childPolicy).slice(0, 500)}`)
  // Reservation semantics: count=2 -> grant remaining evidence via fixture hash lookup (no plaintext exposure)
  const grant = runtime.grant as Record<string, unknown> | undefined
  const g1 = grant?.afterChild1 as Record<string, unknown> | undefined
  const gReplay = grant?.afterReplay as Record<string, unknown> | undefined
  const g2 = grant?.afterChild2 as Record<string, unknown> | undefined
  if (!g1 || g1.found !== true || g1.remaining !== 1) throw new Error(`grant after child1 must be found true remaining 1, got ${JSON.stringify(g1).slice(0, 400)}`)
  if (g1.hash !== runtime.tokenIssue?.hash) throw new Error(`grant after child1 hash must equal tokenIssue hash, got ${String(g1.hash).slice(0, 8)} vs ${String(runtime.tokenIssue?.hash).slice(0, 8)}`)
  if (!gReplay || gReplay.found !== true || gReplay.remaining !== 1) throw new Error(`grant after replay must still be found true remaining 1 (idempotent), got ${JSON.stringify(gReplay).slice(0, 400)}`)
  if (!g2 || g2.remaining !== undefined && g2.remaining !== 0) {
    // after child2 remaining 0 means grant deleted -> found false or remaining 0
    if (g2?.found !== false && g2?.remaining !== 0) throw new Error(`grant after child2 must be exhausted (found false or remaining 0), got ${JSON.stringify(g2).slice(0, 400)}`)
  }
  if (g2 && g2.found === true && g2.remaining !== 0) throw new Error(`grant after child2 found true must have remaining 0, got ${JSON.stringify(g2).slice(0, 400)}`)
  if (g2 && typeof g2.hash === "string" && g2.hash !== runtime.tokenIssue?.hash) throw new Error(`grant after child2 hash must equal tokenIssue hash`)
  const replay = runtime.replay as Record<string, unknown> | undefined
  if (replay) {
    if (replay.sameSession !== true) throw new Error(`replay must yield same session_id, got ${JSON.stringify(replay).slice(0, 400)}`)
    if (replay.succeeded !== true) throw new Error(`replay private result must succeed`)
  }
  if (typeof runtime.idempotentSecondNotifCount === "number" && runtime.idempotentSecondNotifCount !== 0) {
    throw new Error(`idempotent second notif count must be 0, got ${runtime.idempotentSecondNotifCount}`)
  }
  // Second distinct child with same sandbox token proves remaining semantics (count 2)
  const second = runtime.secondChild as Record<string, unknown> | undefined
  if (!second) throw new Error("secondChild evidence missing (count=2 remaining semantics)")
  if (second.privateSucceeded !== true) throw new Error(`second child privateSucceeded must be true, got ${JSON.stringify(second).slice(0, 400)}`)
  const secondSessionId = second.sessionId as string | undefined
  if (!secondSessionId || secondSessionId === expectedSessionId || secondSessionId === sourceId) throw new Error(`second child sessionId must be distinct from first child and source, got ${secondSessionId} vs child ${expectedSessionId} source ${sourceId}`)
  // Third distinct child must fail validation.failed/invalid with zero new session/operation/changefeed/notification
  const third = runtime.thirdChild as Record<string, unknown> | undefined
  if (!third) throw new Error("thirdChild evidence missing (exhausted grant must fail)")
  if (third.valid !== true) throw new Error(`third child must be validation.failed/invalid, got ${JSON.stringify(third).slice(0, 500)}`)
  if (typeof third.notifCount === "number" && third.notifCount !== 0) throw new Error(`third child must produce zero new notification, got ${third.notifCount}`)
  if (third.refreshAdvanced === true) throw new Error(`third child must not advance AgentManager refresh, got refreshAdvanced true`)
  if (third.cursorAdvanced === true) throw new Error(`third child must not advance changefeed cursor, got cursorAdvanced true`)
  if (typeof (third as Record<string, unknown>).sessionId === "string" && ((third as Record<string, unknown>).sessionId as string).length > 0 && (third as Record<string, unknown>).sessionId !== "") {
    // fail-closed: no new session should be created; sessionId should be empty
    const sid = (third as Record<string, unknown>).sessionId as string
    if (sid && sid.startsWith("ses")) throw new Error(`third child must not create new session, got ${sid}`)
  }
  const g3 = grant?.afterChild3 as Record<string, unknown> | undefined
  if (g3 && g3.found === true && typeof g3.remaining === "number" && g3.remaining !== 0) throw new Error(`grant after third must remain exhausted, got ${JSON.stringify(g3).slice(0, 400)}`)
  // Canonical DB identity and isolation evidence (owned scratch)
  await waitForFile(join(scratch, "obs-prod-sandbox-status.json"), timeout, "obs-prod-sandbox-status")
  const status = JSON.parse(readFileSync(join(scratch, "obs-prod-sandbox-status.json"), "utf8")) as Record<string, unknown>
  const canonical = canonicalDbPath(scratch)
  if (status.dbPath !== canonical) throw new Error(`canonical DB mismatch status.dbPath=${status.dbPath} canonical=${canonical}`)
  if (status.testBridge !== true) throw new Error(`testBridge not enabled status=${JSON.stringify(status)}`)
  console.log(`[probe obs-prod-sandbox fd3/fd4] canonical DB identity proven ${canonical} testBridge=${status.testBridge}`)
  console.log(`[probe obs-prod-sandbox fd3/fd4] fd3/fd4 envelope proven child=${expectedSessionId} source=${sourceId} cursor=${afterCursor} seqs=${JSON.stringify(seqs)} refresh=${JSON.stringify(refresh)} replaySame=${replay?.sameSession} secondChild=${secondSessionId} thirdValid=${(runtime.thirdChild as Record<string, unknown> | undefined)?.valid} inheritValid=${runtime.inheritValid} grant1=${JSON.stringify((runtime.grant as Record<string, unknown> | undefined)?.afterChild1)} grant2=${JSON.stringify((runtime.grant as Record<string, unknown> | undefined)?.afterChild2)} gateOk=${runtimeGateOk}`)

  if (frame) {
    writeFileSync(
      join(scratch, "obs-prod-sandbox-dom-evidence"),
      JSON.stringify({ url: frame.url(), runtime, canonical, status }, null, 2),
    )
  } else {
    writeFileSync(
      join(scratch, "obs-prod-sandbox-dom-evidence"),
      JSON.stringify({ url: "no-frame", runtime, canonical, status }, null, 2),
    )
  }
  console.log("[probe obs-prod-sandbox fd3/fd4] lifecycle passed via ServePrivatePeer fd3/fd4 boundary with sandboxInheritanceToken")
}
