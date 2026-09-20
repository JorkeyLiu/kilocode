import { describe, expect, it } from "bun:test"
import { validateE2ERevertSeedRequest, validateE2ERevertSeedResult } from "../../src/services/cli-backend/serve-private-e2e-revert-seed"

describe("e2eRevertSeed fixture contract", () => {
  it("requires KILO_E2E_FIXTURE for request validation", () => {
    const prev = process.env.KILO_E2E_FIXTURE
    process.env.KILO_E2E_FIXTURE = "0"
    try {
      expect(() =>
        validateE2ERevertSeedRequest({
          v: 1,
          requestId: "r1",
          opId: "e2eRevertSeed:tok",
          op: "session/e2eRevertSeed",
          idempotencyKey: "e2eRevertSeed:tok",
          context: { directory: "/tmp/ws" },
          payload: {},
        }),
      ).toThrow()
    } finally {
      if (prev === undefined) delete process.env.KILO_E2E_FIXTURE
      else process.env.KILO_E2E_FIXTURE = prev
    }
  })

  it("strict request fields", () => {
    const prev = process.env.KILO_E2E_FIXTURE
    process.env.KILO_E2E_FIXTURE = "1"
    try {
      const base = {
        v: 1 as const,
        requestId: "r1",
        opId: "e2eRevertSeed:tok",
        op: "session/e2eRevertSeed" as const,
        idempotencyKey: "e2eRevertSeed:tok",
        context: { directory: "/tmp/ws" },
        payload: {},
      }
      expect(() => validateE2ERevertSeedRequest(base)).not.toThrow()
      expect(() => validateE2ERevertSeedRequest({ ...base, v: 2 as unknown as 1 })).toThrow()
      expect(() => validateE2ERevertSeedRequest({ ...base, requestId: "" })).toThrow()
      expect(() => validateE2ERevertSeedRequest({ ...base, op: "wrong" as unknown as "session/e2eRevertSeed" })).toThrow()
      expect(() => validateE2ERevertSeedRequest({ ...base, context: { directory: "" } as unknown as { directory: string } })).toThrow()
      expect(() => validateE2ERevertSeedRequest({ ...base, payload: { title: 123 as unknown as string } })).toThrow()
    } finally {
      if (prev === undefined) delete process.env.KILO_E2E_FIXTURE
      else process.env.KILO_E2E_FIXTURE = prev
    }
  })

  it("strict result matches request and requires succeeded shape", () => {
    const prev = process.env.KILO_E2E_FIXTURE
    process.env.KILO_E2E_FIXTURE = "1"
    try {
      const req = {
        v: 1 as const,
        requestId: "r1",
        opId: "e2eRevertSeed:tok",
        op: "session/e2eRevertSeed" as const,
        idempotencyKey: "e2eRevertSeed:tok",
        context: { directory: "/tmp/ws" },
        payload: {},
      }
      const ok = {
        v: 1,
        requestId: "r1",
        opId: "e2eRevertSeed:tok",
        op: "session/e2eRevertSeed",
        idempotencyKey: "e2eRevertSeed:tok",
        status: "succeeded",
        outcome: { type: "succeeded", time: Date.now() },
        accepted: true,
        data: { sessionId: "ses_abc", messageId: "msg_abc", partId: "prt_abc", session: { id: "ses_abc" }, revision: 1 },
      }
      expect(() => validateE2ERevertSeedResult(ok, req)).not.toThrow()
      expect(() => validateE2ERevertSeedResult({ ...ok, requestId: "r2" }, req)).toThrow()
      expect(() => validateE2ERevertSeedResult({ ...ok, opId: "other" }, req)).toThrow()
      expect(() => validateE2ERevertSeedResult({ ...ok, status: "failed" } as unknown, req)).toThrow()
    } finally {
      if (prev === undefined) delete process.env.KILO_E2E_FIXTURE
      else process.env.KILO_E2E_FIXTURE = prev
    }
  })

  it("does not expose capability without fixture", async () => {
    // This checks that require guard is effective: validate throws when fixture off
    const prev = process.env.KILO_E2E_FIXTURE
    process.env.KILO_E2E_FIXTURE = "0"
    try {
      let threw = false
      try {
        validateE2ERevertSeedRequest({
          v: 1,
          requestId: "r",
          opId: "e2eRevertSeed:tok",
          op: "session/e2eRevertSeed",
          idempotencyKey: "e2eRevertSeed:tok",
          context: { directory: "/tmp/ws" },
          payload: {},
        })
      } catch {
        threw = true
      }
      expect(threw).toBeTrue()
    } finally {
      if (prev === undefined) delete process.env.KILO_E2E_FIXTURE
      else process.env.KILO_E2E_FIXTURE = prev
    }
  })
})
