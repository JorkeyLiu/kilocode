import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { CanonicalConfigService } from "../../src/config/service"
import { Roots } from "../../src/config/paths"
import { createMemorySecretAdapter } from "../../src/config/secret-adapter"
import { createMemoryStateAdapter } from "../../src/config/state-adapter"
import { toCanonicalPayload } from "../../src/config/types"
import type { CanonicalConfigEvent, CanonicalConfigError, TypedEmitter, EmitterFactory } from "../../src/config/types"

const { KiloProvider } = await import("../../src/KiloProvider")

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** Create an emitter factory that stores emitters for test access. */
function createTestEmitterFactory(): {
  factory: EmitterFactory
  changeEmitter: TypedEmitter<CanonicalConfigEvent>
  errorEmitter: TypedEmitter<CanonicalConfigError>
} {
  const changeListeners: Array<(e: CanonicalConfigEvent) => void> = []
  const errorListeners: Array<(e: CanonicalConfigError) => void> = []
  let createCount = 0
  const changeEmitter: TypedEmitter<CanonicalConfigEvent> = {
    event: (listener) => {
      changeListeners.push(listener)
      return {
        dispose() {
          const idx = changeListeners.indexOf(listener)
          if (idx >= 0) changeListeners.splice(idx, 1)
        },
      }
    },
    fire: (e) => {
      for (const l of changeListeners) l(e)
    },
    dispose: () => {
      changeListeners.length = 0
    },
  }
  const errorEmitter: TypedEmitter<CanonicalConfigError> = {
    event: (listener) => {
      errorListeners.push(listener)
      return {
        dispose() {
          const idx = errorListeners.indexOf(listener)
          if (idx >= 0) errorListeners.splice(idx, 1)
        },
      }
    },
    fire: (e) => {
      for (const l of errorListeners) l(e)
    },
    dispose: () => {
      errorListeners.length = 0
    },
  }
  return {
    factory: {
      create: <T>() => {
        // CanonicalConfigService creates two emitters in order: onChangeEmitter, onErrorEmitter
        createCount++
        return (createCount === 1 ? changeEmitter : errorEmitter) as unknown as TypedEmitter<T>
      },
    },
    changeEmitter,
    errorEmitter,
  }
}

