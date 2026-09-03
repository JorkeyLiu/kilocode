#!/usr/bin/env node
/**
 * Real VS Code Extension Host E2E probe.
 *
 * Launches the current workspace Kilo VS Code extension in a real VS Code
 * instance (`@vscode/test-electron`), connects Playwright to the workbench
 * over a uniquely owned CDP port, opens the Agent Manager webview, seeds one
 * deterministic offline fixture session via the env-gated fixture bridge, and
 * asserts the fixture marker renders in the real webview DOM.
 *
 * Usage:
 *   node script/e2e-probe.ts            (via `bun run test:e2e`)
 *   node script/e2e-probe.ts --no-build
 *
 * Scenario selection (KILO_E2E_SCENARIO, forwarded to the extension-host
 * runner so it seeds only the selected scenario's fixtures):
 *   - (unset) | all      => tab-close, child-task-order AND variant-memory in
 *                           one VS Code lifecycle (the delivery gate —
 *                           deliberately NOT extended with topic-navigation,
 *                           which closes/reopens the Agent Manager panel
 *                           mid-run),
 *   - tab-close          => only the tab-close-successor scenario + fixtures,
 *   - child-task-order   => only the child-task scenario + its fixtures,
 *   - variant-memory     => only the variant-memory scenario + its fixtures.
 *   - topic-navigation   => only the derived-Topic lifecycle-convergence
 *                           scenario (navigation, panel close/reopen, webview
 *                           reload) + its fixtures.
 *   - real-session       => only the real-session parity scenario: drives the
 *                           real Agent Manager webview to create/prompt REAL
 *                           backend sessions through the production message
 *                           path and asserts served-backend truth (H-1 custom
 *                           agent, H-8 concurrent sessions, H-9 per-session
 *                           model+variant, H-10 transcript rehydration, H-11
 *                           create/abort/close). Requires the run-owned
 *                           workspace config seed this harness writes before VS
 *                           Code launches (custom provider/model/variant +
 *                           custom agents) and a run-owned hang server the
 *                           custom provider points at, so prompts stay busy
 *                           until the production abort path cancels them.
 *   - real-completed     => only the real-completed-turn parity scenario:
 *                           drives the real Agent Manager webview through
 *                           COMPLETED turns against a run-owned scripted
 *                           OpenAI-compatible SSE provider, proving H-2
 *                           (delegation with result flow-back), H-3 (user
 *                           tool), H-4 (skill), H-5 (MCP connect/execute/
 *                           exact-PID cleanup), H-6 (permission + question
 *                           inline docks), H-7 (parent-child hierarchy
 *                           persists after panel close/reopen), and H-12
 *                           (Revert-to-here restores a tracked file via
 *                           production SessionRevert+Snapshot, the RevertBanner
 *                           renders its diff, and Redo All/unrevert restores
 *                           the edited bytes).
 *   - real-overflow       => only the real-overflow H-13 scenario: drives the
 *                           real Agent Manager webview through ONE completed
 *                           turn whose first scripted response deliberately
 *                           exceeds the run-owned compaction cap (custom
 *                           provider model limit.context ×
 *                           compaction.threshold_percent on a DEDICATED config
 *                           that never shares the H-2..H-7 model), proving the
 *                           production internal context-overflow safeguard
 *                           stays invisible and functional: the served backend
 *                           records a typed auto-compaction part + summary +
 *                           automatic-continuation turn, the panel renders the
 *                           continuation answer (and the summary trace), and
 *                           the Agent Manager DOM has no context-management /
 *                           compact controls.
 *   - real-restart        => only the real-restart H-10/H-11 scenario: drives
 *                           ONE real completed session (durable transcript +
 *                           artifact) against the run-owned scripted provider,
 *                           then proves presentation converges to runtime facts
 *                           across every remaining boundary over the shared
 *                           bridge — Phase A: explicit SSE reconnect with the
 *                           backend alive (same port/PID, no duplicate/stale
 *                           presentation), Phase B: exact-owned worker kill
 *                           through ServerManager's owner path + production
 *                           reconnect flow (new PID/port, transcript/artifact
 *                           rehydrate, UI converges), Phase C: the runner
 *                           executes workbench.action.reloadWindow (the true
 *                           window/extension restart); the test-mode main
 *                           process exits with the torn-down Extension Host, so
 *                           the harness RELAUNCHES VS Code with identical args
 *                           and the fresh Extension Host re-runs the test
 *                           runner, detects the persisted marker, and the
 *                           restored panel resumes the same session/artifact
 *                           from the same XDG scratch.
 *   - worktree-removal     => only the P3.2 runtime-absence + root-local +
 *                           bounded-H-12 scenario: the extension host proves
 *                           the loaded manifest and the RUNTIME command table
 *                           expose no managed worktree or custom Diff Viewer
 *                           surface, the Agent Manager panel is ready with two
 *                           root-local sessions seeded through the production
 *                           session-open path (no worktree dimension), the
 *                           harness drives both tabs and proves them
 *                           controllable with no worktree markers in the
 *                           sidebar DOM, no `.kilo/worktrees` /
 *                           `.kilo/agent-manager.json` / setup-script state is
 *                           created anywhere in the run-owned workspace/XDG
 *                           tree, and the bounded H-12 rollback (REUSED
 *                           assertRealRollbackPhase against the run-owned
 *                           scripted provider) proves Revert-to-here restores
 *                           the exact original bytes and Redo All restores the
 *                           edited bytes through the retained chat UI.
  *   - cloud-claw-removal   => only the P3.3 runtime-absence scenario: the
  *                           extension host proves the loaded manifest, the
  *                           RUNTIME command table, and the built dist/ bundle
  *                           list expose no active cloud-session, KiloClaw, local
  *                           Console, or JetBrains product contribution
  *                           (identifier-based, no false-positive generic
  *                           retained names), and the retained Agent Manager as
  *                           the sole chat UI still becomes ready (no Open in Tab,
  *                           P3.5 Complete 2026-09-01). No
 *                           synthetic fixtures, no CDP DOM driving, no model
 *                           requests — all assertions run extension-host-side
 *                           and are recorded in
 *                           `cloud-claw-removal-runtime-evidence`.
 *   - p3-4-removal         => only the P3.4 remaining-feature-removal
 *                           scenario: the extension host proves the loaded
 *                           manifest, the RUNTIME command table, the built
 *                           dist/ bundle list, and the run-owned workspace
 *                           state expose no indexing / project memory /
 *                           user-visible context-management / manual-compaction
 *                           / autocomplete / commit-message surface
  *                           (LOCK-004/PERF-3/014/015), the fixture-gated
  *                           generation-request collector stays at ZERO model
  *                           requests (no external calls), and the retained Agent
  *                           Manager as the sole chat UI still becomes ready (no
  *                           Open in Tab, P3.5 Complete 2026-09-01) (LOCK-005/007/008). No synthetic fixtures,
 *                           no CDP DOM driving, no model requests — all
 *                           assertions run extension-host-side and are
 *                           recorded in `p3-4-removal-runtime-evidence`.
 *   Any other value fails fast before VS Code launches. Focused runs:
 *     KILO_E2E_SCENARIO=tab-close         node script/e2e-probe-launch.mjs
 *     KILO_E2E_SCENARIO=child-task-order  node script/e2e-probe-launch.mjs
 *     KILO_E2E_SCENARIO=variant-memory    node script/e2e-probe-launch.mjs
 *     KILO_E2E_SCENARIO=topic-navigation  node script/e2e-probe-launch.mjs
 *     KILO_E2E_SCENARIO=real-session      node script/e2e-probe-launch.mjs
 *     KILO_E2E_SCENARIO=real-completed    node script/e2e-probe-launch.mjs
 *     KILO_E2E_SCENARIO=real-overflow     node script/e2e-probe-launch.mjs
 *     KILO_E2E_SCENARIO=real-restart      node script/e2e-probe-launch.mjs
 *     KILO_E2E_SCENARIO=worktree-removal  node script/e2e-probe-launch.mjs
 *     KILO_E2E_SCENARIO=cloud-claw-removal node script/e2e-probe-launch.mjs
 *     KILO_E2E_SCENARIO=p3-4-removal node script/e2e-probe-launch.mjs
 *   (package shortcuts: `bun run test:e2e:tab-close`,
 *   `bun run test:e2e:child-task-order`,
 *   `bun run test:e2e:variant-memory`,
 *   `bun run test:e2e:topic-navigation`,
 *   `bun run test:e2e:real-session`,
 *   `bun run test:e2e:real-completed`,
 *   `bun run test:e2e:real-overflow`,
 *   `bun run test:e2e:real-restart`,
 *   `bun run test:e2e:worktree-removal`,
 *   `bun run test:e2e:cloud-claw-removal`,
 *   `bun run test:e2e:p3-4-removal`.)
 *
 * Scenarios are independent: each seeds only its own fixtures and coordinates
 * through scenario-specific markers (tab-close-done, child-phase1-done /
 * child-phase2-ready / child-phase2-done, variant-ready, topic-nav-done /
 * topic-reopen-ready / topic-reopen-done / topic-reload-frame /
 * topic-reload-ready / topic-reload-done, real-ready / real-snap-N-request /
 * real-snap-N.json / real-reopen-request / real-reopen-ready,
 * real-completed-ready / rc-snap-N-request / rc-snap-N.json /
 * real-completed-reopen-request / real-completed-reopen-ready /
 * real-completed-mcp-disconnect-request / real-completed-mcp-disconnect-done,
 * real-overflow-ready / of-snap-N-request / of-snap-N.json,
 * rr-ready / rr-conn-request / rr-conn.json / rr-kill-request / rr-kill.json /
 * rr-reconnect-request / rr-reconnect.json / rr-snap-N-request / rr-snap-N.json /
 * rr-reload-request / rr-reload-executed / rr-reloaded /
 * rr-c-snap-N-request / rr-c-snap-N.json /
 * runner-pid).
 * No scenario waits on another's markers. The tab-close scenario runs first
 * in the `all` composition and closes all its own tabs before finishing, so
 * the strip it hands to the child scenario is exactly the startup state (one
 * pending tab + bottom page) the child seeding already expects. real-session,
 * real-completed, real-overflow, and real-restart are focused-only (like
 * topic-navigation): they create REAL backend sessions and close/reopen the
 * panel (real-session / real-completed) or reload the whole window
 * (real-restart), which would pollute the other scenarios.
 *
 * MUST run under Node, not Bun: Playwright's CDP WebSocket transport hangs
 * under Bun's runtime against VS Code's Electron CDP endpoint (verified:
 * raw ws + Node both connect; Playwright connectOverCDP under Bun times out).
 * `bun run test:e2e` compiles this file with esbuild and executes it with
 * Node (see script/e2e-probe-launch.mjs).
 *
 * Lifecycle / ownership:
 *   - One unique temp root under the OS tmp dir owns user-data, extensions,
 *     workspace, runner bundle, and coordination files. It is removed on both
 *     success and failure paths, and ONLY after every owned process (matched
 *     by exact PID + unique user-data-dir in its command line) has exited or
 *     been terminated by that exact PID — never by process name, never while
 *     a live process still references the paths.
 *   - VS Code is spawned via @vscode/test-electron.runTests and awaited to
 *     exit; the timeout watchdog terminates every owned process by exact PID
 *     before the scratch dir is deleted.
 *   - The CDP port is allocated, then verified free after VS Code exits.
 *   - The extension-host runner exits (resolving run()) only after the harness
 *     writes the `done` marker, so VS Code exits 0 on success and on failure.
 *   - Platforms: macOS and Linux are supported. Windows fails fast with a
 *     documented error because exact-owned process termination relies on `ps`
 *     PID+args inspection, which is not available on Windows.
 *   - VS Code binary resolution: VSCODE_TEST_EXECUTABLE (must exist), else a
 *     cached download under .vscode-test/, else undefined — runTests then
 *     auto-downloads into the deterministic .vscode-test/ directory, so a
 *     clean checkout works with no binary present (LOCK-002).
 */
import { runTests } from "@vscode/test-electron"
import { chromium, type Browser, type Frame, type Page } from "@playwright/test"
import { build } from "esbuild"
import { spawnSync } from "node:child_process"
import { createServer, type Socket } from "node:net"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { BackendSnapshot, SessionTruth } from "../src/agent-manager/fixture-backend"
import { createScriptedModel, SCRIPTED, type ScriptedModelHandle } from "./e2e-scripted-model"
import {
  writeRealCompletedSeed,
  writeRealOverflowSeed,
  initWorkspaceGit,
  type CompletedSeedPaths,
} from "./e2e-completed-seed"
import { realProjectSeed, writeRealRestartSeed, RESTART_ARTIFACT_CONTENT } from "./e2e-restart-seed"
import { CONFIG_FILENAME } from "../src/config/paths"
import { isWrongPin, pinExpect, pinnedReason, pinReport, type PinExpectation } from "./e2e-pin"
import { assertRunOwnedLlmRequests, readLlmRequests } from "./e2e-llm-matrix"
import { evidenceDirFor, runEvidenceHandoff } from "./e2e-evidence"
import {
  assertArchiveStable,
  canonicalDataRoot,
  canonicalDbPath,
  isIsolatedDataRoot,
  prepareCanonicalRun,
  validateGateEvidence,
} from "./e2e-canonical"
import {
  activeTabId,
  activeTabLabel,
  agentOptions,
  assertNoWorktree,
  clickChildTaskLink,
  clickRealNewSessionAction,
  clickRevertToHere,
  clickSidebarChild,
  clickSidebarTopic,
  clickTab,
  clickTabClose,
  closePopover,
  describeTargets,
  E2EPlan,
  expectBannerFile,
  expectHeaderTitle,
  expectTabOrder,
  expectTopicHierarchy,
  expectTranscriptText,
  findAgentManagerFrameAny,
  headerTitle,
  labelText,
  openSidebarSession,
  pickAgent,
  pickOption,
  pickVariant,
  realTabStates,
  requestRsCanonicalState,
  requestRsSeedCredential,
  sendTurnWithPin,
  sendWithRetry,
  sidebarTopicStates,
  sleep,
  snapshotClient,
  tabLabels,
  tabStates,
  waitForAgentOption,
  waitForFile,
  waitForFileBytes,
  waitForLabel,
  waitForModelSelected,
  waitForNoSessionTabs,
  waitForRealSessionTabs,
  type SidebarChildState,
  type SidebarTopicState,
} from "./e2e-probe-dom"
import { assertRealRestartReload, runRealRestartBoundaries } from "./e2e-probe-restart"
import { assertR9ObservationLifecycle } from "./e2e-probe-r9"
import { runGcLifecycleBoundaries } from "./e2e-probe-lifecycle"
import { repoRootFrom } from "./p0-bench/repo-root"
import {
  REAL_ROLLBACK_PROMPT,
  REAL_ROLLBACK_SUMMARY_PROMPT,
  assertRealRollbackPhase,
  assertWorktreeRemovalLifecycle,
  completedTool,
  prepareWorktreeRemoval,
  realRootSession,
  waitForDock,
  waitForNoDock,
} from "./e2e-probe-worktree"
import { isDirectExecution } from "./e2e-direct"
import { createE2EMarker } from "../src/util/e2e-fixture"

if (process.versions.bun && isDirectExecution()) {
  console.error(
    "[probe] FATAL: this harness must run under Node, not Bun. " +
      "Playwright's connectOverCDP WS transport hangs under Bun against VS Code's CDP endpoint. " +
      "Use `bun run test:e2e` (compiles + runs via Node).",
  )
  process.exit(1)
}

// Set by script/e2e-probe-launch.mjs; falls back to the current working dir.
const root = process.env.KILO_E2E_ROOT ? resolve(process.env.KILO_E2E_ROOT) : resolve(process.cwd())
// Monorepo root for cross-package paths (the hidden cutover CLI entry at
// packages/opencode/src/index.ts). `root` is the PACKAGE root
// (packages/kilo-vscode) — joining it with packages/opencode/... produced
// packages/kilo-vscode/packages/opencode/... and failed the first full
// real-restart run before VS Code launched. Git-first resolution keeps the
// monorepo root correct from any checkout or worktree directory.
const repoRoot = repoRootFrom(root)
const runnerEntry = join(root, "tests", "e2e", "runner.ts")
const shouldBuild = !process.argv.includes("--no-build")
// Watchdog for the whole probe run (outer bound). real-completed drives
// completed turns through the real webview, then reopens the panel (H-7),
// disconnects the MCP server (H-5), and runs H-12 Phase 9; its extension-host
// runner declares a 5.4M ms service budget (REAL_COMPLETED_SERVICE_BUDGET in
// tests/e2e/runner.ts), so the 300s default would kill a valid slow/retry-heavy
// run before Phase 9. real-overflow declares a 900s service budget
// (REAL_OVERFLOW_SERVICE_BUDGET) that a 600s watchdog could not outlive, and
// real-restart declares 2.1M ms across its reload boundary. Derive wider
// defaults ONLY for those scenarios (real-completed 100 min, real-overflow
// 20 min, real-restart 100 min); every other scenario — including real-session,
// whose service loop is bounded at 240s — keeps the 300s default, so the global
// watchdog is not weakened. An explicit KILO_E2E_TIMEOUT always wins over the
// derived default.
const timeoutMs = Number(
  process.env.KILO_E2E_TIMEOUT ??
    (process.env.KILO_E2E_SCENARIO === "real-completed"
      ? 6_000_000
      : process.env.KILO_E2E_SCENARIO === "real-overflow"
        ? 1_200_000
        : process.env.KILO_E2E_SCENARIO === "real-restart"
          ? 6_000_000
          : process.env.KILO_E2E_SCENARIO === "real-lifecycle"
            ? 1_200_000
            : process.env.KILO_E2E_SCENARIO === "worktree-removal"
              ? 6_000_000
              : process.env.KILO_E2E_SCENARIO === "r9-observation"
                ? 1_200_000
                : 300_000),
)

