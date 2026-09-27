import * as vscode from "vscode"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const CMD_POST = "kilo-code.new.e2eFixture.postToAgentManager" as const
const CMD_SETTLE = "kilo-code.new.e2eFixture.settleSessions" as const
const CMD_READY = "kilo-code.new.e2eFixture.agentManagerReady" as const
const CMD_CONTENT_READY = "kilo-code.new.e2eFixture.agentManagerContentReady" as const
const CMD_OPEN = "kilo-code.new.agentManagerOpen" as const
const CMD_SNAPSHOT = "kilo-code.new.e2eFixture.backendSnapshot" as const
const CMD_CANONICAL_STATE = "kilo-code.new.e2eFixture.canonicalState" as const
const CMD_SEED_CREDENTIAL = "kilo-code.new.e2eFixture.seedCredential" as const
const CMD_PRIVATE_EVENT_CLOSE_PEER = "kilo-code.new.e2eFixture.privateEventClosePeer" as const
const CMD_LLM_REQUESTS = "kilo-code.new.e2eFixture.llmRequests" as const
const CMD_LLM_RESET = "kilo-code.new.e2eFixture.llmRequestsReset" as const
const CMD_ABORT = "kilo-code.new.e2eFixture.abortAttempts" as const
const CMD_ABORT_RESET = "kilo-code.new.e2eFixture.abortAttemptsReset" as const
const CMD_AUTHORITY = "kilo-code.new.e2eFixture.privateSessionAuthority" as const
const CMD_PROD_STATUS = "kilo-code.new.e2eFixture.privateObservationStatus" as const
const CMD_PROD_SNAPSHOT = "kilo-code.new.e2eFixture.privateObservationSnapshot" as const
const CMD_OPS = "kilo-code.new.e2eFixture.privateObservationOperations" as const
const CMD_PRIVATE_PEER_STATUS = "kilo-code.new.e2eFixture.privatePeerStatus" as const
const AM_VIEW_TYPE = "kilo-code.new.AgentManagerPanel"

const SERVICE_BUDGET = 900_000
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function isTab(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(AM_VIEW_TYPE)
}

function tabOpen(): boolean {
  return vscode.window.tabGroups.all.some((group) => group.tabs.some(isTab))
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`streaming-observation runner: timeout waiting for ${label}`)
    await sleep(200)
  }
}

async function waitContent(vscodeApi: typeof vscode, label: string): Promise<void> {
  try {
    await vscodeApi.commands.executeCommand(CMD_CONTENT_READY, 15_000)
  } catch (err) {
    throw new Error(`streaming-observation runner: content-ready failed before ${label}: ${String(err)}`)
  }
}

function parseSid(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { sessionId?: unknown; sid?: unknown; sessionID?: unknown }
    const cand = parsed.sessionId ?? parsed.sid ?? parsed.sessionID
    if (typeof cand === "string" && cand.length > 0) return cand
  } catch {
    return undefined
  }
  return undefined
}

async function discoverSid(vscodeApi: typeof vscode): Promise<string | undefined> {
  try {
    const snap = (await vscodeApi.commands.executeCommand(CMD_SNAPSHOT)) as {
      messages?: Record<string, Array<{ role?: string; id?: string; text?: string }>>
    }
    for (const [id, msgs] of Object.entries(snap.messages ?? {})) {
      for (const m of msgs ?? []) {
        if (m.role === "user" && typeof m.id === "string" && m.id.startsWith("msg") && (m.text ?? "").includes("E2E_STREAM_OBS")) return id
      }
    }
  } catch {}
  return undefined
}

