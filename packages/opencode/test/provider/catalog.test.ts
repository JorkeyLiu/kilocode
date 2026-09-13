import { describe, expect, test } from "bun:test"
import path from "path"
import {
  ProviderCatalog,
  toCatalogProvider,
  toCatalogResult,
  toCatalogVariant,
  toCatalogVariantMap,
} from "../../src/provider/catalog"

async function repoText(rel: string) {
  return Bun.file(path.join(import.meta.dir, rel)).text()
}

function baseModel(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    providerID: "p1",
    api: { id: "m1", url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
    name: "M1",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
    limit: { context: 1000, output: 100 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-01-01",
    variants: {},
    ...over,
  }
}

function baseProvider(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    name: "P1",
    source: "api",
    env: [],
    options: {},
    models: { m1: baseModel() },
    ...over,
  }
}

describe("provider catalog redaction", () => {
  test("hasCredential derives from non-empty key only", () => {
    expect(toCatalogProvider(baseProvider({ key: "sk-live" }) as never).hasCredential).toBe(true)
    expect(toCatalogProvider(baseProvider({ key: "" }) as never).hasCredential).toBe(false)
    expect(toCatalogProvider(baseProvider({}) as never).hasCredential).toBe(false)
  })

  test("distinctive secret tokens never appear in catalog JSON", () => {
    const tKey = "CATALOG-SECRET-provider-key-9f31"
    const tOpt = "CATALOG-SECRET-provider-options-4ab2"
    const tNested = "CATALOG-SECRET-nested-77cc"
    const tModelOpt = "CATALOG-SECRET-model-options-1d09"
    const tHeader = "CATALOG-SECRET-model-header-be52"
    const tVariant = "CATALOG-SECRET-variant-63e7"
    const provider = baseProvider({
      key: tKey,
      options: { apiKey: tOpt, nested: { token: tNested }, baseURL: "https://example.com" },
      models: {
        m1: baseModel({
          options: { apiKey: tModelOpt },
          headers: { Authorization: `Bearer ${tHeader}` },
          variants: {
            high: { reasoningEffort: "high", apiKey: tVariant, nested: { secret: tVariant } },
          },
        }),
      },
    })
    const out = toCatalogProvider(provider as never)
    const json = JSON.stringify(out)
    for (const t of [tKey, tOpt, tNested, tModelOpt, tHeader, tVariant]) expect(json).not.toContain(t)
    expect(json).toContain("high")
    expect(out.hasCredential).toBe(true)
    const m = (out.models as Record<string, Record<string, unknown>>).m1!
    expect("options" in m).toBe(false)
    expect("headers" in m).toBe(false)
    expect("key" in (out as Record<string, unknown>)).toBe(false)
    expect("options" in (out as Record<string, unknown>)).toBe(false)
  })

  test("variant whitelist keeps canonical keys and drops arbitrary secrets", () => {
    const v = toCatalogVariant({
      reasoningEffort: "high",
      effort: "medium",
      enable_thinking: true,
      thinking: { type: "adaptive" },
      reasoning_split: false,
      chat_template_args: { enable_thinking: true },
      apiKey: "CATALOG-SECRET-variant-key",
      token: "CATALOG-SECRET-variant-token",
    })
    expect(v).toMatchObject({
      reasoningEffort: "high",
      effort: "medium",
      enable_thinking: true,
      thinking: { type: "adaptive" },
      reasoning_split: false,
      chat_template_args: { enable_thinking: true },
    })
    expect(JSON.stringify(v)).not.toContain("CATALOG-SECRET")
  })

  test("preserves source/env/metadata/display model fields and envelope", () => {
    const provider = baseProvider({
      source: "env",
      env: ["OPENAI_API_KEY"],
      description: "demo",
      metadata: { noteKey: "n", icon: "openai", priority: 1, secret: "CATALOG-SECRET-meta" },
      models: {
        m1: baseModel({
          family: "gpt",
          recommendedIndex: 2,
          isFree: true,
          mayTrainOnYourPrompts: false,
          hasUserByokAvailable: true,
          terminalBench: { overallScore: 9, avgAttemptCostUsd: 0.1 },
          autoRouting: { models: ["a", "b"] },
        }),
      },
    })
    const out = toCatalogProvider(provider as never)
    expect(out.source).toBe("env")
    expect(out.env).toEqual(["OPENAI_API_KEY"])
    expect(out.description).toBe("demo")
    expect(out.metadata).toEqual({ noteKey: "n", icon: "openai", priority: 1 })
    expect(JSON.stringify(out)).not.toContain("CATALOG-SECRET-meta")
    const m = out.models.m1
    expect(m.name).toBe("M1")
    expect(m.family).toBe("gpt")
    expect(m.recommendedIndex).toBe(2)
    expect(m.isFree).toBe(true)
    expect(m.autoRouting).toEqual({ models: ["a", "b"] })

    const res = toCatalogResult({
      providers: { p1: provider as never },
      def: { p1: "m1" },
      connected: ["p1"],
      failed: [],
    })
    expect(res.default).toEqual({ p1: "m1" })
    expect(res.connected).toEqual(["p1"])
    expect(res.failed).toEqual([])
    expect(res.all).toHaveLength(1)
  })

  test("rejects __proto__/constructor/prototype map keys without mutating prototypes", () => {
    const modelMarker = "CATALOG-PROTO-model-8d21"
    const variantMarker = "CATALOG-PROTO-variant-4c77"
    const modelsInput = {
      ...JSON.parse(
        `{"__proto__":{"id":"proto","marker":"${modelMarker}"},"constructor":{"id":"ctor","marker":"${modelMarker}"},"prototype":{"id":"ptype","marker":"${modelMarker}"}}`,
      ),
      "m-ok": baseModel(),
      "m-also": baseModel({ id: "m-also" }),
    }
    const variantsInput = {
      ...JSON.parse(
        `{"__proto__":{"reasoningEffort":"${variantMarker}"},"constructor":{"reasoningEffort":"${variantMarker}"},"prototype":{"reasoningEffort":"${variantMarker}"}}`,
      ),
      high: { reasoningEffort: "high" },
    }
    modelsInput["m-ok"].variants = variantsInput
    const out = toCatalogProvider(baseProvider({ models: modelsInput }) as never)
    for (const k of ["__proto__", "constructor", "prototype"]) {
      expect(Object.prototype.hasOwnProperty.call(out.models, k)).toBe(false)
    }
    expect(Object.getPrototypeOf(out.models)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.keys(out.models)).toEqual(["m-ok", "m-also"])
    expect(out.models["m-ok"]).toBeDefined()
    expect(out.models["m-also"]).toBeDefined()
    const json = JSON.stringify(out)
    expect(json).not.toContain(modelMarker)
    expect(json).not.toContain(variantMarker)

    const vmap = toCatalogVariantMap(variantsInput)!
    for (const k of ["__proto__", "constructor", "prototype"]) {
      expect(Object.prototype.hasOwnProperty.call(vmap, k)).toBe(false)
    }
    expect(Object.getPrototypeOf(vmap)).toBe(Object.prototype)
    expect(Object.keys(vmap)).toEqual(["high"])
    expect(vmap.high).toEqual({ reasoningEffort: "high" })
    expect(JSON.stringify(vmap)).not.toContain(variantMarker)
  })

  test("provider map layer has no dynamic key assignment", async () => {
    const group = await repoText("../../src/provider/catalog.ts")
    expect(group).toContain("isSafeMapKey")
    // Provider collection projects via values only; no result key comes from the input map key.
    expect(group).toContain("Object.values(input.providers).map(toCatalogProvider)")
    expect(group).not.toMatch(/out\[.*provider.*\]\s*=/i)
  })

  test("catalog endpoint registered redacted; legacy list shape untouched", async () => {
    const group = await repoText("../../src/server/routes/instance/httpapi/groups/provider.ts")
    expect(group).toContain('HttpApiEndpoint.get("catalog"')
    expect(group).toContain("/provider/catalog")
    expect(group).toContain('identifier: "provider.catalog"')
    expect(group).toContain("ProviderCatalog.CatalogResult")
    expect(group).toContain(".middleware(InstanceContextMiddleware)")
    expect(group).toContain(".middleware(WorkspaceRoutingMiddleware)")
    expect(group).toContain(".middleware(Authorization)")
    expect(group).toContain('HttpApiEndpoint.get("list", root')
    expect(group).toContain("Provider.ListResult")

    const handler = await repoText("../../src/server/routes/instance/httpapi/handlers/provider.ts")
    expect(handler).toContain('.handle("catalog", catalog)')
    expect(handler).toContain("fetchProviderCatalogData")
    expect(handler).not.toContain("ProviderCatalog.toCatalogResult")
    expect(handler).toContain("provider.list()")
    expect(handler).toContain("Provider.toPublicInfo")
    expect(handler).toContain('.handle("list", list)')
    const shared = await repoText("../../src/kilocode/provider-catalog.ts")
    expect(shared).toContain("ProviderCatalog.toCatalogResult")
    expect(shared).toContain("filterPromptTrainingModels")
    expect(shared).not.toContain("provider.list(")

    const sdk = await repoText("../../../sdk/js/src/v2/gen/sdk.gen.ts")
    expect(sdk).toContain("public catalog")
    expect(sdk).toContain('url: "/provider/catalog"')
    expect(sdk).toContain("public list")
  })

  test("generated catalog types omit key/options/headers", async () => {
    const types = await repoText("../../../sdk/js/src/v2/gen/types.gen.ts")
    const start = types.indexOf("export type ProviderCatalogProvider")
    const end = types.indexOf("export type ProviderCatalogResult")
    const providerBlock = types.slice(start, end)
    expect(providerBlock).toContain("hasCredential")
    expect(providerBlock).not.toContain("key?:")
    expect(providerBlock).not.toContain("options")
    const modelStart = types.indexOf("export type ProviderCatalogModel")
    const modelEnd = types.indexOf("export type ProviderCatalogProvider")
    const modelBlock = types.slice(modelStart, modelEnd)
    expect(modelBlock).not.toContain("options")
    expect(modelBlock).not.toContain("headers")
    expect(ProviderCatalog.CatalogResult).toBeDefined()
  })
})
