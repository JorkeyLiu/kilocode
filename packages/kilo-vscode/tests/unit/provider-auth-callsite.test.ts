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

    // Fixture callers go through the shared private-first projections; the
    // SDK lives only in the helpers' exactly-once same-directory fallback.
    const ext = await src("../../src/extension.ts")
    expect(ext).toContain("fetchFixtureVariantRealPrivateFirst")
    expect(ext).not.toMatch(/client\.provider\.catalog\s*\(/)
    expect(ext).not.toContain("client.provider.list")
    expect(ext).not.toMatch(/\.provider\.auth\s*\(/)

    const variant = await src("../../src/kilo-provider/fixture-variant-real-privatefirst.ts")
    expect(variant).toContain("fetchProviderCatalogPrivateFirst")
    expect(variant).toContain("fetchAgentsPrivateFirst")
    expect(variant).not.toMatch(/client\.provider\.catalog\s*\(/)
    expect(variant).not.toMatch(/\.provider\.auth\s*\(/)
    expect(variant).not.toMatch(/\.app\.agents\s*\(/)

    const agent = await src("../../src/agent-manager/AgentManagerProvider.ts")
    expect(agent).toContain("backendSnapshotForFixture")
    expect(agent).toContain("fixture-backend-snapshot")
    expect(agent).not.toMatch(/client\.provider\.catalog\s*\(/)
    expect(agent).not.toMatch(/\.provider\.auth\s*\(/)
    expect(agent).not.toContain("client.provider.list")

    const snapshot = await src("../../src/agent-manager/fixture-backend-snapshot.ts")
    expect(snapshot).toContain("fetchProviderCatalogPrivateFirst")
    expect(snapshot).not.toMatch(/client\.provider\.catalog\s*\(/)
    expect(snapshot).not.toMatch(/\.provider\.auth\s*\(/)
    expect(snapshot).not.toContain("client.provider.list")
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
