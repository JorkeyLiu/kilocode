import { isAbsolute } from "path"
import { PrivateWorkerHost, type HostOptions } from "./host"
import { OBSERVATION_METHODS } from "./observation"

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
}

export function isPrivateObservationGateEnabled(opts: PrivateObservationServiceOptions): boolean {
  return opts.enabled === true && typeof opts.dbPath === "string" && isAbsolute(opts.dbPath)
}

export class PrivateObservationService implements Disposable {
  private host: PrivateWorkerHost | null = null
  private initPromise: Promise<unknown> | null = null
  private disposed = false
  private readonly consumer: ((method: string, params: unknown) => void) | undefined
  private readonly opts: PrivateObservationServiceOptions

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
        "initializeTimeoutMs" in (contextOrOpts as Record<string, unknown>))
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
   * Returns initialize result when gate on, undefined when gate off.
   */
  async initialize(): Promise<unknown> {
    if (this.disposed) throw new Error("Service disposed")
    if (!this.isEnabled()) return undefined
    if (this.host && this.host.getState() === "open") return undefined
    if (this.initPromise) return this.initPromise
    this.initPromise = this.doInitialize()
    try {
      return await this.initPromise
    } finally {
      this.initPromise = null
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

  /** Delegate observation/ack. */
  async ack(cursor: number): Promise<unknown> {
    if (!this.host) throw new Error("Not started — private observation not enabled or not initialized")
    return this.host.request(OBSERVATION_METHODS.ACK, { cursor })
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
    if (this.host) {
      try {
        this.host.dispose()
      } catch {}
      this.host = null
    }
  }
}

type Disposable = { dispose(): void }
