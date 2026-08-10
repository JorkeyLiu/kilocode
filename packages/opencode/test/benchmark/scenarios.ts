/**
 * Backend P0 benchmark scenarios (6, 7, 8, 9, 11, 12, 13).
 *
 * Every scenario drives the real production HTTP/SSE path against the harness
 * listener (Server.listen/AppLayer) and a real loopback TestLLMServer. No
 * core service is mocked; the only fixture is the project `opencode.json`
 * provider block pointing `test/test-model` at the loopback LLM.
 *
 * Scenario semantics:
 *   6  first prompt        — cold instance boot → first assistant text.
 *   7  large streaming     — 50-chunk / 200 KB reply; first-delta vs total.
 *   8  parallel sessions   — 4 concurrent generations across sessions.
 *   9  permission-heavy    — 2 real ask/reply rounds gating real bash tool runs.
 *   11 hot config update   — hot PATCH during a held generation; no convergence.
 *   12 cold provider PATCH — during a held generation; LOCK-011 snapshot pin +
 *                            convergence evidence + post-convergence new model.
 *   13 burst cold updates  — 5 concurrent cold PATCHes; coalescing evidence.
 *
 * Locked semantics honored (no challenge): LOCK-009 (HTTP/SSE bridge is the
 * production path today), LOCK-011 (active generation pins its config/runtime
 * snapshot; cold updates never interrupt it), LOCK-PERF-1..7 (per-sample raw
 * stages + counts, never a single-run claim, no SLA wording).
 */

import * as P0 from "./p0-records"
import type { BackendHandle, SseEvent } from "./backend"
import { api, json, run, subscribe } from "./backend"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SamplePhase = "warmup" | "measured"

export type ScenarioCtx = {
  readonly backend: BackendHandle
  /** Project directory (git repo with opencode.json provider fixture). */
  readonly dir: string
  readonly sampleNo: number
  readonly phase: SamplePhase
  /** P0 capture index at sample start (use `slice` for this sample's records). */
  readonly recordStart: number
}

export type ScenarioResult = {
  ok: boolean
  blocked: { reason: string; detail: string } | null
  /** Key latencies (ms). Values always present; absent metrics are simply not set. */
  metrics: Record<string, number>
  /** Stage/event counts. */
  counts: Record<string, number>
  /** Raw evidence (bodies, seqs, statuses) for the JSONL sample line. */
  evidence: Record<string, unknown>
  failures: string[]
}

export type Scenario = {
  id: string
  name: string
  run: (ctx: ScenarioCtx) => Promise<ScenarioResult>
}

const ok = (partial: Omit<ScenarioResult, "ok" | "blocked">): ScenarioResult => ({
  ...partial,
  ok: partial.failures.length === 0,
  blocked: null,
})

const fail = (partial: Omit<ScenarioResult, "ok" | "blocked">, failures: string[]): ScenarioResult => ({
  ...partial,
  ok: false,
  blocked: null,
  failures,
})

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

export const modelDef = (id: string) => ({
  id,
  name: `P0 ${id}`,
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  release_date: "2025-01-01",
  limit: { context: 100_000, output: 10_000 },
  cost: { input: 0, output: 0 },
  options: {},
})

/** Full provider block pointing at the loopback LLM (deep-merged on PATCH). */
export const providerBlock = (llmUrl: string, extraModels: Record<string, unknown> = {}) => ({
  name: "Test",
  id: "test",
  env: [],
  npm: "@ai-sdk/openai-compatible",
  models: { "test-model": modelDef("test-model"), ...extraModels },
  options: { apiKey: "test-key", baseURL: llmUrl },
})

// ---------------------------------------------------------------------------
// Shared HTTP helpers
// ---------------------------------------------------------------------------

const createSession = (ctx: ScenarioCtx, input: Record<string, unknown> = {}) =>
  json<{ id: string }>(
    api(ctx.backend.base, ctx.dir, "/session", {
      method: "POST",
      json: { title: "p0-bench", ...input },
    }),
  )

type PromptPayload = {
  agent?: string
  model?: { providerID: string; modelID: string }
  parts: Array<{ type: "text"; text: string }>
}

