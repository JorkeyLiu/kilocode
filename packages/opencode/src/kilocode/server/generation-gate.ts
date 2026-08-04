// kilocode_change - new file
/**
 * Writer-preferring generation admission gate.
 *
 * Writers use one total FIFO for local and global tickets. A local writer that
 * was queued before a global writer keeps its place; once global intent exists,
 * later local writers and all readers wait. Promotion is the only operation
 * that reserves a queued writer, and the reservation is claimed in the same
 * uninterruptible region as the wakeup.
 *
 * Convergence fences (LOCK-002/003/006): a fence blocks NEW reader admission
 * for a directory (project fence) or every directory (global fence) while a
 * cold-config convergence pass drains and rebuilds the runtime. Fences are
 * raised by the ConfigConvergence coordinator BEFORE a cold mutation persists
 * and released after the drain→dispose→boot pass completes, so no generation
 * can bind to the pre-mutation runtime after the commit. Writers are never
 * blocked by a fence — hot and joining config writes keep working during a
 * convergence cycle (LOCK-006).
 */

import { Context, Deferred, Effect, Layer, Option } from "effect"

type WaitState = "queued" | "reserved" | "claimed" | "cancelled"

type WriterWaiter = {
  readonly kind: "project" | "global" | "prep"
  readonly directory?: string
  readonly signal: Deferred.Deferred<void>
  state: WaitState
}

type ReaderWaiter = {
  readonly signal: Deferred.Deferred<void>
  state: WaitState
}

type Entry = {
  readonly directory: string
  readers: number
  writing: boolean
  drain?: Deferred.Deferred<void>
  readersWaiting: ReaderWaiter[]
  // kilocode_change start - convergence fence (LOCK-002/006): blocks new
  // readers for the directory while a convergence pass is pending, without
  // participating in the writer FIFO and without blocking writers. Reference-
  // counted so concurrent cold saves share one physical fence; the fence clears
  // only when the last ref releases (after the final pass).
  fenced: boolean
  fenceRefs: number
  fenceDrain?: Deferred.Deferred<void>
  // kilocode_change start - LOCK-005: write-intent loads admitted under an
  // active per-directory fence register here so the fence cannot release with
  // a pre-convergence runtime cached. Shared across concurrent cold saves.
  fenceLoads?: FenceLoad
  // kilocode_change end
  // kilocode_change end
}

// kilocode_change start - LOCK-005: convergence fence load registry. A load
// admitted while a convergence fence is active registers a ref (`loading`);
// the release confirms it, and the coordinator converges confirmed directories
// before the fence may drop. `loading` ref-counts concurrent loads of the same
// directory; `confirmed` means at least one load finished and cached a runtime.
type FenceLoad = {
  loading: number
  confirmed: boolean
}

/**
 * Fiber-local marker set by the ConfigConvergence pass around its OWN
 * `store.load` calls (LOCK-005). The instance store skips fence-load
 * registration when the marker is set, so a convergence reboot can never
 * re-register a directory the pass is itself converging — which would loop the
 * fence release (dispose → load → register → claim → converge → dispose …).
 */
export const ConvergenceLoad = Context.Reference<boolean>("@kilocode/ConvergenceLoad", {
  defaultValue: () => false,
})

/** Result of claiming registered loads for convergence (LOCK-005). */
export type FenceLoadClaim = {
  readonly confirmed: readonly string[]
  /** Present when in-flight loads remain: await it, then re-claim. */
  readonly wait?: Deferred.Deferred<void>
}
// kilocode_change end

type State = {
  writing: boolean
  perDirectoryWriters: number
  writers: WriterWaiter[]
  reserved?: WriterWaiter
  drains: Map<string, Deferred.Deferred<void>>
  // kilocode_change start - global convergence fence state
  globalFence: boolean
  globalFenceRefs: number
  fenceDrains: Map<string, Deferred.Deferred<void>>
  // kilocode_change start - LOCK-005: global fence load registry (same shape
  // as the per-directory registry on Entry) plus a change signal the pass
  // awaits while loads are still in flight.
  fenceLoads: Map<string, FenceLoad>
  fenceLoadsSignal?: Deferred.Deferred<void>
  // kilocode_change end
  // kilocode_change end
}

