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

export type ExternalObserveRetryOptions = {
  readonly retryInitialMs?: number
  readonly retryMaxMs?: number
}

const DEFAULT_RETRY_INITIAL_MS = 500
const DEFAULT_RETRY_MAX_MS = 5000
const MIN_RETRY_MS = 25
const MAX_RETRY_CAP_MS = 30_000

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
  *   rewrite disk. Parking keeps draining trailing pending batches so later
  *   dirty work is not stuck behind a failure. The first failure per
  *   descriptor set + cause emits `onPending`; timer redeliveries with the
  *   same parked descriptors and the same cause stay silent (dedup) so a
  *   long FD outage does not refresh the user-facing saveError on every
  *   tick. A fresh watcher `notify()` invalidates the dedup entry so the
  *   next attempt emits again, as does any changed error message. Parked
  *   descriptors redeliver once per explicit `reconcile()` signal (transport
  *   recovery notification or the next canonical config read) or per fresh
  *   watcher event, plus via one self-owned bounded backoff wakeup while
  *   parked work remains: a single timer (500ms initial, exponential to
  *   5000ms max, capped indefinitely; singleflight, unref, cleared on
  *   dispose/success) redrives `reconcile()` with the same equivalent
  *   same-key merge. The wakeup never marks success by itself — only an
  *   actual cold observe converges; failure re-parks and reschedules.
  *   Parked work never blocks later saves (observe stays fire-and-forget
  *   outside the write fence) and never replays confirmed write operations
  *   (descriptor-only hint, no fence, no bytes, no generation replay).
 * - Disposal/epoch/project checks stay pending with a diagnostic; never SDK,
 *   never disk rewrite. Disposed/no-adapter paths drop without parking.
 * - Ownership: the activation-owned CanonicalConfigService owns this
 *   accumulator; `dispose()` drops parked and pending work and clears the
 *   self-owned retry timer. No new lifecycle owner, no persistent queue, no
 *   config-bytes copy, no generation replay.
 */
export class ExternalObserveCoalescer {
  private buckets = new Map<string, Bucket>()
  private inflight = new Set<string>()
  private parked = new Map<string, Bucket>()
  private closed = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retryAttempt = 0
  private readonly retryInitialMs: number
  private readonly retryMaxMs: number
  private lastPendingSig = new Map<string, string>()

