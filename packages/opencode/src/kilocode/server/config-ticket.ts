// kilocode_change - new file
import { Effect } from "effect"
import { forkRebuild } from "./config-rebuild"
import type { GenerationGate } from "./generation-gate"

type Result<A, R> = {
  readonly changed: boolean
  readonly value: A
  readonly rebuild?: Effect.Effect<void, never, R>
  // Deferred final event effect (LOCK-002): emitted only after forkRebuild
  // synchronously registered the rebuild, so a cold ConfigUpdated can never be
  // observed before the writer ticket has been handed to the rebuild.
  readonly event?: Effect.Effect<void, never, R>
}

/**
 * A PATCH owns its ticket from acquisition until synchronous rebuild
 * registration. Waiting for the ticket is interruptible; after acquisition the
 * snapshot, persistence, and registration handoff are one uninterruptible
 * transaction. The finalizer is idempotent through the ticket's abort method.
 *
 * LOCK-002 exact execution order: run persist/response → forkRebuild
 * registration/transfer → deferred final event effect → handler returns. On
 * event failure the already-registered rebuild keeps owning the ticket (the
 * `transferred` flag is set before the event runs), so the rebuild's ensuring
 * path releases the barrier and the failure surfaces through existing event
 * semantics (every cold event effect built on Config.emitUpdated logs and
 * swallows publish failures).
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
        if (!exit.value.changed) {
          yield* ticket.abort
          if (exit.value.event) yield* exit.value.event
          return exit.value.value
        }
        const rebuild = exit.value.rebuild
        if (rebuild) {
          yield* forkRebuild(rebuild)
          transferred = true
        }
        if (exit.value.event) yield* exit.value.event
        return exit.value.value
      }).pipe(Effect.ensuring(Effect.suspend(() => (transferred ? Effect.void : ticket.abort))))
    }),
  )

export * as ConfigTicket from "./config-ticket"
