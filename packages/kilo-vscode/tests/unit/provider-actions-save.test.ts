import { describe, expect, it } from "bun:test"
import {
  connectProvider,
  completeProviderOAuth,
  disconnectProvider,
  deleteCustomProvider,
  fetchProviderData,
  resolveStoredKey,
  saveCustomProvider,
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
    dispose: 0,
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
        list: async () => ({
          data: {
            all: [
              {
                id: "openai",
                name: "OpenAI",
                source: "custom",
                env: [],
                models: {},
              },
            ],
            connected: ["openai"],
            default: {},
          },
        }),
        auth: async () => ({ data: {} }),
        oauth: {
          callback: async () => ({ data: true }),
        },
      },
      kilo: {
        authStatus: async () => ({ data: { authenticated: false } }),
      },
      global: {
        config: {
          get: async () => ({ data: existing }),
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
    disposeGlobal: async () => {
      calls.dispose += 1
    },
    fetchAndSendProviders: async () => {
      calls.refresh += 1
    },
  } as unknown as Parameters<typeof saveCustomProvider>[0]

  return {
    calls,
    ctx,
    setCachedConfig: (message: unknown) => calls.cached.push(message),
  }
}

function createProvider() {
  return {
    name: "My Provider",
    options: { baseURL: "https://example.com/v1" },
    models: {
      "model-1": { name: "Model One" },
    },
  }
}

function createSavedProvider() {
  return {
    npm: "@ai-sdk/openai-compatible",
    ...createProvider(),
  }
}

describe("disconnectProvider", () => {
  it("removes auth credentials only without touching disabled_providers", async () => {
    const existing = {
      disabled_providers: ["openai", "groq"],
      provider: {
        openai: {
          options: { apiKey: "sk-test" },
        },
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx(existing)

    await disconnectProvider(ctx, "req", "openai", null, setCachedConfig)

    expect(calls.remove).toEqual([{ providerID: "openai" }])
    // disconnectProvider should NOT mutate disabled_providers
    expect(calls.config).toHaveLength(0)
    expect(calls.refresh).toBe(1)
  })
})

describe("connectProvider", () => {
  it("stores api auth metadata from provider prompts", async () => {
    const { ctx, calls } = createCtx()

    await connectProvider(ctx, "req", "azure", "sk-test", {
      resourceName: " my-resource ",
      empty: "   ",
    })

    expect(calls.set).toEqual([
      {
        providerID: "azure",
        auth: {
          type: "api",
          key: "sk-test",
          metadata: { resourceName: "my-resource" },
        },
      },
    ])
    expect(calls.refresh).toBe(1)
    expect(calls.posts).toContainEqual({ type: "providerConnected", requestId: "req", providerID: "azure" })
  })

  it("stores azure endpoint URL metadata from provider prompts", async () => {
    const { ctx, calls } = createCtx()

    await connectProvider(ctx, "req", "azure", "sk-test", {
      endpointType: "baseURL",
      baseURL: " https://my-resource.openai.azure.com/openai ",
      resourceName: "   ",
    })

    expect(calls.set).toEqual([
      {
        providerID: "azure",
        auth: {
          type: "api",
          key: "sk-test",
          metadata: {
            endpointType: "baseURL",
            baseURL: "https://my-resource.openai.azure.com/openai",
          },
        },
      },
    ])
  })

  it("removes provider from disabled_providers on successful connect", async () => {
    const existing = { disabled_providers: ["azure", "openai"], provider: {} }
    const { ctx, calls } = createCtx(existing)

    await connectProvider(ctx, "req", "azure", "sk-test")

    expect(calls.set).toHaveLength(1)
    // clearStaleDisabled should save with azure removed
    expect(calls.config).toHaveLength(1)
    expect(calls.config[0].config.disabled_providers).toEqual(["openai"])
    expect(calls.refresh).toBe(1)
  })

  it("does not mutate disabled_providers when provider is not disabled", async () => {
    const existing = { disabled_providers: ["openai"], provider: {} }
    const { ctx, calls } = createCtx(existing)

    await connectProvider(ctx, "req", "azure", "sk-test")

    // No config update needed — azure not in disabled_providers
    expect(calls.config).toHaveLength(0)
    expect(calls.refresh).toBe(1)
  })

  it("does not clear stale disabled ID when auth.set fails", async () => {
    const existing = { disabled_providers: ["azure", "openai"], provider: {} }
    const { ctx: base, calls } = createCtx(existing)

    // Override auth.set to throw while keeping postMessage from the same calls object
    const failCtx = {
      ...base,
      client: {
        ...base.client,
        auth: {
          set: async () => {
            throw new Error("auth failure")
          },
          remove: async (input: { providerID: string }) => {
            calls.remove.push(input)
            return { data: true }
          },
        },
      },
    } as unknown as Parameters<typeof connectProvider>[0]

    await connectProvider(failCtx, "req", "azure", "sk-test")

    // auth.set failed — disabled_providers must not be mutated
    expect(calls.config).toHaveLength(0)
    expect(calls.refresh).toBe(0)
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "providerActionError", providerID: "azure" }))
  })
})

