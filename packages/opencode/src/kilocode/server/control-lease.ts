/**
 * Identity-keyed control lifetime leases (LOCK-002/003).
 *
 * A drain-control request served from a cached `InstanceContext` (the
 * snapshot-first lane in instance-context.ts) holds a lease keyed by that
 * exact instance identity until its handler fully completes. `ConfigRebuild`
 * seals the identity — atomically closing new control admission — and awaits
 * outstanding leases before disposing the captured instance. This makes the
 * snapshot lane race-free with old-instance disposal: a control can never run
 * against a context that a writer is disposing, and a writer can never observe
 * zero controls and then have a late control attach to the disposed context.
 *
 * Atomicity model: JavaScript is single-threaded, so each state transition is
 * a single synchronous block.
 *
 * - `acquire` checks `sealed` and increments `outstanding` in one sync step.
 * - `sealAndDrain` sets `sealed` and checks `outstanding === 0` in one sync
 *   step (creating the drain signal if a lease is outstanding).
 *
 * Whichever sync block runs first wins: a control that acquires before the
 * seal holds a lease the writer must drain; a control that arrives after the
 * seal is refused (Option.none → deterministic 409). There is no interval in
 * which the writer observes zero controls and a new control can still attach.
 *
 * The drain signal is only awaited while the writer holds its barrier, so the
 * lease is released on every handler exit path — success, failure, and
 * interruption — via `Effect.ensuring` in the middleware.
 *
 * Records live in a `WeakMap` keyed by the instance identity, so a sealed
 * record survives exactly as long as any actor (writer, in-flight control)
 * references the identity — long enough to refuse a stale attach — and is
 * garbage-collected with the instance. There is no per-rebuild leak.
 */

import { Context, Deferred, Effect, Layer, Option } from "effect"
import type { InstanceContext } from "@/project/instance-context"

interface LeaseRecord {
  sealed: boolean
  outstanding: number
  drain?: Deferred.Deferred<void>
}

export interface ControlLease {
  /**
   * Attempt to acquire a lifetime lease for `ctx`. Returns `Some(release)`
   * when the identity is open for control admission, `None` when a writer has
   * sealed it (the identity is being drained and will be disposed). The
   * sealed-check and the increment are one synchronous step.
   *
   * The caller MUST release the lease via `Effect.ensuring` (or equivalent) so
   * it is returned on success, failure, and interruption.
   */
  readonly acquire: (ctx: InstanceContext) => Option.Option<Effect.Effect<void>>
  /**
   * Atomically close `ctx` for new control admission and complete once every
   * outstanding lease has been released. When this completes, no control can
   * attach to `ctx`, so the caller may dispose the instance.
   */
  readonly sealAndDrain: (ctx: InstanceContext) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, ControlLease>()("@kilocode/ControlLease") {}

/** No-op lease coordinator for layers that do not provide the service. */
export const noop: ControlLease = {
  acquire: () => Option.some(Effect.void),
  sealAndDrain: () => Effect.void,
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const records = new WeakMap<InstanceContext, LeaseRecord>()

    const release = (ctx: InstanceContext, record: LeaseRecord): Effect.Effect<void> =>
      Effect.sync(() => {
        record.outstanding -= 1
        if (record.sealed && record.outstanding === 0 && record.drain) {
          const drain = record.drain
          record.drain = undefined
          Deferred.doneUnsafe(drain, Effect.succeed(void 0))
        }
      })

    const acquire = (ctx: InstanceContext): Option.Option<Effect.Effect<void>> => {
      let record = records.get(ctx)
      if (!record) {
        record = { sealed: false, outstanding: 0 }
        records.set(ctx, record)
      }
      if (record.sealed) return Option.none()
      record.outstanding += 1
      return Option.some(release(ctx, record))
    }

    const sealAndDrain = Effect.fn("ControlLease.sealAndDrain")(function* (ctx: InstanceContext) {
      const wait = yield* Effect.sync(() => {
        let record = records.get(ctx)
        if (!record) {
          record = { sealed: true, outstanding: 0 }
          records.set(ctx, record)
          return undefined
        }
        record.sealed = true
        if (record.outstanding === 0) return undefined
        record.drain = Deferred.makeUnsafe<void>()
        return record.drain
      })
      if (wait) yield* Deferred.await(wait)
    })

    return Service.of({ acquire, sealAndDrain })
  }),
)

export const defaultLayer = layer
export * as ControlLease from "./control-lease"
