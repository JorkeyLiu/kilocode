/**
 * Bounded live fd3/fd4 session/prompt private-first E2E probe.
 * Darwin/Linux only; Windows fails fast per existing harness convention.
 * Proves: real kilo serve SessionPromptDispatch.dispatch via fd3/fd4 PrivatePeer
 * -> ServePrivatePeer strict prompt validation -> extension Host privatePromptWithHandle
 * returns accepted:true succeeded. Verifies explicit messageID tuple preserved,
 * runtime observation read path sees the user message, no duplicate user message
 * or duplicate generation on idempotent replay.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Browser, Frame } from "@playwright/test"
import type { E2EPlan } from "./e2e-probe-dom"
import { findAgentManagerFrameAny, waitForFile } from "./e2e-probe-dom"
import { canonicalDbPath, validateGateEvidence } from "./e2e-canonical"

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
  replayObservation: { userCountAfterReplay: number; hasMarker: boolean; noDuplicate: boolean }
}

export async function assertPromptPrivateFirstLifecycle(browser: Browser, _plan: E2EPlan, scratch: string): Promise<void> {
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

  await waitForFile(join(scratch, "prompt-private-status.json"), timeout, "prompt-private-status")
  const status = JSON.parse(readFileSync(join(scratch, "prompt-private-status.json"), "utf8")) as Record<string, unknown>
  const canonical = canonicalDbPath(scratch)
  if (status.dbPath !== canonical) throw new Error(`canonical DB mismatch status.dbPath=${status.dbPath} canonical=${canonical}`)
  if (status.testBridge !== true) throw new Error(`testBridge not enabled status=${JSON.stringify(status)}`)
  console.log(`[probe prompt-private fd3/fd4] proven session=${sessionId} msg=${messageId} userCount=${obs.userCount} replaySame=${replay.sameMessage} gateOk=${runtime.canonical?.gateOk}`)

  writeFileSync(join(scratch, "prompt-private-dom-evidence"), JSON.stringify({ url: frame.url(), runtime, canonical, status }, null, 2))
  console.log("[probe prompt-private fd3/fd4] lifecycle passed via ServePrivatePeer fd3/fd4 boundary")
}
