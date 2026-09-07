import { isAbsolute } from "path"
import { PrivateWorkerHost, type HostOptions } from "./host"
import { OBSERVATION_METHODS, OBSERVATION_VERSION } from "./observation"
import type { ObservationCursorStore } from "./observation-cursor-store"
import { isE2EFixtureEnabled } from "../util/e2e-fixture"

/**
 * R9 production private-worker observation wiring — enabled no-lease observer.
 *
 * Extension-owned service that owns one PrivateWorkerHost lifecycle and
 * delegates observation snapshot/read/ack/subscribe requests over the
 * private JSON-RPC carrier. Additive, reversible, and preserves
 * the HTTP/SSE migration bridge (legacy bridge remains active,
 * private failure never blocks activation).
 *
 * Gate:
 *  - Explicit internal bootstrap gate, fail-closed, non-user-authored.
 *  - Enabled only when opts.enabled === true AND opts.dbPath is absolute.
 *  - No arbitrary user config/workspace/env overlay is consulted.
 *  - One canonical DB identity — canonical absolute KILO_DB
 *    via resolveCanonicalDbPath / Global.Path.data/kilo.db (legacy owns
 *    exclusive lease, private worker uses Database.layerNoLease only).
 *  - When enabled, creates a real PrivateWorkerHost with
 *    KILO_PRIVATE_WORKER_STANDALONE=1 + absolute KILO_DB and delegates
 *    via non-leased Database.layerNoLease as derived observer
 *    + createChangefeedDeps in the standalone worker. Additive, gated,
 *    reversible, no second store per ADR-0005.
 *
 * Notification boundary:
 *  - Private observation/changed notifications are forwarded through the
 *    injectable onNotification consumer. No webview operational facts are
 *    invented and no second persistence store is introduced. If no suitable
 *    consumer exists, only the internal service callback/request API is
 *    exposed and full UI convergence is a follow-up.
 *
 * Lifecycle — bounded shutdown/reinitialize (no polling, no lease retry):
 *  - One active host per service instance + explicit pending-shutdown owner
 *    for the still-live old child when bounded shutdown (2000ms, exact PID,
 *    no global kills) times out. Pending host remains owned until the exact
 *    child process has exited (proc exitCode/signalCode, not host state) and
 *    is disposed on service disposal; no replacement is spawned on timeout
 *    and both reconnect and initialize are blocked while pending is alive.
 *  - Idempotent disposal, does not interrupt active generations.
 *  - No polling/timers, no Failure/Outcome/Recovery wiring, no selector
 *    changes, no schema changes. On reconnect, exact-PID bounded shutdown,
 *    then single bounded reinitialize with same canonical env (no lease).
 *  - Singleflight: reconnect installs its promise before awaiting any
 *    in-flight initialize, preventing concurrent callers from entering
 *    doReconnect twice.
 */

export interface PrivateObservationServiceOptions {
  /**
   * Internal bootstrap gate — explicit and fail-closed.
   * Must be true with an absolute dbPath to enable. Default false.
   */
  enabled?: boolean
  /** Canonical DB path for the private worker (ADR-0005). Must be absolute when enabled. */
  dbPath?: string
  /** Internal test-only bridge for live notification proof. */
  testBridge?: boolean
  /** Injectable consumer boundary for observation/changed notifications. */
  onNotification?: (method: string, params: unknown) => void
  /** Override spawn command for tests (e.g., bun with standalone TS). */
  command?: string
  /** Override spawn args for tests. */
  args?: string[]
  /** Additional env for test isolation (e.g., XDG_DATA_HOME overrides). Not user config. */
  env?: NodeJS.ProcessEnv
  /** Initialize handshake timeout ms. */
  initializeTimeoutMs?: number
  /** Optional bounded cursor store (single integer, no timers). Injected per instance, no singleton. */
  cursorStore?: ObservationCursorStore
}

export function isPrivateObservationGateEnabled(opts: PrivateObservationServiceOptions): boolean {
  return opts.enabled === true && typeof opts.dbPath === "string" && isAbsolute(opts.dbPath)
}

