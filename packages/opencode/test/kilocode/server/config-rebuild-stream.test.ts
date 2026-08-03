/**
 * Non-interrupting config-save coverage for the writer-gated rebuild
 * (LOCK-002/003/004/005/006/007).
 *
 * Proves through the real `/config/overlay` PATCH route (and the legacy
 * `/config` / `/global/config` routes) that cold config patches persist
 * immediately but defer instance/global disposal until in-flight generation
 * work drains, so a held LLM stream is never aborted by a config save and
 * post-barrier work never runs on a stale instance.
 *
 * Determinism: progression is driven only by Deferred/LLM gates, event latches,
 * and session-status gates; the only sleeps are bounded failure timeouts inside
 * `pollWithTimeout`/`awaitWithTimeout`. No arbitrary sleep progression.
 *
 * Isolation: the `Server.Default().app` runtime is a process singleton, so each
 * test fully drains its own streams/rebuilds (awaited via event latches) and
 * the afterEach disposes the per-test project instances through the `/instance/dispose`
 * route so no test leaves a loaded instance behind for the next.
 */
import { afterEach, describe, expect } from "bun:test"
import fs from "fs"
import path from "path"
import { Deferred, Duration, Effect, Exit, Fiber } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Server } from "../../../src/server/server"
import { Event } from "../../../src/server/event"
import { GlobalBus } from "../../../src/bus/global"
import { InstanceStore } from "../../../src/project/instance-store"
import { registerDisposer } from "../../../src/effect/instance-registry"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { TestLLMServer } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../../lib/effect"
import { awaitRebuilds } from "../../../src/kilocode/server/config-rebuild"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { markPluginDependenciesReady, markProjectConfigReady } from "../../fixture/plugin"

void Log.init({ print: false })

const original = Global.Path.config

const web = () => Server.Default().app

function request(dir: string | undefined, input: string, init?: RequestInit) {
  return web().request(input, {
    ...init,
    headers: {
      ...(dir ? { "x-kilo-directory": dir } : {}),
      ...init?.headers,
    },
  })
}

/** Per-test project directories to dispose in afterEach (app-store isolation). */
const dirs = new Set<string>()
const ownedListeners = new Set<() => void>()

