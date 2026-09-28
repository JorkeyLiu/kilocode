/**
 * Operation-crash E2E (hard crash): accepted in-flight prompt/provider ->
 * exact owned private backend SIGKILL -> restart same DB -> pre-bind
 * convergence prompt/provider abandoned + receipt, owner crash + no provider
 * replay + Agent Manager recentOperations/DOM Stopped after runtime restart exactly once, panel
 * reopen/read-ack observation cursor convergence.
 *
 * Harness only (Node, never bundled). Reuses the hang-server shape from
 * script/e2e-probe.ts (raw TCP hold, no response) with hit counting, the
 * closed canonical seed shape from script/e2e-restart-seed.ts, and the
 * read-only Bun gate (script/e2e-generation-gate.ts) for DB evidence.
 *
 * TCP connection count (hang.hits) is distinct from logical LLM requests
 * (llm-request-collector keyed pid/instance/session): both are snapshotted
 * at before/hardKill/reconnect. Title/small requests are permitted only
 * prekill; after the hard kill completes, zero new run-owned provider
 * network is allowed (no replay).
 */

import { createServer, type Socket } from "node:net"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import type { Browser, Frame } from "@playwright/test"
import type { BackendSnapshot } from "../src/agent-manager/fixture-backend"
import { CONFIG_FILENAME } from "../src/config/paths"
import { realProjectSeed } from "./e2e-restart-seed"
import { canonicalDbPath, isIsolatedDataRoot, validateGateEvidence } from "./e2e-canonical"
import { assertRunOwnedLlmRequests, readLlmRequests } from "./e2e-llm-matrix"
import { llmRequestMatrix, type LlmRequestRecord } from "../src/services/cli-backend/llm-request-collector"
import {
  findAgentManagerFrameAny,
  openSidebarSession,
  pickAgent,
  pickVariant,
  realTabStates,
  sleep,
  snapshotClient,
  waitForAgentOption,
  waitForFile,
  waitForLabel,
  waitForModelSelected,
  type E2EPlan,
} from "./e2e-probe-dom"
import { runGenerationGate } from "./e2e-generation-assert"

export const OPERATION_CRASH_PROMPT = "E2E_CRASH_HOLD: stay busy behind the hang provider"

export interface CrashHang {
  port: number
  hits: () => number
  close: () => Promise<void>
}

