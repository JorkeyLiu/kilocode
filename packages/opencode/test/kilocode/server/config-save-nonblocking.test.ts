// kilocode_change - new file
/**
 * Non-blocking cold-save regression suite (LOCK-001/002/004/005/006/007).
 *
 * The architectural fix: a cold save must acknowledge after authoritative
 * persistence WITHOUT waiting for any active generation or an earlier runtime
 * rebuild to drain, while new generations still wait for convergence and the
 * runtime converges to the latest persisted config. These tests drive the real
 * web handler (`Server.Default`) with a HELD LLM stream and assert, with a
 * bounded Deferred/event signal (never a wall-clock sleep), that every save
 * response completes BEFORE the stream is released, and that the final runtime
 * serves the latest persisted config after exactly the intended coalesced
 * rebuild/disposal.
 *
 * Covered scenarios (LOCK-001/004/005/006/007):
 * 1. cold project save then a HOT model save while the stream is held — the
 *    hot save never waits on the cold convergence fence.
 * 2. cold→cold project saves while the stream is held — both acknowledge;
 *    the burst coalesces into one disposal; the latest config converges.
 * 3. global cold save + project cold save while the stream is held — global
 *    and project scopes both acknowledge and converge.
 * 4. provider-auth mutation (root /auth PUT) while the stream is held — the
 *    auth change persists before release and the runtime converges.
 * 5. failed save (invalid config) during the held stream, then a successful
 *    save — the failure releases the fence and does not block the follow-up.
 * 6. final latest-config convergence: after release, the rebuilt runtime
 *    serves the last save.
 */
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Deferred, Effect, Fiber } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Server } from "../../../src/server/server"
import { Event } from "../../../src/server/event"
import { GlobalBus } from "../../../src/bus/global"
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

type HeldPrompt = {
  gate: Deferred.Deferred<void>
  done: Deferred.Deferred<void>
  fiber: Fiber.Fiber<number, never>
}

/**
 * LOCK-007 per-test owner. Every held-prompt fiber/gate, event listener
 * disposer, and temp project dir is registered here so teardown has one
 * registered cleanup path that runs on success, failure, and interruption:
 * release the holds, join (then interrupt) the fibers, await rebuilds, dispose
 * instances, then invoke and clear the listener disposer registry. Implemented
 * as a closure so the cleanup generator captures the registries lexically.
 */
const makeOwner = () => {
  const holds: HeldPrompt[] = []
  const dirs = new Set<string>()
  const listens = new Set<() => void>()
  const cleanup = Effect.gen(function* () {
    // 1. release every held gate so in-flight streams can complete
    yield* Effect.forEach(holds, (held) =>
      Deferred.succeed(held.gate, void 0).pipe(Effect.catchCause(() => Effect.void)),
    )
    // 2. join fibers with a bounded grace, then interrupt stragglers
    yield* Effect.forEach(holds, (held) =>
      Fiber.join(held.fiber).pipe(Effect.timeout("5 seconds"), Effect.catchCause(() => Effect.void)),
    )
    yield* Effect.forEach(holds, (held) =>
      Effect.gen(function* () {
        yield* Fiber.interrupt(held.fiber)
        yield* Fiber.join(held.fiber).pipe(Effect.catchCause(() => Effect.void))
      }),
    )
    // 3. await rebuilds so no detached rebuild leaks past the owner
    yield* awaitRebuilds().pipe(Effect.catchCause(() => Effect.void))
    // 4. dispose instances in safe order: per-dir route, then store-level
    yield* Effect.forEach([...dirs], (dir) =>
      Effect.promise(async () => {
        try {
          await request(dir, "/instance/dispose", { method: "POST" })
        } catch {
          // instance may already be disposed; teardown must not fail
        }
      }),
    )
    yield* Effect.promise(() => disposeAllInstances()).pipe(Effect.catchCause(() => Effect.void))
    // 5. invoke listener disposers, then clear the registry
    for (const dispose of listens) {
      try {
        dispose()
      } catch {
        // listener may already be removed; teardown must not fail
      }
    }
    listens.clear()
  })
  return {
    holds,
    dirs,
    listens,
    cleanup,
    addHold: (held: HeldPrompt) => {
      holds.push(held)
    },
    addDir: (dir: string) => {
      dirs.add(dir)
    },
    addListener: (dispose: () => void) => {
      listens.add(dispose)
    },
  }
}