const promptPayload = (text: string, model: string): PromptPayload => ({
  agent: "build",
  model: { providerID: "test", modelID: model },
  parts: [{ type: "text", text }],
})

const promptAsync = (ctx: ScenarioCtx, sessionID: string, text: string, model = "test-model") =>
  api(ctx.backend.base, ctx.dir, `/session/${sessionID}/prompt_async`, {
    method: "POST",
    json: promptPayload(text, model),
  })

const okStatus = (res: { status: number }): boolean => res.status >= 200 && res.status < 300

const statusOf = async (ctx: ScenarioCtx, sessionID: string): Promise<string | undefined> => {
  const map = await json<Record<string, { type: string }>>(api(ctx.backend.base, ctx.dir, "/session/status"))
  return map[sessionID]?.type
}

/** Poll until the session is no longer busy (entry absent = idle; offline is distinct). */
const waitIdle = async (ctx: ScenarioCtx, sessionID: string, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const type = await statusOf(ctx, sessionID)
    if (type === undefined || type === "idle") return
    if (type === "offline") throw new Error(`session ${sessionID} offline while waiting for idle`)
    await Bun.sleep(25)
  }
  throw new Error(`session ${sessionID} never became idle within ${timeoutMs}ms`)
}

const waitBusy = async (ctx: ScenarioCtx, sessionID: string, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const type = await statusOf(ctx, sessionID)
    if (type === "busy") return
    if (type === "offline") return // permission ask parks the session as offline
    await Bun.sleep(25)
  }
  throw new Error(`session ${sessionID} never became busy within ${timeoutMs}ms`)
}

/**
 * Wait for a generation to complete: observe busy first (the prompt_async fork
 * is asynchronous — the status map can be empty before the processor starts),
 * then wait for idle/absent.
 */
const waitDone = async (ctx: ScenarioCtx, sessionID: string, timeoutMs = 30_000): Promise<void> => {
  await waitBusy(ctx, sessionID, timeoutMs)
  await waitIdle(ctx, sessionID, timeoutMs)
}

/** Poll LLM server hits until one carries the marker text (the held call is in flight). */
const waitLlmBody = async (ctx: ScenarioCtx, marker: string, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hits = await run(ctx.backend.llm.hits)
    if (hits.some((hit) => JSON.stringify(hit.body).includes(marker))) return
    await Bun.sleep(25)
  }
  throw new Error(`LLM hit with marker "${marker}" never arrived within ${timeoutMs}ms`)
}

/** Await a convergence_complete P0 record whose meta.seq >= minSeq (bounded poll). */
const waitConvergence = async (
  ctx: ScenarioCtx,
  minSeq: number,
  timeoutMs = 25_000,
): Promise<P0.P0Record | undefined> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const slice = ctx.backend.capture.slice(ctx.recordStart)
    const hit = P0.stageRecords(slice, "convergence_complete").find((rec) => P0.seqOf(rec) >= minSeq)
    if (hit) return hit
    await Bun.sleep(50)
  }
  return undefined
}

/**
 * First-span duration metrics (ms) from a sample's p0 slice. The metric name
 * states the occurrence semantics explicitly — only the FIRST completed span
 * of each stage is reported (e.g. firstInstanceBootstrapMs), so a sample with
 * a convergence reboot (scenarios 12/13) never conflates the reboot span with
 * the cold-boot span. Stages without a completed span are omitted.
 */
const stageDurations = (slice: P0.P0Record[]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const stage of P0.STAGES) {
    const durations = P0.stageDurations(slice, stage)
    if (durations.length > 0) out[firstSpanMetric(stage)] = durations[0]!
  }
  return out
}

/** First-span metric key for a stage: instance_bootstrap → firstInstanceBootstrapMs. */
const firstSpanMetric = (stage: string): string => {
  const camel = stage.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
  return `first${camel[0]!.toUpperCase()}${camel.slice(1)}Ms`
}

