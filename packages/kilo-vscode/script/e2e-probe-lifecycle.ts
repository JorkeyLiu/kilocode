import { createHash } from "node:crypto"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Browser, Frame } from "@playwright/test"
import type { BackendSnapshot } from "../src/agent-manager/fixture-backend"
import { SCRIPTED, type ScriptedModelHandle } from "./e2e-scripted-model"
import { RESTART_ARTIFACT_CONTENT } from "./e2e-restart-seed"
import { isWrongPin, pinReport, pinnedReason, type PinExpectation } from "./e2e-pin"
import { assertRunOwnedLlmRequests } from "./e2e-llm-matrix"
import { isIsolatedDataRoot, validateGateEvidence } from "./e2e-canonical"
import {
  activeTabId,
  clickRealNewSessionAction,
  E2EPlan,
  findAgentManagerFrameAnyRedacted,
  headerTitle,
  pickAgent,
  pickVariant,
  realTabStates,
  selectLifecycleTab,
  sendWithRetry,
  sleep,
  snapshotClient,
  tabStates,
  waitForAgentOption,
  waitForFile,
  waitForLabel,
  waitForModelSelected,
  waitForRealSessionTabs,
} from "./e2e-probe-dom"

function fixtureHash(v: string): string {
  return createHash("sha256").update(v).digest("hex").slice(0, 16)
}

function orderHash(ids: string[]): string {
  return createHash("sha256").update(ids.join("|")).digest("hex").slice(0, 16)
}

function newNonce(): string {
  return createHash("sha256")
    .update(String(Date.now()) + Math.random().toString(36))
    .digest("hex")
    .slice(0, 12)
}

function writeNonceRequest(
  scratch: string,
  requestName: string,
  resultName: string,
  payload: Record<string, unknown>,
): string {
  const nonce = newNonce()
  const requestPath = join(scratch, requestName)
  const resultPath = join(scratch, resultName)
  rmSync(resultPath, { force: true })
  writeFileSync(requestPath, JSON.stringify({ ...payload, nonce }))
  return nonce
}



async function waitForHeaderTitle(frame: Frame, expected: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const title = await headerTitle(frame).catch(() => undefined)
    if (title === expected) return
    if (Date.now() > deadline) throw new Error(`probe: headerTitle ${title ?? "<none>"} != ${expected}`)
    await sleep(250)
  }
}

export const ALLOWED_URL_KIND = ["vscode-webview", "other"] as const
export type UrlKind = (typeof ALLOWED_URL_KIND)[number]
export const ALLOWED_PAGE_KIND = ["webview", "other"] as const
export type PageKind = (typeof ALLOWED_PAGE_KIND)[number]
export const ALLOWED_DATA_THEME = ["kilo-vscode", "other", ""] as const
export type DataThemeKind = (typeof ALLOWED_DATA_THEME)[number]
export const ALLOWED_BODY_CATEGORY = [
  "agent-manager",
  "kilo-chat",
  "kilo-welcome",
  "native-chat",
  "placeholder",
  "unknown",
] as const
export type BodyCategory = (typeof ALLOWED_BODY_CATEGORY)[number]

export function deriveUrlKind(url: string): UrlKind {
  return url.includes("vscode-webview") ? "vscode-webview" : "other"
}

export function derivePageKind(url: string): PageKind {
  return url.includes("vscode-webview") ? "webview" : "other"
}

export function deriveDataThemeKind(raw: string): DataThemeKind {
  if (raw === "kilo-vscode") return "kilo-vscode"
  if (raw === "") return ""
  return "other"
}


export function isFrameDetachedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : String(err)
  return msg.toLowerCase().includes("frame was detached")
}

export async function captureLcFrames(browser: Browser): Promise<unknown[]> {
  const out: unknown[] = []
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      for (const frame of page.frames()) {
        if (frame.isDetached()) continue
        const url = frame.url()
        if (!url) continue
        const urlHash = fixtureHash(url)
        const urlKind = deriveUrlKind(url)
        const pageKind = derivePageKind(url)
        let rawTheme = ""
        try {
          rawTheme = await frame.evaluate(() => document.documentElement.getAttribute("data-theme") ?? "")
        } catch (err) {
          if (isFrameDetachedError(err)) continue
          let detached = false
          try {
            detached = frame.isDetached()
          } catch (err) {
            void err
            if (isFrameDetachedError(err)) detached = true
          }
          if (detached) continue
          throw new Error(`lc timeline frame theme failed (redacted): ${String(err).slice(0, 80)}`)
        }
        const dataTheme = deriveDataThemeKind(rawTheme)
        let hasAm = false
        let hasKiloChat = false
        let hasPrompt = false
        let hasHeader = false
        let bodyClass = ""
        let bodyCategory: string = "unknown"
        let visible = false
        try {
          hasAm = (await frame.locator(".am-layout").count()) > 0
          hasKiloChat = (await frame.locator(".chat-view").count()) > 0
          hasPrompt = (await frame.locator("textarea.prompt-input").count()) > 0
          hasHeader = (await frame.locator('[data-slot="task-header-title-label"]').count()) > 0
          bodyClass = await frame.evaluate(() => document.body?.className?.slice(0, 80) ?? "")
          const cat = await frame.evaluate(() => {
            if (document.querySelector(".am-layout")) return "agent-manager"
            const theme = document.documentElement.getAttribute("data-theme")
            const chat = !!document.querySelector(".chat-view")
            const prompt = !!document.querySelector("textarea.prompt-input")
            if (theme === "kilo-vscode" && chat && prompt) {
              return document.querySelector('[data-slot="task-header-title-label"]') ? "kilo-chat" : "kilo-welcome"
            }
            if (chat && prompt) return "native-chat"
            if (document.body && document.body.innerText.trim().length < 20) return "placeholder"
            return "unknown"
          })
          bodyCategory = cat
          visible = await frame.evaluate(() => document.visibilityState === "visible")
        } catch (err) {
          if (isFrameDetachedError(err)) continue
          let detached = false
          try {
            detached = frame.isDetached()
          } catch (err) {
            void err
            if (isFrameDetachedError(err)) detached = true
          }
          if (detached) continue
          throw new Error(`lc timeline frame dom failed (redacted): ${String(err).slice(0, 80)}`)
        }
        out.push({
          urlHash,
          urlKind,
          pageKind,
          dataTheme,
          hasAm,
          hasKiloChat,
          hasPrompt,
          hasHeader,
          bodyClassHash: bodyClass ? fixtureHash(bodyClass) : "",
          bodyCategory,
          visible,
        })
      }
    }
  }
  return out
}

