import { describe, expect, it } from "bun:test"
import { authorizeCredentialRead } from "../../src/provider-actions"

describe("authorizeCredentialRead — custom providers", () => {
  it("authorizes a custom provider with a stored key", () => {
    const list = [{ id: "my-custom", source: "custom", key: "sk-secret-123" }]
    const result = authorizeCredentialRead("my-custom", list)
    expect(result).toEqual({ authorized: true, key: "sk-secret-123" })
  })

  it("authorizes an api provider with a stored key", () => {
    const list = [{ id: "openai", source: "api", key: "sk-openai-456" }]
    const result = authorizeCredentialRead("openai", list)
    expect(result).toEqual({ authorized: true, key: "sk-openai-456" })
  })

  it("rejects a custom provider without a key (env-derived)", () => {
    const list = [{ id: "my-custom", source: "custom" }]
    const result = authorizeCredentialRead("my-custom", list)
    expect(result).toEqual({ authorized: false, error: "Unable to load API key" })
  })

  it("rejects a custom provider with empty key", () => {
    const list = [{ id: "my-custom", source: "custom", key: "" }]
    const result = authorizeCredentialRead("my-custom", list)
    expect(result).toEqual({ authorized: false, error: "Unable to load API key" })
  })

  it("rejects an env source provider", () => {
    const list = [{ id: "env-provider", source: "env", key: "sk-env" }]
    const result = authorizeCredentialRead("env-provider", list)
    expect(result).toEqual({ authorized: false, error: "Unable to load API key" })
  })

  it("rejects a config source provider missing the env field", () => {
    const list = [{ id: "config-provider", source: "config", key: "sk-config" }]
    const result = authorizeCredentialRead("config-provider", list)
    expect(result).toEqual({ authorized: false, error: "Unable to load API key" })
  })

  it("rejects kilo provider", () => {
    const list = [{ id: "kilo", source: "custom", key: "sk-kilo" }]
    const result = authorizeCredentialRead("kilo", list)
    expect(result).toEqual({ authorized: false, error: "Unable to load API key" })
  })

  it("rejects unknown provider ID", () => {
    const list = [{ id: "openai", source: "api", key: "sk-openai" }]
    const result = authorizeCredentialRead("unknown", list)
    expect(result).toEqual({ authorized: false, error: "Unable to load API key" })
  })

  it("rejects empty provider ID", () => {
    const list = [{ id: "openai", source: "api", key: "sk-openai" }]
    const result = authorizeCredentialRead("", list)
    expect(result).toEqual({ authorized: false, error: "Unable to load API key" })
  })

  it("does not expose the key in the error message on rejection", () => {
    const list = [{ id: "my-custom", source: "custom", key: "sk-super-secret" }]
    const result = authorizeCredentialRead("unknown-id", list)
    expect(result.authorized).toBe(false)
    if (!result.authorized) {
      expect(result.error).not.toContain("sk-super-secret")
    }
  })
})