describe("completeProviderOAuth", () => {
  it("removes provider from disabled_providers on successful OAuth completion", async () => {
    const existing = { disabled_providers: ["openai", "groq"], provider: {} }
    const { ctx, calls } = createCtx(existing)

    await completeProviderOAuth(ctx, "req", "openai", 0)

    // clearStaleDisabled should save with openai removed
    expect(calls.config).toHaveLength(1)
    expect(calls.config[0].config.disabled_providers).toEqual(["groq"])
    expect(calls.refresh).toBe(1)
    expect(calls.posts).toContainEqual({ type: "providerConnected", requestId: "req", providerID: "openai" })
  })

  it("does not mutate disabled_providers when provider is not disabled", async () => {
    const existing = { disabled_providers: ["groq"], provider: {} }
    const { ctx, calls } = createCtx(existing)

    await completeProviderOAuth(ctx, "req", "openai", 0)

    // No config update needed — openai not in disabled_providers
    expect(calls.config).toHaveLength(0)
    expect(calls.refresh).toBe(1)
  })

  it("does not touch unrelated disabled IDs", async () => {
    const existing = { disabled_providers: ["openai", "anthropic", "groq"], provider: {} }
    const { ctx, calls } = createCtx(existing)

    await completeProviderOAuth(ctx, "req", "openai", 0)

    expect(calls.config[0].config.disabled_providers).toEqual(["anthropic", "groq"])
  })

  it("does not clear stale disabled ID when OAuth callback fails", async () => {
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

    // OAuth callback failed — disabled_providers must not be mutated
    expect(calls.config).toHaveLength(0)
    expect(calls.refresh).toBe(0)
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "providerActionError", providerID: "openai" }))
  })
})

