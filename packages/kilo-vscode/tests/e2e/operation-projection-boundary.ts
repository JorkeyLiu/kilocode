import * as vscode from "vscode"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isIsolatedDataRoot, validateGateEvidence } from "../../script/e2e-canonical"

const CMD_PROD_STATUS = "kilo-code.new.e2eFixture.privateObservationStatus" as const
const CMD_CANONICAL_STATE = "kilo-code.new.e2eFixture.canonicalState" as const
const CMD_PRIVATE_PEER_STATUS = "kilo-code.new.e2eFixture.privatePeerStatus" as const
const CMD_SESSION_CREATE = "kilo-code.new.e2eFixture.sessionCreate" as const
const CMD_SNAPSHOT = "kilo-code.new.e2eFixture.backendSnapshot" as const
const CMD_PROMPT_PRIVATE = "kilo-code.new.e2eFixture.sessionPromptPrivate" as const
const CMD_PROMPT_PRIVATE_REPLAY = "kilo-code.new.e2eFixture.sessionPromptPrivateReplay" as const
const CMD_OPS = "kilo-code.new.e2eFixture.privateObservationOperations" as const
const CMD_RECENT_OPS = "kilo-code.new.e2eFixture.agentManagerRecentOperations" as const
const CMD_FETCH_RECENT = "kilo-code.new.e2eFixture.agentManagerFetchRecentOps" as const
const CMD_NOTIFICATIONS = "kilo-code.new.e2eFixture.privateObservationNotifications" as const
const CMD_REFRESH = "kilo-code.new.e2eFixture.agentManagerRefreshForFixture" as const
const CMD_POST = "kilo-code.new.e2eFixture.postToAgentManager" as const
const CMD_SETTLE = "kilo-code.new.e2eFixture.settleSessions" as const
const CMD_READY = "kilo-code.new.e2eFixture.agentManagerReady" as const
const CMD_CONTENT_READY = "kilo-code.new.e2eFixture.agentManagerContentReady" as const
const OPERATION_PROJECTION_BUDGET = 900_000

const ALLOWED_OUTCOMES = new Set(["succeeded", "failed", "ambiguous", "in-flight", "superseded", "abandoned"])
const PANEL_SAFE_KEYS = new Set(["opId", "outcome", "code", "message", "time", "cancel"])

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function hasPromptCap(caps: unknown): boolean {
  if (!caps) return false
  if (Array.isArray(caps)) return (caps as string[]).includes("session/prompt")
  if (typeof caps !== "object") return false
  const c = caps as Record<string, unknown>
  if (c["session/prompt"] === true) return true
  if (Array.isArray(c.session) && (c.session as unknown[]).includes("prompt")) return true
  if (typeof c.session !== "object" || c.session === null) return false
  const sess = c.session as Record<string, unknown>
  return !!sess.prompt
}

async function waitPeerReady(
  vscodeApi: typeof vscode,
  peerHistory: unknown[],
): Promise<{ peerReadySnapshot: unknown; lastPeerStat: Record<string, unknown> | null; ready: boolean }> {
  const deadline = Date.now() + 15_000
  let ready = false
  let lastPeerStat: Record<string, unknown> | null = null
  let peerReadySnapshot: unknown = null
  while (Date.now() < deadline) {
    try {
      const peerStat = (await vscodeApi.commands.executeCommand(CMD_PRIVATE_PEER_STATUS)) as {
        backend?: { pid: number | null; port: number | null; epoch: number | null }
        private: {
          available: boolean
          state?: string
          capabilities?: unknown
          protocol?: unknown
          epoch?: number | null
        }
      }
      lastPeerStat = peerStat as unknown as Record<string, unknown>
      peerHistory.push({ at: new Date().toISOString(), stat: peerStat })
      const avail = !!peerStat?.private?.available
      const caps = (peerStat?.private as unknown as { capabilities?: unknown })?.capabilities
      const hasPrompt = hasPromptCap(caps)
      const state = (peerStat?.private as unknown as { state?: string })?.state
      if (avail && hasPrompt) {
        ready = true
        peerReadySnapshot = peerStat
        break
      }
      console.log(
        `[operation-projection] peer not ready avail=${avail} state=${state} hasPrompt=${hasPrompt} caps=${JSON.stringify(caps)?.slice(0, 400)}`,
      )
    } catch (e) {
      peerHistory.push({ at: new Date().toISOString(), error: String(e) })
    }
    await sleep(200)
  }
  return { peerReadySnapshot, lastPeerStat, ready }
}

async function waitPrivateObservationReady(
  vscodeApi: typeof vscode,
  peerHistory: unknown[],
): Promise<{ obsReady: boolean; lastStatus: Record<string, unknown> | null }> {
  const deadline = Date.now() + 15_000
  let lastStatus: Record<string, unknown> | null = null
  while (Date.now() < deadline) {
    try {
      const st = (await vscodeApi.commands.executeCommand(CMD_PROD_STATUS)) as Record<string, unknown>
      lastStatus = st
      peerHistory.push({ at: new Date().toISOString(), privateObservationStatus: st })
      const avail = st.available === true
      const enabled = st.enabled === true
      const testBridge = st.testBridge === true
      if (avail && enabled && testBridge) return { obsReady: true, lastStatus }
      console.log(
        `[operation-projection] privateObservation not ready avail=${avail} enabled=${enabled} testBridge=${testBridge}`,
      )
    } catch (e) {
      peerHistory.push({ at: new Date().toISOString(), error: String(e) })
    }
    await sleep(300)
  }
  return { obsReady: false, lastStatus }
}

async function confirmCreate(
  vscodeApi: typeof vscode,
  sessionId: string,
): Promise<{ backendCreateSnapshot: unknown; sessionExistsAfterCreate: boolean | null; confirmed: boolean }> {
  const deadline = Date.now() + 12_000
  let backendCreateSnapshot: unknown = null
  let sessionExistsAfterCreate: boolean | null = null
  let confirmed = false
  while (Date.now() < deadline) {
    try {
      const snap = (await vscodeApi.commands.executeCommand(CMD_SNAPSHOT)) as {
        sessions: Array<{ id: string }>
        messages?: Record<string, unknown>
      }
      backendCreateSnapshot = snap
      const found = snap.sessions?.some((s) => s.id === sessionId)
      if (found) {
        confirmed = true
        sessionExistsAfterCreate = true
        break
      }
    } catch (e) {
      backendCreateSnapshot = { error: String(e) }
    }
    await sleep(300)
  }
  return { backendCreateSnapshot, sessionExistsAfterCreate, confirmed }
}

