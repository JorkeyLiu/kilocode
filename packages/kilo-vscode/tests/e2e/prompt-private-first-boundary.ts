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
const PROMPT_PRIVATE_BUDGET = 900_000

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
        private: { available: boolean; state?: string; capabilities?: unknown; protocol?: unknown; epoch?: number | null }
      }
      lastPeerStat = peerStat as unknown as Record<string, unknown>
      peerHistory.push({ at: new Date().toISOString(), stat: peerStat })
      const avail = !!peerStat?.private?.available
      const caps = (peerStat?.private as unknown as { capabilities?: unknown })?.capabilities
      const hasCap = hasPromptCap(caps)
      const state = (peerStat?.private as unknown as { state?: string })?.state
      if (avail && hasCap) {
        ready = true
        peerReadySnapshot = peerStat
        break
      }
      console.log(`[prompt-private] peer not ready avail=${avail} state=${state} hasPromptCap=${hasCap} caps=${JSON.stringify(caps)?.slice(0, 300)}`)
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
  const res = (await vscodeApi.commands.executeCommand(CMD_PROMPT_PRIVATE, { directory: dirForCreate, sessionId, messageId, text })) as {
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
    beforePeer,
    afterPeer,
    beforeEpoch,
    afterEpoch: (afterPeer as unknown as { private?: { epoch?: number } })?.private?.epoch ?? null,
    durationMs,
    transportUnknown: (res.result as unknown as { transportUnknown?: boolean }).transportUnknown,
  }
  attempts.push(entry)
  writeFileSync(join(scratch, `prompt-private-attempt-${label}.json`), JSON.stringify(entry, null, 2))
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
  writeFileSync(join(scratch, "prompt-private-attempt-retry.json"), JSON.stringify(entry, null, 2))
  return entry as unknown as Record<string, unknown>
}

