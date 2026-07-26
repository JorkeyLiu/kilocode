import { describe, expect, it } from "bun:test"
import {
  allConfiguredIds,
  buildConfiguredList,
  buildAddList,
  providerSource,
  resolveConfiguredProvider,
  showInlineApiKey,
  isKiloProvider,
  isCustomConfigured,
  resolvePrimarySlot,
} from "../../webview-ui/src/components/settings/provider-tab-helpers"
import type { Provider, ProviderAuthState } from "../../webview-ui/src/types/messages"
import { KILO_PROVIDER_ID } from "../../src/shared/provider-model"

function makeProvider(id: string, name: string, source?: string): Provider {
  const p: Provider = { id, name, models: {} }
  if (source) (p as Record<string, unknown>).source = source
  return p
}

describe("providerSource", () => {
  it("returns undefined when source is missing", () => {
    expect(providerSource(makeProvider("a", "A"))).toBeUndefined()
  })

  it("returns valid source types", () => {
    expect(providerSource(makeProvider("a", "A", "env"))).toBe("env")
    expect(providerSource(makeProvider("a", "A", "api"))).toBe("api")
    expect(providerSource(makeProvider("a", "A", "config"))).toBe("config")
    expect(providerSource(makeProvider("a", "A", "custom"))).toBe("custom")
  })

  it("returns undefined for unknown source values", () => {
    expect(providerSource(makeProvider("a", "A", "bogus"))).toBeUndefined()
  })
})

describe("allConfiguredIds", () => {
  it("collects IDs from connected, disabled, config, and auth", () => {
    const ids = allConfiguredIds(["anthropic", "openai"], new Set(["groq"]), { azure: {} }, { deepseek: "api" })
    expect(ids).toEqual(new Set(["anthropic", "openai", "groq", "azure", "deepseek"]))
  })

  it("returns empty set when all sources are empty", () => {
    const ids = allConfiguredIds([], new Set(), undefined, {})
    expect(ids.size).toBe(0)
  })

  it("deduplicates IDs across sources", () => {
    const ids = allConfiguredIds(["anthropic"], new Set(["anthropic"]), { anthropic: {} }, { anthropic: "api" })
    expect(ids.size).toBe(1)
    expect(ids.has("anthropic")).toBe(true)
  })
})

describe("resolveConfiguredProvider", () => {
  const allProviders: Record<string, Provider> = {
    anthropic: makeProvider("anthropic", "Anthropic", "api"),
  }

  it("returns backend provider when available", () => {
    const p = resolveConfiguredProvider("anthropic", allProviders)
    expect(p.name).toBe("Anthropic")
  })

  it("creates synthetic provider from config entry when backend is missing", () => {
    const p = resolveConfiguredProvider("myprovider", allProviders, {
      myprovider: { name: "My Provider", npm: "@ai-sdk/openai-compatible" },
    })
    expect(p.name).toBe("My Provider")
    expect(p.source).toBe("custom")
  })

  it("creates synthetic provider from config entry with config source", () => {
    const p = resolveConfiguredProvider("azure", allProviders, {
      azure: { name: "Azure" },
    })
    expect(p.name).toBe("Azure")
    expect(p.source).toBe("config")
  })

  it("falls back to ID as name when no backend or config", () => {
    const p = resolveConfiguredProvider("unknown-provider", allProviders)
    expect(p.id).toBe("unknown-provider")
    expect(p.name).toBe("unknown-provider")
  })

  it("uses config name when available for custom provider", () => {
    const p = resolveConfiguredProvider("custom1", allProviders, {
      custom1: { name: "Custom One", npm: "@ai-sdk/openai" },
    })
    expect(p.name).toBe("Custom One")
    expect(p.source).toBe("custom")
  })
})

