import { describe, expect, test } from "bun:test"
import {
  canonicalMcpAuthenticateOpId,
  canonicalMcpConnectOpId,
  canonicalMcpDisconnectOpId,
  isSettledMcpAuthenticateResult,
  isSettledMcpConnectResult,
  isSettledMcpDisconnectResult,
  makeMcpAuthenticateAmbiguous,
  makeMcpConnectAmbiguous,
  makeMcpDisconnectAmbiguous,
  normalizePrivateMcpAuthenticateWire,
  normalizePrivateMcpConnectWire,
  normalizePrivateMcpDisconnectWire,
  parseMcpAuthenticateOpId,
  parseMcpConnectOpId,
  parseMcpDisconnectOpId,
  validateMcpAuthenticateContractRequest,
  validateMcpAuthenticateResult,
  validateMcpConnectContractRequest,
  validateMcpConnectResult,
  validateMcpConnectionFailure,
  validateMcpDisconnectContractRequest,
  validateMcpDisconnectResult,
} from "./serve-private-mcp-connection-contract"

const DIR = "/repo"

function connectReq(over: Record<string, unknown> = {}) {
  const opId = canonicalMcpConnectOpId("t1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "mcp/connect" as const,
    idempotencyKey: opId,
    context: { directory: DIR },
    payload: { name: "demo" },
    ...over,
  }
}

function disconnectReq(over: Record<string, unknown> = {}) {
  const opId = canonicalMcpDisconnectOpId("t1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "mcp/disconnect" as const,
    idempotencyKey: opId,
    context: { directory: DIR },
    payload: { name: "demo" },
    ...over,
  }
}

function connectOk(req: ReturnType<typeof connectReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/connect",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { connected: true },
  }
}

function disconnectOk(req: ReturnType<typeof disconnectReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/disconnect",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { disconnected: true },
  }
}

function authenticateReq(over: Record<string, unknown> = {}) {
  const opId = canonicalMcpAuthenticateOpId("t1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "mcp/authenticate" as const,
    idempotencyKey: opId,
    context: { directory: DIR },
    payload: { name: "demo" },
    ...over,
  }
}

function authenticateOk(req: ReturnType<typeof authenticateReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/authenticate",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { authenticated: true },
  }
}

function failedFor(req: { requestId: string; opId: string; idempotencyKey: string }, op: string, code = "mcp.not_found", retryable = false) {
  const failure = { code, message: "m", retryable }
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { ...failure } },
    accepted: false,
    failure: { ...failure },
  }
}

