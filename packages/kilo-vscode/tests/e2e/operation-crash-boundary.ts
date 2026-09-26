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
const CMD_KILL_SERVER = "kilo-code.new.e2eFixture.killServer" as const
const CMD_KILL_SERVER_HARD = "kilo-code.new.e2eFixture.killServerHard" as const
const CMD_RECONNECT_SERVER = "kilo-code.new.e2eFixture.reconnectServer" as const
const CMD_LLM_REQUESTS = "kilo-code.new.e2eFixture.llmRequests" as const
const CMD_LLM_RESET = "kilo-code.new.e2eFixture.llmRequestsReset" as const
const CMD_OPS = "kilo-code.new.e2eFixture.privateObservationOperations" as const
const CMD_RECENT = "kilo-code.new.e2eFixture.agentManagerRecentOperations" as const
const CMD_FETCH_RECENT = "kilo-code.new.e2eFixture.agentManagerFetchRecentOps" as const
const CMD_REFRESH = "kilo-code.new.e2eFixture.agentManagerRefreshForFixture" as const
const CMD_NOTIFICATIONS = "kilo-code.new.e2eFixture.privateObservationNotifications" as const
const CMD_PRIVATE_PEER_STATUS = "kilo-code.new.e2eFixture.privatePeerStatus" as const
const CMD_PROD_STATUS = "kilo-code.new.e2eFixture.privateObservationStatus" as const
const CMD_PROD_SNAPSHOT = "kilo-code.new.e2eFixture.privateObservationSnapshot" as const
const CMD_PROD_READ = "kilo-code.new.e2eFixture.privateObservationRead" as const
const CMD_PROD_ACK = "kilo-code.new.e2eFixture.privateObservationAck" as const
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
    if (Date.now() > deadline) throw new Error(`operation-crash runner: timeout waiting for ${label}`)
    await sleep(200)
  }
}

async function waitContent(vscodeApi: typeof vscode, label: string): Promise<void> {
  try {
    await vscodeApi.commands.executeCommand(CMD_CONTENT_READY, 15_000)
  } catch (err) {
    throw new Error(`operation-crash runner: content-ready failed before ${label}: ${String(err)}`)
  }
}

async function handleCore(vscodeApi: typeof vscode, scratch: string, snap: number): Promise<number> {
  let next = snap
  const req = join(scratch, `oc-snap-${next}-request`)
  if (existsSync(req)) {
    const snapshot = await vscodeApi.commands.executeCommand(CMD_SNAPSHOT)
    writeFileSync(join(scratch, `oc-snap-${next}.json`), JSON.stringify(snapshot, null, 2))
    next += 1
  }
  const cstate = join(scratch, "oc-cstate-request")
  if (existsSync(cstate)) {
    rmSync(cstate)
    const state = await vscodeApi.commands.executeCommand(CMD_CANONICAL_STATE)
    writeFileSync(join(scratch, "oc-cstate.json"), JSON.stringify(state, null, 2))
  }
  const credSeed = join(scratch, "oc-credseed-request")
  if (existsSync(credSeed)) {
    rmSync(credSeed)
    try {
      const seeded = await vscodeApi.commands.executeCommand(CMD_SEED_CREDENTIAL)
      writeFileSync(join(scratch, "oc-credential.json"), JSON.stringify(seeded, null, 2))
    } catch {
      writeFileSync(join(scratch, "oc-credential.json"), JSON.stringify({ ok: false }, null, 2))
    }
  }
  const kill = join(scratch, "oc-kill-request")
  if (existsSync(kill)) {
    rmSync(kill)
    const killed = await vscodeApi.commands.executeCommand(CMD_KILL_SERVER)
    writeFileSync(join(scratch, "oc-kill.json"), JSON.stringify(killed, null, 2))
  }
  const killHard = join(scratch, "oc-kill-hard-request")
  if (existsSync(killHard)) {
    rmSync(killHard)
    const killed = await vscodeApi.commands.executeCommand(CMD_KILL_SERVER_HARD)
    writeFileSync(join(scratch, "oc-kill-hard.json"), JSON.stringify(killed, null, 2))
  }
  const rc = join(scratch, "oc-reconnect-request")
  if (existsSync(rc)) {
    rmSync(rc)
    const obs = await vscodeApi.commands.executeCommand(CMD_RECONNECT_SERVER)
    writeFileSync(join(scratch, "oc-reconnect.json"), JSON.stringify(obs, null, 2))
  }
  return next
}

