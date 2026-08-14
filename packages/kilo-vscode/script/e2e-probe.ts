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
 *   Any other value fails fast before VS Code launches. Focused runs:
 *     KILO_E2E_SCENARIO=tab-close         node script/e2e-probe-launch.mjs
 *     KILO_E2E_SCENARIO=child-task-order  node script/e2e-probe-launch.mjs
 *     KILO_E2E_SCENARIO=variant-memory    node script/e2e-probe-launch.mjs
 *     KILO_E2E_SCENARIO=topic-navigation  node script/e2e-probe-launch.mjs
 *   (package shortcuts: `bun run test:e2e:tab-close`,
 *   `bun run test:e2e:child-task-order`,
 *   `bun run test:e2e:variant-memory`,
 *   `bun run test:e2e:topic-navigation`.)
 *
 * Scenarios are independent: each seeds only its own fixtures and coordinates
 * through scenario-specific markers (tab-close-done, child-phase1-done /
 * child-phase2-ready / child-phase2-done, variant-ready, topic-nav-done /
 * topic-reopen-ready / topic-reopen-done / topic-reload-frame /
 * topic-reload-ready / topic-reload-done). No scenario waits on another's
 * markers. The tab-close scenario runs first in the `all` composition and
 * closes all its own tabs before finishing, so the strip it hands to the child
 * scenario is exactly the startup state (one pending tab + bottom page) the
 * child seeding already expects.
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
import { createServer } from "node:net"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

if (process.versions.bun) {
  console.error(
    "[probe] FATAL: this harness must run under Node, not Bun. " +
      "Playwright's connectOverCDP WS transport hangs under Bun against VS Code's CDP endpoint. " +
      "Use `bun run test:e2e` (compiles + runs via Node).",
  )
  process.exit(1)
}

// Set by script/e2e-probe-launch.mjs; falls back to the current working dir.
const root = process.env.KILO_E2E_ROOT ? resolve(process.env.KILO_E2E_ROOT) : resolve(process.cwd())
const runnerEntry = join(root, "tests", "e2e", "runner.ts")
const shouldBuild = !process.argv.includes("--no-build")
const timeoutMs = Number(process.env.KILO_E2E_TIMEOUT ?? 300_000)

// LOCK-002: scenario selection. `all` (default) runs every scenario in one VS
// Code lifecycle; a focused value runs exactly that scenario. Unknown values
// fail fast BEFORE VS Code launches (see main()). topic-navigation is
// focused-only by design (not part of `all`): it closes/reopens the Agent
// Manager panel mid-run, which would dispose the tab strip the other `all`
// scenarios coordinate on, so the delivery-gate composition stays deliberate
// and unchanged.
const SCENARIO_VALUES = ["all", "tab-close", "child-task-order", "variant-memory", "topic-navigation"] as const
function parseScenarios(value: string): Set<string> {
  if (value === "all") return new Set(["tab-close", "child-task-order", "variant-memory"])
  if (value === "tab-close" || value === "child-task-order" || value === "variant-memory" || value === "topic-navigation") {
    return new Set([value])
  }
  throw new Error(
    `[probe] unknown KILO_E2E_SCENARIO "${value}". ` +
      `Supported values: ${SCENARIO_VALUES.join(" | ")} (default: all).`,
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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

async function waitForFile(file: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(file)) return
    if (Date.now() > deadline) throw new Error(`probe: timeout waiting for ${label}`)
    await sleep(200)
  }
}

