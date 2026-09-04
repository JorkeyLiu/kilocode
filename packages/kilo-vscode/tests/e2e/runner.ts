/* eslint-disable max-lines */
/**
 * Extension Host E2E runner — child task open tab-order case, active-tab close
 * successor case, in-session per-agent variant memory case, and derived Topic
 * navigation lifecycle-convergence case.
 *
 * Loaded by VS Code through `--extensionTestsPath` (bundled to CJS by
 * script/e2e-probe.ts). Runs inside a real Extension Host alongside the
 * current workspace extension and:
 *
 *   1. activates the extension,
 *   2. opens the Agent Manager webview via the real `kilo-code.new.agentManagerOpen`
 *      command,
 *   3. waits for panel readiness through the env-gated fixture bridge,
 *   4. seeds a deterministic offline scenario using production message shapes
 *      and the production `SessionInfo` type:
 *        - tab-close scenario: three session tabs [TA, TB, TC] in a known
 *          order with TA active (no transcripts needed — the close button acts
 *          on any session tab),
 *        - source session A + sibling session B as the only initial tabs,
 *        - child session C known to the backend store but NOT opened as a tab,
 *        - A's transcript contains a production `task` tool part whose metadata
 *          points at C (renders the real sub-agent link in the Agent Manager),
 *   5. calls the fixture bridge's `settleSessions` handshake: the extension
 *      awaits the real backend session-list refresh (including any deferred
 *      refresh flushed when the CLI connection comes up), then re-seeds a
 *      full `sessionsLoaded` with `preserveSessionIds`. Because session-list
 *      loads are serialized and this re-seed is posted last, no later refresh
 *      can reconcile the fixture sessions away — the fixture survival is
 *      deterministic, with no timer polling or provider/network dependence,
 *   6. writes `<scratch>/ready` + `<scratch>/plan.json`, then blocks until the
 *      harness (Playwright over CDP) asserts the scenario. The tab-close
 *      scenario runs first in the `all` composition and closes all its own
 *      tabs before finishing, handing the child scenario the startup state
 *      (one pending tab + bottom page) its seeding already expects,
 *   7. child phases: the harness asserts [A, B], clicks the real
 *      "Open sub-agent in tab" button in source's chat, verifies the child
 *      lands immediately right of A; on `child-phase1-done` re-selects A so
 *      the harness can re-click and prove an already-open child is focused
 *      WITHOUT reordering, then writes `child-phase2-ready`,
  *   8. on `child-phase2-done` seeds the variant scenario: opens variant
  *      session D, loads a transcript pinning `kilo/e2e-probe` (synthetic
  *      explicit-provider fixture, LOCK-006 explicit-config-only, no preset
  *      catalog/models.dev), calls `provisionVariantModel` LAST so the synthetic
  *      explicit-provider providersLoaded stays the final provider message,
  *      re-seeds the session list so D survives, then writes `variant-ready`,
 *   9. topic-navigation scenario (focused runs only, see below): seeds a
 *      parentID hierarchy — root T1, child T1C (parentID=T1), sibling root T2 —
 *      through production message shapes, then hands the harness three
 *      lifecycle boundaries to assert against the real webview: session
 *      navigation (Topic/child clicks), panel close/reopen (the runner closes
 *      the Agent Manager editor tab, reopens it, and rehydrates the fixture
 *      state), and webview reload (the harness reloads the Agent Manager OOPIF
 *      frame, re-finds it, and the runner rehydrates again),
 *  10. exits when the harness writes `<scratch>/done`, so VS Code exits 0.
 *
 * Scenario selection (KILO_E2E_SCENARIO, set by the harness):
 *   - (unset) | all      => tab-close, then child-task-order, then
 *                           variant-memory, sequentially, in this one VS Code
 *                           lifecycle (the delivery gate — deliberately NOT
 *                           extended with topic-navigation: that scenario
 *                           closes/reopens the Agent Manager panel mid-run,
 *                           which would dispose the tab state the other
 *                           scenarios coordinate on, so it stays a focused
 *                           run with its own lifecycle),
 *   - tab-close          => seeds only the tab-close fixtures (TA, TB, TC) and
 *                           runs only that scenario,
 *   - child-task-order   => seeds only the child fixtures (A, B, C) and runs
 *                           only the child phases,
 *   - variant-memory     => seeds only the variant fixture (D) and skips the
 *                           other scenarios entirely.
 *   - topic-navigation   => seeds only the topic fixtures (T1, T1C, T2) and
 *                           runs the topic lifecycle-convergence phases.
 *   - real-session       => no synthetic fixtures: the harness drives the real
 *                           Agent Manager webview to create/prompt REAL backend
 *                           sessions through the production message path. This
 *                           runner loop services the backendSnapshot truth
 *                           markers and the panel close/reopen boundary.
 *   - real-completed     => no synthetic fixtures either: the harness drives
 *                           COMPLETED turns through the real webview against a
 *                           run-owned scripted OpenAI-compatible provider. This
 *                           runner loop services the snapshot truth markers,
 *                           the panel close/reopen boundary (H-7), the MCP
 *                           disconnect through the real SDK (H-5 cleanup), and
 *                           the H-12 rollback phase (Revert-to-here / Redo All
 *                           on the same served session after the reopen).
 *   - worktree-removal   => P3.2 focused scenario: the extension host asserts
 *                           the loaded manifest + runtime command table expose
 *                           no managed worktree or custom Diff Viewer surface,
 *                           seeds two root-local sessions A + B through the
 *                           production session-open path (no worktree
 *                           dimension), and proves no worktree state is created
 *                           in the run-owned workspace; this runner loop then
 *                           services the bounded H-12 rollback snapshot markers
 *                           (`p32-snap-N`) against the shared served backend.
 *   Scenarios are independent: each seeds only its own fixtures and coordinates
 *   through scenario-specific markers (tab-close-done, child-phase1-done /
 *   child-phase2-ready / child-phase2-done, variant-ready, topic-nav-done /
 *   topic-reopen-ready / topic-reopen-done / topic-reload-frame /
 *   topic-reload-ready / topic-reload-done, real-ready / real-snap-N-request /
 *   real-snap-N.json / real-reopen-request / real-reopen-ready,
 *   real-completed-ready / rc-snap-N-request / rc-snap-N.json /
 *   real-completed-reopen-request / real-completed-reopen-ready /
 *   real-completed-mcp-disconnect-request / real-completed-mcp-disconnect-done,
 *   worktree-removal-ready / p32-snap-N-request / p32-snap-N.json).
 *   `ready`, `done`, `runner-done` are process-level harness gates, not scenario
 *   state.
 *
 * All seeding goes through the env-gated fixture bridge (KILO_E2E_FIXTURE only)
 * and the production Agent Manager message/rendering/tab logic. No ordering
 * logic and no click handler is replaced.
 */

import * as vscode from "vscode"
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  CREDENTIAL_FAILED,
  credentialFailed,
  drop,
  load,
  parsePrivateStatus,
  parseReplay,
  parseTitle,
} from "../../src/util/marker"
import type { Message, SessionInfo } from "../../webview-ui/src/types/messages/sessions"
import type { ToolPart } from "../../webview-ui/src/types/messages/parts"
import type {
  MessagesLoadedMessage,
  SessionCreatedMessage,
  SessionsLoadedMessage,
} from "../../webview-ui/src/types/messages/extension-messages"

const EXTENSION_ID = "kilocode.kilo-code"
const CMD_OPEN = "kilo-code.new.agentManagerOpen"
const CMD_READY = "kilo-code.new.e2eFixture.agentManagerReady"
const CMD_POST = "kilo-code.new.e2eFixture.postToAgentManager"
const CMD_SETTLE = "kilo-code.new.e2eFixture.settleSessions"
const CMD_PROVISION = "kilo-code.new.e2eFixture.provisionVariantModel"
const CMD_SNAPSHOT = "kilo-code.new.e2eFixture.backendSnapshot"
const CMD_CANONICAL_STATE = "kilo-code.new.e2eFixture.canonicalState"
const CMD_MCP_DISCONNECT = "kilo-code.new.e2eFixture.mcpDisconnect"
const CMD_SSE_RECONNECT = "kilo-code.new.e2eFixture.sseReconnect"
const CMD_KILL_SERVER = "kilo-code.new.e2eFixture.killServer"
const CMD_RECONNECT_SERVER = "kilo-code.new.e2eFixture.reconnectServer"
const CMD_SEED_CREDENTIAL = "kilo-code.new.e2eFixture.seedCredential"
const CMD_LLM_REQUESTS = "kilo-code.new.e2eFixture.llmRequests"
const CMD_LLM_RESET = "kilo-code.new.e2eFixture.llmRequestsReset"
const CMD_ABORT_ATTEMPTS = "kilo-code.new.e2eFixture.abortAttempts"
const CMD_ABORT_RESET = "kilo-code.new.e2eFixture.abortAttemptsReset"
const CMD_PRIVATE_PEER_STATUS = "kilo-code.new.e2eFixture.privatePeerStatus"
const CMD_SESSION_UPDATE = "kilo-code.new.e2eFixture.sessionUpdate"
const CMD_PRIVATE_REPLAY = "kilo-code.new.e2eFixture.privateReplay"
const CMD_SSE_TIMELINE_START = "kilo-code.new.e2eFixture.sseTimelineStart"
const CMD_SSE_TIMELINE_STOP = "kilo-code.new.e2eFixture.sseTimelineStop"
const CMD_RELOAD_AM = "kilo-code.new.e2eFixture.reloadAgentManagerWebview"
const AM_VIEW_TYPE = "kilo-code.new.AgentManagerPanel"

// --- Fixture session IDs (deterministic per run; shared with the harness via plan.json) ---

function planIds(fixtureId: string) {
  return {
    sourceId: `${fixtureId}-A`,
    siblingId: `${fixtureId}-B`,
    childId: `${fixtureId}-C`,
    variantId: `${fixtureId}-D`,
    tabAId: `${fixtureId}-TA`,
    tabBId: `${fixtureId}-TB`,
    tabCId: `${fixtureId}-TC`,
    sourceTitle: "E2E Source",
    siblingTitle: "E2E Sibling",
    childTitle: "E2E Child",
    variantTitle: "E2E Variant",
    tabATitle: "E2E Tab A",
    tabBTitle: "E2E Tab B",
    tabCTitle: "E2E Tab C",
    topicRootId: `${fixtureId}-T1`,
    topicChildId: `${fixtureId}-T1C`,
    topicSiblingId: `${fixtureId}-T2`,
    topicRootTitle: "E2E Topic Root",
    topicChildTitle: "E2E Topic Child",
    topicSiblingTitle: "E2E Sibling Root",
    // real-session scenario: run-owned workspace config seed (written by the
    // harness into scratch/workspace/.kilo/kilo.json before VS Code launches).
    // The custom provider/model/variant and the two custom agents are served
    // by the real backend; the harness drives the real webview to select and
    // prompt with them, then asserts served-backend truth through the
    // backendSnapshot fixture command.
    customProvider: "e2e-local",
    customModel: "e2e-model",
    customAgent: "e2e-agent",
    customAgentB: "e2e-agent-b",
    customAgentLabel: "E2E Agent",
    customAgentBLabel: "E2E Agent B",
    customVariantA: "Low",
    customVariantB: "High",
    // real-completed scenario: run-owned fixture identities (the harness wrote
    // the workspace seed — config + user tool + skill + MCP server + permission
    // target — into the scratch workspace before VS Code launched).
    realMcpServer: "e2e-fixture",
    realMcpTool: "e2e-fixture_e2e_echo",
    realUserTool: "e2e_marker",
    realSkill: "e2e-skill",
    realPermissionFile: "ask.txt",
    realArtifact: "e2e-custom-called.txt",
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function failCredential(scratch: string, file: string): never {
  writeFileSync(join(scratch, file), JSON.stringify(credentialFailed(), null, 2))
  throw new Error(CREDENTIAL_FAILED)
}

/**
 * True while the Agent Manager webview editor tab exists. The fixture bridge's
 * `agentManagerReady` command always resolves true (it awaits waitForReady and
 * then returns true regardless), so it can never signal panel disposal — the
 * tab-groups API is the reliable panel-lifecycle signal. The tab input's
 * viewType carries a `mainThreadWebview-` prefix in current VS Code, so match
 * by suffix.
 */
function isAgentManagerTab(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(AM_VIEW_TYPE)
}

function agentManagerTabOpen(): boolean {
  return vscode.window.tabGroups.all.some((group) => group.tabs.some(isAgentManagerTab))
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`probe runner: timeout waiting for ${label}`)
    await sleep(200)
  }
}

/**
 * Wait for a harness marker, aborting early if the harness has already
 * written the `done` marker (it failed or aborted). Lets the runner exit
 * promptly on failure paths instead of sitting out the full marker timeout,
 * which in turn lets VS Code exit under program control.
 */
async function waitForHarness(scratch: string, target: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(target)) return
    if (existsSync(join(scratch, "done"))) {
      throw new Error(`probe runner: harness aborted before ${label} (done marker present)`)
    }
    if (Date.now() > deadline) throw new Error(`probe runner: timeout waiting for ${label}`)
    await sleep(200)
  }
}

async function post(vscodeApi: typeof vscode, msg: unknown): Promise<void> {
  await vscodeApi.commands.executeCommand(CMD_POST, msg)
}

/**
 * LOCK-006/LOCK-008: reset the fixture-gated generation-request collector at
 * the start of a real-* scenario run. Never called between real-restart
 * launches — the persisted store must aggregate across them.
 */
async function resetLlmRequests(vscodeApi: typeof vscode): Promise<void> {
  await vscodeApi.commands.executeCommand(CMD_LLM_RESET)
}

/**
 * Write the aggregate generation-request evidence for one real-* scenario into
 * `<scratch>/llm-requests-<scenario>.json`: every `service=llm` record observed
 * across all server instances/launches of this run (typed provider/model/agent/
 * small/session per request, LOCK-008 diagnostics preserved). The harness
 * asserts the same store directly per phase; this is the durable evidence copy.
 */
/**
 * Fixture-only abort-attempt reset at real-session boundary entry. Issued once
 * per run; never between Stop A and Stop B so the run-level artifact stays
 * cumulative.
 */
async function resetAbortAttempts(vscodeApi: typeof vscode): Promise<void> {
  await vscodeApi.commands.executeCommand(CMD_ABORT_RESET)
}

/**
 * Run-level cumulative abort-attempt evidence (`<scratch>/abort-attempts.json`):
 * the existing fixture observer records stay bounded/redacted in shape; this
 * only wraps them in the run envelope. A missing/malformed observer command
 * result fails the run — it is never represented as a valid empty artifact.
 * A valid empty result (`{total:0,entries:[]}`) is preserved as-is.
 */
async function writeAbortAttemptsEvidence(
  vscodeApi: typeof vscode,
  scratch: string,
  scenario: string,
): Promise<void> {
  const result = (await vscodeApi.commands.executeCommand(CMD_ABORT_ATTEMPTS)) as unknown
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("probe runner: abortAttempts command result missing (expected {total, entries})")
  }
  const rec = result as Record<string, unknown>
  if (typeof rec.total !== "number" || !Number.isInteger(rec.total) || rec.total < 0) {
    throw new Error("probe runner: abortAttempts command result malformed (total must be integer >= 0)")
  }
  if (!Array.isArray(rec.entries)) {
    throw new Error("probe runner: abortAttempts command result malformed (entries must be array)")
  }
  writeFileSync(
    join(scratch, "abort-attempts.json"),
    JSON.stringify(
      {
        scenario,
        collectedAt: new Date().toISOString(),
        total: rec.total,
        entries: rec.entries,
      },
      null,
      2,
    ),
  )
}

async function writeLlmRequestsEvidence(vscodeApi: typeof vscode, scratch: string, scenario: string): Promise<void> {
  const result = (await vscodeApi.commands.executeCommand(CMD_LLM_REQUESTS)) as {
    records: unknown[]
    file: string
  } | null
  writeFileSync(
    join(scratch, `llm-requests-${scenario}.json`),
    JSON.stringify(
      { scenario, collectedAt: new Date().toISOString(), file: result?.file ?? null, records: result?.records ?? [] },
      null,
      2,
    ),
  )
}

/** Full production SessionInfo shape (parentID/revert/summary explicitly set). */
function session(id: string, title: string, iso: string, parentID: string | null = null): SessionInfo {
  return { id, title, createdAt: iso, updatedAt: iso, parentID, revert: null, summary: null }
}

/** Build the production assistant Message + task ToolPart that links to the child. */
function buildTranscript(sourceId: string, childId: string): Message[] {
  const now = Date.now()
  const userMsg: Message = {
    id: `${sourceId}-msg-user`,
    sessionID: sourceId,
    role: "user",
    parentID: "",
    time: { created: now },
    path: { cwd: "/tmp", root: "/tmp" },
    modelID: "test",
    providerID: "test",
    mode: "primary",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    createdAt: new Date(now).toISOString(),
  }
  const toolPart: ToolPart = {
    id: `${sourceId}-part-task`,
    sessionID: sourceId,
    messageID: `${sourceId}-msg-assistant`,
    type: "tool",
    callID: `${sourceId}-call-task`,
    tool: "task",
    state: {
      status: "completed",
      input: { subagent_type: "general", description: "E2E child sub-agent" },
      output: "done",
      title: "Sub-agent",
      metadata: { sessionId: childId },
    },
  }
  const assistantMsg: Message = {
    id: `${sourceId}-msg-assistant`,
    sessionID: sourceId,
    role: "assistant",
    parentID: `${sourceId}-msg-user`,
    time: { created: now, completed: now },
    path: { cwd: "/tmp", root: "/tmp" },
    modelID: "test",
    providerID: "test",
    mode: "primary",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "end_turn",
    parts: [toolPart],
    createdAt: new Date(now).toISOString(),
  }
  return [userMsg, assistantMsg]
}

/**
 * Transcript for the variant-memory session. The user message pins the
 * variant-bearing model (providerID kilo / modelID e2e-probe, injected by the
 * fixture bridge) and the recovered agent (code), so the real webview resolves
 * the session to that model and renders the interactive ThinkingSelector.
 */
function buildVariantTranscript(sessionId: string): Message[] {
  const now = Date.now()
  const userMsg: Message = {
    id: `${sessionId}-msg-variant-user`,
    sessionID: sessionId,
    role: "user",
    parentID: "",
    time: { created: now },
    path: { cwd: "/tmp", root: "/tmp" },
    providerID: "kilo",
    modelID: "e2e-probe",
    model: { providerID: "kilo", modelID: "e2e-probe" },
    agent: "code",
    mode: "primary",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    createdAt: new Date(now).toISOString(),
    content: "E2E variant memory probe",
  }
  return [userMsg]
}

/**
 * Minimal transcript for the topic-navigation sessions: a single user message
 * so the real TaskHeader renders (`hasMessages()`), making the session title
 * in `[data-slot="task-header-title-label"]` a real header-convergence
 * boundary. The backend does not know these synthetic sessions, so the
 * reconcile fetch 404s and never wipes the seeded messages.
 */
function buildTopicTranscript(sessionId: string): Message[] {
  const now = Date.now()
  const userMsg: Message = {
    id: `${sessionId}-msg-topic-user`,
    sessionID: sessionId,
    role: "user",
    parentID: "",
    time: { created: now },
    path: { cwd: "/tmp", root: "/tmp" },
    modelID: "test",
    providerID: "test",
    mode: "primary",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    createdAt: new Date(now).toISOString(),
    content: "E2E topic navigation probe",
  }
  return [userMsg]
}

/**
 * Seed the deterministic topic-navigation fixture state through production
 * message shapes. The inventory is the parentID hierarchy [root T1 → child
 * T1C] plus sibling root T2; topics derive at render time from these facts.
 * `openAll` controls whether the child/sibling also open as tabs: the initial
 * seed opens only the root tab so the harness's Topic/child clicks exercise
 * the production open-session path, while boundary rehydrates (panel
 * close/reopen, webview reload) restore the full canonical state reached by
 * the navigation phase. `activeId` is selected last so the active tab is
 * deterministic. The settle + preserveSessionIds re-seed is the same survival
 * handshake as the other scenarios.
 */