describe("KiloProvider canonical GUI authority", () => {
  it("strictly validates canonical MCP transport values", () => {
    expect(
      toCanonicalPayload({ mcp: { local: { type: "local", command: "node", args: ["server.js"], enabled: true } } }),
    ).toBeDefined()
    expect(toCanonicalPayload({ mcp: { local: { type: "local", command: ["node", "server.js"] } } })).toBeUndefined()
    expect(toCanonicalPayload({ mcp: { local: { type: "local", args: ["node", 1] } } })).toBeUndefined()
    expect(toCanonicalPayload({ mcp: { remote: { type: "remote", url: 42 } } })).toBeUndefined()
    expect(toCanonicalPayload({ mcp: { local: { environment: { TOKEN: "secret:value" } } } })).toBeUndefined()
    expect(toCanonicalPayload({ provider: { openai: { env: ["OPENAI_API_KEY"] } } })).toBeUndefined()
  })

  it("keeps canonical provider view contracts free of legacy fields", async () => {
    const source = await Bun.file(
      new URL("../../webview-ui/src/types/messages/extension-messages.ts", import.meta.url),
    ).text()
    const block = source.match(/export interface CanonicalProvidersLoadedMessage[\s\S]*?\n}\n/)?.[0] ?? ""
    expect(block).not.toContain("Provider>")
    expect(block).not.toContain("env")
    expect(block).not.toContain("metadata")
    expect(block).not.toContain("headers")
    expect(block).not.toContain("credential")
  })

  it("requires OAuth messages to declare the noncanonical discriminator", async () => {
    const source = await Bun.file(
      new URL("../../webview-ui/src/types/messages/webview-messages.ts", import.meta.url),
    ).text()
    for (const name of ["AuthorizeProviderOAuthMessage", "CompleteProviderOAuthMessage"]) {
      const block = source.match(new RegExp(`export interface ${name}[\\s\\S]*?\\n}\\n`))?.[0] ?? ""
      expect(block).toContain("canonical: false")
    }
  })
  it("keeps canonical provider and credential message contracts plaintext-free", async () => {
    const messages = await Bun.file(
      new URL("../../webview-ui/src/types/messages/webview-messages.ts", import.meta.url),
    ).text()
    const providers = await Bun.file(
      new URL("../../webview-ui/src/types/messages/providers.ts", import.meta.url),
    ).text()
    expect(messages).toContain("export interface CanonicalConnectProviderMessage")
    expect(messages).toContain("credentialRequested: boolean")
    const canonicalConfig = providers.match(/export interface ProviderConfig[\s\S]*?\n}\n/)?.[0] ?? ""
    expect(canonicalConfig).not.toContain("api_key")
    for (const name of ["CanonicalConnectProviderMessage", "CanonicalSaveCustomProviderMessage"]) {
      const block = messages.match(new RegExp(`export interface ${name}[\\s\\S]*?\\n}\\n`))?.[0] ?? ""
      expect(block).not.toMatch(/apiKey\??\s*:/)
    }
    expect(providers).not.toContain("CanonicalProviderConfig")
    const canonicalFetch =
      messages.match(/export interface CanonicalFetchCustomProviderModelsMessage[\s\S]*?\n}\n/)?.[0] ?? ""
    expect(canonicalFetch).not.toContain("headers?: Record<string, string>")
  })

  it("requires canonical success acknowledgements to carry a committed stamp", async () => {
    const messages = await Bun.file(
      new URL("../../webview-ui/src/types/messages/extension-messages.ts", import.meta.url),
    ).text()
    for (const name of [
      "CanonicalProviderConnectedMessage",
      "CanonicalProviderDisconnectedMessage",
      "CanonicalProviderDeletedMessage",
    ]) {
      const block = messages.match(new RegExp(`export interface ${name}[\\s\\S]*?\\n}\\n`))?.[0] ?? ""
      expect(block).toContain("canonical: true")
      expect(block).toContain("stamp: CanonicalStamp")
    }
  })

  it("does not call backend config/provider/agent SDK methods", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-provider-canonical-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ model: "custom/model" }))
    const secrets = createMemorySecretAdapter()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    await canonical.initialize()

    const connection = new KiloConnectionService({} as never)
    const calls: string[] = []
    ;(connection as unknown as { client: unknown }).client = {
      config: {
        get: async () => {
          calls.push("config.get")
          throw new Error("backend config read")
        },
        transaction: async () => {
          calls.push("config.transaction")
          throw new Error("backend config write")
        },
      },
      global: {
        config: {
          get: async () => {
            calls.push("global.config.get")
            throw new Error("backend global read")
          },
        },
      },
      provider: {
        list: async () => {
          calls.push("provider.list")
          throw new Error("backend provider read")
        },
      },
      app: {
        agents: async () => {
          calls.push("app.agents")
          throw new Error("backend agent read")
        },
      },
    }
    const provider = new KiloProvider({} as never, connection, undefined, { canonicalConfig: canonical })
    const internal = provider as unknown as {
      fetchAndSendConfig: () => Promise<void>
      fetchAndSendProviders: () => Promise<void>
      fetchAndSendAgents: () => Promise<void>
      handleUpdateConfigMessage: (message: Record<string, unknown>) => Promise<void>
      postMessage: (message: unknown) => void
    }
    const messages: unknown[] = []
    internal.postMessage = (message) => messages.push(message)

    await internal.fetchAndSendConfig()
    await internal.fetchAndSendProviders()
    await internal.fetchAndSendAgents()
    await internal.handleUpdateConfigMessage({
      type: "updateConfig",
      canonical: true,
      config: { model: "custom/next" },
      projectConfig: {},
      globalUnset: [],
      projectUnset: [],
      stamp: canonical.stamp,
    })

    expect(calls).toEqual([])
    expect(fs.readFileSync(path.join(global, "kilo.jsonc"), "utf8")).toContain("custom/next")
    expect(messages).toContainEqual(expect.objectContaining({ type: "configUpdated", canonical: true }))

    // A legacy non-canonical message is rejected structurally and never
    // reaches the removed SDK transaction path.
    messages.length = 0
    await internal.handleUpdateConfigMessage({ type: "updateConfig", config: { model: "custom/other" } })
    expect(calls).toEqual([])
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "configUpdateFailed", canonical: true, kind: "invalid" }),
    )
    expect(fs.readFileSync(path.join(global, "kilo.jsonc"), "utf8")).not.toContain("custom/other")
    provider.dispose()
    canonical.dispose()
  })

  it("routes canonical MCP removal through stamped JSONC mutation", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const block = source.match(/private async handleRemoveMcp[\s\S]*?private async refreshMcpStatus/)?.[0] ?? ""
    expect(block).toContain("writeConfigScopes")
    expect(block).toContain("sameStamp(stamp, service.stamp)")
    expect(block).toContain('type: "mcpCleanupError"')
    expect(block).toContain("removeSecretRef(ref)")
    expect(source).toContain("private async retryCanonicalMcpCleanup")
    expect(source).toContain('type: "mcpCleanupRetryResult"')
  })

  it("keeps canonical config/provider payloads narrow and credential-free", async () => {
    const extension = await Bun.file(
      new URL("../../webview-ui/src/types/messages/extension-messages.ts", import.meta.url),
    ).text()
    const webview = await Bun.file(
      new URL("../../webview-ui/src/types/messages/webview-messages.ts", import.meta.url),
    ).text()
    const types = await Bun.file(new URL("../../src/config/types.ts", import.meta.url)).text()
    expect(extension.match(/CanonicalConfigLoadedMessage[\s\S]*?\n}/)?.[0]).toContain("CanonicalConfigPayload")
    expect(webview.match(/CanonicalUpdateConfigMessage[\s\S]*?\n}/)?.[0]).toContain("CanonicalConfigPayload")
    expect(types).toContain("interface CanonicalProviderPayload")
    expect(types).toContain("interface CanonicalMcpPayload")
    // Check interface body (after the opening brace) for credential field declarations, not comments
    const providerBody = types.match(/interface CanonicalProviderPayload\s*\{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(providerBody).not.toMatch(/^\s*(readonly\s+)?credential[\s:]/m)
    expect(providerBody).not.toMatch(/^\s*(readonly\s+)?headers[\s:]/m)
  })

  it("leaves UI-local settings editable in canonical mode", async () => {
    const source = await Bun.file(
      new URL("../../webview-ui/src/components/settings/BrowserTab.tsx", import.meta.url),
    ).text()
    const display = await Bun.file(
      new URL("../../webview-ui/src/components/settings/DisplayTab.tsx", import.meta.url),
    ).text()
    expect(source).toContain('type: "updateSetting"')
    expect(display).toContain("display.setFontSize")
    expect(display).toContain("fontSize")
  })
})

// ── LOCK-1: Canonical provider recursive validation ────────────────

