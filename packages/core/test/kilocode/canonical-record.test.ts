import { describe, expect, test } from "bun:test"
import {
  isValidCanonicalProviderEntry,
  isValidModelEntry,
  isValidModelsMap,
  isValidVariantEntry,
  APPROVED_VARIANT_KEYS,
} from "../../src/kilocode/canonical-record"

describe("canonical-record shared validator", () => {
  const validCred = (id: string, scope: "global" | "project" = "global") =>
    `secret:kilo.credentials.${scope}.provider.${id}`

  test("provider closed keys rejects unknown keys and empty name", () => {
    const base = {
      endpoint: "https://a.test",
      protocol: "openai/completions",
      credential: validCred("p1"),
      models: { m1: { name: "M1" } },
    }
    expect(isValidCanonicalProviderEntry({ ...base, extra: "nope" })).toBe(false)
    expect(isValidCanonicalProviderEntry({ ...base, name: "" })).toBe(false)
    expect(isValidCanonicalProviderEntry({ ...base, name: 123 })).toBe(false)
    expect(isValidCanonicalProviderEntry(base)).toBe(true)
  })

  test("endpoint and protocol validation", () => {
    const baseCred = validCred("e1")
    expect(isValidCanonicalProviderEntry({ endpoint: "https://ok.test", credential: baseCred, models: { m1: { name: "M1" } } })).toBe(true)
    expect(isValidCanonicalProviderEntry({ endpoint: "ftp://bad", credential: baseCred, models: { m1: { name: "M1" } } })).toBe(false)
    expect(isValidCanonicalProviderEntry({ endpoint: "not-a-url", credential: baseCred, models: { m1: { name: "M1" } } })).toBe(false)
    expect(isValidCanonicalProviderEntry({ endpoint: 123, credential: baseCred, models: { m1: { name: "M1" } } })).toBe(false)
    expect(isValidCanonicalProviderEntry({ protocol: "openai/completions", credential: baseCred, models: { m1: { name: "M1" } } })).toBe(true)
    expect(isValidCanonicalProviderEntry({ protocol: "unknown/proto" as unknown as string, credential: baseCred, models: { m1: { name: "M1" } } })).toBe(false)
    expect(isValidCanonicalProviderEntry({ protocol: 123, credential: baseCred, models: { m1: { name: "M1" } } })).toBe(false)
  })

  test("credential kind/id/scope context", () => {
    const rec = { endpoint: "https://a.test", protocol: "openai/completions", models: { m1: { name: "M1" } } }
    expect(isValidCanonicalProviderEntry({ ...rec, credential: validCred("p1", "global") }, { providerId: "p1", scope: "global" })).toBe(true)
    expect(isValidCanonicalProviderEntry({ ...rec, credential: validCred("p1", "global") }, { providerId: "p2", scope: "global" })).toBe(false)
    expect(isValidCanonicalProviderEntry({ ...rec, credential: validCred("p1", "global") }, { providerId: "p1", scope: "project" })).toBe(false)
    expect(isValidCanonicalProviderEntry({ ...rec, credential: "secret:kilo.credentials.global.mcp.p1" }, { providerId: "p1", scope: "global" })).toBe(false)
    expect(isValidCanonicalProviderEntry({ ...rec, credential: "not-a-ref" }, { providerId: "p1", scope: "global" })).toBe(false)
    expect(isValidCanonicalProviderEntry({ ...rec, credential: 123 as unknown as string }, { providerId: "p1", scope: "global" })).toBe(false)
    // without context, only kind+format checked, id/scope ignored
    expect(isValidCanonicalProviderEntry({ ...rec, credential: validCred("other", "project") })).toBe(true)
  })

  test("models map nonempty and model fields", () => {
    const cred = validCred("pm")
    expect(isValidCanonicalProviderEntry({ endpoint: "https://a.test", credential: cred, models: {} })).toBe(false)
    expect(isValidCanonicalProviderEntry({ endpoint: "https://a.test", credential: cred, models: { m1: { name: "" } } })).toBe(false)
    expect(isValidCanonicalProviderEntry({ endpoint: "https://a.test", credential: cred, models: { m1: { name: "M1", reasoning: "yes" as unknown as boolean } } })).toBe(false)
    expect(isValidCanonicalProviderEntry({ endpoint: "https://a.test", credential: cred, models: { m1: { name: "M1", extra: "x" } as unknown as Record<string, unknown> } })).toBe(false)
    expect(isValidCanonicalProviderEntry({ endpoint: "https://a.test", credential: cred, models: { m1: { name: "M1" } } })).toBe(true)
    expect(isValidModelsMap({ m1: { name: "M1" }, m2: { name: "M2" } })).toBe(true)
    expect(isValidModelsMap({ m1: { name: "" } })).toBe(false)
    expect(isValidModelsMap({})).toBe(true) // map shape valid but provider entry rejects empty via own check
  })

  test("modalities and variants closed shape", () => {
    expect(isValidModelEntry({ name: "M1", modalities: { input: ["text"], output: ["text"] } })).toBe(true)
    expect(isValidModelEntry({ name: "M1", modalities: { input: "text" as unknown as string[] } })).toBe(false)
    expect(isValidModelEntry({ name: "M1", modalities: { input: ["text"], extra: [] as unknown as string[] } as unknown as Record<string, unknown> })).toBe(false)
    expect(isValidModelEntry({ name: "M1", variants: { v1: { enable_thinking: true } } })).toBe(true)
    expect(isValidModelEntry({ name: "M1", variants: { v1: { unknown: true } as unknown as Record<string, unknown> } })).toBe(false)
    expect(isValidModelEntry({ name: "M1", variants: { v1: { thinking: { type: "enabled" } } } })).toBe(true)
    expect(isValidModelEntry({ name: "M1", variants: { v1: { thinking: { type: "bad" } as unknown as Record<string, unknown> } } })).toBe(false)
    expect(isValidModelEntry({ name: "M1", variants: { v1: { chat_template_args: { enable_thinking: true } } } })).toBe(true)
    expect(isValidModelEntry({ name: "M1", variants: { v1: { chat_template_args: { extra: true } as unknown as Record<string, unknown> } } })).toBe(false)
    expect(isValidModelEntry({ name: "M1", variants: "not-a-map" as unknown as Record<string, unknown> })).toBe(false)
    expect(isValidVariantEntry({ enable_thinking: true })).toBe(true)
    expect(isValidVariantEntry({ unknown: true } as unknown as Record<string, unknown>)).toBe(false)
    expect(isValidVariantEntry({ thinking: { type: "adaptive" } })).toBe(true)
    expect(isValidVariantEntry({ thinking: { type: "bad" } as unknown as string })).toBe(false)
    expect(APPROVED_VARIANT_KEYS.has("enable_thinking")).toBe(true)
  })

  test("prototype enforcement null-prototype/array/non-plain same result at CLI and host", () => {
    const base = {
      endpoint: "https://a.test",
      protocol: "openai/completions",
      credential: validCred("proto"),
      models: { m1: { name: "M1" } },
    }
    // normal prototype is valid
    expect(isValidCanonicalProviderEntry(base)).toBe(true)
    // null-prototype is also considered plain and valid
    const nullProto = Object.create(null) as Record<string, unknown>
    Object.assign(nullProto, base)
    expect(isValidCanonicalProviderEntry(nullProto)).toBe(true)
    // array is invalid
    expect(isValidCanonicalProviderEntry([] as unknown as Record<string, unknown>)).toBe(false)
    // class instance with non-Object prototype is invalid
    class Foo {
      endpoint = "https://a.test"
      credential = validCred("proto")
      models = { m1: { name: "M1" } }
    }
    expect(isValidCanonicalProviderEntry(new Foo() as unknown as Record<string, unknown>)).toBe(false)
    // null-prototype models map valid, array invalid
    const nullModels = Object.create(null) as Record<string, unknown>
    nullModels["m1"] = { name: "M1" }
    expect(isValidModelsMap(nullModels)).toBe(true)
    expect(isValidModelsMap([] as unknown as Record<string, unknown>)).toBe(false)
    // null-prototype model entry valid, class-instance invalid
    const nullModel = Object.create(null) as Record<string, unknown>
    nullModel["name"] = "M1"
    expect(isValidModelEntry(nullModel)).toBe(true)
    expect(isValidModelEntry(new (class { name = "M1" })() as unknown as Record<string, unknown>)).toBe(false)
    // null-prototype variant entry valid
    const nullVariant = Object.create(null) as Record<string, unknown>
    nullVariant["enable_thinking"] = true
    expect(isValidVariantEntry(nullVariant)).toBe(true)
    expect(isValidVariantEntry([] as unknown as Record<string, unknown>)).toBe(false)
    // modalities null-prototype
    const nullModal = Object.create(null) as Record<string, unknown>
    nullModal["input"] = ["text"]
    expect(isValidModelEntry({ name: "M1", modalities: nullModal })).toBe(true)
    expect(isValidModelEntry({ name: "M1", modalities: [] as unknown as Record<string, unknown> })).toBe(false)
    // variants map null-prototype
    const nullVariants = Object.create(null) as Record<string, unknown>
    nullVariants["v1"] = { enable_thinking: true }
    expect(isValidModelEntry({ name: "M1", variants: nullVariants })).toBe(true)
  })
})
