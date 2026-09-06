import { describe, expect, test } from "bun:test"
import {
  canonicalProjectCurrentOpId,
  checkProjectCurrentScope,
  compareProjectCurrentParity,
  parseProjectCurrentOpId,
  PROJECT_CURRENT_FAILURE_FORBIDDEN,
  makeProjectCurrentAmbiguous,
  normalizePrivateProjectCurrentWire,
  validateProjectCurrentContractRequest,
  validateProjectCurrentFailure,
  validateProjectCurrentPayload,
  validateProjectCurrentResult,
} from "./serve-private-project-current-contract"

function makeReq(over: Record<string, unknown> = {}) {
  const opId = canonicalProjectCurrentOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "project/current" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
    ...over,
  }
}

function makeSucceeded(
  req: ReturnType<typeof validateProjectCurrentContractRequest>,
  over: Record<string, unknown> = {},
) {
  return {
    v: 1 as const,
    requestId: req.requestId,
    opId: req.opId,
    op: "project/current" as const,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded" as const,
    outcome: { type: "succeeded" as const, time: 1 },
    accepted: true as const,
    data: {},
    ...over,
  }
}

describe("project/current vcs-only private contract", () => {
  test("opId grammar is single token with idempotency equality", () => {
    expect(canonicalProjectCurrentOpId("t1")).toBe("project-current:t1")
    expect(() => canonicalProjectCurrentOpId("")).toThrow()
    expect(() => canonicalProjectCurrentOpId("a:b")).toThrow()
    expect(parseProjectCurrentOpId(canonicalProjectCurrentOpId("t1"))).toEqual({ token: "t1" })
    expect(() => parseProjectCurrentOpId("path:t1")).toThrow()
    expect(() => parseProjectCurrentOpId("project-current:a:b")).toThrow()
  })

  test("request validation enforces strict v1 directory/workspace read envelope", () => {
    const req = makeReq()
    expect(() => validateProjectCurrentContractRequest(req)).not.toThrow()
    expect(() => validateProjectCurrentContractRequest({ ...req, v: 2 })).toThrow()
    expect(() => validateProjectCurrentContractRequest({ ...req, op: "remote/status" })).toThrow()
    expect(() =>
      validateProjectCurrentContractRequest({ ...req, idempotencyKey: canonicalProjectCurrentOpId("other") }),
    ).toThrow()
    expect(() => validateProjectCurrentContractRequest({ ...req, context: { directory: "relative" } })).toThrow()
    expect(() => validateProjectCurrentContractRequest({ ...req, context: { directory: "/tmp\0" } })).toThrow()
    expect(() => validateProjectCurrentContractRequest({ ...req, payload: { limit: 1 } })).toThrow()
    expect(() => validateProjectCurrentContractRequest({ ...req, extra: 1 })).toThrow()
    expect(() =>
      validateProjectCurrentContractRequest({ ...req, context: { directory: "/tmp", sessionId: "ses_x" } }),
    ).toThrow()
  })

  test("scope mismatch is typed by directory/workspace/request", () => {
    const req = validateProjectCurrentContractRequest(makeReq())
    expect(checkProjectCurrentScope(req, { directory: "/tmp", token: "tok1" })).toEqual({ ok: true })
    expect(checkProjectCurrentScope(req, { directory: "/other", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "directory",
    })
    expect(checkProjectCurrentScope(req, { directory: "/tmp/", token: "tok1" })).toEqual({ ok: true })
    expect(checkProjectCurrentScope(req, { directory: "/tmp", workspace: "ws1", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "workspace",
    })
    expect(checkProjectCurrentScope(req, { directory: "/tmp", token: "tok2" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "request",
    })
  })

  test("narrow vcs projection accepts git or absent only", () => {
    expect(validateProjectCurrentPayload({})).toEqual({})
    expect(validateProjectCurrentPayload({ vcs: "git" })).toEqual({ vcs: "git" })
    expect(() => validateProjectCurrentPayload({ vcs: "hg" })).toThrow()
    expect(() => validateProjectCurrentPayload({ vcs: "" })).toThrow()
    expect(() => validateProjectCurrentPayload({ worktree: "/tmp" })).toThrow()
    expect(() => validateProjectCurrentPayload({ sandboxes: [] })).toThrow()
    expect(() => validateProjectCurrentPayload({ id: "x" })).toThrow()
  })

  test("failure taxonomy is finite with fixed messages and no project echo", () => {
    expect(PROJECT_CURRENT_FAILURE_FORBIDDEN.has("vcs")).toBeTrue()
    expect(PROJECT_CURRENT_FAILURE_FORBIDDEN.has("worktree")).toBeTrue()
    expect(() =>
      validateProjectCurrentFailure({ code: "internal", message: "internal error", retryable: false }),
    ).not.toThrow()
    expect(() =>
      validateProjectCurrentFailure({
        code: "InstanceUnavailableDuringConfigRebuild",
        message: "Instance is unavailable during config rebuild; no active runtime for this request",
        retryable: true,
      }),
    ).not.toThrow()
    expect(() => validateProjectCurrentFailure({ code: "boom", message: "boom", retryable: false })).toThrow()
    expect(() => validateProjectCurrentFailure({ code: "internal", message: "wrong", retryable: false })).toThrow()
    expect(() =>
      validateProjectCurrentFailure({ code: "internal", message: "internal error", retryable: false, vcs: "git" }),
    ).toThrow()
  })

  test("result validation binds identities and rejects path-bearing data", () => {
    const req = validateProjectCurrentContractRequest(makeReq())
    expect(() => validateProjectCurrentResult(makeSucceeded(req), req)).not.toThrow()
    expect(() => validateProjectCurrentResult(makeSucceeded(req, { data: { vcs: "git" } }), req)).not.toThrow()
    expect(() => validateProjectCurrentResult(makeSucceeded(req, { data: { vcs: "hg" } }), req)).toThrow()
    expect(() => validateProjectCurrentResult(makeSucceeded(req, { data: { worktree: "/tmp" } }), req)).toThrow()
    expect(() => validateProjectCurrentResult(makeSucceeded(req, { data: { sandboxes: [] } }), req)).toThrow()
    const bad = { ...makeSucceeded(req), requestId: "other" }
    expect(() => validateProjectCurrentResult(bad, req)).toThrow()
  })

  test("wire normalization maps malformed to invalid without throwing", () => {
    const req = validateProjectCurrentContractRequest(makeReq())
    const ok = normalizePrivateProjectCurrentWire(makeSucceeded(req, { data: { vcs: "git" } }), req)
    expect(ok.kind).toBe("valid")
    const bad = normalizePrivateProjectCurrentWire({ v: 99 }, req)
    expect(bad.kind).toBe("invalid")
    const amb = makeProjectCurrentAmbiguous(req, true)
    expect(amb.status).toBe("ambiguous")
  })

  test("parity compares derived hasGit only", () => {
    const req = validateProjectCurrentContractRequest(makeReq())
    const git = validateProjectCurrentResult(makeSucceeded(req, { data: { vcs: "git" } }), req)
    const nogit = validateProjectCurrentResult(makeSucceeded(req, { data: {} }), req)
    expect(compareProjectCurrentParity(git, { data: { vcs: "git" } }).divergence).toBeNull()
    expect(compareProjectCurrentParity(nogit, { data: {} }).divergence).toBeNull()
    expect(compareProjectCurrentParity(git, { data: {} }).divergence).toBe("project-current-hasgit-mismatch")
    expect(compareProjectCurrentParity(nogit, { data: { vcs: "git" } }).divergence).toBe(
      "project-current-hasgit-mismatch",
    )
    expect(compareProjectCurrentParity(nogit, { data: { vcs: "hg" } }).divergence).toBe(
      "project-current-shape-mismatch",
    )
    expect(compareProjectCurrentParity(nogit, { error: { message: "x" } }).divergence).toContain("status-mismatch")
  })
})
