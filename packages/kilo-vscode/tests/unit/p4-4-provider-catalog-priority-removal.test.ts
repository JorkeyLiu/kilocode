import { describe, expect, it } from "bun:test"
import { sortProviders } from "../../webview-ui/src/components/settings/provider-catalog"
import { buildAddList, buildConfiguredList } from "../../webview-ui/src/components/settings/provider-tab-helpers"
import { buildModelGroups } from "../../webview-ui/src/components/shared/model-selector-utils"
import type { Provider } from "../../webview-ui/src/types/messages"
import type { EnrichedModel } from "../../webview-ui/src/context/provider"

function provider(id: string, name: string): Provider {
  return { id, name, models: {} }
}

function enriched(providerID: string, id: string, name: string, providerName: string): EnrichedModel {
  return { providerID, id, name, providerName } as EnrichedModel
}

/**
 * P4.4-T20 preset-provider priority/catalog residue removal — extension webview.
 * Removes PROVIDER_PRIORITY / FALLBACK_PROVIDER_IDS / isPopularProvider / popularProviderIndex /
 * providerOrderIndex / PROVIDER_ORDER / providerSortKey priority dependence, replacing with
 * deterministic alphabetical sorting by display name with provider ID tie-breaker.
 * Preserves KILO_PROVIDER_ID, KILO_AUTO, CUSTOM_PROVIDER_PACKAGES, generic provider discovery,
 * custom-provider behavior, generic icons/notes, and auth flows.
 */
