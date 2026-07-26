/**
 * Structural / source-level tests for ProviderConnectDialog and ProvidersTab.
 *
 * These tests verify invariants that cannot be caught by visual regression alone:
 * - Remove path uses inline confirmation (no nested dialog.show)
 * - Close icon props remain icon='close', size='small', variant='ghost'
 * - Account button routes through server.goToProfile()
 * - Action-row CSS has explicit justify-content and no-wrap
 * - BYOK link exists as a sibling of the action row
 *
 * No SolidJS render harness is used — we parse source text.
 */

import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "../..")

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8")
}

const DIALOG_SRC = read("webview-ui/src/components/settings/ProviderConnectDialog.tsx")
const TAB_SRC = read("webview-ui/src/components/settings/ProvidersTab.tsx")
const DIALOG_CSS = read("webview-ui/src/styles/dialogs.css")

describe("ProviderConnectDialog — remove path is inline (LOCK-072/073)", () => {
  it("removeApiKey does NOT call dialog.show", () => {
    // Extract the removeApiKey function body
    const match = DIALOG_SRC.match(/function removeApiKey\(\)\s*\{([\s\S]*?)\n  \}/)
    expect(match).not.toBeNull()
    const body = match![1]
    expect(body).not.toContain("dialog.show(")
  })

  it("removeApiKey sets confirmingRemove state", () => {
    const match = DIALOG_SRC.match(/function removeApiKey\(\)\s*\{([\s\S]*?)\n  \}/)
    expect(match).not.toBeNull()
    expect(match![1]).toContain("confirmingRemove: true")
  })

  it("executeRemove calls dialog.close once on success", () => {
    const match = DIALOG_SRC.match(/function executeRemove\(\)\s*\{([\s\S]*?)\n  \}/)
    expect(match).not.toBeNull()
    const body = match![1]
    // Should contain exactly one dialog.close() in the success handler
    const closeCount = (body.match(/dialog\.close\(\)/g) ?? []).length
    expect(closeCount).toBe(1)
  })

  it("executeRemove does NOT close dialog on error (keeps retry visible)", () => {
    const match = DIALOG_SRC.match(/function executeRemove\(\)\s*\{([\s\S]*?)\n  \}/)
    expect(match).not.toBeNull()
    const body = match![1]
    // onError handler should set confirmingRemove: true, not call dialog.close
    expect(body).toContain("confirmingRemove: true")
    // Count dialog.close calls outside onDisconnected
    const onErrorSection = body.slice(body.indexOf("onError:"))
    expect(onErrorSection).not.toContain("dialog.close()")
  })

  it("RemoveConfirmView exists as a component", () => {
    expect(DIALOG_SRC).toContain("RemoveConfirmView")
    expect(DIALOG_SRC).toContain("confirmingRemove")
  })

  it("confirmingRemove is cleared on reset", () => {
    const match = DIALOG_SRC.match(/function reset\(\)\s*\{([\s\S]*?)\n  \}/)
    expect(match).not.toBeNull()
    expect(match![1]).toContain("confirmingRemove: undefined")
  })
})

describe("ProvidersTab — Account uses server.goToProfile (LOCK-075)", () => {
  it("Account button calls server.goToProfile", () => {
    // Find the account button onClick handler
    const match = TAB_SRC.match(
      /primary\(\) === "account"[\s\S]*?onClick=\{[\s\S]*?\}[\s\S]*?>/,
    )
    expect(match).not.toBeNull()
    expect(match![0]).toContain("server.goToProfile()")
  })

  it("Account button does NOT use vscode.postMessage directly", () => {
    // The entire account match block
    const match = TAB_SRC.match(
      /<Match when=\{primary\(\) === "account"\}>([\s\S]*?)<\/Match>/,
    )
    expect(match).not.toBeNull()
    expect(match![1]).not.toContain("vscode.postMessage")
  })
})

describe("ProvidersTab — close icon props (LOCK-077)", () => {
  it("close IconButton has icon='close', size='small', variant='ghost'", () => {
    // Find the JSX IconButton usage near deleteCustom onClick
    const idx = TAB_SRC.indexOf("onClick={() => deleteCustom(item.id, item.name)}")
    expect(idx).toBeGreaterThan(-1)
    // IconButton is just before the onClick
    const beforeSnippet = TAB_SRC.slice(Math.max(0, idx - 300), idx)
    expect(beforeSnippet).toContain('icon="close"')
    expect(beforeSnippet).toContain('size="small"')
    expect(beforeSnippet).toContain('variant="ghost"')
  })

  it("close IconButton is wrapped in a settings-provider-row-final-slot div", () => {
    const idx = TAB_SRC.indexOf("onClick={() => deleteCustom(item.id, item.name)}")
    expect(idx).toBeGreaterThan(-1)
    // Look backwards from the onClick to find the wrapper div
    const beforeSnippet = TAB_SRC.slice(Math.max(0, idx - 600), idx)
    expect(beforeSnippet).toContain("settings-provider-row-final-slot")
  })
})

describe("Action row CSS (LOCK-076)", () => {
  it("provider-connect-actions has explicit justify-content", () => {
    expect(DIALOG_CSS).toContain("justify-content: flex-end")
  })

  it("provider-connect-actions has flex-wrap: nowrap", () => {
    expect(DIALOG_CSS).toContain("flex-wrap: nowrap")
  })
})

describe("Close icon target CSS (LOCK-077)", () => {
  it("final-slot has min-width and min-height >= 24px", () => {
    expect(DIALOG_CSS).not.toContain("min-width: 24px")
    // Check settings.css for the target size
    const SETTINGS_CSS = read("webview-ui/src/styles/settings.css")
    expect(SETTINGS_CSS).toContain("min-width: 24px")
    expect(SETTINGS_CSS).toContain("min-height: 24px")
  })
})

describe("No native autofocus (LOCK-082)", () => {
  it("ProviderConnectDialog has no autofocus prop on any TextField", () => {
    // Match both standalone and JSX attribute forms of autofocus on TextField
    const textFieldBlocks = DIALOG_SRC.match(/<TextField[\s\S]*?\/>/g) ?? []
    for (const block of textFieldBlocks) {
      expect(block).not.toMatch(/\bautofocus\b/)
    }
  })

  it("ProviderConnectDialog source has no native autofocus attribute on input", () => {
    expect(DIALOG_SRC).not.toMatch(/<input[^>]*\bautofocus\b/)
  })
})

describe("BYOK sibling (LOCK-074)", () => {
  it("BYOK link exists in the ApiView form", () => {
    expect(DIALOG_SRC).toContain("provider-connect-byok")
    expect(DIALOG_SRC).toContain("provider-connect-byok-link")
  })

  it("BYOK section is outside the provider-connect-actions div", () => {
    // BYOK comes before the action row in the form
    const byokIndex = DIALOG_SRC.indexOf("provider-connect-byok")
    const actionIndex = DIALOG_SRC.indexOf("provider-connect-actions")
    expect(byokIndex).toBeLessThan(actionIndex)
  })
})
