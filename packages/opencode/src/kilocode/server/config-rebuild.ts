// kilocode_change - new file
/**
 * Drain-and-rebuild helpers for the explicit-dispose ticket path, plus the
 * shared rebuild tracker (LOCK-002/003/006).
 *
 * The writer barrier lives in `GenerationGate`. This module performs the
 * drain→dispose→reboot→release transition for a ticket the explicit
 * global-dispose handler established via `withWriteTicket`:
 *
 * 1. The handler calls `gate.beginWriteGlobal()` BEFORE persisting/disposing,
 *    so no post-write generation can slip into an old runtime (LOCK-002).
 * 2. The handler captures pre-barrier identity AFTER ticket acquisition but
 *    BEFORE persistence visibility, then persists and forks the rebuild
 *    (LOCK-003).
 * 3. The rebuild fiber awaits the barrier's drain signal (event-driven, no
 *    polling), disposes the exact captured pre-barrier identity while the
 *    barrier still excludes new work, boots the replacement, and releases the
 *    barrier so queued work binds to the fresh instance (LOCK-003).
 * 4. A failed persistence aborts the barrier (`ticket.abort`) without
 *    disposing anything; queued work resumes on the unchanged instance.
 *
 * Cold config saves do NOT use this path: the ConfigConvergence coordinator
 * raises an admission fence, commits a convergence obligation that
 * synchronously registers the rebuild through the shared tracker, and runs a
 * detached pass that drains readers, disposes the pre-fence identity, and
 * boots the replacement. The tracker hooks exported here
 * (`trackRebuildStarted`/`trackRebuildCompleted`/`recordRebuildFailure`) are
 * shared by that coordinator so `awaitRebuilds` quiescence covers both paths.
 */

import { Cause, Deferred, Effect, Option } from "effect"
import { InstanceStore } from "@/project/instance-store"
import type { InstanceContext } from "@/project/instance-context"
import type { GenerationGate } from "./generation-gate"
import { ControlLease } from "./control-lease"
import { emitGlobalDisposed } from "@/server/global-lifecycle"

/** Exported for the ConfigConvergence coordinator passes. */
export const logRebuildFailure = Effect.fnUntraced(function* (message: string, cause: unknown) {
  yield* Effect.logError(message).pipe(Effect.annotateLogs({ cause }))
})

// kilocode_change start - shared tracker hooks used by both forkRebuild and the
// ConfigConvergence coordinator (commit registers a rebuild, the pass completion
// removes it). Exported for the coordinator module.
export const trackRebuildStarted = Effect.fnUntraced(function* () {
  yield* Effect.sync(() => rebuildStarted())
})

export const trackRebuildCompleted = Effect.fnUntraced(function* () {
  yield* Effect.sync(() => rebuildCompleted())
})
// kilocode_change end

// kilocode_change start - rebuild completion tracking for test isolation
/**
 * Global rebuild completion tracker. Each rebuild increments the counter on
 * start and decrements on completion. When the counter reaches zero, any
 * pending drain Deferred is resolved so tests can await quiescence.
 *
 * Production behavior is unchanged: the counter is internal and the drain
 * signal is only consumed by `awaitRebuilds` (a test-only helper).
 *
 * Race-free quiescence fence (Blocker C): `awaitRebuilds` atomically checks
 * the counter and creates the drain signal inside a single `Effect.sync`,
 * ensuring no rebuild can register between the zero-check and signal setup.
 * Completion removal is guaranteed by `Effect.ensuring` inside `forkRebuild`.
 *
 * BLOCKER 4: rebuildFailure tracks the last rebuild error for observability.
 * awaitRebuilds propagates the failure after all pending rebuilds complete.
 */
let pendingRebuilds = 0
let drainSignal: Deferred.Deferred<void> | undefined
let rebuildFailures: Array<{ message: string; cause: unknown }> = []

/**
 * LOCK-004 registration probe for deterministic ordering tests. Records every
 * synchronous `rebuildStarted()` call from `forkRebuild` into a test-owned
 * array. Because registration happens synchronously in the handler fiber
 * before the deferred final event runs, a test that observes a GlobalBus
 * ConfigUpdated publish can assert the rebuild registration entry already
 * exists — a deterministic happens-before proof with no network timing.
 */
