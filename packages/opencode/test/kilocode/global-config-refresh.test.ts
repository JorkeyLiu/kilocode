import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Permission } from "../../src/permission"
import { GlobalBus } from "../../src/bus/global"
import { Server } from "../../src/server/server"
import { Event } from "../../src/server/event"
import { registerDisposer } from "../../src/effect/instance-registry"
import { awaitRebuilds } from "../../src/kilocode/server/config-rebuild"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const root = Global.Path.config

function app() {
  return Server.Default().app
}

async function update(target: ReturnType<typeof app>, provider: "kilo" | "openrouter") {
  return target.request("/global/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ indexing: { provider } }),
  })
}

async function provider(target: ReturnType<typeof app>, directory: string) {
  const response = await target.request("/config", { headers: { "x-kilo-directory": directory } })
  return (await response.json()).indexing?.provider as string | undefined
}

async function config(dir: string, value: object) {
  await Bun.write(path.join(dir, "kilo.json"), JSON.stringify(value))
}

async function edit(target: ReturnType<typeof app>, directory: string) {
  const response = await target.request("/config", { headers: { "x-kilo-directory": directory } })
  const body = (await response.json()) as { permission?: unknown }
  return Permission.evaluate(
    "edit",
    "*",
    Permission.fromConfig((body.permission ?? {}) as Parameters<typeof Permission.fromConfig>[0]),
  ).action
}

afterEach(async () => {
  // Drain any pending rebuild so a detached fiber cannot leak events into the
  // next test; awaitRebuilds propagates a rebuild failure instead of masking it.
  await Effect.runPromise(awaitRebuilds())
  ;(Global.Path as { config: string }).config = root
  await disposeAllInstances()
  await resetDatabase()
})

describe("global config refresh", () => {
  test("update persists and returns before rebuild disposal completes", async () => {
    await using config = await tmpdir({ retain: true })
    await using workspace = await tmpdir({ retain: true, config: { formatter: false, lsp: false } })
    ;(Global.Path as { config: string }).config = config.path
    await disposeAllInstances()
    const target = app()

    // Seed a cold patch whose rebuild fully completes before the disposer is
    // held, and load the workspace instance so the next rebuild covers it.
    expect((await update(target, "openrouter")).status).toBe(200)
    expect(await provider(target, workspace.path)).toBe("openrouter")

    // Hold the disposer: the next rebuild fiber blocks inside it until
    // released, proving the PATCH does not wait for disposal (LOCK-002).
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const unregister = registerDisposer(async (directory) => {
      if (directory !== workspace.path) return
      started.resolve()
      await release.promise
    })
    let disposed = 0
    const onDisposed = (event: { payload: { type: string } }) => {
      if (event.payload.type === Event.Disposed.type) disposed += 1
    }
    GlobalBus.on("event", onDisposed)
    try {
      const pending = update(target, "kilo")
      // The PATCH persists and returns while the rebuild disposer is still
      // blocked — no waiting on disposal, no timing races.
      expect((await pending).status).toBe(200)
      await started.promise
      // The file is persisted while the disposer is still blocked.
      const saved = JSON.parse(await Bun.file(path.join(config.path, "kilo.jsonc")).text())
      expect(saved.indexing.provider).toBe("kilo")
      // No rebuild completion yet: the rebuild is stuck in the held disposer.
      expect(disposed).toBe(0)

      // Release the disposer; the tracked rebuild completes.
      release.resolve()
      await Effect.runPromise(awaitRebuilds())

      // The next request reads the new config on the rebuilt instance.
      expect(await provider(target, workspace.path)).toBe("kilo")
      expect(disposed).toBe(1)
    } finally {
      release.resolve()
      unregister()
      GlobalBus.off("event", onDisposed)
    }
  })

  test("update ignores disposal notification failures", async () => {
    await using config = await tmpdir({ retain: true })
    ;(Global.Path as { config: string }).config = config.path
    await disposeAllInstances()
    const target = app()
    const listener = () => {
      throw new Error("listener failed")
    }
    GlobalBus.on("event", listener)
    try {
      expect((await update(target, "kilo")).status).toBe(200)
    } finally {
      GlobalBus.off("event", listener)
    }
  })

  test("detects external global config edits", async () => {
    await using global = await tmpdir({ retain: true })
    await using workspace = await tmpdir({ retain: true, config: { formatter: false, lsp: false } })
    ;(Global.Path as { config: string }).config = global.path
    await config(global.path, { permission: { edit: "ask" } })
    await disposeAllInstances()
    const target = app()

    expect(await edit(target, workspace.path)).toBe("ask")

    await config(global.path, { permission: { edit: { "*": "allow" } } })

    expect(await edit(target, workspace.path)).toBe("allow")
  })
})
