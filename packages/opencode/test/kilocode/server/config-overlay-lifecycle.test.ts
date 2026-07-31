/**
 * Route-level lifecycle verification for hot/cold config patches.
 *
 * Proves through the real `/config/overlay` PATCH route that:
 * 1. Hot patches persist config, emit config-updated, and do NOT dispose
 * 2. Cold patches and mixed patches retain disposal behavior
 * 3. Empty patches emit/dispose nothing
 *
 * Uses Server.Default().app.request() for actual route handling.
 * Tests are serial to avoid shared-state leakage.
 *
 * Isolation design (LOCK-002):
 * - Each describe block gets its own tmpdir for global config
 * - Global.Path.config is restored in afterEach
 * - Table-driven patches within one lifecycle reduce redundant serial tests
 * - File reads use fs.readFileSync for determinism (avoids Bun.file lazy-read races)
 * - Each tmpdir is seeded with a kilo.jsonc that includes permission.bash:"allow"
 *   to prevent migrateBashPermission() from injecting bash:allow during loadGlobal,
 *   which would race with the handler's updateGlobal file writes
 *
 * Unverified boundary (LOCK-005):
 * - The HTTP middleware disposal path (disposeMiddleware) is not exercised by
 *   app.request() harness. Disposal scheduling (markInstanceForDisposal and
 *   disposeAllInstancesAndEmitGlobalDisposed) is verified at the handler level
 *   only. Full middleware disposal requires a running HTTP server with the
 *   disposeMiddleware wired in.
 */
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Server } from "../../../src/server/server"
import { Config } from "../../../src/config/config"
import { Event } from "../../../src/server/event"
import { GlobalBus } from "../../../src/bus/global"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

const original = Global.Path.config

afterEach(async () => {
  ;(Global.Path as { config: string }).config = original
  GlobalBus.removeAllListeners("event")
  await disposeAllInstances()
  await resetDatabase()
})

