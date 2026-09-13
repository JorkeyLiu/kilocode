import { describe, expect, test } from "bun:test"
import path from "path"
import { validateProviderCatalogData } from "../../src/kilocode/provider-catalog"

async function repoText(rel: string) {
  return Bun.file(path.join(import.meta.dir, rel)).text()
}

describe("provider-catalog shared owner parity", () => {
  test("HTTP + fd share fetchProviderCatalogData; single redaction owner", async () => {
    const handler = await repoText("../../src/server/routes/instance/httpapi/handlers/provider.ts")
    expect(handler).toContain("fetchProviderCatalogData")
    expect(handler).not.toContain("ProviderCatalog.toCatalogResult")
    const carrier = await repoText("../../src/kilocode/server/fd-carrier.ts")
    expect(carrier).toContain("providerCatalogPrivate")
    expect(carrier).toContain("provider/catalog")
    const shared = await repoText("../../src/kilocode/provider-catalog.ts")
    expect(shared).toContain("fetchProviderCatalogData")
    expect(shared).toContain("ProviderCatalog.toCatalogResult")
    expect(shared).toContain("filterPromptTrainingModels")
    expect(shared).not.toContain("Provider.toPublicInfo")
    expect(shared).toContain("acquireDrainControl")
    expect(shared).toContain("InstanceRef")
  })

  test("empty/failed shapes validate; secrets rejected", () => {
    const empty = { all: [], default: {}, connected: [], failed: [] }
    expect(() => validateProviderCatalogData(empty)).not.toThrow()
    const withFailed = { all: [], default: {}, connected: [], failed: ["broken"] }
    expect(() => validateProviderCatalogData(withFailed)).not.toThrow()
    const secret = {
      all: [{ id: "p", name: "P", source: "api", env: [], hasCredential: false, models: {}, key: "sk-leak" }],
      default: {}, connected: [], failed: [],
    }
    expect(() => validateProviderCatalogData(secret)).toThrow()
  })
})
