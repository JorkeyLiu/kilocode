import * as vscode from "vscode"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const CMD_SNAPSHOT = "kilo-code.new.e2eFixture.backendSnapshot" as const
const CMD_SSE_TIMELINE_STOP = "kilo-code.new.e2eFixture.sseTimelineStop" as const
const CMD_LLM_REQUESTS = "kilo-code.new.e2eFixture.llmRequests" as const
const CMD_PRIVATE_EVENT_CLOSE = "kilo-code.new.e2eFixture.privateEventClosePeer" as const
const CMD_PRIVATE_PEER_STATUS = "kilo-code.new.e2eFixture.privatePeerStatus" as const

export interface EventPre {
  eventCapable: boolean
  eventLive: boolean
  source: string | null
  sseActive: boolean
  connectionState: string
}

export function readEventPre(status: unknown): EventPre {
  const s = status as {
    private?: { eventCapable?: boolean; eventLive?: boolean }
    live?: { source?: string | null; sseActive?: boolean; connectionState?: string }
  }
  return {
    eventCapable: s.private?.eventCapable === true,
    eventLive: s.private?.eventLive === true,
    source: s.live?.source ?? null,
    sseActive: s.live?.sseActive === true,
    connectionState: String(s.live?.connectionState ?? ""),
  }
}

export function assertEventPre(pre: EventPre): void {
  if (!pre.eventCapable) throw new Error(`private event capability event/notify missing pre=${JSON.stringify(pre)}`)
  if (!pre.eventLive) throw new Error(`private event not live pre=${JSON.stringify(pre)}`)
  if (pre.source !== "private") throw new Error(`liveEventSource must be private pre, got ${String(pre.source)}`)
  if (pre.sseActive) throw new Error("SSE must be inactive while private is live (client.global.event untouched)")
  if (pre.connectionState !== "connected") throw new Error(`connection must be connected pre, got ${pre.connectionState}`)
}

export interface TimelineSummary {
  count: number
  hasSessionEntry: boolean
  kinds: string[]
}

export function summarizeTimeline(snapshot: unknown, sessionId: string): TimelineSummary {
  const entries = (snapshot as { entries?: Array<{ kind?: string; sessionID?: string }> })?.entries ?? []
  const kinds = entries.map((e) => String(e.kind ?? "")).slice(0, 12)
  const hasSessionEntry = entries.some((e) => {
    if (e.sessionID === sessionId) return String(e.kind ?? "") !== "server.connected"
    const kind = String(e.kind ?? "")
    if (kind === "session.created" || kind === "session.status") return true
    if (kind.startsWith("sync:session.created") || kind.startsWith("sync:session.status")) return true
    return false
  })
  return { count: entries.length, hasSessionEntry, kinds }
}

export interface EventPhase {
  timeline: TimelineSummary
  llmRequestCount: number
  closeRes: {
    epoch: number | null
    close: { closed: boolean; state: string }
    before: { source: string | null; connectionState: string; sseActive: boolean }
    after: { source: string | null; connectionState: string; sseActive: boolean }
  }
  postPrivateAvailable: boolean
  authorityExists: boolean
  statusAfter: Record<string, unknown>
}

function assertTimeline(timeline: TimelineSummary, sessionId: string): void {
  if (timeline.count < 1) throw new Error(`private event timeline empty while live=private count=${timeline.count}`)
  if (!timeline.hasSessionEntry) {
    throw new Error(`no session-bound backend event via onEvent for ${sessionId} kinds=${timeline.kinds.join(",")}`)
  }
}

async function readLlmCount(vscodeApi: typeof vscode, scratch: string): Promise<number> {
  const llm = (await vscodeApi.commands.executeCommand(CMD_LLM_REQUESTS)) as {
    records: unknown[]
    file: string
  } | null
  const count = llm?.records.length ?? 0
  writeFileSync(join(scratch, "prompt-private-llm.json"), JSON.stringify({ count, file: llm?.file ?? null, records: llm?.records ?? [] }, null, 2))
  if (count > 0) throw new Error(`prompt-private-first issued ${count} model request(s), expected zero`)
  return count
}

async function closeAndRehydrate(vscodeApi: typeof vscode, scratch: string, sessionId: string): Promise<Pick<EventPhase, "closeRes" | "postPrivateAvailable" | "authorityExists" | "statusAfter">> {
  const closeRes = (await vscodeApi.commands.executeCommand(CMD_PRIVATE_EVENT_CLOSE)) as EventPhase["closeRes"]
  writeFileSync(join(scratch, "prompt-private-event-close.json"), JSON.stringify(closeRes, null, 2))
  if (closeRes.after.source !== "sse") throw new Error(`FD close must switch unique live to SSE, got ${String(closeRes.after.source)}`)
  if (closeRes.after.connectionState !== "connected") throw new Error(`SSE fallback must rehydrate connected, got ${closeRes.after.connectionState}`)
  if (!closeRes.after.sseActive) throw new Error("SSE must be active after FD close fallback")
  const statusAfter = (await vscodeApi.commands.executeCommand(CMD_PRIVATE_PEER_STATUS)) as Record<string, unknown>
  const available: unknown = (statusAfter as { private?: { available?: unknown } }).private?.available
  if (available !== false) throw new Error("private peer must be unavailable after FD close (single live source)")
  const snap = (await vscodeApi.commands.executeCommand(CMD_SNAPSHOT)) as { sessions: Array<{ id: string }> }
  const exists = !!snap.sessions?.some((s) => s.id === sessionId)
  writeFileSync(join(scratch, "prompt-private-authority.json"), JSON.stringify({ exists, snapshot: snap }, null, 2))
  if (!exists) throw new Error(`authority rehydrate failed: session ${sessionId} missing from backendSnapshot after SSE fallback`)
  return { closeRes, postPrivateAvailable: false, authorityExists: exists, statusAfter }
}

export async function runEventTransportPhase(
  vscodeApi: typeof vscode,
  scratch: string,
  sessionId: string,
): Promise<EventPhase> {
  const snap = (await vscodeApi.commands.executeCommand(CMD_SSE_TIMELINE_STOP)) as unknown
  writeFileSync(join(scratch, "prompt-private-timeline.json"), JSON.stringify(snap, null, 2))
  const timeline = summarizeTimeline(snap, sessionId)
  assertTimeline(timeline, sessionId)
  const llmRequestCount = await readLlmCount(vscodeApi, scratch)
  const tail = await closeAndRehydrate(vscodeApi, scratch, sessionId)
  return { timeline, llmRequestCount, ...tail }
}