export type ProjectWriteTicket = {
  readonly kind: "project"
  readonly directory: string
  readonly drained: Deferred.Deferred<void>
  readonly release: Effect.Effect<void>
  readonly abort: Effect.Effect<void>
}

export type GlobalWriteTicket = {
  readonly kind: "global"
  readonly drainFor: (directory: string) => Deferred.Deferred<void>
  readonly release: Effect.Effect<void>
  readonly abort: Effect.Effect<void>
}

export type WriteTicket = ProjectWriteTicket | GlobalWriteTicket

// kilocode_change start - convergence fence tickets (LOCK-002/003/006)
/**
 * Per-directory convergence fence. Blocks new reader admission for the
 * directory (generations, instance loads) while a convergence pass drains and
 * rebuilds it, but never blocks writers — hot and joining config writes stay
 * admission-free per LOCK-006. `drained` resolves when the pre-fence readers
 * reach zero. `release` resolves `true` when the ref was actually released, or
 * `false` when this was the last ref and registered write-loads (LOCK-005) are
 * still unconverged — the coordinator converges them and retries.
 */
export type ProjectFenceTicket = {
  readonly kind: "project-fence"
  readonly directory: string
  readonly drained: Deferred.Deferred<void>
  readonly release: Effect.Effect<boolean>
}

/**
 * Global convergence fence. Blocks new reader admission for every directory.
 * `drainFor(directory)` resolves when that directory's pre-fence readers reach
 * zero. `release` resolves `true` when the ref was actually released, or
 * `false` when this was the last ref and registered write-loads (LOCK-005) are
 * still unconverged — the coordinator converges them and retries.
 */
export type GlobalFenceTicket = {
  readonly kind: "global-fence"
  readonly drainFor: (directory: string) => Deferred.Deferred<void>
  readonly release: Effect.Effect<boolean>
}
// kilocode_change end

export interface GenerationGate {
  readonly acquire: (directory: string) => Effect.Effect<Effect.Effect<void>>
  /**
   * Write-preparation admission for config PATCH intake. Waits behind any
   * active or queued global writer (total FIFO), holds a per-directory write
   * intent while the caller loads/captures context — blocking later global
   * writers and same-directory writers/readers — then releases. It is NOT a
   * reader lease, so the PATCH can later acquire its own local write ticket
   * without self-deadlock, and the load can never escape a global rebuild that
   * captured its identities before the directory was seen.
   */
  readonly prepareWrite: (directory: string) => Effect.Effect<Effect.Effect<void>>
  readonly beginWrite: (directory: string) => Effect.Effect<ProjectWriteTicket>
  readonly beginWriteGlobal: () => Effect.Effect<GlobalWriteTicket>
  /**
   * Raise (or share) a per-directory convergence fence (LOCK-002/003/006). New
   * reader admission for `directory` waits until the fence releases; writers
   * are never blocked by a fence. The convergence coordinator raises the fence
   * before a cold mutation persists and releases it after the drain→dispose→
   * boot pass completes.
   */
  readonly beginFence: (directory: string) => Effect.Effect<ProjectFenceTicket>
  readonly beginFenceGlobal: () => Effect.Effect<GlobalFenceTicket>
  /**
   * Register a store.load admitted under an active convergence fence
   * (LOCK-005). Resolves `Some(release)` when the global fence OR the
   * directory's per-directory fence is active — the caller MUST run `release`
   * after the load completes (success, failure, or interruption) so the
   * coordinator converges the loaded runtime before the fence can drop.
   * Resolves `None` when no fence is active (no registration needed).
   */
  readonly registerFenceLoad: (directory: string) => Effect.Effect<Option.Option<Effect.Effect<void>>>
  /**
   * Claim confirmed global-fence loads for convergence (LOCK-005). Removes the
   * confirmed directories from the registry. When in-flight loads remain, the
   * claim ALSO atomically installs the change signal and returns it as `wait`
   * — the check and the signal install are one synchronous step, so a confirm
   * racing the claim can never be lost (either the confirm's sync runs first
   * and the claim observes the confirmed/empty state, or the claim installs
   * the signal and the confirm fires it). Await `wait`, then re-claim.
   */
  readonly claimFenceLoads: () => Effect.Effect<FenceLoadClaim>
  /**
   * Claim a confirmed per-directory fence load for convergence (LOCK-005).
   * Resolves `{ confirmed: true }` when the directory was claimed (removed
   * from the registry), or `{ confirmed: false, wait }` when a load is still
   * in flight — `wait` is the atomically-installed change signal to await
   * before re-claiming.
   */
  readonly claimProjectFenceLoad: (directory: string) => Effect.Effect<{
    readonly confirmed: boolean
    readonly wait?: Deferred.Deferred<void>
  }>
  /**
   * The live per-directory drain for `directory` under the CURRENT fence state
   * (LOCK-005): the shared global drain when the global fence is active, the
   * shared per-directory drain when that fence is active, or an already-resolved
   * drain when neither is active (a registered load converging after the fence
   * dropped must not wait on a drain the gate will never resolve).
   */
  readonly fenceDrainFor: (directory: string) => Effect.Effect<Deferred.Deferred<void>>
  /**
   * True when a reader admission for `directory` would block behind an active
   * or queued writer barrier OR an active convergence fence. Pure check, never
   * mutates gate state. Used by the instance middleware to decide whether a
   * drain-control request must bypass reader admission (LOCK-004).
   */
  readonly isBarrierActive: (directory: string) => boolean
}

