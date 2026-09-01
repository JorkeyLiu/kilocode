import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createRoot } from "solid-js"
import { createDialogModelOptions, sortModelOptions, type CreateDialogModelOptionsDeps } from "../../src/cli/cmd/tui/component/dialog-model"

// P4.4-T26 source-removal evidence — CLI TUI model dialog preset recommendation/popularity presentation physically removed (T26-SCOPE P4.4 CLI TUI display-only; T26-BEHAVIOR generic provider display-name category, no Kilo Recommended / Popular providers / kiloRank — generic deterministic provider-name category).
// - `packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx` deleted kiloRank memo, Kilo Recommended category/rank, disconnected Popular providers synthesis and related unused imports/bindings (take, createDialogProviderOptions). Category collapsed to provider display-name when connected; no new preference/rank mechanism.
// - Preserved: FreeModelDisclosure, BYOK/May-train/Free footer construction, ModelInfoPanel, footer-based free-first ordering, model actions, favorites/recents, provider-scoped newest-first ordering, generic DialogProvider flow (T26-SCOPE display-only).
// - Data-layer recommendedIndex, provider catalog/schema/runtime-model/agent-manager ordering, P5 product deletion, ConfigPaths, transport, generated SDK untouched — LOCK-009 bridge remains open, LOCK-006 custom-provider direction remains open/residual per T26-SCOPE.
// - This file asserts absence of preset presentation rank/category synthesis and executable generic grouping/sort preservation via the real factory; it does not claim P4.4/P5 completion.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}
function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4-T26 TUI model dialog preset removal — preset presentation absent, generic grouping preserved", () => {
  test("dialog-model has no Kilo Recommended / Popular providers / kiloRank / recommendedIndex usage", () => {
    const src = read("cli/cmd/tui/component/dialog-model.tsx")
    expect(src).not.toContain("kiloRank")
    expect(src).not.toContain("Recommended")
    expect(src).not.toContain("Popular")
    expect(src).not.toContain("Popular providers")
    expect(src).not.toContain("recommendedIndex")
    expect(src).not.toContain("createDialogProviderOptions")
    expect(src).not.toContain("take")
    expect(src).not.toContain("kiloRank()")
    expect(src).not.toContain("Sort within Recommended")
  })

  test("dialog-model collapses to provider display-name category when connected", () => {
    const src = read("cli/cmd/tui/component/dialog-model.tsx")
    expect(src).toContain('category: connected() ? provider.name : undefined')
    expect(src).not.toContain('"Recommended"')
    expect(src).not.toContain("provider.id === \"kilo\"")
  })

  test("dialog-model preserves FreeModelDisclosure, ModelInfoPanel, footer disclosure and model actions", () => {
    const src = read("cli/cmd/tui/component/dialog-model.tsx")
    expect(src).toContain("FreeModelDisclosure")
    expect(src).toContain("FreeModelDisclosure.hasByok")
    expect(src).toContain("FreeModelDisclosure.collectsData")
    expect(src).toContain("FreeModelDisclosure.byok")
    expect(src).toContain("FreeModelDisclosure.label")
    expect(src).toContain("ModelInfoPanel")
    expect(src).toContain("footer(provider.id, info)")
    expect(src).toContain("footer(provider.id, model)")
    expect(src).toContain("Free")
    expect(src).toContain("FreeModelDisclosure.byok")
    expect(src).toContain("FreeModelDisclosure.label")
    expect(src).toContain("ModelInfoPanel")
    expect(src).toContain("wide() && preview()")
  })

  test("dialog-model preserves favorites/recents, provider-scoped newestFirst ordering, and generic DialogProvider flow", () => {
    const src = read("cli/cmd/tui/component/dialog-model.tsx")
    expect(src).toContain('Favorites')
    expect(src).toContain('Recent')
    expect(src).toContain("local.model.favorite()")
    expect(src).toContain("local.model.recent()")
    expect(src).toContain("local.model.toggleFavorite")
    expect(src).toContain("sortModelOptions")
    expect(src).toContain("providerOptions")
    expect(src).toContain("favoriteOptions")
    expect(src).toContain("recentOptions")
    expect(src).toContain("DialogProvider")
    expect(src).toContain('model.dialog.provider')
    expect(src).toContain('model.dialog.favorite')
    expect(src).toContain("DialogVariant")
    expect(src).toContain("useConnected")
    // provider-scoped newestFirst ordering preserved via sortModelOptions call
    expect(src).toContain("providerID !== undefined")
    expect(src).toContain("sortModelOptions")
  })

  test("sortModelOptions preserves footer free-first and newestFirst generic ordering without rank", () => {
    const src = read("cli/cmd/tui/component/dialog-model.tsx")
    expect(src).toContain("export function sortModelOptions")
    expect(src).toContain("(option) => option.footer === undefined")
    expect(src).toContain("(option) => option.releaseDate")
    expect(src).toContain("(option) => option.title")
    expect(src).not.toContain("kiloRank")
    expect(src).not.toContain("recommendedIndex")
    expect(src).not.toContain("Recommended")
    expect(src).not.toContain("ReadonlyMap<string, number>")
    expect(src).not.toContain("rank.get")
    expect(src).toContain("fuzzysort")
  })

  test("data-layer recommendedIndex remains outside dialog (T26-SCOPE display-only)", () => {
    const provider = read("kilocode/provider/provider.ts")
    expect(provider).toContain("recommendedIndex")
    expect(provider).toContain("KILO_MODEL_SCHEMA_EXTENSIONS")
    expect(provider).toContain("patchConfigModel")
    const catalog = read("kilo-sessions/remote-model-catalog.ts")
    expect(catalog).toContain("recommendedIndex")
    const dialog = read("cli/cmd/tui/component/dialog-model.tsx")
    expect(dialog).not.toContain("recommendedIndex")
  })

  test("no dialog-provider, Kilo auto-auth, provider catalog/schema, SDK generated surfaces modified per scope", () => {
    const dialogProvider = read("cli/cmd/tui/component/dialog-provider.tsx")
    expect(dialogProvider).toContain('category: "Providers"')
    expect(dialogProvider).toContain("DialogProvider")
    const kiloProvider = read("kilocode/cli/cmd/tui/component/dialog-provider.tsx")
    expect(kiloProvider).toContain("renderAutoMethod")
    expect(kiloProvider).toContain("selectProvider")
    const dialog = read("cli/cmd/tui/component/dialog-model.tsx")
    expect(dialog).toContain('type { Model } from "@kilocode/sdk/v2"')
  })

  test("test-profile lists new TUI model dialog regression in sorted order", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).toContain("p4-4-tui-model-dialog-preset-removal")
    expect(profile).toContain("p4-4-tui-provider-dialog-preset-removal")
    expect(profile).toContain("p4-4-tui-migrate-kilo-config-removal")
    const migrateIdx = profile.indexOf("p4-4-tui-migrate-kilo-config-removal")
    const modelIdx = profile.indexOf("p4-4-tui-model-dialog-preset-removal")
    const providerIdx = profile.indexOf("p4-4-tui-provider-dialog-preset-removal")
    const wellknownIdx = profile.indexOf("p4-4-wellknown-provider-auth-removal")
    expect(migrateIdx).toBeGreaterThan(-1)
    expect(modelIdx).toBeGreaterThan(-1)
    expect(providerIdx).toBeGreaterThan(-1)
    expect(modelIdx).toBeGreaterThan(migrateIdx)
    expect(modelIdx).toBeLessThan(providerIdx)
    expect(providerIdx).toBeLessThan(wellknownIdx)
  })
})