async function seedTopicFixtures(
  vscodeApi: typeof vscode,
  plan: ReturnType<typeof planIds>,
  iso: string,
  activeId: string,
  openAll: boolean,
): Promise<void> {
  const sessions = [
    session(plan.topicRootId, plan.topicRootTitle, iso, null),
    session(plan.topicChildId, plan.topicChildTitle, iso, plan.topicRootId),
    session(plan.topicSiblingId, plan.topicSiblingTitle, iso, null),
  ]
  await post(vscodeApi, {
    type: "sessionsLoaded",
    sessions,
  } satisfies SessionsLoadedMessage)

  // Open the root via the production sessionAdded path (covers the startup
  // pending tab), register it, then open the other sessions as tabs when the
  // canonical state requires them.
  await post(vscodeApi, {
    type: "agentManager.sessionAdded",
    sessionId: plan.topicRootId,
  })
  await post(vscodeApi, {
    type: "sessionCreated",
    session: sessions[0],
  } satisfies SessionCreatedMessage)
  if (openAll) {
    await post(vscodeApi, {
      type: "sessionCreated",
      session: sessions[1],
    } satisfies SessionCreatedMessage)
    await post(vscodeApi, {
      type: "sessionCreated",
      session: sessions[2],
    } satisfies SessionCreatedMessage)
  }

  // One user message per session so the real TaskHeader renders its title.
  for (const s of sessions) {
    await post(vscodeApi, {
      type: "messagesLoaded",
      sessionID: s.id,
      messages: buildTopicTranscript(s.id),
    } satisfies MessagesLoadedMessage)
  }

  // Deterministic active session.
  await post(vscodeApi, {
    type: "agentManager.sessionAdded",
    sessionId: activeId,
  })

  // Survival handshake: flush the real backend refresh, then re-seed
  // authoritatively so [T1, T1C, T2] survive with no timing dependence.
  await vscodeApi.commands.executeCommand(CMD_SETTLE)
  await post(vscodeApi, {
    type: "sessionsLoaded",
    sessions,
    preserveSessionIds: sessions.map((s) => s.id),
  } satisfies SessionsLoadedMessage)
}

interface ScenarioFlags {
  runTabClose: boolean
  runChild: boolean
  runVariant: boolean
  runTopic: boolean
  runReal: boolean
  runRealCompleted: boolean
  runRealOverflow: boolean
  runRealRestart: boolean
  runRealLifecycle: boolean
  runSidebarRemoval: boolean
  runWorktreeRemoval: boolean
  runCloudClawRemoval: boolean
  runP34Removal: boolean
  runR9Observation: boolean
}

/**
 * LOCK-002/003: seed only the selected scenario(s); each scenario's fixtures
 * and markers stay independent of the other. `all` stays the exact
 * tab-close → child-task-order → variant-memory composition (the delivery
 * gate); every other scenario is focused-only.
 */
function scenarioFlags(scenario: string): ScenarioFlags {
  return {
    runTabClose: scenario === "all" || scenario === "tab-close",
    runChild: scenario === "all" || scenario === "child-task-order",
    runVariant: scenario === "all" || scenario === "variant-memory",
    // topic-navigation is focused-only (not part of `all`): it closes/reopens the
    // Agent Manager panel mid-run, which would dispose the tab strip the other
    // `all` scenarios coordinate on, so the delivery-gate composition stays
    // exactly tab-close → child-task-order → variant-memory.
    runTopic: scenario === "topic-navigation",
    // real-session is focused-only (not part of `all`): it creates REAL backend
    // sessions through the production webview path, which would pollute the
    // synthetic session lists the other scenarios re-seed, and it closes/reopens
    // the panel mid-run like topic-navigation.
    runReal: scenario === "real-session",
    // real-completed is focused-only for the same reasons (real backend sessions,
    // completed turns, panel close/reopen, MCP disconnect).
    runRealCompleted: scenario === "real-completed",
    // real-overflow is focused-only for the same reasons (a real backend session
    // driven through a dedicated small-context config; see serviceRealOverflowBoundary).
    runRealOverflow: scenario === "real-overflow",
    // real-restart is focused-only for the same reasons PLUS its reload phase:
    // the runner itself executes workbench.action.reloadWindow mid-run, which
    // re-runs this runner in a fresh Extension Host (see serviceRealRestartBoundary).
    runRealRestart: scenario === "real-restart",
    runRealLifecycle: scenario === "real-lifecycle",
    // P3.1 sidebar-removal is focused-only: it asserts manifest absence and
    // Agent Manager readiness (no synthetic fixtures, no CDP DOM driving — all
    // assertions run extension-host-side).
    runSidebarRemoval: scenario === "sidebar-removal",
    // P3.2 worktree-removal is focused-only: it asserts runtime manifest /
    // command-table absence of the managed-worktree + custom Diff Viewer
    // surfaces, seeds two root-local sessions, and drives the bounded H-12
    // rollback phase against the run-owned scripted provider (real backend
    // sessions — never part of `all`).
    runWorktreeRemoval: scenario === "worktree-removal",
    // P3.3 cloud-claw-removal is focused-only: it asserts runtime manifest /
    // command-table / bundle-list absence of the removed cloud-session, KiloClaw,
    // local Console, and JetBrains product surfaces, then proves the Agent Manager
    // as the sole chat UI still becomes ready (no Open in Tab, P3.5 Complete
    // 2026-09-01) (LOCK-008). No synthetic fixtures, no CDP DOM driving, no model
    // requests — all assertions run extension-host-side and are recorded into
    // `<scratch>/cloud-claw-removal-runtime-evidence`.
    runCloudClawRemoval: scenario === "cloud-claw-removal",
    // P3.4 remaining-feature-removal is focused-only: it asserts runtime
    // manifest / command-table / bundle-list / workspace-state absence of the
    // removed indexing, project memory, user-visible context/compaction
    // controls, autocomplete, and commit-message surfaces, proves the
    // generation-request collector stayed at zero model requests, and that the
    // Agent Manager as the sole chat UI still becomes ready (no Open in Tab,
    // P3.5 Complete 2026-09-01) (LOCK-005/007/008). No synthetic fixtures, no CDP
    // DOM driving — all assertions run extension-host-side and are recorded into
    // `<scratch>/p3-4-removal-runtime-evidence`.
    runP34Removal: scenario === "p3-4-removal",
    // R9 private observation is focused-only: proves the five lifecycle
    // boundaries (panel close/reopen, reload, session switch, transport
    // reconnect, worker restart) against the canonical private observation
    // surface with exact-PID/file-marker evidence.
    runR9Observation: scenario === "r9-observation",
  }
}

export async function run(): Promise<void> {
  const scratch = process.env.KILO_E2E_SCRATCH
  const fixtureId = process.env.KILO_E2E_FIXTURE_ID
  if (!scratch || !fixtureId) {
    throw new Error("probe runner: missing KILO_E2E_SCRATCH / KILO_E2E_FIXTURE_ID env")
  }
  // LOCK-002/003: seed only the selected scenario(s); each scenario's fixtures
  // and markers stay independent of the other.
  const scenario = process.env.KILO_E2E_SCENARIO ?? "all"
  const supported = new Set([
    "all",
    "tab-close",
    "child-task-order",
    "variant-memory",
    "topic-navigation",
    "real-session",
    "real-completed",
    "real-overflow",
    "real-restart",
    "real-lifecycle",
    "sidebar-removal",
    "worktree-removal",
    "cloud-claw-removal",
    "p3-4-removal",
    "r9-observation",
  ])
  if (!supported.has(scenario)) {
    throw new Error(
      `probe runner: unknown KILO_E2E_SCENARIO "${scenario}". ` +
        "Supported values: all | tab-close | child-task-order | variant-memory | topic-navigation | real-session | real-completed | real-overflow | real-restart | real-lifecycle | sidebar-removal | worktree-removal | cloud-claw-removal | p3-4-removal | r9-observation (default: all)",
    )
  }
  const {
    runTabClose,
    runChild,
    runVariant,
    runTopic,
    runReal,
    runRealCompleted,
    runRealOverflow,
    runRealRestart,
    runRealLifecycle,
    runSidebarRemoval,
    runWorktreeRemoval,
    runCloudClawRemoval,
    runP34Removal,
    runR9Observation,
  } = scenarioFlags(scenario)
  writeFileSync(join(scratch, "runner-alive"), "started")
  // Exact Extension-Host process identity: the harness compares this across
  // the reloadWindow boundary as runner re-entry evidence.
  writeFileSync(join(scratch, "runner-pid"), String(process.pid))

  const plan = planIds(fixtureId)
  writeFileSync(join(scratch, "plan.json"), JSON.stringify(plan, null, 2))

  const ext = vscode.extensions.getExtension(EXTENSION_ID)
  if (!ext) throw new Error("probe runner: extension not found in host")
  await ext.activate()

  // The gated bridge commands are registered during activation; they only
  // exist because the harness passed KILO_E2E_FIXTURE.
  await waitFor(
    async () => {
      try {
        await vscode.commands.executeCommand(CMD_READY)
        return true
      } catch {
        return undefined
      }
    },
    60_000,
    "fixture bridge registration",
  )

  await vscode.commands.executeCommand(CMD_OPEN)

  await waitFor(
    async () => {
      const ready = await vscode.commands.executeCommand<boolean>(CMD_READY)
      return ready ? true : undefined
    },
    60_000,
    "Agent Manager panel readiness",
  )

  const iso = new Date().toISOString()

  // --- P3 removal scenarios (focused only) — dispatched from a helper so the
  // run() complexity stays under the ESLint cap. Each proves one removed
  // product surface is absent while the retained editor surfaces stay ready.
  await runRemovalScenarios(
    vscode,
    ext,
    scratch,
    fixtureId,
    runSidebarRemoval,
    runWorktreeRemoval,
    runCloudClawRemoval,
    runP34Removal,
  )

  // --- Tab-close scenario fixtures (TA, TB, TC) — independent of child/variant ---
  // Seeds three session tabs in a known order [TA, TB, TC] with TA active, using
  // the same production session-open path as the child scenario (sessionAdded
  // replaces the startup pending tab, sessionCreated opens and registers each
  // subsequent tab). No transcripts are needed — the close button acts on any
  // session tab. Runs FIRST in the `all` composition and closes all its own
  // tabs before finishing, so the strip handed to the child scenario is exactly
  // the startup state (one pending tab + bottom page) it already expects.
  if (runTabClose) {
    const tabSessions = [
      session(plan.tabAId, plan.tabATitle, iso),
      session(plan.tabBId, plan.tabBTitle, iso),
      session(plan.tabCId, plan.tabCTitle, iso),
    ]
    // 1. Backend session store knows all three sessions.
    await post(vscode, {
      type: "sessionsLoaded",
      sessions: tabSessions,
    } satisfies SessionsLoadedMessage)

    // 2. Open the first tab via the production sessionAdded path (replaces the
    //    startup pending "New Session" tab), leaving [TA] as the base.
    await post(vscode, {
      type: "agentManager.sessionAdded",
      sessionId: plan.tabAId,
    })

    // 3. Register the first tab in the local inventory, then open the other two
    //    tabs in order: [TA, TB, TC].
    await post(vscode, {
      type: "sessionCreated",
      session: session(plan.tabAId, plan.tabATitle, iso),
    } satisfies SessionCreatedMessage)
    await post(vscode, {
      type: "sessionCreated",
      session: session(plan.tabBId, plan.tabBTitle, iso),
    } satisfies SessionCreatedMessage)
    await post(vscode, {
      type: "sessionCreated",
      session: session(plan.tabCId, plan.tabCTitle, iso),
    } satisfies SessionCreatedMessage)

    // 4. Re-select the first tab so the seeded active tab is deterministic.
    await post(vscode, {
      type: "agentManager.sessionAdded",
      sessionId: plan.tabAId,
    })

    // 5. Deterministic survival handshake (same as the child scenario): flush
    //    the real backend refresh, then re-seed authoritatively so [TA, TB, TC]
    //    survive with no timing dependence.
    await vscode.commands.executeCommand(CMD_SETTLE)
    await post(vscode, {
      type: "sessionsLoaded",
      sessions: tabSessions,
      preserveSessionIds: [plan.tabAId, plan.tabBId, plan.tabCId],
    } satisfies SessionsLoadedMessage)

    // `ready` gates the harness start: the tab-close fixtures are seeded. The
    // harness closes tabs via the real .am-tab-close buttons, then writes
    // tab-close-done so the next scenario seeds.
    writeFileSync(join(scratch, "ready"), fixtureId)
    await waitForHarness(scratch, join(scratch, "tab-close-done"), 120_000, "harness tab-close-done marker")
  }

  // --- Child-task scenario fixtures (A, B, C) — independent of the variant ---
  if (runChild) {
    // 1. Backend session store knows all three sessions; only A and B open as tabs.
    await post(vscode, {
      type: "sessionsLoaded",
      sessions: [
        session(plan.sourceId, plan.sourceTitle, iso),
        session(plan.siblingId, plan.siblingTitle, iso),
        session(plan.childId, plan.childTitle, iso),
      ],
    } satisfies SessionsLoadedMessage)

    // 2. Open the source session via the production sessionAdded path while the
    //    auto-created "New Session" pending tab is the only tab — the canonical
    //    coverBottomPage transaction replaces it, leaving [source] as the base.
    await post(vscode, {
      type: "agentManager.sessionAdded",
      sessionId: plan.sourceId,
    })

    // 3. Register the source in the local session inventory (sessionAdded alone
    //    does not touch localSessionIDs) and mark it fresh so the extension's
    //    real session refresh never reconciles it away.
    await post(vscode, {
      type: "sessionCreated",
      session: session(plan.sourceId, plan.sourceTitle, iso),
    } satisfies SessionCreatedMessage)

    // 4. Open the sibling as the second tab: [source, sibling].
    await post(vscode, {
      type: "sessionCreated",
      session: session(plan.siblingId, plan.siblingTitle, iso),
    } satisfies SessionCreatedMessage)

    // 5. Focus the source session again so its chat (with the child task link) is visible.
    await post(vscode, {
      type: "agentManager.sessionAdded",
      sessionId: plan.sourceId,
    })

    // 6. A's transcript contains the production task tool part pointing at C.
    await post(vscode, {
      type: "messagesLoaded",
      sessionID: plan.sourceId,
      messages: buildTranscript(plan.sourceId, plan.childId),
    } satisfies MessagesLoadedMessage)

    // 7. Deterministic survival handshake: the extension awaits the real backend
    //    session-list refresh (including any deferred refresh flushed when the
    //    CLI connection comes up). Session-list loads are serialized, so when
    //    this resolves the webview has applied the real (empty) list — and no
    //    later in-flight refresh exists.
    await vscode.commands.executeCommand(CMD_SETTLE)

    // 8. Final authoritative re-seed AFTER the real refresh: a full
    //    sessionsLoaded with preserveSessionIds is the last session-list message
    //    the webview processes, so [A, B, C] survive with no timing dependence.
    await post(vscode, {
      type: "sessionsLoaded",
      sessions: [
        session(plan.sourceId, plan.sourceTitle, iso),
        session(plan.siblingId, plan.siblingTitle, iso),
        session(plan.childId, plan.childTitle, iso),
      ],
      preserveSessionIds: [plan.sourceId, plan.siblingId, plan.childId],
    } satisfies SessionsLoadedMessage)

    // `ready` gates the harness start: the child fixtures are seeded, so the
    // harness may begin its tab-order assertions. (Variant-only mode writes
    // `ready` after the variant seeding below.)
    writeFileSync(join(scratch, "ready"), fixtureId)

    // Test-owned hang control: KILO_E2E_FIXTURE_HANG keeps the runner alive
    // after readiness so the harness watchdog can exercise exact-owned process
    // termination (LOCK-004). Set only by the failure-path verification run.
    if (process.env.KILO_E2E_FIXTURE_HANG) {
      await new Promise<void>(() => {})
    }

    // Phase 1: harness asserts [A, B], clicks the real sub-agent link, asserts
    // [A, C, B] + active C, then writes child-phase1-done.
    await waitForHarness(scratch, join(scratch, "child-phase1-done"), 120_000, "harness child-phase1-done marker")

    // Phase 2: re-select the source so the harness can re-click the link and
    // prove an already-open child is focused without reordering.
    await post(vscode, {
      type: "agentManager.sessionAdded",
      sessionId: plan.sourceId,
    })
    writeFileSync(join(scratch, "child-phase2-ready"), fixtureId)

    await waitForHarness(scratch, join(scratch, "child-phase2-done"), 120_000, "harness child-phase2-done marker")
  }

  // --- Variant-memory scenario fixtures (D) — independent of the child ---
  if (runVariant) {
    // Explicit-config-only state provides no preset model catalog (LOCK-006
    // P4.4-G2 deleted `models-api.json` (3 MB) and `Core.ModelsDev`
    // `packages/core/src/models-dev.ts` disk/network/refresh plus models
    // snapshot/build machinery); the fixture bridge injects a synthetic
    // explicit-provider fixture variant model (kilo/e2e-probe) and pins it as
    // the per-agent model for every backend agent (so switching agents keeps
    // the variant-bearing model). The runner opens a session whose recovery
    // selects it, then re-provisions the synthetic explicit-provider
    // providersLoaded LAST so it stays the final provider message the webview
    // processes.
    await post(vscode, {
      type: "sessionCreated",
      session: session(plan.variantId, plan.variantTitle, iso),
    } satisfies SessionCreatedMessage)
    await post(vscode, {
      type: "agentManager.sessionAdded",
      sessionId: plan.variantId,
    })
    await post(vscode, {
      type: "messagesLoaded",
      sessionID: plan.variantId,
      messages: buildVariantTranscript(plan.variantId),
    } satisfies MessagesLoadedMessage)
    await vscode.commands.executeCommand(CMD_PROVISION)
    // Authoritative re-seed so the variant tab survives any later refresh. In
    // all-mode the child tabs are already open, so re-seed the full list; in
    // variant-only mode D is the only seeded tab.
    const variantSessions = [
      ...(runChild
        ? [
            session(plan.sourceId, plan.sourceTitle, iso),
            session(plan.siblingId, plan.siblingTitle, iso),
            session(plan.childId, plan.childTitle, iso),
          ]
        : []),
      session(plan.variantId, plan.variantTitle, iso),
    ]
    await post(vscode, {
      type: "sessionsLoaded",
      sessions: variantSessions,
      preserveSessionIds: variantSessions.map((s) => s.id),
    } satisfies SessionsLoadedMessage)
    writeFileSync(join(scratch, "variant-ready"), fixtureId)
    if (!runChild) {
      // Variant-only: the variant seeding above is the only prerequisite the
      // harness needs before it drives the ThinkingSelector + ModeSwitcher.
      writeFileSync(join(scratch, "ready"), fixtureId)
    }
  }

  // --- Topic-navigation lifecycle-convergence scenario (focused only) ---
  // Seeds the parentID hierarchy [root T1 → child T1C] + sibling root T2 and
  // hands the harness three extension-owned view boundaries over the runtime
  // bridge:
  //   1. session navigation — the harness clicks the Topic rows and the child
  //      row in the real Agent Manager and asserts active tab / header / active
  //      topic convergence,
  //   2. panel close/reopen — the runner closes the Agent Manager editor tab,
  //      reopens it, and rehydrates the fixture state so the fresh webview
  //      re-derives the same topic hierarchy/active state,
  //   3. webview reload — the harness reloads the Agent Manager OOPIF frame and
  //      re-finds it, the runner rehydrates again, and the harness asserts the
  //      same converged state.
  // Marker protocol: topic-nav-done (navigation asserted) → runner closes/
  // reopens + rehydrates → topic-reopen-ready (reopen asserted) → harness
  // reloads + re-finds → topic-reload-frame (runner rehydrates) →
  // topic-reload-ready (reload asserted) → topic-reload-done.
  if (runTopic) {
    // Initial seed: root tab only, active root. The child and sibling open as
    // tabs only when the harness clicks their Topic/child rows (production
    // open-session path).
    await seedTopicFixtures(vscode, plan, iso, plan.topicRootId, false)
    writeFileSync(join(scratch, "ready"), fixtureId)
    await waitForHarness(scratch, join(scratch, "topic-nav-done"), 120_000, "harness topic-nav-done marker")

    // Panel close/reopen boundary. Close the Agent Manager editor tab via the
    // tab-groups API (exact webview tab, not the active-editor command), wait
    // until the tab is gone (panel disposed), reopen, and wait for the NEW
    // panel's webview readiness via the fixture bridge (with a panel present,
    // agentManagerReady blocks until its webview sends webviewReady).
    const amTab = vscode.window.tabGroups.all.flatMap((group) => group.tabs).find(isAgentManagerTab)
    if (!amTab) {
      const inventory = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .map((tab) => {
          const input = tab.input
          const kind =
            input instanceof vscode.TabInputWebview
              ? `webview:${input.viewType}`
              : (input?.constructor.name ?? "<none>")
          return `${tab.label}:${kind}`
        })
      throw new Error(
        `probe runner: Agent Manager tab not found for close/reopen boundary. tabs=${inventory.join(", ")}`,
      )
    }
    await vscode.window.tabGroups.close(amTab, true)
    await waitFor(
      async () => (agentManagerTabOpen() ? undefined : "closed"),
      30_000,
      "Agent Manager panel disposed on close",
    )
    await vscode.commands.executeCommand(CMD_OPEN)
    await waitFor(
      async () => (agentManagerTabOpen() ? true : undefined),
      30_000,
      "reopened Agent Manager panel present",
    )
    await waitFor(
      async () => {
        try {
          const ready = await vscode.commands.executeCommand<boolean>(CMD_READY)
          return ready ? true : undefined
        } catch {
          // Command may reject while the new panel is still wiring up.
          return undefined
        }
      },
      60_000,
      "reopened Agent Manager webview readiness",
    )
    // Rehydrate to the canonical converged state (all tabs, child active).
    await seedTopicFixtures(vscode, plan, iso, plan.topicChildId, true)
    writeFileSync(join(scratch, "topic-reopen-ready"), fixtureId)
    await waitForHarness(scratch, join(scratch, "topic-reopen-done"), 120_000, "harness topic-reopen-done marker")

    // Webview reload boundary. The harness marks the pre-reload webview
    // document and writes `topic-reload-start`; the runner then executes the
    // VS Code host's own webview reload action ("Developer: Reload Webviews"),
    // which re-navigates the webview iframe to its real content. Frame-level
    // CDP reloads cannot reload a VS Code webview (they land on the host's
    // fake.html placeholder), so the host action is the smallest verified
    // mechanism. It reloads every open webview — only the Agent Manager exists
    // in the hermetic profile. The harness re-finds the FRESH document (no
    // pre-reload mark) and signals us to rehydrate so the new document
    // re-derives the same topic hierarchy/active state from the re-seeded
    // facts.
    await waitForHarness(scratch, join(scratch, "topic-reload-start"), 120_000, "harness topic-reload-start marker")
    await vscode.commands.executeCommand("workbench.action.webview.reloadWebviewAction")
    await waitForHarness(scratch, join(scratch, "topic-reload-frame"), 120_000, "harness topic-reload-frame marker")
    await seedTopicFixtures(vscode, plan, iso, plan.topicChildId, true)
    writeFileSync(join(scratch, "topic-reload-ready"), fixtureId)
    await waitForHarness(scratch, join(scratch, "topic-reload-done"), 120_000, "harness topic-reload-done marker")
  }

  // --- Real-session scenario (focused only) ---
  // No synthetic seeding: the harness drives the REAL Agent Manager webview to
  // create and prompt REAL backend sessions (via the production webview →
  // AgentManagerProvider → KiloProvider → SDK path) against a run-owned config
  // seed the harness wrote into the scratch workspace. This runner loop only
  // services two deterministic extension-host boundaries the harness cannot
  // reach from the Node side (see serviceRealSessionBoundary).
  if (runReal) {
    await serviceRealSessionBoundary(vscode, scratch, fixtureId)
  }

  // --- Real-completed scenario (focused only) ---
  // Same production-path principle, but the turns COMPLETE against the
  // run-owned scripted OpenAI-compatible provider. This runner loop services
  // the snapshot markers, the panel close/reopen boundary (H-7), and the MCP
  // disconnect through the real SDK (H-5 cleanup) — see
  // serviceRealCompletedBoundary.
  if (runRealCompleted) {
    await serviceRealCompletedBoundary(vscode, scratch, fixtureId)
  }

  // --- Real-overflow scenario (focused only) ---
  // H-13: a single real backend session completes an auto-compaction turn
  // against the run-owned scripted provider (dedicated small-context config).
  // This runner loop only services the snapshot truth markers.
  if (runRealOverflow) {
    await serviceRealOverflowBoundary(vscode, scratch, fixtureId)
  }

  // --- Real-restart scenario (focused only) ---
  // H-10/H-11 runtime-boundary evidence over the shared bridge: transport
  // reconnect (Phase A), exact-owned worker restart (Phase B), and a true
  // extension/window restart with session/artifact rehydration (Phase C). See
  // serviceRealRestartBoundary — the same runner re-enters after reloadWindow.
  if (runRealRestart) {
    await serviceRealRestartBoundary(vscode, scratch, fixtureId)
  }

  // --- R9 private observation scenario (focused only) ---
  if (runR9Observation) {
    await serviceR9ObservationBoundary(vscode, scratch, fixtureId)
  }

  if (runRealLifecycle) {
    await serviceRealLifecycleBoundary(vscode, scratch, fixtureId)
  }

  await waitForHarness(scratch, join(scratch, "done"), 120_000, "harness done marker")
  writeFileSync(join(scratch, "runner-done"), "ok")
}

