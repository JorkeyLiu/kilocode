/**
 * Drain-control admission bypass during cold config convergence fences
 * (LOCK-004/005/006).
 *
 * While a cold config save is draining active generations, instance-gated
 * reader admission starves behind the drain. The only requests that must
 * still complete are the pre-fence lifecycle controls: session abort,
 * queued-message cancel, permission reply, and question reply/reject. They
 * serve from the pre-fence `InstanceStore.snapshot` — never gate.acquire,
 * store.load, or a new runtime boot — and normal new prompts remain blocked.
 *
 * Determinism: progression is driven only by Deferred/LLM gates, event latches,
 * and session-status gates; the only sleeps are bounded failure timeouts inside
 * `pollWithTimeout`/`awaitWithTimeout`. No arbitrary sleep progression.
 *
 * Isolation: same afterEach discipline as config-rebuild-stream.test.ts —
 * await pending rebuilds, dispose per-test instances, reset the database.
 */
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Deferred, Effect, Exit, Fiber } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Server } from "../../../src/server/server"
import { Event } from "../../../src/server/event"
import { GlobalBus } from "../../../src/bus/global"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Permission } from "../../../src/permission"
import { Question } from "../../../src/question"
import { Suggestion } from "../../../src/kilocode/suggestion"
import { Notebook } from "../../../src/kilocode/notebook/service"
import { Session } from "../../../src/session/session"
import { SessionID, MessageID } from "../../../src/session/schema"
import { TestLLMServer } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../../lib/effect"
import { awaitRebuilds } from "../../../src/kilocode/server/config-rebuild"
import { classifyDrainControl } from "../../../src/kilocode/server/drain-control"
import { KiloSessionPromptQueue } from "../../../src/kilocode/session/prompt-queue"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
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
  try {
    const list = await Suggestion.list()
    for (const entry of list) {
      try {
        await Suggestion.dismiss(entry.id)
      } catch {
        // waiter already settled; ignore
      }
    }
  } catch {
    // Suggestion global is best-effort cleanup; ignore
  }
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

/** Event gate: resolves when a GlobalBus event of `type` arrives. */
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

/** Event capture: collects `properties` of matching events until disposed. */
const eventCapture = <T>(type: string, directory?: string) =>
  Effect.gen(function* () {
    const received: T[] = []
    const handler = (event: { directory?: string; payload: { type: string; properties: T } }) => {
      if (event.payload.type !== type) return
      if (directory !== undefined && event.directory !== directory) return
      received.push(event.payload.properties)
    }
    GlobalBus.on("event", handler)
    ownedListeners.add(() => GlobalBus.removeListener("event", handler))
    return {
      received,
      dispose: () => GlobalBus.removeListener("event", handler),
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
 * main call is in flight. `done` succeeds when the prompt HTTP response
 * completes; it is the non-blocking in-flight signal for the stream.
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
    return { status: response.status }
  })

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

/** Run an effect on the production runtime bound to the project instance. */
const withInstance = (dir: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(effect as Effect.Effect<A, E, never>)))

// ─── classifier unit coverage (LOCK-006) ─────────────────────────────

