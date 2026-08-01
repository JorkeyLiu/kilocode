// kilocode_change - new file
/**
 * Canonical legacy AsyncLocalStorage bridge (kilocode_change).
 *
 * An Effect run normally does not re-enter the legacy `Instance.current`
 * AsyncLocalStorage scope. The ALS scope only propagates into async
 * continuations created synchronously inside `storage.run`, so an effect whose
 * Promise-side code reads `Instance.current`/`capture()` must be started
 * inside that callback — it cannot be applied with `Effect.provideService`
 * after the fact. This is the single Kilo-owned boundary for that bridge
 * (the same shape InstanceStore uses for boot/dispose/reload).
 *
 * - `runInInstance` runs a requirements-satisfied effect inside `ctx`'s ALS
 *   scope. Unlike a bare `Effect.promise(() => instanceContext.provide(...))`,
 *   it starts the run as a fork so interrupting the caller interrupts the
 *   ALS-scoped work instead of leaving it detached (verified by
 *   `test/kilocode/effect/als-bridge.test.ts`).
 *
 * Keep ad hoc `instanceContext.provide(...)` + `Effect.runPromise` nesting out
 * of other call sites; `script/check-opencode-promise-facades.ts` classifies
 * this file and InstanceStore as the only allowed bridge sites.
 */

import { Effect, Exit, Fiber } from "effect"
import { context as instanceContext, type InstanceContext } from "@/project/instance-context"

export const runInInstance = <A, E>(
  ctx: InstanceContext,
  effect: Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> =>
  Effect.callback<A, E>((resume) => {
    let resumed = false
    const finish = (exit: Exit.Exit<A, E>) => {
      if (resumed) return
      resumed = true
      resume(exit)
    }
    // The ALS store propagates into continuations created inside `provide`;
    // starting the fork there is what makes `Instance.current` work inside the
    // effect. The fork also gives interruption a handle to cancel the run.
    const fiber = instanceContext.provide(ctx, () =>
      Effect.runFork(effect.pipe(Effect.exit, Effect.flatMap((exit) => Effect.sync(() => finish(exit))))),
    )
    return Effect.sync(() => {
      if (resumed) return
      resumed = true
    }).pipe(Effect.flatMap(() => Fiber.interrupt(fiber).pipe(Effect.asVoid)))
  })
export * as KiloAlsBridge from "./als-bridge"
