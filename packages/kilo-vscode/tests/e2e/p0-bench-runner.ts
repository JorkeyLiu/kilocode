/**
 * Extension Host E2E runner for the P0 benchmark harness (scenarios 1,2,3,4,5,10).
 *
 * Loaded by VS Code through `--extensionTestsPath` (bundled to CJS by
 * script/e2e-p0-bench.ts). Runs inside a real Extension Host alongside the
 * current workspace extension and:
 *
 *   1. activates the extension,
 *   2. opens the Agent Manager webview via the real `kilo-code.new.agentManagerOpen`
 *      command and waits for webview readiness through the env-gated fixture
 *      bridge (KILO_E2E_FIXTURE only),
 *   3. seeds the scenario's real fixtures via production message shapes:
 *        - cold-type scenarios (cold-start / no-provider / custom-provider /
 *          many-agent-mcp) seed nothing in the webview — the harness seeded
 *          the scratch XDG kilo config before launch and the extension/backend
 *          resolve it for real,
 *        - warm-view seeds nothing; the harness drives close/reopen cycles
 *          through `cycle-<n>-close` / `cycle-<n>-open` markers while the
 *          shared backend worker stays live,
 *        - session-switch seeds N deterministic sessions (sessionsLoaded +
 *          sessionCreated + sessionAdded + a per-session transcript) so the
 *          real tab strip renders 5 Playwright-clickable tabs,
 *   4. writes `<scratch>/ready` + `<scratch>/plan.json`, then coordinates with
 *      the harness through scenario markers,
 *   5. exits when the harness writes `<scratch>/done`, so VS Code exits 0.
 *
 * All seeding goes through the env-gated fixture bridge and the production
 * Agent Manager message/rendering/tab logic. No ordering logic and no click
 * handler is replaced. KILO_P0_PERF=1 (set by the harness) activates the
 * opt-in P0 instrumentation on the extension host and (via the extension's
 * spawn env) the backend.
 */

import * as vscode from "vscode"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Message, SessionInfo } from "../../webview-ui/src/types/messages/sessions"
import type {
  MessagesLoadedMessage,
  SessionCreatedMessage,
  SessionsLoadedMessage,
} from "../../webview-ui/src/types/messages/extension-messages"

const EXTENSION_ID = "kilocode.kilo-code"
const CMD_OPEN = "kilo-code.new.agentManagerOpen"
const CMD_READY = "kilo-code.new.e2eFixture.agentManagerReady"
const CMD_POST = "kilo-code.new.e2eFixture.postToAgentManager"

const AM_VIEW_TYPE = "kilo-code.new.AgentManagerPanel"

/** Number of seeded sessions for the session-switch scenario (default 5). */
const SWITCH_SESSIONS = Number(process.env.KILO_P0_SWITCH_SESSIONS ?? 5)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`p0 runner: timeout waiting for ${label}`)
    await sleep(200)
  }
}

/** Wait for a harness marker, aborting early if the harness already failed. */
async function waitForHarness(scratch: string, target: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(target)) return
    if (existsSync(join(scratch, "done"))) {
      throw new Error(`p0 runner: harness aborted before ${label} (done marker present)`)
    }
    if (Date.now() > deadline) throw new Error(`p0 runner: timeout waiting for ${label}`)
    await sleep(200)
  }
}

async function post(vscodeApi: typeof vscode, msg: unknown): Promise<void> {
  await vscodeApi.commands.executeCommand(CMD_POST, msg)
}

/** Full production SessionInfo shape. */
function session(id: string, title: string, iso: string): SessionInfo {
  return { id, title, createdAt: iso, updatedAt: iso, parentID: null, revert: null, summary: null }
}

/** A minimal user message whose content carries a per-session marker. */
function markerMessage(sessionId: string, marker: string): Message[] {
  const now = Date.now()
  const msg: Message = {
    id: `${sessionId}-msg-marker`,
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
    content: `P0 switch marker ${marker}`,
  }
  return [msg]
}

/** Close the Agent Manager editor tab (disposes the webview panel) via real VS Code APIs. */
async function closeAgentManagerPanel(): Promise<void> {
  // VS Code prefixes webview-panel tab inputs with `mainThreadWebview-`; match
  // on the suffix so the check is robust across versions.
  const isAmTab = (tab: vscode.Tab): boolean => {
    const viewType = (tab.input as { viewType?: string } | undefined)?.viewType ?? ""
    return viewType === AM_VIEW_TYPE || viewType.endsWith(AM_VIEW_TYPE)
  }
  const allTabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs)
  const amTab = allTabs.find(isAmTab)
  if (!amTab) {
    console.log("[p0-runner] closeAgentManagerPanel: no Agent Manager tab found (already closed)")
    return
  }
  const closed = await vscode.window.tabGroups.close(amTab)
  console.log(`[p0-runner] closeAgentManagerPanel: tabGroups.close returned ${closed}`)
  // Wait until the tab is actually gone so a subsequent reopen creates a fresh
  // panel (fresh webview load + dataReady gate) rather than revealing a stale one.
  await waitFor(
    async () => {
      const remaining = vscode.window.tabGroups.all.some((group) => group.tabs.some(isAmTab))
      return remaining ? undefined : true
    },
    15_000,
    "Agent Manager panel disposal",
  )
}