interface E2EPlan {
  sourceId: string
  siblingId: string
  childId: string
  variantId: string
  tabAId: string
  tabBId: string
  tabCId: string
  sourceTitle: string
  siblingTitle: string
  childTitle: string
  variantTitle: string
  tabATitle: string
  tabBTitle: string
  tabCTitle: string
  topicRootId: string
  topicChildId: string
  topicSiblingId: string
  topicRootTitle: string
  topicChildTitle: string
  topicSiblingTitle: string
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
 * `.am-tab-label` — prevents matching the sidebar webview, which never renders
 * `.am-tab-sortable`.
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

async function tabLabels(frame: Frame): Promise<string[]> {
  return frame
    .locator(".am-tab .am-tab-label")
    .allTextContents()
    .then((items) => items.map((s) => s.trim()))
    .catch(() => [])
}

/** Ordered [{id, label}] for every session tab (ids from the sortable container). */
async function tabStates(frame: Frame): Promise<Array<{ id: string; label: string }>> {
  return frame.evaluate(() => {
    const out: Array<{ id: string; label: string }> = []
    const containers = Array.from(document.querySelectorAll<HTMLElement>(".am-tab-sortable"))
    for (const container of containers) {
      const id = container.getAttribute("data-tab-id") ?? ""
      const label = container.querySelector(".am-tab-label")?.textContent?.trim() ?? ""
      if (label) out.push({ id, label })
    }
    return out
  })
}

async function activeTabLabel(frame: Frame): Promise<string | undefined> {
  return frame
    .locator(".am-tab.am-tab-active .am-tab-label")
    .first()
    .textContent()
    .then((s) => s?.trim())
    .catch(() => undefined)
}

/** The tab ID of the currently active session tab, if any. */
async function activeTabId(frame: Frame): Promise<string | undefined> {
  return frame
    .evaluate(() => {
      const containers = Array.from(document.querySelectorAll<HTMLElement>(".am-tab-sortable"))
      const active = containers.find((c) => c.querySelector(".am-tab-active"))
      return active?.getAttribute("data-tab-id") ?? undefined
    })
    .catch(() => undefined)
}

/**
 * Assert the ordered tab strip. Tab IDs (from `.am-tab-sortable[data-tab-id]`)
 * are the primary order evidence — they are stable across sessions and immune
 * to title-wording drift. Labels are asserted as supplementary UI evidence.
 */
async function expectTabOrder(
  frame: Frame,
  expectedIds: string[],
  expectedLabels: string[],
  expectedActiveId: string,
  expectedActiveLabel: string,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const states = await tabStates(frame)
    const ids = states.map((t) => t.id)
    const labels = states.map((t) => t.label)
    const active = await activeTabLabel(frame)
    const activeId = await activeTabId(frame)
    const idMatch = ids.length === expectedIds.length && ids.every((id, i) => id === expectedIds[i])
    const labelMatch = labels.every((l, i) => l === expectedLabels[i])
    const activeMatch = active === expectedActiveLabel && activeId === expectedActiveId
    if (idMatch && labelMatch && activeMatch) {
      console.log(
        `[probe] PASS ${label}: ids=[${ids.join(", ")}] labels=[${labels.join(", ")}] active="${active}" (${activeId})`,
      )
      return
    }
    if (Date.now() > deadline) {
      const body = await frame
        .locator("body")
        .innerText()
        .catch(() => "<unreadable>")
      throw new Error(
        `probe: ${label} failed.\n` +
          `  expected ids=[${expectedIds.join(", ")}] labels=[${expectedLabels.join(", ")}] activeId="${expectedActiveId}" activeLabel="${expectedActiveLabel}"\n` +
          `  actual   ids=[${ids.join(", ")}] labels=[${labels.join(", ")}] active="${active ?? "<none>"}" (${activeId ?? "<none>"})\n` +
          `  body:\n${body.slice(0, 1500)}`,
      )
    }
    await sleep(250)
  }
}

async function clickChildTaskLink(frame: Frame, timeoutMs: number): Promise<void> {
  const link = frame.locator('button[aria-label="Open sub-agent in tab"]').first()
  try {
    await link.waitFor({ state: "visible", timeout: timeoutMs })
    await link.click({ timeout: timeoutMs })
  } catch (err) {
    const wrappers = await frame
      .evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('[data-component="tool-part-wrapper"]'))
        return nodes.map((n) => ({
          dataTool: n.getAttribute("data-tool"),
          subagentButtons: n.querySelectorAll('button[aria-label="Open sub-agent in tab"]').length,
          outer: n.outerHTML.slice(0, 1200),
        }))
      })
      .catch(() => [])
    const body = await frame
      .locator("body")
      .innerHTML()
      .catch(() => "<unreadable>")
    throw new Error(
      `probe: production open button not clickable.\n  wrappers=${JSON.stringify(wrappers, null, 2)}\n` +
        `  bodyHTML:\n${body.slice(0, 1200)}`,
    )
  }
  console.log('[probe] clicked production open button (aria-label="Open sub-agent in tab")')
}

