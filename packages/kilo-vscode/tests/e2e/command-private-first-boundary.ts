import * as vscode from "vscode"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isIsolatedDataRoot, validateGateEvidence } from "../../script/e2e-canonical"

const CMD_PROD_STATUS = "kilo-code.new.e2eFixture.privateObservationStatus" as const
const CMD_CANONICAL_STATE = "kilo-code.new.e2eFixture.canonicalState" as const
const CMD_PRIVATE_PEER_STATUS = "kilo-code.new.e2eFixture.privatePeerStatus" as const
const CMD_SESSION_CREATE = "kilo-code.new.e2eFixture.sessionCreate" as const
const CMD_SNAPSHOT = "kilo-code.new.e2eFixture.backendSnapshot" as const
const CMD_COMMAND_PRIVATE = "kilo-code.new.e2eFixture.sessionCommandPrivate" as const
const CMD_COMMAND_PRIVATE_REPLAY = "kilo-code.new.e2eFixture.sessionCommandPrivateReplay" as const
const CMD_COMMAND_LIST_PRIVATE = "kilo-code.new.e2eFixture.commandListPrivate" as const
const COMMAND_PRIVATE_BUDGET = 900_000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function hasCommandCap(caps: unknown): boolean {
  if (!caps) return false
  if (Array.isArray(caps)) return (caps as string[]).includes("session/command")
  if (typeof caps !== "object") return false
  const c = caps as Record<string, unknown>
  if (c["session/command"] === true) return true
  if (Array.isArray(c.session) && (c.session as unknown[]).includes("command")) return true
  if (typeof c.session !== "object" || c.session === null) return false
  const sess = c.session as Record<string, unknown>
  return !!sess.command
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
        private: { available: boolean; state?: string; capabilities?: unknown; protocol?: unknown; epoch?: number | null }
      }
      lastPeerStat = peerStat as unknown as Record<string, unknown>
      peerHistory.push({ at: new Date().toISOString(), stat: peerStat })
      const avail = !!peerStat?.private?.available
      const caps = (peerStat?.private as unknown as { capabilities?: unknown })?.capabilities
      const hasCap = hasCommandCap(caps)
      const state = (peerStat?.private as unknown as { state?: string })?.state
      if (avail && hasCap) {
        ready = true
        peerReadySnapshot = peerStat
        break
      }
      console.log(`[command-private] peer not ready avail=${avail} state=${state} hasCommandCap=${hasCap} caps=${JSON.stringify(caps)?.slice(0, 300)}`)
    } catch (e) {
      peerHistory.push({ at: new Date().toISOString(), error: String(e) })
    }
    await sleep(200)
  }
  return { peerReadySnapshot, lastPeerStat, ready }
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

async function attemptCommand(
  vscodeApi: typeof vscode,
  dirForCreate: string,
  sessionId: string,
  messageId: string,
  command: string,
  args: string,
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
  const res = (await vscodeApi.commands.executeCommand(CMD_COMMAND_PRIVATE, { directory: dirForCreate, sessionId, messageId, command, arguments: args })) as {
    opId: string
    requestId: string
    directory: string
    result: { status: string; accepted: boolean; data?: { messageId?: string; sessionId?: string }; failure?: unknown; transportUnknown?: boolean }
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
    command,
    arguments: args,
    beforePeer,
    afterPeer,
    beforeEpoch,
    afterEpoch: (afterPeer as unknown as { private?: { epoch?: number } })?.private?.epoch ?? null,
    durationMs,
    transportUnknown: (res.result as unknown as { transportUnknown?: boolean }).transportUnknown,
  }
  attempts.push(entry)
  writeFileSync(join(scratch, `command-private-attempt-${label}.json`), JSON.stringify(entry, null, 2))
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
  const retryRes = (await vscodeApi.commands.executeCommand(CMD_COMMAND_PRIVATE_REPLAY, { sessionId, messageId })) as {
    opId: string
    requestId: string
    directory: string
    result: { status: string; accepted: boolean; data?: { messageId?: string; sessionId?: string }; transportUnknown?: boolean }
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
    sameTuple: retryRes.opId === (first as unknown as { opId: string }).opId && retryRes.requestId === (first as unknown as { requestId: string }).requestId,
  }
  attempts.push(entry)
  writeFileSync(join(scratch, "command-private-attempt-retry.json"), JSON.stringify(entry, null, 2))
  return entry as unknown as Record<string, unknown>
}

