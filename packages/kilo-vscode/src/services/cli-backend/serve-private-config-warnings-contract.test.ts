import { describe, expect, test } from "bun:test"
import {
  canonicalConfigWarningsOpId,
  checkConfigWarningsScope,
  compareConfigWarningsParity,
  configWarningKey,
  CONFIG_WARNINGS_FAILURE_FORBIDDEN,
  isConfigWarningsValidationError,
  makeConfigWarningsAmbiguous,
  normalizePrivateConfigWarningsWire,
  parseConfigWarningsOpId,
  ConfigWarningsValidationError,
  validateConfigWarning,
  validateConfigWarnings,
  validateConfigWarningsContractRequest,
  validateConfigWarningsFailure,
  validateConfigWarningsResult,
} from "./serve-private-config-warnings-contract"

function makeReq(over: Record<string, unknown> = {}) {
  const opId = canonicalConfigWarningsOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "config/warnings" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
    ...over,
  }
}

function makeWarning(over: Record<string, unknown> = {}) {
  return { path: "/tmp/.kilo/kilo.jsonc", message: "Configuration is invalid at /tmp/.kilo/kilo.jsonc", ...over }
}

function makeSucceeded(req: ReturnType<typeof validateConfigWarningsContractRequest>, over: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    requestId: req.requestId,
    opId: req.opId,
    op: "config/warnings" as const,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded" as const,
    outcome: { type: "succeeded" as const, time: 1 },
    accepted: true as const,
    data: { warnings: [makeWarning()], ...(over as { warnings?: unknown[] }) },
  }
}

