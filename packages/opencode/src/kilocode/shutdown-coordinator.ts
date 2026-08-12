import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "shutdown-coordinator" })

export interface TimerHandle {
  readonly clear: () => void
  readonly hasRef: () => boolean
}

export interface ShutdownCoordinatorOpts {
  /**
   * Grace period for graceful disposal before the hard-stop fires. Defaults to
   * 5000ms — the same grace the extension's ServerManager uses before its
   * SIGKILL fallback — so the serve process owns a referenced hard deadline
   * instead of relying on a client-side timer that vanishes when the
   * Extension Host exits.
   *
   * The deadline is a JS timer. It bounds *async* disposal hangs — a pending
   * promise that never settles — but it cannot preempt a synchronous
   * event-loop stall, because a blocking loop never yields for the timer to
   * fire. The guarantee is lifecycle ownership, not a latency SLA.
   */
  readonly graceMs?: number
  /** Graceful disposal: instance disposal, then server stop. Called exactly once. */
  readonly shutdown: () => Promise<void>
  /**
   * Escalation when shutdown has not settled within graceMs. Defaults to
   * SIGKILLing self, which cannot be caught or delayed. Fires only when the
   * JS deadline timer runs: async disposal hangs are bounded, but a
   * synchronous event-loop stall blocks the timer itself and is not preempted.
   */
  readonly hardStop?: () => void
  /** Runs exactly once after shutdown settles and the deadline is cleared. */
  readonly onComplete: () => void
  /** Timer factory; injectable for tests. Defaults to a referenced setTimeout. */
  readonly setTimer?: (cb: () => void, ms: number) => TimerHandle
}

export interface ShutdownCoordinator {
  /**
   * Begin graceful shutdown. Idempotent: only the first call starts disposal
   * and arms the hard-stop deadline. Repeated signals or orphan notifications
   * never create parallel disposal; the referenced deadline is the single
   * escalation path.
   */
  readonly begin: () => void
}

export const defaultTimer = (cb: () => void, ms: number): TimerHandle => {
  const handle = setTimeout(cb, ms)
  return {
    clear: () => clearTimeout(handle),
    hasRef: () => handle.hasRef(),
  }
}

export function createShutdownCoordinator(opts: ShutdownCoordinatorOpts): ShutdownCoordinator {
  const graceMs = opts.graceMs ?? 5000
  const hardStop = opts.hardStop ?? (() => process.kill(process.pid, "SIGKILL"))
  const setTimer = opts.setTimer ?? defaultTimer
  let started = false

  const begin = (): void => {
    if (started) return
    started = true
    log.info("beginning graceful shutdown", { graceMs })
    const timer = setTimer(() => {
      log.warn("graceful shutdown exceeded grace; hard-stopping", { graceMs })
      hardStop()
    }, graceMs)
    void Promise.resolve()
      .then(() => opts.shutdown())
      .then(
        () => log.info("graceful shutdown complete"),
        (err) => log.error("graceful shutdown failed", { err }),
      )
      .finally(() => {
        timer.clear()
        opts.onComplete()
      })
  }

  return { begin }
}

/**
 * Wire SIGTERM/SIGINT/SIGHUP to a single begin() callback and return a
 * disposer that removes them.
 *
 * Used by `kilo serve`: the coordinator's `begin()` is idempotent, so repeated
 * signals while shutdown runs are harmless, but once shutdown completes the
 * process must not carry signal listener residue into its final teardown.
 * The disposer is meant to run from the coordinator's `onComplete`.
 */
export function startSignalShutdown(begin: () => void): () => void {
  const onSignal = () => begin()
  process.on("SIGTERM", onSignal)
  process.on("SIGINT", onSignal)
  process.on("SIGHUP", onSignal)
  return () => {
    process.off("SIGTERM", onSignal)
    process.off("SIGINT", onSignal)
    process.off("SIGHUP", onSignal)
  }
}
