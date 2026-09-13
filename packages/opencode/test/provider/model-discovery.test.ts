import { describe, expect, test } from "bun:test"
import {
  MODEL_DISCOVERY_MAX_BODY_BYTES,
  MODEL_DISCOVERY_MAX_ID_LENGTH,
  MODEL_DISCOVERY_MAX_MODELS,
  MODEL_DISCOVERY_TIMEOUT_MS,
  ModelDiscoveryError,
  fetchModelsWithKey,
  isDiscoveryCredentialAllowed,
  isStrictBaseURL,
  normalizeBaseURL,
  parseModelsBody,
} from "@/provider/model-discovery"

const SECRET = "secret-key-xyz"

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function streamResponse(chunks: Uint8Array[], headers?: Record<string, string>, status = 200) {
  let pulls = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      const next = chunks.shift()
      if (next) controller.enqueue(next)
      else controller.close()
    },
  })
  return { response: new Response(stream, { status, headers: { "content-type": "application/json", ...headers } }), pulls: () => pulls }
}

function infiniteStreamResponse(headers?: Record<string, string>) {
  let pulls = 0
  const chunk = new Uint8Array(65536)
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      controller.enqueue(chunk)
    },
  })
  return { response: new Response(stream, { status: 200, headers: { "content-type": "application/json", ...headers } }), pulls: () => pulls }
}

function fetchFn(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const seen: { auth?: string; url?: string; redirect?: string; calls: number } = { calls: 0 }
  const run = async (url: string, init?: RequestInit) => {
    seen.calls += 1
    seen.url = url
    const headers = new Headers(init?.headers)
    seen.auth = headers.get("authorization") ?? undefined
    seen.redirect = init?.redirect
    return handler(url, init)
  }
  return { run: run as typeof fetch, seen }
}

describe("model discovery bounds", () => {
  test("timeout is 15s", () => {
    expect(MODEL_DISCOVERY_TIMEOUT_MS).toBe(15_000)
  })

  test("normalizeBaseURL trims and strips trailing slashes", () => {
    expect(normalizeBaseURL("https://example.com/v1/")).toBe("https://example.com/v1")
    expect(normalizeBaseURL("  https://example.com/v1///  ")).toBe("https://example.com/v1")
  })

  test("isStrictBaseURL allows plain http(s) origins with optional path", () => {
    expect(isStrictBaseURL("https://example.com/v1")).toBe(true)
    expect(isStrictBaseURL("http://127.0.0.1:9/v1/")).toBe(true)
    expect(isStrictBaseURL("  https://example.com/v1  ")).toBe(true)
  })

  test("isStrictBaseURL rejects userinfo, query, fragment, and non-http schemes", () => {
    expect(isStrictBaseURL("https://user@example.com/v1")).toBe(false)
    expect(isStrictBaseURL("https://user:pass@example.com/v1")).toBe(false)
    expect(isStrictBaseURL("https://example.com/v1?key=x")).toBe(false)
    expect(isStrictBaseURL("https://example.com/v1#frag")).toBe(false)
    expect(isStrictBaseURL("ftp://example.com/v1")).toBe(false)
    expect(isStrictBaseURL("/relative/path")).toBe(false)
    expect(isStrictBaseURL("")).toBe(false)
  })
})

describe("isDiscoveryCredentialAllowed", () => {
  test("allows api and custom sources with a key", () => {
    expect(isDiscoveryCredentialAllowed({ providerID: "a", source: "api", key: "k", env: [] })).toBe(true)
    expect(isDiscoveryCredentialAllowed({ providerID: "a", source: "custom", key: "k", env: [] })).toBe(true)
  })

  test("allows config only with empty env (explicitly stored, not env-derived)", () => {
    expect(isDiscoveryCredentialAllowed({ providerID: "a", source: "config", key: "k", env: [] })).toBe(true)
    expect(isDiscoveryCredentialAllowed({ providerID: "a", source: "config", key: "k", env: ["X"] })).toBe(false)
    expect(isDiscoveryCredentialAllowed({ providerID: "a", source: "config", key: "k", env: undefined })).toBe(false)
  })

  test("rejects kilo, env source, missing provider, and empty key", () => {
    expect(isDiscoveryCredentialAllowed({ providerID: "kilo", source: "api", key: "k", env: [] })).toBe(false)
    expect(isDiscoveryCredentialAllowed({ providerID: "a", source: "env", key: "k", env: [] })).toBe(false)
    expect(isDiscoveryCredentialAllowed({ providerID: "", source: "api", key: "k", env: [] })).toBe(false)
    expect(isDiscoveryCredentialAllowed({ providerID: "a", source: "api", key: "", env: [] })).toBe(false)
    expect(isDiscoveryCredentialAllowed({ providerID: "a", source: "api", key: undefined, env: [] })).toBe(false)
  })
})