describe("P4.4-T20 preset-provider priority/catalog residue removed", () => {
  it("priority/popularity symbols are absent from scoped extension path (static)", async () => {
    const providerModel = await Bun.file("src/shared/provider-model.ts").text()
    expect(providerModel).not.toContain("PROVIDER_PRIORITY")
    expect(providerModel).not.toContain("providerOrderIndex")
    expect(providerModel).not.toContain("FALLBACK_PROVIDER_IDS")
    expect(providerModel).not.toContain("isPopularProvider")
    expect(providerModel).not.toContain("popularProviderIndex")

    const catalog = await Bun.file("webview-ui/src/components/settings/provider-catalog.ts").text()
    expect(catalog).not.toContain("PROVIDER_PRIORITY")
    expect(catalog).not.toContain("FALLBACK_PROVIDER_IDS")
    expect(catalog).not.toContain("providerOrderIndex")
    expect(catalog).not.toContain("isPopularProvider")
    expect(catalog).not.toContain("popularProviderIndex")
    expect(catalog).not.toContain("PROVIDER_ORDER")
    expect(catalog).not.toContain("providerSortKey")

    const utils = await Bun.file("webview-ui/src/components/shared/model-selector-utils.ts").text()
    expect(utils).not.toContain("PROVIDER_PRIORITY")
    expect(utils).not.toContain("PROVIDER_ORDER")
    expect(utils).not.toContain("providerOrderIndex")
    expect(utils).not.toContain("providerSortKey")
    expect(utils).not.toContain("FALLBACK_PROVIDER_IDS")
    expect(utils).not.toContain("isPopularProvider")
    expect(utils).not.toContain("popularProviderIndex")

    const helpers = await Bun.file("webview-ui/src/components/settings/provider-tab-helpers.ts").text()
    expect(helpers).not.toContain("isPopularProvider")
    expect(helpers).not.toContain("popularProviderIndex")
    expect(helpers).not.toContain("PROVIDER_PRIORITY")
    expect(helpers).not.toContain("FALLBACK_PROVIDER_IDS")
    expect(helpers).not.toContain("providerOrderIndex")
    expect(helpers).not.toContain("PROVIDER_ORDER")
    expect(helpers).not.toContain("providerSortKey")

    const dialog = await Bun.file("webview-ui/src/components/settings/ProviderSelectDialog.tsx").text()
    expect(dialog).not.toContain("isPopularProvider")
    expect(dialog).not.toContain("popularProviderIndex")
    expect(dialog).not.toContain("PROVIDER_PRIORITY")
    expect(dialog).not.toContain("FALLBACK_PROVIDER_IDS")
    expect(dialog).not.toContain("providerOrderIndex")
    expect(dialog).not.toContain("PROVIDER_ORDER")
    expect(dialog).not.toContain("providerSortKey")
    expect(dialog).not.toContain("settings.providers.group.recommended")
  })

  it("protected symbols and generic behavior remain (static)", async () => {
    const providerModel = await Bun.file("src/shared/provider-model.ts").text()
    expect(providerModel).toContain('KILO_PROVIDER_ID = "kilo"')
    expect(providerModel).toContain("KILO_AUTO")
    expect(providerModel).toContain("CUSTOM_PROVIDER_PACKAGES")
    expect(providerModel).toContain("isCustomProviderPackage")
    expect(providerModel).toContain("parseModelString")
    expect(providerModel).toContain("PROVIDER_ID_PATTERN")

    const catalog = await Bun.file("webview-ui/src/components/settings/provider-catalog.ts").text()
    expect(catalog).toContain("sortProviders")
    expect(catalog).toContain("providerIcon")
    expect(catalog).toContain("providerNoteKey")
    expect(catalog).toContain("CUSTOM_PROVIDER_ID")
    expect(catalog).toContain("localeCompare")

    const utils = await Bun.file("webview-ui/src/components/shared/model-selector-utils.ts").text()
    expect(utils).toContain("KILO_GATEWAY_ID")
    expect(utils).toContain("buildModelGroups")
    expect(utils).toContain("localeCompare")

    const helpers = await Bun.file("webview-ui/src/components/settings/provider-tab-helpers.ts").text()
    expect(helpers).toContain("KILO_PROVIDER_ID")
    expect(helpers).toContain("isCustomProviderPackage")
    expect(helpers).toContain("buildAddList")
    expect(helpers).toContain("buildConfiguredList")

    const dialog = await Bun.file("webview-ui/src/components/settings/ProviderSelectDialog.tsx").text()
    expect(dialog).toContain("CUSTOM_PROVIDER_ID")
    expect(dialog).toContain("providerIcon")
    expect(dialog).not.toContain("isPopularProvider")
  })

  it("sortProviders is deterministic alphabetical with id tie-break", () => {
    const input = [
      provider("zebra", "Zebra"),
      provider("apple", "Apple"),
      provider("middle", "Middle"),
      provider("a2", "Apple"),
    ]
    const sorted = sortProviders(input).map((p) => p.id)
    // Apple names first, tie-break by id: a2 (Apple) vs apple (Apple) -> a2 < apple? "a2" < "apple" lexicographically
    // Actually localeCompare on name equal, then id tie-break: "a2" vs "apple"
    expect(sorted).toEqual(["a2", "apple", "middle", "zebra"])
    // determinism: different input order yields same result
    const shuffled = [provider("middle", "Middle"), provider("a2", "Apple"), provider("zebra", "Zebra"), provider("apple", "Apple")]
    expect(sortProviders(shuffled).map((p) => p.id)).toEqual(sorted)
  })

  it("buildAddList is alphabetical and includes generic providers (no popularity filter)", () => {
    const all: Record<string, Provider> = {
      openai: provider("openai", "OpenAI"),
      anthropic: provider("anthropic", "Anthropic"),
      groq: provider("groq", "Groq"),
    }
    const list = buildAddList(all, new Set(["groq"]))
    expect(list.map((p) => p.id)).toEqual(["anthropic", "openai"])
    // all unconfigured => alphabetical
    expect(buildAddList(all, new Set()).map((p) => p.id)).toEqual(["anthropic", "groq", "openai"])
  })

  it("buildModelGroups provider groups are alphabetical by display name with id tie-break", () => {
    const models: EnrichedModel[] = [
      enriched("zebra", "m1", "Model", "Zebra"),
      enriched("apple", "m2", "Model", "Apple"),
      enriched("middle", "m3", "Model", "Middle"),
    ]
    expect(buildModelGroups(models, [], "Fav").map((g) => g.key)).toEqual(["apple", "middle", "zebra"])
    // tie-break same display name -> id alphabetical
    const tie: EnrichedModel[] = [
      enriched("bbb", "m1", "Model", "Same"),
      enriched("aaa", "m2", "Model", "Same"),
    ]
    expect(buildModelGroups(tie, [], "Fav").map((g) => g.key)).toEqual(["aaa", "bbb"])
  })

  it("custom-provider behavior remains intact via buildConfiguredList generic reconstruction", () => {
    const backend: Record<string, Provider> = {}
    const list = buildConfiguredList(backend, [], new Set(), { "my-custom": { name: "My Custom", npm: "@ai-sdk/openai-compatible" } }, { "my-custom": "api" })
    expect(list.map((p) => p.id)).toContain("my-custom")
    expect(list.find((p) => p.id === "my-custom")?.name).toBe("My Custom")
  })
})