async function reopenPanel(vscodeApi: typeof vscode): Promise<void> {
  const tab = vscodeApi.window.tabGroups.all.flatMap((group) => group.tabs).find(isTab)
  if (!tab) throw new Error("streaming-observation runner: Agent Manager tab not found for reopen")
  await vscodeApi.window.tabGroups.close(tab, true)
  await waitFor(async () => (tabOpen() ? undefined : "closed"), 30_000, "streaming-observation panel disposed")
  await vscodeApi.commands.executeCommand(CMD_OPEN)
  await waitFor(async () => (tabOpen() ? true : undefined), 30_000, "streaming-observation reopened panel")
  await waitFor(
    async () => {
      try {
        const ready = await vscodeApi.commands.executeCommand<boolean>(CMD_READY)
        return ready ? true : undefined
      } catch {
        return undefined
      }
    },
    60_000,
    "streaming-observation reopened readiness",
  )
  await waitContent(vscodeApi, "streaming-observation reopen")
  await vscodeApi.commands.executeCommand(CMD_SETTLE)
}

async function projectTab(vscodeApi: typeof vscode, scratch: string, sid: string): Promise<void> {
  let title = `E2E Streaming ${sid.slice(0, 8)}`
  let created = new Date().toISOString()
  let updated = created
  try {
    const snap = (await vscodeApi.commands.executeCommand(CMD_SNAPSHOT)) as {
      sessions?: Array<{ id?: string; title?: string; createdAt?: number; updatedAt?: number }>
    }
    const hit = (snap.sessions ?? []).find((s) => s.id === sid)
    if (hit) {
      if (typeof hit.title === "string" && hit.title.length > 0) title = hit.title
      if (typeof hit.createdAt === "number") created = new Date(hit.createdAt).toISOString()
      updated = typeof hit.updatedAt === "number" ? new Date(hit.updatedAt).toISOString() : created
    }
  } catch {}
  const session = { id: sid, title, createdAt: created, updatedAt: updated, parentID: null, revert: null, summary: null }
  await vscodeApi.commands.executeCommand(CMD_READY)
  await waitContent(vscodeApi, "streaming-observation reopen projection")
  await vscodeApi.commands.executeCommand(CMD_POST, { type: "agentManager.sessionAdded", sessionId: sid })
  await vscodeApi.commands.executeCommand(CMD_POST, { type: "sessionCreated", session })
  await vscodeApi.commands.executeCommand(CMD_SETTLE)
  writeFileSync(join(scratch, "so-reopen-projection.json"), JSON.stringify({ sessionId: sid, settled: true, session }, null, 2))
}

async function waitPrivatePeer(vscodeApi: typeof vscode, scratch: string): Promise<void> {
  const start = Date.now()
  let attempts = 0
  let available = false
  while (Date.now() - start < 30_000) {
    attempts += 1
    try {
      const stat = (await vscodeApi.commands.executeCommand(CMD_PRIVATE_PEER_STATUS)) as {
        private: { available: boolean }
      }
      if (stat?.private?.available) {
        available = true
        break
      }
    } catch {}
    await sleep(500)
  }
  writeFileSync(join(scratch, "so-peer-wait.json"), JSON.stringify({ attempts, available, elapsedMs: Date.now() - start }, null, 2))
  if (!available) {
    writeFileSync(join(scratch, "so-credential.json"), JSON.stringify({ ok: false, reason: "private transport unavailable" }, null, 2))
    throw new Error("streaming-observation runner: private transport unavailable before seedCredential")
  }
}

async function seedWithRetry(vscodeApi: typeof vscode, scratch: string, rounds: number): Promise<void> {
  let ok = false
  let last = ""
  for (let i = 0; i < rounds && !ok; i++) {
    try {
      const seeded = await vscodeApi.commands.executeCommand(CMD_SEED_CREDENTIAL)
      writeFileSync(join(scratch, "so-credential.json"), JSON.stringify(seeded, null, 2))
      ok = (seeded as { ok?: unknown }).ok === true
      if (!ok) last = JSON.stringify(seeded).slice(0, 300)
    } catch (err) {
      last = String(err).slice(0, 300)
    }
    if (!ok) await sleep(1_000)
  }
  if (!ok) throw new Error(`streaming-observation runner: seedCredential failed after retries: ${last}`)
}

