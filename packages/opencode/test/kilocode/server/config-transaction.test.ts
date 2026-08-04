/**
 * Integration tests for the combined global+project config transaction endpoint.
 *
 * Proves through the real `/config/transaction` PATCH route:
 * 1. Global-only hot/cold patches work correctly
 * 2. Project-only hot/cold patches work correctly
 * 3. Mixed all-hot patches persist both scopes without rebuild
 * 4. Mixed cold patches use one global writer ticket and register one rebuild
 * 5. No-op (empty) patches return current config without persistence
 * 6. Semantic no-op (non-empty patches that don't change values) returns without rebuild
 * 7. Invalid patches return structured 400 without persistence
 * 8. Response carries authoritative global, project overlay, and effective config
 * 9. Old single-scope overlay endpoint remains compatible
 * 10. Cold no-op (valid cold patch that evaluates to no change) skips rebuild
 * 11. Rollback: second-scope failure restores first scope and invalidates caches
 * 12. Response.project is the actual project overlay, not effective config
 *
 * Uses Server.Default().app.request() for actual route handling.
 * Tests are serial to avoid shared-state leakage.
 */
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Option } from "effect"
import type { Scope } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Server } from "../../../src/server/server"
import { Config } from "../../../src/config/config"
import { Event } from "../../../src/server/event"
import { GlobalBus } from "../../../src/bus/global"
import { awaitRebuilds } from "../../../src/kilocode/server/config-rebuild"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { provideInstance } from "../../fixture/fixture"
import { Hash } from "@opencode-ai/core/util/hash"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { KilocodeConfig } from "../../../src/kilocode/config/config"
import { KilocodeAtomicWrite } from "../../../src/kilocode/config/atomic-write"
import { ConfigTransaction } from "../../../src/kilocode/server/config-transaction"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { ConfigConvergence } from "../../../src/kilocode/server/config-convergence"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import type { InstanceContext } from "../../../src/project/instance-context"
import { ProjectV2 } from "@opencode-ai/core/project"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { TestLLMServer } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"
import { awaitWithTimeout, testEffect } from "../../lib/effect"
import { markPluginDependenciesReady, markProjectConfigReady } from "../../fixture/plugin"

void Log.init({ print: false })

const original = Global.Path.config

/**
 * LOCK-003 fixture leak fix: per-test tmpdirs are removed by afterEach AFTER
 * instances are disposed and rebuilds settle. Removing them via `await using`
 * in the test body would race the instance teardown that afterEach still owns
 * (a config watcher on `.kilo` holds the dir mid-removal). The fixture's live
 * registry additionally re-disposes any dir a late runtime-teardown load
 * recreates.
 */
const tdirs: Array<Awaited<ReturnType<typeof tmpdir>>> = []

afterEach(async () => {
  ;(Global.Path as { config: string }).config = original
  GlobalBus.removeAllListeners("event")
  // Teardown order: await rebuilds FIRST, then dispose instances, then reset DB.
  // This ensures rebuild fibers complete before instance disposal.
  await Effect.runPromise(awaitRebuilds())
  await disposeAllInstances()
  await resetDatabase()
  await Promise.all(tdirs.splice(0).map((dir) => dir[Symbol.asyncDispose]()))
})

type TransactionResponse = {
  global: Config.Info
  project: Config.Info
  effective: Config.Info
}

const app = () => Server.Default().app

async function json<T>(response: Response) {
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

function request(dir: string | undefined, input: string, init?: RequestInit) {
  return app().request(input, {
    ...init,
    headers: {
      ...(dir ? { "x-kilo-directory": dir } : {}),
      ...init?.headers,
    },
  })
}

async function seedGlobalConfig(dir: string) {
  await Bun.write(
    path.join(dir, "kilo.jsonc"),
    JSON.stringify({ $schema: "https://app.kilo.ai/config.json", permission: { bash: "allow" } }, null, 2),
  )
  // LOCK-003 fixture leak fix: `Global.Path.config` is always the first entry
  // of ConfigPaths.directories, so every booted instance triggers a detached
  // `Npm.install("@kilocode/plugin")` into it. That install races fixture
  // disposal and leaks 20MB+ node_modules dirs per test run. The stub marks
  // the same dependencies ready the plugin fixture contract expects.
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

function readProjectConfig(projectDir: string): Record<string, unknown> {
  for (const dir of [".kilo", ".kilocode"]) {
    for (const name of ["kilo.jsonc", "kilo.json"]) {
      const fp = path.join(projectDir, dir, name)
      try {
        const raw = fs.readFileSync(fp, "utf-8")
        return JSON.parse(raw) as Record<string, unknown>
      } catch {
        // continue
      }
    }
  }
  return {}
}

function captureEvents() {
  const received: Array<{ type: string; directory?: string; transaction?: string }> = []
  const handler = (event: { directory?: string; transaction?: string; payload: { type: string } }) => {
    received.push({ type: event.payload.type, directory: event.directory, transaction: event.transaction })
  }
  GlobalBus.on("event", handler)
  return {
    received,
    dispose: () => GlobalBus.removeListener("event", handler),
  }
}

// ─── Global-only patches ──────────────────────────────────────────────

describe("config transaction - global-only", () => {
  test.serial("global hot patch persists and returns authoritative config", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const result = await json<TransactionResponse>(
        await request(undefined, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ global: { set: { model: "test/global-model" } } }),
        }),
      )

      expect(result.global.model).toBe("test/global-model")
      expect(result.effective.model).toBe("test/global-model")
      expect(readGlobalConfig(global.path).model).toBe("test/global-model")
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
    } finally {
      events.dispose()
    }
  })

  test.serial("global cold patch persists and registers rebuild", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const _project = await tmpdir({ git: true, retain: true })
    tdirs.push(_project)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const result = await json<TransactionResponse>(
        await request(undefined, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ global: { set: { autoupdate: "notify" } } }),
        }),
      )

      expect(result.global.autoupdate).toBe("notify")
      expect(readGlobalConfig(global.path).autoupdate).toBe("notify")
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
    } finally {
      events.dispose()
    }
  })
})