export async function captureLcLayoutTimeline(browser: Browser, scratch: string, phase: string): Promise<void> {
  const ts = Date.now()
  const iso = new Date(ts).toISOString()
  if (typeof phase !== "string" || phase.length === 0 || phase.length > 80) {
    throw new Error(`lc timeline phase invalid (redacted): ${String(phase).slice(0, 40)}`)
  }
  if (/GcLifecycle Title|GateC Title|e2e-fixture-key|KILO_SERVER_PASSWORD/.test(phase)) {
    throw new Error("lc timeline phase leaked raw (redacted)")
  }
  let auxiliaryBar: Record<string, unknown>
  let chat: Record<string, unknown>
  let editors: Record<string, unknown>
  try {
    let ab: Record<string, unknown> = { exists: false, visible: false, width: 0, height: 0, focusWithin: false }
    let ch: Record<string, unknown> = { exists: false, visible: false, inputVisible: false }
    let ed: Record<string, unknown> = { tabCount: 0, groupCount: 0, tabHashes: [] as string[] }
    let found = false
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        const top = await page.evaluate(() => {
          const abEl =
            document.querySelector(".part.auxiliarybar") ||
            document.querySelector(".auxiliarybar") ||
            document.querySelector('[id*="auxiliarybar"]')
          let abInfo: Record<string, unknown> = { exists: false }
          if (abEl) {
            const style = window.getComputedStyle(abEl as Element)
            const rect = (abEl as Element).getBoundingClientRect()
            const visible =
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0 &&
              style.opacity !== "0"
            abInfo = {
              exists: true,
              visible,
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              focusWithin: (abEl as Element).contains(document.activeElement),
            }
          }
          const chatEl =
            document.querySelector(".part.auxiliarybar .chat-view") || document.querySelector(".auxiliarybar textarea")
          const chatInput = document.querySelector(".part.auxiliarybar textarea, .auxiliarybar textarea")
          const chatInfo = {
            exists: !!chatEl,
            visible: (() => {
              if (!chatEl) return false
              const s = window.getComputedStyle(chatEl as Element)
              const r = (chatEl as Element).getBoundingClientRect()
              return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0
            })(),
            inputVisible: (() => {
              if (!chatInput) return false
              const s = window.getComputedStyle(chatInput as Element)
              const r = (chatInput as Element).getBoundingClientRect()
              return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0
            })(),
          }
          const tabs = document.querySelectorAll(".tabs-container .tab, .editor-group .tab")
          const groups = document.querySelectorAll(".editor-group, .tabs-container")
          const labels: string[] = []
          tabs.forEach((t) => {
            const txt = (t.textContent || "").trim().slice(0, 80)
            if (txt) labels.push(txt)
          })
          return { abInfo, chatInfo, tabCount: tabs.length, groupCount: groups.length, labels }
        })
        if (
          (top.abInfo as Record<string, unknown>).exists ||
          (top.chatInfo as Record<string, unknown>).exists ||
          top.tabCount > 0
        ) {
          ab = top.abInfo as Record<string, unknown>
          ch = top.chatInfo as Record<string, unknown>
          const hashes = (top.labels as string[]).map((l) => fixtureHash(l))
          ed = { tabCount: top.tabCount, groupCount: top.groupCount, tabHashes: hashes }
          found = true
          break
        }
        if (top.tabCount > 0 || (top.abInfo as Record<string, unknown>).exists) {
          ab = top.abInfo as Record<string, unknown>
          ch = top.chatInfo as Record<string, unknown>
          const hashes = (top.labels as string[]).map((l) => fixtureHash(l))
          ed = { tabCount: top.tabCount, groupCount: top.groupCount, tabHashes: hashes }
        }
      }
      if (found) break
    }
    auxiliaryBar = ab
    chat = ch
    editors = ed
  } catch (err) {
    throw new Error(`lc timeline auxiliary capture failed (redacted): ${String(err).slice(0, 120)}`)
  }
  let frames: unknown[]
  try {
    frames = await captureLcFrames(browser)
  } catch (err) {
    throw new Error(`lc timeline frame capture failed (redacted): ${String(err).slice(0, 120)}`)
  }
  const entry: Record<string, unknown> = { ts, iso, phase, auxiliaryBar, chat, editors, frames }
  const file = join(scratch, "lc-layout-timeline.json")
  let arr: unknown[] = []
  if (existsSync(file)) {
    let raw: string
    try {
      raw = readFileSync(file, "utf8")
    } catch (err) {
      throw new Error(`lc timeline read failed (redacted): ${String(err).slice(0, 120)}`)
    }
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error("not array")
      arr = parsed
    } catch (err) {
      throw new Error(`lc timeline existing malformed (redacted): ${String(err).slice(0, 120)}`)
    }
  }
  arr.push(entry)
  try {
    writeFileSync(file, JSON.stringify(arr, null, 2))
  } catch (err) {
    throw new Error(`lc timeline write failed (redacted): ${String(err).slice(0, 120)}`)
  }
}

async function requestPrivateStatus(
  scratch: string,
  timeoutMs = 30000,
): Promise<{
  nonce: string
  backend: { pid: number | null; port: number | null; epoch: number | null }
  private: {
    pid: number | null | undefined
    epoch: number | null
    available: boolean
    state: string
    protocol: { name: string; major: number; minor?: number } | null
    capabilities: string[]
    hasSessionUpdate: boolean
  }
}> {
  const nonce = writeNonceRequest(scratch, "lc-private-status-request", "lc-private-status.json", {})
  await waitForFile(join(scratch, "lc-private-status.json"), timeoutMs, "lc-private-status.json")
  const raw = readFileSync(join(scratch, "lc-private-status.json"), "utf8")
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn("[probe] malformed lc-private-status.json (redacted):", String(err).slice(0, 200))
    throw new Error("lc private-status malformed JSON")
  }
  if ((parsed as { nonce?: string }).nonce !== nonce) throw new Error("lc private-status nonce mismatch")
  return parsed as unknown as {
    nonce: string
    backend: { pid: number | null; port: number | null; epoch: number | null }
    private: {
      pid: number | null | undefined
      epoch: number | null
      available: boolean
      state: string
      protocol: { name: string; major: number; minor?: number } | null
      capabilities: string[]
      hasSessionUpdate: boolean
    }
  }
}


