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
 *      session D, loads a transcript pinning `kilo/e2e-probe`, calls
 *      `provisionVariantModel` LAST so the synthetic providersLoaded stays the
 *      final provider message, re-seeds the session list so D survives, then
 *      writes `variant-ready`,
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
const CMD_MCP_DISCONNECT = "kilo-code.new.e2eFixture.mcpDisconnect"
const CMD_SSE_RECONNECT = "kilo-code.new.e2eFixture.sseReconnect"
const CMD_KILL_SERVER = "kilo-code.new.e2eFixture.killServer"
const CMD_RECONNECT_SERVER = "kilo-code.new.e2eFixture.reconnectServer"
const CMD_LLM_REQUESTS = "kilo-code.new.e2eFixture.llmRequests"
const CMD_LLM_RESET = "kilo-code.new.e2eFixture.llmRequestsReset"
const CMD_OPEN_TAB_READY = "kilo-code.new.e2eFixture.openInTabReady"
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
  runSidebarRemoval: boolean
  runWorktreeRemoval: boolean
  runCloudClawRemoval: boolean
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
    // P3.1 sidebar-removal is focused-only: it asserts manifest absence and
    // opens an "Open in Tab" editor panel (no synthetic fixtures, no CDP DOM
    // driving — all assertions run extension-host-side).
    runSidebarRemoval: scenario === "sidebar-removal",
    // P3.2 worktree-removal is focused-only: it asserts runtime manifest /
    // command-table absence of the managed-worktree + custom Diff Viewer
    // surfaces, seeds two root-local sessions, and drives the bounded H-12
    // rollback phase against the run-owned scripted provider (real backend
    // sessions — never part of `all`).
    runWorktreeRemoval: scenario === "worktree-removal",
    // P3.3 cloud-claw-removal is focused-only: it asserts runtime manifest /
    // command-table / bundle-list absence of the removed cloud-session, KiloClaw,
    // local Console, and JetBrains product surfaces, then proves the retained
    // Open-in-Tab and Agent Manager surfaces stay ready. No synthetic fixtures,
    // no CDP DOM driving, no model requests — all assertions run
    // extension-host-side and are recorded into
    // `<scratch>/cloud-claw-removal-runtime-evidence`.
    runCloudClawRemoval: scenario === "cloud-claw-removal",
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
    "sidebar-removal",
    "worktree-removal",
    "cloud-claw-removal",
  ])
  if (!supported.has(scenario)) {
    throw new Error(
      `probe runner: unknown KILO_E2E_SCENARIO "${scenario}". ` +
        "Supported values: all | tab-close | child-task-order | variant-memory | topic-navigation | real-session | real-completed | real-overflow | real-restart | sidebar-removal | worktree-removal | cloud-claw-removal (default: all)",
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
    runSidebarRemoval,
    runWorktreeRemoval,
    runCloudClawRemoval,
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
  await runRemovalScenarios(vscode, ext, scratch, fixtureId, runSidebarRemoval, runWorktreeRemoval, runCloudClawRemoval)

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
    // The models.dev snapshot ships no model with ≥2 reasoning variants, so the
    // fixture bridge injects one into the real served catalog AND pins it as
    // the per-agent model for every backend agent (so switching agents keeps
    // the variant-bearing model). The runner opens a session whose recovery
    // selects it, then re-provisions the catalog LAST so the synthetic
    // providersLoaded stays the final provider message the webview processes.
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
  // hands the harness three extension-owned view boundaries over the migration
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

  await waitForHarness(scratch, join(scratch, "done"), 120_000, "harness done marker")
  writeFileSync(join(scratch, "runner-done"), "ok")
}

/**
 * Dispatch the focused P3 removal scenarios (P3.1 sidebar, P3.2 worktree, P3.3
 * cloud/KiloClaw/Console/JetBrains). Extracted from run() to keep its ESLint
 * complexity under the cap. Each scenario proves one removed product surface
 * is absent while the retained editor surfaces (Open in Tab / Agent Manager)
 * stay ready; all assertions run extension-host-side.
 */
async function runRemovalScenarios(
  vscodeApi: typeof vscode,
  ext: vscode.Extension<unknown>,
  scratch: string,
  fixtureId: string,
  runSidebarRemoval: boolean,
  runWorktreeRemoval: boolean,
  runCloudClawRemoval: boolean,
): Promise<void> {
  // P3.1 sidebar-removal: proves the ordinary single-chat Activity Bar sidebar
  // is gone from the loaded manifest, and that the "Open in Tab" session editor
  // survives without it — the production openInTab command opens a real TabPanel
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
  // retained Open-in-Tab and Agent Manager surfaces still become ready
  // (LOCK-008). No synthetic fixtures, no CDP DOM driving, and no model
  // requests or external calls; evidence in
  // `<scratch>/cloud-claw-removal-runtime-evidence`.
  if (runCloudClawRemoval) {
    await assertCloudClawRemoval(vscodeApi, ext, scratch, fixtureId)
  }
}

/**
 * P3.1 sidebar-removal assertions (extension-host side):
 *   1. the loaded manifest contributes no Activity Bar sidebar surface under
 *      the forbidden ids/prefixes (kilo-code-ActivityBar /
 *      kilo-code.SidebarProvider / sidebarTitle.*) — identifier-based, so
 *      unrelated future views are not banned,
 *   2. the production "Open in Tab" command opens a TabPanel whose webview
 *      reaches readiness (env-gated fixture bridge),
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

  const probe = await vscodeApi.commands.executeCommand<{ count: number; ready: boolean }>(CMD_OPEN_TAB_READY)
  if (!probe || probe.count < 1 || !probe.ready) {
    throw new Error(`probe runner: Open in Tab panel did not become ready: ${JSON.stringify(probe)}`)
  }

  const amReady = await vscodeApi.commands.executeCommand<boolean>(CMD_READY)
  if (!amReady) throw new Error("probe runner: Agent Manager readiness lost after tab-panel open (P3.1)")

  writeFileSync(join(scratch, "sidebar-removal-ready"), fixtureId)
}

/** Forbidden P3.2 surface regex (managed worktree / run-script / transfer / custom diff). */
const FORBIDDEN_SURFACE = /worktree|runScript|setupScript|gitTransfer|diffViewer|diff-viewer|diff-virtual|showChanges|apply|import/i

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
    throw new Error(`probe runner: loaded manifest still exposes a forbidden P3.2 surface (${JSON.stringify(forbidden)})`)
  }
  return {
    declaredCommands,
    contributedViewIds: Object.values(views).flat().map((v) => v.id ?? ""),
    configProps,
    forbidden,
  }
}

