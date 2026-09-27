/**
 * streaming-observation narrow E2E (direction.md:69-78): controllable slow
 * streaming generation with in-flight tail capture, one in-flight session
 * switch (A→B→A), one in-flight panel close/reopen (re-observe only, never
 * cancel), then release-to-complete and one post-completion transport
 * boundary (FD reconnect private→SSE with the same worker), with final
 * convergence onto the same backend authoritative read (backendSnapshot
 * messages), no loss/dup, no accepted prompt resubmit.
 *
 * Panel close/reopen runs in-flight against the held stream (so-reopen-request
 * while busy): it must not cancel the accepted turn (busy + single user
 * marker + single main LLM request preserved) and the reopened panel must
 * reconverge on private-authoritative list/get/messages. When the private
 * list cannot be read, the probe records reproducible failure evidence and
 * fails — no SDK fallback, no fabricated authority.
 *
 * Harness only (Node, never bundled).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Browser, Frame } from "@playwright/test"
import type { BackendSnapshot } from "../src/agent-manager/fixture-backend"
import { CONFIG_FILENAME } from "../src/config/paths"
import { createStreamingModel, SCRIPTED, type ScriptedModelHandle } from "./e2e-scripted-model"
import { writeRealGenerationSeed } from "./e2e-restart-seed"
import { canonicalDbPath, isIsolatedDataRoot, validateGateEvidence } from "./e2e-canonical"
import { runGenerationGate, type GateFacts } from "./e2e-generation-assert"
import { assertRunOwnedLlmRequests, readLlmRequests } from "./e2e-llm-matrix"
import {
  clickRealNewSessionAction,
  clickTab,
  expectTranscriptText,
  findAgentManagerFrameAny,
  pickAgent,
  pickVariant,
  realTabStates,
  sleep,
  snapshotClient,
  waitForAgentOption,
  waitForFile,
  waitForLabel,
  waitForModelSelected,
  type E2EPlan,
} from "./e2e-probe-dom"

export const STREAMING_OBS_PROMPT = `${SCRIPTED.streamObsMarker}: stream slowly while boundaries run`

export async function prepareStreamingObservation(
  workspace: string,
  want: boolean,
): Promise<ScriptedModelHandle | undefined> {
  if (!want) return undefined
  const scratch = join(workspace, "..")
  const handle = await createStreamingModel(workspace, scratch)
  try {
    const seed = writeRealGenerationSeed(workspace, handle.port, scratch)
    const file = join(workspace, ".kilo", CONFIG_FILENAME)
    mkdirSync(dirname(file), { recursive: true })
    console.log(`[probe] streaming-observation seed: ${seed.configFile} (streaming model port ${handle.port})`)
    return handle
  } catch (err) {
    await handle.close().catch(() => {})
    throw err
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function checkGate(scratch: string): Promise<void> {
  await waitForFile(join(scratch, "canonical-gate.json"), 30_000, "canonical gate before streaming-obs")
  const gate = JSON.parse(readFileSync(join(scratch, "canonical-gate.json"), "utf8")) as Record<string, unknown>
  const err = validateGateEvidence(gate)
  if (err) throw new Error(`streaming-observation: canonical gate invalid: ${err}`)
  const root = gate.dataRoot as string | undefined
  if (typeof root === "string" && !isIsolatedDataRoot(scratch, root)) throw new Error("streaming-observation: dataRoot not isolated")
}

async function requestSoSeedCredential(scratch: string, timeout: number): Promise<Record<string, unknown>> {
  try {
    const { rmSync } = await import("node:fs")
    rmSync(join(scratch, "so-credential.json"), { force: true })
  } catch {}
  writeFileSync(join(scratch, "so-credseed-request"), "ok")
  await waitForFile(join(scratch, "so-credential.json"), timeout, "so-credential.json")
  return JSON.parse(readFileSync(join(scratch, "so-credential.json"), "utf8")) as Record<string, unknown>
}

async function requestSoCanonical(scratch: string, timeout: number): Promise<Record<string, unknown>> {
  writeFileSync(join(scratch, "so-cstate-request"), "ok")
  await waitForFile(join(scratch, "so-cstate.json"), timeout, "so-cstate.json")
  return JSON.parse(readFileSync(join(scratch, "so-cstate.json"), "utf8")) as Record<string, unknown>
}

async function checkCredential(scratch: string, plan: E2EPlan, timeout: number): Promise<void> {
  await waitForFile(join(scratch, "so-credential.json"), timeout, "so-credential.json")
  const cred = JSON.parse(readFileSync(join(scratch, "so-credential.json"), "utf8")) as Record<string, unknown>
  if (cred.ok !== true) throw new Error(`streaming-observation: credential failed ${JSON.stringify(cred)}`)
  const connected = (cred as { connected?: unknown }).connected
  if (!Array.isArray(connected) || !connected.includes(plan.customProvider)) throw new Error("streaming-observation: credential missing provider")
  const fresh = await requestSoSeedCredential(scratch, timeout)
  if (fresh.ok !== true) throw new Error(`streaming-observation: credential round-trip failed ${JSON.stringify(fresh)}`)
}

async function checkCanonical(scratch: string, plan: E2EPlan, timeout: number): Promise<void> {
  const cstate = await requestSoCanonical(scratch, timeout)
  const prov = (cstate as { providerIndex?: { connected?: unknown; entries?: Array<{ id: string; hasCredential: boolean }> } | null }).providerIndex
  if (!prov || !Array.isArray(prov.connected) || !prov.connected.includes(plan.customProvider)) {
    throw new Error("streaming-observation: canonical missing provider")
  }
  const entry = prov.entries?.find((e) => e.id === plan.customProvider)
  if (!entry?.hasCredential) throw new Error("streaming-observation: hasCredential false")
}

async function pickIdentity(frame: Frame, plan: E2EPlan, timeout: number): Promise<void> {
  await waitForAgentOption(frame, plan.customAgentLabel, timeout)
  await pickAgent(frame, plan.customAgentLabel, timeout)
  await waitForLabel(frame, ".mode-switcher-trigger-label", plan.customAgentLabel, timeout, "custom agent selected")
  await pickVariant(frame, plan.customVariantA, timeout)
  await waitForLabel(frame, ".thinking-selector-trigger-label", plan.customVariantA, timeout, "variant selected")
  await waitForModelSelected(frame, plan.customProvider, plan.customModel, timeout, "custom model selected")
}

async function sendStreamingPrompt(frame: Frame, timeout: number): Promise<void> {
  const ta = frame.locator("textarea.prompt-input").first()
  await ta.waitFor({ state: "visible", timeout })
  await ta.fill("")
  await ta.pressSequentially(STREAMING_OBS_PROMPT, { delay: 5 })
  const send = frame.locator('button[aria-label="Send"]').first()
  const deadline = Date.now() + timeout
  for (;;) {
    const present = await send.count().then((n) => n > 0)
    const disabled = present ? await send.getAttribute("aria-disabled").catch(() => "true") : "true"
    if (present && disabled !== "true") break
    if (Date.now() > deadline) throw new Error("streaming-observation: Send never enabled")
    await sleep(250)
  }
  await send.click({ timeout })
}

interface StreamTarget {
  sid: string
  opId: string
  msgId: string
}

function streamTargetOf(snap: BackendSnapshot): StreamTarget | undefined {
  for (const [sid, msgs] of Object.entries(snap.messages ?? {})) {
    for (const m of msgs ?? []) {
      if (m.role === "user" && typeof m.id === "string" && m.id.startsWith("msg") && m.text.includes(SCRIPTED.streamObsMarker)) {
        return { sid, opId: `prompt:${m.id}`, msgId: m.id }
      }
    }
  }
  return undefined
}

function assistantTextOf(snap: BackendSnapshot, sid: string): string {
  const msgs = snap.messages[sid] ?? []
  return msgs.filter((m) => m.role === "assistant").map((m) => m.text).join("\n")
}

function userCountOf(snap: BackendSnapshot, sid: string): number {
  return (snap.messages[sid] ?? []).filter((m) => m.role === "user" && m.text.includes(SCRIPTED.streamObsMarker)).length
}

function mainRequestCount(model: ScriptedModelHandle): number {
  return model.requests.filter((r) => {
    try {
      return JSON.stringify(r.body).includes(SCRIPTED.streamObsMarker) && !JSON.stringify(r.body).includes("Generate a title")
    } catch {
      return false
    }
  }).length
}

async function requestSoPeerStatus(scratch: string): Promise<{
  backend: { pid: number | null; port: number | null; epoch: number | null }
  private: { available: boolean; state: string }
}> {
  try {
    const { rmSync } = await import("node:fs")
    rmSync(join(scratch, "so-peer-status.json"), { force: true })
  } catch {}
  writeFileSync(join(scratch, "so-peer-status-request"), "ok")
  await waitForFile(join(scratch, "so-peer-status.json"), 30_000, "so-peer-status.json")
  return JSON.parse(readFileSync(join(scratch, "so-peer-status.json"), "utf8")) as {
    backend: { pid: number | null; port: number | null; epoch: number | null }
    private: { available: boolean; state: string }
  }
}

async function requestSoSnapshot(scratch: string): Promise<Record<string, unknown>> {
  writeFileSync(join(scratch, "so-obs-snapshot-request"), "ok")
  await waitForFile(join(scratch, "so-obs-snapshot.json"), 30_000, "so-obs-snapshot.json")
  return JSON.parse(readFileSync(join(scratch, "so-obs-snapshot.json"), "utf8")) as Record<string, unknown>
}

async function requestSoStatus(scratch: string): Promise<Record<string, unknown>> {
  writeFileSync(join(scratch, "so-status-request"), "ok")
  await waitForFile(join(scratch, "so-status.json"), 30_000, "so-status.json")
  return JSON.parse(readFileSync(join(scratch, "so-status.json"), "utf8")) as Record<string, unknown>
}

function isSoD1Enabled(): boolean {
  const raw = (process.env.KILO_E2E_SO_D1 ?? "").trim().toLowerCase()
  return raw === "1" || raw === "true" || raw === "yes"
}

async function requestSoOperations(scratch: string, sid: string): Promise<Record<string, unknown>> {
  try {
    const { rmSync } = await import("node:fs")
    rmSync(join(scratch, "so-ops.json"), { force: true })
  } catch {}
  writeFileSync(join(scratch, "so-ops-request"), JSON.stringify({ sessionId: sid, limit: 1 }))
  await waitForFile(join(scratch, "so-ops.json"), 30_000, "so-ops.json")
  return JSON.parse(readFileSync(join(scratch, "so-ops.json"), "utf8")) as Record<string, unknown>
}

function opsOutcomeOf(ops: Record<string, unknown>, opId: string): { outcome: string | null; entry: unknown } {
  const list = (ops as { operations?: unknown }).operations
  if (!Array.isArray(list)) return { outcome: null, entry: null }
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const row = item as { opId?: unknown; outcome?: unknown }
    if (row.opId !== opId) continue
    return { outcome: typeof row.outcome === "string" ? row.outcome : null, entry: item }
  }
  return { outcome: null, entry: null }
}

function isTerminalOutcome(outcome: string | null): boolean {
  return outcome === "succeeded" || outcome === "failed" || outcome === "abandoned"
}

async function requestSoAbortReset(scratch: string): Promise<unknown> {
  try {
    const { rmSync } = await import("node:fs")
    rmSync(join(scratch, "so-abort-reset.json"), { force: true })
  } catch {}
  writeFileSync(join(scratch, "so-abort-reset-request"), "ok")
  await waitForFile(join(scratch, "so-abort-reset.json"), 30_000, "so-abort-reset.json")
  return JSON.parse(readFileSync(join(scratch, "so-abort-reset.json"), "utf8")) as unknown
}

async function requestSoAbort(scratch: string): Promise<{ entries: Array<{ sessionID?: string }>; total: number }> {
  try {
    const { rmSync } = await import("node:fs")
    rmSync(join(scratch, "so-abort.json"), { force: true })
  } catch {}
  writeFileSync(join(scratch, "so-abort-request"), "ok")
  await waitForFile(join(scratch, "so-abort.json"), 30_000, "so-abort.json")
  return JSON.parse(readFileSync(join(scratch, "so-abort.json"), "utf8")) as {
    entries: Array<{ sessionID?: string }>
    total: number
  }
}

async function requestSoAuthority(
  scratch: string,
  sid: string,
): Promise<{
  ok: boolean
  via: string
  list: { entries: number; hasSid: boolean }
  get: { status: string }
  messages: { items: number; userMarkers: number; hasMarker: boolean }
  dirProbe?: unknown
  reason?: string
  error?: string
  enabled?: boolean
  started?: boolean
}> {
  try {
    const { rmSync } = await import("node:fs")
    rmSync(join(scratch, "so-authority.json"), { force: true })
  } catch {}
  writeFileSync(join(scratch, "so-authority-request"), JSON.stringify({ sessionId: sid }))
  await waitForFile(join(scratch, "so-authority.json"), 60_000, "so-authority.json")
  return JSON.parse(readFileSync(join(scratch, "so-authority.json"), "utf8")) as {
    ok: boolean
    via: string
    list: { entries: number; hasSid: boolean }
    get: { status: string }
    messages: { items: number; userMarkers: number; hasMarker: boolean }
    dirProbe?: unknown
    reason?: string
    error?: string
    enabled?: boolean
    started?: boolean
  }
}

async function countText(frame: Frame, text: string): Promise<number> {
  return frame.getByText(text, { exact: false }).count().catch(() => 0)
}

async function ensureTab(frame: Frame, browser: Browser, sid: string, timeout: number): Promise<Frame> {
  let cur = frame
  const deadline = Date.now() + timeout
  for (;;) {
    if (cur.isDetached()) cur = (await findAgentManagerFrameAny(browser, 5_000)).frame
    const tabs = await realTabStates(cur)
    if (tabs.some((t) => t.id === sid)) {
      await clickTab(cur, sid, 10_000)
      return cur
    }
    if (Date.now() > deadline) throw new Error(`streaming-observation: tab ${sid} missing`)
    await sleep(500)
  }
}

/**
 * Bounded D1 convergence poll: snapshot status + panel operations until a
 * terminal outcome or the budget lapses. Returns the bounded timeline plus
 * the last observed state for the verdict.
 */