/**
 * Full production-behavior E2E for the Agent Manager child-task open action:
 *   1. initial tab order [source, sibling] with source active,
 *   2. click the real "Open sub-agent in tab" IconButton in source's chat
 *      (TaskToolExpanded renderer — the same production component the sidebar uses),
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

/** Text of the first element matching the selector (label of a selector trigger). */
async function labelText(frame: Frame, selector: string): Promise<string | undefined> {
  return frame
    .locator(selector)
    .first()
    // Bounded per-read wait so a transiently absent node (e.g. a selector that
    // unmounts/remounts during an agent-switch re-render) never blocks a poll
    // loop on Playwright's 30s default — the caller's loop survives it.
    .textContent({ timeout: 2_000 })
    .then((s) => s?.trim())
    .catch(() => undefined)
}

/** Poll until the selector trigger label equals the expected text. */
async function waitForLabel(frame: Frame, selector: string, expected: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const text = await labelText(frame, selector)
    if (text === expected) {
      console.log(`[probe] PASS ${label}: "${text}"`)
      return
    }
    if (Date.now() > deadline) {
      const evidence = await frame
        .evaluate((sel) => {
          const nodes = Array.from(document.querySelectorAll<HTMLElement>(sel))
          const body = document.body?.innerText ?? ""
          return {
            selector: sel,
            count: nodes.length,
            texts: nodes.map((n) => n.textContent?.trim() ?? ""),
            modeTrigger: document.querySelector(".mode-switcher-trigger-label")?.textContent?.trim() ?? null,
            thinkingTrigger: document.querySelector(".thinking-selector-trigger-label")?.textContent?.trim() ?? null,
            body: body.slice(0, 1200),
          }
        }, selector)
        .catch(() => ({ selector, error: "evaluate failed" }))
      throw new Error(
        `probe: ${label} failed: expected "${expected}", got "${text ?? "<none>"}".\n` +
          `  dom=${JSON.stringify(evidence, null, 2)}`,
      )
    }
    await sleep(250)
  }
}

async function clickTab(frame: Frame, tabId: string, timeoutMs: number): Promise<void> {
  const tab = frame.locator(`.am-tab-sortable[data-tab-id="${tabId}"]`).first()
  await tab.waitFor({ state: "visible", timeout: timeoutMs })
  await tab.click({ timeout: timeoutMs })
}

/**
 * Click the real production close button of one session tab. The button is
 * the `.am-tab-close` rendered by the production SessionTab component inside
 * that tab's `.am-tab-sortable` container — the exact DOM element a user
 * clicks. Scoping by the tab's data-tab-id never depends on a locale-dependent
 * aria-label or title string.
 */
async function clickTabClose(frame: Frame, tabId: string, timeoutMs: number): Promise<void> {
  const btn = frame.locator(`.am-tab-sortable[data-tab-id="${tabId}"] .am-tab-close`).first()
  await btn.waitFor({ state: "visible", timeout: timeoutMs })
  await btn.click({ timeout: timeoutMs })
  console.log(`[probe] clicked .am-tab-close for tab ${tabId}`)
}

/** Poll until no `.am-tab-sortable` session tab remains (only-tab close path). */
async function waitForNoSessionTabs(frame: Frame, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const states = await tabStates(frame)
    if (states.length === 0) {
      console.log(`[probe] PASS ${label}: no session tabs remain`)
      return
    }
    if (Date.now() > deadline) {
      throw new Error(
        `probe: ${label} failed: ${states.length} session tab(s) remain: ` +
          states.map((s) => `${s.id}="${s.label}"`).join(", "),
      )
    }
    await sleep(250)
  }
}

// ---------------------------------------------------------------------------
// Derived Topic navigation — real webview sidebar
// ---------------------------------------------------------------------------

interface SidebarChildState {
  id: string
  label: string
  active: boolean
}

interface SidebarTopicState {
  id: string
  label: string
  active: boolean
  /** Ordered child rows rendered under the expanded topic (`#topic-children-{id}`). */
  children: SidebarChildState[]
}

