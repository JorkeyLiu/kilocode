import { describe, expect, it } from "bun:test"
import path from "path"
import { fetchProviderData } from "../../src/provider-actions"

async function src(rel: string) {
  return Bun.file(path.join(import.meta.dir, rel)).text()
}

describe("provider catalog call-site lock", () => {
  it("regular reads use catalog; no production caller uses provider.list", async () => {
    const actions = await src("../../src/provider-actions.ts")
    expect(actions).toContain("fetchProviderCatalogPrivateFirst")
    expect(actions).not.toContain("client.provider.list")
    expect(actions).not.toContain("raw.key")
    expect(actions).not.toContain("authorizeCredentialRead")
    expect(actions).toContain("hasCredential")

    const helper = await src("../../src/kilo-provider/provider-catalog-privatefirst.ts")
    expect(helper).toContain("client.provider.catalog")
    expect(helper).not.toContain("client.provider.list")
    // Production `.provider.catalog(` lives only in the helper fallback.
    for (const rel of ["../../src/provider-actions.ts", "../../src/KiloProvider.ts"]) {
      const text = await src(rel)
      expect(text).not.toMatch(/client\.provider\.catalog\s*\(/)
    }

    const kilo = await src("../../src/KiloProvider.ts")
    expect(kilo).not.toMatch(/\.provider\.list\(/)
    expect(kilo).not.toContain("handleGetProviderCredential")
    expect(kilo).not.toContain("authorizeCredentialRead")
    expect(kilo).not.toContain("providerCredentialLoaded")
    expect(kilo).not.toContain("providerCredentialError")
    expect(kilo).not.toContain("getProviderCredential")
    expect(kilo).toContain("fetchProviderData")

    // Fixture callers are explicitly excluded and stay on the direct SDK read.
    const ext = await src("../../src/extension.ts")
    expect(ext).toContain("client.provider.catalog")
    expect(ext).not.toContain("client.provider.list")

    const agent = await src("../../src/agent-manager/AgentManagerProvider.ts")
    expect(agent).toContain(".provider")
    expect(agent).toContain(".catalog(")
    expect(agent).not.toContain("client.provider\n      .list(")
    expect(agent).not.toMatch(/client\.provider\s*\n?\s*\.list\(/)
  })

  it("fetchProviderData keeps message parity from redacted catalog", async () => {
    const catalog = {
      all: [
        {
          id: "openai",
          name: "OpenAI",
          source: "api",
          env: [],
          hasCredential: true,
          models: {
            "gpt-4": {
              id: "gpt-4",
              providerID: "openai",
              api: { id: "gpt-4", url: "https://api.openai.com", npm: "@ai-sdk/openai" },
              name: "GPT-4",
              capabilities: {
                temperature: true,
                reasoning: false,
                attachment: false,
                toolcall: true,
                input: { text: true, audio: false, image: false, video: false, pdf: false },
                output: { text: true, audio: false, image: false, video: false, pdf: false },
                interleaved: false,
              },
              cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
              limit: { context: 8000, output: 1000 },
              status: "active",
              release_date: "2024-01-01",
              variants: { high: { reasoningEffort: "high" } },
            },
          },
        },
      ],
      connected: ["openai"],
      default: { openai: "gpt-4" },
      failed: [],
    }
    const client = {
      provider: {
        catalog: async () => ({ data: catalog }),
        auth: async () => ({ data: { openai: [{ type: "api", label: "API" }] } }),
      },
      kilo: { authStatus: async () => ({ data: { authenticated: false } }) },
    } as unknown as Parameters<typeof fetchProviderData>[0]
    const result = await fetchProviderData(client, "/tmp")
    expect(result.response.all).toEqual(catalog.all)
    expect(result.response.connected).toEqual(["openai"])
    expect(result.response.default).toEqual({ openai: "gpt-4" })
    expect(result.authStates).toEqual({ openai: "api" })
    expect(result.authMethods).toEqual({ openai: [{ type: "api", label: "API" }] })
    const model = (result.response.all[0] as unknown as { models: Record<string, { variants?: unknown }> }).models[
      "gpt-4"
    ]!
    expect(model.variants).toEqual({ high: { reasoningEffort: "high" } })
    expect(JSON.stringify(result)).not.toContain("sk-")
  })
})
