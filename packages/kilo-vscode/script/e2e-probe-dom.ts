/**
 * Shared DOM/frame helper functions for the real VS Code E2E probe
 * (script/e2e-probe.ts). Extracted from the probe so the probe file stays
 * under its maxLines cap; these helpers are pure (Playwright Frame/Browser +
 * node fs) and are used by every scenario.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Browser, Frame, Page } from "@playwright/test"
import type { BackendSnapshot, QueuedObservation } from "../src/agent-manager/fixture-backend"
import {
  classifyQueuedObservation,
  countQueuedUserMessages,
  queuedStatusForSession,
  summarizeQueuedObservation,
  validateQueuedObservation,
} from "../src/agent-manager/fixture-backend"
import { isWrongPin, withPin, type PinExpectation } from "./e2e-pin"
import { validateAbortAttempts, validateSseTimeline } from "./e2e-evidence"

const LC_SELECT_VERSION = "lc-select-v1"

function lcHash(v: string): string {
  return createHash("sha256").update(v).digest("hex").slice(0, 16)
}

function lcBucket(remaining: number): string {
  if (remaining <= 0) return "0"
  if (remaining < 1_000) return "lt1s"
  if (remaining < 5_000) return "lt5s"
  return "ge5s"
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Shared plan shape parsed from the runner's `<scratch>/plan.json` (the runner
 * writes it from planIds(); the harness reads it back). Kept here so the
 * restart module and every scenario share the same structural contract.
 */
export interface E2EPlan {
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
  // real-session scenario — run-owned workspace config seed names.
  customProvider: string
  customModel: string
  customAgent: string
  customAgentB: string
  customAgentLabel: string
  customAgentBLabel: string
  customVariantA: string
  customVariantB: string
  // real-completed scenario — run-owned fixture identities shared with the runner.
  realMcpServer: string
  realMcpTool: string
  realUserTool: string
  realSkill: string
  realPermissionFile: string
  realArtifact: string
}

export async function waitForFile(file: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(file)) return
    if (Date.now() > deadline) throw new Error(`probe: timeout waiting for ${label}`)
    await sleep(200)
  }
}

/**
 * Backend-snapshot request client: each `request()` round-trips a numbered
 * marker to the extension-host runner, which executes the env-gated
 * backendSnapshot fixture command against the shared served backend and writes
 * `{prefix}-N.json`. `waitFor()` polls snapshots until the probe passes. The
 * prefix keeps the real scenarios' coordination files distinct
 * (real-snap / rc-snap / of-snap / rr-snap / rr-c-snap).
 */
export function snapshotClient(scratch: string, prefix = "real-snap") {
  let n = 1
  const request = async (): Promise<BackendSnapshot> => {
    const file = join(scratch, `${prefix}-${n}.json`)
    writeFileSync(join(scratch, `${prefix}-${n}-request`), "ok")
    await waitForFile(file, 60_000, `${prefix}-${n}.json`)
    n += 1
    return JSON.parse(readFileSync(file, "utf8")) as BackendSnapshot
  }
  const waitFor = async (
    probe: (snap: BackendSnapshot) => string | undefined,
    timeoutMs: number,
    label: string,
  ): Promise<BackendSnapshot> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const snap = await request()
      const failure = probe(snap)
      if (failure === undefined) {
        console.log(`[probe] PASS ${label}`)
        return snap
      }
      if (Date.now() > deadline) {
        throw new Error(`probe: ${label} failed: ${failure}`)
      }
      await sleep(500)
    }
  }
  return { request, waitFor }
}

/**
 * Find the Agent Manager webview frame anchored on the mounted app root
 * (`.am-layout`). The real-session scenarios never know the real session ids
 * ahead of time and start in the bottom-page state (pending tab, no tab strip
 * yet), so neither the title-based finder nor a `.am-tab-sortable` anchor
 * works. `.am-layout` is Agent Manager-specific — the editor-tab webview never
 * renders it. NOTE: on current VS Code the Agent Manager's content frame URL
 * is `fake.html` (the webview shim), so the finder must not filter on the
 * `index.html` path. Re-enumerates contexts/pages on every poll, so it also
 * survives the page churn of workbench.action.reloadWindow (Phase C).
 */
async function throwRedactedFrameLookupFailed(browser: Browser): Promise<never> {
  let contexts = 0
  let pages = 0
  let totalFrames = 0
  let vscodeWebviewFrames = 0
  let enumerationFailed = false
  try {
    const ctxs = browser.contexts()
    contexts = ctxs.length
    for (const ctx of ctxs) {
      const ps = ctx.pages()
      pages += ps.length
      for (const page of ps) {
        const frames = page.frames()
        totalFrames += frames.length
        for (const frame of frames) {
          if (frame.url().includes("vscode-webview")) vscodeWebviewFrames++
        }
      }
    }
  } catch (err) {
    void err
    enumerationFailed = true
  }
  throw new Error(
    `probe: Agent Manager webview frame not found (any tab). frame-lookup-failed counts=${JSON.stringify({ contexts, pages, totalFrames, vscodeWebviewFrames, enumerationFailed })} enums=${JSON.stringify({ urlKind: "vscode-webview", bodyCategory: "unknown" })}`,
  )
}

async function throwVerboseFrameLookupFailed(browser: Browser): Promise<never> {
  const details: string[] = []
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      for (const frame of page.frames()) {
        if (!frame.url().includes("vscode-webview")) continue
        const state = await frame
          .evaluate(() => ({
            amLayout: document.querySelectorAll(".am-layout").length,
            amTabs: document.querySelectorAll(".am-tab-sortable[data-tab-id]").length,
            bodyLen: (document.body?.innerHTML ?? "").length,
            text: (document.body?.innerText ?? "").slice(0, 200),
          }))
          .catch(() => ({ amLayout: -1, amTabs: -1, bodyLen: -1, text: "<unreadable>" }))
        details.push(`    frame: ${frame.url().slice(0, 140)} ${JSON.stringify(state)}`)
      }
    }
  }
  throw new Error(
    `probe: Agent Manager webview frame not found (any tab).\n${details.join("\n")}\n${await describeTargets(browser)}`,
  )
}

export async function findAgentManagerFrameAny(
  browser: Browser,
  timeoutMs: number,
  opts: { redacted?: boolean } = {},
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
            .locator(".am-layout")
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
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      if (opts.redacted) await throwRedactedFrameLookupFailed(browser)
      await throwVerboseFrameLookupFailed(browser)
    }
    await sleep(Math.min(250, remaining))
  }
  return found
}

export async function findAgentManagerFrameAnyRedacted(
  browser: Browser,
  timeoutMs: number,
): Promise<{ page: Page; frame: Frame; url: string }> {
  return findAgentManagerFrameAny(browser, timeoutMs, { redacted: true })
}

/** Session tabs only — the `pending:` draft tabs are excluded. */
export async function realTabStates(frame: Frame): Promise<Array<{ id: string; label: string }>> {
  const states = await tabStates(frame)
  return states.filter((t) => !t.id.startsWith("pending:"))
}

export async function waitForRealSessionTabs(
  frame: Frame,
  expected: number,
  timeoutMs: number,
  label: string,
): Promise<Array<{ id: string; label: string }>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const tabs = await realTabStates(frame)
    if (tabs.length === expected) {
      console.log(`[probe] PASS ${label}: ${tabs.map((t) => t.id).join(", ")}`)
      return tabs
    }
    if (Date.now() > deadline) {
      throw new Error(
        `probe: ${label} failed: ${tabs.length} real tab(s), expected ${expected}: ${JSON.stringify(tabs)}`,
      )
    }
    await sleep(250)
  }
}

