/**
 * Phase 4: comprehensive integration tests for atomic custom provider save.
 *
 * Drives the real product endpoint `/custom-provider/:providerID/save` through
 * `Server.Default().app.request()` (scope matrix + failure matrix) and through
 * one principal `Server.listen` (held-stream lifecycle), with real Auth storage
 * and valid custom-provider npm packages. No save implementation is mocked
 * (LOCK-001).
 *
 * Coverage:
 * 1. Success matrix (LOCK-002/005): create with auth set, update with auth
 *    preserve (auth untouched), update with auth set/clear, null deletions for
 *    removed models/variants/reasoning, disabled_providers cleanup preserving
 *    unrelated IDs, env-based providers preserve auth. Exactly one
 *    ConfigUpdated event with one logical transaction id;
 *    rebuild settles.
 * 2. No-op semantics (LOCK-006): identical config + auth preserve returns
 *    success with zero events and zero rebuild registrations; an auth set on
 *    an identical config counts as a change — one rebuild, one event, auth updated.
 * 3. Rejection matrix (LOCK-002): non-custom same-ID provider cannot be
 *    overwritten (structured 400 not-custom before any mutation); invalid
 *    schema (missing models / bad npm / non-http baseURL) and invalid provider
 *    ID reject before any mutation.
 * 4. Held stream (LOCK-003/005): save returns 200 and persists global config +
 *    auth while a held generation on the saved provider stays active; no
 *    `session.error`, `server.instance.disposed`, or `global.disposed` before
 *    release; backend PID/listener identity unchanged; exactly one post-release
 *    disposal/rebuild; the stream completes with token continuity; the next
 *    request state reflects the saved config. Progression uses the LLM hold
 *    Deferred and event latches — never arbitrary sleep.
 * 5. Failure matrix (LOCK-004/006): config commit failure restores every
 *    committed artifact with zero events and a released fence; auth-set
 *    failure compensates config AND the exact auth file bytes/mode and never
 *    emits events; interruption cleans
 *    the fence and lock artifacts.
 * 6. Deferred events (LOCK-003): direct `execute` returns the deferred
 *    ConfigUpdated event; nothing is emitted until the caller runs it; a
 *    semantic no-op returns success with a no-op event effect.
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
import { Provider } from "../../../src/provider/provider"
import { AppRuntime, makeAppLayer } from "../../../src/effect/app-runtime"
import { Config } from "../../../src/config/config"
import { KilocodeConfig } from "../../../src/kilocode/config/config"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { execute as executeSave } from "../../../src/kilocode/server/custom-provider-save"
import type { CustomProviderSaveAuth, CustomProviderSaveConfig } from "../../../src/kilocode/server/custom-provider-save"
import { awaitRebuilds, probeRebuildRegistration } from "../../../src/kilocode/server/config-rebuild"
import { TestLLMServer } from "../../lib/llm-server"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../../lib/effect"
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
  probeRebuildRegistration.uninstall()
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

// ─── save request builders ──────────────────────────────────────────────

type AuthMode = { mode: "preserve" } | { mode: "set"; key: string } | { mode: "clear" }

/** Valid save request config (backend schema-compatible). */
const saveConfig = (url: string, extra?: Record<string, unknown>): Record<string, unknown> => ({
  npm: "@ai-sdk/openai-compatible",
  name: "Test",
  options: { baseURL: url },
  models: { "test-model": { name: "Test Model" } },
  ...extra,
})

const authSet: AuthMode = { mode: "set", key: "test-key" }
const authPreserve: AuthMode = { mode: "preserve" }
const authClear: AuthMode = { mode: "clear" }

