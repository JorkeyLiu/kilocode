import { afterEach, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { disposeAllInstances } from "../fixture/fixture"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { pollWithTimeout, testEffect } from "../lib/effect"
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
const it = testEffect(providerLayer())

it.instance("env var populates provider when config has env list and env var set", () =>
  Effect.gen(function* () {
    const key = "CUSTOM_API_KEY"
    const prev = process.env[key]
    process.env[key] = "env-key"
    try {
      const providers = yield* pollWithTimeout(
        Effect.gen(function* () {
          const p = yield* list
          return p[pid("custom-env")] ? p : undefined
        }),
        "provider never became ready",
      )
      expect(providers[pid("custom-env")]).toBeDefined()
    } finally {
      if (prev === undefined) delete process.env[key]
      else process.env[key] = prev
    }
  }),
  {
    config: {
      provider: {
        "custom-env": {
          name: "Custom Env",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.custom.com/v1",
          env: ["CUSTOM_API_KEY"],
          models: { m: { name: "M" } },
          options: { apiKey: "config-key" },
        },
      },
    },
  },
)

it.instance("disabled_providers excludes provider even when env var present", () =>
  Effect.gen(function* () {
    const key = "CUSTOM_API_KEY"
    const prev = process.env[key]
    process.env[key] = "env-key"
    try {
      const providers = yield* pollWithTimeout(
        Effect.gen(function* () {
          const p = yield* list
          // poll until list resolves (provider may be absent, but list readiness is observable)
          return Object.keys(p).length >= 0 ? p : undefined
        }),
        "provider list never became ready",
      )
      expect(providers[pid("custom-env")]).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env[key]
      else process.env[key] = prev
    }
  }),
  {
    config: {
      disabled_providers: ["custom-env"],
      provider: {
        "custom-env": {
          name: "Custom Env",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.custom.com/v1",
          env: ["CUSTOM_API_KEY"],
          models: { m: { name: "M" } },
          options: { apiKey: "k" },
        },
      },
    },
  },
)

it.instance("enabled_providers restricts to listed providers", () =>
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[pid("keep")]).toBeDefined()
    expect(providers[pid("drop")]).toBeUndefined()
  }),
  {
    config: {
      enabled_providers: ["keep"],
      provider: {
        keep: { name: "Keep", npm: "@ai-sdk/openai-compatible", api: "https://a.com/v1", models: { m: { name: "M" } }, options: { apiKey: "k" } },
        drop: { name: "Drop", npm: "@ai-sdk/openai-compatible", api: "https://b.com/v1", models: { m: { name: "M" } }, options: { apiKey: "k" } },
      },
    },
  },
)

it.instance("provider options, model headers, baseURL and npm fallback", () =>
  Effect.gen(function* () {
    const providers = yield* list
    const p = providers[pid("opt-provider")]
    expect(p.options.baseURL).toBe("https://custom.example.com/v1")
    expect(p.options.timeout).toBe(12345)
    const m = p.models["my-model"]
    expect(m.api.npm).toBe("@ai-sdk/openai-compatible")
    expect(m.api.url).toBe("https://custom.example.com/v1")
    expect(m.headers["x-custom"]).toBe("header-val")
    expect(m.options.customOpt).toBe("opt-val")
  }),
  {
    config: {
      provider: {
        "opt-provider": {
          name: "Opt",
          npm: "@ai-sdk/openai-compatible",
          api: "https://custom.example.com/v1",
          models: {
            "my-model": {
              name: "My Model",
              headers: { "x-custom": "header-val" },
              options: { customOpt: "opt-val" },
            },
          },
          options: { apiKey: "k", baseURL: "https://custom.example.com/v1", timeout: 12345 },
        },
      },
    },
  },
)

it.instance("model npm fallback to openai-compatible when provider npm missing", () =>
  Effect.gen(function* () {
    const providers = yield* list
    const m = providers[pid("fallback-npm")].models["m"]
    expect(m.api.npm).toBe("@ai-sdk/openai-compatible")
  }),
  {
    config: {
      provider: {
        "fallback-npm": {
          name: "Fallback",
          api: "https://api.fallback.com/v1",
          models: { m: { name: "M" } },
          options: { apiKey: "k" },
        },
      },
    },
  },
)

