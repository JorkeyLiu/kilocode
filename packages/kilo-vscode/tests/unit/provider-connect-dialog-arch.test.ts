/**
 * Structural / source-level tests for ProviderConnectDialog and ProvidersTab.
 *
 * These tests verify invariants that cannot be caught by visual regression alone:
 * - Remove path uses inline confirmation (no nested dialog.show)
 * - Close icon props remain icon='close', size='small', variant='ghost'
 * - No account/profile Kilo slot remains (LOCK-006 bounded removal)
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

describe("ProvidersTab — Account slot removed (LOCK-075 re-audit)", () => {
  it("ProvidersTab has no account primary slot and no server.goToProfile in account context", () => {
    expect(TAB_SRC).not.toContain('primary() === "account"')
    expect(TAB_SRC).not.toContain("settings.providers.action.account")
    // No Kilo account navigation remains in ProvidersTab; generic surfaces use edit/apiKey only
    expect(TAB_SRC).not.toMatch(/server\.goToProfile\(\)/)
  })

  it("ProvidersTab has no useServer import for account navigation", () => {
    expect(TAB_SRC).not.toContain('from "../../context/server"')
    expect(TAB_SRC).not.toContain("useServer")
  })
})

describe("ProvidersTab — action icon normalization", () => {
  it("account slot is absent", () => {
    expect(TAB_SRC).not.toContain('primary() === "account"')
    expect(TAB_SRC).not.toContain('icon="person"')
    expect(TAB_SRC).not.toContain("settings.providers.action.account")
  })

  it("edit slot renders edit IconButton with Tooltip", () => {
    const match = TAB_SRC.match(/<Match when=\{primary\(\) === "edit"\}>([\s\S]*?)<\/Match>/)
    expect(match).not.toBeNull()
    const block = match![1]
    expect(block).toContain('icon="edit"')
    expect(block).toContain("<Tooltip")
    expect(block).toContain("IconButton")
    expect(block).toContain("editProvider(item)")
  })

  it("edit slot has localized aria-label and tooltip", () => {
    const match = TAB_SRC.match(/<Match when=\{primary\(\) === "edit"\}>([\s\S]*?)<\/Match>/)
    expect(match).not.toBeNull()
    const block = match![1]
    expect(block).toContain('aria-label={language.t("common.edit")}')
    expect(block).toContain('value={language.t("common.edit")}')
  })

  it("edit slot uses credential-slot wrapper", () => {
    const match = TAB_SRC.match(/<Match when=\{primary\(\) === "edit"\}>([\s\S]*?)<\/Match>/)
    expect(match).not.toBeNull()
    expect(match![1]).toContain("settings-provider-row-credential-slot")
  })

  it("apiKey slot renders edit IconButton with Tooltip", () => {
    const match = TAB_SRC.match(/<Match when=\{primary\(\) === "apiKey"\}>([\s\S]*?)<\/Match>/)
    expect(match).not.toBeNull()
    const block = match![1]
    expect(block).toContain('icon="edit"')
    expect(block).toContain("<Tooltip")
    expect(block).toContain("IconButton")
    expect(block).toContain("manageApiKey(item)")
  })

  it("apiKey slot has localized aria-label and tooltip", () => {
    const match = TAB_SRC.match(/<Match when=\{primary\(\) === "apiKey"\}>([\s\S]*?)<\/Match>/)
    expect(match).not.toBeNull()
    const block = match![1]
    expect(block).toContain('aria-label={language.t("settings.providers.action.apiKey")}')
    expect(block).toContain('value={language.t("settings.providers.action.apiKey")}')
  })

  it("apiKey slot uses credential-slot wrapper", () => {
    const match = TAB_SRC.match(/<Match when=\{primary\(\) === "apiKey"\}>([\s\S]*?)<\/Match>/)
    expect(match).not.toBeNull()
    expect(match![1]).toContain("settings-provider-row-credential-slot")
  })

  it("edit and apiKey slots use IconButton with ghost variant and large size", () => {
    const slots = ["edit", "apiKey"]
    for (const slot of slots) {
      const match = TAB_SRC.match(new RegExp(`<Match when=\\{primary\\(\\) === "${slot}"\\}>([\\s\\S]*?)<\\/Match>`))
      expect(match).not.toBeNull()
      const block = match![1]
      expect(block).toContain('variant="ghost"')
      expect(block).toContain('size="large"')
    }
  })

  it("chatgpt slot remains a text Button (unchanged)", () => {
    const match = TAB_SRC.match(/<Match when=\{primary\(\) === "chatgpt"\}>([\s\S]*?)<\/Match>/)
    expect(match).not.toBeNull()
    const block = match![1]
    expect(block).toContain("<Button")
    expect(block).not.toContain("IconButton")
    expect(block).not.toContain("icon=")
  })

  it("anaconda slot remains a text Button (unchanged)", () => {
    const match = TAB_SRC.match(/<Match when=\{primary\(\) === "anaconda"\}>([\s\S]*?)<\/Match>/)
    expect(match).not.toBeNull()
    const block = match![1]
    expect(block).toContain("<Button")
    expect(block).not.toContain("IconButton")
    expect(block).not.toContain("icon=")
  })
})

describe("Icon credential-slot right-alignment (LOCK-033/034)", () => {
  const iconSlots = ["edit", "apiKey"]

  it("icon slots use the --icon modifier class", () => {
    for (const slot of iconSlots) {
      const match = TAB_SRC.match(
        new RegExp(`<Match when=\\{primary\\(\\) === "${slot}"\\}>([\\s\\S]*?)<\\/Match>`)
      )
      expect(match).not.toBeNull()
      expect(match![1]).toContain("settings-provider-row-credential-slot--icon")
    }
  })

  it("chatgpt and anaconda text buttons do NOT use the --icon modifier", () => {
    for (const slot of ["chatgpt", "anaconda"]) {
      const match = TAB_SRC.match(
        new RegExp(`<Match when=\\{primary\\(\\) === "${slot}"\\}>([\\s\\S]*?)<\\/Match>`)
      )
      expect(match).not.toBeNull()
      expect(match![1]).not.toContain("settings-provider-row-credential-slot--icon")
    }
  })

  it("settings.css defines the --icon modifier with flex-end alignment", () => {
    const SETTINGS_CSS = read("webview-ui/src/styles/settings.css")
    expect(SETTINGS_CSS).toContain(".settings-provider-row-credential-slot--icon")
    expect(SETTINGS_CSS).toContain("justify-content: flex-end")
    expect(SETTINGS_CSS).toContain("display: flex")
  })
})

describe("ProvidersTab — close icon props (LOCK-077)", () => {
  it("close IconButton has icon='close', size='large', variant='ghost'", () => {
    // Find the JSX IconButton usage near deleteCustom onClick
    const idx = TAB_SRC.indexOf("onClick={() => deleteCustom(item.id, item.name)}")
    expect(idx).toBeGreaterThan(-1)
    // IconButton is just before the onClick
    const beforeSnippet = TAB_SRC.slice(Math.max(0, idx - 300), idx)
    expect(beforeSnippet).toContain('icon="close"')
    expect(beforeSnippet).toContain('size="large"')
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

describe("Credential reveal CSS (LOCK-009)", () => {
  it("tooltip trigger wrapper is centered as the flex child", () => {
    expect(DIALOG_CSS).toContain('[data-component="tooltip-trigger"]')
    expect(DIALOG_CSS).toContain("align-items: center")
    // align-self: center positions the trigger itself as a centered flex item
    // inside the input-row; align-items alone only centers children inside it
    expect(DIALOG_CSS).toContain("align-self: center")
    expect(DIALOG_CSS).not.toContain("position: absolute")
  })

  it("eye toggle inherits color styling but does not use align-self", () => {
    expect(DIALOG_CSS).toContain(".provider-apikey-eye-toggle")
    // align-self: center was removed — centering targets the tooltip trigger wrapper instead
    const eyeSection = DIALOG_CSS.match(/\.provider-apikey-eye-toggle\s*\{[^}]*\}/)?.[0] ?? ""
    expect(eyeSection).not.toContain("align-self")
  })

  it("input row does not use padding-right for space reservation", () => {
    const inputRowSection = DIALOG_CSS.match(/\.provider-apikey-input-row[^{]*\{[^}]*\}/g) ?? []
    for (const section of inputRowSection) {
      expect(section).not.toContain("padding-right")
    }
  })
})

describe("Close icon target CSS (LOCK-077)", () => {
  it("final-slot has 32px width and height for 32×32 large IconButton", () => {
    expect(DIALOG_CSS).not.toContain("min-width: 24px")
    const SETTINGS_CSS = read("webview-ui/src/styles/settings.css")
    expect(SETTINGS_CSS).toContain("width: 32px")
    expect(SETTINGS_CSS).toContain("height: 32px")
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

describe("ProviderConnectDialog — secure replace (no credential reveal)", () => {
  it("never requests the stored credential from the host", () => {
    expect(DIALOG_SRC).not.toContain("getProviderCredential")
    expect(DIALOG_SRC).not.toContain("requestCredential")
    expect(DIALOG_SRC).not.toContain("providerCredentialLoaded")
    expect(DIALOG_SRC).not.toContain("onCredentialLoaded")
    expect(DIALOG_SRC).not.toContain("onCredentialError")
  })

  it("never holds plaintext credential state", () => {
    expect(DIALOG_SRC).not.toContain("originalKey")
    expect(DIALOG_SRC).not.toContain("pendingCredentialID")
    expect(DIALOG_SRC).not.toContain("setApiKeyValue")
    expect(DIALOG_SRC).not.toContain("credentialLoading")
    expect(DIALOG_SRC).not.toContain("credentialError")
    expect(DIALOG_SRC).not.toContain("showKey")
  })

  it("manage mode shows masked secure-collected notice without echoing the key", () => {
    expect(DIALOG_SRC).toContain("Stored credential is securely collected")
    expect(DIALOG_SRC).toContain("It is never displayed")
    expect(DIALOG_SRC).toContain("hasStored()")
  })

  it("always collects replacement credentials through the secure host prompt", () => {
    expect(DIALOG_SRC).toContain("Credential input is collected securely by the extension host.")
    expect(DIALOG_SRC).toContain("credentialRequested: true")
  })

  it("Update button stays enabled for replace (only connecting disables submit)", () => {
    expect(DIALOG_SRC).toContain('disabled={state.phase === "connecting"}')
    expect(DIALOG_SRC).not.toContain("unchanged()")
    expect(DIALOG_SRC).not.toContain("emptyEdited()")
  })

  it("remove path stays independent via disconnect", () => {
    expect(DIALOG_SRC).toContain("removeApiKey")
    expect(DIALOG_SRC).toContain("executeRemove")
    expect(DIALOG_SRC).toContain("disconnectProvider")
    expect(DIALOG_SRC).toContain("confirmingRemove")
  })

  it("cancel/go-back still closes without touching credentials", () => {
    expect(DIALOG_SRC).toContain("cancelRemove")
    expect(DIALOG_SRC).toContain("function back()")
    expect(DIALOG_SRC).toContain("dialog.close()")
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
