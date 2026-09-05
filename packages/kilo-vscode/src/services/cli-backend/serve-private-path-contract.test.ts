import { describe, expect, test } from "bun:test"
import {
  canonicalPathOpId,
  checkPathScope,
  comparePathParity,
  isPathDirectoryField,
  isPathProcessGlobalField,
  isPathValidationError,
  makePathAmbiguous,
  normalizePrivatePathWire,
  parsePathOpId,
  PATH_FAILED_CODE,
  PATH_FAILED_MESSAGE,
  PATH_INVALID_DETAIL,
  PathValidationError,
  validatePathContractRequest,
  validatePathFailure,
  validatePathPayload,
  validatePathResult,
} from "./serve-private-path-contract"

function makeReq(over: Record<string, unknown> = {}) {
  const opId = canonicalPathOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "path/get" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
    ...over,
  }
}

function makePayload(over: Record<string, unknown> = {}) {
  return {
    home: "/home/u",
    state: "/home/u/.local/state/kilo",
    config: "/home/u/.config/kilo",
    worktree: "/tmp",
    directory: "/tmp",
    ...over,
  }
}

function makeSucceeded(req: ReturnType<typeof validatePathContractRequest>, over: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    requestId: req.requestId,
    opId: req.opId,
    op: "path/get" as const,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded" as const,
    outcome: { type: "succeeded" as const, time: 1 },
    accepted: true as const,
    data: { path: makePayload(over) },
  }
}