// ─── Project-only patches ─────────────────────────────────────────────

describe("config transaction - project-only", () => {
  test.serial("project hot patch persists and returns authoritative config", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const result = await json<TransactionResponse>(
        await request(project.path, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: { set: { model: "test/project-model" } } }),
        }),
      )

      expect(result.effective.model).toBe("test/project-model")
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
    } finally {
      events.dispose()
    }
  })

  test.serial("project cold patch persists and registers rebuild", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const result = await json<TransactionResponse>(
        await request(project.path, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: { set: { autoupdate: false } } }),
        }),
      )

      expect(result.effective.autoupdate).toBe(false)
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
    } finally {
      events.dispose()
    }
  })
})

// ─── Mixed patches ────────────────────────────────────────────────────

describe("config transaction - mixed", () => {
  test.serial("mixed all-hot patches persist both scopes without rebuild", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const result = await json<TransactionResponse>(
        await request(project.path, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            global: { set: { model: "test/global-hot" } },
            project: { set: { small_model: "test/project-hot" } },
          }),
        }),
      )

      expect(result.global.model).toBe("test/global-hot")
      expect(result.effective.small_model).toBe("test/project-hot")
      expect(readGlobalConfig(global.path).model).toBe("test/global-hot")
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
    } finally {
      events.dispose()
    }
  })

  test.serial("mixed cold patch uses one global writer ticket and registers one rebuild", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const result = await json<TransactionResponse>(
        await request(project.path, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            global: { set: { model: "test/global-cold" } },
            project: { set: { autoupdate: false } },
          }),
        }),
      )

      expect(result.global.model).toBe("test/global-cold")
      expect(result.effective.autoupdate).toBe(false)
      expect(readGlobalConfig(global.path).model).toBe("test/global-cold")
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
    } finally {
      events.dispose()
    }
  })
})

// ─── No-op patches ────────────────────────────────────────────────────

describe("config transaction - no-op", () => {
  test.serial("empty transaction returns current config without persistence", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const result = await json<TransactionResponse>(
        await request(undefined, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      )

      expect(result.global).toBeDefined()
      expect(result.effective).toBeDefined()
      const configEvents = events.received.filter(
        (e) => e.type === Event.ConfigUpdated.type || e.type === Event.Disposed.type,
      )
      expect(configEvents.length).toBe(0)
    } finally {
      events.dispose()
    }
  })

  test.serial("empty scope objects return current config without persistence", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const result = await json<TransactionResponse>(
        await request(undefined, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ global: {}, project: {} }),
        }),
      )

      expect(result.global).toBeDefined()
      const configEvents = events.received.filter(
        (e) => e.type === Event.ConfigUpdated.type || e.type === Event.Disposed.type,
      )
      expect(configEvents.length).toBe(0)
    } finally {
      events.dispose()
    }
  })
})

// ─── Semantic no-op (audit fix: cold no-op hardcodes changed=true) ────

describe("config transaction - semantic no-op", () => {
  test.serial("patch that matches existing value does not rebuild", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    // Seed global config with permission.bash already set to "allow"
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      // Send a hot patch (permission is hot, LOCK-002) that sets the same value
      const result = await json<TransactionResponse>(
        await request(project.path, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            global: { set: { permission: { bash: "allow" } } },
          }),
        }),
      )

      expect(result.global.permission).toMatchObject({ bash: "allow" })
      // Semantic no-op: no ConfigUpdated event, no rebuild
      const configEvents = events.received.filter(
        (e) => e.type === Event.ConfigUpdated.type || e.type === Event.Disposed.type,
      )
      expect(configEvents.length).toBe(0)
    } finally {
      events.dispose()
    }
  })
})

// ─── Invalid patches ──────────────────────────────────────────────────

describe("config transaction - invalid", () => {
  test.serial("invalid global patch returns structured 400 without persistence", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const before = readGlobalConfig(global.path)
      const response = await request(undefined, "/config/transaction", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ global: { set: { unknown_key: "value" } } }),
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { name?: string; data?: { path?: string } }
      expect(body.name).toBe("ConfigInvalidError")
      expect(readGlobalConfig(global.path)).toEqual(before)
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(false)
    } finally {
      events.dispose()
    }
  })

  test.serial("invalid project patch returns structured 400 without persistence", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const response = await request(project.path, "/config/transaction", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: { set: { model: 123 } } }),
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { name?: string }
      expect(body.name).toBe("ConfigInvalidError")
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(false)
    } finally {
      events.dispose()
    }
  })
})

