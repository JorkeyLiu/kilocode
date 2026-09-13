import { describe, expect, it } from "bun:test"
import { fetchProviderData } from "../../src/provider-actions"

function caps() {
  return {
    temperature: true, reasoning: false, attachment: false, toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  }
}

function mdl() {
  return {
    id: "gpt-4", providerID: "openai", api: { id: "gpt-4", url: "https://x", npm: "n" }, name: "GPT-4",
    capabilities: caps(), cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
    limit: { context: 8, output: 1 }, status: "active", release_date: "2024-01-01",
    variants: { high: { reasoningEffort: "high" } },
  }
}

function catalog() {
  return {
    all: [{ id: "openai", name: "OpenAI", source: "api", env: [], hasCredential: true, models: { "gpt-4": mdl() } }],
    default: { openai: "gpt-4" }, connected: ["openai"], failed: [],
  }
}

function okPrivate(data: unknown = catalog()) {
  return {
    isPrivateAvailable: () => true,
    privateProviderCatalogOutcomeWithHandle: (r: { requestId: string }) => ({
      id: 1,
      promise: Promise.resolve({ kind: "valid", result: { v: 1, requestId: r.requestId, op: "provider/catalog", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data } }),
      cancel: () => true,
    }),
  }
}

function terminalPrivate(code = "validation.failed") {
  const msg = code === "validation.failed" ? "invalid provider-catalog request" : code
  return {
    isPrivateAvailable: () => true,
    privateProviderCatalogOutcomeWithHandle: (r: { requestId: string }) => ({
      id: 1,
      promise: Promise.resolve({ kind: "valid", result: { v: 1, requestId: r.requestId, op: "provider/catalog", status: "failed", outcome: { type: "failed", time: 1, failure: { code, message: msg, retryable: false } }, accepted: false, failure: { code, message: msg, retryable: false } } }),
      cancel: () => true,
    }),
  }
}

function clientWith(catalogFn: () => Promise<{ data: unknown }>, opts: { auth?: unknown; kilo?: unknown } = {}) {
  return {
    provider: { catalog: catalogFn, auth: async () => ({ data: opts.auth ?? {} }) },
    kilo: { authStatus: async () => ({ data: opts.kilo ?? { authenticated: false } }) },
  } as unknown as Parameters<typeof fetchProviderData>[0]
}

describe("fetchProviderData private-first failure isolation", () => {
  it("private success uses zero SDK catalog", async () => {
    let sdk = 0
    const client = clientWith(async () => { sdk += 1; return { data: catalog() } })
    const out = await fetchProviderData(client, "/tmp", okPrivate() as never)
    expect(sdk).toBe(0)
    expect(out.response.all.length).toBe(1)
    expect(out.authStates).toEqual({ openai: "api" })
  })

  it("terminal rejects the whole fetch with zero SDK and keeps auth isolation", async () => {
    let sdk = 0
    const client = clientWith(async () => { sdk += 1; return { data: catalog() } }, { auth: { openai: [{ type: "api", label: "API" }] }, kilo: { authenticated: true, type: "oauth" } })
    await expect(fetchProviderData(client, "/tmp", terminalPrivate() as never)).rejects.toThrow()
    expect(sdk).toBe(0)
  })

  it("fallback uses exactly one SDK catalog and keeps authMethods/kilo derivation", async () => {
    let sdk = 0
    const client = clientWith(async () => { sdk += 1; return { data: catalog() } }, { auth: { openai: [{ type: "api", label: "API" }] } })
    const out = await fetchProviderData(client, "/tmp", { isPrivateAvailable: () => false } as never)
    expect(sdk).toBe(1)
    expect(out.authMethods).toEqual({ openai: [{ type: "api", label: "API" }] })
    expect(out.authStates).toEqual({ openai: "api" })
  })

  it("auth/kilo failures stay isolated and never reject", async () => {
    const client = {
      provider: { catalog: async () => ({ data: catalog() }), auth: async () => { throw new Error("auth down") } },
      kilo: { authStatus: async () => { throw new Error("kilo down") } },
    } as unknown as Parameters<typeof fetchProviderData>[0]
    const out = await fetchProviderData(client, "/tmp", { isPrivateAvailable: () => false } as never)
    expect(out.authMethods).toEqual({})
    expect(out.authStates).toEqual({ openai: "api" })
  })

  it("SDK catalog failure still rejects the whole fetch", async () => {
    const client = clientWith(async () => { throw new Error("sdk down") })
    await expect(fetchProviderData(client, "/tmp", { isPrivateAvailable: () => false } as never)).rejects.toThrow()
  })

  it("secret SDK payload rejects fail-closed", async () => {
    const secret = catalog()
    ;((((secret.all[0] as Record<string, unknown>).models as Record<string, unknown>)["gpt-4"] as Record<string, unknown>))["headers"] = { Authorization: "Bearer sk-leak" }
    const client = clientWith(async () => ({ data: secret }))
    await expect(fetchProviderData(client, "/tmp", { isPrivateAvailable: () => false } as never)).rejects.toThrow()
  })
})
