import { describe, expect, it } from "bun:test"
import { fetchProviderData } from "../../src/provider-actions"

function catalog() {
  return {
    all: [{ id: "openai", name: "OpenAI", source: "api", env: [], hasCredential: true, models: {} }],
    default: {},
    connected: ["openai"],
    failed: [],
  }
}

function authData() {
  return { openai: [{ type: "api", label: "API" }] }
}

function okPrivate(data: unknown = authData()) {
  return {
    isPrivateAvailable: () => true,
    privateProviderCatalogOutcomeWithHandle: (r: { requestId: string }) => ({
      id: 1,
      promise: Promise.resolve({ kind: "valid", result: { v: 1, requestId: r.requestId, op: "provider/catalog", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: catalog() } }),
      cancel: () => true,
    }),
    privateProviderAuthOutcomeWithHandle: (r: { requestId: string }) => ({
      id: 2,
      promise: Promise.resolve({ kind: "valid", result: { v: 1, requestId: r.requestId, op: "provider/auth", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data } }),
      cancel: () => true,
    }),
  }
}

function catalogPrivate(data: unknown = catalog()) {
  return {
    isPrivateAvailable: () => true,
    privateProviderCatalogOutcomeWithHandle: (r: { requestId: string }) => ({
      id: 1,
      promise: Promise.resolve({ kind: "valid", result: { v: 1, requestId: r.requestId, op: "provider/catalog", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data } }),
      cancel: () => true,
    }),
  }
}

function authTerminalPrivate(code = "validation.failed") {
  return {
    ...catalogPrivate(),
    privateProviderAuthOutcomeWithHandle: (r: { requestId: string }) => ({
      id: 2,
      promise: Promise.resolve({ kind: "valid", result: { v: 1, requestId: r.requestId, op: "provider/auth", status: "failed", outcome: { type: "failed", time: 1, failure: { code, message: "invalid provider-auth request", retryable: false } }, accepted: false, failure: { code, message: "invalid provider-auth request", retryable: false } } }),
      cancel: () => true,
    }),
    isPrivateAvailable: () => true,
  }
}

function clientWith(opts: { catalog?: () => Promise<{ data: unknown }>; auth?: () => Promise<{ data: unknown }>; kilo?: () => Promise<unknown> } = {}) {
  return {
    provider: {
      catalog: opts.catalog ?? (async () => ({ data: catalog() })),
      auth: opts.auth ?? (async () => ({ data: authData() })),
    },
    kilo: { authStatus: opts.kilo ?? (async () => ({ data: { authenticated: false } })) },
  } as unknown as Parameters<typeof fetchProviderData>[0]
}

describe("fetchProviderData auth private-first failure isolation", () => {
  it("private auth success uses zero SDK auth", async () => {
    let sdk = 0
    const client = clientWith({ auth: async () => { sdk += 1; return { data: authData() } } })
    const out = await fetchProviderData(client, "/tmp", okPrivate() as never)
    expect(sdk).toBe(0)
    expect(out.authMethods).toEqual(authData())
    expect(out.authStates).toEqual({ openai: "api" })
  })

  it("auth terminal degrades to {} with zero SDK and keeps catalog authority", async () => {
    let sdk = 0
    const client = clientWith({ auth: async () => { sdk += 1; return { data: authData() } } })
    const out = await fetchProviderData(client, "/tmp", authTerminalPrivate() as never)
    expect(sdk).toBe(0)
    expect(out.authMethods).toEqual({})
    expect(out.response.all.length).toBe(1)
  })

  it("auth fallback uses exactly one SDK auth", async () => {
    let sdk = 0
    const client = clientWith({ auth: async () => { sdk += 1; return { data: authData() } } })
    const out = await fetchProviderData(client, "/tmp", catalogPrivate() as never)
    expect(sdk).toBe(1)
    expect(out.authMethods).toEqual(authData())
  })

  it("old SDK without auth method degrades to {} without a call", async () => {
    const base = catalog()
    const client = {
      provider: { catalog: async () => ({ data: base }) },
      kilo: { authStatus: async () => ({ data: { authenticated: false } }) },
    } as unknown as Parameters<typeof fetchProviderData>[0]
    const out = await fetchProviderData(client, "/tmp", { isPrivateAvailable: () => false } as never)
    expect(out.authMethods).toEqual({})
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

  it("catalog failure still rejects the whole fetch", async () => {
    const client = clientWith({ catalog: async () => { throw new Error("sdk down") } })
    await expect(fetchProviderData(client, "/tmp", { isPrivateAvailable: () => false } as never)).rejects.toThrow()
  })

  it("three branches stay parallel", async () => {
    const order: string[] = []
    const client = {
      provider: {
        catalog: async () => { order.push("catalog"); return { data: catalog() } },
        auth: async () => { order.push("auth"); return { data: authData() } },
      },
      kilo: { authStatus: async () => { order.push("kilo"); return { data: { authenticated: false } } } },
    } as unknown as Parameters<typeof fetchProviderData>[0]
    await fetchProviderData(client, "/tmp", { isPrivateAvailable: () => false } as never)
    expect(order.sort()).toEqual(["auth", "catalog", "kilo"])
  })
})
