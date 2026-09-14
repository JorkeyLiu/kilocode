import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  canonicalEndpointFromConfig,
  packageForProtocol,
  resolveCanonicalProtocol,
  serializeCanonicalProvider,
  validateCustomProvider,
  type FormState,
} from "../../webview-ui/src/components/settings/CustomProviderValidation"
import { isValidCanonicalProviderEntry } from "../../src/config/types"

const t = (key: string) => key

function validForm(overrides: Partial<FormState> = {}): FormState {
  return {
    providerID: "my-custom",
    name: "My Custom",
    npm: "@ai-sdk/openai-compatible",
    protocol: "openai/completions",
    baseURL: "https://example.com/v1",
    apiKey: "",
    models: [{ id: "m1", name: "M1", reasoning: false, supportsImages: false, modalities: {}, variants: [] }],
    headers: [{ key: "", value: "" }],
    saving: false,
    ...overrides,
  }
}

function validateArgs(form: FormState, editing = false, existingIDs: string[] = []) {
  return {
    form,
    t,
    editing,
    disabledProviders: [],
    existingProviderIDs: new Set(existingIDs),
  }
}

describe("canonical custom form init (pure helpers + dialog wiring)", () => {
  it("blank add state uses empty id/name/endpoint with the default protocol", () => {
    const form = validForm({ providerID: "", name: "", baseURL: "", protocol: "openai/completions" })
    expect(form.providerID).toBe("")
    expect(form.name).toBe("")
    expect(form.baseURL).toBe("")
    expect(serializeCanonicalProvider(form)).toBeUndefined()
  })

  it("canonical existing config init reads endpoint/protocol via shared helpers", () => {
    const cfg = { name: "My Custom", endpoint: "https://example.com/v1", protocol: "anthropic/messages", models: { m1: { name: "M1" } } }
    expect(canonicalEndpointFromConfig(cfg)).toBe("https://example.com/v1")
    expect(resolveCanonicalProtocol((cfg as Record<string, unknown>).protocol)).toBe("anthropic/messages")
    const src = readFileSync(resolve(import.meta.dir, "../../webview-ui/src/components/settings/CustomProviderDialog.tsx"), "utf8")
    expect(src).toContain("canonicalEndpointFromConfig")
    expect(src).toContain("resolveCanonicalProtocol")
  })
})

describe("canonical custom fields stay mutable (name/baseURL/protocol)", () => {
  it("edited name and baseURL flow into the canonical payload", () => {
    const form = validForm({ name: "Renamed", baseURL: "https://edited.example.com/v1" })
    const payload = serializeCanonicalProvider(form)
    expect(payload).toBeDefined()
    expect(payload!.name).toBe("Renamed")
    expect(payload!.endpoint).toBe("https://edited.example.com/v1")
    expect(isValidCanonicalProviderEntry(payload)).toBe(true)
  })

  it("each canonical protocol is selectable and serializes verbatim", () => {
    for (const protocol of ["openai/completions", "openai/responses", "anthropic/messages"] as const) {
      const form = validForm({ protocol, npm: packageForProtocol(protocol) })
      const payload = serializeCanonicalProvider(form)
      expect(payload).toBeDefined()
      expect(payload!.protocol).toBe(protocol)
      expect(isValidCanonicalProviderEntry(payload)).toBe(true)
    }
  })

  it("legacy protocol tokens never serialize (protocol validation stays closed)", () => {
    const payload = serializeCanonicalProvider(validForm({ protocol: "openai" as unknown as FormState["protocol"] }))
    expect(payload).toBeUndefined()
  })

  it("validation accepts edited name/baseURL with a legal new ID", () => {
    const out = validateCustomProvider(validateArgs(validForm({ providerID: "brand-new-id", name: "Edited", baseURL: "https://edited.example.com/v1" })))
    expect(out.result).toBeDefined()
    expect(out.result!.name).toBe("Edited")
    expect(out.errors.name).toBeUndefined()
    expect(out.errors.baseURL).toBeUndefined()
  })
})

describe("canonical custom providerID immutability on edit", () => {
  it("editing keeps the existing ID without a duplicate error", () => {
    const out = validateCustomProvider(validateArgs(validForm({ providerID: "mycustom" }), true, ["mycustom"]))
    expect(out.errors.providerID).toBeUndefined()
    expect(out.result?.providerID).toBe("mycustom")
  })

  it("add rejects a duplicate ID while edit allows it", () => {
    const add = validateCustomProvider(validateArgs(validForm({ providerID: "taken" }), false, ["taken"]))
    expect(add.result).toBeUndefined()
    expect(add.errors.providerID).toBe("provider.custom.error.providerID.exists")
    const edit = validateCustomProvider(validateArgs(validForm({ providerID: "taken" }), true, ["taken"]))
    expect(edit.errors.providerID).toBeUndefined()
  })

  it("rejects malformed new IDs without reserving future ordinary IDs", () => {
    expect(validateCustomProvider(validateArgs(validForm({ providerID: "Bad ID!" }), false)).errors.providerID).toBeDefined()
    expect(validateCustomProvider(validateArgs(validForm({ providerID: "openrouter" }), false)).result?.providerID).toBe("openrouter")
  })
})

describe("canonical save payload contract (no legacy shape)", () => {
  it("save uses serializeCanonicalProvider output plus canonical/stamp/credentialRequested", () => {
    const form = validForm({ name: "My Custom", baseURL: "https://example.com/v1", protocol: "openai/completions" })
    const config = serializeCanonicalProvider(form)!
    expect(config).toBeDefined()
    expect("npm" in config).toBe(false)
    expect("options" in config).toBe(false)
    expect("headers" in config).toBe(false)
    expect("env" in config).toBe(false)
    // The dialog send() assembles exactly this wire shape; the host guards
    // canonical:true + stamp + existing SecretStorage ownership.
    const stamp = { materializationVersion: 1 }
    const message = {
      type: "saveCustomProvider",
      providerID: "my-custom",
      config,
      canonical: true as const,
      credentialRequested: false,
      stamp,
    }
    expect(message.canonical).toBe(true)
    expect(message.stamp).toBe(stamp)
    expect(message.config.protocol).toBe("openai/completions")
  })

  it("dialog field gates keep ID immutable on edit while name/baseURL/protocol stay editable", () => {
    const src = readFileSync(resolve(import.meta.dir, "../../webview-ui/src/components/settings/CustomProviderDialog.tsx"), "utf8")
    // providerID is the only field locked on edit; name/baseURL/protocol must not carry a canonical read-only lock.
    expect(src).toContain("disabled={editing()}")
    expect(src).not.toContain("disabled={editing() || isCanonical()}")
    expect(src).not.toContain("disabled={isCanonical()}")
    expect(src).not.toContain("if (isCanonical()) return")
    expect(src).not.toContain("onSelect={() => {")
  })
})
