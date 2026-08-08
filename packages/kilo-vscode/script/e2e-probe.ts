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
 *   - (unset) | all      => child-task-order AND variant-memory in one VS Code
 *                           lifecycle (the delivery gate),
 *   - child-task-order   => only the child-task scenario + its fixtures,
 *   - variant-memory     => only the variant-memory scenario + its fixtures.
 *   Any other value fails fast before VS Code launches. Focused runs:
 *     KILO_E2E_SCENARIO=child-task-order node script/e2e-probe-launch.mjs
 *     KILO_E2E_SCENARIO=variant-memory   node script/e2e-probe-launch.mjs
 *   (package shortcuts: `bun run test:e2e:child-task-order`,
 *   `bun run test:e2e:variant-memory`.)
 *
 * Scenarios are independent: each seeds only its own fixtures and coordinates
 * through scenario-specific markers (child-phase1-done / child-phase2-ready /
 * child-phase2-done, variant-ready). No scenario waits on another's markers.
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
// fail fast BEFORE VS Code launches (see main()).
const SCENARIO_VALUES = ["all", "child-task-order", "variant-memory"] as const
function parseScenarios(value: string): Set<string> {
  if (value === "all") return new Set(["child-task-order", "variant-memory"])
  if (value === "child-task-order" || value === "variant-memory") return new Set([value])
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
  sourceTitle: string
  siblingTitle: string
  childTitle: string
  variantTitle: string
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
        `[probe] runner ready, plan: source=${plan.sourceId} sibling=${plan.siblingId} child=${plan.childId} variant=${plan.variantId}`,
      )
      if (scenarios.has("child-task-order")) {
        await assertChildTaskOrder(browser, plan, scratch)
        console.log("[probe] child-task tab-order assertion passed")
      }
      if (scenarios.has("variant-memory")) {
        await assertVariantMemoryAcrossAgents(browser, plan, scratch)
        console.log("[probe] variant-memory assertion passed")
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
