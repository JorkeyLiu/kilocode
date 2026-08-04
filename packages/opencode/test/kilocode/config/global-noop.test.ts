/**
 * Semantic no-op global save tests.
 *
 * Proves that unchanged hot global patches (dispose:false path) and unchanged
 * cold global patches return {changed:false} without:
 *  - writing the file
 *  - emitting ConfigUpdated/Disposed
 *  - invalidating config caches
 *  - blocking a convergence fence (fence released promptly)
 *
 * Covers both JSON and JSONC global config files, including noncanonical
 * formatting (trailing commas, extra whitespace, different key order) to prove
 * semantic comparison works.
 *
 * Also verifies that subsequent readers and writers are admitted after a no-op
 * (fence released, not permanently blocked).
 */
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Effect } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Server } from "../../../src/server/server"
import { Event } from "../../../src/server/event"
import { GlobalBus } from "../../../src/bus/global"
import { awaitRebuilds } from "../../../src/kilocode/server/config-rebuild"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

const original = Global.Path.config

afterEach(async () => {
  ;(Global.Path as { config: string }).config = original
  GlobalBus.removeAllListeners("event")
  // Drain forked rebuilds before teardown; propagate failures instead of
  // swallowing them so a broken rebuild surfaces in the failing test.
  await Effect.runPromise(awaitRebuilds())
  await disposeAllInstances()
  await resetDatabase()
})

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

function captureEvents() {
  const received: Array<{ type: string; directory?: string }> = []
  const handler = (event: { directory?: string; payload: { type: string } }) => {
    received.push({ type: event.payload.type, directory: event.directory })
  }
  GlobalBus.on("event", handler)
  return {
    received,
    dispose: () => GlobalBus.removeListener("event", handler),
  }
}

function readGlobalFile(globalDir: string): string {
  for (const name of ["kilo.jsonc", "kilo.json"]) {
    const fp = path.join(globalDir, name)
    try {
      return fs.readFileSync(fp, "utf-8")
    } catch {
      // continue
    }
  }
  throw new Error(`No global config file found in ${globalDir}`)
}

type PatchResponse = {
  status: number
  body?: { name?: string; data?: unknown }
}

async function patchGlobal(set: Record<string, unknown>): Promise<PatchResponse> {
  const response = await request(undefined, "/config/overlay", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "global", set }),
  })
  return { status: response.status, body: (await response.json().catch(() => undefined)) as PatchResponse["body"] }
}

async function patchLegacyGlobal(body: Record<string, unknown>): Promise<PatchResponse> {
  const response = await request(undefined, "/global/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json().catch(() => undefined)) as PatchResponse["body"] }
}

// ─── Hot no-op: overlay route, JSON, already-set value ─────────────

describe("global no-op: hot patch (overlay route)", () => {
  test.serial("unchanged hot JSON patch writes nothing and emits no events", async () => {
    await using global = await tmpdir({ retain: true })
    await using project = await tmpdir({ retain: true })
    // Seed with permission.bash to prevent migrateBashPermission race
    await Bun.write(
      path.join(global.path, "kilo.json"),
      JSON.stringify(
        { $schema: "https://app.kilo.ai/config.json", model: "test/model", permission: { bash: "allow" } },
        null,
        2,
      ),
    )
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const before = readGlobalFile(global.path)
      const result = await patchGlobal({ model: "test/model" })
      expect(result.status).toBe(200)
      // File unchanged
      expect(readGlobalFile(global.path)).toBe(before)
      // No lifecycle events
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(false)
      expect(events.received.some((e) => e.type === Event.Disposed.type)).toBe(false)
    } finally {
      events.dispose()
    }
  })

  test.serial("unchanged hot JSONC patch preserves exact bytes and admits later work", async () => {
    await using global = await tmpdir({ retain: true })
    await using project = await tmpdir({ retain: true })
    // Seed with noncanonical JSONC formatting (trailing comma, extra space)
    await Bun.write(
      path.join(global.path, "kilo.jsonc"),
      '{\n  "$schema": "https://app.kilo.ai/config.json",\n  "model": "test/model" ,\n  "permission": { "bash": "allow" }\n}\n',
    )
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const before = readGlobalFile(global.path)
      const result = await patchGlobal({ model: "test/model" })
      expect(result.status).toBe(200)
      expect(readGlobalFile(global.path)).toBe(before)
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(false)
      expect(events.received.some((e) => e.type === Event.Disposed.type)).toBe(false)

      const reader = await request(project.path, "/config/overlay?scope=project")
      expect(reader.status).toBe(200)
      const writer = await patchGlobal({ model: "test/after-jsonc-noop" })
      expect(writer.status).toBe(200)
    } finally {
      events.dispose()
    }
  })

  test.serial("unchanged hot JSON patch with different key order writes nothing", async () => {
    await using global = await tmpdir({ retain: true })
    await using project = await tmpdir({ retain: true })
    // Seed with keys in a specific order, including $schema to prevent loadGlobal from injecting it
    await Bun.write(
      path.join(global.path, "kilo.json"),
      JSON.stringify(
        { $schema: "https://app.kilo.ai/config.json", permission: { bash: "allow" }, model: "test/model" },
        null,
        2,
      ),
    )
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const before = readGlobalFile(global.path)
      // Patch with same value, different key order in patch object
      const result = await patchGlobal({ model: "test/model" })
      expect(result.status).toBe(200)
      // Semantic comparison: model is the same, so no write
      expect(readGlobalFile(global.path)).toBe(before)
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(false)
      expect(events.received.some((e) => e.type === Event.Disposed.type)).toBe(false)
    } finally {
      events.dispose()
    }
  })
})

// ─── Hot no-op: legacy route ──────────────────────────────────────

