import { describe, expect, it } from "bun:test"
import {
  authorizeCredentialRead,
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
    // LOCK-001: the backend coordinates drain/rebuild — no explicit global.dispose.
    expect(calls.dispose).toBe(0)
  })

  it("never swallows a backend auth.remove failure and never claims a false disconnect (LOCK-002)", async () => {
    const existing = {
      disabled_providers: [],
      provider: {
        openai: {
          options: { apiKey: "sk-test" },
        },
      },
    }
    const { ctx: base, calls, setCachedConfig } = createCtx(existing)
    const failCtx = {
      ...base,
      client: {
        ...base.client,
        auth: {
          set: async () => ({ data: true }),
          remove: async () => {
            throw new Error("auth removal exploded")
          },
        },
      },
    } as unknown as Parameters<typeof disconnectProvider>[0]

    await disconnectProvider(failCtx, "req", "openai", null, setCachedConfig)

    // The real backend error is surfaced — never swallowed for a configured provider.
    expect(calls.posts).toContainEqual(
      expect.objectContaining({
        type: "providerActionError",
        action: "disconnect",
        providerID: "openai",
        message: "auth removal exploded",
      }),
    )
    // No false disconnected acknowledgement and no refresh after a failed removal.
    expect(calls.posts.some((message) => (message as { type?: string }).type === "providerDisconnected")).toBe(false)
    expect(calls.refresh).toBe(0)
    expect(calls.dispose).toBe(0)
  })

  it("never reports a post-success refresh failure as a disconnect failure (LOCK-001/004)", async () => {
    const { ctx, calls, setCachedConfig } = createCtx()
    ctx.fetchAndSendProviders = async () => {
      throw new Error("refresh exploded")
    }

    await disconnectProvider(ctx, "req", "openai", null, setCachedConfig)

    expect(calls.remove).toEqual([{ providerID: "openai" }])
    expect(calls.dispose).toBe(0)
    expect(calls.posts).toContainEqual({ type: "providerDisconnected", requestId: "req", providerID: "openai" })
    expect(calls.posts.some((message) => (message as { type?: string }).type === "providerActionError")).toBe(false)
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
    // LOCK-001: the backend coordinates drain/rebuild — no explicit global.dispose.
    expect(calls.dispose).toBe(0)
    // LOCK-004: connect is exactly ONE backend mutation — no global config read/write.
    expect(calls.globalGets).toBe(0)
    expect(calls.config).toHaveLength(0)
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
    expect(calls.globalGets).toBe(0)
    expect(calls.config).toHaveLength(0)
  })

  it("issues exactly one auth.set mutation with no global config read/write", async () => {
    const existing = { disabled_providers: ["azure", "openai"], provider: {} }
    const { ctx, calls } = createCtx(existing)

    await connectProvider(ctx, "req", "azure", "sk-test")

    // LOCK-004: exactly one backend mutation — auth.set absorbs the stale
    // disabled_providers cleanup server-side; no extension config get/update.
    expect(calls.set).toHaveLength(1)
    expect(calls.globalGets).toBe(0)
    expect(calls.config).toHaveLength(0)
    expect(calls.refresh).toBe(1)
    expect(calls.posts).toContainEqual({ type: "providerConnected", requestId: "req", providerID: "azure" })
    expect(calls.dispose).toBe(0)
  })

  it("does not read or write global config when provider is not disabled", async () => {
    const existing = { disabled_providers: ["openai"], provider: {} }
    const { ctx, calls } = createCtx(existing)

    await connectProvider(ctx, "req", "azure", "sk-test")

    // LOCK-004: no extension config read/write at all — cleanup is backend-owned.
    expect(calls.globalGets).toBe(0)
    expect(calls.config).toHaveLength(0)
    expect(calls.refresh).toBe(1)
  })

  it("does not mutate config when auth.set fails", async () => {
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

    // auth.set failed — no global config read or write is attempted
    expect(calls.globalGets).toBe(0)
    expect(calls.config).toHaveLength(0)
    expect(calls.refresh).toBe(0)
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "providerActionError", providerID: "azure" }))
    // No success message, no dispose on a failed mutation.
    expect(calls.posts.some((message) => (message as { type?: string }).type === "providerConnected")).toBe(false)
    expect(calls.dispose).toBe(0)
  })

  it("never reports a post-success refresh failure as a connect failure (LOCK-001/004)", async () => {
    const { ctx, calls } = createCtx()
    ctx.fetchAndSendProviders = async () => {
      throw new Error("refresh exploded")
    }

    await connectProvider(ctx, "req", "azure", "sk-test")

    // The auth.set response IS the acknowledgement — success is emitted even
    // when the refresh throws, and the refresh failure is logged, not reported.
    expect(calls.set).toHaveLength(1)
    expect(calls.globalGets).toBe(0)
    expect(calls.config).toHaveLength(0)
    expect(calls.dispose).toBe(0)
    expect(calls.posts).toContainEqual({ type: "providerConnected", requestId: "req", providerID: "azure" })
    expect(calls.posts.some((message) => (message as { type?: string }).type === "providerActionError")).toBe(false)
  })
})

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
    // LOCK-001: the backend coordinates drain/rebuild — no explicit global.dispose.
    expect(calls.dispose).toBe(0)
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
    // No success message, no dispose on a failed mutation.
    expect(calls.posts.some((message) => (message as { type?: string }).type === "providerConnected")).toBe(false)
    expect(calls.dispose).toBe(0)
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
    expect(calls.dispose).toBe(0)
    expect(calls.posts).toContainEqual({ type: "providerConnected", requestId: "req", providerID: "openai" })
    expect(calls.posts.some((message) => (message as { type?: string }).type === "providerActionError")).toBe(false)
  })
})