describe("LOCK-1: Canonical provider recursive validation", () => {
  it("rejects provider with legacy npm field", () => {
    expect(toCanonicalPayload({ provider: { openai: { npm: "@ai-sdk/openai", name: "OpenAI" } } })).toBeUndefined()
  })

  it("rejects provider with legacy env field", () => {
    expect(toCanonicalPayload({ provider: { openai: { env: ["OPENAI_API_KEY"] } } })).toBeUndefined()
  })

  it("rejects provider with legacy options/baseURL field", () => {
    expect(
      toCanonicalPayload({ provider: { openai: { options: { baseURL: "https://api.openai.com" } } } }),
    ).toBeUndefined()
  })

  it("rejects provider with legacy apiKey field", () => {
    expect(toCanonicalPayload({ provider: { openai: { apiKey: "sk-test" } } })).toBeUndefined()
  })

  it("rejects provider with legacy headers field", () => {
    expect(toCanonicalPayload({ provider: { openai: { headers: { Authorization: "Bearer x" } } } })).toBeUndefined()
  })

  it("rejects model with unknown nested key", () => {
    expect(
      toCanonicalPayload({
        provider: { openai: { models: { "gpt-4": { name: "GPT-4", headers: { "x-key": "val" } } } } },
      }),
    ).toBeUndefined()
  })

  it("rejects model with npm key", () => {
    expect(
      toCanonicalPayload({ provider: { openai: { models: { "gpt-4": { name: "GPT-4", npm: "malicious" } } } } }),
    ).toBeUndefined()
  })

  it("rejects model with credentials key", () => {
    expect(
      toCanonicalPayload({ provider: { openai: { models: { "gpt-4": { name: "GPT-4", credential: "secret:x" } } } } }),
    ).toBeUndefined()
  })

  it("accepts provider with exact canonical fields", () => {
    const result = toCanonicalPayload({
      provider: {
        openai: {
          name: "OpenAI",
          endpoint: "https://api.openai.com/v1",
          protocol: "openai/completions",
          models: { "gpt-4": { name: "GPT-4" } },
        },
      },
    })
    expect(result).toBeDefined()
    expect(result!.provider!.openai!.name).toBe("OpenAI")
    expect(result!.provider!.openai!.endpoint).toBe("https://api.openai.com/v1")
    expect(result!.provider!.openai!.protocol).toBe("openai/completions")
  })

  it("accepts model with approved optional fields (reasoning, modalities, variants)", () => {
    const result = toCanonicalPayload({
      provider: {
        openai: {
          models: {
            o3: {
              name: "O3",
              reasoning: true,
              modalities: { input: ["text"], output: ["text"] },
              variants: { thinking: { enable_thinking: true } },
            },
          },
        },
      },
    })
    expect(result).toBeDefined()
    expect(result!.provider!.openai!.models!["o3"]!.reasoning).toBe(true)
  })

  it("accepts the three canonical protocols and rejects legacy tokens", () => {
    for (const protocol of ["openai/completions", "openai/responses", "anthropic/messages"]) {
      const result = toCanonicalPayload({
        provider: { custom: { name: "C", endpoint: "https://api.example.com/v1", protocol, models: { m1: { name: "M1" } } } },
      })
      expect(result).toBeDefined()
      expect(result!.provider!.custom!.protocol).toBe(protocol)
    }
    for (const protocol of ["openai", "anthropic", "google", "azure", "ollama", "custom"]) {
      expect(
        toCanonicalPayload({
          provider: { custom: { name: "C", endpoint: "https://api.example.com/v1", protocol, models: { m1: { name: "M1" } } } },
        }),
      ).toBeUndefined()
    }
  })
})

// ── LOCK-3: No Kilo fallback selection ──────────────────────────────

describe("LOCK-3: No Kilo fallback selection", () => {
  it("provider index default selection is empty string when no provider matches", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-canonical-fallback-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ model: "anthropic/claude-sonnet-4-20250514" }))
    const secrets = createMemorySecretAdapter()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    await canonical.initialize()

    const connection = new KiloConnectionService({} as never)
    const provider = new KiloProvider({} as never, connection, undefined, { canonicalConfig: canonical })
    const internal = provider as unknown as {
      fetchAndSendProviders: () => Promise<void>
      postMessage: (message: unknown) => void
    }
    const messages: unknown[] = []
    internal.postMessage = (message) => messages.push(message)
    await internal.fetchAndSendProviders()

    const providersMsg = messages.find((m) => (m as Record<string, unknown>).type === "providersLoaded") as
      | Record<string, unknown>
      | undefined
    expect(providersMsg).toBeDefined()
    const defaultSelection = providersMsg!.defaultSelection as Record<string, unknown>
    // Never "kilo" — always empty string when no provider matches
    expect(defaultSelection.providerID).not.toBe("kilo")
    provider.dispose()
    canonical.dispose()
  })

  it("session configuredFallback returns null in canonical mode when no providers", async () => {
    const source = await Bun.file(new URL("../../webview-ui/src/context/session.tsx", import.meta.url)).text()
    // configuredFallback must gate KILO_AUTO behind canonical check
    const fallbackBlock = source.match(/function configuredFallback[\s\S]*?\n  \}/)?.[0] ?? ""
    expect(fallbackBlock).toContain("canonical?.()")
    expect(fallbackBlock).toContain("null")
    // Must not unconditionally return KILO_AUTO
    expect(fallbackBlock).not.toMatch(/return KILO_AUTO(?!\s*\))/)
  })
})

// ── LOCK-4: Narrow canonical state ──────────────────────────────────

