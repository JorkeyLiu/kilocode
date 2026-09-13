import { describe, expect, test } from "bun:test"
import path from "path"
import { validateProviderAuthData } from "../../src/kilocode/provider-auth"

async function repoText(rel: string) {
  return Bun.file(path.join(import.meta.dir, rel)).text()
}

describe("provider-auth shared owner parity", () => {
  test("HTTP + fd share fetchProviderAuthData; single owner", async () => {
    const handler = await repoText("../../src/server/routes/instance/httpapi/handlers/provider.ts")
    expect(handler).toContain("fetchProviderAuthData")
    expect(handler).not.toContain("svc.methods()")
    const carrier = await repoText("../../src/kilocode/server/fd-carrier.ts")
    expect(carrier).toContain("providerAuthPrivate")
    expect(carrier).toContain("provider/auth")
    const shared = await repoText("../../src/kilocode/provider-auth.ts")
    expect(shared).toContain("fetchProviderAuthData")
    expect(shared).toContain("ProviderAuth.Service")
    expect(shared).toContain("acquireDrainControl")
    expect(shared).toContain("InstanceRef")
    expect(shared).not.toContain("fetch(")
  })

  test("empty shapes validate; unknown nested rejected", () => {
    expect(() => validateProviderAuthData({})).not.toThrow()
    expect(() => validateProviderAuthData({ openai: [] })).not.toThrow()
    expect(() => validateProviderAuthData({ openai: [{ type: "api", label: "API" }] })).not.toThrow()
    expect(() =>
      validateProviderAuthData({ openai: [{ type: "api", label: "L", prompts: [{ type: "text", key: "k", message: "m" }] }] }),
    ).not.toThrow()
    expect(() => validateProviderAuthData({ openai: [{ type: "api", label: "L", extra: 1 }] })).toThrow()
    expect(() =>
      validateProviderAuthData({ openai: [{ type: "api", label: "L", prompts: [{ type: "text", key: "k", message: "m", extra: 1 }] }] }),
    ).toThrow()
    expect(() => validateProviderAuthData({ openai: [{ type: "api", label: null }] })).toThrow()
    expect(() => validateProviderAuthData({ openai: [{ type: "api", label: "L", prompts: null }] })).toThrow()
  })
})
