// LOCK-005: AppLayer default graph identity tests.
//
// Proves the default AppLayer graph references exactly one canonical Provider
// layer object (Provider.defaultLayer) and one canonical combined models layer
// object (Provider.defaultModels), matching the feature defaultLayers that
// internally provide Provider.defaultLayer (e.g. LLM.defaultLayer).
//
// Uses only public APIs: Layer.buildWithMemoMap with a fresh MemoMap plus
// service identity assertions across two graph builds. No private Effect
// internals, no network I/O (KILO_DISABLE_MODELS_FETCH + disabled kilo/apertis).

import { expect } from "bun:test"
import { Effect, Exit, Layer, Scope } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ModelsDev as CoreModelsDev } from "@opencode-ai/core/models-dev"
import { makeAppLayer } from "@/effect/app-runtime"
import { Provider } from "@/provider/provider"
import * as KiloModelsDev from "@/provider/models"
import { LLM } from "@/session/llm"
import { it } from "../lib/effect"
import * as Ownership from "@/retention/ownership"

it.instance(
  "LOCK-005: default AppLayer resolves Provider, Kilo, Core, and LLM through canonical layers",
  () =>
    Effect.gen(function* () {
      const memo = Layer.makeMemoMapUnsafe()
      const scope = yield* Scope.make()

      // Deterministic: never fetch models.dev or kilo/apertis gateways.
      const disabled = Flag.KILO_DISABLE_MODELS_FETCH
      Flag.KILO_DISABLE_MODELS_FETCH = true
      try {
        // Default graph: models = Provider.defaultModels, provider = Provider.defaultLayer.
        const ctx = yield* Layer.buildWithMemoMap(makeAppLayer(), memo, scope)

        const appResolved = yield* Effect.gen(function* () {
          const provider = yield* Provider.Service
          const kilo = yield* KiloModelsDev.Service
          const core = yield* CoreModelsDev.Service
          const llm = yield* LLM.Service

          expect(provider).toBeDefined()
          expect(kilo).toBeDefined()
          expect(core).toBeDefined()
          expect(llm).toBeDefined()

          // Provider reads the catalog through the Kilo wrapper backed by core —
          // deterministic empty catalog under KILO_DISABLE_MODELS_FETCH.
          const list = yield* provider.list()
          expect(typeof list).toBe("object")
          return { provider, kilo }
        }).pipe(Effect.provide(ctx))

        // Canonical identity: LLM.defaultLayer internally provides the singleton
        // Provider.defaultLayer, which reads through the canonical
        // Provider.defaultModels. Building these canonical layer objects against
        // the same memoMap as the app graph must resolve the exact same Provider
        // and Kilo service instances — proving the default app graph shares one
        // Provider layer object and one canonical combined models layer object.
        const featureCtx = yield* Layer.buildWithMemoMap(
          Layer.mergeAll(
    Ownership.layer,
LLM.defaultLayer, Provider.defaultLayer, Provider.defaultModels),
          memo,
          scope,
        )
        const featureResolved = yield* Effect.gen(function* () {
          const provider = yield* Provider.Service
          const kilo = yield* KiloModelsDev.Service
          return { provider, kilo }
        }).pipe(Effect.provide(featureCtx))

        expect(featureResolved.provider).toBe(appResolved.provider)
        expect(featureResolved.kilo).toBe(appResolved.kilo)
      } finally {
        Flag.KILO_DISABLE_MODELS_FETCH = disabled
        yield* Scope.close(scope, Exit.void)
      }
    }),
  { config: { disabled_providers: ["kilo", "apertis"] } },
)

// LOCK-003: custom models without a matching custom provider is a compile-time
// error — the makeCoreLayer/makeAppLayer overloads only allow () or
// (models, provider), so an injected catalog can never silently merge while
// Provider reads the defaults. Enforced by typecheck (tests are in the
// tsgo --noEmit project); the listener test passes the full custom pair.
{
  const customModels = KiloModelsDev.combinedLayer()
  // @ts-expect-error - custom models require a matching custom provider
  const mismatched = makeAppLayer(customModels)
  void mismatched
}
