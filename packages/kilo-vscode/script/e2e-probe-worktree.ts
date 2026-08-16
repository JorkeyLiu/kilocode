/**
 * P3.2 worktree-removal focused scenario + the shared bounded H-12 rollback
 * phase for the real VS Code E2E probe (script/e2e-probe.ts). Extracted from
 * the probe so the probe file stays under its maxLines cap; this module is
 * Node-only, test-only, and never bundles into the extension.
 *
 * The worktree-removal scenario proves in a REAL Extension Host that:
 *   1. the loaded manifest + runtime command table expose no managed worktree
 *      or custom Diff Viewer surface (extension-host assertions recorded in
 *      `worktree-removal-runtime-evidence`, re-asserted here fail-fast),
 *   2. root-local Agent Manager orchestration survives: two root-local
 *      sessions seed through the production session-open path (no worktree
 *      dimension) and are CONTROLLABLE over the real webview — both tabs
 *      render, clicking each switches the active tab, and the derived Topic
 *      sidebar has no worktree markers (LOCK-008),
 *   3. no `.kilo/worktrees` / `.kilo/agent-manager.json` / setup-script state
 *      is created anywhere in the run-owned workspace + XDG scratch,
 *   4. the bounded H-12 rollback (assertRealRollbackPhase, SHARED with the
 *      real-completed campaign) proves Revert-to-here restores the exact
 *      original bytes and Redo All restores the edited bytes through the
 *      retained chat UI (LOCK-007/H-12).
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Browser, Frame } from "@playwright/test"
import type { BackendSnapshot, SessionTruth } from "../src/agent-manager/fixture-backend"
import { createScriptedModel, SCRIPTED, type ScriptedModelHandle } from "./e2e-scripted-model"
import { initWorkspaceGit, writeWorktreeRemovalSeed } from "./e2e-completed-seed"
import { assertRunOwnedLlmRequests, readLlmRequests } from "./e2e-llm-matrix"
import { pinExpect, pinReport, type PinExpectation } from "./e2e-pin"
import {
  activeTabId,
  assertNoWorktree,
  clickRevertToHere,
  clickTab,
  clickTabClose,
  expectBannerFile,
  expectTranscriptText,
  findAgentManagerFrameAny,
  pickAgent,
  pickVariant,
  realTabStates,
  sendTurnWithPin,
  sidebarTopicStates,
  sleep,
  snapshotClient,
  waitForAgentOption,
  waitForFile,
  waitForFileBytes,
  waitForLabel,
  waitForModelSelected,
  waitForNoSessionTabs,
  waitForRealSessionTabs,
  type E2EPlan,
} from "./e2e-probe-dom"

/** The two H-12 rollback prompts typed into the real prompt input. */
export const REAL_ROLLBACK_PROMPT = `${SCRIPTED.rollbackMarker}: edit the tracked file`
export const REAL_ROLLBACK_SUMMARY_PROMPT = `${SCRIPTED.rollbackSummaryMarker}: summarize the edit`

/** The root (non-child) session in the real scenarios. */
export function realRootSession(s: BackendSnapshot): SessionTruth | undefined {
  return s.sessions.find((x) => !x.parentID)
}

/** Completed tool-part of one session transcript (all messages). */
export function completedTool(s: BackendSnapshot, sessionID: string, tool: string) {
  return (s.messages[sessionID] ?? []).flatMap((m) => m.tools ?? []).find((t) => t.tool === tool)
}

/** Poll until the given webview DOM selector matches at least one element. */
export async function waitForDock(frame: Frame, selector: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = await frame
      .locator(selector)
      .count()
      .catch(() => 0)
    if (hit > 0) {
      console.log(`[probe] PASS ${label}`)
      return
    }
    if (Date.now() > deadline) {
      const body = await frame.locator("body").innerText().catch(() => "<unreadable>")
      throw new Error(`probe: ${label} failed: selector "${selector}" not found.\nbody:\n${body.slice(0, 1200)}`)
    }
    await sleep(250)
  }
}

/** Poll until the given webview DOM selector matches nothing. */
export async function waitForNoDock(frame: Frame, selector: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = await frame
      .locator(selector)
      .count()
      .catch(() => 0)
    if (hit === 0) {
      console.log(`[probe] PASS ${label}`)
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`probe: ${label} failed: selector "${selector}" still present`)
    }
    await sleep(250)
  }
}

