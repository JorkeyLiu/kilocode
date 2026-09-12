// kilocode_change - new file
/**
 * LOCK-001/002/005/007 convergence tests for the agent-builder save, agent
 * removal, and private skill removal.
 *
 * The agent-builder save and agent removal routes are durable cold mutations
 * routed through `withColdMutation` with explicit scope (LOCK-005); skill
 * removal is private-only over the `skill/remove` FD op through the same
 * shared cold-convergence mutation (`skill-remove-execute`):
 *
 * - agent-builder save: project scope follows the request payload (project →
 *   its directory, global → all loaded directories).
 * - agent removal: always GLOBAL — a custom agent can live in any config
 *   directory, so every loaded directory converges to the post-removal
 *   registry.
 * - skill removal (private FD): project-local when the resolved SKILL.md
 *   target is inside the instance boundary (robust path ownership evidence),
 *   otherwise conservatively GLOBAL.
 *
 * Covered scenarios:
 * 1. Project agent-builder save while a generation stream is HELD: the save
 *    response returns before the stream is released, no `server.instance.disposed`
 *    fires early (the active generation's runtime is not disposed), and after
 *    release exactly one disposed event + reload serves the new agent.
 * 2. Global agent-builder save while a generation stream is HELD on one loaded
 *    directory and a SIBLING directory is loaded and idle: the response returns
 *    before release, the active generation's runtime is not disposed early, and
 *    after release BOTH loaded directories are disposed/reloaded exactly once
 *    each with one `global.disposed`.
 * 3. Private skill removal of a project-local skill: project scope — only the
 *    request directory converges, `global.disposed` never fires.
 * 4. Agent removal: global scope — every loaded directory (including an idle
 *    sibling) converges and `global.disposed` fires once.
 * 5. Private skill removal of a skill OUTSIDE the instance boundary:
 *    conservatively global — both loaded directories converge.
 *
 * Progression uses Deferred/event latches — never wall-clock sleeps.
 */
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { PassThrough } from "stream"
import { Deferred, Effect, Fiber } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Server } from "../../../src/server/server"
import { Event } from "../../../src/server/event"
import { GlobalBus } from "../../../src/bus/global"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { canonicalSkillRemoveOpId } from "../../../src/kilocode/skill-remove-private"
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

/**
 * Private-only skill removal through the real `skill/remove` FD carrier into
 * the shared cold-convergence mutation. There is no HTTP skill-remove route;
 * scope/convergence assertions must drive this path.
 */
async function privateRemoveSkill(dir: string, location: string, token: string): Promise<{ status: string }> {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  try {
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["skill/remove"],
    })
    const opId = canonicalSkillRemoveOpId(token)
    const raw = (await ext.request("skill/remove", {
      v: 1,
      requestId: `req-${token}`,
      opId,
      op: "skill/remove",
      idempotencyKey: opId,
      context: { directory: dir },
      payload: { location },
    })) as { status: string }
    return raw
  } finally {
    carrier.dispose()
    ext.dispose()
  }
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
  dirs.add(result.project)
  return result
})

/** A second loaded-but-idle project directory (sibling for global scope). */
const sibling = (f: Fixture) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const other = await tmpdir({ git: true, retain: true, config: testProviderConfig(f.llm.url) })
        await markProjectConfigReady(other.path)
        return other
      }),
      (value) => Effect.promise(() => value[Symbol.asyncDispose]().catch(() => undefined)),
    )
    dirs.add(tmp.path)
    // Boot the sibling instance so the global convergence pass captures it.
    yield* Effect.promise(async () => {
      const response = await request(tmp.path, "/config/overlay?scope=project")
      expect(response.status).toBe(200)
    })
    return tmp.path
  })

/** Seed a project-local skill manifest (frontmatter name must match dir name). */
const seedSkill = (dir: string, name: string) =>
  Effect.promise(async () => {
    const root = path.join(dir, ".kilo", "skill", name)
    await Bun.write(
      path.join(root, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} fixture.\n---\n# ${name}\n`,
    )
    await Bun.write(path.join(root, "KEEP.txt"), "synthetic sentinel\n")
  })

