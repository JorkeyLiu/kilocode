/**
 * Deterministic cold ConfigUpdated publish-ordering tests (LOCK-002/003/004).
 *
 * Problem being closed: all five cold config paths (legacy `/config`,
 * `/global/config`, global/project `/config/overlay`, and `/config/transaction`)
 * previously emitted ConfigUpdated INSIDE `withWriteTicket.run` — before
 * `forkRebuild` had registered the rebuild. The GenerationGate blocked new
 * readers, but an SSE client could observe the ConfigUpdated event before the
 * writer ticket was handed to the rebuild.
 *
 * LOCK-002 contract: withWriteTicket now runs persist/response → forkRebuild
 * registration/transfer → deferred final event effect → handler returns. So a
 * cold ConfigUpdated can only be observed AFTER the rebuild registration owns
 * the writer ticket.
 *
 * Determinism (no network timing): both the rebuild registration
 * (`probeRebuildRegistration`, a synchronous hook in `forkRebuild`) and the
 * ConfigUpdated publish (`GlobalBus`, a synchronous EventEmitter) execute in
 * the handler fiber in program order. The probe and the event latch share one
 * append-only order array, so by the time the GlobalBus listener observes the
 * ConfigUpdated publish the registration entry is already present.
 *
 * Hot behavior is unchanged (LOCK-001): hot patches still emit immediately and
 * register no rebuild. No-op patches emit nothing and register no rebuild.
 */
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Deferred, Effect } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Server } from "../../../src/server/server"
import { Config } from "../../../src/config/config"
import { Event } from "../../../src/server/event"
import { GlobalBus, type GlobalEvent } from "../../../src/bus/global"
import { awaitRebuilds, probeRebuildRegistration } from "../../../src/kilocode/server/config-rebuild"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { markPluginDependenciesReady, markProjectConfigReady } from "../../fixture/plugin"

void Log.init({ print: false })

const original = Global.Path.config

/**
 * LOCK-003 fixture leak fix: per-test tmpdirs are removed by afterEach AFTER
 * instances are disposed and rebuilds settle (see config-transaction.test.ts).
 */
const tdirs: Array<Awaited<ReturnType<typeof tmpdir>>> = []

afterEach(async () => {
  ;(Global.Path as { config: string }).config = original
  GlobalBus.removeAllListeners("event")
  probeRebuildRegistration.uninstall()
  // Drain forked rebuilds first so no detached fiber leaks events into the
  // next test; propagate rebuild failures instead of masking them.
  await Effect.runPromise(awaitRebuilds())
  await disposeAllInstances()
  await resetDatabase()
  await Promise.all(tdirs.splice(0).map((dir) => dir[Symbol.asyncDispose]()))
})

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
  // LOCK-003 fixture leak fix: the global config dir is the first
  // ConfigPaths.directories entry, so every booted instance triggers a
  // detached `Npm.install("@kilocode/plugin")` into it. The stub marks the
  // same dependencies ready the plugin fixture contract expects.
  await markPluginDependenciesReady(dir)
}

/**
 * LOCK-004 order probe: one shared append-only array written synchronously by
 * (a) the ConfigRebuild registration hook inside forkRebuild and (b) the
 * GlobalBus listener observing the ConfigUpdated publish. Both run in the
 * handler fiber in program order, so the array order is a deterministic
 * happens-before proof. `wait` resolves through a Deferred latch when the
 * ConfigUpdated event fires.
 */
function installOrderProbe() {
  // The probe's own module-level array is the shared append-only log: the
  // rebuild registration hook and this GlobalBus listener both write into it.
  probeRebuildRegistration.install()
  const order = probeRebuildRegistration.entries()
  const latch = Deferred.makeUnsafe<void>()
  const handler = (event: GlobalEvent) => {
    if (event.payload?.type === Event.ConfigUpdated.type) {
      order.push({ kind: "config-updated" })
      Deferred.doneUnsafe(latch, Effect.succeed(void 0))
    }
  }
  GlobalBus.on("event", handler)
  return {
    order,
    wait: () => Effect.runPromise(Deferred.await(latch)),
    dispose: () => GlobalBus.removeListener("event", handler),
  }
}

/** Assert the registration entry precedes the ConfigUpdated entry. */
function expectRegistrationBeforeEvent(order: Array<{ kind: "rebuild-registered" | "config-updated" }>) {
  const registerIdx = order.findIndex((entry) => entry.kind === "rebuild-registered")
  const eventIdx = order.findIndex((entry) => entry.kind === "config-updated")
  expect(registerIdx).toBeGreaterThanOrEqual(0)
  expect(eventIdx).toBeGreaterThanOrEqual(0)
  expect(registerIdx).toBeLessThan(eventIdx)
}

// ─── Cold ordering: registration owns the ticket before the event ─────

