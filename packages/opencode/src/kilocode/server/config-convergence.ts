// kilocode_change - new file
/**
 * Cold-config mutation/convergence coordinator (LOCK-001..007).
 *
 * Canonical specification: `packages/kilo-docs/pages/contributing/architecture/cli-runtime.md`
 * "Config update lifecycle" (#config-update-lifecycle). This module implements
 * the coordinator contract; the architecture doc owns the model, so lifecycle
 * wording changes belong there, not in this header.
 *
 * Replaces the coupling where a cold save transferred a GenerationGate writer
 * ticket to a rebuild that held it until the generation drain completed, which
 * queued every later save behind the stream. The coordinator decouples
 * persistence acknowledgement from runtime drain:
 *
 * 1. `begin(scope)` raises a GenerationGate convergence fence BEFORE the cold
 *    mutation persists (LOCK-002): no new generation can bind to the
 *    pre-mutation runtime from that moment, regardless of the save outcome.
 *    Fences block new READERS only — hot and joining config writes never wait
 *    on a cold convergence fence (LOCK-006).
 * 2. The caller persists under the canonical discovery flocks and returns the
 *    authoritative response. `commit(obligation)` records the mutation (a
 *    monotonic seq) and synchronously registers the required rebuild via the
 *    ConfigRebuild tracker, so a ConfigUpdated event can never be observed
 *    before a convergence pass owns the fence (LOCK-003).
 * 3. A detached pass runner (serialized through a mutex) drains the affected
 *    directories' readers, seals control leases, disposes the exact captured
 *    pre-fence identities, boots replacements from the latest disk state, and
 *    releases the fence refs. The response already returned — saves never wait
 *    for an active generation or an earlier rebuild to drain (LOCK-001).
 * 4. Cold mutations arriving during one pending convergence cycle are
 *    coalesced: the pass captures every obligation committed before its turn,
 *    so one drain→dispose→boot covers the burst. A mutation racing drain/
 *    dispose/boot stays pending (its seq exceeds the covered boot seq) and
 *    forces another pass before the fence releases (LOCK-004).
 * 5. Global vs project scope (LOCK-005): project cold changes fence/rebuild
 *    only their directory; global cold changes cover all loaded directories.
 *    The worker prioritizes global obligations, and a project obligation whose
 *    directory was already booted at a committed seq >= its own is skipped —
 *    a cycle strengthens to global, never weakens.
 * 6. Failure cleanup (LOCK-007): `abort` releases the fence ref and registers
 *    no rebuild; a failed save never leaves the admission fence up, while
 *    concurrent pending obligations keep their fence refs so the fence is not
 *    opened prematurely.
 */

import { Context, Deferred, Effect, Fiber, FiberSet, Layer, Option, Queue } from "effect"
import { GenerationGate } from "./generation-gate"
import { InstanceStore } from "@/project/instance-store"
import { ControlLease } from "./control-lease"
import { trackRebuildCompleted, trackRebuildStarted, logRebuildFailure, recordRebuildFailure } from "./config-rebuild"
import { emitGlobalDisposed } from "@/server/global-lifecycle"
import type { InstanceContext } from "@/project/instance-context"

export type ColdScope = "global" | { readonly directory: string }

/** A raised convergence fence ref plus the run outcome, owned by one save. */
export type ColdObligation = {
  readonly scope: ColdScope
  readonly fence: GenerationGate.ProjectFenceTicket | GenerationGate.GlobalFenceTicket
  seq: number
  resolved: boolean
  /**
   * Pre-fence instance identities captured synchronously at begin time (before
   * the save persists), so the convergence pass disposes exactly the pre-save
   * runtime. `InstanceStore.dispose` is identity-safe, so an explicit
   * reload/dispose that replaced an identity between begin and drain survives.
   */
  olds: Array<{ directory: string; old: Option.Option<InstanceContext> }>
}

type ScopeState = {
  pending: ColdObligation[]
}

/** An abort-deferred fence being retried by a release-only pass (LOCK-005/007). */
type ReleaseFence = {
  readonly scope: ColdScope
  readonly fence: GenerationGate.ProjectFenceTicket | GenerationGate.GlobalFenceTicket
}

