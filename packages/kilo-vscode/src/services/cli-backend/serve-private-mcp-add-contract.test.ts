import { describe, expect, test } from "bun:test"
import {
  canonicalMcpAddOpId,
  isSettledMcpAddResult,
  makeMcpAddAmbiguous,
  normalizePrivateMcpAddWire,
  parseMcpAddOpId,
  validateMcpAddContractRequest,
  validateMcpAddFailure,
  validateMcpAddResult,
} from "./serve-private-mcp-add-contract"
import type { McpAddContractRequest } from "./serve-private-mcp-add-contract"

const DIR = "/repo"

function localConfig(overrides: Record<string, unknown> = {}) {
  return {
    type: "local",
    command: ["npx", "@playwright/mcp@latest"],
    enabled: true,
    timeout: 60000,
    ...overrides,
  }
}

function req(over: Record<string, unknown> = {}): McpAddContractRequest {
  const opId = canonicalMcpAddOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "mcp/add" as const,
    idempotencyKey: opId,
    context: { directory: DIR },
    payload: { name: "kilo-playwright", config: localConfig() as never },
    ...over,
  } as McpAddContractRequest
}

function succeededFor(r: McpAddContractRequest, status: Record<string, unknown> = { demo: { status: "connected" } }) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "mcp/add",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { status },
  }
}

function failedFor(r: McpAddContractRequest, code = "internal", retryable = false) {
  const failure = { code, message: "m", retryable }
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "mcp/add",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { ...failure } },
    accepted: false,
    failure: { ...failure },
  }
}

describe("mcp-add private contract", () => {
  test("opId binds the mcp-add token with no path material", () => {
    expect(canonicalMcpAddOpId("abc")).toBe("mcp-add:abc")
    expect(parseMcpAddOpId("mcp-add:abc")).toEqual({ token: "abc" })
    expect(() => canonicalMcpAddOpId("a:b")).toThrow()
    expect(() => canonicalMcpAddOpId("a/b")).toThrow()
    expect(() => parseMcpAddOpId("mcp-connect:abc")).toThrow()
    expect(() => parseMcpAddOpId("mcp-add:a:b")).toThrow()
  })

  test("valid local registration request is accepted", () => {
    const r = req()
    expect(validateMcpAddContractRequest(r).op).toBe("mcp/add")
    expect(validateMcpAddContractRequest(r).payload.name).toBe("kilo-playwright")
  })

  test("unknown fields and identity mismatches are rejected", () => {
    const r = req()
    expect(() => validateMcpAddContractRequest({ ...r, extra: 1 })).toThrow()
    expect(() => validateMcpAddContractRequest({ ...r, op: "mcp/connect" })).toThrow()
    expect(() => validateMcpAddContractRequest({ ...r, idempotencyKey: "mcp-add:other" })).toThrow()
    expect(() =>
      validateMcpAddContractRequest({ ...r, context: { directory: DIR, workspace: "w" } }),
    ).toThrow()
    expect(() =>
      validateMcpAddContractRequest({ ...r, payload: { name: "x", config: localConfig(), extra: 1 } }),
    ).toThrow()
    expect(() => validateMcpAddContractRequest({ ...r, payload: { name: "" } })).toThrow()
    expect(() => validateMcpAddContractRequest({ ...r, context: { directory: "relative/path" } })).toThrow()
  })

  test("config validation rejects malformed registrations", () => {
    const r = req()
    const bad = (config: unknown) =>
      expect(() =>
        validateMcpAddContractRequest({ ...r, payload: { name: "x", config } }),
      ).toThrow()
    bad({ type: "local", command: [] })
    bad({ type: "local", command: ["ok"], bogus: 1 })
    bad({ type: "bogus", command: ["ok"] })
    bad({ type: "local", command: ["ok"], timeout: -1 })
    bad({ type: "local", command: ["ok"], enabled: "yes" })
    bad({ type: "remote", url: "" })
    bad({ type: "remote", url: "https://example.test", extra: 1 })
  })

  test("succeeded result carries the five-state status map", () => {
    const r = req()
    const out = validateMcpAddResult(succeededFor(r), r)
    expect(out.status).toBe("succeeded")
    const failed = succeededFor(r, { demo: { status: "bogus" } })
    expect(() => validateMcpAddResult(failed, r)).toThrow()
    const leaking = succeededFor(r, { demo: { status: "connected" } })
    ;(leaking as Record<string, unknown>).failure = { code: "internal", message: "m", retryable: false }
    expect(() => validateMcpAddResult(leaking, r)).toThrow()
  })

  test("only CLI-authoritative failure codes are accepted", () => {
    const r = req()
    for (const code of ["validation.failed", "scope_mismatch", "InstanceUnavailableDuringConfigRebuild", "internal"]) {
      expect(validateMcpAddResult(failedFor(r, code), r).status).toBe("failed")
    }
    expect(() => validateMcpAddResult(failedFor(r, "mcp.not_found"), r)).toThrow()
    expect(() => validateMcpAddFailure({ code: "internal", message: "m", retryable: false, config: {} })).toThrow()
    expect(() => validateMcpAddFailure({ code: "nope", message: "m", retryable: false })).toThrow()
  })

  test("ambiguous and invalid wire fail closed", () => {
    const r = req()
    expect(normalizePrivateMcpAddWire(makeMcpAddAmbiguous(r, true), r).kind).toBe("valid")
    expect(normalizePrivateMcpAddWire({ v: 1 }, r).kind).toBe("invalid")
    expect(isSettledMcpAddResult(succeededFor(r), r)).toBeTrue()
    expect(isSettledMcpAddResult(failedFor(r), r)).toBeTrue()
    expect(isSettledMcpAddResult({ status: "nope" }, r)).toBeFalse()
  })
})
