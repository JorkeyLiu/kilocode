import { describe, expect, test } from "bun:test"
import {
  classifyProbeStatus,
  effectiveFallbackSelection,
  isGenerationShape,
  parseFallbackSelection,
  probeBody,
  probeFallbackProvider,
  probeUrl,
  strictProbeEndpoint,
} from "../../src/kilo-provider/fallback-probe"
import { CLOSED_JSONC_FIELDS, getEntry, isGuiField, snapshotKeys } from "../../src/config/registry"
import { toCanonicalPayload } from "../../src/config/types"

const SECRET = "sk-live-probe-secret-123"

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function capture() {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return ok({ choices: [{ message: { content: "hi" } }] })
  }
  return { calls, fetchFn: fetchFn as typeof fetch }
}

describe("fallback selection", () => {
  test("parses one provider/model selection", () => {
    expect(parseFallbackSelection("custom/gpt-4o")).toEqual({ providerID: "custom", modelID: "gpt-4o" })
    expect(parseFallbackSelection("bad")).toBeUndefined()
    expect(parseFallbackSelection(undefined)).toBeUndefined()
    expect(parseFallbackSelection(42)).toBeUndefined()
  })
  test("effective selection prefers project over global, never reads model", () => {
    expect(effectiveFallbackSelection("custom/a", "other/b")).toEqual({ providerID: "custom", modelID: "a" })
    expect(effectiveFallbackSelection(undefined, "other/b")).toEqual({ providerID: "other", modelID: "b" })
    expect(effectiveFallbackSelection(undefined, undefined)).toBeUndefined()
    expect(effectiveFallbackSelection("bad", "other/b")).toBeUndefined()
  })
  test("registry is closed with fallback_model as a hot-style single preference", () => {
    expect(CLOSED_JSONC_FIELDS).toContain("fallback_model")
    expect(isGuiField("fallback_model")).toBe(true)
    expect(snapshotKeys()).toContain("fallback_model")
    const entry = getEntry("fallback_model")
    expect(entry?.composition).toBe("single")
    expect(entry?.secret).toBe("none")
    // Ordinary primary model selector is untouched.
    expect(getEntry("model")?.composition).toBe("single")
  })
  test("canonical payload accepts string and null, rejects secrets by shape", () => {
    expect(toCanonicalPayload({ fallback_model: "custom/m" })?.fallback_model).toBe("custom/m")
    expect(toCanonicalPayload({ fallback_model: null })?.fallback_model).toBe(null)
    expect(toCanonicalPayload({ fallback_model: 42 })).toBeUndefined()
    expect(toCanonicalPayload({ fallback_model: { nested: true } })).toBeUndefined()
    expect(toCanonicalPayload({ unknown_key: 1 })).toBeUndefined()
  })
})

describe("fallback probe request", () => {
  test("strict endpoint rejects credentials, query, fragments, and non-http", () => {
    expect(strictProbeEndpoint("https://api.example.com/v1/")).toBe("https://api.example.com/v1")
    expect(strictProbeEndpoint("http://localhost:8080")).toBe("http://localhost:8080")
    for (const bad of [
      "https://user:pass@api.example.com/v1",
      "https://api.example.com/v1?key=1",
      "https://api.example.com/v1#frag",
      "ftp://api.example.com/v1",
      "not a url",
      "",
      undefined,
    ]) {
      expect(strictProbeEndpoint(bad)).toBeUndefined()
    }
  })
  test("probe URL uses the fixed protocol route, never /models", () => {
    expect(probeUrl("https://api.example.com/v1", "openai/completions")).toBe(
      "https://api.example.com/v1/chat/completions",
    )
    expect(probeUrl("https://api.example.com/v1", "openai/responses")).toBe("https://api.example.com/v1/responses")
    expect(probeUrl("https://api.example.com/v1", "anthropic/messages")).toBe("https://api.example.com/v1/messages")
    expect(probeUrl("https://user@api.example.com/v1", "openai/completions")).toBeUndefined()
  })
  test("probe body is one token, no tools, deterministic prompt", () => {
    for (const protocol of ["openai/completions", "openai/responses", "anthropic/messages"] as const) {
      const body = probeBody(protocol, "m1")
      expect(body.model).toBe("m1")
      expect(body.stream).toBe(false)
      expect(body.temperature).toBe(0)
      expect("tools" in body).toBe(false)
      expect("tool_choice" in body).toBe(false)
      const text = JSON.stringify(body)
      expect(text).not.toContain("/models")
    }
    expect(probeBody("openai/completions", "m1").max_tokens).toBe(1)
  })
  test("generation shape requires protocol output, not a bare 200", () => {
    expect(isGenerationShape("openai/completions", { choices: [] })).toBe(true)
    expect(isGenerationShape("openai/completions", { data: [] })).toBe(false)
    expect(isGenerationShape("openai/responses", { output: [] })).toBe(true)
    expect(isGenerationShape("anthropic/messages", { content: [] })).toBe(true)
    expect(isGenerationShape("anthropic/messages", "<html>ok</html>")).toBe(false)
  })
  test("status classification without leaking bodies", () => {
    expect(classifyProbeStatus(401)).toMatchObject({ usable: false, reason: "auth" })
    expect(classifyProbeStatus(403)).toMatchObject({ usable: false, reason: "auth" })
    expect(classifyProbeStatus(429)).toMatchObject({ usable: false, reason: "rate-limit" })
    expect(classifyProbeStatus(404)).toMatchObject({ usable: false, reason: "invalid-model" })
    expect(classifyProbeStatus(400)).toMatchObject({ usable: false, reason: "invalid-model" })
    expect(classifyProbeStatus(302)).toMatchObject({ usable: false, reason: "upstream" })
    expect(classifyProbeStatus(500)).toMatchObject({ usable: false, reason: "upstream" })
  })
})