type State = {
  committed: number
  global?: ScopeState
  dirs: Map<string, ScopeState>
  /** LOCK-007: true once shutdown begins — begin returns noop obligations and commit/abort fork no workers. */
  shuttingDown: boolean
  /** Committed obligations whose fence is still held and whose tracker start is not yet settled. */
  held: Set<ColdObligation>
  /** Abort-deferred fences with an active release pass (tracker started, not settled). */
  deferred: Set<ReleaseFence>
}

export interface ConfigConvergence {
  /**
   * Raise the admission fence for `scope` and return an obligation. Never
   * blocks. The fence blocks new reader admission for the affected directories
   * until every obligation for the scope is committed-and-converged or aborted.
   */
  readonly begin: (scope: ColdScope) => Effect.Effect<ColdObligation>
  /**
   * Record a successful cold mutation. Assigns a monotonic seq, synchronously
   * registers the required rebuild (LOCK-003), and forks a serialized
   * convergence pass runner.
   */
  readonly commit: (obligation: ColdObligation) => Effect.Effect<void>
  /**
   * Drop a cold mutation that never committed (persist failure, no-op, or
   * interruption). Releases the fence ref and registers no rebuild.
   */
  readonly abort: (obligation: ColdObligation) => Effect.Effect<void>
  /**
   * Coordinator shutdown (LOCK-007): rejects new work, interrupts and joins
   * every owned convergence/release worker, releases fences the coordinator
   * still holds WITHOUT rebooting instances, and settles the rebuild tracker.
   * Runs on layer finalization before dependent services dispose.
   */
  readonly shutdown: Effect.Effect<void>
}

export class Service extends Context.Service<Service, ConfigConvergence>()("@kilocode/ConfigConvergence") {}

const noopObligation = (scope: ColdScope): ColdObligation => ({
  scope,
  fence: {
    kind: "global-fence",
    drainFor: () => {
      const drained = Deferred.makeUnsafe<void>()
      Deferred.doneUnsafe(drained, Effect.succeed(void 0))
      return drained
    },
    release: Effect.succeed(true),
  },
  seq: 0,
  resolved: true,
  olds: [],
})

export const noop: ConfigConvergence = {
  begin: (scope) => Effect.succeed(noopObligation(scope)),
  commit: () => Effect.void,
  abort: () => Effect.void,
  shutdown: Effect.void,
}