describe("saveCustomProvider", () => {
  it("preserves auth when the api key field is unchanged", async () => {
    const { ctx, calls, setCachedConfig } = createCtx()

    await saveCustomProvider(ctx, "req", "myprovider", createProvider(), undefined, false, null, setCachedConfig)

    expect(calls.set).toHaveLength(0)
    expect(calls.remove).toHaveLength(0)
    expect(calls.refresh).toBe(1)
  })

  it("clears auth when the api key field was intentionally cleared", async () => {
    const { ctx, calls, setCachedConfig } = createCtx()

    await saveCustomProvider(ctx, "req", "myprovider", createProvider(), undefined, true, null, setCachedConfig)

    expect(calls.set).toHaveLength(0)
    expect(calls.remove).toEqual([{ providerID: "myprovider" }])
  })

  it("stores a changed api key", async () => {
    const { ctx, calls, setCachedConfig } = createCtx()

    await saveCustomProvider(ctx, "req", "myprovider", createProvider(), " sk-test ", true, null, setCachedConfig)

    expect(calls.remove).toHaveLength(0)
    expect(calls.set).toEqual([{ providerID: "myprovider", auth: { type: "api", key: "sk-test" } }])
  })

  // Regression tests for https://github.com/Kilo-Org/kilocode/issues/9186
  //
  // The CLI's config.update endpoint deep-merges its payload with the existing
  // global config. When the user removes a model or variant from a custom
  // provider and saves, the removed entry stays on disk because the save
  // payload only lists the surviving entries. stripNulls in the merge layer
  // will remove keys explicitly set to null — the save path must emit these
  // sentinels for removed model ids and variant names.
  it("emits null sentinels for models removed since last save", async () => {
    const existing = {
      disabled_providers: [],
      provider: {
        myprovider: {
          npm: "@ai-sdk/openai-compatible",
          name: "My Provider",
          options: { baseURL: "https://example.com/v1" },
          models: {
            "model-keep": { name: "Keep" },
            "model-gone": { name: "Gone" },
          },
        },
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx(existing)

    const next = {
      name: "My Provider",
      options: { baseURL: "https://example.com/v1" },
      models: {
        "model-keep": { name: "Keep" },
      },
    }
    await saveCustomProvider(ctx, "req", "myprovider", next, undefined, false, null, setCachedConfig)

    expect(calls.config).toHaveLength(1)
    const payload = calls.config[0].config.provider as Record<string, { models: Record<string, unknown> }>
    expect(payload.myprovider.models["model-keep"]).toBeDefined()
    expect(payload.myprovider.models["model-gone"]).toBeNull()
  })

  it("emits null sentinels when reasoning and variants are removed from a model", async () => {
    const existing = {
      disabled_providers: [],
      provider: {
        myprovider: {
          npm: "@ai-sdk/openai-compatible",
          name: "My Provider",
          options: { baseURL: "https://example.com/v1" },
          models: {
            "model-1": {
              name: "Model One",
              reasoning: true,
              variants: {
                high: { reasoningEffort: "high" },
                low: { reasoningEffort: "low" },
              },
            },
          },
        },
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx(existing)

    const next = {
      name: "My Provider",
      options: { baseURL: "https://example.com/v1" },
      models: {
        "model-1": { name: "Model One" },
      },
    }
    await saveCustomProvider(ctx, "req", "myprovider", next, undefined, false, null, setCachedConfig)

    expect(calls.config).toHaveLength(1)
    const model = (
      calls.config[0].config.provider as Record<
        string,
        { models: Record<string, { reasoning?: boolean | null; variants?: Record<string, unknown> }> }
      >
    ).myprovider.models["model-1"]
    expect(model.reasoning).toBeNull()
    expect(model.variants?.high).toBeNull()
    expect(model.variants?.low).toBeNull()
  })

  it("does not emit sentinels when the provider is new", async () => {
    const { ctx, calls, setCachedConfig } = createCtx()

    await saveCustomProvider(ctx, "req", "myprovider", createProvider(), undefined, false, null, setCachedConfig)

    expect(calls.config).toHaveLength(1)
    const models = (calls.config[0].config.provider as Record<string, { models: Record<string, unknown> }>).myprovider
      .models
    expect(Object.values(models).every((v) => v !== null)).toBe(true)
  })

  it("removes saved custom providers from disabled_providers when reconnecting", async () => {
    const { ctx, calls, setCachedConfig } = createCtx({ disabled_providers: ["myprovider", "openai"] })

    await saveCustomProvider(ctx, "req", "myprovider", createProvider(), undefined, false, null, setCachedConfig)

    expect(calls.config).toHaveLength(1)
    expect(calls.config[0].config.disabled_providers).toEqual(["openai"])
  })
})

describe("disconnectProvider", () => {
  it("removes auth credentials only without touching disabled_providers or config", async () => {
    const existing = {
      disabled_providers: ["openai"],
      provider: {
        myprovider: createProvider(),
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx(existing)

    await disconnectProvider(ctx, "req", "myprovider", null, setCachedConfig)

    // Should only remove auth — no config mutations
    expect(calls.remove).toEqual([{ providerID: "myprovider" }])
    expect(calls.config).toHaveLength(0)
    expect(calls.project).toHaveLength(0)
    expect(calls.refresh).toBe(1)
    expect(calls.posts).toContainEqual({ type: "providerDisconnected", requestId: "req", providerID: "myprovider" })
  })

  it("does not add providers to disabled_providers on disconnect", async () => {
    const existing = {
      disabled_providers: [],
      provider: {
        myprovider: createProvider(),
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx(existing)

    await disconnectProvider(ctx, "req", "myprovider", null, setCachedConfig)

    expect(calls.config).toHaveLength(0)
    expect(calls.remove).toEqual([{ providerID: "myprovider" }])
  })

  it("does not delete custom provider config on disconnect", async () => {
    const existing = {
      disabled_providers: ["myprovider"],
      provider: {
        myprovider: createSavedProvider(),
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx(existing)

    await disconnectProvider(ctx, "req", "myprovider", null, setCachedConfig)

    expect(calls.remove).toEqual([{ providerID: "myprovider" }])
    expect(calls.config).toHaveLength(0)
    expect(calls.project).toHaveLength(0)
  })
})

describe("deleteCustomProvider", () => {
  it("removes auth and config for a custom provider", async () => {
    const existing = {
      disabled_providers: ["myprovider", "openai"],
      provider: {
        myprovider: createSavedProvider(),
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx(existing)

    await deleteCustomProvider(ctx, "req", "myprovider", null, setCachedConfig)

    expect(calls.remove).toEqual([{ providerID: "myprovider" }])
    expect(calls.config).toHaveLength(1)
    expect(calls.config[0].config).toEqual({
      provider: { myprovider: null },
      disabled_providers: ["openai"],
    })
    expect(calls.project).toEqual([{ config: { provider: { myprovider: null } }, directory: "/tmp" }])
    expect(calls.refresh).toBe(1)
    expect(calls.posts).toContainEqual({ type: "providerDeleted", requestId: "req", providerID: "myprovider" })
  })

  it("deletes project custom provider config when not in global config", async () => {
    const merged = {
      provider: {
        myprovider: createSavedProvider(),
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx({ disabled_providers: [] }, merged)

    await deleteCustomProvider(ctx, "req", "myprovider", null, setCachedConfig)

    expect(calls.config).toHaveLength(0)
    expect(calls.project).toEqual([{ config: { provider: { myprovider: null } }, directory: "/tmp" }])
    expect(calls.remove).toEqual([{ providerID: "myprovider" }])
  })

  it("cleans stale disabled ID from global config when deleting project-only custom provider", async () => {
    const global = { disabled_providers: ["myprovider", "openai"], provider: {} }
    const merged = {
      disabled_providers: ["myprovider", "openai"],
      provider: {
        myprovider: createSavedProvider(),
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx(global, merged)

    await deleteCustomProvider(ctx, "req", "myprovider", null, setCachedConfig)

    // Global config should have disabled_providers cleaned without provider key
    expect(calls.config).toHaveLength(1)
    expect(calls.config[0].config).toEqual({ disabled_providers: ["openai"] })
    // Project config should null out the provider
    expect(calls.project).toEqual([{ config: { provider: { myprovider: null } }, directory: "/tmp" }])
    expect(calls.remove).toEqual([{ providerID: "myprovider" }])
    expect(calls.posts).toContainEqual({ type: "providerDeleted", requestId: "req", providerID: "myprovider" })
  })

  it("skips global save when project-only custom provider is not in disabled_providers", async () => {
    const global = { disabled_providers: ["openai"], provider: {} }
    const merged = {
      disabled_providers: ["openai"],
      provider: {
        myprovider: createSavedProvider(),
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx(global, merged)

    await deleteCustomProvider(ctx, "req", "myprovider", null, setCachedConfig)

    // No global config save needed — provider not in global disabled list
    expect(calls.config).toHaveLength(0)
    expect(calls.project).toEqual([{ config: { provider: { myprovider: null } }, directory: "/tmp" }])
    expect(calls.remove).toEqual([{ providerID: "myprovider" }])
  })

  it("errors when the provider is not a custom provider", async () => {
    const existing = {
      disabled_providers: [],
      provider: {
        myprovider: createProvider(),
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx(existing)

    await deleteCustomProvider(ctx, "req", "myprovider", null, setCachedConfig)

    expect(calls.remove).toHaveLength(0)
    expect(calls.config).toHaveLength(0)
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "providerActionError", action: "delete" }))
  })

  it("cleans up disabled_providers when deleting", async () => {
    const existing = {
      disabled_providers: ["myprovider", "other"],
      provider: {
        myprovider: createSavedProvider(),
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx(existing)

    await deleteCustomProvider(ctx, "req", "myprovider", null, setCachedConfig)

    expect(calls.config[0].config.disabled_providers).toEqual(["other"])
  })
})

describe("fetchProviderData", () => {
  it("derives api auth state and strips keys from provider payloads", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "groq-test",
                name: "Groq Test",
                source: "config",
                key: "sk-test",
                env: [],
                models: {},
              },
            ],
            connected: ["groq-test"],
            default: { "groq-test": "llama-3.1-8b-instant" },
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
  })

  it("uses local Kilo auth status instead of profile availability", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [{ id: "kilo", name: "Kilo Gateway", source: "custom", env: [], models: {} }],
            connected: ["kilo"],
            default: { kilo: "kilo-auto/frontier" },
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
        list: async () => ({
          data: {
            all: [{ id: "kilo", name: "Kilo Gateway", source: "config", key: "configured", env: [], models: {} }],
            connected: ["kilo"],
            default: { kilo: "kilo-auto/frontier" },
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

  it("retains stripped keys for providers with a configured baseURL", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "myprovider",
                name: "My Provider",
                source: "config",
                key: "sk-stored",
                env: [],
                options: { baseURL: "https://example.com/v1" },
                models: {},
              },
              {
                id: "no-url",
                name: "No URL",
                source: "config",
                key: "sk-other",
                env: [],
                models: {},
              },
            ],
            connected: [],
            default: {},
          },
        }),
        auth: async () => ({ data: {} }),
      },
      kilo: {
        authStatus: async () => ({ data: { authenticated: false } }),
      },
    } as unknown as Parameters<typeof fetchProviderData>[0]

    const result = await fetchProviderData(client, "/tmp")

    expect(result.storedKeys).toEqual({
      myprovider: { key: "sk-stored", baseURL: "https://example.com/v1" },
    })
    expect(result.response.all.every((item) => !("key" in (item as Record<string, unknown>)))).toBe(true)
  })
})

describe("resolveStoredKey", () => {
  const storedKeys = {
    myprovider: { key: "sk-stored", baseURL: "https://example.com/v1" },
  }

  it("returns the stored key when the fetch URL matches the configured baseURL", () => {
    expect(resolveStoredKey(storedKeys, "myprovider", "https://example.com/v1")).toBe("sk-stored")
  })

  it("tolerates trailing-slash differences", () => {
    expect(resolveStoredKey(storedKeys, "myprovider", "https://example.com/v1/")).toBe("sk-stored")
  })

  it("refuses to apply the stored key to a different host or path", () => {
    expect(resolveStoredKey(storedKeys, "myprovider", "https://evil.example.net/v1")).toBeUndefined()
    expect(resolveStoredKey(storedKeys, "myprovider", "https://example.com/v2")).toBeUndefined()
  })

  it("returns undefined for unknown or missing provider ids", () => {
    expect(resolveStoredKey(storedKeys, "other", "https://example.com/v1")).toBeUndefined()
    expect(resolveStoredKey(storedKeys, undefined, "https://example.com/v1")).toBeUndefined()
    expect(resolveStoredKey(storedKeys, "", "https://example.com/v1")).toBeUndefined()
  })
})