describe("Gate B path.get candidate contract", () => {
  test("opId grammar is single token with idempotency equality", () => {
    expect(canonicalPathOpId("t1")).toBe("path:t1")
    expect(() => canonicalPathOpId("")).toThrow()
    expect(() => canonicalPathOpId("a:b")).toThrow()
    expect(parsePathOpId(canonicalPathOpId("t1"))).toEqual({ token: "t1" })
    expect(() => parsePathOpId("remote-status:t1")).toThrow()
    expect(() => parsePathOpId("path:a:b")).toThrow()
  })

  test("request validation enforces v1 envelope with absolute directory and empty payload", () => {
    const req = makeReq()
    expect(() => validatePathContractRequest(req)).not.toThrow()
    expect(() => validatePathContractRequest({ ...req, v: 2 })).toThrow()
    expect(() => validatePathContractRequest({ ...req, op: "remote/status" })).toThrow()
    expect(() => validatePathContractRequest({ ...req, idempotencyKey: canonicalPathOpId("other") })).toThrow()
    expect(() => validatePathContractRequest({ ...req, context: { directory: "relative" } })).toThrow()
    expect(() => validatePathContractRequest({ ...req, context: { directory: "/tmp\0" } })).toThrow()
    expect(() => validatePathContractRequest({ ...req, payload: { reason: "x" } })).toThrow()
    expect(() => validatePathContractRequest({ ...req, extra: 1 })).toThrow()
    expect(() => validatePathContractRequest({ ...req, context: { directory: "/tmp", sessionId: "ses_x" } })).toThrow()
  })

  test("workspace binding is optional but scope-checked when present", () => {
    const req = validatePathContractRequest(makeReq({ context: { directory: "/tmp", workspace: "ws1" } }))
    expect(checkPathScope(req, { directory: "/tmp", workspace: "ws1", token: "tok1" })).toEqual({ ok: true })
    expect(checkPathScope(req, { directory: "/tmp", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "workspace",
    })
    expect(checkPathScope(req, { directory: "/tmp", workspace: "ws2", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "workspace",
    })
    const bare = validatePathContractRequest(makeReq())
    expect(checkPathScope(bare, { directory: "/tmp", token: "tok1" })).toEqual({ ok: true })
  })

  test("directory scope binds canonical spellings; token conflict is request mismatch", () => {
    const req = validatePathContractRequest(makeReq())
    expect(checkPathScope(req, { directory: "/tmp/", token: "tok1" })).toEqual({ ok: true })
    expect(checkPathScope(req, { directory: "/other", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "directory",
    })
    expect(checkPathScope(req, { directory: "/tmp", token: "tok2" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "request",
    })
  })

  test("globals stay process-global while directory/worktree are directory-derived; scope is routing-only", () => {
    expect(isPathProcessGlobalField("home")).toBeTrue()
    expect(isPathProcessGlobalField("state")).toBeTrue()
    expect(isPathProcessGlobalField("config")).toBeTrue()
    expect(isPathProcessGlobalField("worktree")).toBeFalse()
    expect(isPathProcessGlobalField("directory")).toBeFalse()
    expect(isPathDirectoryField("worktree")).toBeTrue()
    expect(isPathDirectoryField("directory")).toBeTrue()
    expect(isPathDirectoryField("home")).toBeFalse()
    expect(isPathDirectoryField("state")).toBeFalse()
    expect(isPathDirectoryField("config")).toBeFalse()
    // Scope binds per-directory routing while payload ownership stays split.
    const a = validatePathContractRequest(makeReq({ context: { directory: "/a" } }))
    const b = validatePathContractRequest(makeReq({ requestId: "r2", context: { directory: "/b" } }))
    expect(checkPathScope(a, { directory: "/a", token: "tok1" })).toEqual({ ok: true })
    expect(checkPathScope(a, { directory: "/b", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "directory",
    })
    expect(checkPathScope(b, { directory: "/b", token: "tok1" })).toEqual({ ok: true })
  })

  test("payload projection requires exactly the five production Path fields", () => {
    expect(() => validatePathPayload(makePayload())).not.toThrow()
    expect(Object.keys(makePayload()).sort()).toEqual(["config", "directory", "home", "state", "worktree"])
    expect(() => validatePathPayload({ ...makePayload(), extra: 1 })).toThrow()
    expect(() => validatePathPayload({ home: "/h", state: "/s", config: "/c", worktree: "/w" })).toThrow()
    expect(() => validatePathPayload(makePayload({ home: "" }))).toThrow()
    expect(() => validatePathPayload(makePayload({ directory: 7 }))).toThrow()
    expect(() => validatePathPayload(makePayload({ worktree: "/tmp\0" }))).toThrow()
    // No worktree===directory binding: differing values are shape-valid.
    expect(() => validatePathPayload(makePayload({ worktree: "/repo", directory: "/repo/sub" }))).not.toThrow()
  })

  test("succeeded result asserts no global binding; same globals validate under any directory", () => {
    const a = validatePathContractRequest(makeReq({ context: { directory: "/a" } }))
    const b = validatePathContractRequest(makeReq({ requestId: "r2", context: { directory: "/b" } }))
    const okA = makeSucceeded(a, { worktree: "/a", directory: "/a" })
    expect(() => validatePathResult(okA, a)).not.toThrow()
    // Identical process-global fields under a different request directory are
    // still shape-valid; the contract claims no directory isolation of globals.
    const sameGlobalsOtherDir = makeSucceeded(b, {
      home: okA.data.path.home,
      state: okA.data.path.state,
      config: okA.data.path.config,
      worktree: "/b",
      directory: "/b",
    })
    expect(() => validatePathResult(sameGlobalsOtherDir, b)).not.toThrow()
    expect(() => validatePathResult({ ...okA, accepted: false }, a)).toThrow()
    expect(() => validatePathResult({ ...okA, data: { path: { directory: "/a" } } }, a)).toThrow()
  })

  test("failures are redacted; raw path/session/directory echo keys rejected", () => {
    expect(() => validatePathFailure({ code: "validation.failed", message: "bad", retryable: false })).not.toThrow()
    for (const key of ["home", "state", "config", "worktree", "directory", "workspace", "path", "sessionId", "error"]) {
      expect(() => validatePathFailure({ code: "x", message: "m", retryable: false, [key]: "raw" })).toThrow()
    }
    const req = validatePathContractRequest(makeReq())
    const failed = {
      v: 1 as const,
      requestId: req.requestId,
      opId: req.opId,
      op: "path/get" as const,
      idempotencyKey: req.idempotencyKey,
      status: "failed" as const,
      outcome: { type: "failed" as const, time: 1, failure: { code: "validation.failed", message: "bad", retryable: false } },
      accepted: false as const,
      failure: { code: "validation.failed", message: "bad", retryable: false },
    }
    expect(() => validatePathResult(failed, req)).not.toThrow()
    expect(() => validatePathResult({ ...failed, data: { path: makePayload() } }, req)).toThrow()
  })

  test("wire normalization separates invalid wire from normal failure; ambiguous stays accepted:false", () => {
    const req = validatePathContractRequest(makeReq())
    const ok = validatePathResult(makeSucceeded(req), req)
    expect(normalizePrivatePathWire(makeSucceeded(req), req)).toEqual({ kind: "valid", result: ok })
    const invalid = normalizePrivatePathWire({ bogus: true }, req)
    expect(invalid.kind).toBe("invalid")
    if (invalid.kind === "invalid") {
      expect(new PathValidationError(invalid.detail)).toSatisfy((e) => isPathValidationError(e))
    }
    const amb = makePathAmbiguous(req)
    expect(amb.status).toBe("ambiguous")
    expect(() => validatePathResult(amb, req)).not.toThrow()
    expect(() => validatePathResult({ ...amb, accepted: true }, req)).toThrow()
  })

  test("path-bearing failure code/message never reaches consumers; diagnostics stay fixed", () => {
    const req = validatePathContractRequest(makeReq())
    const evilDir = "/tmp/secret-evil"
    const evilCode = `${evilDir}/code`
    const evilMsg = `failed at ${evilDir}/file`
    // Structurally valid failed envelope carrying path material must not validate.
    const evilFailed = {
      v: 1 as const,
      requestId: req.requestId,
      opId: req.opId,
      op: "path/get" as const,
      idempotencyKey: req.idempotencyKey,
      status: "failed" as const,
      outcome: { type: "failed" as const, time: 1, failure: { code: evilCode, message: evilMsg, retryable: false } },
      accepted: false as const,
      failure: { code: evilCode, message: evilMsg, retryable: false },
    }
    let evilErr = ""
    try {
      validatePathResult(evilFailed, req)
    } catch (e) {
      evilErr = e instanceof Error ? e.message : String(e)
    }
    expect(evilErr.length).toBeGreaterThan(0)
    expect(evilErr).not.toContain(evilDir)
    expect(evilErr).not.toContain("secret-evil")
    // Normalization maps it to fixed invalid detail, never echoing path material.
    const evilWire = normalizePrivatePathWire(evilFailed, req)
    expect(evilWire.kind).toBe("invalid")
    if (evilWire.kind === "invalid") {
      expect(evilWire.detail).toBe(PATH_INVALID_DETAIL)
      expect(evilWire.detail).not.toContain(evilDir)
      const thrown = new PathValidationError(evilWire.detail)
      expect(thrown.message).not.toContain(evilDir)
      expect(thrown.detail).not.toContain(evilDir)
      expect(isPathValidationError(thrown)).toBeTrue()
    }
    // Safe failed envelope normalizes to fixed operation-specific code/message, preserving retryable.
    const safeFailed = {
      v: 1 as const,
      requestId: req.requestId,
      opId: req.opId,
      op: "path/get" as const,
      idempotencyKey: req.idempotencyKey,
      status: "failed" as const,
      outcome: { type: "failed" as const, time: 1, failure: { code: "validation.failed", message: "bad", retryable: true } },
      accepted: false as const,
      failure: { code: "validation.failed", message: "bad", retryable: true },
    }
    expect(() => validatePathResult(safeFailed, req)).not.toThrow()
    const safeWire = normalizePrivatePathWire(safeFailed, req)
    expect(safeWire.kind).toBe("valid")
    if (safeWire.kind === "valid" && safeWire.result.status === "failed") {
      expect(safeWire.result.failure.code).toBe(PATH_FAILED_CODE)
      expect(safeWire.result.failure.message).toBe(PATH_FAILED_MESSAGE)
      expect(safeWire.result.failure.retryable).toBeTrue()
      expect(JSON.stringify(safeWire.result)).not.toContain(evilDir)
    }
    // Malformed keys containing path-like names never echo in diagnostics.
    const evilKey = `${evilDir}/evil-key`
    const cases: unknown[] = [
      { ...makeSucceeded(req), [evilKey]: 1 },
      {
        ...makeSucceeded(req),
        data: { path: { ...makePayload(), [evilKey]: "x" } },
      },
      {
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "path/get",
        idempotencyKey: req.idempotencyKey,
        status: "failed",
        outcome: { type: "failed", time: 1, failure: { code: "x", message: "m", retryable: false, [evilKey]: "raw" } },
        accepted: false,
        failure: { code: "x", message: "m", retryable: false },
      },
    ]
    for (const raw of cases) {
      let msg = ""
      try {
        validatePathResult(raw, req)
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e)
      }
      expect(msg.length).toBeGreaterThan(0)
      expect(msg).not.toContain(evilDir)
      expect(msg).not.toContain("evil-key")
      const wire = normalizePrivatePathWire(raw, req)
      expect(wire.kind).toBe("invalid")
      if (wire.kind === "invalid") {
        expect(wire.detail).toBe(PATH_INVALID_DETAIL)
        expect(wire.detail).not.toContain(evilDir)
      }
    }
  })

  test("parity compares only directory-derived fields and explicitly excludes globals", () => {
    const req = validatePathContractRequest(makeReq())
    const ok = validatePathResult(makeSucceeded(req), req)
    const parity = comparePathParity(ok, { data: makePayload() })
    expect(parity.divergence).toBeNull()
    expect(parity.details.globalExcluded).toBeTrue()
    expect(parity.details.worktreeDerivationUnknown).toBeTrue()
    // Differing process-global fields never surface as divergence.
    const otherGlobals = comparePathParity(ok, {
      data: makePayload({ home: "/other-home", state: "/other-state", config: "/other-config" }),
    })
    expect(otherGlobals.divergence).toBeNull()
    expect(otherGlobals.details.globalExcluded).toBeTrue()
    // Missing globals on the SDK side still hold: they are never read.
    const noGlobals = comparePathParity(ok, { data: { worktree: "/tmp", directory: "/tmp" } })
    expect(noGlobals.divergence).toBeNull()
    const dirMismatch = comparePathParity(ok, { data: makePayload({ worktree: "/tmp", directory: "/other" }) })
    expect(dirMismatch.divergence).toBe("path-directory-mismatch")
    const treeMismatch = comparePathParity(ok, { data: makePayload({ worktree: "/other", directory: "/tmp" }) })
    expect(treeMismatch.divergence).toBe("path-worktree-mismatch")
    expect(treeMismatch.details.worktreeDerivationUnknown).toBeTrue()
    const shapeMismatch = comparePathParity(ok, { data: { directory: "/tmp" } })
    expect(shapeMismatch.divergence).toBe("path-shape-mismatch")
    const statusMismatch = comparePathParity(ok, { error: { message: "boom" } })
    expect(statusMismatch.divergence).toContain("status-mismatch")
    const unknown = comparePathParity(makePathAmbiguous(req), { data: makePayload() })
    expect(unknown.divergence).toBe("transport-unknown")
  })
})
