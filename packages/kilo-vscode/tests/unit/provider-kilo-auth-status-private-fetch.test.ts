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

function kiloInvalidPrivate() {
  return {
    ...okPrivate(),
    privateKiloAuthStatusOutcomeWithHandle: () => ({
      id: 3,
      promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
      cancel: () => true,
    }),
  }
}

function kiloTransportPrivate() {
  return {
    ...okPrivate(),
    privateKiloAuthStatusOutcomeWithHandle: () => ({
      id: 3,
      promise: Promise.reject(new Error("Private peer unavailable")),
      cancel: () => true,
    }),
  }
}

function kiloMissingCapabilityPrivate() {
  const base = okPrivate() as Record<string, unknown>
  const { privateKiloAuthStatusOutcomeWithHandle: _drop, ...rest } = base
  void _drop
  return {
    ...rest,
    getPrivatePeer: () => null,
    getPrivateEpoch: () => 1,
  }
}

function kiloHangingPrivate() {
  return {
    ...okPrivate(),
    privateKiloAuthStatusOutcomeWithHandle: () => ({
      id: 3,
      promise: new Promise(() => {}),
      cancel: () => true,
    }),
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

describe("fetchProviderData kilo/auth-status private authority", () => {
  it("private kilo success projects authStates with zero SDK status", async () => {
    let sdk = 0
    const client = clientWith({ kilo: async () => { sdk += 1; return { data: { authenticated: false } } } })
    const out = await fetchProviderData(client, "/tmp", okPrivate() as never)
    expect(sdk).toBe(0)
    expect(out.authStates).toEqual({ openai: "api", kilo: "oauth" })
  })

  it("signed-out private status omits kilo with zero SDK", async () => {
    let sdk = 0
    const client = clientWith({ kilo: async () => { sdk += 1; return { data: { authenticated: true, type: "api" } } } })
    const out = await fetchProviderData(client, "/tmp", okPrivate({ authenticated: false }) as never)
    expect(sdk).toBe(0)
    expect(out.authStates).toEqual({ openai: "api" })
  })

  it("kilo terminal degrades to omitted auth state with zero SDK and keeps catalog authority", async () => {
    let sdk = 0
    const client = clientWith({ kilo: async () => { sdk += 1; return { data: { authenticated: true, type: "api" } } } })
    const out = await fetchProviderData(client, "/tmp", kiloTerminalPrivate() as never)
    expect(sdk).toBe(0)
    expect(out.authStates).toEqual({ openai: "api" })
    expect(out.response.all.length).toBe(1)
  })

  it("fast non-terminal outcomes degrade to omitted auth state with zero SDK and keep catalog", async () => {
    const cases: Array<{ name: string; conn: unknown }> = [
      { name: "unavailable", conn: { isPrivateAvailable: () => false } },
      { name: "missing-capability", conn: kiloMissingCapabilityPrivate() },
      { name: "invalid", conn: kiloInvalidPrivate() },
      { name: "transport", conn: kiloTransportPrivate() },
    ]
    for (const c of cases) {
      let sdk = 0
      const client = clientWith({ kilo: async () => { sdk += 1; return { data: { authenticated: true, type: "api" } } } })
      const out = await fetchProviderData(client, "/tmp", c.conn as never)
      expect(sdk, c.name).toBe(0)
      expect(out.authStates, c.name).toEqual({ openai: "api" })
      expect(out.response.all.length, c.name).toBe(1)
    }
  })

  it("hanging private kilo times out to omitted auth state with zero SDK and keeps catalog", async () => {
    let sdk = 0
    const client = clientWith({ kilo: async () => { sdk += 1; return { data: { authenticated: true, type: "api" } } } })
    const out = await fetchProviderData(client, "/tmp", kiloHangingPrivate() as never)
    expect(sdk).toBe(0)
    expect(out.authStates).toEqual({ openai: "api" })
    expect(out.response.all.length).toBe(1)
  })

  it("kilo SDK thrower is never called and never rejects", async () => {
    let sdk = 0
    const client = {
      provider: { catalog: async () => ({ data: catalog() }), auth: async () => ({ data: authData() }) },
      kilo: { authStatus: async () => { sdk += 1; throw new Error("kilo down") } },
    } as unknown as Parameters<typeof fetchProviderData>[0]
    const out = await fetchProviderData(client, "/tmp", kiloTransportPrivate() as never)
    expect(sdk).toBe(0)
    expect(out.authStates).toEqual({ openai: "api" })
  })

  it("kilo branch stays parallel without SDK while catalog/auth keep their semantics", async () => {
    const order: string[] = []
    let kiloSdk = 0
    const client = {
      provider: {
        catalog: async () => { order.push("catalog"); return { data: catalog() } },
        auth: async () => { order.push("auth"); return { data: authData() } },
      },
      kilo: { authStatus: async () => { kiloSdk += 1; order.push("kilo"); return { data: { authenticated: false } } } },
    } as unknown as Parameters<typeof fetchProviderData>[0]
    const out = await fetchProviderData(client, "/tmp", { isPrivateAvailable: () => false } as never)
    expect(kiloSdk).toBe(0)
    expect(order.sort()).toEqual(["auth", "catalog"])
    expect(out.authStates).toEqual({ openai: "api" })
  })

  it("catalog failure still rejects the whole fetch", async () => {
    const client = clientWith({ catalog: async () => { throw new Error("sdk down") } })
    await expect(fetchProviderData(client, "/tmp", { isPrivateAvailable: () => false } as never)).rejects.toThrow()
  })
})