// LOCK-002: scenario selection. `all` (default) runs every scenario in one VS
// Code lifecycle; a focused value runs exactly that scenario. Unknown values
// fail fast BEFORE VS Code launches (see main()). topic-navigation,
// real-session, and real-completed are focused-only by design (not part of
// `all`): topic closes/reopens the Agent Manager panel mid-run (which would
// dispose the tab strip the other `all` scenarios coordinate on), and the
// real scenarios create REAL backend sessions through the production webview
// path (which would pollute the synthetic session lists the other scenarios
// re-seed) — so the delivery-gate composition stays deliberate and unchanged.
const SCENARIO_VALUES = [
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
] as const
export function parseScenarios(value: string): Set<string> {
  if (value === "all") return new Set(["tab-close", "child-task-order", "variant-memory"])
  if (
    value === "tab-close" ||
    value === "child-task-order" ||
    value === "variant-memory" ||
    value === "topic-navigation" ||
    value === "real-session" ||
    value === "real-completed" ||
    value === "real-overflow" ||
    value === "real-restart" ||
    value === "real-lifecycle" ||
    value === "sidebar-removal" ||
    value === "worktree-removal" ||
    value === "cloud-claw-removal" ||
    value === "p3-4-removal" ||
    value === "r9-observation"
  ) {
    return new Set([value])
  }
  throw new Error(
    `[probe] unknown KILO_E2E_SCENARIO "${value}". ` +
      `Supported values: ${SCENARIO_VALUES.join(" | ")} (default: all).`,
  )
}

// Shared canonical gate: canonical root setup and Extension Host env
// wiring must test through this predicate so the gates cannot drift.
// real-restart keeps its 18/18 behavior unchanged; real-session now shares the
// same fresh canonical DB + hidden cutover + archive stability.
function isRealRestart(value: string): boolean {
  return parseScenarios(value).has("real-restart")
}

export function needsCanonicalStorage(value: string): boolean {
  return (
    parseScenarios(value).has("real-restart") ||
    parseScenarios(value).has("real-session") ||
    parseScenarios(value).has("real-lifecycle") ||
    parseScenarios(value).has("r9-observation")
  )
}

// LOCK-006: macOS and Linux are first-class. Windows must fail fast with a
// clear documented error instead of silently skipping cleanup — exact-owned
// process termination (processesWithUserData) relies on `ps -axo pid=,args=`,
// which does not exist on Windows. Windows support requires taskkill by exact
// PID + user-data ownership before any path deletion.
if (process.platform === "win32") {
  console.error(
    "[probe] UNSUPPORTED PLATFORM: this E2E harness only supports macOS and Linux.\n" +
      "  Windows is rejected here (fail fast) because exact-owned process cleanup " +
      "depends on `ps` PID+args inspection, which is unavailable; silently skipping " +
      "cleanup is not acceptable. Windows support requires implementing taskkill by " +
      "exact PID/user-data ownership before deleting any scratch path.",
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Unique ownership
// ---------------------------------------------------------------------------

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address !== "object") throw new Error("probe: failed to allocate a free CDP port")
  return address.port
}

/**
 * Resolve a VS Code executable, or return undefined to let @vscode/test-electron
 * download one. Resolution order:
 *   1. `VSCODE_TEST_EXECUTABLE` — must exist; a stale value is logged and
 *      skipped, never passed through,
 *   2. a cached download under `.vscode-test/` (created by an earlier
 *      auto-download or `@vscode/test-electron` test run),
 *   3. undefined — `runTests` then auto-downloads into the deterministic
 *      `.vscode-test/` directory, so a clean checkout needs no binary
 *      (LOCK-002).
 */
function detectExecutable(): string | undefined {
  const env = process.env["VSCODE_TEST_EXECUTABLE"]
  if (env) {
    if (existsSync(env)) return env
    console.warn(`[probe] VSCODE_TEST_EXECUTABLE set but missing, ignoring: ${env}`)
  }
  const testDir = join(root, ".vscode-test")
  if (existsSync(testDir)) {
    const apps = readdirSync(testDir)
      .filter((name) => name.startsWith("vscode-"))
      .sort()
      .reverse()
    for (const app of apps) {
      const macDir = join(testDir, app, "Visual Studio Code.app", "Contents", "MacOS")
      if (existsSync(macDir)) {
        for (const name of readdirSync(macDir)) {
          const candidate = join(macDir, name)
          if (basename(candidate) === "Code" || basename(candidate) === "Electron") return candidate
        }
      }
      for (const name of ["code", "Code.exe"]) {
        const candidate = join(testDir, app, name)
        if (existsSync(candidate)) return candidate
      }
    }
    console.warn(`[probe] no cached VS Code executable found under ${testDir}`)
  } else {
    console.log("[probe] no .vscode-test cache; VS Code will be downloaded automatically")
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Build (canonical bundle step used by `bun run compile` / `bun run package`)
// ---------------------------------------------------------------------------

async function compile() {
  if (!shouldBuild) {
    console.log("[probe] Skipping esbuild (--no-build)")
    return
  }
  console.log("[probe] Building extension + webview bundles via node esbuild.js")
  const result = spawnSync(process.execPath, ["esbuild.js"], { cwd: root, stdio: "inherit" })
  if (result.status !== 0) {
    throw new Error(`probe: esbuild failed (exit ${result.status})`)
  }
  console.log("[probe] Build complete")
}

// ---------------------------------------------------------------------------
// CDP / webview discovery
// ---------------------------------------------------------------------------

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("probe: CDP endpoint did not come up in time")
    await sleep(250)
  }
}

/**
 * Find the Agent Manager webview frame among CDP pages. VS Code webviews are
 * OOPIF iframes; Playwright exposes them as frames (page.frames()) of the
 * workbench page whose URL starts with `vscode-webview://`. The Agent Manager
 * is anchored by its distinctive tab strip: the `.am-tab-sortable` container
 * (rendered only by the Agent Manager tab bar) showing the tab whose title is
 * `anchorTitle`. Each scenario passes its own fixture title (child: source
 * title; variant: variant title) so the finder never depends on a tab seeded
 * by another scenario. Anchoring on the sortable container — not just
 * `.am-tab-label` — prevents matching the editor-tab webview, which never
 * renders `.am-tab-sortable`.
 */
async function findAgentManagerFrame(
  browser: Browser,
  plan: E2EPlan,
  anchorTitle: string,
  timeoutMs: number,
): Promise<{ page: Page; frame: Frame; url: string }> {
  const deadline = Date.now() + timeoutMs
  let found: { page: Page; frame: Frame; url: string } | undefined
  for (;;) {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        for (const frame of page.frames()) {
          const url = frame.url()
          if (!url.includes("vscode-webview")) continue
          const hit = await frame
            .locator(".am-tab-sortable[data-tab-id]")
            .filter({ hasText: anchorTitle })
            .count()
            .then((n) => n > 0)
            .catch(() => false)
          if (hit) {
            found = { page, frame, url }
            break
          }
        }
        if (found) break
      }
      if (found) break
    }
    if (found) break
    if (Date.now() > deadline) {
      throw new Error(`probe: Agent Manager webview frame not found.\n${await describeTargets(browser)}`)
    }
    await sleep(250)
  }
  return found
}

/**
 * Full production-behavior E2E for the Agent Manager child-task open action:
 *   1. initial tab order [source, sibling] with source active,
 *   2. click the real "Open sub-agent in tab" IconButton in source's chat
 *      (TaskToolExpanded renderer — the same production component the editor-tab webview uses),
 *   3. assert [source, child, sibling] with child active,
 *   4. re-select source (runner via sessionAdded), click again,
 *   5. assert the already-open child is focused WITHOUT reordering.
 */
async function assertChildTaskOrder(browser: Browser, plan: E2EPlan, scratch: string): Promise<void> {
  const { frame } = await findAgentManagerFrame(browser, plan, plan.sourceTitle, 60_000)
  const phase1Timeout = 30_000

  // Phase 1: initial order [source, sibling], source active. Tab IDs are the
  // primary order evidence; titles are supplementary UI evidence.
  await expectTabOrder(
    frame,
    [plan.sourceId, plan.siblingId],
    [plan.sourceTitle, plan.siblingTitle],
    plan.sourceId,
    plan.sourceTitle,
    phase1Timeout,
    "initial order",
  )

  // The production task renderer (TaskToolExpanded) shows the open button only
  // when the task part metadata carries the child session ID.
  await clickChildTaskLink(frame, phase1Timeout)

  // Child opens immediately right of its source: [source, child, sibling].
  await expectTabOrder(
    frame,
    [plan.sourceId, plan.childId, plan.siblingId],
    [plan.sourceTitle, plan.childTitle, plan.siblingTitle],
    plan.childId,
    plan.childTitle,
    phase1Timeout,
    "child placed right of source",
  )

  // Phase 2 coordination: tell the runner to re-select the source session.
  writeFileSync(join(scratch, "child-phase1-done"), "ok")
  await waitForFile(join(scratch, "child-phase2-ready"), 60_000, "child-phase2-ready marker")

  // Source active again, order untouched: [source, child, sibling].
  await expectTabOrder(
    frame,
    [plan.sourceId, plan.childId, plan.siblingId],
    [plan.sourceTitle, plan.childTitle, plan.siblingTitle],
    plan.sourceId,
    plan.sourceTitle,
    phase1Timeout,
    "re-selected source keeps child order",
  )

  // Re-click: already-open child focuses without reordering.
  await clickChildTaskLink(frame, phase1Timeout)
  await expectTabOrder(
    frame,
    [plan.sourceId, plan.childId, plan.siblingId],
    [plan.sourceTitle, plan.childTitle, plan.siblingTitle],
    plan.childId,
    plan.childTitle,
    phase1Timeout,
    "already-open child focused without reorder",
  )

  writeFileSync(
    join(scratch, "dom-evidence"),
    JSON.stringify(
      {
        url: frame.url(),
        plan,
        phase2Tabs: await tabLabels(frame),
        phase2Active: await activeTabLabel(frame),
        phase2ActiveId: await activeTabId(frame),
      },
      null,
      2,
    ),
  )
  // Phase 2 complete.
  writeFileSync(join(scratch, "child-phase2-done"), "ok")
}

// ---------------------------------------------------------------------------
// Tab-close successor — real webview DOM, real close button
// ---------------------------------------------------------------------------

/**
 * Real-webview E2E for the active-tab close successor contract:
 *   1. the runner seeds three session tabs [tabA, tabB, tabC] (first / middle
 *      / last) with tabA active,
 *   2. select the MIDDLE tab (tabB) and close it via the real `.am-tab-close`
 *      button → the LEFT neighbor (tabA) becomes active, order [tabA, tabC],
 *   3. close the now-first active tab (tabA) → the RIGHT-neighbor fallback
 *      (tabC, former next tab, now first) becomes active, order [tabC],
 *   4. close the last tab → no session tab remains (only-tab close has no
 *      successor; the production handler falls back to the empty state).
 *
 * The frame anchor used by findAgentManagerFrame is re-resolved after every
 * close that removes the anchor tab, using a surviving tab's title, so the
 * finder never depends on a closed tab.
 */
async function assertTabCloseSuccessor(browser: Browser, plan: E2EPlan, scratch: string): Promise<void> {
  const timeout = 30_000
  // Anchor on the middle tab — the first tab this scenario closes — so the
  // re-anchor path is exercised on each subsequent close.
  let found = await findAgentManagerFrame(browser, plan, plan.tabBTitle, 60_000)
  let frame = found.frame

  // Phase 0: seeded order [tabA, tabB, tabC] with tabA active.
  await expectTabOrder(
    frame,
    [plan.tabAId, plan.tabBId, plan.tabCId],
    [plan.tabATitle, plan.tabBTitle, plan.tabCTitle],
    plan.tabAId,
    plan.tabATitle,
    timeout,
    "seeded order",
  )

  // Phase 1 (branch a): select the middle tab, then close it via the real
  // close button → the LEFT neighbor (tabA) becomes active, order [tabA, tabC].
  await clickTab(frame, plan.tabBId, timeout)
  await expectTabOrder(
    frame,
    [plan.tabAId, plan.tabBId, plan.tabCId],
    [plan.tabATitle, plan.tabBTitle, plan.tabCTitle],
    plan.tabBId,
    plan.tabBTitle,
    timeout,
    "middle tab selected",
  )
  await clickTabClose(frame, plan.tabBId, timeout)
  // The anchor tab (tabB) is gone — re-anchor on a surviving tab's title.
  found = await findAgentManagerFrame(browser, plan, plan.tabATitle, 60_000)
  frame = found.frame
  await expectTabOrder(
    frame,
    [plan.tabAId, plan.tabCId],
    [plan.tabATitle, plan.tabCTitle],
    plan.tabAId,
    plan.tabATitle,
    timeout,
    "close middle selects left neighbor",
  )

  // Phase 2 (branch b): the first tab (tabA) is active; close it → the
  // right-neighbor fallback (tabC, former next tab, now first) becomes active,
  // order [tabC].
  await clickTab(frame, plan.tabAId, timeout)
  await expectTabOrder(
    frame,
    [plan.tabAId, plan.tabCId],
    [plan.tabATitle, plan.tabCTitle],
    plan.tabAId,
    plan.tabATitle,
    timeout,
    "first tab active before close",
  )
  await clickTabClose(frame, plan.tabAId, timeout)
  // The re-anchor tab (tabA) is gone — re-anchor on the surviving tab.
  found = await findAgentManagerFrame(browser, plan, plan.tabCTitle, 60_000)
  frame = found.frame
  await expectTabOrder(
    frame,
    [plan.tabCId],
    [plan.tabCTitle],
    plan.tabCId,
    plan.tabCTitle,
    timeout,
    "close first falls back to right neighbor",
  )

  // Phase 3 (only-tab path): close the last tab → no session tab remains. This
  // also resets the strip to the startup state (one pending tab + bottom page)
  // so the next scenario in the `all` composition seeds from a clean base.
  await clickTabClose(frame, plan.tabCId, timeout)
  await waitForNoSessionTabs(frame, timeout, "last tab closed leaves no session tab")

  writeFileSync(
    join(scratch, "tab-close-dom-evidence"),
    JSON.stringify(
      {
        url: frame.url(),
        plan,
        finalTabs: await tabStates(frame),
      },
      null,
      2,
    ),
  )
  // Scenario complete — the runner may seed the next scenario.
  writeFileSync(join(scratch, "tab-close-done"), "ok")
}

// ---------------------------------------------------------------------------
// Variant memory across agents (LOCK-001) — real webview DOM
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Derived Topic navigation — real webview sidebar
// ---------------------------------------------------------------------------

/**
 * Reload the Agent Manager webview through the VS Code host's own webview
 * reload action, executed by the extension-host runner.
 *
 * Frame-level CDP reloads cannot reload a VS Code webview: a bare
 * `location.reload()` and an explicit `frame.goto(indexUrl)` are both
 * intercepted by the webview host and land on its `fake.html` placeholder
 * (verified against the real harness — the app never remounts). The host's
 * `workbench.action.webview.reloadWebviewAction` ("Developer: Reload
 * Webviews") re-navigates the webview iframe to its real content, which is the
 * smallest verified reload mechanism. It reloads every open webview (only the
 * Agent Manager exists in the hermetic test profile); no production fixture
 * command changes, no full window reload.
 *
 * The harness sets a probe mark in the pre-reload document so the fresh
 * document (which cannot carry the mark) is findable deterministically.
 */
async function reloadAgentManagerFrame(frame: Frame, scratch: string): Promise<void> {
  // Mark the pre-reload document so the fresh post-reload document is
  // distinguishable from the old one (a reload destroys the old document). A
  // failure to set the mark must abort the boundary: if the mark-set was
  // silently swallowed, findReloadedFrame could match the still-present old
  // document as "fresh" (it never received the mark) — a false pass.
  await frame.evaluate(() => {
    ;(window as unknown as { __amProbeMark?: string }).__amProbeMark = "pre-reload"
  })
  writeFileSync(join(scratch, "topic-reload-start"), "ok")
  console.log("[probe] marked pre-reload webview document; reload in progress")
}

/**
 * Find the Agent Manager webview frame whose document is FRESH — i.e. does
 * not carry the pre-reload probe mark set by reloadAgentManagerFrame and has
 * mounted the app (`.am-layout`). The reload destroys the marked document, so
 * only the new document can match.
 */
