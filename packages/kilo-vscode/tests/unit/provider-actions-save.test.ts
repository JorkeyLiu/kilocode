import { describe, expect, it } from "bun:test"
import { fetchProviderData, isProviderModelsAuthError } from "../../src/provider-actions"

describe("fetchProviderData", () => {
  it("derives api auth state from catalog hasCredential without keys", async () => {
    const client = {
      provider: {
        catalog: async () => ({
          data: {
            all: [
              {
                id: "groq-test",
                name: "Groq Test",
                source: "config",
                env: [],
                hasCredential: true,
                models: {},
              },
            ],
            connected: ["groq-test"],
            default: { "groq-test": "llama-3.1-8b-instant" },
            failed: [],
          },
        }),
        auth: async () => ({ data: {} }),
      },
      kilo: {
        authStatus: async () => ({ data: { authenticated: false } }),
      },
    } as unknown as Parameters<typeof fetchProviderData>[0]

    const result = await fetchProviderData(client, "/tmp")
    const item = result.response.all[0] as Record<string, unknown>

    expect(result.authStates).toEqual({ "groq-test": "api" })
    expect("key" in item).toBe(false)
    expect("options" in item).toBe(false)
  })

  it("uses local Kilo auth status instead of profile availability", async () => {
    const client = {
      provider: {
        catalog: async () => ({
          data: {
            all: [
              {
                id: "kilo",
                name: "Kilo Gateway",
                source: "custom",
                env: [],
                hasCredential: false,
                models: {},
              },
            ],
            connected: ["kilo"],
            default: { kilo: "kilo-auto/frontier" },
            failed: [],
          },
        }),
        auth: async () => ({ data: {} }),
      },
      kilo: {
        authStatus: async () => ({ data: { authenticated: true, type: "oauth" } }),
      },
    } as unknown as Parameters<typeof fetchProviderData>[0]

    const result = await fetchProviderData(client, "/tmp")

    expect(result.authStates).toEqual({ kilo: "oauth" })
  })

  it("does not infer Kilo speech access without stored Gateway auth", async () => {
    const client = {
      provider: {
        catalog: async () => ({
          data: {
            all: [
              {
                id: "kilo",
                name: "Kilo Gateway",
                source: "config",
                env: [],
                hasCredential: true,
                models: {},
              },
            ],
            connected: ["kilo"],
            default: { kilo: "kilo-auto/frontier" },
            failed: [],
          },
        }),
        auth: async () => ({ data: {} }),
      },
      kilo: {
        authStatus: async () => ({ data: { authenticated: false } }),
      },
    } as unknown as Parameters<typeof fetchProviderData>[0]

    const result = await fetchProviderData(client, "/tmp")

    expect(result.authStates).toEqual({})
  })

  it("derives authStates without retaining credentials extension-side", async () => {
    const client = {
      provider: {
        catalog: async () => ({
          data: {
            all: [
              {
                id: "myprovider",
                name: "My Provider",
                source: "config",
                env: [],
                hasCredential: true,
                models: {},
              },
              {
                id: "no-url",
                name: "No URL",
                source: "config",
                env: [],
                hasCredential: true,
                models: {},
              },
            ],
            connected: [],
            default: {},
            failed: [],
          },
        }),
        auth: async () => ({ data: {} }),
      },
      kilo: {
        authStatus: async () => ({ data: { authenticated: false } }),
      },
    } as unknown as Parameters<typeof fetchProviderData>[0]

    const result = await fetchProviderData(client, "/tmp")

    expect("storedKeys" in result).toBe(false)
    expect(result.authStates).toEqual({ myprovider: "api", "no-url": "api" })
    expect(result.response.all.every((item) => !("key" in (item as Record<string, unknown>)))).toBe(true)
    expect(result.response.all.every((item) => !("options" in (item as Record<string, unknown>)))).toBe(true)
  })
})