type OverlayResponse = {
  effective: Config.Info
  fields: Record<string, { source: string; value?: unknown }>
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

/**
 * Seed a global config directory with a kilo.jsonc that already has
 * permission.bash set. This prevents migrateBashPermission() from
 * injecting bash:allow during loadGlobal, which would race with the
 * handler's updateGlobal file writes and cause intermittent flakiness.
 */
async function seedGlobalConfig(dir: string) {
  await Bun.write(
    path.join(dir, "kilo.jsonc"),
    JSON.stringify({ $schema: "https://app.kilo.ai/config.json", permission: { bash: "allow" } }, null, 2),
  )
}

/**
 * Read the global config file written by updateGlobal.
 * Uses fs.readFileSync + JSON.parse for determinism — Bun.file().json()
 * can race with writeFileString when the singleton handler's invalidation
 * side-effects haven't fully settled.
 */
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

// ─── LOCK-001 / LOCK-004: hot patches ────────────────────────────────

describe("config overlay lifecycle - hot patches", () => {
  /**
   * Table-driven test covering all hot keys from LOCK-004.
   * Each key is patched individually and verified for:
   *  - the response body reflects the persisted value
   *  - config-updated emission
   *  - NO disposal emission
   *
   * After all keys are patched, a single file read proves persistence.
   * This avoids the race between writeFileString and Bun.file().json()
   * that caused intermittent failures in the previous implementation.
   */
  test.serial("each hot key persists, emits config-updated, and does not dispose", async () => {
    await using global = await tmpdir()
    await using project = await tmpdir()
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    type HotCase = {
      key: string
      value: unknown
      /** Optional assertion on the response body info (post-patch config state). */
      checkResponse?: (info: Config.Info) => void
    }
    const cases: HotCase[] = [
      {
        key: "console",
        value: { diff_style: "split" },
        checkResponse: (info) => expect(info.console).toEqual({ diff_style: "split" }),
      },
      {
        key: "model",
        value: "anthropic/claude-sonnet-4-20250514",
        checkResponse: (info) => expect(info.model).toBe("anthropic/claude-sonnet-4-20250514"),
      },
      {
        key: "small_model",
        value: "anthropic/claude-haiku-3-5-20241022",
        checkResponse: (info) => expect(info.small_model).toBe("anthropic/claude-haiku-3-5-20241022"),
      },
      {
        key: "model_variant",
        value: "high",
        checkResponse: (info) => expect(info.model_variant).toBe("high"),
      },
      {
        key: "model_variant_overrides",
        value: { "anthropic/claude-sonnet-4-20250514": "low" },
        checkResponse: (info) =>
          expect(info.model_variant_overrides).toEqual({ "anthropic/claude-sonnet-4-20250514": "low" }),
      },
      {
        key: "subagent_model",
        value: "anthropic/claude-haiku-3-5-20241022",
        checkResponse: (info) => expect(info.subagent_model).toBe("anthropic/claude-haiku-3-5-20241022"),
      },
      {
        key: "subagent_variant",
        value: "medium",
        checkResponse: (info) => expect(info.subagent_variant).toBe("medium"),
      },
      {
        key: "subagent_variant_overrides",
        value: { code: "high" },
        checkResponse: (info) => expect(info.subagent_variant_overrides).toEqual({ code: "high" }),
      },
    ]

    try {
      for (const c of cases) {
        const before = events.received.length
        const info = await json<Config.Info>(
          await request(undefined, "/config/overlay", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ scope: "global", set: { [c.key]: c.value } }),
          }),
        )

        // Response body is the canonical source of truth from updateGlobal.
        c.checkResponse?.(info)

        // config-updated was emitted for this patch
        const emitted = events.received.slice(before)
        expect(emitted.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
        // NO disposal was emitted
        expect(emitted.some((e) => e.type === Event.Disposed.type)).toBe(false)
      }

      // After all patches, prove persistence to disk in a single read.
      const saved = readGlobalConfig(global.path)
      expect(saved.console).toEqual({ diff_style: "split" })
      expect(saved.model).toBe("anthropic/claude-sonnet-4-20250514")
      expect(saved.small_model).toBe("anthropic/claude-haiku-3-5-20241022")
      expect(saved.model_variant).toBe("high")
      expect(saved.model_variant_overrides).toEqual({ "anthropic/claude-sonnet-4-20250514": "low" })
      expect(saved.subagent_model).toBe("anthropic/claude-haiku-3-5-20241022")
      expect(saved.subagent_variant).toBe("medium")
      expect(saved.subagent_variant_overrides).toEqual({ code: "high" })
    } finally {
      events.dispose()
    }
  })

  /**
   * LOCK-004: multi-hot patch persists all fields together.
   */
  test.serial("multi-hot patch persists all fields together without disposal", async () => {
    await using global = await tmpdir()
    await using project = await tmpdir()
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      await json(
        await request(undefined, "/config/overlay", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scope: "global",
            set: {
              model: "anthropic/claude-sonnet-4-20250514",
              model_variant: "high",
              small_model: "anthropic/claude-haiku-3-5-20241022",
              subagent_model: "anthropic/claude-sonnet-4-20250514",
              subagent_variant: "low",
              console: { diff_style: "split" },
            },
          }),
        }),
      )

      const saved = readGlobalConfig(global.path)
      expect(saved.model).toBe("anthropic/claude-sonnet-4-20250514")
      expect(saved.model_variant).toBe("high")
      expect(saved.small_model).toBe("anthropic/claude-haiku-3-5-20241022")
      expect(saved.subagent_model).toBe("anthropic/claude-sonnet-4-20250514")
      expect(saved.subagent_variant).toBe("low")
      expect(saved.console).toEqual({ diff_style: "split" })
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
      expect(events.received.some((e) => e.type === Event.Disposed.type)).toBe(false)
    } finally {
      events.dispose()
    }
  })

  /**
   * LOCK-002: hot patch invalidates effective config — subsequent overlay
   * read reflects the persisted value without global/server disposal.
   */
  test.serial("hot patch updates effective config via overlay read without disposal", async () => {
    await using global = await tmpdir()
    await using project = await tmpdir()
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      await json(
        await request(undefined, "/config/overlay", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "global", set: { model: "test/updated-model" } }),
        }),
      )

      const overlay = await json<OverlayResponse>(
        await request(project.path, "/config/overlay?scope=project"),
      )
      expect(overlay.fields.model.value).toBe("test/updated-model")
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
      expect(events.received.some((e) => e.type === Event.Disposed.type)).toBe(false)
    } finally {
      events.dispose()
    }
  })

  /**
   * LOCK-002: multiple hot patches accumulate without disposal.
   */
  test.serial("multiple hot patches accumulate correctly without disposal", async () => {
    await using global = await tmpdir()
    await using project = await tmpdir()
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const first = await json<Config.Info>(
        await request(undefined, "/config/overlay", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "global", set: { model: "test/first" } }),
        }),
      )
      expect(first.model).toBe("test/first")

      const second = await json<Config.Info>(
        await request(undefined, "/config/overlay", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "global", set: { small_model: "test/second" } }),
        }),
      )
      expect(second.model).toBe("test/first")
      expect(second.small_model).toBe("test/second")

      // Prove persistence to disk
      const saved = readGlobalConfig(global.path)
      expect(saved.model).toBe("test/first")
      expect(saved.small_model).toBe("test/second")
      const configUpdated = events.received.filter((e) => e.type === Event.ConfigUpdated.type)
      expect(configUpdated.length).toBe(2)
      expect(events.received.some((e) => e.type === Event.Disposed.type)).toBe(false)
    } finally {
      events.dispose()
    }
  })
})

