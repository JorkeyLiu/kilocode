import { describe, expect, it } from "bun:test"

/**
 * P4.4-T11 bounded settings-surface removal — no synthetic Kilo provider.
 *
 * Scope: webview-ui settings surfaces only. Verifies that the allowed
 * settings files no longer synthesize or specially route Kilo, that
 * provider-tab-helpers suppresses Kilo reconstruction when backend omits it
 * (while generic custom-provider reconstruction remains), and that dead
 * visibility helpers are removed. Out-of-scope constants/guard remain.
 */

describe("P4.4-T11 settings-surface no synthetic Kilo", () => {
  it("provider-visibility module removed — no file and no imports (P4.4-T11 re-audit)", async () => {
    const { existsSync } = await import("node:fs")
    expect(existsSync("webview-ui/src/components/settings/provider-visibility.ts")).toBe(false)
    const tab = await Bun.file("webview-ui/src/components/settings/ProvidersTab.tsx").text()
    expect(tab).not.toContain("provider-visibility")
    const catalog = await Bun.file("webview-ui/src/components/settings/provider-catalog.ts").text()
    expect(catalog).not.toContain("provider-visibility")
    const helpers = await Bun.file("webview-ui/src/components/settings/provider-tab-helpers.ts").text()
    expect(helpers).not.toContain("provider-visibility")
  })

  it("provider-catalog has no Kilo-specific icon/note/kiloFallbackProvider branches", async () => {
    const text = await Bun.file(
      "webview-ui/src/components/settings/provider-catalog.ts",
    ).text()
    expect(text).not.toContain("KILO_PROVIDER_ID")
    expect(text).not.toContain("kiloFallbackProvider")
    expect(text).not.toContain("createKiloFallbackProvider")
    // No Kilo-specific noteKey or icon string.
    expect(text).not.toContain("settings.providers.note.kilo")
    expect(text).not.toContain('validIcon("kilo")')
    // Generic helpers must remain.
    expect(text).toContain("providerIcon")
    expect(text).toContain("providerNoteKey")
    expect(text).toContain("isPopularProvider")
    expect(text).toContain("sortProviders")
  })

  it("ProvidersTab no longer synthesizes Kilo or specially routes gateway/login", async () => {
    const text = await Bun.file(
      "webview-ui/src/components/settings/ProvidersTab.tsx",
    ).text()
    expect(text).not.toContain("providersWithKiloFallback")
    expect(text).not.toContain("KILO_PROVIDER_ID")
    expect(text).not.toContain("settings.providers.tag.gateway")
    expect(text).not.toContain("common.signIn")
    expect(text).not.toContain("server.goToLogin")
    // Re-audit: dead Kilo account/profile path removed
    expect(text).not.toContain('primary() === "account"')
    expect(text).not.toContain("showAccountButton")
    expect(text).not.toContain("server.goToProfile")
    expect(text).not.toContain("isKiloProvider")
    expect(text).not.toContain('from "../../context/server"')
    // Generic custom-provider paths must remain.
    expect(text).toContain("buildAddList")
    expect(text).toContain("buildConfiguredList")
    expect(text).toContain("providerIcon")
    expect(text).toContain("isCustomConfigured")
    expect(text).toContain("CustomProviderDialog")
    expect(text).toContain("ProviderConnectDialog")
  })

  it("ProviderSelectDialog no longer injects Kilo fallback or recommended tag", async () => {
    const text = await Bun.file(
      "webview-ui/src/components/settings/ProviderSelectDialog.tsx",
    ).text()
    expect(text).not.toContain("kiloFallbackProvider")
    expect(text).not.toContain("KILO_PROVIDER_ID")
    expect(text).not.toContain("KILO_GATEWAY")
    expect(text).not.toContain("dialog.provider.tag.recommended")
    expect(text).not.toContain("goToLogin")
    // Custom-provider entry must remain.
    expect(text).toContain("CUSTOM_PROVIDER_ID")
    expect(text).toContain("isPopularProvider")
    expect(text).toContain("CustomProviderDialog")
  })

  it("provider-tab-helpers suppresses synthetic Kilo reconstruction when backend omits it (P4.4-T11)", async () => {
    const text = await Bun.file(
      "webview-ui/src/components/settings/provider-tab-helpers.ts",
    ).text()
    expect(text).toContain("KILO_PROVIDER_ID")
    // Guard: early return for Kilo when backend omits it, before synthetic fallback.
    expect(text).toContain("if (id === KILO_PROVIDER_ID) return undefined")
    // Re-audit: dead Kilo predicate and account slot removed
    expect(text).not.toContain("isKiloProvider")
    expect(text).not.toContain('"account"')
    expect(text).not.toContain("isKilo")
    expect(text).toContain("PrimarySlot")
    expect(text).toContain('"edit"')
    // Generic reconstruction must remain for arbitrary IDs.
    expect(text).toContain('return { id, name: id, models: {} }')
    expect(text).toContain("isCustomProviderPackage")
  })

  it("shared provider-model constants are preserved (out-of-scope, not removed)", async () => {
    const text = await Bun.file("src/shared/provider-model.ts").text()
    expect(text).toContain('KILO_PROVIDER_ID = "kilo"')
    expect(text).toContain("KILO_AUTO")
    expect(text).toContain("PROVIDER_PRIORITY")
    expect(text).toContain("createKiloFallbackProvider")
    expect(text).toContain("settings.providers.note.kilo")
  })

  it("speech-to-text availability still references Kilo (out-of-scope preserved)", async () => {
    const text = await Bun.file(
      "webview-ui/src/components/speech-to-text/availability.ts",
    ).text()
    expect(text).toContain("KILO_PROVIDER_ID")
  })
})
