// kilocode_change - P4.4-T7 simplified: kilo dynamic model injection removed, only generic loader helpers remain
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { kiloCustomLoaders, patchKiloProviderPrivacy } from "../../src/kilocode/provider/provider"
import { testEffect } from "../lib/effect"

const input = {
  id: "kilo",
  env: ["KILO_API_KEY"],
  models: {
    "free-model": {
      id: "free-model",
      name: "Free Model",
      cost: { input: 0, output: 0 },
      limit: { context: 128000, output: 4096 },
    },
    "paid-model": {
      id: "paid-model",
      name: "Paid Model",
      cost: { input: 1, output: 2 },
      limit: { context: 128000, output: 4096 },
    },
  },
}

function load(data?: { auth?: object; config?: object; env?: Record<string, string | undefined> }) {
  return kiloCustomLoaders({
    auth: () => Effect.succeed(data?.auth),
    config: () => Effect.succeed(data?.config ?? {}),
    env: () => Effect.succeed(data?.env ?? {}),
    get: () => Effect.succeed(undefined),
  }).kilo(input)
}

const it = testEffect(Layer.empty)

it.effect("enables a paid catalog anonymously without auth", () =>
  Effect.gen(function* () {
    const result = yield* load()
    expect(result.autoload).toBe(true)
    expect(result.options).toEqual({ apiKey: "anonymous" })
  }),
)

it.effect("enables a paid catalog when config apiKey is present", () =>
  Effect.gen(function* () {
    const result = yield* load({ config: { provider: { kilo: { options: { apiKey: "test-key" } } } } })
    expect(result.autoload).toBe(true)
    expect(result.options).toEqual({})
  }),
)

it.effect("denies provider data collection when prompt-training models are hidden", () =>
  Effect.gen(function* () {
    const result = yield* load({ config: { hide_prompt_training_models: true } })
    expect(result.options).toEqual({ apiKey: "anonymous", dataCollection: "deny" })
  }),
)

it.effect("keeps data collection denied after configured options are applied", () =>
  Effect.sync(() => {
    const provider = { options: { dataCollection: "allow", baseURL: "https://api.kilo.ai" } }
    patchKiloProviderPrivacy(provider, { hide_prompt_training_models: true })
    expect(provider.options).toEqual({ dataCollection: "deny", baseURL: "https://api.kilo.ai" })
  }),
)

it.effect("enables a paid catalog when auth exists", () =>
  Effect.gen(function* () {
    const result = yield* load({ auth: { type: "api", key: "test-key" } })
    expect(result.autoload).toBe(true)
    expect(result.options).toEqual({})
  }),
)