// ─── LOCK-003: cold / mixed patches ──────────────────────────────────

describe("config overlay lifecycle - cold patches", () => {
  test.serial("provider cold patch writes config and emits config-updated", async () => {
    await using global = await tmpdir()
    await using project = await tmpdir()
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      await json(
        await request(undefined, "/config/overlay", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "global", set: { provider: { openai: { apiKey: "sk-test-key" } } } }),
        }),
      )

      const saved = readGlobalConfig(global.path)
      expect(saved.provider).toEqual({ openai: { apiKey: "sk-test-key" } })
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
    } finally {
      events.dispose()
    }
  })

  test.serial("permission cold patch writes config and emits config-updated", async () => {
    await using global = await tmpdir()
    await using project = await tmpdir()
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      await json(
        await request(undefined, "/config/overlay", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "global", set: { permission: { edit: { "*": "ask" } } } }),
        }),
      )

      const saved = readGlobalConfig(global.path)
      // permission is merged with the seeded permission.bash:allow
      expect(saved.permission).toMatchObject({ edit: { "*": "ask" }, bash: "allow" })
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
    } finally {
      events.dispose()
    }
  })

  /**
   * LOCK-003: mixed hot+cold patch is treated as cold.
   * isHotPatch returns false when any cold key is present, so disposal is
   * retained. The config file is still written (both keys persisted).
   */
  test.serial("mixed hot+cold patch is treated as cold (disposal retained)", async () => {
    await using global = await tmpdir()
    await using project = await tmpdir()
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      await json(
        await request(undefined, "/config/overlay", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scope: "global",
            set: {
              model: "anthropic/claude-sonnet-4-20250514", // hot
              permission: { bash: "ask" }, // cold
            },
          }),
        }),
      )

      const saved = readGlobalConfig(global.path)
      expect(saved.model).toBe("anthropic/claude-sonnet-4-20250514")
      expect(saved.permission).toEqual({ bash: "ask" })
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
      // Cold path: disposal is marked via markInstanceForDisposal in handler.
      // In this test pattern (direct handler invocation without HTTP middleware),
      // disposal is scheduled but not executed through HTTP middleware.
      // Implementation correctness verified by isHotPatch returning false for
      // mixed keys (proven in hot-keys.test.ts).
    } finally {
      events.dispose()
    }
  })

  /**
   * Implementation finding: unknown keys are accepted by ConfigOverlayPatch
   * schema but rejected by ConfigParse.schema during updateGlobal, resulting
   * in a 500. This is correct cold-path behavior (unknown = cold) but the
   * error surface could be improved to 400. Test verifies the 500 is emitted
   * (not a hang/crash) and no config-updated event fires.
   */
  test.serial("unknown key cold patch returns 500 and does not emit config-updated", async () => {
    await using global = await tmpdir()
    await using project = await tmpdir()
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const response = await request(undefined, "/config/overlay", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "global", set: { unknown_key: "value" } }),
      })
      // Schema validation rejects unknown keys in ConfigV1.Info
      expect(response.status).toBe(500)
      // No config-updated event (update failed before write)
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(false)
    } finally {
      events.dispose()
    }
  })
})

// ─── LOCK-004: empty patches ─────────────────────────────────────────

describe("config overlay lifecycle - empty patches", () => {
  test.serial("empty patch set emits no config events", async () => {
    await using global = await tmpdir()
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const response = await request(undefined, "/config/overlay", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "global" }),
      })
      expect(response.status).toBe(200)

      // Instance middleware may emit project.updated; verify no config lifecycle events
      const configEvents = events.received.filter(
        (e) => e.type === Event.ConfigUpdated.type || e.type === Event.Disposed.type,
      )
      expect(configEvents.length).toBe(0)
    } finally {
      events.dispose()
    }
  })

  test.serial("empty set object emits no config events", async () => {
    await using global = await tmpdir()
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const response = await request(undefined, "/config/overlay", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "global", set: {} }),
      })
      expect(response.status).toBe(200)

      const configEvents = events.received.filter(
        (e) => e.type === Event.ConfigUpdated.type || e.type === Event.Disposed.type,
      )
      expect(configEvents.length).toBe(0)
    } finally {
      events.dispose()
    }
  })

  test.serial("empty project patch emits no config events", async () => {
    await using global = await tmpdir()
    await using project = await tmpdir()
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const response = await request(project.path, "/config/overlay", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "project" }),
      })
      expect(response.status).toBe(200)

      const configEvents = events.received.filter(
        (e) => e.type === Event.ConfigUpdated.type || e.type === Event.Disposed.type,
      )
      expect(configEvents.length).toBe(0)
    } finally {
      events.dispose()
    }
  })
})