async function pollD1Outcome(
  scratch: string,
  snap: { request: () => Promise<BackendSnapshot> },
  sid: string,
  opId: string,
  budgetMs: number,
): Promise<{
  timeline: Array<Record<string, unknown>>
  cur: BackendSnapshot | undefined
  ops: Record<string, unknown>
  outcome: string | null
}> {
  const deadline = Date.now() + budgetMs
  const timeline: Array<Record<string, unknown>> = []
  let cur: BackendSnapshot | undefined
  let ops: Record<string, unknown> = {}
  let outcome: string | null = null
  for (;;) {
    cur = await snap.request()
    ops = await requestSoOperations(scratch, sid).catch((e) => ({ error: String(e).slice(0, 300) }))
    const hit = opsOutcomeOf(ops, opId)
    outcome = hit.outcome
    timeline.push({ at: new Date().toISOString(), status: cur.statuses[sid] ?? "idle", outcome, hasReceipt: hit.entry !== null })
    if (isTerminalOutcome(outcome)) break
    if (Date.now() > deadline) break
    await sleep(1_000)
  }
  return { timeline, cur, ops, outcome }
}

/**
 * D1 dedicated sub-scenario (opt-in via KILO_E2E_SO_D1=1): while the
 * controllable model still holds the in-flight turn (so-release NOT written),
 * actively close the FD peer via the existing so-fdconn fixture path — the
 * owner action true-closes the ServerManager-owned private pipes for the
 * exact active epoch/pid (backend observes EOF/EPIPE, child stays alive)
 * plus the borrowed inner dispose so the real host `onClosed` fires — then
 * bounded-poll for convergence to a terminal operation outcome
 * (succeeded/failed/abandoned). Strict verdict (no any-terminal PASS):
 * close must be proven in-flight (busy + operation in-flight + open owner),
 * owner true-close with same pid/epoch, same worker after, mainRequests
 * unchanged; failed/abandoned additionally requires operation code +
 * receipt replay=forbidden + gen/owner closed; succeeded additionally
 * requires private-authoritative messages to carry the full
 * `streamObsParts`+`streamObsFinal`, assistant finish stop / error null,
 * status idle + receipt owner close completed. Any mismatch FAILs with an
 * explicit discrepancy (never log-only). Run-owned evidence only.
 * Harness-only; production untouched. All waits bounded; cleanup stays with
 * the existing run-owned harness tail (closeHandles + scratch verify).
 */
