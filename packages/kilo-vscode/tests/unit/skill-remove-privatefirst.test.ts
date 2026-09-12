import { describe, expect, test } from "bun:test"
import { attemptSkillRemovePrivate, buildSkillRemoveReq } from "../../src/kilo-provider/skill-remove-privatefirst"
import { canonicalSkillRemoveOpId } from "../../src/services/cli-backend/serve-private-skill-remove-contract"

const DIR = "/repo"
const LOCATION = "/repo/.kilo/skills/demo/SKILL.md"

function req() {
  return buildSkillRemoveReq(DIR, LOCATION)
}

function okFor(r: ReturnType<typeof req>) {
  return {
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
}

function failedFor(r: ReturnType<typeof req>, code = "skill.builtin") {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "skill/remove",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable: false } },
    accepted: false,
    failure: { code, message: "m", retryable: false },
  }
}

function ambiguousFor(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "skill/remove",
    idempotencyKey: r.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

describe("skill remove private-only", () => {
  test("identity binds fresh skill-remove tuple with descriptor location", () => {
    const r = req()
    expect(r.opId).toBe(r.idempotencyKey)
    expect(r.opId.startsWith("skill-remove:")).toBeTrue()
    const token = r.opId.split(":")[1]!
    expect(canonicalSkillRemoveOpId(token)).toBe(r.opId)
    expect(r.context.directory).toBe(DIR)
    expect(r.payload.location).toBe(LOCATION)
  })

  test("succeeded accepted resolves ok with zero SDK", async () => {
    const r = req()
    const connection = {
      isPrivateAvailable: () => true,
      privateSkillRemoveOutcomeWithHandle: (q: typeof r) => ({
        id: 1,
        promise: Promise.resolve({ kind: "valid", result: okFor(q) }),
        cancel: () => true,
      }),
    }
    // No client/SDK object is passed or reachable on this path.
    const out = await attemptSkillRemovePrivate(connection as never, r)
    expect(out).toEqual({ kind: "ok" })
  })

  test("terminal failures preserve actionable codes with zero SDK", async () => {
    for (const code of ["skill.builtin", "skill.url", "skill.not_found", "validation.failed", "internal"]) {
      const r = req()
      const connection = {
        isPrivateAvailable: () => true,
        privateSkillRemoveOutcomeWithHandle: (q: typeof r) => ({
          id: 1,
          promise: Promise.resolve({ kind: "valid", result: failedFor(q, code) }),
          cancel: () => true,
        }),
      }
      const out = await attemptSkillRemovePrivate(connection as never, r)
      expect(out).toEqual({ kind: "failed", code })
    }
  })

  test("retryable fence failure closes without mutation signal", async () => {
    const r = req()
    const connection = {
      isPrivateAvailable: () => true,
      privateSkillRemoveOutcomeWithHandle: (q: typeof r) => ({
        id: 2,
        promise: Promise.resolve({
          kind: "valid",
          result: {
            ...failedFor(q, "InstanceUnavailableDuringConfigRebuild"),
            outcome: {
              type: "failed",
              time: 1,
              failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "m", retryable: true },
            },
            failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "m", retryable: true },
          },
        }),
        cancel: () => true,
      }),
    }
    const out = await attemptSkillRemovePrivate(connection as never, r)
    expect(out).toEqual({ kind: "closed", reason: "InstanceUnavailableDuringConfigRebuild" })
  })

  test("unavailable/ambiguous/invalid/transport close with no SDK", async () => {
    const r1 = req()
    const unavailable = {
      isPrivateAvailable: () => false,
      privateSkillRemoveOutcomeWithHandle: () => {
        throw new Error("must not be called")
      },
    }
    expect(await attemptSkillRemovePrivate(unavailable as never, r1)).toEqual({
      kind: "closed",
      reason: "unavailable",
    })

    const r2 = req()
    const ambiguous = {
      isPrivateAvailable: () => true,
      privateSkillRemoveOutcomeWithHandle: (q: typeof r2) => ({
        id: 2,
        promise: Promise.resolve({ kind: "valid", result: ambiguousFor(q) }),
        cancel: () => true,
      }),
    }
    expect(await attemptSkillRemovePrivate(ambiguous as never, r2)).toEqual({ kind: "closed", reason: "ambiguous" })

    const r3 = req()
    const invalid = {
      isPrivateAvailable: () => true,
      privateSkillRemoveOutcomeWithHandle: () => ({
        id: 3,
        promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
        cancel: () => true,
      }),
    }
    expect(await attemptSkillRemovePrivate(invalid as never, r3)).toEqual({ kind: "closed", reason: "invalid" })

    const r4 = req()
    const transport = {
      isPrivateAvailable: () => true,
      privateSkillRemoveOutcomeWithHandle: () => ({
        id: 4,
        promise: Promise.reject(new Error("Private peer unavailable")),
        cancel: () => true,
      }),
    }
    expect(await attemptSkillRemovePrivate(transport as never, r4)).toEqual({
      kind: "closed",
      reason: "transport",
    })
  })

  test("timeout exact-cancels the pending with the opId", async () => {
    const r = req()
    let cancelled: string | undefined
    const connection = {
      isPrivateAvailable: () => true,
      getPrivatePeer: () => null,
      getPrivateEpoch: () => 1,
      privateSkillRemoveOutcomeWithHandle: () => ({
        id: 7,
        promise: new Promise(() => {}),
        cancel: (msg?: string) => {
          cancelled = msg
          return true
        },
      }),
    }
    const out = await attemptSkillRemovePrivate(connection as never, r, 10)
    expect(out).toEqual({ kind: "closed", reason: "timeout" })
    expect(cancelled).toContain(r.opId)
  })

  test("invalid request closes without touching the peer", async () => {
    const r = { ...req(), payload: { location: "" } }
    const connection = {
      isPrivateAvailable: () => true,
      privateSkillRemoveOutcomeWithHandle: () => {
        throw new Error("must not be called")
      },
    }
    expect(await attemptSkillRemovePrivate(connection as never, r as never)).toEqual({
      kind: "closed",
      reason: "invalid",
    })
  })
})
