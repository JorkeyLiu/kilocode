/**
 * Real-restart E2E scenario (script/e2e-probe.ts imports this; the probe file
 * stays under its maxLines cap). Remaining H-10/H-11 runtime-boundary evidence
 * over the shared kilo serve HTTP/SSE/SDK bridge (LOCK-009): ONE real
 * completed session with a durable transcript marker + artifact file, then
 * presentation convergence to runtime facts across every boundary —
 *
 *   Phase A: explicit SSE reconnect (production SdkSSEAdapter.reconnect) with
 *   the backend ALIVE: same server port/PID, connected before and after, a
 *   non-connected dip in between, ≥1 `server.connected` event delivered (the
 *   direct new-stream signal), unchanged backend session facts, and no
 *   duplicate/stale presentation in the DOM.
 *
 *   Phase B: exact-owned worker restart — killServerForFixture terminates ONLY
 *   the exact current process group through ServerManager's owner path
 *   (SIGTERM to -pid, the same kill dispose() uses), then the production
 *   reconnect flow (getClientAsync → replacement server + SSE). New PID + new
 *   port, the killed PID verifiably gone, and the SAME session id, transcript,
 *   and artifact rehydrate from the same run-owned XDG scratch; the UI
 *   converges through the production connected-state sync.
 *
 *   Phase C: true window/extension restart — the runner executes
 *   workbench.action.reloadWindow (acknowledged via rr-reload-executed) and
 *   the old Extension Host is torn down. In --extensionTestsPath test mode the
 *   main process exits with the extension host, so the harness treats that
 *   exit as the expected reload boundary and RELAUNCHES VS Code with the
 *   identical args; the fresh Extension Host re-runs the test runner, detects
 *   the persisted rr-reload-request marker, restores/reopens the Agent
 *   Manager panel (webview-panel serializer), and writes rr-reloaded. The
 *   harness asserts runner re-entry (runner-pid changed) and that the fresh
 *   webview + backend resume the same session, transcript, and artifact
 *   bytes.
 *
 * No synthetic session/message injection: every asserted fact is served by the
 * real backend through the real SDK and rendered by the real webview.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Browser, Frame } from "@playwright/test"
import type { BackendSnapshot } from "../src/agent-manager/fixture-backend"
import { SCRIPTED, type ScriptedModelHandle } from "./e2e-scripted-model"
import { RESTART_ARTIFACT_CONTENT } from "./e2e-restart-seed"
import { isWrongPin, pinnedReason, pinReport, type PinExpectation } from "./e2e-pin"
import { assertRunOwnedLlmRequests, readLlmRequests } from "./e2e-llm-matrix"
import {
  E2EPlan,
  expectTranscriptText,
  findAgentManagerFrameAny,
  headerTitle,
  openSidebarSession,
  pickAgent,
  pickVariant,
  realTabStates,
  sendWithRetry,
  sleep,
  snapshotClient,
  waitForAgentOption,
  waitForFile,
  waitForFileBytes,
  waitForLabel,
  waitForModelSelected,
  waitForRealSessionTabs,
} from "./e2e-probe-dom"

/** Prompt typed into the real Agent Manager prompt input for the restart turn. */
const RESTART_PROMPT = `${SCRIPTED.restartMarker}: call the user tool and wait for the result`

/** Exact-pid liveness probe (no signal sent; `process.kill(pid, 0)` only checks existence). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Count occurrences of a text in the webview DOM (duplicate-presentation evidence). */
async function countText(frame: Frame, text: string): Promise<number> {
  return frame
    .getByText(text, { exact: false })
    .count()
    .catch(() => 0)
}

/**
 * The restart session's pinned expectation: the seeded custom agent + the
 * run-owned custom provider/model with the Low variant (plan.customVariantA).
 * Exported for the focused unit tests.
 */
export function restartPin(plan: E2EPlan): PinExpectation {
  return {
    agent: plan.customAgent,
    provider: plan.customProvider,
    model: plan.customModel,
    variant: plan.customVariantA,
  }
}

