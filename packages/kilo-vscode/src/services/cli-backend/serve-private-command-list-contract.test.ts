import { describe, expect, test } from "bun:test"
import {
  canonicalCommandListOpId,
  checkCommandListScope,
  compareCommandListParity,
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

describe("Gate B command/list candidate contract", () => {
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

  test("sdk bogus source is strict shape mismatch", () => {
    const req = validateCommandListContractRequest(makeReq())
    const priv = validateCommandListResult(makeSucceeded(req), req)
    expect(compareCommandListParity(priv, { data: [{ name: "init", source: "bogus", hints: [] }] }).divergence).toBe(
      "command-list-shape-mismatch",
    )
  })

  test("parity covers non-array, transport-unknown, description and membership branches", () => {
    const req = validateCommandListContractRequest(makeReq())
    const priv = validateCommandListResult(makeSucceeded(req), req)
    const same = compareCommandListParity(priv, {
      data: [{ name: "init", description: "guided setup", source: "command", hints: [] }],
    })
    expect(same.divergence).toBeNull()
    expect((same.details as Record<string, unknown>).orderingUnknown).toBe(true)
    expect((same.details as Record<string, unknown>).snapshotUnknown).toBe(true)
    expect((same.details as Record<string, unknown>).freshnessUnknown).toBe(true)
    expect((same.details as Record<string, unknown>).templateUnknown).toBe(true)
    // Order-insensitive: reversed sdk order still matches.
    const priv2 = validateCommandListResult(
      { ...makeSucceeded(req), data: { commands: [{ name: "a", hints: [] }, { name: "b", hints: [] }] } },
      req,
    )
    const reversed = compareCommandListParity(priv2, { data: [{ name: "b", hints: [] }, { name: "a", hints: [] }] })
    expect(reversed.divergence).toBeNull()
    // Non-array SDK payload is its own branch.
    expect(compareCommandListParity(priv, { data: { name: "init" } }).divergence).toBe("command-list-non-array")
    // Malformed SDK array entries and field types are shape mismatch, not throw.
    expect(compareCommandListParity(priv, { data: [null] }).divergence).toBe("command-list-shape-mismatch")
    expect(compareCommandListParity(priv, { data: [{ description: "no-name" }] }).divergence).toBe("command-list-shape-mismatch")
    expect(compareCommandListParity(priv, { data: [{ name: 7 }] }).divergence).toBe("command-list-shape-mismatch")
    expect(compareCommandListParity(priv, { data: [{ name: "init", hints: "$1" }] }).divergence).toBe("command-list-shape-mismatch")
    // Description mismatch on shared key.
    const descMismatch = compareCommandListParity(priv, {
      data: [{ name: "init", description: "other text", source: "command", hints: [] }],
    })
    expect(descMismatch.divergence).toBe("command-list-description-mismatch")
    // Membership gaps are unknown, not silent match.
    const missing = compareCommandListParity(priv, { data: [] })
    expect(missing.divergence?.startsWith("command-list-membership-unknown")).toBe(true)
    const extra = compareCommandListParity(priv, {
      data: [
        { name: "init", description: "guided setup", source: "command", hints: [] },
        { name: "extra", hints: [] },
      ],
    })
    expect(extra.divergence?.startsWith("command-list-membership-unknown")).toBe(true)
    // Same-name pair stays representable on both sides.
    const pairPriv = validateCommandListResult(
      {
        ...makeSucceeded(req),
        data: {
          commands: [
            { name: "review", description: "slash", source: "command", hints: [] },
            { name: "review", description: "skill", source: "skill", hints: [] },
          ],
        },
      },
      req,
    )
    const pairSame = compareCommandListParity(pairPriv, {
      data: [
        { name: "review", description: "slash", source: "command", hints: [] },
        { name: "review", description: "skill", source: "skill", hints: [] },
      ],
    })
    expect(pairSame.divergence).toBeNull()
    expect(compareCommandListParity(priv, { error: { message: "boom" } }).divergence?.startsWith("status-mismatch")).toBe(true)
    expect(compareCommandListParity(makeCommandListAmbiguous(req), { data: [] }).divergence).toBe("transport-unknown")
  })

  test("F-001 parity diagnostics never carry command names or payload material", () => {
    const req = validateCommandListContractRequest(makeReq())
    const priv = validateCommandListResult(makeSucceeded(req), req)
    const missing = compareCommandListParity(priv, { data: [] })
    expect(missing.divergence).toBe("command-list-membership-unknown")
    const missingWire = JSON.stringify({ divergence: missing.divergence, details: missing.details })
    expect(missingWire.includes("init")).toBe(false)
    expect((missing.details as Record<string, unknown>).membershipUnknown).toBe(true)
    expect(typeof (missing.details as Record<string, unknown>).privCount).toBe("number")
    expect(typeof (missing.details as Record<string, unknown>).sdkCount).toBe("number")
    const desc = compareCommandListParity(priv, {
      data: [{ name: "init", description: "other text", source: "command", hints: [] }],
    })
    expect(desc.divergence).toBe("command-list-description-mismatch")
    const descWire = JSON.stringify({ divergence: desc.divergence, details: desc.details })
    expect(descWire.includes("init")).toBe(false)
    expect(descWire.includes("other text")).toBe(false)
    expect(descWire.includes("guided setup")).toBe(false)
    expect((desc.details as Record<string, unknown>).descriptionMismatch).toBe(true)
  })

  test("F-004 optional description compares presence and value without name echo", () => {
    const req = validateCommandListContractRequest(makeReq())
    const priv = validateCommandListResult(makeSucceeded(req), req)
    // Both absent is equal.
    const bareReq = validateCommandListContractRequest(makeReq())
    const barePriv = validateCommandListResult(
      {
        ...makeSucceeded(bareReq),
        data: { commands: [{ name: "init", source: "command", hints: [] }] },
      },
      bareReq,
    )
    const bothBare = compareCommandListParity(barePriv, { data: [{ name: "init", source: "command", hints: [] }] })
    expect(bothBare.divergence).toBeNull()
    // SDK present vs private absent is a fixed mismatch.
    const sdkHas = compareCommandListParity(barePriv, {
      data: [{ name: "init", description: "guided setup", source: "command", hints: [] }],
    })
    expect(sdkHas.divergence).toBe("command-list-description-mismatch")
    // Private present vs SDK absent is a fixed mismatch.
    const privHas = compareCommandListParity(priv, { data: [{ name: "init", source: "command", hints: [] }] })
    expect(privHas.divergence).toBe("command-list-description-mismatch")
    // Same presence with differing values is a fixed mismatch.
    const diff = compareCommandListParity(priv, {
      data: [{ name: "init", description: "other text", source: "command", hints: [] }],
    })
    expect(diff.divergence).toBe("command-list-description-mismatch")
    for (const out of [sdkHas, privHas, diff]) {
      const wire = JSON.stringify({ divergence: out.divergence, details: out.details })
      expect(wire.includes("init")).toBe(false)
      expect(wire.includes("other text")).toBe(false)
      expect(wire.includes("guided setup")).toBe(false)
    }
  })
})
