import { describe, expect, test } from "bun:test"
import { createClient } from "../src/gen/client/client.gen.js"
import { KiloClient as BaseKiloClient } from "../src/gen/sdk.gen.js"
import { KiloClient, createKiloClient } from "../src/client.js"

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

function makeFetch(handler: (req: Request) => Response | Promise<Response>) {
  return (req: Request) => handler(req)
}

describe("SDK config preservation runtime", () => {
  test("constructor and instanceof preserve BaseKiloClient identity", async () => {
    const client = createClient({ baseUrl: "http://localhost" })
    const viaNew = new KiloClient({ client })
    const viaFactory = createKiloClient({ baseUrl: "http://localhost" })
    // Both must be instanceof KiloClient (refined) and BaseKiloClient (generated)
    expect(viaNew instanceof KiloClient).toBe(true)
    expect(viaNew instanceof BaseKiloClient).toBe(true)
    expect(viaFactory instanceof KiloClient).toBe(true)
    expect(viaFactory instanceof BaseKiloClient).toBe(true)
    // direct Base instance also instanceof refined (same constructor)
    const base = new BaseKiloClient({ client })
    expect(base instanceof KiloClient).toBe(true)
    expect(viaNew instanceof BaseKiloClient).toBe(true)
  })

  test("config.get default fields response has data/error/request/response with V2 shape", async () => {
    const fetchFn = makeFetch((req) => {
      expect(req.url).toContain("/config")
      return jsonResponse({
        provider: {
          acme: {
            endpoint: "https://api.example.com",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.acme",
            name: "acme",
            models: { m1: { name: "M1" } },
          },
        },
      })
    })
    const client = createKiloClient({ baseUrl: "http://localhost", fetch: fetchFn })
    const res = await client.config.get()
    expect(res.data).toBeDefined()
    expect(res.data?.provider?.acme?.endpoint).toBe("https://api.example.com")
    expect(res.data?.provider?.acme?.protocol).toBe("openai/completions")
    expect(res.data?.provider?.acme?.credential).toBe("secret:kilo.credentials.global.provider.acme")
    expect(res.error).toBeUndefined()
    expect(res.request).toBeInstanceOf(Request)
    expect(res.response).toBeInstanceOf(Response)
  })

  test("config.get throwOnError true narrows and responseStyle data unwraps", async () => {
    const fetchFn = makeFetch(() => jsonResponse({ provider: { acme: { endpoint: "https://a.test", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.acme" } } }))
    const client = createKiloClient({ baseUrl: "http://localhost", fetch: fetchFn })

    // throwOnError true with fields style
    const fields = await client.config.get({ throwOnError: true })
    expect(fields.data).toBeDefined()
    // with throwOnError true, error union not present (fields has no error)
    expect((fields as unknown as { error: unknown }).error).toBeUndefined()
    expect(fields.request).toBeInstanceOf(Request)

    // responseStyle data unwraps
    const data = await client.config.get({ responseStyle: "data" })
    expect(data).toBeDefined()
    expect((data as unknown as { provider: unknown }).provider).toBeDefined()
    // data style with throwOnError true unwraps directly to V2Config
    const dataThrow = await client.config.get({ responseStyle: "data", throwOnError: true })
    expect((dataThrow as unknown as { provider: unknown }).provider).toBeDefined()
  })

  test("config.update accepts endpoint/protocol/credential body and returns V2", async () => {
    let capturedBody: unknown = null
    const fetchFn = makeFetch(async (req) => {
      const text = await req.text()
      capturedBody = text ? JSON.parse(text) : null
      return jsonResponse({
        provider: {
          acme: {
            endpoint: "https://api.example.com",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.acme",
          },
        },
      })
    })
    const client = createKiloClient({ baseUrl: "http://localhost", fetch: fetchFn })
    const res = await client.config.update({
      body: {
        provider: {
          acme: {
            endpoint: "https://api.example.com",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.acme",
            name: "acme",
            models: { m1: { name: "M1" } },
          },
        },
      },
    })
    expect(capturedBody).toMatchObject({
      provider: { acme: { endpoint: "https://api.example.com", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.acme" } },
    })
    expect(res.data?.provider?.acme?.endpoint).toBe("https://api.example.com")

    // data style
    const data = await client.config.update({
      body: {
        provider: {
          x: {
            endpoint: "https://x.test",
            protocol: "openai/responses",
            credential: "secret:kilo.credentials.project.provider.x",
          },
        },
      },
      responseStyle: "data",
    })
    expect((data as unknown as { provider: unknown }).provider).toBeDefined()
  })

  test("config.providers unchanged and session namespace unchanged", async () => {
    const fetchFn = makeFetch((req) => {
      const url = new URL(req.url)
      if (url.pathname === "/config/providers") {
        return jsonResponse({ providers: [], default: {} })
      }
      if (url.pathname.startsWith("/session")) {
        return jsonResponse([])
      }
      return jsonResponse({})
    })
    const client = createKiloClient({ baseUrl: "http://localhost", fetch: fetchFn })
    const prov = await client.config.providers()
    expect(prov.data).toBeDefined()
    expect(prov.data.providers).toBeDefined()
    expect(prov.request).toBeInstanceOf(Request)

    const dataProv = await client.config.providers({ responseStyle: "data" })
    expect((dataProv as unknown as { providers: unknown }).providers).toBeDefined()

    // session still works
    const sessions = await client.session.list()
    expect(sessions.data).toBeDefined()
    expect(sessions.request).toBeInstanceOf(Request)
  })

  test("v2 ProviderConfig includes canonical endpoint/protocol/credential via generated types", async () => {
    const src = await Bun.file(new URL("../src/v2/gen/types.gen.ts", import.meta.url).pathname).text()
    expect(src).toContain("endpoint?: string")
    expect(src).toContain("protocol?:")
    expect(src).toContain("credential?: string")
  })

  test("v2 global config via v2 client (project-only root SDK does not expose global)", async () => {
    const { createKiloClient: createV2 } = await import("../src/v2/client.js")
    // ensure v2 client has global.config
    const fetchFn = makeFetch((req) => {
      const url = new URL(req.url)
      if (url.pathname === "/global/config") return jsonResponse({ provider: { acme: { endpoint: "https://global.test", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.acme" } } })
      if (url.pathname === "/config") return jsonResponse({ provider: {} })
      return jsonResponse({})
    })
    const v2 = createV2({ baseUrl: "http://localhost", fetch: fetchFn })
    // v2 project config
    const proj = await v2.config.get({ directory: "/tmp" })
    expect(proj.data).toBeDefined()
    // v2 global config
    const global = await v2.global.config.get()
    expect(global.data?.provider?.acme?.endpoint).toBe("https://global.test")
    const updated = await v2.global.config.update({ config: { provider: { acme: { endpoint: "https://g2.test", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.acme" } } } })
    expect(updated.data).toBeDefined()
    // root SDK should not have global config (project-only)
    const root = createKiloClient({ baseUrl: "http://localhost", fetch: fetchFn })
    expect((root as unknown as { global: { config: unknown } }).global.config).toBeUndefined()
    expect((root.global as unknown as { config: unknown }).config).toBeUndefined()
  })
})
