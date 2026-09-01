import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { disposeAllInstances } from "../fixture/fixture"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const pid = (s: string) => s as unknown as ProviderV2.ID
const mid = (s: string) => s as unknown as ModelV2.ID

afterEach(async () => {
  await disposeAllInstances()
})

const providerLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Provider.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(RuntimeFlags.layer(flags)),
  )

const list = Provider.use.list()

const alphaProviderConfig = {
  provider: {
    "custom-provider": {
      name: "Custom Provider",
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.custom.com/v1",
      models: {
        "active-model": {
          name: "Active Model",
        },
        "alpha-model": {
          name: "Alpha Model",
          status: "alpha" as const,
        },
      },
      options: {
        apiKey: "custom-key",
      },
    },
  },
}

const it = testEffect(providerLayer())
const experimentalModels = testEffect(providerLayer({ enableExperimentalModels: true }))

it.instance(
  "custom provider with npm package",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[pid("custom-provider")]).toBeDefined()
    expect(providers[pid("custom-provider")].name).toBe("Custom Provider")
    expect(providers[pid("custom-provider")].models["custom-model"]).toBeDefined()
  }),
  {
    config: {
      provider: {
        "custom-provider": {
          name: "Custom Provider",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.custom.com/v1",
          env: ["CUSTOM_API_KEY"],
          models: {
            "custom-model": {
              name: "Custom Model",
              tool_call: true,
              limit: { context: 128000, output: 4096 },
            },
          },
          options: { apiKey: "custom-key" },
        },
      },
    },
  },
)

it.instance(
  "disabled_providers excludes provider",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[pid("custom-provider")]).toBeUndefined()
  }),
  { config: { disabled_providers: ["custom-provider"], provider: { "custom-provider": { name: "Custom", npm: "@ai-sdk/openai-compatible", api: "https://api.custom.com/v1", models: { "m": { name: "M" } }, options: { apiKey: "k" } } } } },
)

it.instance(
  "enabled_providers restricts to only listed providers",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[pid("custom-provider")]).toBeDefined()
    expect(providers[pid("other-provider")]).toBeUndefined()
  }),
  {
    config: {
      enabled_providers: ["custom-provider"],
      provider: {
        "custom-provider": { name: "Custom", npm: "@ai-sdk/openai-compatible", api: "https://api.custom.com/v1", models: { m: { name: "M" } }, options: { apiKey: "k" } },
        "other-provider": { name: "Other", npm: "@ai-sdk/openai-compatible", api: "https://api.other.com/v1", models: { m: { name: "M" } }, options: { apiKey: "k" } },
      },
    },
  },
)

it.instance(
  "custom model alias via config",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[pid("custom-provider")].models["my-alias"]).toBeDefined()
    expect(providers[pid("custom-provider")].models["my-alias"].name).toBe("My Custom Alias")
  }),
  {
    config: {
      provider: {
        "custom-provider": { name: "Custom", npm: "@ai-sdk/openai-compatible", api: "https://api.custom.com/v1", models: { "my-alias": { name: "My Custom Alias" } }, options: { apiKey: "k" } },
      },
    },
  },
)

it.instance(
  "filters alpha provider models by default",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[pid("custom-provider")].models["active-model"]).toBeDefined()
    expect(providers[pid("custom-provider")].models["alpha-model"]).toBeUndefined()
  }),
  { config: alphaProviderConfig },
)

experimentalModels.instance(
  "includes alpha provider models when experimental models are enabled",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[pid("custom-provider")].models["active-model"]).toBeDefined()
    expect(providers[pid("custom-provider")].models["alpha-model"]).toBeDefined()
  }),
  { config: alphaProviderConfig },
)

it.instance(
  "custom DeepSeek openai-compatible model defaults interleaved reasoning field",
  Effect.gen(function* () {
    const providers = yield* list
    const provider = providers[pid("custom-provider")]
    expect(provider.models["deepseek-r1"].capabilities.interleaved).toBeDefined()
    expect((provider.models["deepseek-r1"].capabilities.interleaved as { field: string }).field).toBeDefined()
  }),
  {
    config: {
      provider: {
        "custom-provider": {
          name: "Custom",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.custom.com/v1",
          models: {
            "deepseek-r1": { name: "R1" },
            "deepseek-details": { name: "Details" },
          },
          options: { apiKey: "k" },
        },
      },
    },
  },
)

it.instance(
  "getModel returns explicit model",
  Effect.gen(function* () {
    const svc = yield* Provider.Service
    const model = yield* svc.getModel(pid("custom-provider"), mid("custom-model"))
    expect(String(model.id)).toBe("custom-model")
    expect(String(model.providerID)).toBe("custom-provider")
  }),
  {
    config: {
      provider: {
        "custom-provider": {
          name: "Custom",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.custom.com/v1",
          models: { "custom-model": { name: "Custom Model" } },
          options: { apiKey: "k" },
        },
      },
    },
  },
)

it.instance(
  "getLanguage returns language model for custom provider",
  Effect.gen(function* () {
    const svc = yield* Provider.Service
    const model = yield* svc.getModel(pid("custom-provider"), mid("custom-model"))
    const language = yield* svc.getLanguage(model)
    expect(language).toBeDefined()
  }),
  {
    config: {
      provider: {
        "custom-provider": {
          name: "Custom",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.custom.com/v1",
          models: { "custom-model": { name: "Custom Model" } },
          options: { apiKey: "k" },
        },
      },
    },
  },
)

it.instance("list returns empty when no providers configured", () =>
  Effect.gen(function* () {
    const providers = yield* list
    expect(Object.keys(providers).length).toBe(0)
  }),
)

it.instance("provider model has expected default api npm fallback", () =>
  Effect.gen(function* () {
    const providers = yield* list
    const m = providers[pid("custom-provider")].models["custom-model"]
    expect(m.api.npm).toBe("@ai-sdk/openai-compatible")
    expect(m.api.url).toBe("https://api.custom.com/v1")
  }),
  {
    config: {
      provider: {
        "custom-provider": {
          name: "Custom",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.custom.com/v1",
          models: { "custom-model": { name: "Custom Model" } },
          options: { apiKey: "k" },
        },
      },
    },
  },
)
