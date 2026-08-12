import * as Log from "@opencode-ai/core/util/log"
import { errorMessage } from "../util/error"

export interface FatalHandlerOpts {
  /**
   * Termination override; defaults to process.exit(1). Injectable for tests —
   * the unit tests must not actually kill the test runner.
   */
  readonly exit?: (code: number) => void
  /**
   * Diagnostic sink; defaults to Log.Default.error. Injectable for tests to
   * record calls or throw like a broken pipe would.
   */
  readonly log?: (kind: "exception" | "rejection", message: string) => void
}

/**
 * Install non-reentrant, EPIPE-safe process-level fatal handlers.
 *
 * Why this exists: a `kilo serve --print-logs` backend whose Extension Host
 * parent dies ends up with a broken stderr pipe. The first log write against
 * that pipe surfaces as an `uncaughtException` with `code === "EPIPE"`; the
 * old handler logged again, which wrote to the same broken pipe, which raised
 * another EPIPE — an endless cycle that spins CPU and grows RSS while the
 * orphan watchdog's shutdown is starved.
 *
 * The contract:
 *   - Fatal `uncaughtException` on healthy streams: log once, then exit — crash
 *     semantics preserved, never silently continue.
 *   - `unhandledRejection` on healthy streams: log once and continue (the
 *     rejection is not inherently fatal), preserving prior behavior.
 *   - EPIPE / EAGAIN trigger, a re-entrant invocation, or a throwing log sink:
 *     never write to the broken stream again. Terminate directly without any
 *     recursive logging.
 *
 * Returns a function that removes both handlers.
 */
export function installFatalHandlers(opts: FatalHandlerOpts = {}): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  const log = opts.log ?? ((kind: string, message: string) => Log.Default.error(kind, { e: message }))
  let handling = false

  const fatal = (kind: "exception" | "rejection", e: unknown): void => {
    if (handling || brokenPipe(e)) {
      // Re-entered while the previous invocation was still running, or the
      // trigger is itself a broken-pipe write: the stream is dead, so a
      // diagnostic write can only fail again. Prefer no log over a recursive
      // one; terminate.
      exit(1)
      return
    }
    handling = true
    try {
      log(kind, errorMessage(e))
    } catch {
      // The sink threw (broken pipe surfaced synchronously, or a throwing
      // logger). Do not recurse into the fatal path — exit directly.
      exit(1)
      return
    }
    if (kind === "exception") {
      // Crash semantics: a fatal uncaught error terminates the process.
      exit(1)
      return
    }
    // Rejection logged fine — allow a later rejection to log normally.
    handling = false
  }

  const onException = (e: unknown) => fatal("exception", e)
  const onRejection = (e: unknown) => fatal("rejection", e)
  process.on("uncaughtException", onException)
  process.on("unhandledRejection", onRejection)
  return () => {
    process.off("uncaughtException", onException)
    process.off("unhandledRejection", onRejection)
  }
}

/** True when the error indicates the pipe peer is gone (or not consuming). */
function brokenPipe(e: unknown): boolean {
  if (typeof e === "object" && e !== null) {
    const code = (e as { code?: unknown }).code
    return code === "EPIPE" || code === "EAGAIN"
  }
  return false
}