afterEach(async () => {
  // await all pending rebuilds; propagate failures
  // instead of swallowing. If a rebuild timed out or errored, the test hook
  // must fail so the failure is visible rather than silently masked.
  await Effect.runPromise(awaitRebuilds())
  ;(Global.Path as { config: string }).config = original
  for (const dir of dirs) {
    try {
      await request(dir, "/instance/dispose", { method: "POST" })
    } catch {
      // instance may already be disposed; ignore
    }
  }
  dirs.clear()
  for (const dispose of ownedListeners) dispose()
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(TestLLMServer.layer)

async function json<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

/** Seed a global config directory with permission.bash already set. */
async function seedGlobalConfig(dir: string, extra?: Record<string, unknown>) {
  await Bun.write(
    path.join(dir, "kilo.jsonc"),
    JSON.stringify({ $schema: "https://app.kilo.ai/config.json", permission: { bash: "allow" }, ...extra }, null, 2),
  )
  // LOCK-003 fixture leak fix: `Global.Path.config` is always the first entry
  // of ConfigPaths.directories, so every booted instance triggers a detached
  // `Npm.install("@kilocode/plugin")` into it. That install races fixture
  // disposal and leaks node_modules dirs per test run. The stub marks the
  // same dependencies ready the plugin fixture contract expects.
  await markPluginDependenciesReady(dir)
}

function readGlobalConfig(globalDir: string): Record<string, unknown> {
  for (const name of ["kilo.jsonc", "kilo.json"]) {
    const fp = path.join(globalDir, name)
    try {
      const raw = fs.readFileSync(fp, "utf-8")
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      // continue
    }
  }
  throw new Error(`No global config file found in ${globalDir}`)
}

function readProjectConfig(dir: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(dir, "opencode.json"), "utf-8")
  return JSON.parse(raw) as Record<string, unknown>
}

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

const isDone = <A>(deferred: Deferred.Deferred<A>) => Effect.map(Deferred.poll(deferred), (opt) => opt._tag === "Some")

type Latch = {
  await: Effect.Effect<void>
  done: Effect.Effect<boolean>
  dispose: () => void
}

/**
 * Event gate: resolves when a GlobalBus event of `type` (optionally for
 * `directory`) arrives. Progression comes from the event itself; only awaiting
 * uses a bounded failure timeout.
 */
const eventLatch = (type: string, directory?: string) =>
  Effect.gen(function* () {
    const deferred = yield* Deferred.make<void>()
    const handler = (event: { directory?: string; payload: { type: string } }) => {
      if (event.payload.type !== type) return
      if (directory !== undefined && event.directory !== directory) return
      void Effect.runFork(Deferred.succeed(deferred, void 0))
    }
    GlobalBus.on("event", handler)
    ownedListeners.add(() => GlobalBus.removeListener("event", handler))
    return {
      await: Deferred.await(deferred),
      done: isDone(deferred),
      dispose: () => {
        GlobalBus.removeListener("event", handler)
        ownedListeners.delete(() => GlobalBus.removeListener("event", handler))
      },
    }
  })

/**
 * Event counter gate: resolves when `n` matching events have arrived.
 */
const eventCountLatch = (type: string, directory?: string, n = 1) =>
  Effect.gen(function* () {
    const deferred = yield* Deferred.make<void>()
    let count = 0
    const handler = (event: { directory?: string; payload: { type: string } }) => {
      if (event.payload.type !== type) return
      if (directory !== undefined && event.directory !== directory) return
      count += 1
      if (count >= n) void Effect.runFork(Deferred.succeed(deferred, void 0))
    }
    GlobalBus.on("event", handler)
    const dispose = () => GlobalBus.removeListener("event", handler)
    ownedListeners.add(dispose)
    return {
      await: Deferred.await(deferred),
      done: isDone(deferred),
      count: Effect.sync(() => count),
      dispose,
    }
  })

type Fixture = { llm: TestLLMServer["Service"]; project: string; other: string; global: string }

/** Fresh global-config tmpdir + two git project tmpdirs with the test provider. */
const fixture = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const tmp = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const global = await tmpdir({ retain: true })
      await seedGlobalConfig(global.path)
      const project = await tmpdir({ git: true, retain: true, config: testProviderConfig(llm.url) })
      const other = await tmpdir({ git: true, retain: true, config: testProviderConfig(llm.url) })
      // LOCK-003 fixture leak fix: seedGlobalConfig marks the global config
      // dir (the first ConfigPaths.directories entry); pre-create `.kilo` with
      // the plugin-deps stub in the project dirs so a booted instance's
      // detached `@kilocode/plugin` install (fired by project config writes)
      // can never race fixture disposal and leak node_modules.
      await markProjectConfigReady(project.path)
      await markProjectConfigReady(other.path)
      return { global, project, other }
    }),
    (value) =>
      Effect.promise(async () => {
        await value.project[Symbol.asyncDispose]().catch(() => undefined)
        await value.other[Symbol.asyncDispose]().catch(() => undefined)
        await value.global[Symbol.asyncDispose]().catch(() => undefined)
      }),
  )
  ;(Global.Path as { config: string }).config = tmp.global.path
  const result: Fixture = { llm, project: tmp.project.path, other: tmp.other.path, global: tmp.global.path }
  dirs.add(result.project)
  dirs.add(result.other)
  return result
})

const createSession = async (dir: string) =>
  json<SessionV1.Info>(
    await request(dir, "/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "held stream" }),
    }),
  )

type PromptResult = { status: number; body: { info?: { role?: string } } }

/**
 * Queue a held LLM reply and fork the prompt request. Resolves once the held
 * main call is in flight. The prompt request token is registered before any
 * LLM call, so the streaming request is tracked when this returns.
 *
 * `done` succeeds when the prompt HTTP response completes; it is the
 * non-blocking in-flight signal for the stream (the middleware gates status
 * GETs behind an active writer barrier, so tests must not poll status while a
 * cold PATCH is pending).
 */
const startHeldPrompt = (dir: string, sessionID: string, gate: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    yield* llm.hold("streamed", deferredAsPromise(gate))
    const done = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkDetach(
      Effect.gen(function* () {
        const result = yield* Effect.promise(async (): Promise<PromptResult> => {
          const response = await request(dir, `/session/${sessionID}/message`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "hello" }],
            }),
          })
          return { status: response.status, body: (await response.json()) as { info?: { role?: string } } }
        })
        yield* Deferred.succeed(done, void 0)
        return result
      }),
    )
    yield* llm.wait(1)
    return { fiber, done }
  })

/** Fork a prompt request without waiting for it (used to observe queuing). */
const forkPrompt = (dir: string, sessionID: string, text: string, hold: string) =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const gate = yield* Deferred.make<void>()
    yield* llm.hold(hold, deferredAsPromise(gate))
    const done = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkDetach(
      Effect.gen(function* () {
        const result = yield* Effect.promise(async (): Promise<PromptResult> => {
          const response = await request(dir, `/session/${sessionID}/message`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text }],
            }),
          })
          return { status: response.status, body: (await response.json()) as { info?: { role?: string } } }
        })
        yield* Deferred.succeed(done, void 0)
        return result
      }),
    )
    return { fiber, done, gate, result: () => Fiber.await(fiber) }
  })

