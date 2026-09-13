import { describe, expect, test } from "bun:test"
import path from "path"
import {
  validateProviderModelsDiscoverData,
  validateProviderModelsDiscoverRequest,
} from "../../src/kilocode/provider-models-discover"

async function repoText(rel: string) {
  return Bun.file(path.join(import.meta.dir, rel)).text()
}

function req(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    requestId: "req-discover-1",
    op: "provider/models-discover",
    context: { directory: "/tmp/discover" },
    payload: { providerID: "test", baseURL: "https://example.com/v1" },
    ...overrides,
  }
}

describe("provider-models-discover shared owner parity", () => {
  test("HTTP + fd share fetchProviderModelsDiscoverData; single stored-credential owner", async () => {
    const handler = await repoText("../../src/server/routes/instance/httpapi/handlers/provider.ts")
    expect(handler).toContain("fetchProviderModelsDiscoverData")
    expect(handler).not.toContain("fetchModelsWithKey")
    expect(handler).not.toContain("isDiscoveryCredentialAllowed")
    const carrier = await repoText("../../src/kilocode/server/fd-carrier.ts")
    expect(carrier).toContain("providerModelsDiscoverPrivate")
    expect(carrier).toContain("provider/models-discover")
    const shared = await repoText("../../src/kilocode/provider-models-discover.ts")
    expect(shared).toContain("fetchProviderModelsDiscoverData")
    expect(shared).toContain("fetchModelsWithKey")
    expect(shared).toContain("isDiscoveryCredentialAllowed")
    expect(shared).toContain("acquireDrainControl")
    expect(shared).toContain("InstanceRef")
    expect(shared).not.toContain("HttpApi")
    expect(shared).not.toContain("ProviderModelsApiError")
  })

  test("request validation fails closed on shape abuse", () => {
    expect(() => validateProviderModelsDiscoverRequest(req())).not.toThrow()
    expect(() =>
      validateProviderModelsDiscoverRequest(req({ payload: { providerID: "", baseURL: "https://example.com/v1" } })),
    ).toThrow()
    expect(() =>
      validateProviderModelsDiscoverRequest(req({ payload: { providerID: "test", baseURL: "ftp://example.com/v1" } })),
    ).toThrow()
    expect(() =>
      validateProviderModelsDiscoverRequest(
        req({ payload: { providerID: "test", baseURL: "https://example.com/v1?q=1" } }),
      ),
    ).toThrow()
    expect(() => validateProviderModelsDiscoverRequest(req({ payload: { providerID: "test" } }))).toThrow()
    expect(() =>
      validateProviderModelsDiscoverRequest(
        req({ payload: { providerID: "test", baseURL: "https://example.com/v1", headers: {} } }),
      ),
    ).toThrow()
    expect(() => validateProviderModelsDiscoverRequest(req({ payload: {} }))).toThrow()
    expect(() => validateProviderModelsDiscoverRequest(req({ context: { directory: "relative/path" } }))).toThrow()
    expect(() => validateProviderModelsDiscoverRequest(req({ opId: "x", idempotencyKey: "x" }))).toThrow()
    expect(() => validateProviderModelsDiscoverRequest(req({ op: "provider/catalog" }))).toThrow()
  })

  test("data validation keeps the exact {models:[{id,name}]} wire with bounds", () => {
    expect(() => validateProviderModelsDiscoverData({ models: [] })).not.toThrow()
    expect(() => validateProviderModelsDiscoverData({ models: [{ id: "m1", name: "M1" }] })).not.toThrow()
    expect(() => validateProviderModelsDiscoverData({ models: [{ id: "m1", name: "m1", key: "sk-leak" }] })).toThrow()
    expect(() => validateProviderModelsDiscoverData({ models: [{ id: "", name: "M" }] })).toThrow()
    expect(() => validateProviderModelsDiscoverData({ models: [{ id: "m", name: "" }] })).toThrow()
    expect(() => validateProviderModelsDiscoverData({ models: [{ id: "m\0", name: "M" }] })).toThrow()
    expect(() => validateProviderModelsDiscoverData({ models: [{ id: "x".repeat(257), name: "M" }] })).toThrow()
    expect(() =>
      validateProviderModelsDiscoverData({
        models: Array.from({ length: 501 }, (_, i) => ({ id: `m${i}`, name: `M${i}` })),
      }),
    ).toThrow()
    expect(() => validateProviderModelsDiscoverData({ models: [], extra: 1 })).toThrow()
  })
})
