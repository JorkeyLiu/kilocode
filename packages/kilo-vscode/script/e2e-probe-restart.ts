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

import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Browser, Frame } from "@playwright/test"
import type { BackendSnapshot } from "../src/agent-manager/fixture-backend"
import { SCRIPTED, type ScriptedModelHandle } from "./e2e-scripted-model"
import { RESTART_ARTIFACT_CONTENT } from "./e2e-restart-seed"
import { isWrongPin, pinnedReason, pinReport, type PinExpectation } from "./e2e-pin"
import { assertRunOwnedLlmRequests, readLlmRequests } from "./e2e-llm-matrix"
import { isIsolatedDataRoot, validateGateEvidence } from "./e2e-canonical"
import {
  E2EPlan,
  expectTranscriptText,
  findAgentManagerFrameAny,
  headerTitle,
  openSidebarSession,
  pickAgent,
  pickVariant,
  realTabStates,
  requestCanonicalState,
  requestSeedCredential,
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

export function assertFixtureIdMatch(markerFid: unknown, envFid: unknown): string {
  if (typeof markerFid !== "string" || markerFid.length === 0) throw new Error("e2e-marker.json fixtureId missing")
  if (typeof envFid !== "string" || envFid.length === 0) throw new Error("KILO_E2E_FIXTURE_ID missing or empty")
  if (markerFid !== envFid) throw new Error(`e2e-marker.json fixtureId ${markerFid} != env ${envFid}`)
  return markerFid
}

/** Prompt typed into the real Agent Manager prompt input for the restart turn. */
const RESTART_PROMPT = `${SCRIPTED.restartMarker}: call the user tool and wait for the result`

/** Gate C helpers — hashes redact titles/opIds the same way the fixture does (sha256 slice 16). */
function fixtureHash(v: string): string {
  return createHash("sha256").update(v).digest("hex").slice(0, 16)
}
function newNonce(): string {
  return createHash("sha256")
    .update(String(Date.now()) + Math.random().toString(36))
    .digest("hex")
    .slice(0, 12)
}
function writeNonceRequest(
  scratch: string,
  requestName: string,
  resultName: string,
  payload: Record<string, unknown>,
): string {
  const nonce = newNonce()
  const requestPath = join(scratch, requestName)
  const resultPath = join(scratch, resultName)
  const { rmSync } = require("node:fs") as typeof import("node:fs")
  try {
    rmSync(resultPath, { force: true })
  } catch (err) {
    console.warn(`[probe] cleanup ${resultName} failed (redacted):`, String(err).slice(0, 200))
  }
  writeFileSync(requestPath, JSON.stringify({ ...payload, nonce }))
  return nonce
}
async function requestPrivateStatus(
  scratch: string,
  timeoutMs = 30_000,
): Promise<{
  nonce: string
  backend: { pid: number | null; port: number | null; epoch: number | null }
  private: {
    pid: number | null | undefined
    epoch: number | null
    available: boolean
    state: string
    protocol: { name: string; major: number; minor?: number } | null
    capabilities: string[]
    hasSessionUpdate: boolean
  }
}> {
  const nonce = writeNonceRequest(scratch, "rr-private-status-request", "rr-private-status.json", {})
  await waitForFile(join(scratch, "rr-private-status.json"), timeoutMs, "rr-private-status.json")
  const raw = readFileSync(join(scratch, "rr-private-status.json"), "utf8")
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn("[probe] malformed rr-private-status.json (redacted):", String(err).slice(0, 200))
    throw new Error("private-status malformed JSON")
  }
  if ((parsed as { nonce?: string }).nonce !== nonce) throw new Error(`private-status nonce mismatch (redacted)`)
  return parsed as unknown as {
    nonce: string
    backend: { pid: number | null; port: number | null; epoch: number | null }
    private: {
      pid: number | null | undefined
      epoch: number | null
      available: boolean
      state: string
      protocol: { name: string; major: number; minor?: number } | null
      capabilities: string[]
      hasSessionUpdate: boolean
    }
  }
}
async function requestOpenTab(
  scratch: string,
  timeoutMs = 30_000,
): Promise<{
  nonce: string
  before: {
    backend: { pid: number | null; port: number | null; epoch: number | null }
    private: { pid: number | null | undefined; epoch: number | null; hasSessionUpdate: boolean; available: boolean }
  }
  after: {
    backend: { pid: number | null; port: number | null; epoch: number | null }
    private: { pid: number | null | undefined; epoch: number | null; hasSessionUpdate: boolean; available: boolean }
  }
  openRes: { count: number; ready: boolean }
}> {
  const nonce = writeNonceRequest(scratch, "rr-open-tab-request", "rr-open-tab.json", {})
  await waitForFile(join(scratch, "rr-open-tab.json"), timeoutMs, "rr-open-tab.json")
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(join(scratch, "rr-open-tab.json"), "utf8"))
  } catch (err) {
    console.warn("[probe] malformed rr-open-tab.json (redacted):", String(err).slice(0, 200))
    throw new Error("open-tab malformed JSON")
  }
  if ((parsed as { nonce?: string }).nonce !== nonce) throw new Error(`open-tab nonce mismatch (redacted)`)
  return parsed as unknown as {
    nonce: string
    before: {
      backend: { pid: number | null; port: number | null; epoch: number | null }
      private: { pid: number | null | undefined; epoch: number | null; hasSessionUpdate: boolean; available: boolean }
    }
    after: {
      backend: { pid: number | null; port: number | null; epoch: number | null }
      private: { pid: number | null | undefined; epoch: number | null; hasSessionUpdate: boolean; available: boolean }
    }
    openRes: { count: number; ready: boolean }
  }
}
async function requestTitleUpdate(
  scratch: string,
  sessionId: string,
  title: string,
  timeoutMs = 30_000,
): Promise<{
  nonce: string
  order: string[]
  sdk: { status: string; httpStatus: number | null; hasData: boolean }
  private: { status: string; hasData: boolean; transportUnknown?: boolean } | null
  parity: { divergence: string | null }
  redacted: {
    opIdHash: string
    idempotencyKeyHash: string
    requestIdHash: string
    titleHash: string
    sessionIdHash: string
  }
  revision: { session?: number; config?: number } | null
}> {
  const nonce = writeNonceRequest(scratch, "rr-title-request", "rr-title-result.json", { sessionId, title })
  await waitForFile(join(scratch, "rr-title-result.json"), timeoutMs, "rr-title-result.json")
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(join(scratch, "rr-title-result.json"), "utf8"))
  } catch (err) {
    console.warn("[probe] malformed rr-title-result.json (redacted):", String(err).slice(0, 200))
    throw new Error("title malformed JSON")
  }
  if ((parsed as { nonce?: string }).nonce !== nonce) throw new Error(`title nonce mismatch (redacted)`)
  if (JSON.stringify(parsed).includes(title)) throw new Error(`title result leaked raw title`)
  return parsed as unknown as {
    nonce: string
    order: string[]
    sdk: { status: string; httpStatus: number | null; hasData: boolean }
    private: { status: string; hasData: boolean; transportUnknown?: boolean } | null
    parity: { divergence: string | null }
    redacted: {
      opIdHash: string
      idempotencyKeyHash: string
      requestIdHash: string
      titleHash: string
      sessionIdHash: string
    }
    revision: { session?: number; config?: number } | null
  }
}
async function requestPrivateReplay(
  scratch: string,
  sessionId: string,
  timeoutMs = 30_000,
): Promise<{
  nonce: string
  found: boolean
  private: { status: string; hasData: boolean } | null
  revision: { session?: number; config?: number } | null
  redacted?: { titleHash: string }
}> {
  const nonce = writeNonceRequest(scratch, "rr-replay-request", "rr-replay-result.json", { sessionId })
  await waitForFile(join(scratch, "rr-replay-result.json"), timeoutMs, "rr-replay-result.json")
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(join(scratch, "rr-replay-result.json"), "utf8"))
  } catch (err) {
    console.warn("[probe] malformed rr-replay-result.json (redacted):", String(err).slice(0, 200))
    throw new Error("replay malformed JSON")
  }
  if ((parsed as { nonce?: string }).nonce !== nonce) throw new Error(`replay nonce mismatch (redacted)`)
  return parsed as unknown as {
    nonce: string
    found: boolean
    private: { status: string; hasData: boolean } | null
    revision: { session?: number; config?: number } | null
    redacted?: { titleHash: string }
  }
}

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
// eslint-disable-next-line complexity
async function restartPhase0(
  browser: Browser,
  plan: E2EPlan,
  scratch: string,
  workspace: string,
  snap: ReturnType<typeof snapshotClient>,
  model: ScriptedModelHandle,
): Promise<{ sessionId: string; runnerPid: number; frame: Frame }> {
  const timeout = 30_000
  // P4.2 H-10/H-11 fresh canonical gate must be proven BEFORE the first
  // canonical-era session is created. The harness wrote canonical-gate.json
  // before launching the Extension Host; fail fast if it is missing or
  // malformed so the run cannot claim canonical post-cutover behavior.
  await waitForFile(join(scratch, "canonical-gate.json"), 30_000, "canonical gate evidence before first session")
  {
    const gateRaw = readFileSync(join(scratch, "canonical-gate.json"), "utf8")
    let gate: unknown
    try {
      gate = JSON.parse(gateRaw)
    } catch {
      throw new Error("probe: canonical gate JSON malformed")
    }
    const err = validateGateEvidence(gate)
    if (err) throw new Error(`probe: canonical gate invalid before session: ${err}`)
    // Archive before evidence must also be present (no mutation proof).
    if (!existsSync(join(scratch, "canonical-archive-before.json"))) {
      throw new Error("probe: canonical-archive-before.json missing before first session")
    }
    // Ensure the harness never targeted the user's real home: the gate's
    // dataRoot must be inside the run-owned scratch (normalized isolation helper).
    const dataRoot = (gate as Record<string, unknown>).dataRoot as string | undefined
    if (typeof dataRoot === "string" && !isIsolatedDataRoot(scratch, dataRoot)) {
      throw new Error(`probe: canonical dataRoot not isolated inside scratch: ${dataRoot}`)
    }
    // Require at least one canonical archive before the first session — the fresh
    // canonical DB proof must precede the first canonical-era session.
    {
      const beforeRaw = readFileSync(join(scratch, "canonical-archive-before.json"), "utf8")
      let before: unknown
      try {
        before = JSON.parse(beforeRaw)
      } catch {
        throw new Error("probe: canonical-archive-before.json malformed")
      }
      const count = (before as { archiveCount?: unknown }).archiveCount
      if (typeof count !== "number" || count < 1) {
        throw new Error(
          `probe: canonical archive count before is 0 — fresh canonical DB and at least one archive must exist before the Extension Host creates the canonical-era session (archiveCount=${String(count)})`,
        )
      }
    }
    console.log("[probe] PASS fresh canonical identity/zero-state gate before first session")
  }
  await waitForFile(join(scratch, "rr-ready"), 120_000, "rr-ready marker")
  // Credential provisioning evidence (real SecretStorage, no bypass): the
  // runner seeded the project provider credential before writing rr-ready.
  // Verify the pre-existing evidence without exposing the secret value, then
  // exercise a fresh marker round-trip for coverage.
  {
    const credFile = join(scratch, "rr-credential.json")
    await waitForFile(credFile, timeout, "rr-credential.json (credential provisioning evidence)")
    const cred = JSON.parse(readFileSync(credFile, "utf8")) as Record<string, unknown>
    console.log(`[probe] credential provisioning (pre-rr-ready): ${JSON.stringify(cred)}`)
    if (cred.ok !== true)
      throw new Error(`probe: credential provisioning failed before rr-ready: ${JSON.stringify(cred)}`)
    const connected = (cred as { connected?: unknown }).connected
    if (!Array.isArray(connected) || !connected.includes(plan.customProvider)) {
      throw new Error(`probe: credential evidence missing connected ${plan.customProvider}: ${JSON.stringify(cred)}`)
    }
    if ((cred as { defaultModel?: unknown }).defaultModel !== `${plan.customProvider}/${plan.customModel}`) {
      throw new Error(`probe: credential evidence wrong defaultModel: ${JSON.stringify(cred)}`)
    }
  }
  {
    const fresh = await requestSeedCredential(scratch, timeout)
    console.log(`[probe] credential seeding round-trip: ${JSON.stringify(fresh)}`)
    if (fresh.ok !== true) throw new Error(`probe: credential round-trip failed: ${JSON.stringify(fresh)}`)
  }
  const found = await findAgentManagerFrameAny(browser, 60_000)
  const frame = found.frame

  // Canonical-state probe BEFORE the agent-list assertion: captures the
  // runtime CanonicalConfigService snapshot (readiness, stamp, last error,
  // asset scan summary, selector index sizes/ids) into rr-cstate.json so the
  // dark span between materializeFromDisk completion and webview acceptance is
  // self-diagnosing — H1 (readiness never opened) vs H2 (ready but empty
  // index) becomes decidable from run evidence instead of inference.
  const cstate = await requestCanonicalState(scratch, timeout)
  console.log(`[probe] canonical state: ${JSON.stringify(cstate)}`)
  {
    const prov = (
      cstate as {
        providerIndex?: { connected?: unknown; entries?: Array<{ id: string; hasCredential: boolean }> } | null
      }
    ).providerIndex
    if (!prov || !Array.isArray(prov.connected) || !prov.connected.includes(plan.customProvider)) {
      throw new Error(`probe: canonical state missing connected ${plan.customProvider}: ${JSON.stringify(cstate)}`)
    }
    const entry = prov.entries?.find((e) => e.id === plan.customProvider)
    if (!entry?.hasCredential)
      throw new Error(
        `probe: canonical state hasCredential false for ${plan.customProvider}: ${JSON.stringify(cstate)}`,
      )
    const expectedModel = `${plan.customProvider}/${plan.customModel}`
    if ((cstate as { defaultModel?: unknown }).defaultModel !== expectedModel) {
      throw new Error(
        `probe: canonical state wrong defaultModel: expected ${expectedModel}, got ${JSON.stringify(cstate)}`,
      )
    }
    if ((cstate as { materializationReady?: unknown }).materializationReady !== true) {
      throw new Error(`probe: canonical state not ready: ${JSON.stringify(cstate)}`)
    }
  }

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
  epochBefore: number | null
  after: string
  portAfter: number | null
  pidAfter: number | null
  epochAfter: number | null
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
    epochBefore: number | null
    after: string
    portAfter: number | null
    pidAfter: number | null
    epochAfter: number | null
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
): Promise<{
  killed: { pid: number; port: number; epoch: number | null }
  rc: { pid: number | null; port: number | null; epoch: number | null }
}> {
  writeFileSync(join(scratch, "rr-kill-request"), "ok")
  await waitForFile(join(scratch, "rr-kill.json"), 60_000, "rr-kill.json")
  const killed = JSON.parse(readFileSync(join(scratch, "rr-kill.json"), "utf8")) as {
    pid: number
    port: number
    epoch: number | null
  }
  if (!killed.pid || !killed.port) {
    throw new Error(`probe: worker kill recorded no exact pid/port: ${JSON.stringify(killed)}`)
  }
  console.log(`[probe] killed exact worker: pid=${killed.pid} port=${killed.port} epoch=${killed.epoch}`)
  await sleep(1_000) // let the exit event settle in the extension host
  writeFileSync(join(scratch, "rr-reconnect-request"), "ok")
  await waitForFile(join(scratch, "rr-reconnect.json"), 180_000, "rr-reconnect.json")
  const rc = JSON.parse(readFileSync(join(scratch, "rr-reconnect.json"), "utf8")) as {
    state: string
    port: number | null
    pid: number | null
    epoch: number | null
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
  console.log(
    `[probe] PASS exact worker restart: old pid=${killed.pid} port=${killed.port} → new pid=${rc.pid} port=${rc.port}`,
  )

  await snap.waitFor(
    (s) => restartSessionReason(s, sessionId, plan, RESTART_PROMPT),
    60_000,
    "session transcript rehydrated after exact worker restart",
  )
  await waitForFileBytes(
    join(workspace, plan.realArtifact),
    RESTART_ARTIFACT_CONTENT,
    30_000,
    "artifact rehydrated after exact worker restart",
  )
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
  killed: { pid: number; port: number; epoch: number | null },
  rc: { pid: number | null; port: number | null; epoch: number | null },
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
  await waitForFileBytes(
    join(workspace, plan.realArtifact),
    RESTART_ARTIFACT_CONTENT,
    30_000,
    "artifact persists after true window restart",
  )
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
    epochBefore: number | null
    after: string
    portAfter: number | null
    pidAfter: number | null
    epochAfter: number | null
    states: Array<{ state: string; at: string }>
    connectedEvents: number
  }
  killed: { pid: number; port: number; epoch: number | null }
  rc: { pid: number | null; port: number | null; epoch: number | null }
}