/**
 * Read the runtime-derived Topic hierarchy from the real Agent Manager
 * sidebar: topic root rows (`.am-item.am-topic-root[data-topic-id]`, label
 * from `.am-item-title-text`) with their rendered child rows under
 * `#topic-children-{id}`. DOM order is the derivation order (activity
 * descending, deterministic ID tie-break) — same order the runtime derived.
 */
async function sidebarTopicStates(frame: Frame): Promise<SidebarTopicState[]> {
  return frame
    .evaluate(() => {
      const out: SidebarTopicState[] = []
      const roots = Array.from(document.querySelectorAll<HTMLElement>(".am-list .am-topic-root[data-topic-id]"))
      for (const root of roots) {
        const id = root.getAttribute("data-topic-id") ?? ""
        const children: SidebarChildState[] = []
        const box = document.getElementById(`topic-children-${id}`)
        if (box) {
          for (const child of Array.from(box.querySelectorAll<HTMLElement>(":scope > .am-item"))) {
            children.push({
              id: child.getAttribute("data-sidebar-id") ?? "",
              label: child.querySelector(".am-item-title-text")?.textContent?.trim() ?? "",
              active: child.classList.contains("am-item-active"),
            })
          }
        }
        out.push({
          id,
          label: root.querySelector(".am-item-title-text")?.textContent?.trim() ?? "",
          active: root.classList.contains("am-item-active"),
          children,
        })
      }
      return out
    })
    .catch(() => [])
}

/**
 * Assert the runtime-derived Topic hierarchy: ordered topic roots with
 * labels, active-topic highlight, and rendered child membership. Children are
 * only rendered when the topic is expanded; the active session's topic
 * auto-expands and the default-expand effect opens the most active topic with
 * children, so the seeded root topic's child row is expected visible.
 */
async function expectTopicHierarchy(
  frame: Frame,
  expected: SidebarTopicState[],
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const topics = await sidebarTopicStates(frame)
    const same = (a: SidebarTopicState, b: SidebarTopicState) =>
      a.id === b.id &&
      a.label === b.label &&
      a.active === b.active &&
      a.children.length === b.children.length &&
      a.children.every((c, i) => {
        const d = b.children[i]
        return d && c.id === d.id && c.label === d.label && c.active === d.active
      })
    const match = topics.length === expected.length && topics.every((t, i) => same(t, expected[i]!))
    if (match) {
      console.log(
        `[probe] PASS ${label}: ${topics.map((t) => `${t.id}="${t.label}"${t.active ? "(active)" : ""}[${t.children.map((c) => `${c.id}${c.active ? "(active)" : ""}`).join(",")}]`).join(" ")}`,
      )
      return
    }
    if (Date.now() > deadline) {
      throw new Error(
        `probe: ${label} failed.\n` +
          `  expected=${JSON.stringify(expected)}\n` +
          `  actual  =${JSON.stringify(topics)}`,
      )
    }
    await sleep(250)
  }
}

/** Current title of the real TaskHeader (`[data-slot="task-header-title-label"]`). */
async function headerTitle(frame: Frame): Promise<string | undefined> {
  return frame
    .locator('[data-slot="task-header-title-label"]')
    .first()
    .textContent({ timeout: 2_000 })
    .then((s) => s?.trim())
    .catch(() => undefined)
}

/** Poll until the chat header title equals the expected session title. */
async function expectHeaderTitle(frame: Frame, expected: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const title = await headerTitle(frame)
    if (title === expected) {
      console.log(`[probe] PASS ${label}: "${title}"`)
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`probe: ${label} failed: expected "${expected}", got "${title ?? "<none>"}"`)
    }
    await sleep(250)
  }
}

/** Click a Topic root row in the real sidebar (clicks the title, bubbles to the row's onSelectSession). */
async function clickSidebarTopic(frame: Frame, topicId: string, timeoutMs: number): Promise<void> {
  const row = frame.locator(`.am-item.am-topic-root[data-topic-id="${topicId}"]`).first()
  await row.waitFor({ state: "visible", timeout: timeoutMs })
  await row.locator(".am-item-title-text").first().click({ timeout: timeoutMs })
  console.log(`[probe] clicked sidebar topic row ${topicId}`)
}