async function findReloadedFrame(
  browser: Browser,
  timeoutMs: number,
): Promise<{ page: Page; frame: Frame; url: string }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        for (const frame of page.frames()) {
          const url = frame.url()
          if (!url.includes("vscode-webview")) continue
          const fresh = await frame
            .evaluate(() => {
              const marked = (window as unknown as { __amProbeMark?: string }).__amProbeMark === "pre-reload"
              return !marked && document.querySelector(".am-layout") !== null
            })
            .catch(() => false)
          if (fresh) return { page, frame, url }
        }
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`probe: reloaded Agent Manager webview frame not found.\n${await describeTargets(browser)}`)
    }
    await sleep(250)
  }
}

/**
 * Real-webview E2E for the LOCK-001 regression: within ONE session, each agent
 * keeps its own session-scoped reasoning variant.
 *
 * The runner seeds session D with a transcript whose recovery selects
 * kilo/e2e-probe (a model with variants low/medium/high injected by the
 * env-gated fixture bridge), then this drives the real DOM:
 *   1. the current agent (whatever the machine's default is) picks "Low",
 *   2. switch to a second agent → picks "High",
 *   3. switch back to the first agent → the ThinkingSelector must show "Low"
 *      again (with the old agent-less session key `session/{sid}/{provider}/{model}`,
 *      the second agent's pick overwrote the shared session key, so the first
 *      agent would show "High"),
 *   4. switch back to the second agent → "High".
 *
 * Agent labels are read from the real ModeSwitcher so the case runs on any
 * machine's agent catalog (builtin or custom). It runs standalone: it only
 * requires the variant session D (seeded by the runner when this scenario is
 * selected) and the `variant-ready` marker — never another scenario's markers.
 */
async function assertVariantMemoryAcrossAgents(browser: Browser, plan: E2EPlan, scratch: string): Promise<void> {
  const { frame } = await findAgentManagerFrame(browser, plan, plan.variantTitle, 60_000)
  const timeout = 30_000

  await waitForFile(join(scratch, "variant-ready"), 60_000, "variant-ready marker")

  // Open the variant session tab; its chat resolves to kilo/e2e-probe via the
  // seeded transcript recovery, so the ThinkingSelector is interactive.
  await clickTab(frame, plan.variantId, timeout)
  await waitForLabel(frame, ".thinking-selector-trigger-label", "Low", timeout, "initial variant (variants[0])")

  // Resolve the two agents from the real ModeSwitcher instead of assuming
  // builtin names (the machine's config may replace the builtin catalog).
  const deadline = Date.now() + timeout
  let aLabel = ""
  let bLabel = ""
  for (;;) {
    const mode = await labelText(frame, ".mode-switcher-trigger-label")
    const options = mode ? (await agentOptions(frame, timeout)).options : []
    if (mode && options.length > 0) {
      aLabel = mode
      bLabel = options.find((name) => name !== mode) ?? ""
      if (bLabel) break
    }
    if (Date.now() > deadline) {
      throw new Error(
        `probe: could not resolve two switchable agents. mode="${mode ?? "<none>"}" options=[${options.join(", ")}]`,
      )
    }
    await sleep(250)
  }
  console.log(`[probe] variant scenario agents: A="${aLabel}" B="${bLabel}"`)

  // Agent A picks "Low" explicitly → session-scoped key for A.
  await pickVariant(frame, "Low", timeout)
  await waitForLabel(frame, ".thinking-selector-trigger-label", "Low", timeout, "agent A picks low")

  // Switch to agent B: the model stays e2e-probe (per-agent model memory), and
  // B has no own variant yet — the legacy model memory ("low") applies.
  await pickAgent(frame, bLabel, timeout)
  await waitForLabel(frame, ".mode-switcher-trigger-label", bLabel, timeout, "agent switched to B")
  await waitForLabel(
    frame,
    ".thinking-selector-trigger-label",
    "Low",
    timeout,
    "agent B inherits model memory before picking",
  )

  // Agent B picks "High" → session-scoped key for B.
  await pickVariant(frame, "High", timeout)
  await waitForLabel(frame, ".thinking-selector-trigger-label", "High", timeout, "agent B picks high")

  // Back to A: must restore "Low" — the regression assertion. Pre-fix, the
  // agent-less session key shadows this and shows B's "High".
  await pickAgent(frame, aLabel, timeout)
  await waitForLabel(frame, ".mode-switcher-trigger-label", aLabel, timeout, "agent switched back to A")
  await waitForLabel(
    frame,
    ".thinking-selector-trigger-label",
    "Low",
    timeout,
    "agent A restores low in-session (LOCK-001)",
  )

  // Back to B: restores "High".
  await pickAgent(frame, bLabel, timeout)
  await waitForLabel(frame, ".mode-switcher-trigger-label", bLabel, timeout, "agent switched back to B")
  await waitForLabel(
    frame,
    ".thinking-selector-trigger-label",
    "High",
    timeout,
    "agent B restores high in-session (LOCK-001)",
  )

  writeFileSync(
    join(scratch, "variant-dom-evidence"),
    JSON.stringify(
      {
        url: frame.url(),
        plan,
        agentA: aLabel,
        agentB: bLabel,
        variant: await labelText(frame, ".thinking-selector-trigger-label"),
        agent: await labelText(frame, ".mode-switcher-trigger-label"),
      },
      null,
      2,
    ),
  )
  console.log("[probe] variant memory across agents passed")
}

// ---------------------------------------------------------------------------
// Derived Topic navigation lifecycle convergence — real webview
// ---------------------------------------------------------------------------

/**
 * Real-webview E2E for derived Topic navigation over the migration bridge.
 * Proves the real AgentManagerApp re-derives and converges Topic/session
 * presentation across all three extension-owned view boundaries:
 *
 *   1. Session navigation: the seeded parentID hierarchy [root T1 → child T1C]
 *      + sibling root T2 renders as two Topics (T1 with member T1C, T2), with
 *      no worktree dependency; clicking the sibling Topic row opens its
 *      session and converges the active tab + header + active-Topic highlight;
 *      clicking the child row converges to the child with the Topic highlight
 *      back on its root.
 *   2. Panel close/reopen: the runner closes the Agent Manager editor tab,
 *      reopens it, and rehydrates the fixture state; the fresh webview
 *      re-derives the same Topic hierarchy and converges to the same active
 *      state (active tab + header + active-Topic highlight).
 *   3. Webview reload: the harness reloads the Agent Manager OOPIF frame and
 *      re-finds it; after the runner rehydrates, the new document re-derives
 *      the same hierarchy and converges to the same active state.
 *
 * All interaction is with the real production DOM: sidebar topic/child rows,
 * tab strip, and TaskHeader. The child row is asserted under the expanded
 * root Topic (auto-expand on active Topic) and both Topic-root and child-row
 * highlight classes are asserted.
 */
async function assertTopicNavigation(browser: Browser, plan: E2EPlan, scratch: string): Promise<void> {
  const timeout = 30_000

  // Anchor on the seeded root tab title (T1 is the only open tab initially).
  const found = await findAgentManagerFrame(browser, plan, plan.topicRootTitle, 60_000)
  const frame = found.frame

  // Phase 1: seeded runtime-derived hierarchy, active tab, header, no worktree.
  const seededTopics: SidebarTopicState[] = [
    {
      id: plan.topicRootId,
      label: plan.topicRootTitle,
      active: true,
      children: [{ id: plan.topicChildId, label: plan.topicChildTitle, active: false }],
    },
    { id: plan.topicSiblingId, label: plan.topicSiblingTitle, active: false, children: [] },
  ]
  await expectTopicHierarchy(frame, seededTopics, timeout, "seeded topic hierarchy (parentID-derived)")
  await assertNoWorktree(frame, "seeded sidebar has no worktree dependency")
  await expectTabOrder(
    frame,
    [plan.topicRootId],
    [plan.topicRootTitle],
    plan.topicRootId,
    plan.topicRootTitle,
    timeout,
    "seeded tab order",
  )
  await expectHeaderTitle(frame, plan.topicRootTitle, timeout, "seeded header converges to root title")

  // Phase 2: Topic-click navigation — the sibling root is NOT an open tab, so
  // clicking its Topic row exercises the production open-session path.
  await clickSidebarTopic(frame, plan.topicSiblingId, timeout)
  await expectTabOrder(
    frame,
    [plan.topicRootId, plan.topicSiblingId],
    [plan.topicRootTitle, plan.topicSiblingTitle],
    plan.topicSiblingId,
    plan.topicSiblingTitle,
    timeout,
    "topic click opens sibling root tab",
  )
  await expectHeaderTitle(frame, plan.topicSiblingTitle, timeout, "header converges to sibling root title")
  await expectTopicHierarchy(
    frame,
    [
      {
        id: plan.topicRootId,
        label: plan.topicRootTitle,
        active: false,
        children: [{ id: plan.topicChildId, label: plan.topicChildTitle, active: false }],
      },
      { id: plan.topicSiblingId, label: plan.topicSiblingTitle, active: true, children: [] },
    ],
    timeout,
    "active topic highlight moves to sibling root",
  )

  // Phase 3: child-click navigation — the child row under the expanded root
  // Topic. Clicking it focuses the child; the active-Topic highlight returns
  // to the root Topic and the child row itself highlights.
  await clickSidebarChild(frame, plan.topicChildId, timeout)
  await expectTabOrder(
    frame,
    [plan.topicRootId, plan.topicSiblingId, plan.topicChildId],
    [plan.topicRootTitle, plan.topicSiblingTitle, plan.topicChildTitle],
    plan.topicChildId,
    plan.topicChildTitle,
    timeout,
    "child click opens child tab",
  )
  await expectHeaderTitle(frame, plan.topicChildTitle, timeout, "header converges to child title")
  await expectTopicHierarchy(
    frame,
    [
      {
        id: plan.topicRootId,
        label: plan.topicRootTitle,
        active: true,
        children: [{ id: plan.topicChildId, label: plan.topicChildTitle, active: true }],
      },
      { id: plan.topicSiblingId, label: plan.topicSiblingTitle, active: false, children: [] },
    ],
    timeout,
    "active topic returns to root with active child",
  )
  console.log("[probe] topic navigation convergence passed")
  // Navigation boundary complete — the runner closes/reopens the panel.
  writeFileSync(join(scratch, "topic-nav-done"), "ok")

  // Phase 4: panel close/reopen. The runner closed the editor tab, reopened
  // the panel, and rehydrated the canonical state (all tabs, child active).
  // Re-find the frame (the seeded root tab title anchors the new webview) and
  // assert the SAME runtime-derived hierarchy + active state.
  await waitForFile(join(scratch, "topic-reopen-ready"), 120_000, "topic-reopen-ready marker")
  const reopened = await findAgentManagerFrame(browser, plan, plan.topicRootTitle, 60_000)
  const reopenedFrame = reopened.frame
  const convergedTopics: SidebarTopicState[] = [
    {
      id: plan.topicRootId,
      label: plan.topicRootTitle,
      active: true,
      children: [{ id: plan.topicChildId, label: plan.topicChildTitle, active: true }],
    },
    { id: plan.topicSiblingId, label: plan.topicSiblingTitle, active: false, children: [] },
  ]
  await expectTopicHierarchy(reopenedFrame, convergedTopics, timeout, "reopen re-derives topic hierarchy")
  await assertNoWorktree(reopenedFrame, "reopened sidebar has no worktree dependency")
  await expectTabOrder(
    reopenedFrame,
    [plan.topicRootId, plan.topicChildId, plan.topicSiblingId],
    [plan.topicRootTitle, plan.topicChildTitle, plan.topicSiblingTitle],
    plan.topicChildId,
    plan.topicChildTitle,
    timeout,
    "reopen active tab converges to child",
  )
  await expectHeaderTitle(reopenedFrame, plan.topicChildTitle, timeout, "reopen header converges to child title")
  console.log("[probe] panel close/reopen convergence passed")
  writeFileSync(join(scratch, "topic-reopen-done"), "ok")

  // Phase 5: webview reload. Frame-level CDP reloads cannot reload a VS Code
  // webview (both location.reload() and frame.goto() land on the host's
  // fake.html placeholder — verified against the real harness), so the harness
  // marks the pre-reload document, asks the runner to execute the host's
  // webview reload action, re-finds the FRESH (unmarked) document, signals the
  // runner to rehydrate, then asserts the same converged hierarchy + active
  // state in the new document. The webview persists its tab strip via the VS
  // Code webview state API (300ms debounce), so give it a beat before marking:
  // the fresh document then restores the open tabs/active tab natively and the
  // runner's rehydrate re-derives the topic inventory on top of that restored
  // state (the production convergence path). If the debounce had not fired,
  // the runner's rehydrate rebuilds the tabs instead — the assertion converges
  // either way.
  await sleep(1_000)
  await reloadAgentManagerFrame(reopenedFrame, scratch)
  const reloaded = await findReloadedFrame(browser, 60_000)
  const reloadedFrame = reloaded.frame
  writeFileSync(join(scratch, "topic-reload-frame"), "ok")
  await waitForFile(join(scratch, "topic-reload-ready"), 60_000, "topic-reload-ready marker")
  await expectTopicHierarchy(reloadedFrame, convergedTopics, timeout, "reload re-derives topic hierarchy")
  await assertNoWorktree(reloadedFrame, "reloaded sidebar has no worktree dependency")
  await expectTabOrder(
    reloadedFrame,
    [plan.topicRootId, plan.topicChildId, plan.topicSiblingId],
    [plan.topicRootTitle, plan.topicChildTitle, plan.topicSiblingTitle],
    plan.topicChildId,
    plan.topicChildTitle,
    timeout,
    "reload active tab converges to child",
  )
  await expectHeaderTitle(reloadedFrame, plan.topicChildTitle, timeout, "reload header converges to child title")
  console.log("[probe] webview reload convergence passed")

  writeFileSync(
    join(scratch, "topic-dom-evidence"),
    JSON.stringify(
      {
        url: reloadedFrame.url(),
        plan,
        topics: await sidebarTopicStates(reloadedFrame),
        tabs: await tabStates(reloadedFrame),
        header: await headerTitle(reloadedFrame),
      },
      null,
      2,
    ),
  )
  writeFileSync(join(scratch, "topic-reload-done"), "ok")
}

// ---------------------------------------------------------------------------
// Real-session parity scenario — real backend sessions via the production path
// ---------------------------------------------------------------------------

/** Prompt texts typed into the real Agent Manager prompt input. */
const REAL_PROMPT_A = "E2E parity prompt A: custom agent plus low variant"
const REAL_PROMPT_B = "E2E parity prompt B: custom agent B plus high variant"

/**
 * A run-owned TCP listener that accepts connections and never responds. The
 * seeded custom provider points its baseURL here, so every real prompt stays
 * busy (waiting for response headers) until the production abort path cancels
 * it — making H-8 concurrency and H-11 abort observable against backend truth.
 * The listener is in-process (it dies with the harness) and is closed
 * explicitly on both success and failure paths; no global kills, no external
 * processes.
 */
async function createHangServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    // Hold the connection open and never write a response; socket errors from
    // the client-side abort are expected and ignored here (the abort is the
    // production path under test, not a harness failure).
    socket.on("error", () => {})
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address !== "object") {
    server.close()
    throw new Error("probe: hang server address unavailable")
  }
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * Run-owned workspace config seed for the real-session scenario, written into
 * the scratch workspace's `.kilo/kilo.json` BEFORE VS Code launches so the
 * lazily-spawned CLI backend loads it at startup (project-config convention:
 * the CLI loads `.kilo/kilo.json` from the instance cwd, which the extension
 * pins to the first workspace folder). Seeds:
 *   - a custom provider `e2e-local` (bundled @ai-sdk/openai-compatible) whose
 *     model `e2e-model` carries three reasoning variants and whose baseURL
 *     points at the run-owned hang server — with every request-phase timeout
 *     disabled (timeout/headerTimeout/firstChunkTimeout false) so the prompt
 *     stays busy until the production abort path cancels it,
 *   - two custom primary agents (`e2e-agent`, `e2e-agent-b`) bound to that
 *     model, which the real ModeSwitcher lists and the backend pins on the
 *     created user messages,
 *   - `model` default = e2e-local/e2e-model so the real webview selects the
 *     custom model without any synthetic providersLoaded post.
 *   - `small_model` + `subagent_model` = e2e-local/e2e-model so EVERY implicit
 *     generation (title, summaries, subagent) resolves to the run-owned
 *     provider — Provider.getSmallModel honors cfg.small_model before any kilo
 *     gateway fallback (kilo/kilo-auto/small). LOCK-006: zero gateway attempts.
 */
function writeRealSessionConfig(workspace: string, hangPort: number): string {
  const dir = join(workspace, ".kilo")
  mkdirSync(dir, { recursive: true })
  const file = join(dir, "kilo.json")
  writeFileSync(
    file,
    JSON.stringify(
      {
        $schema: "https://app.kilo.ai/config.json",
        provider: {
          "e2e-local": {
            npm: "@ai-sdk/openai-compatible",
            name: "E2E Local",
            options: {
              baseURL: `http://127.0.0.1:${hangPort}/v1`,
              apiKey: "e2e-fixture-key",
              timeout: false,
              headerTimeout: false,
              firstChunkTimeout: false,
            },
            models: {
              "e2e-model": {
                name: "E2E Model",
                variants: { low: {}, medium: {}, high: {} },
              },
            },
          },
        },
        agent: {
          "e2e-agent": {
            displayName: "E2E Agent",
            description: "E2E parity custom agent",
            mode: "primary",
            model: "e2e-local/e2e-model",
          },
          "e2e-agent-b": {
            displayName: "E2E Agent B",
            description: "E2E parity custom agent B",
            mode: "primary",
            model: "e2e-local/e2e-model",
          },
        },
        model: "e2e-local/e2e-model",
        small_model: "e2e-local/e2e-model",
        subagent_model: "e2e-local/e2e-model",
      },
      null,
      2,
    ),
  )
  return file
}