/**
 * Backend-observable pin assertion for the real-restart session: the session
 * record AND every UI-submitted user message for the prompt carry the custom
 * agent + custom-provider model + the expected variant (see e2e-pin.ts
 * pinnedReason — the shared typed predicate every real scenario uses), the
 * transcript carries the completed user-tool part AND the fixed final text,
 * and the turn is idle. Returns the failure reason or undefined when satisfied.
 * Exported for the focused unit tests.
 */
export function restartSessionReason(
  snap: BackendSnapshot,
  id: string,
  plan: E2EPlan,
  prompt: string,
): string | undefined {
  const s = snap.sessions.find((x) => x.id === id)
  if (!s) return `session ${id} missing from backend`
  const pin = pinnedReason(snap, id, restartPin(plan), prompt)
  if (pin) return pin
  const msgs = snap.messages[id] ?? []
  const tool = msgs.flatMap((m) => m.tools ?? []).find((t) => t.tool === plan.realUserTool)
  if (!tool || tool.status !== "completed") {
    return `session ${id} user tool ${plan.realUserTool} not completed: ${JSON.stringify(tool)}`
  }
  if (!msgs.some((m) => m.text.includes(SCRIPTED.restartFinal))) {
    return `session ${id} transcript missing final text ${SCRIPTED.restartFinal}`
  }
  if ((snap.statuses[id] ?? "idle") !== "idle") return `session ${id} status=${snap.statuses[id]} expected idle`
  return undefined
}

/** Open the restart session in the webview (tab if present, else the real sidebar row). */
async function ensureRestartSessionOpen(frame: Frame, sessionId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const tabs = await realTabStates(frame)
    if (tabs.some((t) => t.id === sessionId)) return
    const sidebarHit = await frame
      .locator(`.am-item.am-topic-root[data-topic-id="${sessionId}"]`)
      .count()
      .catch(() => 0)
    if (sidebarHit > 0) {
      await openSidebarSession(frame, sessionId, 10_000)
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`probe: restart session ${sessionId} not restored as a tab or sidebar row (${timeoutMs}ms)`)
    }
    await sleep(250)
  }
}

/**
 * Phase 0: drive the REAL Agent Manager webview (agent pick + prompt input +
 * Send) against the run-owned scripted provider and assert served-backend
 * truth — session pinned to the custom agent/model, transcript carries the
 * prompt + completed user-tool part + final text, turn idle, and the run-owned
 * artifact file holds the exact bytes the real tool wrote. Returns the session
 * id, the extension-host pid recorded at this stage, and the webview frame.
 * The snapshot client is SHARED with the caller so the numbered marker
 * sequence stays in lockstep with the runner's counter.
 */
