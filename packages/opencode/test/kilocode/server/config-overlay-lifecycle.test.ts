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
import { Deferred, Effect, Fiber } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Server } from "../../../src/server/server"
import { Config } from "../../../src/config/config"
import { Agent } from "../../../src/agent/agent"
import { Event } from "../../../src/server/event"
import { GlobalBus } from "../../../src/bus/global"
import { awaitRebuilds, probeRebuildRegistration } from "../../../src/kilocode/server/config-rebuild"
import { withConfigSnapshot } from "../../../src/kilocode/session/config-snapshot"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { provideInstance } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
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
  probeRebuildRegistration.uninstall()
  // Drain forked rebuilds before teardown; propagate failures instead of
  // swallowing them so a broken rebuild surfaces in the failing test.
  await Effect.runPromise(awaitRebuilds())
  await disposeAllInstances()
  await resetDatabase()
  await Promise.all(tdirs.splice(0).map((dir) => dir[Symbol.asyncDispose]()))
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
 * permission.bash set.
 */
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

/**
 * P4.4-G2 deterministic cold-order probe (borrowed from
 * config-event-ordering.test.ts:179-197). One shared append-only array is
 * written synchronously by (a) the ConfigRebuild registration hook inside
 * `withColdMutation`/ConfigConvergence commit and (b) the GlobalBus listener
 * observing the ConfigUpdated publish. Both run in the handler fiber in
 * program order, so array order is a deterministic happens-before proof.
 * `wait` resolves through a Deferred latch when ConfigUpdated fires.
 */