/** The shared sendTurn callable the rollback phase drives. */
export type RollbackSendTurn = (
  target: Frame,
  prompt: string,
  probe: (s: BackendSnapshot) => string | undefined,
  label: string,
) => Promise<BackendSnapshot>

/**
 * Bounded H-12 rollback phase — SHARED by the real-completed campaign (Phase 9,
 * after the panel reopen) and the P3.2 worktree-removal scenario (Phase 3, on
 * the original panel). Drives the REAL Agent Manager webview through two
 * completed turns against the run-owned scripted provider — the production
 * write tool edits a tracked file, then a plain summary turn — and then clicks
 * the real user-message "Revert to here" control. Production
 * SessionRevert+Snapshot restores the exact initial bytes, the RevertBanner
 * renders the per-file diff, and the real "Redo All" button invokes production
 * unrevert and restores the edited bytes. Asserts served-backend
 * revert/checkpoint facts and lifecycle correctness. Returns the revert
 * boundary user-message id for the caller's evidence.
 */
export async function assertRealRollbackPhase(
  rf: Frame,
  snap: ReturnType<typeof snapshotClient>,
  model: ScriptedModelHandle,
  workspace: string,
  timeout: number,
  plan: E2EPlan,
  sendTurn: RollbackSendTurn,
): Promise<string> {
    // The panel (rf) is showing the root session (opened in Phase 7 or by the
    // first rollback send), so the two rollback turns go through the FRESH
    // webview document against the same served backend session. The tracked
    // rollback file is committed in the run-owned git workspace; the production
    // write tool edits it, Revert-to-here runs production SessionRevert+Snapshot
    // and restores the exact initial bytes, the RevertBanner renders the
    // per-file diff, and Redo All invokes the production unrevert path and
    // restores the edited bytes.
    //
    // The fresh webview document re-resolves its model from scratch: until the
    // served config/catalog resolve, the model selector falls through to the
    // gateway KILO_AUTO free model (kilo/kilo-auto/free) — the only live
    // gateway-fallback window in the real scenarios — so BEFORE the first send
    // on this document, explicitly wait for the visible custom agent + variant
    // and the visible custom model selection (LOCK-006/LOCK-012).
    await waitForAgentOption(rf, plan.customAgentLabel, timeout)
    await pickAgent(rf, plan.customAgentLabel, timeout)
    await waitForLabel(rf, ".mode-switcher-trigger-label", plan.customAgentLabel, timeout, "custom agent selected (reopened panel)")
    await pickVariant(rf, plan.customVariantA, timeout)
    await waitForLabel(rf, ".thinking-selector-trigger-label", plan.customVariantA, timeout, "variant Low selected (reopened panel)")
    await waitForModelSelected(rf, plan.customProvider, plan.customModel, timeout, "custom model visibly selected (reopened panel)")

    const rollbackFile = join(workspace, SCRIPTED.rollbackFile)
    const readRollback = () => (existsSync(rollbackFile) ? readFileSync(rollbackFile, "utf8") : "<missing>")

    // 9a. Turn 1: the real write tool edits the tracked file (production path).
    await sendTurn(
      rf,
      REAL_ROLLBACK_PROMPT,
      (s) => {
        const root = realRootSession(s)
        if (!root) return "root session missing"
        const tool = completedTool(s, root.id, "write")
        if (!tool) {
          const pending = (s.pending?.permissions ?? []).filter((p) => p.sessionID === root.id)
          return (
            `write tool part missing; session=${s.statuses[root.id] ?? "idle"}` +
            (pending.length > 0 ? `; pending-permissions=${JSON.stringify(pending)}` : "; no pending permissions")
          )
        }
        if (tool.status !== "completed") return `write status=${tool.status}`
        if (!tool.output?.includes("Wrote file successfully")) {
          return `write output=${JSON.stringify(tool.output?.slice(0, 300))}`
        }
        if ((s.statuses[root.id] ?? "idle") !== "idle") return `parent status=${s.statuses[root.id]} expected idle`
        return undefined
      },
      "H-12 write: completed write tool part in the backend",
    )
    if (readRollback() !== SCRIPTED.rollbackEdited) {
      throw new Error(`probe: H-12 tracked file not edited after the write turn: ${JSON.stringify(readRollback())}`)
    }
    console.log(`[probe] PASS H-12 tracked file edited: ${rollbackFile} = ${JSON.stringify(SCRIPTED.rollbackEdited)}`)
    await expectTranscriptText(rf, SCRIPTED.rollbackFinal, 60_000, "H-12 panel shows the edit completion text")

    // 9b. Turn 2: a plain-text summary turn so the revert boundary covers TWO
    // user turns and the real RevertBanner renders its "Redo All" action.
    const snapSummary = await sendTurn(
      rf,
      REAL_ROLLBACK_SUMMARY_PROMPT,
      (s) => {
        const root = realRootSession(s)
        if (!root) return "root session missing"
        const users = (s.messages[root.id] ?? []).filter((m) => m.role === "user")
        if (users.length < 2) return `expected at least 2 user messages, got ${users.length}`
        if ((s.statuses[root.id] ?? "idle") !== "idle") return `parent status=${s.statuses[root.id]} expected idle`
        return undefined
      },
      "H-12 summary: second user turn completes and the session is idle",
    )
    await expectTranscriptText(rf, SCRIPTED.rollbackSummaryFinal, 60_000, "H-12 panel shows the summary text")

    // The revert boundary is the FIRST rollback user message (the edit turn).
    const summaryRoot = realRootSession(snapSummary)
    const editUserMsg = (summaryRoot ? snapSummary.messages[summaryRoot.id] ?? [] : []).find(
      (m) => m.role === "user" && m.text.includes(SCRIPTED.rollbackMarker),
    )
    if (!editUserMsg || !editUserMsg.id) {
      throw new Error("probe: H-12 edit user message missing from the backend transcript")
    }
    const editMessageID = editUserMsg.id
    console.log(`[probe] H-12 revert boundary user message: ${editMessageID}`)

    // 9c. Click the real user-message "Revert to here" button (hover-revealed
    // production control; the same DOM a user clicks).
    await clickRevertToHere(rf, editMessageID, 30_000)

    // 9d. Backend: active revert/checkpoint fact + exact initial bytes restored.
    await snap.waitFor(
      (s) => {
        const root = realRootSession(s)
        if (!root) return "root session missing"
        const rev = root.revert
        if (!rev) return "session.revert missing (Revert-to-here did not set the checkpoint)"
        if (rev.messageID !== editMessageID) {
          return `session.revert.messageID=${JSON.stringify(rev.messageID)} expected ${editMessageID}`
        }
        if (!rev.snapshot) return "session.revert.snapshot missing (no checkpoint hash)"
        const diffs = root.summary?.diffs ?? []
        if (!diffs.some((d) => d.file === SCRIPTED.rollbackFile)) {
          return `session.summary.diffs missing ${SCRIPTED.rollbackFile}: ${JSON.stringify(diffs)}`
        }
        return undefined
      },
      90_000,
      "H-12 backend revert/checkpoint fact + summary diff",
    )
    await waitForFileBytes(rollbackFile, SCRIPTED.rollbackOriginal, 30_000, "H-12 exact initial bytes restored")
    console.log(
      `[probe] PASS H-12 restored bytes: ${rollbackFile} = ${JSON.stringify(SCRIPTED.rollbackOriginal)}`,
    )

    // 9e. UI: the RevertBanner is visible with the per-file diff row.
    await waitForDock(rf, ".revert-banner", 60_000, "H-12 RevertBanner visible")
    await expectBannerFile(rf, SCRIPTED.rollbackFile, 30_000, "H-12 RevertBanner lists the reverted file")

    // 9f. Click the real "Redo All" button (production unrevert path).
    const redoAll = rf
      .locator('.revert-banner-actions [data-component="button"]')
      .filter({ hasText: "Redo All" })
      .first()
    await redoAll.waitFor({ state: "visible", timeout: 30_000 })
    await redoAll.click({ timeout: 30_000 })
    console.log("[probe] clicked RevertBanner Redo All (production unrevert path)")

    // 9g. Backend: checkpoint cleared, edited bytes restored, session idle/clean.
    await snap.waitFor(
      (s) => {
        const root = realRootSession(s)
        if (!root) return "root session missing"
        if (root.revert) return "session.revert still set after Redo All"
        if ((s.statuses[root.id] ?? "idle") !== "idle") return `parent status=${s.statuses[root.id]} expected idle`
        return undefined
      },
      90_000,
      "H-12 Redo All clears the backend checkpoint and the session stays idle",
    )
    await waitForFileBytes(rollbackFile, SCRIPTED.rollbackEdited, 30_000, "H-12 edited bytes restored by Redo All")
    await waitForNoDock(rf, ".revert-banner", 30_000, "H-12 RevertBanner gone after Redo All")
    await expectTranscriptText(rf, SCRIPTED.rollbackSummaryFinal, 60_000, "H-12 reverted turns re-shown in the transcript")
    console.log("[probe] PASS H-12 rollback lifecycle passed")
    return editMessageID
}

