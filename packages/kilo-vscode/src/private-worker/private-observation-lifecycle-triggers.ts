/**
 * R9-C3 extension lifecycle triggers for private observation.
 *
 * Additive, gated, no polling, no Failure/Outcome wiring, no DB migration,
 * no protocol/storage change. Still gate-off (enabled:false) so HTTP/SSE
 * remains carrier.
 *
 * Core: vscode-free, single debounce timer (setTimeout once per burst,
 * trailing coalesce, ~150ms), singleflight promise for trigger(reason).
 * - Gate check: if (!service.isEnabled()) return undefined (no host spawn, no lease).
 * - Else: await service.reconnect() (bounded exact-PID, handles peer closed)
 *         then await service.read(persistedCursor) when cursor defined and
 *         surface rehydrate:true/false. Do not fabricate UI mutation.
 * - Coalesce rapid 5x flap in 100ms into 1 call via trailing debounce.
 * - Each entrypoint shares same debounced promise, idempotent, clear timer on dispose.
 *
 * Adapter: thin vscode wiring via static wireVscode(service, context).
 * - Registers window.onDidChangeWindowState, workspace.onDidChangeConfiguration (filtered),
 *   and AgentManagerProvider.onPanelVisibilityChange when available, via context.subscriptions.
 * - Core remains import-free of vscode for unit testability (type-only import).
 *
 * Choice: debounce is TRAILING (not leading) ~150ms — the last reason in the
 * burst wins and one execution follows the quiet period. Documented per spec.
 * Peer-closed is an explicit onPeerClosed() entrypoint; no additive HostOptions.onClosed
 * emitter is introduced — trigger relies on explicit caller (or host-state polling)
 * to avoid altering existing host/peer start/shutdown behaviour. Minimal and additive.
 *
 * No setInterval, no background timer beyond single debounce timeout and existing
 * bounded 300/500ms reconnect retry, no second store, no selector/readiness change.
 */

import type * as vscode from "vscode"
import type { PrivateObservationService } from "./private-observation-service"

export type TriggerResult = {
  reason: string
  reconnectResult: unknown
  readResult?: unknown
  rehydrate?: boolean
}

export class PrivateObservationLifecycleTriggers implements vscode.Disposable {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: Promise<TriggerResult | undefined> | null = null
  private pendingResolve: ((v: TriggerResult | undefined) => void) | null = null
  private pendingReject: ((e: unknown) => void) | null = null
  private pendingReason: string | null = null
  private inflight: Promise<TriggerResult | undefined> | null = null
  private disposed = false
  private readonly debounceMs: number

  constructor(
    private readonly service: PrivateObservationService,
    opts?: { debounceMs?: number },
  ) {
    this.debounceMs = opts?.debounceMs ?? 150
  }

  /** Explicit debounced entrypoint — coalesced, singleflight, trailing. */
  trigger(reason: string): Promise<TriggerResult | undefined> {
    return this.schedule(reason)
  }

  onPanelVisibilityChanged(visible: boolean): Promise<TriggerResult | undefined> {
    return this.schedule(`panel:${visible ? "visible" : "hidden"}`)
  }

  onWindowStateChanged(focused: boolean): Promise<TriggerResult | undefined> {
    return this.schedule(`window:${focused ? "focused" : "blurred"}`)
  }

  onConfigChanged(_e?: unknown): Promise<TriggerResult | undefined> {
    return this.schedule("config:changed")
  }

  onActiveSessionChanged(id: string): Promise<TriggerResult | undefined> {
    return this.schedule(`session:${id}`)
  }

  onPeerClosed(): Promise<TriggerResult | undefined> {
    return this.schedule("peer:closed")
  }

  /** Expose pending/inflight state for tests (no production use). */
  _testHasTimer(): boolean {
    return this.timer !== null
  }

  private schedule(reason: string): Promise<TriggerResult | undefined> {
    if (this.disposed) return Promise.resolve(undefined)
    // Gate-off fast path: still respect debounce coalescence but never spawn host.
    // If inflight exists, coalesce into pending for next burst after inflight settles.
    // Do NOT arm timer while inflight is active — defer until inflight settles to avoid
    // concurrent flush overwriting inflight and lease contention.
    if (this.inflight) {
      if (this.pending) {
        this.pendingReason = reason
        return this.pending
      }
      // No pending yet — queue trailing coalesced run; timer will be armed in finally after inflight=null.
      this.pendingReason = reason
      this.pending = new Promise<TriggerResult | undefined>((resolve, reject) => {
        this.pendingResolve = resolve
        this.pendingReject = reject
      })
      void this.pending.catch(() => {})
      return this.pending
    }
    if (this.pending) {
      this.pendingReason = reason
      return this.pending
    }
    this.pendingReason = reason
    this.pending = new Promise<TriggerResult | undefined>((resolve, reject) => {
      this.pendingResolve = resolve
      this.pendingReject = reject
    })
    // Attach rejection handler to avoid unhandled rejection when dispose clears timer
    void this.pending.catch(() => {})
    this.timer = setTimeout(() => void this.flush(), this.debounceMs)
    if ((this.timer as unknown as { unref?: () => void })?.unref) {
      ;(this.timer as unknown as { unref: () => void }).unref()
    }
    return this.pending
  }

