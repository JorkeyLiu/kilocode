/**
 * Provider-auth lifecycle (LOCK-001..007): every provider-auth mutation routes
 * through the canonical ConfigConvergence coordinator and never disposes active
 * instances outside generation drain.
 *
 * Coverage:
 * 1. Coordinator (LOCK-001/002/004): the mutation persists under one global
 *    convergence fence, exactly one
 *    ControlLease-aware convergence pass is registered, the captured instance
 *    is disposed exactly once after drain, and InstanceStore.disposeAll is
 *    never called. Mutation failures (typed and defect) abort the fence with no
 *    rebuild / disposal, and release it for the next mutation.
 *    A mutation that persists auth and then fails restores the exact auth
 *    artifact bytes/mode before the fence aborts (LOCK-004). A mutation that
 *    persists auth and THEN fails restores the exact artifact too (LOCK-002).
 * 2. Anaconda caller coverage lives in anaconda-desktop/service.test.ts
 *    (service-level, proving the sync routes through the coordinator).
 * 3. Held stream through the real listener (LOCK-006): auth set and auth
 *    remove return 200 and persist BEFORE release; no `session.error`,
 *    `server.instance.disposed`, or `global.disposed` before release; the
 *    stream completes with token continuity; exactly one disposal/rebuild;
 *    backend PID/listener identity unchanged; the rebuilt runtime keeps
 *    serving and the auth file reflects the change.
 */

import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Deferred, Effect, Fiber, Layer, Option, Ref } from "effect"
import type * as Scope from "effect/Scope"
import * as Log from "@opencode-ai/core/util/log"
import type { Hooks } from "@kilocode/plugin"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Auth } from "../../../src/auth"
import { Config } from "../../../src/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Server } from "../../../src/server/server"
import { Event } from "../../../src/server/event"
import { GlobalBus } from "../../../src/bus/global"
import { ProviderAuth } from "../../../src/provider/auth"
import { Plugin } from "../../../src/plugin"
import { InstanceStore } from "../../../src/project/instance-store"
import type { InstanceContext } from "../../../src/project/instance-context"
import { ControlLease } from "../../../src/kilocode/server/control-lease"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { ConfigConvergence } from "../../../src/kilocode/server/config-convergence" // kilocode_change
import { awaitRebuilds, probeRebuildRegistration } from "../../../src/kilocode/server/config-rebuild"
import { invalidateAfterProviderAuthChange } from "../../../src/kilocode/server/provider-auth-lifecycle"
import { TestLLMServer } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../../lib/effect"
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

/** Per-test project directories disposed via the instance route in afterEach. */
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
  ownedListeners.clear()
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(TestLLMServer.layer)

const authFile = () => path.join(Global.Path.data, "auth.json")