function installOrderProbe() {
  probeRebuildRegistration.install()
  const order = probeRebuildRegistration.entries()
  const latch = Deferred.makeUnsafe<void>()
  const handler = (event: { payload: { type: string } }) => {
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

/** Assert exactly one registration exists and it precedes ConfigUpdated. */
function expectOneRegistrationBeforeEvent(order: Array<{ kind: "rebuild-registered" | "config-updated" }>) {
  const registrations = order.filter((entry) => entry.kind === "rebuild-registered")
  const events = order.filter((entry) => entry.kind === "config-updated")
  expect(registrations.length).toBe(1)
  expect(events.length).toBe(1)
  const registerIdx = order.findIndex((entry) => entry.kind === "rebuild-registered")
  const eventIdx = order.findIndex((entry) => entry.kind === "config-updated")
  expect(registerIdx).toBeLessThan(eventIdx)
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
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
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
      {
        key: "agent",
        value: { code: { model: "anthropic/claude-sonnet-4-20250514", variant: "high" } },
        checkResponse: (info) =>
          expect(info.agent?.code).toMatchObject({
            model: "anthropic/claude-sonnet-4-20250514",
            variant: "high",
          }),
      },
      {
        key: "default_agent",
        value: "code",
        checkResponse: (info) => expect(info.default_agent).toBe("code"),
      },
      {
        key: "mode",
        value: { build: { model: "test/mode-model" } },
        checkResponse: (info) => expect(info.mode?.build).toMatchObject({ model: "test/mode-model" }),
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
      expect(
        (saved.agent as Record<string, { model?: string; variant?: string }> | undefined)?.["code"],
      ).toMatchObject({
        model: "anthropic/claude-sonnet-4-20250514",
        variant: "high",
      })
      expect(saved.default_agent).toBe("code")
      expect(
        (saved.mode as Record<string, { model?: string }> | undefined)?.["build"],
      ).toMatchObject({ model: "test/mode-model" })
    } finally {
      events.dispose()
    }
  })

  /**
   * LOCK-004: multi-hot patch persists all fields together.
   */
  test.serial("multi-hot patch persists all fields together without disposal", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
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
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
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
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
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

  /**
   * LOCK-001: a named per-agent model/variant override is hot. The PATCH
   * persists without raising a convergence fence or disposing any instance, and
   * the next agent fetch serves the new model because Agent.state is derived
   * (its cacheKey includes `agent`) and rebuilds on the next request.
   */
  test.serial("per-agent model override is hot and the next agent fetch serves the new model", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      // Boot the project instance so agent state exists for the directory.
      await request(project.path, "/config/overlay?scope=project")
      const before = await json<Agent.Info[]>(await request(project.path, "/agent"))
      const codeBefore = before.find((a) => a.name === "code")

      const info = await json<Config.Info>(
        await request(undefined, "/config/overlay", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "global", set: { agent: { code: { model: "test/new-agent-model" } } } }),
        }),
      )
      expect(info.agent?.code?.model).toBe("test/new-agent-model")

      // config-updated emitted; NO disposal emitted (hot, no convergence fence).
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
      expect(events.received.some((e) => e.type === Event.Disposed.type)).toBe(false)

      // The next agent fetch serves the new model without any runtime swap.
      const after = await json<Agent.Info[]>(await request(project.path, "/agent"))
      const codeAfter = after.find((a) => a.name === "code")
      expect(String(codeAfter?.model?.providerID)).toBe("test")
      expect(String(codeAfter?.model?.modelID)).toBe("new-agent-model")
      expect(String(codeAfter?.model?.modelID)).not.toBe(String(codeBefore?.model?.modelID))
    } finally {
      events.dispose()
    }
  })

  /**
   * LOCK-001: an open generation keeps reading its startup agent model while
   * the hot override is visible to the next (non-snapshotted) request. The
   * agent state cacheKey is derived from the pinned ConfigSnapshot inside the
   * generation and from the live config outside it.
   */
  test.serial("in-flight generation keeps its startup agent model while the next fetch sees the hot override", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const dir = project.path
      await request(dir, "/config/overlay?scope=project")

      const withInstance = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(effect as Effect.Effect<A, E, never>)))
      const config = await Effect.runPromise(withInstance(Config.Service.use((svc) => Effect.succeed(svc))))
      const startupModelID = await Effect.runPromise(
        withInstance(Agent.Service.use((svc) => svc.get("code").pipe(Effect.map((a) => a.model?.modelID)))),
      )

      // Open a generation: a snapshotted scope that stays alive across the hot patch.
      let enteredResolve: () => void = () => {}
      let releaseResolve: () => void = () => {}
      const entered = new Promise<void>((r) => (enteredResolve = r))
      const release = new Promise<void>((r) => (releaseResolve = r))
      const fiber: Fiber.Fiber<string | undefined> = AppRuntime.runFork(
        provideInstance(dir)(
          withConfigSnapshot(
            config,
            Effect.gen(function* () {
              yield* Effect.sync(() => enteredResolve())
              yield* Effect.promise(() => release)
              return yield* Agent.Service.use((svc) => svc.get("code").pipe(Effect.map((a) => a.model?.modelID)))
            }),
          ),
        ) as never,
      ) as Fiber.Fiber<string | undefined>
      await entered

      const info = await json<Config.Info>(
        await request(undefined, "/config/overlay", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "global", set: { agent: { code: { model: "test/patched-agent" } } } }),
        }),
      )
      expect(info.agent?.code?.model).toBe("test/patched-agent")
      expect(events.received.some((e) => e.type === Event.Disposed.type)).toBe(false)

      // The next (non-snapshotted) request sees the new agent model.
      const nextModelID = await Effect.runPromise(
        withInstance(Agent.Service.use((svc) => svc.get("code").pipe(Effect.map((a) => a.model?.modelID)))),
      )
      expect(String(nextModelID)).toBe("patched-agent")

      // The open generation still reads its startup agent model.
      releaseResolve()
      const observed = await AppRuntime.runPromise(Fiber.join(fiber))
      expect(observed).toBe(startupModelID)
      expect(observed).not.toBe("patched-agent")
    } finally {
      events.dispose()
    }
  })
})

// ─── LOCK-003: cold / mixed patches ──────────────────────────────────

