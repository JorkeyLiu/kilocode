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
    const match = TAB_SRC.match(/primary\(\) === "account"[\s\S]*?onClick=\{[\s\S]*?\}[\s\S]*?>/)
    expect(match).not.toBeNull()
    expect(match![0]).toContain("server.goToProfile()")
  })

  it("Account button does NOT use vscode.postMessage directly", () => {
    // The entire account match block
    const match = TAB_SRC.match(/<Match when=\{primary\(\) === "account"\}>([\s\S]*?)<\/Match>/)
    expect(match).not.toBeNull()
    expect(match![1]).not.toContain("vscode.postMessage")
  })
})

describe("ProvidersTab — action icon normalization", () => {
  it("account slot renders person IconButton with Tooltip", () => {
    const match = TAB_SRC.match(/<Match when=\{primary\(\) === "account"\}>([\s\S]*?)<\/Match>/)
    expect(match).not.toBeNull()
    const block = match![1]
    expect(block).toContain('icon="person"')
    expect(block).toContain("<Tooltip")
    expect(block).toContain("IconButton")
    expect(block).toContain("server.goToProfile()")
  })

  it("account slot has localized aria-label and tooltip", () => {
    const match = TAB_SRC.match(/<Match when=\{primary\(\) === "account"\}>([\s\S]*?)<\/Match>/)
    expect(match).not.toBeNull()
    const block = match![1]
    expect(block).toContain('aria-label={language.t("settings.providers.action.account")}')
    expect(block).toContain('value={language.t("settings.providers.action.account")}')
  })

  it("account slot uses credential-slot wrapper", () => {
    const match = TAB_SRC.match(/<Match when=\{primary\(\) === "account"\}>([\s\S]*?)<\/Match>/)
    expect(match).not.toBeNull()
    expect(match![1]).toContain("settings-provider-row-credential-slot")
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

  it("account, edit, and apiKey slots all use IconButton with ghost variant and large size", () => {
    const slots = ["account", "edit", "apiKey"]
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
  const iconSlots = ["account", "edit", "apiKey"]

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

describe("Credential reveal — manage mode (LOCK-003/004/005/006/007)", () => {
  it("sends getProviderCredential on mount in manage mode", () => {
    expect(DIALOG_SRC).toContain("getProviderCredential")
    expect(DIALOG_SRC).toContain("requestCredential()")
  })

  it("has credential loading state", () => {
    expect(DIALOG_SRC).toContain("credentialLoading")
    expect(DIALOG_SRC).toContain("provider.apiKey.manage.loading")
  })

  it("has credential error state with generic message", () => {
    expect(DIALOG_SRC).toContain("credentialError")
    expect(DIALOG_SRC).toContain("provider.apiKey.manage.error")
  })

  it("default input type is password", () => {
    // In manage mode the field defaults to password, toggled by showKey
    expect(DIALOG_SRC).toContain('type={state.showKey ? "text" : "password"}')
  })

  it("has eye toggle button with aria-label", () => {
    expect(DIALOG_SRC).toContain("provider-apikey-eye-toggle")
    expect(DIALOG_SRC).toContain("aria-label")
    expect(DIALOG_SRC).toContain("provider.connect.apiKey.show")
    expect(DIALOG_SRC).toContain("provider.connect.apiKey.hide")
  })

  it("has tooltip for eye toggle", () => {
    expect(DIALOG_SRC).toContain("provider.connect.apiKey.show")
    expect(DIALOG_SRC).toContain("provider.connect.apiKey.hide")
  })

  it("Update button is disabled when credential is loading", () => {
    expect(DIALOG_SRC).toContain("state.credentialLoading")
  })

  it("Update button is disabled when value is unchanged", () => {
    expect(DIALOG_SRC).toContain("unchanged()")
  })

  it("empty edited value shows required validation", () => {
    expect(DIALOG_SRC).toContain("emptyEdited()")
  })

  it("clears plaintext signal and pending request on cleanup", () => {
    expect(DIALOG_SRC).toContain("pendingCredentialID = undefined")
    expect(DIALOG_SRC).toContain("setOriginalKey(null)")
  })

  it("resets credential state on dialog reset", () => {
    const resetMatch = DIALOG_SRC.match(/function reset\(\)\s*\{([\s\S]*?)\n  \}/)
    expect(resetMatch).not.toBeNull()
    const body = resetMatch![1]
    expect(body).toContain("pendingCredentialID = undefined")
    expect(body).toContain("setOriginalKey(null)")
    expect(body).toContain("credentialLoading: undefined")
    expect(body).toContain("credentialError: undefined")
    expect(body).toContain("showKey: undefined")
  })

  it("does not echo key in failure/error UI", () => {
    // The credential error handler shows a generic i18n message, not the actual key.
    // Verify the error callback stores the generic message string, not the apiKey value.
    const onErrorMatch = DIALOG_SRC.match(/onCredentialError[\s\S]*?credentialError:[^}]*/)
    expect(onErrorMatch).not.toBeNull()
    // Should use the i18n error message, not the actual key
    expect(onErrorMatch![0]).toContain("provider.apiKey.manage.error")
  })

  it("has provider-apikey-input-row for flex-based eye toggle layout", () => {
    expect(DIALOG_SRC).toContain("provider-apikey-input-row")
  })

  it("uses Kobalte TextField primitive for manage mode (local composition)", () => {
    expect(DIALOG_SRC).toContain("TextFieldRoot")
    expect(DIALOG_SRC).toContain('data-component="input"')
    expect(DIALOG_SRC).toContain('data-variant="normal"')
  })

  it("eye toggle is inside input-wrapper as flex sibling", () => {
    // The eye toggle should be inside data-slot="input-wrapper", not as a sibling of TextField
    const inputWrapperMatch = DIALOG_SRC.match(/data-slot="input-wrapper"[\s\S]*?provider-apikey-eye-toggle/)
    expect(inputWrapperMatch).not.toBeNull()
  })

  it("uses direct callback assignment instead of side-effect createMemo for value seeding", () => {
    // setApiKeyValue callback ref should exist
    expect(DIALOG_SRC).toContain("setApiKeyValue")
    // onCredentialLoaded should call setApiKeyValue directly
    expect(DIALOG_SRC).toMatch(/setOriginalKey\(message\.apiKey\)[\s\S]*?setApiKeyValue\?\.\(message\.apiKey\)/)
    // No unconsumed createMemo that only calls setValue as a side-effect
    const apiViewMatch = DIALOG_SRC.match(/const ApiView[\s\S]*?const OAuthCodeView/)
    expect(apiViewMatch).not.toBeNull()
    // Should NOT have a createMemo that only calls setValue
    const sideEffectMemo = apiViewMatch![0]?.match(/createMemo\(\(\)\s*=>\s*\{[\s\S]*?setValue/)
    expect(sideEffectMemo).toBeNull()
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