/**
 * Dispatch the focused P3 removal scenarios (P3.1 sidebar, P3.2 worktree, P3.3
 * cloud/KiloClaw/Console/JetBrains). Extracted from run() to keep its ESLint
 * complexity under the cap. Each scenario proves one removed product surface
 * is absent while the retained Agent Manager surface stays ready; all
 * assertions run extension-host-side.
 */
async function runRemovalScenarios(
  vscodeApi: typeof vscode,
  ext: vscode.Extension<unknown>,
  scratch: string,
  fixtureId: string,
  runSidebarRemoval: boolean,
  runWorktreeRemoval: boolean,
  runCloudClawRemoval: boolean,
  runP34Removal: boolean,
): Promise<void> {
  // P3.1 sidebar-removal: proves the ordinary single-chat Activity Bar sidebar
  // is gone from the loaded manifest — the Agent Manager panel remains the
  // sole chat surface
  // whose webview reaches readiness (env-gated fixture bridge), and the Agent
  // Manager panel opened above still reports readiness. No CDP DOM driving is
  // needed because the removed surface never renders and tab readiness is proven
  // through the bridge.
  if (runSidebarRemoval) {
    await assertSidebarRemoval(vscodeApi, ext, scratch, fixtureId)
  }

  // P3.2 worktree-removal: proves the loaded manifest + runtime command table
  // expose no managed worktree or custom Diff Viewer surface, that root-local
  // Agent Manager orchestration survives with two root-local sessions, and that
  // no worktree state is created in the run-owned workspace. All assertions run
  // extension-host-side and are recorded into
  // `<scratch>/worktree-removal-runtime-evidence`; the harness then drives the
  // seeded two-session controllability and the bounded H-12 rollback over CDP
  // (see assertWorktreeRemovalLifecycle in script/e2e-probe.ts).
  if (runWorktreeRemoval) {
    await assertWorktreeRemoval(vscodeApi, ext, scratch, fixtureId)
    await serviceWorktreeRemovalBoundary(vscodeApi, scratch, fixtureId)
  }

  // P3.3 cloud-claw-removal: proves the loaded manifest, runtime command table,
  // and built bundle list expose no active cloud-session, KiloClaw, local
  // Console, or JetBrains product contribution (LOCK-003/PERF-3), while the
  // Agent Manager as the sole chat UI still becomes ready (no Open in Tab,
  // P3.5 Complete 2026-09-01) (LOCK-008). No synthetic fixtures, no CDP DOM
  // driving, and no model requests or external calls; evidence in
  // `<scratch>/cloud-claw-removal-runtime-evidence`.
  if (runCloudClawRemoval) {
    await assertCloudClawRemoval(vscodeApi, ext, scratch, fixtureId)
  }

  // P3.4 p3-4-removal: proves the loaded manifest, runtime command table,
  // built bundle list, and run-owned workspace state expose no removed
  // indexing / project memory / context-management / manual-compaction /
  // autocomplete / commit-message surface (LOCK-004/PERF-3/014/015), that the
  // generation-request collector stayed at zero model requests, and that the
  // Agent Manager as the sole chat UI still becomes ready (no Open in Tab,
  // P3.5 Complete 2026-09-01) (LOCK-005/007/008). No synthetic fixtures, no CDP
  // DOM driving, no model requests; evidence in
  // `<scratch>/p3-4-removal-runtime-evidence`.
  if (runP34Removal) {
    await assertP34Removal(vscodeApi, ext, scratch, fixtureId)
  }
}

/**
 * P3.1 sidebar-removal assertions (extension-host side):
 *   1. the loaded manifest contributes no Activity Bar sidebar surface under
 *      the forbidden ids/prefixes (kilo-code-ActivityBar /
 *      kilo-code.SidebarProvider / sidebarTitle.*) — identifier-based, so
 *      unrelated future views are not banned,
 *   2. the retained Agent Manager panel still reaches readiness through the
 *      env-gated fixture bridge,
 *   3. the Agent Manager panel still reports readiness afterwards.
 * Writes the `sidebar-removal-ready` marker on success; throws on any
 * assertion failure so the Extension Host run exits non-zero.
 */
async function assertSidebarRemoval(
  vscodeApi: typeof vscode,
  ext: vscode.Extension<unknown>,
  scratch: string,
  fixtureId: string,
): Promise<void> {
  const contributes = ext.packageJSON?.contributes ?? {}
  const sidebarIds = ["kilo-code-ActivityBar", "kilo-code.SidebarProvider"]
  const containers: Array<{ id?: string }> = contributes.viewsContainers?.activitybar ?? []
  if (containers.some((c) => sidebarIds.includes(c.id ?? ""))) {
    throw new Error("probe runner: activitybar container still contributes the removed sidebar (P3.1)")
  }
  const views: Record<string, Array<{ id?: string }>> = contributes.views ?? {}
  if (
    Object.values(views)
      .flat()
      .some((v) => sidebarIds.includes(v.id ?? "") || (v.id ?? "").startsWith("kilo-code.Sidebar"))
  ) {
    throw new Error("probe runner: manifest still contributes a view under the removed sidebar (P3.1)")
  }
  const declaredCommands: string[] = contributes.commands?.map((c: { command: string }) => c.command) ?? []
  if (declaredCommands.some((c) => c.startsWith("kilo-code.new.sidebarTitle."))) {
    throw new Error("probe runner: manifest still declares sidebarTitle.* commands (P3.1 sidebar removal)")
  }
  const menuEntries = Object.values(contributes.menus ?? {}).flat() as Array<{ command?: string }>
  if (menuEntries.some((m) => m.command?.startsWith("kilo-code.new.sidebarTitle."))) {
    throw new Error("probe runner: manifest still wires sidebarTitle.* menus (P3.1 sidebar removal)")
  }
  if (JSON.stringify(contributes).includes("kilo-code.SidebarProvider")) {
    throw new Error("probe runner: manifest still references kilo-code.SidebarProvider (P3.1 sidebar removal)")
  }

  const amReady = await vscodeApi.commands.executeCommand<boolean>(CMD_READY)
  if (!amReady) throw new Error("probe runner: Agent Manager readiness lost after P3.1 sidebar removal assertions")

  writeFileSync(join(scratch, "sidebar-removal-ready"), fixtureId)
}

/** Forbidden P3.2 surface regex (managed worktree / run-script / transfer / custom diff). */
const FORBIDDEN_SURFACE =
  /worktree|runScript|setupScript|gitTransfer|diffViewer|diff-viewer|diff-virtual|showChanges|apply|import/i

/** Forbidden managed-worktree / custom-diff identifiers (mirrors the static P3.2 contract). */
const FORBIDDEN_IDS = [
  "WorktreeManager",
  "WorktreeStateManager",
  "WorktreeDiffController",
  "PRStatusPoller",
  "SetupScriptService",
  "SetupScriptRunner",
  "WorktreeDiffEntry",
  "WorktreeDiffReverter",
  "git-transfer",
  "worktree-mode",
  "WorktreeModeProvider",
  "useWorktreeMode",
  "BranchSelect",
  "VscodeSessionTurn",
  "multi-model-utils",
  "MAX_MULTI_VERSIONS",
  "ModelAllocation",
  "ExternalWorktreeInfo",
  "WorktreeErrorCode",
  "AgentManagerPRStatusMessage",
  "agentManager.worktree.",
  "agentManager.run.",
  "agentManager.apply",
  "agentManager.import",
  "agentManager.branches",
  "DiffVirtualProvider",
  "DiffViewerProvider",
  "diff-viewer",
  "diff-virtual",
  "autoBranchNaming",
  "branchPrefix",
  "showChanges",
]

/**
 * P3.2 manifest absence check (part 1 of assertWorktreeRemoval): the loaded
 * contributes must expose no forbidden managed-worktree or custom Diff Viewer
 * surface — no worktree/diff-viewer view ids, containers, commands,
 * keybindings, menus, settings, or identifiers (identifier-based, mirroring
 * tests/unit/worktree-removal.test.ts). Throws on any violation and returns
 * the manifest evidence for the durable runtime-evidence file.
 */
function assertNoForbiddenContributions(contributes: Record<string, unknown>): {
  declaredCommands: string[]
  contributedViewIds: string[]
  configProps: string[]
  forbidden: Record<string, string[]>
} {
  const views = (contributes.views ?? {}) as Record<string, Array<{ id?: string }>>
  const viewHits: string[] = []
  for (const group of Object.values(views)) {
    for (const view of group) {
      if (view.id && FORBIDDEN_SURFACE.test(view.id)) viewHits.push(view.id)
    }
  }
  const containers = (contributes.viewsContainers ?? {}) as Record<string, Array<{ id?: string }>>
  const containerHits: string[] = []
  for (const group of Object.values(containers)) {
    for (const c of group) {
      if (c.id && FORBIDDEN_SURFACE.test(c.id)) containerHits.push(c.id)
    }
  }
  const declaredCommands: string[] = ((contributes.commands ?? []) as Array<{ command: string }>).map((c) => c.command)
  const commandHits = declaredCommands.filter((c) => FORBIDDEN_SURFACE.test(c))
  const bindingHits = ((contributes.keybindings ?? []) as Array<{ command?: string }>)
    .map((b) => b.command ?? "")
    .filter((c) => FORBIDDEN_SURFACE.test(c))
  const menuHits = Object.values((contributes.menus ?? {}) as Record<string, Array<{ command?: string }>>)
    .flat()
    .map((m) => m.command ?? "")
    .filter((c) => FORBIDDEN_SURFACE.test(c))
  const configProps = Object.keys(
    ((contributes.configuration ?? {}) as { properties?: Record<string, unknown> }).properties ?? {},
  )
  const settingHits = configProps.filter((k) => FORBIDDEN_SURFACE.test(k))
  const identifierHits = FORBIDDEN_IDS.filter((id) => JSON.stringify(contributes).includes(id))
  const forbidden = { viewHits, containerHits, commandHits, bindingHits, menuHits, settingHits, identifierHits }
  if (Object.values(forbidden).some((hits) => hits.length > 0)) {
    throw new Error(
      `probe runner: loaded manifest still exposes a forbidden P3.2 surface (${JSON.stringify(forbidden)})`,
    )
  }
  return {
    declaredCommands,
    contributedViewIds: Object.values(views)
      .flat()
      .map((v) => v.id ?? ""),
    configProps,
    forbidden,
  }
}

/**
 * P3.2 runtime command-table check (part 2 of assertWorktreeRemoval): the
 * RUNTIME command table must contain no registered kilo-code worktree /
 * run-script / transfer / diff-viewer command — removed feature initialization
 * must be absent (LOCK-PERF-3) — while the retained root-local surface
 * commands exist (agentManagerOpen / agentManager.newTab). Throws
 * on any violation and returns the runtime evidence.
 */
async function assertNoForbiddenRuntimeCommands(vscodeApi: typeof vscode): Promise<{
  kiloCommands: string[]
  runtimeForbidden: string[]
}> {
  const kiloCommands = (await vscodeApi.commands.getCommands(true)).filter((c) => c.startsWith("kilo-code."))
  const runtimeForbidden = kiloCommands.filter((c) => FORBIDDEN_SURFACE.test(c))
  if (runtimeForbidden.length > 0) {
    throw new Error(
      `probe runner: runtime command table still registers forbidden P3.2 commands: ${runtimeForbidden.join(", ")}`,
    )
  }
  for (const retained of [
    "kilo-code.new.agentManagerOpen",
    "kilo-code.new.agentManager.newTab",
  ]) {
    if (!kiloCommands.includes(retained)) {
      throw new Error(`probe runner: retained root-local command missing at runtime: ${retained}`)
    }
  }
  return { kiloCommands, runtimeForbidden }
}

/**
 * P3.2 no-worktree-state check (part 3 of assertWorktreeRemoval): the
 * run-owned workspace must contain no `.kilo/worktrees/`, no
 * `.kilo/agent-manager.json` (the removed WorktreeStateManager's state file),
 * no `.kilo/setup-script*` files, and no `worktreeId`/`"worktrees"` content
 * markers in the run-owned workspace .kilo state. Throws on any finding and
 * returns the state evidence.
 */
function assertNoWorktreeState(workspace: string): {
  worktreesDir: boolean
  agentManagerJson: boolean
  stateMarkers: string[]
  setupScripts: string[]
} {
  const kiloDir = join(workspace, ".kilo")
  const stateMarkers: string[] = []
  const scan = (dir: string): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git") continue
      const full = join(dir, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) scan(full)
      else if (stat.size < 1_000_000) {
        const content = readFileSync(full, "utf8")
        if (content.includes("worktreeId") || content.includes('"worktrees"')) stateMarkers.push(full)
      }
    }
  }
  scan(kiloDir)
  const setupScripts = ["setup-script", "setup-script.sh", "setup-script.ps1"]
    .map((name) => join(kiloDir, name))
    .filter((p) => existsSync(p))
  const state = {
    worktreesDir: existsSync(join(kiloDir, "worktrees")),
    agentManagerJson: existsSync(join(kiloDir, "agent-manager.json")),
    stateMarkers,
    setupScripts,
  }
  if (state.worktreesDir || state.agentManagerJson || state.stateMarkers.length > 0 || state.setupScripts.length > 0) {
    throw new Error(
      `probe runner: runtime created worktree state in the run-owned workspace (${JSON.stringify(state)})`,
    )
  }
  return state
}

/**
 * P3.2 root-local seeding (part 4 of assertWorktreeRemoval): two root-local
 * sessions A + B seed through the production session-open path (sessionAdded
 * carries NO worktree dimension — the removed worktreeId field is gone from
 * the production message type).
 */