type RebuildProbeEntry = { kind: "rebuild-registered" | "config-updated" }
let rebuildProbe: RebuildProbeEntry[] | undefined
export const probeRebuildRegistration = {
  install: () => {
    rebuildProbe = []
  },
  entries: () => rebuildProbe ?? [],
  uninstall: () => {
    rebuildProbe = undefined
  },
}

function rebuildStarted() {
  pendingRebuilds++
  rebuildProbe?.push({ kind: "rebuild-registered" })
}

function rebuildCompleted() {
  pendingRebuilds--
  if (pendingRebuilds === 0 && drainSignal) {
    const signal = drainSignal
    drainSignal = undefined
    Deferred.doneUnsafe(signal, Effect.succeed(void 0))
  }
}

/**
 * Record a rebuild failure for observability. Called by rebuildInstance/
 * rebuildGlobal and the ConfigConvergence coordinator passes. Exported so the
 * convergence passes record failures for awaitRebuilds observability.
 */
export function recordRebuildFailure(message: string, cause: unknown) {
  rebuildFailures.push({ message, cause })
}

/**
 * Await completion of all pending rebuilds. Used in test afterEach hooks
 * to ensure no detached rebuild fibers leak events into subsequent tests.
 *
 * BLOCKER 4: if any rebuild failed, the failure is re-thrown after all
 * pending rebuilds complete, so test teardown observes the error.
 *
 * Race-free: the counter check and drain signal creation happen atomically
 * inside a single `Effect.sync`, so no rebuild can register between the
 * zero-check and signal setup. The bounded timeout is a failure guard only
 * — progression comes from the rebuild completion signal.
 */
export const awaitRebuilds = Effect.fn("ConfigRebuild.awaitRebuilds")(function* () {
  while (true) {
    const setup = yield* Effect.sync(() => {
      if (pendingRebuilds === 0) {
        const failures = rebuildFailures
        rebuildFailures = []
        return { wait: false, signal: undefined as Deferred.Deferred<void> | undefined, failures }
      }
      const signal = drainSignal ?? Deferred.makeUnsafe<void>()
      drainSignal = signal
      return { wait: true, signal, failures: [] }
    })
    if (setup.wait) {
      yield* Deferred.await(setup.signal!).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.die(new Error(`rebuild drain timed out with ${pendingRebuilds} pending`)),
        }),
      )
      continue
    }
    if (setup.failures.length > 0) {
      yield* Effect.die(
        new Error(
          setup.failures.map((failure) => failure.message).join("; "),
          { cause: setup.failures.length === 1 ? setup.failures[0]!.cause : setup.failures.map((failure) => failure.cause) },
        ),
      )
    }
    return
  }
})
// kilocode_change end

// kilocode_change start - forkRebuild helper for Blocker B
/**
 * Fork a rebuild effect with guaranteed completion tracking.
 *
 * Synchronously registers the rebuild BEFORE forking, so teardown cannot
 * call `awaitRebuilds()` before the rebuild is registered. Completion
 * removal is in the outer `Effect.ensuring` for every success/failure/
 * interruption path. The rebuild runs uninterruptibly to guarantee ticket
 * release.
 *
 * Used by the explicit-dispose path via `withWriteTicket` (the global dispose
 * handler). Cold saves register rebuilds through the ConfigConvergence
 * coordinator using the shared tracker instead.
 */
export function forkRebuild<R>(effect: Effect.Effect<void, never, R>): Effect.Effect<void, never, R> {
  return Effect.uninterruptibleMask(() =>
    Effect.gen(function* () {
      // Registration and detach are one masked handoff. A caller cannot
      // observe zero between these operations, even when it is interrupted.
      yield* Effect.sync(() => rebuildStarted())
      yield* effect.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (!Cause.hasInterruptsOnly(cause)) {
              recordRebuildFailure("config rebuild failed", cause)
              yield* logRebuildFailure("config rebuild failed", cause)
            }
          }),
        ),
        Effect.ensuring(Effect.sync(() => rebuildCompleted())),
        Effect.forkDetach,
      )
    }),
  ).pipe(Effect.asVoid)
}
// kilocode_change end

