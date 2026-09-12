import type { ConvergenceDescriptor, ConvergenceState } from "./convergence"

export type ObserveDeps = {
  readonly isDisposed: () => boolean
  readonly hasProject: boolean
  readonly projectRoot: string | undefined
  readonly observe?: (d: readonly ConvergenceDescriptor[]) => Promise<ConvergenceState>
  readonly onPending: (message: string) => void
}

type PendingNotify = {
  readonly scope: "global" | "project"
  readonly deps: ObserveDeps
}

/**
 * Per-descriptor/scope trailing-edge dirty loop for external canonical
 * config observe hints. Sends only after successful external canonical
 * materialization (the caller gates on that); own-write coalesced events
 * and asset events never call notify.
 *
 * Bounded: at most one inflight hint plus one dirty flag per scope. A
 * notify while inflight records the latest scope/deps and schedules exactly
 * one follow-up after the inflight settles; sustained bursts collapse into
 * that single follow-up per round, never an unbounded queue. The follow-up
 * uses the latest descriptor state so the latest edit is never dropped.
 * Disposal/epoch failure stays pending with a diagnostic; never SDK, never
 * disk rewrite.
 */
export class ExternalObserveCoalescer {
  private inflight = new Map<string, Promise<void>>()
  private dirty = new Map<string, PendingNotify>()

  notify(scope: "global" | "project", deps: ObserveDeps): void {
    if (deps.isDisposed()) return
    if (scope === "project" && !deps.hasProject) return
    const key = scope === "global" ? "global" : `project:${deps.projectRoot}`
    if (this.inflight.has(key)) {
      this.dirty.set(key, { scope, deps })
      return
    }
    const task = this.run(key, scope, deps)
    this.inflight.set(key, task)
    void task.finally(() => {
      if (this.inflight.get(key) === task) this.inflight.delete(key)
    })
  }

  private async run(key: string, scope: "global" | "project", deps: ObserveDeps): Promise<void> {
    let current: PendingNotify | undefined = { scope, deps }
    while (current) {
      await this.sendOnce(current.scope, current.deps)
      const next = this.dirty.get(key)
      if (next) {
        this.dirty.delete(key)
        current = next
        continue
      }
      current = undefined
    }
  }

  private async sendOnce(scope: "global" | "project", deps: ObserveDeps): Promise<void> {
    const observe = deps.observe
    if (!observe) return
    if (deps.isDisposed()) return
    if (scope === "project" && !deps.hasProject) return
    const descriptors: ConvergenceDescriptor[] =
      scope === "global" ? [{ kind: "config", scope: "global" }] : [{ kind: "config", scope: "project", directory: deps.projectRoot! }]
    let state: ConvergenceState
    try {
      state = await observe(descriptors)
    } catch (err) {
      if (!deps.isDisposed()) deps.onPending(`External config runtime convergence pending: ${String(err)}`)
      return
    }
    if (state.status === "pending" && !deps.isDisposed()) deps.onPending(`External config runtime convergence pending: ${state.message}`)
  }
}