/** Click a child session row under its expanded Topic in the real sidebar. */
async function clickSidebarChild(frame: Frame, sessionId: string, timeoutMs: number): Promise<void> {
  const row = frame.locator(`.am-topic-children [data-sidebar-id="${sessionId}"]`).first()
  await row.waitFor({ state: "visible", timeout: timeoutMs })
  await row.locator(".am-item-title-text").first().click({ timeout: timeoutMs })
  console.log(`[probe] clicked sidebar child row ${sessionId}`)
}

/**
 * The Topic hierarchy must derive purely from runtime session facts (parentID
 * edges) with no worktree dependency — the derived-Topic model is a
 * navigation view, not a persisted domain model. Asserts the sidebar renders
 * exactly the derived topic rows (no worktree cards, no data-worktree-id, no
 * stray `.am-item` outside the topic hierarchy).
 */
async function assertNoWorktree(frame: Frame, label: string): Promise<void> {
  const stats = await frame
    .evaluate(() => {
      const list = document.querySelector(".am-list")
      if (!list) {
        return { list: false, worktreeIds: 0, cards: 0, topicRoots: 0, children: 0, items: 0 }
      }
      const topicRoots = list.querySelectorAll(".am-topic-root[data-topic-id]").length
      const children = list.querySelectorAll(".am-topic-children .am-item").length
      return {
        list: true,
        worktreeIds: list.querySelectorAll("[data-worktree-id]").length,
        cards: list.querySelectorAll(".am-worktree-card, .am-worktree-group, .am-group-card").length,
        topicRoots,
        children,
        items: list.querySelectorAll(".am-item").length,
      }
    })
    .catch(() => ({ list: false, worktreeIds: -1, cards: -1, topicRoots: 0, children: 0, items: 0 }))
  const noWorktree = stats.list && stats.worktreeIds === 0 && stats.cards === 0
  const exactHierarchy = stats.topicRoots > 0 && stats.items === stats.topicRoots + stats.children
  if (!noWorktree || !exactHierarchy) {
    throw new Error(`probe: ${label} failed: ${JSON.stringify(stats)}`)
  }
  console.log(
    `[probe] PASS ${label}: no worktree markers; ${stats.topicRoots} topic root(s) + ${stats.children} child row(s)`,
  )
}

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
 * Close an open popover list if one exists. Counts first so an absent list
 * never blocks on Playwright's default 30s action timeout (an unconditional
 * `press("Escape")` on a locator with no match did exactly that and exhausted
 * the pick retry deadline), and bounds the press itself for the Kobalte detach
 * race (options can detach on focus).
 */
async function closePopover(frame: Frame, listSelector: string): Promise<void> {
  const open = await frame.locator(listSelector).count().catch(() => 0)
  if (open > 0) {
    await frame.locator(listSelector).first().press("Escape", { timeout: 2_000 }).catch(() => {})
  }
}

/**
 * Open a popover selector (trigger) and click the option whose label matches
 * `value` exactly. Matching is scoped to the option's label span
 * (`nameSelector`, e.g. `.mode-switcher-item-name` or
 * `.thinking-selector-item-name`) and is case-sensitive whole-string
 * (`getByText(value, { exact: true })`) — never a case-insensitive substring of
 * the option's full text — so a label like "Ask" cannot match a sibling
 * description containing "tasks", and a label like "Code" cannot match a
 * description containing "codebase". The owning `[role="option"]` is clicked,
 * not the span. Retries the open→pick sequence because kobalte popovers
 * re-render option nodes on focus, so a single located reference can detach
 * mid-click. Every wait inside is bounded (≤5s per attempt, retried until the
 * overall deadline) so a transiently missing list can never stall the retry
 * loop.
 */