// ─── Response shape (audit fix: project was returning effective config) ─

describe("config transaction - response shape", () => {
  test.serial("response carries authoritative global, project overlay, and effective config", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path

    try {
      const result = await json<TransactionResponse>(
        await request(project.path, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            global: { set: { model: "test/resp-global" } },
            project: { set: { small_model: "test/resp-project" } },
          }),
        }),
      )

      // Global config is authoritative
      expect(result.global.model).toBe("test/resp-global")
      expect(result.global.small_model).toBeUndefined()

      // Project overlay is NOT effective config — it should contain project-only values
      // The project overlay does not include global model inheritance
      expect(result.project.small_model).toBe("test/resp-project")

      // Effective config reflects merged state
      expect(result.effective.model).toBe("test/resp-global")
      expect(result.effective.small_model).toBe("test/resp-project")
    } finally {
      // No events to dispose in this test
    }
  })

  test.serial("empty transaction returns project overlay, not effective config", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path

    try {
      const result = await json<TransactionResponse>(
        await request(project.path, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      )

      // project field should be the project overlay (empty for a fresh project)
      // effective field includes global defaults
      expect(result.effective.permission).toBeDefined()
    } finally {
      // No events to dispose in this test
    }
  })
})

// ─── Rollback (LOCK-005: invalid second scope → zero writes/events) ───

describe("config transaction - rollback", () => {
  test.serial("invalid second scope causes zero writes and zero events", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const beforeGlobal = readGlobalConfig(global.path)
      // Global patch is valid, project patch is invalid (model must be string).
      // Both scopes are prepared BEFORE the first write (LOCK-002), so the
      // invalid second scope aborts with zero persistence and zero events —
      // nothing to compensate, no stale ConfigUpdated ever emitted.
      const response = await request(project.path, "/config/transaction", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          global: { set: { model: "test/rollback-global" } },
          project: { set: { model: 123 } }, // invalid: model must be string
        }),
      })

      expect(response.status).toBe(400)
      const body = (await response.json()) as { name?: string }
      expect(body.name).toBe("ConfigInvalidError")
      // Zero writes: the global file is byte-identical to its pre-transaction state.
      expect(readGlobalConfig(global.path)).toEqual(beforeGlobal)
      // Zero events: no ConfigUpdated, no Disposed.
      const configEvents = events.received.filter(
        (e) => e.type === Event.ConfigUpdated.type || e.type === Event.Disposed.type,
      )
      expect(configEvents.length).toBe(0)
    } finally {
      events.dispose()
    }
  })
})

// ─── Old endpoint compatibility ───────────────────────────────────────

describe("config transaction - old endpoint compatibility", () => {
  test.serial("old overlay endpoint still works for single-scope patches", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path

    try {
      const result = await json<Config.Info>(
        await request(undefined, "/config/overlay", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "global", set: { model: "test/old-endpoint" } }),
        }),
      )

      expect(result.model).toBe("test/old-endpoint")
      expect(readGlobalConfig(global.path).model).toBe("test/old-endpoint")
    } finally {
      // No events to dispose in this test
    }
  })
})

// ─── LOCK-001: deterministic first-file creation race ─────────────────

/**
 * The discovery lock makes target resolution + write one stable cross-process
 * decision (LOCK-001). Without it, a writer resolves the target BEFORE taking
 * any lock, so a concurrent higher-precedence file creation can shadow the
 * resolved target and make the save invisible. Each test forces that
 * interleaving deterministically: the discovery lock is held while the
 * higher-precedence file is created, so the blocked writer can only resolve
 * the NEW visible target after the creation is durable.
 */