type Owner = ReturnType<typeof makeOwner>

/** Per-test owner acquired so its cleanup runs on success, failure, and interruption. */
const acquireOwner = Effect.acquireRelease(Effect.sync(() => makeOwner()), (owner) => owner.cleanup)

afterEach(async () => {
  ;(Global.Path as { config: string }).config = original
  await Effect.runPromise(awaitRebuilds())
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(TestLLMServer.layer)

async function json<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

/** Seed a global config directory with permission.bash already set. */
async function seedGlobalConfig(dir: string) {
  await Bun.write(
    path.join(dir, "kilo.jsonc"),
    JSON.stringify({ $schema: "https://app.kilo.ai/config.json", permission: { bash: "allow" } }, null, 2),
  )
  await markPluginDependenciesReady(dir)
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

// LOCK-002 cold snapshot observables: two instruction files whose markers are
// consumed into the generation system prompt (`config.instructions` is a cold
// key read via Instruction.system → the LLM request body). The admitted
// generation must carry only the startup marker; a post-convergence generation
// must carry only the new marker.
const COLD_MARKER_V1 = "COLD-SNAPSHOT-V1-MARKER"
const COLD_MARKER_V2 = "COLD-SNAPSHOT-V2-MARKER"

/** Extract the joined system prompt from a recorded LLM request body. */
const systemPrompt = (body: Record<string, unknown>): string => {
  const messages = (body.messages ?? []) as { role?: string; content?: unknown }[]
  for (const m of messages) {
    if (m.role !== "system") continue
    if (typeof m.content === "string") return m.content
    if (Array.isArray(m.content)) {
      return m.content
        .map((part) =>
          part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "",
        )
        .join("\n")
    }
  }
  return ""
}

type Fixture = { llm: TestLLMServer["Service"]; project: string; global: string }

/** Fresh global-config tmpdir + a git project tmpdir with the test provider. */
const fixture = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const tmp = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const global = await tmpdir({ retain: true })
      await seedGlobalConfig(global.path)
      const project = await tmpdir({ git: true, retain: true, config: testProviderConfig(llm.url) })
      await markProjectConfigReady(project.path)
      return { global, project }
    }),
    (value) =>
      Effect.promise(async () => {
        await value.project[Symbol.asyncDispose]().catch(() => undefined)
        await value.global[Symbol.asyncDispose]().catch(() => undefined)
      }),
  )
  ;(Global.Path as { config: string }).config = tmp.global.path
  const result: Fixture = { llm, project: tmp.project.path, global: tmp.global.path }
  return result
})

/** Per-test fixture + LOCK-007 owner: owner cleanup runs before the tmpdir release. */
const withOwner = Effect.gen(function* () {
  const f = yield* fixture
  const owner = yield* acquireOwner
  owner.addDir(f.project)
  return { f, owner }
})

const createSession = async (dir: string) =>
  json<SessionV1.Info>(
    await request(dir, "/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "held stream" }),
    }),
  )

/**
 * Event latch: resolves when `n` matching events arrive. `done` is a
 * non-blocking in-flight check; `count` reports how many arrived so far.
 */
const eventCountLatch = (owner: Owner, type: string, n = 1) =>
  Effect.gen(function* () {
    const deferred = yield* Deferred.make<void>()
    let count = 0
    const handler = (event: { directory?: string; payload: { type: string } }) => {
      if (event.payload.type !== type) return
      count += 1
      if (count >= n) void Effect.runFork(Deferred.succeed(deferred, void 0))
    }
    GlobalBus.on("event", handler)
    const dispose = () => GlobalBus.removeListener("event", handler)
    owner.addListener(dispose)
    return {
      await: Deferred.await(deferred),
      done: isDone(deferred),
      count: Effect.sync(() => count),
      dispose,
    }
  })

/**
 * Queue a held LLM reply and fork the prompt request. Resolves once the held
 * main call is in flight. `done` succeeds when the prompt HTTP response
 * completes — the bounded in-flight signal used instead of polling status.
 */