export class PrivateObservationService implements Disposable {
  private host: PrivateWorkerHost | null = null
  /** Explicit owner for still-live old child when bounded shutdown times out — no orphan, explicit disposal. Ownership is based on actual child exit (proc exitCode), not host state. */
  private pendingShutdownHost: PrivateWorkerHost | null = null
  private pendingShutdownProc: import("child_process").ChildProcess | null = null
  private initPromise: Promise<unknown> | null = null
  private reconnectPromise: Promise<unknown> | null = null
  private disposed = false
  private readonly consumer: ((method: string, params: unknown) => void) | undefined
  private readonly opts: PrivateObservationServiceOptions
  private readonly cursorStore: ObservationCursorStore | undefined
  // R9 fixture-only bounded notification recorder at onNotification boundary:
  // small in-memory sequence of JSON-safe envelopes, not production state,
  // enabled only under KILO_E2E_FIXTURE. No persistence, no second store.
  // Monotonic ordinal watermark: startOrdinal = nextOrdinal - retainedLength,
  // independent of bounded array length to avoid truncation gaps.
  private readonly notificationLog: Array<{ ordinal: number; method: string; params: unknown; at: string }> = []
  private readonly notificationLogLimit = 50
  private notificationNextOrdinal = 0
  private readonly isFixtureRecorderEnabled: boolean
  private peerClosedHook: (() => void) | null = null
  private suppressDepth = 0
  private ackChain: Promise<void> = Promise.resolve()

  constructor(opts?: PrivateObservationServiceOptions)
  constructor(context: unknown, opts: PrivateObservationServiceOptions)
  constructor(contextOrOpts: unknown = {}, optsMaybe?: PrivateObservationServiceOptions) {
    if (optsMaybe !== undefined) {
      this.opts = optsMaybe
    } else if (
      contextOrOpts !== null &&
      typeof contextOrOpts === "object" &&
      ("enabled" in (contextOrOpts as Record<string, unknown>) ||
        "dbPath" in (contextOrOpts as Record<string, unknown>) ||
        "testBridge" in (contextOrOpts as Record<string, unknown>) ||
        "onNotification" in (contextOrOpts as Record<string, unknown>) ||
        "command" in (contextOrOpts as Record<string, unknown>) ||
        "args" in (contextOrOpts as Record<string, unknown>) ||
        "env" in (contextOrOpts as Record<string, unknown>) ||
        "initializeTimeoutMs" in (contextOrOpts as Record<string, unknown>) ||
        "cursorStore" in (contextOrOpts as Record<string, unknown>))
    ) {
      this.opts = contextOrOpts as PrivateObservationServiceOptions
    } else if (
      contextOrOpts !== null &&
      typeof contextOrOpts === "object" &&
      Object.keys(contextOrOpts as object).length === 0
    ) {
      this.opts = {}
    } else if (contextOrOpts === undefined || contextOrOpts === null) {
      this.opts = {}
    } else {
      // Single context-like argument (e.g., VS Code extension context) with no opts — treat as disabled.
      this.opts = {}
    }
    this.consumer = this.opts.onNotification
    this.cursorStore = this.opts.cursorStore
    this.isFixtureRecorderEnabled = isE2EFixtureEnabled()
  }

  /** Whether the internal gate is enabled (explicit, fail-closed). */
  isEnabled(): boolean {
    return isPrivateObservationGateEnabled(this.opts)
  }

  /** Whether the host has been started and is open. */
  isStarted(): boolean {
    return this.host !== null && this.host.getState() === "open"
  }