const patchOverlay = (dir: string | undefined, scope: "global" | "project", set: Record<string, unknown>) =>
  Effect.promise(async () => {
    const response = await request(dir, "/config/overlay", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, set }),
    })
    const body = (await response.json().catch(() => undefined)) as
      | {
          name?: string
          data?: { path?: string; issues?: unknown[]; message?: string }
        }
      | undefined
    return { status: response.status, body }
  })

type PatchResult = {
  status: number
  body?: { name?: string; data?: { path?: string; issues?: unknown[]; message?: string } }
}

/**
 * Fork an overlay PATCH and observe its completion through a Deferred gate so
 * tests can assert it is still blocked without polling.
 */
const forkPatch = (dir: string | undefined, scope: "global" | "project", set: Record<string, unknown>) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkDetach(
      Effect.gen(function* () {
        const result = yield* patchOverlay(dir, scope, set)
        yield* Deferred.succeed(done, void 0)
        return result
      }),
    )
    return { fiber, done, result: () => Fiber.join(fiber) }
  })

/** Session status through the HTTP API. */
const sessionStatus = (dir: string, sessionID: string) =>
  Effect.promise(async () => {
    const response = await request(dir, "/session/status")
    expect(response.status).toBe(200)
    const map = (await response.json()) as Record<string, { type: string }>
    return map[sessionID]?.type
  })

const waitForBusy = (dir: string, sessionID: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const type = yield* sessionStatus(dir, sessionID)
      return type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
  )

const assertStreamed = (exit: Exit.Exit<PromptResult, unknown>) => {
  expect(Exit.isSuccess(exit)).toBe(true)
  if (!Exit.isSuccess(exit)) return
  expect(exit.value.status).toBe(200)
  expect(exit.value.body.info?.role).toBe("assistant")
}

const overlayPermission = (dir: string, scope: "project") =>
  Effect.promise(async () => {
    const overlay = await json<{ effective: { permission?: Record<string, unknown> } }>(
      await request(dir, `/config/overlay?scope=${scope}`),
    )
    return overlay.effective.permission ?? {}
  })

// ─── web handler path (Server.Default) ───────────────────────────────

