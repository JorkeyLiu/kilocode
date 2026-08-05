/**
 * Extension Host E2E runner — child task open tab-order case.
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
 *        - source session A + sibling session B as the only initial tabs,
 *        - child session C known to the backend store but NOT opened as a tab,
 *        - A's transcript contains a production `task` tool part whose metadata
 *          points at C (renders the real sub-agent link in the Agent Manager),
 *   5. calls the fixture bridge's `settleSessions` handshake: the extension
 *      awaits the real backend session-list refresh (including any deferred
 *      refresh flushed when the CLI connection comes up), then re-seeds a
 *      full `sessionsLoaded` for [A, B, C] with `preserveSessionIds`. Because
 *      session-list loads are serialized and this re-seed is posted last, no
 *      later refresh can reconcile the fixture sessions away — the fixture
 *      survival is deterministic, with no timer polling or provider/network
 *      dependence,
 *   6. writes `<scratch>/ready` + `<scratch>/plan.json`, then blocks until the
 *      harness (Playwright over CDP) asserts the tab order, clicks the real
 *      "Open sub-agent in tab" button in source's chat, and verifies the child
 *      lands immediately right of A,
 *   7. on the harness's `phase1-done` marker, re-selects A so the harness can
 *      re-click the button and prove an already-open child is focused WITHOUT
 *      reordering, then writes `<scratch>/phase2-ready`,
 *   8. exits when the harness writes `<scratch>/done`, so VS Code exits 0.
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

// --- Fixture session IDs (deterministic per run; shared with the harness via plan.json) ---

function planIds(fixtureId: string) {
  return {
    sourceId: `${fixtureId}-A`,
    siblingId: `${fixtureId}-B`,
    childId: `${fixtureId}-C`,
    sourceTitle: "E2E Source",
    siblingTitle: "E2E Sibling",
    childTitle: "E2E Child",
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

export async function run(): Promise<void> {
  const scratch = process.env.KILO_E2E_SCRATCH
  const fixtureId = process.env.KILO_E2E_FIXTURE_ID
  if (!scratch || !fixtureId) {
    throw new Error("probe runner: missing KILO_E2E_SCRATCH / KILO_E2E_FIXTURE_ID env")
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

  writeFileSync(join(scratch, "ready"), fixtureId)

  // Test-owned hang control: KILO_E2E_FIXTURE_HANG keeps the runner alive
  // after readiness so the harness watchdog can exercise exact-owned process
  // termination (LOCK-004). Set only by the failure-path verification run.
  if (process.env.KILO_E2E_FIXTURE_HANG) {
    await new Promise<void>(() => {})
  }

  // Phase 1: harness asserts [A, B], clicks the real sub-agent link, asserts
  // [A, C, B] + active C, then writes phase1-done.
  await waitForHarness(scratch, join(scratch, "phase1-done"), 120_000, "harness phase1-done marker")

  // Phase 2: re-select the source so the harness can re-click the link and
  // prove an already-open child is focused without reordering.
  await post(vscode, {
    type: "agentManager.sessionAdded",
    sessionId: plan.sourceId,
    worktreeId: "local",
  })
  writeFileSync(join(scratch, "phase2-ready"), fixtureId)

  await waitForHarness(scratch, join(scratch, "done"), 120_000, "harness done marker")
  writeFileSync(join(scratch, "runner-done"), "ok")
}