export async function waitForAgentOption(frame: Frame, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snap = await agentOptions(frame, 5_000)
    const failure = agentOptionFailure(snap, label)
    if (failure === undefined) {
      console.log(`[probe] PASS custom agent served in ModeSwitcher: "${label}"`)
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`probe: custom agent "${label}" not listed in the real ModeSwitcher: ${failure}`)
    }
    await sleep(250)
  }
}

/** Type the prompt into the real prompt input and click the real Send button. */
async function typePromptAndSend(frame: Frame, text: string, timeoutMs: number): Promise<void> {
  const ta = frame.locator("textarea.prompt-input").first()
  await ta.waitFor({ state: "visible", timeout: timeoutMs })
  // Clear first: a transiently failed send restores its draft into the input
  // (sendMessageFailed → restoreFailed), and the retry path re-sends fresh.
  await ta.fill("")
  await ta.pressSequentially(text, { delay: 5 })
  const send = frame.locator('button[aria-label="Send"]').first()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const present = await send.count().then((n) => n > 0)
    const disabled = present ? await send.getAttribute("aria-disabled").catch(() => "true") : "true"
    if (present && disabled !== "true") break
    if (Date.now() > deadline) throw new Error("probe: Send button never became enabled after typing")
    await sleep(250)
  }
  await send.click({ timeout: timeoutMs })
  console.log(`[probe] sent prompt via real prompt input: ${text}`)
}

/**
 * Send a follow-up prompt to the CURRENTLY OPEN busy session through the real
 * prompt input (G3/B9 queued probe). Unlike sendWithRetry, this expects NO new
 * tab: the busy session stays open, the typed text keeps the Send button
 * visible (PromptInput shows Send while busy+typed, Stop only while
 * busy+empty), and the served backend enqueues the second prompt_async behind
 * the busy turn's per-session FIFO. Production Stop/abort behavior untouched.
 */
export async function sendFollowupToBusySession(frame: Frame, text: string, timeoutMs: number): Promise<void> {
  const ta = frame.locator("textarea.prompt-input").first()
  await ta.waitFor({ state: "visible", timeout: timeoutMs })
  await ta.fill("")
  await ta.pressSequentially(text, { delay: 5 })
  const send = frame.locator('button[aria-label="Send"]').first()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const present = await send.count().then((n) => n > 0)
    const disabled = present ? await send.getAttribute("aria-disabled").catch(() => "true") : "true"
    if (present && disabled !== "true") break
    if (Date.now() > deadline) throw new Error("probe: Send button never became enabled for busy-session follow-up")
    await sleep(250)
  }
  await send.click({ timeout: timeoutMs })
  console.log("[probe] sent busy-session follow-up via real prompt input (queued probe, no new tab expected)")
}

/**
 * G3/B9 investigation-only queued observation (fixture-only, SDK-visible shape
 * only — not backend queue truth, not an abort outcome). While the given
 * session is busy, sends `prompt` to the SAME session through the real prompt
 * input (no new tab), polls only the SDK-visible message/status shape, and
 * writes the bounded/redacted `queued-observation.json` artifact. Never fatal
 * to the A/B lifecycle: a failed tab select, failed Send click, or
 * unconverged wait records the last SDK-visible shape with
 * `sendClickAccepted:false` and the run continues to Stop. An artifact
 * build/validate/write failure skips the artifact file and returns. No abort semantics
 * change; no terminal/durable outcome is claimed; no queue-clear/idle inference.
 */
export async function observeQueuedFollowup(
  frame: Frame,
  snap: ReturnType<typeof snapshotClient>,
  sessionID: string,
  scratch: string,
  marker: string,
  prompt: string,
  timeoutMs: number,
): Promise<void> {
  let baseline: BackendSnapshot
  try {
    baseline = await snap.request()
  } catch {
    console.log("[probe] queued baseline snapshot unavailable, skipping queued observation (Stop continues)")
    return
  }
  const baselineCount = countQueuedUserMessages(baseline, sessionID) ?? 0
  const baselineStatus = queuedStatusForSession(baseline, sessionID)
  let sendClickAccepted = false
  try {
    await clickTab(frame, sessionID, timeoutMs)
    await sendFollowupToBusySession(frame, prompt, timeoutMs)
    sendClickAccepted = true
  } catch (err) {
    console.log(
      `[probe] queued follow-up not accepted (tab select or DOM Send click), recording last SDK shape: ${err instanceof Error ? err.message : String(err)}`,
    )
    sendClickAccepted = false
  }
  let observed: BackendSnapshot | undefined
  if (sendClickAccepted) {
    try {
      observed = await snap.waitFor(
        (s) => {
          const c = classifyQueuedObservation(s, sessionID, marker)
          if (c === "marker-visible-busy-no-assistant" || c === "marker-visible-nonbusy-or-assistant") return undefined
          return `queued SDK-visible shape=${c} (waiting for marker-visible shape, not backend queue truth)`
        },
        30_000,
        "queued second prompt SDK-visible shape observed on busy session",
      )
    } catch (err) {
      console.log(
        `[probe] queued SDK-visible wait did not converge, recording last SDK shape (not backend queue truth): ${err instanceof Error ? err.message : String(err)}`,
      )
      observed = await snap.request().catch(() => baseline)
    }
  } else {
    observed = await snap.request().catch(() => baseline)
  }
  try {
    const artifact: QueuedObservation = summarizeQueuedObservation({
      scenario: "real-session",
      observedAt: new Date().toISOString(),
      sessionID,
      baselineUserCount: baselineCount,
      baselineStatus,
      snap: observed ?? baseline,
      marker,
      sendClickAccepted,
    })
    const verr = validateQueuedObservation(artifact)
    if (verr) throw new Error(`probe: queued observation invalid: ${verr}`)
    writeFileSync(join(scratch, "queued-observation.json"), JSON.stringify(artifact, null, 2))
    console.log(`[probe] QUEUED OBSERVATION: ${JSON.stringify(artifact)}`)
  } catch (err) {
    const kind = err instanceof Error ? err.name : typeof err
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 200).replace(/\s+/g, " ")
    console.log(
      `[probe] queued observation artifact unavailable, skipping artifact (Stop continues): ${kind}: ${msg}`,
    )
    return
  }
}

/**
 * Send a prompt through the real prompt input, wait for the expected number of
 * real session tabs, then poll the served backend until `probe` passes. A
 * transiently failed send (e.g. the agent-requirements check racing the
 * webview's own fetch for the same agent) restores the draft into the input,
 * so on failure the harness clears it and re-sends — bounded attempts, no
 * timers, no synthetic messages.
 *
 * `fatal` (optional) marks a probe failure as NON-RETRYABLE: when it matches,
 * the send aborts immediately instead of re-sending, so a permanently wrong
 * first-turn fact (e.g. the first user message routed to the gateway fallback
 * model) can never be masked by a later retry.
 */
export async function sendWithRetry(
  frame: Frame,
  snap: ReturnType<typeof snapshotClient>,
  prompt: string,
  expectTabs: number,
  probe: (s: BackendSnapshot) => string | undefined,
  label: string,
  timeoutMs: number,
  fatal?: (failure: string) => boolean,
): Promise<BackendSnapshot> {
  for (let attempt = 1; ; attempt++) {
    let last = "unknown error"
    try {
      await typePromptAndSend(frame, prompt, timeoutMs)
      await waitForRealSessionTabs(frame, expectTabs, 20_000, `${label}: ${expectTabs} tab(s) (attempt ${attempt})`)
      return await snap.waitFor(probe, 25_000, `${label} (attempt ${attempt})`)
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
      if (fatal?.(last)) {
        throw new Error(`probe: ${label} failed (non-retryable): ${last}`)
      }
      if (attempt >= 3) {
        throw new Error(`probe: ${label} failed after ${attempt} attempts. Last: ${last}`)
      }
      await sleep(1_000)
    }
  }
}