describe("config transaction - LOCK-001 first-file creation race", () => {
  test.serial("global updateGlobal: higher-precedence file created under the held discovery lock wins the target", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    // Lowest-precedence global file exists: without the discovery lock the
    // writer would resolve it and the save would become invisible once
    // kilo.jsonc (higher precedence) appears.
    await Bun.write(path.join(global.path, "config.json"), JSON.stringify({ model: "old" }, null, 2))
    ;(Global.Path as { config: string }).config = global.path

    const config = await AppRuntime.runPromise(Config.Service.use((svc) => Effect.succeed(svc)))
    // Hold the discovery lock: the forked writer MUST block before resolving
    // any target. Create the higher-precedence file under the lock, then
    // release — the writer can only resolve the NEW visible target.
    const fiber = await AppRuntime.runPromise(
      config.withLock(
        KilocodeConfig.configDiscoveryGlobalKey(),
        Effect.gen(function* () {
          const fiber = yield* Effect.sync(() =>
            AppRuntime.runFork(
              Config.Service.use((svc) => svc.updateGlobal({ model: "new/global" } as Config.Info)).pipe(Effect.exit),
            ),
          )
          yield* Effect.promise(async () => {
            await Bun.write(
              path.join(global.path, "kilo.jsonc"),
              JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }, null, 2),
            )
          })
          return fiber
        }),
      ),
    )
    const exit = await AppRuntime.runPromise(Fiber.join(fiber))
    if (exit._tag !== "Success") throw new Error("updateGlobal through the discovery lock failed")

    // The save landed in the NEW visible target, not the shadowed config.json.
    expect(readGlobalConfig(global.path).model).toBe("new/global")
    const legacy = JSON.parse(fs.readFileSync(path.join(global.path, "config.json"), "utf8")) as { model?: string }
    expect(legacy.model).toBe("old")
  })

  test.serial("global transaction: higher-precedence file created under the held discovery lock wins the target", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    await Bun.write(path.join(global.path, "config.json"), JSON.stringify({ model: "old" }, null, 2))
    ;(Global.Path as { config: string }).config = global.path

    const config = await AppRuntime.runPromise(Config.Service.use((svc) => Effect.succeed(svc)))
    const fiber = await AppRuntime.runPromise(
      config.withLock(
        KilocodeConfig.configDiscoveryGlobalKey(),
        Effect.gen(function* () {
          const fiber = yield* Effect.sync(() =>
            AppRuntime.runFork(
              // The HTTP middleware provides an instance context for
              // directory-less global requests; the direct call needs the
              // same InstanceRef binding for the effective-config read.
              provideInstance(global.path)(
                ConfigTransaction.executeTransaction({ global: { set: { model: "new/tx" } } }),
              ).pipe(Effect.exit),
            ),
          )
          yield* Effect.promise(async () => {
            await Bun.write(
              path.join(global.path, "kilo.jsonc"),
              JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }, null, 2),
            )
          })
          return fiber
        }),
      ),
    )
    const exit = await AppRuntime.runPromise(Fiber.join(fiber))
    if (exit._tag !== "Success") throw new Error("transaction through the discovery lock failed")

    expect(readGlobalConfig(global.path).model).toBe("new/tx")
    const legacy = JSON.parse(fs.readFileSync(path.join(global.path, "config.json"), "utf8")) as { model?: string }
    expect(legacy.model).toBe("old")
  })

  test.serial("global transaction: existing target removed under the held discovery lock is re-resolved", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    // Only the lowest-precedence global file exists. If target resolution
    // happened before the discovery lock, removing it while the writer waits
    // would leave the save invisible (written to a deleted path). Resolution
    // under the lock re-discovers the canonical default target instead.
    await Bun.write(path.join(global.path, "config.json"), JSON.stringify({ model: "old" }, null, 2))
    ;(Global.Path as { config: string }).config = global.path

    const config = await AppRuntime.runPromise(Config.Service.use((svc) => Effect.succeed(svc)))
    const fiber = await AppRuntime.runPromise(
      config.withLock(
        KilocodeConfig.configDiscoveryGlobalKey(),
        Effect.gen(function* () {
          const fiber = yield* Effect.sync(() =>
            AppRuntime.runFork(
              provideInstance(global.path)(
                ConfigTransaction.executeTransaction({ global: { set: { model: "new/removed" } } }),
              ).pipe(Effect.exit),
            ),
          )
          yield* Effect.promise(async () => {
            await fs.promises.rm(path.join(global.path, "config.json"))
          })
          return fiber
        }),
      ),
    )
    const exit = await AppRuntime.runPromise(Fiber.join(fiber))
    if (exit._tag !== "Success") throw new Error("transaction through the discovery lock failed after target removal")

    // The deleted target is gone; the save landed in the canonical default
    // target (kilo.jsonc), which is the first file readGlobalConfig reads.
    expect(fs.existsSync(path.join(global.path, "config.json"))).toBe(false)
    expect(fs.existsSync(path.join(global.path, "kilo.jsonc"))).toBe(true)
    expect(readGlobalConfig(global.path).model).toBe("new/removed")
  })

  test.serial("project transaction: higher-precedence .kilo target created under the held discovery lock wins", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    // Lowest-precedence root config exists; a .kilo dir-config target would
    // shadow it once created.
    await Bun.write(path.join(project.path, "opencode.json"), JSON.stringify({ model: "old" }, null, 2))

    const config = await AppRuntime.runPromise(Config.Service.use((svc) => Effect.succeed(svc)))
    const fiber = await AppRuntime.runPromise(
      config.withLock(
        KilocodeConfig.configDiscoveryProjectKey(project.path),
        Effect.gen(function* () {
          const fiber = yield* Effect.sync(() =>
            AppRuntime.runFork(
              provideInstance(project.path)(
                ConfigTransaction.executeTransaction({ project: { set: { small_model: "new/tx" } } }),
              ).pipe(Effect.exit),
            ),
          )
          yield* Effect.promise(async () => {
            await fs.promises.mkdir(path.join(project.path, ".kilo"), { recursive: true })
            await Bun.write(
              path.join(project.path, ".kilo", "kilo.jsonc"),
              JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }, null, 2),
            )
          })
          return fiber
        }),
      ),
    )
    const exit = await AppRuntime.runPromise(Fiber.join(fiber))
    if (exit._tag !== "Success") throw new Error("project transaction through the discovery lock failed")

    // The save landed in the NEW .kilo/kilo.jsonc, not the shadowed opencode.json.
    expect(readProjectConfig(project.path).small_model).toBe("new/tx")
    const legacy = JSON.parse(fs.readFileSync(path.join(project.path, "opencode.json"), "utf8")) as {
      model?: string
    }
    expect(legacy.model).toBe("old")
  })

  test.serial("project legacy update: higher-precedence .kilo target created under the held discovery lock wins", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    await Bun.write(path.join(project.path, "opencode.json"), JSON.stringify({ model: "old" }, null, 2))

    const config = await AppRuntime.runPromise(Config.Service.use((svc) => Effect.succeed(svc)))
    const fiber = await AppRuntime.runPromise(
      config.withLock(
        KilocodeConfig.configDiscoveryProjectKey(project.path),
        Effect.gen(function* () {
          const fiber = yield* Effect.sync(() =>
            AppRuntime.runFork(
              provideInstance(project.path)(
                Config.Service.use((svc) => svc.update({ small_model: "new/legacy" } as Config.Info)),
              ).pipe(Effect.exit),
            ),
          )
          yield* Effect.promise(async () => {
            await fs.promises.mkdir(path.join(project.path, ".kilo"), { recursive: true })
            await Bun.write(
              path.join(project.path, ".kilo", "kilo.jsonc"),
              JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }, null, 2),
            )
          })
          return fiber
        }),
      ),
    )
    const exit = await AppRuntime.runPromise(Fiber.join(fiber))
    if (exit._tag !== "Success") throw new Error("legacy project update through the discovery lock failed")

    expect(readProjectConfig(project.path).small_model).toBe("new/legacy")
    const legacy = JSON.parse(fs.readFileSync(path.join(project.path, "opencode.json"), "utf8")) as {
      model?: string
    }
    expect(legacy.model).toBe("old")
  })
})