describe("Gate B config/warnings candidate contract", () => {
  test("opId grammar is single token with idempotency equality", () => {
    expect(canonicalConfigWarningsOpId("t1")).toBe("config-warnings:t1")
    expect(() => canonicalConfigWarningsOpId("")).toThrow()
    expect(() => canonicalConfigWarningsOpId("a:b")).toThrow()
    expect(parseConfigWarningsOpId(canonicalConfigWarningsOpId("t1"))).toEqual({ token: "t1" })
    expect(() => parseConfigWarningsOpId("path:t1")).toThrow()
    expect(() => parseConfigWarningsOpId("config-warnings:a:b")).toThrow()
  })

  test("request validation enforces strict v1 directory/workspace read envelope", () => {
    const req = makeReq()
    expect(() => validateConfigWarningsContractRequest(req)).not.toThrow()
    expect(() => validateConfigWarningsContractRequest({ ...req, v: 2 })).toThrow()
    expect(() => validateConfigWarningsContractRequest({ ...req, op: "remote/status" })).toThrow()
    expect(() => validateConfigWarningsContractRequest({ ...req, idempotencyKey: canonicalConfigWarningsOpId("other") })).toThrow()
    expect(() => validateConfigWarningsContractRequest({ ...req, context: { directory: "relative" } })).toThrow()
    expect(() => validateConfigWarningsContractRequest({ ...req, context: { directory: "/tmp\0" } })).toThrow()
    expect(() => validateConfigWarningsContractRequest({ ...req, payload: { limit: 1 } })).toThrow()
    expect(() => validateConfigWarningsContractRequest({ ...req, extra: 1 })).toThrow()
    expect(() => validateConfigWarningsContractRequest({ ...req, context: { directory: "/tmp", sessionId: "ses_x" } })).toThrow()
  })

  test("scope mismatch is typed by directory/workspace/request", () => {
    const req = validateConfigWarningsContractRequest(makeReq())
    expect(checkConfigWarningsScope(req, { directory: "/tmp", token: "tok1" })).toEqual({ ok: true })
    expect(checkConfigWarningsScope(req, { directory: "/other", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "directory",
    })
    expect(checkConfigWarningsScope(req, { directory: "/tmp/", token: "tok1" })).toEqual({ ok: true })
    expect(checkConfigWarningsScope(req, { directory: "/tmp", workspace: "ws1", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "workspace",
    })
    expect(checkConfigWarningsScope(req, { directory: "/tmp", token: "tok2" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "request",
    })
  })

  test("warning projection is bounded to path/message/detail without redaction claim", () => {
    expect(() => validateConfigWarning(makeWarning())).not.toThrow()
    expect(() => validateConfigWarning({ ...makeWarning(), detail: "a.b: bad" })).not.toThrow()
    expect(() => validateConfigWarning({ path: "/p", message: "m", detail: 1 })).toThrow()
    expect(() => validateConfigWarning({ path: "", message: "m" })).toThrow()
    expect(() => validateConfigWarning({ path: "/p", message: "" })).toThrow()
    expect(() => validateConfigWarning({ path: "/p", message: "m", extra: 1 })).toThrow()
    expect(() => validateConfigWarning({ path: "/p" })).toThrow()
    expect(() => validateConfigWarnings([makeWarning()])).not.toThrow()
    expect(() => validateConfigWarnings("nope")).toThrow()
    expect(() => validateConfigWarnings([{ path: "/p", message: "m", extra: 1 }])).toThrow()
    // Direct agent/command frontmatter and substitution shapes carry no detail.
    expect(() => validateConfigWarning({ path: "/g/agent/a.md", message: "Failed to parse agent /g/agent/a.md" })).not.toThrow()
    expect(() =>
      validateConfigWarning({ path: "/g/command/c.md", message: "Failed to substitute variables in agent /g/agent/a.md" }),
    ).not.toThrow()
    // caughtWarning/handleInvalid shapes carry detail.
    expect(() =>
      validateConfigWarning({ path: "/g/kilo.jsonc", message: "Config file at /g/kilo.jsonc is not valid JSON(C)", detail: "oops" }),
    ).not.toThrow()
  })

  test("succeeded result asserts shape only with no directory binding", () => {
    const a = validateConfigWarningsContractRequest(makeReq({ context: { directory: "/a" } }))
    const b = validateConfigWarningsContractRequest(makeReq({ requestId: "r2", context: { directory: "/b" } }))
    const okA = makeSucceeded(a)
    expect(() => validateConfigWarningsResult(okA, a)).not.toThrow()
    const samePayloadOtherDir = { ...makeSucceeded(b), data: okA.data }
    expect(() => validateConfigWarningsResult(samePayloadOtherDir, b)).not.toThrow()
    const empty = { ...makeSucceeded(a), data: { warnings: [] } }
    expect(() => validateConfigWarningsResult(empty, a)).not.toThrow()
    expect(() => validateConfigWarningsResult({ ...okA, data: { warnings: [{ path: "/p" }] } }, a)).toThrow()
  })

  test("failures are redacted with complete forbidden-key coverage", () => {
    expect(() => validateConfigWarningsFailure({ code: "c", message: "m", retryable: false })).not.toThrow()
    const forbidden = [...CONFIG_WARNINGS_FAILURE_FORBIDDEN]
    expect(forbidden.length).toBeGreaterThan(0)
    for (const key of forbidden) {
      expect(() => validateConfigWarningsFailure({ code: "x", message: "m", retryable: false, [key]: "raw" })).toThrow()
    }
    const expected = ["path", "detail", "warnings", "warning", "directory", "workspace", "config", "session", "sessionId", "prompt", "tool", "error", "raw", "output"]
    for (const key of expected) {
      expect(forbidden).toContain(key)
    }
    expect(() => validateConfigWarningsFailure({ code: "", message: "m", retryable: false })).toThrow()
    expect(() => validateConfigWarningsFailure({ code: "x", message: "m", retryable: "yes" })).toThrow()
    expect(() => validateConfigWarningsFailure({ code: "x", message: "m", retryable: false, extra: 1 })).toThrow()
    const req = validateConfigWarningsContractRequest(makeReq())
    const failed = {
      v: 1 as const,
      requestId: req.requestId,
      opId: req.opId,
      op: "config/warnings" as const,
      idempotencyKey: req.idempotencyKey,
      status: "failed" as const,
      outcome: { type: "failed" as const, time: 1, failure: { code: "c", message: "m", retryable: false } },
      accepted: false as const,
      failure: { code: "c", message: "m", retryable: false },
    }
    expect(() => validateConfigWarningsResult(failed, req)).not.toThrow()
    expect(() => validateConfigWarningsResult({ ...failed, data: { warnings: [] } }, req)).toThrow()
  })

  test("wire normalization separates invalid wire from normal failure", () => {
    const req = validateConfigWarningsContractRequest(makeReq())
    const ok = validateConfigWarningsResult(makeSucceeded(req), req)
    expect(normalizePrivateConfigWarningsWire(makeSucceeded(req), req)).toEqual({ kind: "valid", result: ok })
    const invalid = normalizePrivateConfigWarningsWire({ bogus: true }, req)
    expect(invalid.kind).toBe("invalid")
    if (invalid.kind === "invalid") {
      expect(new ConfigWarningsValidationError(invalid.detail)).toSatisfy((e) => isConfigWarningsValidationError(e))
    }
    const amb = makeConfigWarningsAmbiguous(req)
    expect(amb.status).toBe("ambiguous")
    expect(() => validateConfigWarningsResult(amb, req)).not.toThrow()
  })

  test("parity detects bidirectional membership gaps and malformed SDK warnings", () => {
    const req = validateConfigWarningsContractRequest(makeReq())
    const ok = validateConfigWarningsResult(makeSucceeded(req), req)
    expect(compareConfigWarningsParity(ok, { data: [makeWarning()] }).divergence).toBeNull()
    const parityBase = compareConfigWarningsParity(ok, { data: [makeWarning()] }).details
    expect(parityBase.ownerUnknown).toBeTrue()
    expect(parityBase.freshnessUnknown).toBeTrue()
    expect(parityBase.redactionUnknown).toBeTrue()
    // Order is not compared.
    const two = validateConfigWarningsResult(
      { ...makeSucceeded(req), data: { warnings: [makeWarning(), makeWarning({ path: "/b", message: "mb" })] } },
      req,
    )
    expect(compareConfigWarningsParity(two, { data: [makeWarning({ path: "/b", message: "mb" }), makeWarning()] }).divergence).toBeNull()
    // Priv-only entry -> gap unknown.
    const privGap = compareConfigWarningsParity(two, { data: [makeWarning()] })
    expect(privGap.divergence?.startsWith("config-warnings-membership-unknown:")).toBeTrue()
    // SDK-only entry -> gap unknown (bidirectional).
    const sdkGap = compareConfigWarningsParity(ok, { data: [makeWarning(), makeWarning({ path: "/b", message: "mb" })] })
    expect(sdkGap.divergence?.startsWith("config-warnings-membership-unknown:")).toBeTrue()
    // Malformed SDK warning entries are shape mismatches, never silent skips.
    expect(compareConfigWarningsParity(ok, { data: [{ path: "/p" }] }).divergence).toBe("config-warnings-shape-mismatch")
    expect(compareConfigWarningsParity(ok, { data: "nope" }).divergence).toBe("config-warnings-shape-mismatch")
  })

  test("parity key delimits field boundaries against collisions", () => {
    // Concatenation would collide: ("ab","c") vs ("a","bc"). Tuple keys must differ.
    const left = configWarningKey({ path: "/ab", message: "c" })
    const right = configWarningKey({ path: "/a", message: "bc" })
    expect(left).not.toBe(right)
    // Missing detail vs empty-string detail stay distinct.
    expect(configWarningKey({ path: "/p", message: "m" })).not.toBe(
      configWarningKey({ path: "/p", message: "m", detail: "" }),
    )
    // Identical tuples collide by design.
    expect(configWarningKey({ path: "/p", message: "m" })).toBe(configWarningKey({ path: "/p", message: "m" }))
  })

  test("parity detects duplicate-count gaps bidirectionally as membership-unknown", () => {
    const req = validateConfigWarningsContractRequest(makeReq())
    const dup = { path: "/p", message: "m" }
    const privDup = validateConfigWarningsResult(
      { ...makeSucceeded(req), data: { warnings: [dup, dup] } },
      req,
    )
    const privSingle = validateConfigWarningsResult(makeSucceeded(req), req)
    // Priv holds 2 copies, SDK holds 1 -> gap unknown (priv direction).
    const extraPriv = compareConfigWarningsParity(privDup, { data: [{ ...dup }] })
    expect(extraPriv.divergence?.startsWith("config-warnings-membership-unknown:")).toBeTrue()
    expect(extraPriv.details.ownerUnknown).toBeTrue()
    // SDK holds 2 copies, priv holds 1 -> gap unknown (sdk direction).
    const extraSdk = compareConfigWarningsParity(privSingle, { data: [{ ...dup }, { ...dup }] })
    expect(extraSdk.divergence?.startsWith("config-warnings-membership-unknown:")).toBeTrue()
    expect(extraSdk.details.ownerUnknown).toBeTrue()
    // Equal duplicates on both sides agree.
    expect(compareConfigWarningsParity(privDup, { data: [{ ...dup }, { ...dup }] }).divergence).toBeNull()
  })

  test("parity reports transport-unknown, status mismatch, and failed-vs-failed agreement", () => {
    const req = validateConfigWarningsContractRequest(makeReq())
    const ok = validateConfigWarningsResult(makeSucceeded(req), req)
    const amb = makeConfigWarningsAmbiguous(req)
    expect(compareConfigWarningsParity(amb, { data: [makeWarning()] }).divergence).toBe("transport-unknown")
    const mismatch = compareConfigWarningsParity(ok, { error: { message: "bad" } })
    expect(mismatch.divergence).toBe("status-mismatch:sdk=failed priv=succeeded")
    const failed = validateConfigWarningsResult(
      {
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "config/warnings",
        idempotencyKey: req.idempotencyKey,
        status: "failed",
        outcome: { type: "failed", time: 1, failure: { code: "c", message: "m", retryable: false } },
        accepted: false,
        failure: { code: "c", message: "m", retryable: false },
      },
      req,
    )
    expect(compareConfigWarningsParity(failed, { error: { message: "bad" } }).divergence).toBeNull()
  })
})