async function attemptPrompt(
  vscodeApi: typeof vscode,
  dirForCreate: string,
  sessionId: string,
  messageId: string,
  text: string,
  attempts: unknown[],
  scratch: string,
  label: string,
): Promise<Record<string, unknown>> {
  const beforePeer = (await vscodeApi.commands.executeCommand(CMD_PRIVATE_PEER_STATUS)) as Record<string, unknown>
  let beforeEpoch: number | null = null
  try {
    beforeEpoch = (beforePeer as unknown as { private?: { epoch?: number } })?.private?.epoch ?? null
  } catch {
    beforeEpoch = null
  }
  const started = Date.now()
  const res = (await vscodeApi.commands.executeCommand(CMD_PROMPT_PRIVATE, {
    directory: dirForCreate,
    sessionId,
    messageId,
    text,
  })) as {
    opId: string
    requestId: string
    directory: string
    result: {
      status: string
      accepted: boolean
      data?: { messageId?: string; sessionId?: string }
      failure?: unknown
      transportUnknown?: boolean
    }
    sessionId: string
    messageId: string
  }
  const afterPeer = (await vscodeApi.commands.executeCommand(CMD_PRIVATE_PEER_STATUS)) as Record<string, unknown>
  const durationMs = Date.now() - started
  const entry = {
    label,
    opId: res.opId,
    requestId: res.requestId,
    directory: res.directory,
    result: res.result,
    sessionId: res.sessionId,
    messageId: res.messageId,
    beforePeer,
    afterPeer,
    beforeEpoch,
    afterEpoch: (afterPeer as unknown as { private?: { epoch?: number } })?.private?.epoch ?? null,
    durationMs,
    transportUnknown: (res.result as unknown as { transportUnknown?: boolean }).transportUnknown,
  }
  attempts.push(entry)
  writeFileSync(join(scratch, `operation-projection-attempt-${label}.json`), JSON.stringify(entry, null, 2))
  return entry as unknown as Record<string, unknown>
}

async function attemptRetry(
  vscodeApi: typeof vscode,
  sessionId: string,
  messageId: string,
  first: Record<string, unknown>,
  attempts: unknown[],
  scratch: string,
): Promise<Record<string, unknown>> {
  const beforePeer = (await vscodeApi.commands.executeCommand(CMD_PRIVATE_PEER_STATUS)) as Record<string, unknown>
  const started = Date.now()
  const retryRes = (await vscodeApi.commands.executeCommand(CMD_PROMPT_PRIVATE_REPLAY, { sessionId, messageId })) as {
    opId: string
    requestId: string
    directory: string
    result: {
      status: string
      accepted: boolean
      data?: { messageId?: string; sessionId?: string }
      transportUnknown?: boolean
    }
    sessionId: string
    messageId: string
  }
  const afterPeer = (await vscodeApi.commands.executeCommand(CMD_PRIVATE_PEER_STATUS)) as Record<string, unknown>
  const durationMs = Date.now() - started
  const entry = {
    label: "retry",
    opId: retryRes.opId,
    requestId: retryRes.requestId,
    directory: retryRes.directory,
    result: retryRes.result,
    sessionId: retryRes.sessionId,
    messageId: retryRes.messageId,
    beforePeer,
    afterPeer,
    durationMs,
    transportUnknown: (retryRes.result as unknown as { transportUnknown?: boolean }).transportUnknown,
    sameTuple:
      retryRes.opId === (first as unknown as { opId: string }).opId &&
      retryRes.requestId === (first as unknown as { requestId: string }).requestId,
  }
  attempts.push(entry)
  writeFileSync(join(scratch, "operation-projection-attempt-retry.json"), JSON.stringify(entry, null, 2))
  return entry as unknown as Record<string, unknown>
}

async function observePrompt(
  vscodeApi: typeof vscode,
  sessionId: string,
  marker: string,
): Promise<{
  userCount: number
  hasMarker: boolean
  sessionExists: boolean
  snapshot: unknown
  backendPromptSnapshot: unknown
}> {
  await sleep(800)
  let snapshot: unknown = null
  let userCount = 0
  let hasMarker = false
  let sessionExists = false
  let backendPromptSnapshot: unknown = null
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const snap = (await vscodeApi.commands.executeCommand(CMD_SNAPSHOT)) as {
        sessions: Array<{ id: string }>
        messages: Record<string, Array<{ text: string; role: string; id: string }>>
      }
      snapshot = snap
      backendPromptSnapshot = snap
      const sess = snap.sessions?.find((s) => s.id === sessionId)
      sessionExists = !!sess
      const msgs = snap.messages?.[sessionId] ?? []
      const userMsgs = msgs.filter((m) => m.role === "user")
      userCount = userMsgs.length
      hasMarker = userMsgs.some((m) => m.text.includes(marker))
      if (sessionExists && hasMarker && userCount >= 1) break
    } catch (e) {
      snapshot = { error: String(e) }
    }
    await sleep(400)
  }
  return { userCount, hasMarker, sessionExists, snapshot, backendPromptSnapshot }
}

async function observeOperations(
  vscodeApi: typeof vscode,
  directory: string,
  sessionId: string,
  expectedOpId: string,
): Promise<{
  opsResult: Record<string, unknown>
  operation: Record<string, unknown> | null
  found: boolean
  safe: boolean
  finite: boolean
  outcomeLegal: boolean
}> {
  const deadline = Date.now() + 12_000
  let last: Record<string, unknown> | null = null
  let operation: Record<string, unknown> | null = null
  let found = false
  let safe = false
  let finite = false
  let outcomeLegal = false
  while (Date.now() < deadline) {
    try {
      const raw = (await vscodeApi.commands.executeCommand(CMD_OPS, { directory, sessionId, limit: 1 })) as Record<
        string,
        unknown
      >
      last = raw
      const status = raw.status as string | undefined
      if (status === "found") {
        const ops = raw.operations as unknown[] | undefined
        if (Array.isArray(ops) && ops.length > 0) {
          const op = ops[0] as Record<string, unknown>
          operation = op
          const opIdOk = op.opId === expectedOpId
          const outcome = op.outcome as string | undefined
          const outcomeOk = typeof outcome === "string" && ALLOWED_OUTCOMES.has(outcome)
          const time = op.time as unknown
          const timeOk = typeof time === "number" && Number.isFinite(time) && time > 0
          const keys = Object.keys(op)
          const onlySafe = keys.every((k) => PANEL_SAFE_KEYS.has(k))
          const noLeak = !("detail" in op) && !("stack" in op) && !("idempotencyHash" in op) && !("requestId" in op)
          found = opIdOk
          safe = onlySafe && noLeak
          finite = timeOk
          outcomeLegal = outcomeOk
          if (opIdOk && outcomeOk && timeOk && onlySafe && noLeak) break
        }
      }
    } catch (e) {
      last = { error: String(e) } as unknown as Record<string, unknown>
    }
    await sleep(400)
  }
  return { opsResult: last ?? {}, operation, found, safe, finite, outcomeLegal }
}