async function restartPhase0(
  browser: Browser,
  plan: E2EPlan,
  scratch: string,
  workspace: string,
  snap: ReturnType<typeof snapshotClient>,
  model: ScriptedModelHandle,
): Promise<{ sessionId: string; runnerPid: number; frame: Frame }> {
  const timeout = 30_000
  await waitForFile(join(scratch, "rr-ready"), 120_000, "rr-ready marker")
  const found = await findAgentManagerFrameAny(browser, 60_000)
  const frame = found.frame

  await waitForAgentOption(frame, plan.customAgentLabel, timeout)
  await pickAgent(frame, plan.customAgentLabel, timeout)
  await waitForLabel(frame, ".mode-switcher-trigger-label", plan.customAgentLabel, timeout, "custom agent selected")
  // LOCK-012 action-specific readiness: resolve the custom model + variant in
  // the real webview BEFORE the first send. The webview model resolution falls
  // through to the gateway KILO_AUTO free model (kilo/kilo-auto/free) until the
  // served config + provider catalog resolve, and the backend lets an explicit
  // input.model outrank the agent model — so an early send is a REAL gateway
  // call (LOCK-006 violation) that a later retry could mask. Picking the
  // variant forces the per-session model resolution; the visible model-selector
  // label then proves the custom provider/model is selected before any prompt.
  await pickVariant(frame, plan.customVariantA, timeout)
  await waitForLabel(frame, ".thinking-selector-trigger-label", plan.customVariantA, timeout, "variant Low selected")
  await waitForModelSelected(frame, plan.customProvider, plan.customModel, timeout, "custom model visibly selected")

  // A first user message pinned to anything but the custom provider/model +
  // variant is a permanent LOCK-006 violation: the FIRST message's model is
  // immutable in the served transcript, so a wrong pin can never be corrected
  // by a retry — fail non-retryably instead of re-sending (isWrongPin covers
  // both the session-record and the user-message wrong-pin error forms).
  let snap0: BackendSnapshot
  try {
    snap0 = await sendWithRetry(
      frame,
      snap,
      RESTART_PROMPT,
      1,
      (s) => {
        if (s.sessions.length < 1) return "no backend session yet"
        const id = s.sessions[0]!.id
        return restartSessionReason(s, id, plan, RESTART_PROMPT)
      },
      "restart session completed against scripted provider (transcript + user tool)",
      timeout,
      isWrongPin,
    )
  } finally {
    // Preserve the scripted-model request log on success AND failure — on a
    // wrong-model first send the scripted server sees nothing, and this file is
    // the evidence proving whether the prompt ever reached the scripted server.
    writeFileSync(join(scratch, "rr-model-requests.json"), JSON.stringify(model.requests, null, 2))
  }
  const sessionId = snap0.sessions[0]!.id
  console.log(`[probe] restart session: ${sessionId}`)
  // Backend pin evidence for the first (and only) UI send of this scenario: the
  // session record and the first user message must be pinned to e2e-local /
  // e2e-model / low with the custom agent — the direct LOCK-006 proof that no
  // gateway KILO_AUTO free fallback was used.
  const pin0 = pinReport(snap0, sessionId, restartPin(plan), RESTART_PROMPT)
  console.log(`[probe] PIN EVIDENCE (phase 0): ${JSON.stringify(pin0, null, 2)}`)
  writeFileSync(join(scratch, "rr-pin.json"), JSON.stringify(pin0, null, 2))
  const artifact = join(workspace, plan.realArtifact)
  await waitForFileBytes(artifact, RESTART_ARTIFACT_CONTENT, 60_000, "artifact file written by the real user tool")

  // LOCK-006/LOCK-008: request-level isolation after Phase 0 — the completed
  // turn AND any implicit title call both resolved to e2e-local/e2e-model.
  assertRunOwnedLlmRequests(scratch, "real-restart-phase0")
  return { sessionId, runnerPid: Number(readFileSync(join(scratch, "runner-pid"), "utf8")), frame }
}

/**
 * Phase A: transport reconnect with the backend ALIVE. Requests the env-gated
 * sseReconnect fixture command (production SdkSSEAdapter.reconnect) and
 * asserts rr-conn.json: connected before AND after, SAME server port + PID,
 * a non-connected state dip, and ≥1 `server.connected` event (the direct
 * new-stream signal — `/global/event` emits exactly one per subscription;
 * `sync` envelopes are activity-driven and not guaranteed on a quiet
 * reconnect). Then asserts a fresh backend snapshot with unchanged session
 * facts and the DOM shows exactly one session tab + exactly one occurrence
 * of the final text — no duplicate or stale presentation after the stream
 * re-established.
 */
