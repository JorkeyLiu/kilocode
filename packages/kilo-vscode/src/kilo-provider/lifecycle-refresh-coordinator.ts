/**
 * Per-provider lifecycle refresh coordinator.
 *
 * Singleflight + trailing-dirty: concurrent/reentrant `request()` calls share
 * one in-flight gate promise. Any call arriving while a round is in flight
 * only marks dirty; the current round completes, then at least one trailing
 * round runs to cover the dirty window. Rounds run strictly serially so an
 * earlier full-refresh round never posts after a later round.
 *
 * No timers, no background tasks. `dispose()` prevents further rounds and
 * trailing work; the in-flight round (if any) finishes its current pass
 * without scheduling a trailing pass. The gate never rejects: round errors
 * (sync throw or async rejection) are swallowed so fire-and-forget
 * `void request()` call sites cannot produce unhandled rejections.
 *
 * Vscode-free so unit tests can exercise the coordinator directly.
 */

export type LifecycleRefreshRunner = () => Promise<void> | void

export class LifecycleRefreshCoordinator {
  private gate: Promise<void> | null = null
  private dirty = false
  private closed = false

  constructor(private readonly run: LifecycleRefreshRunner) {}

  /** Fixture-only: whether a refresh round is currently in flight. */
  get active(): boolean {
    return this.gate !== null
  }

  request(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.gate) {
      this.dirty = true
      return this.gate
    }
    let resolve!: () => void
    const gate = new Promise<void>((r) => {
      resolve = r
    })
    // Assign synchronously before any runner work so synchronous reentrancy
    // (runner calling request() before its first await) still joins this gate.
    this.gate = gate
    void (async () => {
      try {
        do {
          this.dirty = false
          try {
            await this.run()
          } catch {
            // Fail-soft: a slow/failed round must not block trailing coverage
            // and must never surface as an unhandled rejection.
          }
          if (this.closed) break
        } while (this.dirty)
      } finally {
        // Clear synchronously in the same microtask that exits the loop, before
        // resolving the gate: the loop-exit check and the clear have no await
        // between them, so an arrival at the exit boundary either joined this
        // gate (dirty=true, trailing runs) or sees gate===null (new round).
        if (this.gate === gate) this.gate = null
        resolve()
      }
    })()
    return gate
  }

  dispose(): void {
    this.closed = true
    this.dirty = false
  }
}
