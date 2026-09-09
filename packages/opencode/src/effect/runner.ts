import { Cause, Deferred, Effect, Exit, Fiber, Latch, Schema, Scope, SynchronizedRef } from "effect"
import { Identifier } from "@/id/id"

export type Factory<A, E = never> = (generationID: string) => Effect.Effect<A, E>
export interface EpochDescriptor<A, E = never> {
  readonly prelude: (generationID: string) => Effect.Effect<void, E>
  readonly body: (generationID: string) => Effect.Effect<A, E>
}
export type WorkInput<A, E = never> = Effect.Effect<A, E> | Factory<A, E> | EpochDescriptor<A, E>

export type CancelSnapshot = {
  readonly generationID: string | undefined
  readonly wasBusy: boolean
  readonly interruptRequested: boolean
}

export type CancelRequest = {
  readonly snapshot: CancelSnapshot
  readonly wait: Effect.Effect<void>
}

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  readonly generationID: string | undefined
  readonly ensureRunning: (work: WorkInput<A, E>) => Effect.Effect<A, E>
  readonly startShell: (work: Effect.Effect<A, E>, ready?: Latch.Latch) => Effect.Effect<A, E | Busy>
  readonly requestCancel: Effect.Effect<CancelRequest>
  readonly cancel: Effect.Effect<CancelSnapshot>
}

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("RunnerCancelled", {}) {}
export class Busy extends Schema.TaggedErrorClass<Busy>()("RunnerBusy", {}) {}

type Normalized<A, E> = {
  readonly prelude: (gen: string) => Effect.Effect<void, E>
  readonly body: (gen: string) => Effect.Effect<A, E>
}

interface Epoch<A, E> {
  readonly id: number
  readonly gen: string
  readonly done: Deferred.Deferred<A, E | Cancelled>
  readonly entered: Deferred.Deferred<void>
  readonly latch: Latch.Latch
  readonly fiber: Fiber.Fiber<void, E>
}

interface Shell<A, E> {
  readonly id: number
  readonly fiber: Fiber.Fiber<A, E>
  readonly cancelled: Deferred.Deferred<void>
  readonly gate: Latch.Latch
  readonly ready?: Latch.Latch
}

interface Pending<A, E> {
  readonly id: number
  readonly done: Deferred.Deferred<A, E | Cancelled>
  readonly descriptor: Normalized<A, E>
}

export type State<A, E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Starting"; readonly epoch: Epoch<A, E> }
  | { readonly _tag: "Running"; readonly epoch: Epoch<A, E> }
  | { readonly _tag: "Stopping"; readonly epoch: Epoch<A, E> }
  | { readonly _tag: "Shell"; readonly shell: Shell<A, E> }
  | { readonly _tag: "ShellThenRun"; readonly shell: Shell<A, E>; readonly pending: Pending<A, E> }
  | { readonly _tag: "ShellStopping"; readonly shell: Shell<A, E> }
  | { readonly _tag: "ShellStoppingThenRun"; readonly shell: Shell<A, E>; readonly pending: Pending<A, E> }

const toNormalized = <A, E>(input: WorkInput<A, E>): Normalized<A, E> => {
  if (Effect.isEffect(input)) {
    const work = input as Effect.Effect<A, E>
    return { prelude: () => Effect.void, body: () => work }
  }
  if (typeof input === "function") {
    const factory = input as Factory<A, E>
    return { prelude: () => Effect.void, body: factory }
  }
  const descriptor = input as EpochDescriptor<A, E>
  return { prelude: descriptor.prelude, body: descriptor.body }
}