describe("cold ConfigUpdated publish ordering (LOCK-002/003/004)", () => {
  test.serial("/config (project) cold: rebuild registration recorded before ConfigUpdated", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const probe = installOrderProbe()

    try {
      const response = request(project.path, "/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoupdate: false } as Config.Info),
      })
      // The response only completes after the deferred event effect ran, so
      // the latch and the response are equivalent gates; await both.
      await Promise.all([json(await response), probe.wait()])
      expectRegistrationBeforeEvent(probe.order)
    } finally {
      probe.dispose()
    }
  })

  test.serial("/global/config (global) cold: rebuild registration recorded before ConfigUpdated", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const probe = installOrderProbe()

    try {
      const response = request(undefined, "/global/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoupdate: "notify" } as Config.Info),
      })
      await Promise.all([json(await response), probe.wait()])
      expectRegistrationBeforeEvent(probe.order)
    } finally {
      probe.dispose()
    }
  })

  test.serial("/config/overlay global cold: rebuild registration recorded before ConfigUpdated", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const probe = installOrderProbe()

    try {
      const response = request(undefined, "/config/overlay", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "global", set: { autoupdate: "notify" } }),
      })
      await Promise.all([json(await response), probe.wait()])
      expectRegistrationBeforeEvent(probe.order)
    } finally {
      probe.dispose()
    }
  })

  test.serial("/config/overlay project cold: rebuild registration recorded before ConfigUpdated", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const probe = installOrderProbe()

    try {
      const response = request(project.path, "/config/overlay", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "project", set: { autoupdate: false } }),
      })
      await Promise.all([json(await response), probe.wait()])
      expectRegistrationBeforeEvent(probe.order)
    } finally {
      probe.dispose()
    }
  })

  test.serial("/config/transaction cold: rebuild registration recorded before ConfigUpdated", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const probe = installOrderProbe()

    try {
      const response = request(undefined, "/config/transaction", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ global: { set: { autoupdate: "notify" } } }),
      })
      await Promise.all([json(await response), probe.wait()])
      expectRegistrationBeforeEvent(probe.order)
    } finally {
      probe.dispose()
    }
  })

  test.serial("mixed cold transaction (global+project) emits one event per scope, all after registration", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ git: true, retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const probe = installOrderProbe()

    try {
      const response = request(project.path, "/config/transaction", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          global: { set: { autoupdate: "notify" } },
          project: { set: { username: "cold-user" } },
        }),
      })
      await Promise.all([json(await response), probe.wait()])
      // Exactly one rebuild is registered; both scope events follow it.
      const registrations = probe.order.filter((entry) => entry.kind === "rebuild-registered")
      const events = probe.order.filter((entry) => entry.kind === "config-updated")
      expect(registrations.length).toBe(1)
      expect(events.length).toBe(2)
      const registerIdx = probe.order.findIndex((entry) => entry.kind === "rebuild-registered")
      const firstEventIdx = probe.order.findIndex((entry) => entry.kind === "config-updated")
      expect(registerIdx).toBeLessThan(firstEventIdx)
    } finally {
      probe.dispose()
    }
  })
})

// ─── Hot immediate behavior unchanged (LOCK-001) ──────────────────────

describe("hot ConfigUpdated emission unchanged (LOCK-001)", () => {
  test.serial("/config/overlay global hot: emits immediately, registers no rebuild", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const probe = installOrderProbe()

    try {
      const response = request(undefined, "/config/overlay", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "global", set: { model: "test/hot-model" } }),
      })
      await Promise.all([json(await response), probe.wait()])
      // The event fired with zero rebuild registrations.
      expect(probe.order.filter((entry) => entry.kind === "rebuild-registered").length).toBe(0)
      expect(probe.order.some((entry) => entry.kind === "config-updated")).toBe(true)
    } finally {
      probe.dispose()
    }
  })

  test.serial("/global/config hot: emits immediately, registers no rebuild", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const probe = installOrderProbe()

    try {
      const response = request(undefined, "/global/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test/hot-global" } as Config.Info),
      })
      await Promise.all([json(await response), probe.wait()])
      expect(probe.order.filter((entry) => entry.kind === "rebuild-registered").length).toBe(0)
      expect(probe.order.some((entry) => entry.kind === "config-updated")).toBe(true)
    } finally {
      probe.dispose()
    }
  })

  test.serial("/config/transaction hot: emits immediately, registers no rebuild", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const probe = installOrderProbe()

    try {
      const response = request(undefined, "/config/transaction", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ global: { set: { model: "test/hot-tx" } } }),
      })
      await Promise.all([json(await response), probe.wait()])
      expect(probe.order.filter((entry) => entry.kind === "rebuild-registered").length).toBe(0)
      expect(probe.order.some((entry) => entry.kind === "config-updated")).toBe(true)
    } finally {
      probe.dispose()
    }
  })
})

// ─── No-op: emits none, rebuild none (LOCK-003) ───────────────────────

describe("config no-op emits none and registers no rebuild (LOCK-003)", () => {
  test.serial("/config/transaction cold semantic no-op: no event, no rebuild registration", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const probe = installOrderProbe()

    try {
      // Cold key set to its existing value: prepared as a semantic no-op
      // (the same value is a no-op whether the key is hot or cold).
      const result = await json<{ global: Config.Info }>(
        await request(undefined, "/config/transaction", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ global: { set: { permission: { bash: "allow" } } } }),
        }),
      )
      expect(result.global.permission).toMatchObject({ bash: "allow" })
      expect(probe.order.length).toBe(0)
    } finally {
      probe.dispose()
    }
  })

  test.serial("/config/overlay empty patch: no event, no rebuild registration", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const probe = installOrderProbe()

    try {
      await json<Config.Info>(
        await request(undefined, "/config/overlay", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "global", set: {} }),
        }),
      )
      expect(probe.order.length).toBe(0)
    } finally {
      probe.dispose()
    }
  })
})
