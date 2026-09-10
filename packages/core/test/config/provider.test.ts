import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { ConfigProviderPlugin } from "@opencode-ai/core/config/plugin/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ConfigProviderV1 } from "@opencode-ai/core/v1/config/provider"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { isCanonicalOnlyProviderV1 } from "@opencode-ai/core/kilocode/canonical-provider"
import { isOwnedProviderCredentialRef } from "@opencode-ai/core/kilocode/credential-ref"
import { it } from "../plugin/provider-helper"
import { FastCheck } from "effect/testing"

function request(headers: Record<string, string>, variant?: string) {
  return {
    headers,
    variant,
  }
}

const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigProviderPlugin.Plugin", () => {
  it.effect("loads configured providers and applies later model overrides", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const plugin = yield* PluginV2.Service
      const providerID = ProviderV2.ID.make("custom")
      const modelID = ModelV2.ID.make("chat")
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  custom: {
                    name: "Configured",
                    env: ["CUSTOM_API_KEY"],
                    api: { type: "native", settings: {} },
                    request: request({ first: "first", shared: "first" }),
                    models: {
                      chat: {
                        name: "First",
                        capabilities: { tools: true, input: ["text"], output: ["text"] },
                        disabled: true,
                        limit: { context: 100, output: 50 },
                        cost: { input: 1, output: 2 },
                        request: request({ first: "first", shared: "first" }, "retained"),
                        variants: [
                          {
                            id: "fast",
                            headers: { first: "first", shared: "first" },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
            }),
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  custom: {
                    api: { type: "aisdk", package: "custom-sdk", url: "https://example.test" },
                    request: request({ last: "last", shared: "last" }),
                    models: {
                      chat: {
                        api: { id: "api-chat" },
                        name: "Last",
                        limit: { output: 75 },
                        request: request({ last: "last", shared: "last" }),
                        variants: [
                          {
                            id: "fast",
                            headers: { last: "last", shared: "last" },
                          },
                          {
                            id: "slow",
                            headers: { slow: "slow" },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
            }),
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  custom: { name: "Renamed" },
                },
              }),
            }),
          ]),
      })

      yield* plugin.add({
        ...ConfigProviderPlugin.Plugin,
        effect: ConfigProviderPlugin.Plugin.effect.pipe(
          Effect.provideService(Config.Service, config),
          Effect.provideService(Catalog.Service, catalog),
        ),
      })

      const provider = yield* catalog.provider.get(providerID)
      const model = yield* catalog.model.get(providerID, modelID)
      expect(provider.name).toBe("Renamed")
      expect(provider.env).toEqual(["CUSTOM_API_KEY"])
      expect(provider.enabled).toEqual({ via: "custom", data: {} })
      expect(provider.api).toEqual({ type: "aisdk", package: "custom-sdk", url: "https://example.test" })
      expect(provider.request.headers).toEqual({ first: "first", shared: "last", last: "last" })
      expect(model.api.id).toBe(ModelV2.ID.make("api-chat"))
      expect(model.name).toBe("Last")
      expect(model.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
      expect(model.enabled).toBe(false)
      expect(model.limit).toEqual({ context: 100, output: 75 })
      expect(model.cost).toEqual([{ input: 1, output: 2, cache: { read: 0, write: 0 }, tier: undefined }])
      expect(model.request.headers).toEqual({ first: "first", shared: "last", last: "last" })
      expect(model.request.variant).toBe("retained")
      expect(model.variants.map((variant) => variant.id)).toEqual([
        ModelV2.VariantID.make("fast"),
        ModelV2.VariantID.make("slow"),
      ])
      expect(model.variants[0]?.headers).toEqual({ first: "first", shared: "last", last: "last" })
      expect(model.variants[1]?.headers).toEqual({ slow: "slow" })
    }),
  )
})

