import { describe, expect, test } from "bun:test"
import {
  canonicalCommandListOpId,
  checkCommandListScope,
  isCommandListValidationError,
  makeCommandListAmbiguous,
  normalizePrivateCommandListWire,
  parseCommandListOpId,
  CommandListValidationError,
  validateCommandListContractRequest,
  validateCommandListEntries,
  validateCommandListEntry,
  validateCommandListFailure,
  validateCommandListResult,
} from "./serve-private-command-list-contract"

function makeReq(over: Record<string, unknown> = {}) {
  const opId = canonicalCommandListOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "command/list" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
    ...over,
  }
}

function makeSucceeded(req: ReturnType<typeof validateCommandListContractRequest>, over: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    requestId: req.requestId,
    opId: req.opId,
    op: "command/list" as const,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded" as const,
    outcome: { type: "succeeded" as const, time: 1 },
    accepted: true as const,
    data: {
      commands: [{ name: "init", description: "guided setup", source: "command", hints: [] as string[] }],
    },
    ...over,
  }
}

describe("command/list private-first contract", () => {
  test("opId grammar is command-list single token with idempotency equality", () => {
    expect(canonicalCommandListOpId("t1")).toBe("command-list:t1")
    expect(() => canonicalCommandListOpId("")).toThrow()
    expect(() => canonicalCommandListOpId("a:b")).toThrow()
    expect(parseCommandListOpId(canonicalCommandListOpId("t1"))).toEqual({ token: "t1" })
    expect(() => parseCommandListOpId("command:t1")).toThrow()
    expect(() => parseCommandListOpId("session/command:t1")).toThrow()
    expect(() => parseCommandListOpId("command-list:a:b")).toThrow()
  })

  test("request validation enforces v1 envelope with directory/workspace routing and empty payload", () => {
    const req = makeReq()
    expect(() => validateCommandListContractRequest(req)).not.toThrow()
    expect(() => validateCommandListContractRequest({ ...req, v: 2 })).toThrow()
    expect(() => validateCommandListContractRequest({ ...req, op: "session/command" })).toThrow()
    expect(() => validateCommandListContractRequest({ ...req, op: "v2.command.list" })).toThrow()
    expect(() => validateCommandListContractRequest({ ...req, idempotencyKey: canonicalCommandListOpId("other") })).toThrow()
    expect(() => validateCommandListContractRequest({ ...req, context: { directory: "relative" } })).toThrow()
    expect(() => validateCommandListContractRequest({ ...req, context: { directory: "/tmp\0" } })).toThrow()
    expect(() => validateCommandListContractRequest({ ...req, context: { directory: "/tmp", sessionId: "ses_x" } })).toThrow()
    expect(() => validateCommandListContractRequest({ ...req, payload: { filter: {} } })).toThrow()
    expect(() => validateCommandListContractRequest({ ...req, extra: 1 })).toThrow()
    const withWs = makeReq({ context: { directory: "/tmp", workspace: "w1" } })
    expect(() => validateCommandListContractRequest(withWs)).not.toThrow()
  })

  test("scope check guards directory/workspace/request identity with scope_mismatch", () => {
    const req = validateCommandListContractRequest(makeReq())
    expect(checkCommandListScope(req, { directory: "/tmp", token: "tok1" })).toEqual({ ok: true })
    expect(checkCommandListScope(req, { directory: "/other", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "directory",
    })
    expect(checkCommandListScope(req, { directory: "/tmp", workspace: "w", token: "tok1" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "workspace",
    })
    expect(checkCommandListScope(req, { directory: "/tmp", token: "tok2" })).toEqual({
      ok: false,
      code: "scope_mismatch",
      which: "request",
    })
  })

  test("entry projection keeps only name/description/source/hints and excludes template/agent/model/subtask", () => {
    expect(() => validateCommandListEntry({ name: "init", description: "d", source: "command", hints: ["$1"] })).not.toThrow()
    expect(() => validateCommandListEntry({ name: "init" })).not.toThrow()
    expect(() => validateCommandListEntry({ name: "", hints: [] })).toThrow()
    expect(() => validateCommandListEntry({ name: "init", template: "secret" })).toThrow()
    expect(() => validateCommandListEntry({ name: "init", agent: "a" })).toThrow()
    expect(() => validateCommandListEntry({ name: "init", model: "m" })).toThrow()
    expect(() => validateCommandListEntry({ name: "init", subtask: true })).toThrow()
    expect(() => validateCommandListEntry({ name: "init", hints: "$1" })).toThrow()
    expect(() => validateCommandListEntry({ name: "init", hints: [1] })).toThrow()
    expect(() => validateCommandListEntry({ name: "init", source: "bogus" })).toThrow()
    expect(() => validateCommandListEntry({ name: "init", description: 7 })).toThrow()
    expect(() => validateCommandListEntries("nope")).toThrow()
  })

  test("duplicate-aware entries keep one skill/non-skill same-name pair", () => {
    const pair = [
      { name: "review", description: "slash command", source: "command", hints: [] as string[] },
      { name: "review", description: "skill body", source: "skill", hints: [] as string[] },
    ]
    expect(() => validateCommandListEntries(pair)).not.toThrow()
    const entries = validateCommandListEntries(pair)
    expect(entries.filter((e) => e.name === "review")).toHaveLength(2)
  })

  test("failure shape is redacted code/message/retryable without command or template echo", () => {
    expect(() => validateCommandListFailure({ code: "c", message: "m", retryable: true })).not.toThrow()
    expect(() => validateCommandListFailure({ code: "c", message: "m", retryable: true, template: "x" })).toThrow()
    expect(() => validateCommandListFailure({ code: "c", message: "m", retryable: true, agent: "a" })).toThrow()
    expect(() => validateCommandListFailure({ code: "c", message: "m", retryable: true, commands: [] })).toThrow()
    expect(() => validateCommandListFailure({ code: "c", message: "m", retryable: true, detail: "x" })).toThrow()
  })

  test("result validation binds identity and rejects unknown ordering claims", () => {
    const req = validateCommandListContractRequest(makeReq())
    expect(() => validateCommandListResult(makeSucceeded(req), req)).not.toThrow()
    expect(() => validateCommandListResult({ ...makeSucceeded(req), op: "session/command" }, req)).toThrow()
    const badOrder = { ...makeSucceeded(req), ordering: "name-asc" }
    expect(() => validateCommandListResult(badOrder, req)).toThrow()
    expect(() => validateCommandListResult({ ...makeSucceeded(req), data: { commands: [], total: 1 } }, req)).toThrow()
    const amb = makeCommandListAmbiguous(req)
    expect(() => validateCommandListResult(amb, req)).not.toThrow()
    const wire = normalizePrivateCommandListWire(makeSucceeded(req), req)
    expect(wire.kind).toBe("valid")
    expect(normalizePrivateCommandListWire({ nope: 1 }, req).kind).toBe("invalid")
    expect(new CommandListValidationError("x").kind).toBe("private-command-list-validation")
    expect(isCommandListValidationError(new CommandListValidationError("x"))).toBe(true)
  })

  test("failed result validation accepts valid failure and rejects mismatch/data", () => {
    const req = validateCommandListContractRequest(makeReq())
    const failure = { code: "c", message: "m", retryable: true }
    const failed = {
      v: 1 as const,
      requestId: req.requestId,
      opId: req.opId,
      op: "command/list" as const,
      idempotencyKey: req.idempotencyKey,
      status: "failed" as const,
      outcome: { type: "failed" as const, time: 1, failure: { ...failure } },
      accepted: false,
      failure: { ...failure },
    }
    expect(() => validateCommandListResult(failed, req)).not.toThrow()
    expect(() => validateCommandListResult({ ...failed, outcome: { type: "failed" as const, time: 1, failure: { ...failure, code: "other" } } }, req)).toThrow()
    expect(() => validateCommandListResult({ ...failed, outcome: { type: "failed" as const, time: 1, failure: { ...failure, message: "other" } } }, req)).toThrow()
    expect(() => validateCommandListResult({ ...failed, outcome: { type: "failed" as const, time: 1, failure: { ...failure, retryable: false } } }, req)).toThrow()
    expect(() => validateCommandListResult({ ...failed, data: { commands: [] } }, req)).toThrow()
  })

})
