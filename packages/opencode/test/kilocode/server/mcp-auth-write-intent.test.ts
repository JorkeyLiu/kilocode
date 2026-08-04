// kilocode_change - new file
/**
 * MCP auth write-intent persistence (LOCK-007).
 *
 * The MCP auth routes — POST /mcp/:name/auth (start), POST /mcp/:name/auth/
 * callback, POST /mcp/:name/auth/authenticate, and DELETE /mcp/:name/auth
 * (remove) — persist machine-global auth storage and run pending OAuth flows.
 * They must take write-intent admission in the instance-context middleware:
 * never wait on a cold convergence fence (`gate.prepareWrite`, not
 * `gate.acquire`) and hold an identity-keyed write lifetime lease through the
 * complete handler, so an overlapping convergence pass can never dispose the
 * runtime the auth handler is using (LOCK-006/007).
 *
 * This test drives the real web handler with a HELD MCP auth handler:
 *   1. A project instance is booted and a generation (held LLM stream) keeps a
 *      reader lease on it.
 *   2. A cold project overlay PATCH raises the convergence fence; the pass
 *      parks at the held stream's reader drain — the fence stays up.
 *   3. DELETE /mcp/demo/auth is issued while the fence is up. It is admitted
 *      via prepareWrite (never waits on the fence), acquires the write lease,
 *      and parks inside `McpAuth.mutate` on the mcp-auth.json flock (held by
 *      this test) — the auth handler is now genuinely in flight.
 *   4. The held stream is released: convergence is otherwise ready, but the
 *      held auth handler's write lease keeps the pass parked — the runtime is
 *      NOT disposed while the auth handler is held. (A misclassified route
 *      would have parked at reader admission and the pass would have disposed
 *      the old runtime now, so this assertion discriminates.)
 *   5. The flock is released: the auth handler completes with 200 while the
 *      fence is still active, its write lease releases, and the pass disposes
 *      the old runtime exactly once.
 *
 * No arbitrary sleeps: progression is driven by Deferred gates, LLM holds, and
 * event latches; the only sleeps are bounded failure timeouts inside
 * `pollWithTimeout` / `awaitWithTimeout` plus one bounded non-occurrence window
 * (`assertNotResolved`) where the sleep IS the assertion — proving the pass
 * never disposes while the held auth handler's write lease is outstanding.
 */
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Deferred, Duration, Effect, Fiber, Layer } from "effect"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Server } from "../../../src/server/server"
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

/** The exact EffectFlock key McpAuth uses for the machine-global auth file. */
const mcpAuthLockKey = () => `mcp-auth:${path.join(Global.Path.data, "mcp-auth.json")}`

type HeldPrompt = {
  gate: Deferred.Deferred<void>
  done: Deferred.Deferred<void>
  fiber: Fiber.Fiber<number, never>
}

type HeldFlock = {
  release: Deferred.Deferred<void>
  fiber: Fiber.Fiber<unknown, unknown>
}

/**
 * LOCK-007 per-test owner. Every held-prompt fiber/gate, held flock, event
 * listener disposer, and temp project dir is registered here so teardown has
 * one registered cleanup path that runs on success, failure, and interruption:
 * release the flock and stream holds, join (then interrupt) the fibers, await
 * rebuilds, dispose instances, then invoke and clear the listener disposers.
 * Implemented as a closure so the cleanup generator captures the registries
 * lexically.
 */
