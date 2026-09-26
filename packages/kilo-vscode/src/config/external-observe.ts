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
 * - Unconverged batches (throw or parsed pending state) are parked
 *   descriptor-only in a side map with a pending diagnostic and never
 *   rewrite disk. Parking never re-kicks by itself: no timer, no independent
 *   queue, no hot retry loop. The drain loop keeps sending trailing pending
 *   batches so later dirty work is not stuck behind a failure; parked
 *   descriptors redeliver once per explicit `reconcile()` signal (transport
 *   recovery notification or the next canonical config read). A fresh event
 *   for the same descriptor promotes it back to pending immediately.
 *   Parked work never blocks later saves (observe stays fire-and-forget
 *   outside the write fence).
 * - Disposal/epoch/project checks stay pending with a diagnostic; never SDK,
 *   never disk rewrite. Disposed/no-adapter paths drop without parking.
 * - Ownership: the activation-owned CanonicalConfigService owns this
 *   accumulator; `dispose()` drops parked and pending work. No new lifecycle
 *   owner, no persistent queue, no config-bytes copy, no generation replay.
 */
export class ExternalObserveCoalescer {
  private buckets = new Map<string, Bucket>()
  private inflight = new Set<string>()
  private parked = new Map<string, Bucket>()
  private closed = false

  notify(scope: "global" | "project", deps: ObserveDeps, descriptors?: readonly ConvergenceDescriptor[]): void {
    if (this.closed || deps.isDisposed()) return
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
      // Fresh evidence for the same descriptor promotes it back to pending:
      // the pending send below supersedes the parked copy (no duplicate).
      const park = this.parked.get(key)
      if (park) {
        park.descs.delete(descriptorKey(d))
        if (park.descs.size === 0) this.parked.delete(key)
      }
    }
    const keys = new Set<string>()
    for (const d of list) keys.add(bucketKeyFor(d, deps.projectRoot))
    for (const key of keys) this.kick(key)
  }

  /** True while any pending or parked descriptors await delivery. */
  hasPending(): boolean {
    for (const bucket of this.buckets.values()) if (bucket.descs.size > 0) return true
    for (const park of this.parked.values()) if (park.descs.size > 0) return true
    return false
  }

  /**
   * Redeliver parked unconverged descriptors once (bounded, descriptor-only).
   * Called on transport-recovery notification or the next canonical config
   * read; also safe to call when idle. Pending descriptors already drain on
   * their own; only parked work needs this signal. Never throws.
   */
  reconcile(): void {
    if (this.closed) return
    for (const [key, park] of [...this.parked]) {
      let bucket = this.buckets.get(key)
      if (!bucket) {
        bucket = { scope: park.scope, deps: park.deps, descs: new Map() }
        this.buckets.set(key, bucket)
      }
      for (const [k, d] of park.descs) if (!bucket.descs.has(k)) bucket.descs.set(k, d)
      this.parked.delete(key)
      this.kick(key)
    }
    for (const [key, bucket] of [...this.buckets]) {
      if (bucket.descs.size === 0) continue
      this.kick(key)
    }
  }

  /** Drop parked and pending work. In-flight sends settle without re-queue. */
  dispose(): void {
    this.closed = true
    this.buckets.clear()
    this.parked.clear()
    this.inflight.clear()
  }

  private kick(key: string): void {
    if (this.closed) return
    const bucket = this.buckets.get(key)
    if (!bucket || bucket.descs.size === 0) return
    if (this.inflight.has(key)) return
    this.inflight.add(key)
    void this.pump(key).finally(() => {
      this.inflight.delete(key)
      // Lost-wakeup guard: descriptors that arrived after the pump's final
      // empty check but before inflight removal would otherwise sit pending
      // with no pump to drain them. Re-kick when pending remains. Parked
      // work never re-kicks by itself; it waits for reconcile().
      if (this.closed) return
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
      const out = await this.sendOnce(bucket.scope, bucket.deps, batch)
      if (!out.attempted) continue
      if (out.converged) {
        // A converged batch supersedes parked copies of the same keys.
        const park = this.parked.get(key)
        if (park) {
          for (const d of batch) park.descs.delete(descriptorKey(d))
          if (park.descs.size === 0) this.parked.delete(key)
        }
        continue
      }
      // Unconverged: park descriptor-only for eventual reconcile, then keep
      // draining trailing pending batches so later dirty work is not stuck
      // behind this failure.
      let park = this.parked.get(key)
      if (!park) {
        park = { scope: bucket.scope, deps: bucket.deps, descs: new Map() }
        this.parked.set(key, park)
      }
      park.deps = bucket.deps
      for (const d of batch) {
        const k = descriptorKey(d)
        if (!park.descs.has(k)) park.descs.set(k, d)
      }
    }
  }

  private async sendOnce(
    scope: "global" | "project",
    deps: ObserveDeps,
    descriptors: readonly ConvergenceDescriptor[],
  ): Promise<{ readonly attempted: boolean; readonly converged: boolean }> {
    const observe = deps.observe
    if (!observe) return { attempted: false, converged: false }
    if (deps.isDisposed() || this.closed) return { attempted: false, converged: false }
    if (scope === "project" && !deps.hasProject) return { attempted: false, converged: false }
    if (descriptors.length === 0) return { attempted: false, converged: false }
    let state: ConvergenceState
    try {
      state = await observe(descriptors)
    } catch (err) {
      if (!deps.isDisposed() && !this.closed) deps.onPending(`External runtime convergence pending: ${String(err)}`)
      return { attempted: true, converged: false }
    }
    if (state.status === "pending") {
      if (!deps.isDisposed() && !this.closed) deps.onPending(`External runtime convergence pending: ${state.message}`)
      return { attempted: true, converged: false }
    }
    return { attempted: true, converged: true }
  }
}