const done = (deferred: Deferred.Deferred<void>) => Deferred.doneUnsafe(deferred, Effect.succeed(void 0))

const noopTicket = (directory: string): ProjectWriteTicket => {
  const drained = Deferred.makeUnsafe<void>()
  done(drained)
  return { kind: "project", directory, drained, release: Effect.void, abort: Effect.void }
}

// kilocode_change start - noop convergence fences
const noopProjectFence = (directory: string): ProjectFenceTicket => {
  const drained = Deferred.makeUnsafe<void>()
  done(drained)
  return { kind: "project-fence", directory, drained, release: Effect.succeed(true) }
}

const noopGlobalFence = (): GlobalFenceTicket => ({
  kind: "global-fence",
  drainFor: () => {
    const drained = Deferred.makeUnsafe<void>()
    done(drained)
    return drained
  },
  release: Effect.succeed(true),
})
// kilocode_change end

export const noop: GenerationGate = {
  acquire: () => Effect.succeed(Effect.void),
  prepareWrite: () => Effect.succeed(Effect.void),
  beginWrite: (directory) => Effect.succeed(noopTicket(directory)),
  isBarrierActive: () => false,
  beginFence: (directory) => Effect.succeed(noopProjectFence(directory)), // kilocode_change
  beginFenceGlobal: () => Effect.succeed(noopGlobalFence()), // kilocode_change
  registerFenceLoad: () => Effect.succeed(Option.none()), // kilocode_change - LOCK-005
  claimFenceLoads: () => Effect.succeed({ confirmed: [] }), // kilocode_change - LOCK-005
  claimProjectFenceLoad: () => Effect.succeed({ confirmed: false }), // kilocode_change - LOCK-005
  fenceDrainFor: () => {
    const drained = Deferred.makeUnsafe<void>()
    done(drained)
    return Effect.succeed(drained)
  }, // kilocode_change - LOCK-005
  beginWriteGlobal: () =>
    Effect.succeed({
      kind: "global" as const,
      drainFor: () => {
        const drained = Deferred.makeUnsafe<void>()
        done(drained)
        return drained
      },
      release: Effect.void,
      abort: Effect.void,
    }),
}