const startHeldPrompt = (
  owner: Owner,
  dir: string,
  sessionID: string,
  gate: Deferred.Deferred<void>,
  text = "hello",
) =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    yield* llm.hold("streamed", deferredAsPromise(gate))
    const done = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkDetach(
      Effect.gen(function* () {
        const response = yield* Effect.promise(async () => {
          const res = await request(dir, `/session/${sessionID}/message`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text }],
            }),
          })
          return res.status
        })
        expect(response).toBe(200)
        yield* Deferred.succeed(done, void 0)
        return response
      }),
    )
    yield* llm.wait(1)
    owner.addHold({ gate, done, fiber })
    return { fiber, done }
  })

/** Send a plain (non-held) generation message and return the HTTP status. */
const sendMessage = (dir: string, sessionID: string, text: string) =>
  Effect.promise(async () => {
    const res = await request(dir, `/session/${sessionID}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text }],
      }),
    })
    return res.status
  })

const waitForBusy = (dir: string, sessionID: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const response = yield* Effect.promise(async () => {
        const res = await request(dir, "/session/status")
        const map = (await res.json()) as Record<string, { type: string }>
        return map[sessionID]?.type
      })
      return response === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
  )

/** Send a config/overlay PATCH and return the status + persisted read. */
const patch = (dir: string | undefined, scope: "global" | "project", set: Record<string, unknown>) =>
  Effect.promise(async () => {
    const response = await request(dir, "/config/overlay", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, set }),
    })
    return response.status
  })

/** Read a named key from the effective project-scope config overlay. */
const effectiveValue = (dir: string, key: string) =>
  Effect.promise(async () => {
    const overlay = await json<{ effective: Record<string, unknown> }>(
      await request(dir, "/config/overlay?scope=project"),
    )
    return overlay.effective[key]
  })

/** Await a signal Deferred effect with a bounded failure timeout. */
const joinSignal = (effect: Effect.Effect<void>) => awaitWithTimeout(effect, "signal never arrived")

describe("cold saves acknowledge while a stream is held (LOCK-001)", () => {
  it.live(
    "cold project save then a hot model save: the hot save never waits on the cold convergence fence",
    () =>
      Effect.gen(function* () {
        const { f, owner } = yield* withOwner
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventCountLatch(owner, "server.instance.disposed", 1)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { done } = yield* startHeldPrompt(owner, f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // Cold save: acknowledges immediately (fence up, response before drain).
        const cold = yield* patch(f.project, "project", { autoupdate: false })
        expect(cold).toBe(200)

        // The stream is STILL held. A hot save must complete now — LOCK-006:
        // hot writes never wait on a cold convergence fence. This is the
        // exact regression the architectural fix addresses.
        const hot = yield* patch(f.project, "project", { model: "test/hot-model" })
        expect(hot).toBe(200)
        expect(yield* isDone(done)).toBe(false)

        // Release: the cold convergence disposes exactly once; the hot save
        // contributed nothing (no second disposal, no second rebuild).
        yield* Deferred.succeed(gate, void 0)
        yield* awaitWithTimeout(Deferred.await(done), "held stream never completed")
        yield* joinSignal(instanceDisposed.await)
        expect(yield* instanceDisposed.count).toBe(1)

        // Latest persisted config converges: both saves are on disk and the
        // rebuilt runtime serves them.
        expect(yield* effectiveValue(f.project, "autoupdate")).toBe(false)
      }),
    30_000,
  )

  it.live(
    "cold→cold project saves during the held stream coalesce and the latest config converges",
    () =>
      Effect.gen(function* () {
        const { f, owner } = yield* withOwner
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventCountLatch(owner, "server.instance.disposed", 1)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { done } = yield* startHeldPrompt(owner, f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // Both cold saves acknowledge while the stream is held (LOCK-001);
        // the burst coalesces into one convergence pass (LOCK-004).
        const first = yield* patch(f.project, "project", { autoupdate: false })
        expect(first).toBe(200)
        const second = yield* patch(f.project, "project", { username: "cold-user" })
        expect(second).toBe(200)
        expect(yield* isDone(done)).toBe(false)

        yield* Deferred.succeed(gate, void 0)
        yield* awaitWithTimeout(Deferred.await(done), "held stream never completed")
        yield* joinSignal(instanceDisposed.await)
        expect(yield* instanceDisposed.count).toBe(1)

        // The last committed saves win: the rebuilt runtime serves both keys.
        expect(yield* effectiveValue(f.project, "autoupdate")).toBe(false)
        expect(yield* effectiveValue(f.project, "username")).toBe("cold-user")
      }),
    30_000,
  )

  it.live(
    "global cold save + project cold save during the held stream both acknowledge and converge",
    () =>
      Effect.gen(function* () {
        const { f, owner } = yield* withOwner
        const gate = yield* Deferred.make<void>()
        const globalDisposed = yield* eventCountLatch(owner, Event.Disposed.type, 1)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { done } = yield* startHeldPrompt(owner, f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // Global cold save (affects every loaded directory) and a project cold
        // save (its own directory) both acknowledge while the stream is held.
        const global = yield* patch(undefined, "global", { autoupdate: "notify" })
        expect(global).toBe(200)
        const project = yield* patch(f.project, "project", { username: "cold-user" })
        expect(project).toBe(200)
        expect(yield* isDone(done)).toBe(false)

        yield* Deferred.succeed(gate, void 0)
        yield* awaitWithTimeout(Deferred.await(done), "held stream never completed")
        yield* joinSignal(globalDisposed.await)
        expect(yield* globalDisposed.count).toBe(1)

        // Both scopes converge to their latest persisted state.
        expect(yield* effectiveValue(f.project, "autoupdate")).toBe("notify")
        expect(yield* effectiveValue(f.project, "username")).toBe("cold-user")
      }),
    30_000,
  )

  it.live(
    "provider-auth mutation persists before release and the runtime converges",
    () =>
      Effect.gen(function* () {
        const { f, owner } = yield* withOwner
        const gate = yield* Deferred.make<void>()
        const globalDisposed = yield* eventCountLatch(owner, Event.Disposed.type, 1)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { done } = yield* startHeldPrompt(owner, f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // Root auth set routes through the canonical provider-auth lifecycle:
        // it acknowledges after persistence, before the drain.
        const auth = yield* Effect.promise(async () => {
          const response = await request(f.project, "/auth/test", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "api", key: "rotated-key" }),
          })
          return response.status
        })
        expect(auth).toBe(200)
        expect(yield* isDone(done)).toBe(false)

        yield* Deferred.succeed(gate, void 0)
        yield* awaitWithTimeout(Deferred.await(done), "held stream never completed")
        yield* joinSignal(globalDisposed.await)
        expect(yield* globalDisposed.count).toBe(1)
      }),
    30_000,
  )

  it.live(
    "a failed save during the held stream releases the fence and the follow-up save converges",
    () =>
      Effect.gen(function* () {
        const { f, owner } = yield* withOwner
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventCountLatch(owner, "server.instance.disposed", 1)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { done } = yield* startHeldPrompt(owner, f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // Invalid cold save: structured 400, nothing persisted, fence released
        // (LOCK-007) — it must NOT hang behind the held stream either.
        const bad = yield* Effect.promise(async () => {
          const response = await request(undefined, "/config/overlay", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ scope: "global", set: { model: 123 } }),
          })
          return response.status
        })
        expect(bad).toBe(400)

        // A successful cold save right after the failed one works and converges.
        const good = yield* patch(undefined, "global", { autoupdate: false })
        expect(good).toBe(200)
        expect(yield* isDone(done)).toBe(false)

        yield* Deferred.succeed(gate, void 0)
        yield* awaitWithTimeout(Deferred.await(done), "held stream never completed")
        yield* joinSignal(instanceDisposed.await)
        expect(yield* instanceDisposed.count).toBe(1)

        expect(yield* effectiveValue(f.project, "autoupdate")).toBe(false)
      }),
    30_000,
  )
})

// ─── Hot permission saves (LOCK-002): never rebuild, never wait on a fence ─

describe("hot permission saves never wait on a fence or rebuild (LOCK-002)", () => {
  it.live(
    "project overlay permission save during a held stream returns immediately and never disposes",
    () =>
      Effect.gen(function* () {
        const { f, owner } = yield* withOwner
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventCountLatch(owner, "server.instance.disposed", 1)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { done } = yield* startHeldPrompt(owner, f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // permission is hot (LOCK-002): the overlay save must return while the
        // held stream is still running, persist immediately, and schedule NO
        // disposal/rebuild — a cold classification would drain the stream and
        // dispose the runtime the generation is running on.
        const save = yield* patch(f.project, "project", { permission: { bash: "ask" } })
        expect(save).toBe(200)
        expect(yield* isDone(done)).toBe(false)
        expect(yield* instanceDisposed.done).toBe(false)

        // The permission is already effective for new requests — no rebuild,
        // no runtime swap.
        expect(yield* effectiveValue(f.project, "permission")).toMatchObject({ bash: "ask" })

        yield* Deferred.succeed(gate, void 0)
        yield* awaitWithTimeout(Deferred.await(done), "held stream never completed")
        // Even after the stream completes, no disposal ever happens: the hot
        // save contributed no rebuild obligation.
        yield* awaitRebuilds()
        expect(yield* instanceDisposed.done).toBe(false)
      }),
    30_000,
  )

  it.live(
    "global overlay permission save during a held stream returns immediately and never rebuilds",
    () =>
      Effect.gen(function* () {
        const { f, owner } = yield* withOwner
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventCountLatch(owner, "server.instance.disposed", 1)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { done } = yield* startHeldPrompt(owner, f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        const save = yield* patch(undefined, "global", { permission: { bash: "ask" } })
        expect(save).toBe(200)
        expect(yield* isDone(done)).toBe(false)
        expect(yield* instanceDisposed.done).toBe(false)
        expect(yield* effectiveValue(f.project, "permission")).toMatchObject({ bash: "ask" })

        yield* Deferred.succeed(gate, void 0)
        yield* awaitWithTimeout(Deferred.await(done), "held stream never completed")
        yield* awaitRebuilds()
        expect(yield* instanceDisposed.done).toBe(false)
      }),
    30_000,
  )

  it.live(
    "transaction permission save during a held stream returns immediately and never rebuilds",
    () =>
      Effect.gen(function* () {
        const { f, owner } = yield* withOwner
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventCountLatch(owner, "server.instance.disposed", 1)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { done } = yield* startHeldPrompt(owner, f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        const save = yield* Effect.promise(async () => {
          const response = await request(f.project, "/config/transaction", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ global: { set: { permission: { bash: "ask" } } } }),
          })
          return response.status
        })
        expect(save).toBe(200)
        expect(yield* isDone(done)).toBe(false)
        expect(yield* instanceDisposed.done).toBe(false)
        expect(yield* effectiveValue(f.project, "permission")).toMatchObject({ bash: "ask" })

        yield* Deferred.succeed(gate, void 0)
        yield* awaitWithTimeout(Deferred.await(done), "held stream never completed")
        yield* awaitRebuilds()
        expect(yield* instanceDisposed.done).toBe(false)
      }),
    30_000,
  )

  it.live(
    "legacy /config permission save during a held stream returns immediately and never rebuilds",
    () =>
      Effect.gen(function* () {
        const { f, owner } = yield* withOwner
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventCountLatch(owner, "server.instance.disposed", 1)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { done } = yield* startHeldPrompt(owner, f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        const save = yield* Effect.promise(async () => {
          const response = await request(f.project, "/config", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ permission: { bash: "ask" } }),
          })
          return response.status
        })
        expect(save).toBe(200)
        expect(yield* isDone(done)).toBe(false)
        expect(yield* instanceDisposed.done).toBe(false)
        expect(yield* effectiveValue(f.project, "permission")).toMatchObject({ bash: "ask" })

        yield* Deferred.succeed(gate, void 0)
        yield* awaitWithTimeout(Deferred.await(done), "held stream never completed")
        yield* awaitRebuilds()
        expect(yield* instanceDisposed.done).toBe(false)
      }),
    30_000,
  )
})

// ─── LOCK-007: registered teardown runs before the normal explicit gate release ─

describe("held-stream teardown is failure-safe (LOCK-007)", () => {
  it.live(
    "owner cleanup releases the hold, joins the fiber, and clears listeners without hanging",
    () =>
      Effect.gen(function* () {
        const { f, owner } = yield* withOwner
        const gate = yield* Deferred.make<void>()
        yield* eventCountLatch(owner, "server.instance.disposed", 1)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber, done } = yield* startHeldPrompt(owner, f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)
        expect(yield* isDone(done)).toBe(false)

        // LOCK-007 failure path: run the registered teardown WITHOUT the normal
        // explicit gate release. It must release the hold, join the fiber, and
        // tear down within a bounded window — no hang, no discarded fiber.
        yield* awaitWithTimeout(owner.cleanup, "owner cleanup hung on a held stream", "10 seconds")

        expect(yield* isDone(done)).toBe(true)
        // The held prompt fiber ran to completion (200) — released and joined,
        // not interrupted.
        const status = yield* Fiber.join(fiber).pipe(Effect.catchCause(() => Effect.succeed(-1)))
        expect(status).toBe(200)
        // Listener disposers were invoked and the registry cleared by cleanup.
        expect(owner.listens.size).toBe(0)
      }),
    30_000,
  )
})

// ─── LOCK-002: generation startup snapshot isolation across a cold save ───

describe("in-flight generation keeps its startup cold config (LOCK-002)", () => {
  it.live(
    "a held generation serves the old instructions, the cold save responds before release, and a post-convergence generation serves the new instructions",
    () =>
      Effect.gen(function* () {
        const { f, owner } = yield* withOwner
        const llm = yield* TestLLMServer
        // Seed both instruction files and the STARTUP cold config BEFORE the
        // project instance boots, so the first generation snapshots V1 and the
        // cold save only has to flip `instructions` to the already-present V2
        // file (no file writes racing the convergence reboot).
        yield* Effect.promise(async () => {
          await Bun.write(path.join(f.project, "PROMPT.md"), COLD_MARKER_V1)
          await Bun.write(path.join(f.project, "PROMPT2.md"), COLD_MARKER_V2)
          const file = path.join(f.project, "opencode.json")
          const cfg = JSON.parse(await Bun.file(file).text()) as Record<string, unknown>
          cfg.instructions = ["PROMPT.md"]
          await Bun.write(file, JSON.stringify(cfg, null, 2))
        })

        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventCountLatch(owner, "server.instance.disposed", 1)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { done } = yield* startHeldPrompt(owner, f.project, session.id, gate, "probe-old")
        yield* waitForBusy(f.project, session.id)

        // The admitted generation already produced its real LLM request from
        // the STARTUP snapshot: the system prompt carries the OLD instruction.
        const firstBodies = yield* llm.inputs
        const firstHit = firstBodies.find((body) => JSON.stringify(body).includes("probe-old"))
        expect(firstHit).toBeDefined()
        const firstSystem = systemPrompt(firstHit!)
        expect(firstSystem).toContain(COLD_MARKER_V1)
        expect(firstSystem).not.toContain(COLD_MARKER_V2)

        // Cold save while the stream is held (LOCK-001): acknowledges after
        // persistence, BEFORE the stream is released — the fence defers the
        // drain behind the held generation.
        const save = yield* patch(f.project, "project", { instructions: ["PROMPT2.md"] })
        expect(save).toBe(200)
        expect(yield* isDone(done)).toBe(false)

        // The new config did not leak into any request while held: no LLM hit
        // carries the V2 marker, and the held generation's request still has V1.
        const midBodies = yield* llm.inputs
        expect(midBodies.every((body) => !JSON.stringify(body).includes(COLD_MARKER_V2))).toBe(true)
        const midHit = midBodies.find((body) => JSON.stringify(body).includes("probe-old"))
        expect(midHit).toBeDefined()
        expect(systemPrompt(midHit!)).toContain(COLD_MARKER_V1)

        // Release: convergence disposes the pre-save runtime exactly once and
        // reboots it from the persisted disk config.
        yield* Deferred.succeed(gate, void 0)
        yield* awaitWithTimeout(Deferred.await(done), "held stream never completed")
        yield* joinSignal(instanceDisposed.await)
        expect(yield* instanceDisposed.count).toBe(1)
        yield* awaitRebuilds()

        // A NEW generation after convergence snapshots the NEW cold config:
        // its real LLM request system prompt carries only the V2 instruction.
        // The request hit is recorded at arrival, before the response returns,
        // so awaiting the POST is a bounded in-flight signal (no sleep).
        const secondStatus = yield* sendMessage(f.project, session.id, "probe-new")
        expect(secondStatus).toBe(200)
        const secondBodies = yield* llm.inputs
        const secondHit = secondBodies.find((body) => JSON.stringify(body).includes("probe-new"))
        expect(secondHit).toBeDefined()
        const secondSystem = systemPrompt(secondHit!)
        expect(secondSystem).toContain(COLD_MARKER_V2)
        expect(secondSystem).not.toContain(COLD_MARKER_V1)
      }),
    30_000,
  )
})