describe("classifyDrainControl exact segment classification", () => {
  it.effect("classifies the mandatory control paths", () =>
    Effect.gen(function* () {
      expect(classifyDrainControl("POST", "/session/ses_a/abort")).toBe("abort")
      expect(classifyDrainControl("DELETE", "/session/ses_a/queue/msg_b")).toBe("cancelQueued")
      expect(classifyDrainControl("POST", "/permission/per_1/reply")).toBe("permissionReply")
      // LOCK-007: the legacy session-scoped permission reply is drain-control
      // equivalent to the canonical /permission/:requestID/reply.
      expect(classifyDrainControl("POST", "/session/ses_a/permissions/per_1")).toBe("permissionReply")
      expect(classifyDrainControl("POST", "/question/que_1/reply")).toBe("questionReply")
      expect(classifyDrainControl("POST", "/question/que_1/reject")).toBe("questionReject")
      expect(classifyDrainControl("POST", "/suggestion/sug_1/accept")).toBe("suggestionAccept")
      expect(classifyDrainControl("POST", "/suggestion/sug_1/dismiss")).toBe("suggestionDismiss")
      expect(classifyDrainControl("POST", "/kilocode/notebook/nbr_abc123/reply")).toBe("notebookReply")
      expect(classifyDrainControl("POST", "/kilocode/notebook/nbr_abc123/reject")).toBe("notebookReject")
    }))

  it.effect("rejects near-match and traversal shapes", () =>
    Effect.gen(function* () {
      // near matches
      expect(classifyDrainControl("GET", "/session/ses_a/abort")).toBeUndefined()
      expect(classifyDrainControl("POST", "/session/ses_a/abort/extra")).toBeUndefined()
      expect(classifyDrainControl("POST", "/session/ses_a/aborted")).toBeUndefined()
      expect(classifyDrainControl("POST", "/sessions/ses_a/abort")).toBeUndefined()
      expect(classifyDrainControl("POST", "/permission/per_1/replies")).toBeUndefined()
      expect(classifyDrainControl("POST", "/question/que_1/reject/extra")).toBeUndefined()
      expect(classifyDrainControl("POST", "/suggestion/sug_1/accept/extra")).toBeUndefined()
      expect(classifyDrainControl("POST", "/suggestion/sug_1/dismiss/extra")).toBeUndefined()
      expect(classifyDrainControl("POST", "/suggestion/sug_1/approve")).toBeUndefined()
      expect(classifyDrainControl("PATCH", "/config")).toBeUndefined()
      expect(classifyDrainControl("POST", "/session/ses_a/message")).toBeUndefined()
      // notebook near-matches: wrong methods, extra/trailing segments, list route
      expect(classifyDrainControl("GET", "/kilocode/notebook/nbr_abc123/reply")).toBeUndefined()
      expect(classifyDrainControl("DELETE", "/kilocode/notebook/nbr_abc123/reject")).toBeUndefined()
      expect(classifyDrainControl("POST", "/kilocode/notebook/nbr_abc123/reply/extra")).toBeUndefined()
      expect(classifyDrainControl("POST", "/kilocode/notebook/nbr_abc123/reject/extra")).toBeUndefined()
      expect(classifyDrainControl("POST", "/kilocode/notebook/nbr_abc123/reply/")).toBeUndefined()
      expect(classifyDrainControl("POST", "/kilocode/notebook/nbr_abc123/replies")).toBeUndefined()
      expect(classifyDrainControl("GET", "/kilocode/notebook")).toBeUndefined()
      expect(classifyDrainControl("POST", "/kilocode/notebook")).toBeUndefined()
      expect(classifyDrainControl("POST", "/kilocode/notebooks/nbr_abc123/reply")).toBeUndefined()
      expect(classifyDrainControl("POST", "/notebook/nbr_abc123/reply")).toBeUndefined()
      // legacy permission reply near-matches (LOCK-007)
      expect(classifyDrainControl("GET", "/session/ses_a/permissions/per_1")).toBeUndefined()
      expect(classifyDrainControl("DELETE", "/session/ses_a/permissions/per_1")).toBeUndefined()
      expect(classifyDrainControl("POST", "/session/ses_a/permissions/per_1/extra")).toBeUndefined()
      expect(classifyDrainControl("POST", "/session/ses_a/permission/per_1")).toBeUndefined()
      expect(classifyDrainControl("POST", "/sessions/ses_a/permissions/per_1")).toBeUndefined()
      expect(classifyDrainControl("POST", "/session/ses_a/permissions/")).toBeUndefined()
      expect(classifyDrainControl("POST", "/session/ses_a/permissions")).toBeUndefined()
      // traversal / dot shapes
      expect(classifyDrainControl("POST", "/session/../abort")).toBeUndefined()
      expect(classifyDrainControl("POST", "/session/./abort")).toBeUndefined()
      expect(classifyDrainControl("DELETE", "/session/../queue/..")).toBeUndefined()
      // trailing slash does not extend the shape
      expect(classifyDrainControl("POST", "/session/ses_a/abort/")).toBeUndefined()
      expect(classifyDrainControl("POST", "/permission/per_1/reply/")).toBeUndefined()
      expect(classifyDrainControl("POST", "/session/ses_a/permissions/per_1/")).toBeUndefined()
      expect(classifyDrainControl("POST", "/suggestion/sug_1/accept/")).toBeUndefined()
      expect(classifyDrainControl("POST", "/suggestion/sug_1/dismiss/")).toBeUndefined()
      expect(classifyDrainControl("POST", "/kilocode/notebook/nbr_abc123/reject/")).toBeUndefined()
      // notebook traversal / dot shapes
      expect(classifyDrainControl("POST", "/kilocode/notebook/../reply")).toBeUndefined()
      expect(classifyDrainControl("POST", "/kilocode/notebook/./reject")).toBeUndefined()
    }))

  it.effect("rejects malformed leading, empty, and extra segments fail-closed", () =>
    Effect.gen(function* () {
      // duplicate leading slash / empty path
      expect(classifyDrainControl("POST", "//session/ses_a/abort")).toBeUndefined()
      expect(classifyDrainControl("POST", "///session/ses_a/abort")).toBeUndefined()
      expect(classifyDrainControl("POST", "/")).toBeUndefined()
      expect(classifyDrainControl("POST", "")).toBeUndefined()
      // empty middle segment
      expect(classifyDrainControl("POST", "/session//abort")).toBeUndefined()
      expect(classifyDrainControl("DELETE", "/session/ses_a//msg_b")).toBeUndefined()
      // leading space or double separator
      expect(classifyDrainControl("POST", "/session/ses_a/abort//")).toBeUndefined()
    }))

  it.effect("rejects encoded separators and encoded traversal shapes", () =>
    Effect.gen(function* () {
      // encoded slash / backslash inside a variable segment
      expect(classifyDrainControl("POST", "/session/ses%2Fa/abort")).toBeUndefined()
      expect(classifyDrainControl("POST", "/session/ses%5Ca/abort")).toBeUndefined()
      expect(classifyDrainControl("DELETE", "/session/ses_a/queue/msg%2Fb")).toBeUndefined()
      // encoded dot segments
      expect(classifyDrainControl("POST", "/session/%2E/abort")).toBeUndefined()
      expect(classifyDrainControl("POST", "/session/%2E%2E/abort")).toBeUndefined()
      expect(classifyDrainControl("POST", "/session/%2e%2e/abort")).toBeUndefined()
      // malformed percent-encoding fails closed
      expect(classifyDrainControl("POST", "/session/%zz/abort")).toBeUndefined()
      expect(classifyDrainControl("POST", "/session/ses_a%2/abort")).toBeUndefined()
      // encoded separators inside the notebook request ID fail closed
      expect(classifyDrainControl("POST", "/kilocode/notebook/nbr_%2Fabc/reply")).toBeUndefined()
      expect(classifyDrainControl("POST", "/kilocode/notebook/nbr_%5Cabc/reject")).toBeUndefined()
      expect(classifyDrainControl("POST", "/kilocode/notebook/%2E/reject")).toBeUndefined()
    }))

  it.effect("rejects variable segments that fail the route ID schemas", () =>
    Effect.gen(function* () {
      expect(classifyDrainControl("POST", "/session/not-a-session/abort")).toBeUndefined()
      expect(classifyDrainControl("DELETE", "/session/ses_a/queue/not-a-message")).toBeUndefined()
      expect(classifyDrainControl("DELETE", "/session/ses_a/queue/prt_b")).toBeUndefined() // PartID, not MessageID
      expect(classifyDrainControl("POST", "/permission/not-a-permission/reply")).toBeUndefined()
      expect(classifyDrainControl("POST", "/question/not-a-question/reply")).toBeUndefined()
      expect(classifyDrainControl("POST", "/question/not-a-question/reject")).toBeUndefined()
      expect(classifyDrainControl("POST", "/suggestion/not-a-suggestion/accept")).toBeUndefined()
      expect(classifyDrainControl("POST", "/suggestion/not-a-suggestion/dismiss")).toBeUndefined()
      expect(classifyDrainControl("POST", "/kilocode/notebook/not-a-notebook/reply")).toBeUndefined()
      expect(classifyDrainControl("POST", "/kilocode/notebook/not-a-notebook/reject")).toBeUndefined()
      expect(classifyDrainControl("POST", "/kilocode/notebook/que_1/reply")).toBeUndefined()
      expect(classifyDrainControl("POST", "/kilocode/notebook/nbr_/reject")).toBeUndefined()
      // legacy permission reply validates BOTH variable segments (LOCK-007)
      expect(classifyDrainControl("POST", "/session/not-a-session/permissions/per_1")).toBeUndefined()
      expect(classifyDrainControl("POST", "/session/ses_a/permissions/not-a-permission")).toBeUndefined()
    }))

  it.effect("accepts harmlessly-encoded valid ID segments", () =>
    Effect.gen(function* () {
      // %5F is an underscore; the decoded value still passes the ID schema.
      expect(classifyDrainControl("POST", "/session/ses%5F1/abort")).toBe("abort")
      expect(classifyDrainControl("DELETE", "/session/ses%5F1/queue/msg%5F2")).toBe("cancelQueued")
      expect(classifyDrainControl("POST", "/permission/per%5F1/reply")).toBe("permissionReply")
      expect(classifyDrainControl("POST", "/session/ses%5F1/permissions/per%5F1")).toBe("permissionReply")
      expect(classifyDrainControl("POST", "/question/que%5F1/reject")).toBe("questionReject")
      expect(classifyDrainControl("POST", "/suggestion/sug%5F1/accept")).toBe("suggestionAccept")
      expect(classifyDrainControl("POST", "/suggestion/sug%5F1/dismiss")).toBe("suggestionDismiss")
      expect(classifyDrainControl("POST", "/kilocode/notebook/nbr%5Fabc/reply")).toBe("notebookReply")
      expect(classifyDrainControl("POST", "/kilocode/notebook/nbr%5Fabc/reject")).toBe("notebookReject")
    }))
})

