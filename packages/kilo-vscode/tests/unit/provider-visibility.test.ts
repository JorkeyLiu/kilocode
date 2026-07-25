import { describe, expect, it } from "bun:test"

import {
  connectedNonDisabledIds,
  providersWithKiloFallback,
  visibleConnectedIds,
} from "../../webview-ui/src/components/settings/provider-visibility"

describe("visibleConnectedIds", () => {
  it("hides Kilo from the connected list when auth is missing", () => {
    const ids = visibleConnectedIds(["kilo", "openrouter"], { openrouter: "api" })

    expect(ids).toEqual(["openrouter"])
  })

  it("keeps Kilo in the connected list when auth exists", () => {
    const ids = visibleConnectedIds(["kilo", "openrouter"], { kilo: "oauth", openrouter: "api" })

    expect(ids).toEqual(["kilo", "openrouter"])
  })

  it("leaves non-Kilo providers untouched", () => {
    const ids = visibleConnectedIds(["anthropic"], {})

    expect(ids).toEqual(["anthropic"])
  })
})

describe("providersWithKiloFallback", () => {
  it("adds Kilo when backend providers omit it", () => {
    const providers = providersWithKiloFallback({
      anthropic: { id: "anthropic", name: "Anthropic", env: [], models: {} },
    })

    expect(providers.kilo?.name).toBe("Kilo Gateway")
    expect(providers.anthropic?.name).toBe("Anthropic")
  })

  it("keeps the backend Kilo provider when present", () => {
    const providers = providersWithKiloFallback({
      kilo: { id: "kilo", name: "Custom Kilo Name", env: [], models: {} },
    })

    expect(providers.kilo?.name).toBe("Custom Kilo Name")
  })
})

describe("connectedNonDisabledIds", () => {
  it("excludes Kilo provider from connected list", () => {
    const ids = connectedNonDisabledIds(["kilo", "anthropic"], { kilo: "oauth", anthropic: "api" }, new Set())

    expect(ids).toEqual(["anthropic"])
  })

  it("excludes disabled providers from connected list", () => {
    const ids = connectedNonDisabledIds(["anthropic", "openai"], {}, new Set(["anthropic"]))

    expect(ids).toEqual(["openai"])
  })

  it("excludes both Kilo and disabled providers", () => {
    const ids = connectedNonDisabledIds(["kilo", "anthropic", "openai", "groq"], { kilo: "oauth" }, new Set(["openai"]))

    expect(ids).toEqual(["anthropic", "groq"])
  })

  it("returns empty when all connected providers are disabled or Kilo", () => {
    const ids = connectedNonDisabledIds(["kilo", "anthropic"], { kilo: "oauth" }, new Set(["anthropic"]))

    expect(ids).toEqual([])
  })

  it("returns all non-Kilo connected when nothing is disabled", () => {
    const ids = connectedNonDisabledIds(["anthropic", "openai"], {}, new Set())

    expect(ids).toEqual(["anthropic", "openai"])
  })
})
