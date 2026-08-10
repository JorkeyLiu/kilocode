/**
 * Production-path integration tests for the backend P0 harness.
 *
 * Exercises the real `Server.listen`/AppLayer listener + loopback
 * TestLLMServer over actual HTTP/SSE — the same path `kilo serve` uses — and
 * asserts the P0 instrumentation records land in the captured `service=p0-perf`
 * stream. Covers: per-directory cold boot stages, a prompt round trip, and the
 * flagship cold-provider-PATCH-during-held-generation semantics (LOCK-011:
 * the active generation pins its snapshot, the save acknowledges first,
 * convergence completes after release, and a post-convergence generation sees
 * the new model).
 *
 * Env isolation: `./environment` is the first import so KILO_P0_PERF and the
 * run-owned paths are set before any kilo module (instrument.ts included)
 * evaluates. `Log.init({ print: true })` redirects the p0 stream to stderr,
 * where the harness tee captures it. The registered `registerBenchmarkEnv`
 * dispose restores process.env and removes the run root after the last
 * benchmark file finishes (bun test runs all files in one process).
 */

import "./environment"
import { afterAll, describe, expect, it } from "bun:test"
import * as Log from "@opencode-ai/core/util/log"
import { tmpdir } from "../fixture/fixture"
import { markProjectConfigReady } from "../fixture/plugin"
import { testProviderConfig } from "../lib/test-provider"
import type { BackendHandle, SseSubscription } from "./backend"
import { api, bootBackend, disposeInstance, json, run, subscribe } from "./backend"
import { registerBenchmarkEnv } from "./environment"
import * as P0 from "./p0-records"

await Log.init({ print: true })

const modelDef = (id: string) => ({
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

const providerBlock = (llmUrl: string, extraModels: Record<string, unknown> = {}) => ({
  name: "Test",
  id: "test",
  env: [],
  npm: "@ai-sdk/openai-compatible",
  models: { "test-model": modelDef("test-model"), ...extraModels },
  options: { apiKey: "test-key", baseURL: llmUrl },
})

let backend: BackendHandle | undefined

/** Held-gate releases the afterAll must fire before shutdown (LOCK-007-style owner). */
const pendingGates: Array<() => void> = []

const makeDir = async () => {
  if (!backend) throw new Error("backend not booted")
  const tmp = await tmpdir({ git: true, config: testProviderConfig(backend.llm.url) })
  await markProjectConfigReady(tmp.path)
  return tmp
}

const createSession = (dir: string) =>
  json<{ id: string }>(
    api(backend!.base, dir, "/session", {
      method: "POST",
      json: { title: "p0-integration" },
    }),
  )

const promptAsync = (dir: string, sessionID: string, text: string, model = "test-model") =>
  api(backend!.base, dir, `/session/${sessionID}/prompt_async`, {
    method: "POST",
    json: {
      agent: "build",
      model: { providerID: "test", modelID: model },
      parts: [{ type: "text", text }],
    },
  })

const statusType = async (dir: string, sessionID: string): Promise<string | undefined> => {
  const map = await json<Record<string, { type: string }>>(api(backend!.base, dir, "/session/status"))
  return map[sessionID]?.type
}

const waitIdle = async (dir: string, sessionID: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const type = await statusType(dir, sessionID)
    if (type === undefined || type === "idle") return
    await Bun.sleep(25)
  }
  throw new Error(`session ${sessionID} never idle`)
}

const waitBusy = async (dir: string, sessionID: string, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await statusType(dir, sessionID)) === "busy") return
    await Bun.sleep(25)
  }
  throw new Error(`session ${sessionID} never busy`)
}

const waitLlmHit = async (marker: string, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const bodies = await run(backend!.llm.inputs)
    if (bodies.some((body) => JSON.stringify(body).includes(marker))) return
    await Bun.sleep(25)
  }
  throw new Error(`LLM hit with "${marker}" never arrived`)
}

const waitConvergence = async (recordStart: number, minSeq: number, timeoutMs = 20_000): Promise<P0.P0Record | undefined> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = P0.stageRecords(backend!.capture.slice(recordStart), "convergence_complete").find(
      (rec) => P0.seqOf(rec) >= minSeq,
    )
    if (hit) return hit
    await Bun.sleep(50)
  }
  return undefined
}

afterAll(async () => {
  // Release any still-held generation so the convergence pass can settle, then
  // stop the listener/LLM. The env restore + run-root removal happens in the
  // registerBenchmarkEnv dispose registered below (it must run AFTER the
  // backend stops — afterAll hooks run in registration order).
  for (const release of pendingGates.splice(0)) release()
  if (backend) {
    await backend.stop().catch(() => undefined)
    backend = undefined
  }
})

// Last hook: once every benchmark file has finished, restore the pre-load env
// and remove the run root so later files in this `bun test` process never
// inherit removed runRoot paths.
afterAll(registerBenchmarkEnv())