export async function run(): Promise<void> {
  const scratch = process.env.KILO_P0_SCRATCH
  const fixtureId = process.env.KILO_P0_FIXTURE_ID
  const scenario = process.env.KILO_P0_SCENARIO
  if (!scratch || !fixtureId || !scenario) {
    throw new Error("p0 runner: missing KILO_P0_SCRATCH / KILO_P0_FIXTURE_ID / KILO_P0_SCENARIO env")
  }
  writeFileSync(join(scratch, "runner-alive"), "started")

  const ext = vscode.extensions.getExtension(EXTENSION_ID)
  if (!ext) throw new Error("p0 runner: extension not found in host")
  await ext.activate()

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

  if (scenario === "session-switch") {
    // Deterministic session set: N tabs with distinct titles + transcripts.
    const plan = {
      fixtureId,
      sessions: Array.from({ length: SWITCH_SESSIONS }, (_, i) => ({
        id: `${fixtureId}-SW${i + 1}`,
        title: `P0 Switch ${i + 1}`,
      })),
    }
    writeFileSync(join(scratch, "plan.json"), JSON.stringify(plan, null, 2))

    await post(vscode, {
      type: "sessionsLoaded",
      sessions: plan.sessions.map((s) => session(s.id, s.title, iso)),
    } satisfies SessionsLoadedMessage)

    for (const s of plan.sessions) {
      await post(vscode, {
        type: "sessionCreated",
        session: session(s.id, s.title, iso),
      } satisfies SessionCreatedMessage)
      await post(vscode, {
        type: "agentManager.sessionAdded",
        sessionId: s.id,
        worktreeId: "local",
      })
      await post(vscode, {
        type: "messagesLoaded",
        sessionID: s.id,
        messages: markerMessage(s.id, s.title.replace("P0 Switch ", "S")),
      } satisfies MessagesLoadedMessage)
    }

    // Deterministic survival handshake, mirroring the existing E2E runner:
    // await the real backend session-list refresh, then re-seed the full list
    // with preserveSessionIds so no later refresh reconciles the fixtures away.
    await vscode.commands.executeCommand("kilo-code.new.e2eFixture.settleSessions")
    await post(vscode, {
      type: "sessionsLoaded",
      sessions: plan.sessions.map((s) => session(s.id, s.title, iso)),
      preserveSessionIds: plan.sessions.map((s) => s.id),
    } satisfies SessionsLoadedMessage)

    // Deterministic starting state: the last seeded tab is the active one.
    await post(vscode, {
      type: "agentManager.sessionAdded",
      sessionId: plan.sessions[0]!.id,
      worktreeId: "local",
    })

    writeFileSync(join(scratch, "ready"), fixtureId)
    await waitForHarness(scratch, join(scratch, "done"), 300_000, "harness done marker")
    writeFileSync(join(scratch, "runner-done"), "ok")
    return
  }

  writeFileSync(join(scratch, "plan.json"), JSON.stringify({ fixtureId, scenario }, null, 2))
  writeFileSync(join(scratch, "ready"), fixtureId)

  if (scenario === "warm-view") {
    // Harness drives close/reopen cycles: cycle N closes the panel, the harness
    // records the reopened dataReady gate, and asks for the next close.
    const cycles = Number(process.env.KILO_P0_CYCLES ?? 1)
    for (let cycle = 1; cycle <= cycles; cycle++) {
      console.log(`[p0-runner] warm-view cycle ${cycle}: waiting for close marker`)
      await waitForHarness(scratch, join(scratch, `cycle-${cycle}-close`), 120_000, `cycle-${cycle}-close marker`)
      console.log(`[p0-runner] warm-view cycle ${cycle}: closing Agent Manager panel`)
      await closeAgentManagerPanel()
      writeFileSync(join(scratch, `cycle-${cycle}-closed`), fixtureId)
      console.log(`[p0-runner] warm-view cycle ${cycle}: closed marker written`)
      await waitForHarness(scratch, join(scratch, `cycle-${cycle}-open`), 120_000, `cycle-${cycle}-open marker`)
      console.log(`[p0-runner] warm-view cycle ${cycle}: reopening Agent Manager`)
      await vscode.commands.executeCommand(CMD_OPEN)
      await waitFor(
        async () => {
          const ready = await vscode.commands.executeCommand<boolean>(CMD_READY)
          return ready ? true : undefined
        },
        60_000,
        `cycle-${cycle} Agent Manager panel readiness`,
      )
      writeFileSync(join(scratch, `cycle-${cycle}-opened`), fixtureId)
      console.log(`[p0-runner] warm-view cycle ${cycle}: reopened marker written`)
    }
  }

  await waitForHarness(scratch, join(scratch, "done"), 120_000, "harness done marker")
  writeFileSync(join(scratch, "runner-done"), "ok")
}
