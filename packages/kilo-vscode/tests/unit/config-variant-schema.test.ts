/**
 * P4.1 canonical provider variant schema — direct behavior tests.
 *
 * One closed schema (R10) drives the shared validator, the config-file Zod
 * validation, the GUI serializer (serializeCanonicalProvider), and the GUI
 * deserializer (parseVariant). These tests exercise every supported variant
 * field and every rejected nested/unknown shape through the real code paths.
 */

import { describe, expect, it } from "bun:test"
import {
  APPROVED_VARIANT_KEYS,
  isValidVariantEntry,
  isValidModelEntry,
  isValidModelsMap,
  isValidCanonicalProviderEntry,
  toCanonicalPayload,
  type CanonicalProviderVariantPayload,
} from "../../src/config/types"
import { validateConfig } from "../../src/config/validate"
import {
  parseVariant,
  serializeCanonicalProvider,
  type FormState,
} from "../../webview-ui/src/components/settings/CustomProviderValidation"

const SUPPORTED_KEYS = ["enable_thinking", "reasoningEffort", "effort", "thinking", "reasoning_split", "chat_template_args"]

function variantEntry(v: Record<string, unknown>): { models: Record<string, { name: string; variants: Record<string, unknown> }> } {
  return { models: { "m1": { name: "M1", variants: { "v1": v } } } }
}

function providerWithVariant(v: Record<string, unknown>): Record<string, unknown> {
  return { provider: { p: { name: "P", models: { "m1": { name: "M1", variants: { "v1": v } } } } } }
}

function form(overrides: Partial<FormState> = {}): FormState {
  return {
    providerID: "custom",
    name: "Custom",
    npm: "@ai-sdk/openai-compatible",
    baseURL: "https://api.example.com/v1",
    apiKey: "",
    models: [
      {
        id: "m1",
        name: "Model 1",
        reasoning: true,
        supportsImages: false,
        modalities: { input: [], output: [] },
        variants: [
          {
            name: "v1",
            enableThinking: true,
            thinking: "adaptive",
            splitReasoning: false,
            reasoningEffort: "low",
            outputEffort: "max",
            chatTemplateArgs: true,
          },
        ],
      },
    ],
    headers: [],
    saving: false,
    ...overrides,
  }
}

describe("P4.1 closed variant schema — approved key set", () => {
  it("APPROVED_VARIANT_KEYS is exactly the locked six keys", () => {
    expect([...APPROVED_VARIANT_KEYS].sort()).toEqual([...SUPPORTED_KEYS].sort())
    expect(APPROVED_VARIANT_KEYS.size).toBe(6)
  })

  it("the type-level payload carries exactly the same six keys", () => {
    const payload: CanonicalProviderVariantPayload = {
      enable_thinking: true,
      reasoningEffort: "high",
      effort: "max",
      thinking: { type: "adaptive" },
      reasoning_split: false,
      chat_template_args: { enable_thinking: true },
    }
    expect(Object.keys(payload).sort()).toEqual([...SUPPORTED_KEYS].sort())
  })
})