describe("ConfigProviderV1.Info provider options", () => {
  const decode = Schema.decodeUnknownSync(ConfigProviderV1.Info)

  test.each([1, 5000, 60_000])("accepts positive integer firstChunkTimeout %i", (ms) => {
    const info = decode({ options: { firstChunkTimeout: ms } })
    expect(info.options?.firstChunkTimeout).toBe(ms)
  })

  test("accepts false firstChunkTimeout to disable the first-chunk wait", () => {
    const info = decode({ options: { firstChunkTimeout: false } })
    expect(info.options?.firstChunkTimeout).toBe(false)
  })

  test("accepts omitted firstChunkTimeout", () => {
    expect(() => decode({ options: { timeout: 5000 } })).not.toThrow()
  })

  test.each(["5000", 0, -1, 1.5])("rejects invalid firstChunkTimeout %j", (value) => {
    expect(() => decode({ options: { firstChunkTimeout: value } })).toThrow()
  })

  test("config load rejects invalid firstChunkTimeout through ConfigV1.Info", () => {
    const decodeConfig = Schema.decodeUnknownSync(ConfigV1.Info)
    expect(() =>
      decodeConfig({
        provider: {
          custom: { options: { firstChunkTimeout: 0 } },
        },
      }),
    ).toThrow()
  })
})

describe("ConfigProviderV1.Info canonical provider preservation", () => {
  const decodeProvider = Schema.decodeUnknownSync(ConfigProviderV1.Info)
  const decodeConfig = Schema.decodeUnknownSync(ConfigV1.Info)

  test("preserves endpoint/protocol/credential", () => {
    const info = decodeProvider({
      endpoint: "https://api.example.com/v1",
      protocol: "openai/completions",
      credential: "secret:kilo.credentials.global.provider.acme",
    })
    expect(info.endpoint).toBe("https://api.example.com/v1")
    expect(info.protocol).toBe("openai/completions")
    expect(String(info.credential)).toBe("secret:kilo.credentials.global.provider.acme")
  })

  test("omitting canonical fields remains valid", () => {
    const info = decodeProvider({ name: "legacy", npm: "@ai-sdk/openai" })
    expect(info.endpoint).toBeUndefined()
    expect(info.protocol).toBeUndefined()
    expect(info.credential).toBeUndefined()
  })

  test("rejects invalid protocol", () => {
    expect(() => decodeProvider({ protocol: "openai/chat" as unknown as string })).toThrow()
  })

  test("accepts each canonical protocol", () => {
    for (const protocol of ["openai/completions", "openai/responses", "anthropic/messages"] as const) {
      const info = decodeProvider({ protocol })
      expect(info.protocol).toBe(protocol)
    }
  })

  test("ConfigV1 parse retains canonical fields with models", () => {
    const cfg = decodeConfig({
      provider: {
        acme: {
          endpoint: "https://api.acme.test/v1",
          protocol: "anthropic/messages",
          credential: "secret:kilo.credentials.project.provider.acme",
          models: { m1: { name: "M1" } },
        },
      },
    })
    expect(cfg.provider?.acme?.endpoint).toBe("https://api.acme.test/v1")
    expect(String(cfg.provider?.acme?.credential)).toBe("secret:kilo.credentials.project.provider.acme")
  })

  test("Schema.toArbitrary completes for ConfigV1.Info", () => {
    expect(() => Schema.toArbitrary(ConfigV1.Info)).not.toThrow()
    const arb = Schema.toArbitrary(ConfigV1.Info)
    expect(() => FastCheck.sample(arb, 1)).not.toThrow()
  })
})

