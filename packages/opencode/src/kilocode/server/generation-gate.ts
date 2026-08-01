// kilocode_change - new file
/**
 * Writer-preferring generation admission gate.
 *
 * Writers use one total FIFO for local and global tickets. A local writer that
 * was queued before a global writer keeps its place; once global intent exists,
 * later local writers and all readers wait. Promotion is the only operation
 * that reserves a queued writer, and the reservation is claimed in the same
 * uninterruptible region as the wakeup.
 */

import { Context, Deferred, Effect, Layer } from "effect"

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
}

type State = {
  writing: boolean
  perDirectoryWriters: number
  writers: WriterWaiter[]
  reserved?: WriterWaiter
  drains: Map<string, Deferred.Deferred<void>>
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
}

const done = (deferred: Deferred.Deferred<void>) => Deferred.doneUnsafe(deferred, Effect.succeed(void 0))

const noopTicket = (directory: string): ProjectWriteTicket => {
  const drained = Deferred.makeUnsafe<void>()
  done(drained)
  return { kind: "project", directory, drained, release: Effect.void, abort: Effect.void }
}

export const noop: GenerationGate = {
  acquire: () => Effect.succeed(Effect.void),
  prepareWrite: () => Effect.succeed(Effect.void),
  beginWrite: (directory) => Effect.succeed(noopTicket(directory)),
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
    const state: State = { writing: false, perDirectoryWriters: 0, writers: [], drains: new Map() }

    const entry = (directory: string) => {
      const current = entries.get(directory)
      if (current) return current
      const fresh: Entry = { directory, readers: 0, writing: false, readersWaiting: [] }
      entries.set(directory, fresh)
      return fresh
    }

    const hasGlobalIntent = () => state.writing || state.writers.some((item) => item.kind === "global")
    const hasLocalIntent = (target: Entry) =>
      state.writers.some(
        (item) => (item.kind === "project" || item.kind === "prep") && item.directory === target.directory,
      )

    const admitReader = (target: Entry) => {
      if (hasGlobalIntent() || target.writing || hasLocalIntent(target)) return false
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
    }

    const removeWriter = (waiter: WriterWaiter) => {
      const index = state.writers.indexOf(waiter)
      if (index >= 0) state.writers.splice(index, 1)
    }

    const wakeReaders = () => {
      if (hasGlobalIntent()) return
      for (const target of entries.values()) {
        if (target.writing || hasLocalIntent(target)) continue
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

    return Service.of({ acquire, prepareWrite, beginWrite, beginWriteGlobal })
  }),
)

export const defaultLayer = layer
export * as GenerationGate from "./generation-gate"