async function pickOption(
  frame: Frame,
  triggerSelector: string,
  listSelector: string,
  nameSelector: string,
  value: string,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // Ensure any open popover is closed so the trigger click opens fresh.
    await closePopover(frame, listSelector)
    await frame.locator(triggerSelector).first().click({ timeout: 5_000 }).catch(() => {})
    try {
      const name = frame
        .locator(`${listSelector} [role="option"] ${nameSelector}`)
        .getByText(value, { exact: true })
        .first()
      await name.waitFor({ state: "visible", timeout: 5_000 })
      const option = name.locator("xpath=ancestor::*[@role='option']").first()
      await option.waitFor({ state: "visible", timeout: 5_000 })
      await option.click({ timeout: 5_000 })
      console.log(`[probe] picked "${value}" from ${label}`)
      return
    } catch (err) {
      if (Date.now() > deadline) {
        const evidence = await frame
          .evaluate(
            ([triggerSel, listSel, nameSel]) => {
              const body = document.body?.innerText ?? ""
              const nodes = Array.from(document.querySelectorAll<HTMLElement>(listSel))
              const names = Array.from(document.querySelectorAll<HTMLElement>(`${listSel} ${nameSel}`))
              return {
                trigger: document.querySelector(triggerSel)?.textContent?.trim() ?? null,
                listCount: nodes.length,
                listText: nodes.map((n) => n.textContent?.trim() ?? "").slice(0, 20),
                names: names.map((n) => n.textContent?.trim() ?? "").slice(0, 20),
                modeTrigger: document.querySelector(".mode-switcher-trigger-label")?.textContent?.trim() ?? null,
                body: body.slice(0, 800),
              }
            },
            [triggerSelector, listSelector, nameSelector] as const,
          )
          .catch(() => ({ evaluate: "failed" }))
        throw new Error(
          `probe: could not pick "${value}" from ${label}: ${err instanceof Error ? err.message : String(err)}. dom=${JSON.stringify(evidence, null, 2)}`,
        )
      }
      await sleep(250)
    }
  }
}

/** Open the ThinkingSelector and pick a variant option (real production popover). */
async function pickVariant(frame: Frame, value: string, timeoutMs: number): Promise<void> {
  await pickOption(
    frame,
    ".thinking-selector-trigger-label",
    ".thinking-selector-list",
    ".thinking-selector-item-name",
    value,
    timeoutMs,
    "variant picker",
  )
}

/** Open the ModeSwitcher and pick an agent option (real production popover). */
async function pickAgent(frame: Frame, value: string, timeoutMs: number): Promise<void> {
  await pickOption(
    frame,
    ".mode-switcher-trigger-label",
    ".mode-switcher-list",
    ".mode-switcher-item-name",
    value,
    timeoutMs,
    "agent picker",
  )
}

/** Agent labels offered by the ModeSwitcher (production popover options), then close it. */
async function agentOptions(frame: Frame, timeoutMs: number): Promise<string[]> {
  await frame.locator(".mode-switcher-trigger-label").first().click({ timeout: 5_000 }).catch(() => {})
  const names = await frame
    .locator('.mode-switcher-list .mode-switcher-item-name')
    .allTextContents()
    .then((items) => items.map((s) => s.trim()).filter((s) => s.length > 0))
    .catch(() => [])
  // Close the popover again (Escape) so the next pick starts from a closed state.
  await closePopover(frame, ".mode-switcher-list")
  return names
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
    const options = mode ? await agentOptions(frame, timeout) : []
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
  await waitForLabel(frame, ".thinking-selector-trigger-label", "Low", timeout, "agent B inherits model memory before picking")

  // Agent B picks "High" → session-scoped key for B.
  await pickVariant(frame, "High", timeout)
  await waitForLabel(frame, ".thinking-selector-trigger-label", "High", timeout, "agent B picks high")

  // Back to A: must restore "Low" — the regression assertion. Pre-fix, the
  // agent-less session key shadows this and shows B's "High".
  await pickAgent(frame, aLabel, timeout)
  await waitForLabel(frame, ".mode-switcher-trigger-label", aLabel, timeout, "agent switched back to A")
  await waitForLabel(frame, ".thinking-selector-trigger-label", "Low", timeout, "agent A restores low in-session (LOCK-001)")

  // Back to B: restores "High".
  await pickAgent(frame, bLabel, timeout)
  await waitForLabel(frame, ".mode-switcher-trigger-label", bLabel, timeout, "agent switched back to B")
  await waitForLabel(frame, ".thinking-selector-trigger-label", "High", timeout, "agent B restores high in-session (LOCK-001)")

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

async function describeTargets(browser: Browser): Promise<string> {
  const lines: string[] = []
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      lines.push(`  page: ${page.url()}`)
      for (const frame of page.frames()) {
        lines.push(`    frame: ${frame.url().slice(0, 120)}`)
      }
    }
  }
  return lines.length > 0 ? lines.join("\n") : "  (no pages visible via CDP)"
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