async function seedRootLocalSessions(
  vscodeApi: typeof vscode,
  plan: ReturnType<typeof planIds>,
  iso: string,
): Promise<void> {
  const wtrSessions = [session(plan.sourceId, plan.sourceTitle, iso), session(plan.siblingId, plan.siblingTitle, iso)]
  await post(vscodeApi, {
    type: "sessionsLoaded",
    sessions: wtrSessions,
  } satisfies SessionsLoadedMessage)
  await post(vscodeApi, {
    type: "agentManager.sessionAdded",
    sessionId: plan.sourceId,
  })
  await post(vscodeApi, {
    type: "sessionCreated",
    session: wtrSessions[0],
  } satisfies SessionCreatedMessage)
  await post(vscodeApi, {
    type: "sessionCreated",
    session: wtrSessions[1],
  } satisfies SessionCreatedMessage)
  for (const s of wtrSessions) {
    await post(vscodeApi, {
      type: "messagesLoaded",
      sessionID: s.id,
      messages: buildTopicTranscript(s.id),
    } satisfies MessagesLoadedMessage)
  }
  await post(vscodeApi, {
    type: "agentManager.sessionAdded",
    sessionId: plan.sourceId,
  })
  await vscodeApi.commands.executeCommand(CMD_SETTLE)
  await post(vscodeApi, {
    type: "sessionsLoaded",
    sessions: wtrSessions,
    preserveSessionIds: wtrSessions.map((s) => s.id),
  } satisfies SessionsLoadedMessage)
}

/**
 * P3.2 worktree-removal assertions (extension-host side), split into bounded
 * parts (complexity cap):
 *   1. assertNoForbiddenContributions — the loaded manifest contributes no
 *      forbidden managed-worktree or custom Diff Viewer surface,
 *   2. assertNoForbiddenRuntimeCommands — the runtime command table registers
 *      no removed-feature command (LOCK-PERF-3) and keeps the retained
 *      root-local surface commands,
 *   3. assertNoWorktreeState — no worktree state is created in the run-owned
 *      workspace,
 *   4. the Agent Manager panel still reports readiness and two root-local
 *      sessions A + B seed through the production session-open path (no
 *      worktree dimension on the message).
 * Writes `<scratch>/worktree-removal-runtime-evidence` (durable runtime facts)
 * and `<scratch>/worktree-removal-ready`. Throws on any assertion failure so
 * the Extension Host run exits non-zero.
 */
async function assertWorktreeRemoval(
  vscodeApi: typeof vscode,
  ext: vscode.Extension<unknown>,
  scratch: string,
  fixtureId: string,
): Promise<void> {
  const contributes = (ext.packageJSON?.contributes ?? {}) as Record<string, unknown>
  const manifest = assertNoForbiddenContributions(contributes)
  const runtime = await assertNoForbiddenRuntimeCommands(vscodeApi)
  const workspace = join(scratch, "workspace")
  const state = assertNoWorktreeState(workspace)

  const amReady = await vscodeApi.commands.executeCommand<boolean>(CMD_READY)
  if (!amReady) throw new Error("probe runner: Agent Manager readiness lost before P3.2 worktree-removal seeding")
  const plan = planIds(fixtureId)
  await seedRootLocalSessions(vscodeApi, plan, new Date().toISOString())

  writeFileSync(
    join(scratch, "worktree-removal-runtime-evidence"),
    JSON.stringify(
      {
        scenario: "worktree-removal",
        collectedAt: new Date().toISOString(),
        pid: process.pid,
        fixtureId,
        manifest: {
          contributedCommandCount: manifest.declaredCommands.length,
          contributedCommands: manifest.declaredCommands,
          contributedViewIds: manifest.contributedViewIds,
          contributedConfigurationProperties: manifest.configProps,
          forbidden: manifest.forbidden,
        },
        runtime: {
          kiloCommandTotal: runtime.kiloCommands.length,
          forbiddenCommandHits: runtime.runtimeForbidden,
          retainedCommands: {
            agentManagerOpen: runtime.kiloCommands.includes("kilo-code.new.agentManagerOpen"),
            agentManagerNewTab: runtime.kiloCommands.includes("kilo-code.new.agentManager.newTab"),
          },
        },
        state: {
          workspace,
          worktreesDir: state.worktreesDir,
          agentManagerJson: state.agentManagerJson,
          stateMarkers: state.stateMarkers,
          setupScripts: state.setupScripts,
        },
        seeded: {
          sessionA: plan.sourceId,
          sessionB: plan.siblingId,
          panelReady: amReady,
          messageHasNoWorktreeId: true,
        },
      },
      null,
      2,
    ),
  )
  writeFileSync(join(scratch, "worktree-removal-ready"), fixtureId)
}

/**
 * Forbidden P3.3 active-product identifiers (cloud sessions, KiloClaw, local
 * Console, JetBrains). Identifier-based by design (LOCK-003): each is a
 * product-unique token that would only be present if that removed product's
 * extension surface were still active — no broad substring search. Retained
 * generic names are deliberately NOT here, so unrelated future strings are
 * never banned:
 *   - the `jetbrainsMono` font option (webview i18n, not a product surface),
 *   - the legacy autocomplete `IdeType = "vscode" | "jetbrains"` enum,
 *   - generic `console` / `cloud` words in retained strings.
 * Mirrors the static P3.3 contract (tests/unit/cloud-claw-removal.test.ts).
 */
const FORBIDDEN_PRODUCT_IDS = [
  // cloud sessions
  "openCloudSession",
  "selectCloudSession",
  "cloudSessionCtx",
  "cloudPreviewId",
  "RequestCloudSessions",
  "RequestCloudSessionData",
  "CloudSessionsLoaded",
  "CloudSessionDataLoaded",
  "CloudSessionImported",
  "CloudSessionImportFailed",
  "OpenCloudSessionMessage",
  "ImportAndSendMessage",
  "GitRemoteUrl",
  "CloudSessionList",
  "CloudImportDialog",
  // KiloClaw
  "KiloClawProvider",
  "kiloClawProvider",
  "kilo-code.new.kiloClawOpen",
  "openKiloClaw",
  "OpenKiloClawRequest",
  "kiloclaw",
  // local Console
  "ConsoleProvider",
  "kilo-code.new.consoleOpen",
  "openLocalConsole",
  "LocalConsole",
  // JetBrains
  "JetBrainsProvider",
  "jetbrainsProvider",
  "kilo-code.new.jetbrainsOpen",
  "openJetBrains",
  "jetbrainsPanel",
]

/**
 * Removed-product bundle filename prefixes. A file under the extension's built
 * `dist/` whose basename starts with any of these is a forbidden active
 * product bundle (e.g. `kiloclaw.js`, `cloud-session.js`, `console.js`,
 * `jetbrains.js`). Identifier-based: only exact removed-product bundle names
 * match, never the retained `webview.js` / `agent-manager.js` / `extension.js`
 * / `shiki-worker.js` assets.
 */
const FORBIDDEN_BUNDLE_PREFIXES = ["kiloclaw", "cloud-session", "console", "jetbrains", "claw"]

/**
 * P3.3 cloud-claw-removal assertions (extension-host side):
 *   1. assertNoForbiddenProductContributions — the loaded manifest contributes
 *      no forbidden cloud-session / KiloClaw / Console / JetBrains surface
 *      (views, containers, commands, keybindings, menus, settings) —
 *      identifier-based, so retained generic names are never banned,
 *   2. assertNoForbiddenProductRuntimeCommands — the RUNTIME command table
 *      registers no removed-product command (LOCK-PERF-3) and keeps the
 *      retained root-local surface commands,
 *   3. assertNoForbiddenProductBundles — the built `dist/` contains no removed
 *      KiloClaw/Console/JetBrains/cloud-session product bundle,
 *   4. retained surface stays ready: the Agent Manager panel as the sole chat UI
 *      still reports readiness (LOCK-008) — no Open in Tab (P3.5 Complete 2026-09-01).
 * Writes `<scratch>/cloud-claw-removal-runtime-evidence` (durable runtime
 * facts) and `<scratch>/cloud-claw-removal-ready`. Throws on any assertion
 * failure so the Extension Host run exits non-zero. No synthetic fixtures, no
 * CDP DOM driving, and no model requests or external calls.
 */
async function assertCloudClawRemoval(
  vscodeApi: typeof vscode,
  ext: vscode.Extension<unknown>,
  scratch: string,
  fixtureId: string,
): Promise<void> {
  const contributes = (ext.packageJSON?.contributes ?? {}) as Record<string, unknown>
  const manifest = assertNoForbiddenProductContributions(contributes)
  const runtime = await assertNoForbiddenProductRuntimeCommands(vscodeApi)
  const bundles = assertNoForbiddenProductBundles(ext)

  const amReady = await vscodeApi.commands.executeCommand<boolean>(CMD_READY)
  if (!amReady) throw new Error("probe runner: Agent Manager readiness lost after P3.3 cloud-claw-removal assertions")

  writeFileSync(
    join(scratch, "cloud-claw-removal-runtime-evidence"),
    JSON.stringify(
      {
        scenario: "cloud-claw-removal",
        collectedAt: new Date().toISOString(),
        pid: process.pid,
        fixtureId,
        manifest: {
          contributedCommandCount: manifest.declaredCommands.length,
          contributedCommands: manifest.declaredCommands,
          contributedViewIds: manifest.contributedViewIds,
          contributedConfigurationProperties: manifest.configProps,
          forbidden: manifest.forbidden,
        },
        runtime: {
          kiloCommandTotal: runtime.kiloCommands.length,
          forbiddenCommandHits: runtime.runtimeForbidden,
          retainedCommands: {
            agentManagerOpen: runtime.kiloCommands.includes("kilo-code.new.agentManagerOpen"),
            agentManagerNewTab: runtime.kiloCommands.includes("kilo-code.new.agentManager.newTab"),
          },
        },
        bundles: {
          distDir: bundles.distDir,
          bundleCount: bundles.bundleFiles.length,
          bundleFiles: bundles.bundleFiles,
          forbiddenBundleHits: bundles.forbiddenBundleHits,
        },
        retained: {
          agentManager: { ready: amReady },
        },
      },
      null,
      2,
    ),
  )
  writeFileSync(join(scratch, "cloud-claw-removal-ready"), fixtureId)
}

/**
 * P3.3 manifest absence check (part 1 of assertCloudClawRemoval): the loaded
 * contributes must expose no forbidden cloud-session / KiloClaw / Console /
 * JetBrains surface — no product view ids, containers, commands, keybindings,
 * menus, settings, or identifiers (identifier-based, mirroring
 * tests/unit/cloud-claw-removal.test.ts). Throws on any violation and returns
 * the manifest evidence for the durable runtime-evidence file.
 */
function assertNoForbiddenProductContributions(contributes: Record<string, unknown>): {
  declaredCommands: string[]
  contributedViewIds: string[]
  configProps: string[]
  forbidden: Record<string, string[]>
} {
  const views = (contributes.views ?? {}) as Record<string, Array<{ id?: string }>>
  const viewHits: string[] = []
  for (const group of Object.values(views)) {
    for (const view of group) {
      if (view.id && FORBIDDEN_PRODUCT_IDS.includes(view.id)) viewHits.push(view.id)
    }
  }
  const containers = (contributes.viewsContainers ?? {}) as Record<string, Array<{ id?: string }>>
  const containerHits: string[] = []
  for (const group of Object.values(containers)) {
    for (const c of group) {
      if (c.id && FORBIDDEN_PRODUCT_IDS.includes(c.id)) containerHits.push(c.id)
    }
  }
  const declaredCommands: string[] = ((contributes.commands ?? []) as Array<{ command: string }>).map((c) => c.command)
  const commandHits = declaredCommands.filter((c) => FORBIDDEN_PRODUCT_IDS.includes(c))
  const bindingHits = ((contributes.keybindings ?? []) as Array<{ command?: string }>)
    .map((b) => b.command ?? "")
    .filter((c) => FORBIDDEN_PRODUCT_IDS.includes(c))
  const menuHits = Object.values((contributes.menus ?? {}) as Record<string, Array<{ command?: string }>>)
    .flat()
    .map((m) => m.command ?? "")
    .filter((c) => FORBIDDEN_PRODUCT_IDS.includes(c))
  const configProps = Object.keys(
    ((contributes.configuration ?? {}) as { properties?: Record<string, unknown> }).properties ?? {},
  )
  const settingHits = configProps.filter((k) => FORBIDDEN_PRODUCT_IDS.some((id) => k.includes(id)))
  const identifierHits = FORBIDDEN_PRODUCT_IDS.filter((id) => JSON.stringify(contributes).includes(id))
  const forbidden = { viewHits, containerHits, commandHits, bindingHits, menuHits, settingHits, identifierHits }
  if (Object.values(forbidden).some((hits) => hits.length > 0)) {
    throw new Error(
      `probe runner: loaded manifest still exposes a forbidden P3.3 product surface (${JSON.stringify(forbidden)})`,
    )
  }
  return {
    declaredCommands,
    contributedViewIds: Object.values(views)
      .flat()
      .map((v) => v.id ?? ""),
    configProps,
    forbidden,
  }
}

/**
 * P3.3 runtime command-table check (part 2 of assertCloudClawRemoval): the
 * RUNTIME command table must contain no registered removed-product command
 * (LOCK-PERF-3) while the retained root-local surface commands exist
 * (agentManagerOpen / agentManager.newTab). Throws on any
 * violation and returns the runtime evidence.
 */
async function assertNoForbiddenProductRuntimeCommands(vscodeApi: typeof vscode): Promise<{
  kiloCommands: string[]
  runtimeForbidden: string[]
}> {
  const kiloCommands = (await vscodeApi.commands.getCommands(true)).filter((c) => c.startsWith("kilo-code."))
  const runtimeForbidden = kiloCommands.filter((c) => FORBIDDEN_PRODUCT_IDS.includes(c))
  if (runtimeForbidden.length > 0) {
    throw new Error(
      `probe runner: runtime command table still registers forbidden P3.3 commands: ${runtimeForbidden.join(", ")}`,
    )
  }
  for (const retained of [
    "kilo-code.new.agentManagerOpen",
    "kilo-code.new.agentManager.newTab",
  ]) {
    if (!kiloCommands.includes(retained)) {
      throw new Error(`probe runner: retained root-local command missing at runtime: ${retained}`)
    }
  }
  return { kiloCommands, runtimeForbidden }
}

/**
 * P3.3 bundle-list check (part 3 of assertCloudClawRemoval): the built
 * extension/webview asset list under `dist/` must contain no removed
 * KiloClaw/Console/JetBrains/cloud-session product bundle. Throws on any
 * violation and returns the bundle evidence.
 */
function assertNoForbiddenProductBundles(ext: vscode.Extension<unknown>): {
  distDir: string
  bundleFiles: string[]
  forbiddenBundleHits: string[]
} {
  const distDir = join(ext.extensionPath, "dist")
  let bundleFiles: string[] = []
  try {
    bundleFiles = readdirSync(distDir).sort()
  } catch {
    // dist/ missing during a source run — treat as no bundles (absence holds).
    bundleFiles = []
  }
  const forbiddenBundleHits = bundleFiles.filter((name) =>
    FORBIDDEN_BUNDLE_PREFIXES.some((prefix) => name.startsWith(`${prefix}.`)),
  )
  if (forbiddenBundleHits.length > 0) {
    throw new Error(
      `probe runner: built dist/ still contains forbidden P3.3 product bundles: ${forbiddenBundleHits.join(", ")}`,
    )
  }
  return { distDir, bundleFiles, forbiddenBundleHits }
}

/**
 * Forbidden P3.4 removed-feature identifiers (indexing, project memory,
 * context-management / manual compaction, autocomplete, commit-message).
 * Identifier-based by design (LOCK-004): each token is a product-unique
 * surface name that would only be present if the removed feature's extension
 * surface were still active — no broad substring search. Retained generic
 * names (in-memory caches, speech-to-text prewarm, the invisible automatic
 * CompactionPart rendering) are deliberately NOT here. Mirrors the static
 * P3.4 contract (tests/unit/p3-4-removal.test.ts).
 */
const FORBIDDEN_P34_IDS = [
  // autocomplete (FIM / next-edit / chat-autocomplete / statusbar)
  "AutocompleteServiceManager",
  "AutocompleteInlineCompletionProvider",
  "ChatTextAreaAutocomplete",
  "NextEditInlineCompletionProvider",
  "AutocompleteCodeActionProvider",
  "AutocompleteStatusBar",
  "autocomplete-models",
  "kilo-code.new.autocomplete.",
  "generateSuggestions",
  "cancelSuggestions",
  // indexing
  "indexing-settings",
  "IndexingTab",
  "useIndexing",
  "kilo-code.new.indexing.",
  "prompt-indexing",
  "indexing-warning",
  "dialog-indexing",
  // project memory
  "showMemory",
  "toggleMemory",
  "memory-prompt",
  "memory-status",
  "memory-recall",
  "memory-save",
  "MemoryManager",
  "MemoryActivity",
  "useMemory",
  "kilo-provider/memory",
  "memory-dialog",
  "kilo-code.new.showMemory",
  "kilo-code.new.toggleMemory",
  // commit-message
  "generateCommitMessage",
  "CommitMessageTab",
  "kilo-code.new.generateCommitMessage",
  // user-visible context-management / compaction controls
  "ContextProgress",
  "ContextTab",
  "context-progress",
  "CompactRequest",
  "compactSession",
  "command.session.compact",
  "settings.context.title",
  // orchestrator chatCompletionResult protocol
  "ChatCompletionResultMessage",
  "chatCompletionResult",
]

/**
 * Forbidden P3.4 removed-feature bundle filename prefixes. A file under the
 * extension's built `dist/` whose basename starts with any of these is a
 * forbidden removed-feature bundle (e.g. `autocomplete.js`, `indexing.js`,
 * `memory.js`, `context-progress.js`, `commit-message.js`). Identifier-based:
 * only exact removed-feature bundle names match, never the retained
 * `extension.js` / `webview.js` / `agent-manager.js` / `shiki-worker.js`
 * assets.
 */
const FORBIDDEN_P34_BUNDLE_PREFIXES = ["autocomplete", "commit-message", "indexing", "memory", "context-progress"]

/**
 * Forbidden P3.4 removed-config key forms a run-owned `.kilo` state file must
 * never contain (LOCK-014/015 — no dormant config surface). Exact quoted JSON
 * key forms only, so retained content that merely mentions the words never
 * matches.
 */
const FORBIDDEN_P34_STATE_KEYS = [
  '"codebaseIndexing"',
  '"indexing"',
  '"memory"',
  '"commitMessage"',
  '"autocomplete"',
  '"context-progress"',
]

/**
 * P3.4 manifest absence check (part 1 of assertP34Removal): the loaded
 * contributes must expose no removed indexing / memory / context-management /
 * autocomplete / commit-message surface — no forbidden view ids, containers,
 * commands, keybindings, menus, settings, or identifiers (identifier-based,
 * mirroring tests/unit/p3-4-removal.test.ts). Throws on any violation and
 * returns the manifest evidence for the durable runtime-evidence file.
 */
