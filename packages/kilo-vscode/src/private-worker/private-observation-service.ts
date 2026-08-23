import { isAbsolute } from "path"
import { PrivateWorkerHost, type HostOptions } from "./host"
import { OBSERVATION_METHODS } from "./observation"
import type { ObservationCursorStore } from "./observation-cursor-store"

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
  }

  /** Whether the internal gate is enabled (explicit, fail-closed). */
  isEnabled(): boolean {
    return isPrivateObservationGateEnabled(this.opts)
  }

  /** Whether the host has been started and is open. */
  isStarted(): boolean {
    return this.host !== null && this.host.getState() === "open"
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
        } catch {}
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
        ok = await old.shutdown(2000)
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
        try {
          this.consumer?.(m, p)
        } catch {
          // consumer failures never propagate to transport
        }
      },
    }
    const host = new PrivateWorkerHost(hostOpts)
    this.host = host
    try {
      const res = await host.start()
      return res
    } catch (e) {
      // Ensure failed host is torn down and not retained as started; if exact child remains live after
      // graceful SIGTERM, retain explicit ownership in pending fields (no orphan, no replacement while live).
      try {
        host.dispose()
      } catch {}
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

  /** Delegate observation/ack. On success, persist cursor via store (never throws to caller). */
  async ack(cursor: number): Promise<unknown> {
    if (!this.host) throw new Error("Not started — private observation not enabled or not initialized")
    const res = await this.host.request(OBSERVATION_METHODS.ACK, { cursor })
    if (this.cursorStore) {
      try {
        await this.cursorStore.set(cursor)
      } catch (e) {
        console.warn("[Kilo] PrivateObservationService ack persist failed:", e)
      }
    }
    return res
  }

  /** Delegate observation/subscribe. */
  async subscribe(params?: unknown): Promise<unknown> {
    if (!this.host) throw new Error("Not started — private observation not enabled or not initialized")
    return this.host.request(OBSERVATION_METHODS.SUBSCRIBE, params ?? {})
  }

  /** Generic request delegation (e.g., test/mutateChangefeed when testBridge enabled). */
  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.host) throw new Error("Not started — private observation not enabled or not initialized")
    return this.host.request(method, params)
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
  }
}

type Disposable = { dispose(): void }
