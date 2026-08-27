import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  createDialogProviderOptions,
  providerOptions,
  type CreateDialogProviderOptionsDeps,
} from "../../src/cli/cmd/tui/component/dialog-provider"
import * as KiloProvider from "../../src/kilocode/cli/cmd/tui/component/dialog-provider"
import { isConsoleManagedProvider } from "../../src/cli/cmd/tui/util/provider-origin"
import { selectProvider } from "../../src/kilocode/anaconda-desktop/tui/setup"
import { createRoot } from "solid-js"
import { RGBA } from "@opentui/core"
import type { ProviderAuthMethod } from "@kilocode/sdk/v2"

// P4.4-T25 source-removal evidence — CLI TUI provider dialog preset display
// residue physically removed (T25-SCOPE P4.4 CLI TUI display-only; T25-BEHAVIOR
// generic name+id ordering, unified Providers category, no preset Popular/
// recommendation/title/description — generic deterministic name+id order; generic
// credential/error guidance retained without stale recommended copy).
// - `packages/opencode/src/kilocode/cli/cmd/tui/component/dialog-provider.tsx`
//   deleted PROVIDER_PRIORITY (kilo/anthropic/github-copilot/openai/google/
//   anaconda-desktop), PROVIDER_DESCRIPTIONS (kilo Recommended, anthropic/openai
//   hints, anaconda-desktop Local models), PROVIDER_TITLES (openai Codex) and
//   Kilo Gateway recommended api description branch — atomic-chat local guidance
//   retained; LOCAL_OPTIONAL_API_KEY/isLocalOptionalApiKey/LOCAL_API_KEY_PLACEHOLDER,
//   renderGutter/failedDescription, renderAutoMethod/apiKeyPlaceholder/selectProvider
//   retained per LOCK-006 (generic provider lifecycle/catalog/auth preserved).
// - `packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx` consumer
//   removed PROVIDER_PRIORITY import/usage, Popular category branching,
//   PROVIDER_DESCRIPTIONS/PROVIDER_TITLES special cases — providerOptions now
//   generic deterministic sortBy name+id (case-insensitive + id tie-break) with
//   constant "Providers" category; createDialogProviderOptions now generic
//   title/description (failedDesc fallback only); failed/disabled-state handling,
//   custom-provider support, consoleManaged, onboarded gutter, selectProvider/
//   renderAutoMethod, local optional api-key placeholder, ModelCache/clear/fence
//   and KiloViewers/AppLayer untouched per T25-SCOPE (display-only, no catalog/transport/storage change).
// Spec anchors: runtime §8.1 row 9 (LOCK-006); tracker §7; matrix row 9; T8/T20.
// This file asserts absence of preset display residue and executable generic ordering;
// it does not claim P4.4/P5 completion.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}
function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4-T25 TUI provider dialog preset removal — kilocode overrides absent, generic preserved", () => {
  test("kilocode dialog-provider has no preset priority/descriptions/titles/Popular/Recommended", () => {
    const src = read("kilocode/cli/cmd/tui/component/dialog-provider.tsx")
    expect(src).not.toContain("PROVIDER_PRIORITY")
    expect(src).not.toContain("PROVIDER_DESCRIPTIONS")
    expect(src).not.toContain("PROVIDER_TITLES")
    expect(src).not.toContain("Popular")
    expect(src).not.toContain("(Recommended)")
    expect(src).not.toContain("Recommended")
    expect(src).not.toContain("Claude Max or API key")
    expect(src).not.toContain("ChatGPT login or API key")
    expect(src).not.toContain("Local models")
    expect(src).not.toContain("OpenAI / Codex")
    expect(src).not.toContain("kilo: -1")
    expect(src).not.toContain('"github-copilot": 1')
    expect(src).not.toContain("anthropic: 0")
    // Kilo Gateway recommended api copy removed (atomic-chat retained)
    expect(src).not.toContain("Kilo Gateway gives you access")
    expect(src).not.toContain("https://kilo.ai/gateway")
    expect(src).not.toContain("cheapest prices")
    // generic local guidance retained
    expect(src).toContain("LOCAL_OPTIONAL_API_KEY")
    expect(src).toContain("isLocalOptionalApiKey")
    expect(src).toContain("LOCAL_API_KEY_PLACEHOLDER")
    expect(src).toContain('atomic-chat')
    expect(src).toContain("Connect to Atomic Chat")
    expect(src).toContain("renderGutter")
    expect(src).toContain("failedDescription")
    expect(src).toContain("renderAutoMethod")
    expect(src).toContain("renderApiDescription")
    expect(src).toContain("apiKeyPlaceholder")
    expect(src).toContain("selectProvider")
    expect(src).toContain("KiloAutoMethod")
  })

  test("kilocode dialog-provider preserves generic provider/auth helpers", () => {
    const src = read("kilocode/cli/cmd/tui/component/dialog-provider.tsx")
    expect(src).toContain("export function renderGutter")
    expect(src).toContain("export function failedDescription")
    expect(src).toContain("export const LOCAL_OPTIONAL_API_KEY")
    expect(src).toContain("export function isLocalOptionalApiKey")
    expect(src).toContain("export const LOCAL_API_KEY_PLACEHOLDER")
    expect(src).toContain("export function renderAutoMethod")
    expect(src).toContain("export function renderApiDescription")
    expect(src).toContain("export function apiKeyPlaceholder")
    expect(src).toContain('export { selectProvider }')
    expect(src).toContain("connection error")
    expect(src).toContain("Optional for localhost")
  })

  test("consumer dialog-provider has no preset priority/Popular/description/title branches", () => {
    const src = read("cli/cmd/tui/component/dialog-provider.tsx")
    expect(src).not.toContain("PROVIDER_PRIORITY")
    expect(src).not.toContain("PROVIDER_DESCRIPTIONS")
    expect(src).not.toContain("PROVIDER_TITLES")
    expect(src).not.toContain("Popular")
    expect(src).not.toContain("(Recommended)")
    expect(src).not.toContain("Recommended")
    expect(src).not.toContain("Claude Max")
    expect(src).not.toContain("ChatGPT login")
    expect(src).not.toContain("OpenAI / Codex")
    expect(src).not.toContain('provider.id in PROVIDER_PRIORITY')
    expect(src).not.toContain("priority")
    expect(src).not.toContain("PROVIDER_PRIORITY[x.id]")
    expect(src).not.toContain("baseDesc")
    expect(src).not.toContain("PROVIDER_DESCRIPTIONS[")
    expect(src).not.toContain("PROVIDER_TITLES[")
    // deterministic generic ordering present
    expect(src).toContain("sortBy((x) => x.name.toLowerCase()")
    expect(src).toContain("Providers")
    expect(src).not.toContain('"Popular"')
    // title/description now generic
    expect(src).toContain("title: provider.title")
    expect(src).toContain("description: failedDesc ?? provider.description")
    expect(src).not.toContain("KiloProvider.PROVIDER_TITLES")
    expect(src).not.toContain("KiloProvider.PROVIDER_DESCRIPTIONS")
  })

  test("consumer retains generic provider/auth/error/custom behavior", () => {
    const src = read("cli/cmd/tui/component/dialog-provider.tsx")
    expect(src).toContain("isConsoleManagedProvider")
    expect(src).toContain("sync.data.provider_next.failed")
    expect(src).toContain("KiloProvider.renderGutter")
    expect(src).toContain("KiloProvider.failedDescription")
    expect(src).toContain("KiloProvider.selectProvider")
    expect(src).toContain("KiloProvider.renderAutoMethod")
    expect(src).toContain("KiloProvider.renderApiDescription")
    expect(src).toContain("KiloProvider.isLocalOptionalApiKey")
    expect(src).toContain("KiloProvider.apiKeyPlaceholder")
    expect(src).toContain("KiloProvider.LOCAL_API_KEY_PLACEHOLDER")
    expect(src).toContain("CUSTOM_PROVIDER_OPTION_VALUE")
    expect(src).toContain("CUSTOM_PROVIDER_ID")
    expect(src).toContain("normalizeCustomProviderID")
    expect(src).toContain("Other")
    expect(src).toContain("Custom provider")
    expect(src).toContain("provider_next.all")
    expect(src).toContain("provider_next.connected")
    expect(src).toContain("connected && onboarded()")
    expect(src).toContain("footer: consoleManaged")
    expect(src).toContain("gutter:")
    expect(src).toContain("DialogProvider")
    expect(src).toContain("Connect a provider")
  })

  test("no production opencode source references deleted TUI preset symbols", () => {
    let combined = ""
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue
          walk(full)
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          combined += readFileSync(full, "utf8") + "\n"
        }
      }
    }
    walk(opencode)
    // preset TUI symbols must be absent everywhere
    expect(combined).not.toContain("PROVIDER_DESCRIPTIONS")
    expect(combined).not.toContain("PROVIDER_TITLES")
    // PROVIDER_PRIORITY may still exist in unrelated contexts? Forbid in TUI/dialog-provider context
    // but allow generic providerOptions variable names — check that kilocode dialog-provider file is clean (already proven)
    // and consumer does not contain PROVIDER_PRIORITY
    const consumer = read("cli/cmd/tui/component/dialog-provider.tsx")
    expect(consumer).not.toContain("PROVIDER_PRIORITY")
    const kilo = read("kilocode/cli/cmd/tui/component/dialog-provider.tsx")
    expect(kilo).not.toContain("PROVIDER_PRIORITY")
  })

  test("test-profile lists new TUI dialog regression in sorted order", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).toContain("p4-4-tui-provider-dialog-preset-removal")
    expect(profile).toContain("p4-4-bundled-provider-loader-removal")
    expect(profile).toContain("p4-4-flag-legacy-getter-removal")
    expect(profile).toContain("p4-4-managed-removal")
    const bundledIdx = profile.indexOf("p4-4-bundled-provider-loader-removal")
    const dialogIdx = profile.indexOf("p4-4-tui-provider-dialog-preset-removal")
    const tuiMigrateIdx = profile.indexOf("p4-4-tui-migrate-kilo-config-removal")
    expect(bundledIdx).toBeGreaterThan(-1)
    expect(dialogIdx).toBeGreaterThan(-1)
    expect(tuiMigrateIdx).toBeGreaterThan(-1)
    // alphabetical order: bundled < flag < managed < model-cache < presence < primary < provider-login < provider < sdk < t16 < t18 < tui-migrate < tui-provider-dialog < wellknown
    // dialog should be after tui-migrate and before wellknown
    const wellknownIdx = profile.indexOf("p4-4-wellknown-provider-auth-removal")
    expect(dialogIdx).toBeGreaterThan(tuiMigrateIdx)
    expect(dialogIdx).toBeLessThan(wellknownIdx)
  })
})