/** Optional pin wiring for sendTurnWithPin (see below). */
export interface SendTurnPin {
  exp: PinExpectation
  prompt: string
  /** Resolves the backend session id the pin applies to (e.g. the root session). */
  sessionID: (s: BackendSnapshot) => string | undefined
}

/**
 * Shared completed-turn send helper for the real scenarios (real-completed,
 * real-overflow): type + send one prompt, then poll the served backend until
 * the probe passes — with the backend pin predicate composed FIRST when `pin`
 * is given (see e2e-pin.ts withPin), so a wrong-pinned send is detected on the
 * first snapshot that carries the message and fails permanently instead of
 * being masked by a retry. Bounded attempts; a transiently failed send
 * restores the draft into the input and re-sends. `onFailure` receives the
 * caught error before the retry decision so callers can dump run-owned
 * diagnostics (e.g. the scripted-model request log).
 */
export async function sendTurnWithPin(
  frame: Frame,
  snap: ReturnType<typeof snapshotClient>,
  prompt: string,
  probe: (s: BackendSnapshot) => string | undefined,
  label: string,
  timeoutMs: number,
  pin?: SendTurnPin,
  onFailure?: (err: unknown) => void,
): Promise<BackendSnapshot> {
  for (let attempt = 1; ; attempt++) {
    try {
      await typePromptAndSend(frame, prompt, timeoutMs)
      const combined = pin ? withPin(probe, pin.exp, pin.prompt, pin.sessionID) : probe
      const result = await snap.waitFor(combined, 90_000, `${label} (attempt ${attempt})`)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      onFailure?.(err)
      if (isWrongPin(message)) {
        throw new Error(`probe: ${label} failed (non-retryable pin mismatch): ${message}`)
      }
      if (attempt >= 3) {
        throw new Error(`probe: ${label} failed after ${attempt} attempts. Last: ${message}`)
      }
      await sleep(1_000)
    }
  }
}

/** Poll until the given text appears anywhere in the real webview DOM. */
export async function expectTranscriptText(
  frame: Frame,
  text: string,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = await frame
      .getByText(text, { exact: false })
      .count()
      .catch(() => 0)
    if (hit > 0) {
      console.log(`[probe] PASS ${label}: transcript text present`)
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`probe: ${label} failed: transcript text "${text}" not found in the webview DOM`)
    }
    await sleep(250)
  }
}

/** Open a session from the real sidebar (derived-topic root row keyed by session id). */
export async function openSidebarSession(frame: Frame, sessionId: string, timeoutMs: number): Promise<void> {
  const row = frame.locator(`.am-item.am-topic-root[data-topic-id="${sessionId}"]`).first()
  await row.waitFor({ state: "visible", timeout: timeoutMs })
  await row.locator(".am-item-title-text").first().click({ timeout: timeoutMs })
  console.log(`[probe] clicked sidebar session row ${sessionId}`)
}

export async function tabLabels(frame: Frame): Promise<string[]> {
  return frame
    .locator(".am-tab .am-tab-label")
    .allTextContents()
    .then((items) => items.map((s) => s.trim()))
    .catch(() => [])
}

/** Ordered [{id, label}] for every session tab (ids from the sortable container). */
export async function tabStates(frame: Frame): Promise<Array<{ id: string; label: string }>> {
  return frame.evaluate(() => {
    const out: Array<{ id: string; label: string }> = []
    const containers = Array.from(document.querySelectorAll<HTMLElement>(".am-tab-sortable"))
    for (const container of containers) {
      const id = container.getAttribute("data-tab-id") ?? ""
      const label = container.querySelector(".am-tab-label")?.textContent?.trim() ?? ""
      if (id) out.push({ id, label })
    }
    return out
  })
}

export async function activeTabLabel(frame: Frame): Promise<string | undefined> {
  return frame
    .locator(".am-tab.am-tab-active .am-tab-label")
    .first()
    .textContent()
    .then((s) => s?.trim())
    .catch(() => undefined)
}

/** The tab ID of the currently active session tab, if any. */
export async function activeTabId(frame: Frame): Promise<string | undefined> {
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
export async function expectTabOrder(
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

export async function clickChildTaskLink(frame: Frame, timeoutMs: number): Promise<void> {
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

/** Text of the first element matching the selector (label of a selector trigger). */
export async function labelText(frame: Frame, selector: string): Promise<string | undefined> {
  return (
    frame
      .locator(selector)
      .first()
      // Bounded per-read wait so a transiently absent node (e.g. a selector that
      // unmounts/remounts during an agent-switch re-render) never blocks a poll
      // loop on Playwright's 30s default — the caller's loop survives it.
      .textContent({ timeout: 2_000 })
      .then((s) => s?.trim())
      .catch(() => undefined)
  )
}

/** Poll until the selector trigger label equals the expected text. */
export async function waitForLabel(
  frame: Frame,
  selector: string,
  expected: string,
  timeoutMs: number,
  label: string,
): Promise<void> {
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

/**
 * Pure readiness check for the model selector trigger label: true when the
 * label VISIBLY shows the custom provider/model — either the raw pinned form
 * (`e2e-local / e2e-model`) or the catalog-resolved provider/model names
 * ("E2E Local / E2E Model"). Whitespace AND hyphens are normalized so the two
 * display forms match the same ids ("E2E Local" -> "e2e-local"). Exported for
 * the focused unit tests.
 */
export function modelLabelShows(providerID: string, modelID: string, label: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\s-]+/g, "")
  const normalized = norm(label)
  return normalized.includes(norm(providerID)) && normalized.includes(norm(modelID))
}

/**
 * Action-specific model readiness (LOCK-012, not a global barrier): poll the
 * real model selector trigger label (`.model-selector-trigger-label`) until it
 * VISIBLY shows the custom provider/model (see modelLabelShows). The webview
 * model resolution falls through to the gateway KILO_AUTO free model while the
 * served config/catalog are unresolved, so the first send of a real scenario
 * must wait for this visible selector state — the Send button only gates
 * connection, not config/model readiness.
 */
export async function waitForModelSelected(
  frame: Frame,
  providerID: string,
  modelID: string,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const text = (await labelText(frame, ".model-selector-trigger-label")) ?? ""
    if (modelLabelShows(providerID, modelID, text)) {
      console.log(`[probe] PASS ${label}: "${text}"`)
      return
    }
    if (Date.now() > deadline) {
      const evidence = await frame
        .evaluate(() => ({
          modelTrigger: document.querySelector(".model-selector-trigger-label")?.textContent?.trim() ?? null,
          thinkingTrigger: document.querySelector(".thinking-selector-trigger-label")?.textContent?.trim() ?? null,
          modeTrigger: document.querySelector(".mode-switcher-trigger-label")?.textContent?.trim() ?? null,
          body: (document.body?.innerText ?? "").slice(0, 1200),
        }))
        .catch(() => ({ error: "evaluate failed" }))
      throw new Error(
        `probe: ${label} failed: model selector label "${text}" does not show ${providerID}/${modelID}.\n` +
          `  dom=${JSON.stringify(evidence, null, 2)}`,
      )
    }
    await sleep(250)
  }
}

export async function waitForTab(frame: Frame, tabId: string, timeoutMs: number): Promise<void> {
  const tab = frame.locator(`.am-tab-sortable[data-tab-id="${tabId}"]`).first()
  await tab.waitFor({ state: "visible", timeout: timeoutMs })
}

export async function waitForTabTarget(frame: Frame, tabId: string, timeoutMs: number): Promise<void> {
  const target = frame.locator(`.am-tab-sortable[data-tab-id="${tabId}"] .am-tab-target`).first()
  await target.waitFor({ state: "visible", timeout: timeoutMs })
}

export async function clickVisibleTabTarget(frame: Frame, tabId: string, timeoutMs: number): Promise<void> {
  const target = frame.locator(`.am-tab-sortable[data-tab-id="${tabId}"] .am-tab-target`).first()
  await target.click({ timeout: timeoutMs })
}

function tabDeadlineError(targetHash: string, activeHash: string, bucket: string, stage: string): Error {
  return new Error(`probe: tab-select deadline stage=${stage} targetHash=${targetHash} activeHash=${activeHash} bucket=${bucket}`)
}

function tabStageError(stage: string, targetHash: string, bucket: string): Error {
  return new Error(`probe: tab-select ${stage} failed targetHash=${targetHash} bucket=${bucket}`)
}

export async function clickTab(frame: Frame, tabId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const targetHash = lcHash(tabId)
  const remainingOrThrow = (active = "<detached>"): number => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      const activeHash = lcHash(active)
      throw tabDeadlineError(targetHash, activeHash, lcBucket(remaining), "clickTab")
    }
    return remaining
  }
  const remainingWait = remainingOrThrow("<detached>")
  try {
    await waitForTabTarget(frame, tabId, remainingWait)
  } catch (err) {
    void err
    throw tabStageError("wait", targetHash, lcBucket(remainingWait))
  }
  const remainingClick = remainingOrThrow("<detached>")
  try {
    await clickVisibleTabTarget(frame, tabId, remainingClick)
  } catch (err) {
    void err
    throw tabStageError("click", targetHash, lcBucket(remainingClick))
  }
}