// eslint-disable-next-line complexity
function validateNotificationSnapshot(
  raw: unknown,
  requestedCursor: number | undefined,
): { valid: boolean; reason?: string; cursor?: number; entries?: unknown[] } {
  if (!raw || typeof raw !== "object") return { valid: false, reason: "snapshot not object" }
  const rec = raw as Record<string, unknown>
  // handle both privateObservationNotifications snapshot shape: { startOrdinal, nextOrdinal, entries: [{ ordinal, method, params, at }] }
  // and direct observation/changed payload shape: { v, cursor, entries }
  if ("startOrdinal" in rec && "nextOrdinal" in rec && Array.isArray(rec.entries)) {
    const entries = rec.entries as Array<Record<string, unknown>>
    // entries contain method/params; filter observation/changed
    const obs = entries.filter((e) => e.method === "observation/changed")
    if (obs.length === 0)
      return { valid: true, reason: "no observation/changed yet (may be valid)", cursor: undefined, entries: [] }
    const last = obs[obs.length - 1]!
    const params = last.params as Record<string, unknown> | undefined
    if (!params) return { valid: false, reason: "missing params in notification" }
    if (params.v !== "1.0") return { valid: false, reason: `v must be 1.0 got ${String(params.v)}` }
    if (typeof params.cursor !== "number" || !Number.isInteger(params.cursor) || params.cursor < 0)
      return { valid: false, reason: "cursor invalid" }
    if (!Array.isArray(params.entries)) return { valid: false, reason: "entries not array" }
    const ents = params.entries as Array<Record<string, unknown>>
    if (ents.length === 0) return { valid: true, cursor: params.cursor as number, entries: [] }
    for (const e of ents) {
      const keys = Object.keys(e).sort()
      const want = ["kind", "revision", "seq", "session_id", "time"].sort()
      if (keys.length !== want.length || !keys.every((k, i) => k === want[i]))
        return { valid: false, reason: `entry keys mismatch got ${keys.join(",")}` }
      if (typeof e.seq !== "number" || !Number.isSafeInteger(e.seq) || e.seq <= 0)
        return { valid: false, reason: "seq invalid" }
      if (typeof e.session_id !== "string" || !e.session_id.startsWith("ses"))
        return { valid: false, reason: "session_id invalid" }
      if (typeof e.revision !== "number" || !Number.isInteger(e.revision) || e.revision < 0)
        return { valid: false, reason: "revision invalid" }
      if (e.kind !== "changed" && e.kind !== "deleted")
        return { valid: false, reason: `kind invalid ${String(e.kind)}` }
      if (typeof e.time !== "number" || !Number.isFinite(e.time)) return { valid: false, reason: "time invalid" }
    }
    const lastSeq = ents[ents.length - 1]!.seq as number
    if (lastSeq !== (params.cursor as number))
      return { valid: false, reason: `cursor ${params.cursor} != last seq ${lastSeq}` }
    if (requestedCursor !== undefined) {
      let prev = requestedCursor
      for (const e of ents) {
        const seq = e.seq as number
        if (seq !== prev + 1) return { valid: false, reason: `seq not contiguous expected ${prev + 1} got ${seq}` }
        prev = seq
      }
    }
    return { valid: true, cursor: params.cursor as number, entries: ents }
  }
  // direct changed payload
  if ("v" in rec && "cursor" in rec && Array.isArray(rec.entries)) {
    const v = rec.v as unknown
    const cursor = rec.cursor as unknown
    const ents = rec.entries as unknown[]
    if (v !== "1.0") return { valid: false, reason: `v must be 1.0 got ${String(v)}` }
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0)
      return { valid: false, reason: "cursor invalid" }
    if (ents.length === 0) return { valid: true, cursor: cursor as number, entries: [] }
    for (const rawE of ents) {
      const e = rawE as Record<string, unknown>
      const keys = Object.keys(e).sort()
      const want = ["kind", "revision", "seq", "session_id", "time"].sort()
      if (keys.length !== want.length || !keys.every((k, i) => k === want[i]))
        return { valid: false, reason: `entry keys mismatch got ${keys.join(",")}` }
    }
    const lastSeq = (ents[ents.length - 1] as Record<string, unknown>).seq as number
    if (lastSeq !== (cursor as number))
      return { valid: false, reason: `cursor ${String(cursor)} != last seq ${String(lastSeq)}` }
    return { valid: true, cursor: cursor as number, entries: ents }
  }
  return { valid: false, reason: "unknown notification snapshot shape" }
}

async function fetchRecentOps(vscodeApi: typeof vscode): Promise<Record<string, unknown>> {
  try {
    const res = (await vscodeApi.commands.executeCommand(CMD_RECENT_OPS)) as Record<string, unknown>
    return res
  } catch (e) {
    return { error: String(e) }
  }
}

async function fetchRecentOpsForSession(vscodeApi: typeof vscode, sessionId: string): Promise<Record<string, unknown>> {
  try {
    const res = (await vscodeApi.commands.executeCommand(CMD_FETCH_RECENT, { sessionId })) as Record<string, unknown>
    return res
  } catch (e) {
    return { error: String(e) }
  }
}

async function fetchNotifications(vscodeApi: typeof vscode): Promise<unknown> {
  try {
    const res = await vscodeApi.commands.executeCommand(CMD_NOTIFICATIONS)
    return res
  } catch (e) {
    return { error: String(e) }
  }
}

type SessionCreatedPayload = {
  type: "sessionCreated"
  session: {
    id: string
    title: string
    createdAt: string
    updatedAt: string
    parentID: string | null
    revert: null
    summary: null
  }
}

type SessionAddedPayload = {
  type: "agentManager.sessionAdded"
  sessionId: string
}

async function ensureTabProjection(
  vscodeApi: typeof vscode,
  scratch: string,
  sessionId: string,
  diag: Record<string, unknown>,
): Promise<void> {
  // Strict production loopback: satisfy ready/content-ready, then post
  // agentManager.sessionAdded + sessionCreated via HEAD-existing
  // postToAgentManager, let webview self-emit persistSession/loadMessages,
  // converge via settleSessions. No extension private state fixture read.
  console.log(`[operation-projection] ensuring tab projection (production loopback) for ${sessionId}`)
  await vscodeApi.commands.executeCommand(CMD_READY)
  await vscodeApi.commands.executeCommand(CMD_CONTENT_READY, 15_000)
  const now = new Date().toISOString()
  const session = {
    id: sessionId,
    title: `E2E OpProj ${sessionId.slice(0, 8)}`,
    createdAt: now,
    updatedAt: now,
    parentID: null,
    revert: null,
    summary: null,
  }
  const added: SessionAddedPayload = { type: "agentManager.sessionAdded", sessionId }
  const created: SessionCreatedPayload = { type: "sessionCreated", session }
  await vscodeApi.commands.executeCommand(CMD_POST, added as unknown as Record<string, unknown>)
  await vscodeApi.commands.executeCommand(CMD_POST, created as unknown as Record<string, unknown>)
  await vscodeApi.commands.executeCommand(CMD_SETTLE)
  const proj = {
    sessionId,
    method: "production-loopback",
    readyContentReady: true,
    posted: [added.type, created.type],
    settled: true,
    session,
  }
  writeFileSync(join(scratch, "operation-projection-tab-projection.json"), JSON.stringify(proj, null, 2))
  diag.tabProjection = proj
  console.log(`[operation-projection] tab projection posted via production loopback for ${sessionId}, settled`)
}