async function restartPhaseA(
  frame: Frame,
  snap: ReturnType<typeof snapshotClient>,
  scratch: string,
  plan: E2EPlan,
  sessionId: string,
): Promise<{
  before: string
  portBefore: number | null
  pidBefore: number | null
  after: string
  portAfter: number | null
  pidAfter: number | null
  states: Array<{ state: string; at: string }>
  connectedEvents: number
}> {
  const timeout = 30_000
  writeFileSync(join(scratch, "rr-conn-request"), "ok")
  await waitForFile(join(scratch, "rr-conn.json"), 120_000, "rr-conn.json")
  const conn = JSON.parse(readFileSync(join(scratch, "rr-conn.json"), "utf8")) as {
    before: string
    portBefore: number | null
    pidBefore: number | null
    after: string
    portAfter: number | null
    pidAfter: number | null
    states: Array<{ state: string; at: string }>
    connectedEvents: number
  }
  if (conn.before !== "connected" || conn.after !== "connected") {
    throw new Error(`probe: SSE reconnect boundary failed: before=${conn.before} after=${conn.after}`)
  }
  if (conn.portBefore === null || conn.portBefore !== conn.portAfter) {
    throw new Error(
      `probe: SSE reconnect changed the server port: before=${conn.portBefore} after=${conn.portAfter} (reconnect must keep the backend alive)`,
    )
  }
  if (conn.pidBefore === null || conn.pidBefore !== conn.pidAfter) {
    throw new Error(`probe: SSE reconnect changed the server PID: before=${conn.pidBefore} after=${conn.pidAfter}`)
  }
  if (!conn.states.some((s) => s.state !== "connected")) {
    throw new Error(`probe: SSE reconnect showed no disconnect dip: ${JSON.stringify(conn.states)}`)
  }
  if (conn.connectedEvents < 1) {
    throw new Error(
      `probe: SSE reconnect delivered no server.connected event across the window (connectedEvents=${conn.connectedEvents})`,
    )
  }
  console.log(
    `[probe] PASS transport reconnect: ${JSON.stringify(conn.states)} port=${conn.portBefore} pid=${conn.pidBefore} connectedEvents=${conn.connectedEvents}`,
  )

  await snap.waitFor(
    (s) => restartSessionReason(s, sessionId, plan, RESTART_PROMPT),
    30_000,
    "backend session facts unchanged after SSE reconnect",
  )
  await waitForRealSessionTabs(frame, 1, timeout, "SSE reconnect leaves exactly one session tab")
  await expectTranscriptText(frame, SCRIPTED.restartFinal, 30_000, "final text present after SSE reconnect")
  const doneCount = await countText(frame, SCRIPTED.restartFinal)
  if (doneCount !== 1) {
    throw new Error(`probe: duplicate/stale presentation after reconnect: final text occurrences=${doneCount}`)
  }
  console.log("[probe] PASS no duplicate/stale presentation after SSE reconnect")
  // LOCK-006/LOCK-008: no generation request appeared across the transport
  // reconnect (the stream re-established, nothing new generated).
  assertRunOwnedLlmRequests(scratch, "real-restart-phaseA")
  return conn
}

/**
 * Phase B: exact-owned worker restart. Requests the env-gated killServer
 * fixture (ServerManager's owner path — SIGTERM to the exact current process
 * group only, recorded as the killed PID + port), then the production
 * reconnect flow (getClientAsync → replacement server + SSE). Asserts
 * rr-reconnect.json: connected, NEW PID + NEW port, the killed PID verifiably
 * gone; the backend snapshot rehydrates the SAME session id, transcript, and
 * artifact from the same XDG scratch; the DOM converges to the same session
 * tab + transcript through the production connected-state sync.
 */