/** Click the real New session button via visible semantic action (re-acquires AM frame, never via split container). */
async function clickNewSession(browser: Browser, timeoutMs: number): Promise<Frame> {
  const frame = await clickRealNewSessionAction(browser, timeoutMs)
  console.log("[probe] clicked New session (production add-pending path via semantic action)")
  return frame
}

/** Click the real Stop button (production abort path: webview → extension → SDK abort). */
async function clickStop(frame: Frame, timeoutMs: number): Promise<void> {
  const stop = frame.locator('button[aria-label="Stop"]').first()
  await stop.waitFor({ state: "visible", timeout: timeoutMs })
  await stop.click({ timeout: timeoutMs })
  console.log("[probe] clicked Stop (production abort path)")
}

/** Concatenated user-message text of one session from the backend snapshot. */
function userText(snap: BackendSnapshot, id: string): string {
  const user = (snap.messages[id] ?? []).find((m) => m.role === "user")
  return user?.text ?? ""
}

/**
 * Real-webview E2E for the first parity cluster. Drives the REAL Agent Manager
 * webview — prompt input, Send/Stop buttons, ModeSwitcher, ThinkingSelector,
 * tab strip, New session — over the production webview → AgentManagerProvider
 * → KiloProvider → SDK → served-backend path, then asserts served-backend
 * truth via the backendSnapshot fixture command:
 *
 *   1. H-1 + H-9: the real ModeSwitcher lists the seeded custom agent (proving
 *      the run-owned config reached the served backend), the harness picks the
 *      custom agent + a reasoning variant, sends prompt A, and the backend
 *      pins the session's user message to that agent and the custom-provider
 *      model + variant,
 *   2. H-8: a second real session is created through the same path while the
 *      first is still busy; both run concurrently and each stays pinned to its
 *      own agent/variant,
 *   3. H-11: each session is aborted independently via the real Stop button
 *      (the other stays busy), then one tab is closed via the real close
 *      button and the backend confirms the session persists (view lifecycle
 *      only — no owned handle is leaked),
 *   4. H-10: the panel is closed and reopened; the fresh webview re-fetches the
 *      real session list from the backend and the surviving session's
 *      transcript rehydrates into the real DOM.
 */
async function assertRealSessionLifecycle(browser: Browser, plan: E2EPlan, scratch: string): Promise<void> {
  const timeout = 30_000
  // P4.2 fresh canonical gate must be proven BEFORE the first canonical-era session is created (mirrors restartPhase0).
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
    if (!existsSync(join(scratch, "canonical-archive-before.json"))) {
      throw new Error("probe: canonical-archive-before.json missing before first session")
    }
    const dataRoot = (gate as Record<string, unknown>).dataRoot as string | undefined
    if (typeof dataRoot === "string" && !isIsolatedDataRoot(scratch, dataRoot)) {
      throw new Error(`probe: canonical dataRoot not isolated inside scratch: ${dataRoot}`)
    }
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
  await waitForFile(join(scratch, "real-ready"), 120_000, "real-ready marker")
  {
    const credFile = join(scratch, "rs-credential.json")
    await waitForFile(credFile, timeout, "rs-credential.json (credential provisioning evidence)")
    const cred = JSON.parse(readFileSync(credFile, "utf8")) as Record<string, unknown>
    console.log(`[probe] credential provisioning (pre-real-ready): ${JSON.stringify(cred)}`)
    if (cred.ok !== true)
      throw new Error(`probe: credential provisioning failed before real-ready: ${JSON.stringify(cred)}`)
    const connected = (cred as { connected?: unknown }).connected
    if (!Array.isArray(connected) || !connected.includes(plan.customProvider)) {
      throw new Error(`probe: credential evidence missing connected ${plan.customProvider}: ${JSON.stringify(cred)}`)
    }
    if ((cred as { defaultModel?: unknown }).defaultModel !== `${plan.customProvider}/${plan.customModel}`) {
      throw new Error(`probe: credential evidence wrong defaultModel: ${JSON.stringify(cred)}`)
    }
  }
  {
    const fresh = await requestRsSeedCredential(scratch, timeout)
    console.log(`[probe] credential seeding round-trip: ${JSON.stringify(fresh)}`)
    if (fresh.ok !== true) throw new Error(`probe: credential round-trip failed: ${JSON.stringify(fresh)}`)
  }

  // The panel opens with a single pending "New Session" tab; the frame is
  // anchored by any .am-tab-sortable tab (never rendered by the editor-tab
  // webview).
  const found = await findAgentManagerFrameAny(browser, 60_000)
  let frame = found.frame
  const snap = snapshotClient(scratch)

  const cstate = await requestRsCanonicalState(scratch, timeout)
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

  // --- Phase 1 (H-1 + H-9): custom agent served, selected; variant picked ---
  await waitForAgentOption(frame, plan.customAgentLabel, timeout)
  await pickAgent(frame, plan.customAgentLabel, timeout)
  await waitForLabel(frame, ".mode-switcher-trigger-label", plan.customAgentLabel, timeout, "custom agent selected")
  await pickVariant(frame, plan.customVariantA, timeout)
  await waitForLabel(frame, ".thinking-selector-trigger-label", plan.customVariantA, timeout, "variant A selected")
  // LOCK-012 action-specific readiness: the visible model selector must show the
  // custom provider/model before the first send — until it does, the webview
  // model resolution falls through to the gateway KILO_AUTO free model
  // (kilo/kilo-auto/free), a real gateway call (LOCK-006 violation).
  await waitForModelSelected(frame, plan.customProvider, plan.customModel, timeout, "custom model visibly selected")
  const expA = pinExpect(plan, plan.customAgent, plan.customVariantA)

  // --- Phase 2 (H-11 create): send prompt A through the production path ---
  const snapA = await sendWithRetry(
    frame,
    snap,
    REAL_PROMPT_A,
    1,
    (s) => {
      if (s.sessions.length < 1) return "no backend session yet"
      const id = s.sessions[0]!.id
      const pinned = pinnedReason(s, id, expA, REAL_PROMPT_A)
      if (pinned) return pinned
      if ((s.statuses[id] ?? "idle") !== "busy") return `session ${id} status=${s.statuses[id]} expected busy`
      return undefined
    },
    "session A created via production path, pinned and busy",
    timeout,
    isWrongPin,
  )
  const sessionA = snapA.sessions[0]!
  console.log(`[probe] session A: ${sessionA.id}`)

  // --- Phase 3 (H-8): second concurrent session with a different agent+model (re-acquired AM frame) ---
  frame = await clickNewSession(browser, timeout)
  await waitForAgentOption(frame, plan.customAgentBLabel, timeout)
  await pickAgent(frame, plan.customAgentBLabel, timeout)
  await waitForLabel(frame, ".mode-switcher-trigger-label", plan.customAgentBLabel, timeout, "custom agent B selected")
  await pickVariant(frame, plan.customVariantB, timeout)
  await waitForLabel(frame, ".thinking-selector-trigger-label", plan.customVariantB, timeout, "variant B selected")
  const expB = pinExpect(plan, plan.customAgentB, plan.customVariantB)
  const snapB = await sendWithRetry(
    frame,
    snap,
    REAL_PROMPT_B,
    2,
    (s) => {
      if (s.sessions.length < 2) return `expected 2 backend sessions, got ${s.sessions.length}`
      const b = s.sessions.find((x) => x.id !== sessionA.id)
      if (!b) return "session B missing from backend"
      const failA = pinnedReason(s, sessionA.id, expA, REAL_PROMPT_A)
      if (failA) return `A: ${failA}`
      const failB = pinnedReason(s, b.id, expB, REAL_PROMPT_B)
      if (failB) return `B: ${failB}`
      if ((s.statuses[sessionA.id] ?? "idle") !== "busy" || (s.statuses[b.id] ?? "idle") !== "busy") {
        return `expected both busy, got A=${s.statuses[sessionA.id]} B=${s.statuses[b.id]}`
      }
      return undefined
    },
    "two concurrent sessions pinned to their own agent/variant and busy",
    timeout,
    isWrongPin,
  )
  const sessionB = snapB.sessions.find((x) => x.id !== sessionA.id)!
  console.log(`[probe] session B: ${sessionB.id}`)

  // --- Phase 4 (H-11 abort, independent control): abort A, then B ---
  // The backend status endpoint deletes idle sessions from its map (absent
  // status == idle), so the probes below normalize `undefined` to "idle".
  await clickTab(frame, sessionA.id, timeout)
  await clickStop(frame, timeout)
  await snap.waitFor(
    (s) => {
      const a = s.statuses[sessionA.id] ?? "idle"
      if (a !== "idle") return `session A status=${a} expected idle after abort`
      if (s.statuses[sessionB.id] !== "busy")
        return `session B status=${s.statuses[sessionB.id]} expected still busy (independent control)`
      return undefined
    },
    60_000,
    "abort A leaves A idle and B busy",
  )
  await clickTab(frame, sessionB.id, timeout)
  await clickStop(frame, timeout)
  await snap.waitFor(
    (s) => {
      const b = s.statuses[sessionB.id] ?? "idle"
      if (b !== "idle") return `session B status=${b} expected idle after abort`
      return undefined
    },
    60_000,
    "abort B leaves B idle",
  )

  // --- Phase 5 (H-11 close): close tab A; the backend session must persist ---
  await clickTab(frame, sessionA.id, timeout)
  await clickTabClose(frame, sessionA.id, timeout)
  await waitForRealSessionTabs(frame, 1, timeout, "tab A closed leaves session B tab")
  await snap.waitFor(
    (s) => {
      if (!s.sessions.some((x) => x.id === sessionA.id)) {
        return "session A deleted from backend by tab close (close must be view lifecycle only)"
      }
      return undefined
    },
    30_000,
    "closed session A persists in the backend",
  )

  // LOCK-006/LOCK-008: request-level isolation — every backend generation
  // request so far (agent turns + any implicit title call) is e2e-local/e2e-model.
  // The fixture collector sees the `service=llm` line BEFORE provider/network
  // resolution, so a failed/aborted non-run-owned attempt fails here even while
  // session pins look correct.
  assertRunOwnedLlmRequests(scratch, "real-session-post-abort")

  // --- Phase 6 (H-10): panel close/reopen rehydrates the transcript ---
  // Give the webview's 300ms local-state persist debounce a beat so the tab
  // inventory is durable before the panel is disposed, then hand the panel
  // lifecycle to the runner (tab-groups close + reopen + settle).
  await sleep(1_000)
  writeFileSync(join(scratch, "real-reopen-request"), "ok")
  await waitForFile(join(scratch, "real-reopen-ready"), 120_000, "real-reopen-ready marker")
  const reopened = await findAgentManagerFrameAny(browser, 60_000)
  const rf = reopened.frame

  // The fresh webview re-fetches the real session list (the runner settled it
  // after reopen). Session B may restore as a tab (webview state) or appear
  // only as a sidebar row; open it either way, then assert its transcript
  // rehydrated from the served backend into the real DOM.
  const deadlineOpen = Date.now() + 60_000
  for (;;) {
    const tabs = await realTabStates(rf)
    if (tabs.some((t) => t.id === sessionB.id)) break
    const sidebarHit = await rf
      .locator(`.am-item.am-topic-root[data-topic-id="${sessionB.id}"]`)
      .count()
      .catch(() => 0)
    if (sidebarHit > 0) {
      await openSidebarSession(rf, sessionB.id, 10_000)
      break
    }
    if (Date.now() > deadlineOpen) {
      throw new Error("probe: session B not restored as a tab or sidebar row after panel reopen")
    }
    await sleep(250)
  }
  await expectTranscriptText(rf, REAL_PROMPT_B, 60_000, "session B transcript rehydrates after panel reopen")
  await snap.waitFor(
    (s) => {
      const text = userText(s, sessionB.id)
      if (!text.includes(REAL_PROMPT_B)) return "session B transcript missing the prompt in the backend after reopen"
      return undefined
    },
    30_000,
    "session B backend transcript persists",
  )

  // Backend pin evidence for every UI send of this scenario (LOCK-006): each
  // user message must be pinned to e2e-local/e2e-model + the expected variant
  // and the selected custom agent in the FINAL served state — no gateway
  // KILO_AUTO free fallback or non-run-owned provider anywhere in the run.
  const finalPinSnap = await snap.request()
  const pinEvidence = [
    pinReport(finalPinSnap, sessionA.id, expA, REAL_PROMPT_A),
    pinReport(finalPinSnap, sessionB.id, expB, REAL_PROMPT_B),
  ]
  console.log(`[probe] PIN EVIDENCE: ${JSON.stringify(pinEvidence, null, 2)}`)

  // Final request-level isolation (LOCK-006/LOCK-008): every generation request
  // of the whole run — including implicit title calls and reopened-panel turns.
  const llmFinal = assertRunOwnedLlmRequests(scratch, "real-session-final")

  writeFileSync(
    join(scratch, "real-dom-evidence"),
    JSON.stringify(
      {
        url: rf.url(),
        plan,
        sessionA: sessionA.id,
        sessionB: sessionB.id,
        pins: pinEvidence,
        llmRequests: readLlmRequests(scratch),
        llmMatrix: llmFinal,
        finalTabs: await realTabStates(rf),
        finalHeader: await headerTitle(rf),
      },
      null,
      2,
    ),
  )
  console.log("[probe] real-session lifecycle passed")
}

// ---------------------------------------------------------------------------
// Real-completed-turn parity scenario — H-2..H-7 over the shared bridge
// ---------------------------------------------------------------------------

/** Prompt texts typed into the real Agent Manager prompt input. */
const REAL_TASK_PROMPT = `${SCRIPTED.taskMarker}: delegate one read-only sub-task that only replies with a fixed text string, wait for it, and report its reply verbatim`
const REAL_USER_TOOL_PROMPT = `${SCRIPTED.userToolMarker}: call the user-defined tool`
const REAL_SKILL_PROMPT = `${SCRIPTED.skillMarker}: load the e2e skill`
const REAL_MCP_PROMPT = `${SCRIPTED.mcpMarker}: call the mcp echo tool`
const REAL_PERMISSION_PROMPT = `${SCRIPTED.permissionMarker}: read the ask.txt file`
const REAL_QUESTION_PROMPT = `${SCRIPTED.questionMarker}: ask me a question`

/** Click the real PermissionDock "Allow once" button (production kilo-ui Button). */
async function clickPermissionAllowOnce(frame: Frame, timeoutMs: number): Promise<void> {
  const btn = frame
    .locator('[data-slot="permission-actions"] [data-component="button"][data-variant="primary"]')
    .first()
  await btn.waitFor({ state: "visible", timeout: timeoutMs })
  await btn.click({ timeout: timeoutMs })
  console.log("[probe] clicked PermissionDock Allow once")
}

/** Click one QuestionDock option (by exact label) then the footer Submit button. */
async function clickQuestionAnswer(frame: Frame, optionLabel: string, timeoutMs: number): Promise<void> {
  const dock = frame.locator('[data-component="question-dock"]').first()
  const option = dock
    .locator('button[data-slot="question-option"]')
    .filter({ has: frame.locator('[data-slot="option-label"]').getByText(optionLabel, { exact: true }) })
    .first()
  await option.waitFor({ state: "visible", timeout: timeoutMs })
  await option.click({ timeout: timeoutMs })
  console.log(`[probe] clicked QuestionDock option "${optionLabel}"`)
  const submit = dock
    .locator('[data-slot="question-dock-footer"] [data-component="button"][data-variant="primary"]')
    .first()
  await submit.waitFor({ state: "visible", timeout: timeoutMs })
  await submit.click({ timeout: timeoutMs })
  console.log("[probe] clicked QuestionDock Submit")
}

/**
 * Exact-recorded-handle scan for the run-owned MCP stdio child: every process
 * whose command line contains the absolute fixture server path. The seed's MCP
 * config uses the absolute path, so this is the run-owned handle — never a
 * process-name or pattern kill.
 */
function mcpChildPids(serverPath: string): number[] {
  const proc = spawnSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" })
  const out = proc.stdout ?? ""
  return out
    .split("\n")
    .filter((line) => line.includes(serverPath))
    .map((line) => line.trim())
    .map((line) => {
      const space = line.indexOf(" ")
      return Number(line.slice(0, space))
    })
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

async function waitForMcpChildPids(serverPath: string, timeoutMs: number, label: string): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pids = mcpChildPids(serverPath)
    if (pids.length > 0) {
      console.log(`[probe] PASS ${label}: ${pids.join(", ")}`)
      return pids
    }
    if (Date.now() > deadline) {
      throw new Error(`probe: ${label} failed: no process references ${serverPath}`)
    }
    await sleep(250)
  }
}