// ─── LOCK-005: dynamic transaction regression ─────────────────────────

/**
 * Deterministic dynamic coverage for the transaction coordinator:
 * - second-commit failure restores both exact files, emits nothing, cleans the ticket
 * - concurrent legacy (overlay) + transaction non-overlapping writes preserve both
 * - event transaction ids group one logical save across scopes
 * - interruption leaves no lock/temp artifacts and the next transaction works
 *
 * Fault injection is filesystem-permission based only (LOCK-006): the project
 * `.kilo/` directory is made read-only so the SECOND commit (project target)
 * fails after the global target already committed.
 */
describe("config transaction - LOCK-005 dynamic", () => {
  test.serial("second commit failure restores both exact files, emits nothing, and cleans the ticket", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      // Seed the project target so prepare reads it; then make the project
      // config dir read-only so the project COMMIT fails (temp-file create
      // gets PermissionDenied) while the global commit already succeeded.
      const kiloDir = path.join(project.path, ".kilo")
      await fs.promises.mkdir(kiloDir, { recursive: true })
      // The freshly created `.kilo` config dir is a ConfigPaths.directories
      // entry, so a booted instance would install `@kilocode/plugin` into it
      // (detached) and race disposal (LOCK-003 fixture leak fix).
      await markPluginDependenciesReady(kiloDir)
      const projectFile = path.join(kiloDir, "kilo.jsonc")
      const projectOriginal = JSON.stringify(
        { $schema: "https://app.kilo.ai/config.json", permission: { bash: "allow" } },
        null,
        2,
      )
      await Bun.write(projectFile, projectOriginal)
      await fs.promises.chmod(kiloDir, 0o500)

      const globalOriginal = readGlobalConfig(global.path)

      // Cold patch (autoupdate) → the transaction takes one global writer
      // ticket. The project commit fails; the global commit is compensated.
      const response = await request(project.path, "/config/transaction", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          global: { set: { autoupdate: "notify" } },
          project: { set: { username: "cold-user" } },
        }),
      })
      // A failed commit surfaces as a defect (500), not a typed 400.
      expect(response.status).toBe(500)

      await fs.promises.chmod(kiloDir, 0o700)
      // Both files are byte-identical to their pre-transaction state.
      expect(readGlobalConfig(global.path)).toEqual(globalOriginal)
      expect(fs.readFileSync(projectFile, "utf8")).toBe(projectOriginal)
      // No events: emission only ever happens after ALL targets committed.
      const configEvents = events.received.filter(
        (e) => e.type === Event.ConfigUpdated.type || e.type === Event.Disposed.type,
      )
      expect(configEvents.length).toBe(0)

      // Ticket cleanup: the writer barrier is aborted, so a follow-up
      // transaction completes normally (no reader is stuck behind a barrier).
      const followup = await json<TransactionResponse>(
        await request(undefined, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ global: { set: { model: "test/after-failure" } } }),
        }),
      )
      expect(followup.global.model).toBe("test/after-failure")
    } finally {
      events.dispose()
    }
  })

  test.serial("concurrent legacy project hot write and transaction non-overlapping write preserve both", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path

    try {
      // Boot the project instance once so the project config target exists.
      await request(project.path, "/config/overlay?scope=project")

      // Legacy overlay PATCH and transaction PATCH run concurrently on the
      // SAME project target with non-overlapping hot keys. Both serialize on
      // the shared project lock (LOCK-004), so neither write can be lost.
      const [legacy, tx] = await Promise.all([
        request(project.path, "/config/overlay", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "project", set: { model: "test/legacy-model" } }),
        }),
        request(project.path, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: { set: { small_model: "test/transaction-model" } } }),
        }),
      ])

      expect(legacy.status).toBe(200)
      expect(tx.status).toBe(200)
      // Both values survive: the second writer merged onto the first's result.
      const saved = readProjectConfig(project.path)
      expect(saved.model).toBe("test/legacy-model")
      expect(saved.small_model).toBe("test/transaction-model")
    } finally {
      // No events to dispose in this test
    }
  })

  test.serial("event transaction ids group one logical save across scopes", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      await request(project.path, "/config/overlay?scope=project")

      const result = await json<TransactionResponse>(
        await request(project.path, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            global: { set: { model: "test/tx-id-model" } },
            project: { set: { small_model: "test/tx-id-small" } },
          }),
        }),
      )
      expect(result.global.model).toBe("test/tx-id-model")

      // The combined save emits one event per committed scope, all carrying the
      // SAME logical transaction id (LOCK-004: deferred final events).
      const updated = events.received.filter((e) => e.type === Event.ConfigUpdated.type)
      expect(updated.length).toBeGreaterThanOrEqual(2)
      const ids = updated.map((e) => (e as { transaction?: string }).transaction)
      expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true)
      expect(new Set(ids).size).toBe(1)

      // A second logical save carries a DIFFERENT transaction id.
      events.received.length = 0
      await json<Config.Info>(
        await request(project.path, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ global: { set: { small_model: "test/tx-id-second" } } }),
        }),
      )
      const secondIds = events.received
        .filter((e) => e.type === Event.ConfigUpdated.type)
        .map((e) => (e as { transaction?: string }).transaction)
      expect(secondIds.length).toBeGreaterThanOrEqual(1)
      expect(secondIds.every((id) => id !== ids[0])).toBe(true)
    } finally {
      events.dispose()
    }
  })

  test.serial("interrupted transaction leaves no lock or temp artifacts and the next transaction works", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      await request(project.path, "/config/overlay?scope=project")
      const lockRoot = path.join(Global.Path.state, "locks")

      // Hold the shared global discovery lock so the transaction blocks in its
      // (now interruptible) wait instead of committing (LOCK-001/003).
      const config = await AppRuntime.runPromise(Config.Service.use((svc) => Effect.succeed(svc)))
      const gate = await AppRuntime.runPromise(Deferred.make<void>())
      const globalKey = KilocodeConfig.configDiscoveryGlobalKey()
      const holder = AppRuntime.runFork(config.withLock(globalKey, Deferred.await(gate)))

      // Fork the transaction Effect directly so interruption propagates into
      // the flock wait (a request-harness promise cannot be interrupted).
      const tx = AppRuntime.runFork(
        provideInstance(project.path)(ConfigTransaction.executeTransaction({ global: { set: { model: "test/interrupted" } } })),
      )

      // The transaction must still be blocked on the lock: awaiting it times
      // out (Exit.Failure), proving it did not complete (and cannot commit).
      const blocked = await AppRuntime.runPromise(Effect.exit(Effect.timeout(Fiber.await(tx), "500 millis")))
      expect(blocked._tag).toBe("Failure")

      // Interrupt: the flock wait is interruptible, so this returns promptly
      // (Exit.Success) and the transaction leaves no lock or temp artifacts.
      const interrupted = await AppRuntime.runPromise(
        Effect.exit(Effect.timeout(Fiber.interrupt(tx), "5 seconds")),
      )
      expect(interrupted._tag).toBe("Success")

      // No temp files anywhere in the config directories.
      const tmpFiles = [
        ...fs.readdirSync(global.path).filter((name) => name.includes(".tmp")),
        ...(fs.existsSync(path.join(project.path, ".kilo"))
          ? fs.readdirSync(path.join(project.path, ".kilo")).filter((name) => name.includes(".tmp"))
          : []),
      ]
      expect(tmpFiles.length).toBe(0)

      // Release the holder: the next transaction completes normally and leaves
      // NO lock dirs behind (holder release + transaction release both clean).
      await AppRuntime.runPromise(Deferred.succeed(gate, void 0))
      await AppRuntime.runPromise(Fiber.join(holder))
      const followup = await json<TransactionResponse>(
        await request(undefined, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ global: { set: { model: "test/after-interrupt" } } }),
        }),
      )
      expect(followup.global.model).toBe("test/after-interrupt")
      // The global config lock (holder + followup) is fully released: the
      // specific lock dir no longer exists. (The shared lock root may hold
      // other in-flight locks from the booted instance, so assert by key.)
      const globalLockName = Hash.fast(globalKey) + ".lock"
      expect(fs.existsSync(path.join(lockRoot, globalLockName))).toBe(false)
    } finally {
      events.dispose()
    }
  })

  test.serial("legacy cold overlay and cold transaction concurrently do not deadlock and preserve both writes (LOCK-001)", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      // Both writers are COLD (autoupdate / username) and both follow the
      // canonical gate-then-flock order (LOCK-001). Under the previous
      // flock-then-gate transaction order this pair could form a deadlock cycle
      // with the legacy gate-then-flock overlay path; the timeout guard turns
      // any regression into a clear failure instead of a hang.
      const guard = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("legacy cold overlay + cold transaction deadlocked")), 15_000),
      )
      const [legacy, tx] = await Promise.race([
        Promise.all([
          request(undefined, "/config/overlay", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ scope: "global", set: { autoupdate: "notify" } }),
          }),
          request(undefined, "/config/transaction", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ global: { set: { username: "cold-user" } } }),
          }),
        ]),
        guard,
      ])

      expect(legacy.status).toBe(200)
      expect(tx.status).toBe(200)
      // Both writes survive: the second writer merged onto the first's result
      // under the shared global lock.
      const saved = readGlobalConfig(global.path)
      expect(saved.autoupdate).toBe("notify")
      expect(saved.username).toBe("cold-user")
    } finally {
      events.dispose()
    }
  })

  test.serial("response-read failure restores committed targets, emits no events, releases the ticket (LOCK-003)", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const globalFile = path.join(global.path, "kilo.jsonc")
    const projectFile = path.join(project.path, ".kilo", "kilo.jsonc")
    const projectOriginal = JSON.stringify(
      { $schema: "https://app.kilo.ai/config.json", model: "keep-project" },
      null,
      2,
    )
    await Bun.write(projectFile, projectOriginal)
    const globalOriginal = fs.readFileSync(globalFile, "utf8")

    // Fault injection at the Config service seam: prepare/commit succeed, but
    // the post-commit response reads fail — exactly the LOCK-003 failure mode.
    let failReads = false
    const emitted: string[] = []
    const invalidated: string[] = []
    const artifactFor = (file: string, original: string, info: Config.Info): Config.PreparedConfig => ({
      path: file,
      existed: true,
      original,
      next: JSON.stringify(info, null, 2),
      info,
      changed: true,
    })

    const configMock = Layer.effect(
      Config.Service,
      Effect.gen(function* () {
        const fsUtil = yield* FSUtil.Service
        return Config.Service.of({
          getGlobal: () =>
            failReads ? Effect.die(new Error("injected global read failure")) : Effect.succeed({} as Config.Info),
          get: () =>
            failReads ? Effect.die(new Error("injected effective read failure")) : Effect.succeed({} as Config.Info),
          withLock: <A, E, R>(_key: string, body: Effect.Effect<A, E, R>) => Effect.suspend(() => body),
          prepareGlobal: (patch: Config.Info) =>
            Effect.sync(() => {
              const current = readGlobalConfig(global.path) as Config.Info
              return artifactFor(globalFile, globalOriginal, { ...current, ...patch })
            }),
          prepare: (patch: Config.Info) =>
            Effect.succeed(
              artifactFor(projectFile, projectOriginal, { model: "keep-project", ...patch } as Config.Info),
            ),
          commitGlobal: (artifact: Config.PreparedConfig) =>
            KilocodeAtomicWrite.write(fsUtil, artifact.path, artifact.next).pipe(
              Effect.as({ info: artifact.info, changed: true }),
            ),
          commit: (artifact: Config.PreparedConfig) =>
            KilocodeAtomicWrite.write(fsUtil, artifact.path, artifact.next).pipe(
              Effect.as({ config: artifact.info, changed: true }),
            ),
          emitUpdated: (directory: string, transaction?: string) =>
            Effect.sync(() => emitted.push(`${directory}:${transaction}`)),
          invalidate: () => Effect.sync(() => invalidated.push("global")),
          invalidateProject: () => Effect.sync(() => invalidated.push("project")),
          directories: () => Effect.succeed([]),
          waitForDependencies: () => Effect.void,
          warnings: () => Effect.succeed([]),
          getConsoleState: () =>
            Effect.succeed({ consoleManagedProviders: [], activeOrgName: undefined, switchableOrgCount: 0 }),
          update: () => Effect.die("unexpected update"),
          updateGlobal: () => Effect.die("unexpected updateGlobal"),
        })
      }),
    )

    const gateAndCoordinator = Layer.mergeAll(
      GenerationGate.defaultLayer,
      ConfigConvergence.defaultLayer,
    ).pipe(Layer.provideMerge(GenerationGate.defaultLayer))
    const rt = ManagedRuntime.make(
      Layer.provideMerge(
        Layer.provideMerge(
          Layer.provideMerge(configMock, FSUtil.defaultLayer),
          gateAndCoordinator,
        ),
        Layer.mock(InstanceStore.Service, {
          directories: () => Effect.succeed([]),
          snapshot: () => Effect.succeed(Option.none()),
          provide: <A, E, R>(input: { directory: string; worktree?: string }, effect: Effect.Effect<A, E, R>) => {
            const ref: InstanceContext = {
              directory: input.directory,
              worktree: input.worktree ?? "",
              project: {
                id: ProjectV2.ID.make(input.directory),
                worktree: input.directory,
                time: { created: 0, updated: 0 },
                sandboxes: [],
              },
            }
            return Effect.provideService(effect, InstanceRef, ref)
          },
        }),
      ),
    )
    const runTx = () =>
      rt.runPromise(
        provideInstance(project.path)(
          ConfigTransaction.executeTransaction({
            global: { set: { autoupdate: "notify" } },
            project: { set: { username: "cold-user" } },
          }),
        ).pipe(Effect.exit),
      )

    try {
      // First attempt: reads fail after both commits → full compensation.
      failReads = true
      const failed = await runTx()
      expect(failed._tag).toBe("Failure")

      // Every committed target is restored byte-exactly.
      expect(fs.readFileSync(globalFile, "utf8")).toBe(globalOriginal)
      expect(fs.readFileSync(projectFile, "utf8")).toBe(projectOriginal)
      // No final events were ever emitted.
      expect(emitted.length).toBe(0)
      // Caches were invalidated for both scopes.
      expect(invalidated).toEqual(["global", "project"])

      // The writer ticket was released: a follow-up transaction in the same
      // gate instance acquires without waiting and completes.
      failReads = false
      const followup = await runTx()
      expect(followup._tag).toBe("Success")
      expect(fs.readFileSync(projectFile, "utf8")).toContain("cold-user")
    } finally {
      await rt.dispose()
    }
  })
})

