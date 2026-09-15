import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth } from "@/auth"
import {
  fallbackSessionViewedIds,
  isSettledSessionViewedResult,
  succeeded,
  validateSessionViewedRequest,
  validateSessionViewedResult,
  sessionViewedPrivate,
} from "@/kilocode/presence/session-viewed-private"

const uid = "11111111-1111-4111-8111-111111111111"

function req(sequence = 1, extra: Record<string, unknown> = {}) {
  return {
    v: 1,
    requestId: "r1",
    op: "session/viewed",
    context: { directory: "/tmp" },
    payload: { viewer: { id: uid, active: true, sequence }, attached: ["ses_a"], visible: ["ses_a"] },
    ...extra,
  }
}

describe("session/viewed private contract", () => {
  test("accepts a valid request with requestId-only identity", () => {
    const out = validateSessionViewedRequest(req(2))
    expect(out.requestId).toBe("r1")
    expect(out.payload.viewer.sequence).toBe(2)
    expect((out as unknown as Record<string, unknown>).opId).toBeUndefined()
    expect((out as unknown as Record<string, unknown>).idempotencyKey).toBeUndefined()
  })

  test("rejects opId/idempotencyKey as a second semantic identity", () => {
    expect(() => validateSessionViewedRequest({ ...req(), opId: "x" })).toThrow("unexpected field")
    expect(() => validateSessionViewedRequest({ ...req(), idempotencyKey: "x" })).toThrow("unexpected field")
  })

  test("rejects unknown root/payload/viewer fields", () => {
    expect(() => validateSessionViewedRequest({ ...req(), extra: 1 })).toThrow("unexpected field")
    const badPayload = req() as unknown as Record<string, Record<string, unknown>>
    ;(badPayload.payload as Record<string, unknown>).extra = 1
    expect(() => validateSessionViewedRequest(badPayload)).toThrow("unexpected payload field")
    const badViewer = req() as unknown as Record<string, Record<string, Record<string, unknown>>>
    ;((badViewer.payload as Record<string, unknown>).viewer as Record<string, unknown>).extra = 1
    expect(() => validateSessionViewedRequest(badViewer)).toThrow("unexpected viewer field")
  })

  test("rejects bad viewer UUID, missing/negative/non-safe sequence, non-boolean active", () => {
    const badId = req()
    ;((badId.payload as Record<string, unknown>).viewer as Record<string, unknown>).id = "not-a-uuid"
    expect(() => validateSessionViewedRequest(badId)).toThrow()
    const missingSeq = req()
    delete ((missingSeq.payload as Record<string, unknown>).viewer as Record<string, unknown>).sequence
    expect(() => validateSessionViewedRequest(missingSeq)).toThrow()
    expect(() => validateSessionViewedRequest(req(-1))).toThrow()
    expect(() => validateSessionViewedRequest(req(1.5))).toThrow()
    expect(() => validateSessionViewedRequest(req(Number.MAX_SAFE_INTEGER + 1))).toThrow()
    const badActive = req()
    ;((badActive.payload as Record<string, unknown>).viewer as Record<string, unknown>).active = "yes"
    expect(() => validateSessionViewedRequest(badActive)).toThrow()
  })

  test("rejects non-array lists, non-ses ids, over-long ids, and over-cap lists", () => {
    const nonArray = req()
    ;(nonArray.payload as Record<string, unknown>).attached = "ses_a"
    expect(() => validateSessionViewedRequest(nonArray)).toThrow()
    const badId = req()
    ;(badId.payload as Record<string, unknown>).attached = ["nope"]
    expect(() => validateSessionViewedRequest(badId)).toThrow()
    const longId = req()
    ;(longId.payload as Record<string, unknown>).attached = [`ses_${"x".repeat(231)}`]
    expect(() => validateSessionViewedRequest(longId)).toThrow()
    const overAttached = req()
    ;(overAttached.payload as Record<string, unknown>).attached = Array.from({ length: 1001 }, () => "ses_a")
    expect(() => validateSessionViewedRequest(overAttached)).toThrow()
    const overVisible = req()
    ;(overVisible.payload as Record<string, unknown>).visible = Array.from({ length: 200 }, () => "ses_a")
    expect(() => validateSessionViewedRequest(overVisible)).toThrow()
  })

  test("validates result shape: succeeded needs applied true, failed needs matching failure, ambiguous needs accepted false", () => {
    const base = validateSessionViewedRequest(req(1))
    const ok = succeeded(base)
    expect(validateSessionViewedResult(ok, base).status).toBe("succeeded")
    const badApplied = { ...ok, data: { applied: false } }
    expect(() => validateSessionViewedResult(badApplied, base)).toThrow()
    const badAccepted = { ...ok, accepted: false }
    expect(() => validateSessionViewedResult(badAccepted, base)).toThrow()
    const withFailure = { ...ok, failure: { code: "x", message: "y", retryable: false } }
    expect(() => validateSessionViewedResult(withFailure, base)).toThrow()
    const mismatch = { ...ok, requestId: "other" }
    expect(() => validateSessionViewedResult(mismatch, base)).toThrow("requestId mismatch")
  })

  test("settles succeeded and terminal failed, not retryable or ambiguous", () => {
    const base = validateSessionViewedRequest(req(1))
    expect(isSettledSessionViewedResult(succeeded(base), base)).toBe(true)
    const terminal = {
      v: 1,
      requestId: "r1",
      op: "session/viewed",
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "validation.failed", message: "m", retryable: false } },
      accepted: false,
      failure: { code: "validation.failed", message: "m", retryable: false },
    }
    expect(isSettledSessionViewedResult(terminal, base)).toBe(true)
    const retryable = {
      v: 1,
      requestId: "r1",
      op: "session/viewed",
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "x", message: "m", retryable: true } },
      accepted: false,
      failure: { code: "x", message: "m", retryable: true },
    }
    expect(isSettledSessionViewedResult(retryable, base)).toBe(false)
    expect(isSettledSessionViewedResult({ ...terminal, status: "ambiguous" }, base)).toBe(false)
  })

  test("falls back to unknown requestId for malformed params", () => {
    expect(fallbackSessionViewedIds({}).requestId).toBe("unknown")
    expect(fallbackSessionViewedIds({ requestId: "r9" }).requestId).toBe("r9")
  })
})