  private async flush(): Promise<void> {
    if (this.disposed) {
      this.clearPending(undefined)
      return
    }
    if (this.inflight) {
      // Gate: do not run concurrently — defer trailing burst until inflight settles.
      // Timer that fired (if any) is now consumed; clear stale reference before re-arm.
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = null
      }
      if (this.pending && !this.disposed) {
        this.timer = setTimeout(() => void this.flush(), this.debounceMs)
        if ((this.timer as unknown as { unref?: () => void })?.unref) {
          ;(this.timer as unknown as { unref: () => void }).unref()
        }
      }
      return
    }
    const reason = this.pendingReason ?? "unknown"
    const resolve = this.pendingResolve
    const reject = this.pendingReject
    // Transfer pending to inflight
    const pendingPromise = this.pending
    this.pending = null
    this.pendingResolve = null
    this.pendingReject = null
    this.pendingReason = null
    this.timer = null
    if (!resolve || !reject || !pendingPromise) return

    // Gate check — no host spawn, no lease, no read when disabled
    if (!this.service.isEnabled()) {
      resolve(undefined)
      return
    }

    const exec: Promise<TriggerResult | undefined> = (async (): Promise<TriggerResult | undefined> => {
      try {
        const reconnectResult = await this.service.reconnect()
        let readResult: unknown = undefined
        let rehydrate: boolean | undefined = undefined
        try {
          const c = this.service.getPersistedCursor()
          if (c !== undefined) {
            readResult = await this.service.read(c)
            const r = readResult as { rehydrate?: boolean }
            if (r && typeof r.rehydrate === "boolean") rehydrate = r.rehydrate
          }
        } catch (e) {
          // read failures are surfaced via readResult undefined; reconnect still succeeded
          console.warn("[Kilo] PrivateObservationLifecycleTriggers read failed:", e)
        }
        const out: TriggerResult = { reason, reconnectResult, readResult, rehydrate }
        return out
      } catch (e) {
        throw e
      }
    })()

    this.inflight = exec
    // Ensure pending callers sharing this exec don't get unhandled
    void exec.catch(() => {})
    try {
      const v = await exec
      resolve(v)
    } catch (e) {
      reject(e)
    } finally {
      this.inflight = null
      // Deferred timer: if pending was queued during inflight, arm trailing debounce now.
      if (this.pending && !this.timer && !this.disposed) {
        this.timer = setTimeout(() => void this.flush(), this.debounceMs)
        if ((this.timer as unknown as { unref?: () => void })?.unref) {
          ;(this.timer as unknown as { unref: () => void }).unref()
        }
      }
    }
  }

  private clearPending(value: undefined): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pendingResolve) {
      // Intentional no-op resolve on dispose/cancel — callers receive undefined, not an error.
      this.pendingResolve(value)
    }
    this.pending = null
    this.pendingResolve = null
    this.pendingReject = null
    this.pendingReason = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pendingResolve) {
      // Intentional no-op resolve on dispose — trailing debounce coalescence is cancelled, not failed.
      this.pendingResolve(undefined)
    }
    this.pending = null
    this.pendingResolve = null
    this.pendingReject = null
    this.pendingReason = null
    this.inflight = null
  }

  /**
   * Thin vscode adapter — registers real vscode listeners and pushes disposables
   * to context.subscriptions. Keeps core import-free (type-only) for testability.
   *
   * Registers:
   * - window.onDidChangeWindowState -> onWindowStateChanged(focused)
   * - workspace.onDidChangeConfiguration (filtered to kilo.* and relevant config) -> onConfigChanged(e)
   * - AgentManagerProvider.onPanelVisibilityChange when provider supplied -> onPanelVisibilityChanged(visible)
   *
   * All registrations are additive and disposed via context.subscriptions.
   * No polling, no auto-initialize, no Failure/Outcome wiring.
   */
  static wireVscode(
    service: PrivateObservationService,
    context: vscode.ExtensionContext,
    opts?: {
      agentManagerProvider?: { onPanelVisibilityChange: (cb: (visible: boolean) => void) => void }
      debounceMs?: number
    },
  ): PrivateObservationLifecycleTriggers {
    const triggers = new PrivateObservationLifecycleTriggers(service, { debounceMs: opts?.debounceMs ?? 150 })
    // Lazy import vscode at runtime — keeps core testable without VS Code host.
    // Use dynamic require to avoid bundling dependency in unit tests.
    let vscodeApi: typeof vscode | undefined
    try {
      vscodeApi = require("vscode") as typeof vscode
    } catch {
      vscodeApi = undefined
    }
    if (vscodeApi) {
      const d1 = vscodeApi.window.onDidChangeWindowState((e) => {
        void triggers.onWindowStateChanged(e.focused)
      })
      const d2 = vscodeApi.workspace.onDidChangeConfiguration((e) => {
        // Filtered: only kilo-relevant config triggers coalesced observation gap handling.
        // Keep check lightweight and do not fabricate UI mutation.
        const relevant =
          e.affectsConfiguration("kilo") ||
          e.affectsConfiguration("kilocode") ||
          e.affectsConfiguration("kilo-code")
        if (!relevant) return
        void triggers.onConfigChanged(e)
      })
      context.subscriptions.push(d1, d2)
    }
    if (opts?.agentManagerProvider) {
      const maybe = opts.agentManagerProvider as { onPanelVisibilityChange?: (cb: (visible: boolean) => void) => void }
      if (typeof maybe.onPanelVisibilityChange === "function") {
        const disp = {
          dispose: () => {
            // No direct unsub hook from provider — timer cleanup covers it.
            // Provider's onPanelVisibilityChange stores single callback; clearing via dispose is best-effort.
          },
        } as vscode.Disposable
        maybe.onPanelVisibilityChange((visible: boolean) => {
          void triggers.onPanelVisibilityChanged(visible)
        })
        context.subscriptions.push(disp)
      }
    }
    // No polling, no extra timers beyond single debounce.
    return triggers
  }
}
