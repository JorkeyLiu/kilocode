/**
 * Identity-keyed control + write lifetime leases (LOCK-002/003/006/007).
 *
 * Two admission lanes hold lifetime leases keyed by the exact `InstanceContext`
 * identity:
 *
 * - A drain-control request served from a cached `InstanceContext` (the
 *   snapshot-first lane in instance-context.ts) holds a lease via `acquire`
 *   until its handler fully completes.
 * - A config/settings/provider/auth write-intent request (LOCK-006) holds a
 *   lease via `acquireWrite` from immediately after its middleware load until
 *   the complete downstream handler effect finishes.
 *
 * `ConfigRebuild` / the ConfigConvergence pass seals the identity — atomically
 * closing new control AND write admission — and awaits outstanding leases
 * (both lanes share one `outstanding` counter on the identity record) before
 * disposing the captured instance. This makes both lanes race-free with
 * old-instance disposal: a control or a hot/joining write handler can never
 * run against a context that a writer is disposing, and a writer can never
 * observe zero holders and then have a late handler attach to the disposed
 * context.
 *
 * Atomicity model: JavaScript is single-threaded, so each state transition is
 * a single synchronous block.
 *
 * - `acquire` / `acquireWrite` check `sealed` and increment `outstanding` in
 *   one sync step.
 * - `sealAndDrain` sets `sealed` and checks `outstanding === 0` in one sync
 *   step (creating the drain signal if a lease is outstanding).
 *
 * Whichever sync block runs first wins: a handler that acquires before the
 * seal holds a lease the writer must drain; a handler that arrives after the
 * seal is refused (Option.none → deterministic 409 for controls, deterministic
 * write-unavailable for write intent — the loaded identity is already doomed
 * for disposal, so running against it is never safe). There is no interval in
 * which the writer observes zero holders and a new handler can still attach.
 *
 * The drain signal is only awaited while the writer holds its barrier, so the
 * lease is released on every handler exit path — success, failure, and
 * interruption — via `Effect.ensuring` in the middleware.
 *
 * Records live in a `WeakMap` keyed by the instance identity, so a sealed
 * record survives exactly as long as any actor (writer, in-flight handler)
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
   * Attempt to acquire a lifetime lease for `ctx` (drain-control lane). Returns
   * `Some(release)` when the identity is open for control admission, `None`
   * when a writer has sealed it (the identity is being drained and will be
   * disposed). The sealed-check and the increment are one synchronous step.
   *
   * The caller MUST release the lease via `Effect.ensuring` (or equivalent) so
   * it is returned on success, failure, and interruption.
   */
  readonly acquire: (ctx: InstanceContext) => Option.Option<Effect.Effect<void>>
  /**
   * Attempt to acquire a lifetime lease for `ctx` on the write-intent lane
   * (LOCK-006/007). Same identity record and same `outstanding` counter as
   * `acquire`, so `sealAndDrain` waits for BOTH controls and write handlers
   * before disposal. The middleware acquires it immediately after the
   * write-intent load (for the exact InstanceRef) and holds it through the
   * complete downstream handler effect via `Effect.ensuring`.
   *
   * Returns `None` when the identity is already sealed for disposal — the
   * loaded identity cannot remain valid (LOCK-006), so the caller must not run
   * the handler against it (deterministic refusal; a retry against the
   * replacement identity succeeds).
   */
  readonly acquireWrite: (ctx: InstanceContext) => Option.Option<Effect.Effect<void>>
  /**
   * Atomically close `ctx` for new control and write admission and complete
   * once every outstanding lease (control AND write) has been released. When
   * this completes, no handler can attach to `ctx`, so the caller may dispose
   * the instance.
   */
  readonly sealAndDrain: (ctx: InstanceContext) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, ControlLease>()("@kilocode/ControlLease") {}

/** No-op lease coordinator for layers that do not provide the service. */
export const noop: ControlLease = {
  acquire: () => Option.some(Effect.void),
  acquireWrite: () => Option.some(Effect.void),
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

    const acquireInternal = (ctx: InstanceContext): Option.Option<Effect.Effect<void>> => {
      let record = records.get(ctx)
      if (!record) {
        record = { sealed: false, outstanding: 0 }
        records.set(ctx, record)
      }
      if (record.sealed) return Option.none()
      record.outstanding += 1
      return Option.some(release(ctx, record))
    }

    // The control and write lanes share the identity record: the writer seals
    // both at once and drains the combined outstanding counter, so a
    // snapshot-served control and a loaded write handler can never coexist
    // with a disposer of the exact identity.
    const acquire = acquireInternal
    const acquireWrite = acquireInternal

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
        // LOCK-007: concurrent sealers (e.g. an explicit reload disposal racing
        // a convergence pass disposal of the same identity) share ONE drain
        // signal. Overwriting `record.drain` would orphan the earlier waiter
        // and deadlock it: `release` only fires the CURRENT signal. All
        // concurrent sealers await the same signal, so every waiter completes
        // when the last outstanding lease releases.
        record.drain = record.drain ?? Deferred.makeUnsafe<void>()
        return record.drain
      })
      if (wait) yield* Deferred.await(wait)
    })

    return Service.of({ acquire, acquireWrite, sealAndDrain })
  }),
)

export const defaultLayer = layer
export * as ControlLease from "./control-lease"