function readAuth(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(authFile(), "utf-8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

function seedAuth(providerID: string, info: unknown = { type: "api", key: "test-key" }) {
  fs.mkdirSync(Global.Path.data, { recursive: true })
  fs.writeFileSync(authFile(), JSON.stringify({ ...readAuth(), [providerID]: info }, null, 2))
}

// ─── coordinator-level fixtures ─────────────────────────────────────────

/** Captured pre-fence instance identity the coordinator's convergence pass disposes. */
const fakeCtx: InstanceContext = {
  directory: "/tmp/project-a",
  worktree: "/tmp/project-a",
  project: { id: ProjectV2.ID.make("proj-a"), worktree: "/tmp/project-a", time: { created: 0, updated: 0 }, sandboxes: [] },
}

/**
 * Canonical coordinator graph: real gate + control leases + FSUtil + Auth
 * (real file), with an InstanceStore that records events. The
 * InstanceStore tracks disposeAll so a direct disposal call is observable and
 * forbidden.
 */
function coordinatorLayer(events: Ref.Ref<string[]>) {
  return Layer.mergeAll(
    GenerationGate.defaultLayer,
    ConfigConvergence.defaultLayer, // kilocode_change - canonical cold-mutation coordinator
    ControlLease.defaultLayer,
    FSUtil.defaultLayer,
    Auth.defaultLayer,
    Layer.mock(InstanceStore.Service)({
      directories: () => Effect.succeed([fakeCtx.directory]),
      snapshot: () => Effect.succeed(Option.some(fakeCtx)),
      dispose: () => Ref.update(events, (items) => [...items, "dispose"]),
      load: () => Effect.succeed(fakeCtx),
      disposeAll: () => Ref.update(events, (items) => [...items, "dispose-all"]),
    }),
  ).pipe(Layer.provideMerge(GenerationGate.defaultLayer))
}

/**
 * LOCK-003 cleanup graph: the coordinator with a REAL global config target
 * (the Config service reads the file under Global.Path.config). The
 * InstanceStore records disposal so a direct disposeAll is observable and
 * forbidden.
 */
function cleanupLayer(events: Ref.Ref<string[]>) {
  return Layer.mergeAll(
    GenerationGate.defaultLayer,
    ConfigConvergence.defaultLayer, // kilocode_change - canonical cold-mutation coordinator
    ControlLease.defaultLayer,
    FSUtil.defaultLayer,
    Auth.defaultLayer,
    Config.defaultLayer,
    Layer.mock(InstanceStore.Service)({
      directories: () => Effect.succeed([fakeCtx.directory]),
      snapshot: () => Effect.succeed(Option.some(fakeCtx)),
      dispose: () => Ref.update(events, (items) => [...items, "dispose"]),
      load: () => Effect.succeed(fakeCtx),
      disposeAll: () => Ref.update(events, (items) => [...items, "dispose-all"]),
    }),
  ).pipe(Layer.provideMerge(GenerationGate.defaultLayer))
}

// ─── LOCK-001/002/004: coordinator lifecycle + failure semantics ────────

describe("providerAuth - coordinator lifecycle (LOCK-001/002/004)", () => {
  it.live(
    "persists the mutation under the convergence fence, clears the cache, and registers exactly one convergence pass — never disposeAll",
    () =>
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([])
        yield* Effect.sync(() => seedAuth("test", { type: "api", key: "old" }))
        const beforeRaw = fs.readFileSync(authFile(), "utf-8")

        const exit = yield* Effect.gen(function* () {
          const svc = yield* Auth.Service
          yield* invalidateAfterProviderAuthChange(
            "test",
            svc.set("test", new Auth.Api({ type: "api", key: "new" })).pipe(Effect.orDie),
          ).pipe(Effect.provide(coordinatorLayer(events)))
          return yield* svc.get("test")
        }).pipe(Effect.provide(coordinatorLayer(events)), Effect.exit)
        if (exit._tag !== "Success") throw new Error("auth set through the coordinator failed")
        const stored = exit.value
        // The mutation persisted.
        expect(fs.readFileSync(authFile(), "utf-8")).not.toBe(beforeRaw)
        expect(stored?.type === "api" && stored.key === "new").toBe(true)
        expect(yield* Ref.get(events)).not.toContain("dispose-all")

        // Exactly one rebuild: the captured instance is disposed once after
        // drain; no direct disposeAll.
        yield* awaitRebuilds()
        expect(yield* Ref.get(events)).toEqual(["dispose"])
      }),
  )

  it.live(
    "a typed mutation failure aborts the fence: no cache clear, no rebuild, no disposal; the fence is released",
    () =>
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([])
        yield* Effect.sync(() => seedAuth("test", { type: "api", key: "old" }))
        const beforeRaw = fs.readFileSync(authFile(), "utf-8")

        const failed = yield* invalidateAfterProviderAuthChange(
          "test",
          Effect.fail(new Error("oauth-callback-failed")),
        ).pipe(Effect.provide(coordinatorLayer(events)), Effect.exit)
        expect(failed._tag).toBe("Failure")
        expect(yield* Ref.get(events)).toEqual([])
        expect(fs.readFileSync(authFile(), "utf-8")).toBe(beforeRaw)
        yield* awaitRebuilds()

        // Fence released: the next mutation completes end to end.
        const followup = yield* Effect.gen(function* () {
          const svc = yield* Auth.Service
          yield* invalidateAfterProviderAuthChange(
            "test",
            svc.set("test", new Auth.Api({ type: "api", key: "new" })).pipe(Effect.orDie),
          ).pipe(Effect.provide(coordinatorLayer(events)))
        }).pipe(Effect.provide(coordinatorLayer(events)), Effect.exit)
        if (followup._tag !== "Success") throw new Error("follow-up auth set through the coordinator failed")
        yield* awaitRebuilds()
        expect(yield* Ref.get(events)).toEqual(["dispose"])
      }),
  )

  it.live(
    "a defect mutation failure propagates and aborts the fence without disposal",
    () =>
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([])
        yield* Effect.sync(() => seedAuth("test", { type: "api", key: "old" }))
        const beforeRaw = fs.readFileSync(authFile(), "utf-8")

        const failed = yield* invalidateAfterProviderAuthChange(
          "test",
          Effect.die(new Error("mutation boom")),
        ).pipe(Effect.provide(coordinatorLayer(events)), Effect.exit)
        expect(failed._tag).toBe("Failure")
        expect(yield* Ref.get(events)).toEqual([])
        expect(fs.readFileSync(authFile(), "utf-8")).toBe(beforeRaw)
        yield* awaitRebuilds()
      }),
  )

  it.live(
    "a mutation that persists auth and then fails restores the exact artifact bytes/mode with zero cache/rebuild/event, and releases the fence",
    () =>
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([])
        yield* Effect.sync(() => seedAuth("test", { type: "api", key: "old" }))
        const authPath = authFile()
        const beforeRaw = fs.readFileSync(authPath, "utf-8")
        fs.chmodSync(authPath, 0o640)
        const beforeMode = fs.statSync(authPath).mode & 0o777

        // mutate persists auth (set writes the file) and THEN fails — the exact
        // post-snapshot failure mode LOCK-002 compensates: the durable write
        // must be rolled back byte/mode-exactly before the fence aborts.
        const failed = yield* Effect.gen(function* () {
          const svc = yield* Auth.Service
          yield* invalidateAfterProviderAuthChange(
            "test",
            svc.set("test", new Auth.Api({ type: "api", key: "new" })).pipe(
              Effect.orDie,
              Effect.andThen(Effect.fail(new Error("post-write failure"))),
            ),
          ).pipe(Effect.provide(coordinatorLayer(events)))
        }).pipe(Effect.provide(coordinatorLayer(events)), Effect.exit)
        expect(failed._tag).toBe("Failure")

        // The durable mutation was compensated with the exact artifact.
        expect(fs.readFileSync(authPath, "utf-8")).toBe(beforeRaw)
        expect(fs.statSync(authPath).mode & 0o777).toBe(beforeMode)
        // Zero cache clear, zero rebuild/disposal, zero events.
        expect(yield* Ref.get(events)).toEqual([])
        yield* awaitRebuilds()

        // Fence released: with a healthy mutation the next run completes.
        const followup = yield* Effect.gen(function* () {
          const svc = yield* Auth.Service
          yield* invalidateAfterProviderAuthChange(
            "test",
            svc.set("test", new Auth.Api({ type: "api", key: "new" })).pipe(Effect.orDie),
          ).pipe(Effect.provide(coordinatorLayer(events)))
          return yield* svc.get("test")
        }).pipe(Effect.provide(coordinatorLayer(events)), Effect.exit)
        if (followup._tag !== "Success") throw new Error("follow-up auth set through the coordinator failed")
        yield* awaitRebuilds()
        expect(yield* Ref.get(events)).toEqual(["dispose"])
        const stored = followup.value
        expect(stored?.type === "api" && stored.key === "new").toBe(true)
      }),
  )
})

// ─── LOCK-001/004: OAuth callback through the canonical coordinator ──────