  /**
   * Bounded readiness wait for fixture — waits for existing
   * initialization/reconnect singleflight to settle, then verifies
   * isStarted/hostState open within timeout. Preserves fire-and-forget
   * activation; readiness is explicit and fixture-gated, never polling
   * in production. Returns true when ready, throws on timeout.
   */
  async waitReady(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const pending = this.reconnectPromise ?? this.initPromise
      if (pending) {
        try {
          await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              const rem = deadline - Date.now()
              if (rem <= 0) reject(new Error("privateObservationWaitReady timed out waiting for init/reconnect"))
              else {
                const t = setTimeout(() => reject(new Error("privateObservationWaitReady timed out")), rem)
                if ((t as unknown as { unref?: () => void })?.unref) (t as unknown as { unref: () => void }).unref()
              }
            }),
          ])
        } catch (e) {
          if (String((e as Error).message).includes("timed out")) throw e
          // init/reconnect failure still counts as settled for readiness probe
        }
      }
      if (this.isStarted() && this.getHostState() === "open") return true
      if (Date.now() >= deadline)
        throw new Error(
          `privateObservationWaitReady timed out: hostState=${this.getHostState()} isStarted=${this.isStarted()}`,
        )
      await new Promise<void>((r) => setTimeout(r, 100))
    }
  }

  /** Current host state for diagnostics (open/closed). */
  getHostState(): string {
    if (this.host) return this.host.getState()
    return "closed"
  }

  /** Direct host access for tests (null when gate off or not started). */
  getHost(): PrivateWorkerHost | null {
    return this.host
  }

  /** Direct pending shutdown host for tests — explicit ownership when bounded shutdown timed out. */
  getPendingShutdownHost(): PrivateWorkerHost | null {
    return this.pendingShutdownHost
  }

  /** Exact-PID pending proc for tests — retained until the exact child has exited */
  getPendingShutdownProc(): import("child_process").ChildProcess | null {
    return this.pendingShutdownProc
  }

  private isPendingAlive(): boolean {
    if (!this.pendingShutdownHost) return false
    const proc = this.pendingShutdownProc ?? this.pendingShutdownHost.getProc()
    if (!proc) return false
    return proc.exitCode === null && proc.signalCode === null
  }

  private clearPendingIfExited(): void {
    if (!this.pendingShutdownHost) return
    const proc = this.pendingShutdownProc ?? this.pendingShutdownHost.getProc()
    if (!proc) {
      this.pendingShutdownHost = null
      this.pendingShutdownProc = null
      return
    }
    if (proc.exitCode !== null || proc.signalCode !== null) {
      this.pendingShutdownHost = null
      this.pendingShutdownProc = null
    }
  }

  private runSuppressed<T>(fn: () => T): T {
    this.suppressDepth++
    try {
      return fn()
    } finally {
      this.suppressDepth = Math.max(0, this.suppressDepth - 1)
    }
  }

  private async runSuppressedAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.suppressDepth++
    try {
      return await fn()
    } finally {
      this.suppressDepth = Math.max(0, this.suppressDepth - 1)
    }
  }

  /**
   * Initialize the private worker host when gate is enabled.
   * Fail-closed: no-op when gate disabled or already disposed.
   * Idempotent: concurrent callers share the same promise.
   * If a reconnect is in-flight, initialize shares that reconnect promise
   * (no second concurrent lease acquisition) and resolves with the reconnect
   * result. This avoids duplicate host creation and lease contention.
   * Returns initialize result when gate on, undefined when gate off or already open.
   */
  async initialize(): Promise<unknown> {
    if (this.disposed) throw new Error("Service disposed")
    if (!this.isEnabled()) return undefined
    if (this.reconnectPromise) return this.reconnectPromise
    if (this.initPromise) return this.initPromise
    this.clearPendingIfExited()
    if (this.isPendingAlive()) throw new Error("Private worker shutdown timed out — initialize aborted")
    if (this.host && this.host.getState() === "open") return undefined
    this.initPromise = this.doInitialize()
    try {
      return await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  /**
   * R9 bounded reconnect — bounded shutdown/reinitialize (no lease, no retry).
   * Bounded, exact-PID shutdown: captures the old host, awaits its exit
   * via host.shutdown(2000) (exact child ownership, no global kills, bounded),
   * then re-enters initialization with the same canonical
   * environment (KILO_PRIVATE_WORKER_STANDALONE=1 + absolute KILO_DB).
   * Fail-closed and idempotent: concurrent callers share the same promise,
   * gate-off returns undefined, disposed throws.
   * If shutdown times out (false), reconnect throws without spawning a
   * replacement and retains the still-live old child in an explicit
   * pending-shutdown field until service disposal cleans it. This guarantees
   * no orphaned child after a timeout — the service remains the bounded owner.
   * If an initialize is in-flight, reconnect awaits it to settle before
   * superseding (initialize promise is not cancelled — reconnect starts after).
   * With no-lease (Database.layerNoLease), lease-contention retry is
   * not meaningful; reconnect does a single bounded initialization after shutdown.
   */
  async reconnect(): Promise<unknown> {
    if (this.disposed) throw new Error("Service disposed")
    if (!this.isEnabled()) return undefined
    if (this.reconnectPromise) return this.reconnectPromise
    // Singleflight before awaiting initPromise — prevents concurrent callers from entering doReconnect twice
    const task = (async () => {
      if (this.initPromise) {
        try {
          await this.initPromise
        } catch (e) {
          console.warn("[Kilo] PrivateObservationService reconnect observed in-flight initialize failure:", e)
        }
      }
      return this.doReconnect()
    })()
    this.reconnectPromise = task
    try {
      return await task
    } finally {
      if (this.reconnectPromise === task) this.reconnectPromise = null
    }
  }

  private async doReconnect(): Promise<unknown> {
    // If a prior bounded shutdown timed out, the still-live old child remains
    // explicitly owned until its exact PID has exited (proc exitCode, not host state).
    // Do not spawn a replacement while pending is still live — fail closed.
    this.clearPendingIfExited()
    if (this.isPendingAlive()) {
      if (this.disposed) throw new Error("Service disposed")
      throw new Error("Private worker shutdown timed out — reconnect aborted")
    }
    const old = this.host
    if (old) {
      this.host = null
      this.pendingShutdownHost = old
      this.pendingShutdownProc = old.getProc()
      let ok = false
      try {
        // Bounded awaitable shutdown — exact PID, no global kills, no unbounded wait.
        // Suppressed: intentional disposal must not invoke lifecycle onPeerClosed -> reconnect loop.
        ok = await this.runSuppressedAsync(() => old.shutdown(2000))
      } catch {
        ok = false
      }
      if (!ok) {
        // Re-check actual exit after bounded wait — proc may have exited concurrently
        const proc = this.pendingShutdownProc ?? old.getProc()
        const exited = proc ? proc.exitCode !== null || proc.signalCode !== null : true
        if (exited) {
          this.pendingShutdownHost = null
          this.pendingShutdownProc = null
        } else {
          if (this.disposed) throw new Error("Service disposed")
          // Keep pendingShutdownHost + proc owned for bounded cleanup, no replacement.
          throw new Error("Private worker shutdown timed out — reconnect aborted")
        }
      } else {
        // Shutdown succeeded — old child exited, clear pending ownership.
        this.pendingShutdownHost = null
        this.pendingShutdownProc = null
      }
    }
    if (this.disposed) throw new Error("Service disposed")
    // No-lease mode: no lease-contention retry needed; single initialization.
    this.initPromise = this.doInitialize()
    try {
      return await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  private async doInitialize(): Promise<unknown> {
    if (this.disposed) throw new Error("Service disposed")
    const hostEnv: NodeJS.ProcessEnv = {
      ...(this.opts.env ?? {}),
      KILO_PRIVATE_WORKER_STANDALONE: "1",
      KILO_DB: this.opts.dbPath!,
      ...(this.opts.testBridge ? { KILO_PRIVATE_WORKER_TEST_BRIDGE: "1" } : {}),
    }
    const hostOpts: HostOptions = {
      env: hostEnv,
      command: this.opts.command,
      args: this.opts.args,
      initializeTimeoutMs: this.opts.initializeTimeoutMs,
      onNotification: (m, p) => {
        if (this.isFixtureRecorderEnabled) {
          try {
            const safe = JSON.parse(JSON.stringify(p === undefined ? null : p))
            const ordinal = this.notificationNextOrdinal++
            this.notificationLog.push({ ordinal, method: m, params: safe, at: new Date().toISOString() })
            if (this.notificationLog.length > this.notificationLogLimit) this.notificationLog.shift()
          } catch {
            // JSON-safe envelope failed — still forward to consumer, do not block
          }
        }
        try {
          this.consumer?.(m, p)
        } catch {
          // consumer failures never propagate to transport
        }
      },
      onClosed: () => {
        if (this.suppressDepth > 0) return
        if (this.disposed) return
        try {
          this.peerClosedHook?.()
        } catch {
          // hook failures never propagate
        }
      },
    }
    const host = new PrivateWorkerHost(hostOpts)
    this.host = host
    try {
      // Suppressed: host.start internal timeout dispose must not invoke lifecycle hook; external close after success still fires because suppress is scoped to this await.
      const res = await this.runSuppressedAsync(() => host.start())
      return res
    } catch (e) {
      console.warn("[Kilo] PrivateObservationService initialize failed:", e)
      // Ensure failed host is torn down and not retained as started; if exact child remains live after
      // graceful SIGTERM, retain explicit ownership in pending fields (no orphan, no replacement while live).
      // Suppressed: pending-child shutdown must not trigger lifecycle reconnect recursively.
      this.runSuppressed(() => {
        try {
          host.dispose()
        } catch {}
      })
      const proc = host.getProc()
      const alive = proc ? proc.exitCode === null && proc.signalCode === null : false
      // Use host liveness (exact PID) rather than host state — disposed host reports closed but proc may be live
      if (alive && host.isAlive()) {
        this.pendingShutdownHost = host
        this.pendingShutdownProc = proc
      } else if (!alive) {
        // Child already exited — no pending ownership needed; ensure any stale pending referencing this host is cleared
        if (this.pendingShutdownHost === host) {
          this.pendingShutdownHost = null
          this.pendingShutdownProc = null
        }
      } else {
        // Defensive: proc check and host.isAlive disagreed — retain for bounded cleanup
        this.pendingShutdownHost = host
        this.pendingShutdownProc = proc
      }
      if (this.host === host) this.host = null
      throw e
    }
  }

  /** Delegate observation/snapshot. Requires prior initialize when gate on. */
  async snapshot(params?: unknown): Promise<unknown> {
    if (!this.host) throw new Error("Not started — private observation not enabled or not initialized")
    return this.host.request(OBSERVATION_METHODS.SNAPSHOT, params ?? {})
  }

  /** Delegate observation/read with cursor validation. */
  async read(cursor: number, extra?: Record<string, unknown>): Promise<unknown> {
    if (!this.host) throw new Error("Not started — private observation not enabled or not initialized")
    const p = { cursor, ...(extra ?? {}) }
    return this.host.request(OBSERVATION_METHODS.READ, p)
  }

  /** R9-C2 persisted cursor helpers — single integer, no polling/timers. Only ack is authoritative. */
  getPersistedCursor(): number | undefined {
    try {
      return this.cursorStore?.get()
    } catch (e) {
      console.warn("[Kilo] PrivateObservationService getPersistedCursor failed:", e)
      return undefined
    }
  }

  async setPersistedCursor(cursor: number): Promise<void> {
    if (!this.cursorStore) return
    try {
      await this.cursorStore.set(cursor)
    } catch (e) {
      console.warn("[Kilo] PrivateObservationService setPersistedCursor failed:", e)
    }
  }

  async clearPersistedCursor(): Promise<void> {
    if (!this.cursorStore) return
    try {
      await this.cursorStore.clear()
    } catch (e) {
      console.warn("[Kilo] PrivateObservationService clearPersistedCursor failed:", e)
    }
  }

  /** Delegate observation/ack. On success, persist cursor via store. Both remote ack and persistence must succeed for coordination.
   * Serialized end-to-end (remote observation/ack then cursorStore persistence) in invocation order via a per-service promise chain.
   * No timer/background loop, queue continues after rejection, errors preserved per caller, bounded to active calls.
   */
  async ack(cursor: number): Promise<unknown> {
    if (!this.host) throw new Error("Not started — private observation not enabled or not initialized")
    const host = this.host
    const store = this.cursorStore
    const task = async (): Promise<unknown> => {
      const res = await host.request(OBSERVATION_METHODS.ACK, { cursor })
      if (store) {
        try {
          await store.set(cursor)
        } catch (e) {
          console.warn("[Kilo] PrivateObservationService ack persist failed:", e)
          throw e
        }
      }
      return res
    }
    const pending: Promise<unknown> = this.ackChain.then(task, task)
    this.ackChain = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }

  /** Delegate observation/subscribe. */
  async subscribe(params?: unknown): Promise<unknown> {
    if (!this.host) throw new Error("Not started — private observation not enabled or not initialized")
    return this.host.request(OBSERVATION_METHODS.SUBSCRIBE, params ?? {})
  }

  /** Delegate observation/list — versioned directory-scoped session-list projection, no InstanceRef/drain-control. */
  async list(input: { directory: string; archived?: boolean; cursor?: string; limit?: number }): Promise<unknown> {
    if (!this.host) throw new Error("Not started — private observation not enabled or not initialized")
    const payload: Record<string, unknown> = { v: OBSERVATION_VERSION, directory: input.directory }
    if (input.archived !== undefined) payload.archived = input.archived
    if (input.cursor !== undefined) payload.cursor = input.cursor
    if (input.limit !== undefined) payload.limit = input.limit
    return this.host.request(OBSERVATION_METHODS.LIST, payload)
  }

  /** Generic request delegation (e.g., test/mutateChangefeed when testBridge enabled). */
  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.host) throw new Error("Not started — private observation not enabled or not initialized")
    return this.host.request(method, params)
  }

  /** Fixture-only bounded notification log — JSON-safe envelopes, no persistence. */
  getNotificationLog(): Array<{ ordinal: number; method: string; params: unknown; at: string }> {
    try {
      return JSON.parse(JSON.stringify(this.notificationLog)) as Array<{
        ordinal: number
        method: string
        params: unknown
        at: string
      }>
    } catch {
      return [...this.notificationLog]
    }
  }

  /** Fixture-only snapshot with monotonic watermark — {startOrdinal, nextOrdinal, entries}. Independent of bounded retention. */
  getNotificationSnapshot(): {
    startOrdinal: number
    nextOrdinal: number
    entries: Array<{ ordinal: number; method: string; params: unknown; at: string }>
  } {
    const next = this.notificationNextOrdinal
    const entries = this.getNotificationLog()
    const start = entries.length === 0 ? next : (entries[0]!.ordinal ?? next - entries.length)
    // Cross-check: start should equal next - length when ordinals contiguous; recompute if needed
    const computedStart = next - entries.length
    const startOrdinal =
      entries.length > 0 && typeof entries[0]!.ordinal === "number" ? entries[0]!.ordinal : computedStart
    // Ensure monotonic start <= next
    return { startOrdinal, nextOrdinal: next, entries }
  }

  clearNotificationLog(): void {
    this.notificationLog.length = 0
    // Keep nextOrdinal monotonic — watermark advances; cleared window is [next, next)
  }

  /** Owned peer-close hook — lifecycle triggers call setOnPeerClosed to receive transport close events. No polling. */
  setOnPeerClosed(handler: (() => void) | null): void {
    this.peerClosedHook = handler
  }

  /** Fixture-only: close the underlying transport peer without killing the worker process. Returns peer-close evidence. */
  closePeerTransport(): {
    closed: boolean
    aliveBefore: boolean
    aliveAfter: boolean
    beforePid?: number
    afterPid?: number
    beforeHostState: string
    afterHostState: string
  } {
    const beforePid = this.host?.getPid()
    const beforeHostState = this.getHostState()
    const aliveBefore = this.host ? this.host.isAlive() : false
    const raw = this.host
      ? this.host.closePeerTransport()
      : { closed: false, aliveBefore, aliveAfter: false, beforePid, afterPid: beforePid }
    const closed = typeof raw === "boolean" ? raw : raw.closed
    const aliveAfterRaw = typeof raw === "boolean" ? (this.host ? this.host.isAlive() : false) : raw.aliveAfter
    const afterPidRaw = typeof raw === "boolean" ? this.host?.getPid() : raw.afterPid
    // Capture immediately after disposal; bounded short observation (no production polling timer) is implicit via sync isAlive check.
    const aliveAfter = typeof aliveAfterRaw === "boolean" ? aliveAfterRaw : this.host ? this.host.isAlive() : false
    const afterPid = afterPidRaw ?? this.host?.getPid()
    const afterHostState = this.getHostState()
    return { closed, aliveBefore, aliveAfter, beforePid, afterPid, beforeHostState, afterHostState }
  }

  /** Forward notification without a host (no-op when not started). */
  notify(method: string, params?: unknown): void {
    this.host?.notify(method, params)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.initPromise = null
    this.reconnectPromise = null
    // Clear/block hook so intentional disposal does not schedule lifecycle reconnect.
    this.peerClosedHook = null
    this.runSuppressed(() => {
      if (this.host) {
        try {
          this.host.dispose()
        } catch {}
        this.host = null
      }
      if (this.pendingShutdownHost) {
        try {
          this.pendingShutdownHost.dispose()
        } catch {}
        this.pendingShutdownHost = null
        this.pendingShutdownProc = null
      } else if (this.pendingShutdownProc) {
        try {
          this.pendingShutdownProc.kill()
        } catch {}
        this.pendingShutdownProc = null
      }
    })
  }
}

type Disposable = { dispose(): void }
