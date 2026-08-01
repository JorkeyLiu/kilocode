/**
 * Regression test: Settings Save must call saveConfig directly
 * without a busy-session interruption warning.
 *
 * When backend saves became non-interrupting, the Settings save-bar
 * toast that warned "One/Several sessions are running and will be
 * interrupted" was removed. This test ensures the warning path and
 * its associated session-busy check do not reappear.
 */

import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const SETTINGS_FILE = path.resolve(
  import.meta.dir,
  "../../webview-ui/src/components/settings/Settings.tsx",
)

const settingsSource = fs.readFileSync(SETTINGS_FILE, "utf-8")

const I18N_DIR = path.resolve(import.meta.dir, "../../webview-ui/src/i18n")

function readI18nFiles(): string {
  return fs
    .readdirSync(I18N_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => fs.readFileSync(path.join(I18N_DIR, f), "utf-8"))
    .join("\n")
}

const allI18n = readI18nFiles()

describe("settings save — no busy-session warning", () => {
  it("Settings.tsx does not import useSession", () => {
    expect(settingsSource).not.toContain("useSession")
  })

  it("Settings.tsx does not reference busyCount", () => {
    expect(settingsSource).not.toContain("busyCount")
  })

  it("Settings.tsx does not reference the warning translation keys", () => {
    expect(settingsSource).not.toContain("settings.saveBar.warning.one")
    expect(settingsSource).not.toContain("settings.saveBar.warning.many")
    expect(settingsSource).not.toContain("settings.saveBar.saveAnyway")
    expect(settingsSource).not.toContain("settings.saveBar.cancel")
  })

  it("Settings.tsx does not import showToast", () => {
    expect(settingsSource).not.toContain("showToast")
  })

  it("save-bar Save button onClick references saveConfig directly", () => {
    // The save button should wire onClick={saveConfig}, not a wrapper
    expect(settingsSource).toContain("onClick={saveConfig}")
    // Ensure handleSave wrapper is gone
    expect(settingsSource).not.toContain("handleSave")
  })

  it("warning keys are removed from all i18n locale files", () => {
    const obsoleteKeys = [
      "settings.saveBar.warning.one",
      "settings.saveBar.warning.many",
      "settings.saveBar.saveAnyway",
      "settings.saveBar.cancel",
    ]
    for (const key of obsoleteKeys) {
      expect(allI18n).not.toContain(key)
    }
  })

  it("remaining saveBar i18n keys are preserved", () => {
    const preservedKeys = [
      "settings.saveBar.unsavedChanges",
      "settings.saveBar.discard",
      "settings.saveBar.save",
      "settings.saveBar.saving",
      "settings.saveBar.saveFailed",
    ]
    for (const key of preservedKeys) {
      expect(allI18n).toContain(key)
    }
  })
})
