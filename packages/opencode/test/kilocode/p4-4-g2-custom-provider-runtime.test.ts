import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { testEffect } from "../lib/effect"

const layer = Provider.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

const it = testEffect(layer)

const pid = (s: string) => (ProviderV2.ID as unknown as { make: (x: string) => ProviderV2.ID }).make(s)
const mid = (s: string) => (ModelV2.ID as unknown as { make: (x: string) => ModelV2.ID }).make(s)

describe("P4.4-G2 custom-provider runtime — real provider layer", () => {
  it.instance("list returns config-defined custom provider with models", () =>
    Effect.gen(function* () {
      const svc = yield* Provider.Service
      const providers = yield* svc.list()
      const id = pid("test-custom")
      expect(providers[id]).toBeDefined()
      expect(providers[id].name).toBe("Test Custom")
      expect(Object.keys(providers[id].models)).toContain("test-model")
    }),
    {
      config: {
        provider: {
          "test-custom": {
            name: "Test Custom",
            npm: "@ai-sdk/openai-compatible",
            api: "https://api.test-custom.com/v1",
            models: { "test-model": { name: "Test Model" } },
            options: { apiKey: "test-key" },
          },
        },
      },
    },
  )

  it.instance("getModel and getLanguage resolve for explicit config model", () =>
    Effect.gen(function* () {
      const svc = yield* Provider.Service
      const model = yield* svc.getModel(pid("test-custom"), mid("test-model"))
      expect(String(model.id)).toBe("test-model")
      expect(String(model.providerID)).toBe("test-custom")
      const lang = yield* svc.getLanguage(model)
      expect(lang).toBeDefined()
      expect(typeof (lang as unknown as { doGenerate: unknown }).doGenerate).toBe("function")
    }),
    {
      config: {
        provider: {
          "test-custom": {
            name: "Test Custom",
            npm: "@ai-sdk/openai-compatible",
            api: "https://api.test-custom.com/v1",
            models: { "test-model": { name: "Test Model" } },
            options: { apiKey: "test-key" },
          },
        },
      },
    },
  )

  it.instance("closest suggests model id", () =>
    Effect.gen(function* () {
      const svc = yield* Provider.Service
      const out = yield* svc.closest(pid("test-custom"), ["test"])
      expect(out).toBeDefined()
      expect(String(out?.providerID)).toBe("test-custom")
    }),
    {
      config: {
        provider: {
          "test-custom": {
            name: "Test Custom",
            npm: "@ai-sdk/openai-compatible",
            api: "https://api.test-custom.com/v1",
            models: { "test-model": { name: "Test Model" }, "other-model": { name: "Other" } },
            options: { apiKey: "k" },
          },
        },
      },
    },
  )
})
