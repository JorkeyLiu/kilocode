import { describe, expect, test } from "bun:test"
import {
  canonicalConfigWarningsOpId,
  checkConfigWarningsScope,
  compareConfigWarningsParity,
  configWarningKey,
  configWarningsMessageCategory,
  configWarningsPathCategory,
  CONFIG_WARNINGS_FAILURE_FORBIDDEN,
  isConfigWarningsValidationError,
  makeConfigWarningsAmbiguous,
  normalizePrivateConfigWarningsWire,
  parseConfigWarningsOpId,
  projectConfigWarningToSafe,
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

function makeSafe(over: Record<string, unknown> = {}) {
  return { pathCategory: "agent-file", messageCategory: "invalid-file", ...over }
}

function makeSucceeded(
  req: ReturnType<typeof validateConfigWarningsContractRequest>,
  over: Record<string, unknown> = {},
) {
  return {
    v: 1 as const,
    requestId: req.requestId,
    opId: req.opId,
    op: "config/warnings" as const,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded" as const,
    outcome: { type: "succeeded" as const, time: 1 },
    accepted: true as const,
    data: { warnings: [makeSafe()], ...(over as { warnings?: unknown[] }) },
  }
}

function rawWarning(path: string, message: string, detail?: string) {
  return detail === undefined ? { path, message } : { path, message, detail }
}

describe("config/warnings safe private contract", () => {
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
    expect(() =>
      validateConfigWarningsContractRequest({ ...req, idempotencyKey: canonicalConfigWarningsOpId("other") }),
    ).toThrow()
    expect(() => validateConfigWarningsContractRequest({ ...req, context: { directory: "relative" } })).toThrow()
    expect(() => validateConfigWarningsContractRequest({ ...req, context: { directory: "/tmp\0" } })).toThrow()
    expect(() => validateConfigWarningsContractRequest({ ...req, payload: { limit: 1 } })).toThrow()
    expect(() => validateConfigWarningsContractRequest({ ...req, extra: 1 })).toThrow()
    expect(() =>
      validateConfigWarningsContractRequest({ ...req, context: { directory: "/tmp", sessionId: "ses_x" } }),
    ).toThrow()
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

  test("safe projection maps producer templates to finite categories", () => {
    expect(projectConfigWarningToSafe("/g/kilo.jsonc", "Config file at /g/kilo.jsonc is not valid JSON(C)")).toEqual({
      pathCategory: "config-file",
      messageCategory: "invalid-json",
    })
    expect(projectConfigWarningToSafe("/g/kilo.jsonc", "Configuration is invalid at /g/kilo.jsonc: bad")).toEqual({
      pathCategory: "config-file",
      messageCategory: "invalid-config",
    })
    expect(projectConfigWarningToSafe("/g/agent/a.md", "Config file at /g/agent/a.md is invalid: bad")).toEqual({
      pathCategory: "agent-file",
      messageCategory: "invalid-file",
    })
    expect(projectConfigWarningToSafe("/g/agent/a.md", "Failed to parse agent /g/agent/a.md")).toEqual({
      pathCategory: "agent-file",
      messageCategory: "parse-agent",
    })
    expect(projectConfigWarningToSafe("/g/command/c.md", "Failed to parse command /g/command/c.md")).toEqual({
      pathCategory: "command-file",
      messageCategory: "parse-command",
    })
    expect(
      projectConfigWarningToSafe("/g/agent/a.md", "Failed to substitute variables in agent /g/agent/a.md"),
    ).toEqual({
      pathCategory: "agent-file",
      messageCategory: "substitute-agent",
    })
    // Verbatim frontmatter text and future templates fall into unknown by design.
    expect(projectConfigWarningToSafe("/g/agent/a.md", "some verbatim frontmatter failure")).toEqual({
      pathCategory: "agent-file",
      messageCategory: "unknown",
    })
    expect(projectConfigWarningToSafe("/x/notes.txt", "weird new template")).toEqual({
      pathCategory: "other",
      messageCategory: "unknown",
    })
  })

  test("path/message category helpers stay finite", () => {
    expect(configWarningsPathCategory("/A/AGENT/x.md")).toBe("agent-file")
    expect(configWarningsPathCategory("/a/command/y.md")).toBe("command-file")
    expect(configWarningsPathCategory("/a/KILO.JSONC")).toBe("config-file")
    expect(configWarningsPathCategory("/a/b.txt")).toBe("other")
    expect(configWarningsMessageCategory("Config file at p is invalid")).toBe("invalid-file")
    expect(configWarningsMessageCategory("nope")).toBe("unknown")
  })

  test("safe entries validate categories only and reject raw fields", () => {
    expect(() => validateConfigWarning(makeSafe())).not.toThrow()
    expect(() => validateConfigWarning({ pathCategory: "other", messageCategory: "unknown" })).not.toThrow()
    expect(() => validateConfigWarning({ pathCategory: "config-file", messageCategory: "bogus" })).toThrow()
    expect(() => validateConfigWarning({ pathCategory: "absolute", messageCategory: "unknown" })).toThrow()
    expect(() => validateConfigWarning({ path: "/p", message: "m" })).toThrow()
    expect(() => validateConfigWarning({ ...makeSafe(), detail: "text" })).toThrow()
    expect(() => validateConfigWarning({ ...makeSafe(), path: "/p" })).toThrow()
    expect(() => validateConfigWarning({ ...makeSafe(), message: "m" })).toThrow()
    expect(() => validateConfigWarning({ pathCategory: "other" })).toThrow()
    expect(() => validateConfigWarnings([makeSafe()])).not.toThrow()
    expect(() => validateConfigWarnings("nope")).toThrow()
    expect(() => validateConfigWarnings([{ path: "/p", message: "m" }])).toThrow()
  })

  test("safe payload carries no absolute path, raw text, or detail", () => {
    const req = validateConfigWarningsContractRequest(makeReq())
    const ok = makeSucceeded(req)
    const wire = JSON.stringify(ok)
    expect(wire.includes("/tmp")).toBeFalse()
    expect(wire.includes("detail")).toBeFalse()
    expect(() => validateConfigWarningsResult(ok, req)).not.toThrow()
    const empty = { ...makeSucceeded(req), data: { warnings: [] } }
    expect(() => validateConfigWarningsResult(empty, req)).not.toThrow()
    expect(() => validateConfigWarningsResult({ ...ok, data: { warnings: [{ path: "/p" }] } }, req)).toThrow()
  })

  test("succeeded result accepts identical safe payload under another directory", () => {
    const a = validateConfigWarningsContractRequest(makeReq({ context: { directory: "/a" } }))
    const b = validateConfigWarningsContractRequest(makeReq({ requestId: "r2", context: { directory: "/b" } }))
    const okA = makeSucceeded(a)
    expect(() => validateConfigWarningsResult(okA, a)).not.toThrow()
    const samePayloadOtherDir = { ...makeSucceeded(b), data: okA.data }
    expect(() => validateConfigWarningsResult(samePayloadOtherDir, b)).not.toThrow()
  })

  test("failures are redacted with complete forbidden-key coverage", () => {
    expect(() =>
      validateConfigWarningsFailure({ code: "internal", message: "internal error", retryable: false }),
    ).not.toThrow()
    expect(() =>
      validateConfigWarningsFailure({
        code: "InstanceUnavailableDuringConfigRebuild",
        message: "Instance is unavailable during config rebuild; no active runtime for this request",
        retryable: true,
      }),
    ).not.toThrow()
    const forbidden = [...CONFIG_WARNINGS_FAILURE_FORBIDDEN]
    expect(forbidden.length).toBeGreaterThan(0)
    for (const key of forbidden) {
      expect(() =>
        validateConfigWarningsFailure({
          code: "internal",
          message: "internal error",
          retryable: false,
          [key]: "raw",
        }),
      ).toThrow()
    }
    const expected = [
      "path",
      "detail",
      "warnings",
      "warning",
      "directory",
      "workspace",
      "config",
      "session",
      "sessionId",
      "prompt",
      "tool",
      "error",
      "raw",
      "output",
    ]
    for (const key of expected) {
      expect(forbidden).toContain(key)
    }
    expect(() => validateConfigWarningsFailure({ code: "", message: "m", retryable: false })).toThrow()
    expect(() =>
      validateConfigWarningsFailure({ code: "internal", message: "internal error", retryable: "yes" }),
    ).toThrow()
    expect(() =>
      validateConfigWarningsFailure({ code: "internal", message: "internal error", retryable: false, extra: 1 }),
    ).toThrow()
    // Finite taxonomy: arbitrary backend codes/text and mismatched fixed
    // message/retryable are rejected as invalid wire.
    expect(() => validateConfigWarningsFailure({ code: "-32603", message: "boom /tmp/x", retryable: false })).toThrow()
    expect(() =>
      validateConfigWarningsFailure({ code: "internal", message: "boom /tmp/x", retryable: false }),
    ).toThrow()
    expect(() =>
      validateConfigWarningsFailure({ code: "internal", message: "internal error", retryable: true }),
    ).toThrow()
    expect(() =>
      validateConfigWarningsFailure({
        code: "InstanceUnavailableDuringConfigRebuild",
        message: "Instance is unavailable during config rebuild; no active runtime for this request",
        retryable: false,
      }),
    ).toThrow()
    const req = validateConfigWarningsContractRequest(makeReq())
    const failed = {
      v: 1 as const,
      requestId: req.requestId,
      opId: req.opId,
      op: "config/warnings" as const,
      idempotencyKey: req.idempotencyKey,
      status: "failed" as const,
      outcome: {
        type: "failed" as const,
        time: 1,
        failure: { code: "internal", message: "internal error", retryable: false },
      },
      accepted: false as const,
      failure: { code: "internal", message: "internal error", retryable: false },
    }
    expect(() => validateConfigWarningsResult(failed, req)).not.toThrow()
    expect(() => validateConfigWarningsResult({ ...failed, data: { warnings: [] } }, req)).toThrow()
    // F-001: failed accepted:true is rejected.
    expect(() => validateConfigWarningsResult({ ...failed, accepted: true }, req)).toThrow()
    // Arbitrary backend failure on the wire normalizes to invalid.
    const arbitrary = {
      ...failed,
      failure: { code: "-32603", message: "boom /tmp/x", retryable: false },
      outcome: {
        type: "failed" as const,
        time: 1,
        failure: { code: "-32603", message: "boom /tmp/x", retryable: false },
      },
    }
    expect(() => validateConfigWarningsResult(arbitrary, req)).toThrow()
    expect(normalizePrivateConfigWarningsWire(arbitrary, req).kind).toBe("invalid")
  })

  test("request identities reject path-bearing material", () => {
    const req = makeReq()
    expect(() => validateConfigWarningsContractRequest(req)).not.toThrow()
    expect(() => validateConfigWarningsContractRequest({ ...req, requestId: "/tmp/secret-id" })).toThrow()
    expect(() => validateConfigWarningsContractRequest({ ...req, requestId: "a\\b" })).toThrow()
    expect(() =>
      validateConfigWarningsContractRequest({
        ...req,
        opId: "config-warnings:/tmp/secret",
        idempotencyKey: "config-warnings:/tmp/secret",
      }),
    ).toThrow()
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
    const rawBearing = normalizePrivateConfigWarningsWire(
      { ...makeSucceeded(req), data: { warnings: [{ path: "/p", message: "m" }] } },
      req,
    )
    expect(rawBearing.kind).toBe("invalid")
    const amb = makeConfigWarningsAmbiguous(req)
    expect(amb.status).toBe("ambiguous")
    expect(() => validateConfigWarningsResult(amb, req)).not.toThrow()
  })

  test("parity projects SDK raw warnings to the same safe multiset", () => {
    const req = validateConfigWarningsContractRequest(makeReq())
    const ok = validateConfigWarningsResult(makeSucceeded(req), req)
    const sdkOne = {
      data: [rawWarning("/tmp/.kilo/agent/a.md", "Config file at /tmp/.kilo/agent/a.md is invalid: bad")],
    }
    expect(compareConfigWarningsParity(ok, sdkOne).divergence).toBeNull()
    const parityBase = compareConfigWarningsParity(ok, sdkOne).details
    expect(parityBase.directorySnapshot).toBeTrue()
    expect(parityBase.freshnessUnknown).toBeTrue()
    expect(parityBase.orderingUnknown).toBeTrue()
    // Order is not compared.
    const two = validateConfigWarningsResult(
      {
        ...makeSucceeded(req),
        data: { warnings: [makeSafe(), makeSafe({ pathCategory: "config-file", messageCategory: "invalid-json" })] },
      },
      req,
    )
    expect(
      compareConfigWarningsParity(two, {
        data: [
          rawWarning("/w/kilo.jsonc", "Config file at /w/kilo.jsonc is not valid JSON(C)"),
          rawWarning("/w/agent/a.md", "Config file at /w/agent/a.md is invalid: bad"),
        ],
      }).divergence,
    ).toBeNull()
    // Priv-only entry -> gap unknown.
    const privGap = compareConfigWarningsParity(two, sdkOne)
    expect(privGap.divergence).toBe("config-warnings-membership-unknown")
    // SDK-only entry -> gap unknown (bidirectional).
    const sdkGap = compareConfigWarningsParity(ok, {
      data: [...sdkOne.data, rawWarning("/w/kilo.jsonc", "Config file at /w/kilo.jsonc is not valid JSON(C)")],
    })
    expect(sdkGap.divergence).toBe("config-warnings-membership-unknown")
    // Detail never affects parity: same path/message with different detail agree.
    expect(
      compareConfigWarningsParity(ok, {
        data: [
          rawWarning("/tmp/.kilo/agent/a.md", "Config file at /tmp/.kilo/agent/a.md is invalid: bad", "other detail"),
        ],
      }).divergence,
    ).toBeNull()
    // Malformed SDK warning entries are shape mismatches, never silent skips.
    expect(compareConfigWarningsParity(ok, { data: [{ path: "/p" }] }).divergence).toBe(
      "config-warnings-shape-mismatch",
    )
    expect(compareConfigWarningsParity(ok, { data: "nope" }).divergence).toBe("config-warnings-shape-mismatch")
  })

  test("parity key delimits category boundaries", () => {
    const left = configWarningKey({ pathCategory: "agent-file", messageCategory: "unknown" })
    const right = configWarningKey({ pathCategory: "other", messageCategory: "unknown" })
    expect(left).not.toBe(right)
    expect(configWarningKey(makeSafe())).toBe(configWarningKey(makeSafe()))
  })

  test("parity detects duplicate-count gaps bidirectionally as membership-unknown", () => {
    const req = validateConfigWarningsContractRequest(makeReq())
    const dup = makeSafe()
    const raw = rawWarning("/w/agent/a.md", "Config file at /w/agent/a.md is invalid: bad")
    const privDup = validateConfigWarningsResult({ ...makeSucceeded(req), data: { warnings: [dup, dup] } }, req)
    const privSingle = validateConfigWarningsResult(makeSucceeded(req), req)
    const extraPriv = compareConfigWarningsParity(privDup, { data: [{ ...raw }] })
    expect(extraPriv.divergence).toBe("config-warnings-membership-unknown")
    expect(extraPriv.details.directorySnapshot).toBeTrue()
    const extraSdk = compareConfigWarningsParity(privSingle, { data: [{ ...raw }, { ...raw }] })
    expect(extraSdk.divergence).toBe("config-warnings-membership-unknown")
    expect(extraSdk.details.directorySnapshot).toBeTrue()
    expect(compareConfigWarningsParity(privDup, { data: [{ ...raw }, { ...raw }] }).divergence).toBeNull()
  })

  test("parity reports transport-unknown, status mismatch, and failed-vs-failed agreement", () => {
    const req = validateConfigWarningsContractRequest(makeReq())
    const ok = validateConfigWarningsResult(makeSucceeded(req), req)
    const amb = makeConfigWarningsAmbiguous(req)
    const sdkOne = {
      data: [rawWarning("/tmp/.kilo/agent/a.md", "Config file at /tmp/.kilo/agent/a.md is invalid: bad")],
    }
    expect(compareConfigWarningsParity(amb, sdkOne).divergence).toBe("transport-unknown")
    const mismatch = compareConfigWarningsParity(ok, { error: { message: "bad" } })
    expect(mismatch.divergence).toBe("status-mismatch:sdk=failed priv=succeeded")
    const failed = validateConfigWarningsResult(
      {
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "config/warnings" as const,
        idempotencyKey: req.idempotencyKey,
        status: "failed",
        outcome: {
          type: "failed",
          time: 1,
          failure: { code: "internal", message: "internal error", retryable: false },
        },
        accepted: false,
        failure: { code: "internal", message: "internal error", retryable: false },
      },
      req,
    )
    expect(compareConfigWarningsParity(failed, { error: { message: "bad" } }).divergence).toBeNull()
  })
})
