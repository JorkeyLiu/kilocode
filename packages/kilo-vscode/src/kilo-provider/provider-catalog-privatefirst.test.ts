import { describe, expect, test } from "bun:test"
import {
  attemptProviderCatalogPrivate,
  buildProviderCatalogReq,
  fetchProviderCatalogPrivateFirst,
  parseProviderCatalogResult,
} from "./provider-catalog-privatefirst"

function caps() {
  return {
    temperature: true, reasoning: false, attachment: false, toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  }
}

function catalogData() {
  return {
    all: [{ id: "openai", name: "OpenAI", source: "api", env: [], hasCredential: true, models: { "gpt-4": { id: "gpt-4", providerID: "openai", api: { id: "gpt-4", url: "https://x", npm: "n" }, name: "GPT-4", capabilities: caps(), cost: { input: 1, output: 2, cache: { read: 0, write: 0 } }, limit: { context: 8, output: 1 }, status: "active", release_date: "2024-01-01" } } }],
    default: {}, connected: ["openai"], failed: [],
  }
}

function req() {
  return buildProviderCatalogReq("/tmp/catalog")
}

function okFor(r: ReturnType<typeof req>, d: unknown = catalogData()) {
  return { v: 1, requestId: r.requestId, op: "provider/catalog", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: d }
}

function failedFor(r: ReturnType<typeof req>, code: string, message: string, retryable: boolean) {
  const failure = { code, message, retryable }
  return { v: 1, requestId: r.requestId, op: "provider/catalog", status: "failed", outcome: { type: "failed", time: 1, failure }, accepted: false, failure }
}

function ambiguousFor(r: ReturnType<typeof req>) {
  return { v: 1, requestId: r.requestId, op: "provider/catalog", status: "ambiguous", outcome: { type: "ambiguous", time: 1 }, accepted: false, transportUnknown: true }
}

function connFor(result: (q: ReturnType<typeof req>) => unknown, id = 1) {
  return {
    isPrivateAvailable: () => true,
    privateProviderCatalogOutcomeWithHandle: (q: ReturnType<typeof req>) => ({ id, promise: Promise.resolve({ kind: "valid", result: result(q) }), cancel: () => true }),
  }
}

describe("provider-catalog private-first", () => {
  test("success returns private with zero SDK", async () => {
    const out = await fetchProviderCatalogPrivateFirst({
      connection: connFor((q) => okFor(q)) as never,
      client: { provider: { catalog: async () => { throw new Error("must not call SDK") } } } as never,
      directory: "/tmp/catalog",
    })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") expect(out.via).toBe("private")
  })

  test("terminal closes with zero SDK", async () => {
    let sdk = 0
    const out = await fetchProviderCatalogPrivateFirst({
      connection: connFor((q) => failedFor(q, "validation.failed", "invalid provider-catalog request", false)) as never,
      client: { provider: { catalog: async () => { sdk += 1; return { data: catalogData() } } } } as never,
      directory: "/tmp/catalog",
    })
    expect(out.kind).toBe("terminal")
    expect(sdk).toBe(0)
  })

  test("retryable/invalid/ambiguous/transport/timeout take exactly one SDK fallback", async () => {
    for (const maker of [
      (q: ReturnType<typeof req>) => failedFor(q, "InstanceUnavailableDuringConfigRebuild", "Instance is unavailable during config rebuild; no active runtime for this request", true),
      (q: ReturnType<typeof req>) => ambiguousFor(q),
      (_q: ReturnType<typeof req>) => ({ v: 1, bad: true }),
    ]) {
      let sdk = 0
      const out = await fetchProviderCatalogPrivateFirst({
        connection: connFor(maker as never) as never,
        client: { provider: { catalog: async () => { sdk += 1; return { data: catalogData() } } } } as never,
        directory: "/tmp/catalog",
      })
      expect(out.kind).toBe("ok")
      if (out.kind === "ok") expect(out.via).toBe("sdk")
      expect(sdk).toBe(1)
    }
  })

  test("timeout exact-cancels and falls back once", async () => {
    const r = buildProviderCatalogReq("/tmp/catalog")
    let cancelled = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateProviderCatalogOutcomeWithHandle: () => ({ id: 9, promise: new Promise(() => {}), cancel: () => { cancelled += 1; return true } }),
    }
    const attempt = await attemptProviderCatalogPrivate(conn as never, r, 10)
    expect(attempt.kind).toBe("fallback")
    expect(attempt.kind === "fallback" ? attempt.reason : "").toBe("timeout")
    expect(cancelled).toBe(1)
  })

  test("secret SDK payload fails closed to unavailable", async () => {
    const r = req()
    const secret = catalogData()
    ;(((secret.all[0] as Record<string, unknown>).models as Record<string, unknown>)["gpt-4"] as Record<string, unknown>)["key"] = "sk-leak"
    const out = await fetchProviderCatalogPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: { provider: { catalog: async () => ({ data: secret }) } } as never,
      directory: "/tmp/catalog",
    })
    expect(out.kind).toBe("unavailable")
    void r
  })

  test("parse maps settled-first correctly", () => {
    const r = req()
    expect(parseProviderCatalogResult(okFor(r), r).kind).toBe("ok")
    expect(parseProviderCatalogResult(failedFor(r, "validation.failed", "invalid provider-catalog request", false), r).kind).toBe("terminal")
    expect(parseProviderCatalogResult(failedFor(r, "InstanceUnavailableDuringConfigRebuild", "Instance is unavailable during config rebuild; no active runtime for this request", true), r).kind).toBe("fallback")
    expect(parseProviderCatalogResult(ambiguousFor(r), r).kind).toBe("fallback")
  })
})