async function requestTitleUpdate(
  scratch: string,
  sessionId: string,
  title: string,
  timeoutMs = 30000,
): Promise<{
  nonce: string
  order: string[]
  sdk: { status: string; httpStatus: number | null; hasData: boolean }
  private: { status: string; hasData: boolean } | null
  parity: { divergence: string | null }
  redacted: {
    opIdHash: string
    idempotencyKeyHash: string
    requestIdHash: string
    titleHash: string
    sessionIdHash: string
  }
  revision: { session?: number; config?: number } | null
}> {
  const nonce = writeNonceRequest(scratch, "lc-title-request", "lc-title-result.json", { sessionId, title })
  await waitForFile(join(scratch, "lc-title-result.json"), timeoutMs, "lc-title-result.json")
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(join(scratch, "lc-title-result.json"), "utf8"))
  } catch (err) {
    console.warn("[probe] malformed lc-title-result.json (redacted):", String(err).slice(0, 200))
    throw new Error("lc title malformed")
  }
  if ((parsed as { nonce?: string }).nonce !== nonce) throw new Error("lc title nonce mismatch")
  if (JSON.stringify(parsed).includes(title)) throw new Error("lc title result leaked raw title")
  return parsed as unknown as {
    nonce: string
    order: string[]
    sdk: { status: string; httpStatus: number | null; hasData: boolean }
    private: { status: string; hasData: boolean } | null
    parity: { divergence: string | null }
    redacted: {
      opIdHash: string
      idempotencyKeyHash: string
      requestIdHash: string
      titleHash: string
      sessionIdHash: string
    }
    revision: { session?: number; config?: number } | null
  }
}

async function requestPrivateReplay(
  scratch: string,
  sessionId: string,
  timeoutMs = 30000,
): Promise<{
  nonce: string
  found: boolean
  private: { status: string; hasData: boolean } | null
  revision: { session?: number; config?: number } | null
  redacted?: {
    opIdHash: string
    idempotencyKeyHash: string
    requestIdHash: string
    titleHash: string
    sessionIdHash: string
  }
}> {
  const nonce = writeNonceRequest(scratch, "lc-replay-request", "lc-replay-result.json", { sessionId })
  await waitForFile(join(scratch, "lc-replay-result.json"), timeoutMs, "lc-replay-result.json")
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(join(scratch, "lc-replay-result.json"), "utf8"))
  } catch (err) {
    console.warn("[probe] malformed lc-replay-result.json (redacted):", String(err).slice(0, 200))
    throw new Error("lc replay malformed")
  }
  if ((parsed as { nonce?: string }).nonce !== nonce) throw new Error("lc replay nonce mismatch")
  return parsed as unknown as {
    nonce: string
    found: boolean
    private: { status: string; hasData: boolean } | null
    revision: { session?: number; config?: number } | null
    redacted?: {
      opIdHash: string
      idempotencyKeyHash: string
      requestIdHash: string
      titleHash: string
      sessionIdHash: string
    }
  }
}

/**
 * Deterministic settle barrier after SDK-authoritative title mutation.
 * Proves the existing AgentManagerProvider.settleSessionsForFixture refresh
 * has flushed (real backend session-list refresh, not synthetic injection).
 * Bounded wait — fails closed on marker timeout so a stalled refresh never
 * silently passes.
 */
async function requestLcSettle(scratch: string, timeoutMs = 30000): Promise<void> {
  writeFileSync(join(scratch, "lc-settle-request"), "ok")
  await waitForFile(join(scratch, "lc-settle-done"), timeoutMs, "lc-settle-done")
  rmSync(join(scratch, "lc-settle-done"), { force: true })
}

async function requestLcCanonicalState(scratch: string, timeoutMs = 30000): Promise<Record<string, unknown>> {
  writeFileSync(join(scratch, "lc-cstate-request"), "ok")
  await waitForFile(join(scratch, "lc-cstate.json"), timeoutMs, "lc-cstate.json")
  return JSON.parse(readFileSync(join(scratch, "lc-cstate.json"), "utf8")) as Record<string, unknown>
}

async function requestLcSeedCredential(scratch: string, timeoutMs = 30000): Promise<Record<string, unknown>> {
  const file = join(scratch, "lc-credential.json")
  rmSync(file, { force: true })
  writeFileSync(join(scratch, "lc-credseed-request"), "ok")
  await waitForFile(file, timeoutMs, "lc-credential.json")
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
}









export function lifecyclePin(plan: E2EPlan): PinExpectation {
  return {
    agent: plan.customAgent,
    provider: plan.customProvider,
    model: plan.customModel,
    variant: plan.customVariantA,
  }
}

export function lifecycleSessionReason(
  snap: BackendSnapshot,
  id: string,
  plan: E2EPlan,
  prompt: string,
): string | undefined {
  const s = snap.sessions.find((x) => x.id === id)
  if (!s) return `session ${id} missing from backend`
  const pin = pinnedReason(snap, id, lifecyclePin(plan), prompt)
  if (pin) return pin
  const msgs = snap.messages[id] ?? []
  const tool = msgs.flatMap((m) => m.tools ?? []).find((t) => t.tool === plan.realUserTool)
  if (!tool || tool.status !== "completed") return `session ${id} user tool ${plan.realUserTool} not completed`
  if (!msgs.some((m) => m.text.includes(SCRIPTED.restartFinal))) return `session ${id} transcript missing final text`
  if ((snap.statuses[id] ?? "idle") !== "idle") return `session ${id} status=${snap.statuses[id]} expected idle`
  return undefined
}

const LC_PROMPT = `${SCRIPTED.restartMarker}: call the user tool and wait for the result`
const LC_PROMPT_B = "E2E lifecycle sibling prompt: stay idle"