/**
 * Phases 0 (real completed turn), A (SSE reconnect, backend alive) and B
 * (exact-owned worker restart) against the FIRST VS Code process, returning
 * the cross-boundary evidence (session id, first-host runner pid, transport
 * observation, killed worker, replacement server) the fresh process needs for
 * Phase C. See the module docs for the per-phase assertions.
 */
// eslint-disable-next-line complexity
export async function runRealRestartBoundaries(
  browser: Browser,
  plan: E2EPlan,
  scratch: string,
  workspace: string,
  model: ScriptedModelHandle,
): Promise<RealRestartEvidence> {
  const snap = snapshotClient(scratch, "rr-snap")
  const phase0 = await restartPhase0(browser, plan, scratch, workspace, snap, model)

  // ── Gate C preparation: shared-backend identity (Agent Manager + editor tab) ──
  const gcTitle = `GateC Title ${createHash("sha256").update(phase0.sessionId).digest("hex").slice(0, 6)}`
  // Hoisted for consolidated proof
  let gcPre: Awaited<ReturnType<typeof requestPrivateStatus>> | null = null
  let gcOpen: Awaited<ReturnType<typeof requestOpenTab>> | null = null
  let gcTitleRes: Awaited<ReturnType<typeof requestTitleUpdate>> | null = null
  let gcReplay: Awaited<ReturnType<typeof requestPrivateReplay>> | null = null
  let gcPreA: Awaited<ReturnType<typeof requestPrivateStatus>> | null = null
  let gcPostA: Awaited<ReturnType<typeof requestPrivateStatus>> | null = null
  let gcPreB: Awaited<ReturnType<typeof requestPrivateStatus>> | null = null
  let gcPostB: Awaited<ReturnType<typeof requestPrivateStatus>> | null = null
  let gcReplay2: Awaited<ReturnType<typeof requestPrivateReplay>> | null = null
  {
    const pre = await requestPrivateStatus(scratch)
    gcPre = pre
    if (!pre.private.available)
      throw new Error(`Gate C: private peer not available before openTab: ${JSON.stringify(pre)}`)
    if (!pre.private.hasSessionUpdate)
      throw new Error(`Gate C: missing session/update capability before openTab: ${JSON.stringify(pre)}`)
    if (!pre.private.protocol || pre.private.protocol.name !== "kilo-private" || pre.private.protocol.major !== 1)
      throw new Error(`Gate C: protocol not kilo-private/1 before openTab: ${JSON.stringify(pre.private.protocol)}`)
    if (!pre.backend.pid || !pre.backend.port || !pre.backend.epoch)
      throw new Error(`Gate C: backend pid/port/epoch missing before openTab: ${JSON.stringify(pre.backend)}`)
    if (pre.private.pid !== pre.backend.pid)
      throw new Error(`Gate C: private pid ${pre.private.pid} != backend pid ${pre.backend.pid} before openTab`)
    if (pre.private.epoch !== pre.backend.epoch)
      throw new Error(`Gate C: private epoch ${pre.private.epoch} != backend epoch ${pre.backend.epoch} before openTab`)
    const open = await requestOpenTab(scratch)
    gcOpen = open
    if (!open.openRes.ready) throw new Error(`Gate C: openInTab not ready: ${JSON.stringify(open.openRes)}`)
    // both surfaces must share same backend identity — no second backend spawned
    if (open.before.backend.pid !== pre.backend.pid || open.after.backend.pid !== pre.backend.pid)
      throw new Error(
        `Gate C: openTab changed backend pid before ${pre.backend.pid} -> after ${open.after.backend.pid}`,
      )
    if (open.before.backend.port !== pre.backend.port || open.after.backend.port !== pre.backend.port)
      throw new Error(`Gate C: openTab changed backend port`)
    if (open.before.backend.epoch !== pre.backend.epoch || open.after.backend.epoch !== pre.backend.epoch)
      throw new Error(`Gate C: openTab changed backend epoch`)
    if (!open.after.private.hasSessionUpdate) throw new Error(`Gate C: session/update capability lost after openTab`)
    if (open.after.backend.pid !== open.after.private.pid)
      throw new Error(
        `Gate C: after openTab private pid ${open.after.private.pid} != backend pid ${open.after.backend.pid}`,
      )
    if (open.after.backend.epoch !== open.after.private.epoch)
      throw new Error(`Gate C: after openTab private epoch mismatch`)
    if (open.before.backend.pid !== open.before.private.pid)
      throw new Error(`Gate C: before openTab private pid mismatch`)
    console.log(
      `[probe] PASS Gate C shared backend identity: pid=${pre.backend.pid} port=${pre.backend.port} epoch=${pre.backend.epoch} capabilities=${pre.private.capabilities.join(",")}`,
    )
    writeFileSync(join(scratch, "rr-gc-open-tab.json"), JSON.stringify({ pre, open }, null, 2))
  }

  // ── Gate C: durable title mutation via SDK authoritative + private replay ──
  let gcRevision: { session?: number; config?: number } | null = null
  {
    const titleRes = await requestTitleUpdate(scratch, phase0.sessionId, gcTitle)
    gcTitleRes = titleRes
    if (titleRes.order[0] !== "sdk" || titleRes.order[1] !== "private")
      throw new Error(`Gate C: title update order not SDK then private: ${JSON.stringify(titleRes.order)}`)
    if (titleRes.sdk.status !== "succeeded" || !titleRes.sdk.hasData)
      throw new Error(`Gate C: SDK title update failed: ${JSON.stringify(titleRes.sdk)}`)
    if (!titleRes.private || titleRes.private.status !== "succeeded" || !titleRes.private.hasData)
      throw new Error(`Gate C: private replay failed: ${JSON.stringify(titleRes.private)}`)
    if (titleRes.parity.divergence)
      throw new Error(`Gate C: title parity divergence: ${JSON.stringify(titleRes.parity)}`)
    if (titleRes.redacted.titleHash !== fixtureHash(gcTitle))
      throw new Error(`Gate C: title hash mismatch ${titleRes.redacted.titleHash} vs ${fixtureHash(gcTitle)}`)
    if (titleRes.redacted.sessionIdHash !== fixtureHash(phase0.sessionId))
      throw new Error(`Gate C: sessionId hash mismatch`)
    gcRevision = titleRes.revision
    console.log(
      `[probe] PASS Gate C durable title SDK+private: titleHash=${titleRes.redacted.titleHash} revision=${JSON.stringify(gcRevision)}`,
    )
    if (JSON.stringify(titleRes).includes(gcTitle)) throw new Error(`Gate C: titleRes leaked raw title`)
    writeFileSync(
      join(scratch, "rr-gc-title.json"),
      JSON.stringify({ titleHash: fixtureHash(gcTitle), res: titleRes }, null, 2),
    )
    // verify backend snapshot title persisted
    await snap.waitFor(
      (s) => {
        const t = s.sessions.find((x) => x.id === phase0.sessionId)?.title
        if (t !== gcTitle) return `session title ${t} != ${gcTitle}`
        return undefined
      },
      30_000,
      "backend snapshot title after SDK PATCH",
    )
    // same-key private replay without second mutation
    const replay = await requestPrivateReplay(scratch, phase0.sessionId)
    gcReplay = replay
    if (!replay.found || !replay.private || replay.private.status !== "succeeded" || !replay.private.hasData)
      throw new Error(`Gate C: private same-key replay failed: ${JSON.stringify(replay)}`)
    if (replay.redacted?.titleHash !== fixtureHash(gcTitle)) throw new Error(`Gate C: replay title hash mismatch`)
    // revision must be same as initial titleRes revision (no second mutation)
    const revEqual = JSON.stringify(replay.revision) === JSON.stringify(gcRevision)
    if (!revEqual)
      throw new Error(
        `Gate C: replay revision changed ${JSON.stringify(gcRevision)} -> ${JSON.stringify(replay.revision)}`,
      )
    console.log(`[probe] PASS Gate C same-key private replay revision unchanged`)
    writeFileSync(join(scratch, "rr-gc-replay.json"), JSON.stringify(replay, null, 2))
  }

  const preAStatus = await requestPrivateStatus(scratch)
  gcPreA = preAStatus
  if (preAStatus.private.pid !== preAStatus.backend.pid) throw new Error(`Gate C preA private pid mismatch`)
  if (preAStatus.private.epoch !== preAStatus.backend.epoch) throw new Error(`Gate C preA private epoch mismatch`)
  const conn = await restartPhaseA(phase0.frame, snap, scratch, plan, phase0.sessionId)
  {
    const postA = await requestPrivateStatus(scratch)
    gcPostA = postA
    if (postA.backend.pid !== preAStatus.backend.pid)
      throw new Error(
        `Gate C Phase A: backend pid changed on SSE reconnect before ${preAStatus.backend.pid} after ${postA.backend.pid}`,
      )
    if (postA.backend.port !== preAStatus.backend.port)
      throw new Error(`Gate C Phase A: backend port changed on SSE reconnect`)
    if (postA.backend.epoch !== preAStatus.backend.epoch)
      throw new Error(
        `Gate C Phase A: backend epoch changed on SSE reconnect before ${preAStatus.backend.epoch} after ${postA.backend.epoch}`,
      )
    if (postA.private.pid !== postA.backend.pid)
      throw new Error(`Gate C Phase A: postA private pid ${postA.private.pid} != backend pid ${postA.backend.pid}`)
    if (postA.private.epoch !== postA.backend.epoch) throw new Error(`Gate C Phase A: postA private epoch mismatch`)
    if (conn.pidBefore !== preAStatus.backend.pid || conn.pidAfter !== preAStatus.backend.pid)
      throw new Error(`Gate C Phase A: conn pid mismatch`)
    if (conn.epochBefore !== preAStatus.backend.epoch || conn.epochAfter !== preAStatus.backend.epoch)
      throw new Error(
        `Gate C Phase A: conn epoch mismatch before ${preAStatus.backend.epoch} vs ${conn.epochBefore}/${conn.epochAfter}`,
      )
    if (!postA.private.hasSessionUpdate)
      throw new Error(`Gate C Phase A: session/update capability lost after SSE reconnect`)
    if (!postA.private.available) throw new Error(`Gate C Phase A: private unavailable after SSE reconnect`)
    if (!postA.private.protocol || postA.private.protocol.major !== 1)
      throw new Error(`Gate C Phase A: protocol lost after reconnect`)
    console.log(
      `[probe] PASS Gate C SSE reconnect same identity epoch ${preAStatus.backend.epoch} private capability preserved`,
    )
    writeFileSync(join(scratch, "rr-gc-sse-private.json"), JSON.stringify({ preAStatus, postA, conn }, null, 2))
  }

  const preBStatus = await requestPrivateStatus(scratch)
  gcPreB = preBStatus
  if (preBStatus.private.pid !== preBStatus.backend.pid) throw new Error(`Gate C preB private pid mismatch`)
  if (preBStatus.private.epoch !== preBStatus.backend.epoch) throw new Error(`Gate C preB private epoch mismatch`)
  const { killed, rc } = await restartPhaseB(phase0.frame, snap, scratch, plan, workspace, phase0.sessionId)
  {
    const postB = await requestPrivateStatus(scratch)
    gcPostB = postB
    if (killed.epoch !== preBStatus.backend.epoch)
      throw new Error(
        `Gate C Phase B: killed epoch ${killed.epoch} != pre-kill backend epoch ${preBStatus.backend.epoch}`,
      )
    if (postB.backend.pid === preBStatus.backend.pid)
      throw new Error(
        `Gate C Phase B: backend pid not changed after kill before ${preBStatus.backend.pid} after ${postB.backend.pid}`,
      )
    if (!postB.backend.pid || postB.backend.pid === killed.pid)
      throw new Error(`Gate C Phase B: new backend pid invalid ${postB.backend.pid} killed ${killed.pid}`)
    if (!postB.backend.port || postB.backend.port === killed.port)
      throw new Error(`Gate C Phase B: new backend port invalid`)
    if (!postB.backend.epoch || !preBStatus.backend.epoch || postB.backend.epoch <= preBStatus.backend.epoch)
      throw new Error(
        `Gate C Phase B: new epoch not strictly greater before ${preBStatus.backend.epoch} after ${postB.backend.epoch}`,
      )
    if (postB.private.pid !== postB.backend.pid)
      throw new Error(`Gate C Phase B: postB private pid ${postB.private.pid} != backend pid ${postB.backend.pid}`)
    if (postB.private.epoch !== postB.backend.epoch) throw new Error(`Gate C Phase B: postB private epoch mismatch`)
    if (rc.pid !== postB.backend.pid || rc.port !== postB.backend.port || rc.epoch !== postB.backend.epoch)
      throw new Error(
        `Gate C Phase B: reconnect json mismatch ${JSON.stringify(rc)} vs ${JSON.stringify(postB.backend)}`,
      )
    if (!postB.private.available || !postB.private.hasSessionUpdate)
      throw new Error(
        `Gate C Phase B: private peer not re-established with session/update after restart: ${JSON.stringify(postB.private)}`,
      )
    if (!postB.private.protocol || postB.private.protocol.name !== "kilo-private" || postB.private.protocol.major !== 1)
      throw new Error(`Gate C Phase B: protocol not kilo-private/1 after restart`)
    console.log(
      `[probe] PASS Gate C worker restart new identity pid ${preBStatus.backend.pid}->${postB.backend.pid} epoch ${preBStatus.backend.epoch}->${postB.backend.epoch} private re-established`,
    )
    // durable title persists in backend snapshot after restart
    await snap.waitFor(
      (s) => {
        const t = s.sessions.find((x) => x.id === phase0.sessionId)?.title
        if (t !== gcTitle) return `session title after restart ${t} != ${gcTitle}`
        return undefined
      },
      30_000,
      "backend snapshot title persists after worker restart",
    )
    // same-key private replay after restart returns same persisted revision without second mutation
    const replay2 = await requestPrivateReplay(scratch, phase0.sessionId)
    gcReplay2 = replay2
    if (!replay2.found || replay2.private?.status !== "succeeded" || !replay2.private?.hasData)
      throw new Error(`Gate C Phase B: post-restart private replay failed: ${JSON.stringify(replay2)}`)
    if (JSON.stringify(replay2.revision) !== JSON.stringify(gcRevision))
      throw new Error(
        `Gate C Phase B: post-restart replay revision changed ${JSON.stringify(gcRevision)} -> ${JSON.stringify(replay2.revision)}`,
      )
    console.log(`[probe] PASS Gate C durable title persists and private replay revision unchanged after restart`)
    writeFileSync(
      join(scratch, "rr-gc-restart-private.json"),
      JSON.stringify({ preBStatus, postB, replay2, gcRevision }, null, 2),
    )
  }
  // ── Consolidated redacted Gate C proof (required for real-restart evidence) ──
  // Fail-closed: marker must exist, parse, and match env fixtureId; hash only that exact ID.
  {
    const markerRaw = readFileSync(join(scratch, "e2e-marker.json"), "utf8")
    if (markerRaw.length > 2048) throw new Error("e2e-marker.json too large")
    const markerParsed = JSON.parse(markerRaw) as Record<string, unknown>
    if (markerParsed.v !== 1) throw new Error(`e2e-marker.json v must be 1, got ${String(markerParsed.v)}`)
    const fid = markerParsed.fixtureId
    if (typeof fid !== "string" || fid.length === 0) throw new Error("e2e-marker.json fixtureId missing")
    const envFid = process.env.KILO_E2E_FIXTURE_ID
    if (typeof envFid !== "string" || envFid.length === 0) throw new Error("KILO_E2E_FIXTURE_ID missing or empty")
    if (fid !== envFid) throw new Error(`e2e-marker.json fixtureId ${fid} != env ${envFid}`)
    // lstat symlink check (fail-closed)
    const { lstatSync, realpathSync } = require("node:fs") as typeof import("node:fs")
    const { basename } = require("node:path") as typeof import("node:path")
    const markerPath = join(scratch, "e2e-marker.json")
    const scratchStat = lstatSync(scratch)
    if (!scratchStat.isDirectory() || scratchStat.isSymbolicLink()) throw new Error("scratch is symlink or not dir")
    const markerStat = lstatSync(markerPath)
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error("marker is symlink or not file")
    const realScratch = realpathSync(scratch)
    const realMarker = realpathSync(markerPath)
    const { relative } = require("node:path") as typeof import("node:path")
    const rel = relative(realScratch, realMarker)
    if (rel !== "e2e-marker.json") throw new Error(`marker not inside scratch: ${rel}`)
    if (!basename(scratch).startsWith("kilo-e2e-")) throw new Error("scratch basename not kilo-e2e-")
    const fixtureIdForHash = createHash("sha256").update(fid).digest("hex").slice(0, 16)
    const proof = {
      schema: "kilo-gc-proof/1",
      version: 1,
      scope:
        "real-restart Gate C: shared-backend + SDK-authoritative title + SSE same-epoch + worker-restart new-epoch",
      fixtureIdHash: fixtureIdForHash,
      sessionIdHash: fixtureHash(phase0.sessionId),
      titleHash: fixtureHash(gcTitle),
      pre: gcPre
        ? {
            backend: { pid: gcPre.backend.pid, port: gcPre.backend.port, epoch: gcPre.backend.epoch },
            private: {
              pid: gcPre.private.pid ?? null,
              epoch: gcPre.private.epoch,
              available: gcPre.private.available,
              state: gcPre.private.state,
              protocol: gcPre.private.protocol
                ? { name: gcPre.private.protocol.name, major: gcPre.private.protocol.major }
                : null,
              capabilities: gcPre.private.capabilities,
              hasSessionUpdate: gcPre.private.hasSessionUpdate,
            },
          }
        : null,
      openTab: gcOpen
        ? {
            before: { backend: gcOpen.before.backend, private: gcOpen.before.private },
            after: { backend: gcOpen.after.backend, private: gcOpen.after.private },
            ready: gcOpen.openRes.ready,
            count: gcOpen.openRes.count,
          }
        : null,
      sse: {
        pre: gcPreA
          ? {
              backend: gcPreA.backend,
              private: {
                pid: gcPreA.private.pid ?? null,
                epoch: gcPreA.private.epoch,
                available: gcPreA.private.available,
                hasSessionUpdate: gcPreA.private.hasSessionUpdate,
                protocol: gcPreA.private.protocol
                  ? { name: gcPreA.private.protocol.name, major: gcPreA.private.protocol.major }
                  : null,
              },
            }
          : null,
        conn: {
          before: {
            pid: (conn as unknown as Record<string, unknown>).pidBefore,
            port: (conn as unknown as Record<string, unknown>).portBefore,
            epoch: (conn as unknown as Record<string, unknown>).epochBefore,
          },
          after: {
            pid: (conn as unknown as Record<string, unknown>).pidAfter,
            port: (conn as unknown as Record<string, unknown>).portAfter,
            epoch: (conn as unknown as Record<string, unknown>).epochAfter,
          },
          states: (conn as unknown as { states: unknown }).states,
          connectedEvents: (conn as unknown as { connectedEvents: number }).connectedEvents,
        },
        post: gcPostA
          ? {
              backend: gcPostA.backend,
              private: {
                pid: gcPostA.private.pid ?? null,
                epoch: gcPostA.private.epoch,
                available: gcPostA.private.available,
                hasSessionUpdate: gcPostA.private.hasSessionUpdate,
                protocol: gcPostA.private.protocol
                  ? { name: gcPostA.private.protocol.name, major: gcPostA.private.protocol.major }
                  : null,
              },
            }
          : null,
      },
      titleOp: gcTitleRes
        ? {
            opIdHash: gcTitleRes.redacted.opIdHash,
            idempotencyKeyHash: gcTitleRes.redacted.idempotencyKeyHash,
            requestIdHash: gcTitleRes.redacted.requestIdHash,
            sessionIdHash: gcTitleRes.redacted.sessionIdHash,
            titleHash: gcTitleRes.redacted.titleHash,
            order: gcTitleRes.order,
            sdk: {
              status: gcTitleRes.sdk.status,
              httpStatus: gcTitleRes.sdk.httpStatus,
              hasData: gcTitleRes.sdk.hasData,
            },
            private: gcTitleRes.private
              ? {
                  status: gcTitleRes.private.status,
                  hasData: gcTitleRes.private.hasData,
                  transportUnknown: (gcTitleRes.private as Record<string, unknown>).transportUnknown,
                }
              : null,
            parity: gcTitleRes.parity,
            revision: gcTitleRes.revision,
          }
        : null,
      replay: gcReplay
        ? {
            found: gcReplay.found,
            private: gcReplay.private,
            revision: gcReplay.revision,
            titleHash: gcReplay.redacted?.titleHash,
          }
        : null,
      killed: {
        pid: (killed as unknown as Record<string, unknown>).pid,
        port: (killed as unknown as Record<string, unknown>).port,
        epoch: (killed as unknown as Record<string, unknown>).epoch,
      },
      postRestart: gcPostB
        ? {
            backend: gcPostB.backend,
            private: {
              pid: gcPostB.private.pid ?? null,
              epoch: gcPostB.private.epoch,
              available: gcPostB.private.available,
              hasSessionUpdate: gcPostB.private.hasSessionUpdate,
              protocol: gcPostB.private.protocol
                ? { name: gcPostB.private.protocol.name, major: gcPostB.private.protocol.major }
                : null,
              state: gcPostB.private.state,
              capabilities: gcPostB.private.capabilities,
            },
          }
        : null,
      replayAfterRestart: gcReplay2
        ? {
            found: gcReplay2.found,
            private: gcReplay2.private,
            revision: gcReplay2.revision,
            titleHash: gcReplay2.redacted?.titleHash,
          }
        : null,
      parity: gcTitleRes?.parity ?? null,
      collectedAt: new Date().toISOString(),
    }
    // No raw title, no path, no secret, no raw error — all hashes
    const proofRaw = JSON.stringify(proof, null, 2)
    if (proofRaw.includes(gcTitle)) throw new Error("proof leaked raw title")
    writeFileSync(join(scratch, "rr-gc-proof.json"), proofRaw)
    console.log(`[probe] wrote rr-gc-proof.json schema=${proof.schema} fixtureIdHash=${fixtureIdForHash}`)
  }
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