const oauthHook: NonNullable<Hooks["auth"]> = {
  provider: ProviderV2.ID.make("oauth-test"),
  methods: [
    {
      type: "oauth",
      label: "OAuth",
      authorize: async () => ({
        url: "https://example.com/oauth/authorize",
        method: "auto",
        instructions: "open the URL",
        callback: async () => ({
          type: "success",
          refresh: "refresh-token",
          access: "access-token",
          expires: Date.now() + 86_400_000,
          accountId: "org-123",
        }),
      }),
    },
  ],
}

/**
 * Canonical OAuth graph (LOCK-001): the real ProviderAuth consumes the
 * coordinator's Auth/Plugin instances — no self-provided
 * Auth.defaultLayer — with a plugin OAuth hook. The InstanceStore records disposal so a direct
 * disposeAll is observable and forbidden.
 */
function oauthLayer(events: Ref.Ref<string[]>) {
  const coordinator = Layer.mergeAll(
    GenerationGate.defaultLayer,
    ConfigConvergence.defaultLayer, // kilocode_change - canonical cold-mutation coordinator
    ControlLease.defaultLayer,
    FSUtil.defaultLayer,
    Auth.defaultLayer,
    Layer.mock(InstanceStore.Service)({
      directories: () => Effect.succeed([fakeCtx.directory]),
      snapshot: () => Effect.succeed(Option.some(fakeCtx)),
      dispose: () => Ref.update(events, (items) => [...items, "dispose"]),
      load: () => Effect.succeed(fakeCtx),
      disposeAll: () => Ref.update(events, (items) => [...items, "dispose-all"]),
    }),
  ).pipe(Layer.provideMerge(GenerationGate.defaultLayer))
  const plugin = Layer.mock(Plugin.Service)({
    list: () => Effect.succeed([{ auth: oauthHook }]),
  })
  return ProviderAuth.layer.pipe(Layer.provide(plugin), Layer.provideMerge(coordinator))
}

describe("providerAuth - OAuth callback via the coordinator (LOCK-001/004)", () => {
  it.instance(
    "the callback persists auth and rebuilds exactly once",
    () =>
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([])
        const exit = yield* Effect.gen(function* () {
          const svc = yield* ProviderAuth.Service
          yield* svc.authorize({ providerID: ProviderV2.ID.make("oauth-test"), method: 0 })
          yield* invalidateAfterProviderAuthChange(ProviderV2.ID.make("oauth-test"), svc.callback({ providerID: ProviderV2.ID.make("oauth-test"), method: 0 }))
          return yield* (yield* Auth.Service).get(ProviderV2.ID.make("oauth-test"))
        }).pipe(Effect.provide(oauthLayer(events)), Effect.exit)
        if (exit._tag !== "Success") throw new Error("oauth callback through the coordinator failed")
        const stored = exit.value
        // The OAuth token exchange persisted through the canonical Auth.
        expect(stored?.type === "oauth" && stored.refresh === "refresh-token" && stored.access === "access-token").toBe(
          true,
        )
        // The coordinator rebuild disposes the captured instance — the drain is immediate with no live readers.
        // No direct disposeAll anywhere.
        expect(yield* Ref.get(events)).not.toContain("dispose-all")
        yield* awaitRebuilds()
        expect(yield* Ref.get(events)).toEqual(["dispose"])
        expect(yield* Ref.get(events)).not.toContain("dispose-all")
      }),
  )

  it.instance(
    "a post-write callback failure restores the exact auth artifact and releases the fence",
    () =>
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([])
        yield* Effect.sync(() => seedAuth(ProviderV2.ID.make("oauth-test"), { type: "api", key: "old" }))
        const authPath = authFile()
        const beforeRaw = fs.readFileSync(authPath, "utf-8")
        fs.chmodSync(authPath, 0o640)
        const beforeMode = fs.statSync(authPath).mode & 0o777

        // The callback persists the OAuth tokens and THEN fails (mutate-level
        // post-write failure): the coordinator restores the exact artifact
        // before the fence aborts, with zero cache/rebuild/events.
        const failed = yield* Effect.gen(function* () {
          const svc = yield* ProviderAuth.Service
          yield* svc.authorize({ providerID: ProviderV2.ID.make("oauth-test"), method: 0 })
          yield* invalidateAfterProviderAuthChange(
            ProviderV2.ID.make("oauth-test"),
            svc.callback({ providerID: ProviderV2.ID.make("oauth-test"), method: 0 }).pipe(
              Effect.andThen(Effect.fail(new Error("post-write callback failure"))),
            ),
          )
        }).pipe(Effect.provide(oauthLayer(events)), Effect.exit)
        expect(failed._tag).toBe("Failure")
        expect(fs.readFileSync(authPath, "utf-8")).toBe(beforeRaw)
        expect(fs.statSync(authPath).mode & 0o777).toBe(beforeMode)
        expect(yield* Ref.get(events)).toEqual([])
        yield* awaitRebuilds()

        // Fence released: the next callback completes end to end.
        const followup = yield* Effect.gen(function* () {
          const svc = yield* ProviderAuth.Service
          yield* svc.authorize({ providerID: ProviderV2.ID.make("oauth-test"), method: 0 })
          yield* invalidateAfterProviderAuthChange(ProviderV2.ID.make("oauth-test"), svc.callback({ providerID: ProviderV2.ID.make("oauth-test"), method: 0 }))
        }).pipe(Effect.provide(oauthLayer(events)), Effect.exit)
        if (followup._tag !== "Success") throw new Error("follow-up callback through the coordinator failed")
        yield* awaitRebuilds()
        expect(yield* Ref.get(events)).toEqual(["dispose"])
      }),
  )
})

// ─── LOCK-004: server auth callers never dispose instances directly ──────

