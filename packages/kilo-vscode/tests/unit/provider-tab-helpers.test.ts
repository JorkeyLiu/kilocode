import { describe, expect, it } from "bun:test"
import {
  allConfiguredIds,
  buildConfiguredList,
  buildAddList,
  providerSource,
  resolveConfiguredProvider,
  showInlineApiKey,
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
    expect(p!.name).toBe("Anthropic")
  })

  it("creates synthetic provider from config entry when backend is missing", () => {
    const p = resolveConfiguredProvider("myprovider", allProviders, {
      myprovider: { name: "My Provider", npm: "@ai-sdk/openai-compatible" },
    })
    expect(p!.name).toBe("My Provider")
    expect(p!.source).toBe("custom")
  })

  it("creates synthetic provider from config entry with config source", () => {
    const p = resolveConfiguredProvider("azure", allProviders, {
      azure: { name: "Azure" },
    })
    expect(p!.name).toBe("Azure")
    expect(p!.source).toBe("config")
  })

  it("falls back to ID as name when no backend or config", () => {
    const p = resolveConfiguredProvider("unknown-provider", allProviders)
    expect(p!.id).toBe("unknown-provider")
    expect(p!.name).toBe("unknown-provider")
  })

  it("uses config name when available for custom provider", () => {
    const p = resolveConfiguredProvider("custom1", allProviders, {
      custom1: { name: "Custom One", npm: "@ai-sdk/openai" },
    })
    expect(p!.name).toBe("Custom One")
    expect(p!.source).toBe("custom")
  })

  it("marks canonical endpoint+protocol config entries as custom source", () => {
    const p = resolveConfiguredProvider("canon1", allProviders, {
      canon1: { name: "Canon One", endpoint: "https://example.com/v1", protocol: "openai/completions" },
    })
    expect(p!.name).toBe("Canon One")
    expect(p!.source).toBe("custom")
  })

  it("does not synthesize Kilo when backend omits it even with config entry (P4.4-T11 blocker)", () => {
    const p = resolveConfiguredProvider(KILO_PROVIDER_ID, allProviders, {
      [KILO_PROVIDER_ID]: { name: "Kilo Gateway", npm: "@ai-sdk/openai-compatible" },
    })
    expect(p).toBeUndefined()
  })

  it("does not synthesize Kilo when backend omits it with no config (auth/config-present/backend-absent path)", () => {
    const p = resolveConfiguredProvider(KILO_PROVIDER_ID, allProviders)
    expect(p).toBeUndefined()
  })

  it("still synthesizes generic custom provider when backend omits it", () => {
    const p = resolveConfiguredProvider("my-custom-x", allProviders, {
      "my-custom-x": { name: "My Custom X", npm: "@ai-sdk/openai-compatible" },
    })
    expect(p!.id).toBe("my-custom-x")
    expect(p!.name).toBe("My Custom X")
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

describe("buildConfiguredList Kilo reconstruction guard (P4.4-T11)", () => {
  it("suppresses synthetic Kilo when backend omits it but auth/config contain kilo", () => {
    const list = buildConfiguredList({}, [], new Set(), { [KILO_PROVIDER_ID]: { name: "Kilo" } }, { [KILO_PROVIDER_ID]: "oauth" })
    expect(list.map((p) => p.id)).not.toContain(KILO_PROVIDER_ID)
    expect(list.length).toBe(0)
  })

  it("suppresses Kilo even when connected/disabled/auth/config all contain kilo but backend omits it", () => {
    const list = buildConfiguredList(
      {},
      [KILO_PROVIDER_ID],
      new Set([KILO_PROVIDER_ID]),
      { [KILO_PROVIDER_ID]: { name: "Kilo" } },
      { [KILO_PROVIDER_ID]: "api" },
    )
    expect(list.find((p) => p.id === KILO_PROVIDER_ID)).toBeUndefined()
  })

  it("still reconstructs generic custom provider when backend omits it but auth/config contain it", () => {
    const list = buildConfiguredList(
      {},
      [],
      new Set(),
      { "my-generic-custom": { name: "My Generic", npm: "@ai-sdk/openai-compatible" } },
      { "my-generic-custom": "api" },
    )
    expect(list.map((p) => p.id)).toContain("my-generic-custom")
    expect(list.find((p) => p.id === "my-generic-custom")?.name).toBe("My Generic")
  })

  it("renders Kilo when backend provides it even if also in auth/config", () => {
    const backend: Record<string, Provider> = {
      [KILO_PROVIDER_ID]: makeProvider(KILO_PROVIDER_ID, "Kilo Gateway", "custom"),
    }
    const list = buildConfiguredList(backend, [KILO_PROVIDER_ID], new Set(), { [KILO_PROVIDER_ID]: {} }, { [KILO_PROVIDER_ID]: "oauth" })
    expect(list.map((p) => p.id)).toContain(KILO_PROVIDER_ID)
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

  it("includes all unconfigured providers alphabetically (no popularity filter, P4.4-T20)", () => {
    const list = buildAddList(allProviders, new Set(["anthropic"]))
    const ids = list.map((p) => p.id)
    // previously popular-only excluded groq/obscure; now generic includes them
    expect(ids).toContain(KILO_PROVIDER_ID)
    expect(ids).toContain("openai")
    expect(ids).toContain("groq")
    expect(ids).toContain("obscure")
    expect(ids).not.toContain("anthropic")
    // alphabetical by name: Anthropic would be first but excluded, so Groq, Kilo Gateway, Obscure, OpenAI
    const names = list.map((p) => p.name)
    const sorted = [...names].sort((a, b) => a.localeCompare(b))
    expect(names).toEqual(sorted)
  })

  it("excludes configured providers", () => {
    const list = buildAddList(allProviders, new Set([KILO_PROVIDER_ID, "anthropic", "openai"]))
    const ids = list.map((p) => p.id)
    expect(ids).not.toContain(KILO_PROVIDER_ID)
    expect(ids).not.toContain("anthropic")
    expect(ids).not.toContain("openai")
    expect(ids).toContain("groq")
    expect(ids).toContain("obscure")
  })

  it("returns empty when all providers are configured", () => {
    const configured = new Set(Object.keys(allProviders))
    const list = buildAddList(allProviders, configured)
    expect(list).toEqual([])
  })

  it("sorts add list deterministically alphabetical regardless of input order", () => {
    const providersA: Record<string, Provider> = {
      zebra: makeProvider("zebra", "Zebra"),
      apple: makeProvider("apple", "Apple"),
      middle: makeProvider("middle", "Middle"),
    }
    const providersB: Record<string, Provider> = {
      middle: makeProvider("middle", "Middle"),
      zebra: makeProvider("zebra", "Zebra"),
      apple: makeProvider("apple", "Apple"),
    }
    expect(buildAddList(providersA, new Set()).map((p) => p.id)).toEqual(["apple", "middle", "zebra"])
    expect(buildAddList(providersB, new Set()).map((p) => p.id)).toEqual(["apple", "middle", "zebra"])
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

  it("returns true for canonical source custom without config entry (canonical view signal)", () => {
    expect(isCustomConfigured(makeProvider("custom1", "Custom", "custom"))).toBe(true)
  })

  it("returns false when no config and source is not custom", () => {
    expect(isCustomConfigured(makeProvider("plain1", "Plain"))).toBe(false)
    expect(isCustomConfigured(makeProvider("anthropic", "Anthropic", "api"))).toBe(false)
  })

  it("returns true for canonical endpoint+protocol config shape", () => {
    const config = {
      mycustom: { name: "My Custom", endpoint: "https://example.com/v1", protocol: "openai/completions" },
    }
    expect(isCustomConfigured(makeProvider("mycustom", "My Custom", "custom"), config)).toBe(true)
    // Canonical shape is recognized even when the view source is not yet custom.
    expect(isCustomConfigured(makeProvider("mycustom", "My Custom", "config"), config)).toBe(true)
  })

  it("returns false for reserved internal IDs even with custom source or custom shape", () => {
    const config = {
      [KILO_PROVIDER_ID]: { name: "Kilo", endpoint: "https://example.com/v1", protocol: "openai/completions" },
      _custom: { name: "Synthetic", endpoint: "https://example.com/v1", protocol: "openai/completions" },
      "anaconda-desktop": { name: "Local", endpoint: "https://example.com/v1", protocol: "openai/completions" },
    }
    expect(isCustomConfigured(makeProvider(KILO_PROVIDER_ID, "Kilo", "custom"), config)).toBe(false)
    expect(isCustomConfigured(makeProvider("_custom", "Synthetic", "custom"), config)).toBe(false)
    expect(isCustomConfigured(makeProvider("anaconda-desktop", "Local", "custom"), config)).toBe(false)
  })

  it("does not treat ordinary future-like IDs as reserved", () => {
    const config = {
      openrouter: { name: "OpenRouter", endpoint: "https://example.com/v1", protocol: "openai/completions" },
    }
    expect(isCustomConfigured(makeProvider("openrouter", "OpenRouter", "custom"), config)).toBe(true)
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

  it("returns false for config source with api auth (LOCK-003)", () => {
    expect(showInlineApiKey(configProvider, { azure: "api" })).toBe(false)
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
  it("returns edit when isCustom is true", () => {
    expect(
      resolvePrimarySlot({ isCustom: true, hasApiKey: true, hasChatGPT: true, isAnaconda: true }),
    ).toBe("edit")
  })

  it("returns apiKey when hasApiKey is true (no custom)", () => {
    expect(
      resolvePrimarySlot({ isCustom: false, hasApiKey: true, hasChatGPT: true, isAnaconda: true }),
    ).toBe("apiKey")
  })

  it("returns chatgpt when hasChatGPT is true (no custom, no apiKey)", () => {
    expect(
      resolvePrimarySlot({ isCustom: false, hasApiKey: false, hasChatGPT: true, isAnaconda: true }),
    ).toBe("chatgpt")
  })

  it("returns anaconda when isAnaconda is true (only flag set)", () => {
    expect(
      resolvePrimarySlot({ isCustom: false, hasApiKey: false, hasChatGPT: false, isAnaconda: true }),
    ).toBe("anaconda")
  })

  it("returns placeholder when no flags are set", () => {
    expect(
      resolvePrimarySlot({ isCustom: false, hasApiKey: false, hasChatGPT: false, isAnaconda: false }),
    ).toBe("placeholder")
  })
})
