import { describe, expect, it } from "bun:test"
import path from "path"
import { fetchProviderData } from "../../src/provider-actions"

async function src(rel: string) {
  return Bun.file(path.join(import.meta.dir, rel)).text()
}

describe("provider auth call-site lock", () => {
  it("auth reads use private-first; production direct auth lives only in helper fallback", async () => {
    const actions = await src("../../src/provider-actions.ts")
    expect(actions).toContain("fetchProviderAuthPrivateFirst")
    expect(actions).toContain("fetchProviderCatalogPrivateFirst")
    expect(actions).not.toMatch(/client\.provider\.auth\s*\(/)

    const helper = await src("../../src/kilo-provider/provider-auth-privatefirst.ts")
    expect(helper).toContain("client.provider.auth")
    expect(helper).toContain('typeof client?.provider?.auth !== "function"')
    // Production `.provider.auth(` lives only in the helper fallback.
    for (const rel of ["../../src/provider-actions.ts", "../../src/KiloProvider.ts"]) {
      const text = await src(rel)
      expect(text).not.toMatch(/\.provider\.auth\s*\(/)
    }

    const kilo = await src("../../src/KiloProvider.ts")
    expect(kilo).toContain("fetchProviderData")
    expect(kilo).not.toMatch(/\.provider\.auth\s*\(/)

    // Fixture callers are explicitly excluded and stay on the direct SDK read.
    const ext = await src("../../src/extension.ts")
    expect(ext).toContain("client.provider.catalog")
    expect(ext).not.toMatch(/\.provider\.auth\s*\(/)

    const agent = await src("../../src/agent-manager/AgentManagerProvider.ts")
    expect(agent).toContain(".provider")
  })

  it("fetchProviderData keeps message parity with soft auth", async () => {
    const catalog = {
      all: [{ id: "openai", name: "OpenAI", source: "api", env: [], hasCredential: true, models: {} }],
      connected: ["openai"],
      default: {},
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
    expect(result.authStates).toEqual({ openai: "api" })
    expect(result.authMethods).toEqual({ openai: [{ type: "api", label: "API" }] })
  })
})
