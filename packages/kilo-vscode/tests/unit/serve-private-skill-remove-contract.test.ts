import { describe, expect, test } from "bun:test"
import {
  canonicalSkillRemoveOpId,
  normalizePrivateSkillRemoveWire,
  validateSkillRemoveContractRequest,
  validateSkillRemoveResult,
} from "../../src/services/cli-backend/serve-private-skill-remove-contract"

function req(overrides: Record<string, unknown> = {}) {
  const opId = canonicalSkillRemoveOpId("tok-contract")
  return {
    v: 1 as const,
    requestId: "req-contract",
    opId,
    op: "skill/remove" as const,
    idempotencyKey: opId,
    context: { directory: "/repo" },
    payload: { location: "/repo/.kilo/skills/demo/SKILL.md" },
    ...overrides,
  }
}

describe("skill/remove private contract", () => {
  test("fresh skill-remove identity validates", () => {
    expect(canonicalSkillRemoveOpId("tok")).toBe("skill-remove:tok")
    const out = validateSkillRemoveContractRequest(req())
    expect(out.opId).toBe(out.idempotencyKey)
    expect(out.payload.location).toBe("/repo/.kilo/skills/demo/SKILL.md")
  })

  test("unknown fields and identity mismatches fail closed", () => {
    const cases: unknown[] = [
      req({ extra: true }),
      req({ context: { directory: "/repo", sessionId: "ses_x" } }),
      req({ payload: { location: "/repo/.kilo/skills/demo/SKILL.md", bytes: "x" } }),
      req({ opId: "skill-remove:tok-contract", idempotencyKey: "skill-remove:other" }),
      req({ opId: "skill-remove:", idempotencyKey: "skill-remove:" }),
      req({ requestId: "/repo/evil" }),
      req({ payload: { location: "" } }),
    ]
    for (const c of cases) expect(() => validateSkillRemoveContractRequest(c)).toThrow()
  })

  test("succeeded result echoes identities with descriptor-only data", () => {
    const r = req()
    const raw = {
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: "skill/remove",
      idempotencyKey: r.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { removed: true },
    }
    const out = validateSkillRemoveResult(raw, r)
    expect(out.status).toBe("succeeded")
    expect(JSON.stringify(out).includes(r.payload.location)).toBe(false)
  })

  test("failed result requires echo-matched redacted failure", () => {
    const r = req()
    const failure = { code: "skill.builtin", message: "cannot remove built-in skill", retryable: false }
    const raw = {
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: "skill/remove",
      idempotencyKey: r.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure },
      accepted: false,
      failure,
    }
    expect(validateSkillRemoveResult(raw, r).status).toBe("failed")
  })

  test("failures carrying file bytes or unknown codes are invalid wire", () => {
    const r = req()
    const withLocation = {
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: "skill/remove",
      idempotencyKey: r.idempotencyKey,
      status: "failed",
      outcome: {
        type: "failed",
        time: 1,
        failure: { code: "internal", message: "m", retryable: false, location: "/repo/x" },
      },
      accepted: false,
      failure: { code: "internal", message: "m", retryable: false, location: "/repo/x" },
    }
    expect(normalizePrivateSkillRemoveWire(withLocation, r).kind).toBe("invalid")
    const unknownCode = {
      v: 1,
      requestId: r.requestId,
      opId: r.opId,
      op: "skill/remove",
      idempotencyKey: r.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "nope", message: "m", retryable: false } },
      accepted: false,
      failure: { code: "nope", message: "m", retryable: false },
    }
    expect(normalizePrivateSkillRemoveWire(unknownCode, r).kind).toBe("invalid")
  })

  test("echo mismatch is invalid wire", () => {
    const r = req()
    const raw = {
      v: 1,
      requestId: "other",
      opId: r.opId,
      op: "skill/remove",
      idempotencyKey: r.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { removed: true },
    }
    expect(normalizePrivateSkillRemoveWire(raw, r).kind).toBe("invalid")
  })
})