describe("LOCK-4: Narrow canonical state", () => {
  it("CanonicalConfigPayload type does not include credential or headers", async () => {
    const types = await Bun.file(new URL("../../src/config/types.ts", import.meta.url)).text()
    // CanonicalProviderPayload must not have credential or headers field declarations
    const providerBody = types.match(/interface CanonicalProviderPayload\s*\{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(providerBody).not.toMatch(/^\s*(readonly\s+)?credential[\s:]/m)
    expect(providerBody).not.toMatch(/^\s*(readonly\s+)?headers[\s:]/m)
    // CanonicalMcpPayload must not have environment or oauth field declarations
    const mcpBody = types.match(/interface CanonicalMcpPayload\s*\{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(mcpBody).not.toMatch(/^\s*(readonly\s+)?environment[\s:]/m)
    expect(mcpBody).not.toMatch(/^\s*(readonly\s+)?oauth[\s:]/m)
  })

  it("toCanonicalPayload returns undefined for any non-canonical top-level key", () => {
    expect(toCanonicalPayload({ npm: "@ai-sdk/openai" })).toBeUndefined()
    expect(toCanonicalPayload({ env: ["KEY"] })).toBeUndefined()
    expect(toCanonicalPayload({ options: {} })).toBeUndefined()
    expect(toCanonicalPayload({ headers: {} })).toBeUndefined()
    expect(toCanonicalPayload({ credential: "secret:x" })).toBeUndefined()
  })

  it("toCanonicalPayload returns undefined for MCP with environment field", () => {
    expect(
      toCanonicalPayload({ mcp: { local: { type: "local", command: "node", environment: { TOKEN: "val" } } } }),
    ).toBeUndefined()
  })

  it("toCanonicalPayload returns undefined for MCP with oauth field", () => {
    expect(
      toCanonicalPayload({ mcp: { remote: { type: "remote", url: "https://example.com", oauth: true } } }),
    ).toBeUndefined()
  })
})

// ── LOCK-5: MCP cleanup retry contract ─────────────────────────────

describe("LOCK-5: MCP cleanup retry contract", () => {
  it("KiloProvider has retryCanonicalMcpCleanup method", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    expect(source).toContain("private async retryCanonicalMcpCleanup")
    // Must validate stamp with sameStamp
    expect(source).toContain("sameStamp(stamp, service.stamp)")
    // Must reject stale requests
    expect(source).toContain("MCP cleanup retry is stale")
    // Must send one-shot result
    expect(source).toContain('type: "mcpCleanupRetryResult"')
  })

  it("handleRemoveMcp sends mcpCleanupError on secret deletion failure", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const block = source.match(/private async handleRemoveMcp[\s\S]*?private async refreshMcpStatus/)?.[0] ?? ""
    expect(block).toContain('type: "mcpCleanupError"')
    expect(block).toContain("retryID:")
    expect(block).toContain("stamp: service.stamp")
    // Must clean up the secret ref
    expect(block).toContain("removeSecretRef(ref)")
  })

  it("retryCanonicalMcpCleanup validates ref format before cleaning", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const block =
      source.match(/private async retryCanonicalMcpCleanup[\s\S]*?private async refreshMcpStatus/)?.[0] ?? ""
    // Must parse the secret key to validate scope and kind
    expect(block).toContain("parseSecretKey")
    expect(block).toContain('parsed.kind !== "mcp"')
    // Must use stored ref from the retry map, never accept webview-provided ref
    expect(block).toContain("stored.ref")
    expect(block).toContain("cleanupRetries.get")
    // Must delete the stored record on success
    expect(block).toContain("cleanupRetries.delete")
  })

  it("provider and MCP retry records are keyed by operation-unique opaque IDs", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    // Provider records are keyed by a true operation-unique opaque ID — never a
    // deterministic scope/id-derived key that overlapping failures could share.
    expect(source).toContain('const retryID = retry ? crypto.randomUUID() : ""')
    expect(source).toContain("this.cleanupRetries.set(retryID, record)")
    // MCP records use the same operation-unique ID at store time.
    expect(source).toContain("const retryID = crypto.randomUUID()")
    expect(source).toContain("this.cleanupRetries.set(retryID, {")
    // Stored records carry an explicit kind discriminator so provider/MCP cannot collide.
    expect(source).toContain('kind: "provider"')
    expect(source).toContain('kind: "mcp"')
    // Retry handlers look up by the opaque retryID only (never reconstruct keys
    // from webview-provided scope/name), and require the stored kind to match.
    const providerBlock =
      source.match(
        /private async retryCanonicalProviderCleanup[\s\S]*?private async handleCanonicalConfigUpdate/,
      )?.[0] ?? ""
    expect(providerBlock).toContain("cleanupRetries.get(retryID)")
    expect(providerBlock).toContain('retry.kind !== "provider"')
    expect(providerBlock).toContain("cleanupRetries.delete(retryID)")
    const mcpBlock =
      source.match(/private async retryCanonicalMcpCleanup[\s\S]*?private async refreshMcpStatus/)?.[0] ?? ""
    expect(mcpBlock).toContain("cleanupRetries.get(retryID)")
    expect(mcpBlock).toContain('stored.kind !== "mcp"')
    expect(mcpBlock).toContain("cleanupRetries.delete(retryID)")
  })

  it("retry reserves inFlight before the side effect and consumes on success", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    // Provider retry: reserve (set inFlight) before any await of the side effect,
    // delete on success, restore available on failure.
    const providerBlock =
      source.match(
        /private async retryCanonicalProviderCleanup[\s\S]*?private async handleCanonicalConfigUpdate/,
      )?.[0] ?? ""
    expect(providerBlock).toContain('state: "inFlight"')
    expect(providerBlock).toContain('state: "available"')
    expect(providerBlock.indexOf("cleanupRetries.set")).toBeLessThan(
      providerBlock.indexOf("await service.removeSecretRef"),
    )
    expect(providerBlock.indexOf("cleanupRetries.get")).toBeLessThan(providerBlock.indexOf("cleanupRetries.delete"))
    // MCP retry: reserve (set inFlight) before the side effect, consume on success.
    const mcpBlock =
      source.match(/private async retryCanonicalMcpCleanup[\s\S]*?private async refreshMcpStatus/)?.[0] ?? ""
    expect(mcpBlock).toContain('state: "inFlight"')
    expect(mcpBlock).toContain('state: "available"')
    expect(mcpBlock.indexOf("cleanupRetries.set")).toBeLessThan(mcpBlock.indexOf("await service.removeSecretRef"))
    expect(mcpBlock.indexOf("cleanupRetries.get")).toBeLessThan(mcpBlock.indexOf("cleanupRetries.delete"))
  })
})

