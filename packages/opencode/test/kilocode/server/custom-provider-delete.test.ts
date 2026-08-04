/**
 * Phase 3: comprehensive integration tests for atomic custom provider deletion.
 *
 * Drives the real product endpoint `/custom-provider/:providerID/delete` through
 * `Server.Default().app.request()` (scope matrix + failure matrix) and through
 * one principal `Server.listen` (held-stream lifecycle), with real Auth storage
 * and valid custom-provider npm packages. No deletion implementation is mocked
 * (LOCK-001).
 *
 * Coverage:
 * 1. Scope matrix (LOCK-003): global-only, project-only, global+project,
 *    project-custom + same-ID global non-custom (global preserved),
 *    global-custom + project non-custom (project preserved), nonexistent and
 *    built-in/non-custom rejection before any auth/config/cache/event mutation.
 * 2. Held stream (LOCK-004/005): deletion returns HTTP 200 and persists global/
 *    project files + Auth removal + ModelCache invalidation while a held
 *    generation on the deleted provider stays active; no `session.error`,
 *    `server.instance.disposed`, or `global.disposed` before release; backend
 *    PID/listener identity unchanged; exactly one post-release disposal/rebuild;
 *    the stream completes with token continuity; next request state excludes the
 *    deleted custom scope. Progression uses the LLM hold Deferred and event
 *    latches — never arbitrary sleep.
 * 3. Failure matrix (LOCK-006): second-scope commit failure restores every
 *    committed target with zero events and a released fence; auth-removal
 *    failure compensates config and never touches cache/events; interruption
 *    cleans the fence and lock artifacts; the structured `not-custom` 400
 *    preserves code/message/detail. Cache-clear failure is impossible to
 *    trigger without weakening production (ModelCache.clear is pure in-memory
 *    `Effect.all` over sync detach ops), so its coverage is static: the
 *    compensation it would run is byte-identical to the tested auth-removal
 *    compensation, and the clear runs last in the mutate sequence, after the
 *    commits the cache-clear failure would have to restore.
 * 4. Transaction identity (LOCK-007): exactly one logical transaction id across
 *    the final ConfigUpdated events and exactly one disposal for all changed
 *    scopes.
 *
 * Isolation (LOCK-002/008): XDG dirs and KILO_DB come from the preload; each
 * test boots fresh global/project tmpdirs, marks root + `.kilo` plugin deps
 * ready, and every listener/fixture/server/rebuild has an owner/finalizer.
 */

import { afterEach, describe, expect } from "bun:test"
import fs from "fs"
import path from "path"
import { Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import type * as Scope from "effect/Scope"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Server } from "../../../src/server/server"
import { Event } from "../../../src/server/event"
import { GlobalBus } from "../../../src/bus/global"
import { ModelCache } from "../../../src/provider/model-cache"
import { Provider } from "../../../src/provider/provider"
import { AppRuntime, makeAppLayer } from "../../../src/effect/app-runtime"
import { Config } from "../../../src/config/config"
import { KilocodeConfig } from "../../../src/kilocode/config/config"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { execute as executeDelete } from "../../../src/kilocode/server/custom-provider-delete"
import { TestLLMServer } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../../lib/effect"
import { awaitRebuilds } from "../../../src/kilocode/server/config-rebuild"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { provideInstance } from "../../fixture/fixture"
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

async function json<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

// ─── config/auth readers ────────────────────────────────────────────────

async function seedGlobalConfig(dir: string, extra?: Record<string, unknown>) {
  await Bun.write(
    path.join(dir, "kilo.jsonc"),
    JSON.stringify({ $schema: "https://app.kilo.ai/config.json", permission: { bash: "allow" }, ...extra }, null, 2),
  )
  // LOCK-003 fixture leak fix: Global.Path.config is the first
  // ConfigPaths.directories entry, so booted instances run a detached
  // `Npm.install("@kilocode/plugin")` into it unless the stub marks deps ready.
  await markPluginDependenciesReady(dir)
}

function globalFile(dir: string): string {
  for (const name of ["kilo.jsonc", "kilo.json"]) {
    const fp = path.join(dir, name)
    if (fs.existsSync(fp)) return fp
  }
  throw new Error(`No global config file found in ${dir}`)
}

function readGlobalConfig(dir: string): Record<string, unknown> {
  const raw = fs.readFileSync(globalFile(dir), "utf-8")
  return JSON.parse(raw) as Record<string, unknown>
}