describe("parseModelsBody", () => {
  test("sorts, dedupes, and falls back to id for name", () => {
    expect(
      parseModelsBody({ data: [{ id: "b", name: "B" }, { id: "a" }, { id: "b", name: "dup" }, { id: "  " }] }),
    ).toEqual([
      { id: "a", name: "a" },
      { id: "b", name: "B" },
    ])
  })

  test("rejects non-object, missing data, and oversized lists", () => {
    for (const body of [null, [], "x", {}, { data: {} }, { data: "x" }]) {
      expect(() => parseModelsBody(body)).toThrow(ModelDiscoveryError)
    }
    const many = Array.from({ length: MODEL_DISCOVERY_MAX_MODELS + 1 }, (_, i) => ({ id: `m${i}` }))
    expect(() => parseModelsBody({ data: many })).toThrow("too many")
  })

  test("skips overlong ids", () => {
    const long = "x".repeat(MODEL_DISCOVERY_MAX_ID_LENGTH + 1)
    expect(parseModelsBody({ data: [{ id: long }, { id: "ok" }] })).toEqual([{ id: "ok", name: "ok" }])
  })
})

describe("fetchModelsWithKey", () => {
  test("sends Bearer auth to <baseURL>/models and returns bounded entries", async () => {
    const { run, seen } = fetchFn(() => jsonResponse(200, { data: [{ id: "b" }, { id: "a", name: "A" }] }))
    const models = await fetchModelsWithKey({ baseURL: "https://example.com/v1/", key: SECRET, fetchFn: run })
    expect(seen.url).toBe("https://example.com/v1/models")
    expect(seen.auth).toBe(`Bearer ${SECRET}`)
    expect(models).toEqual([
      { id: "a", name: "A" },
      { id: "b", name: "b" },
    ])
  })

  test("classifies 401/403 as auth without leaking the key", async () => {
    for (const status of [401, 403]) {
      const { run } = fetchFn(() => jsonResponse(status, { error: "nope" }))
      const error = await fetchModelsWithKey({ baseURL: "https://example.com/v1", key: SECRET, fetchFn: run }).catch(
        (err) => err,
      )
      expect(error).toBeInstanceOf(ModelDiscoveryError)
      expect(error.kind).toBe("auth")
      expect(error.message).toContain(`HTTP ${status}`)
      expect(error.message).not.toContain(SECRET)
    }
  })

  test("classifies malformed, oversize, and too-many as invalid", async () => {
    const malformed = fetchFn(() => jsonResponse(200, "not-json{{{"))
    await expect(fetchModelsWithKey({ baseURL: "https://example.com/v1", key: SECRET, fetchFn: malformed.run })).rejects.toThrow(
      "invalid models response",
    )
    const oversize = fetchFn(() => new Response("x".repeat(MODEL_DISCOVERY_MAX_BODY_BYTES + 1), { status: 200 }))
    await expect(
      fetchModelsWithKey({ baseURL: "https://example.com/v1", key: SECRET, fetchFn: oversize.run }),
    ).rejects.toThrow("oversized")
    const many = fetchFn(() =>
      jsonResponse(200, { data: Array.from({ length: MODEL_DISCOVERY_MAX_MODELS + 1 }, (_, i) => ({ id: `m${i}` })) }),
    )
    await expect(fetchModelsWithKey({ baseURL: "https://example.com/v1", key: SECRET, fetchFn: many.run })).rejects.toThrow(
      "too many",
    )
  })

  test("classifies transport failures and non-auth statuses as upstream", async () => {
    const refused = fetchFn(() => {
      throw new Error("connection refused")
    })
    await expect(
      fetchModelsWithKey({ baseURL: "https://example.com/v1", key: SECRET, fetchFn: refused.run }),
    ).rejects.toThrow("request failed")
    const broken = fetchFn(() => jsonResponse(500, { error: "boom" }))
    const error = await fetchModelsWithKey({
      baseURL: "https://example.com/v1",
      key: SECRET,
      fetchFn: broken.run,
    }).catch((err) => err)
    expect(error).toBeInstanceOf(ModelDiscoveryError)
    expect(error.kind).toBe("upstream")
    expect(error.message).not.toContain(SECRET)
  })

  test("rejects non-http baseURLs", async () => {
    const { run, seen } = fetchFn(() => jsonResponse(200, { data: [] }))
    await expect(fetchModelsWithKey({ baseURL: "ftp://example.com/v1", key: SECRET, fetchFn: run })).rejects.toThrow(
      "invalid",
    )
    expect(seen.calls).toBe(0)
  })

  test("rejects userinfo/query/fragment baseURLs without fetching", async () => {
    for (const baseURL of [
      "https://user@example.com/v1",
      "https://example.com/v1?key=x",
      "https://example.com/v1#frag",
    ]) {
      const { run, seen } = fetchFn(() => jsonResponse(200, { data: [] }))
      await expect(fetchModelsWithKey({ baseURL, key: SECRET, fetchFn: run })).rejects.toThrow("invalid")
      expect(seen.calls).toBe(0)
    }
  })

  test("sends redirect manual and treats any 3xx as a redacted upstream failure", async () => {
    for (const location of ["/v1/other", "https://other.example.net/v1/models"]) {
      const { run, seen } = fetchFn(() => jsonResponse(301, "moved", { location }))
      const error = await fetchModelsWithKey({
        baseURL: "https://example.com/v1",
        key: SECRET,
        fetchFn: run,
      }).catch((err) => err)
      expect(seen.redirect).toBe("manual")
      expect(seen.calls).toBe(1)
      expect(error).toBeInstanceOf(ModelDiscoveryError)
      expect(error.kind).toBe("upstream")
      expect(error.message).toBe("Provider models request failed")
      expect(error.message).not.toContain(location)
      expect(error.message).not.toContain(SECRET)
    }
  })

  test("pre-rejects declared oversize bodies without consuming the stream", async () => {
    // Infinite body: completing at all proves the header rejects first.
    // (Bun may issue a single cancellation-related pull; chunks are never
    // accumulated, buffered, or parsed.)
    const { response, pulls } = infiniteStreamResponse({
      "content-length": String(MODEL_DISCOVERY_MAX_BODY_BYTES + 1),
    })
    const { run } = fetchFn(() => response)
    await expect(
      fetchModelsWithKey({ baseURL: "https://example.com/v1", key: SECRET, fetchFn: run }),
    ).rejects.toThrow("oversized")
    expect(pulls()).toBeLessThan(5)
  })

  test("stops chunked bodies at the byte bound and cancels", async () => {
    const chunk = new Uint8Array(65536)
    const { response, pulls } = streamResponse(Array.from({ length: 20 }, () => chunk))
    const { run } = fetchFn(() => response)
    await expect(
      fetchModelsWithKey({ baseURL: "https://example.com/v1", key: SECRET, fetchFn: run }),
    ).rejects.toThrow("oversized")
    // 20 x 64KiB would be needed to finish; the bound must stop reads early.
    expect(pulls()).toBeLessThan(20)
  })

  test("counts multibyte bodies in bytes, not characters", async () => {
    // 600k chars but 1.2M UTF-8 bytes: a character-length check would pass.
    const text = "é".repeat(600_000)
    const encoded = new TextEncoder().encode(text)
    expect(encoded.byteLength).toBeGreaterThan(MODEL_DISCOVERY_MAX_BODY_BYTES)
    const mid = Math.floor(encoded.length / 2)
    const { response } = streamResponse([encoded.slice(0, mid), encoded.slice(mid)])
    const { run } = fetchFn(() => response)
    await expect(
      fetchModelsWithKey({ baseURL: "https://example.com/v1", key: SECRET, fetchFn: run }),
    ).rejects.toThrow("oversized")
  })

  test("never reads error bodies and never leaks them", async () => {
    for (const status of [401, 500]) {
      const { response, pulls } = streamResponse(
        [new TextEncoder().encode("sensitive-upstream-detail")],
        undefined,
        status,
      )
      const { run } = fetchFn(() => response)
      const error = await fetchModelsWithKey({
        baseURL: "https://example.com/v1",
        key: SECRET,
        fetchFn: run,
      }).catch((err) => err)
      expect(error).toBeInstanceOf(ModelDiscoveryError)
      expect(error.kind).toBe(status === 401 ? "auth" : "upstream")
      expect(pulls()).toBeLessThan(5)
      expect(error.message).not.toContain("sensitive-upstream-detail")
      expect(error.message).not.toContain(SECRET)
    }
  })

  test("treats body read aborts as upstream failures", async () => {
    const { run } = fetchFn(() => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new DOMException("aborted", "AbortError"))
        },
      })
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } })
    })
    const error = await fetchModelsWithKey({
      baseURL: "https://example.com/v1",
      key: SECRET,
      fetchFn: run,
    }).catch((err) => err)
    expect(error).toBeInstanceOf(ModelDiscoveryError)
    expect(error.kind).toBe("upstream")
    expect(error.message).toBe("Provider models request failed")
  })
})