/**
 * Stage counts with unambiguous semantics: span stages (listener, config_load,
 * instance_bootstrap, provider_state_init) count COMPLETED spans — a
 * start+end pair is 1, never 2 — while mark stages count records. Unmatched
 * starts (failure/interruption signal) are never counted.
 */
const countStages = (slice: P0.P0Record[]): Record<string, number> => {
  const spanStages = new Set<string>(P0.SPAN_STAGES)
  const out: Record<string, number> = {}
  for (const stage of P0.STAGES) {
    const count = spanStages.has(stage) ? P0.stageSpans(slice, stage).spans : P0.countStage(slice, stage)
    if (count > 0) out[stage] = count
  }
  return out
}

// ---------------------------------------------------------------------------
// Scenario 6 — first prompt (cold instance boot → first assistant text)
// ---------------------------------------------------------------------------

async function scenario6(ctx: ScenarioCtx): Promise<ScenarioResult> {
  const failures: string[] = []
  const sub = subscribe(ctx.backend.base, ctx.dir)
  const t0 = Date.now()
  try {
    await run(ctx.backend.llm.text("first answer", { usage: { input: 10, output: 5 } }))
    const session = await createSession(ctx)
    const of = (type: string) => (event: SseEvent) => event.type === type && event.properties.sessionID === session.id
    await promptAsync(ctx, session.id, "first prompt")
    // Accumulate the session's text deltas until idle: the first assistant
    // reply must be exactly the QUEUED reply content ("first answer"), not the
    // LLM server's auto-reply fallback ("ok") that fires when the queue is
    // empty.
    const replyDeltas: string[] = []
    let firstDeltaT = 0
    const ended = await sub.waitFor(
      (event) => {
        if (
          of("message.part.delta")(event) &&
          event.properties.field === "text" &&
          typeof event.properties.delta === "string"
        ) {
          replyDeltas.push(event.properties.delta)
          if (firstDeltaT === 0) firstDeltaT = Date.now()
        }
        return (
          of("session.status")(event) &&
          typeof event.properties.status === "object" &&
          (event.properties.status as { type?: string }).type === "idle"
        )
      },
      25_000,
    )
    await waitIdle(ctx, session.id)
    const t1 = Date.now()

    const slice = ctx.backend.capture.slice(ctx.recordStart)
    const entry = P0.firstStage(slice, "processor_entry")
    const replyText = replyDeltas.join("")
    if (!ended) failures.push("no session.status idle event")
    if (replyText !== "first answer") {
      failures.push(
        `first reply text ${JSON.stringify(replyText)}, expected "first answer" (queued reply content, not an auto-reply)`,
      )
    }
    if (!entry) failures.push("no processor_entry mark")
    return ok({
      metrics: {
        totalMs: Math.round(t1 - t0),
        startToFirstDeltaMs: Math.round((firstDeltaT || t0) - t0),
        firstDeltaToIdleMs: Math.round(t1 - (firstDeltaT || t0)),
        processorEntryToIdleMs: Math.round(t1 - (entry?.ts ?? t0)),
        ...stageDurations(slice),
      },
      counts: countStages(slice),
      evidence: { sessionID: session.id, processorEntry: entry?.meta, replyText },
      failures,
    })
  } finally {
    sub.close()
  }
}

// ---------------------------------------------------------------------------
// Scenario 7 — large streaming output (50 x 4 KB chunks; first-delta vs total)
// ---------------------------------------------------------------------------

const CHUNKS = 50
const CHUNK_SIZE = 4_000