export const layer = Layer.effect(
  Service,
  Effect.acquireRelease(
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      // LOCK-007: coordinator-owned worker registry. Fibers forked into the set
      // are interrupted when the layer scope closes (AppRuntime/runtime
      // finalization) and are never tied to a caller's request scope. The set
      // lives in the layer scope, so no convergence fiber outlives shutdown.
      const workers = yield* FiberSet.make<void, never>()
      const state: State = {
        committed: 0,
        dirs: new Map(),
        shuttingDown: false,
        held: new Set(),
        deferred: new Set(),
      }
      const booted = new Map<string, number>()
      const mutex = yield* Queue.unbounded<void>()
      yield* Queue.offer(mutex, void 0)

      const pushPending = (scope: ColdScope, obligation: ColdObligation) =>
        Effect.sync(() => {
          if (scope === "global") {
            const current = state.global
            if (current) current.pending = [...current.pending, obligation]
            else state.global = { pending: [obligation] }
          } else {
            const current = state.dirs.get(scope.directory)
            if (current) current.pending = [...current.pending, obligation]
            else state.dirs.set(scope.directory, { pending: [obligation] })
          }
        })

      const begin = Effect.fn("ConfigConvergence.begin")(function* (scope: ColdScope) {
        // LOCK-007: once shutdown begins no new fence is raised — the caller
        // gets a noop obligation whose commit/abort are no-ops, so no new work
        // can start against a runtime that is being disposed.
        // LOCK-007 (audit race 1): fence acquisition + snapshot capture is one
        // UNINTERRUPTIBLE region. The gate raise is synchronous, and every
        // snapshot await resolves (InstanceStore boot deferreds always complete),
        // so begin always returns the obligation and `withColdMutation`'s
        // ensuring-abort always owns the fence. With the caller's `restore`
        // region this was previously interruptible BETWEEN the fence raise and
        // the snapshot awaits, leaking the fence when the save fiber was
        // interrupted during a blocked snapshot/load.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (yield* Effect.sync(() => state.shuttingDown)) return noopObligation(scope)
            const ticket = yield* scope === "global" ? gate.beginFenceGlobal() : gate.beginFence(scope.directory)
            const store = Option.getOrElse(yield* Effect.serviceOption(InstanceStore.Service), () => undefined)
            // LOCK-003: capture the pre-fence identities synchronously (before the
            // save persists) so the pass disposes exactly the pre-save runtime and
            // an explicit reload that replaces an identity later survives.
            // LOCK-005: the snapshot awaits IN-FLIGHT boots of already-cached
            // directories, so a load that started before the fence is captured
            // here even when its boot completes after the fence raised.
            const olds: Array<{ directory: string; old: Option.Option<InstanceContext> }> = store
              ? scope === "global"
                ? yield* Effect.forEach(yield* store.directories(), (directory) =>
                    store!.snapshot(directory).pipe(Effect.map((old) => ({ directory, old }))),
                  )
                : yield* store
                    .snapshot(scope.directory)
                    .pipe(Effect.map((old) => [{ directory: scope.directory, old }]))
              : []
            return { scope, fence: ticket, seq: 0, resolved: false, olds }
          }),
        )
      })

      const abort = Effect.fn("ConfigConvergence.abort")(function* (obligation: ColdObligation) {
        const removed = yield* Effect.sync(() => {
          if (obligation.resolved) return false
          obligation.resolved = true
          return true
        })
        if (!removed) return
        const released = yield* obligation.fence.release
        if (!released) {
          // LOCK-005/007: this was the LAST fence ref and write-intent loads
          // registered against the fence are still unconverged — the fence must
          // not drop with a pre-convergence runtime cached. Converge them and
          // retry the release on a serialized release pass (the abort itself owns
          // no pending obligation). The release pass is TRACKED (LOCK-007): it
          // registers a rebuild start so `awaitRebuilds` quiescence includes it.
          // During shutdown no worker is forked — shutdown retries the release
          // and settles the tracker itself.
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              if (yield* Effect.sync(() => state.shuttingDown)) {
                yield* obligation.fence.release
                return
              }
              const token: ReleaseFence = { scope: obligation.scope, fence: obligation.fence }
              yield* trackRebuildStarted()
              yield* Effect.sync(() => state.deferred.add(token))
              yield* FiberSet.run(workers, runReleasePass(token))
            }),
          )
        }
      })

      const commit = Effect.fn("ConfigConvergence.commit")(function* (obligation: ColdObligation) {
        // LOCK-007: one UNINTERRUPTIBLE region — the shutdown flag check, seq
        // assignment, rebuild registration and worker fork cannot interleave with
        // shutdown. Either the worker is registered before shutdown's flag (and
        // shutdown interrupts it), or shutdown already began and the fence is
        // released directly with no tracking and no worker.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (yield* Effect.sync(() => state.shuttingDown)) {
              yield* obligation.fence.release
              return
            }
            const seq = yield* Effect.sync(() => {
              if (obligation.resolved) return 0
              obligation.resolved = true
              obligation.seq = ++state.committed
              return obligation.seq
            })
            if (seq === 0) return
            yield* pushPending(obligation.scope, obligation)
            // LOCK-003: synchronous rebuild registration before any ConfigUpdated
            // event can be observed; the fence ref stays held by the pass.
            yield* trackRebuildStarted()
            yield* Effect.sync(() => state.held.add(obligation))
            yield* FiberSet.run(workers, runSerialized(obligation.scope))
          }),
        )
      })

      /** Settle one committed obligation: drop the held entry and its tracker start. Idempotent. */
      const settleHeld = (obligation: ColdObligation) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const owned = yield* Effect.sync(() => state.held.delete(obligation))
            if (owned) yield* trackRebuildCompleted()
          }),
        )

      /** Settle one release-pass token: drop the deferred entry and its tracker start. Idempotent. */
      const settleDeferred = (token: ReleaseFence) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const owned = yield* Effect.sync(() => state.deferred.delete(token))
            if (owned) yield* trackRebuildCompleted()
          }),
        )

      const releaseObligations = (items: ColdObligation[]) =>
        Effect.forEach(items, (obligation) =>
          Effect.gen(function* () {
            // LOCK-005: the ticket release is DEFERRED (resolves false) when this
            // is the last fence ref and write-intent loads registered against the
            // fence are still unconverged. Converge them, then retry — the fence
            // can never drop with a pre-global runtime cached. After shutdown the
            // pass stops retrying and leaves the ref to shutdown's cleanup (which
            // never reboots).
            while (true) {
              const released = yield* obligation.fence.release
              if (released) break
              if (yield* Effect.sync(() => state.shuttingDown)) return
              yield* convergeFenceLoads(obligation.scope)
            }
            yield* settleHeld(obligation)
          }),
        )

      /**
       * Converge every write-intent load registered against the fence for
       * `scope` (LOCK-005): claim confirmed directories, dispose their cached
       * pre-convergence runtime and boot from the current disk state, waiting
       * (event-driven) while loads are still in flight, until the registry is
       * empty. Runs before the fence refs are released, so no new reader can
       * bind to a pre-global runtime.
       */
      const convergeFenceLoads = Effect.fnUntraced(function* (scope: ColdScope) {
        const store = Option.getOrElse(yield* Effect.serviceOption(InstanceStore.Service), () => undefined)
        const leases = Option.getOrElse(yield* Effect.serviceOption(ControlLease.Service), () => ControlLease.noop)
        while (true) {
          if (scope === "global") {
            const claimed = yield* gate.claimFenceLoads()
            if (claimed.confirmed.length > 0) {
              yield* Effect.forEach(
                claimed.confirmed,
                (directory) =>
                  Effect.gen(function* () {
                    const drained = yield* gate.fenceDrainFor(directory)
                    yield* convergeLoadedOne(store, leases, directory, drained)
                  }),
                { concurrency: "unbounded", discard: true },
              )
              continue
            }
            // The claim atomically installed the change signal when loads are
            // still in flight; awaiting it can never lose a confirm.
            if (claimed.wait) {
              yield* Deferred.await(claimed.wait)
              continue
            }
            return
          }
          const claimed = yield* gate.claimProjectFenceLoad(scope.directory)
          if (claimed.confirmed) {
            const drained = yield* gate.fenceDrainFor(scope.directory)
            yield* convergeLoadedOne(store, leases, scope.directory, drained)
            continue
          }
          if (claimed.wait) {
            yield* Deferred.await(claimed.wait)
            continue
          }
          return
        }
      })

      /**
       * Disposal + reboot for a directory whose runtime was cached by a
       * write-intent load DURING the fence (LOCK-005). Unlike the olds
       * convergence the identity is not pre-captured: the CURRENT cache entry is
       * the pre-convergence runtime, so it is snapshotted inside the
       * uninterruptible region right before disposal (identity-safe), then booted
       * from the latest disk state.
       */
      const convergeLoadedOne = Effect.fnUntraced(function* (
        store: InstanceStore.Interface | undefined,
        leases: ControlLease,
        directory: string,
        drained: Deferred.Deferred<void>,
      ) {
        // LOCK-007: the drain await is OUTSIDE the protected region so shutdown
        // can interrupt a pass parked on a held reader; the dispose/boot steps
        // stay protected and skip entirely once shutdown begins, so nothing
        // boots or disposes after shutdown.
        yield* Deferred.await(drained)
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (yield* Effect.sync(() => state.shuttingDown)) return
            if (store) {
              const old = yield* store.snapshot(directory)
              if (old._tag === "Some") {
                yield* leases.sealAndDrain(old.value)
                yield* store.dispose(old.value).pipe(
                  Effect.catchCause((cause) =>
                    Effect.gen(function* () {
                      yield* logRebuildFailure("convergence fence-load disposal failed", cause)
                      recordRebuildFailure("convergence fence-load disposal failed", cause)
                    }),
                  ),
                )
              }
              yield* store.load({ directory }).pipe(
                // LOCK-005: see convergeOne — never re-register the pass's own reboot.
                Effect.provideService(GenerationGate.ConvergenceLoad, true),
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    yield* logRebuildFailure("convergence fence-load boot failed", cause)
                    recordRebuildFailure("convergence fence-load boot failed", cause)
                  }),
                ),
              )
            }
          }),
        )
      })

      const convergeOne = Effect.fnUntraced(function* (
        directory: string,
        old: Option.Option<InstanceContext>,
        drained: Deferred.Deferred<void>,
      ) {
        const store = Option.getOrElse(yield* Effect.serviceOption(InstanceStore.Service), () => undefined)
        const leases = Option.getOrElse(yield* Effect.serviceOption(ControlLease.Service), () => ControlLease.noop)
        yield* Deferred.await(drained)
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (yield* Effect.sync(() => state.shuttingDown)) return
            if (store && old._tag === "Some") {
              yield* leases.sealAndDrain(old.value)
              yield* store.dispose(old.value).pipe(
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    yield* logRebuildFailure("convergence instance disposal failed", cause)
                    recordRebuildFailure("convergence instance disposal failed", cause)
                  }),
                ),
              )
            }
            const before = yield* Effect.sync(() => state.committed)
            if (store) {
              // LOCK-005: the pass's own reboot must not re-register the
              // directory with the still-active fence (would loop the release).
              yield* store.load({ directory }).pipe(
                Effect.provideService(GenerationGate.ConvergenceLoad, true),
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    yield* logRebuildFailure("convergence instance boot failed", cause)
                    recordRebuildFailure("convergence instance boot failed", cause)
                  }),
                ),
              )
            }
            yield* Effect.sync(() => {
              const prev = booted.get(directory) ?? 0
              booted.set(directory, Math.max(prev, before))
            })
          }),
        )
      })

      const takePending = (scope: ColdScope): Effect.Effect<ColdObligation[]> =>
        Effect.sync(() => {
          if (scope === "global") {
            const current = state.global
            if (!current) return []
            const items = current.pending
            state.global = { pending: [] }
            return items
          }
          const current = state.dirs.get(scope.directory)
          if (!current) return []
          const items = current.pending
          state.dirs.set(scope.directory, { pending: [] })
          return items
        })

      const runGlobalPass = Effect.fn("ConfigConvergence.runGlobalPass")(function* (captured: ColdObligation[]) {
        const first = captured[0]!
        const fence = first.fence as GenerationGate.GlobalFenceTicket
        const maxSeq = Math.max(...captured.map((item) => item.seq))
        // LOCK-004: the LATEST captured pre-fence identity per directory wins.
        // An explicit reload between begins replaces the cached runtime, so
        // disposing the first-captured old would be an identity-safe no-op while
        // `store.load` keeps serving the newer pre-mutation identity — the stale
        // runtime would never be converged. Iterate in seq order and overwrite,
        // so the newest captured identity (the one actually cached) is the one
        // disposed and rebooted.
        const olds = new Map<string, Option.Option<InstanceContext>>()
        for (const obligation of [...captured].sort((a, b) => a.seq - b.seq)) {
          for (const { directory, old } of obligation.olds) {
            olds.set(directory, old)
          }
        }
        const dirs = [...olds.keys()]
        // LOCK-004 skip: every loaded directory already booted at a committed
        // seq >= the newest captured obligation — an earlier pass converged this
        // burst (or no runtime exists anywhere). The global disposed signal still
        // fires: the mutation is a global lifecycle change regardless of whether
        // any instance was loaded to dispose (LOCK-007 event parity).
        const covered = yield* Effect.sync(() => dirs.every((directory) => (booted.get(directory) ?? 0) >= maxSeq))
        if (!covered) {
          yield* Effect.forEach(olds, ([directory, old]) => convergeOne(directory, old, fence.drainFor(directory)), {
            concurrency: "unbounded",
            discard: true,
          })
        }
        yield* emitGlobalDisposed.pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* logRebuildFailure("global convergence disposed event failed", cause)
              recordRebuildFailure("global convergence disposed event failed", cause)
            }),
          ),
        )
      })

      const runProjectPass = Effect.fn("ConfigConvergence.runProjectPass")(function* (
        directory: string,
        captured: ColdObligation[],
      ) {
        // LOCK-004: the latest committed obligation controls the converged
        // identity/version. All project obligations share the same physical
        // per-directory fence (ref-counted), so any ticket exposes the shared
        // drain; the olds must come from the NEWEST obligation because a reload
        // between begins replaced the cached runtime.
        const latest = captured.reduce((best, item) => (item.seq > best.seq ? item : best), captured[0]!)
        const fence = latest.fence as GenerationGate.ProjectFenceTicket
        const maxSeq = latest.seq
        // LOCK-004/005 skip: this directory was already booted at a committed
        // seq >= the newest captured obligation (e.g. a global pass covered it).
        const covered = yield* Effect.sync(() => (booted.get(directory) ?? 0) >= maxSeq)
        if (covered) return
        const old = latest.olds.find((item) => item.directory === directory)?.old ?? Option.none<InstanceContext>()
        if (old._tag === "None") return
        yield* convergeOne(directory, old, fence.drained)
      })

      /** Serialized pass runner: one convergence pass at a time across scopes. */
      const runSerialized = (scope: ColdScope): Effect.Effect<void> =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* restore(Queue.take(mutex))
            // LOCK-007: the pass body is restored (interruptible at its awaits)
            // so shutdown can preempt a worker; the mutex is always re-offered
            // and in-flight dispose/boot regions complete before the interrupt
            // lands.
            return yield* restore(
              Effect.gen(function* () {
                const captured = yield* takePending(scope)
                if (captured.length === 0) return
                if (scope === "global") yield* runGlobalPass(captured)
                else yield* runProjectPass(scope.directory, captured)
                yield* releaseObligations(captured)
              }).pipe(Effect.ensuring(Queue.offer(mutex, void 0))),
            )
          }),
        )

      /**
       * Serialized release-only pass for an ABORTED obligation whose last fence
       * ref was deferred (LOCK-005/007): converge the registered write-loads and
       * retry the release until the fence drops. Serialized through the same
       * mutex so it never interleaves with a convergence pass. Tracked like any
       * other rebuild (LOCK-007): the start is registered by `abort` before the
       * fork and the completion settles the tracker in the ensuring.
       */
      const runReleasePass = (token: ReleaseFence): Effect.Effect<void> =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* restore(Queue.take(mutex))
            return yield* restore(
              Effect.gen(function* () {
                while (true) {
                  yield* convergeFenceLoads(token.scope)
                  const released = yield* token.fence.release
                  if (released) return
                  if (yield* Effect.sync(() => state.shuttingDown)) return
                }
              }).pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    yield* settleDeferred(token)
                    yield* Queue.offer(mutex, void 0)
                  }),
                ),
              ),
            )
          }),
        )

      /**
       * Coordinator shutdown (LOCK-007): reject new work, interrupt and join
       * every owned worker, release fences the coordinator still holds WITHOUT
       * rebooting instances, and settle the rebuild tracker. Idempotent — safe to
       * call explicitly and again from layer finalization. Runs before dependent
       * services (InstanceStore, gate, leases) dispose.
       */
      const shutdown: Effect.Effect<void> = Effect.fn("ConfigConvergence.shutdown")(function* () {
        // 1. Reject new work first — begin/commit/abort check this flag.
        yield* Effect.sync(() => {
          state.shuttingDown = true
        })
        // 2. Interrupt + join every owned worker. `Fiber.interrupt` awaits the
        //    fiber's exit; passes are interruptible at their awaits (reader
        //    drain, fence-load signal, mutex), and an in-flight dispose/boot
        //    region completes first (bounded) before the interrupt lands.
        yield* Effect.forEach(yield* Effect.sync(() => [...workers]), (fiber) => Fiber.interrupt(fiber), {
          concurrency: "unbounded",
          discard: true,
        })
        // 3. Snapshot every fence the coordinator still owns: committed
        //    obligations (pending or in a preempted pass) and abort-deferred
        //    release refs. All workers are joined, so the sets are stable.
        const owed = yield* Effect.sync(() => ({
          held: [...state.held],
          deferred: [...state.deferred],
        }))
        // 4. Release those fences without converging/rebooting — the runtime is
        //    ending, so the gate just drops refs (a deferred release leaves gate
        //    state that dies with the gate).
        yield* Effect.forEach([...owed.held, ...owed.deferred], (item) => item.fence.release.pipe(Effect.asVoid), {
          concurrency: "unbounded",
          discard: true,
        })
        // 5. Settle the rebuild tracker: every coordinator-owned start gets
        //    exactly one completion (idempotent — completed passes already
        //    removed their entries and settled).
        yield* Effect.forEach(owed.held, () => trackRebuildCompleted(), { concurrency: "unbounded", discard: true })
        yield* Effect.forEach(owed.deferred, () => trackRebuildCompleted(), { concurrency: "unbounded", discard: true })
        yield* Effect.sync(() => {
          state.held.clear()
          state.deferred.clear()
          if (state.global) state.global.pending = []
          for (const dir of state.dirs.values()) dir.pending = []
        })
      })()

      return Service.of({ begin, commit, abort, shutdown })
    }),
    (svc) => svc.shutdown,
  ),
)

