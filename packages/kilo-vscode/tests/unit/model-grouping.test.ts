import { describe, it, expect } from "bun:test"
import {
  buildModelGroups,
  KILO_GATEWAY_ID,
  FAVORITES_KEY,
  modelKey,
  rowKey,
} from "../../webview-ui/src/components/shared/model-selector-utils"
import type { EnrichedModel } from "../../webview-ui/src/context/provider"

function m(overrides: Partial<EnrichedModel> & { providerID: string; id: string; name: string }): EnrichedModel {
  return {
    inputPrice: 0,
    outputPrice: 0,
    contextLength: 0,
    ...overrides,
  }
}

const kiloAuto = m({
  providerID: KILO_GATEWAY_ID,
  id: "kilo-auto/efficient",
  name: "Kilo Auto Efficient",
  providerName: "Kilo Gateway",
})
const kiloAutoSmall = m({
  providerID: KILO_GATEWAY_ID,
  id: "auto-small",
  name: "Kilo Auto Small",
  providerName: "Kilo Gateway",
})
const kiloFrontier = m({
  providerID: KILO_GATEWAY_ID,
  id: "kilo-auto/frontier",
  name: "Kilo Auto Frontier",
  providerName: "Kilo Gateway",
})
const kiloGemini = m({
  providerID: KILO_GATEWAY_ID,
  id: "google/gemini-2.5-pro",
  name: "Google: Gemini 2.5 Pro",
  providerName: "Kilo Gateway",
  recommendedIndex: 0,
})
const kiloClaude = m({
  providerID: KILO_GATEWAY_ID,
  id: "anthropic/claude-sonnet",
  name: "Anthropic: Claude Sonnet",
  providerName: "Kilo Gateway",
  recommendedIndex: 1,
})
const anthropicSonnet = m({
  providerID: "anthropic",
  id: "claude-sonnet-4",
  name: "Claude Sonnet 4",
  providerName: "Anthropic",
})
const anthropicOpus = m({
  providerID: "anthropic",
  id: "claude-opus-4",
  name: "Claude Opus 4",
  providerName: "Anthropic",
  recommendedIndex: 0,
})
const openaiGpt = m({ providerID: "openai", id: "gpt-4o", name: "GPT-4o", providerName: "OpenAI" })
const openaiRecommended = m({ providerID: "openai", id: "o3", name: "o3", providerName: "OpenAI", recommendedIndex: 2 })

