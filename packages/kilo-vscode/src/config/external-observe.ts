import type { ConvergenceDescriptor, ConvergenceState } from "./convergence"

export type ObserveDeps = {
  readonly isDisposed: () => boolean
  readonly hasProject: boolean
  readonly projectRoot: string | undefined
  readonly observe?: (d: readonly ConvergenceDescriptor[]) => Promise<ConvergenceState>
  readonly onPending: (message: string) => void
}

type Bucket = {
  scope: "global" | "project"
  deps: ObserveDeps
  descs: Map<string, ConvergenceDescriptor>
}

const MAX_DESCRIPTORS_PER_REQUEST = 8

function descriptorKey(d: ConvergenceDescriptor): string {
  if (d.kind === "config") return d.scope === "global" ? "config|global" : `config|project|${d.directory}`
  const dir = d.scope === "global" ? "" : (d.directory ?? "")
  return `asset|${d.asset}|${d.scope}|${dir}|${d.id}`
}

function bucketKeyFor(d: ConvergenceDescriptor, fallbackProjectRoot: string | undefined): string {
  if (d.kind === "config") return d.scope === "global" ? "global" : `project:${d.directory}`
  if (d.scope === "global") return "global"
  return `project:${d.directory ?? fallbackProjectRoot ?? ""}`
}

function scopeForBucket(key: string): "global" | "project" {
  return key === "global" ? "global" : "project"
}

/**
 * Bounded descriptor accumulator for external canonical config/asset observe
 * hints. Sends only after successful external canonical materialization (the
 * caller gates on that); own-write hash hits never call notify.
 *
 * Algorithm (simple, provable, no loss of distinct ids):
 * - Each descriptor lands in exactly one scope bucket (`global` or
 *   `project:<directory>`) keyed by its stable descriptor key, so a later
 *   descriptor for a different asset id never overwrites an earlier one.
 *   Same-scope duplicates collapse to one entry (dedup).
 * - At most one inflight wire request per bucket plus trailing pending
 *   entries. A batch snapshots up to 8 descriptors (wire max) and removes
 *   them from pending before sending; descriptors arriving during the send
 *   stay pending for the next batch. Config and asset descriptors for the
 *   same bucket share a batch; bursts >8 drain batch-by-batch until empty.
 * - Failure (throw or pending state) keeps local state intact with a pending
 *   diagnostic and never rewrites disk; the loop still continues with the
 *   next pending batch so later dirty work is not stuck behind a failure.
 * - Disposal/epoch/project checks stay pending with a diagnostic; never SDK,
 *   never disk rewrite.
 */
export class ExternalObserveCoalescer {
  private buckets = new Map<string, Bucket>()
  private inflight = new Set<string>()

  notify(scope: "global" | "project", deps: ObserveDeps, descriptors?: readonly ConvergenceDescriptor[]): void {
    if (deps.isDisposed()) return
    if (scope === "project" && !deps.hasProject) return
    const list: readonly ConvergenceDescriptor[] =
      descriptors && descriptors.length > 0
        ? descriptors
        : scope === "global"
          ? [{ kind: "config", scope: "global" }]
          : [{ kind: "config", scope: "project", directory: deps.projectRoot! }]
    for (const d of list) {
      const key = bucketKeyFor(d, deps.projectRoot)
      if (key !== "global" && !deps.hasProject) continue
      let bucket = this.buckets.get(key)
      if (!bucket) {
        bucket = { scope: scopeForBucket(key), deps, descs: new Map() }
        this.buckets.set(key, bucket)
      }
      bucket.deps = deps
      bucket.descs.set(descriptorKey(d), d)
    }
    const keys = new Set<string>()
    for (const d of list) keys.add(bucketKeyFor(d, deps.projectRoot))
    for (const key of keys) this.kick(key)
  }

  private kick(key: string): void {
    const bucket = this.buckets.get(key)
    if (!bucket || bucket.descs.size === 0) return
    if (this.inflight.has(key)) return
    this.inflight.add(key)
    void this.pump(key).finally(() => {
      this.inflight.delete(key)
      // Lost-wakeup guard: descriptors that arrived after the pump's final
      // empty check but before inflight removal would otherwise sit pending
      // with no pump to drain them. Re-kick when pending remains.
      const pending = this.buckets.get(key)
      if (pending && pending.descs.size > 0) this.kick(key)
    })
  }

  private async pump(key: string): Promise<void> {
    for (;;) {
      const bucket = this.buckets.get(key)
      if (!bucket || bucket.descs.size === 0) {
        if (bucket && bucket.descs.size === 0) this.buckets.delete(key)
        return
      }
      const batch = [...bucket.descs.values()].slice(0, MAX_DESCRIPTORS_PER_REQUEST)
      for (const d of batch) bucket.descs.delete(descriptorKey(d))
      await this.sendOnce(bucket.scope, bucket.deps, batch)
    }
  }

  private async sendOnce(
    scope: "global" | "project",
    deps: ObserveDeps,
    descriptors: readonly ConvergenceDescriptor[],
  ): Promise<void> {
    const observe = deps.observe
    if (!observe) return
    if (deps.isDisposed()) return
    if (scope === "project" && !deps.hasProject) return
    if (descriptors.length === 0) return
    let state: ConvergenceState
    try {
      state = await observe(descriptors)
    } catch (err) {
      if (!deps.isDisposed()) deps.onPending(`External runtime convergence pending: ${String(err)}`)
      return
    }
    if (state.status === "pending" && !deps.isDisposed()) deps.onPending(`External runtime convergence pending: ${state.message}`)
  }
}
