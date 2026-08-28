import { AsyncLocalStorage } from "node:async_hooks"
import { Effect, Fiber } from "effect"

type Slot = {
  work: Effect.Effect<void, never, never>
  done: boolean
}

const storage = new AsyncLocalStorage<Slot | undefined>()

export const Admission = {
  run<A, E, R>(work: Effect.Effect<void, never, never>, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    const slot: Slot = { work, done: false }
    return Effect.gen(function* () {
      const context = yield* Effect.context<R>()
      const fiber = storage.run(slot, () => Effect.runForkWith(context)(effect))
      const exit = yield* Fiber.await(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)))
      return yield* exit
    })
  },
  consume(): Effect.Effect<void, never, never> {
    return Effect.gen(function* () {
      const slot = storage.getStore()
      if (!slot || slot.done) return
      slot.done = true
      yield* slot.work
    })
  },
  consumeSync(): Promise<void> {
    const slot = storage.getStore()
    if (!slot || slot.done) return Promise.resolve()
    slot.done = true
    return Effect.runPromise(slot.work)
  },
}
