/**
 * ControlLease coordinator unit tests (LOCK-002/003).
 *
 * The coordinator keys leases by exact `InstanceContext` identity. These tests
 * use distinct plain objects as identity keys — the service only inspects
 * object identity, never context fields — so the pure unit surface is the
 * acquire/seal/drain state machine:
 *
 * - acquire and seal are single synchronous steps, so whichever runs first
 *   wins: a control that acquires before the seal holds a lease the writer
 *   must drain; a control that arrives after the seal is refused.
 * - the drain signal only resolves when every outstanding lease releases, and
 *   release is guaranteed on success, failure, and interruption.
 * - a sealed identity stays sealed, so a late stale attach is refused even
 *   after the drain completed.
 *
 * No sleeps: every race is sequenced through Deferreds and admission
 * side-effects observed synchronously. Uses `it.live` so the bounded timeout
 * combinators are real failure bounds.
 */
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Option } from "effect"
import { testEffect } from "../../lib/effect"
import { awaitWithTimeout } from "../../lib/effect"
import { ControlLease } from "../../../src/kilocode/server/control-lease"
import type { InstanceContext } from "../../../src/project/instance-context"

const it = testEffect(ControlLease.defaultLayer)

/** Distinct identity keys; the service only uses object identity. */
const ctx = (id: string) => ({ directory: id }) as unknown as InstanceContext

const isDone = <A>(deferred: Deferred.Deferred<A>) => Effect.map(Deferred.poll(deferred), (opt) => opt._tag === "Some")

/** Narrow an Option to its value; the caller must have acquired a lease. */
const unwrap = <A>(opt: Option.Option<A>): A => {
  if (opt._tag === "None") throw new Error("expected Some")
  return opt.value
}

describe("ControlLease identity-keyed lifetime leases", () => {
  it.live("sealAndDrain completes immediately when no lease is outstanding and is idempotent", () =>
    Effect.gen(function* () {
      const leases = yield* ControlLease.Service
      const a = ctx("a")
      yield* awaitWithTimeout(leases.sealAndDrain(a), "seal with no leases did not complete")
      yield* awaitWithTimeout(leases.sealAndDrain(a), "second seal of a sealed identity did not complete")
    }))

  it.live("acquire after seal is refused", () =>
    Effect.gen(function* () {
      const leases = yield* ControlLease.Service
      const a = ctx("a")
      yield* leases.sealAndDrain(a)
      expect((yield* Effect.sync(() => leases.acquire(a)))._tag).toBe("None")
    }))

  it.live("acquire before seal holds the drain until the lease releases", () =>
    Effect.gen(function* () {
      const leases = yield* ControlLease.Service
      const a = ctx("a")
      const lease = yield* Effect.sync(() => leases.acquire(a))
      expect(lease._tag).toBe("Some")
      const drained = yield* Deferred.make<void>()
      const sealed = yield* Effect.forkDetach(
        leases.sealAndDrain(a).pipe(Effect.ensuring(Deferred.succeed(drained, void 0))),
      )
      yield* Effect.yieldNow
      expect(yield* isDone(drained)).toBe(false)
      yield* unwrap(lease)
      yield* awaitWithTimeout(Deferred.await(drained), "seal did not complete after the lease released")
      yield* Fiber.join(sealed)
    }))

  it.live("two outstanding leases drain only after both release", () =>
    Effect.gen(function* () {
      const leases = yield* ControlLease.Service
      const a = ctx("a")
      const first = yield* Effect.sync(() => leases.acquire(a))
      const second = yield* Effect.sync(() => leases.acquire(a))
      expect(first._tag).toBe("Some")
      expect(second._tag).toBe("Some")
      const drained = yield* Deferred.make<void>()
      const sealed = yield* Effect.forkDetach(
        leases.sealAndDrain(a).pipe(Effect.ensuring(Deferred.succeed(drained, void 0))),
      )
      yield* Effect.yieldNow
      expect(yield* isDone(drained)).toBe(false)
      yield* unwrap(first)
      yield* Effect.yieldNow
      expect(yield* isDone(drained)).toBe(false)
      yield* unwrap(second)
      yield* awaitWithTimeout(Deferred.await(drained), "seal did not complete after both leases released")
      yield* Fiber.join(sealed)
    }))

  it.live("release is guaranteed on handler failure and interruption", () =>
    Effect.gen(function* () {
      const leases = yield* ControlLease.Service
      const fail = ctx("fail")
      const failLease = yield* Effect.sync(() => leases.acquire(fail))
      expect(failLease._tag).toBe("Some")
      yield* Effect.fail("boom").pipe(
        Effect.ensuring(unwrap(failLease)),
        Effect.exit,
      )
      yield* awaitWithTimeout(leases.sealAndDrain(fail), "seal after handler failure did not drain")

      const interrupt = ctx("interrupt")
      const interruptLease = yield* Effect.sync(() => leases.acquire(interrupt))
      expect(interruptLease._tag).toBe("Some")
      const gate = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkDetach(
        Effect.gen(function* () {
          yield* Deferred.await(gate)
        }).pipe(Effect.ensuring(unwrap(interruptLease))),
      )
      // Let the parked fiber start so interruption runs its finalizers; a
      // forkDetach fiber interrupted before its first instruction never starts
      // (its ensuring is skipped), which cannot happen in the middleware flow
      // where the served handler effect is always started by the HTTP layer.
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      yield* awaitWithTimeout(leases.sealAndDrain(interrupt), "seal after handler interruption did not drain")
    }))

  it.live("a sealed identity refuses stale attaches after the drain completed", () =>
    Effect.gen(function* () {
      const leases = yield* ControlLease.Service
      const a = ctx("a")
      const lease = yield* Effect.sync(() => leases.acquire(a))
      expect(lease._tag).toBe("Some")
      const drained = yield* Deferred.make<void>()
      const sealed = yield* Effect.forkDetach(
        leases.sealAndDrain(a).pipe(Effect.ensuring(Deferred.succeed(drained, void 0))),
      )
      yield* unwrap(lease)
      yield* awaitWithTimeout(Deferred.await(drained), "seal did not complete")
      yield* Fiber.join(sealed)
      // Late attach to the disposed identity: refused, never a fresh record.
      expect((yield* Effect.sync(() => leases.acquire(a)))._tag).toBe("None")
    }))

  it.live("sealing one identity does not affect another", () =>
    Effect.gen(function* () {
      const leases = yield* ControlLease.Service
      const a = ctx("a")
      const b = ctx("b")
      yield* leases.sealAndDrain(a)
      expect((yield* Effect.sync(() => leases.acquire(b)))._tag).toBe("Some")
      expect((yield* Effect.sync(() => leases.acquire(a)))._tag).toBe("None")
    }))

  it.live("stale attach across the seal boundary is refused (snapshot-before-seal window)", () =>
    Effect.gen(function* () {
      const leases = yield* ControlLease.Service
      const a = ctx("a")
      // The middleware may hold a snapshot reference across the writer's
      // seal+drain+dispose. The sealed record must survive as long as the
      // identity is referenced and refuse the late attach.
      const snap = a
      yield* leases.sealAndDrain(snap)
      yield* leases.sealAndDrain(a)
      expect((yield* Effect.sync(() => leases.acquire(snap)))._tag).toBe("None")
    }))
})