describe("backend p0 harness (production Server.listen/AppLayer)", () => {
  it(
    "boots the listener, records per-directory boot stages, and completes a prompt",
    async () => {
      backend = await bootBackend()
      // The listener span is process-level (one per Server.listen); assert it
      // against the full capture, not the per-sample slice.
      expect(backend.capture.slice(0).map((rec) => rec.stage)).toContain("listener")
      const recordStart = backend.capture.mark()
      const tmp = await makeDir()
      let sub: SseSubscription | undefined
      try {
        // The /event subscription is the first instance-touching request: it
        // boots the directory instance through the production middleware, firing
        // config_load / instance_bootstrap / provider_state_init spans.
        sub = subscribe(backend.base, tmp.path)
        const session = await createSession(tmp.path)
        await run(backend.llm.text("production hello"))
        const res = await promptAsync(tmp.path, session.id, "probe")
        expect(res.status).toBeGreaterThanOrEqual(200)
        expect(res.status).toBeLessThan(300)
        await sub.waitFor((event) => event.type === "session.idle" && event.properties.sessionID === session.id, 15_000)
        sub.close()
        sub = undefined

        const slice = backend.capture.slice(recordStart)
        const stages = slice.map((rec) => rec.stage)
        expect(stages).toContain("config_load")
        expect(stages).toContain("instance_bootstrap")
        expect(stages).toContain("provider_state_init")
        expect(stages).toContain("processor_entry")
        for (const stage of ["config_load", "instance_bootstrap", "provider_state_init"]) {
          expect(P0.stageDurations(slice, stage).length).toBeGreaterThan(0)
        }
        expect(P0.countStage(slice, "processor_entry")).toBeGreaterThanOrEqual(1)
      } finally {
        sub?.close()
        await disposeInstance(backend.base, tmp.path)
        await tmp[Symbol.asyncDispose]().catch(() => undefined)
      }
    },
    30_000,
  )

  it(
    "cold provider PATCH during a held generation keeps the generation pinned and converges (LOCK-011)",
    async () => {
      if (!backend) backend = await bootBackend()
      const recordStart = backend.capture.mark()
      const tmp = await makeDir()
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      pendingGates.push(release)
      try {
        await run(backend.llm.hold("held-pinned", gate))
        const session = await createSession(tmp.path)
        const res = await promptAsync(tmp.path, session.id, "pin-me")
        expect(res.status).toBeGreaterThanOrEqual(200)
        expect(res.status).toBeLessThan(300)
        await waitBusy(tmp.path, session.id)
        await waitLlmHit("pin-me")

        // LOCK-011: the admitted generation pinned the STARTUP runtime.
        const heldBody = (await run(backend.llm.inputs)).find((body) => JSON.stringify(body).includes("pin-me"))
        expect((heldBody as { model?: unknown } | undefined)?.model).toBe("test-model")

        // Cold provider PATCH while the stream is held: acknowledges first.
        // No further HTTP requests until release — the convergence fence
        // blocks new readers (LOCK-002/003), so a request while the generation
        // is held would park behind it.
        const patch = await api(backend.base, tmp.path, "/config/overlay", {
          method: "PATCH",
          json: {
            scope: "project",
            set: { provider: { test: providerBlock(backend.llm.url, { "test-model-2": modelDef("test-model-2") }) } },
          },
        })
        expect(patch.status).toBe(200)
        const commitSeqs = P0.seqs(backend.capture.slice(recordStart), "config_commit")
        expect(commitSeqs.length).toBeGreaterThan(0)
        // The generation is still held: convergence is parked on its reader
        // lease, so no convergence_complete yet (P0 capture — no HTTP).
        expect(P0.stageRecords(backend.capture.slice(recordStart), "convergence_complete")).toHaveLength(0)

        // Release: the generation completes unpinned (no interruption), then the
        // convergence pass disposes + reboots and emits convergence_complete.
        release()
        await waitIdle(tmp.path, session.id)
        const converged = await waitConvergence(recordStart, commitSeqs.at(-1) ?? 1)
        expect(converged).toBeDefined()
        expect(converged?.meta?.seq).toBeGreaterThanOrEqual(commitSeqs.at(-1) ?? 1)

        // Post-convergence generation on the NEW model proves the rebuilt runtime
        // serves the latest persisted config. Wait for the hit that carries the
        // follow-up marker (bounded) before reading bodies.
        await run(backend.llm.text("new answer"))
        const follow = await promptAsync(tmp.path, session.id, "use the new model", "test-model-2")
        expect(follow.status).toBeGreaterThanOrEqual(200)
        expect(follow.status).toBeLessThan(300)
        await waitLlmHit("use the new model")
        await waitIdle(tmp.path, session.id)
        const bodies = await run(backend.llm.inputs)
        expect(bodies.some((body) => body.model === "test-model-2")).toBe(true)

        // The reboot re-ran the instance bootstrap (2 completed spans in the
        // sample: initial boot + convergence reboot).
        expect(P0.stageSpans(backend.capture.slice(recordStart), "instance_bootstrap").spans).toBeGreaterThanOrEqual(2)
      } finally {
        release()
        await disposeInstance(backend.base, tmp.path)
        await tmp[Symbol.asyncDispose]().catch(() => undefined)
      }
    },
    30_000,
  )
})