function readProjectConfig(dir: string): Record<string, unknown> {
  for (const sub of [".kilo", ".kilocode"]) {
    for (const name of ["kilo.jsonc", "kilo.json"]) {
      const fp = path.join(dir, sub, name)
      try {
        const raw = fs.readFileSync(fp, "utf-8")
        return JSON.parse(raw) as Record<string, unknown>
      } catch {
        // continue
      }
    }
  }
  for (const name of ["opencode.jsonc", "opencode.json", "kilo.jsonc", "kilo.json"]) {
    const fp = path.join(dir, name)
    try {
      const raw = fs.readFileSync(fp, "utf-8")
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      // continue
    }
  }
  return {}
}

function projectFile(dir: string): string {
  for (const sub of [".kilo", ".kilocode"]) {
    for (const name of ["kilo.jsonc", "kilo.json"]) {
      const fp = path.join(dir, sub, name)
      if (fs.existsSync(fp)) return fp
    }
  }
  for (const name of ["opencode.jsonc", "opencode.json", "kilo.jsonc", "kilo.json"]) {
    const fp = path.join(dir, name)
    if (fs.existsSync(fp)) return fp
  }
  throw new Error(`No project config file found in ${dir}`)
}

/** The `provider.<id>` entry of a parsed config file, or undefined. */
function providerEntry(cfg: Record<string, unknown>, id: string): unknown {
  const providers = cfg.provider
  if (!providers || typeof providers !== "object") return undefined
  return (providers as Record<string, unknown>)[id]
}

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

// ─── provider entries ───────────────────────────────────────────────────

type Entry = (url: string) => Record<string, unknown>

/** Valid custom provider entry (accepted npm package) pointed at the test LLM. */
const custom: Entry = (url) => ({ ...testProviderConfig(url).provider.test, npm: "@ai-sdk/openai-compatible" })

/** Same-ID entry whose npm package is NOT one of the accepted custom packages. */
const nonCustom: Entry = (url) => ({ ...testProviderConfig(url).provider.test, npm: "some-other-package" })

// ─── event helpers (LOCK-007) ───────────────────────────────────────────

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
    const dispose = () => GlobalBus.removeListener("event", handler)
    ownedListeners.add(dispose)
    return {
      await: Deferred.await(deferred),
      done: isDone(deferred),
      dispose,
    }
  })

/** Event counter gate: resolves when `n` matching events have arrived. */
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

type Fixture = { llm: TestLLMServer["Service"]; project: string; global: string }

/** Fresh global-config tmpdir + git project tmpdir, each optionally carrying a
 * `provider.test` entry for the supplied scope. Global.Path.config is bound to
 * the global dir before any request, and both dirs have their plugin deps
 * stubbed so no detached install ever races teardown (LOCK-002/003). */
const makeFixture = (input: { global?: Entry; project?: Entry }): Effect.Effect<Fixture, unknown, TestLLMServer | Scope.Scope> =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const global = await tmpdir({ retain: true })
        await seedGlobalConfig(global.path, input.global ? { provider: { test: input.global(llm.url) } } : undefined)
        const project = await tmpdir({
          git: true,
          retain: true,
          config: input.project ? { provider: { test: input.project(llm.url) } } : undefined,
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
    dirs.add(result.project)
    return result
  })