describe("providerAuth - server auth callers have no direct disposeAll (LOCK-004)", () => {
  const callers = [
    "server/routes/instance/httpapi/handlers/provider.ts",
    "server/routes/instance/httpapi/handlers/control.ts",
    "server/routes/instance/httpapi/handlers/global.ts",
    "kilocode/server/httpapi/handlers/kilo-gateway.ts",
    "kilocode/anaconda-desktop/service.ts",
  ]
  for (const file of callers) {
    test(`${file} has no direct disposeAll`, async () => {
      const src = await Bun.file(path.join(import.meta.dir, "../../../src", file)).text()
      expect(src).not.toMatch(/\.disposeAll\s*\(/)
    })
  }
})

// ─── LOCK-003: static cleanup-option wiring ─────────────────────────────

describe("providerAuth - disabled cleanup option wiring (LOCK-003)", () => {
  const enabled = [
    "server/routes/instance/httpapi/handlers/control.ts",
    "server/routes/instance/httpapi/handlers/provider.ts",
  ]
  for (const file of enabled) {
    test(`${file} enables the disabled-provider cleanup`, async () => {
      const src = await Bun.file(path.join(import.meta.dir, "../../../src", file)).text()
      expect(src).toMatch(/cleanupDisabled:\s*true/)
    })
  }
  const untouched = ["kilocode/server/httpapi/handlers/kilo-gateway.ts", "kilocode/anaconda-desktop/service.ts"]
  for (const file of untouched) {
    test(`${file} does not request disabled-provider cleanup`, async () => {
      const src = await Bun.file(path.join(import.meta.dir, "../../../src", file)).text()
      expect(src).not.toMatch(/cleanupDisabled/)
    })
  }
})

// ─── event helpers (LOCK-006) ───────────────────────────────────────────

function captureEvents() {
  const received: Array<{ type: string; directory?: string; transaction?: string }> = []
  const handler = (event: { directory?: string; transaction?: string; payload: { type: string } }) => {
    received.push({ type: event.payload.type, directory: event.directory, transaction: event.transaction })
  }
  GlobalBus.on("event", handler)
  const dispose = () => GlobalBus.removeListener("event", handler)
  ownedListeners.add(dispose)
  return { received, dispose }
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

const eventLatch = (type: string, directory?: string) =>
  Effect.gen(function* () {
    const deferred = yield* Deferred.make<void>()
    const handler = (event: { directory?: string; payload: { type: string } }) => {
      if (event.payload.type !== type) return
      if (directory !== undefined && event.directory !== directory) return
      void Effect.runFork(Deferred.succeed(deferred, void 0))
    }
    GlobalBus.on("event", handler)
    const dispose = () => GlobalBus.removeListener("event", handler)
    ownedListeners.add(dispose)
    return {
      await: Deferred.await(deferred),
      done: isDone(deferred),
      dispose,
    }
  })

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

// ─── fixtures ───────────────────────────────────────────────────────────

type Entry = (url: string) => Record<string, unknown>

const custom: Entry = (url) => ({ ...testProviderConfig(url).provider.test, npm: "@ai-sdk/openai-compatible" })

type Fixture = { llm: TestLLMServer["Service"]; project: string; global: string }

const makeFixture = (): Effect.Effect<Fixture, unknown, TestLLMServer | Scope.Scope> =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const global = await tmpdir({ retain: true })
        await seedGlobalConfig(global.path, { provider: { test: custom(llm.url) } })
        const project = await tmpdir({ git: true, retain: true })
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

async function seedGlobalConfig(dir: string, extra?: Record<string, unknown>) {
  await Bun.write(
    path.join(dir, "kilo.jsonc"),
    JSON.stringify({ $schema: "https://app.kilo.ai/config.json", permission: { bash: "allow" }, ...extra }, null, 2),
  )
  await markPluginDependenciesReady(dir)
}

function globalFile(dir: string): string {
  for (const name of ["kilo.jsonc", "kilo.json", "opencode.jsonc", "opencode.json"]) {
    const fp = path.join(dir, name)
    if (fs.existsSync(fp)) return fp
  }
  throw new Error(`No global config file found in ${dir}`)
}

function readGlobalConfig(dir: string): Record<string, unknown> {
  const raw = fs.readFileSync(globalFile(dir), "utf-8")
  return JSON.parse(raw) as Record<string, unknown>
}

const configEvents = (received: Array<{ type: string; directory?: string; transaction?: string }>) =>
  received.filter((event) => event.type === Event.ConfigUpdated.type)

// ─── LOCK-006: held stream through the real listener ────────────────────

describe("providerAuth - held stream + real listener (LOCK-006)", () => {
  it.live(
    "auth set returns 200 and persists before release; stream completes with exactly one disposal/rebuild",
    (): Effect.Effect<void, unknown, TestLLMServer | Scope.Scope> =>
      Effect.gen(function* () {
        const f = yield* makeFixture()
        yield* Effect.sync(() => seedAuth("test", { type: "api", key: "old-key" }))
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1" })),
          (value) => Effect.promise(() => value.stop(true)).pipe(Effect.ignore),
        )
        const gate = yield* Deferred.make<void>()
        const disposed = yield* eventCountLatch(Event.Disposed.type)
        const instanceDisposed = yield* eventCountLatch("server.instance.disposed", f.project)
        const sessionError = yield* eventLatch("session.error")
        const base = listener.url.toString().replace(/\/$/, "")
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
        const listenerStatus = (sessionID: string) =>
          Effect.promise(async () => {
            const response = await fetch(`${base}/session/status`, {
              headers: { "x-kilo-directory": f.project },
            })
            expect(response.status).toBe(200)
            const map = (await response.json()) as Record<string, { type: string }>
            return map[sessionID]?.type
          })

        // Open a session and start a generation whose LLM stream stays held.
        const create = yield* send(f.project, "/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "held stream" }),
        })
        expect(create.status).toBe(200)
        const session = (yield* Effect.promise(() => create.json())) as SessionV1.Info

        yield* f.llm.hold("streamed", deferredAsPromise(gate))
        const promptDone = yield* Deferred.make<void>()
        const promptFiber = yield* Effect.forkDetach(
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
            expect(response.status).toBe(200)
            const body = (yield* Effect.promise(() => response.json())) as { info?: { role?: string } }
            expect(body.info?.role).toBe("assistant")
            yield* Deferred.succeed(promptDone, void 0)
          }),
        )

        yield* Effect.gen(function* () {
          // The stream is in flight (held) — wait until the LLM was hit.
          yield* awaitWithTimeout(f.llm.wait(1), "held generation never reached the LLM", "20 seconds")
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const type = yield* listenerStatus(session.id)
              return type === "busy" ? (true as const) : undefined
            }),
            `session ${session.id} never became busy`,
          )

          // Identity baselines: same backend process and listener URL across the
          // auth change + rebuild (LOCK-006).
          const urlBefore = listener.url.toString()
          const pidBefore = process.pid

          // PUT /auth/test through the real listener: the response returns
          // BEFORE the held stream is released and before any disposal.
          const set = yield* send(f.project, "/auth/test", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "api", key: "rotated-key" }),
          })
          expect(set.status).toBe(200)
          expect(yield* Effect.promise(() => set.json())).toBe(true)

          // Persistence is immediate while the stream is still in flight.
          const stored = readAuth().test as { type: string; key: string }
          expect(stored.type).toBe("api")
          expect(stored.key).toBe("rotated-key")

          // No lifecycle/error signal before release.
          expect(yield* disposed.done).toBe(false)
          expect(yield* instanceDisposed.done).toBe(false)
          expect(yield* sessionError.done).toBe(false)
          expect(yield* isDone(promptDone)).toBe(false)

          // Backend identity unchanged.
          expect(listener.url.toString()).toBe(urlBefore)
          expect(process.pid).toBe(pidBefore)

          // Release the held stream: the deferred rebuild drains the reader and
          // disposes the old instance exactly once.
          yield* Deferred.succeed(gate, void 0)
          yield* awaitWithTimeout(Deferred.await(promptDone), "held stream never completed", "20 seconds")
          yield* Fiber.join(promptFiber)
          yield* awaitWithTimeout(disposed.await, "global disposed event did not arrive", "20 seconds")
          yield* awaitWithTimeout(instanceDisposed.await, "instance disposed event did not arrive", "20 seconds")
          expect(yield* disposed.count).toBe(1)
          expect(yield* instanceDisposed.count).toBe(1)
          expect(yield* sessionError.done).toBe(false)
          yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle", "20 seconds")

          // The listener keeps serving the rebuilt runtime; auth still reflects
          // the change.
          expect(listener.url.toString()).toBe(urlBefore)
          expect((readAuth().test as { key?: string }).key).toBe("rotated-key")
          const status = yield* send(f.project, "/session/status")
          expect(status.status).toBe(200)
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Deferred.succeed(gate, void 0)
              yield* Effect.exit(Effect.timeout(Fiber.join(promptFiber), "20 seconds")).pipe(
                Effect.flatMap((exit) => (exit._tag === "Failure" ? Fiber.interrupt(promptFiber).pipe(Effect.asVoid) : Effect.void)),
              )
            }),
          ),
        )
      }),
    120_000,
  )

  it.live(
    "auth remove returns 200 and persists before release; stream completes with exactly one disposal/rebuild",
    (): Effect.Effect<void, unknown, TestLLMServer | Scope.Scope> =>
      Effect.gen(function* () {
        const f = yield* makeFixture()
        yield* Effect.sync(() => seedAuth("test", { type: "api", key: "old-key" }))
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1" })),
          (value) => Effect.promise(() => value.stop(true)).pipe(Effect.ignore),
        )
        const gate = yield* Deferred.make<void>()
        const disposed = yield* eventCountLatch(Event.Disposed.type)
        const instanceDisposed = yield* eventCountLatch("server.instance.disposed", f.project)
        const sessionError = yield* eventLatch("session.error")
        const base = listener.url.toString().replace(/\/$/, "")
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
        const listenerStatus = (sessionID: string) =>
          Effect.promise(async () => {
            const response = await fetch(`${base}/session/status`, {
              headers: { "x-kilo-directory": f.project },
            })
            expect(response.status).toBe(200)
            const map = (await response.json()) as Record<string, { type: string }>
            return map[sessionID]?.type
          })

        const create = yield* send(f.project, "/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "held stream" }),
        })
        expect(create.status).toBe(200)
        const session = (yield* Effect.promise(() => create.json())) as SessionV1.Info

        yield* f.llm.hold("streamed", deferredAsPromise(gate))
        const promptDone = yield* Deferred.make<void>()
        const promptFiber = yield* Effect.forkDetach(
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
            expect(response.status).toBe(200)
            const body = (yield* Effect.promise(() => response.json())) as { info?: { role?: string } }
            expect(body.info?.role).toBe("assistant")
            yield* Deferred.succeed(promptDone, void 0)
          }),
        )

        yield* Effect.gen(function* () {
          yield* awaitWithTimeout(f.llm.wait(1), "held generation never reached the LLM", "20 seconds")
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const type = yield* listenerStatus(session.id)
              return type === "busy" ? (true as const) : undefined
            }),
            `session ${session.id} never became busy`,
          )

          const urlBefore = listener.url.toString()
          const pidBefore = process.pid

          // DELETE /auth/test through the real listener.
          const removed = yield* send(f.project, "/auth/test", { method: "DELETE" })
          expect(removed.status).toBe(200)
          expect(yield* Effect.promise(() => removed.json())).toBe(true)

          // Auth removed while the stream is still in flight.
          expect((readAuth() as Record<string, unknown>).test).toBeUndefined()

          expect(yield* disposed.done).toBe(false)
          expect(yield* instanceDisposed.done).toBe(false)
          expect(yield* sessionError.done).toBe(false)
          expect(yield* isDone(promptDone)).toBe(false)
          expect(listener.url.toString()).toBe(urlBefore)
          expect(process.pid).toBe(pidBefore)

          yield* Deferred.succeed(gate, void 0)
          yield* awaitWithTimeout(Deferred.await(promptDone), "held stream never completed", "20 seconds")
          yield* Fiber.join(promptFiber)
          yield* awaitWithTimeout(disposed.await, "global disposed event did not arrive", "20 seconds")
          yield* awaitWithTimeout(instanceDisposed.await, "instance disposed event did not arrive", "20 seconds")
          expect(yield* disposed.count).toBe(1)
          expect(yield* instanceDisposed.count).toBe(1)
          expect(yield* sessionError.done).toBe(false)
          yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle", "20 seconds")

          expect(listener.url.toString()).toBe(urlBefore)
          expect((readAuth() as Record<string, unknown>).test).toBeUndefined()
          const status = yield* send(f.project, "/session/status")
          expect(status.status).toBe(200)
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Deferred.succeed(gate, void 0)
              yield* Effect.exit(Effect.timeout(Fiber.join(promptFiber), "20 seconds")).pipe(
                Effect.flatMap((exit) => (exit._tag === "Failure" ? Fiber.interrupt(promptFiber).pipe(Effect.asVoid) : Effect.void)),
              )
            }),
          ),
        )
      }),
    120_000,
  )
})

