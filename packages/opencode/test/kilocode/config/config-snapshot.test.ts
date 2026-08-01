/**
 * LOCK-004: generation-scoped Config.get snapshots.
 *
 * A config PATCH persists immediately and invalidates the shared per-directory
 * config cache. Work already generating on a pre-patch instance must keep
 * reading the config it started with, while the next request must see the new
 * config. `withConfigSnapshot` captures the startup `Config.Info` once and
 * provides it through `ConfigSnapshotRef`, which canonical `Config.get`
 * prefers; Context references propagate through `EffectBridge`/`forkIn`.
 *
 * The scenario runs through the production AppRuntime so the Config service
 * (and its per-directory cache) is the same instance the in-process server
 * uses, and Config reads are bound to the project instance like request work.
 */
import { afterEach, describe, expect } from "bun:test"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Deferred, Effect, Fiber } from "effect"
import { Server } from "../../../src/server/server"
import { Config } from "../../../src/config/config"
import { GlobalBus } from "../../../src/bus/global"
import { withConfigSnapshot } from "../../../src/kilocode/session/config-snapshot"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { provideInstance } from "../../fixture/fixture"
import { TestLLMServer } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"
import { testEffect } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import path from "path"

void Log.init({ print: false })

const original = Global.Path.config

afterEach(async () => {
  ;(Global.Path as { config: string }).config = original
  GlobalBus.removeAllListeners("event")
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(TestLLMServer.layer)

const app = () => Server.Default().app

function request(dir: string | undefined, input: string, init?: RequestInit) {
  return app().request(input, {
    ...init,
    headers: {
      ...(dir ? { "x-kilo-directory": dir } : {}),
      ...init?.headers,
    },
  })
}

/** Run an effect on the production runtime bound to the project instance. */
const withInstance = (dir: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(effect as Effect.Effect<A, E, never>)))

describe("Config.get generation snapshot (LOCK-004)", () => {
  it.live("an open generation keeps its startup Config.get while the next request sees the new config", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const global = await tmpdir()
          await Bun.write(
            path.join(global.path, "kilo.jsonc"),
            JSON.stringify({ $schema: "https://app.kilo.ai/config.json", permission: { bash: "allow" } }, null, 2),
          )
          const project = await tmpdir({ git: true, config: testProviderConfig(llm.url) })
          return { global, project }
        }),
        (value) =>
          Effect.promise(async () => {
            await value.project[Symbol.asyncDispose]().catch(() => undefined)
            await value.global[Symbol.asyncDispose]().catch(() => undefined)
          }),
      )
      ;(Global.Path as { config: string }).config = tmp.global.path
      const dir = tmp.project.path

      // Boot the project instance via a real request.
      yield* Effect.promise(async () => {
        await request(dir, "/config/overlay?scope=project")
      })

      const config = yield* withInstance(dir)(Config.Service.use((svc) => Effect.succeed(svc)))
      const startupModel = yield* withInstance(dir)(config.get()).pipe(Effect.map((info) => info.model))

      // Open a "generation": a snapshotted scope that stays alive across the
      // cold patch, like SessionPrompt loop/shell work does.
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const generation = yield* Effect.forkDetach(
        withInstance(dir)(
          withConfigSnapshot(
            config,
            Effect.gen(function* () {
              const atEntry = yield* config.get()
              yield* Deferred.succeed(entered, void 0)
              yield* Deferred.await(release)
              const afterPatch = yield* config.get()
              return { atEntry, afterPatch }
            }),
          ),
        ),
      )
      yield* Deferred.await(entered)

      // Cold patch through the real route: persists immediately + invalidates
      // the shared config cache.
      const patch = yield* Effect.promise(async () => {
        const response = await request(dir, "/config/overlay", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "project", set: { model: "changed/model" } }),
        })
        return response.status
      })
      expect(patch).toBe(200)

      // The next (non-snapshotted) request reads the new config.
      const nextModel = yield* withInstance(dir)(config.get()).pipe(Effect.map((info) => info.model))
      expect(nextModel).toBe("changed/model")

      // The open generation still reads its startup config.
      yield* Deferred.succeed(release, void 0)
      const observed = yield* Fiber.join(generation)
      expect(observed.atEntry.model).toBe(startupModel)
      expect(observed.afterPatch.model).toBe(startupModel)
      expect(observed.afterPatch.model).not.toBe("changed/model")
    }),
    30_000,
  )

  it.live("Config.get outside any snapshot returns the live config", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const global = await tmpdir()
          await Bun.write(
            path.join(global.path, "kilo.jsonc"),
            JSON.stringify({ $schema: "https://app.kilo.ai/config.json", permission: { bash: "allow" } }, null, 2),
          )
          const project = await tmpdir({ git: true, config: testProviderConfig(llm.url) })
          return { global, project }
        }),
        (value) =>
          Effect.promise(async () => {
            await value.project[Symbol.asyncDispose]().catch(() => undefined)
            await value.global[Symbol.asyncDispose]().catch(() => undefined)
          }),
      )
      ;(Global.Path as { config: string }).config = tmp.global.path
      const dir = tmp.project.path

      yield* Effect.promise(async () => {
        await request(dir, "/config/overlay?scope=project")
      })

      const config = yield* withInstance(dir)(Config.Service.use((svc) => Effect.succeed(svc)))
      const before = yield* withInstance(dir)(config.get()).pipe(Effect.map((info) => info.model))
      // The snapshot reference is undefined by default — no interference.
      const plain = yield* withInstance(dir)(config.get()).pipe(Effect.map((info) => info.model))
      expect(plain).toBe(before)
    }),
    30_000,
  )
})