  constructor(opts: ExternalObserveRetryOptions = {}) {
    const init = opts.retryInitialMs ?? DEFAULT_RETRY_INITIAL_MS
    const max = opts.retryMaxMs ?? DEFAULT_RETRY_MAX_MS
    this.retryInitialMs = Math.min(Math.max(init, MIN_RETRY_MS), MAX_RETRY_CAP_MS)
    this.retryMaxMs = Math.min(Math.max(max, this.retryInitialMs), MAX_RETRY_CAP_MS)
  }

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
    // Fresh watcher evidence is new user-visible intent: invalidate the
    // repeat-pending dedup so the next attempt emits even when the cause
    // text matches the previous failure. Timer-only redeliveries (no
    // notify) keep the dedup entry and stay silent on identical cause.
    for (const key of keys) this.lastPendingSig.delete(key)
    for (const key of keys) this.kick(key)
    this.syncRetryTimer()
  }

  /** True while any pending or parked descriptors await delivery. */
  hasPending(): boolean {
    for (const bucket of this.buckets.values()) if (bucket.descs.size > 0) return true
    for (const park of this.parked.values()) if (park.descs.size > 0) return true
    return false
  }

  /**
   * Redeliver parked unconverged descriptors once (bounded, descriptor-only).
   * Called on transport-recovery notification, the next canonical config
   * read, or the self-owned parked retry wakeup; also safe to call when
   * idle. Pending descriptors already drain on their own; only parked work
   * needs this signal. Never throws. Stays immediate: explicit callers never
   * wait for the backoff timer.
   */
  reconcile(): void {
    if (this.closed) return
    this.clearRetryTimer()
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
    this.syncRetryTimer()
  }

  /** Drop parked and pending work. In-flight sends settle without re-queue. */
  dispose(): void {
    this.closed = true
    this.clearRetryTimer()
    this.retryAttempt = 0
    this.buckets.clear()
    this.parked.clear()
    this.inflight.clear()
    this.lastPendingSig.clear()
  }

  private hasParked(): boolean {
    for (const park of this.parked.values()) if (park.descs.size > 0) return true
    return false
  }

  private retryDelay(): number {
    let delay = this.retryInitialMs
    for (let i = 0; i < this.retryAttempt; i++) {
      delay *= 2
      if (delay >= this.retryMaxMs) return this.retryMaxMs
    }
    return Math.min(delay, this.retryMaxMs)
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
  }

  /**
   * Keep exactly one parked retry wakeup while parked work remains.
   * No timer when parked is empty (pending drains on its own via the pump,
   * including batches already removed into inflight); fully idle — no
   * pending, no parked, and no inflight wire batch — resets the backoff.
   * Never marks success: firing only redrives reconcile(); only a cold
   * observe converges.
   */
  private syncRetryTimer(): void {
    if (this.closed) {
      this.clearRetryTimer()
      return
    }
    if (!this.hasParked()) {
      this.clearRetryTimer()
      if (!this.hasPending() && this.inflight.size === 0) this.retryAttempt = 0
      return
    }
    if (this.retryTimer) return
    const delay = this.retryDelay()
    const timer = setTimeout(() => {
      this.retryTimer = undefined
      if (this.closed) return
      if (!this.hasParked()) {
        if (!this.hasPending() && this.inflight.size === 0) this.retryAttempt = 0
        return
      }
      if (this.retryAttempt < 10) this.retryAttempt += 1
      this.reconcile()
    }, delay)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
    this.retryTimer = timer
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
      // with no pump to drain them. Re-kick when pending remains. Explicit
      // reconcile() and the single parked backoff wakeup cover parked work;
      // this path never fabricates success.
      if (this.closed) return
      const pending = this.buckets.get(key)
      if (pending && pending.descs.size > 0) this.kick(key)
      this.syncRetryTimer()
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
      const out = await this.sendOnce(key, bucket.scope, bucket.deps, batch)
      // Disposed while the wire batch was in flight: never re-park, never
      // re-arm. The dispose() already dropped all queues; settling here
      // must not resurrect parked work or the retry timer.
      if (this.closed) return
      if (!out.attempted) continue
      if (out.converged) {
        // A converged batch supersedes parked copies of the same keys.
        const park = this.parked.get(key)
        if (park) {
          for (const d of batch) park.descs.delete(descriptorKey(d))
          if (park.descs.size === 0) this.parked.delete(key)
        }
        this.lastPendingSig.delete(key)
        this.syncRetryTimer()
        continue
      }
      // Unconverged: park descriptor-only for eventual reconcile, then keep
      // draining trailing pending batches so later dirty work is not stuck
      // behind this failure. Failure stays parked: the single backoff wakeup
      // only redrives reconcile(), never claims success.
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
      this.syncRetryTimer()
    }
  }

  private async sendOnce(
    key: string,
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
      this.emitPendingOnce(key, deps, descriptors, `External runtime convergence pending: ${String(err)}`)
      return { attempted: true, converged: false }
    }
    if (state.status === "pending") {
      this.emitPendingOnce(key, deps, descriptors, `External runtime convergence pending: ${state.message}`)
      return { attempted: true, converged: false }
    }
    return { attempted: true, converged: true }
  }

  /**
   * Emit the pending diagnostic once per descriptor set + cause. Timer-only
   * redeliveries with identical batch keys and identical message stay silent
   * so a long outage keeps a bounded wire rate without refreshing the
   * user-facing error on every tick. Fresh notify() clears the entry and a
   * changed message naturally differs, so both emit again.
   */
  private emitPendingOnce(
    key: string,
    deps: ObserveDeps,
    descriptors: readonly ConvergenceDescriptor[],
    message: string,
  ): void {
    if (deps.isDisposed() || this.closed) return
    const batchSig = descriptors.map((d) => descriptorKey(d)).sort().join(",")
    const sig = `${batchSig}|${message}`
    if (this.lastPendingSig.get(key) === sig) return
    this.lastPendingSig.set(key, sig)
    deps.onPending(message)
  }
}
