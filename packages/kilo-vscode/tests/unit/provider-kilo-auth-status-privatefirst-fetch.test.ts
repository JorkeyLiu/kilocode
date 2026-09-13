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

function okPrivate(status: unknown = { authenticated: true, type: "oauth" }) {
  return {
    isPrivateAvailable: () => true,
    privateProviderCatalogOutcomeWithHandle: (r: { requestId: string }) => ({
      id: 1,
      promise: Promise.resolve({ kind: "valid", result: { v: 1, requestId: r.requestId, op: "provider/catalog", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: catalog() } }),
      cancel: () => true,
    }),
    privateProviderAuthOutcomeWithHandle: (r: { requestId: string }) => ({
      id: 2,
      promise: Promise.resolve({ kind: "valid", result: { v: 1, requestId: r.requestId, op: "provider/auth", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: authData() } }),
      cancel: () => true,
    }),
    privateKiloAuthStatusOutcomeWithHandle: (r: { requestId: string }) => ({
      id: 3,
      promise: Promise.resolve({ kind: "valid", result: { v: 1, requestId: r.requestId, op: "kilo/auth-status", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: status } }),
      cancel: () => true,
    }),
  }
}

function kiloTerminalPrivate(code = "internal") {
  return {
    ...okPrivate(),
    privateKiloAuthStatusOutcomeWithHandle: (r: { requestId: string }) => ({
      id: 3,
      promise: Promise.resolve({ kind: "valid", result: { v: 1, requestId: r.requestId, op: "kilo/auth-status", status: "failed", outcome: { type: "failed", time: 1, failure: { code, message: "internal error", retryable: false } }, accepted: false, failure: { code, message: "internal error", retryable: false } } }),
      cancel: () => true,
    }),
  }
}

function withoutKiloPrivate() {
  const { privateKiloAuthStatusOutcomeWithHandle: _drop, ...rest } = okPrivate() as Record<string, unknown>
  void _drop
  return rest
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

describe("fetchProviderData kilo/auth-status private-first failure isolation", () => {
  it("private kilo success covers authStates with zero SDK status", async () => {
    let sdk = 0
    const client = clientWith({ kilo: async () => { sdk += 1; return { data: { authenticated: false } } } })
    const out = await fetchProviderData(client, "/tmp", okPrivate() as never)
    expect(sdk).toBe(0)
    expect(out.authStates).toEqual({ openai: "api", kilo: "oauth" })
  })

  it("signed-out private status keeps catalog authStates with zero SDK", async () => {
    let sdk = 0
    const client = clientWith({ kilo: async () => { sdk += 1; return { data: { authenticated: true, type: "api" } } } })
    const out = await fetchProviderData(client, "/tmp", okPrivate({ authenticated: false }) as never)
    expect(sdk).toBe(0)
    expect(out.authStates).toEqual({ openai: "api" })
  })

  it("kilo terminal degrades to null with zero SDK and keeps catalog authority", async () => {
    let sdk = 0
    const client = clientWith({ kilo: async () => { sdk += 1; return { data: { authenticated: true, type: "api" } } } })
    const out = await fetchProviderData(client, "/tmp", kiloTerminalPrivate() as never)
    expect(sdk).toBe(0)
    expect(out.authStates).toEqual({ openai: "api" })
    expect(out.response.all.length).toBe(1)
  })

  it("kilo fallback uses exactly one same-directory SDK status", async () => {
    let sdk = 0
    const seen: unknown[] = []
    const client = clientWith({
      kilo: async (args?: unknown) => {
        sdk += 1
        seen.push(args)
        return { data: { authenticated: true, type: "api" } }
      },
    })
    const out = await fetchProviderData(client, "/tmp", withoutKiloPrivate() as never)
    expect(sdk).toBe(1)
    expect(seen).toEqual([{ directory: "/tmp" }])
    expect(out.authStates).toEqual({ openai: "api", kilo: "api" })
  })

  it("kilo SDK failure degrades to null and never rejects", async () => {
    const client = {
      provider: { catalog: async () => ({ data: catalog() }), auth: async () => ({ data: authData() }) },
      kilo: { authStatus: async () => { throw new Error("kilo down") } },
    } as unknown as Parameters<typeof fetchProviderData>[0]
    const out = await fetchProviderData(client, "/tmp", withoutKiloPrivate() as never)
    expect(out.authStates).toEqual({ openai: "api" })
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

  it("catalog failure still rejects the whole fetch", async () => {
    const client = clientWith({ catalog: async () => { throw new Error("sdk down") } })
    await expect(fetchProviderData(client, "/tmp", { isPrivateAvailable: () => false } as never)).rejects.toThrow()
  })
})
