import { describe, expect, it } from "bun:test"

import type { Provider } from "../../webview-ui/src/types/messages"
import {
  isPopularProvider,
  popularProviderIndex,
  sortProviders,
  providerIcon,
  providerNoteKey,
} from "../../webview-ui/src/components/settings/provider-catalog"

function provider(id: string, metadata?: Provider["metadata"]): Provider {
  return {
    id,
    name: id,
    models: {},
    metadata,
  }
}

describe("provider catalog", () => {
  it("treats known provider objects as popular when metadata is unavailable", () => {
    expect(isPopularProvider(provider("openai"))).toBe(true)
    expect(isPopularProvider(provider("anthropic"))).toBe(true)
    expect(isPopularProvider(provider("unknown"))).toBe(false)
  })

  it("uses fallback ordering for provider objects without metadata", () => {
    const items = [provider("openai"), provider("anthropic"), provider("unknown")]
    const ids = sortProviders(items).map((item) => item.id)

    expect(ids).toEqual(["anthropic", "openai", "unknown"])
  })

  it("prefers metadata priority over fallback ordering", () => {
    expect(popularProviderIndex(provider("openai", { priority: 1 }))).toBe(1)
  })

  it("does not specially route Kilo icon — generic validIcon fallback remains (P4.4-T10)", () => {
    // No Kilo-specific branch: icon is derived from metadata.icon or providerID validity.
    // "kilo" is a valid icon name, so generic validIcon(providerID) still resolves to "kilo".
    expect(providerIcon(provider("kilo"))).toBe("kilo")
    expect(providerIcon(provider("kilo", { icon: "kilo" }))).toBe("kilo")
    expect(providerIcon(provider("anthropic"))).toBe("anthropic")
    expect(providerIcon(provider("unknown"))).toBe("synthetic")
  })

  it("does not return Kilo note key — generic metadata noteKey only (P4.4-T10)", () => {
    expect(providerNoteKey(provider("kilo"))).toBeUndefined()
    expect(providerNoteKey("kilo")).toBeUndefined()
    expect(providerNoteKey(provider("anthropic"))).toBeUndefined()
    expect(providerNoteKey(provider("custom", { noteKey: "settings.providers.custom.description" }))).toBe(
      "settings.providers.custom.description",
    )
  })

  it("providerNoteKey with string kilo and provider object kilo both return undefined", () => {
    expect(providerNoteKey(provider("kilo", { priority: 0 }))).toBeUndefined()
  })
})