// ─── LOCK-002/004: organization switch through the real listener ─────────

describe("providerAuth - organization switch held stream (LOCK-002/004)", () => {
  it.live(
    "organization switch returns 200 before drain, no pre-disposal, then exactly one rebuild",
    (): Effect.Effect<void, unknown, TestLLMServer | Scope.Scope> =>
      Effect.gen(function* () {
        const f = yield* makeFixture()
        yield* Effect.sync(() =>
          seedAuth("kilo", {
            type: "oauth",
            refresh: "refresh-token",
            access: "access-token",
            expires: Date.now() + 86_400_000,
            accountId: "org-1",
          }),
        )
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1" })),
          (value) => Effect.promise(() => value.stop(true)).pipe(Effect.ignore),
        )
        const gate = yield* Deferred.make<void>()
        const disposed = yield* eventCountLatch(Event.Disposed.type)
        const instanceDisposed = yield* eventCountLatch("server.instance.disposed", f.project)
        const sessionError = yield* eventLatch("session.error")
        const base = listener.url.toString().replace(/\/$/, "")
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
        const listenerStatus = (sessionID: string) =>
          Effect.promise(async () => {
            const response = await fetch(`${base}/session/status`, {
              headers: { "x-kilo-directory": f.project },
            })
            expect(response.status).toBe(200)
            const map = (await response.json()) as Record<string, { type: string }>
            return map[sessionID]?.type
          })

        const create = yield* send(f.project, "/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "held stream" }),
        })
        expect(create.status).toBe(200)
        const session = (yield* Effect.promise(() => create.json())) as SessionV1.Info

        yield* f.llm.hold("streamed", deferredAsPromise(gate))
        const promptDone = yield* Deferred.make<void>()
        const promptFiber = yield* Effect.forkDetach(
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
            expect(response.status).toBe(200)
            const body = (yield* Effect.promise(() => response.json())) as { info?: { role?: string } }
            expect(body.info?.role).toBe("assistant")
            yield* Deferred.succeed(promptDone, void 0)
          }),
        )

        yield* Effect.gen(function* () {
          yield* awaitWithTimeout(f.llm.wait(1), "held generation never reached the LLM", "20 seconds")
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const type = yield* listenerStatus(session.id)
              return type === "busy" ? (true as const) : undefined
            }),
            `session ${session.id} never became busy`,
          )

          const urlBefore = listener.url.toString()
          const pidBefore = process.pid

          // POST /kilo/organization switches the org while the stream is held.
          const switched = yield* send(f.project, "/kilo/organization", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ organizationId: "org-2" }),
          })
          expect(switched.status).toBe(200)
          expect(yield* Effect.promise(() => switched.json())).toBe(true)

          // The auth mutation persisted while the stream is still in flight.
          const kiloAuth = readAuth().kilo as { type: string; accountId?: string }
          expect(kiloAuth.type).toBe("oauth")
          expect(kiloAuth.accountId).toBe("org-2")

          // No lifecycle/error signal before release; backend identity unchanged.
          expect(yield* disposed.done).toBe(false)
          expect(yield* instanceDisposed.done).toBe(false)
          expect(yield* sessionError.done).toBe(false)
          expect(yield* isDone(promptDone)).toBe(false)
          expect(listener.url.toString()).toBe(urlBefore)
          expect(process.pid).toBe(pidBefore)

          // Release the held stream: exactly one rebuild disposes the old
          // instance after drain; no direct disposeAll.
          yield* Deferred.succeed(gate, void 0)
          yield* awaitWithTimeout(Deferred.await(promptDone), "held stream never completed", "20 seconds")
          yield* Fiber.join(promptFiber)
          yield* awaitWithTimeout(disposed.await, "global disposed event did not arrive", "20 seconds")
          yield* awaitWithTimeout(instanceDisposed.await, "instance disposed event did not arrive", "20 seconds")
          expect(yield* disposed.count).toBe(1)
          expect(yield* instanceDisposed.count).toBe(1)
          expect(yield* sessionError.done).toBe(false)
          yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle", "20 seconds")

          // The listener keeps serving the rebuilt runtime; the org switch stuck.
          expect(listener.url.toString()).toBe(urlBefore)
          expect((readAuth().kilo as { accountId?: string }).accountId).toBe("org-2")
          const status = yield* send(f.project, "/session/status")
          expect(status.status).toBe(200)
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Deferred.succeed(gate, void 0)
              yield* Effect.exit(Effect.timeout(Fiber.join(promptFiber), "20 seconds")).pipe(
                Effect.flatMap((exit) => (exit._tag === "Failure" ? Fiber.interrupt(promptFiber).pipe(Effect.asVoid) : Effect.void)),
              )
            }),
          ),
        )
      }),
    120_000,
  )
})

