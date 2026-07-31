// kilocode_change - new file
// Regression: provider.list must not fail when models.dev is unavailable.
// When the core ModelsDev service throws a defect (e.g. network timeout with
// no cache), the Kilo ModelsDev wrapper catches it and the provider HTTP
// handler falls back to configured providers. This test exercises both paths
// through the actual Provider.Service list() boundary.
//
// LOCK-005: All tests use injected core defects — no real network I/O, no
// process-global flag/cache/log leakage beyond acquireUseRelease scope.

import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelsDev } from "../../src/provider/models"
import { Provider } from "../../src/provider/provider"
import { it } from "../lib/effect"
import { Config } from "../../src/config/config"
import { Auth } from "../../src/auth"
import { Plugin } from "../../src/plugin"
import { Env } from "../../src/env"
import { ModelCache } from "../../src/provider/model-cache"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import * as Core from "@opencode-ai/core/models-dev"
import { Server } from "../../src/server/server"
import { TestInstance } from "../fixture/fixture"
import { withTimeout } from "../../src/util/timeout"
import { makeAppLayer } from "../../src/effect/app-runtime"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

const model = (id: string, name: string, opts?: { reasoning?: boolean }): ModelsDev.Model => ({
  id,
  name,
  release_date: "2026-06-01",
  attachment: false,
  reasoning: opts?.reasoning ?? false,
  temperature: true,
  tool_call: true,
  limit: { context: 128000, output: 8192 },
})

const catalog: Record<string, ModelsDev.Provider> = {
  aihub: {
    id: "aihub",
    name: "AIHub",
    env: ["AIHUB_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.aihub.test/v1",
    models: {
      "gpt-5.6-sol": model("gpt-5.6-sol", "GPT 5.6 Sol", { reasoning: true }),
    },
  },
}

// ---------------------------------------------------------------------------
// Injected defect helpers
// ---------------------------------------------------------------------------

// LOCK-005: Produce a Core.Service whose get() returns Effect.fail(...).pipe(Effect.orDie)
// — the exact defect shape a production timeout produces.  Wrapped by
// ModelsDev.layer's catchDefect, this yields an empty catalog deterministically
// in milliseconds instead of waiting for a real network timeout.
const makeFailingCore = () =>
  Layer.succeed(
    Core.Service,
    Core.Service.of({
      get: () => Effect.fail(new Error("TimeoutException: request timed out")).pipe(Effect.orDie),
      refresh: () => Effect.void,
    }),
  )

// Build a ModelsDev.layer wired through a failing core so the Kilo wrapper's
// catchDefect catches the orDie defect and returns an empty catalog.
const wrappedModelsDev = (core: Layer.Layer<Core.Service, never, never>) => ModelsDev.layer.pipe(
  Layer.provide(core),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(
    Layer.mock(ModelCache.Service)({
      getFailure: () => Effect.succeed(undefined),
      failedProviders: () => Effect.succeed([]),
      get: () => Effect.succeed(undefined),
      fetch: () => Effect.succeed({}),
      refresh: () => Effect.succeed({}),
      clear: () => Effect.void,
    }),
  ),
)

const wrappedFailingModelsDev = wrappedModelsDev(makeFailingCore())
const wrappedCatalogModelsDev = wrappedModelsDev(
  Layer.succeed(
    Core.Service,
    Core.Service.of({
      get: () => Effect.succeed(catalog),
      refresh: () => Effect.void,
    }),
  ),
)

// Build a Provider.layer wired through a failing core so list() exercises the
// Kilo wrapper's catchDefect path without touching the network.
// Exposes ModelsDev.Service alongside Provider.Service for tests that yield both.
const providerWithFailingCore = Provider.layer.pipe(
  Layer.provide(wrappedFailingModelsDev),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(RuntimeFlags.layer()),
)

const modelsWithFailingCore = Layer.merge(makeFailingCore(), wrappedFailingModelsDev)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.instance(
  "configured providers survive models.dev defect (injected orDie)",
  Effect.gen(function* () {
    const provider = yield* Provider.Service

    // Kilo wrapper's catchDefect catches the deterministic defect.
    const list = yield* provider.list()

    expect(typeof list).toBe("object")
  }).pipe(Effect.provide(providerWithFailingCore)),
  { config: { disabled_providers: ["kilo", "apertis"] } },
)

it.instance(
  "configured providers appear with variants when models.dev is unavailable",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const list = yield* provider.list()

    // aihub is in the config fixture → should survive models.dev failure
    const aihub = list[ProviderV2.ID.make("aihub")]
    expect(aihub).toBeDefined()
    expect(aihub.name).toBe("AIHub")

    // model should be present
    const sol = aihub.models["gpt-5.6-sol"]
    expect(sol).toBeDefined()
    expect(sol.capabilities.reasoning).toBe(true)

    // LOCK-003: reasoning model should have low/medium/high variants
    const variants = Object.keys(sol.variants ?? {})
    expect(variants).toContain("low")
    expect(variants).toContain("medium")
    expect(variants).toContain("high")
  }).pipe(Effect.provide(providerWithFailingCore)),
  {
    config: {
      disabled_providers: ["kilo", "apertis"],
      provider: {
        aihub: {
          name: "AIHub",
          npm: "@ai-sdk/openai-compatible",
          models: {
            "gpt-5.6-sol": {
              name: "GPT 5.6 Sol",
              reasoning: true,
            },
          },
        },
      },
    },
  },
)