describe("isProviderModelsAuthError", () => {
  it("maps runtime Unauthorized failures to auth UX", () => {
    expect(isProviderModelsAuthError({ name: "Unauthorized", data: { message: "Stored credential failed authentication (HTTP 401)" } })).toBe(true)
    expect(isProviderModelsAuthError({ name: "Unauthorized", data: {} })).toBe(true)
  })

  it("detects auth status and credential wording in plain messages", () => {
    expect(isProviderModelsAuthError({ name: "UpstreamError", data: { message: "HTTP 403 from provider" } })).toBe(true)
    expect(isProviderModelsAuthError("authentication failed")).toBe(true)
  })

  it("keeps invalid and transport failures as non-auth errors", () => {
    expect(isProviderModelsAuthError({ name: "BadRequest", data: { message: "Provider model discovery request is invalid" } })).toBe(false)
    expect(isProviderModelsAuthError({ name: "InvalidResponse", data: { message: "Provider returned an invalid models response" } })).toBe(false)
    expect(isProviderModelsAuthError({ name: "UpstreamError", data: { message: "Provider models request failed" } })).toBe(false)
    expect(isProviderModelsAuthError(undefined)).toBe(false)
  })
})

describe("fetchProviderData — catalog hasCredential predicates", () => {
  it("marks source='api' providers with hasCredential as api auth", async () => {
    const client = {
      provider: {
        catalog: async () => ({
          data: {
            all: [
              {
                id: "openai",
                name: "OpenAI",
                source: "api",
                env: [],
                hasCredential: true,
                models: {},
              },
            ],
            connected: ["openai"],
            default: {},
            failed: [],
          },
        }),
        auth: async () => ({ data: {} }),
      },
      kilo: {
        authStatus: async () => ({ data: { authenticated: false } }),
      },
    } as unknown as Parameters<typeof fetchProviderData>[0]

    const result = await fetchProviderData(client, "/tmp")
    expect(result.authStates).toEqual({ openai: "api" })
    // Redacted catalog never carries keys/options to the webview
    const item = result.response.all[0] as Record<string, unknown>
    expect("key" in item).toBe(false)
    expect("options" in item).toBe(false)
  })

  it("marks source='env' providers with hasCredential as api auth (source filtering is handler-level)", async () => {
    const client = {
      provider: {
        catalog: async () => ({
          data: {
            all: [
              {
                id: "envprovider",
                name: "Env Provider",
                source: "env",
                env: ["ENV_KEY"],
                hasCredential: true,
                models: {},
              },
            ],
            connected: [],
            default: {},
            failed: [],
          },
        }),
        auth: async () => ({ data: {} }),
      },
      kilo: {
        authStatus: async () => ({ data: { authenticated: false } }),
      },
    } as unknown as Parameters<typeof fetchProviderData>[0]

    const result = await fetchProviderData(client, "/tmp")
    // fetchProviderData marks any provider with hasCredential as api auth;
    // existence comes from the redacted catalog — no raw key is ever read.
    expect(result.authStates).toEqual({ envprovider: "api" })
  })

  it("rejects kilo provider from authStates", async () => {
    const client = {
      provider: {
        catalog: async () => ({
          data: {
            all: [
              {
                id: "kilo",
                name: "Kilo Gateway",
                source: "config",
                env: [],
                hasCredential: true,
                models: {},
              },
            ],
            connected: ["kilo"],
            default: { kilo: "kilo-auto/frontier" },
            failed: [],
          },
        }),
        auth: async () => ({ data: {} }),
      },
      kilo: {
        authStatus: async () => ({ data: { authenticated: false } }),
      },
    } as unknown as Parameters<typeof fetchProviderData>[0]

    const result = await fetchProviderData(client, "/tmp")
    // kilo is always deleted from authStates unless kiloAuth sets it
    expect(result.authStates).toEqual({})
  })

  it("rejects providers without credential from authStates", async () => {
    const client = {
      provider: {
        catalog: async () => ({
          data: {
            all: [
              {
                id: "empty-key",
                name: "Empty Key",
                source: "api",
                env: [],
                hasCredential: false,
                models: {},
              },
            ],
            connected: [],
            default: {},
            failed: [],
          },
        }),
        auth: async () => ({ data: {} }),
      },
      kilo: {
        authStatus: async () => ({ data: { authenticated: false } }),
      },
    } as unknown as Parameters<typeof fetchProviderData>[0]

    const result = await fetchProviderData(client, "/tmp")
    expect(result.authStates).toEqual({})
  })
})

describe("provider credentials are never revealed to the webview", () => {
  it("exposes no credential-read helper and no raw key in the catalog path", async () => {
    const actions = await Bun.file(
      new URL("../../src/provider-actions.ts", import.meta.url),
    ).text()
    expect(actions).not.toContain("authorizeCredentialRead")
    expect(actions).not.toContain("apiKey")
    expect(actions).toContain("hasCredential")
  })
})
