import { describe, expect, test } from "bun:test"
import {
  ProviderHttpExecuteWire,
  HTTP_BODY_MAX_BYTES,
  HTTP_CHUNK_MAX_BYTES,
  hasDuplicateTopLevelModelKey,
  isForbiddenHeaderName,
} from "../../src/kilocode/provider-http-execute"

const baseRecord = {
  name: "Acme",
  endpoint: "https://api.example.com/v1",
  protocol: "openai/completions" as const,
  models: { m1: { name: "M1" } },
  credential: "secret:kilo.credentials.global.provider.acme",
}

const validBody = JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] })

function req(over: Record<string, unknown> = {}) {
  return {
    providerId: "acme",
    modelId: "m1",
    record: baseRecord,
    body: validBody,
    ...over,
  }
}

describe("provider/httpExecute wire", () => {
  test("validates request happy path", () => {
    expect(() => ProviderHttpExecuteWire.validateRequest(req())).not.toThrow()
  })

  test("rejects caller-sensitive headers", () => {
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { authorization: "Bearer x" } }))).toThrow()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { "x-api-key": "x" } }))).toThrow()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { cookie: "x" } }))).toThrow()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { host: "evil.com" } }))).toThrow()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { "content-length": "10" } }))).toThrow()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { connection: "keep-alive" } }))).toThrow()
  })

  test("allows non-sensitive headers", () => {
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-custom": "ok" } }))).not.toThrow()
  })

  test("rejects body model mismatch and invalid JSON", () => {
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ body: JSON.stringify({ model: "other" }) }))).toThrow()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ body: "not json" }))).toThrow()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ body: "" }))).toThrow()
  })

  test("rejects extra keys", () => {
    expect(() => ProviderHttpExecuteWire.validateRequest({ ...req(), extra: 1 } as unknown as Record<string, unknown>)).toThrow()
  })

  test("body size bounded", () => {
    const big = "x".repeat(HTTP_BODY_MAX_BYTES + 1)
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ body: big }))).toThrow()
  })

  test("metadata validation", () => {
    expect(() => ProviderHttpExecuteWire.validateMetadata({ seq: 0, status: 200, headers: {} })).not.toThrow()
    expect(() => ProviderHttpExecuteWire.validateMetadata({ seq: 1, status: 200, headers: {} })).toThrow()
    expect(() => ProviderHttpExecuteWire.validateMetadata({ seq: 0, status: 99, headers: {} })).toThrow()
    expect(() => ProviderHttpExecuteWire.validateMetadata({ seq: 0, status: 200, headers: { authorization: "x" } })).toThrow()
  })

  test("chunk validation", () => {
    const b64 = Buffer.from("hello").toString("base64")
    expect(() => ProviderHttpExecuteWire.validateChunk({ seq: 1, bytes: b64 })).not.toThrow()
    expect(() => ProviderHttpExecuteWire.validateChunk({ seq: 0, bytes: b64 })).toThrow()
    expect(() => ProviderHttpExecuteWire.validateChunk({ seq: 1, bytes: "!!!notbase64" })).toThrow()
    const bigBytes = Buffer.alloc(HTTP_CHUNK_MAX_BYTES + 1).toString("base64")
    expect(() => ProviderHttpExecuteWire.validateChunk({ seq: 1, bytes: bigBytes })).toThrow()
  })

  test("result validation", () => {
    expect(() => ProviderHttpExecuteWire.validateResult({ seq: 0, chunks: 0, bytes: 0 })).not.toThrow()
    expect(() => ProviderHttpExecuteWire.validateResult({ seq: 2, chunks: 2, bytes: 10 })).not.toThrow()
    expect(() => ProviderHttpExecuteWire.validateResult({ seq: 1, chunks: 0, bytes: 0 })).toThrow()
    expect(() => ProviderHttpExecuteWire.validateResult({ seq: 2, chunks: 1, bytes: 10 })).toThrow()
  })

  // --- coverage findings: duplicate model and dangerous headers ---

  test("duplicate top-level model key is rejected", () => {
    const body = `{"model":"m1","model":"m1","messages":[]}`
    expect(hasDuplicateTopLevelModelKey(body)).toBeTrue()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ body }))).toThrow(/duplicate/i)

    // whitespace variation still duplicate
    const spaced = `{"model" : "m1" , "model" : "m1"}`
    expect(hasDuplicateTopLevelModelKey(spaced)).toBeTrue()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ body: spaced }))).toThrow()

    // different model value but duplicate key still invalid (also model mismatch but duplicate takes precedence or at least throws)
    const dupOther = `{"model":"m1","model":"other"}`
    expect(hasDuplicateTopLevelModelKey(dupOther)).toBeTrue()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ body: dupOther }))).toThrow()
  })

  test("escaped-key duplicate is detected", () => {
    // second key uses escaped unicode for 'model'
    const escaped = `{"model":"m1","\\u006d\\u006f\\u0064\\u0065\\u006c":"m1"}`
    expect(hasDuplicateTopLevelModelKey(escaped)).toBeTrue()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ body: escaped }))).toThrow(/duplicate/i)

    // escaped with whitespace and different escape form
    const escaped2 = `{"model":"m1","\\u006D\\u006F\\u0064\\u0065\\u006C":"m1"}`
    expect(hasDuplicateTopLevelModelKey(escaped2)).toBeTrue()

    // escaped inside string value should not be counted as key
    const valueEscaped = `{"model":"m1","other":"\\u006d\\u006f\\u0064\\u0065\\u006c"}`
    expect(hasDuplicateTopLevelModelKey(valueEscaped)).toBeFalse()
    // but valid request passes
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ body: JSON.stringify({ model: "m1", other: "model" }) }))).not.toThrow()

    // key that looks like model inside string content not counted
    const insideString = `{"model":"m1","x":"{\\"model\\":\\"m1\\"}"}`
    expect(hasDuplicateTopLevelModelKey(insideString)).toBeFalse()
  })

  test("nested model non-duplicate is allowed", () => {
    const nested = JSON.stringify({ model: "m1", nested: { model: "other" }, arr: [{ model: "x" }] })
    expect(hasDuplicateTopLevelModelKey(nested)).toBeFalse()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ body: nested }))).not.toThrow()

    // deeply nested duplicate inside nested object should not count
    const deep = `{"model":"m1","a":{"model":"m1","b":{"model":"m1"}}}`
    expect(hasDuplicateTopLevelModelKey(deep)).toBeFalse()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ body: deep }))).not.toThrow()

    // only duplicate at depth 1 counts, array at top level with objects containing model not counted
    const arrayTop = `{"model":"m1","list":[{"model":"m1"},{"model":"m1"}]}`
    expect(hasDuplicateTopLevelModelKey(arrayTop)).toBeFalse()
  })

  test("string value containing model substring not counted", () => {
    const tricky = `{"model":"m1","msg":"model: \\"model\\" is word","other":"model"}`
    expect(hasDuplicateTopLevelModelKey(tricky)).toBeFalse()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ body: tricky }))).not.toThrow()
  })

  test("forbidden exact and hop-by-hop/proxy headers rejected regardless of case", () => {
    const dangerous = [
      "upgrade",
      "forwarded",
      "via",
      "te",
      "trailer",
      "transfer-encoding",
      "keep-alive",
      "proxy-connection",
      "proxy-authorization",
      "proxy-authenticate",
      "authorization",
      "cookie",
      "host",
      "connection",
      "content-length",
      "x-api-key",
    ]
    for (const name of dangerous) {
      // lowercase
      expect(isForbiddenHeaderName(name)).toBeTrue()
      expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { [name]: "x" } }))).toThrow(/forbidden|header/i)
      // mixed case should be rejected (lowercase enforcement + forbidden)
      const mixed = name
        .split("-")
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join("-")
      expect(isForbiddenHeaderName(mixed.toLowerCase())).toBeTrue()
      expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { [mixed]: "x" } as unknown as Record<string, string> }))).toThrow()
      // upper
      expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { [name.toUpperCase()]: "x" } as unknown as Record<string, string> }))).toThrow()
    }
    // substring matching
    expect(isForbiddenHeaderName("x-my-apikey-header")).toBeTrue()
    expect(isForbiddenHeaderName("x-forwarded-for")).toBeTrue()
    expect(isForbiddenHeaderName("my-proxy-header")).toBeTrue()
    expect(isForbiddenHeaderName("custom-signature")).toBeTrue()
    expect(isForbiddenHeaderName("x-auth-token")).toBeTrue()
    // allowed headers not forbidden
    expect(isForbiddenHeaderName("x-custom")).toBeFalse()
    expect(isForbiddenHeaderName("content-type")).toBeFalse()
    expect(isForbiddenHeaderName("anthropic-version")).toBeFalse()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { "x-custom": "1", "content-type": "application/json" } }))).not.toThrow()
  })

  test("hop-by-hop forbidden headers in metadata response are rejected", () => {
    const forb = ["upgrade", "forwarded", "via", "te", "trailer", "transfer-encoding", "keep-alive", "proxy-connection"]
    for (const h of forb) {
      expect(() => ProviderHttpExecuteWire.validateMetadata({ seq: 0, status: 200, headers: { [h]: "x" } })).toThrow(/forbidden/i)
      const mixed = h.charAt(0).toUpperCase() + h.slice(1)
      expect(() => ProviderHttpExecuteWire.validateMetadata({ seq: 0, status: 200, headers: { [mixed]: "x" } as unknown as Record<string, string> })).toThrow()
    }
  })

  test("validateRequest rejects dangerous headers case-insensitively even when lowercase rule fails first", () => {
    // Ensure the error is thrown for forbidden name regardless of lowercase check order
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { "Upgrade": "websocket" } as unknown as Record<string, string> }))).toThrow()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { "Forwarded": "for=1" } as unknown as Record<string, string> }))).toThrow()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { "Via": "1.1 proxy" } as unknown as Record<string, string> }))).toThrow()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { "Te": "trailers" } as unknown as Record<string, string> }))).toThrow()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { "Trailer": "Expires" } as unknown as Record<string, string> }))).toThrow()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { "Transfer-Encoding": "chunked" } as unknown as Record<string, string> }))).toThrow()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { "Keep-Alive": "timeout=5" } as unknown as Record<string, string> }))).toThrow()
    expect(() => ProviderHttpExecuteWire.validateRequest(req({ headers: { "Proxy-Connection": "keep-alive" } as unknown as Record<string, string> }))).toThrow()
  })
})
