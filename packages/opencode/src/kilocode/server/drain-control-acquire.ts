import { Effect, Option } from "effect"
import { InstanceStore } from "@/project/instance-store"
import { GenerationGate } from "./generation-gate"
import { ControlLease } from "./control-lease"
import type { InstanceContext } from "@/project/instance-context"

export class InstanceUnavailableDuringConfigRebuildError extends Error {
  override message: string
  readonly _tag = "InstanceUnavailableDuringConfigRebuild" as const
  constructor(
    public readonly directory: string,
    message = "Instance is unavailable during config rebuild; no active runtime for this request",
  ) {
    super(message)
    this.message = message
    this.name = "InstanceUnavailableDuringConfigRebuild"
  }
}

export type AcquiredControl = {
  readonly ctx: InstanceContext
  readonly release: Effect.Effect<void>
}

/**
 * Shared acquisition helper for drain-control lane.
 * Snapshot-first, ControlLease.acquire, no new gate/read lease.
 * During active fence use existing snapshot; if no snapshot return 409.
 * Outside fence falls through to normal boot via gate+store.load.
 * Used by both HTTP middleware and CancelQueuedDispatch to avoid duplication.
 */
export function acquireDrainControl(directory: string) {
  return acquireDrainControlWith(directory, undefined, undefined, undefined)
}

export function acquireDrainControlWith(
  directory: string,
  storeOpt?: InstanceStore.Interface,
  gateOpt?: GenerationGate,
  leasesOpt?: ControlLease,
) {
  return Effect.gen(function* () {
    const store = storeOpt !== undefined ? storeOpt : yield* InstanceStore.Service
    const gate =
      gateOpt !== undefined
        ? gateOpt
        : Option.getOrElse(yield* Effect.serviceOption(GenerationGate.Service), () => GenerationGate.noop)
    const leases =
      leasesOpt !== undefined
        ? leasesOpt
        : Option.getOrElse(yield* Effect.serviceOption(ControlLease.Service), () => ControlLease.noop)
    const snap = yield* store.snapshot(directory)
    if (snap._tag === "Some") {
      const lease = yield* Effect.sync(() => leases.acquire(snap.value))
      if (lease._tag === "Some") {
        return { ctx: snap.value, release: lease.value } satisfies AcquiredControl
      }
      return yield* Effect.fail(new InstanceUnavailableDuringConfigRebuildError(directory))
    }
    if (gate.isBarrierActive(directory)) {
      return yield* Effect.fail(new InstanceUnavailableDuringConfigRebuildError(directory))
    }
    // No snapshot and no barrier -> normal boot (gate+load) plus ControlLease hold (LOCK-302).
    const releaseGate = yield* gate.acquire(directory)
    const ctx = yield* store.load({ directory }).pipe(Effect.ensuring(releaseGate))
    const leaseOpt = yield* Effect.sync(() => leases.acquire(ctx))
    if (leaseOpt._tag === "None") {
      return yield* Effect.fail(new InstanceUnavailableDuringConfigRebuildError(directory))
    }
    return { ctx, release: leaseOpt.value } satisfies AcquiredControl
  })
}