async function scenario7(ctx: ScenarioCtx): Promise<ScenarioResult> {
  const failures: string[] = []
  const sub = subscribe(ctx.backend.base, ctx.dir)
  const t0 = Date.now()
  try {
    let reply = (await import("../lib/llm-server")).reply()
    for (let i = 0; i < CHUNKS; i++) reply = reply.text("x".repeat(CHUNK_SIZE))
    await run(ctx.backend.llm.push(reply.stop().item()))
    const session = await createSession(ctx)
    const of = (type: string) => (event: SseEvent) => event.type === type && event.properties.sessionID === session.id
    await promptAsync(ctx, session.id, "stream it")
    let bytes = 0
    let deltaCount = 0
    let firstDeltaT = 0
    let lastDeltaT = 0
    const ended = await sub.waitFor(
      (event) => {
        if (of("message.part.delta")(event) && event.properties.field === "text") {
          const delta = event.properties.delta
          if (typeof delta === "string") {
            bytes += delta.length
            deltaCount += 1
            if (firstDeltaT === 0) firstDeltaT = Date.now()
            lastDeltaT = Date.now()
          }
        }
        return (
          of("session.status")(event) &&
          typeof event.properties.status === "object" &&
          (event.properties.status as { type?: string }).type === "idle"
        )
      },
      25_000,
    )
    await waitIdle(ctx, session.id)
    const t1 = Date.now()

    const slice = ctx.backend.capture.slice(ctx.recordStart)
    if (!ended) failures.push("no session.status idle event")
    if (bytes < CHUNKS * CHUNK_SIZE) {
      failures.push(`streamed bytes ${bytes} < expected ${CHUNKS * CHUNK_SIZE}`)
    }
    return ok({
      metrics: {
        totalMs: Math.round(t1 - t0),
        firstDeltaToLastDeltaMs: Math.round(lastDeltaT - firstDeltaT),
        firstDeltaToIdleMs: Math.round(t1 - (firstDeltaT || t0)),
        streamBytesPerMs: bytes > 0 ? Math.round(bytes / Math.max(1, t1 - t0)) : 0,
        ...stageDurations(slice),
      },
      counts: { deltaEvents: deltaCount, ...countStages(slice) },
      evidence: {
        bytes,
        deltaCount,
        expectedBytes: CHUNKS * CHUNK_SIZE,
        firstDeltaT,
        lastDeltaT,
      },
      failures,
    })
  } finally {
    sub.close()
  }
}

// ---------------------------------------------------------------------------
// Scenario 8 — parallel session generations (4 concurrent prompts, one server)
// ---------------------------------------------------------------------------

const PARALLEL = 4

async function scenario8(ctx: ScenarioCtx): Promise<ScenarioResult> {
  const failures: string[] = []
  const t0 = Date.now()
  try {
    const sessions = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) => createSession(ctx, { title: `p0-parallel-${i}` })),
    )
    for (let i = 0; i < PARALLEL; i++) {
      await run(ctx.backend.llm.text(`parallel answer ${i}`))
    }
    const accepted = await Promise.all(sessions.map((session) => promptAsync(ctx, session.id, `parallel prompt ${session.id}`)))
    const t1 = Date.now()
    const idleStart = Date.now()
    await Promise.all(sessions.map((session) => waitDone(ctx, session.id)))
    const t2 = Date.now()

    const slice = ctx.backend.capture.slice(ctx.recordStart)
    const entries = P0.stageRecords(slice, "processor_entry")
    if (accepted.some((res) => !okStatus(res))) failures.push("a parallel prompt was not accepted")
    if (entries.length < PARALLEL) failures.push(`processor_entry count ${entries.length} < ${PARALLEL}`)
    return ok({
      metrics: {
        totalMs: Math.round(t2 - t0),
        parallelToAcceptMs: Math.round(t1 - t0),
        acceptToAllIdleMs: Math.round(t2 - t1),
        idleWaitMs: Math.round(Date.now() - idleStart),
        ...stageDurations(slice),
      },
      counts: { sessions: sessions.length, processor_entry: entries.length, ...countStages(slice) },
      evidence: { sessionIDs: sessions.map((session) => session.id) },
      failures,
    })
  } finally {
    // nothing long-lived to release; parallel prompts run to completion
  }
}

// ---------------------------------------------------------------------------
// Scenario 9 — permission-heavy task: 2 real ask/reply rounds + real bash
// ---------------------------------------------------------------------------