/**
 * Real-webview E2E for the completed-turn parity cluster. Drives the REAL
 * Agent Manager webview — prompt input, Send, ModeSwitcher, the inline
 * PermissionDock/QuestionDock, and the tab strip — over the production webview
 * → AgentManagerProvider → KiloProvider → SDK → served-backend path, against a
 * run-owned scripted OpenAI-compatible SSE provider (script/e2e-scripted-model.ts).
 * Served-backend truth is asserted via the backendSnapshot fixture command:
 *
 *   1. H-2: the prompt triggers a real `task` delegation; the backend creates a
 *      real child session (parentID set), the child's own prompt completes
 *      against the scripted provider, and the completed task tool part in the
 *      PARENT transcript carries the child id + the delegated result; the
 *      panel renders the completed turn text and the child-open button,
 *   2. H-3: the seeded .kilo/tool user tool executes; its completed tool part
 *      is backend-observable and the run-owned artifact file exists,
 *   3. H-4: the seeded skill is loaded through the skill tool; its completed
 *      part returns the skill content,
 *   4. H-5: the seeded MCP server reaches connected status, its tool executes
 *      (log written), and the run-owned child PID is recorded,
 *   5. H-6: a permission ask surfaces the real PermissionDock; clicking
 *      "Allow once" drains the backend pending permission and the turn
 *      completes; a question ask surfaces the real QuestionDock; answering
 *      drains the backend pending question and the turn completes,
 *   6. H-7: the runner closes/reopens the panel; the backend parentID/children
 *      facts persist and the reopened panel renders the parent topic with the
 *      child row (real hierarchy, no synthetic injection),
 *   7. H-5 cleanup: the runner disconnects the MCP server through the real SDK
 *      and every recorded child PID exits; the snapshot shows disabled.
 *   8. H-12 rollback (on the reopened panel): the production write tool edits a
 *      tracked file, the real user-message "Revert to here" control runs
 *      production SessionRevert+Snapshot and restores the exact initial bytes,
 *      the RevertBanner renders the per-file diff, and the real "Redo All"
 *      button invokes production unrevert and restores the edited bytes.
 */
/**
 * H-12 rollback phase of the real-completed scenario (called after the panel
 * reopen and MCP cleanup). Drives the REAL Agent Manager webview (the
 * reopened frame `rf`) through two completed turns against the scripted
 * provider — the production write tool edits a tracked file, then a plain
 * summary turn — and then clicks the real user-message "Revert to here"
 * control. Production SessionRevert+Snapshot restores the exact initial
 * bytes, the RevertBanner renders the per-file diff, and the real "Redo All"
 * button invokes production unrevert and restores the edited bytes. Asserts
 * served-backend revert/checkpoint facts and lifecycle correctness. Returns
 * the revert boundary user-message id for the caller's evidence.
 */

async function assertRealCompletedLifecycle(
  browser: Browser,
  plan: E2EPlan,
  scratch: string,
  workspace: string,
  mcpServerFile: string,
  model: ScriptedModelHandle,
): Promise<void> {
  const timeout = 30_000
  await waitForFile(join(scratch, "real-completed-ready"), 120_000, "real-completed-ready marker")
  const found = await findAgentManagerFrameAny(browser, 60_000)
  const frame = found.frame
  const snap = snapshotClient(scratch, "rc-snap")

  // Send a prompt through the real input and poll served-backend truth until
  // `probe` passes. Bounded retries: a transiently failed send restores the
  // draft into the input (sendMessageFailed → restoreFailed), and the scripted
  // provider is idempotent per marker (a re-sent marker with the tool already
  // in the transcript gets the final text), so a retry never double-executes.
  // The target frame is explicit so post-reopen phases send through the fresh
  // webview document (the pre-reopen frame is detached once the panel closes).
  // EVERY send carries the shared backend pin predicate (e2e-pin.ts withPin) so
  // a wrong-pinned send is a permanent non-retryable failure, never masked by a
  // retry (LOCK-006/LOCK-008).
  const exp = pinExpect(plan, plan.customAgent, plan.customVariantA)
  const sendTurn = async (
    target: Frame,
    prompt: string,
    probe: (s: BackendSnapshot) => string | undefined,
    label: string,
  ): Promise<BackendSnapshot> => {
    return sendTurnWithPin(
      target,
      snap,
      prompt,
      probe,
      label,
      timeout,
      { exp, prompt, sessionID: (s) => realRootSession(s)?.id },
      (err) => {
        console.error(
          "[probe] model request log:",
          JSON.stringify(
            model.requests.map((r) => {
              const body = r.body as { messages?: Array<{ role?: string; content?: unknown }> }
              const last = [...(body?.messages ?? [])].reverse().find((m) => m?.role === "user")
              return {
                url: r.url,
                lastUser: typeof last?.content === "string" ? last.content : JSON.stringify(last?.content),
              }
            }),
            null,
            2,
          ),
        )
        if (!(err instanceof Error)) return
        console.error(`[probe] turn failure (attempt will be retried or aborted): ${err.message}`)
      },
    )
  }

  // --- Phase 0: pick the seeded custom agent (config reachable from the panel) ---
  await waitForAgentOption(frame, plan.customAgentLabel, timeout)
  await pickAgent(frame, plan.customAgentLabel, timeout)
  await waitForLabel(frame, ".mode-switcher-trigger-label", plan.customAgentLabel, timeout, "custom agent selected")
  // Mirror the green real-session flow: pick the reasoning variant too, so the
  // webview resolves the per-session model from the served catalog BEFORE the
  // first send (without it, the first send could race the provider catalog load
  // and fall back to KILO_AUTO, missing the scripted server). Then wait for the
  // VISIBLE custom model selection (LOCK-012): the model selector falls through
  // to the gateway KILO_AUTO free model until the config/catalog resolve, so
  // the first send must not race it.
  await pickVariant(frame, plan.customVariantA, timeout)
  await waitForLabel(frame, ".thinking-selector-trigger-label", plan.customVariantA, timeout, "variant Low selected")
  await waitForModelSelected(frame, plan.customProvider, plan.customModel, timeout, "custom model visibly selected")

  // --- Phase 1 (H-2): real task delegation with result flow-back ---
  const snapTask = await sendTurn(
    frame,
    REAL_TASK_PROMPT,
    (s) => {
      const root = realRootSession(s)
      if (!root) return "no root session yet"
      const child = s.sessions.find((x) => x.parentID === root.id)
      if (!child) return "child session missing (delegation did not create one)"
      const task = completedTool(s, root.id, "task")
      if (!task) return "task tool part missing in parent transcript"
      if (task.status !== "completed") return `task status=${task.status}`
      if (task.metadata?.["sessionId"] !== child.id) {
        return `task metadata.sessionId=${JSON.stringify(task.metadata?.["sessionId"])} expected ${child.id}`
      }
      if (!task.output?.includes(child.id)) return "task output missing the child session id"
      if (!task.output?.includes(SCRIPTED.childResult)) {
        const childText = (s.messages[child.id] ?? []).map((m) => m.text).join("\n")
        return `task output missing the delegated result.\n  task.output=${JSON.stringify(task.output?.slice(0, 500))}\n  child transcript text=${JSON.stringify(childText.slice(0, 500))}\n  root session=${JSON.stringify(root)}\n  child session=${JSON.stringify(child)}`
      }
      if ((s.statuses[root.id] ?? "idle") !== "idle") return `parent status=${s.statuses[root.id]} expected idle`
      return undefined
    },
    "H-2 delegation: backend child + completed task result in the parent",
  )
  const rootId = realRootSession(snapTask)!.id
  const childId = snapTask.sessions.find((x) => x.parentID === rootId)!.id
  console.log(`[probe] H-2 root=${rootId} child=${childId}`)
  await expectTranscriptText(frame, SCRIPTED.taskFinal, 60_000, "H-2 panel shows the completed-turn text")
  await frame
    .locator('button[aria-label="Open sub-agent in tab"]')
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
  console.log("[probe] PASS H-2 panel renders the child-open button (task linkage)")

  // --- Phase 2 (H-3): user-defined tool executes, artifact backend-observable ---
  await sendTurn(
    frame,
    REAL_USER_TOOL_PROMPT,
    (s) => {
      const root = realRootSession(s)
      if (!root) return "root session missing"
      const tool = completedTool(s, root.id, plan.realUserTool)
      if (!tool) return "e2e_marker tool part missing"
      if (tool.status !== "completed") return `e2e_marker status=${tool.status}`
      if (!tool.output?.includes("echo:hello")) return `e2e_marker output=${JSON.stringify(tool.output)}`
      if ((s.statuses[root.id] ?? "idle") !== "idle") return `parent status=${s.statuses[root.id]} expected idle`
      return undefined
    },
    "H-3 user tool: completed tool part in the backend",
  )
  const artifactFile = join(workspace, plan.realArtifact)
  const artifact = existsSync(artifactFile) ? readFileSync(artifactFile, "utf8") : ""
  if (artifact !== "echo:hello") {
    throw new Error(`probe: H-3 artifact missing or wrong at ${artifactFile}: ${JSON.stringify(artifact)}`)
  }
  console.log(`[probe] PASS H-3 run-owned artifact: ${artifactFile} = "echo:hello"`)
  await expectTranscriptText(frame, SCRIPTED.userToolFinal, 60_000, "H-3 panel shows the tool completion text")

  // --- Phase 3 (H-4): seeded skill loads, content returned through the skill tool ---
  await sendTurn(
    frame,
    REAL_SKILL_PROMPT,
    (s) => {
      const root = realRootSession(s)
      if (!root) return "root session missing"
      const tool = completedTool(s, root.id, "skill")
      if (!tool) return "skill tool part missing"
      if (tool.status !== "completed") return `skill status=${tool.status}`
      if (tool.title !== `Loaded skill: ${plan.realSkill}`) return `skill title=${JSON.stringify(tool.title)}`
      if (!tool.output?.includes(`<skill_content name="${plan.realSkill}">`)) {
        return `skill output missing the content wrapper: ${JSON.stringify(tool.output?.slice(0, 200))}`
      }
      if (!tool.output?.includes(SCRIPTED.skillContentMarker)) return "skill output missing the content marker"
      if ((s.statuses[root.id] ?? "idle") !== "idle") return `parent status=${s.statuses[root.id]} expected idle`
      return undefined
    },
    "H-4 skill: content returned through the real skill tool",
  )
  await expectTranscriptText(frame, SCRIPTED.skillFinal, 60_000, "H-4 panel shows the skill completion text")

  // --- Phase 4 (H-5): MCP connected, tool executes, child PID recorded ---
  await sendTurn(
    frame,
    REAL_MCP_PROMPT,
    (s) => {
      if (s.mcp?.[plan.realMcpServer] !== "connected") {
        return `mcp ${plan.realMcpServer} status=${JSON.stringify(s.mcp?.[plan.realMcpServer])} expected connected`
      }
      const root = realRootSession(s)
      if (!root) return "root session missing"
      const tool = completedTool(s, root.id, plan.realMcpTool)
      if (!tool) return "mcp tool part missing"
      if (tool.status !== "completed") return `mcp tool status=${tool.status}`
      if (!tool.output?.includes("echo:hi")) return `mcp tool output=${JSON.stringify(tool.output)}`
      if ((s.statuses[root.id] ?? "idle") !== "idle") return `parent status=${s.statuses[root.id]} expected idle`
      return undefined
    },
    "H-5 MCP: connected + tool executed inside the real loop",
  )
  const mcpLog = join(workspace, "mcp-fixture", "calls.log")
  if (!existsSync(mcpLog) || !readFileSync(mcpLog, "utf8").includes("echo:hi")) {
    throw new Error(`probe: H-5 MCP server-side log missing at ${mcpLog}`)
  }
  console.log(`[probe] PASS H-5 MCP server-side log written: ${mcpLog}`)
  // The MCP child is alive while connected — record its exact PID(s) via the
  // run-owned absolute server path (the recorded handle).
  const mcpPids = await waitForMcpChildPids(mcpServerFile, 30_000, "H-5 MCP child alive while connected")
  for (const pid of mcpPids) {
    try {
      process.kill(pid, 0)
    } catch {
      throw new Error(`probe: H-5 recorded MCP child pid ${pid} is not alive while connected`)
    }
  }

  // --- Phase 5 (H-6): permission dock — real inline PermissionDock reply ---
  // The initial send goes through sendTurn like every other phase, so a
  // transiently failed send is retried with the same bounded semantics (the
  // scripted provider is marker-idempotent, so a re-send never double-executes).
  await sendTurn(
    frame,
    REAL_PERMISSION_PROMPT,
    (s) => {
      const root = realRootSession(s)
      if (!root) return "root session missing"
      const pending = (s.pending?.permissions ?? []).find((p) => p.permission === "read" && p.sessionID === root.id)
      if (!pending) return "no pending read permission for the root session"
      return undefined
    },
    "H-6 permission: backend pending permission observable",
  )
  await waitForDock(
    frame,
    '[data-component="dock-prompt"][data-kind="permission"]',
    60_000,
    "H-6 permission dock visible",
  )
  await clickPermissionAllowOnce(frame, timeout)
  await snap.waitFor(
    (s) => {
      const root = realRootSession(s)
      if (!root) return "root session missing"
      const tool = completedTool(s, root.id, "read")
      if (!tool) return "read tool part missing"
      if (tool.status !== "completed") return `read status=${tool.status}`
      if (!tool.output?.includes(SCRIPTED.permissionSentinel)) {
        return `read output missing the sentinel: ${JSON.stringify(tool.output?.slice(0, 200))}`
      }
      if ((s.pending?.permissions ?? []).some((p) => p.sessionID === root.id)) {
        return "pending permission not drained by the reply"
      }
      if ((s.statuses[root.id] ?? "idle") !== "idle") return `parent status=${s.statuses[root.id]} expected idle`
      return undefined
    },
    90_000,
    "H-6 permission reply drains the pending request and completes",
  )
  await waitForNoDock(
    frame,
    '[data-component="dock-prompt"][data-kind="permission"]',
    timeout,
    "H-6 permission dock gone",
  )
  await expectTranscriptText(frame, SCRIPTED.permissionFinal, 60_000, "H-6 panel shows the permission completion text")

  // --- Phase 6 (H-6): question dock — real inline QuestionDock reply ---
  await sendTurn(
    frame,
    REAL_QUESTION_PROMPT,
    (s) => {
      const root = realRootSession(s)
      if (!root) return "root session missing"
      const pending = (s.pending?.questions ?? []).find(
        (q) => q.sessionID === root.id && q.questions.some((x) => x.question === "Pick an option"),
      )
      if (!pending) return "no pending question for the root session"
      return undefined
    },
    "H-6 question: backend pending question observable",
  )
  await waitForDock(frame, '[data-component="question-dock"]', 60_000, "H-6 question dock visible")
  await clickQuestionAnswer(frame, "B", timeout)
  await snap.waitFor(
    (s) => {
      const root = realRootSession(s)
      if (!root) return "root session missing"
      const tool = completedTool(s, root.id, "question")
      if (!tool) return "question tool part missing"
      if (tool.status !== "completed") return `question status=${tool.status}`
      if (!tool.output?.includes('"Pick an option"="B"')) {
        return `question output missing the answer mapping: ${JSON.stringify(tool.output)}`
      }
      if ((s.pending?.questions ?? []).some((q) => q.sessionID === root.id)) {
        return "pending question not drained by the reply"
      }
      if ((s.statuses[root.id] ?? "idle") !== "idle") return `parent status=${s.statuses[root.id]} expected idle`
      return undefined
    },
    90_000,
    "H-6 question reply drains the pending request and completes",
  )
  await waitForNoDock(frame, '[data-component="question-dock"]', timeout, "H-6 question dock gone")
  await expectTranscriptText(frame, SCRIPTED.questionFinal, 60_000, "H-6 panel shows the question completion text")

  // --- Phase 7 (H-7): panel close/reopen — hierarchy persists and renders ---
  const pre = await snap.request()
  const rootTitle = pre.sessions.find((x) => x.id === rootId)?.title ?? ""
  const childTitle = pre.sessions.find((x) => x.id === childId)?.title ?? ""
  writeFileSync(join(scratch, "real-completed-reopen-request"), "ok")
  await waitForFile(join(scratch, "real-completed-reopen-ready"), 120_000, "real-completed-reopen-ready marker")
  const reopened = await findAgentManagerFrameAny(browser, 60_000)
  const rf = reopened.frame
  await snap.waitFor(
    (s) => {
      const root = s.sessions.find((x) => x.id === rootId)
      if (!root) return "root session missing after reopen"
      const child = s.sessions.find((x) => x.id === childId)
      if (!child) return "child session missing after reopen"
      if (child.parentID !== rootId) return `child.parentID=${child.parentID} expected ${rootId}`
      if (!(s.children?.[rootId] ?? []).includes(childId)) {
        return `children[${rootId}]=${JSON.stringify(s.children?.[rootId])} missing ${childId}`
      }
      return undefined
    },
    60_000,
    "H-7 backend parentID/children facts persist after panel reopen",
  )
  // The reopened panel re-derives the hierarchy from backend facts: open the
  // root topic row (real click), then assert the child row renders under it.
  await clickSidebarTopic(rf, rootId, timeout)
  const deadlineHierarchy = Date.now() + 30_000
  for (;;) {
    const topics = await sidebarTopicStates(rf)
    const root = topics.find((t) => t.id === rootId)
    const child = root?.children.find((c) => c.id === childId)
    if (root && child) {
      console.log(
        `[probe] PASS H-7 reopened panel renders parent topic "${root.label}" with child row "${child.label}"`,
      )
      break
    }
    if (Date.now() > deadlineHierarchy) {
      throw new Error(
        `probe: H-7 hierarchy rendering failed.\n` +
          `  topics=${JSON.stringify(topics)}\n  expected root=${rootId} child=${childId}`,
      )
    }
    await sleep(250)
  }

  // --- Phase 8 (H-5 cleanup): disconnect through the real SDK, exact PIDs exit ---
  const pidsBefore = mcpChildPids(mcpServerFile)
  if (pidsBefore.length === 0) {
    throw new Error("probe: H-5 cleanup — recorded MCP child pids no longer alive before disconnect")
  }
  writeFileSync(join(scratch, "real-completed-mcp-disconnect-request"), "ok")
  await waitForFile(
    join(scratch, "real-completed-mcp-disconnect-done"),
    60_000,
    "real-completed-mcp-disconnect-done marker",
  )
  const deadlineExit = Date.now() + 30_000
  for (;;) {
    const alive = pidsBefore.filter((pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })
    if (alive.length === 0) break
    if (Date.now() > deadlineExit) {
      throw new Error(`probe: H-5 cleanup — MCP child pids still alive after disconnect: ${alive.join(", ")}`)
    }
    await sleep(250)
  }
  console.log(`[probe] PASS H-5 cleanup: recorded MCP child pids ${pidsBefore.join(", ")} exited after disconnect`)
  await snap.waitFor(
    (s) => {
      if (s.mcp?.[plan.realMcpServer] !== "disabled") {
        return `mcp ${plan.realMcpServer} status=${JSON.stringify(s.mcp?.[plan.realMcpServer])} expected disabled`
      }
      return undefined
    },
    30_000,
    "H-5 snapshot shows the MCP server disabled after disconnect",
  )

  // LOCK-006/LOCK-008: request-level isolation after H-2..H-7 — every
  // generation request so far (turns, delegated subagent, any implicit title).
  assertRunOwnedLlmRequests(scratch, "real-completed-post-h7")

  // --- Phase 9 (H-12): rollback — real write turn, Revert-to-here, Redo All ---
  // Extracted into assertRealRollbackPhase (complexity cap); the reopened panel
  // (rf) is still showing the root session, so the turns go through the FRESH
  // webview document against the same served backend session.
  const editMessageID = await assertRealRollbackPhase(rf, snap, model, workspace, timeout, plan, sendTurn)
  const rollbackFile = join(workspace, SCRIPTED.rollbackFile)
  const readRollback = () => (existsSync(rollbackFile) ? readFileSync(rollbackFile, "utf8") : "<missing>")

  // Backend pin evidence for every UI send of this scenario (LOCK-006): each
  // submitted user message must be pinned to e2e-local/e2e-model / low with the
  // custom agent in the FINAL served state — H-2..H-6, the permission/question
  // turns, and the two H-12 turns (the latter sent through the reopened webview
  // document). The per-prompt report only inspects the messages that carry that
  // prompt, so the H-12 summary pin can never be masked by the edit turn.
  const finalPinSnap = await snap.request()
  const rootFinal = realRootSession(finalPinSnap)!
  const pinEvidence = [
    pinReport(finalPinSnap, rootFinal.id, exp, REAL_TASK_PROMPT),
    pinReport(finalPinSnap, rootFinal.id, exp, REAL_USER_TOOL_PROMPT),
    pinReport(finalPinSnap, rootFinal.id, exp, REAL_SKILL_PROMPT),
    pinReport(finalPinSnap, rootFinal.id, exp, REAL_MCP_PROMPT),
    pinReport(finalPinSnap, rootFinal.id, exp, REAL_PERMISSION_PROMPT),
    pinReport(finalPinSnap, rootFinal.id, exp, REAL_QUESTION_PROMPT),
    pinReport(finalPinSnap, rootFinal.id, exp, REAL_ROLLBACK_PROMPT),
    pinReport(finalPinSnap, rootFinal.id, exp, REAL_ROLLBACK_SUMMARY_PROMPT),
  ]
  console.log(`[probe] PIN EVIDENCE: ${JSON.stringify(pinEvidence, null, 2)}`)

  // Final request-level isolation (LOCK-006/LOCK-008): every generation request
  // of the whole run — turns, subagent, compaction summary, continuation, and
  // any implicit title call. A kilo gateway title call fails here even though
  // the session pins never see it.
  const llmFinal = assertRunOwnedLlmRequests(scratch, "real-completed-final")

  writeFileSync(
    join(scratch, "real-completed-dom-evidence"),
    JSON.stringify(
      {
        url: rf.url(),
        plan,
        rootId,
        childId,
        rootTitle,
        childTitle,
        modelRequests: model.requests.map((r) => ({ url: r.url, body: r.body })),
        pins: pinEvidence,
        llmRequests: readLlmRequests(scratch),
        llmMatrix: llmFinal,
        finalTopics: await sidebarTopicStates(rf),
        finalTabs: await realTabStates(rf),
        // H-12 rollback evidence: boundary message id, exact file bytes at each
        // stage, and the backend revert/checkpoint fact.
        rollback: {
          file: SCRIPTED.rollbackFile,
          boundaryMessageID: editMessageID,
          editedBytes: readRollback(),
        },
      },
      null,
      2,
    ),
  )
  console.log("[probe] real-completed lifecycle passed")
}