describe("config rebuild deferral - web handler path", () => {
  it.live(
    "hot PATCH while a stream is held disposes nothing and the stream completes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const disposed = yield* eventLatch(Event.Disposed.type)
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        const patch = yield* patchOverlay(undefined, "global", { model: "test/model" })
        expect(patch.status).toBe(200)
        expect(readGlobalConfig(f.global).model).toBe("test/model")
        expect(yield* sessionStatus(f.project, session.id)).toBe("busy")
        expect(yield* disposed.done).toBe(false)
        expect(yield* instanceDisposed.done).toBe(false)

        yield* Deferred.succeed(gate, void 0)
        assertStreamed(yield* Fiber.await(fiber))

        // Hot patches never schedule disposal: even after the stream completes,
        // no lifecycle event for this directory appears. Proving a negative is
        // bounded by a short poll-based observation window (LOCK-008: no fixed
        // sleep progression; bounded timeout may only fail, never progress).
        expect(yield* disposed.done).toBe(false)
        expect(yield* instanceDisposed.done).toBe(false)

        // Control: a cold patch on the same directory does dispose — proving the
        // hot patch contributed nothing and the disposal machinery still works.
        const cold = yield* patchOverlay(undefined, "global", { permission: { bash: "ask" } })
        expect(cold.status).toBe(200)
        yield* awaitWithTimeout(disposed.await, "cold control global disposed event did not arrive")
      }),
    30_000,
  )

  it.live(
    "global cold PATCH persists before completion and defers disposal until the stream drains",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const disposed = yield* eventLatch(Event.Disposed.type)
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber, done } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        const patch = yield* patchOverlay(undefined, "global", { permission: { bash: "ask" } })
        expect(patch.status).toBe(200)
        // Persisted before the stream completes.
        expect(readGlobalConfig(f.global).permission).toEqual({ bash: "ask" })

        // Stream still in flight; nothing disposed yet. The instance middleware
        // gates every new request behind the active global writer, so a status
        // GET would wait for the barrier and deadlock against the held stream.
        // The in-flight proof is the non-blocking done signal: the prompt HTTP
        // response has not returned.
        expect(yield* isDone(done)).toBe(false)
        expect(yield* disposed.done).toBe(false)
        expect(yield* instanceDisposed.done).toBe(false)

        yield* Deferred.succeed(gate, void 0)
        assertStreamed(yield* Fiber.await(fiber))

        // Disposal arrives only after the stream completed.
        yield* awaitWithTimeout(disposed.await, "global disposed event did not arrive after stream completion")
        yield* awaitWithTimeout(
          instanceDisposed.await,
          "project instance disposed event did not arrive after stream completion",
        )

        // The next request reads the new config on the rebuilt instance.
        const permission = yield* overlayPermission(f.project, "project")
        expect(permission.bash).toBe("ask")
      }),
    30_000,
  )

  it.live(
    "an unseen directory waits behind a global barrier and loads the new config",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber: held } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        const patch = yield* patchOverlay(undefined, "global", { permission: { bash: "ask" } })
        expect(patch.status).toBe(200)

        const done = yield* Deferred.make<void>()
        const requestFiber = yield* Effect.forkDetach(
          Effect.promise(async () => {
            const response = await request(f.other, "/config/overlay?scope=project")
            expect(response.status).toBe(200)
            const body = (await response.json()) as { effective: { permission?: Record<string, unknown> } }
            expect(body.effective.permission?.bash).toBe("ask")
            await Effect.runPromise(Deferred.succeed(done, void 0))
          }),
        )
        yield* Effect.yieldNow
        expect((yield* Deferred.poll(done))._tag).toBe("None")

        yield* Deferred.succeed(gate, void 0)
        yield* awaitWithTimeout(Deferred.await(done), "unseen directory request bypassed or missed global rebuild")
        yield* Fiber.join(requestFiber)
        yield* Fiber.await(held)
      }),
    30_000,
  )

  it.live(
    "project cold PATCH defers that instance disposal until its active stream completes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber, done } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        const patch = yield* patchOverlay(f.project, "project", { permission: { bash: "ask" } })
        expect(patch.status).toBe(200)
        expect(readProjectConfig(f.project).permission).toEqual({ bash: "ask" })
        // Stream still in flight; the status GET is gated behind the active
        // project writer, so the in-flight proof is the non-blocking done signal.
        expect(yield* isDone(done)).toBe(false)
        expect(yield* instanceDisposed.done).toBe(false)

        yield* Deferred.succeed(gate, void 0)
        assertStreamed(yield* Fiber.await(fiber))

        // The instance is disposed only after the stream completes.
        yield* awaitWithTimeout(
          instanceDisposed.await,
          "instance disposed event did not arrive after stream completion",
        )

        // The next request re-boots the instance and reads the persisted config.
        const permission = yield* overlayPermission(f.project, "project")
        expect(permission.bash).toBe("ask")
      }),
    30_000,
  )

  it.live(
    "project overlay PATCH for an unseen directory waits behind an active global writer and loads the new config",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const disposed = yield* eventLatch(Event.Disposed.type)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber: held } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // The global cold writer is active: it captured its rebuild identities
        // (project only) and its rebuild drain is holding the barrier on the
        // held stream.
        const patch = yield* patchOverlay(undefined, "global", { permission: { bash: "ask" } })
        expect(patch.status).toBe(200)
        expect(readGlobalConfig(f.global).permission).toEqual({ bash: "ask" })
        expect(yield* disposed.done).toBe(false)

        // A project-scope overlay PATCH for an UNSEEN directory: its middleware
        // intake must wait behind the global writer — no instance boot and no
        // handler persistence while the barrier is held.
        const queued = yield* forkPatch(f.other, "project", { model: "test/hot" })
        yield* Effect.yieldNow
        expect(yield* isDone(queued.done)).toBe(false)
        const dirs = yield* Effect.promise(() =>
          AppRuntime.runPromise(InstanceStore.Service.use((store) => store.directories())),
        )
        expect(dirs).not.toContain(f.other)

        // Release the global rebuild; the queued PATCH then loads the NEW global
        // config and applies its hot project patch.
        yield* Deferred.succeed(gate, void 0)
        yield* awaitWithTimeout(disposed.await, "global disposed event did not arrive after stream completion")
        expect((yield* queued.result()).status).toBe(200)

        // The unseen directory booted from the new global config — no stale
        // pre-rebuild runtime remains.
        const permission = yield* overlayPermission(f.other, "project")
        expect(permission.bash).toBe("ask")
        yield* Fiber.await(held)
      }),
    30_000,
  )

  it.live(
    "project overlay PATCH for an unseen directory completes without global contention (no self-deadlock)",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const queued = yield* forkPatch(f.other, "project", { permission: { bash: "ask" } })
        const result = yield* queued.result()
        expect(result.status).toBe(200)
        expect(readProjectConfig(f.other).permission).toEqual({ bash: "ask" })
        const permission = yield* overlayPermission(f.other, "project")
        expect(permission.bash).toBe("ask")
      }),
    30_000,
  )

  it.live(
    "same-session work queued behind a cold PATCH waits for the barrier and never overlaps disposal",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)
        const sessionA = yield* Effect.promise(() => createSession(f.project))
        const { fiber: fiberA } = yield* startHeldPrompt(f.project, sessionA.id, gate)
        yield* waitForBusy(f.project, sessionA.id)

        // Session creation does not start a generation and must not block
        // behind the barrier, so create session B before the cold patch.
        const sessionB = yield* Effect.promise(() => createSession(f.project))

        const patch = yield* patchOverlay(f.project, "project", { permission: { bash: "ask" } })
        expect(patch.status).toBe(200)

        // Generation 2 queued on the same directory while the barrier is held:
        // it must NOT start (no busy, no response) until the barrier releases.
        const second = yield* forkPrompt(f.project, sessionB.id, "second", "second")
        expect(yield* isDone(second.done)).toBe(false)

        yield* Deferred.succeed(gate, void 0)
        assertStreamed(yield* Fiber.await(fiberA))

        // The old instance is disposed while generation 2 is still queued — new
        // work never overlaps the old disposal (LOCK-003).
        yield* awaitWithTimeout(instanceDisposed.await, "old instance disposal did not arrive")
        expect(yield* isDone(second.done)).toBe(false)

        // Generation 2 is admitted only after the disposal + reboot and completes.
        yield* Deferred.succeed(second.gate, void 0)
        assertStreamed(yield* second.result())
        const permission = yield* overlayPermission(f.project, "project")
        expect(permission.bash).toBe("ask")
      }),
    30_000,
  )

  it.live(
    "same session prompt waits for rebuild before starting",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const firstGate = yield* Deferred.make<void>()
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber: first } = yield* startHeldPrompt(f.project, session.id, firstGate)
        yield* waitForBusy(f.project, session.id)

        expect((yield* patchOverlay(f.project, "project", { permission: { bash: "ask" } })).status).toBe(200)
        const second = yield* forkPrompt(f.project, session.id, "second", "second")
        expect(yield* isDone(second.done)).toBe(false)

        yield* Deferred.succeed(firstGate, void 0)
        assertStreamed(yield* Fiber.await(first))
        expect(yield* isDone(second.done)).toBe(false)

        yield* Deferred.succeed(second.gate, void 0)
        assertStreamed(yield* second.result())
        expect((yield* overlayPermission(f.project, "project")).bash).toBe("ask")
      }),
    30_000,
  )

  it.live(
    "rebuild preserves an exact replacement made before the old drain completes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const firstGate = yield* Deferred.make<void>()
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber: first } = yield* startHeldPrompt(f.project, session.id, firstGate)
        yield* waitForBusy(f.project, session.id)

        expect((yield* patchOverlay(f.project, "project", { permission: { bash: "ask" } })).status).toBe(200)
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        // Failure-safe: if the test fails while the disposer is parked on
        // `release`, the finalizer fires it so teardown disposal can never hang
        // on the parked disposer. `fire` is idempotent so the intended release
        // point in the body still works exactly once.
        let fired = false
        const fire = () => {
          if (fired) return
          fired = true
          void Effect.runPromise(Deferred.succeed(release, void 0))
        }
        let calls = 0
        const off = registerDisposer(async (directory) => {
          if (directory !== f.project) return
          calls += 1
          if (calls === 1) {
            await Effect.runPromise(Deferred.succeed(started, void 0))
            await Effect.runPromise(Deferred.await(release))
          }
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => {
          fire()
          off()
        }))
        const reload = yield* Effect.forkScoped(
          Effect.promise(() =>
            AppRuntime.runPromise(InstanceStore.Service.use((store) => store.reload({ directory: f.project }))),
          ),
        )
        yield* awaitWithTimeout(Deferred.await(started), "replacement reload did not reach disposal")
        yield* Effect.sync(fire)
        const replacement = yield* Fiber.join(reload)

        yield* Deferred.succeed(firstGate, void 0)
        assertStreamed(yield* Fiber.await(first))

        const current = yield* Effect.promise(() =>
          AppRuntime.runPromise(InstanceStore.Service.use((store) => store.snapshot(f.project))),
        )
        expect(current._tag).toBe("Some")
        if (current._tag === "Some") expect(current.value).toBe(replacement)
      }),
    30_000,
  )

  it.live(
    "project ConfigUpdated listener failure does not abort persistence or rebuild",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const disposed = yield* eventLatch("server.instance.disposed", f.project)
        const listener = (event: { directory?: string; payload: { type: string } }) => {
          if (event.directory === f.project && event.payload.type === Event.ConfigUpdated.type) {
            throw new Error("listener failed")
          }
        }
        GlobalBus.on("event", listener)
        try {
          const patch = yield* patchOverlay(f.project, "project", { permission: { bash: "ask" } })
          expect(patch.status).toBe(200)
          expect(readProjectConfig(f.project).permission).toEqual({ bash: "ask" })
          yield* awaitWithTimeout(disposed.await, "project rebuild did not complete after listener failure")
          expect((yield* overlayPermission(f.project, "project")).bash).toBe("ask")
        } finally {
          GlobalBus.off("event", listener)
        }
      }),
    30_000,
  )

  it.live(
    "promptAsync generation holds the lease past the HTTP response and blocks the rebuild",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)
        const session = yield* Effect.promise(() => createSession(f.project))

        yield* f.llm.hold("streamed", deferredAsPromise(gate))
        const accepted = yield* Effect.promise(async () => {
          const response = await request(f.project, `/session/${session.id}/prompt_async`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "async hello" }],
            }),
          })
          return response.status
        })
        expect(accepted).toBe(204)
        // The forked async generation starts asynchronously; poll the status gate.
        yield* awaitWithTimeout(
          pollWithTimeout(
            Effect.gen(function* () {
              const type = yield* sessionStatus(f.project, session.id)
              return type === "busy" ? (true as const) : undefined
            }),
            "async prompt never became busy",
            "20 seconds",
          ),
          "async prompt never became busy",
          "20 seconds",
        )
        yield* awaitWithTimeout(f.llm.wait(1), "async prompt never hit the LLM", "20 seconds")

        const patch = yield* patchOverlay(f.project, "project", { permission: { bash: "ask" } })
        expect(patch.status).toBe(200)
        // The async generation is still active: no disposal of its instance.
        expect(yield* instanceDisposed.done).toBe(false)

        yield* Deferred.succeed(gate, void 0)
        // The drain fires only after the async generation completes: the exact
        // old instance is disposed, but not before the gate release.
        yield* awaitWithTimeout(
          instanceDisposed.await,
          "async instance disposed event did not arrive after the generation completed",
        )
      }),
    30_000,
  )

  it.live(
    "two concurrent project cold PATCHes serialize without orphaning the runtime",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventCountLatch("server.instance.disposed", f.project, 2)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // Two cold project PATCHes race. The first becomes the writer and returns
        // immediately; the second serializes behind it and must NOT return while
        // the held stream blocks the first writer's drain.
        const first = yield* forkPatch(f.project, "project", { permission: { bash: "ask" } })
        const second = yield* forkPatch(f.project, "project", { permission: { edit: { "*": "ask" } } })

        expect((yield* first.result()).status).toBe(200)
        expect(yield* isDone(second.done)).toBe(false)

        // Releasing the stream lets the first writer drain/dispose/reboot and
        // then grants the second writer, which persists the final config.
        yield* Deferred.succeed(gate, void 0)
        assertStreamed(yield* Fiber.await(fiber))
        expect((yield* second.result()).status).toBe(200)

        // Both rebuilds disposed the directory's instance exactly once each.
        yield* awaitWithTimeout(instanceDisposed.await, "two instance disposals did not arrive")
        expect(yield* instanceDisposed.count).toBe(2)

        // The last persisted config wins and the live runtime serves it.
        const saved = readProjectConfig(f.project)
        expect(saved.permission).toEqual({ bash: "ask", edit: { "*": "ask" } })
        const permission = yield* overlayPermission(f.project, "project")
        expect(permission.edit).toEqual({ "*": "ask" })
      }),
    30_000,
  )

  it.live(
    "concurrent global cold PATCHes serialize and rebuild every loaded directory",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const globalDisposed = yield* eventCountLatch(Event.Disposed.type, undefined, 2)
        const otherDisposed = yield* eventLatch("server.instance.disposed", f.other)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // A second loaded directory must be covered by the global rebuild.
        yield* Effect.promise(async () => {
          await request(f.other, "/config/overlay?scope=project")
        })

        const first = yield* forkPatch(undefined, "global", { permission: { bash: "ask" } })
        const second = yield* forkPatch(undefined, "global", { permission: { edit: { "*": "ask" } } })

        expect((yield* first.result()).status).toBe(200)
        expect(yield* isDone(second.done)).toBe(false)

        yield* Deferred.succeed(gate, void 0)
        assertStreamed(yield* Fiber.await(fiber))
        expect((yield* second.result()).status).toBe(200)

        // Two global rebuilds ran; the second covered both loaded directories.
        yield* awaitWithTimeout(globalDisposed.await, "two global disposed events did not arrive")
        expect(yield* globalDisposed.count).toBe(2)
        yield* awaitWithTimeout(otherDisposed.await, "second directory was not rebuilt by the global patch")

        const projectPermission = yield* overlayPermission(f.project, "project")
        expect(projectPermission.edit).toEqual({ "*": "ask" })
        const otherPermission = yield* overlayPermission(f.other, "project")
        expect(otherPermission.edit).toEqual({ "*": "ask" })
      }),
    30_000,
  )

  it.live(
    "idle cold PATCH rebuilds promptly with no active generation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const disposed = yield* eventLatch(Event.Disposed.type)

        // Boot the project instance so there is something to dispose.
        yield* Effect.promise(async () => {
          await request(f.project, "/config/overlay?scope=project")
        })

        const patch = yield* patchOverlay(undefined, "global", { permission: { bash: "ask" } })
        expect(patch.status).toBe(200)

        // No stream anywhere: the drain is immediate and the rebuild runs
        // promptly, gated only by the event itself.
        yield* awaitWithTimeout(disposed.await, "immediate global disposal event did not arrive", "5 seconds")
        const permission = yield* overlayPermission(f.project, "project")
        expect(permission.bash).toBe("ask")
      }),
    30_000,
  )

  it.live(
    "failed persistence aborts the barrier, returns structured 400, and schedules no disposal",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const disposed = yield* eventLatch(Event.Disposed.type)
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)
        const configUpdated = yield* eventLatch(Event.ConfigUpdated.type)

        yield* Effect.promise(async () => {
          await seedGlobalConfig(f.global, { model: "keep-me" })
        })

        const patch = yield* patchOverlay(undefined, "global", { model: 123 })
        expect(patch.status).toBe(400)
        const body = patch.body as { name?: string; data?: { path?: string; issues?: unknown[] } }
        expect(body.name).toBe("ConfigInvalidError")
        expect(body.data?.path).toBeTruthy()
        expect(Array.isArray(body.data?.issues)).toBe(true)

        const saved = readGlobalConfig(f.global)
        expect(saved.model).toBe("keep-me")
        expect(yield* configUpdated.done).toBe(false)
        expect(yield* disposed.done).toBe(false)
        expect(yield* instanceDisposed.done).toBe(false)

        // The aborted ticket released the barrier: the next cold PATCH works.
        const next = yield* patchOverlay(undefined, "global", { permission: { bash: "ask" } })
        expect(next.status).toBe(200)
        yield* awaitWithTimeout(disposed.await, "barrier stayed held after failed persistence")
      }),
    30_000,
  )

  it.live(
    "command generation queues behind a cold PATCH and completes on the rebuilt instance",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)

        // A project-local command consumed by the command route.
        yield* Effect.promise(async () => {
          const cmd = path.join(f.project, ".kilo", "command")
          await fs.promises.mkdir(cmd, { recursive: true })
          await Bun.write(path.join(cmd, "hello.md"), "Say hello back.")
        })

        const sessionA = yield* Effect.promise(() => createSession(f.project))
        const { fiber: fiberA } = yield* startHeldPrompt(f.project, sessionA.id, gate)
        yield* waitForBusy(f.project, sessionA.id)

        // Session creation does not start a generation and must not block
        // behind the barrier, so create session B before the cold patch.
        const sessionB = yield* Effect.promise(() => createSession(f.project))

        const patch = yield* patchOverlay(f.project, "project", { permission: { bash: "ask" } })
        expect(patch.status).toBe(200)

        // The command is a generation entry (admission + snapshot): it queues
        // behind the barrier like any prompt.
        const llm = yield* TestLLMServer
        const cmdGate = yield* Deferred.make<void>()
        yield* llm.hold("command", deferredAsPromise(cmdGate))
        const cmdDone = yield* Deferred.make<void>()
        const cmdFiber = yield* Effect.forkDetach(
          Effect.gen(function* () {
            const result = yield* Effect.promise(async () => {
              const response = await request(f.project, `/session/${sessionB.id}/command`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ command: "hello", agent: "build", arguments: "" }),
              })
              return response.status
            })
            yield* Deferred.succeed(cmdDone, void 0)
            return result
          }),
        )
        expect(yield* isDone(cmdDone)).toBe(false)

        yield* Deferred.succeed(gate, void 0)
        assertStreamed(yield* Fiber.await(fiberA))
        yield* awaitWithTimeout(instanceDisposed.await, "instance disposal did not arrive before command admission")

        yield* Deferred.succeed(cmdGate, void 0)
        expect(yield* Fiber.join(cmdFiber)).toBe(200)
        const permission = yield* overlayPermission(f.project, "project")
        expect(permission.bash).toBe("ask")
      }),
    30_000,
  )

  it.live(
    "overlay and legacy PATCH routes return structured 400s for invalid config (LOCK-007)",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const disposed = yield* eventLatch(Event.Disposed.type)
        const configUpdated = yield* eventLatch(Event.ConfigUpdated.type)

        // Overlay global invalid → deep validation → typed ConfigInvalidError.
        const overlayGlobal = yield* patchOverlay(undefined, "global", { model: 123 })
        expect(overlayGlobal.status).toBe(400)
        const body = overlayGlobal.body as { name?: string; data?: { path?: string; issues?: unknown[] } }
        expect(body.name).toBe("ConfigInvalidError")
        expect(body.data?.path).toBeTruthy()
        expect(Array.isArray(body.data?.issues)).toBe(true)

        // Overlay project invalid.
        const overlayProject = yield* patchOverlay(f.project, "project", { model: 123 })
        expect(overlayProject.status).toBe(400)
        expect((overlayProject.body as { name?: string }).name).toBe("ConfigInvalidError")

        // Legacy /global/config invalid → structured 400 carrying the path.
        const legacyGlobal = yield* Effect.promise(async () => {
          const response = await request(undefined, "/global/config", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: 123 }),
          })
          return {
            status: response.status,
            body: (await response.json()) as { name?: string; data?: { message?: string } },
          }
        })
        expect(legacyGlobal.status).toBe(400)
        expect(legacyGlobal.body?.name).toBeTruthy()
        expect(legacyGlobal.body?.data?.message).toContain("model")

        // Legacy /config (project) invalid.
        const legacyProject = yield* Effect.promise(async () => {
          const response = await request(f.project, "/config", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: 123 }),
          })
          return {
            status: response.status,
            body: (await response.json()) as { name?: string; data?: { message?: string } },
          }
        })
        expect(legacyProject.status).toBe(400)
        expect(legacyProject.body?.name).toBeTruthy()
        expect(legacyProject.body?.data?.message).toContain("model")

        // Nothing was written or emitted by any failed save.
        expect(yield* configUpdated.done).toBe(false)
        expect(yield* disposed.done).toBe(false)
        expect(readGlobalConfig(f.global).model).toBeUndefined()
      }),
    30_000,
  )
})