/**
 * Drain the project ticket's directory, dispose the exact captured old
 * instance, boot the replacement, then release the barrier. Never interrupted
 * by a client disconnect; the barrier is always released even when
 * disposal/reboot fails.
 *
 * LOCK-003: the exact pre-barrier instance identity is captured by the handler
 * BEFORE persistence visibility, then passed in. If explicit reload/dispose
 * replaced the runtime between capture and rebuild, `store.dispose(old)` is a
 * safe no-op (identity check in InstanceStore) and the replacement survives.
 */
export const rebuildInstance = Effect.fn("ConfigRebuild.rebuildInstance")(function* (
  ticket: GenerationGate.ProjectWriteTicket,
  old: Option.Option<InstanceContext>, // kilocode_change - pre-captured identity from handler
) {
  const store = yield* InstanceStore.Service
  const leases = Option.getOrElse(yield* Effect.serviceOption(ControlLease.Service), () => ControlLease.noop)
  yield* Effect.uninterruptible(
    Effect.gen(function* () {
      yield* Deferred.await(ticket.drained)
      // kilocode_change - BLOCKER 4: catch and log disposal/boot failures,
      // record them for awaitRebuilds observability. catchCause preserves the
      // Effect<void, never, R> type required by forkRebuild. The rebuild fiber
      // always completes successfully; ticket.release runs via ensuring.
      if (old._tag === "Some") {
        // LOCK-002/003: close control admission for the exact
        // old identity and await outstanding control leases before disposal, so
        // a snapshot-served control can never race the disposer.
        yield* leases.sealAndDrain(old.value)
        yield* store.dispose(old.value).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* logRebuildFailure("config rebuild disposal failed", cause)
              recordRebuildFailure("config rebuild disposal failed", cause)
            }),
          ),
        )
      }
      yield* store.load({ directory: ticket.directory }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* logRebuildFailure("config rebuild instance boot failed", cause)
            recordRebuildFailure("config rebuild instance boot failed", cause)
          }),
        ),
      )
    }).pipe(Effect.ensuring(ticket.release)),
  )
})

/**
 * Global drain-and-rebuild: use the pre-captured directory/identity pairs from
 * the handler (captured AFTER ticket acquisition but BEFORE persistence, so no
 * post-patch generation exists), dispose each old instance after its readers
 * drain (independently — idle directories are not delayed by busy ones), boot
 * replacements, emit the `global.disposed` signal once (catching publication
 * failures), then release the barrier.
 */
export const rebuildGlobal = Effect.fn("ConfigRebuild.rebuildGlobal")(function* (
  ticket: GenerationGate.GlobalWriteTicket,
  olds: Array<{ directory: string; old: Option.Option<InstanceContext> }>, // kilocode_change - pre-captured identities
) {
  const store = yield* InstanceStore.Service
  const leases = Option.getOrElse(yield* Effect.serviceOption(ControlLease.Service), () => ControlLease.noop)
  yield* Effect.uninterruptible(
    Effect.gen(function* () {
      // kilocode_change - BLOCKER 4: per-directory disposal/boot errors are
      // caught, logged, and recorded; one directory's failure does not prevent
      // others from completing. catchCause preserves the never error type.
      yield* Effect.forEach(
        olds,
        Effect.fnUntraced(function* ({ directory, old }) {
          if (old._tag === "None") return
          yield* Deferred.await(ticket.drainFor(directory))
          // LOCK-002/003: close control admission for the
          // exact old identity and await outstanding control leases before
          // disposal, so a snapshot-served control can never race the disposer.
          yield* leases.sealAndDrain(old.value)
          yield* store.dispose(old.value).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* logRebuildFailure("global rebuild disposal failed", cause)
                recordRebuildFailure("global rebuild disposal failed", cause)
              }),
            ),
          )
          yield* store.load({ directory }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* logRebuildFailure("global rebuild instance boot failed", cause)
                recordRebuildFailure("global rebuild instance boot failed", cause)
              }),
            ),
          )
        }),
        { concurrency: "unbounded", discard: true },
      )
      // kilocode_change - catch publication failures while always releasing the ticket
      yield* emitGlobalDisposed.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* logRebuildFailure("global disposed event publication failed", cause)
            recordRebuildFailure("global disposed event publication failed", cause)
          }),
        ),
      )
    }).pipe(Effect.ensuring(ticket.release)),
  )
})

export * as ConfigRebuild from "./config-rebuild"