// ---------------------------------------------------------------------------
// Real-overflow parity scenario — H-13 internal context-overflow safeguard
// ---------------------------------------------------------------------------

/** Prompt typed into the real Agent Manager prompt input for the overflow turn. */
const REAL_OVERFLOW_PROMPT = `${SCRIPTED.overflowMarker}: produce a very long answer and keep going`

/**
 * Real-webview E2E for the H-13 internal context-overflow safeguard. Drives the
 * REAL Agent Manager webview — prompt input, Send, ModeSwitcher,
 * ThinkingSelector — over the production webview → AgentManagerProvider →
 * KiloProvider → SDK → served-backend path, against a run-owned scripted
 * OpenAI-compatible SSE provider whose dedicated config seeds a deliberately
 * small model `limit.context` + `compaction.threshold_percent` (this config is
 * NEVER shared with real-completed's H-2..H-7 model). Served-backend truth is
 * asserted via the backendSnapshot fixture command:
 *
 *   1. the scripted first response reports usage crossing cap =
 *      context × threshold_percent, so the production step-finish overflow
 *      check deterministically fires; the served backend records a REAL
 *      large pre-compaction assistant response (the marker text that only
 *      exists when the first model call ran before compaction — a future
 *      preflight-estimate compaction cannot produce it), a REAL
 *      auto-compaction user message (typed `compaction` part, auto: true,
 *      overflow false/absent), a REAL summary assistant message
 *      (summary: true) generated against the scripted provider, and a REAL
 *      synthetic automatic-continuation user message (compaction_continue
 *      metadata) whose continuation answer completes the SAME turn — no user
 *      action, no context-management product surface involved,
 *   2. the panel renders the continuation answer and the compaction summary
 *      trace, and the session ends idle,
 *   3. the Agent Manager panel DOM has NO context-management/compact controls:
 *      no settings surface (the sidebar ContextTab is not inspected), no
 *      task-header context-menu/action content (the header popover is closed),
 *      while the pre-existing shared TaskHeader widgets are recorded as
 *      evidence, not asserted absent.
 */
async function assertRealOverflowLifecycle(
  browser: Browser,
  plan: E2EPlan,
  scratch: string,
  model: ScriptedModelHandle,
): Promise<void> {
  const timeout = 30_000
  await waitForFile(join(scratch, "real-overflow-ready"), 120_000, "real-overflow-ready marker")
  const found = await findAgentManagerFrameAny(browser, 60_000)
  const frame = found.frame
  const snap = snapshotClient(scratch, "of-snap")

  // EVERY send carries the shared backend pin predicate (e2e-pin.ts withPin):
  // the overflow prompt's user message must be pinned to the custom
  // provider/model/variant + agent — a wrong-pinned send is a permanent
  // non-retryable failure, never masked by a retry (LOCK-006/LOCK-008). The
  // synthetic automatic-continuation and compaction user messages the backend
  // generates mid-turn are excluded from the pin set (isSyntheticUser).
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

  // --- Phase 0: pick the seeded custom agent + Low variant (mirror the
  // proven real-completed flow so the first send never races the provider
  // catalog load and falls back to KILO_AUTO, missing the scripted server).
  // Then wait for the VISIBLE custom model selection (LOCK-012): the model
  // selector falls through to the gateway KILO_AUTO free model until the
  // config/catalog resolve, so the first send must not race it.
  await waitForAgentOption(frame, plan.customAgentLabel, timeout)
  await pickAgent(frame, plan.customAgentLabel, timeout)
  await waitForLabel(frame, ".mode-switcher-trigger-label", plan.customAgentLabel, timeout, "custom agent selected")
  await pickVariant(frame, plan.customVariantA, timeout)
  await waitForLabel(frame, ".thinking-selector-trigger-label", plan.customVariantA, timeout, "variant Low selected")
  await waitForModelSelected(frame, plan.customProvider, plan.customModel, timeout, "custom model visibly selected")

  // --- Phase 1 (H-13 backend): the overflow turn — large first response,
  // internal auto-compaction, and the post-compaction continuation answer, all
  // in ONE user turn with no user action beyond the single send.
  const snapTurn = await sendTurn(
    frame,
    REAL_OVERFLOW_PROMPT,
    (s) => {
      const root = realRootSession(s)
      if (!root) return "no root session yet"
      const msgs = s.messages[root.id] ?? []
      const compactionMsg = msgs.find((m) => m.compaction)
      if (!compactionMsg) {
        return `no compaction part yet; status=${s.statuses[root.id] ?? "idle"}`
      }
      if (compactionMsg.compaction?.auto !== true) {
        return `compaction.auto=${JSON.stringify(compactionMsg.compaction)} expected true (internal safeguard)`
      }
      // H-13 audit: the large pre-compaction assistant response must be in the
      // backend transcript. Its unique marker text only exists if the FIRST
      // model call ran before compaction, so a future preflight-estimate
      // compaction (no model call before compacting) can no longer pass the
      // post-response usage-threshold claim.
      const bigResponse = msgs.find((m) => m.role === "assistant" && m.text.includes(SCRIPTED.overflowBig))
      if (!bigResponse) {
        return "no pre-compaction large assistant response (E2E_OVERFLOW_BIG_RESPONSE) in the backend transcript"
      }
      // Production semantics (prompt.ts): `overflow: true` is reserved for
      // unfinished-stream provider overflow, never this usage-threshold path —
      // the served part is expected `false` or absent.
      if (compactionMsg.compaction?.overflow === true) {
        return `compaction.overflow=${JSON.stringify(compactionMsg.compaction.overflow)} expected false (usage-threshold-at-finish)`
      }
      const summaryMsg = msgs.find((m) => m.summary === true)
      if (!summaryMsg) return "no compaction summary message in the backend transcript"
      if (!summaryMsg.text.includes(SCRIPTED.compactionSummary)) {
        return `summary text missing the marker: ${JSON.stringify(summaryMsg.text.slice(0, 200))}`
      }
      const continueMsg = msgs.find((m) => m.continuation === true)
      if (!continueMsg) return "no automatic-continuation user message in the backend transcript"
      const contAnswer = msgs.find((m) => m.role === "assistant" && m.text.includes(SCRIPTED.continuationAnswer))
      if (!contAnswer) return "continuation answer missing from the backend transcript"
      if ((s.statuses[root.id] ?? "idle") !== "idle") return `parent status=${s.statuses[root.id]} expected idle`
      return undefined
    },
    "H-13 backend: compaction part + summary + automatic continuation in one turn",
  )
  const rootId = realRootSession(snapTurn)!.id
  console.log(`[probe] H-13 overflow session: ${rootId}`)

  // --- Phase 2 (H-13 UI): the panel renders the continuation answer and the
  // compaction summary trace (the invisible safeguard's transcript evidence).
  await expectTranscriptText(frame, SCRIPTED.continuationAnswer, 60_000, "H-13 panel shows the continuation answer")
  await expectTranscriptText(frame, SCRIPTED.compactionSummary, 60_000, "H-13 panel shows the compaction summary trace")

  // --- Phase 3 (H-13 panel surface): no context-management/compact controls
  // in the Agent Manager panel DOM. The sidebar ContextTab is intentionally
  // NOT inspected (LOCK-004: P3.4 removal scope). The shared TaskHeader's
  // context popover trigger is recorded as evidence only — the popover CONTENT
  // (with the Compact action) is not mounted while closed, and the panel
  // mounts no settings/context-management surface at all.
  const surface = await frame
    .evaluate(() => {
      const sel = (s: string) => document.querySelectorAll(s).length
      return {
        settingsRows: sel('[data-slot="settings-row"]'),
        headerContextMenu: sel('[data-slot="task-header-context-menu"]'),
        headerContextActions: sel('[data-slot="task-header-context-action"]'),
        contextTriggers: sel(".task-header-context-trigger"),
        promptInput: sel("textarea.prompt-input"),
        transcriptText: document.body?.innerText?.includes("E2E_CONTINUATION_ANSWER") ?? false,
      }
    })
    .catch(() => ({
      settingsRows: -1,
      headerContextMenu: -1,
      headerContextActions: -1,
      contextTriggers: -1,
      promptInput: -1,
      transcriptText: false,
    }))
  const noControls = surface.settingsRows === 0 && surface.headerContextMenu === 0 && surface.headerContextActions === 0
  if (!noControls) {
    throw new Error(
      `probe: H-13 Agent Manager panel has context-management/compact controls: ${JSON.stringify(surface)}`,
    )
  }
  console.log(`[probe] PASS H-13 panel surface: no context-management/compact controls ${JSON.stringify(surface)}`)
  if (surface.transcriptText !== true) {
    throw new Error("probe: H-13 panel transcript does not contain the continuation answer in innerText")
  }

  // Backend pin evidence for the overflow UI send (LOCK-006): the overflow
  // prompt's user message must be pinned to e2e-local/e2e-model / low with the
  // custom agent — the synthetic auto-compaction and continuation user messages
  // the backend generated mid-turn are excluded from the pin set.
  const finalPinSnap = await snap.request()
  const rootFinal = realRootSession(finalPinSnap)!
  const pinEvidence = [pinReport(finalPinSnap, rootFinal.id, exp, REAL_OVERFLOW_PROMPT)]
  console.log(`[probe] PIN EVIDENCE: ${JSON.stringify(pinEvidence, null, 2)}`)

  // Final request-level isolation (LOCK-006/LOCK-008): every generation request
  // of the run — overflow turn, compaction summary, continuation, implicit title.
  const llmFinal = assertRunOwnedLlmRequests(scratch, "real-overflow-final")

  writeFileSync(
    join(scratch, "real-overflow-dom-evidence"),
    JSON.stringify(
      {
        url: found.url,
        plan,
        rootId,
        modelRequests: model.requests.map((r) => ({ url: r.url, body: r.body })),
        pins: pinEvidence,
        llmRequests: readLlmRequests(scratch),
        llmMatrix: llmFinal,
        finalTabs: await realTabStates(frame),
        surface,
        // The exact scripted-model decision log proves the first request
        // reached the model (large response) and the continuation followed
        // the compaction summary — no preflight interception, no retries.
        overflowConfig: {
          provider: plan.customProvider,
          model: plan.customModel,
          agent: plan.customAgent,
          variant: plan.customVariantA,
          prompt: REAL_OVERFLOW_PROMPT,
          reportedUsage: SCRIPTED.overflowUsage,
        },
      },
      null,
      2,
    ),
  )
  console.log("[probe] real-overflow lifecycle passed")
}

// ---------------------------------------------------------------------------
// P3.2 worktree-removal scenario — runtime absence + root-local + bounded H-12
// ---------------------------------------------------------------------------

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

/** real-session only: create the run-owned hang server and write the config seed. */
async function prepareRealSession(
  workspace: string,
  real: boolean,
): Promise<{ port: number; close: () => Promise<void> } | undefined> {
  if (!real) return undefined
  const hang = await createHangServer()
  const configFile = writeRealSessionConfig(workspace, hang.port)
  // Project-scope canonical seed (extension-only) mirroring writeRealRestartSeed:
  // the backend kilo.json seed above feeds ONLY the CLI backend — the extension
  // reads exclusively <workspace>/.kilo/kilo.jsonc (paths.ts projectConfigFile),
  // so without this seed the canonical provider index can never serve e2e-local
  // and waitForModelSelected(e2e-local/e2e-model) cannot pass.
  const canonicalFile = join(workspace, ".kilo", CONFIG_FILENAME)
  writeFileSync(canonicalFile, JSON.stringify(realProjectSeed(hang.port), null, 2))
  // No-op dependency guard (same rationale as writeRealRestartSeed):
  // prevent the detached Npm.install("@kilocode/plugin") fiber from reifying
  // into the run-owned .kilo config dir. Required even though real-session has
  // no user tool — the config loader fires for every writable config dir.
  const kiloDir = join(workspace, ".kilo")
  mkdirSync(join(kiloDir, "node_modules"), { recursive: true })
  writeFileSync(
    join(kiloDir, "package-lock.json"),
    JSON.stringify({
      name: "kilo-e2e-workspace",
      version: "0.0.0",
      lockfileVersion: 3,
      packages: { "": { dependencies: { "@kilocode/plugin": "0.0.0" } } },
    }),
  )
  console.log(
    `[probe] real-session config seed: ${configFile} + canonical ${canonicalFile} (hang server port ${hang.port})`,
  )
  return hang
}