export const defaultLayer = layer

/** Run outcome a cold mutation path returns to `withColdMutation`. */
export type ColdMutationResult<A> = {
  readonly changed: boolean
  readonly value: A
  readonly event?: Effect.Effect<void>
}

/**
 * Canonical cold-save wrapper (LOCK-001/002/003/007). Raises the admission
 * fence for `scope`, runs the persist/response effect, then either commits
 * (registering the convergence rebuild) or aborts (releasing the fence and
 * registering nothing). The response value returns before any drain — later
 * saves never wait behind the fence, and a ConfigUpdated event is emitted only
 * after the rebuild registration owns the fence.
 *
 * LOCK-007 (audit race 1): begin raises the fence before snapshotting, so an
 * interruption between the fence raise and the obligation assignment would leak
 * the fence. The obligation is therefore published to the cleanup holder inside
 * ONE uninterruptible region (begin + assignment); a pending interruption is
 * delivered only at the next interruptible step AFTER that region, by which
 * point the ensuring-abort always sees the obligation and releases the fence.
 */
export const withColdMutation = <A, E, R>(input: {
  readonly scope: ColdScope
  readonly run: () => Effect.Effect<ColdMutationResult<A>, E, R>
}): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const svc = Option.getOrElse(yield* Effect.serviceOption(Service), () => noop)
      let obligation: ColdObligation | undefined
      let committed = false
      return yield* Effect.gen(function* () {
        // begin is one uninterruptible step and the obligation is written to
        // the holder inside that region, so the ensuring below always owns a
        // fence ref to release — even when the save fiber is interrupted
        // during a blocked snapshot/load.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            obligation = yield* svc.begin(input.scope)
          }),
        )
        const created = obligation
        if (!created) return yield* Effect.die(new Error("cold mutation begin returned no obligation"))
        // The persist/response run is RESTORED (interruptible) so an
        // interruption lands cleanly at cooperative points (e.g. a discovery
        // flock wait) — the run's own exit-wrapped rollback/compensation
        // restores partial state, and the ensuring abort releases the fence.
        const exit = yield* restore(Effect.exit(input.run()))
        if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause)
        if (!exit.value.changed) {
          if (exit.value.event) yield* exit.value.event
          return exit.value.value
        }
        yield* svc.commit(created)
        committed = true
        if (exit.value.event) yield* exit.value.event
        return exit.value.value
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            const current = obligation
            if (!current || committed) return Effect.void
            return svc.abort(current)
          }),
        ),
      )
    }),
  )

export * as ConfigConvergence from "./config-convergence"
