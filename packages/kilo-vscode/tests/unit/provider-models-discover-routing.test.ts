import { describe, expect, it } from "bun:test"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"

const { KiloProvider } = await import("../../src/KiloProvider")

type Internals = {
  postMessage: (message: unknown) => void
  handleFetchCustomProviderModels: (msg: Record<string, unknown>) => Promise<void>
  dispose: () => void
}

function makeLegacyProvider(client: unknown) {
  const connection = new KiloConnectionService({} as never)
  ;(connection as unknown as { getClient: () => unknown }).getClient = () => client as never
  const provider = new KiloProvider({} as never, connection, undefined, {})
  const messages: unknown[] = []
  const internal = provider as unknown as Internals
  internal.postMessage = (message) => messages.push(message)
  return { provider: internal, messages, connection }
}

function discoverClient(impl: (args: Record<string, unknown>) => Promise<unknown> | unknown) {
  const calls: Array<Record<string, unknown>> = []
  const client = {
    provider: {
      models: {
        discover: async (args: Record<string, unknown>) => {
          calls.push(args)
          const data = await impl(args)
          return { data }
        },
      },
    },
  }
  return { client, calls }
}

function fetched(messages: unknown[]) {
  return messages.find((m) => (m as Record<string, unknown>).type === "customProviderModelsFetched") as
    | Record<string, unknown>
    | undefined
}

describe("handleFetchCustomProviderModels stored-credential routing", () => {
  it("has no extension-side stored key cache", () => {
    const { client } = discoverClient(async () => ({ models: [] }))
    const { provider } = makeLegacyProvider(client)
    expect((provider as unknown as Record<string, unknown>).storedProviderKeys).toBeUndefined()
    ;(provider as unknown as { dispose: () => void }).dispose()
  })

  it("calls the runtime narrow endpoint once for an existing provider without a raw key", async () => {
    const { client, calls } = discoverClient(async () => ({ models: [{ id: "m1", name: "M1" }] }))
    const { provider, messages } = makeLegacyProvider(client)
    await provider.handleFetchCustomProviderModels({
      requestId: "r1",
      baseURL: "https://example.com/v1",
      providerID: "myprovider",
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.providerID).toBe("myprovider")
    expect(calls[0]?.baseURL).toBe("https://example.com/v1")
    const result = fetched(messages)
    expect(result).toBeDefined()
    expect(result!.models).toEqual([{ id: "m1", name: "M1" }])
    expect(result!.error).toBeUndefined()
    ;(provider as unknown as { dispose: () => void }).dispose()
  })

  it("keeps the direct fetch path when a raw apiKey is typed and never calls the endpoint", async () => {
    const { client, calls } = discoverClient(async () => ({ models: [{ id: "m1", name: "M1" }] }))
    const { provider, messages } = makeLegacyProvider(client)
    await provider.handleFetchCustomProviderModels({
      requestId: "r2",
      baseURL: "http://127.0.0.1:1",
      providerID: "myprovider",
      apiKey: "sk-raw",
    })
    expect(calls).toHaveLength(0)
    const result = fetched(messages)
    expect(result).toBeDefined()
    expect(result!.error).toBeDefined()
    ;(provider as unknown as { dispose: () => void }).dispose()
  })

  it("keeps the direct fetch path when custom headers are present and never calls the endpoint", async () => {
    const { client, calls } = discoverClient(async () => ({ models: [{ id: "m1", name: "M1" }] }))
    const { provider, messages } = makeLegacyProvider(client)
    await provider.handleFetchCustomProviderModels({
      requestId: "r3",
      baseURL: "http://127.0.0.1:1",
      providerID: "myprovider",
      headers: { "X-Custom": "1" },
    })
    expect(calls).toHaveLength(0)
    const result = fetched(messages)
    expect(result).toBeDefined()
    expect(result!.error).toBeDefined()
    ;(provider as unknown as { dispose: () => void }).dispose()
  })

  it("maps runtime Unauthorized failures to auth UX without changing the message shape", async () => {
    const { client } = discoverClient(async () => {
      // Mirrors the hey-api error body shape.
      // eslint-disable-next-line no-throw-literal
      throw { name: "Unauthorized", data: { message: "Stored credential failed authentication (HTTP 401)" } }
    })
    const { provider, messages } = makeLegacyProvider(client)
    await provider.handleFetchCustomProviderModels({
      requestId: "r4",
      baseURL: "https://example.com/v1",
      providerID: "myprovider",
    })
    const result = fetched(messages)
    expect(result).toBeDefined()
    expect(result!.error).toBeDefined()
    expect(result!.auth).toBe(true)
    expect(Object.keys(result!).sort()).toEqual(["auth", "error", "requestId", "type"].sort())
    ;(provider as unknown as { dispose: () => void }).dispose()
  })

  it("maps runtime non-auth failures to plain error UX", async () => {
    const { client } = discoverClient(async () => {
      // Mirrors the hey-api error body shape.
      // eslint-disable-next-line no-throw-literal
      throw { name: "BadRequest", data: { message: "Provider model discovery request is invalid" } }
    })
    const { provider, messages } = makeLegacyProvider(client)
    await provider.handleFetchCustomProviderModels({
      requestId: "r5",
      baseURL: "https://example.com/v1",
      providerID: "myprovider",
    })
    const result = fetched(messages)
    expect(result).toBeDefined()
    expect(result!.error).toBeDefined()
    expect(result!.auth ?? false).toBe(false)
    ;(provider as unknown as { dispose: () => void }).dispose()
  })
})