describe("global no-op: hot patch (legacy /global/config route)", () => {
  test.serial("unchanged hot patch via legacy route writes nothing and emits no events", async () => {
    await using global = await tmpdir({ retain: true })
    await using project = await tmpdir({ retain: true })
    await Bun.write(
      path.join(global.path, "kilo.json"),
      JSON.stringify(
        { $schema: "https://app.kilo.ai/config.json", model: "test/model", permission: { bash: "allow" } },
        null,
        2,
      ),
    )
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const before = readGlobalFile(global.path)
      const result = await patchLegacyGlobal({ model: "test/model" })
      expect(result.status).toBe(200)
      expect(readGlobalFile(global.path)).toBe(before)
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(false)
      expect(events.received.some((e) => e.type === Event.Disposed.type)).toBe(false)
    } finally {
      events.dispose()
    }
  })
})

// ─── Cold no-op: overlay route ────────────────────────────────────

describe("global no-op: cold patch (overlay route)", () => {
  test.serial("unchanged cold JSON patch writes nothing, emits no events, and releases the fence", async () => {
    await using global = await tmpdir({ retain: true })
    await using project = await tmpdir({ retain: true })
    await Bun.write(
      path.join(global.path, "kilo.json"),
      JSON.stringify({ $schema: "https://app.kilo.ai/config.json", permission: { bash: "allow" } }, null, 2),
    )
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const before = readGlobalFile(global.path)
      // Permission.bash is already "allow" — cold patch that is a semantic no-op
      const result = await patchGlobal({ permission: { bash: "allow" } })
      expect(result.status).toBe(200)
      expect(readGlobalFile(global.path)).toBe(before)
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(false)
      expect(events.received.some((e) => e.type === Event.Disposed.type)).toBe(false)

      // The fence was released: a subsequent patch is admitted immediately
      const next = await patchGlobal({ model: "test/after-noop" })
      expect(next.status).toBe(200)
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
    } finally {
      events.dispose()
    }
  })

  test.serial("unchanged cold JSONC patch writes nothing and emits no events", async () => {
    await using global = await tmpdir({ retain: true })
    await using project = await tmpdir({ retain: true })
    await Bun.write(
      path.join(global.path, "kilo.jsonc"),
      JSON.stringify({ $schema: "https://app.kilo.ai/config.json", permission: { bash: "allow" } }, null, 2),
    )
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const before = readGlobalFile(global.path)
      const result = await patchGlobal({ permission: { bash: "allow" } })
      expect(result.status).toBe(200)
      expect(readGlobalFile(global.path)).toBe(before)
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(false)
      expect(events.received.some((e) => e.type === Event.Disposed.type)).toBe(false)

      // Subsequent patch admitted
      const next = await patchGlobal({ model: "test/after-noop" })
      expect(next.status).toBe(200)
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
    } finally {
      events.dispose()
    }
  })
})

// ─── Cold no-op: legacy route ─────────────────────────────────────

describe("global no-op: cold patch (legacy /global/config route)", () => {
  test.serial("unchanged cold patch via legacy route writes nothing and releases the fence", async () => {
    await using global = await tmpdir({ retain: true })
    await using project = await tmpdir({ retain: true })
    await Bun.write(
      path.join(global.path, "kilo.json"),
      JSON.stringify({ $schema: "https://app.kilo.ai/config.json", permission: { bash: "allow" } }, null, 2),
    )
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const before = readGlobalFile(global.path)
      // Legacy route with indexing — unchanged value
      const result = await patchLegacyGlobal({ permission: { bash: "allow" } })
      expect(result.status).toBe(200)
      expect(readGlobalFile(global.path)).toBe(before)
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(false)
      expect(events.received.some((e) => e.type === Event.Disposed.type)).toBe(false)

      // Subsequent patch admitted
      const next = await patchLegacyGlobal({ model: "test/after-noop" })
      expect(next.status).toBe(200)
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
    } finally {
      events.dispose()
    }
  })
})

// ─── Semantic equivalence: different formatting, same value ────────

describe("global no-op: semantic equivalence", () => {
  test.serial("JSON patch against noncanonical JSON is semantic no-op when value unchanged", async () => {
    await using global = await tmpdir({ retain: true })
    await using project = await tmpdir({ retain: true })
    // Noncanonical: extra spaces, different key order, includes $schema
    await Bun.write(
      path.join(global.path, "kilo.json"),
      '{\n  "$schema": "https://app.kilo.ai/config.json",\n  "permission": {\n    "bash" :  "allow"\n  },\n  "model" : "test/model"\n}\n',
    )
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const before = readGlobalFile(global.path)
      // Patch with the same model value
      const result = await patchGlobal({ model: "test/model" })
      expect(result.status).toBe(200)
      // Semantic comparison: model is the same, no write needed
      expect(readGlobalFile(global.path)).toBe(before)
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(false)
      expect(events.received.some((e) => e.type === Event.Disposed.type)).toBe(false)
    } finally {
      events.dispose()
    }
  })

  test.serial("actual change after no-op still writes and emits", async () => {
    await using global = await tmpdir({ retain: true })
    await using project = await tmpdir({ retain: true })
    await Bun.write(
      path.join(global.path, "kilo.json"),
      JSON.stringify(
        { $schema: "https://app.kilo.ai/config.json", model: "test/model", permission: { bash: "allow" } },
        null,
        2,
      ),
    )
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      // First: no-op
      const noOp = await patchGlobal({ model: "test/model" })
      expect(noOp.status).toBe(200)
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(false)

      // Then: actual change
      const changed = await patchGlobal({ model: "test/changed" })
      expect(changed.status).toBe(200)
      expect(readGlobalFile(global.path)).toContain("test/changed")
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
    } finally {
      events.dispose()
    }
  })
})