async function handleSnapshot(vscodeApi: typeof vscode, scratch: string, next: number): Promise<number> {
  const req = join(scratch, `so-snap-${next}-request`)
  if (!existsSync(req)) return next
  const snapshot = await vscodeApi.commands.executeCommand(CMD_SNAPSHOT)
  writeFileSync(join(scratch, `so-snap-${next}.json`), JSON.stringify(snapshot, null, 2))
  return next + 1
}

async function handleOps(vscodeApi: typeof vscode, scratch: string): Promise<void> {
  const opsReq = join(scratch, "so-ops-request")
  if (!existsSync(opsReq)) return
  const raw = readFileSync(opsReq, "utf8")
  rmSync(opsReq)
  let sid: string | undefined
  let limit = 1
  try {
    const parsed = JSON.parse(raw) as { sessionId?: unknown; limit?: unknown }
    if (typeof parsed.sessionId === "string" && parsed.sessionId.length > 0) sid = parsed.sessionId
    if (typeof parsed.limit === "number" && Number.isInteger(parsed.limit) && parsed.limit >= 1 && parsed.limit <= 20) {
      limit = parsed.limit
    }
  } catch {
    sid = undefined
  }
  if (typeof sid !== "string" || sid.length === 0) sid = await discoverSid(vscodeApi)
  const directory = (() => {
    const ws = vscodeApi.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (ws) {
      try {
        return require("node:fs").realpathSync(ws)
      } catch {
        return ws
      }
    }
    return join(scratch, "workspace")
  })()
  const res = await vscodeApi.commands.executeCommand(CMD_OPS, { directory, sessionId: sid, limit })
  writeFileSync(join(scratch, "so-ops.json"), JSON.stringify(res, null, 2))
}

async function handleSimple(vscodeApi: typeof vscode, scratch: string): Promise<void> {
  const cstate = join(scratch, "so-cstate-request")
  if (existsSync(cstate)) {
    rmSync(cstate)
    const state = await vscodeApi.commands.executeCommand(CMD_CANONICAL_STATE)
    writeFileSync(join(scratch, "so-cstate.json"), JSON.stringify(state, null, 2))
  }
  const credSeed = join(scratch, "so-credseed-request")
  if (existsSync(credSeed)) {
    rmSync(credSeed)
    await seedWithRetry(vscodeApi, scratch, 3)
  }
  const conn = join(scratch, "so-fdconn-request")
  if (existsSync(conn)) {
    rmSync(conn)
    const obs = await vscodeApi.commands.executeCommand(CMD_PRIVATE_EVENT_CLOSE_PEER)
    writeFileSync(join(scratch, "so-fdconn.json"), JSON.stringify(obs, null, 2))
  }
  const peerStatus = join(scratch, "so-peer-status-request")
  if (existsSync(peerStatus)) {
    rmSync(peerStatus)
    const res = await vscodeApi.commands.executeCommand(CMD_PRIVATE_PEER_STATUS)
    writeFileSync(join(scratch, "so-peer-status.json"), JSON.stringify(res, null, 2))
  }
  const snapReq = join(scratch, "so-obs-snapshot-request")
  if (existsSync(snapReq)) {
    rmSync(snapReq)
    const res = await vscodeApi.commands.executeCommand(CMD_PROD_SNAPSHOT)
    writeFileSync(join(scratch, "so-obs-snapshot.json"), JSON.stringify(res, null, 2))
  }
  const statusReq = join(scratch, "so-status-request")
  if (existsSync(statusReq)) {
    rmSync(statusReq)
    const res = await vscodeApi.commands.executeCommand(CMD_PROD_STATUS)
    writeFileSync(join(scratch, "so-status.json"), JSON.stringify(res, null, 2))
  }
  const abortReset = join(scratch, "so-abort-reset-request")
  if (existsSync(abortReset)) {
    rmSync(abortReset)
    const res = await vscodeApi.commands.executeCommand(CMD_ABORT_RESET)
    writeFileSync(join(scratch, "so-abort-reset.json"), JSON.stringify(res, null, 2))
  }
  const abortReq = join(scratch, "so-abort-request")
  if (existsSync(abortReq)) {
    rmSync(abortReq)
    const res = await vscodeApi.commands.executeCommand(CMD_ABORT)
    writeFileSync(join(scratch, "so-abort.json"), JSON.stringify(res, null, 2))
  }
  await handleOps(vscodeApi, scratch)
  const authReq = join(scratch, "so-authority-request")
  if (existsSync(authReq)) {
    const raw = readFileSync(authReq, "utf8")
    rmSync(authReq)
    let sid: string | undefined
    try {
      sid = (JSON.parse(raw) as { sessionId?: unknown }).sessionId as string | undefined
    } catch {
      sid = undefined
    }
    if (typeof sid !== "string" || sid.length === 0) sid = await discoverSid(vscodeApi)
    const res = await vscodeApi.commands.executeCommand(CMD_AUTHORITY, sid)
    writeFileSync(join(scratch, "so-authority.json"), JSON.stringify(res, null, 2))
  }
}

