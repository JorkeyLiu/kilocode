/**
 * Bounded live fd3/fd4 session/prompt private-first E2E probe.
 * Darwin/Linux only; Windows fails fast per existing harness convention.
 * Proves: real kilo serve SessionPromptDispatch.dispatch via fd3/fd4 PrivatePeer
 * -> ServePrivatePeer strict prompt validation -> extension Host privatePromptWithHandle
 * returns accepted:true succeeded. Verifies explicit messageID tuple preserved,
 * runtime observation read path sees the user message, no duplicate user message
 * on idempotent replay.
 *
 * noReply:true premise: the prompt operation succeeds but NO Runner generation
 * is ever enqueued, so canonical SQLite must carry NO owner/member rows for
 * the op (absence asserted read-only via e2e-generation-gate.ts — no false
 * owner/member). There is deliberately no observation/generation RPC: the
 * harness reads the run-owned DB directly through the Bun-only gate child.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Browser, Frame } from "@playwright/test"
import type { E2EPlan } from "./e2e-probe-dom"
import { findAgentManagerFrameAny, waitForFile } from "./e2e-probe-dom"
import { canonicalDbPath, validateGateEvidence } from "./e2e-canonical"
import { assertNoFalseGeneration } from "./e2e-generation-assert"

export interface PromptPrivateFirstEvidence {
  scenario: string
  collectedAt: string
  pid: number
  canonical: { dbPath: string; gateOk: boolean; gateErr?: string }
  testBridge: boolean
  create: { opId: string; requestId: string; directory: string; privateSucceeded: boolean; sessionId: string }
  prompt: { opId: string; requestId: string; directory: string; messageId: string; privateSucceeded: boolean; accepted: boolean; sessionId: string }
  replay: { sameMessage: boolean; succeeded: boolean; opId: string; requestId: string; accepted: boolean }
  observation: { userCount: number; hasMarker: boolean; sessionExists: boolean }
  generation: { opId: string }
  replayObservation: { userCountAfterReplay: number; hasMarker: boolean; noDuplicate: boolean }
  eventTransport: {
    preLive: string | null
    preSseActive: boolean
    preEventCapable: boolean
    preEventLive: boolean
    preConnected: boolean
    timelineCount: number
    timelineHasSessionEntry: boolean
    timelineKinds: string[]
    postLive: string | null
    postSseActive: boolean
    postConnected: boolean
    postPrivateAvailable: boolean
    authoritySessionExists: boolean
    llmRequestCount: number
  }
}

export function assertPromptPrivateEventTransport(runtime: PromptPrivateFirstEvidence): Record<string, unknown> {
  const transport = runtime.eventTransport as Record<string, unknown> | undefined
  if (!transport) throw new Error("eventTransport missing (private event/notify proof required)")
  if (transport.preLive !== "private") throw new Error(`preLive must be private, got ${String(transport.preLive)}`)
  if (transport.preSseActive !== false) throw new Error("preSseActive must be false (no client.global.event SSE while private live)")
  if (transport.preEventCapable !== true) throw new Error("preEventCapable must be true (event/notify capability)")
  if (transport.preEventLive !== true) throw new Error("preEventLive must be true")
  if (transport.preConnected !== true) throw new Error("preConnected must be true")
  if (typeof transport.timelineCount !== "number" || transport.timelineCount < 1) throw new Error(`timelineCount must be >=1, got ${String(transport.timelineCount)}`)
  if (transport.timelineHasSessionEntry !== true) throw new Error(`timelineHasSessionEntry must be true, got ${JSON.stringify(transport).slice(0, 400)}`)
  if (transport.postLive !== "sse") throw new Error(`postLive must be sse after FD close, got ${String(transport.postLive)}`)
  if (transport.postSseActive !== true) throw new Error("postSseActive must be true after FD close")
  if (transport.postConnected !== true) throw new Error("postConnected must be true after SSE fallback")
  if (transport.postPrivateAvailable !== false) throw new Error("postPrivateAvailable must be false (single live source)")
  if (transport.authoritySessionExists !== true) throw new Error("authoritySessionExists must be true after SSE fallback")
  if (transport.llmRequestCount !== 0) throw new Error(`llmRequestCount must be 0 (no model network), got ${String(transport.llmRequestCount)}`)
  return transport
}

export async function assertPromptPrivateFirstLifecycle(browser: Browser, _plan: E2EPlan, scratch: string, root: string): Promise<void> {
  const timeout = 30_000
  await waitForFile(join(scratch, "prompt-private-ready"), 120_000, "prompt-private-ready marker")
  await waitForFile(join(scratch, "prompt-private-cstate.json"), timeout, "prompt-private-cstate")
  {
    const cstate = JSON.parse(readFileSync(join(scratch, "prompt-private-cstate.json"), "utf8")) as Record<string, unknown>
    console.log("[probe prompt-private fd3/fd4] cstate", JSON.stringify(cstate).slice(0, 400))
  }
  const gateRaw = readFileSync(join(scratch, "canonical-gate.json"), "utf8")
  const gate = JSON.parse(gateRaw) as Record<string, unknown>
  const gateErr = validateGateEvidence(gate)
  if (gateErr) throw new Error(`probe prompt-private: canonical gate invalid: ${gateErr}`)
  console.log("[probe prompt-private fd3/fd4] canonical gate ok via validateGateEvidence, gateOk=true")

  const found = await findAgentManagerFrameAny(browser, 60_000)
  const frame: Frame = found.frame
  console.log("[probe prompt-private fd3/fd4] frame ready", found.url)

  await waitForFile(join(scratch, "prompt-private-runtime-evidence"), 120_000, "prompt-private runtime evidence")
  const runtime = JSON.parse(readFileSync(join(scratch, "prompt-private-runtime-evidence"), "utf8")) as PromptPrivateFirstEvidence & Record<string, unknown>

  if (runtime.scenario !== "prompt-private-first") throw new Error(`scenario must be prompt-private-first got ${String(runtime.scenario)}`)
  if (runtime.canonical?.gateOk !== true) throw new Error(`gateOk must be true, got ${String(runtime.canonical?.gateOk)}`)
  const create = runtime.create as Record<string, unknown> | undefined
  if (!create || create.privateSucceeded !== true) throw new Error(`private create must succeed via fd3/fd4, got ${JSON.stringify(create).slice(0, 500)}`)
  const sessionId = create.sessionId as string | undefined
  if (!sessionId || !sessionId.startsWith("ses")) throw new Error(`sessionId must be ses*, got ${String(sessionId)}`)
  const prompt = runtime.prompt as Record<string, unknown> | undefined
  if (!prompt || prompt.privateSucceeded !== true) throw new Error(`private prompt must succeed via fd3/fd4, got ${JSON.stringify(prompt).slice(0, 800)}`)
  if (prompt.accepted !== true) throw new Error(`prompt accepted must be true, got ${String(prompt.accepted)}`)
  const messageId = prompt.messageId as string | undefined
  if (!messageId || !messageId.startsWith("msg")) throw new Error(`messageId must be msg*, got ${String(messageId)}`)
  const expectedOpId = `prompt:${messageId}`
  if (prompt.opId !== expectedOpId) throw new Error(`opId must be canonical ${expectedOpId}, got ${String(prompt.opId)}`)
  const obs = runtime.observation as Record<string, unknown> | undefined
  if (!obs) throw new Error("observation missing")
  if (obs.hasMarker !== true) throw new Error(`observation hasMarker must be true, got ${String(obs.hasMarker)}`)
  if (typeof obs.userCount !== "number" || obs.userCount < 1) throw new Error(`userCount must be >=1, got ${String(obs.userCount)}`)
  if (obs.sessionExists !== true) throw new Error("sessionExists must be true")
  const replay = runtime.replay as Record<string, unknown> | undefined
  if (!replay || replay.succeeded !== true) throw new Error(`replay must succeed, got ${JSON.stringify(replay).slice(0, 400)}`)
  if (replay.sameMessage !== true) throw new Error("replay sameMessage must be true")
  if (replay.accepted !== true) throw new Error("replay accepted must be true")
  if (replay.opId !== expectedOpId) throw new Error(`replay opId must equal ${expectedOpId}`)
  const replayObs = runtime.replayObservation as Record<string, unknown> | undefined
  if (!replayObs || replayObs.noDuplicate !== true) throw new Error(`replay noDuplicate must be true, got ${JSON.stringify(replayObs).slice(0, 400)}`)
  if (replayObs.userCountAfterReplay !== obs.userCount) throw new Error(`userCount after replay must equal before ${obs.userCount}, got ${replayObs.userCountAfterReplay}`)
  // noReply:true premise: prompt operation succeeded but no Runner generation
  // was enqueued — assert ABSENCE (no false owner/member) read-only through
  // the Bun gate child. Never require existence here.
  const genRef = runtime.generation as { opId?: string } | undefined
  if (!genRef || genRef.opId !== expectedOpId) throw new Error(`generation opId must equal ${expectedOpId}, got ${String(genRef?.opId)}`)
  const dbPath = canonicalDbPath(scratch)
  assertNoFalseGeneration(root, scratch, dbPath, sessionId, expectedOpId)

  const transport = assertPromptPrivateEventTransport(runtime)

  await waitForFile(join(scratch, "prompt-private-status.json"), timeout, "prompt-private-status")
  const status = JSON.parse(readFileSync(join(scratch, "prompt-private-status.json"), "utf8")) as Record<string, unknown>
  const canonical = canonicalDbPath(scratch)
  if (status.dbPath !== canonical) throw new Error(`canonical DB mismatch status.dbPath=${status.dbPath} canonical=${canonical}`)
  if (status.testBridge !== true) throw new Error(`testBridge not enabled status=${JSON.stringify(status)}`)
  console.log(`[probe prompt-private fd3/fd4] proven session=${sessionId} msg=${messageId} userCount=${obs.userCount} replaySame=${replay.sameMessage} gateOk=${runtime.canonical?.gateOk} eventLive=${transport.preLive}->${transport.postLive} timeline=${transport.timelineCount} llm=${transport.llmRequestCount} noFalseOwnerMember=${expectedOpId}`)

  writeFileSync(join(scratch, "prompt-private-dom-evidence"), JSON.stringify({ url: frame.url(), runtime, canonical, status }, null, 2))
  console.log("[probe prompt-private fd3/fd4] lifecycle passed via ServePrivatePeer fd3/fd4 boundary")
}