/**
 * Read-only recursive scan for managed-worktree state markers in a run-owned
 * directory tree (never deletes). Flags exactly what the removed features
 * persisted: managed checkouts under `.kilo/worktrees/`, the old
 * WorktreeStateManager's `.kilo/agent-manager.json`, setup-script files, and
 * `worktreeId` / `"worktrees"` content markers in JSON/Markdown files. Skips
 * node_modules and .git (never a managed-worktree surface). Core-schema
 * singular `worktree` fields (Session/Project roots) are NOT flagged — only
 * the removed managed-worktree identifiers.
 */
export function scanWorktreeState(dir: string): {
  worktreeDirs: string[]
  agentManagerJson: string[]
  setupScripts: string[]
  markerFiles: string[]
} {
  const out = {
    worktreeDirs: [] as string[],
    agentManagerJson: [] as string[],
    setupScripts: [] as string[],
    markerFiles: [] as string[],
  }
  const walk = (d: string): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git") continue
      const full = join(d, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (name === "worktrees") {
          out.worktreeDirs.push(full)
          continue
        }
        walk(full)
      } else if (name === "agent-manager.json") {
        out.agentManagerJson.push(full)
      } else if (name === "setup-script" || name === "setup-script.sh" || name === "setup-script.ps1") {
        out.setupScripts.push(full)
      } else if (stat.size < 2_000_000 && (name.endsWith(".json") || name.endsWith(".md"))) {
        let content = ""
        try {
          content = readFileSync(full, "utf8")
        } catch {
          continue
        }
        if (content.includes("worktreeId") || content.includes('"worktrees"')) out.markerFiles.push(full)
      }
    }
  }
  walk(dir)
  return out
}