describe("P4.4-T25 TUI provider dialog — executable generic deterministic ordering", () => {
  test("providerOptions orders by display name case-insensitive then id tie-break", () => {
    const list = [
      { id: "openai", name: "OpenAI" },
      { id: "anthropic", name: "anthropic" },
      { id: "google", name: "Google" },
      { id: "kilo", name: "Kilo" },
    ]
    const opts = providerOptions(list)
    // case-insensitive alphabetical: anthropic, Google, Kilo, OpenAI
    expect(opts.slice(0, 4).map((o) => o.value)).toEqual(["anthropic", "google", "kilo", "openai"])
    expect(opts.slice(0, 4).map((o) => o.title)).toEqual(["anthropic", "Google", "Kilo", "OpenAI"])
    for (const o of opts.slice(0, 4)) {
      expect(o.category).toBe("Providers")
      expect(o.description).toBeUndefined()
    }
    expect(opts.at(-1)?.value).toBe("__opencode_custom_provider__")
    // kilo is not first — no preset priority
    expect(opts[0].value).not.toBe("kilo")
  })

  test("providerOptions tie-break by id when names collide case-insensitively", () => {
    const list = [
      { id: "b", name: "Same" },
      { id: "a", name: "same" },
      { id: "c", name: "Alpha" },
    ]
    const opts = providerOptions(list)
    expect(opts[0].value).toBe("c")
    expect(opts[1].value).toBe("a")
    expect(opts[2].value).toBe("b")
    expect(opts[1].title).toBe("same")
    expect(opts[2].title).toBe("Same")
  })

  test("providerOptions custom provider appended and does not interfere with ordering", () => {
    const list = [
      { id: "zebra", name: "Zebra" },
      { id: "alpha", name: "Alpha" },
    ]
    const opts = providerOptions(list)
    expect(opts.map((o) => o.value)).toEqual(["alpha", "zebra", "__opencode_custom_provider__"])
    expect(opts.at(-1)?.title).toBe("Other")
    expect(opts.at(-1)?.description).toBe("Custom provider")
    expect(opts.at(-1)?.category).toBe("Providers")
  })

  test("providerOptions category never Popular, always Providers", () => {
    const list = [
      { id: "kilo", name: "Kilo" },
      { id: "anthropic", name: "Anthropic" },
      { id: "github-copilot", name: "GitHub Copilot" },
      { id: "openai", name: "OpenAI" },
      { id: "google", name: "Google" },
      { id: "anaconda-desktop", name: "Anaconda" },
    ]
    const opts = providerOptions(list)
    for (const o of opts) expect(o.category).toBe("Providers")
    expect(opts.map((o) => o.value).slice(0, -1)).toEqual(
      ["anaconda-desktop", "anthropic", "github-copilot", "google", "kilo", "openai"].sort((a, b) => {
        const nameA = list.find((x) => x.id === a)!.name.toLowerCase()
        const nameB = list.find((x) => x.id === b)!.name.toLowerCase()
        return nameA.localeCompare(nameB) || a.localeCompare(b)
      }),
    )
  })
})