describe("buildConfiguredList", () => {
  const allProviders: Record<string, Provider> = {
    anthropic: makeProvider("anthropic", "Anthropic", "api"),
    openai: makeProvider("openai", "OpenAI", "api"),
    groq: makeProvider("groq", "Groq", "api"),
  }

  it("includes connected providers", () => {
    const list = buildConfiguredList(allProviders, ["anthropic"], new Set(), undefined, {})
    expect(list.map((p) => p.id)).toContain("anthropic")
  })

  it("includes disabled providers", () => {
    const list = buildConfiguredList(allProviders, [], new Set(["groq"]), undefined, {})
    expect(list.map((p) => p.id)).toContain("groq")
  })

  it("includes providers with config entries even if not connected", () => {
    const list = buildConfiguredList(allProviders, [], new Set(), { azure: { name: "Azure" } }, {})
    expect(list.find((p) => p.id === "azure")?.name).toBe("Azure")
  })

  it("includes providers with auth states", () => {
    const list = buildConfiguredList(allProviders, [], new Set(), undefined, { deepseek: "api" })
    expect(list.map((p) => p.id)).toContain("deepseek")
  })

  it("does not duplicate providers across sources", () => {
    const list = buildConfiguredList(
      allProviders,
      ["anthropic"],
      new Set(["anthropic"]),
      { anthropic: {} },
      { anthropic: "api" },
    )
    const anthropicCount = list.filter((p) => p.id === "anthropic").length
    expect(anthropicCount).toBe(1)
  })

  it("returns empty list when no configured providers", () => {
    const list = buildConfiguredList({}, [], new Set(), undefined, {})
    expect(list).toEqual([])
  })
})

describe("buildAddList", () => {
  const allProviders: Record<string, Provider> = {
    [KILO_PROVIDER_ID]: makeProvider(KILO_PROVIDER_ID, "Kilo Gateway"),
    anthropic: makeProvider("anthropic", "Anthropic"),
    openai: makeProvider("openai", "OpenAI"),
    groq: makeProvider("groq", "Groq"),
    obscure: makeProvider("obscure", "Obscure"),
  }

  it("includes popular unconfigured providers", () => {
    const list = buildAddList(allProviders, new Set(["anthropic"]))
    const ids = list.map((p) => p.id)
    expect(ids).toContain(KILO_PROVIDER_ID)
    expect(ids).toContain("openai")
    expect(ids).not.toContain("anthropic")
  })

  it("excludes configured providers", () => {
    const list = buildAddList(allProviders, new Set([KILO_PROVIDER_ID, "anthropic", "openai"]))
    const ids = list.map((p) => p.id)
    expect(ids).not.toContain(KILO_PROVIDER_ID)
    expect(ids).not.toContain("anthropic")
    expect(ids).not.toContain("openai")
  })

  it("returns empty when all popular providers are configured", () => {
    const configured = new Set(Object.keys(allProviders))
    const list = buildAddList(allProviders, configured)
    expect(list).toEqual([])
  })
})

describe("isKiloProvider", () => {
  it("returns true for Kilo provider", () => {
    expect(isKiloProvider(makeProvider(KILO_PROVIDER_ID, "Kilo Gateway"))).toBe(true)
  })

  it("returns false for non-Kilo providers", () => {
    expect(isKiloProvider(makeProvider("anthropic", "Anthropic"))).toBe(false)
    expect(isKiloProvider(makeProvider("custom1", "Custom", "custom"))).toBe(false)
  })
})

describe("isCustomConfigured", () => {
  it("returns true for custom provider with npm config", () => {
    const config = { mycustom: { npm: "@ai-sdk/openai-compatible" } }
    expect(isCustomConfigured(makeProvider("mycustom", "My Custom", "custom"), config)).toBe(true)
  })

  it("returns false for Kilo provider even with custom source", () => {
    const config = { [KILO_PROVIDER_ID]: { npm: "@ai-sdk/openai-compatible" } }
    expect(isCustomConfigured(makeProvider(KILO_PROVIDER_ID, "Kilo", "custom"), config)).toBe(false)
  })

  it("returns false for non-custom providers", () => {
    expect(isCustomConfigured(makeProvider("anthropic", "Anthropic", "api"), {})).toBe(false)
    expect(isCustomConfigured(makeProvider("azure", "Azure", "config"), { azure: { name: "Azure" } })).toBe(false)
  })

  it("returns false when no config provided", () => {
    expect(isCustomConfigured(makeProvider("custom1", "Custom", "custom"))).toBe(false)
  })
})