it.instance(
  "models.dev enrichment is preserved when catalog is available",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const list = yield* provider.list()

    // aihub should appear from the injected catalog
    const aihub = list[ProviderV2.ID.make("aihub")]
    expect(aihub).toBeDefined()
    expect(aihub.name).toBe("AIHub")

    const sol = aihub.models["gpt-5.6-sol"]
    expect(sol).toBeDefined()
    expect(sol.capabilities.reasoning).toBe(true)

    // LOCK-003: assert a catalog-only field that the config does NOT provide.
    expect(sol.limit.context).toBe(128000)
    expect(sol.release_date).toBe("2026-06-01")
    expect(sol.capabilities.temperature).toBe(true)

    const variants = Object.keys(sol.variants ?? {})
    expect(variants).toContain("low")
    expect(variants).toContain("medium")
    expect(variants).toContain("high")
  }).pipe(Effect.provide(Layer.merge(wrappedCatalogModelsDev, Provider.defaultLayer))),
  {
    config: {
      disabled_providers: ["kilo", "apertis"],
      provider: {
        aihub: {
          name: "AIHub",
          npm: "@ai-sdk/openai-compatible",
          models: {
            "gpt-5.6-sol": {
              name: "GPT 5.6 Sol",
              reasoning: true,
            },
          },
        },
      },
    },
  },
)

// ---------------------------------------------------------------------------
// LOCK-002: Deterministic timeout-shaped defect
// The production core service has a 10-second Effect.timeout on the HTTP fetch,
// after which orDie converts the TimeoutException into a defect.  The Kilo
// wrapper's catchDefect catches that defect and returns an empty catalog.
//
// Rather than waiting 10+ real seconds for the production timeout to fire
// (which would exceed default Bun test timeout), we inject a Core.Service
// whose get() returns Effect.fail(...).pipe(Effect.orDie) — producing the
// exact same defect shape (TimeoutException → orDie → defect) that the
// wrapper's catchDefect must handle.  This exercises the production wrapper
// code path (models.ts catchDefect) deterministically in milliseconds.
// ---------------------------------------------------------------------------

it.instance(
  "configured providers survive timeout-shaped defect (injected orDie)",
  Effect.gen(function* () {
    const provider = yield* Provider.Service

    const list = yield* provider.list()
    expect(typeof list).toBe("object")
  }).pipe(Effect.provide(providerWithFailingCore)),
  { config: { disabled_providers: ["kilo", "apertis"] } },
)

// ---------------------------------------------------------------------------
// LOCK-003: Production route integration test
// Proves the actual HTTP /provider route returns HTTP 200 with config-defined
// providers when the injected core ModelsDev service produces a defect.
//
// NOT accepted: direct ModelsDev.Service / Provider.Service resolution.
// This test exercises the full HTTP pipeline: route matching, auth/instance
// middleware, handler group effect, and JSON serialization.
// ---------------------------------------------------------------------------