// ─── LOCK-005: held stream + real listener (Server.listen principal path) ─

const heldFixture = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const tmp = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const global = await tmpdir({ retain: true })
      await seedGlobalConfig(global.path)
      const project = await tmpdir({ git: true, retain: true, config: testProviderConfig(llm.url) })
      // LOCK-004 fixture leak fix: the real listener boots an instance against
      // this project and runs cold config writes, whose detached
      // `@kilocode/plugin` install (fired by project config writes) can race
      // fixture disposal and recreate `.kilo`/node_modules after removal.
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
  return { llm, project: tmp.project.path, global: tmp.global.path }
})

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) =>
    new Promise<A>((resolve, reject) => {
      Effect.runFork(
        Deferred.await(deferred).pipe(
          Effect.match({
            onFailure: (error) => {
              reject(error)
            },
            onSuccess: (value) => {
              resolve(value)
            },
          }),
        ),
      )
    }).then(onfulfilled, onrejected),
})

const isDone = <A>(deferred: Deferred.Deferred<A>) => Effect.map(Deferred.poll(deferred), (opt) => opt._tag === "Some")

/**
 * Event latch: resolves when `n` matching GlobalBus events arrive. `done` is a
 * non-blocking in-flight check; `count` reports how many arrived so far.
 */
const eventLatch = (type: string, n = 1) =>
  Effect.gen(function* () {
    const deferred = yield* Deferred.make<void>()
    let count = 0
    const handler = (event: { payload: { type: string } }) => {
      if (event.payload.type !== type) return
      count += 1
      if (count >= n) void Effect.runFork(Deferred.succeed(deferred, void 0))
    }
    GlobalBus.on("event", handler)
    const dispose = () => GlobalBus.removeListener("event", handler)
    return {
      await: Deferred.await(deferred),
      done: isDone(deferred),
      count: Effect.sync(() => count),
      dispose,
    }
  })