async function observeCommand(
  vscodeApi: typeof vscode,
  sessionId: string,
  marker: string,
): Promise<{ userCount: number; hasMarker: boolean; sessionExists: boolean; snapshot: unknown; backendCommandSnapshot: unknown }> {
  await sleep(800)
  let snapshot: unknown = null
  let userCount = 0
  let hasMarker = false
  let sessionExists = false
  let backendCommandSnapshot: unknown = null
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const snap = (await vscodeApi.commands.executeCommand(CMD_SNAPSHOT)) as {
        sessions: Array<{ id: string }>
        messages: Record<string, Array<{ text: string; role: string; id: string }>>
      }
      snapshot = snap
      backendCommandSnapshot = snap
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
  return { userCount, hasMarker, sessionExists, snapshot, backendCommandSnapshot }
}

async function observeReplay(
  vscodeApi: typeof vscode,
  sessionId: string,
  marker: string,
  beforeUserCount: number,
): Promise<{ afterUserCount: number; afterHasMarker: boolean; noDuplicate: boolean; backendReplaySnapshot: unknown }> {
  await sleep(600)
  let afterUserCount = beforeUserCount
  let afterHasMarker = false
  let noDuplicate = false
  let backendReplaySnapshot: unknown = null
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
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
  return { afterUserCount, afterHasMarker, noDuplicate, backendReplaySnapshot }
}