/** Click the real Stop button (production abort path: webview → extension → SDK abort). */
export async function clickStop(frame: Frame, timeoutMs: number): Promise<void> {
  const stop = frame.locator('button[aria-label="Stop"]').first()
  await stop.waitFor({ state: "visible", timeout: timeoutMs })
  await stop.click({ timeout: timeoutMs })
  console.log("[probe] clicked Stop (production abort path)")
}

/**
 * Fixture-only bounded SSE timeline windows around Stop A / Stop B
 * (LOCK-049/050/051): the harness brackets each Stop with scratch markers;
 * the extension-host runner starts/stops the redacted observer and writes the
 * durable `sse-timeline-abort-A/B.json` artifact. The artifact carries only
 * redacted delivered-event metadata in arrival order; its timestamps are
 * client-observed receipt times, never wire/server claims.
 */
export async function startSseTimelineWindow(scratch: string, tag: string): Promise<void> {
  writeFileSync(join(scratch, `sse-timeline-${tag}-start-request`), "ok")
  await waitForFile(join(scratch, `sse-timeline-${tag}-started`), 60_000, `sse-timeline-${tag}-started marker`)
  console.log(`[probe] SSE timeline window ${tag} started`)
}

export async function stopSseTimelineWindow(scratch: string, tag: string): Promise<unknown> {
  writeFileSync(join(scratch, `sse-timeline-${tag}-stop-request`), "ok")
  const file = join(scratch, `sse-timeline-abort-${tag}.json`)
  await waitForFile(file, 60_000, `sse-timeline-abort-${tag}.json`)
  const raw = readFileSync(file, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`probe: sse-timeline-abort-${tag}.json malformed`)
  }
  const err = validateSseTimeline(parsed)
  if (err) throw new Error(`probe: sse-timeline-abort-${tag}.json invalid: ${err}`)
  console.log(`[probe] SSE timeline window ${tag} stopped`)
  return parsed
}

/** Run-level abort-attempt artifact written by the runner after Stop B. */
export const ABORT_ATTEMPTS_FILE = "abort-attempts.json"

/**
 * Marker-driven acknowledgement of the cumulative run-level abort export: waits
 * for `abort-attempts.json` after the Stop B timeline artifact, then validates
 * the fixture-only bounded/redacted envelope. Absence fails here (the Stop B
 * export must exist once the timeline artifact was acknowledged); the evidence
 * handoff separately treats absence as allowed.
 */
export async function waitForAbortAttempts(scratch: string, timeoutMs = 60_000): Promise<unknown> {
  const file = join(scratch, ABORT_ATTEMPTS_FILE)
  await waitForFile(file, timeoutMs, ABORT_ATTEMPTS_FILE)
  const raw = readFileSync(file, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("probe: abort-attempts.json malformed")
  }
  const err = validateAbortAttempts(parsed)
  if (err) throw new Error(`probe: abort-attempts.json invalid: ${err}`)
  console.log("[probe] abort attempts export acknowledged")
  return parsed
}

/** Bound for the secondary timeline-cleanup diagnostic (same bound as timeline strings). */
export const TIMELINE_CLEANUP_DIAGNOSTIC_LIMIT = 500

/** Primary error with an optional bounded non-enumerable cleanup diagnostic. */
export type TimelinePrimaryError = Error & { timelineCleanupError?: string }

function cleanupDiagnostic(cleanup: unknown): string {
  const msg = cleanup instanceof Error ? cleanup.message : String(cleanup)
  return msg.length <= TIMELINE_CLEANUP_DIAGNOSTIC_LIMIT ? msg : msg.slice(0, TIMELINE_CLEANUP_DIAGNOSTIC_LIMIT)
}

/**
 * Stop-bracketed work with primary-preserving cleanup (LOCK-079). The stop is
 * always attempted even when the primary work fails. When both fail, the
 * original primary object is rethrown unchanged and the bounded secondary
 * diagnostic is logged plus attached as a non-enumerable `timelineCleanupError`
 * without replacing the primary.
 */
export async function runWithTimelineStop(
  tag: string,
  work: () => Promise<void>,
  stop: () => Promise<unknown>,
): Promise<void> {
  try {
    await work()
  } catch (primary) {
    try {
      await stop()
    } catch (cleanup) {
      const detail = cleanupDiagnostic(cleanup)
      console.error(`[probe] timeline-stop ${tag} cleanup also failed: ${detail}`)
      if (primary instanceof Error) {
        try {
          Object.defineProperty(primary, "timelineCleanupError", {
            value: detail,
            enumerable: false,
            writable: true,
            configurable: true,
          })
        } catch (attach) {
          const msg = attach instanceof Error ? attach.message : String(attach)
          console.error(`[probe] timeline-stop ${tag} diagnostic attach failed: ${msg}`)
        }
      }
      throw primary
    }
    throw primary
  }
  await stop()
}

/**
 * Phase 4 of the real-session lifecycle (H-11 abort, independent control):
 * abort A (B stays busy), then abort B — with each Stop bracketed by a
 * fixture-only bounded redacted SSE timeline window so the next real probe can
 * read delivered-event arrival order around the abort. The stop is always
 * attempted even when the abort assertion fails, but the primary Stop/status
 * failure stays primary: when both fail the original primary object is
 * rethrown with the bounded secondary diagnostic logged/attached (LOCK-079).
 * The backend status endpoint deletes idle sessions from its map (absent
 * status == idle), so the probes normalize `undefined` to "idle".
 */