function assertNoP34Contributions(contributes: Record<string, unknown>): {
  declaredCommands: string[]
  contributedViewIds: string[]
  configProps: string[]
  forbidden: Record<string, string[]>
} {
  const views = (contributes.views ?? {}) as Record<string, Array<{ id?: string }>>
  const viewHits: string[] = []
  for (const group of Object.values(views)) {
    for (const view of group) {
      if (view.id && FORBIDDEN_P34_IDS.includes(view.id)) viewHits.push(view.id)
    }
  }
  const containers = (contributes.viewsContainers ?? {}) as Record<string, Array<{ id?: string }>>
  const containerHits: string[] = []
  for (const group of Object.values(containers)) {
    for (const container of group) {
      if (container.id && FORBIDDEN_P34_IDS.includes(container.id)) containerHits.push(container.id)
    }
  }
  const declaredCommands: string[] = ((contributes.commands ?? []) as Array<{ command: string }>).map((c) => c.command)
  const commandHits = declaredCommands.filter((c) => FORBIDDEN_P34_IDS.includes(c))
  const bindingHits = ((contributes.keybindings ?? []) as Array<{ command?: string }>)
    .map((b) => b.command ?? "")
    .filter((c) => FORBIDDEN_P34_IDS.includes(c))
  const menuHits = Object.values((contributes.menus ?? {}) as Record<string, Array<{ command?: string }>>)
    .flat()
    .map((m) => m.command ?? "")
    .filter((c) => FORBIDDEN_P34_IDS.includes(c))
  const configProps = Object.keys(
    ((contributes.configuration ?? {}) as { properties?: Record<string, unknown> }).properties ?? {},
  )
  const settingHits = configProps.filter((k) => FORBIDDEN_P34_IDS.some((id) => k.includes(id)))
  const identifierHits = FORBIDDEN_P34_IDS.filter((id) => JSON.stringify(contributes).includes(id))
  const forbidden = { viewHits, containerHits, commandHits, bindingHits, menuHits, settingHits, identifierHits }
  if (Object.values(forbidden).some((hits) => hits.length > 0)) {
    throw new Error(
      `probe runner: loaded manifest still exposes a forbidden P3.4 surface (${JSON.stringify(forbidden)})`,
    )
  }
  return {
    declaredCommands,
    contributedViewIds: Object.values(views)
      .flat()
      .map((v) => v.id ?? ""),
    configProps,
    forbidden,
  }
}

/**
 * P3.4 runtime command-table check (part 2 of assertP34Removal): the RUNTIME
 * command table must contain no registered removed-feature command
 * (LOCK-PERF-3) while the retained surface commands exist (agentManagerOpen /
 * agentManager.newTab / explainCode /
 * addToContext). Throws on any violation and returns the runtime evidence.
 */
async function assertNoP34RuntimeCommands(vscodeApi: typeof vscode): Promise<{
  kiloCommands: string[]
  runtimeForbidden: string[]
}> {
  const kiloCommands = (await vscodeApi.commands.getCommands(true)).filter((c) => c.startsWith("kilo-code."))
  const runtimeForbidden = kiloCommands.filter((c) => FORBIDDEN_P34_IDS.includes(c))
  if (runtimeForbidden.length > 0) {
    throw new Error(
      `probe runner: runtime command table still registers forbidden P3.4 commands: ${runtimeForbidden.join(", ")}`,
    )
  }
  for (const retained of [
    "kilo-code.new.agentManagerOpen",
    "kilo-code.new.agentManager.newTab",
    "kilo-code.new.explainCode",
    "kilo-code.new.addToContext",
    "kilo-code.new.toggleAutoApprove",
  ]) {
    if (!kiloCommands.includes(retained)) {
      throw new Error(`probe runner: retained command missing at runtime: ${retained}`)
    }
  }
  return { kiloCommands, runtimeForbidden }
}

/**
 * P3.4 bundle-list check (part 3 of assertP34Removal): the built extension /
 * webview asset list under `dist/` must contain no removed-feature bundle.
 * Throws on any violation and returns the bundle evidence.
 */
function assertNoP34Bundles(ext: vscode.Extension<unknown>): {
  distDir: string
  bundleFiles: string[]
  forbiddenBundleHits: string[]
} {
  const distDir = join(ext.extensionPath, "dist")
  let bundleFiles: string[] = []
  try {
    bundleFiles = readdirSync(distDir).sort()
  } catch {
    // dist/ missing during a source run — treat as no bundles (absence holds).
    bundleFiles = []
  }
  const forbiddenBundleHits = bundleFiles.filter((name) =>
    FORBIDDEN_P34_BUNDLE_PREFIXES.some((prefix) => name.startsWith(`${prefix}.`)),
  )
  if (forbiddenBundleHits.length > 0) {
    throw new Error(
      `probe runner: built dist/ still contains forbidden P3.4 bundles: ${forbiddenBundleHits.join(", ")}`,
    )
  }
  return { distDir, bundleFiles, forbiddenBundleHits }
}

/**
 * P3.4 workspace-state check (part 4 of assertP34Removal): the run-owned
 * workspace must contain no removed-feature `.kilo` state — no
 * memory/indexing/autocomplete/commit-message dirs or files directly under
 * `.kilo`, and no removed config key form in its small text/JSON files
 * (LOCK-014/015). Throws on any finding and returns the state evidence.
 */
function assertNoP34WorkspaceState(workspace: string): {
  kiloDirExists: boolean
  forbiddenFiles: string[]
  forbiddenStateMarkers: string[]
} {
  const kiloDir = join(workspace, ".kilo")
  const forbiddenFiles: string[] = []
  const forbiddenStateMarkers: string[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(kiloDir)
  } catch {
    return { kiloDirExists: false, forbiddenFiles, forbiddenStateMarkers }
  }
  for (const name of entries) {
    if (/^(memory|indexing|autocomplete|commit-message)/i.test(name)) forbiddenFiles.push(name)
    const full = join(kiloDir, name)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isFile() && stat.size > 0 && stat.size < 1_000_000) {
      const content = readFileSync(full, "utf8")
      for (const key of FORBIDDEN_P34_STATE_KEYS) {
        if (content.includes(key)) forbiddenStateMarkers.push(`${name}:${key}`)
      }
    }
  }
  if (forbiddenFiles.length > 0 || forbiddenStateMarkers.length > 0) {
    throw new Error(
      `probe runner: run-owned workspace state contains removed-feature residue (${JSON.stringify({ forbiddenFiles, forbiddenStateMarkers })})`,
    )
  }
  return { kiloDirExists: entries.length > 0, forbiddenFiles, forbiddenStateMarkers }
}

/**
 * P3.4 remaining-feature-removal assertions (extension-host side):
 *   1. assertNoP34Contributions — the loaded manifest contributes no removed
 *      indexing / memory / context-management / autocomplete / commit-message
 *      surface,
 *   2. assertNoP34RuntimeCommands — the RUNTIME command table registers no
 *      removed-feature command (LOCK-PERF-3) and keeps the retained surface
 *      commands,
 *   3. assertNoP34Bundles — the built `dist/` contains no removed-feature
 *      bundle,
 *   4. assertNoP34WorkspaceState — the run-owned workspace carries no
 *      removed-feature `.kilo` state (LOCK-014/015),
 *   5. model-request silence: the fixture-gated generation-request collector
 *      must stay at ZERO model requests across the whole scenario (no external
 *      model calls and no leaked owned resources),
 *   6. retained surface stays ready: the Agent Manager panel as the sole chat UI
 *      still reports readiness (LOCK-005/007/008) — no Open in Tab (P3.5 Complete 2026-09-01).
 * Writes `<scratch>/p3-4-removal-runtime-evidence` (durable runtime facts) and
 * `<scratch>/p3-4-removal-ready`. Throws on any assertion failure so the
 * Extension Host run exits non-zero. No synthetic fixtures, no CDP DOM
 * driving, no model requests.
 */
async function assertP34Removal(
  vscodeApi: typeof vscode,
  ext: vscode.Extension<unknown>,
  scratch: string,
  fixtureId: string,
): Promise<void> {
  // LOCK-PERF-3/LOCK-013/014: the generation-request collector must observe
  // zero model requests for this scenario. Reset at scenario start (the
  // extension is already activated and the Agent Manager panel already
  // opened), then assert the store is empty right before writing the
  // evidence.
  await resetLlmRequests(vscodeApi)

  const contributes = (ext.packageJSON?.contributes ?? {}) as Record<string, unknown>
  const manifest = assertNoP34Contributions(contributes)
  const runtime = await assertNoP34RuntimeCommands(vscodeApi)
  const bundles = assertNoP34Bundles(ext)
  const workspace = join(scratch, "workspace")
  const state = assertNoP34WorkspaceState(workspace)

  const amReady = await vscodeApi.commands.executeCommand<boolean>(CMD_READY)
  if (!amReady) throw new Error("probe runner: Agent Manager readiness lost after P3.4 assertions")

  const llm = (await vscodeApi.commands.executeCommand(CMD_LLM_REQUESTS)) as {
    records: unknown[]
    file: string
  } | null
  const llmRequestCount = llm?.records.length ?? 0
  if (llmRequestCount > 0) {
    throw new Error(`probe runner: P3.4 scenario issued ${llmRequestCount} model request(s)`)
  }

  writeFileSync(
    join(scratch, "p3-4-removal-runtime-evidence"),
    JSON.stringify(
      {
        scenario: "p3-4-removal",
        collectedAt: new Date().toISOString(),
        pid: process.pid,
        fixtureId,
        manifest: {
          contributedCommandCount: manifest.declaredCommands.length,
          contributedCommands: manifest.declaredCommands,
          contributedViewIds: manifest.contributedViewIds,
          contributedConfigurationProperties: manifest.configProps,
          forbidden: manifest.forbidden,
        },
        runtime: {
          kiloCommandTotal: runtime.kiloCommands.length,
          forbiddenCommandHits: runtime.runtimeForbidden,
          retainedCommands: {
            agentManagerOpen: runtime.kiloCommands.includes("kilo-code.new.agentManagerOpen"),
            agentManagerNewTab: runtime.kiloCommands.includes("kilo-code.new.agentManager.newTab"),
          },
        },
        bundles: {
          distDir: bundles.distDir,
          bundleCount: bundles.bundleFiles.length,
          bundleFiles: bundles.bundleFiles,
          forbiddenBundleHits: bundles.forbiddenBundleHits,
        },
        state: {
          workspace,
          kiloDirExists: state.kiloDirExists,
          forbiddenFiles: state.forbiddenFiles,
          forbiddenStateMarkers: state.forbiddenStateMarkers,
        },
        modelRequests: { count: llmRequestCount },
        retained: {
          agentManager: { ready: amReady },
        },
      },
      null,
      2,
    ),
  )
  writeFileSync(join(scratch, "p3-4-removal-ready"), fixtureId)
}

/**
 * Extension-host service loop for the P3.2 worktree-removal scenario:
 *   1. resets the generation-request store (the seeding already settled the
 *      real session list — a SECOND settle here would fire a backend refresh
 *      with the empty served list that reconciles the seeded root-local
 *      sessions out of the webview store, so none is issued),
 *   2. backend truth for the bounded H-12 phase: on each `p32-snap-N-request`
 *      marker, executes the env-gated backendSnapshot fixture command against
 *      the shared served backend and writes `p32-snap-N.json` (the harness
 *      asserts the write/revert/redo facts on it),
 *   3. writes the aggregate LLM request evidence before stopping.
 * Stops when the harness writes the `done` marker (success or abort).
 */
async function serviceWorktreeRemovalBoundary(
  vscodeApi: typeof vscode,
  scratch: string,
  fixtureId: string,
): Promise<void> {
  await resetLlmRequests(vscodeApi)
  writeFileSync(join(scratch, "worktree-removal-service-ready"), fixtureId)

  let snap = 1
  const deadline = Date.now() + WORKTREE_REMOVAL_SERVICE_BUDGET
  while (Date.now() < deadline) {
    if (existsSync(join(scratch, "done"))) break
    const req = join(scratch, `p32-snap-${snap}-request`)
    if (existsSync(req)) {
      const snapshot = await vscodeApi.commands.executeCommand(CMD_SNAPSHOT)
      writeFileSync(join(scratch, `p32-snap-${snap}.json`), JSON.stringify(snapshot, null, 2))
      snap += 1
    }
    await sleep(200)
  }
  await writeLlmRequestsEvidence(vscodeApi, scratch, "worktree-removal")
}

/**
 * Extension-host service loop for the real-session scenario:
 *   1. backend truth: on each `real-snap-N-request` marker, executes the
 *      env-gated backendSnapshot fixture command against the shared served
 *      backend and writes `real-snap-N.json` (the harness asserts on it),
 *   2. SSE timeline windows (LOCK-049/050/051): on each
 *      `sse-timeline-A/B-start-request` marker, starts the fixture-only
 *      bounded redacted timeline observer and writes
 *      `sse-timeline-A/B-started`; on each `sse-timeline-A/B-stop-request`
 *      marker, stops it and writes the redacted `sse-timeline-abort-A/B.json`
 *      the harness asserts around Stop A / Stop B,
 *   3. panel close/reopen: on `real-reopen-request`, closes the Agent Manager
 *      editor tab, reopens it, waits for the fresh webview's readiness,
 *      settles the real session list, then writes `real-reopen-ready` so the
 *      harness can assert transcript rehydration from the real backend.
 * Stops when the harness writes the `done` marker (success or abort).
 */
async function serviceRealSessionBoundary(vscodeApi: typeof vscode, scratch: string, fixtureId: string): Promise<void> {
  await resetLlmRequests(vscodeApi)
  await resetAbortAttempts(vscodeApi)
  // Canonical credential provisioning (real SecretStorage, no bypass):
  // the seeded kilo.jsonc already carries the credential ref and default model;
  // store the secret through the production storeSecret path and converge
  // canonical state before the first UI assertion. Uses run-owned SecretStorage
  // and awaits materializationReady + hasCredential before writing evidence.
  // Distinct rs-credential.json keeps the five-boundary claim aggregatable
  // across manifests without collision with real-restart's rr-credential.json.
  try {
    const seeded = await vscodeApi.commands.executeCommand(CMD_SEED_CREDENTIAL)
    writeFileSync(join(scratch, "rs-credential.json"), JSON.stringify(seeded, null, 2))
  } catch {
    failCredential(scratch, "rs-credential.json")
  }
  await vscodeApi.commands.executeCommand(CMD_SETTLE)
  writeFileSync(join(scratch, "real-ready"), fixtureId)

  let snap = 1
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    if (existsSync(join(scratch, "done"))) break
    const req = join(scratch, `real-snap-${snap}-request`)
    if (existsSync(req)) {
      const snapshot = await vscodeApi.commands.executeCommand(CMD_SNAPSHOT)
      writeFileSync(join(scratch, `real-snap-${snap}.json`), JSON.stringify(snapshot, null, 2))
      snap += 1
    }
    // Canonical-state probe (real-session lifecycle, before its agent-list assertion):
    // read-only CanonicalConfigService snapshot — the H1/H2 discriminator for a
    // recurring ModeSwitcher options=[].
    const cstate = join(scratch, "rs-cstate-request")
    if (existsSync(cstate)) {
      rmSync(cstate)
      const state = await vscodeApi.commands.executeCommand(CMD_CANONICAL_STATE)
      writeFileSync(join(scratch, "rs-cstate.json"), JSON.stringify(state, null, 2))
    }
    const credSeed = join(scratch, "rs-credseed-request")
    if (existsSync(credSeed)) {
      rmSync(credSeed)
      try {
        const seeded = await vscodeApi.commands.executeCommand(CMD_SEED_CREDENTIAL)
        writeFileSync(join(scratch, "rs-credential.json"), JSON.stringify(seeded, null, 2))
      } catch {
        failCredential(scratch, "rs-credential.json")
      }
    }
    // SSE timeline windows around Stop A / Stop B: the harness brackets each
    // Stop with start/stop markers; the observer is fixture-only, bounded, and
    // redacted (no payloads), and stop writes the durable timeline artifact.
    for (const tag of ["A", "B"]) {
      const startReq = join(scratch, `sse-timeline-${tag}-start-request`)
      if (existsSync(startReq)) {
        rmSync(startReq)
        const started = await vscodeApi.commands.executeCommand(CMD_SSE_TIMELINE_START)
        writeFileSync(join(scratch, `sse-timeline-${tag}-started`), JSON.stringify(started))
      }
      const stopReq = join(scratch, `sse-timeline-${tag}-stop-request`)
      if (existsSync(stopReq)) {
        rmSync(stopReq)
        const snapshot = await vscodeApi.commands.executeCommand(CMD_SSE_TIMELINE_STOP)
        writeFileSync(join(scratch, `sse-timeline-abort-${tag}.json`), JSON.stringify(snapshot, null, 2))
        if (tag === "B") {
          await writeAbortAttemptsEvidence(vscodeApi, scratch, "real-session")
        }
      }
    }
    const reopen = join(scratch, "real-reopen-request")
    if (existsSync(reopen)) {
      rmSync(reopen)
      const amTab = vscodeApi.window.tabGroups.all.flatMap((group) => group.tabs).find(isAgentManagerTab)
      if (!amTab) throw new Error("probe runner: Agent Manager tab not found for real-session reopen boundary")
      await vscodeApi.window.tabGroups.close(amTab, true)
      await waitFor(
        async () => (agentManagerTabOpen() ? undefined : "closed"),
        30_000,
        "real-session: panel disposed on close",
      )
      await vscodeApi.commands.executeCommand(CMD_OPEN)
      await waitFor(
        async () => (agentManagerTabOpen() ? true : undefined),
        30_000,
        "real-session: reopened panel present",
      )
      await waitFor(
        async () => {
          try {
            const ready = await vscodeApi.commands.executeCommand<boolean>(CMD_READY)
            return ready ? true : undefined
          } catch {
            return undefined
          }
        },
        60_000,
        "real-session: reopened webview readiness",
      )
      await vscodeApi.commands.executeCommand(CMD_SETTLE)
      writeFileSync(join(scratch, "real-reopen-ready"), fixtureId)
    }
    await sleep(200)
  }
  await writeLlmRequestsEvidence(vscodeApi, scratch, "real-session")
}

/**
 * Service-window budget for the real-completed scenario (ms), derived from the
 * declared worst-case phase budgets in script/e2e-probe.ts
 * assertRealCompletedLifecycle so a valid slow/retry-heavy run is never
 * abandoned while the harness is still inside its own declared budgets:
 *   - per sendTurn phase (H-2..H-6, 6 phases): 3 attempts × (send 30s +
 *     snap.waitFor 90s) + 2 retry sleeps 1s = 362s → 2,172s
 *   - H-6 post-sendTurn UI waits (permission + question): 2 × (dock 60s +
 *     click 30s + completion 90s + dock gone 30s + text 60s) = 540s
 *   - H-2..H-5 transcript/UI extras: 90s + 60s + 60s + 30s = 240s
 *   - setup (agent + variant picks, 5 × 30s): 150s
 *   - H-7 reopen: waitForFile 120s + refind 60s + hierarchy facts 60s +
 *     topic click 30s + hierarchy loop 30s = 300s (the runner's own close 30s
 *     / open 30s / readiness 60s runs inside this window)
 *   - H-5 cleanup: marker 60s + exit loop 30s + disabled snapshot 30s = 120s
 *   - H-12 rollback (Phase 9, after the reopened panel): 2 sendTurn phases
 *     (edit + summary, 2 × 362s = 724s) + transcript text 3 × 60s + revert
 *     click 90s + revert fact 90s + file bytes 2 × 30s + banner 60s + banner
 *     file 30s + Redo All click 60s + unrevert fact 90s + banner gone 30s =
 *     1,414s
 *   Total: 3,522 + 1,414 = 4,936s; margin ≈ 10% → 5,400s (90 min). The global
 *   probe watchdog (KILO_E2E_TIMEOUT) stays the outer bound; this deadline
 *   only guarantees the service loop outlives every declared phase budget.
 */
const REAL_COMPLETED_SERVICE_BUDGET = 5_400_000

/**
 * Service-window budget for the P3.2 worktree-removal scenario (ms), derived
 * from the declared worst-case phase budgets in script/e2e-probe.ts
 * assertWorktreeRemovalLifecycle so a valid slow/retry-heavy run is never
 * abandoned while the harness is still inside its own declared budgets:
 *   - seeded two-session phase: ready 120s + tabs 20s + switching 2 × 30s +
 *     sidebar 30s + tab closes 3 × 30s = ~320s
 *   - Phase 0 (agent + variant picks): 5 × 30s = 150s
 *   - H-12 rollback (reused assertRealRollbackPhase): 2 sendTurn phases
 *     (edit + summary, 2 × 362s = 724s) + transcript text 3 × 60s + revert
 *     click 90s + revert fact 90s + file bytes 2 × 30s + banner 60s + banner
 *     file 30s + Redo All click 60s + unrevert fact 90s + banner gone 30s =
 *     1,414s
 *   Total: ~1,884s; margin ≈ 10% → 2,100s (35 min). The global probe watchdog
 *   (KILO_E2E_TIMEOUT) stays the outer bound; this deadline only guarantees
 *   the service loop outlives every declared phase budget.
 */