// ─── LOCK-001: held /global/dispose through the real listener ───────────

describe("providerAuth - held global dispose (LOCK-001)", () => {
  it.live(
    "global dispose returns 200 before drain, no pre-disposal, then exactly one rebuild and one global.disposed",
    (): Effect.Effect<void, unknown, TestLLMServer | Scope.Scope> =>
      Effect.gen(function* () {
        const f = yield* makeFixture()
        yield* Effect.sync(() => seedAuth("test", { type: "api", key: "old-key" }))
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1" })),
          (value) => Effect.promise(() => value.stop(true)).pipe(Effect.ignore),
        )
        const gate = yield* Deferred.make<void>()
        const disposed = yield* eventCountLatch(Event.Disposed.type)
        const instanceDisposed = yield* eventCountLatch("server.instance.disposed", f.project)
        const sessionError = yield* eventLatch("session.error")
        const base = listener.url.toString().replace(/\/$/, "")
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
        const listenerStatus = (sessionID: string) =>
          Effect.promise(async () => {
            const response = await fetch(`${base}/session/status`, {
              headers: { "x-kilo-directory": f.project },
            })
            expect(response.status).toBe(200)
            const map = (await response.json()) as Record<string, { type: string }>
            return map[sessionID]?.type
          })

        const create = yield* send(f.project, "/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "held stream" }),
        })
        expect(create.status).toBe(200)
        const session = (yield* Effect.promise(() => create.json())) as SessionV1.Info

        yield* f.llm.hold("streamed", deferredAsPromise(gate))
        const promptDone = yield* Deferred.make<void>()
        const promptFiber = yield* Effect.forkDetach(
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
            expect(response.status).toBe(200)
            const body = (yield* Effect.promise(() => response.json())) as { info?: { role?: string } }
            expect(body.info?.role).toBe("assistant")
            yield* Deferred.succeed(promptDone, void 0)
          }),
        )

        yield* Effect.gen(function* () {
          yield* awaitWithTimeout(f.llm.wait(1), "held generation never reached the LLM", "20 seconds")
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const type = yield* listenerStatus(session.id)
              return type === "busy" ? (true as const) : undefined
            }),
            `session ${session.id} never became busy`,
          )

          const urlBefore = listener.url.toString()
          const pidBefore = process.pid

          // POST /global/dispose through the real listener: the response
          // returns BEFORE the held stream is released and before any disposal.
          const disposedRes = yield* send(f.project, "/global/dispose", { method: "POST" })
          expect(disposedRes.status).toBe(200)
          expect(yield* Effect.promise(() => disposedRes.json())).toBe(true)

          // No lifecycle/error signal before release; backend identity unchanged.
          expect(yield* disposed.done).toBe(false)
          expect(yield* instanceDisposed.done).toBe(false)
          expect(yield* sessionError.done).toBe(false)
          expect(yield* isDone(promptDone)).toBe(false)
          expect(listener.url.toString()).toBe(urlBefore)
          expect(process.pid).toBe(pidBefore)

          // Release the held stream: the deferred rebuild drains the reader,
          // disposes the old instance exactly once, and emits one global.disposed.
          yield* Deferred.succeed(gate, void 0)
          yield* awaitWithTimeout(Deferred.await(promptDone), "held stream never completed", "20 seconds")
          yield* Fiber.join(promptFiber)
          yield* awaitWithTimeout(disposed.await, "global disposed event did not arrive", "20 seconds")
          yield* awaitWithTimeout(instanceDisposed.await, "instance disposed event did not arrive", "20 seconds")
          expect(yield* disposed.count).toBe(1)
          expect(yield* instanceDisposed.count).toBe(1)
          expect(yield* sessionError.done).toBe(false)
          yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle", "20 seconds")

          // The listener keeps serving the rebuilt runtime.
          expect(listener.url.toString()).toBe(urlBefore)
          const status = yield* send(f.project, "/session/status")
          expect(status.status).toBe(200)
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Deferred.succeed(gate, void 0)
              yield* Effect.exit(Effect.timeout(Fiber.join(promptFiber), "20 seconds")).pipe(
                Effect.flatMap((exit) =>
                  exit._tag === "Failure" ? Fiber.interrupt(promptFiber).pipe(Effect.asVoid) : Effect.void,
                ),
              )
            }),
          ),
        )
      }),
    120_000,
  )
})