// ─── drain-control bypass through the real routes ────────────────────

describe("drain-control bypass - web handler path", () => {
  it.live(
    "session abort completes during an active cold save drain and the save converges once",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)
        const disposals = yield* eventCapture<{ directory: string }>("server.instance.disposed", f.project)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber, done } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // A cold project PATCH starts a convergence pass whose drain waits on
        // the held stream. The second session is created BEFORE the fence:
        // session creation is a normal data-plane request that is fence-blocked,
        // so awaiting it inline after the PATCH would deadlock the test before
        // the abort is ever issued.
        const sessionB = yield* Effect.promise(() => createSession(f.project))
        const patch = yield* patchOverlay(f.project, "project", { autoupdate: false })
        expect(patch.status).toBe(200)
        expect(yield* isDone(done)).toBe(false)
        expect(yield* instanceDisposed.done).toBe(false)

        // A normal new prompt issued while the save drains stays blocked: the
        // message POST waits at reader admission, never reaching the handler.
        const second = yield* forkPrompt(f.project, sessionB.id, "second", "second")
        yield* Effect.yieldNow
        expect(yield* isDone(second.done)).toBe(false)

        // Abort must complete while the convergence fence is active (bypass),
        // even though the held stream would otherwise starve reader admission.
        const abort = yield* Effect.promise(async () => {
          const response = await request(f.project, `/session/${session.id}/abort`, { method: "POST" })
          return response.status
        })
        expect(abort).toBe(200)

        // The abort cancelled the generation: the stream ends and the drain
        // completes, so the exact old instance is disposed exactly once.
        yield* awaitWithTimeout(Deferred.await(done), "aborted stream did not complete")
        yield* Fiber.join(fiber)
        yield* awaitWithTimeout(instanceDisposed.await, "instance disposal did not arrive after abort")
        expect(yield* instanceDisposed.done).toBe(true)

        // The queued normal prompt is admitted only after the fence releases.
        expect(yield* isDone(second.done)).toBe(false)
        yield* Deferred.succeed(second.gate, void 0)
        const exit = yield* second.result()
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) expect(exit.value.status).toBe(200)

        // Exactly one rebuild: the cold PATCH's single drain/dispose/reboot, no
        // extra disposal from the abort control or the second prompt.
        yield* awaitRebuilds()
        expect(disposals.received.length).toBe(1)
      }),
    30_000,
  )

  it.live(
    "queued-message cancel completes during an active cold save drain",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // Enqueue a second same-session prompt BEFORE the fence: its intake
        // admission passes (no fence yet), the message is persisted, and the
        // slot waits in the queue behind the running generation. Deterministic
        // wait on the queue registry: without it the forked POST races the
        // PATCH below — a losing POST blocks at reader admission and never
        // enqueues, so cancelOne would find nothing to cancel.
        const queued = yield* forkPrompt(f.project, session.id, "queued", "queued")
        const queuedMsg = yield* pollWithTimeout(
          Effect.gen(function* () {
            const messages = yield* withInstance(f.project)(
              Session.Service.use((svc) => svc.messages({ sessionID: SessionID.make(session.id) })),
            )
            const lastUser = messages.findLast((m) => m.info.role === "user")
            if (!lastUser) return undefined
            const id = MessageID.make(lastUser.info.id)
            return KiloSessionPromptQueue._isQueued(SessionID.make(session.id), id) ? lastUser : undefined
          }),
          "queued message never enqueued",
        )
        const messageID = MessageID.make(queuedMsg.info.id)
        expect(yield* isDone(queued.done)).toBe(false)

        // Cold PATCH: the save drains on the running stream; the queued slot is
        // still pending.
        const patch = yield* patchOverlay(f.project, "project", { autoupdate: false })
        expect(patch.status).toBe(200)
        expect(yield* isDone(queued.done)).toBe(false)

        // cancelQueued must complete during the fence and flag the slot.
        const cancelled = yield* Effect.promise(async () => {
          const response = await request(f.project, `/session/${session.id}/queue/${messageID}`, {
            method: "DELETE",
          })
          return { status: response.status, body: (await response.json()) as boolean }
        })
        expect(cancelled.status).toBe(200)
        expect(cancelled.body).toBe(true)

        // Release the running generation: the save converges once and the
        // cancelled slot runs its cancelled effect (no new LLM call).
        yield* Deferred.succeed(gate, void 0)
        const first = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(first)).toBe(true)
        yield* awaitWithTimeout(instanceDisposed.await, "instance disposal did not arrive after release")
        const queuedExit = yield* queued.result()
        expect(Exit.isSuccess(queuedExit)).toBe(true)
        if (Exit.isSuccess(queuedExit)) expect(queuedExit.value.status).toBe(200)
      }),
    30_000,
  )

  it.live(
    "permission reply completes during an active cold save drain",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // A real pending permission request on the pre-fence instance.
        const asked = yield* eventCapture<{ id: string }>("permission.asked", f.project)
        const askFiber = yield* Effect.forkDetach(
          withInstance(f.project)(
            Permission.Service.use((svc) =>
              svc.ask({
                sessionID: SessionID.make(session.id),
                permission: "bash",
                patterns: ["npm test"],
                metadata: { command: "npm test" },
                always: ["npm *"],
                ruleset: [],
              }),
            ),
          ),
        )
        yield* pollWithTimeout(
          Effect.sync(() => (asked.received.length > 0 ? (true as const) : undefined)),
          "permission.asked never arrived",
        )
        const requestID = asked.received[0]!.id

        // Cold PATCH: the save drains on the held stream.
        const patch = yield* patchOverlay(f.project, "project", { autoupdate: false })
        expect(patch.status).toBe(200)
        expect(yield* instanceDisposed.done).toBe(false)

        // Permission reply must complete during the fence.
        const reply = yield* Effect.promise(async () => {
          const response = await request(f.project, `/permission/${requestID}/reply`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reply: "once" }),
          })
          return response.status
        })
        expect(reply).toBe(200)

        // The pending ask resolved with the reply.
        yield* awaitWithTimeout(Fiber.join(askFiber), "permission ask never resolved")

        // Release the stream: the save converges once.
        yield* Deferred.succeed(gate, void 0)
        yield* Fiber.await(fiber)
        yield* awaitWithTimeout(instanceDisposed.await, "instance disposal did not arrive after release")
      }),
    30_000,
  )

  it.live(
    "legacy session permission reply completes during an active cold save drain (LOCK-007)",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // A real pending permission request on the pre-fence instance.
        const asked = yield* eventCapture<{ id: string }>("permission.asked", f.project)
        const askFiber = yield* Effect.forkDetach(
          withInstance(f.project)(
            Permission.Service.use((svc) =>
              svc.ask({
                sessionID: SessionID.make(session.id),
                permission: "bash",
                patterns: ["npm test"],
                metadata: { command: "npm test" },
                always: [],
                ruleset: [],
              }),
            ),
          ),
        )
        yield* pollWithTimeout(
          Effect.sync(() => (asked.received.length > 0 ? (true as const) : undefined)),
          "permission.asked never arrived",
        )
        const requestID = asked.received[0]!.id

        // Cold PATCH: the save drains on the held stream.
        const patch = yield* patchOverlay(f.project, "project", { autoupdate: false })
        expect(patch.status).toBe(200)
        expect(yield* instanceDisposed.done).toBe(false)

        // The legacy session-scoped reply must complete during the fence drain:
        // it is drain-control equivalent to the canonical permission reply and
        // unblocks the same generation the drain is holding.
        const reply = yield* Effect.promise(async () => {
          const response = await request(f.project, `/session/${session.id}/permissions/${requestID}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ response: "once" }),
          })
          return response.status
        })
        expect(reply).toBe(200)

        // The pending ask resolved with the reply.
        yield* awaitWithTimeout(Fiber.join(askFiber), "permission ask never resolved")

        // Release the stream: the save converges once.
        yield* Deferred.succeed(gate, void 0)
        yield* Fiber.await(fiber)
        yield* awaitWithTimeout(instanceDisposed.await, "instance disposal did not arrive after release")
      }),
    30_000,
  )

  it.live(
    "permission always reply persists during the drain without triggering an extra rebuild",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)
        const disposals = yield* eventCapture<{ directory: string }>("server.instance.disposed", f.project)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // A pending permission with an always rule on the pre-fence instance.
        const asked = yield* eventCapture<{ id: string }>("permission.asked", f.project)
        const askFiber = yield* Effect.forkDetach(
          withInstance(f.project)(
            Permission.Service.use((svc) =>
              svc.ask({
                sessionID: SessionID.make(session.id),
                permission: "bash",
                patterns: ["npm test"],
                metadata: { command: "npm test" },
                always: ["npm *"],
                ruleset: [],
              }),
            ),
          ),
        )
        yield* pollWithTimeout(
          Effect.sync(() => (asked.received.length > 0 ? (true as const) : undefined)),
          "permission.asked never arrived",
        )
        const requestID = asked.received[0]!.id

        // Cold PATCH: the save drains on the held stream.
        const patch = yield* patchOverlay(f.project, "project", { autoupdate: false })
        expect(patch.status).toBe(200)
        expect(yield* instanceDisposed.done).toBe(false)

        // Reply "always" through the control lane during the fence drain: the
        // rule is persisted via updateGlobal(dispose:false) — no fence, no
        // extra rebuild.
        const reply = yield* Effect.promise(async () => {
          const response = await request(f.project, `/permission/${requestID}/reply`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reply: "always" }),
          })
          return response.status
        })
        expect(reply).toBe(200)
        yield* awaitWithTimeout(Fiber.join(askFiber), "permission always ask never resolved")

        // Release the stream: the save converges exactly once (the cold PATCH
        // only). The always rule was persisted to the global config by the
        // reply before the old instance was disposed, so the replacement boots
        // with it.
        yield* Deferred.succeed(gate, void 0)
        yield* Fiber.await(fiber)
        yield* awaitWithTimeout(instanceDisposed.await, "instance disposal did not arrive after release")
        yield* awaitRebuilds()
        expect(disposals.received.length).toBe(1)
        const raw = yield* Effect.promise(() => Bun.file(path.join(f.global, "kilo.jsonc")).text())
        const global = JSON.parse(raw) as { permission?: { bash?: Record<string, string> } }
        expect(global.permission?.bash?.["npm *"]).toBe("allow")
      }),
    30_000,
  )

  it.live(
    "question reply and reject complete during an active cold save drain",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        const asked = yield* eventCapture<{ id: string }>("question.asked", f.project)
        const question = {
          question: "Proceed?",
          header: "Confirm",
          options: [
            { label: "yes", description: "continue" },
            { label: "no", description: "stop" },
          ],
        }
        const replyFiber = yield* Effect.forkDetach(
          withInstance(f.project)(
            Question.Service.use((svc) =>
              svc.ask({ sessionID: SessionID.make(session.id), questions: [question], blocking: false }),
            ),
          ),
        )
        const rejectFiber = yield* Effect.forkDetach(
          withInstance(f.project)(
            Question.Service.use((svc) =>
              svc.ask({ sessionID: SessionID.make(session.id), questions: [question], blocking: false }),
            ),
          ),
        )
        yield* pollWithTimeout(
          Effect.sync(() => (asked.received.length >= 2 ? (true as const) : undefined)),
          "two question.asked events never arrived",
        )
        const [replyID, rejectID] = [asked.received[0]!.id, asked.received[1]!.id]

        // Cold PATCH: the save drains on the held stream.
        const patch = yield* patchOverlay(f.project, "project", { autoupdate: false })
        expect(patch.status).toBe(200)
        expect(yield* instanceDisposed.done).toBe(false)

        // Question reply + reject must complete during the fence drain.
        const replied = yield* Effect.promise(async () => {
          const response = await request(f.project, `/question/${replyID}/reply`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ answers: [["yes"]] }),
          })
          return response.status
        })
        expect(replied).toBe(200)
        const rejected = yield* Effect.promise(async () => {
          const response = await request(f.project, `/question/${rejectID}/reject`, { method: "POST" })
          return response.status
        })
        expect(rejected).toBe(200)

        // The replied ask succeeded; the rejected ask failed with RejectedError
        // by design — assert both exits instead of joining the reject fiber as a
        // success (its failure would abort the test while the held stream is
        // still open and hang scope teardown).
        const replyExit = yield* Fiber.join(replyFiber).pipe(Effect.exit)
        expect(Exit.isSuccess(replyExit)).toBe(true)
        const rejectExit = yield* Fiber.join(rejectFiber).pipe(Effect.exit)
        expect(Exit.isFailure(rejectExit)).toBe(true)
        expect(Exit.isSuccess(rejectExit)).toBe(false)

        yield* Deferred.succeed(gate, void 0)
        yield* Fiber.await(fiber)
        yield* awaitWithTimeout(instanceDisposed.await, "instance disposal did not arrive after release")
      }),
    30_000,
  )

  it.live(
    "suggestion accept and dismiss complete during an active cold save drain",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        // Always release the held stream on scope close so a body failure
        // cannot wedge the convergence rebuild behind the fence (which would
        // surface as an afterEach hook timeout instead of the real error).
        // Double-succeed is harmless (ignored).
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, void 0).pipe(Effect.ignore))
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // Two real pending suggestions on the pre-fence instance: one to
        // accept, one to dismiss. Forked as detached waiters so the test can
        // prove each settles while the fence is still held.
        const actions = [
          { label: "yes", description: "continue", prompt: "proceed" },
          { label: "no", description: "stop", prompt: "halt" },
        ]
        const acceptedEvts = yield* eventCapture<{ requestID: string }>("suggestion.accepted", f.project)
        const dismissedEvts = yield* eventCapture<{ requestID: string }>("suggestion.dismissed", f.project)
        const show = (text: string) =>
          withInstance(f.project)(
            Effect.promise(() => Suggestion.show({ sessionID: session.id, text, actions })) as unknown as Effect.Effect<
              { label: string; description?: string; prompt: string },
              unknown,
              never
            >,
          )
        const acceptFiber = yield* Effect.forkDetach(show("Proceed?"))
        const dismissFiber = yield* Effect.forkDetach(show("Discard?"))
        const [acceptID, dismissID] = yield* pollWithTimeout(
          Effect.gen(function* () {
            const list = yield* Effect.promise(() => Suggestion.list())
            const scoped = list.filter((entry) => String(entry.sessionID) === session.id)
            if (scoped.length >= 2) return [String(scoped[0]!.id), String(scoped[1]!.id)] as const
            return undefined
          }),
          "two suggestions never became pending",
        )

        // Cold PATCH: the save drains on the held stream.
        const patch = yield* patchOverlay(f.project, "project", { autoupdate: false })
        expect(patch.status).toBe(200)
        expect(yield* instanceDisposed.done).toBe(false)

        // Both suggestion controls must complete during the fence drain.
        const accepted = yield* Effect.promise(async () => {
          const response = await request(f.project, `/suggestion/${acceptID}/accept`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ index: 0 }),
          })
          return response.status
        })
        expect(accepted).toBe(200)
        const dismissed = yield* Effect.promise(async () => {
          const response = await request(f.project, `/suggestion/${dismissID}/dismiss`, { method: "POST" })
          return response.status
        })
        expect(dismissed).toBe(200)

        // Both settled BEFORE the fence releases: accept resolves with the
        // chosen action, dismiss rejects with DismissedError by design, and
        // each emitted its bus event on the pre-fence instance.
        const acceptExit = yield* Fiber.join(acceptFiber).pipe(Effect.exit)
        expect(Exit.isSuccess(acceptExit)).toBe(true)
        if (Exit.isSuccess(acceptExit))
          expect(acceptExit.value).toEqual({ label: "yes", description: "continue", prompt: "proceed" })
        const dismissExit = yield* Fiber.join(dismissFiber).pipe(Effect.exit)
        expect(Exit.isFailure(dismissExit)).toBe(true)
        expect(acceptedEvts.received.length).toBe(1)
        expect(acceptedEvts.received[0]!.requestID).toBe(acceptID)
        expect(dismissedEvts.received.length).toBe(1)
        expect(dismissedEvts.received[0]!.requestID).toBe(dismissID)

        // The fence still drains normally on the held stream.
        yield* Deferred.succeed(gate, void 0)
        yield* Fiber.await(fiber)
        yield* awaitWithTimeout(instanceDisposed.await, "instance disposal did not arrive after release")
      }),
    30_000,
  )

  it.live(
    "suggestion drain-control with no instance during a convergence fence refuses deterministically",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // A second directory with a persisted session but NO live instance.
        // Same scope-close release as the accept/dismiss test above: a body
        // failure must not leave the held stream (and the global fence behind
        // it) dangling into afterEach.
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, void 0).pipe(Effect.ignore))
        const disposed = yield* Effect.promise(() => createSession(f.other))
        expect(disposed.id).toBeTruthy()
        yield* Effect.promise(async () => {
          const response = await request(f.other, "/instance/dispose", { method: "POST" })
          expect(response.status).toBe(200)
        })

        // Global cold PATCH: the fence covers every directory.
        const patch = yield* patchOverlay(undefined, "global", { autoupdate: "notify" })
        expect(patch.status).toBe(200)

        // Suggestion controls for the no-instance directory: no snapshot, no
        // boot, no synthetic context — a deterministic 409 instead of hanging
        // or dying, for both accept and dismiss.
        const accept = yield* Effect.promise(async () => {
          const response = await request(f.other, "/suggestion/sug_noinstance0001/accept", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ index: 0 }),
          })
          return { status: response.status, body: (await response.json()) as { _tag?: string } }
        })
        expect(accept.status).toBe(409)
        expect(accept.body._tag).toBe("InstanceUnavailableDuringConfigRebuild")
        const dismiss = yield* Effect.promise(async () => {
          const response = await request(f.other, "/suggestion/sug_noinstance0002/dismiss", { method: "POST" })
          return { status: response.status, body: (await response.json()) as { _tag?: string } }
        })
        expect(dismiss.status).toBe(409)
        expect(dismiss.body._tag).toBe("InstanceUnavailableDuringConfigRebuild")

        // The fence still drains normally on the held stream.
        yield* Deferred.succeed(gate, void 0)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    30_000,
  )

  it.live(
    "drain-control for a directory with no instance during a convergence fence refuses deterministically",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // A second directory with a persisted session but NO live instance.
        const disposed = yield* Effect.promise(() => createSession(f.other))
        yield* Effect.promise(async () => {
          const response = await request(f.other, "/instance/dispose", { method: "POST" })
          expect(response.status).toBe(200)
        })

        // Global cold PATCH: the fence covers every directory.
        const patch = yield* patchOverlay(undefined, "global", { autoupdate: "notify" })
        expect(patch.status).toBe(200)

        // abort for the no-instance directory: no gate, no boot, no synthetic
        // context — a deterministic 409 instead of hanging or dying.
        const abort = yield* Effect.promise(async () => {
          const response = await request(f.other, `/session/${disposed.id}/abort`, { method: "POST" })
          return { status: response.status, body: (await response.json()) as { _tag?: string } }
        })
        expect(abort.status).toBe(409)
        expect(abort.body._tag).toBe("InstanceUnavailableDuringConfigRebuild")

        // The fence still drains normally on the held stream.
        yield* Deferred.succeed(gate, void 0)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    30_000,
  )

  it.live(
    "legacy global config PATCH defers disposal and abort completes during its drain",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)
        const disposals = yield* eventCapture<{ directory: string }>("server.instance.disposed", f.project)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // Legacy (non-overlay) cold global PATCH: same convergence fence + pass
        // machinery as the overlay global path, so it must honor the same
        // drain-control lane and seal/drain before disposal.
        const patch = yield* Effect.promise(async () => {
          const response = await request(undefined, "/global/config", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ autoupdate: false }),
          })
          return response.status
        })
        expect(patch).toBe(200)
        expect(yield* instanceDisposed.done).toBe(false)

        // Abort completes during the legacy save's drain (control lane).
        const abort = yield* Effect.promise(async () => {
          const response = await request(f.project, `/session/${session.id}/abort`, { method: "POST" })
          return response.status
        })
        expect(abort).toBe(200)

        // The abort ends the stream; the legacy save converges exactly once.
        yield* awaitWithTimeout(instanceDisposed.await, "instance disposal did not arrive after abort")
        yield* Fiber.await(fiber)
        yield* awaitRebuilds()
        expect(disposals.received.length).toBe(1)
      }),
    30_000,
  )

  it.live(
    "notebook reply and reject complete during an active cold save drain",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, void 0).pipe(Effect.ignore))
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)
        const disposals = yield* eventCapture<{ directory: string }>("server.instance.disposed", f.project)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { fiber, done } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // Two real pending notebook requests on the pre-fence instance.
        const sid = SessionID.make(session.id)
        const ask = withInstance(f.project)(
          Notebook.Service.use((svc) =>
            svc.request({ sessionID: sid, path: "b.ipynb", operation: "read", includeOutputs: false }),
          ),
        )
        const replyFiber = yield* Effect.forkDetach(ask)
        const rejectFiber = yield* Effect.forkDetach(ask)
        const pending = yield* pollWithTimeout(
          Effect.gen(function* () {
            const list = yield* withInstance(f.project)(
              Notebook.Service.use((svc) => svc.list()),
            )
            if (list.length >= 2) return list
            return undefined
          }),
          "two notebook requests never became pending",
        )
        const replyID = String(pending[0]!.id)
        const rejectID = String(pending[1]!.id)

        // Cold PATCH: the save drains on the held stream.
        const patch = yield* patchOverlay(f.project, "project", { autoupdate: false })
        expect(patch.status).toBe(200)
        expect(yield* isDone(done)).toBe(false)
        expect(yield* instanceDisposed.done).toBe(false)

        // Both notebook controls must complete during the fence drain through
        // the exact HTTP shapes: POST /kilocode/notebook/:requestID/reply|reject.
        const replied = yield* Effect.promise(async () => {
          const response = await request(f.project, `/kilocode/notebook/${replyID}/reply`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              result: { operation: "read", path: "b.ipynb", requestPath: "b.ipynb", revision: "r1", cells: [] },
            }),
          })
          return response.status
        })
        expect(replied).toBe(200)
        const rejected = yield* Effect.promise(async () => {
          const response = await request(f.project, `/kilocode/notebook/${rejectID}/reject`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: { code: "timeout", message: "timed out" } }),
          })
          return response.status
        })
        expect(rejected).toBe(200)

        // Both settled BEFORE the fence releases: reply resolves, reject fails
        // with the host error by design.
        const replyExit = yield* Fiber.join(replyFiber).pipe(Effect.exit)
        expect(Exit.isSuccess(replyExit)).toBe(true)
        const rejectExit = yield* Fiber.join(rejectFiber).pipe(Effect.exit)
        expect(Exit.isFailure(rejectExit)).toBe(true)

        // The fence still drains normally on the held stream and the save
        // converges exactly once.
        yield* Deferred.succeed(gate, void 0)
        yield* Fiber.await(fiber)
        yield* awaitWithTimeout(instanceDisposed.await, "instance disposal did not arrive after release")
        expect(yield* instanceDisposed.done).toBe(true)
        yield* awaitRebuilds()
        expect(disposals.received.length).toBe(1)
      }),
    30_000,
  )
})

// ─── drain-control bypass through a real listener (Server.listen) ─────

describe("drain-control bypass - Server.listen path", () => {
  it.live(
    "session abort completes through a real listener during an active global save drain",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1" })),
          (value) => Effect.promise(() => value.stop(true)).pipe(Effect.ignore),
        )
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)
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

        // The listener shares the canonical SessionStatus/gate with the canonical
        // runtime (standalone topology); status is polled through the listener HTTP
        // surface as production-path evidence.
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
        const session = (yield* Effect.promise(() => create.json())) as SessionV1.Info

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
            yield* Deferred.succeed(done, void 0)
            return response.status
          }),
        )
        yield* f.llm.wait(1)
        yield* waitForListenerBusy(session.id)

        // A cold global PATCH through the listener: the convergence fence covers
        // every directory and drains on the held stream.
        const patch = yield* send("", "/config/overlay", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "global", set: { autoupdate: "notify" } }),
        })
        expect(patch.status).toBe(200)
        expect(yield* isDone(done)).toBe(false)
        expect(yield* instanceDisposed.done).toBe(false)

        // Abort through the listener must complete during the fence: the
        // drain-control lane serves it from the pre-fence snapshot.
        const abort = yield* send(f.project, `/session/${session.id}/abort`, { method: "POST" })
        expect(abort.status).toBe(200)

        // The abort cancelled the generation: the stream ends and the save
        // converges once, disposing the exact old instance.
        yield* awaitWithTimeout(Deferred.await(done), "aborted stream did not complete through listener")
        yield* Fiber.join(fiber)
        yield* awaitWithTimeout(instanceDisposed.await, "instance disposal did not arrive after abort")
        expect(yield* instanceDisposed.done).toBe(true)

        // The listener keeps serving the rebuilt runtime.
        expect(listener.url).toBe(url)
        const status = yield* send(f.project, "/session/status")
        expect(status.status).toBe(200)
      }),
    30_000,
  )

  it.live(
    "notebook reply completes through a real listener during an active cold save drain",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        // Notebook tools are vscode-gated (KILO_CLIENT=vscode +
        // experimental.native_notebook_tools). Set the client before the
        // listener boots its first instance and restore it in a finalizer so
        // no other test observes the override.
        const prevClient = process.env["KILO_CLIENT"]
        process.env["KILO_CLIENT"] = "vscode"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (prevClient === undefined) delete process.env["KILO_CLIENT"]
            else process.env["KILO_CLIENT"] = prevClient
          }),
        )
        // Enable native notebook tools in this test's project config before
        // the listener boots its instance for the directory.
        yield* Effect.promise(async () => {
          const file = path.join(f.project, ".kilo", "kilo.jsonc")
          const raw = (await Bun.file(file).json()) as Record<string, unknown>
          await Bun.write(file, JSON.stringify({ ...raw, experimental: { native_notebook_tools: true } }, null, 2))
        })
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1" })),
          (value) => Effect.promise(() => value.stop(true)).pipe(Effect.ignore),
        )
        const gate = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, void 0).pipe(Effect.ignore))
        const instanceDisposed = yield* eventLatch("server.instance.disposed", f.project)
        const disposals = yield* eventCapture<{ directory: string }>("server.instance.disposed", f.project)
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

        // The listener shares the canonical SessionStatus/gate with the canonical
        // runtime (standalone topology); status is polled through the listener HTTP
        // surface as production-path evidence.
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

        const allowAll = [{ permission: "*", pattern: "*", action: "allow" }]
        const createHeld = yield* send(f.project, "/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "held stream", permission: allowAll }),
        })
        expect(createHeld.status).toBe(200)
        const held = (yield* Effect.promise(() => createHeld.json())) as SessionV1.Info
        const createNb = yield* send(f.project, "/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "notebook tool", permission: allowAll }),
        })
        expect(createNb.status).toBe(200)
        const notebook = (yield* Effect.promise(() => createNb.json())) as SessionV1.Info

        // Held stream first: it consumes the hold entry so the later tool/text
        // entries belong to the notebook generation in FIFO order.
        yield* f.llm.hold("streamed", deferredAsPromise(gate))
        const heldDone = yield* Deferred.make<void>()
        const heldFiber = yield* Effect.forkDetach(
          Effect.gen(function* () {
            const response = yield* send(f.project, `/session/${held.id}/message`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                agent: "build",
                model: { providerID: "test", modelID: "test-model" },
                parts: [{ type: "text", text: "hello" }],
              }),
            })
            yield* Deferred.succeed(heldDone, void 0)
            return response.status
          }),
        )
        yield* f.llm.wait(1)
        yield* waitForListenerBusy(held.id)

        // The notebook generation runs the listener's real generation/tool
        // path: the model requests exactly one notebook_read, whose
        // Notebook.Service.request stays pending in the listener runtime.
        yield* f.llm.tool("notebook_read", { path: "b.ipynb" })
        yield* f.llm.text("notebook done")
        const nbDone = yield* Deferred.make<void>()
        const nbFiber = yield* Effect.forkDetach(
          Effect.gen(function* () {
            const response = yield* send(f.project, `/session/${notebook.id}/message`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                agent: "build",
                model: { providerID: "test", modelID: "test-model" },
                parts: [{ type: "text", text: "read the notebook" }],
              }),
            })
            yield* Deferred.succeed(nbDone, void 0)
            return response.status
          }),
        )
        // The model emits the notebook_read call, which first pends as a
        // notebook_read permission ask in the listener runtime. Allow it
        // pre-fence through the exact permission shape so the tool proceeds
        // to its Notebook.Service.request.
        yield* awaitWithTimeout(f.llm.wait(2), "notebook tool call never reached the LLM", "30 seconds")
        const ask = yield* pollWithTimeout(
          Effect.gen(function* () {
            const response = yield* send(f.project, "/permission")
            if (response.status !== 200) return undefined
            const list = (yield* Effect.promise(
              () => response.json() as Promise<Array<{ id: string; sessionID: string; permission: string }>>,
            )) as Array<{ id: string; sessionID: string; permission: string }>
            const match = list.find(
              (entry) => entry.sessionID === notebook.id && entry.permission === "notebook_read",
            )
            return match ? match : undefined
          }),
          "notebook_read permission never became pending in the listener runtime",
          "30 seconds",
        )
        const allowed = yield* send(f.project, `/permission/${ask.id}/reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reply: "once" }),
        })
        expect(allowed.status).toBe(200)
        // The pending ID must be observed through the listener's own
        // GET /kilocode/notebook before the fence goes up — same-store
        // canonical-runtime probes are not evidence for this runtime.
        const pending = yield* pollWithTimeout(
          Effect.gen(function* () {
            const response = yield* send(f.project, "/kilocode/notebook")
            if (response.status !== 200) return undefined
            const list = (yield* Effect.promise(
              () => response.json() as Promise<Array<{ id: string; sessionID: string }>>,
            )) as Array<{ id: string; sessionID: string }>
            const match = list.find((entry) => entry.sessionID === notebook.id && entry.id.startsWith("nbr_"))
            return match ? match : undefined
          }),
          "notebook request never became pending in the listener runtime",
          "30 seconds",
        )
        const requestID = pending.id
        yield* waitForListenerBusy(notebook.id)

        // A cold global PATCH through the listener: the convergence fence covers
        // every directory and drains on the held stream.
        const patch = yield* send("", "/config/overlay", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "global", set: { autoupdate: "notify" } }),
        })
        expect(patch.status).toBe(200)
        expect(yield* isDone(heldDone)).toBe(false)
        expect(yield* isDone(nbDone)).toBe(false)
        expect(yield* instanceDisposed.done).toBe(false)

        // Reply through the listener must complete during the fence: the
        // drain-control lane serves it from the pre-fence snapshot. Reject
        // shares the same lane (classifier unit tests prove the symmetric
        // exact POST /kilocode/notebook/:requestID/reject route, and the web
        // handler live test proves both settle); one listener reply case is
        // sufficient for the production-path proof.
        const replied = yield* send(f.project, `/kilocode/notebook/${requestID}/reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            result: { operation: "read", path: "b.ipynb", requestPath: "b.ipynb", revision: "r1", cells: [] },
          }),
        })
        expect(replied.status).toBe(200)

        // The waiter settles in the listener runtime, so the admitted
        // generation progresses and finishes while the fence is still up.
        yield* awaitWithTimeout(f.llm.wait(3), "notebook follow-up never reached the LLM", "30 seconds")
        yield* awaitWithTimeout(Deferred.await(nbDone), "notebook generation did not complete after reply", "30 seconds")
        const nbResult = yield* Fiber.join(nbFiber)
        expect(nbResult).toBe(200)

        // Releasing the held stream lets the save converge exactly once,
        // disposing the exact old instance.
        yield* Deferred.succeed(gate, void 0)
        yield* awaitWithTimeout(Deferred.await(heldDone), "held stream did not complete after release")
        yield* Fiber.join(heldFiber)
        yield* awaitWithTimeout(instanceDisposed.await, "instance disposal did not arrive after release")
        expect(yield* instanceDisposed.done).toBe(true)
        yield* awaitRebuilds()
        expect(disposals.received.length).toBe(1)

        // The listener keeps serving the rebuilt runtime.
        expect(listener.url).toBe(url)
        const status = yield* send(f.project, "/session/status")
        expect(status.status).toBe(200)
      }),
    60_000,
  )
})