async function restartPhaseB(
  frame: Frame,
  snap: ReturnType<typeof snapshotClient>,
  scratch: string,
  plan: E2EPlan,
  workspace: string,
  sessionId: string,
): Promise<{ killed: { pid: number; port: number }; rc: { pid: number | null; port: number | null } }> {
  writeFileSync(join(scratch, "rr-kill-request"), "ok")
  await waitForFile(join(scratch, "rr-kill.json"), 60_000, "rr-kill.json")
  const killed = JSON.parse(readFileSync(join(scratch, "rr-kill.json"), "utf8")) as { pid: number; port: number }
  if (!killed.pid || !killed.port) {
    throw new Error(`probe: worker kill recorded no exact pid/port: ${JSON.stringify(killed)}`)
  }
  console.log(`[probe] killed exact worker: pid=${killed.pid} port=${killed.port}`)
  await sleep(1_000) // let the exit event settle in the extension host
  writeFileSync(join(scratch, "rr-reconnect-request"), "ok")
  await waitForFile(join(scratch, "rr-reconnect.json"), 180_000, "rr-reconnect.json")
  const rc = JSON.parse(readFileSync(join(scratch, "rr-reconnect.json"), "utf8")) as {
    state: string
    port: number | null
    pid: number | null
    states: Array<{ state: string; at: string }>
  }
  if (rc.state !== "connected") {
    throw new Error(`probe: production reconnect did not converge: ${JSON.stringify(rc.states)}`)
  }
  if (rc.pid === null || rc.pid === killed.pid) {
    throw new Error(`probe: reconnect did not start a NEW server pid (old=${killed.pid} new=${rc.pid})`)
  }
  if (rc.port === null || rc.port === killed.port) {
    throw new Error(`probe: reconnect did not allocate a NEW port (old=${killed.port} new=${rc.port})`)
  }
  const goneDeadline = Date.now() + 30_000
  while (pidAlive(killed.pid) && Date.now() < goneDeadline) await sleep(250)
  if (pidAlive(killed.pid)) {
    throw new Error(`probe: exact killed worker pid ${killed.pid} still alive after production reconnect`)
  }
  console.log(`[probe] PASS exact worker restart: old pid=${killed.pid} port=${killed.port} → new pid=${rc.pid} port=${rc.port}`)

  await snap.waitFor(
    (s) => restartSessionReason(s, sessionId, plan, RESTART_PROMPT),
    60_000,
    "session transcript rehydrated after exact worker restart",
  )
  await waitForFileBytes(join(workspace, plan.realArtifact), RESTART_ARTIFACT_CONTENT, 30_000, "artifact rehydrated after exact worker restart")
  await ensureRestartSessionOpen(frame, sessionId, 60_000)
  await expectTranscriptText(frame, SCRIPTED.restartFinal, 60_000, "transcript converged after exact worker restart")
  // LOCK-006/LOCK-008: the replacement worker generated nothing non-run-owned —
  // the store aggregates the pre-kill records with any post-reconnect requests
  // (same run, same scratch), so an early external request cannot disappear.
  assertRunOwnedLlmRequests(scratch, "real-restart-phaseB")
  return { killed, rc }
}

/**
 * Phase C: true window/extension restart. The HARNESS writes rr-reload-request
 * (after Phase B) and the runner executes workbench.action.reloadWindow; in
 * test mode the main process exits with the torn-down Extension Host, so the
 * harness relaunches VS Code with identical args. This runs in the FRESH
 * harness after the relaunch: waits for rr-reloaded written by the fresh
 * Extension Host runner, asserts runner re-entry (runner-pid changed),
 * re-finds the fresh webview document, and asserts the same session id +
 * transcript + artifact bytes resume from the same XDG scratch.
 */
async function assertReloadPhase(
  browser: Browser,
  snapC: ReturnType<typeof snapshotClient>,
  scratch: string,
  plan: E2EPlan,
  workspace: string,
  sessionId: string,
  runnerPid: number,
  conn: unknown,
  killed: { pid: number; port: number },
  rc: { pid: number | null; port: number | null },
  model: ScriptedModelHandle,
): Promise<void> {
  await waitForFile(join(scratch, "rr-reloaded"), 300_000, "rr-reloaded marker (fresh Extension Host re-entry)")
  const reentryDeadline = Date.now() + 60_000
  let freshRunnerPid = Number(readFileSync(join(scratch, "runner-pid"), "utf8"))
  while (freshRunnerPid === runnerPid && Date.now() < reentryDeadline) {
    await sleep(250)
    freshRunnerPid = Number(readFileSync(join(scratch, "runner-pid"), "utf8"))
  }
  if (freshRunnerPid === runnerPid) {
    throw new Error(
      `probe: reloadWindow did not re-enter the runner (pid unchanged: ${runnerPid}); static evidence said it would`,
    )
  }
  console.log(`[probe] PASS runner re-entry after reloadWindow: extension-host pid ${runnerPid} → ${freshRunnerPid}`)

  const fresh = await findAgentManagerFrameAny(browser, 120_000)
  const rf = fresh.frame
  await snapC.waitFor(
    (s) => restartSessionReason(s, sessionId, plan, RESTART_PROMPT),
    120_000,
    "same session/transcript resumed in the fresh Extension Host",
  )
  // The fresh webview may restore the session as a tab or list it only as a
  // sidebar row; open it either way before asserting the rendered transcript.
  await ensureRestartSessionOpen(rf, sessionId, 120_000)
  await expectTranscriptText(rf, RESTART_PROMPT, 120_000, "prompt text present in fresh webview after restart")
  await expectTranscriptText(rf, SCRIPTED.restartFinal, 120_000, "final text present in fresh webview after restart")
  await waitForFileBytes(join(workspace, plan.realArtifact), RESTART_ARTIFACT_CONTENT, 30_000, "artifact persists after true window restart")
  await expectTranscriptText(rf, plan.customAgentLabel, 60_000, "custom agent label rendered in fresh webview")

  // Phase C backend pin evidence: the SAME session's UI-submitted message stays
  // pinned to the custom provider/model/variant + agent in the fresh Extension
  // Host — no restart boundary may re-route it to the gateway fallback.
  const finalSnap = await snapC.request()
  const pinEvidence = pinReport(finalSnap, sessionId, restartPin(plan), RESTART_PROMPT)
  console.log(`[probe] PIN EVIDENCE: ${JSON.stringify(pinEvidence, null, 2)}`)

  // Final LOCK-006/LOCK-008 request-level isolation across the WHOLE restart
  // lifecycle: the aggregate store (both extension hosts, all three server
  // instances) shows every generation request — the completed turn, any title
  // call — used e2e-local/e2e-model.
  const llmFinal = assertRunOwnedLlmRequests(scratch, "real-restart-final")

  writeFileSync(
    join(scratch, "rr-dom-evidence"),
    JSON.stringify(
      {
        url: fresh.url,
        plan,
        sessionId,
        runnerPid,
        freshRunnerPid,
        conn,
        killed,
        reconnect: rc,
        modelRequests: model.requests.map((r) => ({ url: r.url, body: r.body })),
        pins: [pinEvidence],
        llmRequests: readLlmRequests(scratch),
        llmMatrix: llmFinal,
        finalTabs: await realTabStates(rf),
        finalHeader: await headerTitle(rf),
      },
      null,
      2,
    ),
  )
  console.log("[probe] real-restart lifecycle passed")
}