export const make = <A, E = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: Effect.Effect<A, E>
  },
): Runner<A, E> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>({ _tag: "Idle" })
  const idle = opts?.onIdle ?? Effect.void
  const onBusy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  let ids = 0

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => {
    ids += 1
    return ids
  }

  const complete = (done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Deferred.fail(done, new Cancelled()).pipe(Effect.asVoid)
      : Deferred.done(done, exit).pipe(Effect.asVoid)

  // Single-flight interruption outcome: waiters share the epoch done value.
  // The captured onInterrupt is evaluated exactly once in the finalizer path;
  // per-waiter fallback evaluation would duplicate side effects (e.g. one
  // interrupted assistant row per joiner). Cancelled without fallback dies.
  const awaitDone = (done: Deferred.Deferred<A, E | Cancelled>) =>
    Deferred.await(done).pipe(Effect.catchTag("RunnerCancelled", (e) => Effect.die(e)))

  // Evaluate the captured fallback once and complete the shared Deferred with
  // that one Exit. Skips evaluation when the Deferred is already resolved so a
  // losing promotion never produces a second side effect. Runs inside the
  // caller's uninterruptible finalizer/cancel scope.
  const completeWithSharedFallback = (
    done: Deferred.Deferred<A, E | Cancelled>,
  ): Effect.Effect<Exit.Exit<A, E | Cancelled>> =>
    Effect.gen(function* () {
      if (yield* Deferred.isDone(done)) {
        return Exit.failCause(Cause.die(new Cancelled())) as Exit.Exit<A, E | Cancelled>
      }
      if (!onInterrupt) {
        const cancelled = Exit.failCause(Cause.fail(new Cancelled())) as unknown as Exit.Exit<A, E | Cancelled>
        yield* Deferred.done(done, cancelled).pipe(Effect.ignore)
        return cancelled
      }
      const fallback = (yield* Effect.exit(onInterrupt)) as Exit.Exit<A, E | Cancelled>
      yield* Deferred.done(done, fallback).pipe(Effect.ignore)
      return fallback
    })

  const finalizeById = (id: number, done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>): Effect.Effect<void> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        // Already resolved (canceled pending reused as epoch done): never
        // evaluate the fallback a second time and never resurrect state.
        if (yield* Deferred.isDone(done)) return
        const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        if (interrupted && onInterrupt) {
          // Body exit (including the TurnClose wrapper, which is part of body)
          // has completed before this finalizer runs. Mark finishing while the
          // matching epoch is still non-Idle, evaluate the fallback once, then
          // publish onIdle/Idle before the single shared done value so targeted
          // waits (which join done) imply convergence.
          yield* SynchronizedRef.update(ref, (st) => {
            if (st._tag === "Starting" && st.epoch.id === id) return { _tag: "Stopping", epoch: st.epoch } as State<A, E>
            if (st._tag === "Running" && st.epoch.id === id) return { _tag: "Stopping", epoch: st.epoch } as State<A, E>
            return st
          })
          const fallback = (yield* Effect.exit(onInterrupt)) as Exit.Exit<A, E | Cancelled>
          yield* idle
          const target = yield* SynchronizedRef.get(ref)
          const match =
            (target._tag === "Stopping" && target.epoch.id === id) ||
            (target._tag === "Running" && target.epoch.id === id) ||
            (target._tag === "Starting" && target.epoch.id === id)
          if (match) {
            yield* SynchronizedRef.set(ref, { _tag: "Idle" } as State<A, E>)
          }
          yield* Deferred.done(done, fallback).pipe(Effect.ignore)
          return
        }
        yield* SynchronizedRef.update(ref, (st) => {
          if (st._tag === "Starting" && st.epoch.id === id) return { _tag: "Stopping", epoch: st.epoch } as State<A, E>
          if (st._tag === "Running" && st.epoch.id === id) return { _tag: "Stopping", epoch: st.epoch } as State<A, E>
          return st
        })
        yield* idle
        const target = yield* SynchronizedRef.get(ref)
        const match =
          (target._tag === "Stopping" && target.epoch.id === id) ||
          (target._tag === "Running" && target.epoch.id === id) ||
          (target._tag === "Starting" && target.epoch.id === id)
        if (match) {
          yield* SynchronizedRef.set(ref, { _tag: "Idle" } as State<A, E>)
        }
        yield* complete(done, exit).pipe(Effect.ignore)
      }),
    )

  const promoteById = (id: number): Effect.Effect<void> =>
    SynchronizedRef.modifyEffect(ref, (st) => {
      if (st._tag === "Starting" && st.epoch.id === id) {
        return Effect.succeed([onBusy, { _tag: "Running", epoch: st.epoch } as State<A, E>] as const)
      }
      return Effect.succeed([Effect.void, st] as const)
    }).pipe(Effect.flatten)

  // Losing CAS paths interrupt a suspended worker whose latch never opens.
  // The pre-admission latch wait must stay interruptible (restore) so
  // Fiber.interrupt terminates promptly without running prelude/body and
  // without touching done. After a winning install + latch open, the prelude
  // stays uninterruptible; winning Starting cancellation forces exactly one
  // prelude via requestRunInterrupt (open, await entered, then interrupt body).
  const abortSuspended = (fiber: Fiber.Fiber<unknown, unknown>): Effect.Effect<void> =>
    Fiber.interrupt(fiber as Fiber.Fiber<void, E>).pipe(Effect.ignore)

  const worker = (
    id: number,
    gen: string,
    done: Deferred.Deferred<A, E | Cancelled>,
    entered: Deferred.Deferred<void>,
    latch: Latch.Latch,
    descriptor: Normalized<A, E>,
  ): Effect.Effect<void, E> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* restore(latch.await)
        const pre = yield* Effect.exit(Effect.uninterruptible(descriptor.prelude(gen)))
        yield* Deferred.succeed(entered, undefined).pipe(Effect.uninterruptible, Effect.ignore)
        if (pre._tag === "Failure") {
          const exit = Exit.failCause(pre.cause as Cause.Cause<E>) as Exit.Exit<A, E>
          yield* finalizeById(id, done, exit)
          return yield* Effect.failCause(pre.cause)
        }
        yield* promoteById(id)
        return yield* restore(descriptor.body(gen)).pipe(
          Effect.onExit((exit) => finalizeById(id, done, exit)),
          Effect.asVoid,
        )
      }),
    )

  const spawnRun = (
    descriptor: Normalized<A, E>,
    gen: string,
    id: number,
    done: Deferred.Deferred<A, E | Cancelled>,
    entered: Deferred.Deferred<void>,
    latch: Latch.Latch,
  ): Effect.Effect<Epoch<A, E>> =>
    Effect.gen(function* () {
      const fiber = yield* worker(id, gen, done, entered, latch, descriptor).pipe(Effect.forkIn(scope))
      return { id, gen, done, entered, latch, fiber } as Epoch<A, E>
    })

  // Strip a resolved/canceled pending without promoting it. A canceled
  // pending's Deferred is already settled via the shared fallback; installing
  // or opening it as an epoch would resurrect a dead generation and leak the
  // replacement Starting state (its finalizer early-returns on isDone).
  const stripResolvedPending = (shellID: number, pendingID: number) =>
    SynchronizedRef.modify(ref, (st) => {
      if (
        (st._tag === "ShellThenRun" || st._tag === "ShellStoppingThenRun") &&
        st.shell.id === shellID &&
        st.pending.id === pendingID
      ) {
        if (st._tag === "ShellThenRun") return [true as const, { _tag: "Shell", shell: st.shell } as State<A, E>] as const
        return [true as const, { _tag: "ShellStopping", shell: st.shell } as State<A, E>] as const
      }
      return [false as const, st] as const
    })

  // Single conditional CAS promotion keyed by shell id + pending id.
  // Spawns the suspended epoch outside the lock, then atomically swaps
  // ShellThenRun/ShellStoppingThenRun with that exact pending to Starting.
  // Cancellation that removed/failed the pending wins: CAS fails and the
  // spawned epoch is interrupted without resurrection. Factory construction
  // happens before CAS but stays suspended on the epoch latch, so a losing
  // attempt never opens the latch and has no observable side effects; the
  // winning pending keeps one factory invocation. An already-resolved
  // pending.done is rejected defensively before spawn, after spawn, and after
  // a winning CAS before the latch opens; no resolved/canceled pending is
  // ever installed or opened.
  const tryPromoteShellPending = (shellID: number, pending: Pending<A, E>): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (yield* Deferred.isDone(pending.done)) {
        yield* stripResolvedPending(shellID, pending.id)
        return false
      }
      const gen = Identifier.create("gen", "ascending")
      const pid = next()
      const entered = yield* Deferred.make<void>()
      const latch = yield* Latch.make()
      const epoch = yield* spawnRun(pending.descriptor, gen, pid, pending.done, entered, latch)
      if (yield* Deferred.isDone(pending.done)) {
        yield* abortSuspended(epoch.fiber)
        yield* stripResolvedPending(shellID, pending.id)
        return false
      }
      const won = yield* SynchronizedRef.modify(ref, (st) => {
        if (
          (st._tag === "ShellThenRun" || st._tag === "ShellStoppingThenRun") &&
          st.shell.id === shellID &&
          st.pending.id === pending.id
        ) {
          return [true as const, { _tag: "Starting", epoch } as State<A, E>] as const
        }
        return [false as const, st] as const
      })
      if (!won) {
        yield* abortSuspended(epoch.fiber)
        return false
      }
      if (yield* Deferred.isDone(pending.done)) {
        yield* abortSuspended(epoch.fiber)
        yield* SynchronizedRef.modify(ref, (st) => {
          if (st._tag === "Starting" && st.epoch.id === epoch.id) {
            return [true as const, { _tag: "Idle" } as State<A, E>] as const
          }
          return [false as const, st] as const
        })
        return false
      }
      yield* epoch.latch.open.pipe(Effect.uninterruptible, Effect.ignore)
      return true
    })

  const idleSeen = new Set<number>()

  const clearIdleSeen = (id: number) => Effect.sync(() => {
    idleSeen.delete(id)
  })

  // Single bounded owner drain keyed by shell id. Every shell finalizer path
  // funnels here. Each recursion step makes progress via a state-changing CAS
  // or the one-time idle flag, so there is no busy spin. Continuous arrivals
  // are constrained to one pending slot by the state machine.
  // Resolves exactly one of:
  // 1. state no longer belongs to shell id -> stale done
  // 2. ShellThenRun/ShellStoppingThenRun pending -> exact shellID+pendingID
  //    promotion; CAS loss re-evaluates, never returns prematurely
  // 3. Shell/ShellStopping with no pending -> run idle once while non-Idle,
  //    then re-evaluate; conditional Idle CAS failure re-evaluates
  // 4. Starting (promotion committed) or Idle -> done
  const drainShell = (id: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      const cur = yield* SynchronizedRef.get(ref)
      const owned =
        (cur._tag === "Shell" ||
          cur._tag === "ShellThenRun" ||
          cur._tag === "ShellStopping" ||
          cur._tag === "ShellStoppingThenRun") &&
        cur.shell.id === id
      if (!owned) {
        yield* clearIdleSeen(id)
        return
      }
      if (cur._tag === "ShellThenRun" || cur._tag === "ShellStoppingThenRun") {
        const promoted = yield* tryPromoteShellPending(id, cur.pending)
        if (promoted) {
          yield* clearIdleSeen(id)
          return
        }
        return yield* drainShell(id)
      }
      if (cur._tag === "Shell") {
        yield* SynchronizedRef.modify(ref, (st) => {
          if (st._tag === "Shell" && st.shell.id === id) {
            return [true as const, { _tag: "ShellStopping", shell: st.shell } as State<A, E>] as const
          }
          return [false as const, st] as const
        })
        return yield* drainShell(id)
      }
      if (cur._tag === "ShellStopping") {
        if (!idleSeen.has(id)) {
          yield* idle
          idleSeen.add(id)
          return yield* drainShell(id)
        }
        const moved = yield* SynchronizedRef.modify(ref, (st) => {
          if (st._tag === "ShellStopping" && st.shell.id === id) {
            return [true as const, { _tag: "Idle" } as State<A, E>] as const
          }
          return [false as const, st] as const
        })
        if (moved) {
          yield* clearIdleSeen(id)
          return
        }
        return yield* drainShell(id)
      }
      yield* clearIdleSeen(id)
    })

  const finishShell = (id: number): Effect.Effect<void> => Effect.uninterruptible(drainShell(id))

  const stopShell = (shell: Shell<A, E>) =>
    Effect.gen(function* () {
      if (shell.ready) yield* shell.ready.await.pipe(Effect.exit, Effect.asVoid)
      yield* Deferred.succeed(shell.cancelled, undefined).pipe(Effect.asVoid, Effect.ignore)
      yield* shell.gate.open.pipe(Effect.uninterruptible, Effect.ignore)
      yield* Fiber.interrupt(shell.fiber).pipe(Effect.ignore)
    })

  const requestRunInterrupt = (epoch: Epoch<A, E>): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* epoch.latch.open.pipe(Effect.uninterruptible, Effect.ignore)
      yield* Deferred.await(epoch.entered).pipe(Effect.ignore)
      yield* Fiber.interrupt(epoch.fiber).pipe(Effect.ignore)
    })

  const ensureRunning = (work: WorkInput<A, E>): Effect.Effect<A, E> =>
    Effect.gen(function* () {
      const descriptor = toNormalized(work)
      const current = yield* SynchronizedRef.get(ref)
      switch (current._tag) {
        case "Starting":
        case "Running":
        case "Stopping":
          return yield* awaitDone(current.epoch.done)
        case "ShellThenRun":
        case "ShellStoppingThenRun":
          return yield* awaitDone(current.pending.done)
        case "Shell": {
          const done = yield* Deferred.make<A, E | Cancelled>()
          const pid = next()
          const pending: Pending<A, E> = { id: pid, done, descriptor }
          const updated = yield* SynchronizedRef.modify(ref, (st) => {
            if (st._tag === "Shell" && st.shell.id === current.shell.id) {
              return [true as const, { _tag: "ShellThenRun", shell: st.shell, pending } as State<A, E>] as const
            }
            return [false as const, st] as const
          })
          if (updated) return yield* awaitDone(done)
          return yield* ensureRunning(work)
        }
        case "ShellStopping": {
          const done = yield* Deferred.make<A, E | Cancelled>()
          const pid = next()
          const pending: Pending<A, E> = { id: pid, done, descriptor }
          const updated = yield* SynchronizedRef.modify(ref, (st) => {
            if (st._tag === "ShellStopping" && st.shell.id === current.shell.id) {
              return [true as const, { _tag: "ShellStoppingThenRun", shell: st.shell, pending } as State<A, E>] as const
            }
            return [false as const, st] as const
          })
          if (updated) return yield* awaitDone(done)
          return yield* ensureRunning(work)
        }
        case "Idle": {
          const gen = Identifier.create("gen", "ascending")
          const done = yield* Deferred.make<A, E | Cancelled>()
          const entered = yield* Deferred.make<void>()
          const latch = yield* Latch.make()
          const id = next()
          const epoch = yield* spawnRun(descriptor, gen, id, done, entered, latch)
          const installed = yield* SynchronizedRef.modify(ref, (st) => {
            if (st._tag === "Idle") return [true as const, { _tag: "Starting", epoch } as State<A, E>] as const
            return [false as const, st] as const
          })
          if (!installed) {
            yield* abortSuspended(epoch.fiber)
            return yield* ensureRunning(work)
          }
          yield* epoch.latch.open.pipe(Effect.uninterruptible, Effect.ignore)
          return yield* awaitDone(done)
        }
      }
    })

  const startShell = (work: Effect.Effect<A, E>, ready?: Latch.Latch): Effect.Effect<A, E | Busy> =>
    Effect.gen(function* () {
      const probe = yield* SynchronizedRef.get(ref)
      if (probe._tag !== "Idle") return yield* Effect.fail(new Busy())
      const id = next()
      const cancelled = yield* Deferred.make<void>()
      const gate = yield* Latch.make()
      // Suspended-start protocol (mirrors run startup): the real fiber is
      // forked behind a closed barrier so body/finalizer cannot run before
      // the Shell state is atomically installed while Idle.
      const fiber = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* restore(gate.await)
          return yield* restore(work).pipe(Effect.ensuring(finishShell(id)))
        }).pipe(Effect.forkIn(scope)),
      )
      const shell: Shell<A, E> = { id, fiber, cancelled, gate, ready }
      const installed = yield* SynchronizedRef.modify(ref, (st) => {
        if (st._tag === "Idle") return [true as const, { _tag: "Shell", shell } as State<A, E>] as const
        return [false as const, st] as const
      })
      if (!installed) {
        yield* abortSuspended(fiber)
        return yield* Effect.fail(new Busy())
      }
      yield* onBusy
      yield* gate.open.pipe(Effect.uninterruptible, Effect.ignore)
      const exit = yield* Fiber.await(fiber)
      if (Exit.isSuccess(exit)) return exit.value
      if (Cause.hasInterruptsOnly(exit.cause)) {
        if (onInterrupt) return yield* onInterrupt
        return yield* Effect.die(new Cancelled())
      }
      const stopped = yield* Deferred.isDone(cancelled)
      if (stopped && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
        if (onInterrupt) return yield* onInterrupt
        return yield* Effect.die(new Cancelled())
      }
      return yield* Effect.failCause(exit.cause)
    })

  const awaitEpoch = (epoch: Epoch<A, E>): Effect.Effect<void> =>
    Effect.withFiber((cur) =>
      cur === (epoch.fiber as unknown as typeof cur)
        ? Effect.void
        : Deferred.await(epoch.done).pipe(Effect.ignore),
    )

  const awaitShell = (shell: Shell<A, E>): Effect.Effect<void> =>
    Effect.withFiber((cur) =>
      cur === (shell.fiber as unknown as typeof cur)
        ? Effect.void
        : Fiber.await(shell.fiber).pipe(Effect.asVoid),
    )

  // Signal-only owner request. Atomically transitions Starting|Running to
  // Stopping or Shell* to ShellStopping (failing the exact canceled pending),
  // returns the honest snapshot plus the targeted convergence handle, and
  // schedules the interrupt outside the state lock. Safe and nonblocking at
  // the request point; idempotent for repeated Stopping calls. Same-target
  // internal callers must use requestCancel (or rely on the self-await guard
  // in wait) to avoid awaiting their own finalizer.
  const requestCancel: Effect.Effect<CancelRequest> = Effect.gen(function* () {
    const target = yield* SynchronizedRef.modify(ref, (st) => {
      switch (st._tag) {
        case "Idle":
          return [
            {
              snapshot: { generationID: undefined, wasBusy: false, interruptRequested: false } as CancelSnapshot,
              task: Effect.void,
              wait: Effect.void,
            } as const,
            st,
          ] as const
        case "Starting":
        case "Running": {
          const snap: CancelSnapshot = { generationID: st.epoch.gen, wasBusy: true, interruptRequested: true }
          const epoch = st.epoch
          return [
            { snapshot: snap, task: requestRunInterrupt(epoch), wait: awaitEpoch(epoch) } as const,
            { _tag: "Stopping", epoch } as State<A, E>,
          ] as const
        }
        case "Stopping": {
          const snap: CancelSnapshot = { generationID: st.epoch.gen, wasBusy: true, interruptRequested: true }
          const epoch = st.epoch
          return [{ snapshot: snap, task: requestRunInterrupt(epoch), wait: awaitEpoch(epoch) } as const, st] as const
        }
        case "Shell": {
          const snap: CancelSnapshot = { generationID: undefined, wasBusy: true, interruptRequested: true }
          const shell = st.shell
          return [
            { snapshot: snap, task: stopShell(shell), wait: awaitShell(shell) } as const,
            { _tag: "ShellStopping", shell } as State<A, E>,
          ] as const
        }
        case "ShellThenRun": {
          const snap: CancelSnapshot = { generationID: undefined, wasBusy: true, interruptRequested: true }
          const shell = st.shell
          const pending = st.pending
          const task = Effect.uninterruptible(
            Effect.gen(function* () {
              // Single-flight pending outcome: one shared fallback value/error
              // for all joiners sharing this Deferred, not per-waiter effects.
              yield* completeWithSharedFallback(pending.done).pipe(Effect.ignore)
              yield* stopShell(shell)
            }),
          )
          const wait = Effect.all([Deferred.await(pending.done).pipe(Effect.ignore), awaitShell(shell)], {
            discard: true,
          })
          return [{ snapshot: snap, task, wait } as const, { _tag: "ShellStopping", shell } as State<A, E>] as const
        }
        case "ShellStopping": {
          const snap: CancelSnapshot = { generationID: undefined, wasBusy: true, interruptRequested: true }
          const shell = st.shell
          return [{ snapshot: snap, task: stopShell(shell), wait: awaitShell(shell) } as const, st] as const
        }
        case "ShellStoppingThenRun": {
          const snap: CancelSnapshot = { generationID: undefined, wasBusy: true, interruptRequested: true }
          const shell = st.shell
          const pending = st.pending
          const task = Effect.uninterruptible(
            Effect.gen(function* () {
              // Single-flight pending outcome: one shared fallback value/error
              // for all joiners sharing this Deferred, not per-waiter effects.
              yield* completeWithSharedFallback(pending.done).pipe(Effect.ignore)
              yield* stopShell(shell)
            }),
          )
          const wait = Effect.all([Deferred.await(pending.done).pipe(Effect.ignore), awaitShell(shell)], {
            discard: true,
          })
          return [{ snapshot: snap, task, wait } as const, { _tag: "ShellStopping", shell } as State<A, E>] as const
        }
      }
    })
    yield* Effect.forkIn(scope)(target.task.pipe(Effect.ignore))
    return { snapshot: target.snapshot, wait: target.wait }
  })

  // Historical convergent cancel: signal via requestCancel, then await the
  // targeted epoch/shell finalizer until the Runner-owned lifecycle has
  // performed body exit (TurnClose), onIdle/status projection, and reached
  // Idle or promoted the explicit post-cancel pending. Captured handles only,
  // so a later unrelated generation is never awaited. Never completes done.
  const cancel: Effect.Effect<CancelSnapshot> = Effect.gen(function* () {
    const req = yield* requestCancel
    yield* req.wait
    return req.snapshot
  })

  return {
    get state() {
      return state()
    },
    get busy() {
      return state()._tag !== "Idle"
    },
    get generationID() {
      const cur = state()
      if (cur._tag === "Starting" || cur._tag === "Running" || cur._tag === "Stopping") return cur.epoch.gen
      return undefined
    },
    ensureRunning,
    startShell,
    requestCancel,
    cancel,
  }
}

export * as Runner from "./runner"
