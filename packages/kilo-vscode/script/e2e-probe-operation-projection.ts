/**
 * Bounded live fd3/fd4 durable operation -> private observation -> AgentManager recentOperations/OperationStatus E2E probe.
 * Darwin/Linux only; Windows fails fast per existing harness convention.
 * Proves: real kilo serve SessionPromptDispatch via fd3/fd4 PrivatePeer -> observation/operations panel projection -> AgentManager recentOperations -> OperationStatus hidden/visible.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Browser, Frame } from "@playwright/test"
import type { E2EPlan } from "./e2e-probe-dom"
import { activeTabId, clickTab, findAgentManagerFrameAny, waitForFile } from "./e2e-probe-dom"
import { canonicalDbPath, validateGateEvidence } from "./e2e-canonical"

export interface OperationProjectionEvidence {
  scenario: string
  collectedAt: string
  pid: number
  canonical: { dbPath: string; gateOk: boolean; gateErr?: string }
  testBridge: boolean
  create: { opId: string; requestId: string; directory: string; privateSucceeded: boolean; sessionId: string }
  prompt: {
    opId: string
    requestId: string
    directory: string
    messageId: string
    privateSucceeded: boolean
    accepted: boolean
    sessionId: string
  }
  operations: {
    opId: string
    outcome: string
    found: boolean
    safe: boolean
    finite: boolean
    outcomeLegal: boolean
    limit: number
  }
  replay: { sameMessage: boolean; succeeded: boolean; opId: string; requestId: string; accepted: boolean }
  observation: { userCount: number; hasMarker: boolean; sessionExists: boolean }
  replayObservation: { userCountAfterReplay: number; hasMarker: boolean; noDuplicate: boolean }
  notifications: {
    beforeLen: number
    afterLen: number
    notifValidationBefore: unknown
    notifValidationAfter: unknown
    extraAllowed: boolean
  }
  recentOperations: { before: unknown; afterReplay: unknown; closeVerified: boolean | null; closeDetail?: string }
  statusTextExpect?: string
  shouldBeHidden?: boolean
}

function expectedStatusForOutcome(op: Record<string, unknown>): { text: string | undefined; tone: string } {
  const outcome = op.outcome as string | undefined
  if (outcome === "in-flight") return { text: "Running", tone: "running" }
  if (outcome === "succeeded") return { text: undefined, tone: "neutral" }
  if (outcome === "failed") return { text: `Failed · ${String(op.code)}: ${String(op.message)}`, tone: "error" }
  if (outcome === "abandoned") {
    const cancel = op.cancel as Record<string, unknown> | undefined
    const src = cancel?.source ? ` · ${String(cancel.source)}` : ""
    return { text: `Cancelled${src}`, tone: "cancelled" }
  }
  if (outcome === "ambiguous") return { text: "Ambiguous", tone: "neutral" }
  if (outcome === "superseded") return { text: "Superseded", tone: "neutral" }
  return { text: undefined, tone: "neutral" }
}

// eslint-disable-next-line complexity
export async function assertOperationProjectionLifecycle(
  browser: Browser,
  _plan: E2EPlan,
  scratch: string,
): Promise<void> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const timeout = 30_000
  await waitForFile(join(scratch, "operation-projection-ready"), 120_000, "operation-projection-ready marker")
  await waitForFile(join(scratch, "operation-projection-cstate.json"), timeout, "operation-projection-cstate")
  {
    const cstate = JSON.parse(readFileSync(join(scratch, "operation-projection-cstate.json"), "utf8")) as Record<
      string,
      unknown
    >
    console.log("[probe operation-projection fd3/fd4] cstate", JSON.stringify(cstate).slice(0, 400))
  }
  const gateRaw = readFileSync(join(scratch, "canonical-gate.json"), "utf8")
  const gate = JSON.parse(gateRaw) as Record<string, unknown>
  const gateErr = validateGateEvidence(gate)
  if (gateErr) throw new Error(`probe operation-projection: canonical gate invalid: ${gateErr}`)
  console.log("[probe operation-projection fd3/fd4] canonical gate ok via validateGateEvidence, gateOk=true")

  let cur = (await findAgentManagerFrameAny(browser, 60_000)).frame
  console.log("[probe operation-projection fd3/fd4] frame ready", cur.url())

  await waitForFile(
    join(scratch, "operation-projection-runtime-evidence"),
    120_000,
    "operation-projection runtime evidence",
  )
  const runtime = JSON.parse(
    readFileSync(join(scratch, "operation-projection-runtime-evidence"), "utf8"),
  ) as OperationProjectionEvidence & Record<string, unknown>

  if (runtime.scenario !== "operation-projection")
    throw new Error(`scenario must be operation-projection got ${String(runtime.scenario)}`)
  if (runtime.canonical?.gateOk !== true)
    throw new Error(`gateOk must be true, got ${String(runtime.canonical?.gateOk)}`)
  const create = runtime.create as Record<string, unknown> | undefined
  if (!create || create.privateSucceeded !== true)
    throw new Error(`private create must succeed via fd3/fd4, got ${JSON.stringify(create).slice(0, 500)}`)
  const sessionId = create.sessionId as string | undefined
  if (!sessionId || !sessionId.startsWith("ses")) throw new Error(`sessionId must be ses*, got ${String(sessionId)}`)
  const prompt = runtime.prompt as Record<string, unknown> | undefined
  if (!prompt || prompt.privateSucceeded !== true)
    throw new Error(`private prompt must succeed via fd3/fd4, got ${JSON.stringify(prompt).slice(0, 800)}`)
  if (prompt.accepted !== true) throw new Error(`prompt accepted must be true, got ${String(prompt.accepted)}`)
  const messageId = prompt.messageId as string | undefined
  if (!messageId || !messageId.startsWith("msg")) throw new Error(`messageId must be msg*, got ${String(messageId)}`)
  const expectedOpId = `prompt:${messageId}`
  if (prompt.opId !== expectedOpId)
    throw new Error(`opId must be canonical ${expectedOpId}, got ${String(prompt.opId)}`)
  const obs = runtime.observation as Record<string, unknown> | undefined
  if (!obs) throw new Error("observation missing")
  if (obs.hasMarker !== true) throw new Error(`observation hasMarker must be true, got ${String(obs.hasMarker)}`)
  if (typeof obs.userCount !== "number" || obs.userCount < 1)
    throw new Error(`userCount must be >=1, got ${String(obs.userCount)}`)
  if (obs.sessionExists !== true) throw new Error("sessionExists must be true")
  const ops = runtime.operations as Record<string, unknown> | undefined
  if (!ops || ops.found !== true)
    throw new Error(`operations found must be true, got ${JSON.stringify(ops).slice(0, 600)}`)
  if (ops.opId !== expectedOpId) throw new Error(`operations opId must be ${expectedOpId}, got ${String(ops.opId)}`)
  if (ops.safe !== true)
    throw new Error(`operations safe must be true (no detail/stack leak), got ${JSON.stringify(ops).slice(0, 600)}`)
  if (ops.finite !== true) throw new Error(`operations finite must be true, got ${JSON.stringify(ops).slice(0, 600)}`)
  if (ops.outcomeLegal !== true)
    throw new Error(`operations outcomeLegal must be true, got ${JSON.stringify(ops).slice(0, 600)}`)
  const outcome = ops.outcome as string | undefined
  const allowed = new Set(["succeeded", "failed", "ambiguous", "in-flight", "superseded", "abandoned"])
  if (!outcome || !allowed.has(outcome))
    throw new Error(`outcome must be legal ${Array.from(allowed).join(",")} got ${String(outcome)}`)
  // notification snapshot validation: if harness could read it, it must be valid
  const notifs = runtime.notifications as Record<string, unknown> | undefined
  if (notifs) {
    const vBefore = notifs.notifValidationBefore as Record<string, unknown> | undefined
    if (vBefore && typeof vBefore.valid === "boolean" && vBefore.valid === false) {
      const reason = (vBefore as Record<string, unknown>).reason as string | undefined
      // only fail if there were entries and validation failed
      const beforeLen = notifs.beforeLen as number | undefined
      if (typeof beforeLen === "number" && beforeLen > 0)
        throw new Error(`notification before validation failed: ${String(reason).slice(0, 400)}`)
    }
    const afterLen = notifs.afterLen as number | undefined
    const beforeLen = notifs.beforeLen as number | undefined
    if (typeof beforeLen === "number" && typeof afterLen === "number" && afterLen !== -1 && beforeLen !== -1) {
      if (afterLen > beforeLen + 1)
        throw new Error(`replay produced too many notifications before=${beforeLen} after=${afterLen} (max +1 allowed)`)
    }
  }

  const replay = runtime.replay as Record<string, unknown> | undefined
  if (!replay || replay.succeeded !== true)
    throw new Error(`replay must succeed, got ${JSON.stringify(replay).slice(0, 400)}`)
  if (replay.sameMessage !== true) throw new Error("replay sameMessage must be true")
  if (replay.accepted !== true) throw new Error("replay accepted must be true")
  if (replay.opId !== expectedOpId) throw new Error(`replay opId must equal ${expectedOpId}`)
  const replayObs = runtime.replayObservation as Record<string, unknown> | undefined
  if (!replayObs || replayObs.noDuplicate !== true)
    throw new Error(`replay noDuplicate must be true, got ${JSON.stringify(replayObs).slice(0, 400)}`)
  if (replayObs.userCountAfterReplay !== obs.userCount)
    throw new Error(`userCount after replay must equal before ${obs.userCount}, got ${replayObs.userCountAfterReplay}`)

  await waitForFile(join(scratch, "operation-projection-status.json"), timeout, "operation-projection-status")
  const status = JSON.parse(readFileSync(join(scratch, "operation-projection-status.json"), "utf8")) as Record<
    string,
    unknown
  >
  const canonical = canonicalDbPath(scratch)
  if (status.dbPath !== canonical)
    throw new Error(`canonical DB mismatch status.dbPath=${status.dbPath} canonical=${canonical}`)
  if (status.testBridge !== true) throw new Error(`testBridge not enabled status=${JSON.stringify(status)}`)

  // ---- AgentManager recentOperations via probe-side deterministic wait ----
  // Bounded wait for the private recentOps snapshot file and exact entry
  // recentOperations[sessionId].opId === prompt:<messageId>. No fallback to operations.
  const recentOpsPath = join(scratch, "operation-projection-recentops-before.json")
  const recentWaitDeadline = Date.now() + 30_000
  let recentOpsSnapshot: Record<string, unknown> | null = null
  let validatedEntry: Record<string, unknown> | null = null
  for (;;) {
    try {
      const raw = readFileSync(recentOpsPath, "utf8")
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const map =
        (parsed.recentOperations as Record<string, unknown> | undefined) ?? (parsed as Record<string, unknown>)
      const entry = map?.[sessionId] as Record<string, unknown> | undefined
      if (entry) {
        if (entry.opId !== expectedOpId) {
          if (Date.now() > recentWaitDeadline)
            throw new Error(`probe: recentOperations opId must be ${expectedOpId}, got ${String(entry.opId)}`)
        } else if ("detail" in entry || "stack" in entry) {
          throw new Error(`probe: recentOperations leaked detail/stack`)
        } else {
          recentOpsSnapshot = parsed
          validatedEntry = entry
          console.log(
            `[probe operation-projection fd3/fd4] recentOperations entry validated session=${sessionId} opId=${expectedOpId}`,
          )
          break
        }
      } else {
        if (Date.now() > recentWaitDeadline)
          throw new Error(`probe: recentOperations missing for ${sessionId} in scratch snapshot after bounded wait`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes("probe: recentOperations")) throw e
      if (Date.now() > recentWaitDeadline)
        throw new Error(
          `probe: recentOperations file missing or unreadable after bounded wait for ${sessionId}: ${msg.slice(0, 400)}`,
        )
    }
    if (Date.now() > recentWaitDeadline)
      throw new Error(
        `probe: recentOperations bounded wait deadline exceeded for ${sessionId} expected ${expectedOpId}`,
      )
    await sleep(250)
  }
  if (!validatedEntry) throw new Error(`probe: recentOperations validated entry missing for ${sessionId} (unreachable)`)
  // Derive DOM expectation exclusively from the validated recentOperations entry — no fallback.
  const opForDom: Record<string, unknown> = validatedEntry
  const expected = expectedStatusForOutcome(opForDom)
  const shouldBeHidden = expected.text === undefined
  const domOutcome = opForDom.outcome as string | undefined

  // Ensure the target session tab is active: deterministic polling with frame reacquire.
  const domDeadline = Date.now() + 30_000
  // wait for tab to exist at least once (webview may still be hydrating)
  for (;;) {
    if (cur.isDetached()) {
      const fresh = await findAgentManagerFrameAny(browser, 5_000)
      cur = fresh.frame
    }
    const active = await activeTabId(cur).catch(() => undefined)
    if (active === sessionId) break
    const exists = await cur
      .locator(`.am-tab-sortable[data-tab-id="${sessionId}"]`)
      .count()
      .catch(() => 0)
    if (exists === 0) {
      if (Date.now() > domDeadline)
        throw new Error(`probe: session tab ${sessionId} never appeared before DOM check (active=${String(active)})`)
      await sleep(250)
      continue
    }
    try {
      const remain = Math.max(1_000, domDeadline - Date.now())
      await clickTab(cur, sessionId, remain)
    } catch {
      if (Date.now() > domDeadline) throw new Error(`probe: clickTab ${sessionId} failed and deadline exceeded`)
      await sleep(250)
      continue
    }
    // poll active
    let polled: string | undefined
    const pollStart = Date.now()
    while (Date.now() - pollStart < 5_000) {
      if (cur.isDetached()) {
        const fresh = await findAgentManagerFrameAny(browser, 2_000).catch(() => null)
        if (fresh) cur = fresh.frame
      }
      polled = await activeTabId(cur).catch(() => undefined)
      if (polled === sessionId) break
      await sleep(250)
    }
    if (polled === sessionId) break
    if (Date.now() > domDeadline)
      throw new Error(`probe: activeTabId never converged to ${sessionId} (last=${String(polled)})`)
    await sleep(250)
  }

  // Now cur is guaranteed active for sessionId — poll scoped OperationStatus
  const scopedSel = `[data-component="am-operation-status"][data-session-id="${sessionId}"]`
  const textSel = `${scopedSel} [data-slot="am-operation-text"]`
  if (shouldBeHidden) {
    const hiddenDeadline = Date.now() + 15_000
    for (;;) {
      if (cur.isDetached()) {
        const fresh = await findAgentManagerFrameAny(browser, 2_000).catch(() => null)
        if (fresh) cur = fresh.frame
      }
      const activeNow = await activeTabId(cur).catch(() => undefined)
      if (activeNow !== sessionId)
        throw new Error(`probe: active tab changed from ${sessionId} to ${String(activeNow)} while verifying hidden`)
      const count = await cur
        .locator(scopedSel)
        .count()
        .catch(() => 0)
      if (count === 0) {
        // Also ensure no legacy global bare element is leaking the same session (defense: global check must also be 0 for this outcome? Not required)
        console.log(
          `[probe operation-projection fd3/fd4] OperationStatus correctly hidden for ${sessionId} outcome=${String(domOutcome)}`,
        )
        break
      }
      if (Date.now() > hiddenDeadline) {
        const text = await cur
          .locator(textSel)
          .first()
          .textContent()
          .catch(() => "<unreadable>")
        const tone = await cur
          .locator(scopedSel)
          .first()
          .getAttribute("data-tone")
          .catch(() => "<no-tone>")
        throw new Error(
          `OperationStatus should be hidden for succeeded outcome session=${sessionId} but found visible count=${count} tone=${String(tone)} text=${String(text).slice(0, 200)}`,
        )
      }
      await sleep(250)
    }
  } else {
    const visibleDeadline = Date.now() + 15_000
    const expText = expected.text ?? ""
    const expTone = expected.tone
    for (;;) {
      if (cur.isDetached()) {
        const fresh = await findAgentManagerFrameAny(browser, 2_000).catch(() => null)
        if (fresh) cur = fresh.frame
      }
      const activeNow = await activeTabId(cur).catch(() => undefined)
      if (activeNow !== sessionId)
        throw new Error(`probe: active tab changed from ${sessionId} to ${String(activeNow)} while verifying visible`)
      const count = await cur
        .locator(scopedSel)
        .count()
        .catch(() => 0)
      if (count === 1) {
        const text = await cur
          .locator(textSel)
          .first()
          .textContent()
          .catch(() => "")
        const tone = await cur
          .locator(scopedSel)
          .first()
          .getAttribute("data-tone")
          .catch(() => "")
        const outcomeAttr = await cur
          .locator(scopedSel)
          .first()
          .getAttribute("data-outcome")
          .catch(() => "")
        if (outcomeAttr !== String(domOutcome)) {
          if (Date.now() > visibleDeadline)
            throw new Error(
              `OperationStatus data-outcome mismatch expected ${String(domOutcome)} got ${String(outcomeAttr)}`,
            )
          await sleep(250)
          continue
        }
        if (tone !== expTone) {
          if (Date.now() > visibleDeadline)
            throw new Error(
              `OperationStatus tone mismatch expected ${expTone} got ${String(tone)} for outcome=${String(domOutcome)}`,
            )
          await sleep(250)
          continue
        }
        if (text !== expText) {
          // strict equality: OperationStatus text must match helper output for this outcome
          if (Date.now() > visibleDeadline)
            throw new Error(
              `OperationStatus text mismatch expected "${expText}" got "${String(text).slice(0, 200)}" for outcome=${String(domOutcome)}`,
            )
          await sleep(250)
          continue
        }
        if (!text || text.length === 0) {
          if (Date.now() > visibleDeadline)
            throw new Error(`OperationStatus text empty for outcome=${String(domOutcome)}`)
          await sleep(250)
          continue
        }
        if (text.includes("detail") || text.includes("stack") || text.includes("[redacted]"))
          throw new Error(`OperationStatus leaked detail/stack text=${text.slice(0, 200)}`)
        console.log(
          `[probe operation-projection fd3/fd4] OperationStatus visible for session=${sessionId} outcome=${String(domOutcome)} text=${text.slice(0, 120)} tone=${tone}`,
        )
        break
      }
      if (count > 1)
        throw new Error(
          `OperationStatus scoped count=${count} for session=${sessionId} expected 1 (no duplicate for private-only recentOperations)`,
        )
      if (Date.now() > visibleDeadline)
        throw new Error(
          `OperationStatus should be visible for outcome=${String(domOutcome)} session=${sessionId} but found hidden (count=0) expected text="${expText}"`,
        )
      await sleep(250)
    }
  }

  // DOM verification passed — publish evidence BEFORE close/forget (fixes tab-removed race)
  console.log(
    `[probe operation-projection fd3/fd4] DOM verification passed for ${sessionId} outcome=${String((opForDom as Record<string, unknown>).outcome)} shouldBeHidden=${shouldBeHidden}`,
  )
  writeFileSync(
    join(scratch, "operation-projection-dom-evidence"),
    JSON.stringify(
      {
        url: cur.url(),
        runtime,
        canonical,
        status,
        opForDom,
        expected,
        shouldBeHidden,
        outcome: (opForDom as Record<string, unknown>).outcome,
      },
      null,
      2,
    ),
  )
  console.log(
    "[probe operation-projection fd3/fd4] dom-evidence written, awaiting post-DOM close/forget verification (bounded wait)",
  )

  // ---- close/forget verification AFTER DOM (boundary executes close only after dom-evidence) ----
  const closeWaitDeadline = Date.now() + 60_000
  let closeVerified: boolean | null | undefined
  let closeDetail: string | undefined
  let closeRaw: Record<string, unknown> | null = null
  let afterCloseSnapshot: Record<string, unknown> | null = null
  for (;;) {
    try {
      const raw = readFileSync(join(scratch, "operation-projection-close-check.json"), "utf8")
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const cv = parsed.closeVerified as boolean | null | undefined
      const cd = parsed.closeDetail as string | undefined
      // boundary's pending marker is "pending DOM verification — close/forget not yet executed"
      const isPending = cd === "pending DOM verification — close/forget not yet executed"
      if (!isPending) {
        // also require after-close snapshot exists
        const acRaw = readFileSync(join(scratch, "operation-projection-recentops-after-close.json"), "utf8")
        afterCloseSnapshot = JSON.parse(acRaw) as Record<string, unknown>
        closeRaw = parsed
        closeVerified = cv
        closeDetail = cd
        break
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes("probe:")) throw e
    }
    if (Date.now() > closeWaitDeadline) {
      throw new Error(`probe: close/forget verification bounded wait timeout after DOM evidence for ${sessionId}`)
    }
    await sleep(250)
  }
  if (closeVerified === true) {
    // also assert after-close snapshot does not contain the session
    if (afterCloseSnapshot) {
      const mapAfter =
        ((afterCloseSnapshot as Record<string, unknown>).recentOperations as Record<string, unknown> | undefined) ??
        (afterCloseSnapshot as Record<string, unknown>)
      if ((mapAfter as Record<string, unknown>)[sessionId] !== undefined) {
        throw new Error(
          `probe: post-close recentOperations still contains ${sessionId}: ${JSON.stringify((mapAfter as Record<string, unknown>)[sessionId]).slice(0, 400)}`,
        )
      }
      if ("detail" in (closeRaw as object) || "stack" in (closeRaw as object))
        throw new Error(`probe: close check leaked detail/stack`)
    }
    console.log(`[probe operation-projection fd3/fd4] close/forget cleared recentOperations verified (post-DOM)`)
  } else if (closeVerified === false) {
    console.warn(
      `[probe operation-projection fd3/fd4] close/forget did not clear recentOperations: ${String(closeDetail).slice(0, 400)}`,
    )
    throw new Error(`close/forget verification failed: ${String(closeDetail).slice(0, 400)}`)
  } else {
    console.log(
      `[probe operation-projection fd3/fd4] close/forget unverified (no easy bridge): ${String(closeDetail ?? "no detail").slice(0, 300)}`,
    )
  }

  console.log(
    `[probe operation-projection fd3/fd4] proven session=${sessionId} msg=${messageId} opId=${expectedOpId} outcome=${String((opForDom as Record<string, unknown>).outcome)} userCount=${obs.userCount} replaySame=${replay.sameMessage} gateOk=${runtime.canonical?.gateOk}`,
  )

  // dom-evidence already written; also ensure final marker for boundary's done loop visibility
  console.log("[probe operation-projection fd3/fd4] lifecycle passed via ServePrivatePeer fd3/fd4 boundary")
}