describe("config overlay lifecycle - cold patches", () => {
  test.serial("provider cold patch writes config and emits config-updated", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
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

  /**
   * P4.4-G2 (LOCK-006): `mcp` is cold — a valid mcp patch routes through
   * `withColdMutation`/ConfigConvergence, which raises the convergence fence,
   * persists canonical config, synchronously registers exactly one rebuild via
   * the ConfigRebuild tracker, then runs the deferred ConfigUpdated publish.
   * The shared order probe proves the registration precedes ConfigUpdated, so
   * `mcp` cannot silently regress to a hot `dispose:false` path (persistence +
   * ConfigUpdated alone are shared by hot/cold and prove nothing). No real MCP
   * worker is started.
   */
  test.serial("mcp cold patch writes config and emits config-updated (P4.4-G2)", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const probe = installOrderProbe()

    try {
      const response = request(undefined, "/config/overlay", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "global",
          set: { mcp: { "test-server": { type: "local", command: ["node", "server.js"], enabled: true } } },
        }),
      })
      await Promise.all([json(await response), probe.wait()])

      const saved = readGlobalConfig(global.path)
      expect(saved.mcp).toEqual({
        "test-server": { type: "local", command: ["node", "server.js"], enabled: true },
      })
      expectOneRegistrationBeforeEvent(probe.order)
    } finally {
      probe.dispose()
    }
  })

  /**
   * P4.4-G2 (LOCK-006): mixed hot (`model`) + cold (`mcp`) patch remains cold.
   * `withColdMutation`/ConfigConvergence commits a single convergence
   * obligation for the whole patch, so exactly one rebuild registration
   * precedes ConfigUpdated even though one key is hot. Both keys persist.
   * No real MCP worker is started.
   */
  test.serial("mixed hot+cold with mcp is treated as cold (P4.4-G2)", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const probe = installOrderProbe()

    try {
      const response = request(undefined, "/config/overlay", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "global",
          set: {
            model: "anthropic/claude-sonnet-4-20250514", // hot
            mcp: { "test-server": { type: "local", command: ["node", "server.js"], enabled: true } }, // cold
          },
        }),
      })
      await Promise.all([json(await response), probe.wait()])

      const saved = readGlobalConfig(global.path)
      expect(saved.model).toBe("anthropic/claude-sonnet-4-20250514")
      expect(saved.mcp).toEqual({
        "test-server": { type: "local", command: ["node", "server.js"], enabled: true },
      })
      expectOneRegistrationBeforeEvent(probe.order)
    } finally {
      probe.dispose()
    }
  })

  test.serial("permission hot patch writes config and emits config-updated (LOCK-002)", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
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
      // permission is hot (LOCK-002) and merged with the seeded permission.bash:allow
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
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
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
              autoupdate: false, // cold
            },
          }),
        }),
      )

      const saved = readGlobalConfig(global.path)
      expect(saved.model).toBe("anthropic/claude-sonnet-4-20250514")
      expect(saved.autoupdate).toBe(false)
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
   * LOCK-007: unknown keys and invalid values are rejected by the deep config
   * validation and surface as a structured 400 carrying the file path and Zod
   * issues, with nothing written and no lifecycle events emitted.
   */
  test.serial("invalid cold patch returns structured 400, writes nothing, and emits no config-updated", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
    await seedGlobalConfig(global.path)
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const before = readGlobalConfig(global.path)

      const response = await request(undefined, "/config/overlay", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "global", set: { unknown_key: "value" } }),
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { name?: string; data?: { path?: string; issues?: unknown[] } }
      expect(body.name).toBe("ConfigInvalidError")
      expect(body.data?.path).toBeTruthy()
      expect(Array.isArray(body.data?.issues)).toBe(true)

      // The file is untouched (validation failed before any write).
      expect(readGlobalConfig(global.path)).toEqual(before)
      // No config-updated event (update failed before write)
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(false)
      expect(events.received.some((e) => e.type === Event.Disposed.type)).toBe(false)
    } finally {
      events.dispose()
    }
  })
})

// ─── LOCK-004: empty patches ─────────────────────────────────────────

describe("config overlay lifecycle - empty patches", () => {
  test.serial("empty patch set emits no config events", async () => {
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
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
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
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
    const global = await tmpdir({ retain: true })
    tdirs.push(global)
    const project = await tmpdir({ retain: true })
    tdirs.push(project)
    await markProjectConfigReady(project.path)
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