export class Service extends Context.Service<Service, GenerationGate>()("@kilocode/GenerationGate") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const entries = new Map<string, Entry>()
    const state: State = {
      writing: false,
      perDirectoryWriters: 0,
      writers: [],
      drains: new Map(),
      globalFence: false, // kilocode_change
      globalFenceRefs: 0, // kilocode_change
      fenceDrains: new Map(), // kilocode_change
      fenceLoads: new Map(), // kilocode_change - LOCK-005
    }

    const entry = (directory: string) => {
      const current = entries.get(directory)
      if (current) return current
      const fresh: Entry = { directory, readers: 0, writing: false, readersWaiting: [], fenced: false, fenceRefs: 0 }
      entries.set(directory, fresh)
      return fresh
    }

    const hasGlobalIntent = () => state.writing || state.writers.some((item) => item.kind === "global")
    const hasLocalIntent = (target: Entry) =>
      state.writers.some(
        (item) => (item.kind === "project" || item.kind === "prep") && item.directory === target.directory,
      )

    // Pure: true when a reader for `target` would wait behind a writer barrier
    // or an active convergence fence (LOCK-002/003).
    const wouldBlock = (target: Entry) =>
      hasGlobalIntent() || state.globalFence || target.writing || target.fenced || hasLocalIntent(target)

    const admitReader = (target: Entry) => {
      if (wouldBlock(target)) return false
      target.readers += 1
      return true
    }

    const releaseReader = (target: Entry) => {
      target.readers -= 1
      if (target.readers === 0 && target.drain) {
        const drain = target.drain
        target.drain = undefined
        done(drain)
      }
      if (target.readers === 0 && state.writing) {
        const drain = state.drains.get(target.directory)
        if (drain) done(drain)
      }
      // kilocode_change start - resolve convergence fence drains (LOCK-002/003)
      if (target.readers === 0 && target.fenceDrain) {
        const drain = target.fenceDrain
        target.fenceDrain = undefined
        done(drain)
      }
      if (target.readers === 0 && state.globalFence) {
        const drain = state.fenceDrains.get(target.directory)
        if (drain) {
          state.fenceDrains.delete(target.directory)
          done(drain)
        }
      }
      // kilocode_change end
    }

    const removeWriter = (waiter: WriterWaiter) => {
      const index = state.writers.indexOf(waiter)
      if (index >= 0) state.writers.splice(index, 1)
    }

    const wakeReaders = () => {
      // kilocode_change - a convergence fence keeps readers parked until release
      if (hasGlobalIntent() || state.globalFence) return
      for (const target of entries.values()) {
        if (target.writing || target.fenced || hasLocalIntent(target)) continue
        for (const waiter of target.readersWaiting) done(waiter.signal)
      }
    }

    const promote = () => {
      if (state.writing || state.reserved) return
      while (state.writers[0]?.state === "cancelled") state.writers.shift()
      const next = state.writers[0]
      if (!next) {
        wakeReaders()
        return
      }
      if (next.kind === "project" || next.kind === "prep") {
        const target = entry(next.directory!)
        if (target.writing) return
        next.state = "reserved"
        state.reserved = next
        done(next.signal)
        return
      }
      if (state.perDirectoryWriters > 0) return
      next.state = "reserved"
      state.reserved = next
      done(next.signal)
    }

    const cancelWriter = (waiter: WriterWaiter) => {
      if (waiter.state === "claimed" || waiter.state === "cancelled") return
      waiter.state = "cancelled"
      removeWriter(waiter)
      if (state.reserved === waiter) state.reserved = undefined
      promote()
    }

    const claimWriter = (waiter: WriterWaiter) => {
      if (waiter.state !== "reserved" || state.reserved !== waiter) return false
      waiter.state = "claimed"
      state.reserved = undefined
      removeWriter(waiter)
      if (waiter.kind === "global") {
        state.writing = true
        state.drains = new Map()
        return true
      }
      const target = entry(waiter.directory!)
      target.writing = true
      state.perDirectoryWriters += 1
      if (waiter.kind === "prep") return true
      target.drain = Deferred.makeUnsafe<void>()
      if (target.readers === 0) done(target.drain)
      return true
    }

    const prepTicket = (target: Entry): Effect.Effect<void> => {
      let released = false
      return Effect.sync(() => {
        if (released) return
        released = true
        target.writing = false
        state.perDirectoryWriters -= 1
        promote()
      })
    }

    const claimReader = (target: Entry, waiter: ReaderWaiter) => {
      if (waiter.state !== "queued") return false
      const index = target.readersWaiting.indexOf(waiter)
      if (index >= 0) target.readersWaiting.splice(index, 1)
      waiter.state = "cancelled"
      return admitReader(target)
    }

    const cancelReader = (target: Entry, waiter: ReaderWaiter) => {
      if (waiter.state !== "queued") return
      waiter.state = "cancelled"
      const index = target.readersWaiting.indexOf(waiter)
      if (index >= 0) target.readersWaiting.splice(index, 1)
    }

    const localTicket = (target: Entry): ProjectWriteTicket => {
      let released = false
      const once = Effect.sync(() => {
        if (released) return
        released = true
        target.writing = false
        state.perDirectoryWriters -= 1
        promote()
      })
      return { kind: "project", directory: target.directory, drained: target.drain!, release: once, abort: once }
    }

    const globalTicket = (): GlobalWriteTicket => {
      let released = false
      const once = Effect.sync(() => {
        if (released) return
        released = true
        state.writing = false
        state.drains = new Map()
        promote()
      })
      return {
        kind: "global",
        drainFor: (directory: string) => {
          const existing = state.drains.get(directory)
          if (existing) return existing
          const drain = Deferred.makeUnsafe<void>()
          state.drains.set(directory, drain)
          const target = entries.get(directory)
          if (!target || target.readers === 0) done(drain)
          return drain
        },
        release: once,
        abort: once,
      }
    }

    const acquire = Effect.fn("GenerationGate.acquire")(function* (directory: string) {
      const target = entry(directory)
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          while (true) {
            if (yield* Effect.sync(() => admitReader(target))) return Effect.sync(() => releaseReader(target))
            const waiter: ReaderWaiter = { signal: yield* Deferred.make<void>(), state: "queued" }
            yield* Effect.sync(() => target.readersWaiting.push(waiter))
            yield* restore(
              Deferred.await(waiter.signal).pipe(Effect.onInterrupt(() => Effect.sync(() => cancelReader(target, waiter)))),
            )
            yield* restore(Effect.yieldNow.pipe(Effect.onInterrupt(() => Effect.sync(() => cancelReader(target, waiter)))))
            if (yield* Effect.sync(() => claimReader(target, waiter))) return Effect.sync(() => releaseReader(target))
          }
        }),
      )
    })

    const beginWrite = Effect.fn("GenerationGate.beginWrite")(function* (directory: string) {
      const target = entry(directory)
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          while (true) {
            const immediate = yield* Effect.sync(
              () => !state.writing && !state.reserved && state.writers.length === 0 && !target.writing,
            )
            if (immediate) {
              yield* Effect.sync(() => {
                target.writing = true
                state.perDirectoryWriters += 1
                target.drain = Deferred.makeUnsafe<void>()
                if (target.readers === 0) done(target.drain)
              })
              return localTicket(target)
            }
            const waiter: WriterWaiter = { kind: "project", directory, signal: yield* Deferred.make<void>(), state: "queued" }
            yield* Effect.sync(() => {
              state.writers.push(waiter)
              promote()
            })
            yield* restore(
              Deferred.await(waiter.signal).pipe(Effect.onInterrupt(() => Effect.sync(() => cancelWriter(waiter)))),
            )
            yield* restore(Effect.yieldNow.pipe(Effect.onInterrupt(() => Effect.sync(() => cancelWriter(waiter)))))
            if (yield* Effect.sync(() => claimWriter(waiter))) return localTicket(target)
          }
        }),
      )
    })

    const prepareWrite = Effect.fn("GenerationGate.prepareWrite")(function* (directory: string) {
      const target = entry(directory)
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          while (true) {
            const immediate = yield* Effect.sync(
              () => !state.writing && !state.reserved && state.writers.length === 0 && !target.writing,
            )
            if (immediate) {
              yield* Effect.sync(() => {
                target.writing = true
                state.perDirectoryWriters += 1
              })
              return prepTicket(target)
            }
            const waiter: WriterWaiter = { kind: "prep", directory, signal: yield* Deferred.make<void>(), state: "queued" }
            yield* Effect.sync(() => {
              state.writers.push(waiter)
              promote()
            })
            yield* restore(
              Deferred.await(waiter.signal).pipe(Effect.onInterrupt(() => Effect.sync(() => cancelWriter(waiter)))),
            )
            yield* restore(Effect.yieldNow.pipe(Effect.onInterrupt(() => Effect.sync(() => cancelWriter(waiter)))))
            if (yield* Effect.sync(() => claimWriter(waiter))) return prepTicket(target)
          }
        }),
      )
    })

    const beginWriteGlobal = Effect.fn("GenerationGate.beginWriteGlobal")(function* () {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          while (true) {
            const immediate = yield* Effect.sync(
              () => !state.writing && !state.reserved && state.writers.length === 0 && state.perDirectoryWriters === 0,
            )
            if (immediate) {
              yield* Effect.sync(() => {
                state.writing = true
                state.drains = new Map()
              })
              return globalTicket()
            }
            const waiter: WriterWaiter = { kind: "global", signal: yield* Deferred.make<void>(), state: "queued" }
            yield* Effect.sync(() => {
              state.writers.push(waiter)
              promote()
            })
            yield* restore(
              Deferred.await(waiter.signal).pipe(Effect.onInterrupt(() => Effect.sync(() => cancelWriter(waiter)))),
            )
            yield* restore(Effect.yieldNow.pipe(Effect.onInterrupt(() => Effect.sync(() => cancelWriter(waiter)))))
            if (yield* Effect.sync(() => claimWriter(waiter))) return globalTicket()
          }
        }),
      )
    })

    const isBarrierActive = (directory: string) => wouldBlock(entry(directory))

    // kilocode_change start - convergence fences (LOCK-002/003/006)
    /**
     * Raise (or share) a per-directory convergence fence. Synchronous state
     * transition (no waiting): new readers for the directory block until every
     * shared ref releases. The fence never participates in the writer FIFO and
     * never blocks writers.
     */
    const beginFence = Effect.fn("GenerationGate.beginFence")(function* (directory: string) {
      const target = entry(directory)
      return yield* Effect.sync(() => {
        let released = false
        const release = Effect.sync(() => {
          // LOCK-005: the LAST ref cannot drop while write-intent loads
          // registered against this fence are still unconverged — the fence
          // must hold so the coordinator converges them (dispose + reboot)
          // before any new reader can bind to the pre-convergence runtime.
          if (!released && target.fenceRefs === 1 && target.fenceLoads !== undefined) return false
          if (released) return true
          released = true
          target.fenceRefs -= 1
          if (target.fenceRefs === 0) {
            target.fenced = false
            target.fenceDrain = undefined
            target.fenceLoads = undefined
            wakeReaders()
          }
          return true
        })
        const ticket: ProjectFenceTicket = {
          kind: "project-fence",
          directory,
          drained: target.fenceDrain!,
          release,
        }
        if (target.fenced) {
          target.fenceRefs += 1
          return ticket
        }
        target.fenced = true
        target.fenceRefs = 1
        target.fenceDrain = Deferred.makeUnsafe<void>()
        if (target.readers === 0) done(target.fenceDrain)
        return { ...ticket, drained: target.fenceDrain }
      })
    })

    /**
     * Raise (or share) the global convergence fence. New readers for every
     * directory block until every shared ref releases; writers are never
     * blocked by a fence.
     */
    const beginFenceGlobal = Effect.fn("GenerationGate.beginFenceGlobal")(function* () {
      return yield* Effect.sync(() => {
        let released = false
        const release = Effect.sync(() => {
          // LOCK-005: see beginFence — the last global ref cannot drop while
          // registered write-loads are unconverged.
          if (!released && state.globalFenceRefs === 1 && state.fenceLoads.size > 0) return false
          if (released) return true
          released = true
          state.globalFenceRefs -= 1
          if (state.globalFenceRefs === 0) {
            state.globalFence = false
            state.fenceDrains = new Map()
            state.fenceLoads = new Map()
            fireFenceLoadsSignal()
            wakeReaders()
          }
          return true
        })
        const ticket: GlobalFenceTicket = {
          kind: "global-fence",
          drainFor: (directory: string) => drainsOf(directory),
          release,
        }
        if (state.globalFence) {
          state.globalFenceRefs += 1
          return ticket
        }
        state.globalFence = true
        state.globalFenceRefs = 1
        state.fenceDrains = new Map()
        return ticket
      })
    })

    /**
     * Per-fence drain lookup: each raise shares the SAME drains map so every
     * holder awaits the same per-directory drain signal.
     */
    const drainsOf = (directory: string) => {
      const existing = state.fenceDrains.get(directory)
      if (existing) return existing
      const drain = Deferred.makeUnsafe<void>()
      state.fenceDrains.set(directory, drain)
      const target = entries.get(directory)
      if (!target || target.readers === 0) done(drain)
      return drain
    }

    // kilocode_change start - LOCK-005: write-load registry + convergence
    // handshake. A load admitted while the global fence (or a per-directory
    // fence) is active registers a ref; the release confirms it once the load
    // finished, and the coordinator claims confirmed directories, converges
    // them (dispose the pre-convergence runtime, boot from current disk), and
    // only then releases the fence refs. The last ref release is DEFERRED
    // (returns false) while the registry is non-empty, so the fence cannot drop
    // with a pre-global runtime cached.
    const fireFenceLoadsSignal = () => {
      const signal = state.fenceLoadsSignal
      if (signal) {
        state.fenceLoadsSignal = undefined
        done(signal)
      }
    }

    const confirmFenceLoad = (directory: string, global: boolean): Effect.Effect<void> => {
      let confirmed = false
      return Effect.sync(() => {
        if (confirmed) return
        confirmed = true
        if (global) {
          const current = state.fenceLoads.get(directory)
          if (!current) return
          current.loading -= 1
          if (current.loading === 0) current.confirmed = true
        } else {
          const target = entries.get(directory)
          const current = target?.fenceLoads
          if (!current) return
          current.loading -= 1
          if (current.loading === 0) current.confirmed = true
        }
        fireFenceLoadsSignal()
      })
    }

    const registerFenceLoad = Effect.fn("GenerationGate.registerFenceLoad")(function* (directory: string) {
      return yield* Effect.sync(() => {
        if (state.globalFence) {
          const current = state.fenceLoads.get(directory)
          if (current) current.loading += 1
          else state.fenceLoads.set(directory, { loading: 1, confirmed: false })
          fireFenceLoadsSignal()
          return Option.some(confirmFenceLoad(directory, true))
        }
        const target = entries.get(directory)
        if (target?.fenced) {
          const current = target.fenceLoads
          if (current) current.loading += 1
          else target.fenceLoads = { loading: 1, confirmed: false }
          fireFenceLoadsSignal()
          return Option.some(confirmFenceLoad(directory, false))
        }
        return Option.none()
      })
    })

    const claimFenceLoads = Effect.fn("GenerationGate.claimFenceLoads")(function* () {
      return yield* Effect.sync(() => {
        const confirmed: string[] = []
        for (const [directory, load] of state.fenceLoads) {
          if (load.confirmed) confirmed.push(directory)
        }
        for (const directory of confirmed) state.fenceLoads.delete(directory)
        if (confirmed.length > 0) fireFenceLoadsSignal()
        // Claim + signal install in ONE synchronous step: when in-flight loads
        // remain, install the change signal before returning so a confirm that
        // already fired (before this sync) cannot be lost — it is observed as
        // the confirmed/empty state above instead.
        if (confirmed.length > 0 || state.fenceLoads.size === 0) return { confirmed } as FenceLoadClaim
        const signal = state.fenceLoadsSignal ?? Deferred.makeUnsafe<void>()
        state.fenceLoadsSignal = signal
        return { confirmed, wait: signal } as FenceLoadClaim
      })
    })

    const claimProjectFenceLoad = Effect.fn("GenerationGate.claimProjectFenceLoad")(function* (directory: string) {
      return yield* Effect.sync(() => {
        const target = entries.get(directory)
        const current = target?.fenceLoads
        if (!current) return { confirmed: false } as const
        if (current.confirmed) {
          target!.fenceLoads = undefined
          return { confirmed: true } as const
        }
        const signal = state.fenceLoadsSignal ?? Deferred.makeUnsafe<void>()
        state.fenceLoadsSignal = signal
        return { confirmed: false, wait: signal } as const
      })
    })

    const fenceDrainFor = Effect.fn("GenerationGate.fenceDrainFor")(function* (directory: string) {
      return yield* Effect.sync(() => {
        const target = entries.get(directory)
        if (state.globalFence) return drainsOf(directory)
        if (target?.fenced && target.fenceDrain) return target.fenceDrain
        const drain = Deferred.makeUnsafe<void>()
        done(drain)
        return drain
      })
    })
    // kilocode_change end

    return Service.of({
      acquire,
      prepareWrite,
      beginWrite,
      beginWriteGlobal,
      beginFence,
      beginFenceGlobal,
      registerFenceLoad,
      claimFenceLoads,
      claimProjectFenceLoad,
      fenceDrainFor,
      isBarrierActive,
    })
  }),
)

export const defaultLayer = layer
export * as GenerationGate from "./generation-gate"