const WORKTREE_REMOVAL_SERVICE_BUDGET = 2_100_000
/**
 * Extension-host service loop for the real-completed scenario:
 *   1. backend truth: on each `rc-snap-N-request` marker, executes the
 *      env-gated backendSnapshot fixture command against the shared served
 *      backend and writes `rc-snap-N.json` (the harness asserts on it),
 *   2. panel close/reopen (H-7): on `real-completed-reopen-request`, closes
 *      the Agent Manager editor tab, reopens it, waits for the fresh webview's
 *      readiness, settles the real session list, then writes
 *      `real-completed-reopen-ready`,
 *   3. MCP disconnect (H-5 cleanup): on `real-completed-mcp-disconnect-request`,
 *      disconnects the run-owned MCP server through the real SDK (the env-gated
 *      fixture command calls the shared client's mcp.disconnect) and writes
 *      `real-completed-mcp-disconnect-done` — the harness verifies the recorded
 *      child PIDs exited.
 * Stops when the harness writes the `done` marker (success or abort).
 */
async function serviceRealCompletedBoundary(
  vscodeApi: typeof vscode,
  scratch: string,
  fixtureId: string,
): Promise<void> {
  await resetLlmRequests(vscodeApi)
  await vscodeApi.commands.executeCommand(CMD_SETTLE)
  writeFileSync(join(scratch, "real-completed-ready"), fixtureId)

  let snap = 1
  const deadline = Date.now() + REAL_COMPLETED_SERVICE_BUDGET
  while (Date.now() < deadline) {
    if (existsSync(join(scratch, "done"))) break
    const req = join(scratch, `rc-snap-${snap}-request`)
    if (existsSync(req)) {
      const snapshot = await vscodeApi.commands.executeCommand(CMD_SNAPSHOT)
      writeFileSync(join(scratch, `rc-snap-${snap}.json`), JSON.stringify(snapshot, null, 2))
      snap += 1
    }
    const reopen = join(scratch, "real-completed-reopen-request")
    if (existsSync(reopen)) {
      rmSync(reopen)
      const amTab = vscodeApi.window.tabGroups.all.flatMap((group) => group.tabs).find(isAgentManagerTab)
      if (!amTab) {
        throw new Error("probe runner: Agent Manager tab not found for real-completed reopen boundary")
      }
      await vscodeApi.window.tabGroups.close(amTab, true)
      await waitFor(
        async () => (agentManagerTabOpen() ? undefined : "closed"),
        30_000,
        "real-completed: panel disposed on close",
      )
      await vscodeApi.commands.executeCommand(CMD_OPEN)
      await waitFor(
        async () => (agentManagerTabOpen() ? true : undefined),
        30_000,
        "real-completed: reopened panel present",
      )
      await waitFor(
        async () => {
          try {
            const ready = await vscodeApi.commands.executeCommand<boolean>(CMD_READY)
            return ready ? true : undefined
          } catch {
            return undefined
          }
        },
        60_000,
        "real-completed: reopened webview readiness",
      )
      await vscodeApi.commands.executeCommand(CMD_SETTLE)
      writeFileSync(join(scratch, "real-completed-reopen-ready"), fixtureId)
    }
    const mcpDisconnect = join(scratch, "real-completed-mcp-disconnect-request")
    if (existsSync(mcpDisconnect)) {
      rmSync(mcpDisconnect)
      const status = await vscodeApi.commands.executeCommand(CMD_MCP_DISCONNECT, "e2e-fixture")
      writeFileSync(join(scratch, "real-completed-mcp-disconnect-done"), JSON.stringify(status))
    }
    await sleep(200)
  }
  await writeLlmRequestsEvidence(vscodeApi, scratch, "real-completed")
}

/**
 * Service-window budget for the real-overflow scenario (ms), derived from the
 * declared worst-case phase budgets in script/e2e-probe.ts
 * assertRealOverflowLifecycle so a valid slow/retry-heavy run is never
 * abandoned while the harness is still inside its own declared budgets:
 *   - Phase 0 (agent + variant picks): 5 × 30s = 150s
 *   - Phase 1 (overflow turn): sendTurn 3 attempts × (send 30s + snap.waitFor
 *     90s) + 2 retry sleeps 1s = 362s; the compaction turn itself adds ~3
 *     model round-trips (seconds each) inside the same snap.waitFor window
 *   - Phase 2 (panel text + divider): 3 × 60s = 180s
 *   - Phase 3 (panel surface DOM): 30s
 *   Total: ~722s; margin ≈ 25% → 900s (15 min). The global probe watchdog
 *   (KILO_E2E_TIMEOUT) stays the outer bound; this deadline only guarantees
 *   the service loop outlives every declared phase budget.
 */
const REAL_OVERFLOW_SERVICE_BUDGET = 900_000

/**
 * Extension-host service loop for the real-overflow scenario (H-13):
 *   1. settles the real session list and writes `real-overflow-ready`,
 *   2. backend truth: on each `of-snap-N-request` marker, executes the
 *      env-gated backendSnapshot fixture command against the shared served
 *      backend and writes `of-snap-N.json` (the harness asserts the typed
 *      compaction/overflow facts on it).
 * No panel close/reopen and no MCP disconnect — the panel stays open for the
 * whole scenario. Stops when the harness writes the `done` marker.
 */
async function serviceRealOverflowBoundary(
  vscodeApi: typeof vscode,
  scratch: string,
  fixtureId: string,
): Promise<void> {
  await resetLlmRequests(vscodeApi)
  await vscodeApi.commands.executeCommand(CMD_SETTLE)
  writeFileSync(join(scratch, "real-overflow-ready"), fixtureId)

  let snap = 1
  const deadline = Date.now() + REAL_OVERFLOW_SERVICE_BUDGET
  while (Date.now() < deadline) {
    if (existsSync(join(scratch, "done"))) break
    const req = join(scratch, `of-snap-${snap}-request`)
    if (existsSync(req)) {
      const snapshot = await vscodeApi.commands.executeCommand(CMD_SNAPSHOT)
      writeFileSync(join(scratch, `of-snap-${snap}.json`), JSON.stringify(snapshot, null, 2))
      snap += 1
    }
    await sleep(200)
  }
  await writeLlmRequestsEvidence(vscodeApi, scratch, "real-overflow")
}

/**
 * Service-window budget for the real-restart scenario (ms), derived from the
 * declared worst-case phase budgets in script/e2e-probe.ts
 * assertRealRestartLifecycle so a valid slow/retry-heavy run is never
 * abandoned while the harness is still inside its own declared budgets:
 *   - Phase 0 (agent pick + completed turn): sendTurn 3 attempts × (send 30s +
 *     snap.waitFor 90s) + 2 retry sleeps 1s = 362s + artifact wait 60s = 422s
 *   - Phase A (SSE reconnect observation + convergence): conn.json 120s +
 *     snapshot 90s + DOM asserts 90s = 300s
 *   - Phase B (kill + reconnect + rehydration): kill 60s + settle 30s +
 *     reconnect 180s + snapshot 90s + UI convergence 120s = 480s
 *   - Phase C (reloadWindow re-entry): reload 300s + fresh host ready 120s +
 *     snapshot 120s + DOM asserts 120s = 660s
 *   Total: ~1,862s; margin ≈ 10% → 2,100s (35 min). The global probe watchdog
 *   (KILO_E2E_TIMEOUT) stays the outer bound; this deadline only guarantees
 *   the service loop outlives every declared phase budget.
 */
const REAL_RESTART_SERVICE_BUDGET = 2_100_000

/**
 * Extension-host service loop for the real-restart scenario (Phase A/B entry,
 * or Phase C re-entry after the runner executed workbench.action.reloadWindow).
 *
 * Entry (no persisted rr-reload-request yet):
 *   1. settles the real session list and writes `rr-ready`,
 *   2. on `rr-conn-request`, executes the env-gated sseReconnect fixture
 *      command against the SHARED connection service (production
 *      SdkSSEAdapter.reconnect, backend left alive) and writes `rr-conn.json` —
 *      the fixture counts `server.connected` deliveries (the direct new-stream
 *      event), not `sync` envelopes (activity-driven, not guaranteed),
 *   3. on `rr-kill-request`, executes the exact-owned killServer fixture
 *      command (ServerManager's owner kill path — SIGTERM to the exact process
 *      group only) and writes `rr-kill.json` with the killed PID + port,
 *   4. on `rr-reconnect-request`, executes the production reconnect flow
 *      (getClientAsync → connect → replacement server + SSE) and writes
 *      `rr-reconnect.json` with the new PID/port/state,
 *   4b. on `rr-cstate-request`, executes the env-gated canonicalState fixture
 *       command (read-only CanonicalConfigService snapshot) and writes
 *       `rr-cstate.json` — the restartPhase0 H1/H2 diagnostic,
 *   5. on `rr-snap-N-request`, executes the backendSnapshot fixture command
 *      and writes `rr-snap-N.json`,
 *   6. on `rr-reload-request` (harness finished Phase B), writes
 *      `rr-reload-executed` and executes `workbench.action.reloadWindow` — the
 *      true window/extension restart. In --extensionTestsPath test mode the
 *      reload teardown exits the main process with this Extension Host (the
 *      fresh window never comes up in-place), so the harness treats that exit
 *      as the expected reload boundary and RELAUNCHES VS Code with identical
 *      args; the runner is torn down with the old Extension Host and the
 *      harness keeps the same scratch/user-data for the relaunch.
 *
 * Re-entry (fresh Extension Host after the relaunch; the persisted marker is
 * still on disk):
 *   7. ensures the Agent Manager panel is open (the webview-panel serializer
 *      restored it, or CMD_OPEN recreates it), settles the real session list,
 *      and writes `rr-reloaded` — the runner re-entry evidence the harness
 *      waits on (together with the changed `runner-pid`),
 *   8. services `rr-c-snap-N-request` snapshots (post-restart backend truth)
 *      until the harness writes `done`.
 * Stops when the harness writes the `done` marker (success or abort).
 */
// eslint-disable-next-line complexity
async function serviceRealRestartBoundary(vscodeApi: typeof vscode, scratch: string, fixtureId: string): Promise<void> {
  const reloadRequested = existsSync(join(scratch, "rr-reload-request"))
  if (reloadRequested) {
    await serviceRealRestartReloadPhase(vscodeApi, scratch, fixtureId)
    return
  }

  // LOCK-006/LOCK-008: reset the generation-request store at run start ONLY.
  // The persisted store must aggregate across the Phase B worker restart and
  // the Phase C reloadWindow relaunch, so no reset happens in the reload
  // re-entry above.
  await resetLlmRequests(vscodeApi)
  // Canonical credential provisioning (real SecretStorage, no bypass):
  // the seeded kilo.jsonc already carries the credential ref and default model;
  // store the secret through the production storeSecret path and converge
  // canonical state before the first UI assertion. Uses run-owned SecretStorage
  // and awaits materializationReady + hasCredential before writing evidence.
  try {
    const seeded = await vscodeApi.commands.executeCommand(CMD_SEED_CREDENTIAL)
    writeFileSync(join(scratch, "rr-credential.json"), JSON.stringify(seeded, null, 2))
  } catch {
    failCredential(scratch, "rr-credential.json")
  }
  await vscodeApi.commands.executeCommand(CMD_SETTLE)
  writeFileSync(join(scratch, "rr-ready"), fixtureId)

  let snap = 1
  let reloaded = false
  const deadline = Date.now() + REAL_RESTART_SERVICE_BUDGET
  while (Date.now() < deadline) {
    if (existsSync(join(scratch, "done"))) break

    const conn = join(scratch, "rr-conn-request")
    if (existsSync(conn)) {
      rmSync(conn)
      const obs = await vscodeApi.commands.executeCommand(CMD_SSE_RECONNECT)
      writeFileSync(join(scratch, "rr-conn.json"), JSON.stringify(obs, null, 2))
    }

    // Canonical-state probe (restartPhase0, before its agent-list assertion):
    // read-only CanonicalConfigService snapshot from the env-gated fixture
    // command — the H1/H2 discriminator for a recurring ModeSwitcher options=[].
    const cstate = join(scratch, "rr-cstate-request")
    if (existsSync(cstate)) {
      rmSync(cstate)
      const state = await vscodeApi.commands.executeCommand(CMD_CANONICAL_STATE)
      writeFileSync(join(scratch, "rr-cstate.json"), JSON.stringify(state, null, 2))
    }

    const credSeed = join(scratch, "rr-credseed-request")
    if (existsSync(credSeed)) {
      rmSync(credSeed)
      try {
        const seeded = await vscodeApi.commands.executeCommand(CMD_SEED_CREDENTIAL)
        writeFileSync(join(scratch, "rr-credential.json"), JSON.stringify(seeded, null, 2))
      } catch {
        failCredential(scratch, "rr-credential.json")
      }
    }

    const kill = join(scratch, "rr-kill-request")
    if (existsSync(kill)) {
      rmSync(kill)
      const killed = await vscodeApi.commands.executeCommand(CMD_KILL_SERVER)
      writeFileSync(join(scratch, "rr-kill.json"), JSON.stringify(killed, null, 2))
    }

    const rc = join(scratch, "rr-reconnect-request")
    if (existsSync(rc)) {
      rmSync(rc)
      const obs = await vscodeApi.commands.executeCommand(CMD_RECONNECT_SERVER)
      writeFileSync(join(scratch, "rr-reconnect.json"), JSON.stringify(obs, null, 2))
    }

    // Gate C: private peer status snapshot (non-secret backend pid/port/epoch + private negotiation)
    const privStatusReq = join(scratch, "rr-private-status-request")
    if (existsSync(privStatusReq)) {
      const raw = readFileSync(privStatusReq, "utf8")
      try {
        rmSync(privStatusReq)
      } catch (err) {
        console.warn("[Runner] cleanup rr-private-status-request failed:", String(err).slice(0, 200))
      }
      let nonce = ""
      try {
        nonce = (JSON.parse(raw) as { nonce?: string }).nonce ?? ""
      } catch (err) {
        console.warn("[Runner] malformed rr-private-status-request (redacted):", String(err).slice(0, 200))
      }
      const status = await vscodeApi.commands.executeCommand(CMD_PRIVATE_PEER_STATUS)
      writeFileSync(join(scratch, "rr-private-status.json"), JSON.stringify({ ...(status as object), nonce }, null, 2))
    }


    // Gate C: durable title mutation via SDK authoritative path + private same-key replay observation
    const titleReq = join(scratch, "rr-title-request")
    if (existsSync(titleReq)) {
      const raw = readFileSync(titleReq, "utf8")
      try {
        rmSync(titleReq)
      } catch (err) {
        console.warn("[Runner] cleanup rr-title-request failed:", String(err).slice(0, 200))
      }
      let payload: { sessionId: string; title: string; directory?: string; nonce?: string }
      try {
        payload = JSON.parse(raw)
      } catch (err) {
        console.warn("[Runner] malformed rr-title-request (redacted):", String(err).slice(0, 200))
        payload = { sessionId: "", title: "" }
      }
      const nonce = payload.nonce ?? ""
      // raw title exists only transiently in request payload; runner deletes promptly
      const { nonce: _n, ...cmdPayload } = payload
      const result = await vscodeApi.commands.executeCommand(CMD_SESSION_UPDATE, cmdPayload)
      const out = { ...(result as object), nonce }
      // ensure no raw title leaks into result file
      const serialized = JSON.stringify(out)
      if (payload.title && serialized.includes(payload.title)) {
        throw new Error("runner: title result leaked raw title")
      }
      writeFileSync(join(scratch, "rr-title-result.json"), JSON.stringify(out, null, 2))
    }

    // Gate C: same-key private replay without second SDK mutation (proves replay-only and revision convergence)
    const replayReq = join(scratch, "rr-replay-request")
    if (existsSync(replayReq)) {
      const raw = readFileSync(replayReq, "utf8")
      try {
        rmSync(replayReq)
      } catch (err) {
        console.warn("[Runner] cleanup rr-replay-request failed:", String(err).slice(0, 200))
      }
      let sid = raw.trim()
      let nonce = ""
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed === "string") sid = parsed
        else if (parsed && typeof parsed.sessionId === "string") {
          sid = parsed.sessionId
          nonce = parsed.nonce ?? ""
        } else if (parsed && typeof parsed.nonce === "string") {
          nonce = parsed.nonce
          sid = parsed.sessionId ?? sid
        }
      } catch (err) {
        console.warn("[Runner] malformed rr-replay-request (redacted):", String(err).slice(0, 200))
      }
      const result = await vscodeApi.commands.executeCommand(CMD_PRIVATE_REPLAY, sid)
      writeFileSync(join(scratch, "rr-replay-result.json"), JSON.stringify({ ...(result as object), nonce }, null, 2))
    }

    const req = join(scratch, `rr-snap-${snap}-request`)
    if (existsSync(req)) {
      const snapshot = await vscodeApi.commands.executeCommand(CMD_SNAPSHOT)
      writeFileSync(join(scratch, `rr-snap-${snap}.json`), JSON.stringify(snapshot, null, 2))
      snap += 1
    }

    const reload = join(scratch, "rr-reload-request")
    if (existsSync(reload) && !reloaded) {
      reloaded = true
      // Acknowledge BEFORE the reload tears this Extension Host down so the
      // harness can prove workbench.action.reloadWindow actually executed.
      writeFileSync(join(scratch, "rr-reload-executed"), String(process.pid))
      console.log("[probe runner] executing workbench.action.reloadWindow (true window/extension restart)")
      await vscodeApi.commands.executeCommand("workbench.action.reloadWindow")
      // This Extension Host is being torn down; stop servicing. The harness
      // relaunches VS Code with identical args and the fresh host re-runs this
      // runner, detecting the persisted rr-reload-request.
      return
    }

    await sleep(200)
  }
  await writeLlmRequestsEvidence(vscodeApi, scratch, "real-restart")
}

/**
 * Phase C of the real-restart scenario, running in the FRESH Extension Host
 * after workbench.action.reloadWindow (the window reload re-runs the
 * --extensionTestsPath runner; the persisted `rr-reload-request` marker tells
 * this instance it is the reload phase, not the initial entry). The fresh
 * Extension Host re-spawned the shared kilo serve backend (extension
 * deactivation disposed the old one), so the same run-owned XDG scratch holds
 * the persisted session + artifact; this loop settles the session list, proves
 * the panel is present, writes `rr-reloaded`, and services the post-restart
 * `rr-c-snap-N` backend snapshots until the harness writes `done`.
 */
async function serviceRealRestartReloadPhase(
  vscodeApi: typeof vscode,
  scratch: string,
  fixtureId: string,
): Promise<void> {
  // run() already executed CMD_OPEN (which reveals an existing restored panel
  // or opens a new one); wait for the fresh webview's readiness.
  await waitFor(
    async () => {
      try {
        const ready = await vscodeApi.commands.executeCommand<boolean>(CMD_READY)
        return ready ? true : undefined
      } catch {
        return undefined
      }
    },
    60_000,
    "real-restart reload phase: Agent Manager webview readiness",
  )
  await vscodeApi.commands.executeCommand(CMD_SETTLE)
  writeFileSync(join(scratch, "rr-reloaded"), fixtureId)

  let snap = 1
  const deadline = Date.now() + 600_000
  while (Date.now() < deadline) {
    if (existsSync(join(scratch, "done"))) break
    const req = join(scratch, `rr-c-snap-${snap}-request`)
    if (existsSync(req)) {
      const snapshot = await vscodeApi.commands.executeCommand(CMD_SNAPSHOT)
      writeFileSync(join(scratch, `rr-c-snap-${snap}.json`), JSON.stringify(snapshot, null, 2))
      snap += 1
    }
    await sleep(200)
  }
  await writeLlmRequestsEvidence(vscodeApi, scratch, "real-restart")
}