describe("P4.4-T26 TUI model dialog — executable factory assembly via createDialogModelOptions", () => {
  function fakeProviders() {
    return [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4": {
            id: "gpt-4",
            name: "GPT 4",
            providerID: "openai",
            release_date: "2025-01-01",
            cost: { input: 1, output: 2 },
            status: "active",
          },
          "gpt-5": {
            id: "gpt-5",
            name: "GPT 5",
            providerID: "openai",
            release_date: "2026-03-05",
            cost: { input: 0, output: 0 },
            status: "active",
          },
        },
      },
      {
        id: "kilo",
        name: "Kilo",
        models: {
          "kilo-model-a": {
            id: "kilo-model-a",
            name: "Kilo A",
            providerID: "kilo",
            release_date: "2026-01-01",
            cost: { input: 1, output: 1 },
            hasUserByokAvailable: true,
            mayTrainOnYourPrompts: true,
            status: "active",
          },
        },
      },
      {
        id: "opencode",
        name: "Opencode",
        models: {
          "free-model": {
            id: "free-model",
            name: "Free Model",
            providerID: "opencode",
            release_date: "2024-01-01",
            cost: { input: 0, output: 0 },
            status: "active",
          },
        },
      },
    ]
  }

  function makeLocal(favorites: Array<{ providerID: string; modelID: string }>, recents: Array<{ providerID: string; modelID: string }>) {
    return {
      model: {
        favorite: () => favorites,
        recent: () => recents,
        current: () => undefined,
        variant: { list: () => [], selected: () => undefined },
        set: () => {},
        toggleFavorite: () => {},
      },
    } as unknown as CreateDialogModelOptionsDeps["local"]
  }

  function makeSync(providers: ReturnType<typeof fakeProviders>) {
    return {
      data: { provider: providers as unknown as CreateDialogModelOptionsDeps["sync"] extends { data: { provider: infer P } } ? P : never },
    } as unknown as CreateDialogModelOptionsDeps["sync"]
  }

  const fakeDialog = {
    clear: () => {},
    replace: () => {},
    setSize: () => {},
    stack: [],
    size: "medium",
  } as unknown as CreateDialogModelOptionsDeps["dialog"]

  test("connected models use provider-name category and no Recommended entries", () => {
    const providers = fakeProviders()
    const local = makeLocal([], [])
    const sync = makeSync(providers)
    const connected = (() => true) as unknown as CreateDialogModelOptionsDeps["connected"]
    const opts = createRoot((dispose) => {
      const get = createDialogModelOptions({ local, sync, connected, dialog: fakeDialog, query: () => "" })
      const v = get()
      dispose()
      return v
    })
    expect(opts.length).toBeGreaterThan(0)
    for (const o of opts) {
      if (o.category) {
        expect(o.category).not.toBe("Recommended")
        expect(o.category).not.toContain("Popular")
        expect(["OpenAI", "Kilo", "Opencode", "Favorites", "Recent"]).toContain(o.category)
      }
    }
    const categories = new Set(opts.map((o) => o.category).filter(Boolean))
    expect(categories.has("OpenAI")).toBe(true)
    expect(categories.has("Kilo")).toBe(true)
  })

  test("disconnected options contain no Popular providers synthetic shortcut", () => {
    const providers = fakeProviders()
    const local = makeLocal([], [])
    const sync = makeSync(providers)
    const connected = (() => false) as unknown as CreateDialogModelOptionsDeps["connected"]
    const opts = createRoot((dispose) => {
      const get = createDialogModelOptions({ local, sync, connected, dialog: fakeDialog, query: () => "" })
      const v = get()
      dispose()
      return v
    })
    for (const o of opts) {
      expect(o.category).not.toBe("Popular providers")
      expect(o.category).not.toBe("Popular")
    }
    expect(opts.every((o) => o.category === undefined)).toBe(true)
  })

  test("provider-scoped result preserves newest-first order", () => {
    const providers = [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "a-old": { id: "a-old", name: "A Old", providerID: "openai", release_date: "2025-01-01", cost: { input: 1, output: 1 }, status: "active" },
          "b-new": { id: "b-new", name: "B New", providerID: "openai", release_date: "2026-03-05", cost: { input: 1, output: 1 }, status: "active" },
          "c-mid": { id: "c-mid", name: "C Mid", providerID: "openai", release_date: "2025-06-01", cost: { input: 1, output: 1 }, status: "active" },
        },
      },
    ]
    const local = makeLocal([], [])
    const sync = makeSync(providers as unknown as ReturnType<typeof fakeProviders>)
    const connected = (() => true) as unknown as CreateDialogModelOptionsDeps["connected"]
    const opts = createRoot((dispose) => {
      const get = createDialogModelOptions({ local, sync, connected, dialog: fakeDialog, providerID: "openai", query: () => "" })
      const v = get()
      dispose()
      return v
    })
    const titles = opts.map((o) => o.title)
    expect(titles).toEqual(["B New", "C Mid", "A Old"])
  })

  test("favorites/recents deduplication is real", () => {
    const providers = fakeProviders()
    const fav = [{ providerID: "openai", modelID: "gpt-4" }]
    const rec = [{ providerID: "openai", modelID: "gpt-4" }, { providerID: "openai", modelID: "gpt-5" }]
    const local = makeLocal(fav, rec)
    const sync = makeSync(providers)
    const connected = (() => true) as unknown as CreateDialogModelOptionsDeps["connected"]
    const opts = createRoot((dispose) => {
      const get = createDialogModelOptions({ local, sync, connected, dialog: fakeDialog, query: () => "" })
      const v = get()
      dispose()
      return v
    })
    const favOpts = opts.filter((o) => o.category === "Favorites")
    const recOpts = opts.filter((o) => o.category === "Recent")
    const providerOpts = opts.filter((o) => o.category === "OpenAI")
    expect(favOpts.length).toBe(1)
    expect(favOpts[0].value).toEqual({ providerID: "openai", modelID: "gpt-4" })
    expect(recOpts.length).toBe(1)
    expect(recOpts[0].value).toEqual({ providerID: "openai", modelID: "gpt-5" })
    expect(providerOpts.some((o) => o.value.providerID === "openai" && o.value.modelID === "gpt-4")).toBe(false)
    expect(providerOpts.some((o) => o.value.providerID === "openai" && o.value.modelID === "gpt-5")).toBe(false)
  })

  test("footer disclosure/free ordering remains via factory and sortModelOptions", () => {
    const providers = fakeProviders()
    const local = makeLocal([], [])
    const sync = makeSync(providers)
    const connected = (() => true) as unknown as CreateDialogModelOptionsDeps["connected"]
    const opts = createRoot((dispose) => {
      const get = createDialogModelOptions({ local, sync, connected, dialog: fakeDialog, query: () => "" })
      const v = get()
      dispose()
      return v
    })
    const kiloEntry = opts.find((o) => o.value.providerID === "kilo")
    expect(kiloEntry?.footer).toContain("BYOK")
    expect(kiloEntry?.footer).toContain("May train")
    const freeOpencode = opts.find((o) => o.value.providerID === "opencode")
    expect(freeOpencode?.footer).toBe("Free")
    // free-first ordering preserved in regular picker via sortModelOptions
    const regular = sortModelOptions(
      [
        { title: "Beta", releaseDate: "2026-01-01" },
        { title: "Alpha", releaseDate: "2025-01-01", footer: "Free" },
        { title: "Gamma", releaseDate: "2024-01-01", footer: "BYOK · May train" },
      ],
      false,
    )
    expect(regular.map((m) => m.title)).toEqual(["Alpha", "Gamma", "Beta"])
    expect(sortModelOptions.length).toBe(2)
  })

  test("FreeModelDisclosure and ModelInfoPanel remain importable with expected labels", async () => {
    const { FreeModelDisclosure } = await import("../../src/kilocode/components/free-model-disclosure")
    expect(FreeModelDisclosure.byok).toBe("BYOK")
    expect(FreeModelDisclosure.label).toBe("May train")
    expect(FreeModelDisclosure.hasByok({ hasUserByokAvailable: true } as unknown as Parameters<typeof FreeModelDisclosure.hasByok>[0])).toBe(true)
    expect(FreeModelDisclosure.collectsData({ mayTrainOnYourPrompts: true } as unknown as Parameters<typeof FreeModelDisclosure.collectsData>[0])).toBe(true)
    const { ModelInfoPanel } = await import("../../src/kilocode/components/model-info-panel")
    expect(ModelInfoPanel).toBeDefined()
    expect(typeof ModelInfoPanel).toBe("function")
  })
})
