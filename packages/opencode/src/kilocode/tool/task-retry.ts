import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Duration, Effect } from "effect"
import { SessionRetry } from "@/session/retry"
import type { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { isRecord } from "@/util/record"

/**
 * Bounded same-session automatic retry for child task sessions that ended in a
 * terminal transient provider/network failure.
 *
 * Conservative by design:
 * - only errors already classified transient by SessionRetry.retryable are retried
 * - interruption/cancellation never reaches this path (it is not an assistant error)
 * - any completed, running, or interrupted tool part in the child history blocks
 *   retry — those imply committed or ambiguous side effects
 * - the same child session is re-prompted; a replacement session is never created
 */
export namespace KiloTaskRetry {
  /** Maximum automatic retries after the initial child attempt. */
  export const MAX = 2

  /**
   * True when the child history contains a completed, running, or interrupted
   * tool part. Interrupted tool executions are persisted as error-state parts
   * with metadata.interrupted (see session/processor.ts abort handling).
   */
  export function ambiguous(msgs: readonly SessionV1.WithParts[]) {
    return msgs.some((msg) =>
      msg.parts.some(
        (part) =>
          part.type === "tool" &&
          (part.state.status === "completed" ||
            part.state.status === "running" ||
            (part.state.status === "error" &&
              isRecord(part.state.metadata) &&
              part.state.metadata.interrupted === true)),
      ),
    )
  }

  /**
   * History that cannot be inspected is treated as ambiguous — never retry
   * blind. Only the expected lookup failure (NotFoundError) is handled;
   * interrupts and defects propagate unchanged.
   */
  const blocked = (sessions: Session.Interface, sessionID: SessionID) =>
    sessions.messages({ sessionID }).pipe(
      Effect.map(ambiguous),
      Effect.catchTag("NotFoundError", () => Effect.succeed(true)),
    )

  /**
   * Re-prompts the same child session for transient terminal errors, at most
   * `max` (default 2) times with the existing bounded exponential backoff from
   * SessionRetry.delay. Returns the last attempted result, or undefined when no
   * retry was performed. `wait` exists for tests only.
   */
  export const recover = Effect.fn("KiloTaskRetry.recover")(function* <E, R>(opts: {
    error: NonNullable<SessionV1.Assistant["error"]>
    sessions: Session.Interface
    sessionID: SessionID
    attempt: () => Effect.Effect<SessionV1.WithParts, E, R>
    max?: number
    wait?: (attempt: number) => Duration.Duration
  }) {
    let error = opts.error
    let last: SessionV1.WithParts | undefined
    for (let index = 1; index <= (opts.max ?? MAX); index++) {
      if (!SessionRetry.retryable(error)) return last
      if (yield* blocked(opts.sessions, opts.sessionID)) return last
      yield* Effect.sleep(opts.wait?.(index) ?? Duration.millis(SessionRetry.delay(index)))
      last = yield* opts.attempt()
      if (last.info.role !== "assistant" || !last.info.error) return last
      error = last.info.error
    }
    return last
  })
}
