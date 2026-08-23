import { isAbsolute } from "path"
import { PrivateWorkerHost, type HostOptions } from "./host"
import { OBSERVATION_METHODS } from "./observation"
import type { ObservationCursorStore } from "./observation-cursor-store"

/**
 * P4.2b additive production private-worker observation wiring.
 *
 * Extension-owned service that owns one PrivateWorkerHost lifecycle and
 * delegates observation snapshot/read/ack/subscribe requests over the
 * private JSON-RPC carrier. Additive, gated, reversible, and preserves
 * the HTTP/SSE migration bridge.
 *
 * Gate:
 *  - Explicit internal bootstrap gate, fail-closed, non-user-authored.
 *  - Enabled only when opts.enabled === true AND opts.dbPath is absolute.
 *  - No arbitrary user config/workspace/env overlay is consulted.
 *  - Default gate-off preserves current extension behavior (no host, no DB,
 *    no selector/readiness change, no second store per ADR-0005).
 *  - Gate-on creates a real PrivateWorkerHost with canonical leased DB
 *    (KILO_PRIVATE_WORKER_STANDALONE=1 + absolute KILO_DB) and delegates
 *    via leased Database.layerFromPath + createChangefeedDeps in the
 *    standalone worker.
 *
 * Notification boundary:
 *  - Private observation/changed notifications are forwarded through the
 *    injectable onNotification consumer. No webview operational facts are
 *    invented and no second persistence store is introduced. If no suitable
 *    consumer exists, only the internal service callback/request API is
 *    exposed and full UI convergence is a follow-up.
 *
 * Lifecycle:
 *  - One host per service instance. Explicit ownership, idempotent disposal.
 *  - Does not interrupt active generations.
 *  - No polling/timers, no Failure/Outcome/Recovery wiring, no selector
 *    changes, no schema changes.
 */

export interface PrivateObservationServiceOptions {
  /**
   * Internal bootstrap gate — explicit and fail-closed.
   * Must be true with an absolute dbPath to enable. Default false.
   */
  enabled?: boolean
  /** Canonical leased DB path for the private worker (ADR-0005). Must be absolute when enabled. */
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
    } else if (contextOrOpts !== null && typeof contextOrOpts === "object" && Object.keys(contextOrOpts as object).length === 0) {
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
    if (this.host && this.host.getState() === "open") return undefined
    if (this.initPromise) return this.initPromise
    if (this.reconnectPromise) return this.reconnectPromise
    this.initPromise = this.doInitialize()
    try {
      return await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  /**
   * R9-C1 bounded reconnect/reacquire.
   * Bounded, exact-PID shutdown: captures the old host, awaits its exit
   * via host.shutdown(2000) (exact child ownership, no global kills, bounded),
   * clears init state, and re-enters initialization with the same canonical
   * environment (KILO_PRIVATE_WORKER_STANDALONE=1 + absolute KILO_DB).
   * Fail-closed and idempotent: concurrent callers share the same promise,
   * gate-off returns undefined, disposed throws.
   * If an initialize is in-flight, reconnect awaits it to settle before
   * superseding (initialize promise is not cancelled — reconnect starts after).
   * No old worker can retain the DB lease when replacement initialization begins:
   * shutdown is awaited boundedly; if initialization still fails with live-PID
   * lease contention, a bounded retry (two attempts with 300ms/500ms backoff)
   * recovers without unbounded waits.
   */
  async reconnect(): Promise<unknown> {
    if (this.disposed) throw new Error("Service disposed")
    if (!this.isEnabled()) return undefined
    if (this.reconnectPromise) return this.reconnectPromise
    // If an initialize is in flight, let it settle — reconnect supersedes after.
    // Initialize's promise is awaited, not cancelled; reconnectPromise will be the sole
    // subsequent acquisition. Concurrent initialize callers during reconnect share reconnectPromise.
    if (this.initPromise) {
      try {
        await this.initPromise
      } catch {}
    }
    this.reconnectPromise = this.doReconnect()
    try {
      return await this.reconnectPromise
    } finally {
      this.reconnectPromise = null
    }
  }

  // eslint-disable-next-line complexity
  private async doReconnect(): Promise<unknown> {
    const old = this.host
    if (old) {
      this.host = null
      try {
        // Bounded awaitable shutdown — exact PID, no global kills, no unbounded wait.
        // If shutdown times out (still live), initialization retry below handles residual lease contention.
        await old.shutdown(2000)
      } catch {}
    }
    // Bounded lease-contention retry: if old worker's exit raced with new acquisition,
    // Database.layerFromPath will fail with "lease held by live PID". Retry boundedly.
    const attempt = async (): Promise<unknown> => {
      this.initPromise = this.doInitialize()
      try {
        return await this.initPromise
      } finally {
        this.initPromise = null
      }
    }
    try {
      return await attempt()
    } catch (e) {
      const msg = String((e as Error)?.message ?? "")
      const isLeaseContention =
        msg.includes("lease held") ||
        msg.includes("exclusivity") ||
        msg.includes("concurrent acquisition") ||
        msg.includes("DB lease") ||
        msg.includes("timed out") ||
        msg.includes("Peer closed") ||
        msg.includes("Not started")
      if (!isLeaseContention) throw e
      await new Promise((r) => setTimeout(r, 300))
      try {
        return await attempt()
      } catch (e2) {
        const msg2 = String((e2 as Error)?.message ?? "")
        const stillLease =
          msg2.includes("lease held") ||
          msg2.includes("exclusivity") ||
          msg2.includes("concurrent acquisition") ||
          msg2.includes("DB lease") ||
          msg2.includes("timed out") ||
          msg2.includes("Peer closed")
        if (!stillLease) throw e2
        await new Promise((r) => setTimeout(r, 500))
        return await attempt()
      }
    }
  }

  private async doInitialize(): Promise<unknown> {
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
      // Ensure failed host is torn down and not retained as started
      try {
        host.dispose()
      } catch {}
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
  }
}

type Disposable = { dispose(): void }