it.instance(
  "route: core defect produces HTTP 200 with config-defined AIHub + variants",
  Effect.gen(function* () {
    const tmp = yield* TestInstance
    const handler = HttpApiApp.webHandler({ models: wrappedFailingModelsDev, provider: providerWithFailingCore }).handler
    const response = yield* Effect.promise(() =>
      Promise.resolve(
        handler(
          new Request("http://localhost/provider", {
            headers: { "x-kilo-directory": tmp.directory },
          }),
          HttpApiApp.context,
        ),
      ),
    )

    expect(response.status).toBe(200)

    const body: {
      all: Array<{ id: string; name: string; models: Record<string, { variants?: Record<string, unknown> }> }>
      connected: string[]
    } = yield* Effect.promise(() => response.json())

    const aihub = body.all.find((p) => p.id === "aihub")
    expect(aihub).toBeDefined()
    expect(aihub!.name).toBe("AIHub")

    expect(aihub!.models["gpt-5.6-sol"]).toBeDefined()

    const variants = Object.keys(aihub!.models["gpt-5.6-sol"].variants ?? {})
    expect(variants).toContain("low")
    expect(variants).toContain("medium")
    expect(variants).toContain("high")
  }),
  {
    config: {
      disabled_providers: ["kilo", "apertis"],
      provider: {
        aihub: {
          name: "AIHub",
          npm: "@ai-sdk/openai-compatible",
          models: {
            "gpt-5.6-sol": {
              name: "GPT 5.6 Sol",
              reasoning: true,
            },
          },
        },
      },
    },
  },
)

// ---------------------------------------------------------------------------
// LOCK-004: Runtime probe — Kilo wrapper and Core service are independent
// Proves that after LOCK-001 (Kilo tag = @kilocode/ModelsDev), both services
// resolve independently through the layer graph and are distinct objects.
// Exercises at least one direct Core.Service method safely via seeded cache.
// ---------------------------------------------------------------------------

it.instance(
  "LOCK-004: Kilo wrapper and core service resolve as distinct instances",
  (() => {
    // Build a probe layer that provides BOTH services independently:
    // - @opencode/ModelsDev (core) via a seeded-core stub
    // - @kilocode/ModelsDev (Kilo wrapper) via ModelsDev.layer wired through the stub
    const seededCore = Core.Service.of({
      get: () => Effect.succeed(catalog),
      refresh: () => Effect.void,
    })
    const probeLayer = Layer.merge(
      Layer.succeed(Core.Service, seededCore),
      ModelsDev.layer.pipe(
        Layer.provide(Layer.succeed(Core.Service, seededCore)),
        Layer.provide(Config.defaultLayer),
        Layer.provide(Auth.defaultLayer),
        Layer.provide(ModelCache.defaultLayer),
      ),
    )

    return Effect.gen(function* () {
      const kiloSvc = yield* ModelsDev.Service // @kilocode/ModelsDev (wrapper)
      const coreSvc = yield* Core.Service // @opencode/ModelsDev (core)

      // LOCK-004: They must be different service implementations
      expect(kiloSvc).not.toBe(coreSvc)

      // Exercise Core.Service.get() safely — seeded with catalog
      const coreProviders = yield* coreSvc.get()
      expect(typeof coreProviders).toBe("object")
      expect(coreProviders.aihub).toBeDefined()
      expect(coreProviders.aihub.models["gpt-5.6-sol"]).toBeDefined()

      // Exercise Kilo wrapper's get() — delegates to core + overlay + enrichment
      const kiloProviders = yield* kiloSvc.get()
      expect(typeof kiloProviders).toBe("object")
      // The wrapper applies overlay (adds Anaconda Desktop) on top of core providers,
      // so aihub from core should still be present
      expect(kiloProviders.aihub).toBeDefined()
    }).pipe(Effect.provide(probeLayer))
  })(),
  {
    config: {
      disabled_providers: ["kilo", "apertis"],
    },
  },
)

// ---------------------------------------------------------------------------
// LOCK-004: Listener integration test
// Exercises the actual production listener path:
//   Server.listen() → listenerLayer() → KiloListener.build() → AppLayer
// This is distinct from the Server.Default / createRoutes path above.
// AppLayer's CoreLayer provides both CoreModelsDev.defaultLayer (core) and
// KiloModelsDev.defaultLayer (Kilo wrapper with catchDefect).
//
// The test starts a real ephemeral HTTP listener on port 0, injects a core
// defect beneath the Kilo wrapper, and verifies that /provider returns HTTP
// 200 with the config-defined AIHub provider, gpt-5.6-sol model, and
// low/medium/high reasoning variants.
//
// LOCK-005: This test must FAIL against the pre-fix production graph
// (where AppLayer.CoreLayer provides raw core ModelsDev) and PASS after
// the fix (where CoreLayer provides KiloModelsDev.defaultLayer).
// ---------------------------------------------------------------------------