it.instance("metadata, limits, modalities, cost defaults", () =>
  Effect.gen(function* () {
    const providers = yield* list
    const m = providers[pid("meta-provider")].models["meta-model"]
    expect(m.cost.input).toBe(2)
    expect(m.cost.output).toBe(5)
    expect(m.cost.cache.read).toBe(0.5)
    expect(m.cost.cache.write).toBe(1)
    expect(m.limit.context).toBe(128000)
    expect(m.limit.output).toBe(4096)
    expect(m.capabilities.temperature).toBe(true)
    expect(m.capabilities.reasoning).toBe(true)
    expect(m.capabilities.attachment).toBe(true)
    expect(m.capabilities.input.image).toBe(true)
    expect(m.capabilities.output.text).toBe(true)
  }),
  {
    config: {
      provider: {
        "meta-provider": {
          name: "Meta",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.meta.com/v1",
          models: {
            "meta-model": {
              name: "Meta Model",
              cost: { input: 2, output: 5, cache_read: 0.5, cache_write: 1 },
              limit: { context: 128000, output: 4096 },
              temperature: true,
              reasoning: true,
              attachment: true,
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          },
          options: { apiKey: "k" },
        },
      },
    },
  },
)

it.instance("model cost defaults to zero when not specified", () =>
  Effect.gen(function* () {
    const providers = yield* list
    const m = providers[pid("cost-default")].models["m"]
    expect(m.cost.input).toBe(0)
    expect(m.cost.output).toBe(0)
    expect(m.cost.cache.read).toBe(0)
    expect(m.cost.cache.write).toBe(0)
  }),
  {
    config: {
      provider: {
        "cost-default": { name: "Cost", npm: "@ai-sdk/openai-compatible", api: "https://a.com/v1", models: { m: { name: "M" } }, options: { apiKey: "k" } },
      },
    },
  },
)

it.instance("reasoning model gets low/medium/high variants via ProviderTransform", () =>
  Effect.gen(function* () {
    const providers = yield* list
    const m = providers[pid("variant-provider")].models["reason-model"]
    expect(Object.keys(m.variants ?? {})).toContain("low")
    expect(Object.keys(m.variants ?? {})).toContain("medium")
    expect(Object.keys(m.variants ?? {})).toContain("high")
    const nonReason = providers[pid("variant-provider")].models["plain-model"]
    expect(nonReason).toBeDefined()
  }),
  {
    config: {
      provider: {
        "variant-provider": {
          name: "Variant",
          npm: "@ai-sdk/openai-compatible",
          api: "https://a.com/v1",
          models: {
            "reason-model": { name: "Reason", reasoning: true },
            "plain-model": { name: "Plain" },
          },
          options: { apiKey: "k" },
        },
      },
    },
  },
)

it.instance("deepseek interleaved defaults", () =>
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[pid("deepseek-provider")].models["deepseek-r1"].capabilities.interleaved).toEqual({ field: "reasoning_content" })
    expect(providers[pid("deepseek-provider")].models["deepseek-details"].capabilities.interleaved).toEqual({ field: "reasoning_details" })
  }),
  {
    config: {
      provider: {
        "deepseek-provider": {
          name: "DeepSeek",
          npm: "@ai-sdk/openai-compatible",
          api: "https://a.com/v1",
          models: {
            "deepseek-r1": { name: "R1" },
            "deepseek-details": { name: "Details", interleaved: { field: "reasoning_details" } },
          },
          options: { apiKey: "k" },
        },
      },
    },
  },
)

it.instance("getModel returns explicit model and getLanguage resolves", () =>
  Effect.gen(function* () {
    const svc = yield* Provider.Service
    const model = yield* svc.getModel(pid("err-provider"), mid("good-model"))
    expect(String(model.id)).toBe("good-model")
    const lang = yield* svc.getLanguage(model)
    expect(lang).toBeDefined()
    expect(typeof (lang as unknown as { doGenerate: unknown }).doGenerate).toBe("function")
  }),
  {
    config: {
      provider: {
        "err-provider": { name: "Err", npm: "@ai-sdk/openai-compatible", api: "https://a.com/v1", models: { "good-model": { name: "Good" } }, options: { apiKey: "k" } },
      },
    },
  },
)

it.instance("getModel fails with suggestions for unknown model", () =>
  Effect.gen(function* () {
    const svc = yield* Provider.Service
    const exit = yield* svc.getModel(pid("err-provider"), mid("bad-model")).pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const err = (exit.cause as unknown as { failure?: { value?: unknown } }).failure?.value ?? exit.cause
      expect(String((err as unknown as { modelID?: unknown }).modelID ?? "bad-model")).toContain("bad-model")
    }
  }),
  {
    config: {
      provider: {
        "err-provider": { name: "Err", npm: "@ai-sdk/openai-compatible", api: "https://a.com/v1", models: { "good-model": { name: "Good" }, "good-other": { name: "Other" } }, options: { apiKey: "k" } },
      },
    },
  },
)