// ── LOCK-6: Strict MCP UI/schema ───────────────────────────────────

describe("LOCK-6: Strict MCP UI/schema", () => {
  it("CanonicalMcpPayload rejects environment field", () => {
    expect(
      toCanonicalPayload({ mcp: { local: { type: "local", command: "node", environment: { TOKEN: "x" } } } }),
    ).toBeUndefined()
  })

  it("CanonicalMcpPayload rejects oauth field", () => {
    expect(
      toCanonicalPayload({ mcp: { remote: { type: "remote", url: "https://x.com", oauth: true } } }),
    ).toBeUndefined()
  })

  it("CanonicalMcpPayload rejects args with non-string items", () => {
    expect(
      toCanonicalPayload({ mcp: { local: { type: "local", command: "node", args: ["--port", 3000] } } }),
    ).toBeUndefined()
  })

  it("CanonicalMcpPayload rejects url with non-string value", () => {
    expect(toCanonicalPayload({ mcp: { remote: { type: "remote", url: 42 } } })).toBeUndefined()
  })

  it("CanonicalMcpPayload rejects command with non-string value", () => {
    expect(toCanonicalPayload({ mcp: { local: { type: "local", command: ["node", "server.js"] } } })).toBeUndefined()
  })

  it("CanonicalMcpPayload accepts exact canonical fields", () => {
    const local = toCanonicalPayload({
      mcp: { local: { type: "local", command: "node", args: ["server.js"], enabled: true } },
    })
    expect(local).toBeDefined()
    expect(local!.mcp!.local!.command).toBe("node")
    expect(local!.mcp!.local!.args).toEqual(["server.js"])

    const remote = toCanonicalPayload({
      mcp: { remote: { type: "remote", url: "https://example.com/sse", enabled: true } },
    })
    expect(remote).toBeDefined()
    expect(remote!.mcp!.remote!.url).toBe("https://example.com/sse")
  })

  it("McpEditView disables remove button and edit controls in canonical mode", async () => {
    const source = await Bun.file(
      new URL("../../webview-ui/src/components/settings/McpEditView.tsx", import.meta.url),
    ).text()
    // Remove button must be wrapped in Show when={!canonical?.()}
    expect(source).toContain("<Show when={!canonical?.()}>")
    // Command/url fields must be disabled in canonical mode
    expect(source).toContain("disabled={canonical?.() === true}")
    // Environment section must be hidden in canonical mode
    expect(source).toContain('Show when={transport() === "local" && !canonical?.()}')
  })
})

// ── LOCK-2: Canonical custom-provider save/discovery boundary ──────

describe("LOCK-2: Canonical custom-provider save/discovery boundary", () => {
  it("serializeCanonicalProvider produces only {name, endpoint, protocol, models}", async () => {
    const source = await Bun.file(
      new URL("../../webview-ui/src/components/settings/CustomProviderValidation.ts", import.meta.url),
    ).text()
    expect(source).toContain("export function serializeCanonicalProvider")
    // Must return CanonicalProviderPayload
    expect(source).toContain("CanonicalProviderPayload")
    // Must NOT produce npm/options/headers/env
    const fnBlock = source.match(/export function serializeCanonicalProvider[\s\S]*?\n\}/)?.[0] ?? ""
    expect(fnBlock).not.toContain("npm")
    expect(fnBlock).not.toContain("options")
    expect(fnBlock).not.toContain("headers")
    expect(fnBlock).not.toContain("env")
  })

  it("CustomProviderDialog canonical save uses serializeCanonicalProvider", async () => {
    const source = await Bun.file(
      new URL("../../webview-ui/src/components/settings/CustomProviderDialog.tsx", import.meta.url),
    ).text()
    expect(source).toContain("serializeCanonicalProvider")
    // Canonical-only save: non-canonical UI surfaces an explicit
    // unsupported error and never sends the removed legacy message.
    expect(source).toContain("isCanonical()")
    expect(source).toContain("canonicalConfig")
    expect(source).toContain("Provider mutations are canonical-only")
    expect(source).not.toContain("apiKeyChanged")
  })

  it("CustomProviderDialog does not invoke legacy serializer for canonical save", async () => {
    const source = await Bun.file(
      new URL("../../webview-ui/src/components/settings/CustomProviderDialog.tsx", import.meta.url),
    ).text()
    // Canonical-only save: serializeCanonicalProvider is the sole config path.
    const saveBlock = source.match(/function save[\s\S]*?action\.send/)?.[0] ?? ""
    expect(saveBlock).toContain("serializeCanonicalProvider")
    expect(saveBlock).toContain("canonicalConfig")
    expect(saveBlock).not.toContain("apiKeyChanged")
  })
})

// ── LOCK-7: Canonical Kilo selection isolation ───────────────────────