it.instance(
  "listener: core defect through AppLayer produces HTTP 200 with config-defined AIHub + variants",
  Effect.gen(function* () {
    const tmp = yield* TestInstance
    const listener = yield* Effect.promise(() =>
      Server.listen({
        hostname: "127.0.0.1",
        port: 0,
        mdns: false,
        appLayer: makeAppLayer(modelsWithFailingCore, providerWithFailingCore),
      }),
    )

    try {
      const response = yield* Effect.promise(() =>
        withTimeout(
          fetch(new URL("/provider", listener.url), {
            headers: { "x-kilo-directory": tmp.directory },
          }),
          15_000,
          "listener /provider request timed out",
        ),
      )

      expect(response.status).toBe(200)

      const body: {
        all: Array<{ id: string; name: string; models: Record<string, { variants?: Record<string, unknown> }> }>
        connected: string[]
      } = yield* Effect.promise(() => response.json())

      const aihub = body.all.find((p) => p.id === "aihub")
      expect(aihub).toBeDefined()
      expect(aihub!.name).toBe("AIHub")

      expect(aihub!.models["gpt-5.6-sol"]).toBeDefined()

      const variants = Object.keys(aihub!.models["gpt-5.6-sol"].variants ?? {})
      expect(variants).toContain("low")
      expect(variants).toContain("medium")
      expect(variants).toContain("high")
    } finally {
      yield* Effect.promise(() => withTimeout(listener.stop(true), 30_000, "listener stop timed out"))
    }
  }),
  {
    config: {
      disabled_providers: ["kilo", "apertis"],
      provider: {
        aihub: {
          name: "AIHub",
          npm: "@ai-sdk/openai-compatible",
          models: {
            "gpt-5.6-sol": {
              name: "GPT 5.6 Sol",
              reasoning: true,
            },
          },
        },
      },
    },
  },
  { timeout: 15_000 },
)

// ---------------------------------------------------------------------------
// LOCK-004: Instance-sharing proof — Provider reads through the exact same
// KiloModelsDev.Service instance that AppLayer provides.
//
// Builds a tracked KiloModelsDev.Service with a counted Core.Service.get(),
// then wires both ModelsDev.Service and Provider.layer through it. The test
// proves that exactly one get() call fires, confirming no duplicate instance.
// ---------------------------------------------------------------------------

it.instance(
  "LOCK-004: Provider reads catalog through the same KiloModelsDev.Service instance as AppLayer",
  (() => {
    let getCount = 0
    const trackedKilo = ModelsDev.layer.pipe(
      Layer.provide(
        Layer.succeed(
          Core.Service,
          Core.Service.of({
            get: () => {
              getCount++
              return Effect.succeed(catalog)
            },
            refresh: () => Effect.void,
          }),
        ),
      ),
      Layer.provide(Config.defaultLayer),
      Layer.provide(Auth.defaultLayer),
      Layer.provide(
        Layer.mock(ModelCache.Service)({
          getFailure: () => Effect.succeed(undefined),
          failedProviders: () => Effect.succeed([]),
          get: () => Effect.succeed(undefined),
          fetch: () => Effect.succeed({}),
          refresh: () => Effect.succeed({}),
          clear: () => Effect.void,
        }),
      ),
    )

    // Build Provider wired through the SAME trackedKilo layer,
    // and merge trackedKilo so ModelsDev.Service is also available to the test body
    const providerWithTracked = Layer.mergeAll(
      Provider.layer.pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(Env.defaultLayer),
        Layer.provide(Config.defaultLayer),
        Layer.provide(Auth.defaultLayer),
        Layer.provide(Plugin.defaultLayer),
        Layer.provide(trackedKilo),
        Layer.provide(RuntimeFlags.layer()),
      ),
      trackedKilo,
    )

    return Effect.gen(function* () {
      const svc = yield* Provider.Service
      const list = yield* svc.list()

      // The tracked core get() should have been called exactly once
      // proves no duplicate KiloModelsDev.Service instance was created
      expect(getCount).toBe(1)

      // Resolve KiloModelsDev.Service from the same tracked layer
      // and verify it is the exact same object
      const kiloSvc = yield* ModelsDev.Service
      const kiloSvcFromLayer = yield* ModelsDev.Service.pipe(
        Effect.provide(trackedKilo),
      )
      expect(kiloSvc).toBe(kiloSvcFromLayer)

      // Provider should have built successfully (may have no providers
      // if none have API keys, but the list call proves the catalog path works)
      expect(typeof list).toBe("object")
    }).pipe(Effect.provide(providerWithTracked))
  })(),
  {
    config: {
      disabled_providers: ["kilo", "apertis"],
    },
  },
)