/** Seed a project-local custom agent manifest. */
const seedAgent = (dir: string, name: string) =>
  Effect.promise(async () => {
    await Bun.write(path.join(dir, ".kilo", "agent", `${name}.md`), `---\ndescription: ${name} fixture.\n---\nRemove me.\n`)
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

/**
 * Queue a held LLM reply and fork the prompt request. Resolves once the held
 * main call is in flight. `done` succeeds when the prompt HTTP response
 * completes — the bounded in-flight signal used instead of polling status.
 */
const startHeldPrompt = (dir: string, sessionID: string, gate: Deferred.Deferred<void>) =>
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

/** Await a signal Deferred effect with a bounded failure timeout. */
const joinSignal = (effect: Effect.Effect<void>) =>
  awaitWithTimeout(effect, "signal never arrived", "30 seconds")

describe("agent-builder save converges with explicit scope (LOCK-005/007)", () => {
  it.live(
    "project save acknowledges before the held stream releases; exactly one disposed event and reload serves the agent",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const gate = yield* Deferred.make<void>()
        const instanceDisposed = yield* eventCountLatch("server.instance.disposed", f.project, 1)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { done, fiber } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // Project-scope save: the response returns BEFORE the held stream is
        // released and BEFORE any disposal of the active generation's runtime.
        const saved = yield* Effect.promise(async () => {
          const response = await request(f.project, "/agent-builder/held-project", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ scope: "project", prompt: "Held project agent." }),
          })
          return { status: response.status, body: (await response.json()) as { path: string } }
        })
        expect(saved.status).toBe(200)
        expect(saved.body.path).toBe(path.join(f.project, ".kilo", "agent", "held-project.md"))
        expect(yield* Effect.promise(() => Bun.file(saved.body.path).exists())).toBe(true)
        expect(yield* isDone(done)).toBe(false)
        expect(yield* instanceDisposed.done).toBe(false)

        // Release the held stream: the project convergence drains the reader,
        // disposes the pre-save runtime exactly once, reboots, and drops the
        // fence. The response already returned.
        yield* Deferred.succeed(gate, void 0)
        yield* awaitWithTimeout(Deferred.await(done), "held stream never completed")
        yield* Fiber.join(fiber)
        yield* joinSignal(instanceDisposed.await)
        expect(yield* instanceDisposed.count).toBe(1)
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")

        // The rebuilt runtime serves the saved agent (final event/reload).
        const agents = (yield* Effect.promise(async () => {
          const res = await request(f.project, "/agent")
          const list = (await res.json()) as Array<{ name: string }>
          return list
        })) as Array<{ name: string }>
        expect(agents.some((item) => item.name === "held-project")).toBe(true)
      }),
    120_000,
  )

  it.live(
    "global save acknowledges before release; the active generation is not disposed early and BOTH loaded directories refresh",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        // A sibling directory is loaded and idle — a global mutation must
        // converge it too (LOCK-005).
        const other = yield* sibling(f)
        const gate = yield* Deferred.make<void>()
        const projectDisposed = yield* eventCountLatch("server.instance.disposed", f.project, 1)
        const siblingDisposed = yield* eventCountLatch("server.instance.disposed", other, 1)
        const globalDisposed = yield* eventCountLatch(Event.Disposed.type, undefined, 1)
        const session = yield* Effect.promise(() => createSession(f.project))
        const { done, fiber } = yield* startHeldPrompt(f.project, session.id, gate)
        yield* waitForBusy(f.project, session.id)

        // Global-scope save: acknowledges while the stream is held; the agent
        // file lands in the global config directory.
        const saved = yield* Effect.promise(async () => {
          const response = await request(f.project, "/agent-builder/held-global", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ scope: "global", prompt: "Held global agent." }),
          })
          return { status: response.status, body: (await response.json()) as { path: string } }
        })
        expect(saved.status).toBe(200)
        expect(saved.body.path).toBe(path.join(f.global, "agent", "held-global.md"))
        expect(yield* Effect.promise(() => Bun.file(saved.body.path).exists())).toBe(true)

        // The active generation's runtime is NOT disposed early. The idle
        // sibling may converge immediately (LOCK-005: idle directories are not
        // delayed by busy ones), so only the project latch is asserted here.
        expect(yield* isDone(done)).toBe(false)
        expect(yield* projectDisposed.done).toBe(false)

        // Release: both loaded directories converge exactly once; the global
        // disposed signal fires once.
        yield* Deferred.succeed(gate, void 0)
        yield* awaitWithTimeout(Deferred.await(done), "held stream never completed")
        yield* Fiber.join(fiber)
        yield* joinSignal(projectDisposed.await)
        yield* joinSignal(siblingDisposed.await)
        yield* joinSignal(globalDisposed.await)
        expect(yield* projectDisposed.count).toBe(1)
        expect(yield* siblingDisposed.count).toBe(1)
        expect(yield* globalDisposed.count).toBe(1)
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")
      }),
    120_000,
  )
})

