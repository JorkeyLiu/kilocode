import { describe, expect, it } from "bun:test"
import {
  authorizeCredentialRead,
  completeProviderOAuth,
  fetchProviderData,
  isProviderModelsAuthError,
} from "../../src/provider-actions"

type ExistingGlobal = { disabled_providers?: string[]; provider?: Record<string, unknown> }

function createCtx(existing: ExistingGlobal = { disabled_providers: [] }, merged: ExistingGlobal = existing) {
  const calls = {
    set: [] as Array<{ providerID: string; auth: { type: string; key: string; metadata?: Record<string, string> } }>,
    remove: [] as Array<{ providerID: string }>,
    posts: [] as unknown[],
    config: [] as Array<{ config: Record<string, unknown> }>,
    project: [] as Array<{ config: Record<string, unknown> }>,
    cached: [] as unknown[],
    refresh: 0,
    customProviderDelete: [] as Array<{ providerID: string; directory?: string }>,
    customProviderSave: [] as Array<{ providerID: string; config: unknown; auth: unknown; directory?: string }>,
    globalGets: 0,
    oauth: [] as Array<{ providerID: string; method: number; code?: string; directory?: string }>,
  }

  const ctx = {
    client: {
      auth: {
        set: async (input: {
          providerID: string
          auth: { type: string; key: string; metadata?: Record<string, string> }
        }) => {
          calls.set.push(input)
          return { data: true }
        },
        remove: async (input: { providerID: string }) => {
          calls.remove.push(input)
          return { data: true }
        },
      },
      provider: {
        catalog: async () => ({
          data: {
            all: [
              {
                id: "openai",
                name: "OpenAI",
                source: "custom",
                env: [],
                hasCredential: false,
                models: {},
              },
            ],
            connected: ["openai"],
            default: {},
            failed: [],
          },
        }),
        auth: async () => ({ data: {} }),
        oauth: {
          callback: async (input: { providerID: string; method: number; code?: string; directory?: string }) => {
            calls.oauth.push(input)
            return { data: true }
          },
        },
      },
      customProvider: {
        delete: async (input: { providerID: string; directory?: string }) => {
          calls.customProviderDelete.push(input)
          return { data: { success: true } }
        },
        save: async (input: { providerID: string; config: unknown; auth: unknown; directory?: string }) => {
          calls.customProviderSave.push(input)
          return { data: { success: true } }
        },
      },
      kilo: {
        authStatus: async () => ({ data: { authenticated: false } }),
      },
      global: {
        config: {
          get: async () => {
            calls.globalGets += 1
            return { data: existing }
          },
          update: async (input: { config: Record<string, unknown> }) => {
            calls.config.push(input)
            return { data: input }
          },
        },
      },
      config: {
        get: async () => ({ data: merged }),
        update: async (input: { config: Record<string, unknown> }) => {
          calls.project.push(input)
          return { data: input }
        },
      },
    },
    postMessage: (message: unknown) => calls.posts.push(message),
    getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    workspaceDir: "/tmp",
    fetchAndSendProviders: async () => {
      calls.refresh += 1
    },
  } as unknown as Parameters<typeof completeProviderOAuth>[0]

  return {
    calls,
    ctx,
    setCachedConfig: (message: unknown) => calls.cached.push(message),
  }
}

describe("completeProviderOAuth", () => {
  it("issues exactly one OAuth callback mutation with no global config read/write", async () => {
    const existing = { disabled_providers: ["openai", "groq"], provider: {} }
    const { ctx, calls } = createCtx(existing)

    await completeProviderOAuth(ctx, "req", "openai", 0)

    // LOCK-004: exactly one backend mutation — the OAuth callback absorbs the
    // stale disabled_providers cleanup server-side; no extension config get/update.
    expect(calls.oauth).toHaveLength(1)
    expect(calls.oauth[0]?.providerID).toBe("openai")
    expect(calls.oauth[0]?.method).toBe(0)
    expect(calls.globalGets).toBe(0)
    expect(calls.config).toHaveLength(0)
    expect(calls.refresh).toBe(1)
    expect(calls.posts).toContainEqual({ type: "providerConnected", requestId: "req", providerID: "openai" })
    // LOCK-001: the backend coordinates drain/rebuild — the extension exposes
    // no global.dispose surface; the callback response is the acknowledgement.
    expect((ctx as unknown as Record<string, unknown>).disposeGlobal).toBeUndefined()
    expect(
      (ctx.client as unknown as { global?: Record<string, unknown> }).global?.dispose,
    ).toBeUndefined()
  })

  it("does not read or write global config when provider is not disabled", async () => {
    const existing = { disabled_providers: ["groq"], provider: {} }
    const { ctx, calls } = createCtx(existing)

    await completeProviderOAuth(ctx, "req", "openai", 0)

    // LOCK-004: no extension config read/write — cleanup is backend-owned.
    expect(calls.oauth).toHaveLength(1)
    expect(calls.globalGets).toBe(0)
    expect(calls.config).toHaveLength(0)
    expect(calls.refresh).toBe(1)
  })

  it("never touches global config — the backend callback owns disabled cleanup", async () => {
    const existing = { disabled_providers: ["openai", "anthropic", "groq"], provider: {} }
    const { ctx, calls } = createCtx(existing)

    await completeProviderOAuth(ctx, "req", "openai", 0)

    expect(calls.oauth).toHaveLength(1)
    expect(calls.globalGets).toBe(0)
    expect(calls.config).toHaveLength(0)
  })

  it("does not mutate config when OAuth callback fails", async () => {
    const existing = { disabled_providers: ["openai", "groq"], provider: {} }
    const { ctx: base, calls } = createCtx(existing)

    const failCtx = {
      ...base,
      client: {
        ...base.client,
        provider: {
          ...base.client.provider,
          oauth: {
            callback: async () => {
              throw new Error("oauth failure")
            },
          },
        },
      },
    } as unknown as Parameters<typeof completeProviderOAuth>[0]

    await completeProviderOAuth(failCtx, "req", "openai", 0)

    // OAuth callback failed — no global config read or write is attempted
    expect(calls.globalGets).toBe(0)
    expect(calls.config).toHaveLength(0)
    expect(calls.refresh).toBe(0)
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "providerActionError", providerID: "openai" }))
    // No success message, and no global.dispose surface on a failed mutation.
    expect(calls.posts.some((message) => (message as { type?: string }).type === "providerConnected")).toBe(false)
    expect((failCtx as unknown as Record<string, unknown>).disposeGlobal).toBeUndefined()
  })

  it("never reports a post-success refresh failure as an OAuth connect failure (LOCK-001/004)", async () => {
    const { ctx, calls } = createCtx()
    ctx.fetchAndSendProviders = async () => {
      throw new Error("refresh exploded")
    }

    await completeProviderOAuth(ctx, "req", "openai", 0)

    expect(calls.oauth).toHaveLength(1)
    expect(calls.globalGets).toBe(0)
    expect(calls.config).toHaveLength(0)
    expect((ctx as unknown as Record<string, unknown>).disposeGlobal).toBeUndefined()
    expect(
      (ctx.client as unknown as { global?: Record<string, unknown> }).global?.dispose,
    ).toBeUndefined()
    expect(calls.posts).toContainEqual({ type: "providerConnected", requestId: "req", providerID: "openai" })
    expect(calls.posts.some((message) => (message as { type?: string }).type === "providerActionError")).toBe(false)
  })
})

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
    // source filtering (source === "api") is done in handleGetProviderCredential
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