async function handleOps(vscodeApi: typeof vscode, scratch: string): Promise<void> {
  const opsReq = join(scratch, "oc-ops-request")
  if (existsSync(opsReq)) {
    const raw = readFileSync(opsReq, "utf8")
    rmSync(opsReq)
    const payload = JSON.parse(raw) as { directory: string; sessionId: string; limit?: number }
    const res = await vscodeApi.commands.executeCommand(CMD_OPS, {
      directory: payload.directory,
      sessionId: payload.sessionId,
      limit: payload.limit ?? 1,
    })
    writeFileSync(join(scratch, "oc-ops.json"), JSON.stringify(res, null, 2))
  }
  const recentReq = join(scratch, "oc-recent-request")
  if (existsSync(recentReq)) {
    const raw = readFileSync(recentReq, "utf8")
    rmSync(recentReq)
    const payload = JSON.parse(raw) as { sessionId?: string }
    const res = payload.sessionId
      ? await vscodeApi.commands.executeCommand(CMD_FETCH_RECENT, { sessionId: payload.sessionId })
      : await vscodeApi.commands.executeCommand(CMD_RECENT)
    writeFileSync(join(scratch, "oc-recent.json"), JSON.stringify(res, null, 2))
  }
  const refreshReq = join(scratch, "oc-refresh-request")
  if (existsSync(refreshReq)) {
    rmSync(refreshReq)
    const res = await vscodeApi.commands.executeCommand(CMD_REFRESH)
    writeFileSync(join(scratch, "oc-refresh.json"), JSON.stringify(res ?? { ok: true }, null, 2))
  }
  const notifReq = join(scratch, "oc-notif-request")
  if (existsSync(notifReq)) {
    rmSync(notifReq)
    const res = await vscodeApi.commands.executeCommand(CMD_NOTIFICATIONS)
    writeFileSync(join(scratch, "oc-notif.json"), JSON.stringify(res, null, 2))
  }
  const statusReq = join(scratch, "oc-status-request")
  if (existsSync(statusReq)) {
    rmSync(statusReq)
    const res = await vscodeApi.commands.executeCommand(CMD_PROD_STATUS)
    writeFileSync(join(scratch, "oc-status.json"), JSON.stringify(res, null, 2))
  }
}

async function handleObs(vscodeApi: typeof vscode, scratch: string): Promise<void> {
  const snapReq = join(scratch, "oc-obs-snapshot-request")
  if (existsSync(snapReq)) {
    rmSync(snapReq)
    const res = await vscodeApi.commands.executeCommand(CMD_PROD_SNAPSHOT)
    writeFileSync(join(scratch, "oc-obs-snapshot.json"), JSON.stringify(res, null, 2))
  }
  const readReq = join(scratch, "oc-obs-read-request")
  if (existsSync(readReq)) {
    const raw = readFileSync(readReq, "utf8")
    rmSync(readReq)
    const payload = JSON.parse(raw) as { cursor: number }
    const res = await vscodeApi.commands.executeCommand(CMD_PROD_READ, payload.cursor)
    writeFileSync(join(scratch, "oc-obs-read.json"), JSON.stringify(res, null, 2))
  }
  const ackReq = join(scratch, "oc-obs-ack-request")
  if (existsSync(ackReq)) {
    const raw = readFileSync(ackReq, "utf8")
    rmSync(ackReq)
    const payload = JSON.parse(raw) as { cursor: number }
    const res = await vscodeApi.commands.executeCommand(CMD_PROD_ACK, payload.cursor)
    writeFileSync(join(scratch, "oc-obs-ack.json"), JSON.stringify(res, null, 2))
  }
}

function parseReopenSid(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { sessionId?: unknown; sid?: unknown; sessionID?: unknown }
    const cand = parsed.sessionId ?? parsed.sid ?? parsed.sessionID
    if (typeof cand === "string" && cand.length > 0) return cand
  } catch {
    return undefined
  }
  return undefined
}

async function discoverCrashSid(vscodeApi: typeof vscode): Promise<string | undefined> {
  try {
    const snap = (await vscodeApi.commands.executeCommand(CMD_SNAPSHOT)) as {
      messages?: Record<string, Array<{ role?: string; id?: string; text?: string }>>
    }
    for (const [id, msgs] of Object.entries(snap.messages ?? {})) {
      for (const m of msgs ?? []) {
        if (m.role === "user" && typeof m.id === "string" && m.id.startsWith("msg") && (m.text ?? "").includes("E2E_CRASH_HOLD")) return id
      }
    }
  } catch {}
  return undefined
}