export async function abortRealSessionsWithTimeline(
  frame: Frame,
  snap: ReturnType<typeof snapshotClient>,
  sessionA: string,
  sessionB: string,
  scratch: string,
  timeout: number,
): Promise<void> {
  const runWithStop = async (tag: string, work: () => Promise<void>): Promise<void> =>
    runWithTimelineStop(tag, work, () => stopSseTimelineWindow(scratch, tag))
  await startSseTimelineWindow(scratch, "A")
  await runWithStop("A", async () => {
    await clickTab(frame, sessionA, timeout)
    await clickStop(frame, timeout)
    await snap.waitFor(
      (s) => {
        const a = s.statuses[sessionA] ?? "idle"
        if (a !== "idle") return `session A status=${a} expected idle after abort`
        if (s.statuses[sessionB] !== "busy")
          return `session B status=${s.statuses[sessionB]} expected still busy (independent control)`
        return undefined
      },
      60_000,
      "abort A leaves A idle and B busy",
    )
  })
  await startSseTimelineWindow(scratch, "B")
  await runWithStop("B", async () => {
    await clickTab(frame, sessionB, timeout)
    await clickStop(frame, timeout)
    await snap.waitFor(
      (s) => {
        const b = s.statuses[sessionB] ?? "idle"
        if (b !== "idle") return `session B status=${b} expected idle after abort`
        return undefined
      },
      60_000,
      "abort B leaves B idle",
    )
  })
  await waitForAbortAttempts(scratch, 60_000)
}

export async function waitForActiveTabId(frame: Frame, expectedId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const targetHash = lcHash(expectedId)
  for (;;) {
    const active = await activeTabId(frame).catch(() => undefined)
    if (active === expectedId) return
    if (Date.now() > deadline) {
      const activeHash = lcHash(active ?? "none")
      const remaining = deadline - Date.now()
      throw tabDeadlineError(targetHash, activeHash, lcBucket(remaining), "poll")
    }
    await sleep(250)
  }
}

export async function selectLifecycleTab(
  browser: Browser,
  frame: Frame,
  tabId: string,
  timeoutMs: number,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  const targetHash = lcHash(tabId)
  let waitAttempts = 0
  let clickAttempts = 0
  let reacquires = 0
  let detachedSeen = 0
  let activePolls = 0
  let lastActive: string | undefined
  let stage: string = "init"
  let lastRemaining = timeoutMs
  let cur = frame

  const frameHashSync = (f: Frame): string => {
    try {
      const u = (f as unknown as { url?: () => string }).url?.()
      if (typeof u === "string" && u.length > 0) return lcHash(u)
    } catch (err) {
      void err
      return "none"
    }
    return "none"
  }

  const emit = (s: string, active?: string, remaining?: number): void => {
    stage = s
    if (active !== undefined) lastActive = active
    const r = remaining ?? lastRemaining
    lastRemaining = r
    const activeHash = lastActive ? lcHash(lastActive) : "none"
    const bucket = lcBucket(r)
    let fHash = "none"
    try {
      fHash = frameHashSync(cur)
    } catch (err) {
      void err
      fHash = "none"
    }
    const payload = {
      v: LC_SELECT_VERSION,
      targetHash,
      activeHash,
      stage,
      waitAttempts,
      clickAttempts,
      reacquires,
      detachedSeen,
      activePolls,
      remainingBucket: bucket,
      frameHash: fHash,
    }
    console.log(`[probe] lifecycle-select ${JSON.stringify(payload)}`)
  }

  const remainingOrThrow = (active?: string): number => {
    const remaining = deadline - Date.now()
    lastRemaining = remaining
    if (active !== undefined) lastActive = active
    if (remaining <= 0) {
      emit("deadline", active, remaining)
      const activeHash = lcHash(active ?? "none")
      throw tabDeadlineError(targetHash, activeHash, lcBucket(remaining), "deadline")
    }
    return remaining
  }

  // initial detach reacquire (positive frame, no extra sampling)
  {
    remainingOrThrow("<detached>")
    let detached = false
    try {
      detached = cur.isDetached()
    } catch {
      detached = true
    }
    if (detached) {
      detachedSeen++
      stage = "detach"
      const remaining = remainingOrThrow("<detached>")
      const fresh = await findAgentManagerFrameAnyRedacted(browser, remaining)
      cur = fresh.frame
      reacquires++
    }
  }
  {
    // Wait stage outside retry boundary — wait failure never retries even if detached
    stage = "wait"
    const remainingWait = remainingOrThrow("<detached>")
    waitAttempts++
    try {
      await waitForTabTarget(cur, tabId, remainingWait)
    } catch (err) {
      void err
      emit("wait", "<detached>", remainingWait)
      throw tabStageError("wait", targetHash, lcBucket(remainingWait))
    }
    stage = "click"
    const remainingClick = remainingOrThrow("<detached>")
    clickAttempts++
    try {
      await clickVisibleTabTarget(cur, tabId, remainingClick)
    } catch (err) {
      void err
      remainingOrThrow("<detached>")
      let isDetached = false
      try {
        isDetached = cur.isDetached()
      } catch (err2) {
        void err2
        isDetached = true
      }
      if (isDetached) {
        detachedSeen++
        emit("click", "<detached>", remainingClick)
        const rem2 = remainingOrThrow("<detached>")
        const fresh = await findAgentManagerFrameAnyRedacted(browser, rem2)
        cur = fresh.frame
        reacquires++
        stage = "wait"
        const remWait2 = remainingOrThrow("<detached>")
        waitAttempts++
        try {
          await waitForTabTarget(cur, tabId, remWait2)
        } catch (err2) {
          void err2
          emit("wait", "<detached>", remWait2)
          throw tabStageError("wait", targetHash, lcBucket(remWait2))
        }
        stage = "click"
        const rem3 = remainingOrThrow("<detached>")
        clickAttempts++
        try {
          await clickVisibleTabTarget(cur, tabId, rem3)
        } catch (err3) {
          void err3
          emit("click", "<detached>", rem3)
          throw tabStageError("click", targetHash, lcBucket(rem3))
        }
      } else {
        emit("click", "<detached>", remainingClick)
        throw tabStageError("click", targetHash, lcBucket(remainingClick))
      }
    }
  }
  for (;;) {
    remainingOrThrow("<detached>")
    let needReacquire = false
    try {
      needReacquire = cur.isDetached()
    } catch {
      needReacquire = true
    }
    if (needReacquire) {
      detachedSeen++
      stage = "detach"
      const remaining = remainingOrThrow("<detached>")
      const fresh = await findAgentManagerFrameAnyRedacted(browser, remaining)
      cur = fresh.frame
      reacquires++
    }
    stage = "poll"
    remainingOrThrow("<detached>")
    const active = await activeTabId(cur).catch(() => undefined)
    lastActive = active
    activePolls++
    if (active === tabId) return cur
    const remaining = remainingOrThrow(active ?? "<none>")
    await sleep(Math.min(250, remaining))
  }
}

/**
 * Click the real production close button of one session tab. The button is
 * the `.am-tab-close` rendered by the production SessionTab component inside
 * that tab's `.am-tab-sortable` container — the exact DOM element a user
 * clicks. Scoping by the tab's data-tab-id never depends on a locale-dependent
 * aria-label or title string.
 */
export async function clickTabClose(frame: Frame, tabId: string, timeoutMs: number): Promise<void> {
  const btn = frame.locator(`.am-tab-sortable[data-tab-id="${tabId}"] .am-tab-close`).first()
  await btn.waitFor({ state: "visible", timeout: timeoutMs })
  await btn.click({ timeout: timeoutMs })
  console.log(`[probe] clicked .am-tab-close for tab ${tabId}`)
}

