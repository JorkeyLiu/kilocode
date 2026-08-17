import { describe, it, expect } from "bun:test"
import { resolveLocale, selectedLocale, t, translate } from "../../src/services/i18n"

describe("extension host i18n", () => {
  it("returns the key itself when the dict has no entry", () => {
    const result = t("nonexistent.key")
    expect(result).toBe("nonexistent.key")
  })

  it("returns empty string for empty key", () => {
    expect(t("")).toBe("")
  })

  it("resolves supported locale variants", () => {
    expect(resolveLocale("de-DE")).toBe("de")
    expect(resolveLocale("pt-BR")).toBe("br")
    expect(resolveLocale("nb-NO")).toBe("no")
    expect(resolveLocale("zh-CN")).toBe("zh")
    expect(resolveLocale("zh-Hant")).toBe("zht")
    expect(resolveLocale("zh-TW")).toBe("zht")
  })

  it("falls back to English for unsupported locales", () => {
    expect(resolveLocale("sv-SE")).toBe("en")
  })

  it("prefers Kilo new language setting over VS Code language", () => {
    const vscode = {
      env: { language: "en" },
      workspace: {
        getConfiguration: (section: string) => ({
          get: () => (section === "kilo-code.new" ? "de" : undefined),
        }),
      },
    } as unknown as typeof import("vscode")

    expect(selectedLocale(vscode)).toBe("de")
  })

  it("uses VS Code language when Kilo language setting is automatic", () => {
    const vscode = {
      env: { language: "nl" },
      workspace: {
        getConfiguration: () => ({
          get: () => undefined,
        }),
      },
    } as unknown as typeof import("vscode")

    expect(selectedLocale(vscode)).toBe("nl")
  })

  it("returns the raw key when the dict is empty", () => {
    const result = translate("de", "kilocode:any.key")
    expect(result).toBe("kilocode:any.key")
  })
})