describe("P4.1 closed variant schema — every supported field accepted", () => {
  it("isValidVariantEntry accepts all six supported keys with correct shapes", () => {
    expect(isValidVariantEntry({
      enable_thinking: true,
      reasoningEffort: "high",
      effort: "max",
      thinking: { type: "adaptive" },
      reasoning_split: false,
      chat_template_args: { enable_thinking: true },
    })).toBe(true)
  })

  it("each field is accepted individually", () => {
    expect(isValidVariantEntry({ enable_thinking: false })).toBe(true)
    expect(isValidVariantEntry({ reasoningEffort: "none" })).toBe(true)
    expect(isValidVariantEntry({ effort: "low" })).toBe(true)
    for (const type of ["enabled", "disabled", "adaptive"]) {
      expect(isValidVariantEntry({ thinking: { type } })).toBe(true)
    }
    expect(isValidVariantEntry({ reasoning_split: true })).toBe(true)
    expect(isValidVariantEntry({ chat_template_args: { enable_thinking: false } })).toBe(true)
  })

  it("empty variant entry is accepted", () => {
    expect(isValidVariantEntry({})).toBe(true)
  })

  it("isValidModelsMap accepts the closed six-key variant", () => {
    expect(isValidModelsMap(variantEntry({
      enable_thinking: true,
      reasoningEffort: "high",
      effort: "max",
      thinking: { type: "adaptive" },
      reasoning_split: false,
      chat_template_args: { enable_thinking: true },
    }).models)).toBe(true)
  })

  it("toCanonicalPayload accepts the closed six-key variant", () => {
    const payload = toCanonicalPayload(providerWithVariant({
      enable_thinking: true,
      reasoningEffort: "high",
      effort: "max",
      thinking: { type: "adaptive" },
      reasoning_split: false,
      chat_template_args: { enable_thinking: true },
    }))
    expect(payload).toBeDefined()
    expect(isValidCanonicalProviderEntry(payload!.provider!.p!)).toBe(true)
  })

  it("validateConfig accepts the closed six-key variant", () => {
    const result = validateConfig(JSON.stringify(providerWithVariant({
      enable_thinking: true,
      reasoningEffort: "high",
      effort: "max",
      thinking: { type: "adaptive" },
      reasoning_split: false,
      chat_template_args: { enable_thinking: true },
    })), "global", "test.jsonc")
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe("P4.1 closed variant schema — nested value shapes rejected", () => {
  it("rejects thinking with a value outside the closed enum", () => {
    expect(isValidVariantEntry({ thinking: { type: "always" } })).toBe(false)
    expect(isValidVariantEntry({ thinking: { type: 42 } })).toBe(false)
    expect(isValidVariantEntry({ thinking: { type: "" } })).toBe(false)
  })

  it("rejects thinking with extra keys (arbitrary nested objects)", () => {
    expect(isValidVariantEntry({ thinking: { type: "adaptive", budget_tokens: 1000 } })).toBe(false)
    expect(isValidVariantEntry({ thinking: { type: "adaptive", anything: true } })).toBe(false)
  })

  it("rejects thinking that is not a plain object", () => {
    expect(isValidVariantEntry({ thinking: 42 })).toBe(false)
    expect(isValidVariantEntry({ thinking: "adaptive" })).toBe(false)
    expect(isValidVariantEntry({ thinking: ["adaptive"] })).toBe(false)
    expect(isValidVariantEntry({ thinking: null })).toBe(false)
  })

  it("rejects chat_template_args with a non-boolean enable_thinking value", () => {
    expect(isValidVariantEntry({ chat_template_args: { enable_thinking: "yes" } })).toBe(false)
    expect(isValidVariantEntry({ chat_template_args: { enable_thinking: 1 } })).toBe(false)
    expect(isValidVariantEntry({ chat_template_args: { enable_thinking: null } })).toBe(false)
  })

  it("rejects chat_template_args with extra keys (arbitrary nested objects)", () => {
    expect(isValidVariantEntry({ chat_template_args: { enable_thinking: true, max_tokens: 100 } })).toBe(false)
  })

  it("rejects chat_template_args that is not a plain object", () => {
    expect(isValidVariantEntry({ chat_template_args: true })).toBe(false)
    expect(isValidVariantEntry({ chat_template_args: "x" })).toBe(false)
    expect(isValidVariantEntry({ chat_template_args: [true] })).toBe(false)
    expect(isValidVariantEntry({ chat_template_args: null })).toBe(false)
  })
})

describe("P4.1 closed variant schema — unknown keys and wrong scalar types rejected", () => {
  it("rejects any key outside the approved six", () => {
    expect(isValidVariantEntry({ bogus: true })).toBe(false)
    expect(isValidVariantEntry({ temperature: 0.5 })).toBe(false)
    expect(isValidVariantEntry({ modelParams: {} })).toBe(false)
  })

  it("rejects wrong scalar types for boolean fields", () => {
    expect(isValidVariantEntry({ enable_thinking: "yes" })).toBe(false)
    expect(isValidVariantEntry({ enable_thinking: 1 })).toBe(false)
    expect(isValidVariantEntry({ reasoning_split: "true" })).toBe(false)
  })

  it("rejects wrong scalar types for string fields", () => {
    expect(isValidVariantEntry({ reasoningEffort: 42 })).toBe(false)
    expect(isValidVariantEntry({ reasoningEffort: true })).toBe(false)
    expect(isValidVariantEntry({ effort: ["max"] })).toBe(false)
  })

  it("rejects non-object variant entries", () => {
    expect(isValidVariantEntry("v1")).toBe(false)
    expect(isValidVariantEntry(42)).toBe(false)
    expect(isValidVariantEntry(null)).toBe(false)
    expect(isValidVariantEntry(["enable_thinking"])).toBe(false)
  })

  it("end-to-end: toCanonicalPayload and validateConfig reject nested violations", () => {
    const badThinking = providerWithVariant({ thinking: { type: "adaptive", extra: true } })
    expect(toCanonicalPayload(badThinking)).toBeUndefined()
    expect(validateConfig(JSON.stringify(badThinking), "global", "test.jsonc").valid).toBe(false)

    const badChatArgs = providerWithVariant({ chat_template_args: { enable_thinking: "yes" } })
    expect(toCanonicalPayload(badChatArgs)).toBeUndefined()
    expect(validateConfig(JSON.stringify(badChatArgs), "global", "test.jsonc").valid).toBe(false)

    const unknownKey = providerWithVariant({ temperature: 0.5 })
    expect(toCanonicalPayload(unknownKey)).toBeUndefined()
    expect(validateConfig(JSON.stringify(unknownKey), "global", "test.jsonc").valid).toBe(false)

    const arbitraryNested = providerWithVariant({ thinking: { type: "adaptive" }, arbitrary: { nested: true } })
    expect(toCanonicalPayload(arbitraryNested)).toBeUndefined()
    expect(validateConfig(JSON.stringify(arbitraryNested), "global", "test.jsonc").valid).toBe(false)
  })
})

describe("P4.1 closed variant schema — GUI serializer and deserializer agree", () => {
  it("serializeCanonicalProvider emits all six keys with the exact closed shapes", () => {
    const payload = serializeCanonicalProvider(form())
    expect(payload).toBeDefined()
    const variant = payload!.models!["m1"]!.variants!["v1"]
    expect(variant).toEqual({
      enable_thinking: true,
      reasoningEffort: "low",
      effort: "max",
      thinking: { type: "adaptive" },
      reasoning_split: false,
      chat_template_args: { enable_thinking: true },
    })
    expect(isValidCanonicalProviderEntry(payload)).toBe(true)
  })

  it("parseVariant deserializes every canonical key back to the GUI form shape", () => {
    const entry: CanonicalProviderVariantPayload = {
      enable_thinking: true,
      reasoningEffort: "low",
      effort: "max",
      thinking: { type: "adaptive" },
      reasoning_split: false,
      chat_template_args: { enable_thinking: true },
    }
    expect(parseVariant(["v1", entry])).toEqual({
      name: "v1",
      enableThinking: true,
      thinking: "adaptive",
      splitReasoning: false,
      reasoningEffort: "low",
      outputEffort: "max",
      chatTemplateArgs: true,
    })
  })

  it("serialize → parse round-trips every supported field unchanged", () => {
    const source = form()
    const payload = serializeCanonicalProvider(source)!
    const variant = payload.models!["m1"]!.variants!["v1"]
    const parsed = parseVariant(["v1", variant])
    expect(parsed.enableThinking).toBe(source.models[0].variants[0].enableThinking)
    expect(parsed.thinking).toBe(source.models[0].variants[0].thinking)
    expect(parsed.splitReasoning).toBe(source.models[0].variants[0].splitReasoning)
    expect(parsed.reasoningEffort).toBe(source.models[0].variants[0].reasoningEffort)
    expect(parsed.outputEffort).toBe(source.models[0].variants[0].outputEffort)
    expect(parsed.chatTemplateArgs).toBe(source.models[0].variants[0].chatTemplateArgs)
  })

  it("parseVariant drops unset and wrong-typed fields without crashing", () => {
    const parsed = parseVariant(["v1", {
      enable_thinking: false,
      reasoning_split: true,
      thinking: { type: "disabled" },
      chat_template_args: { enable_thinking: false },
    }])
    expect(parsed.thinking).toBe("disabled")
    expect(parsed.reasoningEffort).toBeUndefined()
    expect(parsed.outputEffort).toBeUndefined()
  })
})

describe("P4.1 closed schema — models and variants containers reject arrays and non-records", () => {
  it("isValidModelEntry rejects array-shaped model entries", () => {
    expect(isValidModelEntry([{ name: "M1" }])).toBe(false)
    expect(isValidModelEntry(["string"])).toBe(false)
    expect(isValidModelEntry([1, 2, 3])).toBe(false)
  })

  it("isValidModelEntry rejects array-shaped variants container", () => {
    expect(isValidModelEntry({
      name: "M1",
      variants: [{ name: "v1", enable_thinking: true }],
    })).toBe(false)
    expect(isValidModelEntry({
      name: "M1",
      variants: ["string"],
    })).toBe(false)
  })

  it("isValidModelsMap rejects array-shaped models maps", () => {
    expect(isValidModelsMap([{ name: "M1" }])).toBe(false)
    expect(isValidModelsMap(["m1", "m2"])).toBe(false)
    expect(isValidModelsMap([1, 2])).toBe(false)
  })

  it("isValidModelsMap accepts valid keyed record of model entries", () => {
    expect(isValidModelsMap({
      "m1": { name: "Model 1" },
      "m2": { name: "Model 2", reasoning: true },
    })).toBe(true)
  })

  it("isValidModelEntry accepts valid keyed record of variants", () => {
    expect(isValidModelEntry({
      name: "M1",
      variants: {
        "v1": { enable_thinking: true },
        "v2": { reasoningEffort: "high" },
      },
    })).toBe(true)
  })

  it("toCanonicalPayload rejects array-shaped models in provider", () => {
    const payload = toCanonicalPayload({
      provider: {
        p: { name: "P", models: [{ name: "M1" }] },
      },
    })
    expect(payload).toBeUndefined()
  })

  it("toCanonicalPayload rejects array-shaped variants in provider model", () => {
    const payload = toCanonicalPayload({
      provider: {
        p: {
          name: "P",
          models: {
            "m1": { name: "M1", variants: [{ enable_thinking: true }] },
          },
        },
      },
    })
    expect(payload).toBeUndefined()
  })

  it("validateConfig rejects array-shaped models in provider", () => {
    const result = validateConfig(JSON.stringify({
      provider: {
        p: { name: "P", models: [{ name: "M1" }] },
      },
    }), "global", "test.jsonc")
    expect(result.valid).toBe(false)
  })

  it("validateConfig rejects array-shaped variants in provider model", () => {
    const result = validateConfig(JSON.stringify({
      provider: {
        p: {
          name: "P",
          models: {
            "m1": { name: "M1", variants: [{ enable_thinking: true }] },
          },
        },
      },
    }), "global", "test.jsonc")
    expect(result.valid).toBe(false)
  })
})