/** Poll until no `.am-tab-sortable` session tab remains (only-tab close path). */
export async function waitForNoSessionTabs(frame: Frame, timeoutMs: number, label: string): Promise<void> {
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

export interface SidebarChildState {
  id: string
  label: string
  active: boolean
}

export interface SidebarTopicState {
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
export async function sidebarTopicStates(frame: Frame): Promise<SidebarTopicState[]> {
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
export async function expectTopicHierarchy(
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
export async function headerTitle(frame: Frame): Promise<string | undefined> {
  return frame
    .locator('[data-slot="task-header-title-label"]')
    .first()
    .textContent({ timeout: 2_000 })
    .then((s) => s?.trim())
    .catch(() => undefined)
}

/** Poll until the chat header title equals the expected session title. */
export async function expectHeaderTitle(
  frame: Frame,
  expected: string,
  timeoutMs: number,
  label: string,
): Promise<void> {
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
export async function clickSidebarTopic(frame: Frame, topicId: string, timeoutMs: number): Promise<void> {
  const row = frame.locator(`.am-item.am-topic-root[data-topic-id="${topicId}"]`).first()
  await row.waitFor({ state: "visible", timeout: timeoutMs })
  await row.locator(".am-item-title-text").first().click({ timeout: timeoutMs })
  console.log(`[probe] clicked sidebar topic row ${topicId}`)
}

/** Click a child session row under its expanded Topic in the real sidebar. */
export async function clickSidebarChild(frame: Frame, sessionId: string, timeoutMs: number): Promise<void> {
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
export async function assertNoWorktree(frame: Frame, label: string): Promise<void> {
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
 * Close an open popover list if one exists. Counts first so an absent list
 * never blocks on Playwright's default 30s action timeout (an unconditional
 * `press("Escape")` on a locator with no match did exactly that and exhausted
 * the pick retry deadline), and bounds the press itself for the Kobalte detach
 * race (options can detach on focus).
 */
export async function closePopover(frame: Frame, listSelector: string): Promise<void> {
  const open = await frame
    .locator(listSelector)
    .count()
    .catch(() => 0)
  if (open > 0) {
    await frame
      .locator(listSelector)
      .first()
      .press("Escape", { timeout: 2_000 })
      .catch(() => {})
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
export async function pickOption(
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
    await frame
      .locator(triggerSelector)
      .first()
      .click({ timeout: 5_000 })
      .catch(() => {})
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
export async function pickVariant(frame: Frame, value: string, timeoutMs: number): Promise<void> {
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
export async function pickAgent(frame: Frame, value: string, timeoutMs: number): Promise<void> {
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

/**
 * Structured ModeSwitcher read: which variant of the trigger is rendered
 * plus the visible option labels. The webview renders its trigger ONLY when
 * agents.length > 1, so "trigger absent" (index never populated),
 * "trigger rendered but disabled" (selection cannot resolve against the
 * served agents — the legacy default-agent parity regression signature), and
 * "trigger present with an empty/short list" are distinct failure modes the
 * harness must not conflate — a plain [] used to hide all three.
 */
export interface ModeSwitcherSnapshot {
  /** True when the `.mode-switcher-trigger-label` trigger exists in the DOM. */
  triggerRendered: boolean
  /** "interactive" popover, disabled trigger, or "absent" from the DOM. */
  variant: "interactive" | "disabled" | "absent"
  /** Visible agent option labels after opening the popover ([] when unrendered/disabled). */
  options: string[]
  /** Captured trigger-click failure text (never swallowed); undefined on success. */
  clickError?: string
}

/** Bounded wait for the popover list to become visible before reading items. */
const MODE_SWITCHER_LIST_WAIT_MS = 2_000

/**
 * Pure readiness classifier for the ModeSwitcher agent list. Returns undefined
 * when the expected label is served by a properly populated switcher;
 * otherwise a DISTINCT reason string per failure mode:
 * - trigger never rendered (webview hides it when agents.length <= 1),
 * - trigger rendered but disabled (aria-disabled="true"),
 * - trigger click failed (captured error text, not swallowed),
 * - trigger rendered but fewer than 2 visible options,
 * - expected label missing from a populated list.
 * Exported for the focused unit tests.
 */
export function agentOptionFailure(snap: ModeSwitcherSnapshot, label: string): string | undefined {
  if (!snap.triggerRendered || snap.variant === "absent") {
    return "ModeSwitcher trigger never rendered — the webview hides the trigger when agents.length <= 1"
  }
  if (snap.variant === "disabled") {
    return 'ModeSwitcher trigger is disabled (aria-disabled="true") — the selection value matches no served agent'
  }
  if (snap.clickError) {
    return snap.clickError
  }
  if (snap.options.length < 2) {
    return `ModeSwitcher shows ${snap.options.length} visible option(s) [${snap.options.join(", ")}]; expected >= 2`
  }
  if (!snap.options.includes(label)) {
    return `expected label not listed; options=[${snap.options.join(", ")}]`
  }
  return undefined
}

/** Agent labels offered by the ModeSwitcher (production popover options), then close it. */
export async function agentOptions(frame: Frame, timeoutMs: number): Promise<ModeSwitcherSnapshot> {
  const trigger = frame.locator(".mode-switcher-trigger-label")
  const triggerRendered = await trigger
    .count()
    .then((n) => n > 0)
    .catch(() => false)
  if (!triggerRendered) {
    return { triggerRendered: false, variant: "absent", options: [] }
  }
  // Disabled-variant detection BEFORE clicking: a disabled trigger can never
  // open the popover, so the read must report the variant instead of a
  // misleading empty-options list.
  const disabled = await frame
    .locator('button[aria-disabled="true"] .mode-switcher-trigger-label')
    .count()
    .then((n) => n > 0)
    .catch(() => false)
  if (disabled) {
    return { triggerRendered: true, variant: "disabled", options: [] }
  }
  let clickError: string | undefined
  await trigger
    .first()
    .click({ timeout: 5_000 })
    .catch((err: unknown) => {
      clickError = `ModeSwitcher trigger click failed: ${err instanceof Error ? err.message : String(err)}`
    })
  // Bounded wait for the popover before reading items (a just-clicked list may
  // need a tick to mount); absence after the bound is itself diagnostic.
  const listVisible = await frame
    .locator(".mode-switcher-list")
    .first()
    .waitFor({ state: "visible", timeout: Math.min(MODE_SWITCHER_LIST_WAIT_MS, timeoutMs) })
    .then(() => true)
    .catch(() => false)
  const names: string[] = listVisible
    ? await frame
        .locator(".mode-switcher-list .mode-switcher-item-name")
        .allTextContents()
        .then((items) => items.map((s) => s.trim()).filter((s) => s.length > 0))
        .catch(() => [])
    : []
  // Close the popover again (Escape) so the next pick starts from a closed state.
  await closePopover(frame, ".mode-switcher-list")
  return clickError === undefined
    ? { triggerRendered: true, variant: "interactive", options: names }
    : { triggerRendered: true, variant: "interactive", options: names, clickError }
}

/**
 * Canonical-state probe round trip over the fixture bridge: writes the
 * `rr-cstate-request` marker; the extension-host runner executes the env-gated
 * `kilo-code.new.e2eFixture.canonicalState` command (read-only
 * CanonicalConfigService snapshot) and writes `rr-cstate.json`. Called BEFORE
 * the agent-list assertion in restartPhase0 so a recurring ModeSwitcher
 * options=[] is self-diagnosing (H1 readiness-never-opened vs H2 empty index).
 */
export async function requestCanonicalState(scratch: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const file = join(scratch, "rr-cstate.json")
  writeFileSync(join(scratch, "rr-cstate-request"), "ok")
  await waitForFile(file, timeoutMs, "rr-cstate.json (canonical state probe)")
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
}

/**
 * Credential-seeding probe round trip: writes `rr-credseed-request`; the
 * runner executes the env-gated `kilo-code.new.e2eFixture.seedCredential`
 * command (production storeSecret path + GUI-write convergence) and writes
 * `rr-credential.json`. Never exposes the secret value. Called before
 * rr-ready/first canonical-state assertion to prove the real SecretStorage
 * path converged.
 */
export async function requestSeedCredential(scratch: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const marker = join(scratch, "rr-credseed-request")
  const file = join(scratch, "rr-credential.json")
  // Ensure round-trip freshness: remove any prior file so waitForFile proves
  // the fresh command execution, not a stale pre-rr-ready write.
  try {
    rmSync(file, { force: true } as never)
  } catch (err) {
    void err
  }
  writeFileSync(marker, "ok")
  await waitForFile(file, timeoutMs, "rr-credential.json (credential seeding probe)")
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
}

/**
 * Real-session canonical-state probe: `rs-cstate-request` → `rs-cstate.json`.
 * Mirrors requestCanonicalState for the rr- boundary but uses distinct
 * rs- markers so the five-boundary claim aggregates across manifests without
 * collision. Called BEFORE the agent-list assertion in the real-session
 * lifecycle for the same H1/H2 diagnostic.
 */
export async function requestRsCanonicalState(scratch: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const file = join(scratch, "rs-cstate.json")
  writeFileSync(join(scratch, "rs-cstate-request"), "ok")
  await waitForFile(file, timeoutMs, "rs-cstate.json (canonical state probe)")
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
}

/**
 * Real-session credential round trip: `rs-credseed-request` → `rs-credential.json`.
 * Mirrors requestSeedCredential but uses the rs- marker so the evidence
 * inventory stays distinct from the real-restart rs-credential.json file.
 * Never exposes the secret value.
 */
export async function requestRsSeedCredential(scratch: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const marker = join(scratch, "rs-credseed-request")
  const file = join(scratch, "rs-credential.json")
  try {
    rmSync(file, { force: true } as never)
  } catch (err) {
    void err
  }
  writeFileSync(marker, "ok")
  await waitForFile(file, timeoutMs, "rs-credential.json (credential seeding probe)")
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
}

/** Poll until the given file's bytes exactly equal `expected`. */
export async function waitForFileBytes(
  file: string,
  expected: string,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const bytes = existsSync(file) ? readFileSync(file, "utf8") : "<missing>"
    if (bytes === expected) {
      console.log(`[probe] PASS ${label}`)
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`probe: ${label} failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(bytes)}`)
    }
    await sleep(250)
  }
}

/**
 * Click the real production "Revert to here" control on one user message row.
 * The control is an IconButton inside the hover-revealed
 * `[data-slot="user-message-copy-wrapper"]` (opacity 0 / pointer-events none
 * until the `[data-component="user-message"]` container is hovered), so the
 * harness hovers the row first and then clicks the revealed button — the same
 * interaction a user performs. The row is scoped by the served-backend message
 * id via the production `data-message` attribute; the exact revert button is
 * `[data-component="icon-button"][data-icon="arrow-left"]` with the
 * "Revert to here" aria-label (fork uses data-icon="fork"; pull-back only
 * renders for queued messages, which the completed rollback turns never are).
 */
export async function clickRevertToHere(frame: Frame, messageID: string, timeoutMs: number): Promise<void> {
  const row = frame.locator(`[data-message="${messageID}"] .vscode-session-turn-user`).first()
  await row.waitFor({ state: "visible", timeout: timeoutMs })
  await row.hover({ timeout: timeoutMs })
  const btn = row.locator('[data-component="icon-button"][data-icon="arrow-left"][aria-label="Revert to here"]').first()
  await btn.waitFor({ state: "visible", timeout: timeoutMs })
  await btn.click({ timeout: timeoutMs })
  console.log(`[probe] clicked production Revert-to-here on user message ${messageID}`)
}

/** Poll until the RevertBanner lists the given file in its per-file diff rows. */
export async function expectBannerFile(frame: Frame, file: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const names: string[] = await frame
      .locator(".revert-banner .revert-banner-filename")
      .allTextContents()
      .then((items) => items.map((s) => s.trim()))
      .catch(() => [])
    if (names.includes(file)) {
      console.log(`[probe] PASS ${label}: banner lists "${file}"`)
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`probe: ${label} failed: banner filenames=[${names.join(", ")}]`)
    }
    await sleep(250)
  }
}

/**
 * Pure decision for the visible "New session" primary action.
 *
 * Candidates are split into role-based (accessible name "New session") and
 * fallback icon-based (icon-button plus). Preference is role; fallback is used
 * only when no role candidate is visible. Requires exactly one visible primary
 * candidate before a click — multiple visible candidates fail closed. Never
 * uses the tab-add split container hierarchy as a locator scope.
 */
export type NewSessionRoleFallback = "role" | "fallback"
export interface NewSessionCandidateDecisionInputs {
  roleCandidates: Array<{ visible: boolean }>
  fallbackCandidates: Array<{ visible: boolean }>
}
export function decideNewSessionCandidates(
  inputs: NewSessionCandidateDecisionInputs,
): { pick: NewSessionRoleFallback } | { error: string } {
  const roleVisible = inputs.roleCandidates.filter((c) => c.visible).length
  const fallbackVisible = inputs.fallbackCandidates.filter((c) => c.visible).length
  if (roleVisible === 1) return { pick: "role" }
  if (roleVisible > 1)
    return {
      error: `ambiguous New session role candidates visible=${roleVisible} totalRole=${inputs.roleCandidates.length} fallbackVisible=${fallbackVisible}`,
    }
  if (roleVisible === 0 && fallbackVisible === 1) return { pick: "fallback" }
  if (roleVisible === 0 && fallbackVisible > 1)
    return {
      error: `ambiguous fallback New session candidates visible=${fallbackVisible} totalFallback=${inputs.fallbackCandidates.length} roleVisible=${roleVisible}`,
    }
  return {
    error: `no visible New session candidate roleCount=${inputs.roleCandidates.length} fallbackCount=${inputs.fallbackCandidates.length} roleVisible=${roleVisible} fallbackVisible=${fallbackVisible}`,
  }
}

async function classifyNewSessionFrame(frame: Frame): Promise<Record<string, unknown>> {
  try {
    return await frame.evaluate(() => {
      const tabs = document.querySelectorAll(".am-tab-sortable[data-tab-id]").length
      const emptyEl = document.querySelector(".am-empty-state") as HTMLElement | null
      const emptyVisible = (() => {
        if (!emptyEl) return false
        const s = window.getComputedStyle(emptyEl)
        const r = emptyEl.getBoundingClientRect()
        return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0
      })()
      const tabBar = document.querySelector(".am-tab-bar:not(.am-tab-bar-empty)")
      const tabBarVisible = (() => {
        if (!tabBar) return false
        const s = window.getComputedStyle(tabBar as Element)
        const r = (tabBar as Element).getBoundingClientRect()
        return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0
      })()
      const tabBarEmpty = document.querySelector(".am-tab-bar-empty")
      const tabBarEmptyVisible = (() => {
        if (!tabBarEmpty) return false
        const s = window.getComputedStyle(tabBarEmpty as Element)
        const r = (tabBarEmpty as Element).getBoundingClientRect()
        return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0
      })()
      const bottomGated = !tabBarVisible && tabBarEmptyVisible
      return { tabCount: tabs, emptyVisible, tabBarVisible, tabBarEmptyVisible, bottomGated }
    })
  } catch (err) {
    void err
    return { tabCount: -1, emptyVisible: false, tabBarVisible: false, tabBarEmptyVisible: false, bottomGated: false }
  }
}

async function collectNewSessionCandidates(frame: Frame): Promise<{
  roleCount: number
  fallbackCount: number
  roleVisibleCount: number
  fallbackVisibleCount: number
  roleCandidates: Array<{ visible: boolean }>
  fallbackCandidates: Array<{ visible: boolean }>
}> {
  const roleLocator = frame.getByRole("button", { name: "New session", exact: true })
  const fallbackLocator = frame.locator('button[data-component="icon-button"][data-icon="plus"]')
  let roleCount = -1
  let fallbackCount = -1
  let roleVisibleCount = 0
  let fallbackVisibleCount = 0
  let roleCandidates: Array<{ visible: boolean }> = []
  let fallbackCandidates: Array<{ visible: boolean }> = []
  try {
    roleCount = await roleLocator.count()
    const handles = await roleLocator.all().catch(() => [])
    for (const h of handles) {
      const vis = await h.isVisible().catch(() => false)
      roleCandidates.push({ visible: vis })
      if (vis) roleVisibleCount++
    }
    if (roleCount === 0) roleCandidates = []
  } catch (err) {
    void err
    roleCount = -1
  }
  try {
    fallbackCount = await fallbackLocator.count()
    const fbHandles = await fallbackLocator.all().catch(() => [])
    for (const h of fbHandles) {
      const vis = await h.isVisible().catch(() => false)
      fallbackCandidates.push({ visible: vis })
      if (vis) fallbackVisibleCount++
    }
    if (fallbackCount === 0) fallbackCandidates = []
  } catch (err) {
    void err
    fallbackCount = -1
  }
  return { roleCount, fallbackCount, roleVisibleCount, fallbackVisibleCount, roleCandidates, fallbackCandidates }
}

/**
 * Bounded helper to click the real visible "New session" primary action.
 *
 * Each invocation re-acquires the current Agent Manager frame via
 * findAgentManagerFrameAny (positive AM identity, never first non-AM), then
 * observes visible candidates in that frame:
 *   - preferred: getByRole button named New session exact
 *   - fallback: icon-button plus scoped by the AM frame
 * Distinct from the dropdown trigger (More new-tab options) and the hidden
 * menu item (New Session). Fails closed when zero or multiple visible primary
 * candidates exist, emitting redacted diagnostics (counts/visibility/frame
 * detached + tab/empty classification) without leaking raw titles/session ids.
 */
export async function clickRealNewSessionAction(browser: Browser, timeoutMs: number): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  let lastDiag = ""
  let lastError = ""
  // Re-acquire the AM frame positively on every call (LOCK-LC-004)
  // redacted diagnostics keys: tabCount emptyVisible tabBarVisible tabBarEmptyVisible frameDetached roleCount roleVisibleCount fallbackCount fallbackVisibleCount
  let frame: Frame
  try {
    const initial = await findAgentManagerFrameAny(browser, Math.min(15_000, timeoutMs), { redacted: true })
    frame = initial.frame
  } catch (err) {
    void err
    lastError = "frame-lookup-failed"
    lastDiag = JSON.stringify({ frameLookup: lastError, timeoutMs })
    throw new Error(`probe: New session action not unique/visible within ${timeoutMs}ms: ${lastError} lastDiag=${lastDiag}`)
  }
  /**
   * Bounded helper — clicks the first visible handle for the picked candidate
   * (role vs fallback icon). Pure click attempt with no deadline math; deadline
   * and redaction are owned by the caller so the action stays strict-deadline
   * and fixed-category. Keeps the loop/visibility branch out of the main loop
   * to satisfy the eslint complexity cap.
   */
  const clickVisibleForPick = async (
    target: Frame,
    pick: NewSessionRoleFallback,
    clickTimeout: number,
    diag: string,
  ): Promise<{ clicked: boolean; error?: string }> => {
    if (pick === "role") {
      const loc = target.getByRole("button", { name: "New session", exact: true })
      const handles = await loc.all()
      for (const h of handles) {
        if (await h.isVisible().catch(() => false)) {
          await h.click({ timeout: clickTimeout })
          console.log(`[probe] clicked New session via role diag=${diag}`)
          return { clicked: true }
        }
      }
      return { clicked: false, error: `role pick but no visible handle found diag=${diag}` }
    }
    const loc = target.locator('button[data-component="icon-button"][data-icon="plus"]')
    const handles = await loc.all()
    for (const h of handles) {
      if (await h.isVisible().catch(() => false)) {
        await h.click({ timeout: clickTimeout })
        console.log(`[probe] clicked New session via fallback icon diag=${diag}`)
        return { clicked: true }
      }
    }
    return { clicked: false, error: `fallback pick but no visible handle found diag=${diag}` }
  }
  for (;;) {
    const remainingBefore = deadline - Date.now()
    if (remainingBefore <= 0) {
      throw new Error(`probe: New session action not unique/visible within ${timeoutMs}ms: ${lastError} lastDiag=${lastDiag}`)
    }
    let frameDetached = false
    try {
      frameDetached = frame.isDetached()
    } catch (err) {
      void err
      frameDetached = true
    }
    if (frameDetached) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(
          `probe: New session action failed: frame detached before click diag=${JSON.stringify({ frameDetached, timeoutMs, remainingMs: remaining })} lastDiag=${lastDiag} lastError=${lastError}`,
        )
      }
      try {
        const fresh = await findAgentManagerFrameAny(browser, Math.min(remaining, 15_000), { redacted: true })
        frame = fresh.frame
        lastError = "frame-detached-reacquired"
      } catch (err) {
        void err
        lastError = "frame-lookup-failed"
        if (Date.now() > deadline) {
          throw new Error(`probe: New session action not unique/visible within ${timeoutMs}ms: ${lastError} lastDiag=${lastDiag}`)
        }
      }
      const remainingAfter = deadline - Date.now()
      if (remainingAfter <= 0) {
        throw new Error(`probe: New session action not unique/visible within ${timeoutMs}ms: ${lastError} lastDiag=${lastDiag}`)
      }
      await sleep(Math.min(250, remainingAfter))
      continue
    }
    const classification = await classifyNewSessionFrame(frame)
    const cand = await collectNewSessionCandidates(frame)
    const decision = decideNewSessionCandidates({ roleCandidates: cand.roleCandidates, fallbackCandidates: cand.fallbackCandidates })
    const diagBase = {
      roleCount: cand.roleCount,
      roleVisibleCount: cand.roleVisibleCount,
      fallbackCount: cand.fallbackCount,
      fallbackVisibleCount: cand.fallbackVisibleCount,
      frameDetached,
      ...classification,
    }
    lastDiag = JSON.stringify(diagBase)
    if ("pick" in decision) {
      const remainingClick = deadline - Date.now()
      if (remainingClick <= 0) {
        lastError = "deadline-exceeded"
        throw new Error(`probe: New session action not unique/visible within ${timeoutMs}ms: ${lastError} lastDiag=${lastDiag}`)
      }
      const clickTimeout = Math.min(5_000, remainingClick)
      try {
        const clicked = await clickVisibleForPick(frame, decision.pick, clickTimeout, lastDiag)
        if (clicked.clicked) return frame
        if (clicked.error) lastError = clicked.error
      } catch (err) {
        void err
        lastError = `click-failed diag=${lastDiag}`
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          throw new Error(`probe: New session action not unique/visible within ${timeoutMs}ms: ${lastError} lastDiag=${lastDiag}`)
        }
        try {
          const fresh = await findAgentManagerFrameAny(browser, Math.min(remaining, 5_000), { redacted: true })
          frame = fresh.frame
        } catch (inner) {
          void inner
          lastError = "frame-lookup-failed"
        }
      }
    } else {
      lastError = `${decision.error} diag=${lastDiag}`
    }

    if (Date.now() > deadline) {
      throw new Error(`probe: New session action not unique/visible within ${timeoutMs}ms: ${lastError} lastDiag=${lastDiag}`)
    }
    const remainingAfter = deadline - Date.now()
    if (remainingAfter <= 0) {
      throw new Error(`probe: New session action not unique/visible within ${timeoutMs}ms: ${lastError} lastDiag=${lastDiag}`)
    }
    await sleep(Math.min(250, remainingAfter))
  }
}

export async function describeTargets(browser: Browser): Promise<string> {
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