/**
 * Cross-boundary evidence handed from the first VS Code process (Phases 0/A/B)
 * to the fresh process for the Phase C assertions.
 */
export interface RealRestartEvidence {
  sessionId: string
  runnerPid: number
  conn: {
    before: string
    portBefore: number | null
    pidBefore: number | null
    after: string
    portAfter: number | null
    pidAfter: number | null
    states: Array<{ state: string; at: string }>
    connectedEvents: number
  }
  killed: { pid: number; port: number }
  rc: { pid: number | null; port: number | null }
}

/**
 * Phases 0 (real completed turn), A (SSE reconnect, backend alive) and B
 * (exact-owned worker restart) against the FIRST VS Code process, returning
 * the cross-boundary evidence (session id, first-host runner pid, transport
 * observation, killed worker, replacement server) the fresh process needs for
 * Phase C. See the module docs for the per-phase assertions.
 */
export async function runRealRestartBoundaries(
  browser: Browser,
  plan: E2EPlan,
  scratch: string,
  workspace: string,
  model: ScriptedModelHandle,
): Promise<RealRestartEvidence> {
  const snap = snapshotClient(scratch, "rr-snap")
  const phase0 = await restartPhase0(browser, plan, scratch, workspace, snap, model)
  const conn = await restartPhaseA(phase0.frame, snap, scratch, plan, phase0.sessionId)
  const { killed, rc } = await restartPhaseB(
    phase0.frame,
    snap,
    scratch,
    plan,
    workspace,
    phase0.sessionId,
  )
  return { sessionId: phase0.sessionId, runnerPid: phase0.runnerPid, conn, killed, rc }
}

/**
 * Phase C of the real-restart scenario, driven by the harness in the FRESH
 * VS Code process after the reload boundary (see assertRealRestartReload).
 */
export async function assertRealRestartReload(
  browser: Browser,
  snapC: ReturnType<typeof snapshotClient>,
  scratch: string,
  plan: E2EPlan,
  workspace: string,
  evidence: RealRestartEvidence,
  model: ScriptedModelHandle,
): Promise<void> {
  await assertReloadPhase(
    browser,
    snapC,
    scratch,
    plan,
    workspace,
    evidence.sessionId,
    evidence.runnerPid,
    evidence.conn,
    evidence.killed,
    evidence.rc,
    model,
  )
}
