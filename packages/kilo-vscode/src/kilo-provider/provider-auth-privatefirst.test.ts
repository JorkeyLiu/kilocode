import { describe, expect, test } from "bun:test"
import {
  attemptProviderAuthPrivate,
  buildProviderAuthReq,
  fetchProviderAuthPrivateFirst,
  parseProviderAuthResult,
} from "./provider-auth-privatefirst"

function authData() {
  return {
    openai: [{ type: "api" as const, label: "API key" }],
    anthropic: [
      {
        type: "oauth" as const,
        label: "OAuth",
        prompts: [{ type: "text" as const, key: "k", message: "Enter" }],
      },
    ],
  }
}

function req() {
  return buildProviderAuthReq("/tmp/auth")
}

function okFor(r: ReturnType<typeof req>, d: unknown = authData()) {
  return { v: 1, requestId: r.requestId, op: "provider/auth", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: d }
}

function failedFor(r: ReturnType<typeof req>, code: string, message: string, retryable: boolean) {
  const failure = { code, message, retryable }
  return { v: 1, requestId: r.requestId, op: "provider/auth", status: "failed", outcome: { type: "failed", time: 1, failure }, accepted: false, failure }
}

function ambiguousFor(r: ReturnType<typeof req>) {
  return { v: 1, requestId: r.requestId, op: "provider/auth", status: "ambiguous", outcome: { type: "ambiguous", time: 1 }, accepted: false, transportUnknown: true }
}

function connFor(result: (q: ReturnType<typeof req>) => unknown, id = 1) {
  return {
    isPrivateAvailable: () => true,
    privateProviderAuthOutcomeWithHandle: (q: ReturnType<typeof req>) => ({ id, promise: Promise.resolve({ kind: "valid", result: result(q) }), cancel: () => true }),
  }
}

describe("provider-auth private-first", () => {
  test("success returns private with zero SDK", async () => {
    const out = await fetchProviderAuthPrivateFirst({
      connection: connFor((q) => okFor(q)) as never,
      client: { provider: { auth: async () => { throw new Error("must not call SDK") } } } as never,
      directory: "/tmp/auth",
    })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") expect(out.via).toBe("private")
  })

  test("terminal closes with zero SDK", async () => {
    let sdk = 0
    const out = await fetchProviderAuthPrivateFirst({
      connection: connFor((q) => failedFor(q, "validation.failed", "invalid provider-auth request", false)) as never,
      client: { provider: { auth: async () => { sdk += 1; return { data: authData() } } } } as never,
      directory: "/tmp/auth",
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
      const out = await fetchProviderAuthPrivateFirst({
        connection: connFor(maker as never) as never,
        client: { provider: { auth: async () => { sdk += 1; return { data: authData() } } } } as never,
        directory: "/tmp/auth",
      })
      expect(out.kind).toBe("ok")
      if (out.kind === "ok") expect(out.via).toBe("sdk")
      expect(sdk).toBe(1)
    }
  })

  test("timeout exact-cancels and falls back once", async () => {
    const r = buildProviderAuthReq("/tmp/auth")
    let cancelled = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateProviderAuthOutcomeWithHandle: () => ({ id: 9, promise: new Promise(() => {}), cancel: () => { cancelled += 1; return true } }),
    }
    const attempt = await attemptProviderAuthPrivate(conn as never, r, 10)
    expect(attempt.kind).toBe("fallback")
    expect(attempt.kind === "fallback" ? attempt.reason : "").toBe("timeout")
    expect(cancelled).toBe(1)
  })

  test("old SDK without method degrades to unavailable without a call", async () => {
    const out = await fetchProviderAuthPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: { provider: {} } as never,
      directory: "/tmp/auth",
    })
    expect(out.kind).toBe("unavailable")
  })

  test("malformed SDK payload degrades to unavailable", async () => {
    const out = await fetchProviderAuthPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: { provider: { auth: async () => ({ data: { openai: [{ type: "api", label: "x", extra: 1 }] } }) } } as never,
      directory: "/tmp/auth",
    })
    expect(out.kind).toBe("unavailable")
  })

  test("parse maps settled-first correctly", () => {
    const r = req()
    expect(parseProviderAuthResult(okFor(r), r).kind).toBe("ok")
    expect(parseProviderAuthResult(failedFor(r, "validation.failed", "invalid provider-auth request", false), r).kind).toBe("terminal")
    expect(parseProviderAuthResult(failedFor(r, "InstanceUnavailableDuringConfigRebuild", "Instance is unavailable during config rebuild; no active runtime for this request", true), r).kind).toBe("fallback")
    expect(parseProviderAuthResult(ambiguousFor(r), r).kind).toBe("fallback")
  })
})