describe("showInlineApiKey", () => {
  const anthropic = makeProvider("anthropic", "Anthropic", "api")
  const envProvider = makeProvider("local", "Local", "env")
  const configProvider = makeProvider("azure", "Azure", "config")
  const kilo = makeProvider(KILO_PROVIDER_ID, "Kilo Gateway", "custom")

  it("returns true when auth is api and source is not env", () => {
    expect(showInlineApiKey(anthropic, { anthropic: "api" })).toBe(true)
  })

  it("returns false when auth is api but source is env (LOCK-032)", () => {
    expect(showInlineApiKey(envProvider, { local: "api" })).toBe(false)
  })

  it("returns false when auth is not api", () => {
    expect(showInlineApiKey(anthropic, {})).toBe(false)
    expect(showInlineApiKey(anthropic, { anthropic: "oauth" })).toBe(false)
  })

  it("returns true for config source with api auth", () => {
    expect(showInlineApiKey(configProvider, { azure: "api" })).toBe(true)
  })

  it("returns true for Kilo with api auth (LOCK-032)", () => {
    expect(showInlineApiKey(kilo, { [KILO_PROVIDER_ID]: "api" })).toBe(true)
  })

  it("returns false for Kilo with oauth (LOCK-032)", () => {
    expect(showInlineApiKey(kilo, { [KILO_PROVIDER_ID]: "oauth" })).toBe(false)
  })
})

describe("buildConfiguredList neutral ordering", () => {
  const allProviders: Record<string, Provider> = {
    [KILO_PROVIDER_ID]: makeProvider(KILO_PROVIDER_ID, "Kilo Gateway", "custom"),
    anthropic: makeProvider("anthropic", "Anthropic", "api"),
    openai: makeProvider("openai", "OpenAI", "api"),
    groq: makeProvider("groq", "Groq", "api"),
  }

  it("does not force Kilo to the first position", () => {
    const list = buildConfiguredList(
      allProviders,
      [KILO_PROVIDER_ID, "anthropic", "openai", "groq"],
      new Set(),
      undefined,
      { [KILO_PROVIDER_ID]: "oauth" },
    )
    const ids = list.map((p) => p.id)
    expect(ids[0]).not.toBe(KILO_PROVIDER_ID)
  })

  it("sorts configured providers alphabetically by name", () => {
    const list = buildConfiguredList(allProviders, ["anthropic", "openai", "groq"], new Set(), undefined, {})
    const names = list.map((p) => p.name)
    const sorted = names.slice().sort()
    expect(names).toEqual(sorted)
  })

  it("uses id as stable tiebreak when names match", () => {
    const providers: Record<string, Provider> = {
      aaa: makeProvider("aaa", "Same", "api"),
      bbb: makeProvider("bbb", "Same", "api"),
    }
    const list = buildConfiguredList(providers, ["aaa", "bbb"], new Set(), undefined, {})
    expect(list.map((p) => p.id)).toEqual(["aaa", "bbb"])
  })
})

describe("resolvePrimarySlot", () => {
  it("returns account when isKilo is true regardless of other flags", () => {
    expect(resolvePrimarySlot({ isKilo: true, isCustom: true, hasApiKey: true, hasChatGPT: true, isAnaconda: true })).toBe("account")
  })

  it("returns edit when isCustom is true (non-Kilo)", () => {
    expect(resolvePrimarySlot({ isKilo: false, isCustom: true, hasApiKey: true, hasChatGPT: true, isAnaconda: true })).toBe("edit")
  })

  it("returns apiKey when hasApiKey is true (no custom)", () => {
    expect(resolvePrimarySlot({ isKilo: false, isCustom: false, hasApiKey: true, hasChatGPT: true, isAnaconda: true })).toBe("apiKey")
  })

  it("returns chatgpt when hasChatGPT is true (no custom, no apiKey)", () => {
    expect(resolvePrimarySlot({ isKilo: false, isCustom: false, hasApiKey: false, hasChatGPT: true, isAnaconda: true })).toBe("chatgpt")
  })

  it("returns anaconda when isAnaconda is true (only flag set)", () => {
    expect(resolvePrimarySlot({ isKilo: false, isCustom: false, hasApiKey: false, hasChatGPT: false, isAnaconda: true })).toBe("anaconda")
  })

  it("returns placeholder when no flags are set", () => {
    expect(resolvePrimarySlot({ isKilo: false, isCustom: false, hasApiKey: false, hasChatGPT: false, isAnaconda: false })).toBe("placeholder")
  })
})