describe("authorizeCredentialRead", () => {
  const apiProvider = { id: "openai", source: "api", key: "sk-test-123" }
  const customProvider = { id: "custom1", source: "custom", key: "custom-key" }
  const configCustomProvider = {
    id: "configcustom",
    source: "config",
    key: "stored-key",
    env: [],
  }
  const configEnvProvider = {
    id: "configenv",
    source: "config",
    key: "env-key",
    env: ["OPENAI_API_KEY"],
  }
  const configNoEnvField = { id: "confignoenv", source: "config", key: "key" }
  const envProvider = { id: "envprovider", source: "env", key: "env-key" }
  const kiloProvider = { id: "kilo", source: "config", key: "configured" }

  it("authorizes source='api' provider with non-empty key", () => {
    const result = authorizeCredentialRead("openai", [apiProvider as any])
    expect(result).toEqual({ authorized: true, key: "sk-test-123" })
  })

  it("authorizes source='custom' provider with non-empty key", () => {
    const result = authorizeCredentialRead("custom1", [customProvider as any])
    expect(result).toEqual({ authorized: true, key: "custom-key" })
  })

  it("authorizes source='config' custom provider with non-empty key and empty env", () => {
    const result = authorizeCredentialRead("configcustom", [configCustomProvider as any])
    expect(result).toEqual({ authorized: true, key: "stored-key" })
  })

  it("rejects source='config' provider with non-empty key and non-empty env (env-derived)", () => {
    const result = authorizeCredentialRead("configenv", [configEnvProvider as any])
    expect(result).toEqual({ authorized: false, error: "Unable to load API key" })
  })

  it("rejects source='config' provider with non-empty key but missing env field", () => {
    const result = authorizeCredentialRead("confignoenv", [configNoEnvField as any])
    expect(result).toEqual({ authorized: false, error: "Unable to load API key" })
  })

  it("rejects empty providerID", () => {
    const result = authorizeCredentialRead("", [apiProvider as any])
    expect(result).toEqual({ authorized: false, error: "Unable to load API key" })
  })

  it("rejects kilo provider", () => {
    const result = authorizeCredentialRead("kilo", [kiloProvider as any])
    expect(result).toEqual({ authorized: false, error: "Unable to load API key" })
  })

  it("rejects provider not found in list", () => {
    const result = authorizeCredentialRead("openai", [])
    expect(result).toEqual({ authorized: false, error: "Unable to load API key" })
  })

  it("rejects source='env' provider with non-empty key (env-derived)", () => {
    const result = authorizeCredentialRead("envprovider", [envProvider as any])
    expect(result).toEqual({ authorized: false, error: "Unable to load API key" })
  })

  it("rejects empty key", () => {
    const result = authorizeCredentialRead("empty", [{ id: "empty", source: "api", key: "" }] as any)
    expect(result).toEqual({ authorized: false, error: "Unable to load API key" })
  })

  it("rejects non-string key", () => {
    const result = authorizeCredentialRead("bad", [{ id: "bad", source: "api", key: 123 }] as any)
    expect(result).toEqual({ authorized: false, error: "Unable to load API key" })
  })

  it("error result never includes the key value", () => {
    const result = authorizeCredentialRead("kilo", [kiloProvider as any])
    expect(result.authorized).toBe(false)
    if (!result.authorized) {
      expect(result.error).not.toContain("configured")
      expect(result).not.toHaveProperty("key")
    }
  })
})
