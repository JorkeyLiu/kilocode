// kilocode_change - new file
import { Effect } from "effect"
import { forkRebuild } from "./config-rebuild"
import type { GenerationGate } from "./generation-gate"

type Result<A, R> = {
  readonly changed: boolean
  readonly value: A
  readonly rebuild?: Effect.Effect<void, never, R>
}

/**
 * A PATCH owns its ticket from acquisition until synchronous rebuild
 * registration. Waiting for the ticket is interruptible; after acquisition the
 * snapshot, persistence, and registration handoff are one uninterruptible
 * transaction. The finalizer is idempotent through the ticket's abort method.
 */
export const withWriteTicket = <A, E, R, T extends GenerationGate.WriteTicket>(input: {
  readonly acquire: Effect.Effect<T, E, R>
  readonly run: (
    ticket: T,
  ) => Effect.Effect<Result<A, R>, E, R>
}): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const ticket = yield* restore(input.acquire)
      let transferred = false
      return yield* Effect.gen(function* () {
        const exit = yield* Effect.exit(input.run(ticket))
        if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause)
        if (!exit.value.changed || !exit.value.rebuild) {
          yield* ticket.abort
          return exit.value.value
        }
        yield* forkRebuild(exit.value.rebuild)
        transferred = true
        return exit.value.value
      }).pipe(Effect.ensuring(Effect.suspend(() => (transferred ? Effect.void : ticket.abort))))
    }),
  )

export * as ConfigTicket from "./config-ticket"