/**
 * P3.2 runtime command-table check (part 2 of assertWorktreeRemoval): the
 * RUNTIME command table must contain no registered kilo-code worktree /
 * run-script / transfer / diff-viewer command — removed feature initialization
 * must be absent (LOCK-PERF-3) — while the retained root-local surface
 * commands exist (agentManagerOpen / openInTab / agentManager.newTab). Throws
 * on any violation and returns the runtime evidence.
 */
async function assertNoForbiddenRuntimeCommands(vscodeApi: typeof vscode): Promise<{
  kiloCommands: string[]
  runtimeForbidden: string[]
}> {
  const kiloCommands = (await vscodeApi.commands.getCommands(true)).filter((c) => c.startsWith("kilo-code."))
  const runtimeForbidden = kiloCommands.filter((c) => FORBIDDEN_SURFACE.test(c))
  if (runtimeForbidden.length > 0) {
    throw new Error(`probe runner: runtime command table still registers forbidden P3.2 commands: ${runtimeForbidden.join(", ")}`)
  }
  for (const retained of ["kilo-code.new.agentManagerOpen", "kilo-code.new.openInTab", "kilo-code.new.agentManager.newTab"]) {
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
    throw new Error(`probe runner: runtime created worktree state in the run-owned workspace (${JSON.stringify(state)})`)
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
            openInTab: runtime.kiloCommands.includes("kilo-code.new.openInTab"),
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
 *   4. retained surfaces stay ready: the production "Open in Tab" editor panel
 *      opens and reaches webview readiness, and the Agent Manager panel still
 *      reports readiness (LOCK-008).
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

  const probe = await vscodeApi.commands.executeCommand<{ count: number; ready: boolean }>(CMD_OPEN_TAB_READY)
  if (!probe || probe.count < 1 || !probe.ready) {
    throw new Error(`probe runner: Open in Tab panel did not become ready: ${JSON.stringify(probe)}`)
  }
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
            openInTab: runtime.kiloCommands.includes("kilo-code.new.openInTab"),
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
          openInTab: { panels: probe.count, ready: probe.ready },
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
    throw new Error(`probe runner: loaded manifest still exposes a forbidden P3.3 product surface (${JSON.stringify(forbidden)})`)
  }
  return {
    declaredCommands,
    contributedViewIds: Object.values(views).flat().map((v) => v.id ?? ""),
    configProps,
    forbidden,
  }
}

/**
 * P3.3 runtime command-table check (part 2 of assertCloudClawRemoval): the
 * RUNTIME command table must contain no registered removed-product command
 * (LOCK-PERF-3) while the retained root-local surface commands exist
 * (agentManagerOpen / openInTab / agentManager.newTab). Throws on any
 * violation and returns the runtime evidence.
 */
async function assertNoForbiddenProductRuntimeCommands(vscodeApi: typeof vscode): Promise<{
  kiloCommands: string[]
  runtimeForbidden: string[]
}> {
  const kiloCommands = (await vscodeApi.commands.getCommands(true)).filter((c) => c.startsWith("kilo-code."))
  const runtimeForbidden = kiloCommands.filter((c) => FORBIDDEN_PRODUCT_IDS.includes(c))
  if (runtimeForbidden.length > 0) {
    throw new Error(`probe runner: runtime command table still registers forbidden P3.3 commands: ${runtimeForbidden.join(", ")}`)
  }
  for (const retained of ["kilo-code.new.agentManagerOpen", "kilo-code.new.openInTab", "kilo-code.new.agentManager.newTab"]) {
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
    throw new Error(`probe runner: built dist/ still contains forbidden P3.3 product bundles: ${forbiddenBundleHits.join(", ")}`)
  }
  return { distDir, bundleFiles, forbiddenBundleHits }
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
 *   2. panel close/reopen: on `real-reopen-request`, closes the Agent Manager
 *      editor tab, reopens it, waits for the fresh webview's readiness,
 *      settles the real session list, then writes `real-reopen-ready` so the
 *      harness can assert transcript rehydration from the real backend.
 * Stops when the harness writes the `done` marker (success or abort).
 */
async function serviceRealSessionBoundary(vscodeApi: typeof vscode, scratch: string, fixtureId: string): Promise<void> {
  await resetLlmRequests(vscodeApi)
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