const deleteVia = (dir: string | undefined, providerID: string) =>
  Effect.promise(async () => {
    const response = await request(dir, `/custom-provider/${providerID}/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    })
    const body = (await response.json().catch(() => undefined)) as
      | { success?: boolean; code?: string; message?: string; detail?: string; name?: string }
      | undefined
    return { status: response.status, body }
  })

const configEvents = (received: Array<{ type: string; directory?: string; transaction?: string }>) =>
  received.filter((event) => event.type === Event.ConfigUpdated.type)

// ─── LOCK-003: scope matrix ─────────────────────────────────────────────

describe("customProviderDelete - scope matrix (LOCK-003)", () => {
  it.live(
    "global-only custom: deletion clears the global file and auth, leaves the project untouched",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: custom })
        yield* Effect.sync(() => seedAuth("test"))
        expect(providerEntry(readGlobalConfig(f.global), "test")).toBeDefined()
        const beforeProject = readProjectConfig(f.project)

        const result = yield* deleteVia(f.project, "test")
        expect(result.status).toBe(200)
        expect(result.body?.success).toBe(true)
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")

        expect(providerEntry(readGlobalConfig(f.global), "test")).toBeUndefined()
        expect(readProjectConfig(f.project)).toEqual(beforeProject)
        expect(readAuth().test).toBeUndefined()
      }),
    30_000,
  )

  it.live(
    "project-only custom: deletion clears the project file and auth, leaves the global file untouched",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ project: custom })
        yield* Effect.sync(() => seedAuth("test"))
        expect(providerEntry(readProjectConfig(f.project), "test")).toBeDefined()
        const beforeGlobalRaw = fs.readFileSync(globalFile(f.global), "utf-8")

        const result = yield* deleteVia(f.project, "test")
        expect(result.status).toBe(200)
        expect(result.body?.success).toBe(true)
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")

        expect(providerEntry(readProjectConfig(f.project), "test")).toBeUndefined()
        expect(fs.readFileSync(globalFile(f.global), "utf-8")).toBe(beforeGlobalRaw)
        expect(readAuth().test).toBeUndefined()
      }),
    30_000,
  )

  it.live(
    "global+project custom: deletion clears both scopes and auth with one logical transaction id",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: custom, project: custom })
        yield* Effect.sync(() => seedAuth("test"))
        const events = captureEvents()

        // LOCK-004: the web() app shares the memoized ModelCache with
        // AppRuntime, so the deletion's cache clear is observable.
        yield* Effect.promise(() =>
          AppRuntime.runPromise(ModelCache.Service.use((svc) => svc.fetch("test"))),
        )
        const cacheBefore = yield* Effect.promise(() =>
          AppRuntime.runPromise(ModelCache.Service.use((svc) => svc.get("test"))),
        )
        expect(cacheBefore).toBeDefined()

        try {
          const result = yield* deleteVia(f.project, "test")
          expect(result.status).toBe(200)
          expect(result.body?.success).toBe(true)
          yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")

          expect(providerEntry(readGlobalConfig(f.global), "test")).toBeUndefined()
          expect(providerEntry(readProjectConfig(f.project), "test")).toBeUndefined()
          expect(readAuth().test).toBeUndefined()
          const cacheAfter = yield* Effect.promise(() =>
            AppRuntime.runPromise(ModelCache.Service.use((svc) => svc.get("test"))),
          )
          expect(cacheAfter).toBeUndefined()

          // LOCK-007: exactly one ConfigUpdated per committed scope (global +
          // project), all sharing the same non-empty logical transaction id.
          const updated = configEvents(events.received)
          expect(updated.length).toBe(2)
          expect(updated.map((event) => event.directory).sort()).toEqual(["global", f.project].sort())
          const ids = updated.map((event) => event.transaction)
          expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true)
          expect(new Set(ids).size).toBe(1)
        } finally {
          events.dispose()
        }
      }),
    30_000,
  )

  it.live(
    "project custom + same-ID global non-custom: global entry is preserved byte-for-byte",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: nonCustom, project: custom })
        yield* Effect.sync(() => seedAuth("test"))
        const beforeGlobalRaw = fs.readFileSync(globalFile(f.global), "utf-8")

        const result = yield* deleteVia(f.project, "test")
        expect(result.status).toBe(200)
        expect(result.body?.success).toBe(true)
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")

        // Project scope (custom) removed; the same-ID global entry is NOT a
        // target because its npm package is not custom — the file is untouched.
        expect(providerEntry(readProjectConfig(f.project), "test")).toBeUndefined()
        expect(fs.readFileSync(globalFile(f.global), "utf-8")).toBe(beforeGlobalRaw)
        expect(providerEntry(readGlobalConfig(f.global), "test")).toBeDefined()
        expect(readAuth().test).toBeUndefined()
      }),
    30_000,
  )

  it.live(
    "global custom + project non-custom: project entry is preserved byte-for-byte",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: custom, project: nonCustom })
        yield* Effect.sync(() => seedAuth("test"))
        const beforeProjectRaw = fs.readFileSync(projectFile(f.project), "utf-8")

        const result = yield* deleteVia(f.project, "test")
        expect(result.status).toBe(200)
        expect(result.body?.success).toBe(true)
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")

        expect(providerEntry(readGlobalConfig(f.global), "test")).toBeUndefined()
        expect(fs.readFileSync(projectFile(f.project), "utf-8")).toBe(beforeProjectRaw)
        expect(providerEntry(readProjectConfig(f.project), "test")).toBeDefined()
        expect(readAuth().test).toBeUndefined()
      }),
    30_000,
  )

  it.live(
    "nonexistent provider rejects with structured not-custom 400 before any mutation",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: custom })
        yield* Effect.sync(() => seedAuth("test"))
        const beforeGlobalRaw = fs.readFileSync(globalFile(f.global), "utf-8")
        const beforeAuthRaw = fs.readFileSync(authFile(), "utf-8")
        const events = captureEvents()

        try {
          const result = yield* deleteVia(f.project, "nonexistent")
          expect(result.status).toBe(400)
          expect(result.body?.code).toBe("not-custom")
          expect(result.body?.message).toContain("nonexistent")
          expect(result.body?.detail).toContain("providerID: nonexistent")

          expect(fs.readFileSync(globalFile(f.global), "utf-8")).toBe(beforeGlobalRaw)
          expect(fs.readFileSync(authFile(), "utf-8")).toBe(beforeAuthRaw)
          expect(configEvents(events.received).length).toBe(0)
        } finally {
          events.dispose()
        }
      }),
    30_000,
  )

  it.live(
    "built-in ID and non-custom entries in both scopes reject before any mutation",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: nonCustom, project: nonCustom })
        yield* Effect.sync(() => seedAuth("test"))
        const beforeGlobalRaw = fs.readFileSync(globalFile(f.global), "utf-8")
        const beforeProjectRaw = fs.readFileSync(projectFile(f.project), "utf-8")
        const beforeAuthRaw = fs.readFileSync(authFile(), "utf-8")

        // An actual built-in provider ID is not present in config at all.
        const builtIn = yield* deleteVia(f.project, "openai")
        expect(builtIn.status).toBe(400)
        expect(builtIn.body?.code).toBe("not-custom")

        // The same-ID entry whose npm package is non-custom in both scopes.
        const sameId = yield* deleteVia(f.project, "test")
        expect(sameId.status).toBe(400)
        expect(sameId.body?.code).toBe("not-custom")
        expect(sameId.body?.message).toContain("test")
        expect(sameId.body?.detail).toContain("providerID: test")

        expect(fs.readFileSync(globalFile(f.global), "utf-8")).toBe(beforeGlobalRaw)
        expect(fs.readFileSync(projectFile(f.project), "utf-8")).toBe(beforeProjectRaw)
        expect(fs.readFileSync(authFile(), "utf-8")).toBe(beforeAuthRaw)
      }),
    30_000,
  )

  it.live(
    "route-matching but invalid provider ID (uppercase) rejects with structured validation 400 before any mutation",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: custom })
        yield* Effect.sync(() => seedAuth("test"))
        const beforeGlobalRaw = fs.readFileSync(globalFile(f.global), "utf-8")
        const beforeAuthRaw = fs.readFileSync(authFile(), "utf-8")
        const events = captureEvents()

        try {
          // "Test" passes the route (single path segment) but violates the
          // shared predicate /^[a-z0-9][a-z0-9-_]*$/ enforced backend-side
          // (LOCK-002), so it rejects before any fence/lock/auth/config work.
          const result = yield* deleteVia(f.project, "Test")
          expect(result.status).toBe(400)
          expect(result.body?.code).toBe("validation")
          expect(result.body?.message).toContain("Test")

          expect(fs.readFileSync(globalFile(f.global), "utf-8")).toBe(beforeGlobalRaw)
          expect(fs.readFileSync(authFile(), "utf-8")).toBe(beforeAuthRaw)
          expect(configEvents(events.received).length).toBe(0)
        } finally {
          events.dispose()
        }
      }),
    30_000,
  )
})

// ─── LOCK-003: deferred final events ─────────────────────────────────────

describe("customProviderDelete - deferred final events (LOCK-003)", () => {
  it.live(
    "execute returns the deferred ConfigUpdated events; nothing is emitted until the response boundary runs them",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: custom, project: custom })
        yield* Effect.sync(() => seedAuth("test"))
        const events = captureEvents()

        try {
          // Direct service invocation (no HTTP): execute must NOT publish any
          // ConfigUpdated event — the transaction events are deferred into the
          // result until the caller's response acknowledgement boundary, after
          // persistence and rebuild registration are complete.
          const result = yield* Effect.promise(() =>
            AppRuntime.runPromise(
              provideInstance(f.project)(executeDelete({ providerID: "test", directory: f.project })),
            ),
          )
          expect(result.success).toBe(true)
          expect(configEvents(events.received).length).toBe(0)

          // Running the deferred events publishes exactly one ConfigUpdated per
          // committed scope, all sharing one logical transaction id.
          yield* Effect.promise(() => AppRuntime.runPromise(result.events))
          const updated = configEvents(events.received)
          expect(updated.length).toBe(2)
          expect(updated.map((event) => event.directory).sort()).toEqual(["global", f.project].sort())
          const ids = updated.map((event) => event.transaction)
          expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true)
          expect(new Set(ids).size).toBe(1)

          // Persistence is complete before the deferred events are observable.
          expect(providerEntry(readGlobalConfig(f.global), "test")).toBeUndefined()
          expect(providerEntry(readProjectConfig(f.project), "test")).toBeUndefined()
          expect(readAuth().test).toBeUndefined()
          yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")
        } finally {
          events.dispose()
        }
      }),
    30_000,
  )
})

// ─── LOCK-004/005/007: held stream through the real listener ────────────

describe("customProviderDelete - held stream + real listener (LOCK-004/005)", () => {
  it.live(
    "deletion returns 200 and persists before release; stream completes with exactly one disposal/rebuild",
    (): Effect.Effect<void, unknown, TestLLMServer | Scope.Scope> =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: custom, project: custom })
        yield* Effect.sync(() => seedAuth("test"))
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1" })),
          (value) => Effect.promise(() => value.stop(true)).pipe(Effect.ignore),
        )
        const gate = yield* Deferred.make<void>()
        const disposed = yield* eventCountLatch(Event.Disposed.type)
        const instanceDisposed = yield* eventCountLatch("server.instance.disposed", f.project)
        const sessionError = yield* eventLatch("session.error")
        const events = captureEvents()
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

        // LOCK-006: gate release and prompt fiber join/interrupt live in an
        // OUTER finalizer covering every assertion after the hold starts. A
        // mid-test assertion failure therefore cannot hang teardown on the
        // held stream: the finalizer always releases the gate (idempotent)
        // and joins the prompt fiber, interrupting it if it never completes.
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
          // deletion + rebuild (LOCK-004).
          const urlBefore = listener.url.toString()
          const pidBefore = process.pid

          // Deletion through the real listener: the response returns BEFORE the
          // held stream is released and before any disposal.
          const deleted = yield* send(f.project, "/custom-provider/test/delete", {
            method: "POST",
            headers: { "content-type": "application/json" },
          })
          expect(deleted.status).toBe(200)
          const deletedBody = (yield* Effect.promise(() => deleted.json())) as { success?: boolean }
          expect(deletedBody.success).toBe(true)

          // Persistence is immediate: files and auth are gone while the stream is
          // still in flight. (ModelCache invalidation is asserted through the
          // shared memoized app path in the scope matrix; the listener app layer
          // is freshly rebuilt, so its cache is not observable from AppRuntime.)
          expect(providerEntry(readGlobalConfig(f.global), "test")).toBeUndefined()
          expect(providerEntry(readProjectConfig(f.project), "test")).toBeUndefined()
          expect(readAuth().test).toBeUndefined()

          // No lifecycle/error signal before release.
          expect(yield* disposed.done).toBe(false)
          expect(yield* instanceDisposed.done).toBe(false)
          expect(yield* sessionError.done).toBe(false)
          expect(yield* isDone(promptDone)).toBe(false)

          // LOCK-003 ordering proof: the final ConfigUpdated events are
          // already observable with the response, but the rebuild is still
          // draining (registered, not completed) — the held stream keeps the
          // disposal pending. Events therefore fire only after persistence AND
          // rebuild registration (response acknowledgement boundary), never
          // before either.
          const updated = configEvents(events.received)
          expect(updated.length).toBe(2)
          expect(updated.map((event) => event.directory).sort()).toEqual(["global", f.project].sort())
          const ids = updated.map((event) => event.transaction)
          expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true)
          expect(new Set(ids).size).toBe(1)

          // Backend identity unchanged.
          expect(listener.url.toString()).toBe(urlBefore)
          expect(process.pid).toBe(pidBefore)

          // Release the held stream: the deferred rebuild drains the reader and
          // disposes the old instance exactly once. Deferred.succeed is
          // idempotent, so this is safe even if a prior assertion failed.
          yield* Deferred.succeed(gate, void 0)
          yield* awaitWithTimeout(Deferred.await(promptDone), "held stream never completed", "20 seconds")
          yield* Fiber.join(promptFiber)
          yield* awaitWithTimeout(disposed.await, "global disposed event did not arrive", "20 seconds")
          yield* awaitWithTimeout(instanceDisposed.await, "instance disposed event did not arrive", "20 seconds")
          expect(yield* disposed.count).toBe(1)
          expect(yield* instanceDisposed.count).toBe(1)
          expect(yield* sessionError.done).toBe(false)
          yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle", "20 seconds")

          // The listener keeps serving the rebuilt runtime; the next request
          // state excludes the deleted custom scope.
          expect(listener.url.toString()).toBe(urlBefore)
          const overlay = yield* send(f.project, "/config/overlay?scope=project")
          expect(overlay.status).toBe(200)
          const overlayBody = (yield* Effect.promise(() => overlay.json())) as {
            effective: { provider?: Record<string, unknown> }
          }
          expect(providerEntry(overlayBody.effective, "test")).toBeUndefined()
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Deferred.succeed(gate, void 0)
              yield* Effect.exit(Effect.timeout(Fiber.join(promptFiber), "20 seconds")).pipe(
                Effect.flatMap((exit) =>
                  exit._tag === "Failure"
                    ? Fiber.interrupt(promptFiber).pipe(Effect.asVoid)
                    : Effect.void,
                ),
              )
            }),
          ),
        )
      }),
    120_000,
  )
})

// ─── LOCK-006: failure matrix ───────────────────────────────────────────

describe("customProviderDelete - failure matrix (LOCK-006)", () => {
  it.live(
    "second-scope commit failure restores every committed target, emits nothing, and releases the fence",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: custom })
        // Seed the project target inside `.kilo` (the preferred update target),
        // then make the dir read-only so the SECOND commit (project) fails
        // after the global commit already succeeded.
        const kiloDir = path.join(f.project, ".kilo")
        yield* Effect.promise(async () => {
          await fs.promises.mkdir(kiloDir, { recursive: true })
          await markPluginDependenciesReady(kiloDir)
          const projectFileRaw = path.join(kiloDir, "kilo.jsonc")
          const projectOriginal = JSON.stringify(
            { $schema: "https://app.kilo.ai/config.json", provider: { test: custom(f.llm.url) } },
            null,
            2,
          )
          await Bun.write(projectFileRaw, projectOriginal)
          await fs.promises.chmod(kiloDir, 0o500)
        })
        yield* Effect.sync(() => seedAuth("test"))
        const globalOriginal = fs.readFileSync(globalFile(f.global), "utf-8")
        const projectOriginal = fs.readFileSync(path.join(kiloDir, "kilo.jsonc"), "utf-8")
        const authOriginal = fs.readFileSync(authFile())
        const events = captureEvents()

        try {
          const result = yield* deleteVia(f.project, "test")
          // A failed commit surfaces as a defect (500), never a false 200.
          expect(result.status).toBe(500)
        } finally {
          events.dispose()
        }
        yield* Effect.promise(() => fs.promises.chmod(kiloDir, 0o700))

        // Every committed target restored exactly; auth/cache/events untouched.
        expect(fs.readFileSync(globalFile(f.global), "utf-8")).toBe(globalOriginal)
        expect(fs.readFileSync(path.join(kiloDir, "kilo.jsonc"), "utf-8")).toBe(projectOriginal)
        expect(Buffer.compare(fs.readFileSync(authFile()), authOriginal)).toBe(0)
        expect(configEvents(events.received).length).toBe(0)
        expect(events.received.some((event) => event.type === Event.Disposed.type)).toBe(false)

        // Fence released: a follow-up deletion completes normally.
        const followup = yield* deleteVia(f.project, "test")
        expect(followup.status).toBe(200)
        expect(providerEntry(readGlobalConfig(f.global), "test")).toBeUndefined()
        expect(providerEntry(readProjectConfig(f.project), "test")).toBeUndefined()
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")
      }),
    30_000,
  )

  it.live(
    "auth removal failure compensates config, never touches cache/events, and releases the fence",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: custom, project: custom })
        yield* Effect.sync(() => seedAuth("test", { type: "api", key: "test-key" }))
        // Seed the cache so a leaked clear would be observable.
        yield* Effect.promise(() =>
          AppRuntime.runPromise(ModelCache.Service.use((svc) => svc.fetch("test"))),
        )
        const authPath = authFile()
        const globalOriginal = fs.readFileSync(globalFile(f.global), "utf-8")
        const projectOriginal = fs.readFileSync(projectFile(f.project), "utf-8")
        const authOriginal = fs.readFileSync(authPath)
        const events = captureEvents()

        try {
          // The auth file is owned by this process, so making the FILE read-only
          // fails auth.remove (writeFileString gets EACCES) while config commits
          // (config dirs) and cache clears (memory) remain functional.
          yield* Effect.promise(() => fs.promises.chmod(authPath, 0o400))
          const result = yield* deleteVia(f.project, "test")
          expect(result.status).toBe(500)
        } finally {
          events.dispose()
        }
        yield* Effect.promise(() => fs.promises.chmod(authPath, 0o600))

        // Compensation restored both committed config targets and left auth,
        // cache, and events untouched.
        expect(fs.readFileSync(globalFile(f.global), "utf-8")).toBe(globalOriginal)
        expect(fs.readFileSync(projectFile(f.project), "utf-8")).toBe(projectOriginal)
        expect(Buffer.compare(fs.readFileSync(authPath), authOriginal)).toBe(0)
        const cacheAfter = yield* Effect.promise(() =>
          AppRuntime.runPromise(ModelCache.Service.use((svc) => svc.get("test"))),
        )
        expect(cacheAfter).toBeDefined()
        expect(configEvents(events.received).length).toBe(0)
        expect(events.received.some((event) => event.type === Event.Disposed.type)).toBe(false)

        // Fence released: the follow-up deletion succeeds end to end.
        const followup = yield* deleteVia(f.project, "test")
        expect(followup.status).toBe(200)
        expect(providerEntry(readGlobalConfig(f.global), "test")).toBeUndefined()
        expect(providerEntry(readProjectConfig(f.project), "test")).toBeUndefined()
        expect(readAuth().test).toBeUndefined()
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")
      }),
    30_000,
  )

  it.live(
    "cache-clear failure restores config AND the exact auth file bytes/mode, emits nothing, releases the fence",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: custom, project: custom })
        yield* Effect.sync(() => seedAuth("test"))
        const authPath = authFile()
        const globalOriginal = fs.readFileSync(globalFile(f.global), "utf-8")
        const projectOriginal = fs.readFileSync(projectFile(f.project), "utf-8")
        const authOriginal = fs.readFileSync(authPath)
        const authMode = fs.statSync(authPath).mode & 0o777
        const events = captureEvents()

        // LOCK-005: executable cache-clear failure via Effect layer injection
        // of a failing ModelCache.Service at the canonical AppLayer boundary.
        // The real deletion executor, config, auth, gate, and instance-store
        // graph is untouched — this is a test service substitution, not a mock
        // of deletion logic. `clear` fails once (forcing the compensation to
        // run after a DURABLE auth removal), then succeeds for the follow-up.
        let fail = true
        const failingCache = Layer.succeed(
          ModelCache.Service,
          ModelCache.Service.of({
            getFailure: () => Effect.succeed(undefined),
            failedProviders: () => Effect.succeed([]),
            get: () => Effect.succeed(undefined),
            fetch: () => Effect.die(new Error("cache fetch should not run during deletion")),
            refresh: () => Effect.die(new Error("cache refresh should not run during deletion")),
            clear: () => (fail ? Effect.die(new Error("simulated cache-clear failure")) : Effect.void),
          }),
        )
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() =>
            Server.listen({
              hostname: "127.0.0.1",
              port: 0,
              appLayer: makeAppLayer(Provider.defaultModels, Provider.defaultLayer, failingCache),
            }),
          ),
          (value) => Effect.promise(() => value.stop(true)).pipe(Effect.ignore),
        )
        const base = listener.url.toString().replace(/\/$/, "")
        const send = (input: string, init?: RequestInit) =>
          Effect.promise(async () => {
            const response = await fetch(`${base}${input}`, {
              ...init,
              headers: { "x-kilo-directory": f.project, ...init?.headers },
            })
            return response
          })

        try {
          const first = yield* send("/custom-provider/test/delete", { method: "POST" })
          // A cache-clear failure surfaces as a defect (500), never a false 200.
          expect(first.status).toBe(500)

          // Compensation restored every committed config target AND the exact
          // auth file bytes/mode (the removal was durable before clear failed);
          // no ConfigUpdated/disposed events were emitted.
          expect(fs.readFileSync(globalFile(f.global), "utf-8")).toBe(globalOriginal)
          expect(fs.readFileSync(projectFile(f.project), "utf-8")).toBe(projectOriginal)
          expect(Buffer.compare(fs.readFileSync(authPath), authOriginal)).toBe(0)
          expect(fs.statSync(authPath).mode & 0o777).toBe(authMode)
          expect(configEvents(events.received).length).toBe(0)
          expect(events.received.some((event) => event.type === Event.Disposed.type)).toBe(false)

          // Fence released: with the cache healthy, the follow-up deletion
          // completes end to end (same listener, same backend).
          fail = false
          const followup = yield* send("/custom-provider/test/delete", { method: "POST" })
          expect(followup.status).toBe(200)
          const followupBody = (yield* Effect.promise(() => followup.json())) as { success?: boolean }
          expect(followupBody.success).toBe(true)
          yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")
          expect(providerEntry(readGlobalConfig(f.global), "test")).toBeUndefined()
          expect(providerEntry(readProjectConfig(f.project), "test")).toBeUndefined()
          expect(readAuth().test).toBeUndefined()
        } finally {
          events.dispose()
        }
      }),
    60_000,
  )

  it.live(
    "interrupted deletion cleans the fence and lock artifacts; the next deletion works",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: custom, project: custom })
        yield* Effect.sync(() => seedAuth("test"))
        const globalKey = KilocodeConfig.configDiscoveryGlobalKey()

        // LOCK-001: the deletion persists under the global discovery flock.
        // Hold the flock so the deletion blocks at the interruptible flock
        // wait — a convergence fence never blocks a save, so the flock is the
        // only interruptible point the interruption can land on.
        const config = yield* Effect.promise(() =>
          AppRuntime.runPromise(Config.Service.use((svc) => Effect.succeed(svc))),
        )
        const lockGate = yield* Effect.promise(() => AppRuntime.runPromise(Deferred.make<void>()))
        const holder = AppRuntime.runFork(config.withLock(globalKey, Deferred.await(lockGate)))

        // Fork the deletion Effect directly so interruption propagates into the
        // flock wait (a request-harness promise cannot be interrupted).
        const tx = AppRuntime.runFork(
          provideInstance(f.project)(executeDelete({ providerID: "test" })),
        )

        // LOCK-005: every path (pass AND assertion failure) releases the held
        // flock. The holder is released by the finalizer before the follow-up
        // deletion runs, so a mid-test failure can never leak the flock into
        // the next test.
        yield* Effect.gen(function* () {
          // The deletion must still be blocked on the flock: awaiting it times
          // out (Exit.Failure), proving it did not complete (and cannot commit).
          const blocked = yield* Effect.promise(() =>
            AppRuntime.runPromise(Effect.exit(Effect.timeout(Fiber.await(tx), "500 millis"))),
          )
          expect(blocked._tag).toBe("Failure")

          // Interrupt: the flock wait is interruptible, so this returns
          // promptly (Exit.Success) and leaves no lock or temp artifacts.
          const interrupted = yield* Effect.promise(() =>
            AppRuntime.runPromise(Effect.exit(Effect.timeout(Fiber.interrupt(tx), "5 seconds"))),
          )
          expect(interrupted._tag).toBe("Success")

          // No temp files anywhere in the config directories.
          const tmpFiles = [
            ...fs.readdirSync(f.global).filter((name) => name.includes(".tmp")),
            ...fs.readdirSync(f.project).filter((name) => name.includes(".tmp")),
            ...(fs.existsSync(path.join(f.project, ".kilo"))
              ? fs.readdirSync(path.join(f.project, ".kilo")).filter((name) => name.includes(".tmp"))
              : []),
          ]
          expect(tmpFiles.length).toBe(0)
        }).pipe(
          Effect.ensuring(
            Effect.promise(async () => {
              await Effect.runPromise(Deferred.succeed(lockGate, void 0))
              await Effect.runPromise(Fiber.join(holder)).catch(() => undefined)
            }),
          ),
        )

        // The holder flock is released (by the finalizer above): the next
        // deletion completes normally and leaves NO lock dirs behind (holder
        // release + deletion release both clean).
        const followup = yield* deleteVia(f.project, "test")
        expect(followup.status).toBe(200)
        expect(providerEntry(readGlobalConfig(f.global), "test")).toBeUndefined()
        expect(providerEntry(readProjectConfig(f.project), "test")).toBeUndefined()
        expect(readAuth().test).toBeUndefined()
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")

        // The global config lock is fully released: the specific lock dir no
        // longer exists. (The shared lock root may hold other in-flight locks
        // from the booted instance, so assert by key.)
        const lockRoot = path.join(Global.Path.state, "locks")
        const globalLockName = Hash.fast(globalKey) + ".lock"
        expect(fs.existsSync(path.join(lockRoot, globalLockName))).toBe(false)
      }),
    30_000,
  )
})