/**
 * real-completed only: create the run-owned scripted OpenAI-compatible SSE
 * provider and write the full workspace seed (config + user tool + skill +
 * MCP fixture + permission target + no-op dependency guard) BEFORE VS Code
 * launches, so the lazily-spawned CLI backend loads every fixture at startup.
 */
async function prepareRealCompleted(
  workspace: string,
  real: boolean,
): Promise<{ handle: ScriptedModelHandle; mcpServerFile: string } | undefined> {
  if (!real) return undefined
  const handle = await createScriptedModel(workspace)
  const sdkEsmDir = join(root, "..", "opencode", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm")
  const pluginToolUrl = pathToFileURL(join(root, "..", "plugin", "src", "tool.ts")).href
  const seed = writeRealCompletedSeed(workspace, handle.port, sdkEsmDir, pluginToolUrl)
  // H-6: the seeded read rule "ask.txt" is relative to the workspace; make the
  // workspace a git repo so the backend resolves worktree == workspace and the
  // read tool's permission pattern is exactly "ask.txt" (not a /-relative
  // absolute path the "*" allow rule swallows).
  initWorkspaceGit(workspace)
  console.log(`[probe] real-completed seed: ${seed.configFile} (scripted model port ${handle.port})`)
  return { handle, mcpServerFile: seed.mcpServerFile }
}

/**
 * real-overflow only: create the run-owned scripted OpenAI-compatible SSE
 * provider and write the dedicated small-context workspace seed (config +
 * no-op dependency guard) BEFORE VS Code launches, so the lazily-spawned CLI
 * backend loads the overflow trigger config at startup. This config is NEVER
 * shared with real-completed — the small model limit + low threshold would
 * change the served-model behavior the H-2..H-7 turns depend on.
 */
async function prepareRealOverflow(workspace: string, real: boolean): Promise<ScriptedModelHandle | undefined> {
  if (!real) return undefined
  const handle = await createScriptedModel(workspace)
  const configFile = writeRealOverflowSeed(workspace, handle.port)
  console.log(`[probe] real-overflow seed: ${configFile} (scripted model port ${handle.port})`)
  return handle
}

/**
 * real-restart only: create the run-owned scripted OpenAI-compatible SSE
 * provider and write the dedicated workspace seed (minimal config + user tool
 * + no-op dependency guard) BEFORE VS Code launches, so the lazily-spawned CLI
 * backend loads it at startup. The scripted model survives every restart
 * boundary (it lives in THIS harness process), while the seeded session +
 * artifact live in the run-owned XDG scratch the extension host reuses after
 * the exact worker kill and the true window restart.
 */
async function prepareRealRestart(workspace: string, real: boolean): Promise<ScriptedModelHandle | undefined> {
  if (!real) return undefined
  const handle = await createScriptedModel(workspace)
  const pluginToolUrl = pathToFileURL(join(root, "..", "plugin", "src", "tool.ts")).href
  // scratch is the run-owned isolated XDG root; it is created in main before this
  // call, so we forward it to writeRealRestartSeed for the global kilo.jsonc.
  // main() invokes prepareRealRestart after scratch creation, so we can locate
  // scratch via the workspace's sibling (workspace = <scratch>/workspace).
  const scratch = join(workspace, "..")
  const seed = writeRealRestartSeed(workspace, handle.port, pluginToolUrl, scratch)
  console.log(
    `[probe] real-restart seed: ${seed.configFile} + ${seed.canonicalFile} (scripted model port ${handle.port})`,
  )
  return handle
}

async function prepareRealLifecycle(workspace: string, real: boolean): Promise<ScriptedModelHandle | undefined> {
  if (!real) return undefined
  const handle = await createScriptedModel(workspace)
  const pluginToolUrl = pathToFileURL(join(root, "..", "plugin", "src", "tool.ts")).href
  const scratch = join(workspace, "..")
  const seed = writeRealRestartSeed(workspace, handle.port, pluginToolUrl, scratch)
  console.log(
    `[probe] real-lifecycle seed: ${seed.configFile} + ${seed.canonicalFile} (scripted model port ${handle.port})`,
  )
  return handle
}

/** Dispatch the selected focused scenarios to their assertion functions. */
async function runScenario(
  browser: Browser,
  scenarios: Set<string>,
  plan: E2EPlan,
  scratch: string,
  workspace: string,
  completed?: { handle: ScriptedModelHandle; mcpServerFile: string },
  overflowModel?: ScriptedModelHandle,
  wtModel?: ScriptedModelHandle,
  lifecycleModel?: ScriptedModelHandle,
): Promise<void> {
  if (scenarios.has("tab-close")) {
    await assertTabCloseSuccessor(browser, plan, scratch)
    console.log("[probe] tab-close successor assertion passed")
  }
  if (scenarios.has("child-task-order")) {
    await assertChildTaskOrder(browser, plan, scratch)
    console.log("[probe] child-task tab-order assertion passed")
  }
  if (scenarios.has("variant-memory")) {
    await assertVariantMemoryAcrossAgents(browser, plan, scratch)
    console.log("[probe] variant-memory assertion passed")
  }
  if (scenarios.has("topic-navigation")) {
    await assertTopicNavigation(browser, plan, scratch)
    console.log("[probe] topic-navigation assertion passed")
  }
  if (scenarios.has("real-session")) {
    await assertRealSessionLifecycle(browser, plan, scratch)
    console.log("[probe] real-session lifecycle assertion passed")
  }
  if (scenarios.has("real-completed")) {
    if (!completed) throw new Error("probe: real-completed preparation missing")
    await assertRealCompletedLifecycle(browser, plan, scratch, workspace, completed.mcpServerFile, completed.handle)
    console.log("[probe] real-completed lifecycle assertion passed")
  }
  if (scenarios.has("real-overflow")) {
    if (!overflowModel) throw new Error("probe: real-overflow preparation missing")
    await assertRealOverflowLifecycle(browser, plan, scratch, overflowModel)
    console.log("[probe] real-overflow lifecycle assertion passed")
  }
  if (scenarios.has("sidebar-removal"))
    console.log("[probe] sidebar-removal assertions ran in the Extension Host runner")
  if (scenarios.has("worktree-removal")) {
    if (!wtModel) throw new Error("probe: worktree-removal preparation missing")
    await assertWorktreeRemovalLifecycle(browser, plan, scratch, workspace, wtModel)
    console.log("[probe] worktree-removal lifecycle assertion passed")
  }
  if (scenarios.has("cloud-claw-removal"))
    console.log("[probe] cloud-claw-removal assertions ran in the Extension Host runner")
  if (scenarios.has("p3-4-removal")) console.log("[probe] p3-4-removal assertions ran in the Extension Host runner")
  if (scenarios.has("r9-observation")) {
    await assertR9ObservationLifecycle(browser, plan, scratch)
    console.log("[probe] r9-observation lifecycle assertion passed")
  }
  if (scenarios.has("real-lifecycle")) {
    if (!lifecycleModel) throw new Error("probe: real-lifecycle preparation missing")
    await runGcLifecycleBoundaries(browser, plan, scratch, workspace, lifecycleModel)
    console.log("[probe] real-lifecycle lifecycle assertion passed")
  }
}

// ---------------------------------------------------------------------------
// Cleanup verification
// ---------------------------------------------------------------------------

async function portFree(port: number): Promise<boolean> {
  const server = createServer()
  return new Promise((resolve) => {
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true))
    })
  })
}

/** Read-only check that no process still references our unique user-data dir. */
function processesWithUserData(userData: string): Array<{ pid: number; args: string }> {
  const proc = spawnSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" })
  const out = proc.stdout ?? ""
  return out
    .split("\n")
    .filter((line) => line.includes(userData))
    .map((line) => line.trim())
    .map((line) => {
      const space = line.indexOf(" ")
      return { pid: Number(line.slice(0, space)), args: line.slice(space + 1) }
    })
}

/**
 * Terminate every owned process (matched by exact PID + unique user-data-dir)
 * with SIGTERM, escalating to SIGKILL after a grace period. Returns how many
 * owned processes survived both signals. No process-name kills — every PID is
 * resolved from the user-data ownership filter above.
 */
async function terminateOwned(userData: string, graceMs: number): Promise<number> {
  const signal = async (sig: NodeJS.Signals) => {
    const targets = processesWithUserData(userData)
    for (const p of targets) {
      try {
        process.kill(p.pid, sig)
      } catch {
        // already exited
      }
    }
    if (targets.length > 0) await sleep(graceMs)
    return processesWithUserData(userData)
  }

  let remaining = await signal("SIGTERM")
  if (remaining.length === 0) return 0
  remaining = await signal("SIGKILL")
  return remaining.length
}

/**
 * Strip Electron/VS Code env vars before spawning VS Code. When the harness
 * itself runs inside a VS Code extension host (as this session does),
 * ELECTRON_RUN_AS_NODE and the VSCODE_* vars are set and would make the
 * downloaded VS Code binary launch as plain Node instead of Electron.
 * Mirrors script/launch.ts cleanEnv().
 */
function cleanEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ELECTRON_") || key.startsWith("VSCODE_")) delete process.env[key]
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Ready marker per scenario: real-session / real-completed / real-overflow /
 * real-restart write their own `*-ready` marker (they never seed synthetic
 * fixtures and never write the synthetic `ready`); every other scenario
 * writes `ready` after its fixture seeding.
 */
function readyMarkerFor(scenarios: Set<string>): string {
  if (scenarios.has("sidebar-removal")) return "sidebar-removal-ready"
  if (scenarios.has("real-session")) return "real-ready"
  if (scenarios.has("real-completed")) return "real-completed-ready"
  if (scenarios.has("real-overflow")) return "real-overflow-ready"
  if (scenarios.has("real-restart")) return "rr-ready"
  if (scenarios.has("real-lifecycle")) return "lc-ready"
  if (scenarios.has("worktree-removal")) return "worktree-removal-ready"
  if (scenarios.has("cloud-claw-removal")) return "cloud-claw-removal-ready"
  if (scenarios.has("p3-4-removal")) return "p3-4-removal-ready"
  if (scenarios.has("r9-observation")) return "r9-ready"
  return "ready"
}

let vscodeRun: Promise<number> | undefined

/**
 * Shared VS Code launch — the restart lifecycle and the standard single-process
 * path pass identical runTests args (hermetic scratch XDG tree;
 * `--remote-allow-origins=*` is required for Playwright's CDP WebSocket Origin
 * on this ephemeral loopback-only test profile, never production).
 */
function launchVSCode(opts: {
  executable?: string
  runnerOut: string
  scratch: string
  fixtureId: string
  scenario: string
  userData: string
  extensions: string
  workspace: string
  port: number
  providerBaseURL?: string
}): Promise<number> {
  const {
    executable,
    runnerOut,
    scratch,
    fixtureId,
    scenario,
    userData,
    extensions,
    workspace,
    port,
    providerBaseURL,
  } = opts
  // For the canonical post-cutover runs (real-restart + real-session), the
  // Extension Host must use the same run-owned fresh canonical data root
  // (single DB for the whole run). The isolated root lives at
  // scratch/xdg-data/kilo (canonicalDataRoot); expose it via KILO_DB so the
  // spawned kilo serve uses it instead of any ambient HOME/XDG data.
  // Non-canonical runs inherit the existing XDG isolation without an explicit
  // KILO_DB. Predicate needsCanonicalStorage covers both gates.
  const canonicalEnv = needsCanonicalStorage(scenario) ? { KILO_DB: canonicalDbPath(scratch) } : {}
  const e2eProviderEnv =
    providerBaseURL && /^https?:\/\/(127\.0\.0\.1|localhost):\d+\/v1$/.test(providerBaseURL)
      ? { KILO_E2E_PROVIDER_BASE_URL: providerBaseURL }
      : {}
  return runTests({
    ...(executable ? { vscodeExecutablePath: executable } : {}),
    extensionDevelopmentPath: root,
    extensionTestsPath: runnerOut,
    extensionTestsEnv: {
      KILO_E2E_FIXTURE: "1",
      KILO_E2E_SCRATCH: scratch,
      KILO_E2E_FIXTURE_ID: fixtureId,
      KILO_E2E_SCENARIO: scenario,
      XDG_CONFIG_HOME: join(scratch, "xdg-config"),
      XDG_DATA_HOME: join(scratch, "xdg-data"),
      XDG_CACHE_HOME: join(scratch, "xdg-cache"),
      XDG_STATE_HOME: join(scratch, "xdg-state"),
      ...canonicalEnv,
      ...e2eProviderEnv,
    },
    launchArgs: [
      workspace,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensions}`,
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
    ],
  })
}

/**
 * real-restart only: the Phase C window/extension-restart boundary over TWO
 * VS Code processes. The FIRST process runs Phases 0/A/B (real completed turn,
 * SSE reconnect with the backend alive, exact-owned worker restart), then the
 * harness writes rr-reload-request and the extension-host runner executes
 * `workbench.action.reloadWindow` (acknowledged via rr-reload-executed). In
 * --extensionTestsPath test mode the reload teardown exits the main process
 * with the old Extension Host — the fresh window never comes up in-place — so
 * this treats that exit as the expected reload boundary and RELAUNCHES VS Code
 * with identical args (same user-data-dir, workspace, XDG scratch, and
 * extensionTestsPath runner). The fresh Extension Host re-runs the runner,
 * detects the persisted rr-reload-request, and services the Phase C
 * assertions (runner re-entry, deserialized/reopened Agent Manager, same
 * session/transcript/artifact). Returns true when the run failed.
 */
async function runRealRestartLifecycle(opts: {
  scratch: string
  workspace: string
  userData: string
  extensions: string
  executable: string | undefined
  runnerOut: string
  fixtureId: string
  cdpPort: number
  restartModel: ScriptedModelHandle
}): Promise<boolean> {
  const { scratch, workspace, userData, extensions, executable, runnerOut, fixtureId, cdpPort, restartModel } = opts
  const doneFile = join(scratch, "done")
  const planFile = join(scratch, "plan.json")
  let failed = false

  const providerBaseURL = `http://127.0.0.1:${restartModel.port}/v1`
  const launch = async (port: number) => {
    vscodeRun = launchVSCode({
      executable,
      runnerOut,
      scratch,
      fixtureId,
      scenario: "real-restart",
      userData,
      extensions,
      workspace,
      port,
      providerBaseURL,
    })
    await waitForCdp(port, 90_000)
    console.log("[probe] CDP endpoint reachable, connecting Playwright")
    return chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 })
  }

  const awaitRun = async (label: string, reloadBoundary = false): Promise<number> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const watch = new Promise<number>((resolve) => {
      timer = setTimeout(() => {
        failed = true
        console.error(`[probe] FAIL: ${label} did not exit within ${timeoutMs}ms`)
        void terminateOwned(userData, 2_000).then((remaining) => {
          if (remaining > 0) {
            console.error(`[probe] FAIL: ${remaining} owned processes survived SIGKILL (${label})`)
          } else {
            console.log(`[probe] watchdog: all owned processes terminated by exact PID (${label})`)
          }
          resolve(remaining)
        })
      }, timeoutMs)
    })
    const code = await Promise.race([vscodeRun!, watch]).catch((err) => {
      if (reloadBoundary) {
        // The --extensionTestsPath reload teardown rejects runTests with a
        // nonzero code when the main process exits with the torn-down
        // Extension Host — this is the EXPECTED Phase C reload boundary (the
        // runner already executed workbench.action.reloadWindow, proven by the
        // rr-reload-executed acknowledgment the harness waited for).
        console.log(
          `[probe] NOTE: ${label} rejected — expected reload boundary: ${err instanceof Error ? err.message : String(err)}`,
        )
        return 1
      }
      failed = true
      console.error(`[probe] FAIL: runTests error (${label}): ${err instanceof Error ? err.message : String(err)}`)
      return 1
    })
    if (timer) clearTimeout(timer)
    console.log(`[probe] VS Code exited (code ${code}) — ${label}`)
    return code
  }

  const readPlan = () => JSON.parse(readFileSync(planFile, "utf8")) as E2EPlan

  // ── Launch 1: Phases 0, A, B ────────────────────────────────────────────
  const browser = await launch(cdpPort)
  let evidence
  try {
    if (process.env.KILO_E2E_FORCE_FAIL) {
      throw new Error("forced failure (KILO_E2E_FORCE_FAIL): exercising failure-path cleanup")
    }
    await waitForFile(join(scratch, "rr-ready"), 120_000, "runner ready marker")
    await waitForFile(planFile, 30_000, "runner plan marker")
    const plan = readPlan()
    console.log(
      `[probe] runner ready, plan: source=${plan.sourceId} sibling=${plan.siblingId} child=${plan.childId} ` +
        `variant=${plan.variantId} tabA=${plan.tabAId} tabB=${plan.tabBId} tabC=${plan.tabCId} ` +
        `topicRoot=${plan.topicRootId} topicChild=${plan.topicChildId} topicSibling=${plan.topicSiblingId} ` +
        `realAgent=${plan.customAgent} realAgentB=${plan.customAgentB} realModel=${plan.customProvider}/${plan.customModel}`,
    )
    evidence = await runRealRestartBoundaries(browser, plan, scratch, workspace, restartModel)
    // Phase C: request the true window/extension restart. The runner executes
    // workbench.action.reloadWindow and acknowledges it before the teardown.
    writeFileSync(join(scratch, "rr-reload-request"), "ok")
    await waitForFile(join(scratch, "rr-reload-executed"), 60_000, "runner executed reloadWindow")
  } finally {
    // Unblock the first extension-host runner so VS Code exits under program
    // control (the reload teardown is what actually ends the process).
    writeFileSync(doneFile, "done")
    await browser.close()
  }
  const first = await awaitRun("first launch (reload boundary)", true)
  if (first === 0) {
    console.log(
      "[probe] NOTE: first launch exited 0; reloadWindow main-exit not observed, fresh host re-entry still runs",
    )
  }

  // ── Launch 2: Phase C re-entry in the fresh Extension Host ──────────────
  // The `done` marker from launch 1 must NOT leak into the fresh runner (its
  // reload-phase loop would break immediately and never service the Phase C
  // snapshot requests); remove it before the relaunch.
  rmSync(doneFile, { force: true })
  const freshPort = await freePort()
  console.log(`[probe] relaunching VS Code for Phase C re-entry (cdp port ${freshPort})`)
  const fresh = await launch(freshPort)
  try {
    await waitForFile(join(scratch, "rr-reloaded"), 300_000, "rr-reloaded marker (fresh Extension Host re-entry)")
    await waitForFile(planFile, 30_000, "fresh runner plan marker")
    const plan = readPlan()
    await assertRealRestartReload(
      fresh,
      snapshotClient(scratch, "rr-c-snap"),
      scratch,
      plan,
      workspace,
      evidence,
      restartModel,
    )
    console.log("[probe] real-restart lifecycle assertion passed")
  } finally {
    writeFileSync(doneFile, "done")
    await fresh.close()
  }
  const second = await awaitRun("fresh launch (Phase C)")
  if (second !== 0) failed = true
  const freshPortFree = await portFree(freshPort)
  console.log(`[probe] cleanup: relaunch CDP port ${freshPort} ${freshPortFree ? "released" : "STILL BOUND"}`)
  if (!freshPortFree) failed = true
  return failed
}

