import { describe, expect, test } from "bun:test"
import {
  makeProviderAuthAmbiguous,
  normalizePrivateProviderAuthWire,
  validateProviderAuthContractRequest,
  validateProviderAuthData,
  validateProviderAuthResult,
} from "./serve-private-provider-auth-contract"

function text(overrides: Record<string, unknown> = {}) {
  return { type: "text", key: "k", message: "Enter key", ...overrides }
}

function select(overrides: Record<string, unknown> = {}) {
  return {
    type: "select",
    key: "region",
    message: "Pick",
    options: [{ label: "A", value: "a" }],
    ...overrides,
  }
}

function data(overrides: Record<string, unknown> = {}) {
  return {
    openai: [{ type: "api", label: "API key", prompts: [text()] }],
    anthropic: [{ type: "oauth", label: "OAuth" }],
    ...overrides,
  }
}

function req() {
  return { v: 1 as const, requestId: "r-auth", op: "provider/auth" as const, context: { directory: "/tmp" }, payload: {} }
}

function ok(r: ReturnType<typeof req>, d: unknown = data()) {
  return { v: 1, requestId: r.requestId, op: "provider/auth", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: d }
}

function failed(r: ReturnType<typeof req>, code: string, message: string, retryable: boolean) {
  const failure = { code, message, retryable }
  return { v: 1, requestId: r.requestId, op: "provider/auth", status: "failed", outcome: { type: "failed", time: 1, failure }, accepted: false, failure }
}

describe("provider-auth contract", () => {
  test("request strict: unknown fields rejected", () => {
    const r = req()
    expect(() => validateProviderAuthContractRequest(r)).not.toThrow()
    expect(() => validateProviderAuthContractRequest({ ...r, opId: "x" })).toThrow()
    expect(() => validateProviderAuthContractRequest({ ...r, context: { directory: "relative" } })).toThrow()
    expect(() => validateProviderAuthContractRequest({ ...r, payload: { q: 1 } })).toThrow()
    expect(() => validateProviderAuthContractRequest({ ...r, op: "provider/catalog" })).toThrow()
  })

  test("full/empty shapes validate", () => {
    const r = req()
    expect(() => validateProviderAuthResult(ok(r), r)).not.toThrow()
    expect(() => validateProviderAuthResult(ok(r, {}), r)).not.toThrow()
    expect(() => validateProviderAuthData(data())).not.toThrow()
    expect(() => validateProviderAuthData({})).not.toThrow()
  })

  test("select prompts and when/options validate", () => {
    expect(() =>
      validateProviderAuthData({
        p: [{ type: "api", label: "L", prompts: [select()] }],
      }),
    ).not.toThrow()
    expect(() =>
      validateProviderAuthData({
        p: [{ type: "api", label: "L", prompts: [text({ placeholder: "hint", when: { key: "k", op: "eq", value: "v" } })] }],
      }),
    ).not.toThrow()
    expect(() =>
      validateProviderAuthData({
        p: [{ type: "api", label: "L", prompts: [select({ options: [{ label: "A", value: "a", hint: "h" }] })] }],
      }),
    ).not.toThrow()
  })

  test("unknown nested fields rejected fail-closed", () => {
    const r = req()
    const cases: unknown[] = [
      { openai: [{ type: "api", label: "L", extra: 1 }] },
      { openai: [{ type: "api", label: "L", prompts: [{ ...text(), extra: 1 }] }] },
      { openai: [{ type: "api", label: "L", prompts: [{ ...text(), when: { key: "k", op: "eq", value: "v", extra: 1 } }] }] },
      { openai: [{ type: "api", label: "L", prompts: [{ ...select(), options: [{ label: "A", value: "a", extra: 1 }] }] }] },
      { openai: [{ type: "api", label: "L", prompts: [{ type: "text", key: "k", message: "m", placeholder: null }] }] },
      { openai: [{ type: "api", label: "L", prompts: [{ type: "select", key: "k", message: "m" }] }] },
      { openai: [{ type: "api", label: "L", prompts: [{ type: "weird", key: "k", message: "m" }] }] },
      { openai: [{ type: "bogus", label: "L" }] },
      { "": [{ type: "api", label: "L" }] },
    ]
    for (const bad of cases) {
      expect(() => validateProviderAuthData(bad)).toThrow()
      expect(normalizePrivateProviderAuthWire(ok(r, bad), r).kind).toBe("invalid")
    }
  })

  test("null optional degrades, absent valid", () => {
    expect(() => validateProviderAuthData({ p: [{ type: "api", label: "L" }] })).not.toThrow()
    expect(() => validateProviderAuthData({ p: [{ type: "api", label: "L", prompts: null }] })).toThrow()
    expect(() => validateProviderAuthData({ p: [{ type: "api", label: null }] })).toThrow()
  })

  test("strict result schema", () => {
    const r = req()
    expect(() => validateProviderAuthResult({ ...ok(r), extra: 1 }, r)).toThrow()
    expect(normalizePrivateProviderAuthWire({ v: 1, bad: true }, r).kind).toBe("invalid")
    expect(normalizePrivateProviderAuthWire(ok(r), { ...r, requestId: "other" } as never).kind).toBe("invalid")
  })

  test("failure taxonomy fixed messages", () => {
    const r = req()
    const terminal = failed(r, "validation.failed", "invalid provider-auth request", false)
    expect(() => validateProviderAuthResult(terminal, r)).not.toThrow()
    const fence = failed(r, "InstanceUnavailableDuringConfigRebuild", "Instance is unavailable during config rebuild; no active runtime for this request", true)
    expect(() => validateProviderAuthResult(fence, r)).not.toThrow()
    const badMsg = failed(r, "validation.failed", "wrong", false)
    expect(() => validateProviderAuthResult(badMsg, r)).toThrow()
    expect(makeProviderAuthAmbiguous(r).status).toBe("ambiguous")
  })
})