describe("P4.4-T25 TUI provider dialog — factory integration via createDialogProviderOptions (actual mappings)", () => {
  const fakeTheme = {
    error: RGBA.fromHex("#ff0000"),
    textMuted: RGBA.fromHex("#999999"),
    text: RGBA.fromHex("#ffffff"),
    primary: RGBA.fromHex("#0000ff"),
    success: RGBA.fromHex("#00ff00"),
    background: RGBA.fromHex("#000000"),
    backgroundPanel: RGBA.fromHex("#000000"),
    backgroundElement: RGBA.fromHex("#000000"),
    backgroundMenu: RGBA.fromHex("#000000"),
    border: RGBA.fromHex("#000000"),
    borderSubtle: RGBA.fromHex("#000000"),
    borderActive: RGBA.fromHex("#000000"),
    info: RGBA.fromHex("#000000"),
    warning: RGBA.fromHex("#000000"),
    accent: RGBA.fromHex("#000000"),
    secondary: RGBA.fromHex("#000000"),
    selectedListItemText: RGBA.fromHex("#000000"),
    diffAdded: RGBA.fromHex("#000000"),
    diffRemoved: RGBA.fromHex("#000000"),
    diffContext: RGBA.fromHex("#000000"),
    diffHunkHeader: RGBA.fromHex("#000000"),
    diffHighlightAdded: RGBA.fromHex("#000000"),
    diffHighlightRemoved: RGBA.fromHex("#000000"),
    diffAddedBg: RGBA.fromHex("#000000"),
    diffRemovedBg: RGBA.fromHex("#000000"),
    diffContextBg: RGBA.fromHex("#000000"),
    diffLineNumber: RGBA.fromHex("#000000"),
    diffAddedLineNumberBg: RGBA.fromHex("#000000"),
    diffRemovedLineNumberBg: RGBA.fromHex("#000000"),
    markdownText: RGBA.fromHex("#000000"),
    markdownHeading: RGBA.fromHex("#000000"),
    markdownLink: RGBA.fromHex("#000000"),
    markdownLinkText: RGBA.fromHex("#000000"),
    markdownCode: RGBA.fromHex("#000000"),
    markdownBlockQuote: RGBA.fromHex("#000000"),
    markdownEmph: RGBA.fromHex("#000000"),
    markdownStrong: RGBA.fromHex("#000000"),
    markdownHorizontalRule: RGBA.fromHex("#000000"),
    markdownListItem: RGBA.fromHex("#000000"),
    markdownListEnumeration: RGBA.fromHex("#000000"),
    markdownImage: RGBA.fromHex("#000000"),
    markdownImageText: RGBA.fromHex("#000000"),
    markdownCodeBlock: RGBA.fromHex("#000000"),
    syntaxComment: RGBA.fromHex("#000000"),
    syntaxKeyword: RGBA.fromHex("#000000"),
    syntaxFunction: RGBA.fromHex("#000000"),
    syntaxVariable: RGBA.fromHex("#000000"),
    syntaxString: RGBA.fromHex("#000000"),
    syntaxNumber: RGBA.fromHex("#000000"),
    syntaxType: RGBA.fromHex("#000000"),
    syntaxOperator: RGBA.fromHex("#000000"),
    syntaxPunctuation: RGBA.fromHex("#000000"),
    thinkingOpacity: 0.6,
    _hasSelectedListItemText: true,
  } as unknown as CreateDialogProviderOptionsDeps["theme"]

  test("factory maps failed-state description and gutter via KiloProvider helpers", async () => {
    const fakes: CreateDialogProviderOptionsDeps = {
      sync: {
        data: {
          provider_next: {
            all: [
              { id: "openai", name: "OpenAI" },
              { id: "anthropic", name: "Anthropic" },
            ],
            connected: [],
            failed: ["openai"],
            default: {},
          },
          console_state: { consoleManagedProviders: [] as string[], activeOrgName: undefined },
          provider_auth: {} as Record<string, ProviderAuthMethod[]>,
        },
      } as unknown as CreateDialogProviderOptionsDeps["sync"],
      dialog: {
        replace: (() => {}) as unknown as CreateDialogProviderOptionsDeps["dialog"] extends { replace: infer R } ? R : never,
        clear: (() => {}) as unknown as CreateDialogProviderOptionsDeps["dialog"] extends { clear: infer R } ? R : never,
        stack: [],
        size: "medium",
        setSize: (() => {}) as unknown as CreateDialogProviderOptionsDeps["dialog"] extends { setSize: infer R } ? R : never,
      } as CreateDialogProviderOptionsDeps["dialog"],
      sdk: {
        client: {
          provider: {
            oauth: {
              authorize: async () => ({ data: { method: "code", url: "https://example.com", instructions: "code" }, error: undefined } as unknown as Awaited<ReturnType<NonNullable<NonNullable<CreateDialogProviderOptionsDeps["sdk"]>["client"]>["provider"]["oauth"]["authorize"]>>),
            },
          },
        },
      } as unknown as CreateDialogProviderOptionsDeps["sdk"],
      toast: { show: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["toast"]>["show"] } as CreateDialogProviderOptionsDeps["toast"],
      theme: fakeTheme,
      onboarded: (() => false) as unknown as CreateDialogProviderOptionsDeps["onboarded"],
    }
    const opts = await createRoot((dispose) => {
      const get = createDialogProviderOptions(fakes as unknown as CreateDialogProviderOptionsDeps)
      const v = get()
      dispose()
      return v
    })
    const openai = opts.find((o) => o.value === "openai")!
    const anthropic = opts.find((o) => o.value === "anthropic")!
    expect(openai.description).toBe("(connection error — click to reconnect)")
    expect(openai.description).not.toContain("Recommended")
    expect(anthropic.description).toBeUndefined()
    expect(openai.gutter).toBeDefined()
    expect(typeof openai.gutter).toBe("function")
    expect(anthropic.gutter).toBeUndefined()
    // failed takes precedence over connected — also verify via helper directly for sanity
    expect(KiloProvider.failedDescription("openai", ["openai"])).toBe("(connection error — click to reconnect)")
    expect(KiloProvider.renderGutter("openai", ["openai"], fakeTheme!)).toBeDefined()
  })

  test("factory maps connected + onboarded gutter fallback when not failed", async () => {
    const mk = async (connected: string[], onboarded: boolean, failed: string[] = []) => {
      const fakes = {
        sync: {
          data: {
            provider_next: { all: [{ id: "openai", name: "OpenAI" }], connected, failed },
            console_state: { consoleManagedProviders: [] as string[], activeOrgName: undefined },
            provider_auth: {} as Record<string, ProviderAuthMethod[]>,
          },
        } as unknown as CreateDialogProviderOptionsDeps["sync"],
        dialog: { replace: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["replace"], clear: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["clear"], stack: [], size: "medium", setSize: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["setSize"] } as CreateDialogProviderOptionsDeps["dialog"],
        sdk: { client: { provider: { oauth: { authorize: async () => ({ data: undefined, error: undefined } as unknown as Awaited<ReturnType<NonNullable<NonNullable<CreateDialogProviderOptionsDeps["sdk"]>["client"]>["provider"]["oauth"]["authorize"]>>) } } } } as unknown as CreateDialogProviderOptionsDeps["sdk"],
        toast: { show: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["toast"]>["show"] } as CreateDialogProviderOptionsDeps["toast"],
        theme: fakeTheme,
        onboarded: (() => onboarded) as unknown as CreateDialogProviderOptionsDeps["onboarded"],
      }
      const opts = await createRoot((dispose) => {
        const get = createDialogProviderOptions(fakes as unknown as CreateDialogProviderOptionsDeps)
        const v = get()
        dispose()
        return v
      })
      return opts.find((o) => o.value === "openai")!
    }
    const failedGutter = await mk(["openai"], true, ["openai"])
    expect(failedGutter.gutter).toBeDefined() // failed present -> gutter is failed indicator, not connected check
    const connectedGutter = await mk(["openai"], true, [])
    expect(connectedGutter.gutter).toBeDefined() // connected && onboarded -> success gutter
    const notOnboarded = await mk(["openai"], false, [])
    expect(notOnboarded.gutter).toBeUndefined()
    const notConnected = await mk([], true, [])
    expect(notConnected.gutter).toBeUndefined()
  })

  test("factory maps console-managed footer and selection guard via actual onSelect", async () => {
    const orgName = "acme"
    const replaceCalls: Array<() => unknown> = []
    const fakes = {
      sync: {
        data: {
          provider_next: { all: [{ id: "openai", name: "OpenAI" }, { id: "anthropic", name: "Anthropic" }], connected: [], failed: [] },
          console_state: { consoleManagedProviders: ["openai"] as string[], activeOrgName: orgName },
          provider_auth: {} as Record<string, ProviderAuthMethod[]>,
        },
      } as unknown,
      dialog: { replace: ((fn: unknown) => replaceCalls.push(fn as () => unknown)) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["replace"], clear: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["clear"], stack: [], size: "medium", setSize: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["setSize"] } as CreateDialogProviderOptionsDeps["dialog"],
      sdk: { client: { provider: { oauth: { authorize: async () => ({ data: undefined, error: undefined } as unknown as Awaited<ReturnType<NonNullable<NonNullable<CreateDialogProviderOptionsDeps["sdk"]>["client"]>["provider"]["oauth"]["authorize"]>>) } } } } as unknown as CreateDialogProviderOptionsDeps["sdk"],
      toast: { show: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["toast"]>["show"] } as CreateDialogProviderOptionsDeps["toast"],
      theme: fakeTheme,
      onboarded: (() => true) as unknown as CreateDialogProviderOptionsDeps["onboarded"],
    }
    const opts = await createRoot((dispose) => {
      const get = createDialogProviderOptions(fakes as unknown as CreateDialogProviderOptionsDeps)
      const v = get()
      dispose()
      return v
    })
    const openai = opts.find((o) => o.value === "openai")!
    const anthropic = opts.find((o) => o.value === "anthropic")!
    expect(openai.footer).toBe(orgName)
    expect(anthropic.footer).toBeUndefined()
    // onSelect for console-managed must early-return without dispatch
    replaceCalls.length = 0
    await (openai as unknown as { onSelect: () => Promise<void> }).onSelect()
    expect(replaceCalls.length).toBe(0)
    // non-managed still has onSelect dispatch (will go to api path)
    replaceCalls.length = 0
    await (anthropic as unknown as { onSelect: () => Promise<void> }).onSelect()
    expect(replaceCalls.length).toBe(1)
    // helper sanity
    expect(isConsoleManagedProvider(["openai"], "openai")).toBe(true)
    expect(isConsoleManagedProvider(["openai"], "anthropic")).toBe(false)
  })

  test("factory maps custom-provider option and its onSelect via injected prompt", async () => {
    const replaceCalls: Array<() => unknown> = []
    let promptValue: string | undefined = "my-custom"
    const fakes = {
      sync: {
        data: {
          provider_next: { all: [{ id: "openai", name: "OpenAI" }], connected: [], failed: [] },
          console_state: { consoleManagedProviders: [] as string[], activeOrgName: undefined },
          provider_auth: {} as Record<string, ProviderAuthMethod[]>,
        },
      } as unknown,
      dialog: { replace: ((fn: unknown) => replaceCalls.push(fn as () => unknown)) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["replace"], clear: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["clear"], stack: [], size: "medium", setSize: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["setSize"] } as CreateDialogProviderOptionsDeps["dialog"],
      sdk: { client: { provider: { oauth: { authorize: async () => ({ data: undefined, error: undefined } as unknown as Awaited<ReturnType<NonNullable<NonNullable<CreateDialogProviderOptionsDeps["sdk"]>["client"]>["provider"]["oauth"]["authorize"]>>) } } } } as unknown as CreateDialogProviderOptionsDeps["sdk"],
      toast: { show: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["toast"]>["show"] } as CreateDialogProviderOptionsDeps["toast"],
      theme: fakeTheme,
      onboarded: (() => false) as unknown as CreateDialogProviderOptionsDeps["onboarded"],
      promptCustomProviderID: async () => promptValue,
    }
    const opts = await createRoot((dispose) => {
      const get = createDialogProviderOptions(fakes as unknown as CreateDialogProviderOptionsDeps)
      const v = get()
      dispose()
      return v
    })
    const custom = opts.find((o) => o.value === "__opencode_custom_provider__")!
    expect(custom.title).toBe("Other")
    expect(custom.description).toBe("Custom provider")
    expect(custom.category).toBe("Providers")
    expect(typeof (custom as unknown as { onSelect: unknown }).onSelect).toBe("function")
    replaceCalls.length = 0
    await (custom as unknown as { onSelect: () => Promise<void> }).onSelect()
    expect(replaceCalls.length).toBe(1)
    // prompt returning undefined must not dispatch
    promptValue = undefined
    const opts2 = await createRoot((dispose) => {
      const get = createDialogProviderOptions(fakes as unknown as CreateDialogProviderOptionsDeps)
      const v = get()
      dispose()
      return v
    })
    const custom2 = opts2.find((o) => o.value === "__opencode_custom_provider__")!
    replaceCalls.length = 0
    await (custom2 as unknown as { onSelect: () => Promise<void> }).onSelect()
    expect(replaceCalls.length).toBe(0)
    // still validates generic helpers via factory path
    expect(KiloProvider.isLocalOptionalApiKey("atomic-chat")).toBe(true)
    expect(selectProvider({ providerID: "anaconda-desktop", replace: () => {}, model: (() => null) as unknown as Parameters<typeof selectProvider>[0]["model"] })).toBe(true)
    expect(selectProvider({ providerID: "openai", replace: () => {}, model: (() => null) as unknown as Parameters<typeof selectProvider>[0]["model"] })).toBe(false)
  })

  test("factory maps API onSelect to dialog.replace with ApiMethod", async () => {
    const replaceCalls: Array<() => unknown> = []
    const fakes = {
      sync: {
        data: {
          provider_next: { all: [{ id: "openai", name: "OpenAI" }], connected: [], failed: [] },
          console_state: { consoleManagedProviders: [] as string[], activeOrgName: undefined },
          provider_auth: { openai: [{ type: "api", label: "API key" }] } as Record<string, ProviderAuthMethod[]>,
        },
      } as unknown,
      dialog: { replace: ((fn: unknown) => replaceCalls.push(fn as () => unknown)) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["replace"], clear: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["clear"], stack: [], size: "medium", setSize: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["setSize"] } as CreateDialogProviderOptionsDeps["dialog"],
      sdk: { client: { provider: { oauth: { authorize: async () => ({ data: undefined, error: undefined } as unknown as Awaited<ReturnType<NonNullable<NonNullable<CreateDialogProviderOptionsDeps["sdk"]>["client"]>["provider"]["oauth"]["authorize"]>>) } } } } as unknown as CreateDialogProviderOptionsDeps["sdk"],
      toast: { show: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["toast"]>["show"] } as CreateDialogProviderOptionsDeps["toast"],
      theme: fakeTheme,
      onboarded: (() => false) as unknown as CreateDialogProviderOptionsDeps["onboarded"],
    }
    const opts = await createRoot((dispose) => {
      const get = createDialogProviderOptions(fakes as unknown as CreateDialogProviderOptionsDeps)
      const v = get()
      dispose()
      return v
    })
    const openai = opts.find((o) => o.value === "openai")!
    expect(typeof (openai as unknown as { onSelect: unknown }).onSelect).toBe("function")
    replaceCalls.length = 0
    await (openai as unknown as { onSelect: () => Promise<void> }).onSelect()
    expect(replaceCalls.length).toBe(1)
    // placeholder still via helper
    expect(KiloProvider.apiKeyPlaceholder("openai")).toBe("API key")
    expect(KiloProvider.apiKeyPlaceholder("atomic-chat")).toBe("Optional for localhost")
  })

  test("factory maps OAuth onSelect to authorize and dialog dispatch (code and auto)", async () => {
    const authorizeCalls: Array<Record<string, unknown>> = []
    const replaceCalls: Array<() => unknown> = []
    const clearCalls: number[] = []
    const toastCalls: unknown[] = []
    let authorizeResult: Awaited<ReturnType<NonNullable<NonNullable<CreateDialogProviderOptionsDeps["sdk"]>["client"]>["provider"]["oauth"]["authorize"]>> = { data: { method: "code", url: "https://example.com", instructions: "enter code" }, error: undefined } as unknown as Awaited<ReturnType<NonNullable<NonNullable<CreateDialogProviderOptionsDeps["sdk"]>["client"]>["provider"]["oauth"]["authorize"]>>
    const fakes = {
      sync: {
        data: {
          provider_next: { all: [{ id: "google", name: "Google" }], connected: [], failed: [] },
          console_state: { consoleManagedProviders: [] as string[], activeOrgName: undefined },
          provider_auth: { google: [{ type: "oauth", label: "OAuth" }] } as Record<string, ProviderAuthMethod[]>,
        },
      } as unknown,
      dialog: {
        replace: ((fn: unknown) => replaceCalls.push(fn as () => unknown)) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["replace"],
        clear: (() => clearCalls.push(1)) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["clear"],
      },
      sdk: {
        client: {
          provider: {
            oauth: {
              authorize: async (args: unknown) => {
                authorizeCalls.push(args as Record<string, unknown>)
                return authorizeResult
              },
              callback: async () => ({ error: undefined }),
            },
          },
          auth: { set: async () => ({}) },
          instance: { dispose: async () => {} },
        },
      } as unknown,
      toast: { show: ((opts: unknown) => toastCalls.push(opts)) as unknown as NonNullable<CreateDialogProviderOptionsDeps["toast"]>["show"] } as CreateDialogProviderOptionsDeps["toast"],
      theme: fakeTheme,
      onboarded: (() => false) as unknown as CreateDialogProviderOptionsDeps["onboarded"],
    }
    const opts = await createRoot((dispose) => {
      const get = createDialogProviderOptions(fakes as unknown as CreateDialogProviderOptionsDeps)
      const v = get()
      dispose()
      return v
    })
    const google = opts.find((o) => o.value === "google")!
    await (google as unknown as { onSelect: () => Promise<void> }).onSelect()
    expect(authorizeCalls.length).toBe(1)
    expect(authorizeCalls[0]).toMatchObject({ providerID: "google", method: 0 })
    expect(replaceCalls.length).toBe(1) // code method -> CodeMethod
    // auto method via KiloProvider.renderAutoMethod for kilo
    authorizeCalls.length = 0
    replaceCalls.length = 0
    authorizeResult = { data: { method: "auto", url: "https://auth.example", instructions: "auto" }, error: undefined } as unknown as typeof authorizeResult
    const kiloFakes = {
      sync: { data: { provider_next: { all: [{ id: "kilo", name: "Kilo" }], connected: [], failed: [], default: {} }, console_state: { consoleManagedProviders: [] as string[], activeOrgName: undefined }, provider_auth: { kilo: [{ type: "oauth", label: "Kilo OAuth" }] } as Record<string, ProviderAuthMethod[]>, }, } as unknown as CreateDialogProviderOptionsDeps["sync"],
      dialog: { replace: ((fn: unknown) => replaceCalls.push(fn as () => unknown)) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["replace"], clear: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["clear"], stack: [], size: "medium", setSize: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["setSize"] } as CreateDialogProviderOptionsDeps["dialog"],
      sdk: {
        client: {
          provider: {
            oauth: {
              authorize: async (args: unknown) => {
                authorizeCalls.push(args as Record<string, unknown>)
                return authorizeResult
              },
            },
          },
          auth: { set: async () => ({}) },
          instance: { dispose: async () => {} },
        },
      } as unknown as CreateDialogProviderOptionsDeps["sdk"],
      toast: { show: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["toast"]>["show"] } as CreateDialogProviderOptionsDeps["toast"],
      theme: fakeTheme,
      onboarded: (() => false) as unknown as CreateDialogProviderOptionsDeps["onboarded"],
    }
    const kiloOpts = await createRoot((dispose) => {
      const get = createDialogProviderOptions(kiloFakes as unknown as CreateDialogProviderOptionsDeps)
      const v = get()
      dispose()
      return v
    })
    const kilo = kiloOpts.find((o) => o.value === "kilo")!
    authorizeCalls.length = 0
    replaceCalls.length = 0
    await (kilo as unknown as { onSelect: () => Promise<void> }).onSelect()
    expect(authorizeCalls.length).toBe(1)
    expect(replaceCalls.length).toBe(1) // auto -> KiloAutoMethod
    expect(KiloProvider.renderAutoMethod({ providerID: "kilo", title: "Kilo", index: 0, authorization: { url: "https://example.com", instructions: "x" } as unknown as Parameters<typeof KiloProvider.renderAutoMethod>[0]["authorization"], useSDK: (() => null) as unknown as Parameters<typeof KiloProvider.renderAutoMethod>[0]["useSDK"], useTheme: (() => null) as unknown as Parameters<typeof KiloProvider.renderAutoMethod>[0]["useTheme"], DialogModel: null as unknown as Parameters<typeof KiloProvider.renderAutoMethod>[0]["DialogModel"] })).toBeDefined()
    expect(KiloProvider.renderAutoMethod({ providerID: "google", title: "Google", index: 0, authorization: { url: "https://example.com", instructions: "x" } as unknown as Parameters<typeof KiloProvider.renderAutoMethod>[0]["authorization"], useSDK: (() => null) as unknown as Parameters<typeof KiloProvider.renderAutoMethod>[0]["useSDK"], useTheme: (() => null) as unknown as Parameters<typeof KiloProvider.renderAutoMethod>[0]["useTheme"], DialogModel: null as unknown as Parameters<typeof KiloProvider.renderAutoMethod>[0]["DialogModel"] })).toBeUndefined()
    // error path
    authorizeResult = { error: { message: "fail", _tag: "ProviderAuthError" } as unknown as never, data: undefined } as unknown as typeof authorizeResult
    const errFakes = {
      sync: {
        data: {
          provider_next: { all: [{ id: "google", name: "Google" }], connected: [], failed: [] },
          console_state: { consoleManagedProviders: [] as string[], activeOrgName: undefined },
          provider_auth: { google: [{ type: "oauth", label: "OAuth" }] } as Record<string, ProviderAuthMethod[]>,
        },
      } as unknown as CreateDialogProviderOptionsDeps["sync"],
      dialog: { replace: ((fn: unknown) => replaceCalls.push(fn as () => unknown)) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["replace"], clear: (() => clearCalls.push(1)) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["clear"], stack: [], size: "medium", setSize: (() => {}) as unknown as NonNullable<CreateDialogProviderOptionsDeps["dialog"]>["setSize"] } as CreateDialogProviderOptionsDeps["dialog"],
      sdk: {
        client: {
          provider: {
            oauth: { authorize: async () => authorizeResult },
          },
          auth: { set: async () => ({}) },
          instance: { dispose: async () => {} },
        },
      } as unknown,
      toast: { show: ((opts: unknown) => toastCalls.push(opts)) as unknown as NonNullable<CreateDialogProviderOptionsDeps["toast"]>["show"] } as CreateDialogProviderOptionsDeps["toast"],
      theme: fakeTheme,
      onboarded: (() => false) as unknown as CreateDialogProviderOptionsDeps["onboarded"],
    }
    const errOpts = await createRoot((dispose) => {
      const get = createDialogProviderOptions(errFakes as unknown as CreateDialogProviderOptionsDeps)
      const v = get()
      dispose()
      return v
    })
    const googleErr = errOpts.find((o) => o.value === "google")!
    toastCalls.length = 0
    clearCalls.length = 0
    await (googleErr as unknown as { onSelect: () => Promise<void> }).onSelect()
    expect(toastCalls.length).toBe(1)
    expect(clearCalls.length).toBe(1)
  })

  test("generic placeholder and description helpers preserved", () => {
    expect(KiloProvider.apiKeyPlaceholder("openai")).toBe("API key")
    expect(KiloProvider.LOCAL_API_KEY_PLACEHOLDER).toBe("local")
    expect(KiloProvider.renderApiDescription("atomic-chat", fakeTheme!)).toBeDefined()
    expect(KiloProvider.renderApiDescription("openai", fakeTheme!)).toBeUndefined()
  })
})