/** Poll until the active session tab id equals the expected id. */
async function expectActiveTab(frame: Frame, expected: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const active = await activeTabId(frame)
    if (active === expected) {
      console.log(`[probe] PASS ${label}: active tab = ${expected}`)
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`probe: ${label} failed: active tab = ${JSON.stringify(active)}, expected ${expected}`)
    }
    await sleep(250)
  }
}

/**
 * Poll until the derived Topic sidebar renders the expected root-local topic
 * rows with NO worktree markers, then assert the exact hierarchy. Polled
 * because the sidebar's topic derivation lags the session-open messages (the
 * one-shot assertNoWorktree fails on an empty sidebar even though no worktree
 * surface ever exists).
 */
async function expectRootLocalSidebar(
  frame: Frame,
  expectedRoots: string[],
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const topics = await sidebarTopicStates(frame)
    const rootIds = topics.map((t) => t.id)
    if (expectedRoots.every((id) => rootIds.includes(id))) {
      // Exact hierarchy + zero worktree markers (one-shot now that the roots
      // rendered; the topic derivation is complete).
      await assertNoWorktree(frame, label)
      console.log(`[probe] PASS ${label}: topics=[${rootIds.join(", ")}]`)
      return
    }
    if (Date.now() > deadline) {
      const dom = await frame
        .evaluate(() => {
          const list = document.querySelector(".am-list")
          return {
            listPresent: list !== null,
            skeleton: list?.querySelectorAll(".am-skeleton-list").length ?? 0,
            amItems: list?.querySelectorAll(".am-item").length ?? 0,
            topicRoots: list?.querySelectorAll(".am-topic-root[data-topic-id]").length ?? 0,
            listHTML: list?.innerHTML.slice(0, 2000) ?? "<none>",
            bodyText: (document.body?.innerText ?? "").slice(0, 1200),
          }
        })
        .catch(() => ({ error: "evaluate failed" }))
      throw new Error(
        `probe: ${label} failed: expected roots ${expectedRoots.join(", ")}, got ${JSON.stringify(topics)}.\n` +
          `  dom=${JSON.stringify(dom, null, 2)}`,
      )
    }
    await sleep(250)
  }
}