describe("fallback probe execution", () => {
  test("usable on a real generation response with manual redirect and bearer secret", async () => {
    const { calls, fetchFn } = capture()
    const result = await probeFallbackProvider({
      endpoint: "https://api.example.com/v1",
      protocol: "openai/completions",
      modelID: "m1",
      secret: SECRET,
      fetchFn,
    })
    expect(result).toEqual({ usable: true })
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe("https://api.example.com/v1/chat/completions")
    expect(calls[0]!.init.method).toBe("POST")
    expect(calls[0]!.init.redirect).toBe("manual")
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`)
    const body = JSON.parse(String(calls[0]!.init.body))
    expect(body.max_tokens).toBe(1)
    expect(body.model).toBe("m1")
  })
  test("auth failure is reported without the response body or secret", async () => {
    const result = await probeFallbackProvider({
      endpoint: "https://api.example.com/v1",
      protocol: "openai/completions",
      modelID: "m1",
      secret: SECRET,
      fetchFn: (async () =>
        new Response(JSON.stringify({ error: { code: "bad-key", hint: SECRET } }), { status: 401 })) as typeof fetch,
    })
    expect(result).toMatchObject({ usable: false, reason: "auth" })
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(JSON.stringify(result)).not.toContain("bad-key")
  })
  test("rate-limit and invalid-model map distinctly", async () => {
    const limited = await probeFallbackProvider({
      endpoint: "https://api.example.com/v1",
      protocol: "openai/completions",
      modelID: "m1",
      secret: SECRET,
      fetchFn: (async () => new Response("{}", { status: 429 })) as typeof fetch,
    })
    expect(limited).toMatchObject({ usable: false, reason: "rate-limit" })
    const missing = await probeFallbackProvider({
      endpoint: "https://api.example.com/v1",
      protocol: "openai/completions",
      modelID: "nope",
      secret: SECRET,
      fetchFn: (async () => new Response("{}", { status: 404 })) as typeof fetch,
    })
    expect(missing).toMatchObject({ usable: false, reason: "invalid-model" })
  })
  test("network failure and invalid config stay distinct", async () => {
    const down = await probeFallbackProvider({
      endpoint: "https://api.example.com/v1",
      protocol: "openai/completions",
      modelID: "m1",
      secret: SECRET,
      fetchFn: (async () => {
        throw new Error("socket hang up")
      }) as typeof fetch,
    })
    expect(down).toMatchObject({ usable: false, reason: "network" })
    expect(
      await probeFallbackProvider({
        endpoint: "https://user@host/v1",
        protocol: "openai/completions",
        modelID: "m1",
        secret: SECRET,
      }),
    ).toMatchObject({ usable: false, reason: "invalid-config" })
    expect(
      await probeFallbackProvider({
        endpoint: "https://api.example.com/v1",
        protocol: "nope",
        modelID: "m1",
        secret: SECRET,
      }),
    ).toMatchObject({ usable: false, reason: "invalid-config" })
    expect(
      await probeFallbackProvider({
        endpoint: "https://api.example.com/v1",
        protocol: "openai/completions",
        modelID: "m1",
        secret: "",
      }),
    ).toMatchObject({ usable: false, reason: "auth" })
  })
  test("wrong-shape 200 and oversized bodies are upstream, never usable", async () => {
    const html = await probeFallbackProvider({
      endpoint: "https://api.example.com/v1",
      protocol: "openai/completions",
      modelID: "m1",
      secret: SECRET,
      fetchFn: (async () => ok({ data: [] })) as typeof fetch,
    })
    expect(html).toMatchObject({ usable: false, reason: "upstream" })
    const huge = await probeFallbackProvider({
      endpoint: "https://api.example.com/v1",
      protocol: "openai/completions",
      modelID: "m1",
      secret: SECRET,
      fetchFn: (async () =>
        new Response("{}", { status: 200, headers: { "content-length": String(10 * 1024 * 1024) } })) as typeof fetch,
    })
    expect(huge).toMatchObject({ usable: false, reason: "upstream" })
  })
})
