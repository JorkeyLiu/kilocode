// kilocode_change - new file
import { Context, Effect } from "effect"
import { Config } from "@/config/config"
import { InstanceStore } from "@/project/instance-store"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { runInInstance } from "@/kilocode/effect/als-bridge"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { withConfigSnapshot } from "@/kilocode/session/config-snapshot"

/**
 * Fiber-local admission scope reference.
 *
 * When a parent generation is admitted for a directory, it provides this
 * reference in its Effect context. Nested child work (TaskPromptOps.prompt,
 * subagent forks) inherits the context and sees the reference, so it reuses
 * the parent's admission without re-acquiring the gate. This prevents
 * parent→child deadlocks when a writer is queued.
 *
 * Scoped by directory: a child for the SAME directory reuses, including the
 * parent versioned policy snapshot; a child for a DIFFERENT directory
 * acquires independently and captures its own snapshot at actual execution.
 * Process-global mutable reentrancy is NOT used.
 *
 * Fresh prompt intake (which has no parent context) never sees this reference
 * and acquires independently.
 */
type AdmissionScope = {
  readonly directory: string
}

export const GenerationAdmissionScope = Context.Reference<AdmissionScope | undefined>(
  "@kilocode/GenerationAdmissionScope",
  { defaultValue: () => undefined },
)

/**
 * Run generation work (prompt loop / shell / command) under generation
 * admission.
 *
 * 1. Check the fiber-local admission scope. If already admitted for the
 *    SAME directory, reuse the existing admission and versioned policy
 *    snapshot without re-acquiring the gate. This prevents
 *    nested-reader/writer deadlocks.
 * 2. Otherwise, acquire a reader lease on the generation gate for the current
 *    directory. If a cold-config convergence fence is active or a global
 *    writer is queued, this waits — and while waiting the work never touches
 *    an InstanceContext.
 * 3. Once admitted (the fence released), load the CURRENT instance context
 *    (post-rebuild) and rebind both the Effect `InstanceRef` and the legacy
 *    AsyncLocalStorage instance context, so no stale runtime is used.
 * 4. Capture the versioned policy snapshot AFTER the rebind, so `Config.get`
 *    and permission policy inside the generation return the config that was
 *    persisted before the fence released. Queued generations therefore
 *    snapshot at actual execution, and the next admission after convergence
 *    sees the latest version. The lease is held for the whole generation.
 */
export const withGenerationAdmission = <A, E, R>(
  config: Config.Interface,
  work: Effect.Effect<A, E, R>,
) : Effect.Effect<A, E, R> =>
  (Effect.gen(function* () {
    const scope = yield* GenerationAdmissionScope
    const current = yield* InstanceState.context

    // If already admitted for the same directory, nested work reuses the
    // parent's admission and snapshot. No gate re-acquisition, no deadlock.
    if (scope && scope.directory === current.directory) {
      return yield* work
    }

    // Fresh admission: acquire gate, load instance, capture snapshot
    const gate = yield* GenerationGate.Service
    const release = yield* gate.acquire(current.directory)
    return yield* Effect.ensuring(
      Effect.gen(function* () {
        const store = yield* InstanceStore.Service
        const captured = yield* Effect.context()
        const ctx = yield* store.load({ directory: current.directory })
        // Rebind the legacy ALS around the full run so Promise-side code that
        // reads `Instance.current`/`capture()` sees the fresh instance, then
        // capture the config snapshot for the whole generation. `runInInstance`
        // is the canonical ALS bridge (ratchet-classified) and interrupts the
        // bridged run when this admission is cancelled.
        const rebound = withConfigSnapshot(config, work).pipe(
          Effect.provide(captured),
          Effect.provideService(InstanceRef, ctx),
          Effect.provideService(GenerationAdmissionScope, { directory: current.directory }),
        ) as Effect.Effect<A, E, never>
        return yield* runInInstance(ctx, rebound)
      }),
      release,
    )
  }) as Effect.Effect<A, E, R>)

export * as KiloGenerationAdmission from "./generation-admission"