describe("LOCK-7: Canonical Kilo selection isolation", () => {
  it("KiloProvider.selectKiloModel returns early when canonicalConfig is set", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-canonical-select-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ model: "custom/model" }))
    const secrets = createMemorySecretAdapter()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    await canonical.initialize()

    const connection = new KiloConnectionService({} as never)
    const provider = new KiloProvider({} as never, connection, undefined, { canonicalConfig: canonical })
    const messages: unknown[] = []
    const internal = provider as unknown as {
      postMessage: (message: unknown) => void
      pendingKiloModel: { modelID?: string; agent?: string } | null
    }
    internal.postMessage = (message) => messages.push(message)
    internal.pendingKiloModel = null

    // selectKiloModel must be a no-op in canonical mode
    provider.selectKiloModel("test-model", "test-agent")
    expect(internal.pendingKiloModel).toBeNull()
    expect(messages).toHaveLength(0)

    provider.dispose()
    canonical.dispose()
  })

  it("webview selectKiloModel guards canonical?.() check", async () => {
    const source = await Bun.file(new URL("../../webview-ui/src/context/session.tsx", import.meta.url)).text()
    const fnBlock = source.match(/function selectKiloModel[\s\S]*?setPendingKiloModel/)?.[0] ?? ""
    expect(fnBlock).toContain("canonical?.()")
  })
})

// ── LOCK-8: Canonical handler typed provider record ──────────────────

describe("LOCK-8: Canonical handler typed provider record", () => {
  it("handleCanonicalProviderAction uses parseCanonicalProviderRecord for provider access", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const block =
      source.match(
        /private async handleCanonicalProviderAction[\s\S]*?private async retryCanonicalProviderCleanup/,
      )?.[0] ?? ""
    // Must use the typed accessor, not bare Record<string, unknown> spread
    expect(block).toContain("parseCanonicalProviderRecord")
    expect(block).toContain("narrowProviderEntry")
  })

  it("retryCanonicalProviderCleanup uses parseCanonicalProviderRecord for scope config", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const block =
      source.match(
        /private async retryCanonicalProviderCleanup[\s\S]*?private async handleCanonicalConfigUpdate/,
      )?.[0] ?? ""
    expect(block).toContain("parseCanonicalProviderRecord")
  })

  it("types.ts exports parseCanonicalProviderRecord and narrowProviderEntry", async () => {
    const source = await Bun.file(new URL("../../src/config/types.ts", import.meta.url)).text()
    expect(source).toContain("export function parseCanonicalProviderRecord")
    expect(source).toContain("export function narrowProviderEntry")
  })
})

// ── LOCK-9: Retry-record identity validation ─────────────────────────

describe("LOCK-9: Retry-record identity validation", () => {
  it("retryCanonicalProviderCleanup rejects mismatched or in-flight stored records", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const block =
      source.match(
        /private async retryCanonicalProviderCleanup[\s\S]*?private async handleCanonicalConfigUpdate/,
      )?.[0] ?? ""
    // Must reject stored records of the wrong kind
    expect(block).toContain('retry.kind !== "provider"')
    // Must reject already-reserved (inFlight) records — one-shot concurrency
    expect(block).toContain('retry.state !== "available"')
    // Must require the stored stamp to equal the current service stamp
    expect(block).toContain("sameStamp(retry.stamp, service.stamp)")
    // Must reject stale records
    expect(block).toContain("Provider cleanup retry is stale")
  })

  it("provider and MCP retry records are keyed by opaque operation-unique IDs", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    // Provider records use an operation-unique opaque ID at store time.
    expect(source).toContain('const retryID = retry ? crypto.randomUUID() : ""')
    expect(source).toContain("this.cleanupRetries.set(retryID, record)")
    // MCP records use the same operation-unique opaque ID at store time.
    expect(source).toContain("const retryID = crypto.randomUUID()")
    expect(source).toContain("this.cleanupRetries.set(retryID, {")
    // Both records carry the kind discriminator
    expect(source).toContain('kind: "provider"')
    expect(source).toContain('kind: "mcp"')
  })

  it("retry reserves inFlight before the side effect and consumes on success", async () => {
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const providerBlock =
      source.match(
        /private async retryCanonicalProviderCleanup[\s\S]*?private async handleCanonicalConfigUpdate/,
      )?.[0] ?? ""
    expect(providerBlock.indexOf("cleanupRetries.get")).toBeLessThan(providerBlock.indexOf("cleanupRetries.set"))
    expect(providerBlock.indexOf("cleanupRetries.set")).toBeLessThan(providerBlock.indexOf("cleanupRetries.delete"))
    const mcpBlock =
      source.match(/private async retryCanonicalMcpCleanup[\s\S]*?private async refreshMcpStatus/)?.[0] ?? ""
    expect(mcpBlock.indexOf("cleanupRetries.get")).toBeLessThan(mcpBlock.indexOf("cleanupRetries.set"))
    expect(mcpBlock.indexOf("cleanupRetries.set")).toBeLessThan(mcpBlock.indexOf("cleanupRetries.delete"))
  })
})

// ── P4.1 Behavior Tests: direct runtime state verification ─────────