async function scenario9(ctx: ScenarioCtx): Promise<ScenarioResult> {
  const failures: string[] = []
  const sub = subscribe(ctx.backend.base, ctx.dir)
  const t0 = Date.now()
  try {
    const firstCmd = "echo p0-perm-1 > perm1.txt"
    const secondCmd = "echo p0-perm-2 > perm2.txt"
    const has = (needle: string) => (hit: { body: Record<string, unknown> }) =>
      JSON.stringify(hit.body).includes(needle)
    // The title-generation request hits the same LLM endpoint; it must never
    // consume a queued tool/text reply, so every match excludes it.
    const notTitle = (hit: { body: Record<string, unknown> }) => !JSON.stringify(hit.body).includes("Generate a title")
    // Each request body carries only the conversation history — never the
    // queued reply's content. The first call (bare prompt) carries no marker,
    // so entry 1 matches by the ABSENCE of the first command. The second call
    // carries the first command's history but not yet the second, so entry 2
    // matches on that exact state; the third call carries both, so entry 3
    // matches on the second command (entry 2 has already been consumed).
    await run(
      ctx.backend.llm.toolMatch((hit) => notTitle(hit) && !has("p0-perm-1")(hit), "bash", {
        command: firstCmd,
        description: "first",
      }),
    )
    await run(
      ctx.backend.llm.toolMatch(
        (hit) => notTitle(hit) && has("p0-perm-1")(hit) && !has("p0-perm-2")(hit),
        "bash",
        {
          command: secondCmd,
          description: "second",
        },
      ),
    )
    await run(ctx.backend.llm.textMatch((hit) => notTitle(hit) && has("p0-perm-2")(hit), "permissions done"))
    // Force the ask: explicit bash ask rule (default is ask anyway, but the
    // explicit rule pins the behavior for every run).
    const session = await createSession(ctx, {
      permission: [{ permission: "bash", pattern: "*", action: "ask" }],
    })
    const of = (type: string) => (event: SseEvent) => event.type === type && event.properties.sessionID === session.id
    await promptAsync(ctx, session.id, "run my commands")

    const tAsked1 = Date.now()
    const ask1 = await sub.waitFor(of("permission.asked"), 15_000).catch(() => undefined)
    const tReply1 = Date.now()
    const reply1 = await replyPermission(ctx, ask1, "once")
    const ask2 = await sub.waitFor(of("permission.asked"), 15_000).catch(() => undefined)
    const tReply2 = Date.now()
    const reply2 = await replyPermission(ctx, ask2, "once")
    const tDone0 = Date.now()
    await waitIdle(ctx, session.id)
    const tDone = Date.now()

    const file1 = await fileExists(ctx.dir, "perm1.txt")
    const file2 = await fileExists(ctx.dir, "perm2.txt")
    const slice = ctx.backend.capture.slice(ctx.recordStart)
    if (!ask1) failures.push("first permission.asked never arrived")
    if (!ask2) failures.push("second permission.asked never arrived")
    if (reply1 !== true || reply2 !== true) failures.push("a permission reply was not accepted")
    if (!file1 || !file2) failures.push(`real bash executions missing: perm1=${file1} perm2=${file2}`)
    return ok({
      metrics: {
        totalMs: Math.round(tDone - t0),
        startToFirstAskMs: Math.round(tAsked1 - t0),
        reply1ToAsk2Ms: Math.round(tReply2 - tReply1),
        secondReplyToIdleMs: Math.round(tDone - tDone0),
      },
      counts: { asks: 2, replies: 2, bashExecutions: (file1 ? 1 : 0) + (file2 ? 1 : 0), ...countStages(slice) },
      evidence: {
        ask1: ask1?.properties.id,
        ask2: ask2?.properties.id,
        reply1,
        reply2,
        perm1Exists: file1,
        perm2Exists: file2,
      },
      failures,
    })
  } finally {
    sub.close()
  }
}

async function replyPermission(ctx: ScenarioCtx, ask: SseEvent | undefined, reply: string): Promise<boolean> {
  if (!ask) return false
  // The production `permission.asked` event serializes the PermissionV1.Request
  // fields into `properties` — the request ID is `properties.id` (per_...),
  // which the /permission/:requestID/reply route consumes as :requestID.
  const requestID = ask.properties.id
  if (typeof requestID !== "string") return false
  const res = await api(ctx.backend.base, ctx.dir, `/permission/${requestID}/reply`, {
    method: "POST",
    json: { reply },
  })
  return res.status >= 200 && res.status < 300
}