describe("ConfigProvider credential safety", () => {
  const decodeV1 = Schema.decodeUnknownSync(ConfigProviderV1.Info)

  test("rejects plaintext credential", () => {
    expect(() => decodeV1({ credential: "sk-1234567890abcdef" })).toThrow()
    expect(() => decodeV1({ credential: "" })).toThrow()
  })

  test("rejects malformed owned refs", () => {
    const bad = [
      "secret:kilo.credentials.global.mcp.acme",
      "secret:kilo.credentials.global.provider.",
      "secret:kilo.credentials.global.provider..bad",
      "secret:kilo.credentials.bad.provider.acme",
      "secret:kilo.credentials.global.provider",
      "secret:kilo.credentials:",
    ]
    for (const cred of bad) expect(() => decodeV1({ credential: cred })).toThrow()
  })

  test("accepts valid owned refs and shares parser", () => {
    const cred = "secret:kilo.credentials.global.provider.acme"
    const info = decodeV1({ credential: cred })
    expect(String(info.credential)).toBe(cred)
    expect(isOwnedProviderCredentialRef(cred)).toBe(true)
    expect(isOwnedProviderCredentialRef("sk-123")).toBe(false)
  })

  test("plaintext error is redacted with distinctive token and does not leak", () => {
    const token = "sk-DISTINCTIVE-LEAK-TOKEN-ABC123-XYZ-999"
    let msg = ""
    try {
      decodeV1({ credential: token })
    } catch (e) {
      msg = (e as Error).message ?? String(e)
    }
    expect(msg).not.toContain(token)
    expect(msg).toContain("Invalid credential reference")
    expect(msg).toContain('["credential"]')
    // nested provider path via ConfigV1
    const decodeConfig = Schema.decodeUnknownSync(ConfigV1.Info)
    let msg2 = ""
    try {
      decodeConfig({ provider: { acme: { credential: token } } } as unknown as Record<string, unknown>)
    } catch (e) {
      msg2 = (e as Error).message ?? String(e)
    }
    expect(msg2).not.toContain(token)
    expect(msg2).toContain("Invalid credential reference")
    expect(msg2).toContain('["credential"]')
  })
})

