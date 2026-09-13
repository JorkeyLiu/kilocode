import { describe, expect, test } from "bun:test"
import {
  makeProviderModelsDiscoverAmbiguous,
  normalizePrivateProviderModelsDiscoverWire,
  validateProviderModelsDiscoverContractRequest,
  validateProviderModelsDiscoverData,
  validateProviderModelsDiscoverResult,
} from "./serve-private-provider-models-discover-contract"

function req() {
  return {
    v: 1 as const,
    requestId: "r-discover",
    op: "provider/models-discover" as const,
    context: { directory: "/tmp" },
    payload: { providerID: "test", baseURL: "https://example.com/v1" },
  }
}

function data(models: unknown = [{ id: "m1", name: "M1" }]) {
  return { models }
}

function ok(r: ReturnType<typeof req>, d: unknown = data()) {
  return {
    v: 1,
    requestId: r.requestId,
    op: "provider/models-discover",
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: d,
  }
}

function failed(r: ReturnType<typeof req>, code: string, message: string, retryable: boolean) {
  const failure = { code, message, retryable }
  return {
    v: 1,
    requestId: r.requestId,
    op: "provider/models-discover",
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

describe("provider-models-discover contract", () => {
  test("request strict: payload shape plus unknown fields rejected", () => {
    const r = req()
    expect(() => validateProviderModelsDiscoverContractRequest(r)).not.toThrow()
    expect(() => validateProviderModelsDiscoverContractRequest({ ...r, opId: "x" })).toThrow()
    expect(() => validateProviderModelsDiscoverContractRequest({ ...r, context: { directory: "relative" } })).toThrow()
    expect(() => validateProviderModelsDiscoverContractRequest({ ...r, payload: {} })).toThrow()
    expect(() =>
      validateProviderModelsDiscoverContractRequest({ ...r, payload: { ...r.payload, headers: {} } }),
    ).toThrow()
    expect(() =>
      validateProviderModelsDiscoverContractRequest({ ...r, payload: { providerID: "", baseURL: r.payload.baseURL } }),
    ).toThrow()
    expect(() =>
      validateProviderModelsDiscoverContractRequest({ ...r, payload: { providerID: "test", baseURL: "ftp://x/v1" } }),
    ).toThrow()
    expect(() =>
      validateProviderModelsDiscoverContractRequest({
        ...r,
        payload: { providerID: "test", baseURL: "https://x/v1?q=1" },
      }),
    ).toThrow()
    expect(() => validateProviderModelsDiscoverContractRequest({ ...r, op: "provider/catalog" })).toThrow()
  })

  test("full/empty/failed shapes validate", () => {
    const r = req()
    expect(() => validateProviderModelsDiscoverResult(ok(r), r)).not.toThrow()
    expect(() => validateProviderModelsDiscoverResult(ok(r, data([])), r)).not.toThrow()
    expect(() => validateProviderModelsDiscoverData(data())).not.toThrow()
  })

  test("secrets and unknown entry fields fail closed", () => {
    const r = req()
    for (const entry of [
      { id: "m1", name: "M1", key: "sk-secret" },
      { id: "m1", name: "M1", options: { baseURL: "https://x" } },
      { id: "m1", name: "M1", headers: {} },
      { id: "m1", name: "M1", apiKey: "sk-x" },
    ]) {
      const wire = JSON.stringify(entry)
      expect(
        wire.includes("sk-") || wire.includes("headers") || wire.includes("baseURL") || wire.includes("apiKey"),
      ).toBeTrue()
      expect(() => validateProviderModelsDiscoverData(data([entry]))).toThrow()
      expect(normalizePrivateProviderModelsDiscoverWire(ok(r, data([entry])), r).kind).toBe("invalid")
    }
    expect(() => validateProviderModelsDiscoverData(data([{ id: "", name: "M" }]))).toThrow()
    expect(() => validateProviderModelsDiscoverData(data([{ id: "m", name: "" }]))).toThrow()
    expect(normalizePrivateProviderModelsDiscoverWire({ v: 1, bad: true }, r).kind).toBe("invalid")
    expect(normalizePrivateProviderModelsDiscoverWire(ok(r), { ...r, requestId: "other" } as never).kind).toBe(
      "invalid",
    )
  })

  test("failure taxonomy fixed messages with unauthorized terminal", () => {
    const r = req()
    const terminal = failed(r, "validation.failed", "invalid provider models-discover request", false)
    expect(() => validateProviderModelsDiscoverResult(terminal, r)).not.toThrow()
    const auth = failed(r, "unauthorized", "stored credential failed authentication", false)
    expect(() => validateProviderModelsDiscoverResult(auth, r)).not.toThrow()
    const fence = failed(
      r,
      "InstanceUnavailableDuringConfigRebuild",
      "Instance is unavailable during config rebuild; no active runtime for this request",
      true,
    )
    expect(() => validateProviderModelsDiscoverResult(fence, r)).not.toThrow()
    const badMsg = failed(r, "unauthorized", "wrong", false)
    expect(() => validateProviderModelsDiscoverResult(badMsg, r)).toThrow()
    const badRetry = failed(r, "unauthorized", "stored credential failed authentication", true)
    expect(() => validateProviderModelsDiscoverResult(badRetry, r)).toThrow()
    expect(() => validateProviderModelsDiscoverResult(failed(r, "nope", "x", false), r)).toThrow()
    expect(makeProviderModelsDiscoverAmbiguous(r).status).toBe("ambiguous")
  })
})