async function reopenPanel(vscodeApi: typeof vscode): Promise<void> {
  const tab = vscodeApi.window.tabGroups.all.flatMap((group) => group.tabs).find(isTab)
  if (!tab) throw new Error("operation-crash runner: Agent Manager tab not found for reopen boundary")
  await vscodeApi.window.tabGroups.close(tab, true)
  await waitFor(async () => (tabOpen() ? undefined : "closed"), 30_000, "operation-crash panel disposed")
  await vscodeApi.commands.executeCommand(CMD_OPEN)
  await waitFor(async () => (tabOpen() ? true : undefined), 30_000, "operation-crash reopened panel")
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
    "operation-crash reopened readiness",
  )
  await waitContent(vscodeApi, "operation-crash reopen")
  await vscodeApi.commands.executeCommand(CMD_SETTLE)
}

async function projectCrashTab(vscodeApi: typeof vscode, scratch: string, sid: string): Promise<void> {
  let title = `E2E Crash ${sid.slice(0, 8)}`
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
  await waitContent(vscodeApi, "operation-crash reopen projection")
  await vscodeApi.commands.executeCommand(CMD_POST, { type: "agentManager.sessionAdded", sessionId: sid })
  await vscodeApi.commands.executeCommand(CMD_POST, { type: "sessionCreated", session })
  await vscodeApi.commands.executeCommand(CMD_SETTLE)
  writeFileSync(
    join(scratch, "oc-reopen-projection.json"),
    JSON.stringify(
      { sessionId: sid, method: "production-loopback", readyContentReady: true, posted: ["agentManager.sessionAdded", "sessionCreated"], settled: true, session },
      null,
      2,
    ),
  )
}

async function handleReopen(vscodeApi: typeof vscode, scratch: string, fixtureId: string): Promise<void> {
  const reopen = join(scratch, "oc-reopen-request")
  if (!existsSync(reopen)) return
  const raw = readFileSync(reopen, "utf8")
  rmSync(reopen)
  const sid = parseReopenSid(raw) ?? (await discoverCrashSid(vscodeApi))
  if (!sid) throw new Error("operation-crash runner: reopen request missing sessionId for tab projection")
  await reopenPanel(vscodeApi)
  await projectCrashTab(vscodeApi, scratch, sid)
  writeFileSync(join(scratch, "oc-reopen-ready"), fixtureId)
}

export async function serviceOperationCrashBoundary(
  vscodeApi: typeof vscode,
  scratch: string,
  fixtureId: string,
): Promise<void> {
  await vscodeApi.commands.executeCommand(CMD_LLM_RESET)
  {
    const start = Date.now()
    let attempts = 0
    let available = false
    const deadline = start + 30_000
    while (Date.now() < deadline) {
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
    writeFileSync(join(scratch, "oc-peer-wait.json"), JSON.stringify({ attempts, available, elapsedMs: Date.now() - start }, null, 2))
    if (!available) {
      writeFileSync(join(scratch, "oc-credential.json"), JSON.stringify({ ok: false, reason: "private transport unavailable" }, null, 2))
      throw new Error("operation-crash runner: private transport unavailable before seedCredential")
    }
  }
  try {
    const seeded = await vscodeApi.commands.executeCommand(CMD_SEED_CREDENTIAL)
    writeFileSync(join(scratch, "oc-credential.json"), JSON.stringify(seeded, null, 2))
  } catch {
    writeFileSync(join(scratch, "oc-credential.json"), JSON.stringify({ ok: false }, null, 2))
    throw new Error("operation-crash runner: seedCredential failed")
  }
  await vscodeApi.commands.executeCommand(CMD_SETTLE)
  writeFileSync(join(scratch, "operation-crash-ready"), fixtureId)
  let snap = 1
  const deadline = Date.now() + SERVICE_BUDGET
  while (Date.now() < deadline) {
    if (existsSync(join(scratch, "done"))) break
    snap = await handleCore(vscodeApi, scratch, snap)
    await handleOps(vscodeApi, scratch)
    await handleObs(vscodeApi, scratch)
    await handleReopen(vscodeApi, scratch, fixtureId)
    await sleep(200)
  }
  try {
    const result = (await vscodeApi.commands.executeCommand(CMD_LLM_REQUESTS)) as {
      records: unknown[]
      file: string
    } | null
    writeFileSync(
      join(scratch, "llm-requests-operation-crash.json"),
      JSON.stringify(
        { scenario: "operation-crash", collectedAt: new Date().toISOString(), file: result?.file ?? null, records: result?.records ?? [] },
        null,
        2,
      ),
    )
  } catch {
    writeFileSync(
      join(scratch, "llm-requests-operation-crash.json"),
      JSON.stringify({ scenario: "operation-crash", records: [], error: "llmRequests unavailable" }, null, 2),
    )
  }
}