describe("buildModelGroups", () => {
  it("produces no top-level Auto or Recommended groups", () => {
    const groups = buildModelGroups(
      [kiloAuto, kiloAutoSmall, kiloFrontier, kiloGemini, kiloClaude, anthropicSonnet, anthropicOpus],
      [],
      "Favorites",
    )
    const keys = groups.map((g) => g.key)
    expect(keys).not.toContain("auto")
    expect(keys).not.toContain("recommended")
  })

  it("puts auto models under the Kilo Gateway provider group", () => {
    const groups = buildModelGroups([kiloAuto, kiloAutoSmall, kiloFrontier, anthropicSonnet], [], "Favorites")
    const kiloGroup = groups.find((g) => g.key === KILO_GATEWAY_ID)
    expect(kiloGroup).toBeDefined()
    const ids = kiloGroup!.rows.map((r) => r.model.id)
    expect(ids).toContain("kilo-auto/efficient")
    expect(ids).toContain("auto-small")
    expect(ids).toContain("kilo-auto/frontier")
  })

  it("puts recommended models under their provider group", () => {
    const groups = buildModelGroups([kiloGemini, kiloClaude, anthropicOpus, openaiRecommended], [], "Favorites")
    const kiloGroup = groups.find((g) => g.key === KILO_GATEWAY_ID)
    expect(kiloGroup).toBeDefined()
    expect(kiloGroup!.rows.some((r) => r.model.id === "google/gemini-2.5-pro")).toBe(true)

    const anthropicGroup = groups.find((g) => g.key === "anthropic")
    expect(anthropicGroup).toBeDefined()
    expect(anthropicGroup!.rows.some((r) => r.model.id === "claude-opus-4")).toBe(true)

    const openaiGroup = groups.find((g) => g.key === "openai")
    expect(openaiGroup).toBeDefined()
    expect(openaiGroup!.rows.some((r) => r.model.id === "o3")).toBe(true)
  })

  it("sorts auto models before recommended and regular within a provider group", () => {
    const groups = buildModelGroups([kiloGemini, kiloAuto, kiloClaude, kiloAutoSmall], [], "Favorites")
    const kiloGroup = groups.find((g) => g.key === KILO_GATEWAY_ID)
    expect(kiloGroup).toBeDefined()
    const ids = kiloGroup!.rows.map((r) => r.model.id)
    // Auto models first
    const autoIndices = [ids.indexOf("kilo-auto/efficient"), ids.indexOf("auto-small")]
    const recIndex = ids.indexOf("google/gemini-2.5-pro")
    expect(autoIndices[0]).toBeLessThan(recIndex)
    expect(autoIndices[1]).toBeLessThan(recIndex)
  })

  it("sorts recommended models by recommendedIndex within a provider group", () => {
    const groups = buildModelGroups([kiloClaude, kiloGemini, anthropicOpus], [], "Favorites")
    const kiloGroup = groups.find((g) => g.key === KILO_GATEWAY_ID)
    expect(kiloGroup).toBeDefined()
    const ids = kiloGroup!.rows.map((r) => r.model.id)
    // Gemini (recommendedIndex 0) before Claude (recommendedIndex 1)
    expect(ids.indexOf("google/gemini-2.5-pro")).toBeLessThan(ids.indexOf("anthropic/claude-sonnet"))
  })

  it("sorts regular models alphabetically within a provider group", () => {
    const modelA = m({ providerID: "openai", id: "aaa", name: "AAA", providerName: "OpenAI" })
    const modelZ = m({ providerID: "openai", id: "zzz", name: "ZZZ", providerName: "OpenAI" })
    const modelM = m({ providerID: "openai", id: "mmm", name: "MMM", providerName: "OpenAI" })
    const groups = buildModelGroups([modelZ, modelA, modelM], [], "Favorites")
    const openaiGroup = groups.find((g) => g.key === "openai")
    expect(openaiGroup).toBeDefined()
    const ids = openaiGroup!.rows.map((r) => r.model.id)
    expect(ids).toEqual(["aaa", "mmm", "zzz"])
  })

  it("preserves Favorites as the only special top-level group", () => {
    const fav = anthropicSonnet
    const groups = buildModelGroups([kiloAuto, anthropicSonnet, openaiGpt], [fav], "Favorites")
    expect(groups[0]!.key).toBe(FAVORITES_KEY)
    expect(groups[0]!.label).toBe("Favorites")
    expect(groups[0]!.rows[0]!.kind).toBe("favorite")
    expect(groups[0]!.rows[0]!.model.id).toBe("claude-sonnet-4")
  })

  it("sorts provider groups alphabetically by display name with id tie-break", () => {
    const groups = buildModelGroups([openaiGpt, anthropicSonnet, kiloAuto], [], "Favorites")
    const keys = groups.map((g) => g.key)
    expect(keys).toEqual(["anthropic", KILO_GATEWAY_ID, "openai"])
  })

  it("handles empty model list", () => {
    const groups = buildModelGroups([], [], "Favorites")
    expect(groups).toEqual([])
  })

  it("handles empty models with favorites", () => {
    const groups = buildModelGroups([], [anthropicSonnet], "Favorites")
    expect(groups).toHaveLength(1)
    expect(groups[0]!.key).toBe(FAVORITES_KEY)
    expect(groups[0]!.rows).toHaveLength(1)
  })

  it("deduplicates favorites from provider groups (favorites are separate)", () => {
    const groups = buildModelGroups([anthropicSonnet, openaiGpt], [anthropicSonnet], "Favorites")
    // Favorites group has the model
    expect(groups[0]!.key).toBe(FAVORITES_KEY)
    expect(groups[0]!.rows[0]!.model.id).toBe("claude-sonnet-4")
    // Provider group also has the model (dedup is handled by the component, not the builder)
    const anthropicGroup = groups.find((g) => g.key === "anthropic")
    expect(anthropicGroup).toBeDefined()
    expect(anthropicGroup!.rows[0]!.model.id).toBe("claude-sonnet-4")
  })

  it("generates correct row keys for favorites", () => {
    const groups = buildModelGroups([], [anthropicSonnet], "Favorites")
    expect(groups[0]!.rows[0]!.key).toBe(rowKey("favorite", "anthropic", "claude-sonnet-4"))
  })

  it("generates correct row keys for provider models", () => {
    const groups = buildModelGroups([anthropicSonnet], [], "Favorites")
    const anthropicGroup = groups.find((g) => g.key === "anthropic")
    expect(anthropicGroup!.rows[0]!.key).toBe(rowKey("model", "anthropic", "claude-sonnet-4"))
  })

  it("uses providerName for group label", () => {
    const groups = buildModelGroups([anthropicSonnet], [], "Favorites")
    const anthropicGroup = groups.find((g) => g.key === "anthropic")
    expect(anthropicGroup!.label).toBe("Anthropic")
  })

  it("preserves empty providerName as group label (?? only handles null/undefined)", () => {
    // providerName is a required string field; ?? id is a defensive fallback
    // that only fires for null/undefined, so empty string passes through as-is.
    const noName = m({ providerID: "custom", id: "x", name: "X", providerName: "" })
    const groups = buildModelGroups([noName], [], "Favorites")
    const customGroup = groups.find((g) => g.key === "custom")
    expect(customGroup!.label).toBe("")
  })
})

describe("modelKey", () => {
  it("joins providerID and modelID with slash", () => {
    expect(modelKey("anthropic", "claude-sonnet")).toBe("anthropic/claude-sonnet")
  })
})

describe("rowKey", () => {
  it("formats kind:providerID/modelID", () => {
    expect(rowKey("model", "anthropic", "claude-sonnet")).toBe("model:anthropic/claude-sonnet")
    expect(rowKey("favorite", "openai", "gpt-4o")).toBe("favorite:openai/gpt-4o")
  })
})