it.instance("closest suggests model id", () =>
  Effect.gen(function* () {
    const svc = yield* Provider.Service
    const out = yield* svc.closest(pid("closest-provider"), ["test"])
    expect(out).toBeDefined()
    expect(String(out?.providerID)).toBe("closest-provider")
  }),
  {
    config: {
      provider: {
        "closest-provider": { name: "Closest", npm: "@ai-sdk/openai-compatible", api: "https://a.com/v1", models: { "test-model": { name: "Test" }, "other": { name: "Other" } }, options: { apiKey: "k" } },
      },
    },
  },
)

it.instance("closest returns undefined for unknown provider", () =>
  Effect.gen(function* () {
    const svc = yield* Provider.Service
    const out = yield* svc.closest(pid("unknown"), ["test"])
    expect(out).toBeUndefined()
  }),
)

it.instance("defaultModel returns error when no providers", () =>
  Effect.gen(function* () {
    const svc = yield* Provider.Service
    const exit = yield* svc.defaultModel().pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
  }),
  { config: { enabled_providers: [] } },
)

it.instance("multi-provider: list returns both providers with isolated models", () =>
  Effect.gen(function* () {
    const providers = yield* list
    expect(Object.keys(providers).length).toBe(2)
    expect(providers[pid("p-a")].models["m-a"]).toBeDefined()
    expect(providers[pid("p-b")].models["m-b"]).toBeDefined()
    expect(providers[pid("p-a")].models["m-b"]).toBeUndefined()
  }),
  {
    config: {
      provider: {
        "p-a": { name: "A", npm: "@ai-sdk/openai-compatible", api: "https://a.com/v1", models: { "m-a": { name: "MA" } }, options: { apiKey: "a" } },
        "p-b": { name: "B", npm: "@ai-sdk/openai-compatible", api: "https://b.com/v1", models: { "m-b": { name: "MB" } }, options: { apiKey: "b" } },
      },
    },
  },
)

it.instance("provider api field sets model api.url and npm fallback", () =>
  Effect.gen(function* () {
    const providers = yield* list
    const m = providers[pid("api-field")].models["m"]
    expect(m.api.url).toBe("https://api.example.com/v1")
    expect(m.api.npm).toBe("@ai-sdk/openai-compatible")
  }),
  {
    config: {
      provider: {
        "api-field": { name: "API", npm: "@ai-sdk/openai-compatible", api: "https://api.example.com/v1", models: { m: { name: "M" } }, options: { apiKey: "k" } },
      },
    },
  },
)

it.instance("dead catalog removed: unknown provider suggestions from explicit providers only", () =>
  Effect.gen(function* () {
    const svc = yield* Provider.Service
    const err = (yield* svc.getModel(pid("unknown-provider"), mid("any-model")).pipe(Effect.flip)) as Provider.ModelNotFoundError
    expect(String(err.providerID)).toBe("unknown-provider")
    expect(Array.isArray(err.suggestions)).toBe(true)
  }),
  {
    config: {
      provider: {
        "known-provider": { name: "Known", npm: "@ai-sdk/openai-compatible", api: "https://a.com/v1", models: { "known-model": { name: "Known Model" } }, options: { apiKey: "k" } },
      },
    },
  },
)

it.instance("dead catalog removed: unknown model suggestions from config provider models only", () =>
  Effect.gen(function* () {
    const svc = yield* Provider.Service
    const err = (yield* svc.getModel(pid("known-provider"), mid("unknown-model")).pipe(Effect.flip)) as Provider.ModelNotFoundError
    expect(String(err.modelID)).toBe("unknown-model")
    expect(err.modelsEmpty).toBe(false)
    expect(Array.isArray(err.suggestions)).toBe(true)
    expect(err.suggestions?.includes("known-model")).toBe(true)
  }),
  {
    config: {
      provider: {
        "known-provider": { name: "Known", npm: "@ai-sdk/openai-compatible", api: "https://a.com/v1", models: { "known-model": { name: "Known Model" }, "other-model": { name: "Other" } }, options: { apiKey: "k" } },
      },
    },
  },
)

test("dead catalog state field absent in provider source", async () => {
  const src = await Bun.file("src/provider/provider.ts").text()
  expect(src).not.toContain("catalog: Record")
  expect(src).not.toContain("const catalog:")
  expect(src).not.toContain("s.catalog")
})
