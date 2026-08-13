/**
 * Extension Host E2E runner — child task open tab-order case, active-tab close
 * successor case, and in-session per-agent variant memory case.
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
 *   9. exits when the harness writes `<scratch>/done`, so VS Code exits 0.
 *
 * Scenario selection (KILO_E2E_SCENARIO, set by the harness):
 *   - (unset) | all      => tab-close, then child-task-order, then
 *                           variant-memory, sequentially, in this one VS Code
 *                           lifecycle,
 *   - tab-close          => seeds only the tab-close fixtures (TA, TB, TC) and
 *                           runs only that scenario,
 *   - child-task-order   => seeds only the child fixtures (A, B, C) and runs
 *                           only the child phases,
 *   - variant-memory     => seeds only the variant fixture (D) and skips the
 *                           other scenarios entirely.
 *   Scenarios are independent: each seeds only its own fixtures and coordinates
 *   through scenario-specific markers (tab-close-done, child-phase1-done /
 *   child-phase2-ready / child-phase2-done, variant-ready). `ready`, `done`,
 *   `runner-done` are process-level harness gates, not scenario state.
 *
 * All seeding goes through the env-gated fixture bridge (KILO_E2E_FIXTURE only)
 * and the production Agent Manager message/rendering/tab logic. No ordering
 * logic and no click handler is replaced.
 */

import * as vscode from "vscode"
import { existsSync, writeFileSync } from "node:fs"
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
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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

/** Full production SessionInfo shape (parentID/revert/summary explicitly set). */
function session(id: string, title: string, iso: string): SessionInfo {
  return { id, title, createdAt: iso, updatedAt: iso, parentID: null, revert: null, summary: null }
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

export async function run(): Promise<void> {
  const scratch = process.env.KILO_E2E_SCRATCH
  const fixtureId = process.env.KILO_E2E_FIXTURE_ID
  if (!scratch || !fixtureId) {
    throw new Error("probe runner: missing KILO_E2E_SCRATCH / KILO_E2E_FIXTURE_ID env")
  }
  // LOCK-002/003: seed only the selected scenario(s); each scenario's fixtures
  // and markers stay independent of the other.
  const scenario = process.env.KILO_E2E_SCENARIO ?? "all"
  const runTabClose = scenario === "all" || scenario === "tab-close"
  const runChild = scenario === "all" || scenario === "child-task-order"
  const runVariant = scenario === "all" || scenario === "variant-memory"
  if (!runTabClose && !runChild && !runVariant) {
    throw new Error(
      `probe runner: unknown KILO_E2E_SCENARIO "${scenario}". ` +
        "Supported values: all | tab-close | child-task-order | variant-memory (default: all)",
    )
  }
  writeFileSync(join(scratch, "runner-alive"), "started")

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
      worktreeId: "local",
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
      worktreeId: "local",
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
      worktreeId: "local",
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
      worktreeId: "local",
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
      worktreeId: "local",
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
      worktreeId: "local",
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

  await waitForHarness(scratch, join(scratch, "done"), 120_000, "harness done marker")
  writeFileSync(join(scratch, "runner-done"), "ok")
}