const CMD_R9_STATUS = "kilo-code.new.e2eFixture.privateObservationStatus"
const CMD_R9_SNAPSHOT = "kilo-code.new.e2eFixture.privateObservationSnapshot"
const CMD_R9_READ = "kilo-code.new.e2eFixture.privateObservationRead"
const CMD_R9_ACK = "kilo-code.new.e2eFixture.privateObservationAck"
const CMD_R9_RECONNECT = "kilo-code.new.e2eFixture.privateObservationReconnect"
const CMD_R9_MUTATE = "kilo-code.new.e2eFixture.privateObservationMutate"
const CMD_R9_SUBSCRIBE = "kilo-code.new.e2eFixture.privateObservationSubscribe"
const CMD_R9_WAIT_READY = "kilo-code.new.e2eFixture.privateObservationWaitReady"
const CMD_R9_PEER_CLOSED = "kilo-code.new.e2eFixture.privateObservationOnPeerClosed"
const CMD_R9_CLOSE_PEER = "kilo-code.new.e2eFixture.privateObservationClosePeer"
const CMD_R9_KILL = "kilo-code.new.e2eFixture.privateObservationKillWorker"
const CMD_R9_NOTIFICATIONS = "kilo-code.new.e2eFixture.privateObservationNotifications"
const CMD_R9_CLEAR_NOTIFICATIONS = "kilo-code.new.e2eFixture.privateObservationClearNotifications"
const R9_SERVICE_BUDGET = 900_000

async function serviceR9ObservationBoundary(
  vscodeApi: typeof vscode,
  scratch: string,
  fixtureId: string,
): Promise<void> {
  // Seed two sessions for session-switch boundary (production message path)
  const iso = new Date().toISOString()
  const plan = planIds(fixtureId)
  const r9Sessions = [session(plan.sourceId, plan.sourceTitle, iso), session(plan.siblingId, plan.siblingTitle, iso)]
  await post(vscodeApi, {
    type: "sessionsLoaded",
    sessions: r9Sessions,
  } satisfies SessionsLoadedMessage)
  await post(vscodeApi, {
    type: "agentManager.sessionAdded",
    sessionId: plan.sourceId,
  })
  await post(vscodeApi, {
    type: "sessionCreated",
    session: r9Sessions[0],
  } satisfies SessionCreatedMessage)
  await post(vscodeApi, {
    type: "sessionCreated",
    session: r9Sessions[1],
  } satisfies SessionCreatedMessage)
  for (const s of r9Sessions) {
    await post(vscodeApi, {
      type: "messagesLoaded",
      sessionID: s.id,
      messages: buildTopicTranscript(s.id),
    } satisfies MessagesLoadedMessage)
  }
  await post(vscodeApi, {
    type: "agentManager.sessionAdded",
    sessionId: plan.sourceId,
  })
  await vscodeApi.commands.executeCommand(CMD_SETTLE)
  await post(vscodeApi, {
    type: "sessionsLoaded",
    sessions: r9Sessions,
    preserveSessionIds: r9Sessions.map((s) => s.id),
  } satisfies SessionsLoadedMessage)

  // Fixture-side readiness: explicit bounded wait before first snapshot (preserves fire-and-forget activation)
  await vscodeApi.commands.executeCommand(CMD_R9_WAIT_READY, 10_000)
  const status0 = (await vscodeApi.commands.executeCommand(CMD_R9_STATUS)) as Record<string, unknown>
  writeFileSync(join(scratch, "r9-status.json"), JSON.stringify(status0, null, 2))
  try {
    const cstate = await vscodeApi.commands.executeCommand(CMD_CANONICAL_STATE)
    writeFileSync(join(scratch, "r9-cstate.json"), JSON.stringify(cstate, null, 2))
  } catch (e) {
    writeFileSync(join(scratch, "r9-cstate.json"), JSON.stringify({ error: String(e) }, null, 2))
  }
  // Subscribe evidence (required): invoke subscribe and include JSON-safe result — validated as v 1.0, integer cursor, subscribed:true
  const sub0Raw = (await vscodeApi.commands.executeCommand(CMD_R9_SUBSCRIBE)) as Record<string, unknown>
  if (
    sub0Raw.v !== "1.0" ||
    typeof sub0Raw.cursor !== "number" ||
    !Number.isInteger(sub0Raw.cursor) ||
    sub0Raw.subscribed !== true
  ) {
    throw new Error(`initial subscribe invalid: ${JSON.stringify(sub0Raw)}`)
  }
  const sub0 = sub0Raw
  // Initial snapshot/read/ack to establish cursor
  const snap0 = (await vscodeApi.commands.executeCommand(CMD_R9_SNAPSHOT)) as { cursor: number }
  // mutate to create changefeed entry then ack
  const mut1 = (await vscodeApi.commands.executeCommand(CMD_R9_MUTATE, {
    session_id: plan.sourceId,
    revision: 1,
    kind: "changed",
    time: 7000,
  })) as { cursor: number }
  const ack1 = (await vscodeApi.commands.executeCommand(CMD_R9_ACK, mut1.cursor)) as unknown
  writeFileSync(join(scratch, "r9-ack.json"), JSON.stringify({ snap0, mut1, ack1, status0, subscribe: sub0 }, null, 2))
  // Reset bounded notification recorder per fixture run (no second store)
  await vscodeApi.commands.executeCommand(CMD_R9_CLEAR_NOTIFICATIONS)
  writeFileSync(join(scratch, "r9-ready"), fixtureId)

  const boundaries: Array<{ name: string; action: () => Promise<unknown> }> = [
    {
      name: "panel",
      action: async () => {
        await vscodeApi.commands.executeCommand(CMD_R9_WAIT_READY, 5000)
        const tab = vscodeApi.window.tabGroups.all.flatMap((g) => g.tabs).find(isAgentManagerTab)
        if (!tab) throw new Error("r9 panel: Agent Manager tab not found")
        await vscodeApi.window.tabGroups.close(tab, true)
        await waitFor(async () => (agentManagerTabOpen() ? undefined : "closed"), 30_000, "r9 panel disposed")
        await vscodeApi.commands.executeCommand(CMD_OPEN)
        await waitFor(async () => (agentManagerTabOpen() ? true : undefined), 30_000, "r9 panel reopened")
        await waitFor(
          async () => {
            try {
              const ready = await vscodeApi.commands.executeCommand<boolean>(CMD_READY)
              return ready ? true : undefined
            } catch {
              return undefined
            }
          },
          60_000,
          "r9 panel readiness after reopen",
        )
        await vscodeApi.commands.executeCommand(CMD_SETTLE)
        await sleep(500)
        // Re-seed sessions after reopen — include full production tab path so topics + tabs converge even if webview state restore missed
        await post(vscodeApi, {
          type: "sessionsLoaded",
          sessions: r9Sessions,
          preserveSessionIds: r9Sessions.map((s) => s.id),
        } satisfies SessionsLoadedMessage)
        await post(vscodeApi, {
          type: "agentManager.sessionAdded",
          sessionId: r9Sessions[0]!.id,
        })
        await post(vscodeApi, {
          type: "sessionCreated",
          session: r9Sessions[0]!,
        } satisfies SessionCreatedMessage)
        await post(vscodeApi, {
          type: "sessionCreated",
          session: r9Sessions[1]!,
        } satisfies SessionCreatedMessage)
        await post(vscodeApi, {
          type: "agentManager.sessionAdded",
          sessionId: r9Sessions[0]!.id,
        })
        // Final authoritative re-seed after tab path so preserve wins
        await sleep(300)
        await post(vscodeApi, {
          type: "sessionsLoaded",
          sessions: r9Sessions,
          preserveSessionIds: r9Sessions.map((s) => s.id),
        } satisfies SessionsLoadedMessage)
        await sleep(500)
        // Ensure private observation ready after panel trigger debounce
        await vscodeApi.commands.executeCommand(CMD_R9_WAIT_READY, 10_000)
        return { kind: "panel" }
      },
    },
    {
      name: "reload",
      action: async () => {
        await vscodeApi.commands.executeCommand(CMD_R9_WAIT_READY, 5000)
        // Three-phase handshake: write reload-start, perform reload, wait for frame-ready
        writeFileSync(join(scratch, "r9-reload-start"), "ok")
        await vscodeApi.commands.executeCommand("workbench.action.webview.reloadWebviewAction")
        await waitForHarness(scratch, join(scratch, "r9-reload-frame"), 60_000, "r9-reload-frame")
        // re-seed after reload in fresh webview — include tab path for convergence
        await sleep(500)
        await post(vscodeApi, {
          type: "sessionsLoaded",
          sessions: r9Sessions,
          preserveSessionIds: r9Sessions.map((s) => s.id),
        } satisfies SessionsLoadedMessage)
        await post(vscodeApi, {
          type: "agentManager.sessionAdded",
          sessionId: r9Sessions[0]!.id,
        })
        await post(vscodeApi, {
          type: "sessionCreated",
          session: r9Sessions[0]!,
        } satisfies SessionCreatedMessage)
        await post(vscodeApi, {
          type: "sessionCreated",
          session: r9Sessions[1]!,
        } satisfies SessionCreatedMessage)
        await post(vscodeApi, {
          type: "agentManager.sessionAdded",
          sessionId: r9Sessions[0]!.id,
        })
        await sleep(300)
        await post(vscodeApi, {
          type: "sessionsLoaded",
          sessions: r9Sessions,
          preserveSessionIds: r9Sessions.map((s) => s.id),
        } satisfies SessionsLoadedMessage)
        await sleep(500)
        writeFileSync(join(scratch, "r9-reload-ready"), fixtureId)
        await vscodeApi.commands.executeCommand(CMD_R9_WAIT_READY, 10_000)
        return { kind: "reload" }
      },
    },
    {
      name: "switch",
      action: async () => {
        await vscodeApi.commands.executeCommand(CMD_R9_WAIT_READY, 5000)
        // Ordered handshake: probe initiates real sibling-tab click BEFORE after-state is captured.
        // Wait for probe's JSON-safe click confirmation marker (written after the real webview click + active verification)
        console.log("[probe runner] r9 switch: awaiting probe click confirmation r9-switch-clicked")
        const clickedPath = join(scratch, "r9-switch-clicked")
        const deadline = Date.now() + 30_000
        let clicked: Record<string, unknown> | null = null
        while (Date.now() < deadline) {
          if (existsSync(clickedPath)) {
            try {
              clicked = JSON.parse(readFileSync(clickedPath, "utf8"))
              if (clicked && typeof clicked.clickedTabId === "string") break
            } catch (err) {
              console.warn("[Runner] r9 switch marker malformed (redacted):", String(err).slice(0, 80))
            }
          }
          if (existsSync(join(scratch, "done")))
            throw new Error("r9 switch aborted: harness done before click confirmation")
          await sleep(200)
        }
        if (!clicked || typeof clicked.clickedTabId !== "string") {
          throw new Error("r9 switch: probe click confirmation r9-switch-clicked not found or invalid within 30s")
        }
        const clickedTabId = clicked.clickedTabId as string
        if (clickedTabId !== plan.siblingId) {
          throw new Error(
            `r9 switch clickedTabId mismatch expected ${plan.siblingId} got ${clickedTabId} payload=${JSON.stringify(clicked)}`,
          )
        }
        const activeTabId = (clicked as Record<string, unknown>).activeTabId as string | undefined
        console.log(
          `[probe runner] r9 switch click confirmed clicked=${clickedTabId} active=${activeTabId} payload=${JSON.stringify(clicked)}`,
        )
        // Give webview->extension message time to propagate, then ensure private observation ready
        await sleep(800)
        await vscodeApi.commands.executeCommand(CMD_R9_WAIT_READY, 5000)
        // Write durable confirmation marker BEFORE after-state capture — observable ordering in artifacts/run.log
        const confirmation = {
          clickedTabId,
          activeTabId: activeTabId ?? clickedTabId,
          at: new Date().toISOString(),
          selected: true,
        }
        writeFileSync(join(scratch, "r9-switch-confirmed"), JSON.stringify(confirmation, null, 2))
        console.log(
          `[probe runner] r9 switch confirmed marker written before finalizing r9-switch.json: ${JSON.stringify(confirmation)}`,
        )
        return { kind: "switch", switchConfirmation: confirmation }
      },
    },
    {
      name: "reconnect",
      action: async () => {
        await vscodeApi.commands.executeCommand(CMD_R9_WAIT_READY, 5000)
        // Materially distinct transport reconnect: close peer transport without killing worker, observed via onClosed -> lifecycle onPeerClosed
        const closeRes = (await vscodeApi.commands.executeCommand(CMD_R9_CLOSE_PEER)) as {
          before: { pid?: number; hostState: string }
          afterClose: {
            closeAlive: boolean
            closeAliveAfter?: boolean
            closed: boolean
            beforeAlive: boolean
            beforePid?: number
            afterPid?: number
          }
          after: { pid?: number; hostState: string }
          close: { aliveBefore: boolean; aliveAfter?: boolean; closed: boolean; beforePid?: number; afterPid?: number }
          trigger: { reason?: string; rehydrate?: boolean } | unknown
        }
        // Prove worker PID remained alive post-close before service replacement (distinct from exact-PID kill)
        // Require both aliveBefore and aliveAfter true plus same numeric PID immediately after peer disposal.
        const c = closeRes.close as {
          aliveBefore?: boolean
          aliveAfter?: boolean
          beforePid?: number
          afterPid?: number
          closed?: boolean
        }
        const ac = closeRes.afterClose as {
          closeAlive?: boolean
          closeAliveAfter?: boolean
          closed?: boolean
          beforePid?: number
          afterPid?: number
        }
        const aliveBefore = c.aliveBefore ?? ac.closeAlive
        const aliveAfter = c.aliveAfter ?? ac.closeAliveAfter
        const beforePid = c.beforePid ?? ac.beforePid
        const afterPid = c.afterPid ?? ac.afterPid
        const closed = c.closed ?? ac.closed
        if (!aliveBefore || !aliveAfter) {
          throw new Error(
            `reconnect peer close did not keep worker alive post-close before replacement: ${JSON.stringify(closeRes)}`,
          )
        }
        if (typeof beforePid !== "number" || typeof afterPid !== "number" || beforePid !== afterPid) {
          throw new Error(
            `reconnect peer close PID mismatch before ${beforePid} after ${afterPid}: ${JSON.stringify(closeRes)}`,
          )
        }
        if (!closed) {
          throw new Error(`reconnect peer close not observed as closed: ${JSON.stringify(closeRes)}`)
        }
        await vscodeApi.commands.executeCommand(CMD_R9_WAIT_READY, 10_000)
        // After reconnect, create fixture-gated changefeed mutation so a real observation/changed notification is captured
        const mut = (await vscodeApi.commands.executeCommand(CMD_R9_MUTATE, {
          session_id: `r9-reconnect-${Date.now()}`,
          revision: 1,
          kind: "changed",
          time: Date.now(),
        })) as { cursor: number }
        // Wait briefly for notification delivery via onNotification boundary
        await sleep(600)
        await vscodeApi.commands.executeCommand(CMD_R9_WAIT_READY, 5000)
        return { ...closeRes, postMutate: mut }
      },
    },
    {
      name: "restart",
      action: async () => {
        await vscodeApi.commands.executeCommand(CMD_R9_WAIT_READY, 5000)
        // Real eviction path: after acking cursor, append at least two entries beyond cursor with maxRows:1 so subsequent read is genuinely gapped
        const mut2 = (await vscodeApi.commands.executeCommand(CMD_R9_MUTATE, {
          session_id: plan.siblingId,
          revision: 2,
          kind: "changed",
          time: 7001,
        })) as { cursor: number }
        await vscodeApi.commands.executeCommand(CMD_R9_ACK, mut2.cursor)
        const evict1 = (await vscodeApi.commands.executeCommand(CMD_R9_MUTATE, {
          session_id: "r9-evict-1",
          revision: 1,
          kind: "changed",
          time: 7002,
          caps: { maxRows: 1, maxBytes: 1024 },
        })) as { cursor: number }
        const evict2 = (await vscodeApi.commands.executeCommand(CMD_R9_MUTATE, {
          session_id: "r9-evict-2",
          revision: 1,
          kind: "changed",
          time: 7003,
          caps: { maxRows: 1, maxBytes: 1024 },
        })) as { cursor: number }
        // Exact-PID worker restart: terminate exact active private worker child PID, wait for exit, call reconnect, require different after PID + no live pending
        const killRes = (await vscodeApi.commands.executeCommand(CMD_R9_KILL)) as {
          beforePid?: number
          after: { pid?: number; pendingPid: number | null; pendingAlive: boolean; hostState: string }
        }
        if (killRes.beforePid === killRes.after.pid)
          throw new Error(`restart pid did not change before ${killRes.beforePid} after ${killRes.after.pid}`)
        if (killRes.after.pendingAlive) throw new Error(`restart pending child still alive ${killRes.after.pendingPid}`)
        if (killRes.after.hostState !== "open") throw new Error(`restart hostState not open ${killRes.after.hostState}`)
        const statusAfter = (await vscodeApi.commands.executeCommand(CMD_R9_STATUS)) as Record<string, unknown>
        writeFileSync(
          join(scratch, "r9-evict.json"),
          JSON.stringify({ mut2, evict1, evict2, killRes, statusAfter }, null, 2),
        )
        return { mut2, evict1, evict2, killRes }
      },
    },
  ]

  const collected: unknown[] = []
  const deadline = Date.now() + R9_SERVICE_BUDGET
  let idx = 0
  // eslint-disable-next-line complexity
  async function runBoundary(b: (typeof boundaries)[number]): Promise<void> {
    await vscodeApi.commands.executeCommand(CMD_R9_WAIT_READY, 5000)
    // Preserve bounded recorder across boundary: monotonic ordinal watermark independent of bounded 50 retention
    // Do NOT use array length as watermark; use nextOrdinal. Truncated windows are explicitly unproven.
    const beforeRaw = (await vscodeApi.commands.executeCommand(CMD_R9_NOTIFICATIONS)) as unknown
    const beforeNotifSnap = (() => {
      if (
        beforeRaw &&
        typeof beforeRaw === "object" &&
        !Array.isArray(beforeRaw) &&
        "entries" in (beforeRaw as Record<string, unknown>) &&
        "nextOrdinal" in (beforeRaw as Record<string, unknown>)
      ) {
        return beforeRaw as { startOrdinal: number; nextOrdinal: number; entries: unknown[] }
      }
      const arr = (Array.isArray(beforeRaw) ? beforeRaw : []) as unknown[]
      return { startOrdinal: 0, nextOrdinal: arr.length, entries: arr }
    })()
    const watermarkOrdinal = beforeNotifSnap.nextOrdinal
    const notifBefore = [...beforeNotifSnap.entries]
    const beforeSnapMeta = beforeNotifSnap
    const beforeStatus = (await vscodeApi.commands.executeCommand(CMD_R9_STATUS)) as {
      pid?: number
      hostState: string
      persistedCursor?: number
      enabled: boolean
      dbPath: string
    }
    const beforeObsSnap = (await vscodeApi.commands.executeCommand(CMD_R9_SNAPSHOT)) as {
      cursor: number
      snapshot?: unknown
    }
    const beforeReadRaw =
      beforeStatus.persistedCursor !== undefined
        ? ((await vscodeApi.commands.executeCommand(CMD_R9_READ, beforeStatus.persistedCursor)) as {
            rehydrate: boolean
            cursor: number
            entries?: unknown[]
          })
        : { rehydrate: false, cursor: beforeObsSnap.cursor, entries: [] as unknown[] }
    const before = {
      pid: beforeStatus.pid,
      hostState: beforeStatus.hostState,
      cursor: beforeObsSnap.cursor,
      rehydrate: beforeReadRaw.rehydrate,
    }
    const beforeEntries = (beforeReadRaw as { entries?: unknown[] }).entries ?? []
    const actionRes = await b.action()
    // debounce + bounded reconnect window: poll for hostState open up to 5s after action
    const start = Date.now()
    let afterStatus: { pid?: number; hostState: string; persistedCursor?: number; enabled: boolean } | null = null
    while (Date.now() - start < 5000) {
      const s = (await vscodeApi.commands.executeCommand(CMD_R9_STATUS)) as {
        pid?: number
        hostState: string
        persistedCursor?: number
        enabled: boolean
      }
      if (s.hostState === "open" && s.pid !== undefined) {
        afterStatus = s
        break
      }
      await sleep(200)
    }
    if (!afterStatus) {
      afterStatus = (await vscodeApi.commands.executeCommand(CMD_R9_STATUS)) as {
        pid?: number
        hostState: string
        persistedCursor?: number
        enabled: boolean
      }
    }
    const afterSnap = (await vscodeApi.commands.executeCommand(CMD_R9_SNAPSHOT)) as { cursor: number }
    const afterReadRaw =
      afterStatus.persistedCursor !== undefined
        ? ((await vscodeApi.commands.executeCommand(CMD_R9_READ, afterStatus.persistedCursor)) as {
            rehydrate: boolean
            cursor: number
            entries?: unknown[]
          })
        : { rehydrate: false, cursor: afterSnap.cursor, entries: [] as unknown[] }
    const after = {
      pid: afterStatus.pid,
      hostState: afterStatus.hostState,
      cursor: afterSnap.cursor,
      rehydrate: afterReadRaw.rehydrate,
    }
    const afterEntries = (afterReadRaw as { entries?: unknown[] }).entries ?? []
    // Capture bounded notification sequence after the boundary and derive duplicate/continuity from observed sequence IDs
    // Ordinal watermark: only deliveries with ordinal >= watermarkOrdinal belong to this boundary; truncated = watermark < startOrdinal => unproven
    const afterRaw = (await vscodeApi.commands.executeCommand(CMD_R9_NOTIFICATIONS)) as unknown
    const afterSnap2 = (() => {
      if (
        afterRaw &&
        typeof afterRaw === "object" &&
        !Array.isArray(afterRaw) &&
        "entries" in (afterRaw as Record<string, unknown>) &&
        "nextOrdinal" in (afterRaw as Record<string, unknown>)
      ) {
        return afterRaw as { startOrdinal: number; nextOrdinal: number; entries: unknown[] }
      }
      const arr = (Array.isArray(afterRaw) ? afterRaw : []) as unknown[]
      return { startOrdinal: 0, nextOrdinal: arr.length, entries: arr }
    })()
    const truncated = watermarkOrdinal < afterSnap2.startOrdinal
    const notifAfter = (() => {
      const hasOrdinal =
        afterSnap2.entries.length > 0 &&
        afterSnap2.entries[0] !== null &&
        typeof (afterSnap2.entries[0] as Record<string, unknown>).ordinal === "number"
      if (hasOrdinal) {
        return (afterSnap2.entries as Array<Record<string, unknown>>).filter(
          (e) => (e.ordinal as number) >= watermarkOrdinal,
        ) as unknown[]
      }
      // Legacy fallback: slice by watermark length approximation; if truncated, return empty to force unproven
      if (truncated) return [] as unknown[]
      const arr = afterSnap2.entries
      const startIdx = Math.max(0, arr.length - (afterSnap2.nextOrdinal - watermarkOrdinal))
      return arr.slice(startIdx)
    })()
    const afterSnapMeta = afterSnap2
    // eslint-disable-next-line complexity
    const validateEnvelope = (item: unknown): string | undefined => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return "notification must be object"
      const r = item as Record<string, unknown>
      if (r.method !== "observation/changed") return `method must be observation/changed got ${String(r.method)}`
      const params = r.params as Record<string, unknown> | undefined
      if (!params || typeof params !== "object" || Array.isArray(params)) return "params must be object"
      if (params.v !== "1.0") return `v must be 1.0 got ${String(params.v)}`
      if (
        typeof params.cursor !== "number" ||
        !Number.isInteger(params.cursor) ||
        params.cursor < 0 ||
        !Number.isSafeInteger(params.cursor)
      )
        return `cursor must be integer >=0 got ${String(params.cursor)}`
      const entries = params.entries as unknown
      if (!Array.isArray(entries) || entries.length === 0) return "entries must be non-empty array"
      for (const e of entries) {
        if (!e || typeof e !== "object" || Array.isArray(e)) return "entry must be object"
        const en = e as Record<string, unknown>
        if (typeof en.seq !== "number" || !Number.isInteger(en.seq) || en.seq < 0 || !Number.isSafeInteger(en.seq))
          return `seq must be integer >=0 got ${String(en.seq)}`
        if (typeof en.session_id !== "string" || en.session_id.length === 0)
          return `session_id must be non-empty string got ${String(en.session_id)}`
        if (typeof en.revision !== "number" || !Number.isInteger(en.revision))
          return `revision must be integer got ${String(en.revision)}`
        if (en.kind !== "changed" && en.kind !== "deleted") return `kind must be changed/deleted got ${String(en.kind)}`
        if (typeof en.time !== "number") return `time must be number got ${String(en.time)}`
      }
      const maxSeq = Math.max(...(entries as Array<Record<string, unknown>>).map((e) => e.seq as number))
      if (params.cursor !== maxSeq) return `cursor ${String(params.cursor)} must equal max seq ${String(maxSeq)}`
      return undefined
    }
    const strictBeforeErr = (() => {
      for (let i = 0; i < notifBefore.length; i++) {
        const err = validateEnvelope(notifBefore[i])
        if (err) return `before notifications[${i}] invalid: ${err}`
      }
      return undefined
    })()
    if (strictBeforeErr && notifBefore.length > 0) throw new Error(strictBeforeErr)
    const strictAfterErr = (() => {
      for (let i = 0; i < notifAfter.length; i++) {
        const err = validateEnvelope(notifAfter[i])
        if (err) return `after notifications[${i}] invalid: ${err}`
      }
      return undefined
    })()
    if (strictAfterErr) throw new Error(strictAfterErr)
    const extractSeqs = (list: unknown[]): number[] => {
      const out: number[] = []
      for (const item of list) {
        if (item && typeof item === "object") {
          const r = item as Record<string, unknown>
          const params = r.params as Record<string, unknown> | undefined
          const entries = params?.entries as unknown[] | undefined
          if (Array.isArray(entries)) {
            for (const e of entries)
              if (e && typeof e === "object" && typeof (e as Record<string, unknown>).seq === "number")
                out.push((e as Record<string, unknown>).seq as number)
          }
          if (typeof r.seq === "number") out.push(r.seq)
        }
      }
      return out
    }
    const beforeSeqsArr = extractSeqs(notifBefore)
    const afterSeqsArr = extractSeqs(notifAfter)
    const beforeSeqs = new Set(beforeSeqsArr)
    let duplicate = false
    for (const s of afterSeqsArr) if (beforeSeqs.has(s)) duplicate = true
    // Truncated watermark is explicitly unproven — duplicate/continuity fails regardless of seq values
    if (truncated) duplicate = true
    // duplicate also if same seq repeats within after delta
    {
      const seenAfter = new Set<number>()
      for (const s of afterSeqsArr) {
        if (seenAfter.has(s)) duplicate = true
        seenAfter.add(s)
      }
      // gap detection within after delta: must be contiguous +1
      for (let i = 1; i < afterSeqsArr.length; i++) {
        if (afterSeqsArr[i] !== afterSeqsArr[i - 1]! + 1) duplicate = true
      }
    }
    if (after.cursor < before.cursor) duplicate = true
    // Continuity derived from observed sequence progression, plus separate cursor monotonicity
    let seqContinuity = true
    let gapAcross: string | undefined
    if (truncated) {
      // Bounded 50 retention evicted the watermark — continuity unproven, fail explicitly
      seqContinuity = false
      gapAcross = `truncated watermark ${watermarkOrdinal} < after start ${afterSnapMeta.startOrdinal}`
    } else if (afterSeqsArr.length > 0) {
      // within-after contiguous check
      for (let i = 1; i < afterSeqsArr.length; i++) {
        if (afterSeqsArr[i] !== afterSeqsArr[i - 1]! + 1) seqContinuity = false
      }
      if (beforeSeqsArr.length > 0) {
        const maxBefore = Math.max(...beforeSeqsArr)
        const minAfter = Math.min(...afterSeqsArr)
        if (minAfter <= maxBefore) seqContinuity = false
        else if (minAfter !== maxBefore + 1) {
          seqContinuity = false
          gapAcross = `gap across boundary ${maxBefore} -> ${minAfter}`
        }
      }
    } else {
      // No observed delivery — continuity fails for reconnect/restart unless explicit no-change contract
      if (b.name === "reconnect" || b.name === "restart") seqContinuity = false
    }
    const cursorMonotonic = after.cursor >= before.cursor
    const continuity = seqContinuity && cursorMonotonic && !truncated
    if ((b.name === "reconnect" || b.name === "restart") && notifAfter.length === 0) {
      throw new Error(
        `${b.name} after notifications empty — valid changed delivery required (before ${before.cursor} after ${after.cursor} notifs ${notifAfter.length})`,
      )
    }
    // Restart must have rehydrate true due to genuine gap; verify via read
    let rehydrate = afterReadRaw.rehydrate
    if (b.name === "restart" && !rehydrate)
      throw new Error("restart boundary expected rehydrate:true but got false (gap not proven)")
    const ev: Record<string, unknown> = {
      boundary: b.name,
      before,
      after,
      duplicate,
      continuity,
      rehydrate,
      beforeEntriesCount: beforeEntries.length,
      afterEntriesCount: afterEntries.length,
      notifications: { before: notifBefore, after: notifAfter },
      notificationsBefore: notifBefore,
      notificationsAfter: notifAfter,
      actionResult: actionRes,
      notes: [
        `before pid ${before.pid} after ${after.pid}`,
        `beforeEntries ${beforeEntries.length} afterEntries ${afterEntries.length}`,
        `notifs before ${notifBefore.length} after ${notifAfter.length}`,
      ],
    }
    // Include validated subscribe result in required runtime output (do not swallow errors)
    if (b.name === "reconnect" || b.name === "restart") {
      try {
        const sub = (await vscodeApi.commands.executeCommand(CMD_R9_SUBSCRIBE)) as Record<string, unknown>
        const subErr = (() => {
          if (!sub || typeof sub !== "object") return "subscribe not object"
          const o = sub as Record<string, unknown>
          if (o.v !== "1.0") return `subscribe v must be 1.0 got ${String(o.v)}`
          if (typeof o.cursor !== "number" || !Number.isInteger(o.cursor))
            return `subscribe cursor must be integer got ${String(o.cursor)}`
          if (o.subscribed !== true) return `subscribe subscribed must be true got ${String(o.subscribed)}`
          return undefined
        })()
        if (subErr) throw new Error(subErr)
        ev.subscribe = sub
      } catch (e) {
        // Do not swallow subscribe failures — record as failed boundary
        const msg = String(e)
        ev.subscribeError = msg
        throw new Error(`subscribe failed for ${b.name}: ${msg}`)
      }
    }
    // Surface trigger reason for transport reconnect
    if (
      b.name === "reconnect" &&
      actionRes &&
      typeof actionRes === "object" &&
      "trigger" in (actionRes as Record<string, unknown>)
    ) {
      ev.trigger = (actionRes as Record<string, unknown>).trigger
    }
    if (
      b.name === "restart" &&
      actionRes &&
      typeof actionRes === "object" &&
      "killRes" in (actionRes as Record<string, unknown>)
    ) {
      ev.kill = (actionRes as Record<string, unknown>).killRes
    }
    if (
      b.name === "switch" &&
      actionRes &&
      typeof actionRes === "object" &&
      "switchConfirmation" in (actionRes as Record<string, unknown>)
    ) {
      ev.switchConfirmation = (actionRes as Record<string, unknown>).switchConfirmation
      ev.switch = (actionRes as Record<string, unknown>).switchConfirmation
    }
    if (duplicate) throw new Error(`duplicate notification detected for ${b.name}`)
    if (!continuity) throw new Error(`continuity failed for ${b.name}`)
    writeFileSync(join(scratch, `r9-${b.name}.json`), JSON.stringify(ev, null, 2))
    collected.push(ev)
  }

  while (Date.now() < deadline && idx < boundaries.length) {
    if (existsSync(join(scratch, "done"))) break
    const name = boundaries[idx]!.name
    const req = join(scratch, `r9-${name}-request`)
    if (existsSync(req)) {
      rmSync(req)
      await runBoundary(boundaries[idx]!)
      idx += 1
    }
    // Also handle snapshot markers for probe convenience
    const snapReq = join(scratch, `r9-snap-${idx}-request`)
    if (existsSync(snapReq)) {
      const snap = await vscodeApi.commands.executeCommand(CMD_R9_SNAPSHOT)
      writeFileSync(join(scratch, `r9-snap-${idx}.json`), JSON.stringify(snap, null, 2))
    }
    await sleep(200)
  }
  // If harness never drove some boundaries (focused helper not used), run remaining directly
  while (idx < boundaries.length && !existsSync(join(scratch, "done"))) {
    await runBoundary(boundaries[idx]!)
    idx += 1
  }
  const runtime = {
    scenario: "r9-observation",
    collectedAt: new Date().toISOString(),
    pid: process.pid,
    canonical: {
      dbPath: (status0 as { dbPath?: string }).dbPath ?? "unknown",
      gateOk: true,
    },
    testBridge: (status0 as { testBridge?: boolean }).testBridge ?? false,
    boundaries: collected,
    finalDom: { boundaries: collected.length },
  }
  writeFileSync(join(scratch, "r9-observation-runtime-evidence"), JSON.stringify(runtime, null, 2))
  // Final DOM evidence placeholder — probe will overwrite with real frame URL
  writeFileSync(join(scratch, "r9-dom-evidence"), JSON.stringify({ url: "runner", plan, runtime }, null, 2))
  // Ensure status/cstate still present for harness final check
  const finalStatus = await vscodeApi.commands.executeCommand(CMD_R9_STATUS)
  writeFileSync(join(scratch, "r9-status.json"), JSON.stringify(finalStatus, null, 2))
}