/**
 * Real-webview E2E for the P3.2 worktree-removal scenario. The extension-host
 * runner already asserted the loaded manifest + runtime command table expose
 * no managed worktree or custom Diff Viewer surface (recorded in
 * `worktree-removal-runtime-evidence`); this harness phase asserts the RENDERED
 * surfaces over the real Agent Manager webview and drives the bounded H-12
 * rollback through the retained chat UI:
 *
 *   1. two root-local sessions A + B seed through the production session-open
 *      path (no worktree dimension) and are CONTROLLABLE: both tabs render,
 *      clicking each switches the active tab, and the derived Topic sidebar has
 *      no worktree markers (assertNoWorktree) — root-local orchestration
 *      survives with no worktree directories (LOCK-008),
 *   2. the seeded tabs close through the real .am-tab-close buttons and the
 *      panel returns to the bottom page,
 *   3. the bounded H-12 rollback (reused assertRealRollbackPhase): the real
 *      write tool edits the tracked rollback.txt, Revert-to-here runs
 *      production SessionRevert+Snapshot and restores the exact initial bytes,
 *      the RevertBanner renders the per-file diff, and Redo All restores the
 *      edited bytes — all through the retained chat UI (LOCK-007/H-12),
 *   4. no worktree state exists anywhere in the run-owned workspace + XDG
 *      scratch at the end of the scenario (harness-side scan, recorded in the
 *      dom evidence).
 */