const saveVia = (dir: string | undefined, providerID: string, body: { config: unknown; auth: AuthMode }) =>
  Effect.promise(async () => {
    const response = await request(dir, `/custom-provider/${providerID}/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const parsed = (await response.json().catch(() => undefined)) as
      | { success?: boolean; code?: string; message?: string; detail?: string; name?: string }
      | undefined
    return { status: response.status, body: parsed }
  })

// ─── event helpers (LOCK-003/007) ───────────────────────────────────────

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

type Fixture = { llm: TestLLMServer["Service"]; project: string; global: string }

/** Fresh global-config tmpdir + git project tmpdir, each optionally carrying a
 * `provider.test` entry for the supplied scope. Entry builders receive the
 * test LLM url. Global.Path.config is bound to the global dir before any
 * request, and both dirs have their plugin deps stubbed so no detached install
 * ever races teardown (LOCK-002/003). */
const makeFixture = (input: {
  global?: (url: string) => Record<string, unknown>
  project?: (url: string) => Record<string, unknown>
}): Effect.Effect<Fixture, unknown, TestLLMServer | Scope.Scope> =>
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

const configEvents = (received: Array<{ type: string; directory?: string; transaction?: string }>) =>
  received.filter((event) => event.type === Event.ConfigUpdated.type)

// ─── LOCK-002/005: success matrix ───────────────────────────────────────

describe("customProviderSave - success matrix (LOCK-002/005)", () => {
  it.live(
    "create with auth set: config persisted, auth stored, disabled cleaned, one transaction event",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({})
        yield* Effect.sync(() => seedAuth("test"))
        // A stale disabled ID is cleaned by the save.
        const before = readGlobalConfig(f.global)
        before.disabled_providers = ["test", "openai"]
        fs.writeFileSync(globalFile(f.global), JSON.stringify(before, null, 2))
        const events = captureEvents()

        try {
          const result = yield* saveVia(f.project, "test", { config: saveConfig(f.llm.url), auth: authSet })
          expect(result.status).toBe(200)
          expect(result.body?.success).toBe(true)
          yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")

          const entry = providerEntry(readGlobalConfig(f.global), "test") as Record<string, unknown>
          expect(entry).toBeDefined()
          expect(entry.npm).toBe("@ai-sdk/openai-compatible")
          expect(entry.name).toBe("Test")
          const disabled = (readGlobalConfig(f.global).disabled_providers as string[]) ?? []
          expect(disabled).toEqual(["openai"])
          expect(readAuth().test).toEqual({ type: "api", key: "test-key" })

          const updated = configEvents(events.received)
          expect(updated.length).toBe(1)
          expect(updated[0]?.directory).toBe("global")
          expect(typeof updated[0]?.transaction).toBe("string")
        } finally {
          events.dispose()
        }
      }),
    30_000,
  )

  it.live(
    "update with auth preserve: config patched, auth file untouched byte-for-byte",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: (url) => saveConfig(url) })
        yield* Effect.sync(() => seedAuth("test"))
        const authOriginal = fs.readFileSync(authFile())
        const events = captureEvents()

        try {
          const result = yield* saveVia(f.project, "test", {
            config: saveConfig("https://new.example/v1", { name: "Updated" }),
            auth: authPreserve,
          })
          expect(result.status).toBe(200)
          expect(result.body?.success).toBe(true)
          yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")

          const entry = providerEntry(readGlobalConfig(f.global), "test") as Record<string, unknown>
          expect(entry.name).toBe("Updated")
          expect((entry.options as Record<string, unknown>).baseURL).toBe("https://new.example/v1")
          // Auth untouched (preserve): byte-exact.
          expect(Buffer.compare(fs.readFileSync(authFile()), authOriginal)).toBe(0)

          const updated = configEvents(events.received)
          expect(updated.length).toBe(1)
          expect(new Set(updated.map((event) => event.transaction)).size).toBe(1)
        } finally {
          events.dispose()
        }
      }),
    30_000,
  )

  it.live(
    "update with auth set overwrites the stored key; update with auth clear removes it",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: (url) => saveConfig(url) })
        yield* Effect.sync(() => seedAuth("test"))

        const set = yield* saveVia(f.project, "test", {
          config: saveConfig(f.llm.url, { name: "Updated" }),
          auth: { mode: "set", key: "new-key" },
        })
        expect(set.status).toBe(200)
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")
        expect(readAuth().test).toEqual({ type: "api", key: "new-key" })

        const cleared = yield* saveVia(f.project, "test", {
          config: saveConfig(f.llm.url, { name: "Updated" }),
          auth: authClear,
        })
        expect(cleared.status).toBe(200)
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")
        expect(readAuth().test).toBeUndefined()
      }),
    30_000,
  )

  it.live(
    "null deletions: removed models/variants/reasoning keys do not persist after save",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({
          global: (url) =>
            saveConfig(url, {
              models: {
                keep: { name: "Keep", reasoning: true, variants: { high: { reasoningEffort: "high" }, low: {} } },
                gone: { name: "Gone" },
              },
            }),
        })
        yield* Effect.sync(() => seedAuth("test"))

        const result = yield* saveVia(f.project, "test", {
          config: saveConfig(f.llm.url, {
            models: {
              keep: { name: "Keep" },
            },
          }),
          auth: authPreserve,
        })
        expect(result.status).toBe(200)
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")

        const entry = providerEntry(readGlobalConfig(f.global), "test") as Record<string, unknown>
        const models = entry.models as Record<string, unknown>
        expect(models.keep).toBeDefined()
        expect("gone" in models).toBe(false)
        const keep = models.keep as Record<string, unknown>
        expect(keep.reasoning).toBeUndefined()
        expect(keep.variants).toBeUndefined()
      }),
    30_000,
  )

  it.live(
    "disabled_providers removes the target ID only and is left untouched when not disabled",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: (url) => saveConfig(url) })
        yield* Effect.sync(() => seedAuth("test"))
        const before = readGlobalConfig(f.global)
        before.disabled_providers = ["test", "openai", "groq"]
        fs.writeFileSync(globalFile(f.global), JSON.stringify(before, null, 2))

        const first = yield* saveVia(f.project, "test", { config: saveConfig(f.llm.url), auth: authPreserve })
        expect(first.status).toBe(200)
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")
        expect((readGlobalConfig(f.global).disabled_providers as string[]).sort()).toEqual(["groq", "openai"])

        // A second save with identical config + preserve is a no-op; the
        // disabled list (already clean) is not rewritten.
        const second = yield* saveVia(f.project, "test", { config: saveConfig(f.llm.url), auth: authPreserve })
        expect(second.status).toBe(200)
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")
        expect((readGlobalConfig(f.global).disabled_providers as string[]).sort()).toEqual(["groq", "openai"])
      }),
    30_000,
  )

  it.live(
    "env-based provider with auth preserve leaves the auth file untouched",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: (url) => saveConfig(url, { env: ["MY_PROVIDER_KEY"] }) })
        yield* Effect.sync(() => seedAuth("test"))
        const authOriginal = fs.readFileSync(authFile())

        const result = yield* saveVia(f.project, "test", {
          config: saveConfig(f.llm.url, { env: ["MY_PROVIDER_KEY"] }),
          auth: authPreserve,
        })
        expect(result.status).toBe(200)
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")
        expect(Buffer.compare(fs.readFileSync(authFile()), authOriginal)).toBe(0)
        const entry = providerEntry(readGlobalConfig(f.global), "test") as Record<string, unknown>
        expect(entry.env).toEqual(["MY_PROVIDER_KEY"])
      }),
    30_000,
  )
})

// ─── LOCK-006: no-op semantics ──────────────────────────────────────────

describe("customProviderSave - no-op semantics (LOCK-006)", () => {
  it.live(
    "identical config + auth preserve returns success with zero events and zero rebuilds",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: (url) => saveConfig(url) })
        yield* Effect.sync(() => seedAuth("test"))
        const globalOriginal = fs.readFileSync(globalFile(f.global), "utf-8")
        const authOriginal = fs.readFileSync(authFile())
        const events = captureEvents()
        probeRebuildRegistration.install()

        try {
          const result = yield* saveVia(f.project, "test", { config: saveConfig(f.llm.url), auth: authPreserve })
          // Existing UI expects save success when nothing changed (LOCK-006).
          expect(result.status).toBe(200)
          expect(result.body?.success).toBe(true)
          yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")

          expect(fs.readFileSync(globalFile(f.global), "utf-8")).toBe(globalOriginal)
          expect(Buffer.compare(fs.readFileSync(authFile()), authOriginal)).toBe(0)
          expect(configEvents(events.received).length).toBe(0)
          expect(probeRebuildRegistration.entries().length).toBe(0)
        } finally {
          events.dispose()
          probeRebuildRegistration.uninstall()
        }
      }),
    30_000,
  )

  it.live(
    "auth set on an identical config counts as a change: one rebuild, one event, auth updated",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: (url) => saveConfig(url) })
        yield* Effect.sync(() => seedAuth("test"))
        const globalOriginal = fs.readFileSync(globalFile(f.global), "utf-8")
        const events = captureEvents()
        probeRebuildRegistration.install()

        try {
          const result = yield* saveVia(f.project, "test", {
            config: saveConfig(f.llm.url),
            auth: { mode: "set", key: "rotated-key" },
          })
          expect(result.status).toBe(200)
          expect(result.body?.success).toBe(true)
          yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")

          // Config byte-identical; auth rotated; exactly one rebuild + one event.
          expect(fs.readFileSync(globalFile(f.global), "utf-8")).toBe(globalOriginal)
          expect(readAuth().test).toEqual({ type: "api", key: "rotated-key" })
          const updated = configEvents(events.received)
          expect(updated.length).toBe(1)
          expect(updated[0]?.directory).toBe("global")
          expect(probeRebuildRegistration.entries().length).toBe(1)
        } finally {
          events.dispose()
          probeRebuildRegistration.uninstall()
        }
      }),
    30_000,
  )
})

// ─── LOCK-002: rejection matrix ─────────────────────────────────────────

describe("customProviderSave - rejection matrix (LOCK-002)", () => {
  it.live(
    "existing non-custom same-ID provider cannot be overwritten (structured 400 before any mutation)",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({
          global: () => ({ npm: "some-other-package", name: "Other", options: { baseURL: "https://x.example" } }),
        })
        yield* Effect.sync(() => seedAuth("test"))
        const globalOriginal = fs.readFileSync(globalFile(f.global), "utf-8")
        const authOriginal = fs.readFileSync(authFile())
        const events = captureEvents()

        try {
          const result = yield* saveVia(f.project, "test", { config: saveConfig(f.llm.url), auth: authSet })
          expect(result.status).toBe(400)
          expect(result.body?.code).toBe("not-custom")
          expect(result.body?.message).toContain("test")
          expect(result.body?.detail).toContain("providerID: test")

          expect(fs.readFileSync(globalFile(f.global), "utf-8")).toBe(globalOriginal)
          expect(Buffer.compare(fs.readFileSync(authFile()), authOriginal)).toBe(0)
          expect(configEvents(events.received).length).toBe(0)
        } finally {
          events.dispose()
        }
      }),
    30_000,
  )

  it.live(
    "invalid config schema (missing models / bad npm / non-http baseURL) rejects before any mutation",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({})
        yield* Effect.sync(() => seedAuth("test"))
        const before = fs.readFileSync(globalFile(f.global), "utf-8")
        const events = captureEvents()

        try {
          const noModels = yield* saveVia(f.project, "test", {
            config: { npm: "@ai-sdk/openai-compatible", name: "Test", options: { baseURL: f.llm.url }, models: {} },
            auth: authPreserve,
          })
          expect(noModels.status).toBe(400)

          const badNpm = yield* saveVia(f.project, "test", {
            config: { npm: "malicious-package", name: "Test", options: { baseURL: f.llm.url }, models: { m: { name: "M" } } },
            auth: authPreserve,
          })
          expect(badNpm.status).toBe(400)

          const badUrl = yield* saveVia(f.project, "test", {
            config: { npm: "@ai-sdk/openai-compatible", name: "Test", options: { baseURL: "ftp://x.example" }, models: { m: { name: "M" } } },
            auth: authPreserve,
          })
          expect(badUrl.status).toBe(400)

          expect(fs.readFileSync(globalFile(f.global), "utf-8")).toBe(before)
          expect(configEvents(events.received).length).toBe(0)
        } finally {
          events.dispose()
        }
      }),
    30_000,
  )

  it.live(
    "provider ID that cannot route (contains a slash) is never matched and nothing mutates",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({})
        yield* Effect.sync(() => seedAuth("test"))
        const before = fs.readFileSync(globalFile(f.global), "utf-8")

        // Provider ID format validation lives extension-side (validateProviderID);
        // the backend route matches `:providerID` only as a single path segment,
        // so a slashed ID is a route miss (404) and never mutates anything.
        const result = yield* saveVia(f.project, "bad/id", { config: saveConfig(f.llm.url), auth: authPreserve })
        expect(result.status).toBe(404)
        expect(fs.readFileSync(globalFile(f.global), "utf-8")).toBe(before)
      }),
    30_000,
  )

  it.live(
    "route-matching but invalid provider ID (uppercase) rejects with structured validation 400 before any mutation",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({})
        yield* Effect.sync(() => seedAuth("test"))
        const before = fs.readFileSync(globalFile(f.global), "utf-8")
        const authOriginal = fs.readFileSync(authFile())
        const events = captureEvents()

        try {
          // "Test" passes the route (single path segment) but violates the
          // shared predicate /^[a-z0-9][a-z0-9-_]*$/ enforced backend-side
          // (LOCK-002), so it rejects before any fence/lock/auth/config work.
          const result = yield* saveVia(f.project, "Test", { config: saveConfig(f.llm.url), auth: authSet })
          expect(result.status).toBe(400)
          expect(result.body?.code).toBe("validation")
          expect(result.body?.message).toContain("Test")

          expect(fs.readFileSync(globalFile(f.global), "utf-8")).toBe(before)
          expect(Buffer.compare(fs.readFileSync(authFile()), authOriginal)).toBe(0)
          expect(configEvents(events.received).length).toBe(0)
        } finally {
          events.dispose()
        }
      }),
    30_000,
  )
})

// ─── LOCK-003: deferred final events ────────────────────────────────────

describe("customProviderSave - deferred final events (LOCK-003)", () => {
  it.live(
    "execute returns the deferred ConfigUpdated event; nothing is emitted until the response boundary runs it",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: (url) => saveConfig(url) })
        yield* Effect.sync(() => seedAuth("test"))
        const events = captureEvents()

        try {
          const result = yield* Effect.promise(() =>
            AppRuntime.runPromise(
              provideInstance(f.project)(
                executeSave({
                  providerID: "test",
                  config: saveConfig("https://new.example/v1") as unknown as CustomProviderSaveConfig,
                  auth: authPreserve as unknown as CustomProviderSaveAuth,
                  directory: f.project,
                }),
              ),
            ),
          )
          expect(result.success).toBe(true)
          expect(configEvents(events.received).length).toBe(0)

          yield* Effect.promise(() => AppRuntime.runPromise(result.events))
          const updated = configEvents(events.received)
          expect(updated.length).toBe(1)
          expect(updated[0]?.directory).toBe("global")
          expect(typeof updated[0]?.transaction).toBe("string")

          expect(providerEntry(readGlobalConfig(f.global), "test")).toBeDefined()
          yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")
        } finally {
          events.dispose()
        }
      }),
    30_000,
  )

  it.live(
    "execute no-op returns success with a no-op event effect and emits nothing",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: (url) => saveConfig(url) })
        yield* Effect.sync(() => seedAuth("test"))
        const events = captureEvents()

        try {
          const result = yield* Effect.promise(() =>
            AppRuntime.runPromise(
              provideInstance(f.project)(
                executeSave({
                  providerID: "test",
                  config: saveConfig(f.llm.url) as unknown as CustomProviderSaveConfig,
                  auth: authPreserve as unknown as CustomProviderSaveAuth,
                  directory: f.project,
                }),
              ),
            ),
          )
          expect(result.success).toBe(true)
          yield* Effect.promise(() => AppRuntime.runPromise(result.events))
          expect(configEvents(events.received).length).toBe(0)
          yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")
        } finally {
          events.dispose()
        }
      }),
    30_000,
  )
})

// ─── LOCK-003/005: held stream through the real listener ────────────────

describe("customProviderSave - held stream + real listener (LOCK-003/005)", () => {
  it.live(
    "save returns 200 and persists before release; stream completes with exactly one disposal/rebuild",
    (): Effect.Effect<void, unknown, TestLLMServer | Scope.Scope> =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: (url) => saveConfig(url) })
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
          // save + rebuild (LOCK-003).
          const urlBefore = listener.url.toString()
          const pidBefore = process.pid

          // Save through the real listener: the response returns BEFORE the
          // held stream is released and before any disposal.
          const saved = yield* send(f.project, "/custom-provider/test/save", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ config: saveConfig(f.llm.url, { name: "Updated" }), auth: authPreserve }),
          })
          expect(saved.status).toBe(200)
          const savedBody = (yield* Effect.promise(() => saved.json())) as { success?: boolean }
          expect(savedBody.success).toBe(true)

          // Persistence is immediate: config + auth are updated while the
          // stream is still in flight.
          const entry = providerEntry(readGlobalConfig(f.global), "test") as Record<string, unknown>
          expect(entry.name).toBe("Updated")

          // No lifecycle/error signal before release.
          expect(yield* disposed.done).toBe(false)
          expect(yield* instanceDisposed.done).toBe(false)
          expect(yield* sessionError.done).toBe(false)
          expect(yield* isDone(promptDone)).toBe(false)

          // LOCK-003 ordering proof: the final ConfigUpdated event is already
          // observable with the response, but the rebuild is still draining
          // (registered, not completed) — the held stream keeps the disposal
          // pending.
          const updated = configEvents(events.received)
          expect(updated.length).toBe(1)
          expect(updated[0]?.directory).toBe("global")
          expect(typeof updated[0]?.transaction).toBe("string")

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

          // The listener keeps serving the rebuilt runtime; the next request
          // state reflects the saved config.
          expect(listener.url.toString()).toBe(urlBefore)
          const overlay = yield* send(f.project, "/config/overlay?scope=project")
          expect(overlay.status).toBe(200)
          const overlayBody = (yield* Effect.promise(() => overlay.json())) as {
            effective: { provider?: Record<string, unknown> }
          }
          expect(providerEntry(overlayBody.effective, "test")).toBeDefined()
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

// ─── LOCK-004/006: failure matrix ───────────────────────────────────────

describe("customProviderSave - failure matrix (LOCK-004/006)", () => {
  it.live(
    "config commit failure restores the target, emits nothing, and releases the fence",
    () =>
      Effect.gen(function* () {
        // Point Global.Path.config at a read-only directory so the global
        // config commit fails (EACCES) after prepare.
        const f = yield* makeFixture({ global: (url) => saveConfig(url) })
        yield* Effect.sync(() => seedAuth("test"))
        const globalOriginal = fs.readFileSync(globalFile(f.global), "utf-8")
        const authOriginal = fs.readFileSync(authFile())
        const events = captureEvents()

        try {
          yield* Effect.promise(() => fs.promises.chmod(f.global, 0o500))
          const result = yield* saveVia(f.project, "test", {
            config: saveConfig("https://new.example/v1", { name: "Changed" }),
            auth: authPreserve,
          })
          // A failed commit surfaces as a defect (500), never a false 200.
          expect(result.status).toBe(500)
        } finally {
          events.dispose()
          yield* Effect.promise(() => fs.promises.chmod(f.global, 0o700))
        }

        expect(fs.readFileSync(globalFile(f.global), "utf-8")).toBe(globalOriginal)
        expect(Buffer.compare(fs.readFileSync(authFile()), authOriginal)).toBe(0)
        expect(configEvents(events.received).length).toBe(0)
        expect(events.received.some((event) => event.type === Event.Disposed.type)).toBe(false)

        // Fence released: a follow-up save completes normally.
        const followup = yield* saveVia(f.project, "test", {
          config: saveConfig("https://new.example/v1", { name: "Changed" }),
          auth: authPreserve,
        })
        expect(followup.status).toBe(200)
        expect(providerEntry(readGlobalConfig(f.global), "test")).toBeDefined()
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")
      }),
    30_000,
  )

  it.live(
    "auth-set failure compensates config AND the exact auth file, emits nothing",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: (url) => saveConfig(url) })
        yield* Effect.sync(() => seedAuth("test"))
        const authPath = authFile()
        const globalOriginal = fs.readFileSync(globalFile(f.global), "utf-8")
        const authOriginal = fs.readFileSync(authPath)
        const events = captureEvents()

        try {
          // The auth file is owned by this process, so making the FILE read-only
          // fails auth.set (writeJson gets EACCES) while config commits remain functional.
          yield* Effect.promise(() => fs.promises.chmod(authPath, 0o400))
          const result = yield* saveVia(f.project, "test", {
            config: saveConfig("https://new.example/v1", { name: "Changed" }),
            auth: { mode: "set", key: "new-key" },
          })
          expect(result.status).toBe(500)
        } finally {
          events.dispose()
          yield* Effect.promise(() => fs.promises.chmod(authPath, 0o600))
        }

        // Compensation restored the config target and the exact auth bytes
        // (the set never wrote because the file is read-only).
        expect(fs.readFileSync(globalFile(f.global), "utf-8")).toBe(globalOriginal)
        expect(Buffer.compare(fs.readFileSync(authPath), authOriginal)).toBe(0)
        expect(configEvents(events.received).length).toBe(0)
        expect(events.received.some((event) => event.type === Event.Disposed.type)).toBe(false)

        // Fence released: the follow-up save succeeds end to end and the
        // seeded credentials survive (the failed save never wrote them).
        const followup = yield* saveVia(f.project, "test", {
          config: saveConfig("https://new.example/v1", { name: "Changed" }),
          auth: authPreserve,
        })
        expect(followup.status).toBe(200)
        expect(readAuth().test).toEqual({ type: "api", key: "test-key" })
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")
      }),
    30_000,
  )

  it.live(
    "interrupted save cleans the fence and lock artifacts; the next save works",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture({ global: (url) => saveConfig(url) })
        yield* Effect.sync(() => seedAuth("test"))
        const globalKey = KilocodeConfig.configDiscoveryGlobalKey()

        // LOCK-001: the save persists under the global discovery flock. Hold
        // the flock so the save blocks at the interruptible flock wait — a
        // convergence fence never blocks a save, so the flock is the only
        // interruptible point the interruption can land on.
        const config = yield* Effect.promise(() =>
          AppRuntime.runPromise(Config.Service.use((svc) => Effect.succeed(svc))),
        )
        const lockGate = yield* Effect.promise(() => AppRuntime.runPromise(Deferred.make<void>()))
        const holder = AppRuntime.runFork(config.withLock(globalKey, Deferred.await(lockGate)))

        // Fork the save Effect directly so interruption propagates into the
        // flock wait (a request-harness promise cannot be interrupted).
        const tx = AppRuntime.runFork(
          provideInstance(f.project)(
            executeSave({
              providerID: "test",
              config: saveConfig("https://new.example/v1", { name: "Changed" }) as unknown as CustomProviderSaveConfig,
              auth: authPreserve as unknown as CustomProviderSaveAuth,
            }),
          ),
        )

        yield* Effect.gen(function* () {
          // The save must still be blocked on the flock: awaiting it times out
          // (Exit.Failure), proving it did not complete (and cannot commit).
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

        // The holder flock is released (by the finalizer above): the next save
        // completes normally and leaves NO lock dirs behind.
        const followup = yield* saveVia(f.project, "test", {
          config: saveConfig("https://new.example/v1", { name: "Changed" }),
          auth: authPreserve,
        })
        expect(followup.status).toBe(200)
        expect(providerEntry(readGlobalConfig(f.global), "test")).toBeDefined()
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild did not settle")

        const lockRoot = path.join(Global.Path.state, "locks")
        const globalLockName = Hash.fast(globalKey) + ".lock"
        expect(fs.existsSync(path.join(lockRoot, globalLockName))).toBe(false)
      }),
    30_000,
  )
})