// ─── LOCK-002: organization read-under-fence ─────────────────────────

describe("providerAuth - organization read under fence (LOCK-002)", () => {
  it.live(
    "the org-switch mutate runs under the convergence fence, so its auth read is never a pre-fence snapshot",
    () =>
      Effect.gen(function* () {
        const events = yield* Ref.make<string[]>([])
        yield* Effect.sync(() =>
          seedAuth("kilo", {
            type: "oauth",
            refresh: "refresh-1",
            access: "access-1",
            expires: Date.now() + 86_400_000,
            accountId: "org-1",
          }),
        )
        const beforeRaw = fs.readFileSync(authFile(), "utf-8")

        // Mirrors kilo-gateway.ts exactly: read the current kilo record
        // immediately before the set, preserving the credential and only
        // changing the org. The coordinator runs this mutate UNDER the
        // convergence fence (fresh gate per test — no shared process state).
        const exit = yield* Effect.gen(function* () {
          const svc = yield* Auth.Service
          const gate = yield* GenerationGate.Service
          yield* invalidateAfterProviderAuthChange(
            "kilo",
            Effect.gen(function* () {
              // The coordinator holds the global convergence fence while
              // mutate runs: a reader for any directory would block behind it,
              // so a newer credential cannot land between the read and the set.
              expect(gate.isBarrierActive("/probe")).toBe(true)
              const info = yield* svc.get("kilo").pipe(Effect.orDie)
              if (!info || info.type !== "oauth") return yield* Effect.fail(new Error("kilo auth missing"))
              yield* svc.set("kilo", {
                type: "oauth",
                refresh: info.refresh,
                access: info.access,
                expires: info.expires,
                accountId: "org-2",
              })
            }),
          )
          return yield* svc.get("kilo")
        }).pipe(Effect.provide(coordinatorLayer(events)), Effect.exit)
        if (exit._tag !== "Success") throw new Error("org-switch mutate through the coordinator failed")

        // Only the org changed; the credential was read under the fence.
        const stored = exit.value
        expect(stored?.type === "oauth" && stored.accountId === "org-2").toBe(true)
        expect((stored as { refresh?: string }).refresh).toBe("refresh-1")
        expect((stored as { access?: string }).access).toBe("access-1")
        expect(fs.readFileSync(authFile(), "utf-8")).not.toBe(beforeRaw)
        yield* awaitRebuilds()
      }),
  )

  test("the organization handler reads the kilo credential inside the coordinator mutate (LOCK-002)", async () => {
    const src = await Bun.file(
      path.join(import.meta.dir, "../../../src/kilocode/server/httpapi/handlers/kilo-gateway.ts"),
    ).text()
    const coordinatorIdx = src.indexOf("invalidateAfterProviderAuthChange")
    const readIdx = src.indexOf('auth.get("kilo")')
    expect(coordinatorIdx).toBeGreaterThanOrEqual(0)
    // The current-credential read appears AFTER the coordinator invocation —
    // i.e. inside the mutate under the convergence fence, never before it.
    expect(readIdx).toBeGreaterThan(coordinatorIdx)
  })
})