const LC_SERVICE_BUDGET = 900_000

async function serviceRealLifecycleBoundary(
  vscodeApi: typeof vscode,
  scratch: string,
  fixtureId: string,
): Promise<void> {
  await resetLlmRequests(vscodeApi)
  try {
    const seeded = await vscodeApi.commands.executeCommand(CMD_SEED_CREDENTIAL)
    writeFileSync(join(scratch, "lc-credential.json"), JSON.stringify(seeded, null, 2))
  } catch {
    failCredential(scratch, "lc-credential.json")
  }
  await vscodeApi.commands.executeCommand(CMD_SETTLE)
  writeFileSync(join(scratch, "lc-ready"), fixtureId)
  let snap = 1
  const deadline = Date.now() + LC_SERVICE_BUDGET
  while (Date.now() < deadline) {
    if (existsSync(join(scratch, "done"))) break
    const cstate = join(scratch, "lc-cstate-request")
    if (existsSync(cstate)) {
      rmSync(cstate)
      const state = await vscodeApi.commands.executeCommand(CMD_CANONICAL_STATE)
      writeFileSync(join(scratch, "lc-cstate.json"), JSON.stringify(state, null, 2))
    }
    const credSeed = join(scratch, "lc-credseed-request")
    if (existsSync(credSeed)) {
      rmSync(credSeed)
      try {
        const seeded = await vscodeApi.commands.executeCommand(CMD_SEED_CREDENTIAL)
        writeFileSync(join(scratch, "lc-credential.json"), JSON.stringify(seeded, null, 2))
      } catch {
        failCredential(scratch, "lc-credential.json")
      }
    }
    const privReq = join(scratch, "lc-private-status-request")
    if (existsSync(privReq)) {
      const raw = load(privReq)
      drop(privReq)
      const { nonce } = parsePrivateStatus(raw)
      const status = await vscodeApi.commands.executeCommand(CMD_PRIVATE_PEER_STATUS)
      writeFileSync(join(scratch, "lc-private-status.json"), JSON.stringify({ ...(status as object), nonce }, null, 2))
    }
    const titleReq = join(scratch, "lc-title-request")
    if (existsSync(titleReq)) {
      const raw = load(titleReq)
      drop(titleReq)
      const { sessionId, title, nonce } = parseTitle(raw)
      const cmdPayload = { sessionId, title }
      const result = await vscodeApi.commands.executeCommand(CMD_SESSION_UPDATE, cmdPayload)
      const out = { ...(result as object), nonce }
      const serialized = JSON.stringify(out)
      if (title && serialized.includes(title)) throw new Error("runner: title result leaked raw title")
      writeFileSync(join(scratch, "lc-title-result.json"), JSON.stringify(out, null, 2))
    }
    const replayReq = join(scratch, "lc-replay-request")
    if (existsSync(replayReq)) {
      const raw = load(replayReq)
      drop(replayReq)
      const { sessionId: sid, nonce } = parseReplay(raw)
      const result = await vscodeApi.commands.executeCommand(CMD_PRIVATE_REPLAY, sid)
      writeFileSync(join(scratch, "lc-replay-result.json"), JSON.stringify({ ...(result as object), nonce }, null, 2))
    }
    const snapReq = join(scratch, `lc-snap-${snap}-request`)
    if (existsSync(snapReq)) {
      const snapshot = await vscodeApi.commands.executeCommand(CMD_SNAPSHOT)
      writeFileSync(join(scratch, `lc-snap-${snap}.json`), JSON.stringify(snapshot, null, 2))
      snap += 1
    }
    const settleReq = join(scratch, "lc-settle-request")
    if (existsSync(settleReq)) {
      rmSync(settleReq)
      await vscodeApi.commands.executeCommand(CMD_SETTLE)
      writeFileSync(join(scratch, "lc-settle-done"), fixtureId)
    }
    const panelClose = join(scratch, "lc-panel-close-request")
    if (existsSync(panelClose)) {
      rmSync(panelClose)
      const amTab = vscodeApi.window.tabGroups.all.flatMap((group) => group.tabs).find(isAgentManagerTab)
      if (!amTab) throw new Error("probe runner: Agent Manager tab not found for lc panel close")
      await vscodeApi.window.tabGroups.close(amTab, true)
      await waitFor(async () => (agentManagerTabOpen() ? undefined : "closed"), 30_000, "lc panel disposed")
      await vscodeApi.commands.executeCommand(CMD_OPEN)
      await waitFor(async () => (agentManagerTabOpen() ? true : undefined), 30_000, "lc reopened panel present")
      await waitFor(
        async () => {
          try {
            const ready = await vscodeApi.commands.executeCommand<boolean>(CMD_READY)
            return ready ? true : undefined
          } catch {
            return undefined
          }
        },
        60_000,
        "lc reopened webview readiness",
      )
      await vscodeApi.commands.executeCommand(CMD_SETTLE)
      writeFileSync(join(scratch, "lc-panel-close-ready"), fixtureId)
    }
    const reloadReq = join(scratch, "lc-reload-request")
    if (existsSync(reloadReq)) {
      rmSync(reloadReq)
      await vscodeApi.commands.executeCommand(CMD_RELOAD_AM)
      await vscodeApi.commands.executeCommand(CMD_SETTLE)
      writeFileSync(join(scratch, "lc-reload-ready"), fixtureId)
    }
    await sleep(200)
  }
  await writeLlmRequestsEvidence(vscodeApi, scratch, "real-lifecycle")
}