async function fileExists(dir: string, name: string): Promise<boolean> {
  const fs = await import("node:fs")
  return fs.existsSync(`${dir}/${name}`)
}

// ---------------------------------------------------------------------------
// Scenario 11 — hot config update during an active held generation
// ---------------------------------------------------------------------------

async function scenario11(ctx: ScenarioCtx): Promise<ScenarioResult> {
  const failures: string[] = []
  const marker = `hot-hold-${ctx.sampleNo}`
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const t0 = Date.now()
  try {
    await run(ctx.backend.llm.hold("held-hot", gate))
    const session = await createSession(ctx)
    await promptAsync(ctx, session.id, marker)
    await waitBusy(ctx, session.id)
    await waitLlmBody(ctx, marker)

    const t1 = Date.now()
    const res = await api(ctx.backend.base, ctx.dir, "/config", {
      method: "PATCH",
      json: { model: "test/hot-model" },
    })
    const t2 = Date.now()
    const stillHeld = await statusOf(ctx, session.id)

    const sliceHeld = ctx.backend.capture.slice(ctx.recordStart)
    const coldBefore = P0.stageRecords(sliceHeld, "config_commit").length + P0.stageRecords(sliceHeld, "convergence_complete").length

    release()
    await waitIdle(ctx, session.id)
    const t3 = Date.now()

    const slice = ctx.backend.capture.slice(ctx.recordStart)
    const coldTotal = P0.stageRecords(slice, "config_commit").length + P0.stageRecords(slice, "convergence_complete").length
    const cfg = await json<{ model?: string }>(api(ctx.backend.base, ctx.dir, "/config"))
    if (res.status !== 200) failures.push(`hot PATCH returned ${res.status}`)
    if (stillHeld !== "busy") failures.push(`session left busy during hold (status=${stillHeld})`)
    if (coldBefore !== 0) failures.push(`hot PATCH produced ${coldBefore} cold marks while held`)
    if (coldTotal !== 0) failures.push(`hot PATCH produced ${coldTotal} cold marks overall`)
    if (cfg.model !== "test/hot-model") failures.push(`effective config model=${cfg.model}, expected test/hot-model`)
    return ok({
      metrics: {
        totalMs: Math.round(t3 - t0),
        hotPatchMs: Math.round(t2 - t1),
        heldToReleaseMs: Math.round(t2 - t0),
        releaseToIdleMs: Math.round(t3 - t2),
      },
      counts: { config_commit: 0, convergence_complete: 0, ...countStages(slice) },
      evidence: { patchStatus: res.status, stillHeld, effectiveModel: cfg.model, marker },
      failures,
    })
  } finally {
    release()
  }
}

// ---------------------------------------------------------------------------
// Scenario 12 — cold provider PATCH during an active held generation (LOCK-011)
// ---------------------------------------------------------------------------