const makeOwner = () => {
  const holds: HeldPrompt[] = []
  const flocks: HeldFlock[] = []
  const dirs = new Set<string>()
  const listens = new Set<() => void>()
  const cleanup = Effect.gen(function* () {
    // 1. release the held flock so any parked MCP auth handler can complete
    //    and hand back its write lease to the convergence pass
    yield* Effect.forEach(flocks, (held) =>
      Deferred.succeed(held.release, void 0).pipe(Effect.catchCause(() => Effect.void)),
    )
    yield* Effect.forEach(flocks, (held) =>
      Fiber.join(held.fiber).pipe(Effect.timeout("5 seconds"), Effect.catchCause(() => Effect.void)),
    )
    // 2. release every held gate so in-flight streams can complete
    yield* Effect.forEach(holds, (held) =>
      Deferred.succeed(held.gate, void 0).pipe(Effect.catchCause(() => Effect.void)),
    )
    // 3. join fibers with a bounded grace, then interrupt stragglers
    yield* Effect.forEach(holds, (held) =>
      Fiber.join(held.fiber).pipe(Effect.timeout("5 seconds"), Effect.catchCause(() => Effect.void)),
    )
    yield* Effect.forEach(holds, (held) =>
      Effect.gen(function* () {
        yield* Fiber.interrupt(held.fiber)
        yield* Fiber.join(held.fiber).pipe(Effect.catchCause(() => Effect.void))
      }),
    )
    // 4. await rebuilds so no detached rebuild leaks past the owner
    yield* awaitRebuilds().pipe(Effect.catchCause(() => Effect.void))
    // 5. dispose instances in safe order: per-dir route, then store-level
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
    // 6. invoke listener disposers, then clear the registry
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
    flocks,
    dirs,
    listens,
    cleanup,
    addHold: (held: HeldPrompt) => {
      holds.push(held)
    },
    addFlock: (held: HeldFlock) => {
      flocks.push(held)
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

// The test runtime also provides the real EffectFlock so the test can hold the
// exact mcp-auth.json lock the server's `McpAuth.mutate` serializes on. The
// flock fs lock and its process-wide in-process ownership map are shared across
// layer instances, so a hold from this runtime blocks the server's storage
// write until released.
const it = testEffect(Layer.mergeAll(TestLLMServer.layer, EffectFlock.defaultLayer))

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

/**
 * Assert a `done`-style signal (a `Deferred` poll or an event-latch `done`
 * effect) does NOT resolve within `window`. A bounded non-occurrence check:
 * the correct behavior here is a never-event (the held MCP auth handler write
 * lease parks the convergence pass indefinitely), so the window only bounds
 * how long the test waits to observe a misclassification's disposal.
 */
const assertNotResolved = (done: Effect.Effect<boolean>, message: string, window: Duration.Input) =>
  Effect.gen(function* () {
    yield* Effect.sleep(window)
    const fired = yield* done
    if (fired) yield* Effect.fail(new Error(message))
  })

type Fixture = { llm: TestLLMServer["Service"]; project: string; global: string }

/** Fresh global-config tmpdir + a git project tmpdir with the test provider
 * and a declared (disabled, local) MCP server so the auth remove route sees
 * `demo` in its status map without any network. */
const fixture = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const tmp = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const global = await tmpdir({ retain: true })
      await seedGlobalConfig(global.path)
      const project = await tmpdir({
        git: true,
        retain: true,
        config: {
          ...testProviderConfig(llm.url),
          mcp: {
            demo: { type: "local", command: ["echo", "demo"], enabled: false },
          },
        },
      })
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

/** Event latch: resolves when `n` matching events arrive. */
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
const startHeldPrompt = (owner: Owner, dir: string, sessionID: string, gate: Deferred.Deferred<void>) =>
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
              parts: [{ type: "text", text: "hello" }],
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

/** Send a config/overlay PATCH and return the status. */
const patch = (dir: string | undefined, scope: "global" | "project", set: Record<string, unknown>) =>
  Effect.promise(async () => {
    const response = await request(dir, "/config/overlay", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, set }),
    })
    return response.status
  })

/**
 * Hold the mcp-auth.json EffectFlock lock (the same flock `McpAuth.mutate`
 * serializes on) until `release` resolves. The MCP auth handler blocks inside
 * `McpAuth.mutate` while this lock is held, making the handler genuinely
 * in-flight. The flock fs lock is process-wide, so the server's AppLayer flock
 * instance observes the hold and retries until the scope closes.
 */
const holdMcpAuthFlock = (release: Deferred.Deferred<void>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      yield* flock.acquire(mcpAuthLockKey())
      yield* Deferred.await(release)
    }),
  )