async function lifecyclePhase0(
  browser: Browser,
  plan: E2EPlan,
  scratch: string,
  workspace: string,
  snap: ReturnType<typeof snapshotClient>,
  model: ScriptedModelHandle,
): Promise<{ sessionId: string; siblingId: string; runnerPid: number; frame: Frame }> {
  const timeout = 30000
  await waitForFile(join(scratch, "canonical-gate.json"), 30000, "canonical gate before lifecycle")
  {
    const gateRaw = readFileSync(join(scratch, "canonical-gate.json"), "utf8")
    let gate: unknown
    try {
      gate = JSON.parse(gateRaw)
    } catch {
      throw new Error("probe: canonical gate malformed")
    }
    const err = validateGateEvidence(gate)
    if (err) throw new Error(`probe: canonical gate invalid: ${err}`)
    const dataRoot = (gate as Record<string, unknown>).dataRoot as string | undefined
    if (typeof dataRoot === "string" && !isIsolatedDataRoot(scratch, dataRoot))
      throw new Error(`probe: dataRoot not isolated`)
  }
  await waitForFile(join(scratch, "lc-ready"), 120000, "lc-ready")
  {
    const credFile = join(scratch, "lc-credential.json")
    await waitForFile(credFile, timeout, "lc-credential.json")
    const cred = JSON.parse(readFileSync(credFile, "utf8")) as Record<string, unknown>
    if (cred.ok !== true) throw new Error(`probe: lc credential failed ${JSON.stringify(cred)}`)
    const connected = (cred as { connected?: unknown }).connected
    if (!Array.isArray(connected) || !connected.includes(plan.customProvider))
      throw new Error(`probe: lc credential missing connected`)
    if ((cred as { defaultModel?: unknown }).defaultModel !== `${plan.customProvider}/${plan.customModel}`)
      throw new Error(`probe: lc credential wrong defaultModel`)
  }
  {
    const fresh = await requestLcSeedCredential(scratch, timeout)
    if (fresh.ok !== true) throw new Error(`probe: lc credential round-trip failed ${JSON.stringify(fresh)}`)
  }
  const found = await findAgentManagerFrameAnyRedacted(browser, 60000)
  const frame = found.frame
  const cstate = await requestLcCanonicalState(scratch, timeout)
  {
    const prov = (
      cstate as {
        providerIndex?: { connected?: unknown; entries?: Array<{ id: string; hasCredential: boolean }> } | null
      }
    ).providerIndex
    if (!prov || !Array.isArray(prov.connected) || !prov.connected.includes(plan.customProvider))
      throw new Error(`probe: lc canonical state missing connected`)
    const entry = prov.entries?.find((e) => e.id === plan.customProvider)
    if (!entry?.hasCredential) throw new Error(`probe: lc hasCredential false`)
    if ((cstate as { defaultModel?: unknown }).defaultModel !== `${plan.customProvider}/${plan.customModel}`)
      throw new Error(`probe: lc defaultModel wrong`)
    if ((cstate as { materializationReady?: unknown }).materializationReady !== true)
      throw new Error(`probe: lc not ready`)
  }
  await waitForAgentOption(frame, plan.customAgentLabel, timeout)
  await pickAgent(frame, plan.customAgentLabel, timeout)
  await waitForLabel(frame, ".mode-switcher-trigger-label", plan.customAgentLabel, timeout, "custom agent selected")
  await pickVariant(frame, plan.customVariantA, timeout)
  await waitForLabel(frame, ".thinking-selector-trigger-label", plan.customVariantA, timeout, "variant Low selected")
  await waitForModelSelected(frame, plan.customProvider, plan.customModel, timeout, "custom model selected")
  let snap0: BackendSnapshot
  try {
    snap0 = await sendWithRetry(
      frame,
      snap,
      LC_PROMPT,
      1,
      (s) => {
        if (s.sessions.length < 1) return "no backend session yet"
        const id = s.sessions[0]!.id
        return lifecycleSessionReason(s, id, plan, LC_PROMPT)
      },
      "lifecycle session completed",
      timeout,
      isWrongPin,
    )
  } finally {
    writeFileSync(join(scratch, "lc-model-requests.json"), JSON.stringify(model.requests, null, 2))
  }
  const sessionId = snap0.sessions[0]!.id
  // Second session via real visible New session UI action (re-acquires AM frame, never synthetic injection)
  let newSessionFrame = await clickRealNewSessionAction(browser, timeout)
  await pickAgent(newSessionFrame, plan.customAgentLabel, timeout)
  await waitForLabel(
    newSessionFrame,
    ".mode-switcher-trigger-label",
    plan.customAgentLabel,
    timeout,
    "sibling agent selected",
  )
  await pickVariant(newSessionFrame, plan.customVariantA, timeout)
  await waitForLabel(
    newSessionFrame,
    ".thinking-selector-trigger-label",
    plan.customVariantA,
    timeout,
    "sibling variant selected",
  )
  await waitForModelSelected(newSessionFrame, plan.customProvider, plan.customModel, timeout, "sibling model selected")
  const snap1 = await sendWithRetry(
    newSessionFrame,
    snap,
    LC_PROMPT_B,
    2,
    (s) => {
      if (s.sessions.length < 2) return `expected 2 sessions got ${s.sessions.length}`
      return undefined
    },
    "lifecycle sibling session created",
    timeout,
    isWrongPin,
  )
  const siblingId = snap1.sessions.find((x) => x.id !== sessionId)!.id
  const artifact = join(workspace, plan.realArtifact)
  await waitForFile(artifact, 60000, "artifact after lifecycle phase0")
  const art = readFileSync(artifact, "utf8")
  if (art !== RESTART_ARTIFACT_CONTENT) throw new Error(`lifecycle artifact mismatch ${JSON.stringify(art)}`)
  await waitForRealSessionTabs(newSessionFrame, 2, timeout, "lifecycle two tabs after sibling")
  const tabs = await realTabStates(newSessionFrame)
  const targetTab = tabs.find((t) => t.id === sessionId)
  if (!targetTab) throw new Error(`target tab not found ${sessionId}`)
  newSessionFrame = await selectLifecycleTab(browser, newSessionFrame, sessionId, 10000)
  assertRunOwnedLlmRequests(scratch, "real-lifecycle-phase0")
  return {
    sessionId,
    siblingId,
    runnerPid: Number(readFileSync(join(scratch, "runner-pid"), "utf8")),
    frame: newSessionFrame,
  }
}