async function observePrompt(
  vscodeApi: typeof vscode,
  sessionId: string,
  marker: string,
): Promise<{ userCount: number; hasMarker: boolean; sessionExists: boolean; snapshot: unknown; backendPromptSnapshot: unknown }> {
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

export async function servicePromptPrivateFirstBoundary(
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
  try {
    console.log("[prompt-private] start hardened")
    const status0 = (await vscodeApi.commands.executeCommand(CMD_PROD_STATUS)) as Record<string, unknown>
    writeFileSync(join(scratch, "prompt-private-status.json"), JSON.stringify(status0, null, 2))
    diag.status0 = status0
    try {
      const cstate = await vscodeApi.commands.executeCommand(CMD_CANONICAL_STATE)
      writeFileSync(join(scratch, "prompt-private-cstate.json"), JSON.stringify(cstate, null, 2))
      diag.cstate = cstate
    } catch (e) {
      writeFileSync(join(scratch, "prompt-private-cstate.json"), JSON.stringify({ error: String(e) }, null, 2))
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
    diag.peerHistory = peerHistory
    diag.peerReadySnapshot = peerReadySnapshot
    writeFileSync(join(scratch, "prompt-private-peer-history.json"), JSON.stringify({ peerHistory, ready, peerReadySnapshot }, null, 2))
    if (!ready) {
      const errMsg = `prompt-private-first: peer not ready within 15s (available+session/prompt). last=${JSON.stringify(lastPeerStat)?.slice(0, 800)} historyLen=${peerHistory.length}`
      const diagPayload = { kind: "peer-not-ready", peerHistory, lastPeerStat, status0, gate, gateOk, gateErr, scratch, fixtureId }
      writeFileSync(join(scratch, "prompt-private-diag.json"), JSON.stringify(diagPayload, null, 2))
      writeFileSync(join(scratch, "prompt-private-error.json"), JSON.stringify({ error: errMsg, diag: diagPayload }, null, 2))
      throw new Error(errMsg)
    }
    dirForCreate = (() => {
      const ws = vscodeApi.workspace.workspaceFolders?.[0]?.uri.fsPath
      if (ws) return ws
      return join(scratch, "workspace")
    })()
    diag.dirForCreate = dirForCreate
    const sessionRes = (await vscodeApi.commands.executeCommand(CMD_SESSION_CREATE, { directory: dirForCreate, title: `E2E Prompt ${fixtureId.slice(0, 8)}` })) as {
      opId: string
      requestId: string
      directory: string
      result: { status: string; accepted: boolean; data?: { session?: { id?: string } }; failure?: unknown; transportUnknown?: boolean }
      sessionId?: string
    }
    createRes = sessionRes
    diag.createRes = sessionRes
    writeFileSync(join(scratch, "prompt-private-create.json"), JSON.stringify(sessionRes, null, 2))
    if (sessionRes.result?.status !== "succeeded" || !sessionRes.sessionId) {
      const errMsg = `prompt session create failed: ${JSON.stringify(sessionRes.result).slice(0, 800)}`
      const payload = { createRes: sessionRes, peerHistory, peerReadySnapshot, status0 }
      writeFileSync(join(scratch, "prompt-private-diag.json"), JSON.stringify(payload, null, 2))
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
    writeFileSync(join(scratch, "prompt-private-create-confirm.json"), JSON.stringify({ confirmed, sessionId: createSessionId, snapshot: backendCreateSnapshot }, null, 2))
    if (!confirmed) {
      const errMsg = `session ${createSessionId} not confirmed in backendSnapshot within 12s after create (race guard). snapshot=${JSON.stringify(backendCreateSnapshot).slice(0, 900)}`
      writeFileSync(join(scratch, "prompt-private-diag.json"), JSON.stringify({ createRes: sessionRes, backendCreateSnapshot, peerReadySnapshot, peerHistory }, null, 2))
      throw new Error(errMsg)
    }
    const sessionId = createSessionId as string
    messageId = `msg_${fixtureId.replace(/-/g, "").slice(0, 16)}${Date.now().toString(16).slice(-8)}`
    marker = `prompt-private-marker-${fixtureId.slice(0, 8)}`
    const text = `E2E prompt-private-first ${marker}`
    diag.messageId = messageId
    diag.marker = marker
    const first = await attemptPrompt(vscodeApi, dirForCreate, sessionId, messageId, text, attempts, scratch, "first")
    let promptRes: Record<string, unknown> = first
    const firstStatus = (first.result as unknown as { status?: string }).status
    const firstTransportUnknown = (first.result as unknown as { transportUnknown?: boolean }).transportUnknown === true
    if (firstStatus === "ambiguous" && firstTransportUnknown) {
      console.log(`[prompt-private] first attempt ambiguous transportUnknown, retrying once same tuple msg=${messageId}`)
      const retry = await attemptRetry(vscodeApi, sessionId, messageId, first, attempts, scratch)
      promptRes = retry as unknown as Record<string, unknown>
    }
    diag.attempts = attempts
    writeFileSync(join(scratch, "prompt-private-attempts.json"), JSON.stringify(attempts, null, 2))
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
      const errMsg = `private prompt failed after ${attempts.length} attempt(s): ${JSON.stringify(finalRes.result).slice(0, 800)} attempts=${JSON.stringify(attempts).slice(0, 1500)}`
      const payload = { attempts, peerHistory, peerReadySnapshot, createRes: sessionRes, backendCreateSnapshot }
      writeFileSync(join(scratch, "prompt-private-diag.json"), JSON.stringify(payload, null, 2))
      writeFileSync(join(scratch, "prompt-private-error.json"), JSON.stringify({ error: errMsg, attempts, peerHistory }, null, 2))
      throw new Error(errMsg)
    }
    if (finalRes.result.data?.messageId !== messageId) throw new Error(`prompt data.messageId mismatch expected ${messageId} got ${String(finalRes.result.data?.messageId)} attempts=${JSON.stringify(attempts).slice(0, 600)}`)
    if (finalRes.result.data?.sessionId !== sessionId) throw new Error(`prompt data.sessionId mismatch expected ${sessionId} got ${String(finalRes.result.data?.sessionId)}`)
    if (finalRes.opId !== `prompt:${messageId}`) throw new Error(`opId mismatch expected prompt:${messageId} got ${finalRes.opId}`)
    const obs = await observePrompt(vscodeApi, sessionId, marker)
    backendPromptSnapshot = obs.backendPromptSnapshot
    diag.backendPromptSnapshot = backendPromptSnapshot
    diag.observation = { userCount: obs.userCount, hasMarker: obs.hasMarker, sessionExists: obs.sessionExists }
    writeFileSync(join(scratch, "prompt-private-observation.json"), JSON.stringify({ userCount: obs.userCount, hasMarker: obs.hasMarker, sessionExists: obs.sessionExists, snapshot: backendPromptSnapshot }, null, 2))
    if (!obs.sessionExists) {
      const payload = { sessionId, attempts, backendPromptSnapshot, peerReadySnapshot }
      writeFileSync(join(scratch, "prompt-private-diag.json"), JSON.stringify(payload, null, 2))
      throw new Error(`session ${sessionId} not found in backendSnapshot after prompt`)
    }
    if (!obs.hasMarker) {
      const payload = { marker, sessionId, attempts, backendPromptSnapshot }
      writeFileSync(join(scratch, "prompt-private-diag.json"), JSON.stringify(payload, null, 2))
      throw new Error(`marker ${marker} not found in user messages for ${sessionId}, snapshot=${JSON.stringify(obs.snapshot).slice(0, 800)}`)
    }
    const beforeUserCount = obs.userCount
    const hasMarker = obs.hasMarker
    const replayRes = (await vscodeApi.commands.executeCommand(CMD_PROMPT_PRIVATE_REPLAY, { sessionId, messageId })) as {
      opId: string
      requestId: string
      directory: string
      result: { status: string; accepted: boolean; data?: { messageId?: string; sessionId?: string } }
      sessionId: string
      messageId: string
    }
    const replaySucceeded = replayRes.result?.status === "succeeded" && replayRes.result?.accepted === true
    const replaySame = replayRes.messageId === messageId && replayRes.sessionId === sessionId && replayRes.opId === `prompt:${messageId}` && replayRes.requestId === finalRes.requestId
    diag.replayRes = replayRes
    diag.replaySame = replaySame
    writeFileSync(join(scratch, "prompt-private-replay.json"), JSON.stringify({ replayRes, replaySame }, null, 2))
    if (!replaySucceeded) {
      const payload = { replayRes, attempts, backendPromptSnapshot }
      writeFileSync(join(scratch, "prompt-private-diag.json"), JSON.stringify(payload, null, 2))
      throw new Error(`replay failed: ${JSON.stringify(replayRes.result).slice(0, 800)}`)
    }
    if (replayRes.opId !== `prompt:${messageId}`) throw new Error(`replay opId must be canonical prompt:${messageId}, got ${replayRes.opId}`)
    if (!replaySame) {
      console.warn(`[prompt-private] replay same tuple mismatch expected requestId ${finalRes.requestId} got ${replayRes.requestId}`)
    }
    const repObs = await observeReplay(vscodeApi, sessionId, marker, beforeUserCount)
    backendReplaySnapshot = repObs.backendReplaySnapshot
    diag.backendReplaySnapshot = backendReplaySnapshot
    diag.afterUserCount = repObs.afterUserCount
    diag.afterHasMarker = repObs.afterHasMarker
    diag.noDuplicate = repObs.noDuplicate
    writeFileSync(join(scratch, "prompt-private-replay-observation.json"), JSON.stringify({ afterUserCount: repObs.afterUserCount, afterHasMarker: repObs.afterHasMarker, noDuplicate: repObs.noDuplicate, snapshot: backendReplaySnapshot }, null, 2))
    if (!repObs.noDuplicate) {
      const payload = { beforeUserCount, afterUserCount: repObs.afterUserCount, afterHasMarker: repObs.afterHasMarker, attempts, backendReplaySnapshot }
      writeFileSync(join(scratch, "prompt-private-diag.json"), JSON.stringify(payload, null, 2))
      throw new Error(`replay must not duplicate user message before=${beforeUserCount} after=${repObs.afterUserCount} hasMarker=${repObs.afterHasMarker}`)
    }
    const statusAfter = (await vscodeApi.commands.executeCommand(CMD_PRIVATE_PEER_STATUS)) as Record<string, unknown>
    const evidence = {
      scenario: "prompt-private-first",
      collectedAt: new Date().toISOString(),
      pid: (status0 as Record<string, unknown>).pid ?? 0,
      canonical: { dbPath: String((status0 as Record<string, unknown>).dbPath ?? ""), gateOk, gateErr, isolateOk: (() => { try { const dr = (gate as Record<string, unknown> | null)?.dataRoot as string | undefined; if (!dr) return undefined; return isIsolatedDataRoot(scratch, dr) } catch { return undefined } })() },
      testBridge: (status0 as Record<string, unknown>).testBridge === true,
      create: { opId: (sessionRes as unknown as { opId: string }).opId, requestId: (sessionRes as unknown as { requestId: string }).requestId, directory: (sessionRes as unknown as { directory: string }).directory, privateSucceeded: true, sessionId },
      prompt: { opId: finalRes.opId, requestId: finalRes.requestId, directory: finalRes.directory, messageId, privateSucceeded: promptSucceeded, accepted: !!finalRes.result.accepted, sessionId, attempts: attempts.length },
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
    writeFileSync(join(scratch, "prompt-private-runtime-evidence"), JSON.stringify(evidence, null, 2))
    writeFileSync(join(scratch, "prompt-private-diag.json"), JSON.stringify({ evidence, attempts, peerHistory, peerReadySnapshot, backendCreateSnapshot, backendPromptSnapshot, backendReplaySnapshot }, null, 2))
    writeFileSync(join(scratch, "prompt-private-ready"), fixtureId)
    const deadline = Date.now() + PROMPT_PRIVATE_BUDGET
    while (Date.now() < deadline) {
      if (existsSync(join(scratch, "done"))) break
      await sleep(200)
    }
  } catch (err) {
    console.error("[prompt-private] boundary failed", String(err), err instanceof Error ? err.stack : "")
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
      }
      writeFileSync(join(scratch, "prompt-private-error.json"), JSON.stringify(payload, null, 2))
      writeFileSync(join(scratch, "prompt-private-diag.json"), JSON.stringify(payload, null, 2))
      writeFileSync(join(scratch, "prompt-private-ready"), `error:${String(err).slice(0, 260)}`)
      writeFileSync(join(scratch, "prompt-private-failed"), fixtureId)
    } catch {}
    throw err
  }
}