async function scenario12(ctx: ScenarioCtx): Promise<ScenarioResult> {
  const failures: string[] = []
  const marker = `cold-hold-${ctx.sampleNo}`
  const newModel = "test-model-2"
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const t0 = Date.now()
  try {
    await run(ctx.backend.llm.hold("held-cold", gate))
    const session = await createSession(ctx)
    await promptAsync(ctx, session.id, marker)
    await waitBusy(ctx, session.id)
    await waitLlmBody(ctx, marker)
    // The admitted generation pinned the STARTUP runtime: its LLM body carries
    // the old model (LOCK-011 snapshot pin).
    const heldBody = await heldModel(ctx, marker)

    const t1 = Date.now()
    const res = await api(ctx.backend.base, ctx.dir, "/config/overlay", {
      method: "PATCH",
      json: {
        scope: "project",
        set: { provider: { test: providerBlock(ctx.backend.llm.url, { [newModel]: modelDef(newModel) }) } },
      },
    })
    const t2 = Date.now()
    // NOTE: no new HTTP requests until release — the convergence fence blocks
    // new readers (LOCK-002/003), so a request while the generation is held
    // would park behind it. Evidence of the held state is read from the P0
    // capture instead: config_commit must be present (commit happened before
    // the response returned) and convergence_complete must NOT be (the pass
    // awaits the drain behind the held generation's reader lease).
    const sliceAfterPatch = ctx.backend.capture.slice(ctx.recordStart)
    const commitSeqs = P0.seqs(sliceAfterPatch, "config_commit")
    const commitSeq = commitSeqs.at(-1) ?? 0
    const completedEarly = P0.stageRecords(sliceAfterPatch, "convergence_complete").length > 0

    release()
    await waitIdle(ctx, session.id)

    // Convergence completes after the held generation released (bounded poll).
    const converged = await waitConvergence(ctx, commitSeq)
    const t4 = Date.now()

    // A post-convergence generation on the NEW model proves the rebuilt
    // runtime serves the latest persisted config.
    await run(ctx.backend.llm.text("new model answer"))
    const followUp = await promptAsync(ctx, session.id, "use the new model", newModel)
    await waitDone(ctx, session.id)
    const t5 = Date.now()
    const newModelSeen = await sawModel(ctx, newModel)
    const slice = ctx.backend.capture.slice(ctx.recordStart)
    // COMPLETED instance_bootstrap spans (start+end = 1): boot + convergence
    // reboot. A lone p0.start (interruption) is not counted.
    const bootSpans = P0.stageSpans(slice, "instance_bootstrap").spans
    if (res.status !== 200) failures.push(`cold PATCH returned ${res.status}`)
    if (heldBody !== "test-model") failures.push(`held generation used model ${heldBody}, expected test-model (snapshot pin)`)
    if (commitSeq < 1) failures.push("no config_commit mark with a seq")
    if (completedEarly) failures.push("convergence_complete arrived while the generation was still held")
    if (!converged) failures.push(`no convergence_complete with seq >= ${commitSeq}`)
    if (!okStatus(followUp)) failures.push(`post-convergence prompt returned ${followUp.status}`)
    if (!newModelSeen) failures.push(`post-convergence generation did not use model ${newModel}`)
    if (bootSpans < 2) failures.push(`expected 2 instance_bootstrap spans (boot + reboot), got ${bootSpans}`)
    return ok({
      metrics: {
        totalMs: Math.round(t5 - t0),
        patchMs: Math.round(t2 - t1),
        commitToConvergedMs: Math.round(t4 - t2),
        convergedToFollowUpMs: Math.round(t5 - t4),
        heldToReleaseMs: Math.round(t2 - t0),
      },
      counts: countStages(slice),
      evidence: {
        patchStatus: res.status,
        heldModel: heldBody,
        commitSeq,
        convergedSeq: converged?.meta?.seq,
        // Derived by construction, not a raw status observation: the scenario
        // only reaches the PATCH after waitBusy + waitLlmBody, and the fence
        // blocks new readers until release (LOCK-002/003).
        heldDuringPatch: true,
        newModelSeen,
        bootstrapSpans: bootSpans,
      },
      failures,
    })
  } finally {
    release()
  }
}

async function heldModel(ctx: ScenarioCtx, marker: string): Promise<string> {
  const bodies = await run(ctx.backend.llm.inputs)
  const hit = bodies.find((body) => JSON.stringify(body).includes(marker))
  if (!hit || typeof hit.model !== "string") return "unknown"
  return hit.model
}

async function sawModel(ctx: ScenarioCtx, model: string): Promise<boolean> {
  const bodies = await run(ctx.backend.llm.inputs)
  return bodies.some((body) => body.model === model)
}

// ---------------------------------------------------------------------------
// Scenario 13 — burst cold updates with coalescing evidence
// ---------------------------------------------------------------------------

const BURST = 5

