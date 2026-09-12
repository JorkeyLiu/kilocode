import { describe, expect, test } from "bun:test"
import {
  canonicalSkillListOpId,
  checkSkillListScope,
  isSkillListValidationError,
  makeSkillListAmbiguous,
  normalizePrivateSkillListWire,
  parseSkillListOpId,
  SkillListValidationError,
  validateSkillListContractRequest,
  validateSkillListEntries,
  validateSkillListEntry,
  validateSkillListFailure,
  validateSkillListResult,
} from "./serve-private-skill-list-contract"

function makeReq(over: Record<string, unknown> = {}) {
  const opId = canonicalSkillListOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "skill/list" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
    ...over,
  }
}

function makeSucceeded(req: ReturnType<typeof validateSkillListContractRequest>, over: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    requestId: req.requestId,
    opId: req.opId,
    op: "skill/list" as const,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded" as const,
    outcome: { type: "succeeded" as const, time: 1 },
    accepted: true as const,
    data: {
      skills: [{ name: "demo", description: "demo skill", location: "builtin" }],
    },
    ...over,
  }
}

describe("skill/list private-first contract", () => {
  test("opId grammar is skill-list single token with idempotency equality", () => {
    expect(canonicalSkillListOpId("t1")).toBe("skill-list:t1")
    expect(() => canonicalSkillListOpId("")).toThrow()
    expect(() => canonicalSkillListOpId("a:b")).toThrow()
    expect(parseSkillListOpId(canonicalSkillListOpId("t1"))).toEqual({ token: "t1" })
    expect(() => parseSkillListOpId("skill:t1")).toThrow()
    expect(() => parseSkillListOpId("command/list:t1")).toThrow()
    expect(() => parseSkillListOpId("skill-remove:t1")).toThrow()
    expect(() => parseSkillListOpId("skill-list:a:b")).toThrow()
  })

  test("request validation enforces v1 envelope with directory/workspace routing and empty payload", () => {
    const req = makeReq()
    expect(() => validateSkillListContractRequest(req)).not.toThrow()
    expect(() => validateSkillListContractRequest({ ...req, v: 2 })).toThrow()
    expect(() => validateSkillListContractRequest({ ...req, op: "command/list" })).toThrow()
    expect(() => validateSkillListContractRequest({ ...req, op: "skill/remove" })).toThrow()
    expect(() => validateSkillListContractRequest({ ...req, idempotencyKey: canonicalSkillListOpId("other") })).toThrow()
    expect(() => validateSkillListContractRequest({ ...req, context: { directory: "relative" } })).toThrow()
    expect(() => validateSkillListContractRequest({ ...req, context: { directory: "/tmp\0" } })).toThrow()
    expect(() => validateSkillListContractRequest({ ...req, context: { directory: "/tmp", sessionId: "ses_x" } })).toThrow()
    expect(() => validateSkillListContractRequest({ ...req, payload: { filter: {} } })).toThrow()
    expect(() => validateSkillListContractRequest({ ...req, extra: 1 })).toThrow()
    const withWs = makeReq({ context: { directory: "/tmp", workspace: "w1" } })
    expect(() => validateSkillListContractRequest(withWs)).not.toThrow()
  })

  test("scope check guards directory/workspace/request identity with scope_mismatch", () => {
    const req = validateSkillListContractRequest(makeReq())
    expect(checkSkillListScope(req, { directory: "/tmp", token: "tok1" })).toEqual({ ok: true })
    expect(checkSkillListScope(req, { directory: "/other", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "directory",
    })
    expect(checkSkillListScope(req, { directory: "/tmp", workspace: "w", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "workspace",
    })
    expect(checkSkillListScope(req, { directory: "/tmp", token: "tok2" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "request",
    })
  })

  test("entry projection keeps only name/description/location and excludes content", () => {
    expect(() => validateSkillListEntry({ name: "demo", description: "d", location: "builtin" })).not.toThrow()
    expect(() => validateSkillListEntry({ name: "demo", location: "/repo/.kilo/skills/demo/SKILL.md" })).not.toThrow()
    expect(() => validateSkillListEntry({ name: "", location: "builtin" })).toThrow()
    expect(() => validateSkillListEntry({ name: "demo", location: "" })).toThrow()
    expect(() => validateSkillListEntry({ name: "demo", location: "builtin", content: "secret" })).toThrow()
    expect(() => validateSkillListEntry({ name: "demo", location: "builtin", template: "x" })).toThrow()
    expect(() => validateSkillListEntry({ name: "demo", location: "builtin", agent: "a" })).toThrow()
    expect(() => validateSkillListEntry({ name: "demo", location: "builtin", model: "m" })).toThrow()
    expect(() => validateSkillListEntry({ name: "demo", location: "builtin", subtask: true })).toThrow()
    expect(() => validateSkillListEntry({ name: "demo", location: "builtin", source: "skill" })).toThrow()
    expect(() => validateSkillListEntry({ name: "demo", location: "builtin", description: 7 })).toThrow()
    expect(() => validateSkillListEntries("nope")).toThrow()
  })

  test("insertion order is preserved with no uniqueness claim", () => {
    const pair = [
      { name: "b", location: "builtin" },
      { name: "a", location: "builtin" },
    ]
    const entries = validateSkillListEntries(pair)
    expect(entries.map((e) => e.name)).toEqual(["b", "a"])
  })

  test("failure shape is redacted code/message/retryable without content or location echo", () => {
    expect(() => validateSkillListFailure({ code: "c", message: "m", retryable: true })).not.toThrow()
    expect(() => validateSkillListFailure({ code: "c", message: "m", retryable: true, content: "x" })).toThrow()
    expect(() => validateSkillListFailure({ code: "c", message: "m", retryable: true, location: "x" })).toThrow()
    expect(() => validateSkillListFailure({ code: "c", message: "m", retryable: true, path: "x" })).toThrow()
    expect(() => validateSkillListFailure({ code: "c", message: "m", retryable: true, skills: [] })).toThrow()
    expect(() => validateSkillListFailure({ code: "c", message: "m", retryable: true, detail: "x" })).toThrow()
  })

  test("result validation binds identity and accepts empty authoritative success", () => {
    const req = validateSkillListContractRequest(makeReq())
    expect(() => validateSkillListResult(makeSucceeded(req), req)).not.toThrow()
    expect(() => validateSkillListResult({ ...makeSucceeded(req), data: { skills: [] } }, req)).not.toThrow()
    expect(() => validateSkillListResult({ ...makeSucceeded(req), op: "command/list" }, req)).toThrow()
    const badOrder = { ...makeSucceeded(req), ordering: "name-asc" }
    expect(() => validateSkillListResult(badOrder, req)).toThrow()
    expect(() => validateSkillListResult({ ...makeSucceeded(req), data: { skills: [], total: 1 } }, req)).toThrow()
    expect(() => validateSkillListResult({ ...makeSucceeded(req), data: { skills: [{ name: "a", location: "b", content: "x" }] } }, req)).toThrow()
    const amb = makeSkillListAmbiguous(req)
    expect(() => validateSkillListResult(amb, req)).not.toThrow()
    const wire = normalizePrivateSkillListWire(makeSucceeded(req), req)
    expect(wire.kind).toBe("valid")
    expect(normalizePrivateSkillListWire({ nope: 1 }, req).kind).toBe("invalid")
    expect(new SkillListValidationError("x").kind).toBe("private-skill-list-validation")
    expect(isSkillListValidationError(new SkillListValidationError("x"))).toBe(true)
  })

  test("failed result validation accepts valid failure and rejects mismatch/data", () => {
    const req = validateSkillListContractRequest(makeReq())
    const failure = { code: "c", message: "m", retryable: true }
    const failed = {
      v: 1 as const,
      requestId: req.requestId,
      opId: req.opId,
      op: "skill/list" as const,
      idempotencyKey: req.idempotencyKey,
      status: "failed" as const,
      outcome: { type: "failed" as const, time: 1, failure: { ...failure } },
      accepted: false,
      failure: { ...failure },
    }
    expect(() => validateSkillListResult(failed, req)).not.toThrow()
    expect(() => validateSkillListResult({ ...failed, outcome: { type: "failed" as const, time: 1, failure: { ...failure, code: "other" } } }, req)).toThrow()
    expect(() => validateSkillListResult({ ...failed, outcome: { type: "failed" as const, time: 1, failure: { ...failure, message: "other" } } }, req)).toThrow()
    expect(() => validateSkillListResult({ ...failed, outcome: { type: "failed" as const, time: 1, failure: { ...failure, retryable: false } } }, req)).toThrow()
    expect(() => validateSkillListResult({ ...failed, data: { skills: [] } }, req)).toThrow()
  })
})