// ─── LOCK-003: disabled_providers cleanup via root auth set ─────────────

describe("providerAuth - disabled_providers cleanup (LOCK-003)", () => {
  it.live(
    "auth set removes the target ID under one fence: one convergence pass, one ConfigUpdated, unrelated IDs preserved",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture()
        yield* Effect.sync(() => seedAuth("test", { type: "api", key: "old-key" }))
        const before = readGlobalConfig(f.global)
        before.disabled_providers = ["test", "openai"]
        fs.writeFileSync(globalFile(f.global), JSON.stringify(before, null, 2))
        const events = captureEvents()
        probeRebuildRegistration.install()

        try {
          const result = yield* Effect.promise(async () => {
            const response = await request(f.project, "/auth/test", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ type: "api", key: "rotated-key" }),
            })
            return { status: response.status, body: await response.json().catch(() => undefined) }
          })
          expect(result.status).toBe(200)
          expect(result.body).toBe(true)
          yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle", "20 seconds")

          // The disabled list cleaned the target ID only; auth updated.
          const disabled = (readGlobalConfig(f.global).disabled_providers as string[]) ?? []
          expect(disabled).toEqual(["openai"])
          expect((readAuth().test as { key?: string }).key).toBe("rotated-key")

          // Exactly one rebuild registration and one deferred ConfigUpdated
          // event with a transaction id; the rebuild emits exactly one
          // global.disposed after disposal (never a second mutation).
          expect(probeRebuildRegistration.entries().length).toBe(1)
          const updated = configEvents(events.received)
          expect(updated.length).toBe(1)
          expect(updated[0]?.directory).toBe("global")
          expect(typeof updated[0]?.transaction).toBe("string")
          expect(events.received.filter((event) => event.type === Event.Disposed.type).length).toBe(1)
        } finally {
          events.dispose()
          probeRebuildRegistration.uninstall()
        }
      }),
    30_000,
  )

  it.live(
    "a cleanup commit failure restores the exact auth artifact, emits nothing, and releases the fence",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture()
        yield* Effect.sync(() => seedAuth("test", { type: "api", key: "old-key" }))
        const before = readGlobalConfig(f.global)
        before.disabled_providers = ["test", "openai"]
        fs.writeFileSync(globalFile(f.global), JSON.stringify(before, null, 2))
        const authPath = authFile()
        const authOriginal = fs.readFileSync(authPath)
        const authMode = fs.statSync(authPath).mode & 0o777
        const globalOriginal = fs.readFileSync(globalFile(f.global), "utf-8")
        const events = captureEvents()
        probeRebuildRegistration.install()

        try {
          // A read-only global config directory makes the atomic-write commit
          // fail (EACCES) AFTER the auth mutation succeeded.
          yield* Effect.promise(() => fs.promises.chmod(f.global, 0o500))
          const result = yield* Effect.promise(async () => {
            const response = await request(f.project, "/auth/test", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ type: "api", key: "rotated-key" }),
            })
            return { status: response.status, body: await response.json().catch(() => undefined) }
          })
          // A cleanup failure surfaces as a defect (500), never a false 200.
          expect(result.status).toBe(500)
        } finally {
          yield* Effect.promise(() => fs.promises.chmod(f.global, 0o700))
          events.dispose()
          probeRebuildRegistration.uninstall()
        }

        // Compensation restored the exact auth bytes/mode and left the global
        // config untouched; zero events, zero rebuilds, zero disposal.
        expect(Buffer.compare(fs.readFileSync(authPath), authOriginal)).toBe(0)
        expect(fs.statSync(authPath).mode & 0o777).toBe(authMode)
        expect(fs.readFileSync(globalFile(f.global), "utf-8")).toBe(globalOriginal)
        expect(configEvents(events.received).length).toBe(0)
        expect(events.received.some((event) => event.type === Event.Disposed.type)).toBe(false)
        expect(probeRebuildRegistration.entries().length).toBe(0)
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle", "20 seconds")

        // Fence released: a follow-up auth set completes end to end.
        const followup = yield* Effect.promise(async () => {
          const response = await request(f.project, "/auth/test", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "api", key: "rotated-key" }),
          })
          return { status: response.status, body: await response.json().catch(() => undefined) }
        })
        expect(followup.status).toBe(200)
        expect((readAuth().test as { key?: string }).key).toBe("rotated-key")
        const disabled = (readGlobalConfig(f.global).disabled_providers as string[]) ?? []
        expect(disabled).toEqual(["openai"])
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle", "20 seconds")
      }),
    30_000,
  )

})