async function main() {
  const started = Date.now()
  // LOCK-002: resolve the scenario set BEFORE any build or VS Code launch so an
  // unknown value fails fast and never spawns an owned Electron process.
  const scenario = process.env.KILO_E2E_SCENARIO ?? "all"
  const scenarios = parseScenarios(scenario)
  console.log(`[probe] scenarios: ${scenario} (${[...scenarios].join(", ")})`)
  cleanEnv()
  await compile()

  const fixtureId = `e2e-probe-${randomBytes(4).toString("hex")}`
  const cdpPort = await freePort()
  const scratch = mkdtempSync(join(tmpdir(), "kilo-e2e-"))
  const userData = join(scratch, "user-data")
  const extensions = join(scratch, "extensions")
  const workspace = join(scratch, "workspace")
  mkdirSync(workspace, { recursive: true })
  // Run-owned marker bound to scratch + fixtureId: proves CLI seam scratch
  // belongs to current harness run (not any absolute path). Created before
  // VS Code launch so both ServerManager and CLI provider seams validate it;
  // survives child restarts/window reload (scratch owner cleans it).
  createE2EMarker(scratch, fixtureId)
  process.env.KILO_E2E_FIXTURE_ID = fixtureId
  process.env.KILO_E2E_SCRATCH = scratch

  console.log(`[probe] fixture id: ${fixtureId}`)
  console.log(`[probe] cdp port:   ${cdpPort}`)
  console.log(`[probe] scratch:    ${scratch}`)

  const doneFile = join(scratch, "done")
  let failed = false
  // Run-owned handles and the evidence destination are declared before the
  // guarded region and assigned INSIDE it: every step after mkdtempSync —
  // fixture seeding, canonical setup, runner bundle, VS Code launch — must
  // flow through the same cleanup tail (closeHandles + verifyCleanup) on
  // failure, so the run-owned scratch is removed instead of leaking (the
  // first full real-restart run leaked kilo-e2e-* when ensureFreshCanonicalRoot
  // threw before the try block).
  let evidenceDir: ReturnType<typeof evidenceDirFor>
  let hang: Awaited<ReturnType<typeof prepareRealSession>>
  let completed: Awaited<ReturnType<typeof prepareRealCompleted>>
  let overflowModel: Awaited<ReturnType<typeof prepareRealOverflow>>
  let restartModel: Awaited<ReturnType<typeof prepareRealRestart>>
  let lifecycleModel: Awaited<ReturnType<typeof prepareRealLifecycle>>
  let wtModel: Awaited<ReturnType<typeof prepareWorktreeRemoval>>
  try {
    // LOCK-013: test-only evidence contract — resolve/validate fail-fast (e2e-evidence.ts).
    evidenceDir = evidenceDirFor(scratch)
    // real-session only: the run-owned hang server + workspace config seed must
    // exist BEFORE VS Code launches so the lazily-spawned CLI backend loads the
    // custom provider/model/variant and agents at startup.
    hang = await prepareRealSession(workspace, scenarios.has("real-session"))
    // real-completed only: the run-owned scripted model server + the full
    // workspace seed (config, user tool, skill, MCP fixture, permission target,
    // no-op dependency guard) must also exist BEFORE VS Code launches.
    completed = await prepareRealCompleted(workspace, scenarios.has("real-completed"))
    // real-overflow only: the run-owned scripted model server + the dedicated
    // small-context workspace seed (config + no-op dependency guard) must also
    // exist BEFORE VS Code launches.
    overflowModel = await prepareRealOverflow(workspace, scenarios.has("real-overflow"))
    // real-restart only: the run-owned scripted model server + the minimal
    // workspace seed (config + user tool + no-op dependency guard) must also
    // exist BEFORE VS Code launches — the scripted model and the session/artifact
    // survive every restart boundary.
    restartModel = await prepareRealRestart(workspace, scenarios.has("real-restart"))
    // P3.2 worktree-removal only: the run-owned scripted model server + the
    // MINIMAL workspace seed (config + H-12 edit rule + tracked rollback file +
    // no-op dependency guard, plain single git repo) must also exist BEFORE VS
    // Code launches so the lazily-spawned CLI backend loads them at startup.
    wtModel = await prepareWorktreeRemoval(workspace, scenarios.has("worktree-removal"))
    lifecycleModel = await prepareRealLifecycle(workspace, scenarios.has("real-lifecycle"))
    // canonical post-cutover wiring (P4.2 H-10/H-11 for real-restart + real-session):
    // allocate a run-owned isolated temp root at scratch/xdg-data/kilo, execute
    // the existing hidden `__internal-storage-cutover cutover --data-root` against
    // it before the first kilo serve spawn, and record read-only gate + archive
    // evidence. The fresh DB starts empty by design; the harness creates the
    // canonical-era session then proves it rehydrates across the boundaries.
    // `repoRoot` is the MONOREPO root — the hidden CLI entry lives at
    // packages/opencode/src/index.ts relative to it, not to the package root.
    // real-* scenarios also seed the hermetic global canonical root here
    // (plugin dependency guard + canonical agent .md assets) pre-first-launch.
    // Predicate needsCanonicalStorage covers real-restart + real-session.
    await prepareCanonicalRun({ scenarios, scratch, repoRoot, realRestart: needsCanonicalStorage(scenario) })
    const runnerOut = join(scratch, "runner.cjs")
    await build({
      entryPoints: [runnerEntry],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      external: ["vscode"],
      outfile: runnerOut,
      logLevel: "silent",
    })
    console.log("[probe] runner bundled:", runnerOut)

    const executable = detectExecutable()
    if (executable) {
      console.log("[probe] VS Code executable:", executable)
    } else {
      console.log("[probe] no VS Code override/cache; @vscode/test-electron will download into .vscode-test")
    }

    if (scenarios.has("real-restart")) {
      if (!restartModel) throw new Error("probe: real-restart preparation missing")
      // The real-restart scenario owns TWO VS Code processes: the first runs
      // Phases 0/A/B and then the runner executes workbench.action.reloadWindow
      // (test-mode teardown exits the main process), and a relaunch with
      // identical args carries the fresh Extension Host into Phase C.
      const relaunchFailed = await runRealRestartLifecycle({
        scratch,
        workspace,
        userData,
        extensions,
        executable,
        runnerOut,
        fixtureId,
        cdpPort,
        restartModel,
      })
      if (relaunchFailed) failed = true
      // H-10/H-11 post-boundary canonical archive stability: the same fresh
      // canonical data root must show no archive mutation after the five
      // boundaries (SSE reconnect, worker restart, Extension Host reload).
      try {
        assertArchiveStable(scratch, canonicalDataRoot(scratch))
      } catch (err) {
        failed = true
        console.error(`[probe] FAIL canonical archive stability: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      const providerBaseURL =
        scenarios.has("real-lifecycle") && lifecycleModel ? `http://127.0.0.1:${lifecycleModel.port}/v1` : undefined
      vscodeRun = launchVSCode({
        executable,
        runnerOut,
        scratch,
        fixtureId,
        scenario,
        userData,
        extensions,
        workspace,
        port: cdpPort,
        providerBaseURL,
      })

      await waitForCdp(cdpPort, 90_000)
      console.log("[probe] CDP endpoint reachable, connecting Playwright")
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 30_000 })
      try {
        if (process.env.KILO_E2E_FORCE_FAIL) {
          throw new Error("forced failure (KILO_E2E_FORCE_FAIL): exercising failure-path cleanup")
        }
        const readyMarker = readyMarkerFor(scenarios)
        await waitForFile(join(scratch, readyMarker), 120_000, "runner ready marker")
        await waitForFile(join(scratch, "plan.json"), 30_000, "runner plan marker")
        const plan = JSON.parse(readFileSync(join(scratch, "plan.json"), "utf8")) as E2EPlan
        console.log(
          `[probe] runner ready, plan: source=${plan.sourceId} sibling=${plan.siblingId} child=${plan.childId} ` +
            `variant=${plan.variantId} tabA=${plan.tabAId} tabB=${plan.tabBId} tabC=${plan.tabCId} ` +
            `topicRoot=${plan.topicRootId} topicChild=${plan.topicChildId} topicSibling=${plan.topicSiblingId} ` +
            `realAgent=${plan.customAgent} realAgentB=${plan.customAgentB} realModel=${plan.customProvider}/${plan.customModel}`,
        )
        await runScenario(
          browser,
          scenarios,
          plan,
          scratch,
          workspace,
          completed,
          overflowModel,
          wtModel,
          lifecycleModel,
        )
        // Real-session post-boundary canonical archive stability: same fresh
        // canonical data root must show no archive mutation after the panel
        // close/reopen + session-switch boundaries. Reuses the same predicate
        // as the pre-run gate; real-restart's stability is already checked in
        // its dedicated two-process path above.
        if (needsCanonicalStorage(scenario)) {
          try {
            assertArchiveStable(scratch, canonicalDataRoot(scratch))
          } catch (err) {
            failed = true
            console.error(
              `[probe] FAIL canonical archive stability: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
      } finally {
        // Unblock the extension-host runner on success AND failure so VS Code
        // always exits under program control (no detached processes).
        writeFileSync(doneFile, "done")
        await browser.close()
      }
    }
  } catch (err) {
    failed = true
    console.error(`[probe] FAIL: ${err instanceof Error ? err.message : String(err)}`)
    writeFileSync(doneFile, "done")
  }

  // Release the run-owned scripted/hang listeners before process settle + scratch deletion.
  await closeHandles({ hang, completed, overflowModel, restartModel, lifecycleModel, wtModel })

  // VS Code exits only after the runner sees the `done` marker (or times out).
  // Await it before touching the scratch dir so the unique user-data/extensions
  // dirs are not deleted under a live process. On timeout the watchdog
  // terminates every owned process by exact PID before cleanup proceeds.
  if (vscodeRun) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let watchdogDone: Promise<number> | undefined
    const watch = new Promise<number>((resolve) => {
      timer = setTimeout(() => {
        failed = true
        console.error(`[probe] FAIL: VS Code did not exit within ${timeoutMs}ms`)
        watchdogDone = terminateOwned(userData, 2_000).then((remaining) => {
          if (remaining > 0) {
            console.error(`[probe] FAIL: ${remaining} owned VS Code processes survived SIGKILL`)
          } else {
            console.log("[probe] watchdog: all owned VS Code processes terminated by exact PID")
          }
          return remaining
        })
        resolve(1)
      }, timeoutMs)
    })
    const code = await Promise.race([vscodeRun, watch]).catch((err) => {
      failed = true
      console.error(`[probe] FAIL: runTests error: ${err instanceof Error ? err.message : String(err)}`)
      return 1
    })
    if (timer) clearTimeout(timer)
    // If the watchdog fired, wait for its final tally so the proof line prints
    // (and any SIGKILL survivors are counted) before cleanup proceeds.
    if (watchdogDone) {
      const remaining = await watchdogDone
      if (remaining > 0) failed = true
    }
    console.log(`[probe] VS Code exited (code ${code})`)
    if (code !== 0) failed = true
  }

  // Durable evidence handoff after the runner quiesced, before scratch cleanup.
  if (
    runEvidenceHandoff({
      evidenceDir,
      staging: process.env.KILO_E2E_EVIDENCE_STAGING!,
      scratch,
      workspace,
      scenarios,
      fixtureId,
      startedAt: started,
      success: !failed,
    })
  ) {
    failed = true
  }

  await verifyCleanup(userData, cdpPort, scratch)
  console.log(`[probe] total elapsed: ${Math.round((Date.now() - started) / 1000)}s`)
  if (failed) process.exit(1)
}

/**
 * Release the run-owned scripted/hang listeners BEFORE the owned VS Code
 * processes are settled and the scratch dir is deleted; the listeners are
 * in-process, so closing also releases sockets still held by aborted model
 * requests.
 */
async function closeHandles(opts: {
  hang: { close: () => Promise<void> } | undefined
  completed: { handle: { close: () => Promise<void> } } | undefined
  overflowModel: { close: () => Promise<void> } | undefined
  restartModel: { close: () => Promise<void> } | undefined
  lifecycleModel: { close: () => Promise<void> } | undefined
  wtModel: { close: () => Promise<void> } | undefined
}) {
  const { hang, completed, overflowModel, restartModel, lifecycleModel, wtModel } = opts
  if (hang) await hang.close().catch((err) => console.error("[probe] hang server close failed:", err))
  if (completed)
    await completed.handle.close().catch((err) => console.error("[probe] scripted model close failed:", err))
  if (overflowModel)
    await overflowModel.close().catch((err) => console.error("[probe] overflow scripted model close failed:", err))
  if (restartModel)
    await restartModel.close().catch((err) => console.error("[probe] restart scripted model close failed:", err))
  if (lifecycleModel)
    await lifecycleModel.close().catch((err) => console.error("[probe] lifecycle scripted model close failed:", err))
  if (wtModel)
    await wtModel.close().catch((err) => console.error("[probe] worktree-removal scripted model close failed:", err))
}

async function verifyCleanup(userData: string, cdpPort: number, scratch: string) {
  // 1. Give owned VS Code processes (main, extension host, helpers) a moment
  //    to exit on their own after the run, then terminate every owned survivor
  //    by exact PID (SIGTERM → SIGKILL). This includes VS Code's long-lived
  //    chrome_crashpad_handler, which is owned by this instance via the unique
  //    user-data dir.
  const settleDeadline = Date.now() + 15_000
  let owned = processesWithUserData(userData)
  while (owned.length > 0 && Date.now() < settleDeadline) {
    await sleep(300)
    owned = processesWithUserData(userData)
  }
  const remaining = owned.length > 0 ? await terminateOwned(userData, 3_000) : 0
  if (remaining > 0) {
    throw new Error(
      `cleanup: ${remaining} owned VS Code processes could not be terminated by exact PID:\n` +
        processesWithUserData(userData)
          .map((p) => `  ${p.pid} ${p.args}`)
          .join("\n"),
    )
  }
  console.log("[probe] cleanup: no owned VS Code process remains")

  // 2. Only delete paths after zero owned processes remain, and only after the
  //    owned CDP port is verifiably released.
  const free = await portFree(cdpPort)
  console.log(`[probe] cleanup: CDP port ${cdpPort} ${free ? "released" : "STILL BOUND"}`)
  if (!free) throw new Error(`cleanup: CDP port ${cdpPort} still bound by an owned process`)
  rmSync(scratch, { recursive: true, force: true })
  const gone = !existsSync(scratch)
  console.log(`[probe] cleanup: scratch dir removed: ${gone}`)
  if (!gone) throw new Error("cleanup: scratch dir could not be removed")
}

if (isDirectExecution()) {
  main().catch((err) => {
    console.error(`[probe] FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    process.exit(1)
  })
}