describe("MCP auth write-intent persistence (LOCK-007)", () => {
  it.live(
    "a held MCP auth handler is admitted via write intent (no fence wait) and is not disposed by an overlapping convergence pass",
    () =>
      Effect.gen(function* () {
        const { f, owner } = yield* withOwner
        const streamGate = yield* Deferred.make<void>()
        const flockRelease = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventCountLatch(owner, "server.instance.disposed", 1)

        // Boot the project instance and hold a generation (reader lease) on it.
        const session = yield* Effect.promise(() => createSession(f.project))
        const { done } = yield* startHeldPrompt(owner, f.project, session.id, streamGate)
        yield* waitForBusy(f.project, session.id)

        // Hold the mcp-auth.json flock so the DELETE handler blocks inside
        // McpAuth.mutate once it reaches the storage write.
        const flockFiber = yield* Effect.forkDetach(holdMcpAuthFlock(flockRelease))
        owner.addFlock({ release: flockRelease, fiber: flockFiber })

        // Cold project PATCH: fence up; the convergence pass parks at the held
        // stream's reader drain, so the fence stays active.
        const cold = yield* patch(f.project, "project", { autoupdate: false })
        expect(cold).toBe(200)
        expect(yield* instanceDisposed.done).toBe(false)

        // Fork the MCP auth credential removal while the fence is active.
        const removeDone = yield* Deferred.make<void>()
        const removeResult = yield* Deferred.make<{ status: number; body: unknown }>()
        const removeFiber = yield* Effect.forkDetach(
          Effect.gen(function* () {
            const result = yield* Effect.promise(async () => {
              const res = await request(f.project, "/mcp/demo/auth", { method: "DELETE" })
              let body: unknown
              try {
                body = await res.json()
              } catch {
                body = undefined
              }
              return { status: res.status, body }
            })
            yield* Deferred.succeed(removeResult, result)
            yield* Deferred.succeed(removeDone, void 0)
          }),
        )
        // The handler is admitted via prepareWrite (never waits on the fence)
        // and is now held inside McpAuth.mutate at the flock.
        yield* Effect.yieldNow
        expect(yield* isDone(removeDone)).toBe(false)
        expect(yield* instanceDisposed.done).toBe(false)

        // Release the stream: convergence is otherwise ready, but the held MCP
        // auth handler's write lease keeps the pass parked — the runtime must
        // NOT be disposed while the auth handler is in flight. A misclassified
        // route (reader admission) would have disposed it here, so this is the
        // discriminating assertion for both no-fence-wait and lease coverage.
        yield* Deferred.succeed(streamGate, void 0)
        // The LLM hold release → stream completion is bounded; 10s covers
        // slow CI hosts.
        yield* awaitWithTimeout(Deferred.await(done), "held stream never completed", "10 seconds")
        // The convergence pass is now otherwise ready (the stream reader drain
        // released). It must NOT dispose the runtime while the MCP auth handler
        // is still held at the flock: a misclassified route would let the pass
        // dispose the old runtime now. Bounded non-occurrence window — the
        // correct case parks indefinitely on the write lease, so the window
        // only bounds observing a misclassification's disposal.
        yield* assertNotResolved(
          instanceDisposed.done,
          "convergence disposed the runtime while the MCP auth handler was held",
          "2 seconds",
        )
        expect(yield* isDone(removeDone)).toBe(false)
        expect(yield* instanceDisposed.done).toBe(false)

        // Release the flock: the auth handler completes with 200 while the
        // fence is still active, its write lease releases, and the pass
        // disposes the old runtime exactly once. The flock retry spacing is
        // bounded, so the handler completion is awaited with a 10s bound.
        yield* Deferred.succeed(flockRelease, void 0)
        yield* awaitWithTimeout(Deferred.await(removeDone), "MCP auth handler never completed", "10 seconds")
        yield* Fiber.join(removeFiber)
        yield* Fiber.join(flockFiber)
        const result = yield* Deferred.await(removeResult)
        expect(result.status).toBe(200)
        expect(result.body).toEqual({ success: true })

        yield* awaitWithTimeout(
          instanceDisposed.await,
          "instance disposal did not arrive after auth handler release",
          "10 seconds",
        )
        expect(yield* instanceDisposed.count).toBe(1)
        yield* awaitRebuilds()
      }),
    // The convergence pass includes a full instance reboot after the held
    // auth handler releases its write lease; the same 120s bound as the other
    // held-stream lifecycle tests covers slow CI hosts.
    120_000,
  )
})