export async function assertWorktreeRemovalLifecycle(
  browser: Browser,
  plan: E2EPlan,
  scratch: string,
  workspace: string,
  model: ScriptedModelHandle,
): Promise<void> {
  const timeout = 30_000
  await waitForFile(join(scratch, "worktree-removal-ready"), 120_000, "worktree-removal-ready marker")

  // The extension-host runtime evidence is authoritative for the absence
  // claims; re-assert the decision-critical facts here (fail-fast before any
  // DOM driving if the runner recorded a violation).
  const runtimeEvidence = JSON.parse(
    readFileSync(join(scratch, "worktree-removal-runtime-evidence"), "utf8"),
  ) as {
    manifest: { forbidden: Record<string, string[]> }
    runtime: { forbiddenCommandHits: string[]; retainedCommands: Record<string, boolean> }
    state: { worktreesDir: boolean; agentManagerJson: boolean; stateMarkers: string[]; setupScripts: string[] }
  }
  const forbiddenCount = Object.values(runtimeEvidence.manifest.forbidden).reduce((n, hits) => n + hits.length, 0)
  if (forbiddenCount > 0 || runtimeEvidence.runtime.forbiddenCommandHits.length > 0) {
    throw new Error(`probe: extension-host runtime evidence recorded forbidden P3.2 surfaces: ${JSON.stringify(runtimeEvidence)}`)
  }
  if (!runtimeEvidence.runtime.retainedCommands.agentManagerOpen || !runtimeEvidence.runtime.retainedCommands.openInTab) {
    throw new Error(`probe: extension-host runtime evidence lost a retained root-local command: ${JSON.stringify(runtimeEvidence)}`)
  }
  if (
    runtimeEvidence.state.worktreesDir ||
    runtimeEvidence.state.agentManagerJson ||
    runtimeEvidence.state.stateMarkers.length > 0 ||
    runtimeEvidence.state.setupScripts.length > 0
  ) {
    throw new Error(`probe: extension-host runtime evidence recorded worktree state: ${JSON.stringify(runtimeEvidence.state)}`)
  }
  console.log("[probe] PASS extension-host runtime evidence: manifest/commands/state clean")

  const found = await findAgentManagerFrameAny(browser, 60_000)
  const frame = found.frame

  // --- Phase 1: two root-local sessions controllable, no worktree surface ---
  await waitForRealSessionTabs(frame, 2, 20_000, "P3.2 two root-local session tabs render")
  const tabs = await realTabStates(frame)
  const ids = tabs.map((t) => t.id)
  if (ids.includes(plan.sourceId) && ids.includes(plan.siblingId)) {
    console.log(`[probe] PASS P3.2 seeded tabs [${ids.join(", ")}]`)
  } else {
    throw new Error(`probe: P3.2 seeded tabs missing: got ${JSON.stringify(ids)}`)
  }
  await expectActiveTab(frame, plan.sourceId, timeout, "P3.2 seeded active tab is A")
  await clickTab(frame, plan.siblingId, timeout)
  await expectActiveTab(frame, plan.siblingId, timeout, "P3.2 click B activates B")
  await clickTab(frame, plan.sourceId, timeout)
  await expectActiveTab(frame, plan.sourceId, timeout, "P3.2 click A activates A")
  await expectRootLocalSidebar(frame, [plan.sourceId, plan.siblingId], timeout, "P3.2 sidebar renders root-local topics with no worktree markers")
  const surface = await frame
    .evaluate(() => {
      const sel = (s: string) => document.querySelectorAll(s).length
      return {
        worktreeIds: sel("[data-worktree-id]"),
        worktreeCards: sel(".am-worktree-card, .am-worktree-group, .am-group-card"),
        runCards: sel(".am-run-card, [data-run-id], .run-status"),
        // The removed worktree-section grouping rendered `data-section-id`
        // attributes; the retained Agent Manager sidebar layout uses the plain
        // `.am-section` class (its own Sessions section), which is NOT a
        // removed surface marker.
        sections: sel("[data-section-id]"),
        branchSelect: sel(".branch-select, [data-slot='branch-select']"),
        html: document.body?.innerHTML ?? "",
      }
    })
    .catch(() => ({ worktreeIds: -1, worktreeCards: -1, runCards: -1, sections: -1, branchSelect: -1, html: "" }))
  const clean =
    surface.worktreeIds === 0 &&
    surface.worktreeCards === 0 &&
    surface.runCards === 0 &&
    surface.sections === 0 &&
    surface.branchSelect === 0
  if (!clean) {
    throw new Error(`probe: P3.2 Agent Manager panel DOM has forbidden surface markers: ${JSON.stringify({ ...surface, html: surface.html.slice(0, 400) })}`)
  }
  console.log(`[probe] PASS P3.2 panel surface: no worktree/run/section markers ${JSON.stringify(surface)}`)

  // --- Phase 2: close the seeded tabs through the real close buttons ---
  // The close button is hover/active-revealed (pointer-events: none until the
  // tab is active or hovered), so select each tab first — the same production
  // interaction the tab-close scenario uses.
  await clickTab(frame, plan.siblingId, timeout)
  await clickTabClose(frame, plan.siblingId, timeout)
  await clickTab(frame, plan.sourceId, timeout)
  await clickTabClose(frame, plan.sourceId, timeout)
  await waitForNoSessionTabs(frame, 30_000, "P3.2 seeded tabs closed, panel back at the bottom page")

  // --- Phase 3: bounded H-12 rollback through the retained chat UI ---
  // Phase 0 (mirror the proven real-completed flow so the first send never
  // races the provider catalog load and falls back to KILO_AUTO).
  await waitForAgentOption(frame, plan.customAgentLabel, timeout)
  await pickAgent(frame, plan.customAgentLabel, timeout)
  await waitForLabel(frame, ".mode-switcher-trigger-label", plan.customAgentLabel, timeout, "custom agent selected (P3.2)")
  await pickVariant(frame, plan.customVariantA, timeout)
  await waitForLabel(frame, ".thinking-selector-trigger-label", plan.customVariantA, timeout, "variant Low selected (P3.2)")
  await waitForModelSelected(frame, plan.customProvider, plan.customModel, timeout, "custom model visibly selected (P3.2)")

  const snap = snapshotClient(scratch, "p32-snap")
  const exp = pinExpect(plan, plan.customAgent, plan.customVariantA)
  const sendTurn = async (
    target: Frame,
    prompt: string,
    probe: (s: BackendSnapshot) => string | undefined,
    label: string,
  ): Promise<BackendSnapshot> => {
    return sendTurnWithPin(target, snap, prompt, probe, label, timeout, {
      exp,
      prompt,
      sessionID: (s) => realRootSession(s)?.id,
    })
  }
  const editMessageID = await assertRealRollbackPhase(frame, snap, model, workspace, timeout, plan, sendTurn)
  const rollbackFile = join(workspace, SCRIPTED.rollbackFile)
  const readRollback = () => (existsSync(rollbackFile) ? readFileSync(rollbackFile, "utf8") : "<missing>")
  if (readRollback() !== SCRIPTED.rollbackEdited) {
    throw new Error(`probe: P3.2 H-12 final rollback file bytes wrong: ${JSON.stringify(readRollback())}`)
  }
  console.log(`[probe] PASS P3.2 H-12 final bytes restored by Redo All: ${JSON.stringify(SCRIPTED.rollbackEdited)}`)

  // Backend pin evidence for the two H-12 UI sends (LOCK-006).
  const finalPinSnap = await snap.request()
  const rootFinal = realRootSession(finalPinSnap)
  if (!rootFinal) throw new Error("probe: P3.2 H-12 root session missing from the final backend snapshot")
  const pinEvidence = [
    pinReport(finalPinSnap, rootFinal.id, exp, REAL_ROLLBACK_PROMPT),
    pinReport(finalPinSnap, rootFinal.id, exp, REAL_ROLLBACK_SUMMARY_PROMPT),
  ]
  console.log(`[probe] PIN EVIDENCE (P3.2): ${JSON.stringify(pinEvidence, null, 2)}`)

  // Final request-level isolation (LOCK-006/LOCK-008).
  const llmFinal = assertRunOwnedLlmRequests(scratch, "worktree-removal-final")

  // --- Phase 4: harness-side no-worktree-state scan over workspace + XDG ---
  const stateScan: Record<string, ReturnType<typeof scanWorktreeState>> = {
    workspace: scanWorktreeState(workspace),
    "xdg-config": scanWorktreeState(join(scratch, "xdg-config")),
    "xdg-data": scanWorktreeState(join(scratch, "xdg-data")),
    "xdg-state": scanWorktreeState(join(scratch, "xdg-state")),
    "xdg-cache": scanWorktreeState(join(scratch, "xdg-cache")),
  }
  const stateViolations = Object.entries(stateScan).filter(
    ([, s]) =>
      s.worktreeDirs.length > 0 ||
      s.agentManagerJson.length > 0 ||
      s.setupScripts.length > 0 ||
      s.markerFiles.length > 0,
  )
  if (stateViolations.length > 0) {
    throw new Error(`probe: P3.2 worktree state found in the run-owned tree: ${JSON.stringify(stateViolations, null, 2)}`)
  }
  console.log("[probe] PASS P3.2 no worktree state in workspace/XDG scratch")

  writeFileSync(
    join(scratch, "worktree-removal-dom-evidence"),
    JSON.stringify(
      {
        url: found.url,
        plan,
        runtimeEvidence,
        seeded: {
          tabs: ids,
          activeA: true,
          activeB: true,
          surface,
        },
        rollback: {
          file: SCRIPTED.rollbackFile,
          boundaryMessageID: editMessageID,
          editedBytes: readRollback(),
        },
        pins: pinEvidence,
        llmRequests: readLlmRequests(scratch),
        llmMatrix: llmFinal,
        finalTabs: await realTabStates(frame),
        stateScan,
        modelRequests: model.requests.map((r) => ({ url: r.url, body: r.body })),
      },
      null,
      2,
    ),
  )
  console.log("[probe] worktree-removal lifecycle passed")
}

/**
 * P3.2 worktree-removal only: create the run-owned scripted OpenAI-compatible
 * SSE provider and write the MINIMAL workspace seed (custom provider/model/
 * variant + custom agent + H-12 edit rule + tracked rollback file + no-op
 * dependency guard) BEFORE VS Code launches, then make the workspace a plain
 * single git repo (root-local — no managed worktree feature anywhere). The
 * scripted model serves the two bounded H-12 turns (write + summary) exactly
 * like real-completed Phase 9, but with no MCP/tool/skill/permission fixtures
 * attached.
 */
export async function prepareWorktreeRemoval(
  workspace: string,
  real: boolean,
): Promise<ScriptedModelHandle | undefined> {
  if (!real) return undefined
  const handle = await createScriptedModel(workspace)
  const configFile = writeWorktreeRemovalSeed(workspace, handle.port)
  initWorkspaceGit(workspace)
  console.log(`[probe] worktree-removal seed: ${configFile} (scripted model port ${handle.port})`)
  return handle
}