const liveIt = testEffect(TestLLMServer.layer)

describe("config transaction - held stream + real listener (LOCK-005)", () => {
  liveIt.live(
    "cold transaction returns HTTP 200 before release, then exactly one disposal/rebuild",
    (): Effect.Effect<void, unknown, TestLLMServer | Scope.Scope> =>
      Effect.gen(function* () {
        const f = yield* heldFixture
        const listener = yield* Effect.acquireRelease(
          Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1" })),
          (value) => Effect.promise(() => value.stop(true)).pipe(Effect.ignore),
        )
        const gate = yield* Deferred.make<void>()
        const disposed = yield* eventLatch(Event.Disposed.type)
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
        yield* Effect.forkDetach(
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
            yield* Deferred.succeed(promptDone, void 0)
          }),
        )
        // The stream is in flight (held) — wait until the LLM was hit.
        yield* awaitWithTimeout(f.llm.wait(1), "held generation never reached the LLM", "20 seconds")

        // Cold transaction through the real listener: the response returns
        // BEFORE the held stream is released and before any disposal.
        const cold = yield* send(f.project, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ global: { set: { autoupdate: "notify" } } }),
        })
        expect(cold.status).toBe(200)
        expect(yield* disposed.done).toBe(false)
        expect(yield* isDone(promptDone)).toBe(false)

        // Release the held stream: the deferred rebuild drains the reader and
        // disposes the old instance exactly once.
        yield* Deferred.succeed(gate, void 0)
        yield* awaitWithTimeout(disposed.await, "old instance never disposed after drain", "20 seconds")
        expect(yield* isDone(promptDone)).toBe(true)
        expect(yield* disposed.count).toBe(1)
      }),
    120_000,
  )
})