describe("saveCustomProvider", () => {
  it("performs exactly one atomic backend save with the sanitized config and preserve auth", async () => {
    const { ctx, calls } = createCtx()

    await saveCustomProvider(ctx, "req", "myprovider", createProvider(), undefined, false)

    // LOCK-001/005: exactly ONE generated customProvider.save call carrying
    // the sanitized config and the resolved auth mode; no split backend calls.
    expect(calls.customProviderSave).toHaveLength(1)
    const call = calls.customProviderSave[0] as {
      providerID: string
      config: Record<string, unknown>
      auth: { mode: string }
      directory?: string
    }
    expect(call.providerID).toBe("myprovider")
    expect(call.directory).toBe("/tmp")
    expect(call.auth).toEqual({ mode: "preserve" })
    expect(call.config).toEqual(createSavedProvider())
    expect(calls.config).toHaveLength(0)
    expect(calls.project).toHaveLength(0)
    expect(calls.set).toHaveLength(0)
    expect(calls.remove).toHaveLength(0)
    // LOCK-005: the backend coordinates drain/rebuild — no explicit dispose.
    expect(calls.dispose).toBe(0)
    // providerConnected is posted only after success, then the provider refresh.
    expect(calls.posts).toContainEqual({ type: "providerConnected", requestId: "req", providerID: "myprovider" })
    expect(calls.refresh).toBe(1)
  })

  it("does not send null sentinels or disabled_providers — the backend computes deletions itself", async () => {
    const existing = {
      disabled_providers: ["myprovider", "openai"],
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
    const { ctx, calls } = createCtx(existing)

    const next = {
      name: "My Provider",
      options: { baseURL: "https://example.com/v1" },
      models: {
        "model-keep": { name: "Keep" },
      },
    }
    await saveCustomProvider(ctx, "req", "myprovider", next, undefined, false)

    expect(calls.customProviderSave).toHaveLength(1)
    const call = calls.customProviderSave[0] as {
      config: Record<string, unknown>
      auth: { mode: string }
    }
    // The payload is the sanitized config without null sentinels: the backend
    // derives removals from the old global entry + new config (LOCK-002).
    const models = call.config.models as Record<string, unknown>
    expect(models["model-keep"]).toBeDefined()
    expect("model-gone" in models).toBe(false)
    expect(Object.values(models).every((value) => value !== null)).toBe(true)
    // disabled_providers cleanup is backend-owned; the save payload never
    // carries it and no separate global config write happens.
    expect("disabled_providers" in call.config).toBe(false)
    expect(calls.config).toHaveLength(0)
    expect(calls.refresh).toBe(1)
  })

  it("stores a changed api key as an auth set in the single save payload", async () => {
    const { ctx, calls } = createCtx()

    await saveCustomProvider(ctx, "req", "myprovider", createProvider(), " sk-test ", true)

    expect(calls.customProviderSave).toHaveLength(1)
    expect((calls.customProviderSave[0] as { auth: { mode: string; key: string } }).auth).toEqual({
      mode: "set",
      key: "sk-test",
    })
    expect(calls.set).toHaveLength(0)
    expect(calls.remove).toHaveLength(0)
    expect(calls.dispose).toBe(0)
  })

  it("clears auth when the api key field was intentionally cleared", async () => {
    const { ctx, calls } = createCtx()

    await saveCustomProvider(ctx, "req", "myprovider", createProvider(), undefined, true)

    expect(calls.customProviderSave).toHaveLength(1)
    expect((calls.customProviderSave[0] as { auth: { mode: string } }).auth).toEqual({ mode: "clear" })
    expect(calls.remove).toHaveLength(0)
  })

  it("never reports a post-success refresh failure as a save failure (LOCK-005)", async () => {
    const { ctx, calls } = createCtx()
    ctx.fetchAndSendProviders = async () => {
      throw new Error("refresh exploded")
    }

    await saveCustomProvider(ctx, "req", "myprovider", createProvider(), " sk-test ", true)

    // The single save response IS the acknowledgement.
    expect(calls.customProviderSave).toHaveLength(1)
    expect(calls.dispose).toBe(0)
    expect(calls.posts).toContainEqual({ type: "providerConnected", requestId: "req", providerID: "myprovider" })
    expect(
      calls.posts.some(
        (message) =>
          (message as { type?: string }).type === "providerActionError" &&
          (message as { action?: string }).action === "connect",
      ),
    ).toBe(false)
  })

  it("reports a backend save failure as a connect error without refresh", async () => {
    const existing = {
      disabled_providers: [],
      provider: {
        myprovider: createSavedProvider(),
      },
    }
    const { ctx, calls } = createCtx(existing)
    ctx.client.customProvider.save = async () => {
      throw new Error("backend exploded")
    }

    await saveCustomProvider(ctx, "req", "myprovider", createProvider(), undefined, false)

    expect(calls.posts).toContainEqual(
      expect.objectContaining({
        type: "providerActionError",
        action: "connect",
        requestId: "req",
        providerID: "myprovider",
      }),
    )
    expect(calls.posts.some((message) => (message as { type?: string }).type === "providerConnected")).toBe(false)
    expect(calls.refresh).toBe(0)
  })

  it("reports a non-success save result as a connect error without refresh", async () => {
    const { ctx, calls } = createCtx()
    ctx.client.customProvider.save = async () => ({ data: { success: false } })

    await saveCustomProvider(ctx, "req", "myprovider", createProvider(), undefined, false)

    expect(calls.posts).toContainEqual(
      expect.objectContaining({
        type: "providerActionError",
        action: "connect",
        requestId: "req",
        providerID: "myprovider",
      }),
    )
    expect(calls.posts.some((message) => (message as { type?: string }).type === "providerConnected")).toBe(false)
    expect(calls.refresh).toBe(0)
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
  it("calls atomic backend endpoint without separate project patch for a custom provider", async () => {
    const existing = {
      disabled_providers: ["myprovider", "openai"],
      provider: {
        myprovider: createSavedProvider(),
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx(existing)

    await deleteCustomProvider(ctx, "req", "myprovider", null, setCachedConfig)

    // Verify atomic backend endpoint was called with directory
    expect(calls.customProviderDelete).toEqual([{ providerID: "myprovider", directory: "/tmp" }])
    // Old separate auth.remove and global.config.update should NOT be called
    expect(calls.remove).toHaveLength(0)
    expect(calls.config).toHaveLength(0)
    // LOCK-001: extension must NOT issue a second project PATCH
    expect(calls.project).toHaveLength(0)
    expect(calls.refresh).toBe(1)
    expect(calls.posts).toContainEqual({ type: "providerDeleted", requestId: "req", providerID: "myprovider" })
  })

  it("calls backend endpoint for project-only custom provider", async () => {
    const merged = {
      provider: {
        myprovider: createSavedProvider(),
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx({ disabled_providers: [] }, merged)

    await deleteCustomProvider(ctx, "req", "myprovider", null, setCachedConfig)

    expect(calls.customProviderDelete).toEqual([{ providerID: "myprovider", directory: "/tmp" }])
    expect(calls.remove).toHaveLength(0)
    expect(calls.config).toHaveLength(0)
    // LOCK-001: extension must NOT issue a second project PATCH
    expect(calls.project).toHaveLength(0)
  })

  it("calls backend endpoint for project-only custom provider with stale disabled ID", async () => {
    const global = { disabled_providers: ["myprovider", "openai"], provider: {} }
    const merged = {
      disabled_providers: ["myprovider", "openai"],
      provider: {
        myprovider: createSavedProvider(),
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx(global, merged)

    await deleteCustomProvider(ctx, "req", "myprovider", null, setCachedConfig)

    // Backend endpoint handles auth + global config + project config atomically
    expect(calls.customProviderDelete).toEqual([{ providerID: "myprovider", directory: "/tmp" }])
    expect(calls.remove).toHaveLength(0)
    expect(calls.config).toHaveLength(0)
    // LOCK-001: extension must NOT issue a second project PATCH
    expect(calls.project).toHaveLength(0)
    expect(calls.posts).toContainEqual({ type: "providerDeleted", requestId: "req", providerID: "myprovider" })
  })

  it("calls backend endpoint for global+project custom provider", async () => {
    const global = { disabled_providers: ["openai"], provider: {} }
    const merged = {
      disabled_providers: ["openai"],
      provider: {
        myprovider: createSavedProvider(),
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx(global, merged)

    await deleteCustomProvider(ctx, "req", "myprovider", null, setCachedConfig)

    // Provider exists in effective config, backend handles everything
    expect(calls.customProviderDelete).toEqual([{ providerID: "myprovider", directory: "/tmp" }])
    // LOCK-001: extension must NOT issue a second project PATCH
    expect(calls.project).toHaveLength(0)
    expect(calls.remove).toHaveLength(0)
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

    expect(calls.customProviderDelete).toHaveLength(0)
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

    // Backend endpoint handles global config; extension does not patch separately
    expect(calls.customProviderDelete).toEqual([{ providerID: "myprovider", directory: "/tmp" }])
    expect(calls.config).toHaveLength(0)
  })

  it("emits providerDeleted after mutation and never reports a refresh failure as a deletion failure", async () => {
    const existing = {
      disabled_providers: [],
      provider: {
        myprovider: createSavedProvider(),
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx(existing)
    ctx.fetchAndSendProviders = async () => {
      throw new Error("refresh exploded")
    }

    await deleteCustomProvider(ctx, "req", "myprovider", null, setCachedConfig)

    // LOCK-004: the mutation is acknowledged by the backend response; the
    // success message is emitted first and is never suppressed by the refresh.
    expect(calls.customProviderDelete).toEqual([{ providerID: "myprovider", directory: "/tmp" }])
    const deleted = calls.posts.filter((message) => (message as { type?: string }).type === "providerDeleted")
    expect(deleted).toEqual([{ type: "providerDeleted", requestId: "req", providerID: "myprovider" }])
    // The refresh failure is surfaced truthfully (logged), never as a delete error.
    expect(
      calls.posts.some(
        (message) =>
          (message as { type?: string }).type === "providerActionError" &&
          (message as { action?: string }).action === "delete",
      ),
    ).toBe(false)
    // Deletion is never retried automatically.
    expect(calls.customProviderDelete).toHaveLength(1)
  })

  it("reports a backend deletion failure as a delete error without refresh", async () => {
    const existing = {
      disabled_providers: [],
      provider: {
        myprovider: createSavedProvider(),
      },
    }
    const { ctx, calls, setCachedConfig } = createCtx(existing)
    ctx.client.customProvider.delete = async () => {
      throw new Error("backend exploded")
    }

    await deleteCustomProvider(ctx, "req", "myprovider", null, setCachedConfig)

    expect(calls.posts).toContainEqual(
      expect.objectContaining({
        type: "providerActionError",
        action: "delete",
        requestId: "req",
        providerID: "myprovider",
      }),
    )
    expect(calls.posts.some((message) => (message as { type?: string }).type === "providerDeleted")).toBe(false)
    expect(calls.refresh).toBe(0)
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

describe("fetchProviderData — credential read authorization predicates", () => {
  it("marks source='api' providers with non-empty key as api auth", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "openai",
                name: "OpenAI",
                source: "api",
                key: "sk-test-key",
                env: [],
                models: {},
              },
            ],
            connected: ["openai"],
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
    expect(result.authStates).toEqual({ openai: "api" })
    // Key is stripped from the response sent to webview
    const item = result.response.all[0] as Record<string, unknown>
    expect("key" in item).toBe(false)
  })

  it("marks source='env' providers with non-empty key as api auth (source filtering is handler-level)", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "envprovider",
                name: "Env Provider",
                source: "env",
                key: "env-key-value",
                env: ["ENV_KEY"],
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
    // fetchProviderData marks any provider with non-empty key as api auth;
    // source filtering (source === "api") is done in handleGetProviderCredential
    expect(result.authStates).toEqual({ envprovider: "api" })
  })

  it("rejects kilo provider from authStates", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "kilo",
                name: "Kilo Gateway",
                source: "config",
                key: "configured",
                env: [],
                models: {},
              },
            ],
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
    // kilo is always deleted from authStates unless kiloAuth sets it
    expect(result.authStates).toEqual({})
  })

  it("rejects providers with empty key from authStates", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "empty-key",
                name: "Empty Key",
                source: "api",
                key: "",
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