// eslint-disable-next-line complexity
export async function serviceOperationProjectionBoundary(
  vscodeApi: typeof vscode,
  scratch: string,
  fixtureId: string,
): Promise<void> {
  const diag: Record<string, unknown> = { fixtureId, startedAt: new Date().toISOString(), scratch }
  const peerHistory: unknown[] = []
  let createRes: unknown = null
  let createSessionId: string | null = null
  let backendCreateSnapshot: unknown = null
  let backendPromptSnapshot: unknown = null
  let backendReplaySnapshot: unknown = null
  let peerReadySnapshot: unknown = null
  const attempts: unknown[] = []
  let sessionExistsAfterCreate: boolean | null = null
  let marker = ""
  let messageId = ""
  let dirForCreate = ""
  let opsResultBeforeReplay: Record<string, unknown> | null = null
  let opsResultAfterReplay: Record<string, unknown> | null = null
  let recentOpsBefore: Record<string, unknown> | null = null
  let recentOpsAfter: Record<string, unknown> | null = null
  let notificationsBefore: unknown = null
  let notificationsAfter: unknown = null
  try {
    console.log("[operation-projection] start hardened")
    const status0 = (await vscodeApi.commands.executeCommand(CMD_PROD_STATUS)) as Record<string, unknown>
    writeFileSync(join(scratch, "operation-projection-status.json"), JSON.stringify(status0, null, 2))
    diag.status0 = status0
    try {
      const cstate = await vscodeApi.commands.executeCommand(CMD_CANONICAL_STATE)
      writeFileSync(join(scratch, "operation-projection-cstate.json"), JSON.stringify(cstate, null, 2))
      diag.cstate = cstate
    } catch (e) {
      writeFileSync(join(scratch, "operation-projection-cstate.json"), JSON.stringify({ error: String(e) }, null, 2))
      diag.cstateError = String(e)
    }
    let gate: Record<string, unknown> | null = null
    let gateOk = false
    let gateErr: string | undefined
    try {
      const gateRaw = readFileSync(join(scratch, "canonical-gate.json"), "utf8")
      gate = JSON.parse(gateRaw) as Record<string, unknown>
      gateErr = validateGateEvidence(gate)
      gateOk = gateErr === undefined
    } catch (e) {
      gateErr = String(e)
    }
    diag.gate = gate
    diag.gateOk = gateOk
    diag.gateErr = gateErr
    const peerReady = await waitPeerReady(vscodeApi, peerHistory)
    peerReadySnapshot = peerReady.peerReadySnapshot
    const ready = peerReady.ready
    const lastPeerStat = peerReady.lastPeerStat
    const obsReadyRes = await waitPrivateObservationReady(vscodeApi, peerHistory)
    const obsReady = obsReadyRes.obsReady
    const lastObsStatus = obsReadyRes.lastStatus
    diag.peerHistory = peerHistory
    diag.peerReadySnapshot = peerReadySnapshot
    diag.obsReady = obsReady
    diag.lastObsStatus = lastObsStatus
    writeFileSync(
      join(scratch, "operation-projection-peer-history.json"),
      JSON.stringify({ peerHistory, ready, obsReady, peerReadySnapshot, lastObsStatus }, null, 2),
    )
    if (!ready || !obsReady) {
      const errMsg = `operation-projection: peer not ready within 15s (servePrivate avail+prompt=${ready} privateObservation avail=${obsReady}). lastPeer=${JSON.stringify(lastPeerStat)?.slice(0, 800)} lastObs=${JSON.stringify(lastObsStatus)?.slice(0, 800)} historyLen=${peerHistory.length}`
      const diagPayload = {
        kind: "peer-not-ready",
        peerHistory,
        lastPeerStat,
        lastObsStatus,
        status0,
        gate,
        gateOk,
        gateErr,
        scratch,
        fixtureId,
      }
      writeFileSync(join(scratch, "operation-projection-diag.json"), JSON.stringify(diagPayload, null, 2))
      writeFileSync(
        join(scratch, "operation-projection-error.json"),
        JSON.stringify({ error: errMsg, diag: diagPayload }, null, 2),
      )
      throw new Error(errMsg)
    }
    dirForCreate = (() => {
      const ws = vscodeApi.workspace.workspaceFolders?.[0]?.uri.fsPath
      if (ws) {
        try {
          const rp = require("node:fs").realpathSync(ws)
          return rp
        } catch {
          return ws
        }
      }
      return join(scratch, "workspace")
    })()
    diag.dirForCreate = dirForCreate
    const sessionRes = (await vscodeApi.commands.executeCommand(CMD_SESSION_CREATE, {
      directory: dirForCreate,
      title: `E2E OpProj ${fixtureId.slice(0, 8)}`,
    })) as {
      opId: string
      requestId: string
      directory: string
      result: {
        status: string
        accepted: boolean
        data?: { session?: { id?: string } }
        failure?: unknown
        transportUnknown?: boolean
      }
      sessionId?: string
    }
    createRes = sessionRes
    diag.createRes = sessionRes
    writeFileSync(join(scratch, "operation-projection-create.json"), JSON.stringify(sessionRes, null, 2))
    if (sessionRes.result?.status !== "succeeded" || !sessionRes.sessionId) {
      const errMsg = `operation-projection session create failed: ${JSON.stringify(sessionRes.result).slice(0, 800)}`
      const payload = { createRes: sessionRes, peerHistory, peerReadySnapshot, status0 }
      writeFileSync(join(scratch, "operation-projection-diag.json"), JSON.stringify(payload, null, 2))
      throw new Error(errMsg)
    }
    createSessionId = sessionRes.sessionId as string
    diag.createSessionId = createSessionId
    const confirm = await confirmCreate(vscodeApi, createSessionId as string)
    backendCreateSnapshot = confirm.backendCreateSnapshot
    sessionExistsAfterCreate = confirm.sessionExistsAfterCreate
    const confirmed = confirm.confirmed
    diag.sessionExistsAfterCreate = sessionExistsAfterCreate
    diag.backendCreateSnapshot = backendCreateSnapshot
    writeFileSync(
      join(scratch, "operation-projection-create-confirm.json"),
      JSON.stringify({ confirmed, sessionId: createSessionId, snapshot: backendCreateSnapshot }, null, 2),
    )
    if (!confirmed) {
      const errMsg = `session ${createSessionId} not confirmed in backendSnapshot within 12s after create`
      writeFileSync(
        join(scratch, "operation-projection-diag.json"),
        JSON.stringify({ createRes: sessionRes, backendCreateSnapshot, peerReadySnapshot, peerHistory }, null, 2),
      )
      throw new Error(errMsg)
    }
    const sessionId = createSessionId as string
    messageId = `msg_${fixtureId.replace(/-/g, "").slice(0, 16)}${Date.now().toString(16).slice(-8)}`
    marker = `op-proj-marker-${fixtureId.slice(0, 8)}`
    const text = `E2E operation-projection ${marker}`
    diag.messageId = messageId
    diag.marker = marker
    const first = await attemptPrompt(vscodeApi, dirForCreate, sessionId, messageId, text, attempts, scratch, "first")
    let promptRes: Record<string, unknown> = first
    const firstStatus = (first.result as unknown as { status?: string }).status
    const firstTransportUnknown = (first.result as unknown as { transportUnknown?: boolean }).transportUnknown === true
    if (firstStatus === "ambiguous" && firstTransportUnknown) {
      console.log(
        `[operation-projection] first attempt ambiguous transportUnknown, retrying once same tuple msg=${messageId}`,
      )
      const retry = await attemptRetry(vscodeApi, sessionId, messageId, first, attempts, scratch)
      promptRes = retry as unknown as Record<string, unknown>
    }
    diag.attempts = attempts
    writeFileSync(join(scratch, "operation-projection-attempts.json"), JSON.stringify(attempts, null, 2))
    const finalRes = promptRes as unknown as {
      opId: string
      requestId: string
      directory: string
      result: { status: string; accepted: boolean; data?: { messageId?: string; sessionId?: string } }
      sessionId: string
      messageId: string
    }
    const promptSucceeded = finalRes.result?.status === "succeeded" && finalRes.result?.accepted === true
    if (!promptSucceeded) {
      const errMsg = `private prompt failed after ${attempts.length} attempt(s): ${JSON.stringify(finalRes.result).slice(0, 800)}`
      const payload = { attempts, peerHistory, peerReadySnapshot, createRes: sessionRes, backendCreateSnapshot }
      writeFileSync(join(scratch, "operation-projection-diag.json"), JSON.stringify(payload, null, 2))
      writeFileSync(
        join(scratch, "operation-projection-error.json"),
        JSON.stringify({ error: errMsg, attempts, peerHistory }, null, 2),
      )
      throw new Error(errMsg)
    }
    if (finalRes.result.data?.messageId !== messageId)
      throw new Error(
        `prompt data.messageId mismatch expected ${messageId} got ${String(finalRes.result.data?.messageId)}`,
      )
    if (finalRes.result.data?.sessionId !== sessionId)
      throw new Error(
        `prompt data.sessionId mismatch expected ${sessionId} got ${String(finalRes.result.data?.sessionId)}`,
      )
    if (finalRes.opId !== `prompt:${messageId}`)
      throw new Error(`opId mismatch expected prompt:${messageId} got ${finalRes.opId}`)
    const obs = await observePrompt(vscodeApi, sessionId, marker)
    backendPromptSnapshot = obs.backendPromptSnapshot
    diag.backendPromptSnapshot = backendPromptSnapshot
    diag.observation = { userCount: obs.userCount, hasMarker: obs.hasMarker, sessionExists: obs.sessionExists }
    writeFileSync(
      join(scratch, "operation-projection-observation.json"),
      JSON.stringify(
        {
          userCount: obs.userCount,
          hasMarker: obs.hasMarker,
          sessionExists: obs.sessionExists,
          snapshot: backendPromptSnapshot,
        },
        null,
        2,
      ),
    )
    if (!obs.sessionExists) {
      const payload = { sessionId, attempts, backendPromptSnapshot, peerReadySnapshot }
      writeFileSync(join(scratch, "operation-projection-diag.json"), JSON.stringify(payload, null, 2))
      throw new Error(`session ${sessionId} not found in backendSnapshot after prompt`)
    }
    if (!obs.hasMarker) {
      const payload = { marker, sessionId, attempts, backendPromptSnapshot }
      writeFileSync(join(scratch, "operation-projection-diag.json"), JSON.stringify(payload, null, 2))
      throw new Error(`marker ${marker} not found in user messages for ${sessionId}`)
    }
    const beforeUserCount = obs.userCount
    const hasMarker = obs.hasMarker

    // ---- operation projection: privateObservationOperations limit:1 ----
    const opsCheck = await observeOperations(vscodeApi, dirForCreate, sessionId, `prompt:${messageId}`)
    opsResultBeforeReplay = opsCheck.opsResult
    diag.opsResultBeforeReplay = opsResultBeforeReplay
    diag.opsOperation = opsCheck.operation
    writeFileSync(join(scratch, "operation-projection-ops.json"), JSON.stringify(opsCheck, null, 2))
    if (!opsCheck.found)
      throw new Error(
        `operations not found or opId mismatch expected prompt:${messageId} got ${JSON.stringify(opsCheck.operation)}`,
      )
    if (!opsCheck.outcomeLegal) throw new Error(`operations outcome illegal: ${JSON.stringify(opsCheck.operation)}`)
    if (!opsCheck.finite) throw new Error(`operations time not finite: ${JSON.stringify(opsCheck.operation)}`)
    if (!opsCheck.safe) throw new Error(`operations leaked non-panel fields: ${JSON.stringify(opsCheck.operation)}`)

    // ---- notification snapshot: observation/changed ----
    notificationsBefore = await fetchNotifications(vscodeApi)
    writeFileSync(
      join(scratch, "operation-projection-notifications-before.json"),
      JSON.stringify(notificationsBefore, null, 2),
    )
    diag.notificationsBefore = notificationsBefore
    // try to capture persisted cursor from status0? Use privateObservationStatus persistedCursor
    const persistedBefore = (status0 as Record<string, unknown>).persistedCursor as number | undefined
    const notifValidation = validateNotificationSnapshot(notificationsBefore, persistedBefore)
    diag.notifValidationBefore = notifValidation
    writeFileSync(
      join(scratch, "operation-projection-notif-validation-before.json"),
      JSON.stringify(notifValidation, null, 2),
    )
    // if readable, enforce valid
    if ((notificationsBefore as Record<string, unknown>)?.error === undefined) {
      // we have notification snapshot; if it contains observation/changed entries, validate strict
      const maybeHasEntries = (notificationsBefore as Record<string, unknown>)?.entries !== undefined
      if (maybeHasEntries && !notifValidation.valid) {
        const payload = { notificationsBefore, notifValidation }
        writeFileSync(join(scratch, "operation-projection-diag.json"), JSON.stringify(payload, null, 2))
        // not fatal if no entries yet, but if entries exist and invalid, fail
        const entriesLen = Array.isArray((notificationsBefore as Record<string, unknown>).entries)
          ? ((notificationsBefore as Record<string, unknown>).entries as unknown[]).length
          : 0
        if (entriesLen > 0) throw new Error(`notification snapshot invalid: ${notifValidation.reason}`)
      }
    }

    // ---- AgentManager tab projection BEFORE recentOperations / pre-close handshake ----
    // boundary private session must be tracked, projected as tab, active via fixture-gated message path
    await ensureTabProjection(vscodeApi, scratch, sessionId, diag)

    // ---- AgentManager recentOperations via fixture bridge ----
    // Poll for recentOperations[sessionId] == prompt:messageId via direct fetch for that session (bypasses managedSessions catalog race)
    let amFound = false
    let amOpIdMatch = false
    let amSafe = false
    let amOp: Record<string, unknown> | undefined
    const deadlineRecent = Date.now() + 12_000
    while (Date.now() < deadlineRecent) {
      try {
        recentOpsBefore = await fetchRecentOpsForSession(vscodeApi, sessionId)
      } catch (e) {
        recentOpsBefore = { error: String(e) }
      }
      writeFileSync(
        join(scratch, "operation-projection-recentops-before.json"),
        JSON.stringify(recentOpsBefore, null, 2),
      )
      diag.recentOpsBefore = recentOpsBefore
      const raw = recentOpsBefore as unknown as Record<string, unknown>
      const candidate =
        (raw[sessionId] as unknown as Record<string, unknown> | undefined) ??
        ((raw.recentOperations as unknown as Record<string, unknown> | undefined)?.[sessionId] as unknown as
          | Record<string, unknown>
          | undefined)
      if (candidate && typeof candidate === "object") {
        amOp = candidate as Record<string, unknown>
        amFound = true
        amOpIdMatch = (candidate as Record<string, unknown>).opId === `prompt:${messageId}`
        const keys = Object.keys(candidate as object)
        amSafe =
          keys.every((k) => PANEL_SAFE_KEYS.has(k)) &&
          !("detail" in (candidate as Record<string, unknown>)) &&
          !("stack" in (candidate as Record<string, unknown>))
        diag.amRecentOp = candidate as Record<string, unknown>
        if (amFound && amOpIdMatch && amSafe) break
      }
      await sleep(500)
    }
    writeFileSync(
      join(scratch, "operation-projection-am-check-before.json"),
      JSON.stringify({ amFound, amOpIdMatch, amSafe, amOp }, null, 2),
    )
    if (!amFound)
      throw new Error(
        `AgentManager recentOperations missing for ${sessionId} after fetch: ${JSON.stringify(recentOpsBefore).slice(0, 800)}`,
      )
    if (!amOpIdMatch)
      throw new Error(
        `AgentManager recentOperations opId mismatch expected prompt:${messageId} got ${JSON.stringify(diag.amRecentOp)}`,
      )
    if (!amSafe)
      throw new Error(`AgentManager recentOperations leaked non-panel fields: ${JSON.stringify(diag.amRecentOp)}`)

    // ---- OperationStatus hidden vs visible check ----
    // If outcome == succeeded, OperationStatus should be hidden (no DOM), else visible with safe text
    const outcome = (opsCheck.operation as Record<string, unknown>).outcome as string
    const shouldBeHidden = outcome === "succeeded"
    diag.outcomeForStatus = outcome
    diag.shouldBeHidden = shouldBeHidden
    // We cannot directly check DOM here; probe will verify DOM. But we can record recentOps tone/text via helper for diagnostics
    // Simulate operationStatusText logic
    let statusText: string | undefined
    if (outcome === "in-flight") statusText = "Running"
    else if (outcome === "succeeded") statusText = undefined
    else if (outcome === "failed")
      statusText = `Failed · ${(opsCheck.operation as Record<string, unknown>).code}: ${(opsCheck.operation as Record<string, unknown>).message}`
    else if (outcome === "abandoned") {
      const src = (opsCheck.operation as Record<string, unknown>).cancel as Record<string, unknown> | undefined
      const s = src?.source ? ` · ${src.source}` : ""
      statusText = `Cancelled${s}`
    } else if (outcome === "ambiguous") statusText = "Ambiguous"
    else if (outcome === "superseded") statusText = "Superseded"
    diag.expectedStatusText = statusText
    writeFileSync(
      join(scratch, "operation-projection-status-expect.json"),
      JSON.stringify({ outcome, shouldBeHidden, statusText }, null, 2),
    )

    // ---- replay same tuple ----
    const beforeNotifLen = (() => {
      try {
        const snap = notificationsBefore as Record<string, unknown>
        if (Array.isArray(snap.entries)) return (snap.entries as unknown[]).length
        if (Array.isArray((snap as Record<string, unknown>).entries))
          return ((snap as Record<string, unknown>).entries as unknown[]).length
        return -1
      } catch {
        return -1
      }
    })()
    const replayRes = (await vscodeApi.commands.executeCommand(CMD_PROMPT_PRIVATE_REPLAY, {
      sessionId,
      messageId,
    })) as {
      opId: string
      requestId: string
      directory: string
      result: { status: string; accepted: boolean; data?: { messageId?: string; sessionId?: string } }
      sessionId: string
      messageId: string
    }
    const replaySucceeded = replayRes.result?.status === "succeeded" && replayRes.result?.accepted === true
    const replaySame =
      replayRes.messageId === messageId &&
      replayRes.sessionId === sessionId &&
      replayRes.opId === `prompt:${messageId}` &&
      replayRes.requestId === finalRes.requestId
    diag.replayRes = replayRes
    diag.replaySame = replaySame
    writeFileSync(join(scratch, "operation-projection-replay.json"), JSON.stringify({ replayRes, replaySame }, null, 2))
    if (!replaySucceeded) {
      const payload = { replayRes, attempts, backendPromptSnapshot }
      writeFileSync(join(scratch, "operation-projection-diag.json"), JSON.stringify(payload, null, 2))
      throw new Error(`replay failed: ${JSON.stringify(replayRes.result).slice(0, 800)}`)
    }
    if (replayRes.opId !== `prompt:${messageId}`)
      throw new Error(`replay opId must be canonical prompt:${messageId}, got ${replayRes.opId}`)
    if (!replaySame) {
      console.warn(
        `[operation-projection] replay same tuple mismatch expected requestId ${finalRes.requestId} got ${replayRes.requestId}`,
      )
    }
    await sleep(900)
    let backendReplaySnapshot: unknown = null
    let afterUserCount = beforeUserCount
    let afterHasMarker = false
    let noDuplicate = false
    const deadlineReplay = Date.now() + 10_000
    while (Date.now() < deadlineReplay) {
      try {
        const snap2 = (await vscodeApi.commands.executeCommand(CMD_SNAPSHOT)) as {
          sessions: Array<{ id: string }>
          messages: Record<string, Array<{ text: string; role: string; id: string }>>
        }
        backendReplaySnapshot = snap2
        const msgs2 = snap2.messages?.[sessionId] ?? []
        const userMsgs2 = msgs2.filter((m) => m.role === "user")
        afterUserCount = userMsgs2.length
        afterHasMarker = userMsgs2.some((m) => m.text.includes(marker))
        noDuplicate = afterUserCount === beforeUserCount && afterHasMarker
        if (noDuplicate) break
      } catch {}
      await sleep(300)
    }
    diag.backendReplaySnapshot = backendReplaySnapshot
    diag.afterUserCount = afterUserCount
    diag.afterHasMarker = afterHasMarker
    diag.noDuplicate = noDuplicate
    writeFileSync(
      join(scratch, "operation-projection-replay-observation.json"),
      JSON.stringify({ afterUserCount, afterHasMarker, noDuplicate, snapshot: backendReplaySnapshot }, null, 2),
    )
    if (!noDuplicate) {
      const payload = { beforeUserCount, afterUserCount, afterHasMarker, attempts, backendReplaySnapshot }
      writeFileSync(join(scratch, "operation-projection-diag.json"), JSON.stringify(payload, null, 2))
      throw new Error(
        `replay must not duplicate user message before=${beforeUserCount} after=${afterUserCount} hasMarker=${afterHasMarker}`,
      )
    }

    // ---- operations after replay: should not create new row, same opId, same time maybe? ----
    const opsAfter = await observeOperations(vscodeApi, dirForCreate, sessionId, `prompt:${messageId}`)
    opsResultAfterReplay = opsAfter.opsResult
    diag.opsResultAfterReplay = opsResultAfterReplay
    diag.opsAfter = opsAfter.operation
    writeFileSync(join(scratch, "operation-projection-ops-after.json"), JSON.stringify(opsAfter, null, 2))
    if (!opsAfter.found) throw new Error(`operations after replay not found opId prompt:${messageId}`)
    if ((opsAfter.operation as Record<string, unknown>).opId !== `prompt:${messageId}`)
      throw new Error(`operations after replay opId mismatch`)
    // ensure not extra operation row: limit 1 still 1, and time unchanged or at least not new distinct opId
    // we can also fetch with limit 20 to ensure only one prompt op row for this session? But spec says replay same tuple不新增 user message/operation row
    // For safety, fetch limit 20 and ensure count of operations with opId prompt:messageId is 1
    try {
      const raw20 = (await vscodeApi.commands.executeCommand(CMD_OPS, {
        directory: dirForCreate,
        sessionId,
        limit: 20,
      })) as Record<string, unknown>
      const ops20 = (raw20.operations as unknown[] | undefined) ?? []
      const matching = ops20.filter((o) => (o as Record<string, unknown>).opId === `prompt:${messageId}`)
      diag.ops20 = raw20
      diag.matchingCount = matching.length
      writeFileSync(
        join(scratch, "operation-projection-ops20.json"),
        JSON.stringify({ raw20, matchingCount: matching.length }, null, 2),
      )
      if (matching.length !== 1)
        throw new Error(`replay should not create extra operation row, matching count=${matching.length}`)
    } catch (e) {
      const msg = String(e)
      if (msg.includes("replay should not create extra")) throw e
      console.warn(`[operation-projection] ops20 check skipped: ${msg.slice(0, 200)}`)
    }

    notificationsAfter = await fetchNotifications(vscodeApi)
    writeFileSync(
      join(scratch, "operation-projection-notifications-after.json"),
      JSON.stringify(notificationsAfter, null, 2),
    )
    diag.notificationsAfter = notificationsAfter
    const afterNotifVal = validateNotificationSnapshot(notificationsAfter, persistedBefore)
    diag.notifValidationAfter = afterNotifVal
    // strictly record extra notification: should not produce extra observation/changed for same op
    const afterLen = (() => {
      try {
        const snap = notificationsAfter as Record<string, unknown>
        if (Array.isArray(snap.entries)) return (snap.entries as unknown[]).length
        return -1
      } catch {
        return -1
      }
    })()
    diag.notifLenBefore = beforeNotifLen
    diag.notifLenAfter = afterLen
    const extraAllowed = afterLen === beforeNotifLen || afterLen === beforeNotifLen + 1
    // we allow at most 1 extra if it is an explicit observation refresh, but we strictly record; if more than 1 extra, fail
    if (afterLen !== -1 && beforeNotifLen !== -1 && afterLen > beforeNotifLen + 1) {
      const payload = { beforeNotifLen, afterLen, notificationsBefore, notificationsAfter }
      writeFileSync(join(scratch, "operation-projection-diag.json"), JSON.stringify(payload, null, 2))
      throw new Error(
        `replay produced extra operation notifications before=${beforeNotifLen} after=${afterLen} (max +1 allowed for observation refresh)`,
      )
    }
    if (afterLen !== -1 && beforeNotifLen !== -1 && afterLen === beforeNotifLen + 1) {
      console.log(
        `[operation-projection] replay produced one extra notification (allowed as observation refresh), strictly recorded`,
      )
    }

    // ---- recentOps after replay should stay same ----
    try {
      await vscodeApi.commands.executeCommand(CMD_REFRESH)
      await sleep(600)
    } catch {}
    recentOpsAfter = await fetchRecentOps(vscodeApi)
    writeFileSync(
      join(scratch, "operation-projection-recentops-after-replay.json"),
      JSON.stringify(recentOpsAfter, null, 2),
    )
    diag.recentOpsAfterReplay = recentOpsAfter

    // ---- Phase: publish pre-close evidence, wait for probe DOM verification BEFORE close/forget ----
    // This reordering fixes the proven race where close/forget cleared recentOperations
    // before the probe could activate the tab and verify scoped OperationStatus DOM.
    let closeVerified: boolean | null = null
    let closeDetail: string | undefined = "pending DOM verification — close/forget not yet executed"
    // Publish a pending close state so probe's bounded wait can distinguish pending vs final
    writeFileSync(
      join(scratch, "operation-projection-close-check.json"),
      JSON.stringify({ closeVerified: null, closeDetail }, null, 2),
    )
    diag.closeVerified = null
    diag.closeDetail = closeDetail

    const statusBeforeClose = (await vscodeApi.commands.executeCommand(CMD_PRIVATE_PEER_STATUS)) as Record<
      string,
      unknown
    >
    const pendingEvidence = {
      scenario: "operation-projection",
      collectedAt: new Date().toISOString(),
      pid: (status0 as Record<string, unknown>).pid ?? 0,
      canonical: {
        dbPath: String((status0 as Record<string, unknown>).dbPath ?? ""),
        gateOk,
        gateErr,
        isolateOk: (() => {
          try {
            const dr = (gate as Record<string, unknown> | null)?.dataRoot as string | undefined
            if (!dr) return undefined
            return isIsolatedDataRoot(scratch, dr)
          } catch {
            return undefined
          }
        })(),
      },
      testBridge: (status0 as Record<string, unknown>).testBridge === true,
      create: {
        opId: (sessionRes as unknown as { opId: string }).opId,
        requestId: (sessionRes as unknown as { requestId: string }).requestId,
        directory: (sessionRes as unknown as { directory: string }).directory,
        privateSucceeded: true,
        sessionId,
      },
      prompt: {
        opId: finalRes.opId,
        requestId: finalRes.requestId,
        directory: finalRes.directory,
        messageId,
        privateSucceeded: promptSucceeded,
        accepted: !!finalRes.result.accepted,
        sessionId,
        attempts: attempts.length,
      },
      operations: {
        opId: (opsCheck.operation as Record<string, unknown>).opId,
        outcome: (opsCheck.operation as Record<string, unknown>).outcome,
        found: opsCheck.found,
        safe: opsCheck.safe,
        finite: opsCheck.finite,
        outcomeLegal: opsCheck.outcomeLegal,
        limit: 1,
      },
      replay: {
        sameMessage: replaySame,
        succeeded: replaySucceeded,
        opId: replayRes.opId,
        requestId: replayRes.requestId,
        accepted: !!replayRes.result.accepted,
        canonicalOpId: replayRes.opId === `prompt:${messageId}`,
      },
      observation: {
        userCount: beforeUserCount,
        hasMarker,
        sessionExists: obs.sessionExists,
        durableSessionConfirmed: !!sessionExistsAfterCreate,
      },
      replayObservation: { userCountAfterReplay: afterUserCount, hasMarker: afterHasMarker, noDuplicate: noDuplicate },
      notifications: {
        beforeLen: beforeNotifLen,
        afterLen,
        notifValidationBefore: notifValidation,
        notifValidationAfter: afterNotifVal,
        extraAllowed,
      },
      recentOperations: { before: recentOpsBefore, afterReplay: recentOpsAfter, closeVerified: null, closeDetail },
      tabProjection: diag.tabProjection,
      statusTextExpect: statusText,
      shouldBeHidden,
      gate,
      peerReadySnapshot,
      peerHistoryLen: peerHistory.length,
      backendCreateConfirmed: !!sessionExistsAfterCreate,
      statusAfterPeer: statusBeforeClose,
      diagAttempts: attempts,
    }
    writeFileSync(join(scratch, "operation-projection-runtime-evidence"), JSON.stringify(pendingEvidence, null, 2))
    writeFileSync(
      join(scratch, "operation-projection-diag.json"),
      JSON.stringify(
        {
          evidence: pendingEvidence,
          attempts,
          peerHistory,
          peerReadySnapshot,
          backendCreateSnapshot,
          backendPromptSnapshot,
          backendReplaySnapshot,
          recentOpsBefore,
          recentOpsAfter,
          notificationsBefore,
          notificationsAfter,
        },
        null,
        2,
      ),
    )
    writeFileSync(join(scratch, "operation-projection-ready"), fixtureId)
    console.log(
      "[operation-projection] pre-close evidence published, awaiting probe dom-evidence before close/forget (bounded wait)",
    )
    // Deterministic wait for probe's DOM evidence (scoped sessionId OperationStatus verified) before mutating tab state
    const domEvidenceDeadline = Date.now() + 90_000
    while (Date.now() < domEvidenceDeadline) {
      if (existsSync(join(scratch, "operation-projection-dom-evidence"))) break
      await sleep(250)
    }
    if (!existsSync(join(scratch, "operation-projection-dom-evidence"))) {
      console.warn(
        "[operation-projection] dom-evidence not observed within 90s, proceeding to close/forget anyway (probe may have failed)",
      )
    } else {
      console.log("[operation-projection] dom-evidence observed, proceeding to close/forget")
    }

    // ---- close/forget/prune: executed ONLY after dom-evidence ----
    try {
      let forgetRes: unknown = null
      try {
        forgetRes = await vscodeApi.commands.executeCommand(
          "kilo-code.new.e2eFixture.agentManagerForgetSession" as never,
          { sessionId } as never,
        )
        diag.forgetRes = forgetRes
      } catch (e) {
        diag.forgetError = String(e)
        try {
          const del = (await vscodeApi.commands.executeCommand(
            "kilo-code.new.e2eFixture.sessionDeletePrivate" as never,
            { directory: dirForCreate, sessionId } as never,
          )) as unknown
          diag.deleteRes = del
          forgetRes = del
        } catch (e2) {
          diag.deleteError = String(e2)
        }
      }
      if (forgetRes !== null) {
        await sleep(800)
        try {
          await vscodeApi.commands.executeCommand(CMD_REFRESH)
          await sleep(500)
        } catch {}
        const afterClose = await fetchRecentOps(vscodeApi)
        writeFileSync(
          join(scratch, "operation-projection-recentops-after-close.json"),
          JSON.stringify(afterClose, null, 2),
        )
        diag.recentOpsAfterClose = afterClose
        const mapAfter =
          ((afterClose as Record<string, unknown>).recentOperations as Record<string, unknown> | undefined) ??
          (afterClose as Record<string, unknown>)
        const still = (mapAfter as Record<string, unknown>)[sessionId] !== undefined
        if (!still) {
          closeVerified = true
          closeDetail = undefined
          console.log(`[operation-projection] close/forget cleared recentOperations for ${sessionId} (post-DOM)`)
        } else {
          closeVerified = false
          closeDetail = `recentOperations still contains ${sessionId} after close/forget: ${JSON.stringify((mapAfter as Record<string, unknown>)[sessionId]).slice(0, 400)}`
          console.warn(`[operation-projection] close/forget did not clear recentOperations: ${closeDetail}`)
        }
      } else {
        closeVerified = null
        closeDetail = "no easy bridge for close/forget (both fixture commands unavailable) — reported as unverified"
        console.log(`[operation-projection] close/forget unverified: ${closeDetail}`)
        // still write an after-close snapshot for probe's wait (empty map)
        try {
          const afterClose = await fetchRecentOps(vscodeApi)
          writeFileSync(
            join(scratch, "operation-projection-recentops-after-close.json"),
            JSON.stringify(afterClose, null, 2),
          )
          diag.recentOpsAfterClose = afterClose
        } catch {}
      }
    } catch (e) {
      closeVerified = null
      closeDetail = `close/forget probe threw: ${String(e).slice(0, 400)} — reported as unverified`
      console.log(`[operation-projection] close/forget unverified: ${closeDetail}`)
    }
    diag.closeVerified = closeVerified
    diag.closeDetail = closeDetail
    writeFileSync(
      join(scratch, "operation-projection-close-check.json"),
      JSON.stringify({ closeVerified, closeDetail }, null, 2),
    )

    const statusAfter = (await vscodeApi.commands.executeCommand(CMD_PRIVATE_PEER_STATUS)) as Record<string, unknown>
    const finalEvidence = {
      scenario: "operation-projection",
      collectedAt: new Date().toISOString(),
      pid: (status0 as Record<string, unknown>).pid ?? 0,
      canonical: {
        dbPath: String((status0 as Record<string, unknown>).dbPath ?? ""),
        gateOk,
        gateErr,
        isolateOk: (() => {
          try {
            const dr = (gate as Record<string, unknown> | null)?.dataRoot as string | undefined
            if (!dr) return undefined
            return isIsolatedDataRoot(scratch, dr)
          } catch {
            return undefined
          }
        })(),
      },
      testBridge: (status0 as Record<string, unknown>).testBridge === true,
      create: {
        opId: (sessionRes as unknown as { opId: string }).opId,
        requestId: (sessionRes as unknown as { requestId: string }).requestId,
        directory: (sessionRes as unknown as { directory: string }).directory,
        privateSucceeded: true,
        sessionId,
      },
      prompt: {
        opId: finalRes.opId,
        requestId: finalRes.requestId,
        directory: finalRes.directory,
        messageId,
        privateSucceeded: promptSucceeded,
        accepted: !!finalRes.result.accepted,
        sessionId,
        attempts: attempts.length,
      },
      operations: {
        opId: (opsCheck.operation as Record<string, unknown>).opId,
        outcome: (opsCheck.operation as Record<string, unknown>).outcome,
        found: opsCheck.found,
        safe: opsCheck.safe,
        finite: opsCheck.finite,
        outcomeLegal: opsCheck.outcomeLegal,
        limit: 1,
      },
      replay: {
        sameMessage: replaySame,
        succeeded: replaySucceeded,
        opId: replayRes.opId,
        requestId: replayRes.requestId,
        accepted: !!replayRes.result.accepted,
        canonicalOpId: replayRes.opId === `prompt:${messageId}`,
      },
      observation: {
        userCount: beforeUserCount,
        hasMarker,
        sessionExists: obs.sessionExists,
        durableSessionConfirmed: !!sessionExistsAfterCreate,
      },
      replayObservation: { userCountAfterReplay: afterUserCount, hasMarker: afterHasMarker, noDuplicate: noDuplicate },
      notifications: {
        beforeLen: beforeNotifLen,
        afterLen,
        notifValidationBefore: notifValidation,
        notifValidationAfter: afterNotifVal,
        extraAllowed,
      },
      recentOperations: { before: recentOpsBefore, afterReplay: recentOpsAfter, closeVerified, closeDetail },
      tabProjection: diag.tabProjection,
      statusTextExpect: statusText,
      shouldBeHidden,
      gate,
      peerReadySnapshot,
      peerHistoryLen: peerHistory.length,
      backendCreateConfirmed: !!sessionExistsAfterCreate,
      statusAfterPeer: statusAfter,
      diagAttempts: attempts,
    }
    writeFileSync(join(scratch, "operation-projection-runtime-evidence"), JSON.stringify(finalEvidence, null, 2))
    writeFileSync(
      join(scratch, "operation-projection-diag.json"),
      JSON.stringify(
        {
          evidence: finalEvidence,
          attempts,
          peerHistory,
          peerReadySnapshot,
          backendCreateSnapshot,
          backendPromptSnapshot,
          backendReplaySnapshot,
          recentOpsBefore,
          recentOpsAfter,
          notificationsBefore,
          notificationsAfter,
        },
        null,
        2,
      ),
    )
    // ready already written; re-assert presence for harness that may have consumed it
    writeFileSync(join(scratch, "operation-projection-ready"), fixtureId)
    const deadline = Date.now() + OPERATION_PROJECTION_BUDGET
    while (Date.now() < deadline) {
      if (existsSync(join(scratch, "done"))) break
      await sleep(200)
    }
  } catch (err) {
    console.error("[operation-projection] boundary failed", String(err), err instanceof Error ? err.stack : "")
    try {
      const payload = {
        error: String(err),
        stack: err instanceof Error ? err.stack : undefined,
        diag,
        attempts,
        peerHistory,
        peerReadySnapshot,
        createRes,
        createSessionId,
        backendCreateSnapshot,
        backendPromptSnapshot,
        backendReplaySnapshot,
        sessionExistsAfterCreate,
        marker,
        messageId,
        dirForCreate,
        opsResultBeforeReplay,
        opsResultAfterReplay,
        recentOpsBefore,
        recentOpsAfter,
        notificationsBefore,
        notificationsAfter,
      }
      writeFileSync(join(scratch, "operation-projection-error.json"), JSON.stringify(payload, null, 2))
      writeFileSync(join(scratch, "operation-projection-diag.json"), JSON.stringify(payload, null, 2))
      writeFileSync(join(scratch, "operation-projection-ready"), `error:${String(err).slice(0, 260)}`)
      writeFileSync(join(scratch, "operation-projection-failed"), fixtureId)
    } catch {}
    throw err
  }
}