describe("sessionViewedPrivate owner", () => {
  const authLayer = Layer.succeed(
    Auth.Service,
    Auth.Service.of({
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed({} as never),
      set: () => Effect.void,
      remove: () => Effect.void,
    }),
  )

  test("writes through the canonical KiloViewers owner and repeats harmlessly", async () => {
    const { KiloViewers } = await import("@/kilocode/presence/service")
    const layer = KiloViewers.layer.pipe(Layer.provide(authLayer))
    const run = Effect.gen(function* () {
      const first = yield* sessionViewedPrivate(req(1))
      expect(first.status).toBe("succeeded")
      if (first.status === "succeeded") expect(first.data).toEqual({ applied: true })
      // Lower-sequence repeat is still a transport success; the owner drops
      // it with no TTL refresh (monotonic ordering makes it harmless).
      const repeat = yield* sessionViewedPrivate(req(1))
      expect(repeat.status).toBe("succeeded")
      const invalid = yield* sessionViewedPrivate({ v: 1, requestId: "r2", op: "session/viewed" })
      expect(invalid.status).toBe("failed")
      if (invalid.status === "failed") expect(invalid.failure.code).toBe("validation.failed")
    }).pipe(Effect.provide(layer))
    await Effect.runPromise(run)
  })

  test("owner internal error and defect synthesize retryable failure for SDK fallback", async () => {
    const { KiloViewers } = await import("@/kilocode/presence/service")
    const failing = Layer.succeed(
      KiloViewers.Service,
      KiloViewers.Service.of({
        update: () => Effect.fail(new Error("owner boom")) as unknown as Effect.Effect<void>,
        invalidateAuth: () => Effect.void,
      }),
    )
    const failingOut = await Effect.runPromise(sessionViewedPrivate(req(3)).pipe(Effect.provide(failing)))
    expect(failingOut.status).toBe("failed")
    if (failingOut.status === "failed") {
      expect(failingOut.failure.code).toBe("internal")
      expect(failingOut.failure.retryable).toBe(true)
      expect(failingOut.accepted).toBe(false)
      expect(isSettledSessionViewedResult(failingOut, validateSessionViewedRequest(req(3)))).toBe(false)
    } else throw new Error("expected failed")
    const defecting = Layer.succeed(
      KiloViewers.Service,
      KiloViewers.Service.of({
        update: () => Effect.die(new Error("owner defect")),
        invalidateAuth: () => Effect.void,
      }),
    )
    const defectOut = await Effect.runPromise(sessionViewedPrivate(req(4)).pipe(Effect.provide(defecting)))
    expect(defectOut.status).toBe("failed")
    if (defectOut.status === "failed") expect(defectOut.failure.retryable).toBe(true)
    else throw new Error("expected failed")
  })
})