export async function createCountingHang(): Promise<CrashHang> {
  const sockets = new Set<Socket>()
  let count = 0
  const server = createServer((socket) => {
    count += 1
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
    throw new Error("operation-crash: hang address unavailable")
  }
  return {
    port: address.port,
    hits: () => count,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export async function prepareOperationCrash(
  workspace: string,
  want: boolean,
  create?: () => Promise<CrashHang>,
): Promise<CrashHang | undefined> {
  if (!want) return undefined
  const hang = await (create ?? createCountingHang)()
  try {
    const file = join(workspace, ".kilo", CONFIG_FILENAME)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(realProjectSeed(hang.port), null, 2))
    const kiloDir = join(workspace, ".kilo")
    mkdirSync(join(kiloDir, "node_modules"), { recursive: true })
    writeFileSync(
      join(kiloDir, "package-lock.json"),
      JSON.stringify({ name: "kilo-e2e-workspace", version: "0.0.0", lockfileVersion: 3, packages: { "": { dependencies: { "@kilocode/plugin": "0.0.0" } } } }),
    )
    console.log(`[probe] operation-crash seed: ${file} (hang port ${hang.port})`)
    return hang
  } catch (err) {
    await hang.close().catch(() => {})
    throw err
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function checkGate(scratch: string): Promise<void> {
  await waitForFile(join(scratch, "canonical-gate.json"), 30_000, "canonical gate before crash")
  const gate = JSON.parse(readFileSync(join(scratch, "canonical-gate.json"), "utf8")) as Record<string, unknown>
  const err = validateGateEvidence(gate)
  if (err) throw new Error(`operation-crash: canonical gate invalid: ${err}`)
  const root = (gate as Record<string, unknown>).dataRoot as string | undefined
  if (typeof root === "string" && !isIsolatedDataRoot(scratch, root)) throw new Error("operation-crash: dataRoot not isolated")
}

async function requestOcSeedCredential(scratch: string, timeout: number): Promise<Record<string, unknown>> {
  const file = join(scratch, "oc-credential.json")
  try {
    const { rmSync } = await import("node:fs") as typeof import("node:fs")
    rmSync(file, { force: true })
  } catch {}
  writeFileSync(join(scratch, "oc-credseed-request"), "ok")
  await waitForFile(file, timeout, "oc-credential.json (credential seeding probe)")
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
}

async function requestOcCanonical(scratch: string, timeout: number): Promise<Record<string, unknown>> {
  writeFileSync(join(scratch, "oc-cstate-request"), "ok")
  await waitForFile(join(scratch, "oc-cstate.json"), timeout, "oc-cstate.json")
  return JSON.parse(readFileSync(join(scratch, "oc-cstate.json"), "utf8")) as Record<string, unknown>
}

async function checkCredential(scratch: string, plan: E2EPlan, timeout: number): Promise<void> {
  await waitForFile(join(scratch, "oc-credential.json"), timeout, "oc-credential.json")
  const cred = JSON.parse(readFileSync(join(scratch, "oc-credential.json"), "utf8")) as Record<string, unknown>
  if (cred.ok !== true) throw new Error(`operation-crash: credential failed ${JSON.stringify(cred)}`)
  const connected = (cred as { connected?: unknown }).connected
  if (!Array.isArray(connected) || !connected.includes(plan.customProvider)) throw new Error("operation-crash: credential missing provider")
  const fresh = await requestOcSeedCredential(scratch, timeout)
  if (fresh.ok !== true) throw new Error(`operation-crash: credential round-trip failed ${JSON.stringify(fresh)}`)
}

async function checkCanonical(scratch: string, plan: E2EPlan, timeout: number): Promise<void> {
  const cstate = await requestOcCanonical(scratch, timeout)
  const prov = (cstate as { providerIndex?: { connected?: unknown; entries?: Array<{ id: string; hasCredential: boolean }> } | null }).providerIndex
  if (!prov || !Array.isArray(prov.connected) || !prov.connected.includes(plan.customProvider)) {
    throw new Error("operation-crash: canonical missing provider")
  }
  const entry = prov.entries?.find((e) => e.id === plan.customProvider)
  if (!entry?.hasCredential) throw new Error("operation-crash: hasCredential false")
}

async function pickIdentity(frame: Frame, plan: E2EPlan, timeout: number): Promise<void> {
  await waitForAgentOption(frame, plan.customAgentLabel, timeout)
  await pickAgent(frame, plan.customAgentLabel, timeout)
  await waitForLabel(frame, ".mode-switcher-trigger-label", plan.customAgentLabel, timeout, "custom agent selected")
  await pickVariant(frame, plan.customVariantA, timeout)
  await waitForLabel(frame, ".thinking-selector-trigger-label", plan.customVariantA, timeout, "variant selected")
  await waitForModelSelected(frame, plan.customProvider, plan.customModel, timeout, "custom model selected")
}

async function sendHoldPrompt(frame: Frame, timeout: number): Promise<void> {
  const ta = frame.locator("textarea.prompt-input").first()
  await ta.waitFor({ state: "visible", timeout })
  await ta.fill("")
  await ta.pressSequentially(OPERATION_CRASH_PROMPT, { delay: 5 })
  const send = frame.locator('button[aria-label="Send"]').first()
  const deadline = Date.now() + timeout
  for (;;) {
    const present = await send.count().then((n) => n > 0)
    const disabled = present ? await send.getAttribute("aria-disabled").catch(() => "true") : "true"
    if (present && disabled !== "true") break
    if (Date.now() > deadline) throw new Error("operation-crash: Send never enabled")
    await sleep(250)
  }
  await send.click({ timeout })
}

function userOpOf(snap: BackendSnapshot): { sid: string; opId: string; msgId: string } | undefined {
  for (const [sid, msgs] of Object.entries(snap.messages ?? {})) {
    for (const m of msgs ?? []) {
      if (m.role === "user" && typeof m.id === "string" && m.id.startsWith("msg") && m.text.includes("E2E_CRASH_HOLD")) {
        return { sid, opId: `prompt:${m.id}`, msgId: m.id }
      }
    }
  }
  return undefined
}

async function requestOps(scratch: string, directory: string, sessionId: string): Promise<Record<string, unknown>> {
  writeFileSync(join(scratch, "oc-ops-request"), JSON.stringify({ directory, sessionId, limit: 10 }))
  await waitForFile(join(scratch, "oc-ops.json"), 30_000, "oc-ops.json")
  return JSON.parse(readFileSync(join(scratch, "oc-ops.json"), "utf8")) as Record<string, unknown>
}

async function requestRecent(scratch: string, sessionId: string): Promise<Record<string, unknown>> {
  writeFileSync(join(scratch, "oc-recent-request"), JSON.stringify({ sessionId }))
  await waitForFile(join(scratch, "oc-recent.json"), 30_000, "oc-recent.json")
  return JSON.parse(readFileSync(join(scratch, "oc-recent.json"), "utf8")) as Record<string, unknown>
}

async function requestNotif(scratch: string): Promise<unknown> {
  writeFileSync(join(scratch, "oc-notif-request"), "ok")
  await waitForFile(join(scratch, "oc-notif.json"), 30_000, "oc-notif.json")
  return JSON.parse(readFileSync(join(scratch, "oc-notif.json"), "utf8")) as unknown
}

async function requestStatus(scratch: string): Promise<Record<string, unknown>> {
  writeFileSync(join(scratch, "oc-status-request"), "ok")
  await waitForFile(join(scratch, "oc-status.json"), 30_000, "oc-status.json")
  return JSON.parse(readFileSync(join(scratch, "oc-status.json"), "utf8")) as Record<string, unknown>
}

async function requestObsSnapshot(scratch: string): Promise<Record<string, unknown>> {
  writeFileSync(join(scratch, "oc-obs-snapshot-request"), "ok")
  await waitForFile(join(scratch, "oc-obs-snapshot.json"), 30_000, "oc-obs-snapshot.json")
  return JSON.parse(readFileSync(join(scratch, "oc-obs-snapshot.json"), "utf8")) as Record<string, unknown>
}

async function requestObsRead(scratch: string, cursor: number): Promise<Record<string, unknown>> {
  writeFileSync(join(scratch, "oc-obs-read-request"), JSON.stringify({ cursor }))
  await waitForFile(join(scratch, "oc-obs-read.json"), 30_000, "oc-obs-read.json")
  return JSON.parse(readFileSync(join(scratch, "oc-obs-read.json"), "utf8")) as Record<string, unknown>
}

async function requestObsAck(scratch: string, cursor: number): Promise<unknown> {
  writeFileSync(join(scratch, "oc-obs-ack-request"), JSON.stringify({ cursor }))
  await waitForFile(join(scratch, "oc-obs-ack.json"), 30_000, "oc-obs-ack.json")
  return JSON.parse(readFileSync(join(scratch, "oc-obs-ack.json"), "utf8")) as unknown
}

function recentEntryFor(recent: Record<string, unknown>, sid: string): Record<string, unknown> | undefined {
  const direct = (recent as Record<string, unknown>)[sid] as Record<string, unknown> | undefined
  if (direct && typeof direct.opId === "string") return direct
  const nested = (recent.recentOperations as Record<string, unknown> | undefined)?.[sid] as Record<string, unknown> | undefined
  return nested
}

function llmSnapshot(scratch: string): LlmRequestRecord[] {
  return readLlmRequests(scratch)
}

function assertAllRunOwned(records: LlmRequestRecord[], phase: string): void {
  const matrix = llmRequestMatrix(records)
  if (matrix.violations.length > 0) {
    throw new Error(`operation-crash: ${phase}: non-run-owned LLM request observed: ${JSON.stringify(matrix.violations).slice(0, 800)}`)
  }
}

// eslint-disable-next-line complexity
export async function assertOperationCrashLifecycle(
  browser: Browser,
  plan: E2EPlan,
  scratch: string,
  workspace: string,
  hang: CrashHang,
  root: string,
): Promise<void> {
  const timeout = 30_000
  await checkGate(scratch)
  await waitForFile(join(scratch, "operation-crash-ready"), 120_000, "operation-crash-ready")
  await checkCredential(scratch, plan, timeout)
  const found = await findAgentManagerFrameAny(browser, 60_000)
  let frame = found.frame
  const snap = snapshotClient(scratch, "oc-snap")
  await checkCanonical(scratch, plan, timeout)
  await pickIdentity(frame, plan, timeout)
  await sendHoldPrompt(frame, timeout)
  const busy = await snap.waitFor(
    (s) => {
      const hit = userOpOf(s)
      if (!hit) return "no crash user message yet"
      if ((s.statuses[hit.sid] ?? "idle") !== "busy") return `session ${hit.sid} status=${s.statuses[hit.sid]} expected busy`
      return undefined
    },
    90_000,
    "crash prompt busy behind hang provider",
  )
  const target = userOpOf(busy)
  if (!target) throw new Error("operation-crash: busy target lost")
  const { sid, opId } = target
  console.log(`[probe operation-crash] in-flight settled sid=${sid} op=${opId}`)
  const hitsBefore = hang.hits()
  if (hitsBefore < 1) throw new Error(`operation-crash: hang hits before kill must be >=1, got ${hitsBefore}`)
  const llmBefore = llmSnapshot(scratch)
  if (llmBefore.length < 1) throw new Error(`operation-crash: llm requests before kill must be >=1, got ${llmBefore.length}`)
  assertAllRunOwned(llmBefore, "before-hard-kill")
  const dbPath = canonicalDbPath(scratch)
  const before = runGenerationGate(root, scratch, dbPath, sid, opId)
  if (!before.session.exists) throw new Error(`operation-crash: session ${sid} missing in DB before kill`)
  if (!before.operation || before.operation.outcome !== "in-flight") {
    throw new Error(`operation-crash: prompt operation must be in-flight before kill, got ${JSON.stringify(before.operation)}`)
  }
  const openOwner = before.owners.find((o) => o.reason === null && o.closedAt === null)
  if (!openOwner) throw new Error(`operation-crash: no open generation owner before kill: ${JSON.stringify(before.owners)}`)
  if (before.members.length === 0) throw new Error("operation-crash: no generation members before kill")
  writeFileSync(join(scratch, "operation-crash-before.json"), JSON.stringify({ sid, opId, hitsBefore, llmBefore, gate: before }, null, 2))
  // Hard crash: exact owned detached backend SIGKILL (no graceful SIGTERM).
  const killedRaw = await (async () => {
    writeFileSync(join(scratch, "oc-kill-hard-request"), "ok")
    await waitForFile(join(scratch, "oc-kill-hard.json"), 60_000, "oc-kill-hard.json")
    return JSON.parse(readFileSync(join(scratch, "oc-kill-hard.json"), "utf8")) as { pid: number; port: number; epoch: number | null }
  })()
  if (!killedRaw.pid || !killedRaw.port) throw new Error(`operation-crash: hard kill recorded no pid/port ${JSON.stringify(killedRaw)}`)
  console.log(`[probe operation-crash] hard-killed exact pid=${killedRaw.pid} port=${killedRaw.port}`)
  const hitsAtKill = hang.hits()
  const llmAtKill = llmSnapshot(scratch)
  assertAllRunOwned(llmAtKill, "at-hard-kill")
  // TCP vs logical distinction: raw hang TCP connections may grow in the
  // kill window (transport retries while the doomed backend still lives),
  // but logical LLM.run requests (service=llm lines) must not grow except
  // for prekill small/title. Record the TCP delta as evidence only; the
  // strict no-replay gates below compare post-kill snapshots.
  if (hitsAtKill !== hitsBefore) {
    console.log(`[probe operation-crash] TCP kill-window delta before=${hitsBefore} atKill=${hitsAtKill} (transport-level, evidence only)`)
  }
  // Logical LLM: any delta between before and the kill instant must be
  // run-owned small/title only (prekill titles permitted, never a new main turn).
  if (llmAtKill.length !== llmBefore.length) {
    const delta = llmAtKill.slice(llmBefore.length)
    const nonSmall = delta.filter((r) => r.small !== true)
    if (nonSmall.length > 0) {
      throw new Error(`operation-crash: new non-small LLM request across hard kill: ${JSON.stringify(nonSmall).slice(0, 800)}`)
    }
    console.log(`[probe operation-crash] prekill title-only delta=${delta.length} allowed`)
  }
  writeFileSync(join(scratch, "operation-crash-hardkill.json"), JSON.stringify({ sid, opId, hitsBefore, hitsAtKill, llmBefore, llmAtKill, killed: killedRaw }, null, 2))
  await sleep(1_000)
  writeFileSync(join(scratch, "oc-reconnect-request"), "ok")
  await waitForFile(join(scratch, "oc-reconnect.json"), 180_000, "oc-reconnect.json")
  const rc = JSON.parse(readFileSync(join(scratch, "oc-reconnect.json"), "utf8")) as { state: string; pid: number | null; port: number | null; epoch: number | null }
  if (rc.state !== "connected") throw new Error(`operation-crash: reconnect not connected ${JSON.stringify(rc)}`)
  if (rc.pid === null || rc.pid === killedRaw.pid) throw new Error(`operation-crash: reconnect pid not new old=${killedRaw.pid} new=${rc.pid}`)
  if (rc.port === null || rc.port === killedRaw.port) throw new Error("operation-crash: reconnect port not new")
  const goneDeadline = Date.now() + 30_000
  while (pidAlive(killedRaw.pid) && Date.now() < goneDeadline) await sleep(250)
  if (pidAlive(killedRaw.pid)) throw new Error(`operation-crash: hard-killed pid ${killedRaw.pid} still alive`)
  const hitsAfterRestart = hang.hits()
  const llmAfter = llmSnapshot(scratch)
  assertAllRunOwned(llmAfter, "after-reconnect")
  // Strict no-replay: no new TCP hang connection and no new logical LLM
  // request (keyed pid/instance/session in the collector store) may appear
  // after the hard kill completes. The pre-bind convergence sweep
  // terminalizes without replay. TCP baseline is the at-kill snapshot (the
  // kill window may carry pre-death transport retries); logical baseline is
  // likewise at-kill (prekill titles already folded in above).
  if (hitsAfterRestart !== hitsAtKill) {
    throw new Error(`operation-crash: provider TCP replay detected hits atKill=${hitsAtKill} afterRestart=${hitsAfterRestart} (before=${hitsBefore})`)
  }
  if (llmAfter.length !== llmAtKill.length) {
    throw new Error(`operation-crash: provider LLM replay detected llm before=${llmBefore.length} atKill=${llmAtKill.length} after=${llmAfter.length}: ${JSON.stringify(llmAfter.slice(llmAtKill.length)).slice(0, 800)}`)
  }
  const after = runGenerationGate(root, scratch, dbPath, sid, opId)
  const owner = after.owners.find((o) => o.genID === openOwner.genID) ?? after.owners[0]
  if (!owner) throw new Error("operation-crash: owner missing after restart")
  // Strict hard-crash terminal: owner crash only (never graceful error).
  if (owner.reason !== "crash") {
    throw new Error(`operation-crash: owner reason must be crash, got ${owner.reason}`)
  }
  if (owner.closedAt === null || owner.nextAt !== null) throw new Error("operation-crash: owner terminal close invalid")
  // Strict pre-bind convergence: prompt abandoned (prompt.abandoned) + receipt
  // abandoned/forbidden/gen==owner/closeReason crash.
  if (!after.operation || after.operation.outcome !== "abandoned") {
    throw new Error(`operation-crash: prompt operation must be abandoned after hard crash, got ${JSON.stringify(after.operation)}`)
  }
  if (after.operation.code !== "prompt.abandoned") throw new Error(`operation-crash: prompt code must be prompt.abandoned, got ${after.operation.code}`)
  if (!after.receipt || after.receipt.outcome !== "abandoned") throw new Error("operation-crash: prompt receipt must be abandoned")
  if (after.receipt.replay !== "forbidden") throw new Error("operation-crash: prompt receipt replay must be forbidden")
  if (after.receipt.genID !== owner.genID) throw new Error("operation-crash: prompt receipt gen must equal terminal owner")
  // Pre-bind sweep order (serve gateThenListen): the operation sweep writes
  // the prompt receipt while the generation owner is still open, then the
  // generation sweep closes the owner as crash. The receipt therefore
  // snapshots owner_close_reason null — strict null proves the pre-bind
  // operation-first ordering (not a post-close crash snapshot).
  if (after.receipt.closeReason !== null) {
    throw new Error(`operation-crash: prompt receipt closeReason must be null (open-owner snapshot), got ${after.receipt.closeReason}`)
  }
  const providers = after.providers ?? []
  const linked = providers.filter((p) => p.genID === owner.genID)
  if (linked.length === 0) {
    throw new Error(`operation-crash: no provider op linked to crash owner ${owner.genID}: ${JSON.stringify(providers).slice(0, 600)}`)
  }
  const badLinked = linked.filter((p) => p.outcome !== "abandoned")
  if (badLinked.length > 0) {
    throw new Error(`operation-crash: linked provider must be abandoned, got ${JSON.stringify(badLinked).slice(0, 600)}`)
  }
  if (!linked.some((p) => p.code === "provider.abandoned")) {
    throw new Error(`operation-crash: linked provider must carry provider.abandoned code, got ${JSON.stringify(linked).slice(0, 600)}`)
  }
  const abandonedProviders = providers.filter((p) => p.outcome === "abandoned")
  if (abandonedProviders.length === 0) throw new Error("operation-crash: no abandoned provider after hard crash")
  const receiptsByOp = new Map((after.providerReceipts ?? []).map((r) => [r.opId, r]))
  for (const p of linked) {
    const pr = receiptsByOp.get(p.opId)
    if (!pr) throw new Error(`operation-crash: provider receipt missing for ${String(p.opId)}`)
    if (pr.outcome !== "abandoned") throw new Error(`operation-crash: provider receipt must be abandoned for ${String(p.opId)}, got ${pr.outcome}`)
    if (pr.replay !== "forbidden") throw new Error(`operation-crash: provider receipt replay must be forbidden for ${String(p.opId)}`)
    if (pr.genID !== owner.genID) throw new Error(`operation-crash: provider receipt gen must equal owner for ${String(p.opId)}`)
    // Same pre-bind order as the prompt receipt: provider sweep snapshots the
    // still-open owner, so owner_close_reason is null (strict).
    if (pr.closeReason !== null) throw new Error(`operation-crash: provider receipt closeReason must be null for ${String(p.opId)}, got ${pr.closeReason}`)
  }
  writeFileSync(
    join(scratch, "operation-crash-after.json"),
    JSON.stringify({ sid, opId, hitsBefore, hitsAtKill, hitsAfterRestart, llmBefore: llmBefore.length, llmAtKill: llmAtKill.length, llmAfter: llmAfter.length, gate: after, killed: killedRaw, reconnect: rc }, null, 2),
  )
  const ops = await requestOps(scratch, workspace, sid)
  const opsList = (ops.operations as unknown[] | undefined) ?? []
  const promptRow = opsList.find((o) => (o as Record<string, unknown>).opId === opId) as Record<string, unknown> | undefined
  if (!promptRow || promptRow.outcome !== "abandoned") throw new Error(`operation-crash: operations missing abandoned ${opId}`)
  if ("detail" in promptRow || "stack" in promptRow) throw new Error("operation-crash: operations leaked detail/stack")
  try {
    await (async () => {
      writeFileSync(join(scratch, "oc-refresh-request"), "ok")
      await waitForFile(join(scratch, "oc-refresh.json"), 30_000, "oc-refresh.json")
    })()
  } catch {}
  await sleep(600)
  const recent = await requestRecent(scratch, sid)
  const entry = recentEntryFor(recent, sid)
  // recentOperations holds the single latest PanelOperation per session: after
  // a hard crash that is the abandoned provider attempt (provider.abandoned),
  // never the older prompt row. Accept the prompt op or any provider op linked
  // to the crash owner — strict abandoned either way, exactly one entry.
  const allowedOpIds = new Set([opId, ...linked.map((p) => String(p.opId))])
  if (!entry || typeof entry.opId !== "string" || !allowedOpIds.has(entry.opId)) {
    throw new Error(`operation-crash: recentOperations missing crash op (prompt or linked provider): ${JSON.stringify(recent).slice(0, 600)}`)
  }
  if (entry.outcome !== "abandoned") throw new Error(`operation-crash: recentOperations outcome must be abandoned, got ${entry.outcome}`)
  const scoped = `[data-component="am-operation-status"][data-session-id="${sid}"]`
  const textSel = `${scoped} [data-slot="am-operation-text"]`
  const tabs = await realTabStates(frame)
  if (!tabs.some((t) => t.id === sid)) {
    const count = await frame.locator(`.am-tab-sortable[data-tab-id="${sid}"]`).count().catch(() => 0)
    if (count === 0) throw new Error(`operation-crash: session tab ${sid} missing before DOM check`)
    const remain = 30_000
    const { clickTab } = await import("./e2e-probe-dom")
    await clickTab(frame, sid, remain)
  }
  // Hard-crash runtime-restart abandoned => OperationStatus visible
  // "Stopped after runtime restart" exactly once (neutral). Scoped to this
  // probe's exact crash discriminants (prompt.abandoned / provider.abandoned
  // with fixed restart messages); generic cancellations stay Cancelled elsewhere.
  const cancelledDeadline = Date.now() + 15_000
  let cancelledText = ""
  for (;;) {
    if (frame.isDetached()) {
      const fresh = await findAgentManagerFrameAny(browser, 5_000)
      frame = fresh.frame
    }
    const count = await frame.locator(scoped).count().catch(() => 0)
    if (count === 1) {
      cancelledText = (await frame.locator(textSel).first().textContent().catch(() => "")) ?? ""
      if (cancelledText === "Stopped after runtime restart") break
    }
    if (Date.now() > cancelledDeadline) {
      const text = (await frame.locator(textSel).first().textContent().catch(() => "")) ?? ""
      throw new Error(`operation-crash: OperationStatus must show Stopped after runtime restart exactly once, got count=${count} text=${text.slice(0, 120)}`)
    }
    await sleep(250)
  }
  {
    const count = await frame.locator(scoped).count().catch(() => 0)
    if (count !== 1) throw new Error(`operation-crash: Stopped after runtime restart must appear exactly once, got count=${count}`)
    const outcome = await frame.locator(scoped).first().getAttribute("data-outcome").catch(() => null)
    if (outcome !== "abandoned") throw new Error(`operation-crash: DOM outcome must be abandoned, got ${outcome}`)
    const tone = await frame.locator(scoped).first().getAttribute("data-tone").catch(() => null)
    if (tone !== "neutral") throw new Error(`operation-crash: DOM tone must be neutral, got ${tone}`)
  }
  writeFileSync(
    join(scratch, "operation-crash-dom-evidence"),
    JSON.stringify({ sid, opId, hitsBefore, hitsAtKill, hitsAfterRestart, llmAfter: llmAfter.length, killed: killedRaw, reconnect: rc, recent: entry, domText: cancelledText, url: frame.url() }, null, 2),
  )
  const notif = await requestNotif(scratch)
  writeFileSync(join(scratch, "operation-crash-notif.json"), JSON.stringify(notif, null, 2))
  const status = await requestStatus(scratch)
  writeFileSync(join(scratch, "operation-crash-status.json"), JSON.stringify(status, null, 2))
  if (status.dbPath !== dbPath) throw new Error(`operation-crash: canonical DB mismatch ${status.dbPath} vs ${dbPath}`)
  const beforeCursor = await requestObsSnapshot(scratch)
  const cursor = beforeCursor.cursor as number | undefined
  if (typeof cursor !== "number") throw new Error("operation-crash: observation snapshot cursor missing")
  const read = await requestObsRead(scratch, cursor)
  const ack = await requestObsAck(scratch, cursor)
  writeFileSync(join(scratch, "operation-crash-obs.json"), JSON.stringify({ snapshot: beforeCursor, read, ack }, null, 2))
  writeFileSync(join(scratch, "oc-reopen-request"), JSON.stringify({ sessionId: sid, opId }))
  await waitForFile(join(scratch, "oc-reopen-ready"), 120_000, "oc-reopen-ready")
  const fresh = await findAgentManagerFrameAny(browser, 60_000)
  frame = fresh.frame
  const afterCursor = await requestObsSnapshot(scratch)
  const cursorAfter = afterCursor.cursor as number | undefined
  if (typeof cursorAfter !== "number" || cursorAfter < cursor) throw new Error(`operation-crash: cursor regressed ${cursor} -> ${cursorAfter}`)
  const recentAfter = await requestRecent(scratch, sid)
  const entryAfter = recentEntryFor(recentAfter, sid)
  if (!entryAfter || typeof entryAfter.opId !== "string" || !allowedOpIds.has(entryAfter.opId) || entryAfter.outcome !== "abandoned") {
    throw new Error("operation-crash: recentOperations lost after reopen")
  }
  // Reopen DOM (strict, same session): the runner reopens the panel via the
  // existing agentManagerOpen route and re-projects the same crash sid via
  // the existing production fixture loopback (sessionAdded/sessionCreated +
  // SETTLE/READY/CONTENT_READY, no new durable state). The reopened same-sid
  // tab must show the scoped OperationStatus "Stopped after runtime restart"
  // exactly once (outcome abandoned, tone neutral) for this exact
  // runtime-restart crash. Tab-less is a failure — no
  // best-effort pass. When the tab is not yet visible but the existing
  // sidebar row is, recover via the existing openSidebarSession route and
  // observe (production unchanged).
  let reopenDom: string | null = null
  {
    const tabDeadline = Date.now() + 30_000
    let tabFound = false
    let tabsDiag = ""
    for (;;) {
      if (frame.isDetached()) {
        const refound = await findAgentManagerFrameAny(browser, 5_000)
        frame = refound.frame
      }
      const tabsAfter = await realTabStates(frame)
      tabsDiag = tabsAfter.map((t) => t.id).join(",").slice(0, 400)
      if (tabsAfter.some((t) => t.id === sid)) {
        tabFound = true
        break
      }
      const count = await frame.locator(`.am-tab-sortable[data-tab-id="${sid}"]`).count().catch(() => 0)
      if (count > 0) {
        tabFound = true
        break
      }
      if (Date.now() > tabDeadline) break
      await sleep(500)
    }
    if (!tabFound) {
      const sidebarHit = await frame
        .locator(`.am-item.am-topic-root[data-topic-id="${sid}"]`)
        .count()
        .catch(() => 0)
      if (sidebarHit > 0) {
        await openSidebarSession(frame, sid, 10_000)
        const recoverDeadline = Date.now() + 30_000
        for (;;) {
          if (frame.isDetached()) {
            const refound = await findAgentManagerFrameAny(browser, 5_000)
            frame = refound.frame
          }
          const tabsAfter = await realTabStates(frame)
          tabsDiag = tabsAfter.map((t) => t.id).join(",").slice(0, 400)
          if (tabsAfter.some((t) => t.id === sid)) {
            tabFound = true
            break
          }
          const count = await frame.locator(`.am-tab-sortable[data-tab-id="${sid}"]`).count().catch(() => 0)
          if (count > 0) {
            tabFound = true
            break
          }
          if (Date.now() > recoverDeadline) break
          await sleep(500)
        }
      }
    }
    if (!tabFound) {
      writeFileSync(join(scratch, "operation-crash-reopen-tabs"), JSON.stringify({ sid, tabs: tabsDiag }, null, 2))
      throw new Error(`operation-crash: reopened same-sid tab missing sid=${sid} tabs=[${tabsDiag}]`)
    }
    const { clickTab } = await import("./e2e-probe-dom")
    await clickTab(frame, sid, 30_000)
    const deadline = Date.now() + 15_000
    for (;;) {
      if (frame.isDetached()) {
        const refound = await findAgentManagerFrameAny(browser, 5_000)
        frame = refound.frame
      }
      const count = await frame.locator(scoped).count().catch(() => 0)
      if (count === 1) {
        const text = (await frame.locator(textSel).first().textContent().catch(() => "")) ?? ""
        if (text === "Stopped after runtime restart") {
          reopenDom = text
          break
        }
      }
      if (Date.now() > deadline) {
        const text = (await frame.locator(textSel).first().textContent().catch(() => "")) ?? ""
        const count = await frame.locator(scoped).count().catch(() => 0)
        throw new Error(`operation-crash: reopened DOM must show Stopped after runtime restart exactly once, got count=${count} text=${text.slice(0, 120)}`)
      }
      await sleep(250)
    }
    const count = await frame.locator(scoped).count().catch(() => 0)
    if (count !== 1) throw new Error(`operation-crash: reopened Stopped after runtime restart must appear exactly once, got count=${count}`)
    const outcome = await frame.locator(scoped).first().getAttribute("data-outcome").catch(() => null)
    if (outcome !== "abandoned") throw new Error(`operation-crash: reopened DOM outcome must be abandoned, got ${outcome}`)
    const tone = await frame.locator(scoped).first().getAttribute("data-tone").catch(() => null)
    if (tone !== "neutral") throw new Error(`operation-crash: reopened DOM tone must be neutral, got ${tone}`)
    writeFileSync(
      join(scratch, "operation-crash-reopen-dom"),
      JSON.stringify({ sid, opId, domText: reopenDom, outcome, tone, url: frame.url() }, null, 2),
    )
  }
  const llm = assertRunOwnedLlmRequests(scratch, "operation-crash-final")
  writeFileSync(
    join(scratch, "operation-crash-runtime-evidence"),
    JSON.stringify(
      {
        scenario: "operation-crash",
        collectedAt: new Date().toISOString(),
        sid,
        opId,
        hitsBefore,
        hitsAtKill,
        hitsAfterRestart,
        llmBefore: llmBefore.length,
        llmAtKill: llmAtKill.length,
        llmAfter: llmAfter.length,
        llmByPid: llm.bySession,
        killed: killedRaw,
        reconnect: rc,
        owner: { genID: owner.genID, reason: owner.reason, closedAt: owner.closedAt },
        operation: { opId: after.operation?.opId, outcome: after.operation?.outcome, code: after.operation?.code },
        receipt: { outcome: after.receipt?.outcome, replay: after.receipt?.replay, genID: after.receipt?.genID, closeReason: after.receipt?.closeReason },
        providers: providers.length,
        linkedProviders: linked.map((p) => ({ opId: p.opId, outcome: p.outcome, code: p.code, genID: p.genID })),
        abandonedProviders: abandonedProviders.length,
        cursorBefore: cursor,
        cursorAfter,
        reopenDom,
        llmRequests: readLlmRequests(scratch),
        llmMatrix: llm,
      },
      null,
      2,
    ),
  )
  console.log(`[probe operation-crash] proven hard crash sid=${sid} op=${opId} owner=crash hits=${hitsBefore}->${hitsAfterRestart} llm=${llmBefore.length}->${llmAfter.length} cursor=${cursor}->${cursorAfter}`)
}

export function _userOpOfForTest(snap: BackendSnapshot): string | undefined {
  const hit = userOpOf(snap)
  return hit?.opId
}
