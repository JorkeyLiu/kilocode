/**
 * R9 private observation focused probe — Extension Host evidence for the five
 * lifecycle boundaries against the private observation surface.
 *
 * Bounded, additive, fixture-gated (KILO_E2E_FIXTURE only) and reuses the
 * existing exact-PID/file-marker/evidence-handoff harness:
 *   panel close/reopen, reload (webview), session switch, transport reconnect,
 *   worker restart.
 *
 * Each boundary is driven via a scratch marker request (`r9-*-request`) and
 * answered by the runner's `serviceR9ObservationBoundary` with a JSON file
 * (`r9-*.json`) containing before/after PID, host state, snapshot/read/ack
 * cursor, rehydrate, duplicate/continuity assertions. The final aggregation
 * is `r9-observation-runtime-evidence` (required) plus `r9-dom-evidence`
 * and canonical gate artifacts.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Browser, Frame } from "@playwright/test"
import type { E2EPlan } from "./e2e-probe-dom"
import { assertNoWorktree, findAgentManagerFrameAny, sleep, waitForFile, tabStates, sidebarTopicStates } from "./e2e-probe-dom"
import { canonicalDbPath, isIsolatedDataRoot, validateGateEvidence } from "./e2e-canonical"

export interface R9BoundaryEvidence {
  boundary: string
  before: { pid?: number; hostState: string; cursor: number; rehydrate?: boolean }
  after: { pid?: number; hostState: string; cursor: number; rehydrate?: boolean }
  duplicate: boolean
  continuity: boolean
  rehydrate: boolean
  notes: string[]
  beforeEntriesCount?: number
  afterEntriesCount?: number
  subscribe?: unknown
  trigger?: unknown
  kill?: unknown
  actionResult?: unknown
  switch?: unknown
  switchConfirmation?: unknown
  // Fixture-only bounded notification recorder evidence (JSON-safe envelopes)
  notifications?: { before: unknown[]; after: unknown[] }
  notificationsBefore?: unknown[]
  notificationsAfter?: unknown[]
}

export interface R9RuntimeEvidence {
  scenario: string
  collectedAt: string
  pid: number
  canonical: { dbPath: string; dataRoot?: string; isolateOk?: boolean; gateOk: boolean }
  testBridge: boolean
  boundaries: R9BoundaryEvidence[]
  finalDom: unknown
}

const EXPECTED_BOUNDARIES = ["panel", "reload", "switch", "reconnect", "restart"] as const

function validateSubscribe(sub: unknown): string | undefined {
  if (sub === null || typeof sub !== "object" || Array.isArray(sub)) return "subscribe must be object"
  const o = sub as Record<string, unknown>
  if (o.v !== "1.0") return `subscribe v must be 1.0, got ${String(o.v)}`
  if (typeof o.cursor !== "number" || !Number.isInteger(o.cursor) || o.cursor < 0) return `subscribe cursor must be integer >=0, got ${String(o.cursor)}`
  if (o.subscribed !== true) return `subscribe subscribed must be true, got ${String(o.subscribed)}`
  return undefined
}

function extractNotificationSeqs(list: unknown[]): number[] {
  const seqs: number[] = []
  for (const item of list) {
    if (item && typeof item === "object") {
      const r = item as Record<string, unknown>
      // envelope shape { method, params: { v, cursor, entries: [{seq}] }, at }
      const params = r.params as Record<string, unknown> | undefined
      const entries = params?.entries as unknown[] | undefined
      if (Array.isArray(entries)) {
        for (const e of entries) {
          if (e && typeof e === "object" && typeof (e as Record<string, unknown>).seq === "number") {
            seqs.push((e as Record<string, unknown>).seq as number)
          }
        }
      }
      // also catch direct {seq}
      if (typeof r.seq === "number") seqs.push(r.seq)
    }
  }
  return seqs
}

function isValidIntegerCursor(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v)
}

// eslint-disable-next-line complexity
function validateNotificationEnvelope(item: unknown): string | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return "notification must be object"
  const r = item as Record<string, unknown>
  if (r.method !== "observation/changed") return `notification method must be observation/changed, got ${String(r.method)}`
  const params = r.params as Record<string, unknown> | undefined
  if (!params || typeof params !== "object" || Array.isArray(params)) return "notification params must be object"
  if (params.v !== "1.0") return `notification params v must be 1.0, got ${String(params.v)}`
  if (!isValidIntegerCursor(params.cursor)) return `notification params cursor must be integer >=0, got ${String(params.cursor)}`
  const entries = params.entries as unknown
  if (!Array.isArray(entries) || entries.length === 0) return "notification params entries must be non-empty array"
  for (const e of entries) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return "notification entry must be object"
    const entry = e as Record<string, unknown>
    if (!isValidIntegerCursor(entry.seq)) return `notification entry seq must be integer >=0, got ${String(entry.seq)}`
    if (typeof entry.session_id !== "string" || entry.session_id.length === 0) return `notification entry session_id must be non-empty string, got ${String(entry.session_id)}`
    if (typeof entry.revision !== "number" || !Number.isInteger(entry.revision) || entry.revision < 0) return `notification entry revision must be integer >=0, got ${String(entry.revision)}`
    if (entry.kind !== "changed" && entry.kind !== "deleted" && entry.kind !== "generation") return `notification entry kind must be changed or deleted or generation, got ${String(entry.kind)}`
    if (typeof entry.time !== "number" || !Number.isFinite(entry.time)) return `notification entry time must be finite number, got ${String(entry.time)}`
  }
  // params.cursor should equal max seq for continuity
  const maxSeq = Math.max(...(entries as Array<Record<string, unknown>>).map((e) => e.seq as number))
  if (params.cursor !== maxSeq) return `notification params cursor ${String(params.cursor)} must equal max entry seq ${String(maxSeq)}`
  return undefined
}

function validateNotificationLogStrict(list: unknown[], label: string): string | undefined {
  for (let i = 0; i < list.length; i++) {
    const err = validateNotificationEnvelope(list[i])
    if (err) return `${label}[${i}] invalid: ${err}`
  }
  return undefined
}

function deriveSeqContinuity(beforeSeqs: number[], afterSeqs: number[]): string | undefined {
  if (afterSeqs.length === 0) return "after notification seqs empty — no valid changed delivery"
  // within after, must be strictly increasing by 1, no gaps, no duplicates
  const seen = new Set<number>()
  for (let i = 0; i < afterSeqs.length; i++) {
    const s = afterSeqs[i]!
    if (seen.has(s)) return `duplicate seq ${s} within after log`
    seen.add(s)
    if (i > 0) {
      const prev = afterSeqs[i - 1]!
      if (s !== prev + 1) return `gap in after seqs: ${prev} -> ${s} (expected ${prev + 1})`
    }
  }
  if (beforeSeqs.length > 0) {
    const maxBefore = Math.max(...beforeSeqs)
    const minAfter = Math.min(...afterSeqs)
    if (minAfter <= maxBefore) return `after seq ${minAfter} not greater than before max ${maxBefore}`
    if (minAfter !== maxBefore + 1) return `gap across boundary: before max ${maxBefore} -> after min ${minAfter} (expected ${maxBefore + 1})`
  }
  return undefined
}

function validateCommon(ev: R9BoundaryEvidence): string | undefined {
  if (!ev.boundary) return "missing boundary name"
  if (ev.before.hostState !== "open" && ev.before.hostState !== "closed") return `before hostState invalid: ${ev.before.hostState}`
  if (ev.after.hostState !== "open") return `after hostState must be open, got ${ev.after.hostState}`
  if (typeof ev.before.cursor !== "number" || typeof ev.after.cursor !== "number") return "cursor must be number"
  if (typeof ev.before.pid !== "number") return `before pid must be number, got ${String(ev.before.pid)}`
  if (typeof ev.after.pid !== "number") return `after pid must be number, got ${String(ev.after.pid)}`
  if (ev.duplicate) return "duplicate notification detected"
  if (!ev.continuity) return "continuity failed"
  if (typeof ev.rehydrate !== "boolean") return "rehydrate must be boolean"
  if (ev.boundary === "restart" && ev.rehydrate !== true) return "restart boundary must have rehydrate:true"
  if (ev.boundary === "restart" && ev.before.pid === ev.after.pid) return "restart pid must change"
  return undefined
}

// eslint-disable-next-line complexity
function validateReconnect(ev: R9BoundaryEvidence): string | undefined {
  if (!ev.trigger || typeof ev.trigger !== "object" || Array.isArray(ev.trigger)) return "reconnect missing trigger evidence"
  const trig = ev.trigger as Record<string, unknown>
  const reason = (trig.reason as string | undefined) ?? ((trig.trigger as Record<string, unknown> | undefined)?.reason as string | undefined)
  if (typeof reason !== "string" || !reason.includes("peer:closed")) {
    return `reconnect trigger reason must contain peer:closed, got ${String(reason)}`
  }
  if (ev.before.hostState !== "open") return `reconnect before hostState must be open, got ${ev.before.hostState}`
  if (ev.after.hostState !== "open") return `reconnect after hostState must be open, got ${ev.after.hostState}`
  const notif = ev.notifications ?? (ev.notificationsBefore && ev.notificationsAfter ? { before: ev.notificationsBefore, after: ev.notificationsAfter } : undefined)
  if (!notif || !Array.isArray(notif.before) || !Array.isArray(notif.after)) {
    return "reconnect missing notification sequence evidence (before/after notification logs required)"
  }
  // Strict envelope validation — only v1.0 observation/changed with valid entries counts for continuity
  const beforeStrict = validateNotificationLogStrict(notif.before, "reconnect before notifications")
  if (beforeStrict) return beforeStrict
  const afterStrict = validateNotificationLogStrict(notif.after, "reconnect after notifications")
  if (afterStrict) return afterStrict
  // After must contain a valid changed delivery — empty after fails unless explicit no-change contract (not used here)
  if (notif.after.length === 0) return "reconnect after notifications empty — valid changed delivery required"
  const beforeSeqsArr = extractNotificationSeqs(notif.before)
  const afterSeqsArr = extractNotificationSeqs(notif.after)
  const beforeSeqs = new Set(beforeSeqsArr)
  for (const s of afterSeqsArr) if (beforeSeqs.has(s)) return `reconnect duplicate notification seq ${s} found in after log`
  // Derive continuity from observed sequence IDs, detect gaps; keep cursor monotonicity as separate field
  const gapErr = deriveSeqContinuity(beforeSeqsArr, afterSeqsArr)
  if (gapErr) return `reconnect seq continuity failed: ${gapErr}`
  if (ev.after.cursor < ev.before.cursor) return "reconnect cursor monotonicity failed: after cursor regressed"
  // No valid changed delivery with seq progression must not pass
  if (afterSeqsArr.length === 0) return "reconnect missing valid changed delivery for continuity"
  return undefined
}

// eslint-disable-next-line complexity
function validateRestart(ev: R9BoundaryEvidence): string | undefined {
  if (!ev.kill || typeof ev.kill !== "object" || Array.isArray(ev.kill)) return "restart missing exact-kill evidence"
  const kill = ev.kill as Record<string, unknown>
  const beforePid = kill.beforePid as number | undefined
  const afterObj = (kill.after as Record<string, unknown> | undefined) ?? kill
  const afterPid = afterObj.pid as number | undefined
  const pendingAlive = afterObj.pendingAlive as boolean | undefined
  if (typeof beforePid !== "number") return `restart kill beforePid must be number, got ${String(beforePid)}`
  if (typeof afterPid !== "number") return `restart kill after pid must be number, got ${String(afterPid)}`
  if (beforePid === afterPid) return `restart kill pid must change before ${beforePid} after ${afterPid}`
  if (pendingAlive !== false) return `restart kill pendingAlive must be false, got ${String(pendingAlive)}`
  if (ev.after.hostState !== "open") return `restart after hostState must be open, got ${ev.after.hostState}`
  const notif = ev.notifications ?? (ev.notificationsBefore && ev.notificationsAfter ? { before: ev.notificationsBefore, after: ev.notificationsAfter } : undefined)
  if (!notif || !Array.isArray(notif.before) || !Array.isArray(notif.after)) {
    return "restart missing notification sequence evidence (before/after notification logs required)"
  }
  const beforeStrict = validateNotificationLogStrict(notif.before, "restart before notifications")
  if (beforeStrict) return beforeStrict
  const afterStrict = validateNotificationLogStrict(notif.after, "restart after notifications")
  if (afterStrict) return afterStrict
  if (notif.after.length === 0) return "restart after notifications empty — valid changed delivery required"
  const beforeSeqsArr = extractNotificationSeqs(notif.before)
  const afterSeqsArr = extractNotificationSeqs(notif.after)
  const beforeSeqs = new Set(beforeSeqsArr)
  for (const s of afterSeqsArr) if (beforeSeqs.has(s)) return `restart duplicate notification seq ${s} found in after log`
  const gapErr = deriveSeqContinuity(beforeSeqsArr, afterSeqsArr)
  if (gapErr) return `restart seq continuity failed: ${gapErr}`
  if (ev.after.cursor < ev.before.cursor) return "restart cursor monotonicity failed: after cursor regressed"
  if (ev.rehydrate !== true) return "restart requires rehydrate:true with genuine gap"
  if (afterSeqsArr.length === 0) return "restart missing valid changed delivery for continuity"
  return undefined
}

// eslint-disable-next-line complexity
function validateGenericNotifications(ev: R9BoundaryEvidence): string | undefined {
  const notifRaw =
    ev.notifications ??
    (ev.notificationsBefore !== undefined && ev.notificationsAfter !== undefined ? { before: ev.notificationsBefore, after: ev.notificationsAfter } : undefined)
  if (notifRaw === undefined) return undefined
  if (!notifRaw || typeof notifRaw !== "object" || Array.isArray(notifRaw)) return "notifications must be object with before/after"
  const n = notifRaw as { before?: unknown; after?: unknown }
  if (!Array.isArray(n.before) || !Array.isArray(n.after)) return "notifications before/after must be arrays"
  const beforeStrict = validateNotificationLogStrict(n.before, `${ev.boundary} before notifications`)
  if (beforeStrict) return beforeStrict
  if ((n.after as unknown[]).length > 0) {
    const afterStrict = validateNotificationLogStrict(n.after, `${ev.boundary} after notifications`)
    if (afterStrict) return afterStrict
  }
  const beforeSeqs = extractNotificationSeqs(n.before)
  const afterSeqs = extractNotificationSeqs(n.after as unknown[])
  const beforeSet = new Set(beforeSeqs)
  for (const s of afterSeqs) if (beforeSet.has(s)) return `${ev.boundary} duplicate notification seq ${s} found in after log`
  const seen = new Set<number>()
  for (let i = 0; i < afterSeqs.length; i++) {
    const s = afterSeqs[i]!
    if (seen.has(s)) return `${ev.boundary} duplicate seq ${s} within after log`
    seen.add(s)
    if (i > 0 && s !== afterSeqs[i - 1]! + 1) return `${ev.boundary} gap in after seqs: ${afterSeqs[i - 1]} -> ${s} (expected ${(afterSeqs[i - 1]! + 1)})`
  }
  if (beforeSeqs.length > 0 && afterSeqs.length > 0) {
    const maxBefore = Math.max(...beforeSeqs)
    const minAfter = Math.min(...afterSeqs)
    if (minAfter <= maxBefore) return `${ev.boundary} after seq ${minAfter} not greater than before max ${maxBefore}`
    if (minAfter !== maxBefore + 1) return `${ev.boundary} gap across boundary: before max ${maxBefore} -> after min ${minAfter} (expected ${maxBefore + 1})`
  }
  return undefined
}

function validateSwitch(ev: R9BoundaryEvidence): string | undefined {
  const fromAction = (ev.actionResult as Record<string, unknown> | undefined)?.switchConfirmation
  const fromTop = (ev as unknown as Record<string, unknown>).switchConfirmation ?? (ev as unknown as Record<string, unknown>).switch
  const confirmation = (fromAction ?? fromTop) as Record<string, unknown> | undefined
  if (!confirmation || typeof confirmation !== "object" || Array.isArray(confirmation)) {
    return "switch missing click confirmation (switchConfirmation with clickedTabId required)"
  }
  const clicked = confirmation.clickedTabId
  if (typeof clicked !== "string" || clicked.length === 0) return "switch confirmation clickedTabId must be non-empty string"
  const active = confirmation.activeTabId ?? confirmation.selectedTabId
  if (active !== undefined && typeof active !== "string") return "switch confirmation activeTabId must be string"
  return undefined
}

export function validateR9Boundary(ev: R9BoundaryEvidence): string | undefined {
  const common = validateCommon(ev)
  if (common) return common
  const gen = validateGenericNotifications(ev)
  if (gen) return gen
  if (ev.boundary === "switch") {
    const err = validateSwitch(ev)
    if (err) return err
  }
  if (ev.boundary === "reconnect") {
    const err = validateReconnect(ev)
    if (err) return err
  }
  if (ev.boundary === "restart") {
    const err = validateRestart(ev)
    if (err) return err
  }
  if (ev.subscribe !== undefined) {
    const err = validateSubscribe(ev.subscribe)
    if (err) return `subscribe invalid: ${err}`
  }
  return undefined
}

function validateRuntimeSubscribes(boundaries: R9BoundaryEvidence[]): string | undefined {
  const required = ["reconnect", "restart"] as const
  for (const name of required) {
    const b = boundaries.find((x) => x.boundary === name)
    if (!b) return `missing required boundary ${name} for subscribe evidence`
    if (b.subscribe === undefined) return `boundary ${name} missing subscribe evidence (reconnect and restart each require subscribes with v1.0 integer cursor subscribed:true)`
    const err = validateSubscribe(b.subscribe)
    if (err) return `boundary ${name} subscribe invalid: ${err}`
  }
  // Also validate any additional subscribe present strictly
  for (const b of boundaries) {
    if (b.subscribe !== undefined) {
      const err = validateSubscribe(b.subscribe)
      if (err) return `boundary ${b.boundary} subscribe invalid: ${err}`
    }
  }
  return undefined
}

export function isR9RuntimeValid(ev: R9RuntimeEvidence): string | undefined {
  if (ev.scenario !== "r9-observation") return "scenario must be r9-observation"
  if (!Array.isArray(ev.boundaries) || ev.boundaries.length !== 5) return `need 5 boundaries, got ${ev.boundaries?.length ?? 0}`
  const names = ev.boundaries.map((b) => b.boundary)
  const uniq = new Set(names)
  if (uniq.size !== 5) return `boundaries must be 5 unique, got ${names.join(",")}`
  for (const exp of EXPECTED_BOUNDARIES) if (!uniq.has(exp)) return `missing expected boundary ${exp} got ${names.join(",")}`
  for (const extra of names) if (!(EXPECTED_BOUNDARIES as readonly string[]).includes(extra)) return `unexpected boundary ${extra}`
  for (const b of ev.boundaries) {
    const err = validateR9Boundary(b)
    if (err) return `boundary ${b.boundary}: ${err}`
  }
  if (!ev.canonical.gateOk) return "canonical gate not ok"
  const subErr = validateRuntimeSubscribes(ev.boundaries)
  if (subErr) return subErr
  const reconnect = ev.boundaries.find((b) => b.boundary === "reconnect")
  if (!reconnect || !reconnect.trigger) return "runtime missing reconnect trigger evidence"
  const restart = ev.boundaries.find((b) => b.boundary === "restart")
  if (!restart || !restart.kill) return "runtime missing restart kill evidence"
  return undefined
}

async function requestJson(scratch: string, request: string, response: string, timeoutMs: number): Promise<unknown> {
  writeFileSync(join(scratch, request), "ok")
  await waitForFile(join(scratch, response), timeoutMs, response)
  const raw = readFileSync(join(scratch, response), "utf8")
  return JSON.parse(raw)
}

async function checkCanonicalGate(scratch: string, timeout: number): Promise<void> {
  await waitForFile(join(scratch, "canonical-gate.json"), timeout, "canonical gate")
  const gateRaw = readFileSync(join(scratch, "canonical-gate.json"), "utf8")
  const gate = JSON.parse(gateRaw) as Record<string, unknown>
  const err = validateGateEvidence(gate)
  if (err) throw new Error(`probe r9: canonical gate invalid: ${err}`)
  const dataRoot = gate.dataRoot as string | undefined
  if (typeof dataRoot === "string" && !isIsolatedDataRoot(scratch, dataRoot)) {
    throw new Error(`probe r9: canonical dataRoot not isolated: ${dataRoot}`)
  }
  console.log("[probe r9] canonical gate ok", gate)
}

async function findReloadedFrame(browser: Browser): Promise<Frame> {
  let fresh: Frame | null = null
  const deadline = Date.now() + 60_000
  while (!fresh && Date.now() < deadline) {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        for (const fr of page.frames()) {
          const url = fr.url()
          if (!url.includes("vscode-webview")) continue
          const ok = await fr
            .evaluate(() => {
              const marked = (window as unknown as { __amProbeMark?: string }).__amProbeMark === "pre-reload"
              return !marked && document.querySelector(".am-layout") !== null
            })
            .catch(() => false)
          if (ok) {
            fresh = fr
            break
          }
        }
        if (fresh) break
      }
      if (fresh) break
    }
    if (!fresh) await sleep(250)
  }
  if (!fresh) throw new Error("probe r9: reloaded frame not found after reload boundary")
  return fresh
}

async function handleReloadHandshake(browser: Browser, scratch: string): Promise<Frame> {
  // Wait for runner's reload-start marker (three-phase handshake: runner writes start+does reload)
  await waitForFile(join(scratch, "r9-reload-start"), 60_000, "r9-reload-start")
  const fresh = await findReloadedFrame(browser)
  console.log("[probe r9] reloaded frame found after reload-start")
  writeFileSync(join(scratch, "r9-reload-frame"), "ok")
  await waitForFile(join(scratch, "r9-reload-ready"), 60_000, "r9-reload-ready")
  return fresh
}

async function driveBoundaryNonReload(
  scratch: string,
  name: string,
): Promise<R9BoundaryEvidence> {
  const req = `r9-${name}-request`
  const res = `r9-${name}.json`
  console.log(`[probe r9] driving boundary ${name} (${req} -> ${res})`)
  const ev = (await requestJson(scratch, req, res, 120_000)) as R9BoundaryEvidence
  const err = validateR9Boundary(ev)
  if (err) throw new Error(`probe r9: boundary ${name} invalid: ${err} ev=${JSON.stringify(ev)}`)
  console.log(`[probe r9] boundary ${name} ok before pid ${ev.before.pid} after ${ev.after.pid} rehydrate ${ev.rehydrate}`)
  return ev
}

// eslint-disable-next-line complexity
async function handleSwitchBoundary(scratch: string, plan: E2EPlan, frame: Frame): Promise<R9BoundaryEvidence> {
  console.log("[probe r9] switch boundary start: writing r9-switch-request then performing real sibling-tab click before awaiting evidence")
  writeFileSync(join(scratch, "r9-switch-request"), "ok")
  const loc = frame.locator(`.am-tab-sortable[data-tab-id="${plan.siblingId}"]`)
  const count = await loc.count()
  if (count === 0) throw new Error(`probe r9: sibling tab ${plan.siblingId} not found for switch boundary`)
  await loc.click({ timeout: 10_000 })
  console.log("[probe r9] clicked sibling tab for switch boundary")
  const deadline = Date.now() + 10_000
  let active: string | undefined
  let confirmed = false
  while (Date.now() < deadline) {
    active = await frame
      .evaluate(() => {
        const containers = Array.from(document.querySelectorAll<HTMLElement>(".am-tab-sortable"))
        const activeEl = containers.find((c) => c.querySelector(".am-tab-active"))
        return activeEl?.getAttribute("data-tab-id") ?? undefined
      })
      .catch(() => undefined)
    if (active === plan.siblingId) {
      confirmed = true
      break
    }
    await sleep(250)
  }
  if (!confirmed) throw new Error(`probe r9: sibling tab ${plan.siblingId} not active after click, active=${active}`)
  const clickedPayload = { clickedTabId: plan.siblingId, activeTabId: active, at: new Date().toISOString(), selected: true }
  writeFileSync(join(scratch, "r9-switch-clicked"), JSON.stringify(clickedPayload, null, 2))
  console.log(`[probe r9] switch click confirmed active=${active} — awaiting r9-switch.json finalization after click`)
  await waitForFile(join(scratch, "r9-switch.json"), 120_000, "r9-switch.json")
  const raw = readFileSync(join(scratch, "r9-switch.json"), "utf8")
  const evSwitch = JSON.parse(raw) as R9BoundaryEvidence
  const err = validateR9Boundary(evSwitch)
  if (err) throw new Error(`probe r9: boundary switch invalid: ${err} ev=${JSON.stringify(evSwitch)}`)
  const actionConfirm = (evSwitch.actionResult as Record<string, unknown> | undefined)?.switchConfirmation as Record<string, unknown> | undefined
  const topConfirm = (evSwitch as unknown as Record<string, unknown>).switchConfirmation as Record<string, unknown> | undefined
  const topSwitch = (evSwitch as unknown as Record<string, unknown>).switch as Record<string, unknown> | undefined
  const foundClicked = actionConfirm?.clickedTabId ?? topConfirm?.clickedTabId ?? topSwitch?.clickedTabId
  if (foundClicked !== plan.siblingId) throw new Error(`probe r9: switch evidence missing confirmation clickedTabId ${plan.siblingId}, ev=${JSON.stringify(evSwitch).slice(0, 800)}`)
  const foundActive = actionConfirm?.activeTabId ?? topConfirm?.activeTabId ?? topSwitch?.activeTabId ?? active
  console.log(`[probe r9] boundary switch ok before pid ${evSwitch.before.pid} after ${evSwitch.after.pid} rehydrate ${evSwitch.rehydrate} clicked=${foundClicked} active=${foundActive}`)
  await waitForFile(join(scratch, "r9-switch-clicked"), 5_000, "r9-switch-clicked")
  await waitForFile(join(scratch, "r9-switch-confirmed"), 30_000, "r9-switch-confirmed")
  const confirmedRaw = readFileSync(join(scratch, "r9-switch-confirmed"), "utf8")
  const confirmedJson = JSON.parse(confirmedRaw) as Record<string, unknown>
  if (confirmedJson.clickedTabId !== plan.siblingId) throw new Error(`probe r9: r9-switch-confirmed mismatch ${JSON.stringify(confirmedJson)}`)
  const clickedStat = statSync(join(scratch, "r9-switch-clicked"))
  const evidStat = statSync(join(scratch, "r9-switch.json"))
  if (evidStat.mtimeMs < clickedStat.mtimeMs) throw new Error(`probe r9: switch evidence finalized before click (ev ${evidStat.mtimeMs} < clicked ${clickedStat.mtimeMs})`)
  return evSwitch
}

async function waitForNoWorktreeStable(frame: Frame, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      await assertNoWorktree(frame, label)
      return
    } catch (err) {
      lastErr = err
      await sleep(250)
    }
  }
  // Final attempt gives the throwable with details
  if (lastErr) throw lastErr
  await assertNoWorktree(frame, label)
}

async function waitForR9Topics(frame: Frame, label: string, timeoutMs: number, expectedRoots: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: string | undefined
  while (Date.now() < deadline) {
    const topics = await sidebarTopicStates(frame)
    const tabs = await tabStates(frame)
    if (topics.length === expectedRoots && tabs.length >= expectedRoots) {
      try {
        await assertNoWorktree(frame, label)
        return
      } catch (e) {
        last = String(e)
      }
    } else {
      last = `topics=${topics.length} tabs=${tabs.length} expectedRoots=${expectedRoots}`
    }
    await sleep(250)
  }
  const topics = await sidebarTopicStates(frame)
  const tabs = await tabStates(frame)
  const stats = await frame
    .evaluate(() => {
      const list = document.querySelector(".am-list")
      return {
        amList: !!list,
        topicRoots: document.querySelectorAll(".am-topic-root[data-topic-id]").length,
        items: document.querySelectorAll(".am-item").length,
        tabs: document.querySelectorAll(".am-tab-sortable[data-tab-id]").length,
        bodyLen: (document.body?.innerHTML ?? "").length,
        bodySnippet: (document.body?.innerText ?? "").slice(0, 800),
      }
    })
    .catch(() => ({ amList: false, topicRoots: -1, items: -1, tabs: -1, bodyLen: -1, bodySnippet: "<unreadable>" }))
  throw new Error(`probe: ${label} failed after ${timeoutMs}ms last=${last} topics=${JSON.stringify(topics)} tabs=${JSON.stringify(tabs)} stats=${JSON.stringify(stats)}`)
}

export async function assertR9ObservationLifecycle(browser: Browser, plan: E2EPlan, scratch: string): Promise<void> {
  const timeout = 30_000
  await waitForFile(join(scratch, "r9-ready"), 120_000, "r9-ready marker")
  await checkCanonicalGate(scratch, timeout)
  await waitForFile(join(scratch, "r9-cstate.json"), timeout, "r9-cstate.json")
  {
    const cstate = JSON.parse(readFileSync(join(scratch, "r9-cstate.json"), "utf8")) as Record<string, unknown>
    console.log("[probe r9] r9-cstate", JSON.stringify(cstate).slice(0, 500))
  }

  const found0 = await findAgentManagerFrameAny(browser, 60_000)
  let currentFrame: Frame = found0.frame
  await assertNoWorktree(currentFrame, "r9 initial has no worktree")
  console.log("[probe r9] initial frame ready", found0.url)

  // Panel boundary
  let evPanel = await driveBoundaryNonReload(scratch, "panel")
  // Reacquire current Agent Manager frame after panel close/reopen (do not reuse disposed frame)
  {
    const fresh = await findAgentManagerFrameAny(browser, 60_000)
    currentFrame = fresh.frame
    await waitForR9Topics(currentFrame, "r9 after panel has no worktree", 30_000, 2)
    console.log("[probe r9] reacquired frame after panel", fresh.url)
  }

  // Reload boundary — three-phase handshake, no circular wait
  // Mark pre-reload document so fresh can be distinguished
  await currentFrame.evaluate(() => {
    ;(window as unknown as { __amProbeMark?: string }).__amProbeMark = "pre-reload"
  })
  // Drive reload request (runner will write reload-start, do reload, wait for frame-ready, then write response)
  writeFileSync(join(scratch, "r9-reload-request"), "ok")
  console.log("[probe r9] wrote r9-reload-request, awaiting r9-reload-start handshake")
  const freshAfterReload = await handleReloadHandshake(browser, scratch)
  await waitForFile(join(scratch, "r9-reload.json"), 120_000, "r9-reload.json")
  const reloadRaw = readFileSync(join(scratch, "r9-reload.json"), "utf8")
  const evReload = JSON.parse(reloadRaw) as R9BoundaryEvidence
  {
    const err = validateR9Boundary(evReload)
    if (err) throw new Error(`probe r9: boundary reload invalid: ${err} ev=${JSON.stringify(evReload)}`)
  }
  console.log(`[probe r9] boundary reload ok before pid ${evReload.before.pid} after ${evReload.after.pid} rehydrate ${evReload.rehydrate}`)
  currentFrame = freshAfterReload
  await waitForR9Topics(currentFrame, "r9 after reload has no worktree", 30_000, 2)

  // Switch boundary — ordered handshake via helper (probe clicks BEFORE evidence finalization, LOCK-002)
  const evSwitch = await handleSwitchBoundary(scratch, plan, currentFrame)

  // Reconnect boundary (transport reconnect via lifecycle trigger) — missing trigger fails via validateR9Boundary
  let evReconnect = await driveBoundaryNonReload(scratch, "reconnect")

  // Restart boundary (worker restart via exact PID kill)
  let evRestart = await driveBoundaryNonReload(scratch, "restart")
  if (!evRestart.rehydrate) throw new Error("probe r9: restart boundary must have rehydrate true")

  // Final runtime evidence aggregation
  await waitForFile(join(scratch, "r9-observation-runtime-evidence"), timeout, "r9 runtime evidence")
  const runtime = JSON.parse(readFileSync(join(scratch, "r9-observation-runtime-evidence"), "utf8")) as R9RuntimeEvidence
  // Use measured runtime evidence: ensure five boundaries accounted
  const runtimeErr = isR9RuntimeValid(runtime)
  if (runtimeErr) throw new Error(`probe r9: runtime evidence invalid: ${runtimeErr} ${JSON.stringify(runtime).slice(0, 800)}`)
  // Prefer to ensure runtime includes exactly the five expected boundaries (already checked)
  console.log("[probe r9] runtime evidence ok", JSON.stringify(runtime.boundaries.map((b) => b.boundary)))

  // Canonical DB identity: privateObservationStatus dbPath must equal canonicalDbPath(scratch)
  await waitForFile(join(scratch, "r9-status.json"), timeout, "r9-status.json")
  const status = JSON.parse(readFileSync(join(scratch, "r9-status.json"), "utf8")) as Record<string, unknown>
  const canonical = canonicalDbPath(scratch)
  if (status.dbPath !== canonical) {
    throw new Error(`probe r9: canonical DB mismatch status.dbPath=${status.dbPath} canonical=${canonical}`)
  }
  if (status.testBridge !== true) {
    throw new Error(`probe r9: testBridge not enabled in fixture run status=${JSON.stringify(status)}`)
  }
  console.log(`[probe r9] canonical DB identity proven ${canonical} testBridge=${status.testBridge}`)

  // Final DOM evidence — use current reacquired frame (not stale)
  const finalUrl = currentFrame.url()
  // If frame detached, re-find
  let finalFrameForEvidence = currentFrame
  if (!finalUrl || !finalUrl.includes("vscode-webview")) {
    const ff = await findAgentManagerFrameAny(browser, 30_000)
    finalFrameForEvidence = ff.frame
  }
  // Include switch confirmation in durable DOM evidence (JSON-safe, observable)
  const switchConfirmation = (() => {
    try {
      return JSON.parse(readFileSync(join(scratch, "r9-switch-clicked"), "utf8"))
    } catch {
      return undefined
    }
  })()
  const switchConfirmed = (() => {
    try {
      return JSON.parse(readFileSync(join(scratch, "r9-switch-confirmed"), "utf8"))
    } catch {
      return undefined
    }
  })()
  writeFileSync(
    join(scratch, "r9-dom-evidence"),
    JSON.stringify(
      {
        url: finalFrameForEvidence.url(),
        plan,
        runtimeBoundaries: runtime.boundaries.map((b) => b.boundary),
        canonical,
        status,
        switch: { clicked: switchConfirmation, confirmed: switchConfirmed, evSwitch },
      },
      null,
      2,
    ),
  )
  console.log("[probe r9] lifecycle passed")
}