describe("P4.1 behavior: canonical:false/missing mutation rejection", () => {
  it("handleProviderAction rejects connectProvider without canonical discriminator", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-p41-behavior-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ model: "custom/model" }))
    const secrets = createMemorySecretAdapter()
    const emitters = createTestEmitterFactory()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
      emitterFactory: emitters.factory,
    })
    await canonical.initialize()

    const connection = new KiloConnectionService({} as never)
    const provider = new KiloProvider({} as never, connection, undefined, { canonicalConfig: canonical })
    const messages: unknown[] = []
    const internal = provider as unknown as {
      handleProviderAction: (msg: Record<string, unknown>) => Promise<void>
      postMessage: (message: unknown) => void
      canonicalReady: boolean
    }
    internal.postMessage = (msg) => messages.push(msg)
    internal.canonicalReady = true

    // connectProvider without canonical:true must be rejected
    await internal.handleProviderAction({
      type: "connectProvider",
      providerID: "openai",
      requestId: "r1",
      credentialRequested: false,
    })
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "providerActionError",
        providerID: "openai",
        kind: "invalid",
        message: expect.stringContaining("missing the canonical discriminator"),
      }),
    )

    // disconnectProvider without canonical:true must be rejected
    messages.length = 0
    await internal.handleProviderAction({ type: "disconnectProvider", providerID: "openai", requestId: "r2" })
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "providerActionError",
        providerID: "openai",
        kind: "invalid",
      }),
    )

    // deleteCustomProvider without canonical:true must be rejected
    messages.length = 0
    await internal.handleProviderAction({ type: "deleteCustomProvider", providerID: "openai", requestId: "r3" })
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "providerActionError",
        providerID: "openai",
        kind: "invalid",
      }),
    )

    provider.dispose()
    canonical.dispose()
  })

  it("handleWebviewMessage rejects removeAgent without canonical discriminator", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-p41-agent-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ model: "custom/model" }))
    const secrets = createMemorySecretAdapter()
    const emitters = createTestEmitterFactory()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
      emitterFactory: emitters.factory,
    })
    await canonical.initialize()

    const connection = new KiloConnectionService({} as never)
    const provider = new KiloProvider({} as never, connection, undefined, { canonicalConfig: canonical })
    const messages: unknown[] = []
    const internal = provider as unknown as {
      handleRemoveAgent: (
        name: string,
        scope?: "global" | "project",
        expectedHash?: string,
        stamp?: import("../../src/config/types").CanonicalStamp,
      ) => Promise<void>
      handleCanonicalAgentMutation: (msg: Record<string, unknown>) => Promise<void>
      postMessage: (message: unknown) => void
      canonicalReady: boolean
      canonicalConfig: import("../../src/config/service").CanonicalConfigService | null
    }
    internal.postMessage = (msg) => messages.push(msg)
    internal.canonicalReady = true

    // removeAgent without canonical:true — the message handler gate rejects it.
    // Agent mutations are canonical-only with no legacy authority: the gate
    // is unconditional (no canonicalConfig precondition).
    const source = await Bun.file(new URL("../../src/KiloProvider.ts", import.meta.url)).text()
    const removeAgentBlock = source.match(/case "removeAgent":\s*\{[\s\S]*?case "mutateAgent"/)?.[0] ?? ""
    expect(removeAgentBlock).toContain("message.canonical !== true")
    expect(removeAgentBlock).not.toContain("this.canonicalConfig && message.canonical !== true")
    expect(removeAgentBlock).toContain("agentMutationError")
    expect(removeAgentBlock).toContain("missing the canonical discriminator")

    const mutateAgentBlock = source.match(/case "mutateAgent":\s*\{[\s\S]*?case "removeMcp"/)?.[0] ?? ""
    expect(mutateAgentBlock).toContain("message.canonical !== true")
    expect(mutateAgentBlock).not.toContain("this.canonicalConfig && message.canonical !== true")
    expect(mutateAgentBlock).toContain("agentMutationError")
    expect(mutateAgentBlock).toContain("missing the canonical discriminator")

    provider.dispose()
    canonical.dispose()
  })
})

describe("P4.1 behavior: sticky canonicalMode ignores legacy payloads", () => {
  it("KiloProvider.onCanonicalChange sends canonical messages only", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-p41-sticky-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ model: "custom/model" }))
    const secrets = createMemorySecretAdapter()
    const emitters = createTestEmitterFactory()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
      emitterFactory: emitters.factory,
    })
    await canonical.initialize()

    const connection = new KiloConnectionService({} as never)
    const provider = new KiloProvider({} as never, connection, undefined, { canonicalConfig: canonical })
    const messages: unknown[] = []
    const internal = provider as unknown as {
      postMessage: (message: unknown) => void
      isWebviewReady: boolean
      canonicalReady: boolean
    }
    internal.postMessage = (msg) => messages.push(msg)
    internal.isWebviewReady = true
    internal.canonicalReady = true

    // Trigger a canonical change event
    emitters.changeEmitter.fire({ source: "file", hasErrors: false, errors: [] })

    // All messages must carry canonical:true
    const configMsg = messages.find(
      (m) =>
        (m as Record<string, unknown>).type === "configLoaded" ||
        (m as Record<string, unknown>).type === "configUpdated",
    )
    expect(configMsg).toBeDefined()
    expect((configMsg as Record<string, unknown>).canonical).toBe(true)

    provider.dispose()
    canonical.dispose()
  })

  it("readiness mirrors service materializationReady on subscribe after error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-p41-mirror-ready-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ model: "custom/model" }))
    const secrets = createMemorySecretAdapter()
    const emitters = createTestEmitterFactory()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
      emitterFactory: emitters.factory,
    })
    await canonical.initialize()

    const connection = new KiloConnectionService({} as never)
    const provider = new KiloProvider({} as never, connection, undefined, { canonicalConfig: canonical })
    const internal = provider as unknown as {
      postMessage: (message: unknown) => void
      isWebviewReady: boolean
      canonicalReady: boolean
    }
    internal.postMessage = () => {}
    internal.isWebviewReady = true

    // onCanonicalError reads service.materializationReady — when the service
    // still considers itself ready (direct emitter bypass), provider stays ready
    emitters.errorEmitter.fire({ kind: "validation", message: "test error", errors: [] })
    expect(internal.canonicalReady).toBe(canonical.materializationReady)
    expect(internal.canonicalReady).toBe(true)

    // Simulate the service clearing readiness (as materializeFromDisk does
    // before emitting errors in production) then fire error again
    ;(canonical as unknown as { successfulMaterializationStamp: null }).successfulMaterializationStamp = null
    emitters.errorEmitter.fire({ kind: "validation", message: "test error 2", errors: [] })
    expect(internal.canonicalReady).toBe(false)
    expect(internal.canonicalReady).toBe(canonical.materializationReady)

    // Re-subscribing mirrors service.materializationReady
    ;(provider as unknown as { subscribeCanonical: () => void }).subscribeCanonical()
    expect(internal.canonicalReady).toBe(canonical.materializationReady)

    provider.dispose()
    canonical.dispose()
  })
})