// eslint-disable-next-line complexity
async function assertStreamingObservationD1InFlightClose(
  scratch: string,
  snap: { request: () => Promise<BackendSnapshot> },
  model: ScriptedModelHandle,
  sid: string,
  opId: string,
  root: string,
): Promise<void> {
  const startedAt = new Date().toISOString()
  const discrepancies: string[] = []
  const fail = (reason: string, extra: Record<string, unknown>): never => {
    const evidence = {
      scenario: "streaming-observation",
      subscenario: "D1-inflight-fd-close",
      collectedAt: startedAt,
      sid,
      opId,
      verdict: { converged: false, reason, discrepancies },
      ...extra,
    }
    writeFileSync(join(scratch, "streaming-observation-d1.json"), JSON.stringify(evidence, null, 2))
    throw new Error(`streaming-observation D1 FAIL: ${reason} | discrepancies: ${discrepancies.join(" ;; ").slice(0, 2000)}; evidence streaming-observation-d1.json`)
  }
  const pre = await snap.request()
  const preStatus = pre.statuses[sid] ?? "idle"
  if (preStatus !== "busy") {
    discrepancies.push(`precondition status must be busy, got ${preStatus}`)
    fail(`precondition not in-flight: status=${preStatus}`, { preStatus })
  }
  const peerBefore = await requestSoPeerStatus(scratch)
  const opsBefore = await requestSoOperations(scratch, sid).catch((e) => ({ error: String(e).slice(0, 300) }))
  const beforeOutcome = opsOutcomeOf(opsBefore as Record<string, unknown>, opId)
  const mainBefore = mainRequestCount(model)
  const dbPath = canonicalDbPath(scratch)
  let gateBefore: GateFacts | null = null
  try {
    gateBefore = runGenerationGate(root, scratch, dbPath, sid, opId)
  } catch (err) {
    discrepancies.push(`DB gate before close unreadable: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
  }
  const evidence: Record<string, unknown> = {
    scenario: "streaming-observation",
    subscenario: "D1-inflight-fd-close",
    collectedAt: startedAt,
    sid,
    opId,
    pre: {
      status: preStatus,
      peer: peerBefore,
      operations: opsBefore,
      outcome: beforeOutcome.outcome,
      gate: gateBefore
        ? {
            operation: gateBefore.operation,
            owners: gateBefore.owners,
            members: gateBefore.members.length,
            receipt: gateBefore.receipt,
          }
        : null,
      mainRequests: mainBefore,
      totalRequests: model.requests.length,
      providerClientGone: model.clientGone?.current ?? false,
    },
  }
  if (mainBefore !== 1) discrepancies.push(`pre mainRequests must be 1, got ${mainBefore}`)
  if (beforeOutcome.outcome !== "in-flight" && beforeOutcome.outcome !== null) {
    discrepancies.push(`close must happen in-flight: ops outcome before close is terminal ${String(beforeOutcome.outcome)}, not in-flight`)
  }
  if (gateBefore) {
    if (!gateBefore.session.exists) discrepancies.push(`DB session ${sid} missing before close`)
    if (!gateBefore.operation || gateBefore.operation.outcome !== "in-flight") {
      discrepancies.push(`DB operation must be in-flight before close, got ${JSON.stringify(gateBefore.operation).slice(0, 300)}`)
    }
    const open = gateBefore.owners.find((o) => o.reason === null && o.closedAt === null)
    if (!open) discrepancies.push(`DB must carry an open generation owner before close, got ${JSON.stringify(gateBefore.owners).slice(0, 300)}`)
  } else {
    discrepancies.push("DB gate before close missing — cannot prove in-flight owner")
  }
  if (!peerBefore.backend.pid || !peerBefore.backend.port || peerBefore.backend.epoch === null || peerBefore.backend.epoch === undefined) {
    discrepancies.push(`peerBefore missing pid/port/epoch: ${JSON.stringify(peerBefore.backend).slice(0, 300)}`)
  }
  if (discrepancies.length > 0) fail("pre-close in-flight proof failed", { pre: evidence.pre })
  if (isTerminalOutcome(beforeOutcome.outcome)) {
    discrepancies.push(`already terminal before close (${String(beforeOutcome.outcome)}) — close did not happen in-flight`)
    fail("already-terminal-before-close is not D1 convergence", { pre: evidence.pre })
  }
  writeFileSync(join(scratch, "so-fdconn-request"), "ok")
  await waitForFile(join(scratch, "so-fdconn.json"), 120_000, "so-fdconn.json")
  const fdconn = JSON.parse(readFileSync(join(scratch, "so-fdconn.json"), "utf8")) as Record<string, unknown>
  evidence.fdconn = fdconn
  const fd = fdconn as {
    epoch?: unknown
    close?: { closed?: unknown; state?: unknown }
    owner?: { closed?: unknown; alreadyClosed?: unknown; pid?: unknown; epoch?: unknown; port?: unknown } | null
    before?: { source?: unknown }
    after?: { source?: unknown; connectionState?: unknown; sseActive?: unknown }
  }
  if (fd.epoch !== peerBefore.backend.epoch) discrepancies.push(`fdconn epoch ${String(fd.epoch)} != peerBefore epoch ${String(peerBefore.backend.epoch)}`)
  if (!fd.owner || fd.owner.closed !== true) discrepancies.push(`owner did not true-close: ${JSON.stringify(fd.owner).slice(0, 300)}`)
  if (fd.owner && fd.owner.alreadyClosed !== false) discrepancies.push(`owner alreadyClosed must be false, got ${String(fd.owner.alreadyClosed)}`)
  if (fd.owner && fd.owner.pid !== peerBefore.backend.pid) {
    discrepancies.push(`owner pid ${String(fd.owner.pid)} != peerBefore pid ${String(peerBefore.backend.pid)}`)
  }
  if (fd.owner && fd.owner.epoch !== peerBefore.backend.epoch) {
    discrepancies.push(`owner epoch ${String(fd.owner.epoch)} != peerBefore epoch ${String(peerBefore.backend.epoch)}`)
  }
  if (!fd.close || fd.close.closed !== true) discrepancies.push(`borrowed close did not report closed=true: ${JSON.stringify(fd.close).slice(0, 300)}`)
  if (!fd.before || fd.before.source !== "private") discrepancies.push(`fdconn before.source must be private, got ${String(fd.before?.source)}`)
  if (!fd.after || fd.after.source !== "sse" || fd.after.connectionState !== "connected" || fd.after.sseActive !== true) {
    discrepancies.push(`fdconn after must be live SSE connected/sseActive, got ${JSON.stringify(fd.after).slice(0, 300)}`)
  }
  if (discrepancies.length > 0) fail("fdconn owner/transport proof failed", { pre: evidence.pre, fdconn })
  const polled = await pollD1Outcome(scratch, snap, sid, opId, 60_000)
  const { timeline, cur, ops, outcome } = polled
  const peerAfter = await requestSoPeerStatus(scratch).catch((e) => ({ error: String(e).slice(0, 300) }))
  const mainAfter = mainRequestCount(model)
  evidence.timeline = timeline
  evidence.post = {
    status: cur?.statuses[sid] ?? "unknown",
    operations: ops,
    outcome,
    peer: peerAfter,
    mainRequests: mainAfter,
    totalRequests: model.requests.length,
    providerClientGone: model.clientGone?.current ?? false,
  }
  const peerAfterTyped = peerAfter as unknown as { backend?: { pid?: unknown; port?: unknown; epoch?: unknown } }
  if (peerAfterTyped.backend) {
    if (peerAfterTyped.backend.pid !== peerBefore.backend.pid) discrepancies.push(`worker pid changed across close ${String(peerBefore.backend.pid)} -> ${String(peerAfterTyped.backend.pid)}`)
    if (peerAfterTyped.backend.port !== peerBefore.backend.port) discrepancies.push(`worker port changed across close`)
    if (peerAfterTyped.backend.epoch !== peerBefore.backend.epoch) discrepancies.push(`worker epoch changed across close ${String(peerBefore.backend.epoch)} -> ${String(peerAfterTyped.backend.epoch)}`)
  } else {
    discrepancies.push(`peerAfter missing backend: ${JSON.stringify(peerAfter).slice(0, 300)}`)
  }
  if (mainAfter !== mainBefore) discrepancies.push(`mainRequests grew across close ${mainBefore} -> ${mainAfter} (accepted prompt resubmitted)`)
  if (mainAfter !== 1) discrepancies.push(`post mainRequests must stay 1, got ${mainAfter}`)
  if (!isTerminalOutcome(outcome)) {
    const busy = (cur?.statuses[sid] ?? "idle") === "busy"
    const noReceipt = outcome === "in-flight" || outcome === null
    discrepancies.push(busy && noReceipt ? "busy-inflight-no-receipt after budget" : `no-terminal-convergence busy=${busy} outcome=${String(outcome)}`)
    fail("in-flight FD peer-close did not converge", { timeline, post: evidence.post })
  }
  const postStatus = cur?.statuses[sid] ?? "idle"
  const opsHit = opsOutcomeOf(ops, opId)
  const opsEntry = opsHit.entry as Record<string, unknown> | null
  let gateAfter: GateFacts | null = null
  try {
    gateAfter = runGenerationGate(root, scratch, dbPath, sid, opId)
  } catch (err) {
    discrepancies.push(`DB gate after close unreadable: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
  }
  evidence.gateAfter = gateAfter
    ? { operation: gateAfter.operation, owners: gateAfter.owners, members: gateAfter.members.length, receipt: gateAfter.receipt }
    : null
  if (outcome === "failed" || outcome === "abandoned") {
    if (!opsEntry) discrepancies.push(`ops projection missing entry for ${opId} at terminal ${outcome}`)
    else {
      if (opsEntry.outcome !== outcome) discrepancies.push(`ops outcome ${String(opsEntry.outcome)} != polled ${outcome}`)
      if (typeof opsEntry.code !== "string" || (opsEntry.code as string).length === 0) {
        discrepancies.push(`failed/abandoned ops entry must carry operation code, got ${JSON.stringify(opsEntry).slice(0, 300)}`)
      }
    }
    if (!gateAfter) discrepancies.push("DB gate after close missing for failed/abandoned proof")
    else {
      const op = gateAfter.operation
      if (!op || op.outcome !== outcome) discrepancies.push(`DB operation outcome must be ${outcome}, got ${JSON.stringify(op).slice(0, 300)}`)
      if (!op || typeof op.code !== "string" || op.code.length === 0) {
        discrepancies.push(`DB operation must carry code for ${outcome}, got ${JSON.stringify(op).slice(0, 300)}`)
      }
      const receipt = gateAfter.receipt
      if (!receipt) discrepancies.push(`DB receipt missing for ${outcome} ${opId}`)
      else {
        if (receipt.outcome !== outcome) discrepancies.push(`receipt outcome ${String(receipt.outcome)} != operation ${outcome}`)
        if (receipt.replay !== "forbidden") discrepancies.push(`receipt replay must be forbidden, got ${String(receipt.replay)}`)
        if (receipt.genID === null || receipt.genUnknown !== null) {
          discrepancies.push(`receipt gen must equal owner (no gen_unknown), got gen=${String(receipt.genID)} unknown=${String(receipt.genUnknown)}`)
        }
      }
      const owner = gateAfter.owners.find((o) => o.genID === (receipt?.genID ?? "")) ?? gateAfter.owners[0]
      if (!owner) discrepancies.push("DB owner missing for failed/abandoned proof")
      else {
        if (receipt && receipt.genID !== owner.genID) discrepancies.push(`receipt gen ${String(receipt.genID)} != owner ${owner.genID}`)
        if (owner.closedAt === null || owner.reason === null || owner.nextAt !== null) {
          discrepancies.push(`owner must be closed (closedAt+reason set, nextAt null), got ${JSON.stringify(owner).slice(0, 300)}`)
        }
      }
    }
    if (postStatus !== "idle") discrepancies.push(`post status must be idle at terminal ${outcome}, got ${postStatus}`)
    if (discrepancies.length > 0) fail(`terminal ${outcome} proof failed`, { timeline, post: evidence.post, gateAfter: evidence.gateAfter })
    evidence.verdict = { converged: true, reason: `terminal-after-close:${outcome}`, outcome, discrepancies: [] }
    writeFileSync(join(scratch, "streaming-observation-d1.json"), JSON.stringify(evidence, null, 2))
    console.log(`[probe streaming-observation] D1 PASS terminal ${String(outcome)} status=${postStatus} owner-closed receipt-forbidden main=${mainAfter}`)
    return
  }
  if (outcome === "succeeded") {
    const text = cur ? assistantTextOf(cur, sid) : ""
    for (const part of SCRIPTED.streamObsParts as unknown as string[]) {
      if (!text.includes(part)) discrepancies.push(`private-authoritative transcript missing ${part}`)
    }
    if (!text.includes(SCRIPTED.streamObsFinal)) discrepancies.push("private-authoritative transcript missing streamObsFinal")
    const rows = cur?.messages[sid] ?? []
    const assistants = rows.filter((m) => m.role === "assistant")
    if (assistants.length === 0) discrepancies.push("no assistant message in private-authoritative read at succeeded")
    else {
      const ok = assistants.some((m) => (m as { finish?: unknown }).finish === "stop" && (m as { error?: unknown }).error === null)
      if (!ok) discrepancies.push(`no assistant with finish stop / error null: ${JSON.stringify(assistants.map((m) => ({ finish: (m as { finish?: unknown }).finish ?? null, error: (m as { error?: unknown }).error ?? "absent" }))).slice(0, 400)}`)
    }
    const readable = (cur as unknown as { messagesReadable?: Record<string, boolean> })?.messagesReadable?.[sid]
    if (readable === false) discrepancies.push("messagesReadable false — private-authoritative read unavailable at succeeded")
    if (postStatus !== "idle") discrepancies.push(`post status must be idle at succeeded, got ${postStatus}`)
    if (!gateAfter) discrepancies.push("DB gate after close missing for succeeded proof")
    else {
      const op = gateAfter.operation
      if (!op || op.outcome !== "succeeded") discrepancies.push(`DB operation outcome must be succeeded, got ${JSON.stringify(op).slice(0, 300)}`)
      const receipt = gateAfter.receipt
      if (!receipt) discrepancies.push(`DB receipt missing for succeeded ${opId}`)
      else {
        if (receipt.outcome !== "succeeded") discrepancies.push(`receipt outcome must be succeeded, got ${String(receipt.outcome)}`)
        if (receipt.replay !== "forbidden") discrepancies.push(`receipt replay must be forbidden, got ${String(receipt.replay)}`)
        if (receipt.closeReason !== "completed") discrepancies.push(`receipt owner close must be completed, got ${String(receipt.closeReason)}`)
      }
      const owner = gateAfter.owners.find((o) => o.genID === (receipt?.genID ?? "")) ?? gateAfter.owners[0]
      if (!owner) discrepancies.push("DB owner missing for succeeded proof")
      else if (owner.reason !== "completed" || owner.closedAt === null || owner.nextAt !== null) {
        discrepancies.push(`owner close must be completed (reason completed, closedAt set, nextAt null), got ${JSON.stringify(owner).slice(0, 300)}`)
      }
    }
    if (discrepancies.length > 0) fail("terminal succeeded proof failed", { timeline, post: evidence.post, gateAfter: evidence.gateAfter })
    evidence.verdict = { converged: true, reason: "terminal-after-close:succeeded", outcome, discrepancies: [] }
    writeFileSync(join(scratch, "streaming-observation-d1.json"), JSON.stringify(evidence, null, 2))
    console.log(`[probe streaming-observation] D1 PASS terminal succeeded status=idle owner-completed receipt-forbidden main=${mainAfter}`)
    return
  }
  discrepancies.push(`unexpected terminal outcome ${String(outcome)}`)
  fail("unexpected terminal outcome", { timeline, post: evidence.post })
}

// eslint-disable-next-line complexity
export async function assertStreamingObservationLifecycle(
  browser: Browser,
  plan: E2EPlan,
  scratch: string,
  model: ScriptedModelHandle,
  root: string,
): Promise<void> {
  const timeout = 30_000
  await checkGate(scratch)
  await waitForFile(join(scratch, "streaming-observation-ready"), 120_000, "streaming-observation-ready")
  await checkCredential(scratch, plan, timeout)
  let frame = (await findAgentManagerFrameAny(browser, 60_000)).frame
  const snap = snapshotClient(scratch, "so-snap")
  await checkCanonical(scratch, plan, timeout)
  await pickIdentity(frame, plan, timeout)
  await sendStreamingPrompt(frame, timeout)
  const busy = await snap.waitFor(
    (s) => {
      const hit = streamTargetOf(s)
      if (!hit) return "no streaming user message yet"
      if ((s.statuses[hit.sid] ?? "idle") !== "busy") return `session ${hit.sid} status=${s.statuses[hit.sid]} expected busy`
      return undefined
    },
    90_000,
    "streaming prompt busy",
  )
  const target = streamTargetOf(busy)
  if (!target) throw new Error("streaming-observation: busy target lost")
  const { sid, opId } = target
  console.log(`[probe streaming-observation] streaming busy sid=${sid} op=${opId}`)
  const mainBefore = mainRequestCount(model)
  if (mainBefore !== 1) throw new Error(`streaming-observation: main requests before boundaries must be 1, got ${mainBefore}`)
  const llmBefore = readLlmRequests(scratch).length
  const tailBeforeSnap = await snap.request()
  const tailBefore = assistantTextOf(tailBeforeSnap, sid)
  const userBefore = userCountOf(tailBeforeSnap, sid)
  if (userBefore !== 1) throw new Error(`streaming-observation: user marker count before must be 1, got ${userBefore}`)
  const obsBefore = await requestSoSnapshot(scratch)
  const cursorBefore = obsBefore.cursor as number | undefined
  if (typeof cursorBefore !== "number") throw new Error("streaming-observation: observation cursor missing")
  writeFileSync(join(scratch, "streaming-observation-before.json"), JSON.stringify({ sid, opId, tailBefore, llmBefore, cursorBefore }, null, 2))

  // Boundary 1: session A→B→A switch. The New-session click opens a pending
  // tab (not a real session tab yet, mirroring the H-8 concurrent-session
  // path): drive a quick companion prompt through the production path so B
  // becomes a real session while A still streams, then click B→A.
  frame = await clickRealNewSessionAction(browser, timeout)
  await waitForAgentOption(frame, plan.customAgentBLabel, timeout)
  await pickAgent(frame, plan.customAgentBLabel, timeout)
  await waitForLabel(frame, ".mode-switcher-trigger-label", plan.customAgentBLabel, timeout, "companion agent selected")
  await pickVariant(frame, plan.customVariantB, timeout)
  await waitForLabel(frame, ".thinking-selector-trigger-label", plan.customVariantB, timeout, "companion variant selected")
  {
    const ta = frame.locator("textarea.prompt-input").first()
    await ta.waitFor({ state: "visible", timeout })
    await ta.fill("")
    await ta.pressSequentially("E2E switch companion probe: reply briefly", { delay: 5 })
    const send = frame.locator('button[aria-label="Send"]').first()
    const deadline = Date.now() + timeout
    for (;;) {
      const present = await send.count().then((n) => n > 0)
      const disabled = present ? await send.getAttribute("aria-disabled").catch(() => "true") : "true"
      if (present && disabled !== "true") break
      if (Date.now() > deadline) throw new Error("streaming-observation: companion Send never enabled")
      await sleep(250)
    }
    await send.click({ timeout })
  }
  const withCompanion = await snap.waitFor(
    (s) => {
      if (s.sessions.length < 2) return `expected 2 backend sessions, got ${s.sessions.length}`
      const b = s.sessions.find((x) => x.id !== sid)
      if (!b) return "companion session missing from backend"
      return undefined
    },
    90_000,
    "companion session created while A streams",
  )
  const bid = withCompanion.sessions.find((x) => x.id !== sid)!.id
  let tabsAfterNew = await realTabStates(frame)
  {
    const deadline = Date.now() + timeout
    while (!(tabsAfterNew.some((t) => t.id === sid) && tabsAfterNew.some((t) => t.id === bid)) && Date.now() < deadline) {
      await sleep(500)
      if (frame.isDetached()) frame = (await findAgentManagerFrameAny(browser, 5_000)).frame
      tabsAfterNew = await realTabStates(frame)
    }
  }
  if (!tabsAfterNew.some((t) => t.id === sid) || !tabsAfterNew.some((t) => t.id === bid)) {
    throw new Error(`streaming-observation: switch needs A + B tabs, got ${tabsAfterNew.map((t) => t.id).join(",")}`)
  }
  frame = await ensureTab(frame, browser, sid, timeout)
  frame = await ensureTab(frame, browser, bid, timeout)
  frame = await ensureTab(frame, browser, sid, timeout)
  const afterSwitch = await snap.request()
  if (userCountOf(afterSwitch, sid) !== 1) throw new Error("streaming-observation: switch duplicated user message")
  if ((afterSwitch.statuses[sid] ?? "idle") !== "busy") {
    throw new Error(`streaming-observation: switch cancelled in-flight turn (status=${afterSwitch.statuses[sid] ?? "idle"})`)
  }
  if (mainRequestCount(model) !== 1) throw new Error("streaming-observation: switch resubmitted accepted prompt")
  const tailSwitch = assistantTextOf(afterSwitch, sid)
  if (tailBefore.length > 0 && !tailSwitch.startsWith(tailBefore)) throw new Error("streaming-observation: switch lost persisted tail")
  console.log(`[probe streaming-observation] PASS switch A->B->A sid=${sid} bid=${bid}`)

  // D1 dedicated sub-scenario (KILO_E2E_SO_D1=1 only): in-flight FD peer-close
  // convergence while the model hold is active. Terminates here either way —
  // never continues into the main reopen/release PASS flow.
  if (isSoD1Enabled()) {
    await assertStreamingObservationD1InFlightClose(scratch, snap, model, sid, opId, root)
    return
  }

  // Boundary 2: in-flight panel close/reopen is re-observe only. The held
  // stream stays open across the boundary: no cancel, still busy, single
  // user marker, single main LLM request, and the reopened panel reconverges
  // on private-authoritative list/get/messages. Any failure here is recorded
  // as reproducible evidence and fails — no SDK fallback, no fabricated
  // authority, no reopen bypass.
  await requestSoAbortReset(scratch)
  try {
    const { rmSync } = await import("node:fs")
    rmSync(join(scratch, "so-reopen-ready"), { force: true })
    rmSync(join(scratch, "so-reopen-projection.json"), { force: true })
  } catch {}
  let afterReopen: Awaited<ReturnType<typeof snap.request>> | undefined
  let tailReopen = ""
  let aborts: { entries: Array<{ sessionID?: string }>; total: number } = { entries: [], total: -1 }
  let authority:
    | {
        ok: boolean
        via: string
        list: { entries: number; hasSid: boolean }
        get: { status: string }
        messages: { items: number; userMarkers: number; hasMarker: boolean }
        dirProbe?: unknown
        reason?: string
        error?: string
      }
    | undefined
  try {
    writeFileSync(join(scratch, "so-reopen-request"), JSON.stringify({ sessionId: sid, opId }))
    await waitForFile(join(scratch, "so-reopen-ready"), 120_000, "so-reopen-ready")
    frame = (await findAgentManagerFrameAny(browser, 60_000)).frame
    afterReopen = await snap.request()
    if (userCountOf(afterReopen, sid) !== 1) throw new Error("streaming-observation: reopen duplicated user message")
    if ((afterReopen.statuses[sid] ?? "idle") !== "busy") {
      throw new Error(`streaming-observation: reopen cancelled in-flight turn (status=${afterReopen.statuses[sid] ?? "idle"})`)
    }
    if (mainRequestCount(model) !== 1) throw new Error("streaming-observation: reopen resubmitted accepted prompt")
    tailReopen = assistantTextOf(afterReopen, sid)
    if (tailBefore.length > 0 && !tailReopen.startsWith(tailBefore)) throw new Error("streaming-observation: reopen lost persisted tail")
    aborts = await requestSoAbort(scratch)
    const sidAborts = aborts.entries.filter((e) => e.sessionID === sid)
    if (aborts.total !== 0 || sidAborts.length !== 0) {
      throw new Error(`streaming-observation: reopen issued abort total=${aborts.total} sidAborts=${sidAborts.length}`)
    }
    authority = await requestSoAuthority(scratch, sid)
    if (!authority.ok || authority.via !== "private" || !authority.list.hasSid || authority.get.status !== "found" || !authority.messages.hasMarker) {
      throw new Error(`streaming-observation: reopen private authority did not converge: ${JSON.stringify({ ok: authority.ok, via: authority.via, list: authority.list, get: authority.get, messages: authority.messages, reason: authority.reason ?? null, error: authority.error ?? null })}`)
    }
    frame = await ensureTab(frame, browser, sid, 60_000)
  } catch (err) {
    const tabsDiag = await realTabStates(frame).catch(() => [] as Array<{ id: string; label: string }>)
    const peerDiag = await requestSoPeerStatus(scratch).catch((e) => ({ error: String(e).slice(0, 300) }))
    const prodDiag = await requestSoStatus(scratch).catch((e) => ({ error: String(e).slice(0, 300) }))
    writeFileSync(
      join(scratch, "streaming-observation-reopen-failure.json"),
      JSON.stringify(
        {
          scenario: "streaming-observation",
          phase: "in-flight-reopen",
          collectedAt: new Date().toISOString(),
          sid,
          opId,
          failure: String(err instanceof Error ? err.message : err).slice(0, 500),
          tailBeforeLen: tailBefore.length,
          tailReopenLen: tailReopen.length,
          userMarkers: afterReopen ? userCountOf(afterReopen, sid) : -1,
          status: afterReopen ? (afterReopen.statuses[sid] ?? "idle") : "unknown",
          mainRequests: mainRequestCount(model),
          aborts,
          authority: authority ?? null,
          tabs: tabsDiag.map((t) => t.id),
          peer: peerDiag,
          observation: prodDiag,
          reproduce: {
            seed: "so-reopen-request {sessionId, opId} while busy; read so-authority.json + so-abort.json + so-snap-*.json",
            scratchFiles: ["so-reopen-projection.json", "so-reopen-ready", "so-authority.json", "so-abort.json"],
          },
        },
        null,
        2,
      ),
    )
    throw err
  }
  console.log(`[probe streaming-observation] PASS reopen in-flight sid=${sid} busy user=1 main=1 authority=private list=${authority!.list.entries} messages=${authority!.messages.items}`)

  // Release the held stream and let the turn complete AFTER the in-flight
  // reopen above. Rationale: closing the FD underlying transport while the
  // provider fetch is in flight silently drops it (turn orphaned busy, no
  // cancel/disposition), so the remaining transport boundary runs against
  // the completed turn and proves observation convergence onto the same
  // authoritative read.
  writeFileSync(join(scratch, "so-release"), "ok")
  console.log("[probe streaming-observation] release gate written — awaiting turn completion")
  const done = await snap.waitFor(
    (s) => {
      const hit = streamTargetOf(s)
      if (!hit) return "streaming session lost"
      if ((s.statuses[hit.sid] ?? "idle") !== "idle") return `session ${hit.sid} status=${s.statuses[hit.sid]} expected idle`
      const text = assistantTextOf(s, hit.sid)
      if (!text.includes(SCRIPTED.streamObsFinal)) return "final streaming text not yet persisted"
      return undefined
    },
    120_000,
    "streaming turn completes after release",
  )
  const doneText = assistantTextOf(done, sid)
  for (const part of SCRIPTED.streamObsParts as unknown as string[]) {
    if (!doneText.includes(part)) throw new Error(`streaming-observation: completed transcript missing ${part}`)
  }
  if (tailBefore.length > 0 && !doneText.startsWith(tailBefore)) throw new Error("streaming-observation: completion lost persisted prefix")
  console.log(`[probe streaming-observation] PASS completion tail ${tailBefore.length}->${doneText.length}`)

  // Boundary 3: FD transport reconnect with backend alive (completed turn).
  // See D1 in the header: while in flight this silently drops the provider
  // fetch, so it runs post-completion and proves transport convergence +
  // transcript stability.
  // The current workspace drives live realtime over the private FD peer
  // (SSE is torn down while private is live), so the boundary closes the
  // FD underlying transport via the production fixture path and proves the
  // SSE fallback converges with the SAME worker PID/port/epoch.
  const peerBefore = await requestSoPeerStatus(scratch)
  if (!peerBefore.backend.pid || !peerBefore.backend.port) throw new Error("streaming-observation: peer status missing pid/port before FD reconnect")
  if (peerBefore.backend.epoch === null || peerBefore.backend.epoch === undefined) {
    throw new Error("streaming-observation: peer status missing epoch before FD reconnect")
  }
  writeFileSync(join(scratch, "so-fdconn-request"), "ok")
  await waitForFile(join(scratch, "so-fdconn.json"), 120_000, "so-fdconn.json")
  const fdconn = JSON.parse(readFileSync(join(scratch, "so-fdconn.json"), "utf8")) as {
    epoch: number | null
    close: { closed: boolean; state: string }
    owner: { closed: boolean; alreadyClosed: boolean; pid: number | undefined; port: number | null; epoch: number | null } | null
    before: { source: string | null; connectionState: string; sseActive: boolean }
    after: { source: string | null; connectionState: string; sseActive: boolean }
  }
  if (fdconn.before.source !== "private") throw new Error(`streaming-observation: FD reconnect live source must start private, got ${String(fdconn.before.source)}`)
  if (fdconn.close.closed !== true) throw new Error("streaming-observation: FD underlying transport not observed closed")
  if (!fdconn.owner || fdconn.owner.closed !== true || fdconn.owner.alreadyClosed !== false) {
    throw new Error(`streaming-observation: FD owner did not true-close: ${JSON.stringify(fdconn.owner).slice(0, 300)}`)
  }
  if (fdconn.owner.pid !== peerBefore.backend.pid) {
    throw new Error(`streaming-observation: FD owner pid mismatch ${String(fdconn.owner.pid)} != ${String(peerBefore.backend.pid)} (stale/no-op)`)
  }
  if (fdconn.owner.epoch !== peerBefore.backend.epoch) {
    throw new Error(`streaming-observation: FD owner epoch mismatch ${String(fdconn.owner.epoch)} != ${String(peerBefore.backend.epoch)} (stale/no-op)`)
  }
  if (fdconn.epoch !== peerBefore.backend.epoch) {
    throw new Error(`streaming-observation: FD epoch mismatch ${String(fdconn.epoch)} != ${String(peerBefore.backend.epoch)}`)
  }
  if (fdconn.after.source !== "sse" || fdconn.after.connectionState !== "connected" || fdconn.after.sseActive !== true) {
    throw new Error(`streaming-observation: FD fallback did not converge to live SSE: ${JSON.stringify(fdconn.after)}`)
  }
  const peerAfter = await requestSoPeerStatus(scratch)
  if (peerAfter.backend.pid !== peerBefore.backend.pid) throw new Error(`streaming-observation: FD reconnect changed worker pid ${String(peerBefore.backend.pid)} -> ${String(peerAfter.backend.pid)}`)
  if (peerAfter.backend.port !== peerBefore.backend.port) throw new Error("streaming-observation: FD reconnect changed port")
  if (peerAfter.backend.epoch !== peerBefore.backend.epoch) {
    throw new Error(`streaming-observation: FD reconnect changed epoch ${String(peerBefore.backend.epoch)} -> ${String(peerAfter.backend.epoch)}`)
  }
  if (!pidAlive(peerAfter.backend.pid!)) throw new Error("streaming-observation: backend pid not alive after FD reconnect")
  const afterConn = await snap.request()
  if (userCountOf(afterConn, sid) !== 1) throw new Error("streaming-observation: reconnect duplicated user message")
  if ((afterConn.statuses[sid] ?? "idle") !== "idle") {
    throw new Error(`streaming-observation: completed turn regressed after FD reconnect (status=${afterConn.statuses[sid] ?? "idle"})`)
  }
  if (mainRequestCount(model) !== 1) throw new Error("streaming-observation: reconnect resubmitted accepted prompt")
  if (!assistantTextOf(afterConn, sid).includes(SCRIPTED.streamObsFinal)) throw new Error("streaming-observation: reconnect lost final text")
  console.log(`[probe streaming-observation] PASS FD reconnect private->SSE pid=${peerAfter.backend.pid} port=${peerAfter.backend.port}`)

  // Final convergence onto the same backend authoritative read.
  const finalSnap = await snap.request()
  const finalText = assistantTextOf(finalSnap, sid)
  for (const part of SCRIPTED.streamObsParts as unknown as string[]) {
    if (!finalText.includes(part)) throw new Error(`streaming-observation: final transcript missing ${part}`)
  }
  if (tailBefore.length > 0 && !finalText.startsWith(tailBefore)) throw new Error("streaming-observation: final lost persisted prefix")
  if (userCountOf(finalSnap, sid) !== 1) throw new Error("streaming-observation: final duplicated user message")
  if (mainRequestCount(model) !== 1) throw new Error(`streaming-observation: final resubmitted (main=${mainRequestCount(model)})`)
  frame = await ensureTab(frame, browser, sid, 60_000)
  await expectTranscriptText(frame, SCRIPTED.streamObsFinal, 60_000, "final text rendered")
  const occurrences = await countText(frame, SCRIPTED.streamObsFinal)
  if (occurrences !== 1) throw new Error(`streaming-observation: duplicate presentation occurrences=${occurrences}`)
  const obsAfter = await requestSoSnapshot(scratch)
  const cursorAfter = obsAfter.cursor as number | undefined
  if (typeof cursorAfter !== "number" || cursorAfter < (cursorBefore as number)) {
    throw new Error(`streaming-observation: cursor regressed ${String(cursorBefore)} -> ${String(cursorAfter)}`)
  }
  const status = await requestSoStatus(scratch)
  if (status.dbPath !== canonicalDbPath(scratch)) throw new Error("streaming-observation: canonical DB mismatch")
  const llm = assertRunOwnedLlmRequests(scratch, "streaming-observation-final")
  void existsSync
  writeFileSync(
    join(scratch, "streaming-observation-runtime-evidence"),
    JSON.stringify(
      {
        scenario: "streaming-observation",
        collectedAt: new Date().toISOString(),
        sid,
        opId,
        tailBeforeLen: tailBefore.length,
        finalLen: finalText.length,
        mainRequests: mainRequestCount(model),
        llmBefore,
        llmAfter: readLlmRequests(scratch).length,
        llmMatrix: llm,
        conn: { kind: "fd-private-to-sse", pid: peerAfter.backend.pid, port: peerAfter.backend.port, epoch: peerAfter.backend.epoch, before: fdconn.before, after: fdconn.after },
        cursorBefore,
        cursorAfter,
        dbPath: status.dbPath,
      },
      null,
      2,
    ),
  )
  console.log(`[probe streaming-observation] proven sid=${sid} op=${opId} tail ${tailBefore.length}->${finalText.length} cursor=${String(cursorBefore)}->${String(cursorAfter)}`)
}