async function scenario13(ctx: ScenarioCtx): Promise<ScenarioResult> {
  const failures: string[] = []
  const marker = `burst-hold-${ctx.sampleNo}`
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const t0 = Date.now()
  try {
    await run(ctx.backend.llm.hold("held-burst", gate))
    const session = await createSession(ctx)
    await promptAsync(ctx, session.id, marker)
    await waitBusy(ctx, session.id)
    await waitLlmBody(ctx, marker)

    // BURST concurrent cold PATCHes, each adding one model. All must commit
    // while the generation is held (fence up, drain parked behind the reader).
    const t1 = Date.now()
    const statuses = await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        api(ctx.backend.base, ctx.dir, "/config/overlay", {
          method: "PATCH",
          json: {
            scope: "project",
            set: { provider: { test: providerBlock(ctx.backend.llm.url, { [`test-burst-${i}`]: modelDef(`test-burst-${i}`) }) } },
          },
        }).then((res) => res.status),
      ),
    )
    const t2 = Date.now()
    // No HTTP requests until release (the convergence fence blocks new readers,
    // LOCK-002/003); coalescing evidence is read from the P0 capture.

    release()
    await waitIdle(ctx, session.id)

    const sliceAfter = ctx.backend.capture.slice(ctx.recordStart)
    const commitSeqs = P0.seqs(sliceAfter, "config_commit")
    const maxSeq = Math.max(0, ...commitSeqs)
    const converged = await waitConvergence(ctx, maxSeq)
    const t4 = Date.now()

    // Post-convergence: EVERY burst model must be effective after convergence —
    // one real generation per model, not just the final one. A missing model
    // fails the prompt or the LLM body never carries it.
    const modelsEffective: boolean[] = []
    for (let i = 0; i < BURST; i++) {
      await run(ctx.backend.llm.text(`burst answer ${i}`))
      const res = await promptAsync(ctx, session.id, `burst done ${i}`, `test-burst-${i}`)
      await waitDone(ctx, session.id)
      modelsEffective.push(okStatus(res) && (await sawModel(ctx, `test-burst-${i}`)))
    }
    const t5 = Date.now()

    const slice = ctx.backend.capture.slice(ctx.recordStart)
    const completes = P0.stageRecords(slice, "convergence_complete")
    const completions = completes.length
    if (statuses.some((status) => status !== 200)) failures.push(`a burst PATCH failed: ${JSON.stringify(statuses)}`)
    if (commitSeqs.length !== BURST) failures.push(`expected ${BURST} config_commit marks, got ${commitSeqs.length}`)
    if (!converged) failures.push(`no convergence_complete with seq >= ${maxSeq}`)
    if (completions >= BURST) failures.push(`no coalescing: ${completions} completions for ${BURST} commits`)
    if (modelsEffective.some((seen) => !seen)) {
      failures.push(`not all ${BURST} burst models effective after convergence: ${JSON.stringify(modelsEffective)}`)
    }
    return ok({
      metrics: {
        totalMs: Math.round(t5 - t0),
        burstMs: Math.round(t2 - t1),
        burstToConvergedMs: Math.round(t4 - t2),
        convergedToAllModelsMs: Math.round(t5 - t4),
      },
      counts: countStages(slice),
      evidence: {
        statuses,
        commitSeqs,
        maxSeq,
        completions,
        finalSeq: completes.at(-1)?.meta?.seq,
        // Derived by construction, not a raw status observation: the burst only
        // fires after waitBusy + waitLlmBody, and the fence parks the burst
        // behind the held generation's reader lease (LOCK-002/003).
        heldDuringBurst: true,
        modelsEffective,
      },
      failures,
    })
  } finally {
    release()
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const SCENARIOS: Scenario[] = [
  { id: "6", name: "first-prompt", run: scenario6 },
  { id: "7", name: "large-stream", run: scenario7 },
  { id: "8", name: "parallel-sessions", run: scenario8 },
  { id: "9", name: "permission-heavy", run: scenario9 },
  { id: "11", name: "hot-config", run: scenario11 },
  { id: "12", name: "cold-during-generation", run: scenario12 },
  { id: "13", name: "burst-cold", run: scenario13 },
]

export const byID = (id: string): Scenario => {
  const found = SCENARIOS.find((scenario) => scenario.id === id)
  if (!found) throw new Error(`unknown scenario id ${id}`)
  return found
}
