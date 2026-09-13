import { describe, expect, it } from "bun:test"
import path from "path"
import { fetchProviderData } from "../../src/provider-actions"

async function src(rel: string) {
  return Bun.file(path.join(import.meta.dir, rel)).text()
}

describe("provider catalog call-site lock", () => {
  it("regular reads use catalog; only explicit reveal uses provider.list", async () => {
    const actions = await src("../../src/provider-actions.ts")
    expect(actions).toContain("client.provider.catalog")
    expect(actions).not.toContain("client.provider.list")
    expect(actions).not.toContain("raw.key")
    expect(actions).toContain("hasCredential")

    const kilo = await src("../../src/KiloProvider.ts")
    const listHits = kilo.match(/\.provider\.list\(/g) ?? []
    expect(listHits).toHaveLength(1)
    expect(kilo).toContain("handleGetProviderCredential")
    expect(kilo).toContain("authorizeCredentialRead")
    expect(kilo).toContain("fetchProviderData")

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