async function handleReopen(vscodeApi: typeof vscode, scratch: string, fixtureId: string): Promise<void> {
  const reopen = join(scratch, "so-reopen-request")
  if (!existsSync(reopen)) return
  const raw = readFileSync(reopen, "utf8")
  rmSync(reopen)
  const sid = parseSid(raw) ?? (await discoverSid(vscodeApi))
  if (!sid) throw new Error("streaming-observation runner: reopen request missing sessionId")
  // Production-only reopen: close + reopen the panel, then settle and let the
  // real backend session list rehydrate the tabs. No synthetic sessionCreated
  // post: projecting a create for an already-existing in-flight session risks
  // the backend treating it as a fresh create and cancelling the live turn
  // (cancelTree), which would make the boundary itself destroy accepted work.
  await reopenPanel(vscodeApi)
  writeFileSync(
    join(scratch, "so-reopen-projection.json"),
    JSON.stringify({ sessionId: sid, method: "production-rehydrate-only", projected: false, settled: true }, null, 2),
  )
  writeFileSync(join(scratch, "so-reopen-ready"), fixtureId)
}

async function writeLlmEvidence(vscodeApi: typeof vscode, scratch: string): Promise<void> {
  try {
    const result = (await vscodeApi.commands.executeCommand(CMD_LLM_REQUESTS)) as {
      records: unknown[]
      file: string
    } | null
    writeFileSync(
      join(scratch, "llm-requests-streaming-observation.json"),
      JSON.stringify(
        { scenario: "streaming-observation", collectedAt: new Date().toISOString(), file: result?.file ?? null, records: result?.records ?? [] },
        null,
        2,
      ),
    )
  } catch {
    writeFileSync(
      join(scratch, "llm-requests-streaming-observation.json"),
      JSON.stringify({ scenario: "streaming-observation", records: [], error: "llmRequests unavailable" }, null, 2),
    )
  }
}

export async function serviceStreamingObservationBoundary(
  vscodeApi: typeof vscode,
  scratch: string,
  fixtureId: string,
): Promise<void> {
  await vscodeApi.commands.executeCommand(CMD_LLM_RESET)
  await waitPrivatePeer(vscodeApi, scratch)
  await seedWithRetry(vscodeApi, scratch, 5)
  await vscodeApi.commands.executeCommand(CMD_SETTLE)
  writeFileSync(join(scratch, "streaming-observation-ready"), fixtureId)
  let snap = 1
  const deadline = Date.now() + SERVICE_BUDGET
  while (Date.now() < deadline) {
    if (existsSync(join(scratch, "done"))) break
    snap = await handleSnapshot(vscodeApi, scratch, snap)
    await handleSimple(vscodeApi, scratch)
    await handleReopen(vscodeApi, scratch, fixtureId)
    await sleep(200)
  }
  await writeLlmEvidence(vscodeApi, scratch)
}
