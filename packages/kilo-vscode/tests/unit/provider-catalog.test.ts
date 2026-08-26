import { describe, expect, it } from "bun:test"

import type { Provider } from "../../webview-ui/src/types/messages"
import { sortProviders, providerIcon, providerNoteKey } from "../../webview-ui/src/components/settings/provider-catalog"

function provider(id: string, name = id, metadata?: Provider["metadata"]): Provider {
  return {
    id,
    name,
    models: {},
    metadata,
  }
}

describe("provider catalog", () => {
  it("sorts providers alphabetically by name with id tie-break", () => {
    const items = [
      provider("openai", "OpenAI"),
      provider("anthropic", "Anthropic"),
      provider("zzz", "Anthropic"),
      provider("unknown", "Unknown"),
    ]
    const ids = sortProviders(items).map((item) => item.id)
    // Anthropic names sort first; tie-break by id: anthropic before zzz
    expect(ids).toEqual(["anthropic", "zzz", "openai", "unknown"])
  })

  it("sort is deterministic alphabetical regardless of input order", () => {
    const a = [provider("zebra", "Zebra"), provider("apple", "Apple"), provider("middle", "Middle")]
    const b = [provider("middle", "Middle"), provider("zebra", "Zebra"), provider("apple", "Apple")]
    expect(sortProviders(a).map((p) => p.id)).toEqual(sortProviders(b).map((p) => p.id))
    expect(sortProviders(a).map((p) => p.id)).toEqual(["apple", "middle", "zebra"])
  })

  it("does not specially route Kilo icon — generic validIcon fallback remains (P4.4-T10/T20)", () => {
    expect(providerIcon(provider("kilo", "kilo"))).toBe("kilo")
    expect(providerIcon(provider("kilo", "kilo", { icon: "kilo" }))).toBe("kilo")
    expect(providerIcon(provider("anthropic", "Anthropic"))).toBe("anthropic")
    expect(providerIcon(provider("unknown", "Unknown"))).toBe("synthetic")
  })

  it("does not return Kilo note key — generic metadata noteKey only (P4.4-T10)", () => {
    expect(providerNoteKey(provider("kilo", "kilo"))).toBeUndefined()
    expect(providerNoteKey("kilo")).toBeUndefined()
    expect(providerNoteKey(provider("anthropic", "Anthropic"))).toBeUndefined()
    expect(providerNoteKey(provider("custom", "Custom", { noteKey: "settings.providers.custom.description" }))).toBe(
      "settings.providers.custom.description",
    )
  })

  it("providerNoteKey with string kilo and provider object kilo both return undefined", () => {
    expect(providerNoteKey(provider("kilo", "kilo", { priority: 0 } as unknown as Provider["metadata"]))).toBeUndefined()
  })
})