let vscodeRun: Promise<number> | undefined

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

  console.log(`[probe] fixture id: ${fixtureId}`)
  console.log(`[probe] cdp port:   ${cdpPort}`)
  console.log(`[probe] scratch:    ${scratch}`)

  const doneFile = join(scratch, "done")
  let failed = false
  try {
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

    vscodeRun = runTests({
      ...(executable ? { vscodeExecutablePath: executable } : {}),
      extensionDevelopmentPath: root,
      extensionTestsPath: runnerOut,
      extensionTestsEnv: {
        KILO_E2E_FIXTURE: "1",
        KILO_E2E_SCRATCH: scratch,
        KILO_E2E_FIXTURE_ID: fixtureId,
        // The runner seeds only the selected scenario(s) — never markers or
        // state produced by another scenario.
        KILO_E2E_SCENARIO: scenario,
        // Hermetic isolation: point the spawned CLI backend at a scratch XDG
        // tree so it loads a clean global config instead of the developer's
        // real ~/.config/kilo. This makes the Agent Manager's agent catalog and
        // provider/model config deterministic across machines (builtin agents
        // code/ask/plan, no custom providers, no model_variant overrides) and
        // prevents a dev's local config from breaking the scenario.
        XDG_CONFIG_HOME: join(scratch, "xdg-config"),
        XDG_DATA_HOME: join(scratch, "xdg-data"),
        XDG_CACHE_HOME: join(scratch, "xdg-cache"),
        XDG_STATE_HOME: join(scratch, "xdg-state"),
      },
      launchArgs: [
        workspace,
        `--user-data-dir=${userData}`,
        `--extensions-dir=${extensions}`,
        `--remote-debugging-port=${cdpPort}`,
        // Security note: CDP is bound to the loopback interface with a
        // freshly allocated port and a unique temp user-data profile owned by
        // this process. `--remote-allow-origins=*` is required because the
        // Playwright CDP WebSocket transport sends an Origin header that
        // recent Chromium builds reject unless allowed. Scope: this flag only
        // applies to the ephemeral, localhost-only, test-profile instance
        // launched here; it is never used by production extension launches.
        // Revisit for later docs: if a future Chromium accepts Playwright's
        // Origin without the flag, restrict it to the exact local origin.
        `--remote-allow-origins=*`,
      ],
    })

    await waitForCdp(cdpPort, 90_000)
    console.log("[probe] CDP endpoint reachable, connecting Playwright")
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 30_000 })
    try {
      if (process.env.KILO_E2E_FORCE_FAIL) {
        throw new Error("forced failure (KILO_E2E_FORCE_FAIL): exercising failure-path cleanup")
      }
      await waitForFile(join(scratch, "ready"), 120_000, "runner ready marker")
      await waitForFile(join(scratch, "plan.json"), 30_000, "runner plan marker")
      const plan = JSON.parse(readFileSync(join(scratch, "plan.json"), "utf8")) as E2EPlan
      console.log(
        `[probe] runner ready, plan: source=${plan.sourceId} sibling=${plan.siblingId} child=${plan.childId} ` +
          `variant=${plan.variantId} tabA=${plan.tabAId} tabB=${plan.tabBId} tabC=${plan.tabCId} ` +
          `topicRoot=${plan.topicRootId} topicChild=${plan.topicChildId} topicSibling=${plan.topicSiblingId}`,
      )
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
    } finally {
      // Unblock the extension-host runner on success AND failure so VS Code
      // always exits under program control (no detached processes).
      writeFileSync(doneFile, "done")
      await browser.close()
    }
  } catch (err) {
    failed = true
    console.error(`[probe] FAIL: ${err instanceof Error ? err.message : String(err)}`)
    writeFileSync(doneFile, "done")
  }

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

  await verifyCleanup(userData, cdpPort, scratch)
  console.log(`[probe] total elapsed: ${Math.round((Date.now() - started) / 1000)}s`)
  if (failed) process.exit(1)
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

main().catch((err) => {
  console.error(`[probe] FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  process.exit(1)
})
