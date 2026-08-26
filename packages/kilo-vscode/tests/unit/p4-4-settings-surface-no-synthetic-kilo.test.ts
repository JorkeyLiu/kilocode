import { describe, expect, it } from "bun:test"

/**
 * P4.4-T12 dead factory/i18n residue removal — no synthetic Kilo provider factory or orphaned locale keys.
 *
 * Scope: deletes the unreachable synthetic Kilo provider factory from shared/provider-model.ts
 * and its orphaned i18n residues (settings.providers.tag.gateway, dialog.provider.tag.recommended,
 * settings.providers.note.kilo) after the T10/T11 settings-surface cleanup. Verifies factory and
 * synthetic literals are absent while retained provider/session/transport invariants remain.
 *
 * Preserved: KILO_PROVIDER_ID, KILO_AUTO, PROVIDER_PRIORITY, speech-to-text Kilo guard,
 * session-model KILO_AUTO fallback, generic custom-provider UI, HTTP/SSE bridge (out of scope).
 */

describe("P4.4-T12 dead factory/i18n residue removal — no synthetic Kilo", () => {
  it("provider-visibility module removed — no file and no imports (P4.4-T11 re-audit, retained for T12)", async () => {
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
    expect(text).not.toContain("settings.providers.note.kilo")
    expect(text).not.toContain('validIcon("kilo")')
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
    expect(text).not.toContain('primary() === "account"')
    expect(text).not.toContain("showAccountButton")
    expect(text).not.toContain("server.goToProfile")
    expect(text).not.toContain("isKiloProvider")
    expect(text).not.toContain('from "../../context/server"')
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
    expect(text).toContain("CUSTOM_PROVIDER_ID")
    expect(text).toContain("isPopularProvider")
    expect(text).toContain("CustomProviderDialog")
  })

  it("provider-tab-helpers suppresses synthetic Kilo reconstruction when backend omits it (P4.4-T11)", async () => {
    const text = await Bun.file(
      "webview-ui/src/components/settings/provider-tab-helpers.ts",
    ).text()
    expect(text).toContain("KILO_PROVIDER_ID")
    expect(text).toContain("if (id === KILO_PROVIDER_ID) return undefined")
    expect(text).not.toContain("isKiloProvider")
    expect(text).not.toContain('"account"')
    expect(text).not.toContain("isKilo")
    expect(text).toContain("PrimarySlot")
    expect(text).toContain('"edit"')
    expect(text).toContain('return { id, name: id, models: {} }')
    expect(text).toContain("isCustomProviderPackage")
  })

  it("shared provider-model dead factory and synthetic Kilo metadata literals are absent (P4.4-T12)", async () => {
    const text = await Bun.file("src/shared/provider-model.ts").text()
    expect(text).not.toContain("createKiloFallbackProvider")
    expect(text).not.toContain("Kilo Gateway")
    expect(text).not.toContain("settings.providers.note.kilo")
    // Factory's internal Kilo icon literal (metadata.icon = KILO_PROVIDER_ID) is gone with the factory;
    // the provider-model must no longer synthesize a Kilo provider object.
    expect(text).not.toContain("noteKey")
    expect(text).not.toContain('source: "custom"')
  })

  it("shared provider-model retained constants and session/speech fallback surfaces are preserved (T12)", async () => {
    const text = await Bun.file("src/shared/provider-model.ts").text()
    expect(text).toContain('KILO_PROVIDER_ID = "kilo"')
    expect(text).toContain("KILO_AUTO")
    expect(text).toContain("PROVIDER_PRIORITY")
    expect(text).toContain("KILO_PROVIDER_ID,")
    // Protect: no import/type made unused beyond the deleted factory — file still exports priority/order helpers.
    expect(text).toContain("providerOrderIndex")
    expect(text).toContain("CUSTOM_PROVIDER_PACKAGES")
    const speech = await Bun.file(
      "webview-ui/src/components/speech-to-text/availability.ts",
    ).text()
    expect(speech).toContain("KILO_PROVIDER_ID")
    const session = await Bun.file("webview-ui/src/context/session.tsx").text()
    expect(session).toContain("KILO_AUTO")
    expect(session).toContain("KILO_PROVIDER_ID")
  })

  it("orphaned locale keys are absent from every dictionary (P4.4-T12)", async () => {
    const { readdirSync } = await import("node:fs")
    const webviewLocales = readdirSync("webview-ui/src/i18n").filter((f) => f.endsWith(".ts"))
    expect(webviewLocales.length).toBeGreaterThan(0)
    for (const file of webviewLocales) {
      const text = await Bun.file(`webview-ui/src/i18n/${file}`).text()
      expect(text).not.toContain("settings.providers.tag.gateway")
      expect(text).not.toContain("dialog.provider.tag.recommended")
      expect(text).not.toContain("settings.providers.note.kilo")
    }
    const kiloLocales = readdirSync("../kilo-i18n/src").filter((f) => f.endsWith(".ts"))
    expect(kiloLocales.length).toBeGreaterThan(0)
    for (const file of kiloLocales) {
      const text = await Bun.file(`../kilo-i18n/src/${file}`).text()
      expect(text).not.toContain("settings.providers.note.kilo")
      expect(text).not.toContain("settings.providers.tag.gateway")
      expect(text).not.toContain("dialog.provider.tag.recommended")
    }
    const providerModel = await Bun.file("src/shared/provider-model.ts").text()
    expect(providerModel).not.toContain("settings.providers.tag.gateway")
    expect(providerModel).not.toContain("dialog.provider.tag.recommended")
    expect(providerModel).not.toContain("settings.providers.note.kilo")
  })
})