describe("private skill removal converges with project scope for project-local skills (LOCK-005)", () => {
  it.live(
    "removing a project-local skill disposes only the request directory and never fires global.disposed",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* seedSkill(f.project, "remove-me")
        // Boot the request instance so the registry discovers the skill.
        yield* Effect.promise(async () => {
          const response = await request(f.project, "/skill")
          expect(response.status).toBe(200)
        })
        const instanceDisposed = yield* eventCountLatch("server.instance.disposed", f.project, 1)
        const globalDisposed = yield* eventCountLatch(Event.Disposed.type, undefined, 1)
        const location = path.join(f.project, ".kilo", "skill", "remove-me", "SKILL.md")

        const removed = yield* Effect.promise(() => privateRemoveSkill(f.project, location, "conv-project"))
        expect(removed.status).toBe("succeeded")
        expect(yield* Effect.promise(() => Bun.file(location).exists())).toBe(false)
        // Removing only the manifest preserves sibling files.
        expect(yield* Effect.promise(() => Bun.file(path.join(f.project, ".kilo", "skill", "remove-me", "KEEP.txt")).exists())).toBe(true)

        // Project scope: exactly one disposal for the request directory, no
        // global disposed signal.
        yield* joinSignal(instanceDisposed.await)
        expect(yield* instanceDisposed.count).toBe(1)
        expect(yield* globalDisposed.done).toBe(false)
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")
      }),
    120_000,
  )

  it.live(
    "removing a skill outside the instance boundary is conservatively global and converges every loaded directory",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        // A GLOBAL-config skill: outside the project boundary, so the scope
        // falls back to global (all loaded directories).
        const globalSkill = path.join(f.global, "skill", "global-skill", "SKILL.md")
        yield* Effect.promise(() =>
          Bun.write(
            globalSkill,
            "---\nname: global-skill\ndescription: global fixture.\n---\n# global-skill\n",
          ),
        )
        const other = yield* sibling(f)
        yield* Effect.promise(async () => {
          const response = await request(f.project, "/skill")
          expect(response.status).toBe(200)
        })
        const projectDisposed = yield* eventCountLatch("server.instance.disposed", f.project, 1)
        const siblingDisposed = yield* eventCountLatch("server.instance.disposed", other, 1)
        const globalDisposed = yield* eventCountLatch(Event.Disposed.type, undefined, 1)

        const removed = yield* Effect.promise(() => privateRemoveSkill(f.project, globalSkill, "conv-global"))
        expect(removed.status).toBe("succeeded")
        expect(yield* Effect.promise(() => Bun.file(globalSkill).exists())).toBe(false)

        yield* joinSignal(projectDisposed.await)
        yield* joinSignal(siblingDisposed.await)
        yield* joinSignal(globalDisposed.await)
        expect(yield* projectDisposed.count).toBe(1)
        expect(yield* siblingDisposed.count).toBe(1)
        expect(yield* globalDisposed.count).toBe(1)
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")
      }),
    120_000,
  )
})

describe("agent removal converges globally (LOCK-005)", () => {
  it.live(
    "removing a custom agent converges every loaded directory and fires global.disposed once",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* seedAgent(f.project, "remove-agent")
        // Boot the request instance so the agent registry discovers the file.
        yield* Effect.promise(async () => {
          const response = await request(f.project, "/agent")
          expect(response.status).toBe(200)
        })
        const other = yield* sibling(f)
        const projectDisposed = yield* eventCountLatch("server.instance.disposed", f.project, 1)
        const siblingDisposed = yield* eventCountLatch("server.instance.disposed", other, 1)
        const globalDisposed = yield* eventCountLatch(Event.Disposed.type, undefined, 1)
        const location = path.join(f.project, ".kilo", "agent", "remove-agent.md")

        const removed = yield* Effect.promise(async () => {
          const response = await request(f.project, "/kilocode/agent/remove", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "remove-agent" }),
          })
          return response.status
        })
        expect(removed).toBe(200)
        expect(yield* Effect.promise(() => Bun.file(location).exists())).toBe(false)

        // Global scope: both loaded directories converge; one global signal.
        yield* joinSignal(projectDisposed.await)
        yield* joinSignal(siblingDisposed.await)
        yield* joinSignal(globalDisposed.await)
        expect(yield* projectDisposed.count).toBe(1)
        expect(yield* siblingDisposed.count).toBe(1)
        expect(yield* globalDisposed.count).toBe(1)
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")
      }),
    120_000,
  )
})