describe("P4.1 behavior: readiness clears on error, reopens on error-free", () => {
  it("onCanonicalError mirrors service materializationReady", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-p41-ready-clear-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ model: "custom/model" }))
    const secrets = createMemorySecretAdapter()
    const emitters = createTestEmitterFactory()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
      emitterFactory: emitters.factory,
    })
    await canonical.initialize()

    const connection = new KiloConnectionService({} as never)
    const provider = new KiloProvider({} as never, connection, undefined, { canonicalConfig: canonical })
    const messages: unknown[] = []
    const internal = provider as unknown as {
      postMessage: (message: unknown) => void
      isWebviewReady: boolean
      canonicalReady: boolean
    }
    internal.postMessage = (msg) => messages.push(msg)
    internal.isWebviewReady = true
    internal.canonicalReady = true

    // Simulate service clearing readiness before error (as materializeFromDisk
    // does in production at line 1545) — then error reads the cleared fact
    ;(canonical as unknown as { successfulMaterializationStamp: null }).successfulMaterializationStamp = null
    emitters.errorEmitter.fire({ kind: "validation", message: "test error", errors: [] })
    expect(internal.canonicalReady).toBe(false)
    expect(internal.canonicalReady).toBe(canonical.materializationReady)

    // Should publish canonicalConfigError
    expect(messages).toContainEqual(expect.objectContaining({ type: "canonicalConfigError" }))

    // Error-free event should reopen readiness — simulate the service having
    // completed a successful materialization (restamps before firing change)
    messages.length = 0
    ;(canonical as unknown as { successfulMaterializationStamp: object }).successfulMaterializationStamp = {}
    emitters.changeEmitter.fire({ source: "file", hasErrors: false, errors: [] })
    expect(internal.canonicalReady).toBe(true)

    provider.dispose()
    canonical.dispose()
  })
})

describe("P4.1 behavior: webview ready→error/not-ready→recovery", () => {
  it("webview config context sets canonical false on ready:false and canonicalConfigError", async () => {
    // Test the isCanonicalReady and config context behavior by examining
    // the config context source for the ready:false handling
    const configSource = await Bun.file(new URL("../../webview-ui/src/context/config.tsx", import.meta.url)).text()

    // applyConfigUpdated must call applyCanonicalState which handles ready:false
    expect(configSource).toContain("applyCanonicalState")

    // applyCanonicalState helper must handle ready:false
    const canonicalStateBlock = configSource.match(/function applyCanonicalState[\s\S]*?\n  \}/)?.[0] ?? ""
    expect(canonicalStateBlock).toContain("message.canonical && message.ready === false")
    expect(canonicalStateBlock).toContain("setCanonical(false)")

    // canonicalConfigError must close readiness
    expect(configSource).toContain('message.type === "canonicalConfigError"')
    expect(configSource).toContain("setCanonical(false)")
  })

  it("webview provider context handles ready:false and canonicalConfigError", async () => {
    const providerSource = await Bun.file(new URL("../../webview-ui/src/context/provider.tsx", import.meta.url)).text()

    // providersLoaded handler must handle ready:false
    expect(providerSource).toContain("message.ready === false")
    expect(providerSource).toContain("setCanonical(false)")

    // canonicalConfigError must close readiness
    expect(providerSource).toContain('message.type === "canonicalConfigError"')
    expect(providerSource).toContain("setCanonical(false)")
  })

  it("webview session context ignores legacy agentsLoaded when canonicalMode is active", async () => {
    const sessionSource = await Bun.file(new URL("../../webview-ui/src/context/session.tsx", import.meta.url)).text()

    // agentsLoaded handler must guard against noncanonical when canonicalMode is active
    const agentsBlock = sessionSource.match(/message\.type !== "agentsLoaded"[\s\S]*?setAgents/)?.[0] ?? ""
    expect(agentsBlock).toContain("canonicalMode")
    expect(agentsBlock).toContain("!message.canonical")
  })
})

describe("P4.1 behavior: canonicalMode is sticky and never resets", () => {
  it("config context never resets canonicalMode to false", async () => {
    const configSource = await Bun.file(new URL("../../webview-ui/src/context/config.tsx", import.meta.url)).text()
    // canonicalMode should only be set to true, never to false
    const setCanonicalModeCalls = configSource.match(/setCanonicalMode\((?!true)[^)]+\)/g) ?? []
    expect(setCanonicalModeCalls).toHaveLength(0)
  })

  it("provider context never resets canonicalMode to false", async () => {
    const providerSource = await Bun.file(new URL("../../webview-ui/src/context/provider.tsx", import.meta.url)).text()
    const setCanonicalModeCalls = providerSource.match(/setCanonicalMode\((?!true)[^)]+\)/g) ?? []
    expect(setCanonicalModeCalls).toHaveLength(0)
  })
})
