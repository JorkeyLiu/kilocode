import { describe, expect, test } from "bun:test"
import {
  makeProviderCatalogAmbiguous,
  normalizePrivateProviderCatalogWire,
  validateProviderCatalogContractRequest,
  validateProviderCatalogData,
  validateProviderCatalogResult,
} from "./serve-private-provider-catalog-contract"

function caps() {
  return {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  }
}

function mdl(id = "gpt-4", overrides: Record<string, unknown> = {}) {
  return {
    id,
    providerID: "openai",
    api: { id, url: "https://api.openai.com", npm: "@ai-sdk/openai" },
    name: "GPT-4",
    capabilities: caps(),
    cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
    limit: { context: 8000, output: 1000 },
    status: "active",
    release_date: "2024-01-01",
    ...overrides,
  }
}

function prov(overrides: Record<string, unknown> = {}) {
  return {
    id: "openai",
    name: "OpenAI",
    source: "api",
    env: [],
    hasCredential: true,
    models: { "gpt-4": mdl() },
    ...overrides,
  }
}

function data(overrides: Record<string, unknown> = {}) {
  return { all: [prov()], default: { openai: "gpt-4" }, connected: ["openai"], failed: [], ...overrides }
}

function req() {
  return { v: 1 as const, requestId: "r-cat", op: "provider/catalog" as const, context: { directory: "/tmp" }, payload: {} }
}

function ok(r: ReturnType<typeof req>, d: unknown = data()) {
  return { v: 1, requestId: r.requestId, op: "provider/catalog", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: d }
}

function failed(r: ReturnType<typeof req>, code: string, message: string, retryable: boolean) {
  const failure = { code, message, retryable }
  return { v: 1, requestId: r.requestId, op: "provider/catalog", status: "failed", outcome: { type: "failed", time: 1, failure }, accepted: false, failure }
}

describe("provider-catalog contract", () => {
  test("request strict: unknown fields rejected", () => {
    const r = req()
    expect(() => validateProviderCatalogContractRequest(r)).not.toThrow()
    expect(() => validateProviderCatalogContractRequest({ ...r, opId: "x" })).toThrow()
    expect(() => validateProviderCatalogContractRequest({ ...r, context: { directory: "relative" } })).toThrow()
    expect(() => validateProviderCatalogContractRequest({ ...r, payload: { q: 1 } })).toThrow()
    expect(() => validateProviderCatalogContractRequest({ ...r, op: "agent/list" })).toThrow()
  })

  test("full/empty/failed shapes validate", () => {
    const r = req()
    expect(() => validateProviderCatalogResult(ok(r), r)).not.toThrow()
    expect(() => validateProviderCatalogResult(ok(r, data({ all: [], default: {}, connected: [], failed: [] })), r)).not.toThrow()
    expect(() => validateProviderCatalogResult(ok(r, data({ failed: ["broken"] })), r)).not.toThrow()
    expect(() => validateProviderCatalogData(data())).not.toThrow()
  })

  test("secrets fail closed at every layer", () => {
    const r = req()
    for (const secret of [
      prov({ key: "sk-secret" }),
      prov({ options: { baseURL: "https://x" } }),
      { ...prov(), models: { "gpt-4": { ...mdl(), options: {}, headers: {} } } },
      { ...prov(), models: { "gpt-4": { ...mdl(), variants: { v1: { apiKey: "sk-x" } } } } },
      { ...prov(), models: { "gpt-4": { ...mdl(), variants: { v1: { headers: {} } } } } },
    ]) {
      const wire = JSON.stringify(secret)
      expect(wire.includes("sk-") || wire.includes("apiKey") || wire.includes("headers") || wire.includes("baseURL")).toBeTrue()
      expect(() => validateProviderCatalogData(data({ all: [secret] }))).toThrow()
      expect(normalizePrivateProviderCatalogWire(ok(r, data({ all: [secret] })), r).kind).toBe("invalid")
    }
  })

  test("unknown fields rejected, strict schema", () => {
    const r = req()
    expect(() => validateProviderCatalogData({ ...data(), extra: 1 })).toThrow()
    expect(() => validateProviderCatalogData(data({ all: [{ ...prov(), extra: 1 }] }))).toThrow()
    expect(() => validateProviderCatalogData(data({ all: [prov()], default: { openai: 1 } as never }))).toThrow()
    expect(normalizePrivateProviderCatalogWire({ v: 1, bad: true }, r).kind).toBe("invalid")
    expect(normalizePrivateProviderCatalogWire(ok(r), { ...r, requestId: "other" } as never).kind).toBe("invalid")
  })

  test("failure taxonomy fixed messages", () => {
    const r = req()
    const terminal = failed(r, "validation.failed", "invalid provider-catalog request", false)
    expect(() => validateProviderCatalogResult(terminal, r)).not.toThrow()
    const fence = failed(r, "InstanceUnavailableDuringConfigRebuild", "Instance is unavailable during config rebuild; no active runtime for this request", true)
    expect(() => validateProviderCatalogResult(fence, r)).not.toThrow()
    const badMsg = failed(r, "validation.failed", "wrong", false)
    expect(() => validateProviderCatalogResult(badMsg, r)).toThrow()
    expect(makeProviderCatalogAmbiguous(r).status).toBe("ambiguous")
  })
})