export async function serviceCommandPrivateFirstBoundary(
  vscodeApi: typeof vscode,
  scratch: string,
  fixtureId: string,
): Promise<void> {
  const diag: Record<string, unknown> = { fixtureId, startedAt: new Date().toISOString(), scratch }
  const peerHistory: unknown[] = []
  let createRes: unknown = null
  let createSessionId: string | null = null
  let backendCreateSnapshot: unknown = null
  let backendCommandSnapshot: unknown = null
  let backendReplaySnapshot: unknown = null
  let peerReadySnapshot: unknown = null
  const attempts: unknown[] = []
  let sessionExistsAfterCreate: boolean | null = null
  let marker = ""
  let messageId = ""
  let dirForCreate = ""
  let command = ""
  let args = ""
  try {
    console.log("[command-private] start hardened")
    const status0 = (await vscodeApi.commands.executeCommand(CMD_PROD_STATUS)) as Record<string, unknown>
    writeFileSync(join(scratch, "command-private-status.json"), JSON.stringify(status0, null, 2))
    diag.status0 = status0
    try {
      const cstate = await vscodeApi.commands.executeCommand(CMD_CANONICAL_STATE)
      writeFileSync(join(scratch, "command-private-cstate.json"), JSON.stringify(cstate, null, 2))
      diag.cstate = cstate
    } catch (e) {
      writeFileSync(join(scratch, "command-private-cstate.json"), JSON.stringify({ error: String(e) }, null, 2))
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
    // Seed a minimal provider so command's getModel can succeed in isolated workspace (prompt succeeds without this, but command's pre-intake getModel fails with ProviderNoProvidersError)
    // Use the same shape as writeRealCompletedSeed (provider e2e-local/e2e-model) but with a dummy baseURL (no server needed for the user-message intake path)
    // Write to both kilo.json and kilo.jsonc so the server's config loader finds it regardless of extension preference
    try {
      const { mkdirSync: mk2, writeFileSync: wf2, existsSync: ex2 } = require("node:fs") as typeof import("node:fs")
      const { join: jp2 } = require("node:path") as typeof import("node:path")
      const kiloDir = jp2(dirForCreate, ".kilo")
      mk2(kiloDir, { recursive: true })
      const cfgJson = {
        $schema: "https://app.kilo.ai/config.json",
        provider: {
          "e2e-local": {
            npm: "@ai-sdk/openai-compatible",
            name: "E2E Local",
            options: { baseURL: "http://127.0.0.1:12345/v1", apiKey: "e2e-fixture-key" },
            models: { "e2e-model": { name: "E2E Model" } },
          },
        },
        model: "e2e-local/e2e-model",
        small_model: "e2e-local/e2e-model",
        subagent_model: "e2e-local/e2e-model",
      }
      for (const name of ["kilo.json", "kilo.jsonc"]) {
        const p = jp2(kiloDir, name)
        if (!ex2(p)) {
          wf2(p, JSON.stringify(cfgJson, null, 2))
          console.log(`[command-private] seeded provider config at ${p}`)
        }
      }
    } catch (e) {
      console.warn(`[command-private] provider seed failed: ${String(e).slice(0, 200)}`)
    }
    const peerReady = await waitPeerReady(vscodeApi, peerHistory)
    peerReadySnapshot = peerReady.peerReadySnapshot
    const ready = peerReady.ready
    const lastPeerStat = peerReady.lastPeerStat
    diag.peerHistory = peerHistory
    diag.peerReadySnapshot = peerReadySnapshot
    writeFileSync(join(scratch, "command-private-peer-history.json"), JSON.stringify({ peerHistory, ready, peerReadySnapshot }, null, 2))
    if (!ready) {
      const errMsg = `command-private-first: peer not ready within 15s (available+session/command). last=${JSON.stringify(lastPeerStat)?.slice(0, 800)} historyLen=${peerHistory.length}`
      const diagPayload = { kind: "peer-not-ready", peerHistory, lastPeerStat, status0, gate, gateOk, gateErr, scratch, fixtureId }
      writeFileSync(join(scratch, "command-private-diag.json"), JSON.stringify(diagPayload, null, 2))
      writeFileSync(join(scratch, "command-private-error.json"), JSON.stringify({ error: errMsg, diag: diagPayload }, null, 2))
      throw new Error(errMsg)
    }
    const sessionRes = (await vscodeApi.commands.executeCommand(CMD_SESSION_CREATE, { directory: dirForCreate, title: `E2E Command ${fixtureId.slice(0, 8)}` })) as {
      opId: string
      requestId: string
      directory: string
      result: { status: string; accepted: boolean; data?: { session?: { id?: string } }; failure?: unknown; transportUnknown?: boolean }
      sessionId?: string
    }
    createRes = sessionRes
    diag.createRes = sessionRes
    writeFileSync(join(scratch, "command-private-create.json"), JSON.stringify(sessionRes, null, 2))
    if (sessionRes.result?.status !== "succeeded" || !sessionRes.sessionId) {
      const errMsg = `command session create failed: ${JSON.stringify(sessionRes.result).slice(0, 800)}`
      const payload = { createRes: sessionRes, peerHistory, peerReadySnapshot, status0 }
      writeFileSync(join(scratch, "command-private-diag.json"), JSON.stringify(payload, null, 2))
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
    writeFileSync(join(scratch, "command-private-create-confirm.json"), JSON.stringify({ confirmed, sessionId: createSessionId, snapshot: backendCreateSnapshot }, null, 2))
    if (!confirmed) {
      const errMsg = `session ${createSessionId} not confirmed in backendSnapshot within 12s after create (race guard). snapshot=${JSON.stringify(backendCreateSnapshot).slice(0, 900)}`
      writeFileSync(join(scratch, "command-private-diag.json"), JSON.stringify({ createRes: sessionRes, backendCreateSnapshot, peerReadySnapshot, peerHistory }, null, 2))
      throw new Error(errMsg)
    }
    const extractCommands = (res: unknown): Array<{ name: string }> => {
      const outer = res as Record<string, unknown> | null
      let cand: unknown = (outer as unknown as { result?: unknown })?.result
      if (cand && typeof cand === "object" && "kind" in (cand as Record<string, unknown>)) {
        const w = cand as Record<string, unknown>
        if (w.kind === "valid" && w.result && typeof w.result === "object") cand = w.result
        else if (w.kind === "invalid") return []
      }
      if (cand && typeof cand === "object" && "result" in (cand as Record<string, unknown>)) {
        const maybe = (cand as Record<string, unknown>).result as Record<string, unknown> | undefined
        if (maybe && typeof maybe.status === "string") cand = maybe
      }
      const data = (cand as { status?: string; data?: { commands?: Array<{ name: string }> } } | null)?.data?.commands
      return Array.isArray(data) ? data.filter((c) => typeof c.name === "string" && c.name.length > 0) : []
    }
    try {
      const listRes = (await vscodeApi.commands.executeCommand(CMD_COMMAND_LIST_PRIVATE, { directory: dirForCreate })) as unknown
      writeFileSync(join(scratch, "command-private-list.json"), JSON.stringify(listRes, null, 2))
      diag.commandList = listRes
      const available = extractCommands(listRes)
      if (available.length === 0) {
        const payload = { workspaceList: listRes, dirForCreate, scratch, fixtureId }
        writeFileSync(join(scratch, "command-private-diag.json"), JSON.stringify(payload, null, 2))
        writeFileSync(join(scratch, "command-private-error.json"), JSON.stringify({ error: "command list empty for workspace", payload }, null, 2))
        throw new Error(`command list empty for workspace dir=${dirForCreate} res=${JSON.stringify(listRes).slice(0, 800)}`)
      }
      // Prefer a skill command that doesn't require a model/provider (more stable in isolated workspace with empty provider list)
      const rawList = (listRes as unknown as { result?: { data?: { commands?: Array<{ name: string; source?: string }> } } })?.result?.data?.commands ?? []
      // Handle possible WireOutcome wrapper
      const unwrappedRaw = Array.isArray(rawList) && rawList.length === 0 && (listRes as unknown as { result?: { result?: { data?: { commands?: unknown[] } } } })?.result?.result?.data?.commands
        ? (listRes as unknown as { result: { result: { data: { commands: Array<{ name: string; source?: string }> } } } }).result.result.data.commands
        : rawList
      const skillFirst = (unwrappedRaw as Array<{ name: string; source?: string }>).find((c) => c.source === "skill")?.name
      const preferred = skillFirst ?? available[0]!.name
      command = preferred
      console.log(`[command-private] selected available command "${command}" from list len=${available.length} dir=${dirForCreate} (after session create) available=${available.map((c) => c.name).slice(0, 5).join(",")} skillFirst=${skillFirst}`)
      diag.selectedCommand = command
      diag.commandListAvailable = available.map((c) => c.name)
    } catch (e) {
      const msg = String(e)
      if (msg.includes("command list empty")) throw e
      console.warn(`[command-private] command list failed: ${msg.slice(0, 300)}`)
      writeFileSync(join(scratch, "command-private-list-error.json"), JSON.stringify({ error: msg }, null, 2))
      writeFileSync(join(scratch, "command-private-diag.json"), JSON.stringify({ error: msg, dirForCreate, scratch }, null, 2))
      throw new Error(`command list failed: ${msg.slice(0, 600)}`)
    }
    const sessionId = createSessionId as string
    const availableForFallback: Array<{ name: string }> = (diag as Record<string, unknown>).commandList
      ? (() => {
          const res = (diag as Record<string, unknown>).commandList as unknown
          const outer = res as Record<string, unknown> | null
          let cand: unknown = (outer as unknown as { result?: unknown })?.result
          if (cand && typeof cand === "object" && "kind" in (cand as Record<string, unknown>)) {
            const w = cand as Record<string, unknown>
            if (w.kind === "valid" && w.result && typeof w.result === "object") cand = w.result
            else if (w.kind === "invalid") return []
          }
          if (cand && typeof cand === "object" && "result" in (cand as Record<string, unknown>)) {
            const maybe = (cand as Record<string, unknown>).result as Record<string, unknown> | undefined
            if (maybe && typeof maybe.status === "string") cand = maybe
          }
          const data = (cand as { data?: { commands?: Array<{ name: string }> } } | null)?.data?.commands
          return Array.isArray(data) ? data : []
        })()
      : []
    messageId = `msg_${fixtureId.replace(/-/g, "").slice(0, 16)}${Date.now().toString(16).slice(-8)}`
    marker = `command-private-marker-${fixtureId.slice(0, 8)}`
    args = `E2E command-private-first ${marker}`
    diag.messageId = messageId
    diag.marker = marker
    diag.command = command
    diag.arguments = args
    diag.availableForFallback = availableForFallback.map((c) => c.name)
    let finalRes: Record<string, unknown> | null = null
    let commandSucceeded = false
    let usedIdx = 0
    for (let idx = 0; idx < Math.min(availableForFallback.length, 8); idx += 1) {
      const tryCmd = idx === 0 ? command : availableForFallback[idx]!.name
      const tryMsgId = idx === 0 ? messageId : `msg_${fixtureId.replace(/-/g, "").slice(0, 12)}${idx}${Date.now().toString(16).slice(-6)}`
      const tryMarker = idx === 0 ? marker : `command-private-marker-${fixtureId.slice(0, 8)}-${idx}`
      const tryArgs = idx === 0 ? args : `E2E command-private-first ${tryMarker} ${idx}`
      if (idx > 0) {
        messageId = tryMsgId
        marker = tryMarker
        args = tryArgs
        command = tryCmd
        diag.messageId = messageId
        diag.marker = marker
        diag.command = command
        diag.arguments = args
        console.log(`[command-private] fallback attempt ${idx} command="${tryCmd}" msg=${tryMsgId}`)
      }
      const first = await attemptCommand(vscodeApi, dirForCreate, sessionId, tryMsgId, tryCmd, tryArgs, attempts, scratch, idx === 0 ? "first" : `fallback-${idx}`)
      let cur: Record<string, unknown> = first
      const st = (first.result as unknown as { status?: string }).status
      const tu = (first.result as unknown as { transportUnknown?: boolean }).transportUnknown === true
      if (st === "ambiguous" && tu) {
        console.log(`[command-private] attempt ${idx} ambiguous transportUnknown, retrying once same tuple`)
        const retry = await attemptRetry(vscodeApi, sessionId, tryMsgId, first, attempts, scratch)
        cur = retry as unknown as Record<string, unknown>
      }
      const curStatus = (cur.result as unknown as { status?: string }).status
      const curAccepted = (cur.result as unknown as { accepted?: boolean }).accepted === true
      if (curStatus === "succeeded" && curAccepted) {
        finalRes = cur as unknown as Record<string, unknown>
        commandSucceeded = true
        usedIdx = idx
        break
      }
      // track last attempted idx for diagnostics even on failure
      usedIdx = idx
      const failCode = (cur.result as unknown as { failure?: { code?: string } })?.failure?.code
      if (curStatus === "failed" && failCode === "command.not_found" && idx + 1 < Math.min(availableForFallback.length, 8)) {
        console.log(`[command-private] ${tryCmd} not_found terminal, trying next ${availableForFallback[idx + 1]!.name}`)
        continue
      }
      finalRes = cur as unknown as Record<string, unknown>
      usedIdx = idx
      break
    }
    diag.attempts = attempts
    writeFileSync(join(scratch, "command-private-attempts.json"), JSON.stringify(attempts, null, 2))
    if (!finalRes || !commandSucceeded) {
      const fr = finalRes as unknown as { result?: unknown } | null
      const errMsg = `private command failed after ${attempts.length} attempt(s) tried ${usedIdx + 1} commands: ${JSON.stringify(fr?.result).slice(0, 800)} attempts=${JSON.stringify(attempts).slice(0, 1500)} available=${JSON.stringify(availableForFallback.map((c) => c.name)).slice(0, 400)}`
      const payload = { attempts, peerHistory, peerReadySnapshot, createRes: sessionRes, backendCreateSnapshot, command, arguments: args, availableForFallback }
      writeFileSync(join(scratch, "command-private-diag.json"), JSON.stringify(payload, null, 2))
      writeFileSync(join(scratch, "command-private-error.json"), JSON.stringify({ error: errMsg, attempts, peerHistory }, null, 2))
      throw new Error(errMsg)
    }
    const finalTyped = finalRes as unknown as {
      opId: string
      requestId: string
      directory: string
      result: { status: string; accepted: boolean; data?: { messageId?: string; sessionId?: string } }
      sessionId: string
      messageId: string
    }
    if (finalTyped.result.data?.messageId !== messageId) throw new Error(`command data.messageId mismatch expected ${messageId} got ${String(finalTyped.result.data?.messageId)} attempts=${JSON.stringify(attempts).slice(0, 600)}`)
    if (finalTyped.result.data?.sessionId !== sessionId) throw new Error(`command data.sessionId mismatch expected ${sessionId} got ${String(finalTyped.result.data?.sessionId)}`)
    if (finalTyped.opId !== `prompt:${messageId}`) throw new Error(`opId mismatch expected prompt:${messageId} got ${finalTyped.opId}`)
    const obs = await observeCommand(vscodeApi, sessionId, marker)
    backendCommandSnapshot = obs.backendCommandSnapshot
    diag.backendCommandSnapshot = backendCommandSnapshot
    diag.observation = { userCount: obs.userCount, hasMarker: obs.hasMarker, sessionExists: obs.sessionExists }
    writeFileSync(join(scratch, "command-private-observation.json"), JSON.stringify({ userCount: obs.userCount, hasMarker: obs.hasMarker, sessionExists: obs.sessionExists, snapshot: backendCommandSnapshot }, null, 2))
    if (!obs.sessionExists) {
      const payload = { sessionId, attempts, backendCommandSnapshot, peerReadySnapshot }
      writeFileSync(join(scratch, "command-private-diag.json"), JSON.stringify(payload, null, 2))
      throw new Error(`session ${sessionId} not found in backendSnapshot after command`)
    }
    if (!obs.hasMarker) {
      const payload = { marker, sessionId, attempts, backendCommandSnapshot, command, arguments: args }
      writeFileSync(join(scratch, "command-private-diag.json"), JSON.stringify(payload, null, 2))
      throw new Error(`marker ${marker} not found in user messages for ${sessionId}, snapshot=${JSON.stringify(obs.snapshot).slice(0, 800)}`)
    }
    const beforeUserCount = obs.userCount
    const hasMarker = obs.hasMarker
    const replayRes = (await vscodeApi.commands.executeCommand(CMD_COMMAND_PRIVATE_REPLAY, { sessionId, messageId })) as {
      opId: string
      requestId: string
      directory: string
      result: { status: string; accepted: boolean; data?: { messageId?: string; sessionId?: string } }
      sessionId: string
      messageId: string
    }
    const replaySucceeded = replayRes.result?.status === "succeeded" && replayRes.result?.accepted === true
    const replaySame = replayRes.messageId === messageId && replayRes.sessionId === sessionId && replayRes.opId === `prompt:${messageId}` && replayRes.requestId === finalTyped.requestId
    diag.replayRes = replayRes
    diag.replaySame = replaySame
    writeFileSync(join(scratch, "command-private-replay.json"), JSON.stringify({ replayRes, replaySame }, null, 2))
    if (!replaySucceeded) {
      const payload = { replayRes, attempts, backendCommandSnapshot }
      writeFileSync(join(scratch, "command-private-diag.json"), JSON.stringify(payload, null, 2))
      throw new Error(`replay failed: ${JSON.stringify(replayRes.result).slice(0, 800)}`)
    }
    if (replayRes.opId !== `prompt:${messageId}`) throw new Error(`replay opId must be canonical prompt:${messageId}, got ${replayRes.opId}`)
    if (!replaySame) {
      console.warn(`[command-private] replay same tuple mismatch expected requestId ${finalTyped.requestId} got ${replayRes.requestId}`)
    }
    const repObs = await observeReplay(vscodeApi, sessionId, marker, beforeUserCount)
    backendReplaySnapshot = repObs.backendReplaySnapshot
    diag.backendReplaySnapshot = backendReplaySnapshot
    diag.afterUserCount = repObs.afterUserCount
    diag.afterHasMarker = repObs.afterHasMarker
    diag.noDuplicate = repObs.noDuplicate
    writeFileSync(join(scratch, "command-private-replay-observation.json"), JSON.stringify({ afterUserCount: repObs.afterUserCount, afterHasMarker: repObs.afterHasMarker, noDuplicate: repObs.noDuplicate, snapshot: backendReplaySnapshot }, null, 2))
    if (!repObs.noDuplicate) {
      const payload = { beforeUserCount, afterUserCount: repObs.afterUserCount, afterHasMarker: repObs.afterHasMarker, attempts, backendReplaySnapshot }
      writeFileSync(join(scratch, "command-private-diag.json"), JSON.stringify(payload, null, 2))
      throw new Error(`replay must not duplicate user message before=${beforeUserCount} after=${repObs.afterUserCount} hasMarker=${repObs.afterHasMarker}`)
    }
    const statusAfter = (await vscodeApi.commands.executeCommand(CMD_PRIVATE_PEER_STATUS)) as Record<string, unknown>
    const evidence = {
      scenario: "command-private-first",
      collectedAt: new Date().toISOString(),
      pid: (status0 as Record<string, unknown>).pid ?? 0,
      canonical: { dbPath: String((status0 as Record<string, unknown>).dbPath ?? ""), gateOk, gateErr, isolateOk: (() => { try { const dr = (gate as Record<string, unknown> | null)?.dataRoot as string | undefined; if (!dr) return undefined; return isIsolatedDataRoot(scratch, dr) } catch { return undefined } })() },
      testBridge: (status0 as Record<string, unknown>).testBridge === true,
      create: { opId: (sessionRes as unknown as { opId: string }).opId, requestId: (sessionRes as unknown as { requestId: string }).requestId, directory: (sessionRes as unknown as { directory: string }).directory, privateSucceeded: true, sessionId },
      command: { opId: finalTyped.opId, requestId: finalTyped.requestId, directory: finalTyped.directory, messageId, privateSucceeded: commandSucceeded, accepted: !!finalTyped.result.accepted, sessionId, attempts: attempts.length, command, arguments: args },
      replay: { sameMessage: replaySame, succeeded: replaySucceeded, opId: replayRes.opId, requestId: replayRes.requestId, accepted: !!replayRes.result.accepted, canonicalOpId: replayRes.opId === `prompt:${messageId}` },
      observation: { userCount: beforeUserCount, hasMarker, sessionExists: obs.sessionExists, durableSessionConfirmed: !!sessionExistsAfterCreate },
      replayObservation: { userCountAfterReplay: repObs.afterUserCount, hasMarker: repObs.afterHasMarker, noDuplicate: repObs.noDuplicate },
      gate,
      peerReadySnapshot,
      peerHistoryLen: peerHistory.length,
      backendCreateConfirmed: !!sessionExistsAfterCreate,
      statusAfterPeer: statusAfter,
      diagAttempts: attempts,
    }
    writeFileSync(join(scratch, "command-private-runtime-evidence"), JSON.stringify(evidence, null, 2))
    writeFileSync(join(scratch, "command-private-diag.json"), JSON.stringify({ evidence, attempts, peerHistory, peerReadySnapshot, backendCreateSnapshot, backendCommandSnapshot, backendReplaySnapshot }, null, 2))
    writeFileSync(join(scratch, "command-private-ready"), fixtureId)
    const deadline = Date.now() + COMMAND_PRIVATE_BUDGET
    while (Date.now() < deadline) {
      if (existsSync(join(scratch, "done"))) break
      await sleep(200)
    }
  } catch (err) {
    console.error("[command-private] boundary failed", String(err), err instanceof Error ? err.stack : "")
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
        backendCommandSnapshot,
        backendReplaySnapshot,
        sessionExistsAfterCreate,
        marker,
        messageId,
        dirForCreate,
        command,
        arguments: args,
      }
      writeFileSync(join(scratch, "command-private-error.json"), JSON.stringify(payload, null, 2))
      writeFileSync(join(scratch, "command-private-diag.json"), JSON.stringify(payload, null, 2))
      writeFileSync(join(scratch, "command-private-ready"), `error:${String(err).slice(0, 260)}`)
      writeFileSync(join(scratch, "command-private-failed"), fixtureId)
    } catch {}
    throw err
  }
}