describe("Canonical-only V1 predicate", () => {
  test("definitive signals are canonical-only", () => {
    expect(isCanonicalOnlyProviderV1({ endpoint: "https://a.test" })).toBe(true)
    expect(isCanonicalOnlyProviderV1({ protocol: "openai/completions" })).toBe(true)
    expect(isCanonicalOnlyProviderV1({ credential: "secret:kilo.credentials.global.provider.acme" })).toBe(true)
  })

  test("name/models alone are not canonical-only", () => {
    expect(isCanonicalOnlyProviderV1({ name: "x", models: { m1: { name: "M1" } } })).toBe(false)
    expect(isCanonicalOnlyProviderV1({ name: "x" })).toBe(false)
    expect(isCanonicalOnlyProviderV1({})).toBe(false)
  })

  test("hybrid with legacy provider keys is not canonical-only", () => {
    expect(isCanonicalOnlyProviderV1({ npm: "@ai-sdk/openai", endpoint: "https://a.test" } as unknown as Record<string, unknown>)).toBe(false)
    expect(isCanonicalOnlyProviderV1({ api: "https://api.test", endpoint: "https://a.test" })).toBe(false)
    expect(isCanonicalOnlyProviderV1({ env: ["FOO"], credential: "secret:kilo.credentials.global.provider.acme" })).toBe(false)
    expect(isCanonicalOnlyProviderV1({ id: "x", protocol: "openai/completions" })).toBe(false)
  })

  test("model legacy fields make hybrid", () => {
    expect(isCanonicalOnlyProviderV1({ endpoint: "https://a.test", models: { m1: { name: "M1", id: "custom-id" } } })).toBe(false)
    expect(isCanonicalOnlyProviderV1({ endpoint: "https://a.test", models: { m1: { name: "M1", cost: { input: 1, output: 2 } } } })).toBe(false)
  })

  test("canonical models remain canonical-only", () => {
    expect(isCanonicalOnlyProviderV1({ endpoint: "https://a.test", models: { m1: { name: "M1", reasoning: true } } })).toBe(true)
    expect(isCanonicalOnlyProviderV1({ endpoint: "https://a.test", models: { m1: { name: "M1", variants: { v1: { enable_thinking: true } } } } })).toBe(true)
  })

  test("each canonical signal + prompt/isFree/ai_sdk_provider hybrid is not canonical-only", () => {
    // prompt
    expect(isCanonicalOnlyProviderV1({ endpoint: "https://a.test", models: { m1: { name: "M1", prompt: "codex" } } } as unknown as Record<string, unknown>)).toBe(false)
    expect(isCanonicalOnlyProviderV1({ protocol: "openai/completions", models: { m1: { prompt: "gemini" } } } as unknown as Record<string, unknown>)).toBe(false)
    expect(isCanonicalOnlyProviderV1({ credential: "secret:kilo.credentials.global.provider.acme", models: { m1: { prompt: "beast" } } } as unknown as Record<string, unknown>)).toBe(false)
    // isFree
    expect(isCanonicalOnlyProviderV1({ endpoint: "https://a.test", models: { m1: { name: "M1", isFree: true } } } as unknown as Record<string, unknown>)).toBe(false)
    expect(isCanonicalOnlyProviderV1({ protocol: "anthropic/messages", models: { m1: { isFree: false } } } as unknown as Record<string, unknown>)).toBe(false)
    expect(isCanonicalOnlyProviderV1({ credential: "secret:kilo.credentials.global.provider.acme", models: { m1: { isFree: true } } } as unknown as Record<string, unknown>)).toBe(false)
    // ai_sdk_provider
    expect(isCanonicalOnlyProviderV1({ endpoint: "https://a.test", models: { m1: { name: "M1", ai_sdk_provider: "openai" } } } as unknown as Record<string, unknown>)).toBe(false)
    expect(isCanonicalOnlyProviderV1({ protocol: "openai/responses", models: { m1: { ai_sdk_provider: "anthropic" } } } as unknown as Record<string, unknown>)).toBe(false)
    expect(isCanonicalOnlyProviderV1({ credential: "secret:kilo.credentials.global.provider.acme", models: { m1: { ai_sdk_provider: "mistral" } } } as unknown as Record<string, unknown>)).toBe(false)
  })

  test("canonical signal + variants.<id>.disabled:true is hybrid/non-canonical-only, canonical-approved variants remain canonical-only", () => {
    // disabled is an accepted operational variant field — any presence makes it hybrid
    expect(
      isCanonicalOnlyProviderV1({
        endpoint: "https://a.test",
        models: { m1: { name: "M1", variants: { v1: { disabled: true } } } },
      } as unknown as Record<string, unknown>),
    ).toBe(false)
    expect(
      isCanonicalOnlyProviderV1({
        protocol: "openai/completions",
        models: { m1: { name: "M1", variants: { v1: { disabled: true } } } },
      } as unknown as Record<string, unknown>),
    ).toBe(false)
    expect(
      isCanonicalOnlyProviderV1({
        credential: "secret:kilo.credentials.global.provider.acme",
        models: { m1: { name: "M1", variants: { v1: { disabled: true } } } },
      } as unknown as Record<string, unknown>),
    ).toBe(false)
    // presence matters even when false
    expect(
      isCanonicalOnlyProviderV1({
        endpoint: "https://a.test",
        models: { m1: { name: "M1", variants: { v1: { disabled: false } } } },
      } as unknown as Record<string, unknown>),
    ).toBe(false)
    // combined with approved keys remains hybrid
    expect(
      isCanonicalOnlyProviderV1({
        endpoint: "https://a.test",
        models: { m1: { name: "M1", variants: { v1: { disabled: true, enable_thinking: true } } } },
      } as unknown as Record<string, unknown>),
    ).toBe(false)
    // canonical-approved variants remain canonical-only (ConfigV1 variant schema has only disabled as operational key)
    expect(isCanonicalOnlyProviderV1({ endpoint: "https://a.test", models: { m1: { name: "M1", variants: { v1: { enable_thinking: true } } } } })).toBe(true)
    expect(isCanonicalOnlyProviderV1({ endpoint: "https://a.test", models: { m1: { name: "M1", variants: { v1: { reasoningEffort: "high" } } } } })).toBe(true)
    expect(isCanonicalOnlyProviderV1({ endpoint: "https://a.test", models: { m1: { name: "M1", variants: { v1: { effort: "medium" } } } } })).toBe(true)
    expect(isCanonicalOnlyProviderV1({ endpoint: "https://a.test", models: { m1: { name: "M1", variants: { v1: { thinking: { type: "enabled" } } } } } })).toBe(true)
    expect(isCanonicalOnlyProviderV1({ endpoint: "https://a.test", models: { m1: { name: "M1", variants: { v1: { reasoning_split: true } } } } })).toBe(true)
    expect(isCanonicalOnlyProviderV1({ endpoint: "https://a.test", models: { m1: { name: "M1", variants: { v1: { chat_template_args: { enable_thinking: false } } } } } })).toBe(true)
  })
})
