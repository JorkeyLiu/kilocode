/**
 * Structural / source-level tests for CustomProviderDialog.
 *
 * These tests verify invariants that cannot be caught by visual regression alone:
 * - Dialog uses x-large sizing (no nested 60vh scroll)
 * - Responsive grid for basic fields with container query collapse
 * - Sections (Models, Headers) with visual dividers
 * - Sticky footer for submit action
 * - Credential reveal: loading/error states, eye toggle, originalKey semantics
 * - save semantics: apiTouched controls apiKey passthrough
 * - onMount triggers credential load for API-backed existing providers
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

const DIALOG_SRC = read("webview-ui/src/components/settings/CustomProviderDialog.tsx")
const DIALOG_CSS = read("webview-ui/src/styles/dialogs.css")

describe("CustomProviderDialog — layout sizing (LOCK-001/LOCK-002)", () => {
  it('uses size="x-large" on Dialog', () => {
    expect(DIALOG_SRC).toContain('size="x-large"')
  })

  it("applies scoped class for CSS overrides (LOCK-001)", () => {
    expect(DIALOG_SRC).toContain('class="custom-provider-dialog"')
  })

  it("does NOT have nested max-height: 60vh on the form container", () => {
    // The main form container div should not have max-height: 60vh — Dialog handles scrolling.
    // The model picker list may have its own max-height for local scrolling, which is fine.
    expect(DIALOG_SRC).not.toMatch(/max-height.*60vh/)
  })

  it("does NOT have nested overflow-y: auto on the form container", () => {
    // The form uses cpd-form CSS class (not inline styles) — Dialog handles scrolling.
    expect(DIALOG_SRC).toContain('class="cpd-form"')
    // The cpd-form class does NOT contain overflow-y — that's on dialog-body.
    expect(DIALOG_CSS).not.toMatch(/\.cpd-form\s*\{[^}]*overflow-y/)
  })

  it("uses cpd-basic-grid class for 2-column responsive layout of basic fields", () => {
    expect(DIALOG_SRC).toContain('class="cpd-basic-grid"')
  })

  it("places API key in a full-width row spanning both grid columns", () => {
    expect(DIALOG_SRC).toContain('class="cpd-api-key-row"')
  })

  it("uses cpd-form class on the form element", () => {
    expect(DIALOG_SRC).toContain('class="cpd-form"')
  })

  it("has cpd-section wrappers for Models and Headers", () => {
    const sectionMatches = DIALOG_SRC.match(/class="cpd-section"/g) ?? []
    expect(sectionMatches.length).toBe(2)
  })

  it("has cpd-divider between sections (hr elements)", () => {
    const dividerMatches = DIALOG_SRC.match(/class="cpd-divider"/g) ?? []
    expect(dividerMatches.length).toBe(2)
  })

  it("has cpd-footer wrapper around submit button", () => {
    expect(DIALOG_SRC).toContain('class="cpd-footer"')
  })

  it("CSS defines 2-column grid with container query collapse", () => {
    expect(DIALOG_CSS).toContain("grid-template-columns: 1fr 1fr")
    expect(DIALOG_CSS).toContain("@container (max-width: 500px)")
    expect(DIALOG_CSS).toContain(".cpd-basic-grid {\n    grid-template-columns: 1fr;")
  })

  it("CSS defines sticky footer with right-aligned submit", () => {
    expect(DIALOG_CSS).toContain("position: sticky")
    expect(DIALOG_CSS).toContain("bottom: 0")
    expect(DIALOG_CSS).toMatch(/\.cpd-footer[\s\S]*?justify-content:\s*flex-end/)
  })

  it("has cpd-configured sub-container for user-added model cards", () => {
    expect(DIALOG_SRC).toContain('class="cpd-configured"')
  })

  it("has cpd-available sub-container for fetched model picker", () => {
    expect(DIALOG_SRC).toContain('class="cpd-available"')
  })

  it("has cpd-available-label for the fetched section label", () => {
    expect(DIALOG_SRC).toContain('class="cpd-available-label"')
  })

  it("has cpd-model-list class for responsive multi-column model grid", () => {
    expect(DIALOG_SRC).toContain('class="cpd-model-list"')
    expect(DIALOG_CSS).toContain(".cpd-model-list")
  })

  it("CSS defines cpd-model-list grid with responsive breakpoints", () => {
    expect(DIALOG_CSS).toMatch(/\.cpd-model-list[\s\S]*?grid-template-columns/)
    // Has 3-column, 2-column, and 1-column variants
    expect(DIALOG_CSS).toContain("repeat(3, 1fr)")
    expect(DIALOG_CSS).toContain("repeat(2, 1fr)")
  })

  it("has cpd-picker class for fetched model picker wrapper", () => {
    expect(DIALOG_SRC).toContain('class="cpd-picker"')
    expect(DIALOG_CSS).toContain(".cpd-picker")
  })

  it("has cpd-picker-toolbar and cpd-picker-actions classes", () => {
    expect(DIALOG_SRC).toContain('class="cpd-picker-toolbar"')
    expect(DIALOG_SRC).toContain('class="cpd-picker-actions"')
    expect(DIALOG_CSS).toContain(".cpd-picker-toolbar")
    expect(DIALOG_CSS).toContain(".cpd-picker-actions")
  })

  it("has cpd-variant-grid class for 2-column variant Select layout", () => {
    expect(DIALOG_CSS).toContain(".cpd-variant-grid")
  })

  it("has cpd-checkbox-row class for horizontal checkbox layout", () => {
    expect(DIALOG_CSS).toContain(".cpd-checkbox-row")
  })
})

describe("CustomProviderDialog — credential reveal (LOCK-003/005)", () => {
  it("imports TextFieldRoot for Kobalte composition", () => {
    expect(DIALOG_SRC).toContain("TextFieldRoot")
  })

  it("imports Tooltip for eye toggle", () => {
    expect(DIALOG_SRC).toContain("Tooltip")
  })

  it("imports onMount for credential load trigger", () => {
    expect(DIALOG_SRC).toContain("onMount")
  })

  it("has credential loading state", () => {
    expect(DIALOG_SRC).toContain("credentialLoading")
    expect(DIALOG_SRC).toContain("provider.apiKey.manage.loading")
  })

  it("has credential error state with generic message", () => {
    expect(DIALOG_SRC).toContain("credentialError")
    expect(DIALOG_SRC).toContain("provider.apiKey.manage.error")
  })

  it("has originalKey signal for touched tracking", () => {
    expect(DIALOG_SRC).toContain("originalKey")
  })

  it("has showKey signal for password toggle", () => {
    expect(DIALOG_SRC).toContain("showKey")
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

  it("eye toggle is inside input-wrapper as flex sibling", () => {
    const inputWrapperMatch = DIALOG_SRC.match(/data-slot="input-wrapper"[\s\S]*?provider-apikey-eye-toggle/)
    expect(inputWrapperMatch).not.toBeNull()
  })

  it("sends getProviderCredential on mount for API-backed providers", () => {
    expect(DIALOG_SRC).toContain("getProviderCredential")
    expect(DIALOG_SRC).toContain("requestCredential()")
  })

  it("onMount triggers credential load only when editing and auth is api", () => {
    const onMountMatch = DIALOG_SRC.match(/onMount\(\(\)\s*=>\s*\{([\s\S]*?)\}\)/)
    expect(onMountMatch).not.toBeNull()
    const body = onMountMatch![1]
    expect(body).toContain("editing()")
    expect(body).toContain('auth === "api"')
    expect(body).toContain("requestCredential()")
  })

  it("clears pending credential request on cleanup", () => {
    expect(DIALOG_SRC).toContain("pendingCredentialID = undefined")
    expect(DIALOG_SRC).toContain("setOriginalKey(null)")
  })

  it("seeds form field with loaded key without marking touched", () => {
    // The onCredentialLoaded handler should call setForm("apiKey", ...) but NOT setApiTouched(true).
    // On the canonical path it returns early without seeding the form.
    const loadedMatch = DIALOG_SRC.match(/onCredentialLoaded:[\s\S]*?setCredentialLoading\(false\)\s*\}/)
    expect(loadedMatch).not.toBeNull()
    expect(loadedMatch![0]).toContain('setForm("apiKey", message.apiKey)')
    expect(loadedMatch![0]).not.toContain("setApiTouched(true)")
  })

  it("guards credential load from overwriting a user edit (apiTouched check)", () => {
    // The onCredentialLoaded handler must check apiTouched() before seeding the form field.
    // On the canonical path it returns early without touching the form at all.
    const loadedMatch = DIALOG_SRC.match(/onCredentialLoaded:[\s\S]*?setCredentialLoading\(false\)\s*\}/)
    expect(loadedMatch).not.toBeNull()
    expect(loadedMatch![0]).toContain("if (!apiTouched())")
  })

  it("uses Description (always visible) instead of ErrorMessage (error-only) for API key description", () => {
    expect(DIALOG_SRC).toContain("TextFieldRoot.Description")
    expect(DIALOG_SRC).toContain('data-slot="input-description"')
    expect(DIALOG_SRC).not.toContain("TextFieldRoot.ErrorMessage")
    expect(DIALOG_SRC).not.toMatch(/data-slot="input-error"[^>]*>[\s\S]*?provider\.custom\.field\.apiKey\.description/)
  })

  it("does not echo key in failure/error UI", () => {
    // The credential error handler shows a generic i18n message, not the actual key.
    // Verify the onCredentialError handler stores the generic message string.
    const onErrorMatch = DIALOG_SRC.match(/onCredentialError[\s\S]*?setCredentialError\([^)]*\)/)
    expect(onErrorMatch).not.toBeNull()
    expect(onErrorMatch![0]).toContain("provider.apiKey.manage.error")
  })
})

describe("CustomProviderDialog — save semantics (LOCK-004)", () => {
  it("canonical save requests credentials via credentialRequested flag", () => {
    expect(DIALOG_SRC).toContain("credentialRequested: apiTouched()")
  })

  it("canonical-only save never sends legacy apiKey fields", () => {
    expect(DIALOG_SRC).not.toContain("apiKeyChanged")
    expect(DIALOG_SRC).toContain("Provider mutations are canonical-only")
  })

  it("apiTouched is set to true only on user input, not on credential load", () => {
    // Find all setApiTouched(true) calls
    const touchedCalls = DIALOG_SRC.match(/setApiTouched\(true\)/g) ?? []
    // Each setApiTouched(true) should be inside an onChange handler, not in onCredentialLoaded
    for (const _call of touchedCalls) {
      // Verify setApiTouched is NOT inside the onCredentialLoaded block
      const loadedBlock = DIALOG_SRC.match(/onCredentialLoaded:[\s\S]*?onCredentialError/)
      expect(loadedBlock).not.toBeNull()
      expect(loadedBlock![0]).not.toContain("setApiTouched(true)")
    }
  })
})