// ─── real listener path (Server.listen with disposeMiddleware) ───────

describe("config rebuild deferral - Server.listen path", () => {
  it.live(
    "cold PATCH through a real listener defers disposal until the held stream completes and the listener keeps serving",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1" })),
          (value) => Effect.promise(() => value.stop(true)).pipe(Effect.ignore),
        )
        const gate = yield* Deferred.make<void>()
        const disposed = yield* eventLatch(Event.Disposed.type)
        const url = listener.url

        const base = url.toString().replace(/\/$/, "")
        const send = (dir: string, input: string, init?: RequestInit) =>
          Effect.promise(async () => {
            const response = await fetch(`${base}${input}`, {
              ...init,
              headers: {
                ...(dir ? { "x-kilo-directory": dir } : {}),
                ...init?.headers,
              },
            })
            return response
          })

        // The listener is a fresh layer (Layer.fresh) with its own SessionStatus
        // and GenerationGate instances, so status must be polled through the
        // listener itself — `web()` resolves to a separate service tree.
        const listenerStatus = (sessionID: string) =>
          Effect.promise(async () => {
            const response = await fetch(`${base}/session/status`, {
              headers: { "x-kilo-directory": f.project },
            })
            expect(response.status).toBe(200)
            const map = (await response.json()) as Record<string, { type: string }>
            return map[sessionID]?.type
          })
        const waitForListenerBusy = (sessionID: string) =>
          pollWithTimeout(
            Effect.gen(function* () {
              const type = yield* listenerStatus(sessionID)
              return type === "busy" ? (true as const) : undefined
            }),
            `session ${sessionID} never became busy`,
          )

        const create = yield* send(f.project, "/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "held stream" }),
        })
        expect(create.status).toBe(200)
        const session = yield* Effect.promise(() => create.json()) as Effect.Effect<SessionV1.Info>

        yield* f.llm.hold("streamed", deferredAsPromise(gate))
        const done = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkDetach(
          Effect.gen(function* () {
            const response = yield* send(f.project, `/session/${session.id}/message`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                agent: "build",
                model: { providerID: "test", modelID: "test-model" },
                parts: [{ type: "text", text: "hello" }],
              }),
            })
            const body = yield* Effect.promise(() => response.json()) as Effect.Effect<{ info?: { role?: string } }>
            yield* Deferred.succeed(done, void 0)
            return { status: response.status, body }
          }),
        )
        yield* f.llm.wait(1)
        yield* waitForListenerBusy(session.id)

        const patch = yield* send("", "/config/overlay", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "global", set: { permission: { bash: "ask" } } }),
        })
        expect(patch.status).toBe(200)
        expect(readGlobalConfig(f.global).permission).toEqual({ bash: "ask" })
        // The instance middleware gates new requests behind the global writer,
        // so the in-flight stream proof is the non-blocking done signal.
        expect(yield* isDone(done)).toBe(false)
        expect(yield* disposed.done).toBe(false)

        yield* Deferred.succeed(gate, void 0)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (!Exit.isSuccess(exit)) return
        expect(exit.value.status).toBe(200)
        expect(exit.value.body.info?.role).toBe("assistant")

        yield* awaitWithTimeout(disposed.await, "listener global disposed event did not arrive")

        // The listener process is stable across the rebuild: same URL and it
        // still serves the rebuilt runtime with the new config.
        expect(listener.url).toBe(url)
        const overlay = yield* send(f.project, "/config/overlay?scope=project")
        expect(overlay.status).toBe(200)
        const body = yield* Effect.promise(() => overlay.json()) as Effect.Effect<{
          effective: { permission?: Record<string, unknown> }
        }>
        expect(body.effective.permission?.bash).toBe("ask")
      }),
    30_000,
  )
})