function assertExactOrder(ids: string[], expectedSet: Set<string>, label: string): void {
  if (ids.length !== expectedSet.size)
    throw new Error(
      `${label} order count mismatch: got ${ids.length} expected ${expectedSet.size} ids=${ids.join(",")}`,
    )
  const uniq = new Set(ids)
  if (uniq.size !== ids.length) throw new Error(`${label} duplicate ids: ${ids.join(",")}`)
  for (const id of ids) if (!expectedSet.has(id)) throw new Error(`${label} unexpected id ${id} not in expected set`)
  for (const id of expectedSet) if (!ids.includes(id)) throw new Error(`${label} missing id ${id}`)
}

// eslint-disable-next-line complexity
export async function runGcLifecycleBoundaries(
  browser: Browser,
  plan: E2EPlan,
  scratch: string,
  workspace: string,
  model: ScriptedModelHandle,
): Promise<void> {
  const snap = snapshotClient(scratch, "lc-snap")
  await captureLcLayoutTimeline(browser, scratch, "lifecycle-start")
  try {
    const phase0 = await lifecyclePhase0(browser, plan, scratch, workspace, snap, model)

    const gcTitle = `GcLifecycle Title ${createHash("sha256").update(phase0.sessionId).digest("hex").slice(0, 6)}`
    let gcTitleRes: Awaited<ReturnType<typeof requestTitleUpdate>> | null = null
    let gcReplay: Awaited<ReturnType<typeof requestPrivateReplay>> | null = null

    let gcRevision: { session?: number; config?: number } | null = null
    {
      const titleRes = await requestTitleUpdate(scratch, phase0.sessionId, gcTitle)
      gcTitleRes = titleRes
      if (titleRes.order[0] !== "sdk" || titleRes.order[1] !== "private")
        throw new Error(`lc title order not sdk private`)
      if (titleRes.sdk.status !== "succeeded") throw new Error(`lc sdk failed`)
      if (!titleRes.private || titleRes.private.status !== "succeeded") throw new Error(`lc private failed`)
      if (titleRes.parity.divergence) throw new Error(`lc parity divergence`)
      if (titleRes.redacted.titleHash !== fixtureHash(gcTitle)) throw new Error(`lc title hash mismatch`)
      gcRevision = titleRes.revision
      await snap.waitFor(
        (s) => {
          const t = s.sessions.find((x) => x.id === phase0.sessionId)?.title
          if (t !== gcTitle) return `title ${t} != ${gcTitle}`
          return undefined
        },
        30000,
        "lc backend title persisted",
      )
      await requestLcSettle(scratch)
      const replay = await requestPrivateReplay(scratch, phase0.sessionId)
      gcReplay = replay
      if (!replay.found || !replay.private || replay.private.status !== "succeeded") throw new Error(`lc replay failed`)
      if (replay.redacted?.titleHash !== fixtureHash(gcTitle)) throw new Error(`lc replay title hash mismatch`)
      if (replay.redacted?.opIdHash !== titleRes.redacted.opIdHash) throw new Error(`lc replay opIdHash mismatch`)
      if (replay.redacted?.idempotencyKeyHash !== titleRes.redacted.idempotencyKeyHash)
        throw new Error(`lc replay idempotencyKeyHash mismatch`)
      if (replay.redacted?.requestIdHash !== titleRes.redacted.requestIdHash)
        throw new Error(`lc replay requestIdHash mismatch`)
      if (replay.redacted?.sessionIdHash !== titleRes.redacted.sessionIdHash)
        throw new Error(`lc replay sessionIdHash mismatch`)
      if (JSON.stringify(replay.revision) !== JSON.stringify(gcRevision)) throw new Error(`lc replay revision mismatch`)
      writeFileSync(join(scratch, "lc-gc-replay.json"), JSON.stringify(replay, null, 2))
      {
        let amFrame2 = (await findAgentManagerFrameAnyRedacted(browser, 30000)).frame
        const beforeActive = await activeTabId(amFrame2).catch(() => "")
        if (beforeActive === phase0.sessionId) {
          amFrame2 = await selectLifecycleTab(browser, amFrame2, phase0.siblingId, 10000)
          amFrame2 = await selectLifecycleTab(browser, amFrame2, phase0.sessionId, 10000)
        } else if (beforeActive === phase0.siblingId) {
          amFrame2 = await selectLifecycleTab(browser, amFrame2, phase0.sessionId, 10000)
        } else {
          amFrame2 = await selectLifecycleTab(browser, amFrame2, phase0.sessionId, 10000)
        }
        await waitForHeaderTitle(amFrame2, gcTitle, 10000)
      }
    }

    const expectedSet = new Set([phase0.sessionId, phase0.siblingId])
    const initialFrame = (await findAgentManagerFrameAnyRedacted(browser, 30000)).frame
    const initialStates = await tabStates(initialFrame)
    const initialIds = initialStates.map((t) => t.id)
    assertExactOrder(initialIds, expectedSet, "initial")
    const oh = orderHash(initialIds)
    const count = initialIds.length
    if (count !== expectedSet.size) throw new Error(`initial count mismatch`)

    async function observeSingleTitleRequired(): Promise<string> {
      const amFrame = (await findAgentManagerFrameAnyRedacted(browser, 30000)).frame
      const t = await headerTitle(amFrame)
      if (!t) throw new Error("agent title observation absent")
      return t
    }

    let panelPre: Awaited<ReturnType<typeof requestPrivateStatus>> | null = null
    let panelPost: Awaited<ReturnType<typeof requestPrivateStatus>> | null = null
    let panelTitle: string | null = null
    let panelOrderIds: string[] | null = null
    {
      let panelFrame: Frame = initialFrame
      try {
        if (panelFrame.isDetached()) {
          panelFrame = (await findAgentManagerFrameAnyRedacted(browser, 10000)).frame
        }
      } catch {
        panelFrame = (await findAgentManagerFrameAnyRedacted(browser, 10000)).frame
      }
      const activeBeforePanel = await activeTabId(panelFrame).catch(() => "")
      if (activeBeforePanel === phase0.sessionId) {
        panelFrame = await selectLifecycleTab(browser, panelFrame, phase0.siblingId, 10000)
        panelFrame = await selectLifecycleTab(browser, panelFrame, phase0.sessionId, 10000)
      } else if ((await activeTabId(panelFrame).catch(() => "")) !== phase0.sessionId) {
        panelFrame = await selectLifecycleTab(browser, panelFrame, phase0.sessionId, 10000)
      }
      const preSingle = await observeSingleTitleRequired()
      if (preSingle !== gcTitle) throw new Error(`panel pre title mismatch ${preSingle}`)
      await captureLcLayoutTimeline(browser, scratch, "pre-panel-close")
      panelPre = await requestPrivateStatus(scratch)
      writeFileSync(join(scratch, "lc-panel-close-request"), "ok")
      await captureLcLayoutTimeline(browser, scratch, "post-panel-close-request")
      await waitForFile(join(scratch, "lc-panel-close-ready"), 60000, "lc-panel-close-ready")
      await captureLcLayoutTimeline(browser, scratch, "post-panel-close-ready")
      const fresh = await findAgentManagerFrameAnyRedacted(browser, 60000)
      const freshFrame = fresh.frame
      await waitForRealSessionTabs(freshFrame, 2, 30000, "panel reopen tabs")
      await captureLcLayoutTimeline(browser, scratch, "post-panel-reopen-tabs")
      await snap.waitFor(
        (s) => {
          const t = s.sessions.find((x) => x.id === phase0.sessionId)?.title
          if (t !== gcTitle) return `after panel title ${t} != ${gcTitle}`
          return undefined
        },
        30000,
        "lc title after panel",
      )
      const states = await tabStates(freshFrame)
      const ids = states.map((t) => t.id)
      assertExactOrder(ids, expectedSet, "panel reopen")
      if (orderHash(ids) !== oh) throw new Error(`panel orderHash mismatch ${orderHash(ids)} vs ${oh}`)
      panelOrderIds = ids
      panelPost = await requestPrivateStatus(scratch)
      if (panelPost.backend.pid !== panelPre.backend.pid) throw new Error(`panel pid changed`)
      if (panelPost.backend.port !== panelPre.backend.port) throw new Error(`panel port changed`)
      if (panelPost.backend.epoch !== panelPre.backend.epoch) throw new Error(`panel epoch changed`)
      const postSingle = await observeSingleTitleRequired()
      await captureLcLayoutTimeline(browser, scratch, "post-panel-reopen")
      if (postSingle !== gcTitle) throw new Error(`panel post title mismatch ${postSingle}`)
      panelTitle = postSingle
    }

    let reloadPre: Awaited<ReturnType<typeof requestPrivateStatus>> | null = null
    let reloadPost: Awaited<ReturnType<typeof requestPrivateStatus>> | null = null
    let reloadTitle: string | null = null
    let reloadOrderIds: string[] | null = null
    {
      const preSingle = await observeSingleTitleRequired()
      if (preSingle !== gcTitle) throw new Error(`reload pre title mismatch`)
      await captureLcLayoutTimeline(browser, scratch, "pre-webview-reload")
      reloadPre = await requestPrivateStatus(scratch)
      const amFrame = (await findAgentManagerFrameAnyRedacted(browser, 30000)).frame
      await amFrame.evaluate(() => {
        ;(window as unknown as { __lcProbeMark?: string }).__lcProbeMark = "pre-reload"
      })
      writeFileSync(join(scratch, "lc-reload-request"), "ok")
      await captureLcLayoutTimeline(browser, scratch, "post-webview-reload-request")
      await waitForFile(join(scratch, "lc-reload-ready"), 60000, "lc-reload-ready")
      await captureLcLayoutTimeline(browser, scratch, "post-webview-reload-ready")
      const deadline = Date.now() + 60000
      let reloaded: Frame | null = null
      for (;;) {
        for (const ctx of browser.contexts()) {
          for (const page of ctx.pages()) {
            for (const frame of page.frames()) {
              if (!frame.url().includes("vscode-webview")) continue
              let fresh: boolean
              try {
                fresh = await frame.evaluate(() => {
                  const marked = (window as unknown as { __lcProbeMark?: string }).__lcProbeMark === "pre-reload"
                  return !marked && document.querySelector(".am-layout") !== null
                })
              } catch {
                throw new Error(`probe: reload fresh check failed (redacted)`)
              }
              if (fresh) {
                reloaded = frame
                break
              }
            }
            if (reloaded) break
          }
          if (reloaded) break
        }
        if (reloaded) break
        if (Date.now() > deadline) throw new Error("lc reloaded frame not found")
        await sleep(250)
      }
      await waitForRealSessionTabs(reloaded!, 2, 30000, "reload tabs")
      await snap.waitFor(
        (s) => {
          const t = s.sessions.find((x) => x.id === phase0.sessionId)?.title
          if (t !== gcTitle) return `after reload title ${t} != ${gcTitle}`
          return undefined
        },
        30000,
        "lc title after reload",
      )
      const states = await tabStates(reloaded!)
      const ids = states.map((t) => t.id)
      assertExactOrder(ids, expectedSet, "reload")
      if (orderHash(ids) !== oh) throw new Error(`reload orderHash mismatch`)
      reloadOrderIds = ids
      reloadPost = await requestPrivateStatus(scratch)
      if (reloadPost.backend.pid !== reloadPre.backend.pid) throw new Error(`reload pid changed`)
      if (reloadPost.backend.epoch !== reloadPre.backend.epoch) throw new Error(`reload epoch changed`)
      const postSingle = await observeSingleTitleRequired()
      await captureLcLayoutTimeline(browser, scratch, "post-webview-reload")
      if (postSingle !== gcTitle) throw new Error(`reload post title mismatch ${postSingle}`)
      reloadTitle = postSingle
    }

    let switchPre: Awaited<ReturnType<typeof requestPrivateStatus>> | null = null
    let switchMid: Awaited<ReturnType<typeof requestPrivateStatus>> | null = null
    let switchPost: Awaited<ReturnType<typeof requestPrivateStatus>> | null = null
    let switchTitlePre: string | null = null
    let switchTitleMid: string | null = null
    let switchTitlePost: string | null = null
    let switchOrderMid: string[] | null = null
    let switchOrderPost: string[] | null = null
    {
      const preSingle = await observeSingleTitleRequired()
      if (preSingle !== gcTitle) throw new Error(`switch pre title mismatch ${preSingle}`)
      await captureLcLayoutTimeline(browser, scratch, "pre-session-switch")
      switchTitlePre = preSingle
      switchPre = await requestPrivateStatus(scratch)
      let amFrame0 = (await findAgentManagerFrameAnyRedacted(browser, 30000)).frame
      amFrame0 = await selectLifecycleTab(browser, amFrame0, phase0.sessionId, 10000)
      let active = await activeTabId(amFrame0)
      if (active !== phase0.sessionId) throw new Error(`switch pre active not target ${active}`)
      const orderPreSwitch = (await tabStates(amFrame0)).map((t) => t.id)
      assertExactOrder(orderPreSwitch, expectedSet, "switch pre order")
      if (orderHash(orderPreSwitch) !== oh) throw new Error(`switch pre orderHash mismatch`)
      amFrame0 = await selectLifecycleTab(browser, amFrame0, phase0.siblingId, 10000)
      active = await activeTabId(amFrame0)
      if (active !== phase0.siblingId) throw new Error(`switch to sibling failed ${active}`)
      const orderMid = (await tabStates(amFrame0)).map((t) => t.id)
      assertExactOrder(orderMid, expectedSet, "switch mid order")
      if (orderHash(orderMid) !== oh) throw new Error(`switch mid orderHash mismatch`)
      switchOrderMid = orderMid
      switchMid = await requestPrivateStatus(scratch)
      await captureLcLayoutTimeline(browser, scratch, "switched-session")
      const midSingle = await observeSingleTitleRequired()
      switchTitleMid = midSingle
      if (midSingle === gcTitle) throw new Error(`switch mid title must be sibling title, got durable target title`)
      if (!midSingle || midSingle.length === 0) throw new Error(`switch mid title absent`)
      amFrame0 = await selectLifecycleTab(browser, amFrame0, phase0.sessionId, 10000)
      active = await activeTabId(amFrame0)
      if (active !== phase0.sessionId) throw new Error(`switch back failed ${active}`)
      const orderPost = (await tabStates(amFrame0)).map((t) => t.id)
      assertExactOrder(orderPost, expectedSet, "switch post order")
      if (orderHash(orderPost) !== oh) throw new Error(`switch post orderHash mismatch`)
      switchOrderPost = orderPost
      switchPost = await requestPrivateStatus(scratch)
      await captureLcLayoutTimeline(browser, scratch, "post-session-switch")
      const postSingle = await observeSingleTitleRequired()
      if (postSingle !== gcTitle) throw new Error(`switch post title mismatch`)
      switchTitlePost = postSingle
      if (switchMid.backend.pid !== switchPre.backend.pid) throw new Error(`switch mid pid changed`)
      if (switchPost.backend.pid !== switchPre.backend.pid) throw new Error(`switch post pid changed`)
      const capsPre = switchPre.private.capabilities.slice().sort().join(",")
      const capsMid = switchMid.private.capabilities.slice().sort().join(",")
      const capsPost = switchPost.private.capabilities.slice().sort().join(",")
      if (capsMid !== capsPre) throw new Error(`switch mid capabilities mismatch`)
      if (capsPost !== capsPre) throw new Error(`switch post capabilities mismatch`)
    }

    const finalReplay = await requestPrivateReplay(scratch, phase0.sessionId)
    if (!finalReplay.found || !finalReplay.private || finalReplay.private.status !== "succeeded")
      throw new Error(`final replay failed`)
    if (finalReplay.redacted?.opIdHash !== gcTitleRes!.redacted.opIdHash)
      throw new Error(`final replay opIdHash mismatch`)
    if (finalReplay.redacted?.idempotencyKeyHash !== gcTitleRes!.redacted.idempotencyKeyHash)
      throw new Error(`final replay idempotencyKeyHash mismatch`)
    if (finalReplay.redacted?.requestIdHash !== gcTitleRes!.redacted.requestIdHash)
      throw new Error(`final replay requestIdHash mismatch`)
    if (finalReplay.redacted?.titleHash !== gcTitleRes!.redacted.titleHash)
      throw new Error(`final replay titleHash mismatch`)
    if (finalReplay.redacted?.sessionIdHash !== gcTitleRes!.redacted.sessionIdHash)
      throw new Error(`final replay sessionIdHash mismatch`)
    if (JSON.stringify(finalReplay.revision) !== JSON.stringify(gcRevision))
      throw new Error(`final replay revision mismatch`)

    await snap.waitFor(
      (s) => {
        const t = s.sessions.find((x) => x.id === phase0.sessionId)?.title
        if (t !== gcTitle) return `final title ${t} != ${gcTitle}`
        return undefined
      },
      30000,
      "lc final title",
    )

    {
      const markerRaw = readFileSync(join(scratch, "e2e-marker.json"), "utf8")
      if (markerRaw.length > 2048) throw new Error("marker too large")
      const markerParsed = JSON.parse(markerRaw) as Record<string, unknown>
      if (markerParsed.v !== 1) throw new Error("marker v must be 1")
      const fid = markerParsed.fixtureId
      if (typeof fid !== "string" || fid.length === 0) throw new Error("marker fixtureId missing")
      const envFid = process.env.KILO_E2E_FIXTURE_ID
      if (typeof envFid !== "string" || envFid.length === 0) throw new Error("env fid missing")
      if (fid !== envFid) throw new Error("fid mismatch")
      const { lstatSync, realpathSync } = await import("node:fs")
      const markerPath = join(scratch, "e2e-marker.json")
      const scratchStat = lstatSync(scratch)
      if (!scratchStat.isDirectory() || scratchStat.isSymbolicLink()) throw new Error("scratch symlink")
      const markerStat = lstatSync(markerPath)
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error("marker symlink")
      const realScratch = realpathSync(scratch)
      const realMarker = realpathSync(markerPath)
      const { relative } = await import("node:path")
      const rel = relative(realScratch, realMarker)
      if (rel !== "e2e-marker.json") throw new Error("marker not inside")
      const fixtureIdForHash = fixtureHash(fid)
      const canon = (
        p: { name: string; major: number; minor?: number } | null | undefined,
      ): { name: string; major: number; minor: number } | null =>
        p ? { name: p.name, major: p.major, minor: p.minor ?? 0 } : null
      const buildPriv = (p: Awaited<ReturnType<typeof requestPrivateStatus>>) => ({
        pid: p.private.pid ?? null,
        epoch: p.private.epoch,
        available: p.private.available,
        hasSessionUpdate: p.private.hasSessionUpdate,
        state: p.private.state,
        protocol: canon(p.private.protocol),
        capabilities: p.private.capabilities,
      })
      const proofOrderHash = oh
      const siblingTitleHashObserved = fixtureHash(switchTitleMid!)
      const gcPre = panelPre
      const proof = {
        schema: "kilo-gc-lifecycle-proof/2",
        version: 2,
        scope: "real-lifecycle Gate C: Agent Manager lifecycle with stable identity and same-key replay",
        fixtureIdHash: fixtureIdForHash,
        sessionIdHash: fixtureHash(phase0.sessionId),
        siblingIdHash: fixtureHash(phase0.siblingId),
        titleHash: fixtureHash(gcTitle),
        siblingTitleHash: siblingTitleHashObserved,
        orderHash: proofOrderHash,
        pre: {
          backend: { pid: panelPre!.backend.pid, port: panelPre!.backend.port, epoch: panelPre!.backend.epoch },
          private: buildPriv(panelPre!),
        },
        titleOp: {
          opIdHash: gcTitleRes!.redacted.opIdHash,
          idempotencyKeyHash: gcTitleRes!.redacted.idempotencyKeyHash,
          requestIdHash: gcTitleRes!.redacted.requestIdHash,
          sessionIdHash: gcTitleRes!.redacted.sessionIdHash,
          titleHash: gcTitleRes!.redacted.titleHash,
          order: gcTitleRes!.order,
          sdk: {
            status: gcTitleRes!.sdk.status,
            httpStatus: gcTitleRes!.sdk.httpStatus,
            hasData: gcTitleRes!.sdk.hasData,
          },
          private: { status: gcTitleRes!.private!.status, hasData: gcTitleRes!.private!.hasData },
          parity: gcTitleRes!.parity,
          revision: gcTitleRes!.revision,
        },
        replay: {
          found: gcReplay!.found,
          private: gcReplay!.private,
          revision: gcReplay!.revision,
          titleHash: gcReplay!.redacted?.titleHash,
          opIdHash: gcReplay!.redacted?.opIdHash,
          idempotencyKeyHash: gcReplay!.redacted?.idempotencyKeyHash,
          requestIdHash: gcReplay!.redacted?.requestIdHash,
          sessionIdHash: gcReplay!.redacted?.sessionIdHash,
        },
        boundaries: {
          panelCloseReopen: {
            pre: { backend: panelPre!.backend, private: buildPriv(panelPre!) },
            post: { backend: panelPost!.backend, private: buildPriv(panelPost!) },
            orderHash: orderHash(panelOrderIds!),
            orderCount: count,
            titleHash: fixtureHash(panelTitle!),
          },
          webviewReload: {
            pre: { backend: reloadPre!.backend, private: buildPriv(reloadPre!) },
            post: { backend: reloadPost!.backend, private: buildPriv(reloadPost!) },
            orderHash: orderHash(reloadOrderIds!),
            orderCount: count,
            titleHash: fixtureHash(reloadTitle!),
          },
          sessionSwitch: {
            pre: {
              backend: switchPre!.backend,
              private: buildPriv(switchPre!),
              activeIdHash: fixtureHash(phase0.sessionId),
              titleHash: fixtureHash(switchTitlePre!),
            },
            switched: {
              backend: switchMid!.backend,
              private: buildPriv(switchMid!),
              activeIdHash: fixtureHash(phase0.siblingId),
              titleHash: fixtureHash(switchTitleMid!),
            },
            post: {
              backend: switchPost!.backend,
              private: buildPriv(switchPost!),
              activeIdHash: fixtureHash(phase0.sessionId),
              titleHash: fixtureHash(switchTitlePost!),
            },
            orderHash: orderHash(switchOrderPost!),
            orderCount: count,
          },
        },
        finalReplay: {
          found: finalReplay.found,
          private: finalReplay.private,
          revision: finalReplay.revision,
          titleHash: finalReplay.redacted?.titleHash,
          opIdHash: finalReplay.redacted?.opIdHash,
          idempotencyKeyHash: finalReplay.redacted?.idempotencyKeyHash,
          requestIdHash: finalReplay.redacted?.requestIdHash,
          sessionIdHash: finalReplay.redacted?.sessionIdHash,
        },
        parity: gcTitleRes!.parity,
        collectedAt: new Date().toISOString(),
      }
      void switchOrderMid
      void gcPre
      await captureLcLayoutTimeline(browser, scratch, "pre-proof-write")
      const proofRaw = JSON.stringify(proof, null, 2)
      if (proofRaw.includes(gcTitle)) throw new Error("lc proof leaked raw title")
      writeFileSync(join(scratch, "lc-gc-proof.json"), proofRaw)
      console.log(`[probe] wrote lc-gc-proof.json`)
      await captureLcLayoutTimeline(browser, scratch, "final-done")
    }

    await captureLcLayoutTimeline(browser, scratch, "final-done-outer")
    const finalSnap = await snap.request()
    const pinEvidence = pinReport(finalSnap, phase0.sessionId, lifecyclePin(plan), LC_PROMPT)
    assertRunOwnedLlmRequests(scratch, "real-lifecycle-final")
    writeFileSync(
      join(scratch, "lc-dom-evidence"),
      JSON.stringify(
        {
          sessionIdHash: fixtureHash(phase0.sessionId),
          siblingIdHash: fixtureHash(phase0.siblingId),
          pin: pinEvidence,
          orderHash: oh,
          titleHash: fixtureHash(gcTitle),
        },
        null,
        2,
      ),
    )
    console.log("[probe] real-lifecycle lifecycle passed")
  } catch (err) {
    await captureLcLayoutTimeline(browser, scratch, "failure-diagnostics")
    throw err
  }
}