describe("mcp-connection private contract", () => {
  test("opId builders bind colon-free pathless tokens per op", () => {
    expect(canonicalMcpConnectOpId("t1")).toBe("mcp-connect:t1")
    expect(canonicalMcpDisconnectOpId("t1")).toBe("mcp-disconnect:t1")
    expect(canonicalMcpAuthenticateOpId("t1")).toBe("mcp-authenticate:t1")
    expect(parseMcpConnectOpId("mcp-connect:t1")).toEqual({ token: "t1" })
    expect(parseMcpDisconnectOpId("mcp-disconnect:t1")).toEqual({ token: "t1" })
    expect(parseMcpAuthenticateOpId("mcp-authenticate:t1")).toEqual({ token: "t1" })
    expect(() => parseMcpConnectOpId("mcp-disconnect:t1")).toThrow()
    expect(() => parseMcpDisconnectOpId("mcp-connect:t1")).toThrow()
    expect(() => parseMcpAuthenticateOpId("mcp-connect:t1")).toThrow()
    expect(() => canonicalMcpConnectOpId("a/b")).toThrow()
    expect(() => parseMcpConnectOpId("mcp-connect:a:b")).toThrow()
    expect(() => canonicalMcpAuthenticateOpId("a:b")).toThrow()
  })

  test("strict requests reject unknown fields, scope drift, and bad payloads", () => {
    const good = connectReq()
    expect(validateMcpConnectContractRequest(good)).toEqual(good)
    expect(validateMcpDisconnectContractRequest(disconnectReq())).toBeTruthy()
    expect(() => validateMcpConnectContractRequest({ ...good, extra: 1 })).toThrow()
    expect(() => validateMcpConnectContractRequest({ ...good, context: { directory: DIR, other: 1 } })).toThrow()
    expect(() => validateMcpConnectContractRequest({ ...good, context: { directory: "relative" } })).toThrow()
    expect(() => validateMcpConnectContractRequest({ ...good, payload: { name: "" } })).toThrow()
    expect(() => validateMcpConnectContractRequest({ ...good, payload: { name: "demo", extra: 1 } })).toThrow()
    expect(() => validateMcpConnectContractRequest({ ...good, idempotencyKey: "mcp-connect:other" })).toThrow()
    expect(() => validateMcpConnectContractRequest({ ...good, op: "mcp/disconnect" })).toThrow()
    expect(() => validateMcpDisconnectContractRequest({ ...disconnectReq(), op: "mcp/connect" })).toThrow()
    expect(() => validateMcpConnectContractRequest({ ...good, opId: "mcp-disconnect:t1", idempotencyKey: "mcp-disconnect:t1" })).toThrow()
    const auth = authenticateReq()
    expect(validateMcpAuthenticateContractRequest(auth)).toEqual(auth)
    expect(() => validateMcpAuthenticateContractRequest({ ...auth, extra: 1 })).toThrow()
    expect(() => validateMcpAuthenticateContractRequest({ ...auth, op: "mcp/connect" })).toThrow()
    expect(() => validateMcpAuthenticateContractRequest({ ...auth, payload: { name: "" } })).toThrow()
    expect(() => validateMcpAuthenticateContractRequest({ ...auth, idempotencyKey: "mcp-authenticate:other" })).toThrow()
    expect(() => validateMcpConnectContractRequest({ ...good, op: "mcp/authenticate" })).toThrow()
  })

  test("succeeded results require the exact accepted data shape", () => {
    const c = connectReq()
    expect(validateMcpConnectResult(connectOk(c), c).status).toBe("succeeded")
    expect(() => validateMcpConnectResult({ ...connectOk(c), accepted: false }, c)).toThrow()
    expect(() => validateMcpConnectResult({ ...connectOk(c), data: { connected: false } }, c)).toThrow()
    expect(() => validateMcpConnectResult({ ...connectOk(c), data: {} }, c)).toThrow()
    // Cross-op data is rejected: connect never carries disconnected and vice versa.
    expect(() => validateMcpConnectResult({ ...connectOk(c), data: { disconnected: true } }, c)).toThrow()
    const d = disconnectReq()
    expect(validateMcpDisconnectResult(disconnectOk(d), d).status).toBe("succeeded")
    expect(() => validateMcpDisconnectResult({ ...disconnectOk(d), data: { connected: true } }, d)).toThrow()
    const a = authenticateReq()
    expect(validateMcpAuthenticateResult(authenticateOk(a), a).status).toBe("succeeded")
    expect(() => validateMcpAuthenticateResult({ ...authenticateOk(a), data: { connected: true } }, a)).toThrow()
    expect(() => validateMcpAuthenticateResult({ ...authenticateOk(a), data: { authenticated: false } }, a)).toThrow()
  })

  test("failed results echo identities and accept only CLI-authoritative codes", () => {
    const c = connectReq()
    for (const code of ["mcp.not_found", "validation.failed", "scope_mismatch", "internal"]) {
      const out = validateMcpConnectResult(failedFor(c, "mcp/connect", code), c)
      expect(out.status).toBe("failed")
    }
    const fence = failedFor(c, "mcp/connect", "InstanceUnavailableDuringConfigRebuild", true)
    expect(validateMcpConnectResult(fence, c).status).toBe("failed")
    expect(() => validateMcpConnectionFailure({ code: "boom", message: "m", retryable: false })).toThrow()
    expect(() => validateMcpConnectionFailure({ code: "internal", message: "m", retryable: false, name: "demo" })).toThrow()
    expect(() =>
      validateMcpConnectResult({ ...failedFor(c, "mcp/connect"), op: "mcp/disconnect" }, c),
    ).toThrow()
    const mismatched = failedFor(c, "mcp/connect")
    mismatched.outcome.failure = { code: "internal", message: "m", retryable: false }
    expect(() => validateMcpConnectResult(mismatched, c)).toThrow()
  })

  test("ambiguous makers and settled checks treat every valid outcome as settled", () => {
    const c = connectReq()
    const d = disconnectReq()
    const ca = makeMcpConnectAmbiguous(c)
    expect(ca.status).toBe("ambiguous")
    expect(ca.accepted).toBeFalse()
    expect(validateMcpConnectResult(ca, c).status).toBe("ambiguous")
    expect(isSettledMcpConnectResult(connectOk(c), c)).toBeTrue()
    expect(isSettledMcpConnectResult(failedFor(c, "mcp/connect"), c)).toBeTrue()
    expect(isSettledMcpConnectResult(ca, c)).toBeTrue()
    expect(isSettledMcpConnectResult({ status: "succeeded" }, c)).toBeFalse()
    const da = makeMcpDisconnectAmbiguous(d)
    expect(validateMcpDisconnectResult(da, d).status).toBe("ambiguous")
    expect(isSettledMcpDisconnectResult(disconnectOk(d), d)).toBeTrue()
    expect(isSettledMcpDisconnectResult(failedFor(d, "mcp/disconnect"), d)).toBeTrue()
    expect(isSettledMcpDisconnectResult(da, d)).toBeTrue()
  })

  test("wire normalization keeps invalid wire explicit", () => {
    const c = connectReq()
    expect(normalizePrivateMcpConnectWire(connectOk(c), c).kind).toBe("valid")
    expect(normalizePrivateMcpConnectWire({ nope: 1 }, c).kind).toBe("invalid")
    const d = disconnectReq()
    expect(normalizePrivateMcpDisconnectWire(disconnectOk(d), d).kind).toBe("valid")
    expect(normalizePrivateMcpDisconnectWire(disconnectOk(d), { ...d, requestId: "other" } as never).kind).toBe("invalid")
    const a = authenticateReq()
    expect(normalizePrivateMcpAuthenticateWire(authenticateOk(a), a).kind).toBe("valid")
    expect(normalizePrivateMcpAuthenticateWire({ nope: 1 }, a).kind).toBe("invalid")
    expect(isSettledMcpAuthenticateResult(authenticateOk(a), a)).toBeTrue()
    expect(isSettledMcpAuthenticateResult(failedFor(a, "mcp/authenticate"), a)).toBeTrue()
    expect(isSettledMcpAuthenticateResult(makeMcpAuthenticateAmbiguous(a), a)).toBeTrue()
    expect(isSettledMcpAuthenticateResult({ status: "succeeded" }, a)).toBeFalse()
  })
})
