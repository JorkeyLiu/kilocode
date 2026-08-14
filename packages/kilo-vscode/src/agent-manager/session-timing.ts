/**
 * Cumulative active-generation runtime tracking for Agent Manager sessions.
 *
 * Pure (vscode-free) module. Owns the durable per-session timing state and
 * applies status transitions; the VS Code adapter supplies a workspaceState-
 * backed store through the Host boundary (host.ts `Store`).
 *
 * Semantics:
 * - Time accumulates only while a session is in a non-idle status (busy,
 *   retry, offline). Idle settles the running segment and stops the clock.
 * - Duplicate non-idle and duplicate idle events are idempotent: they never
 *   reset the active segment and never double-count elapsed time.
 * - Persistence happens on status boundaries, never per display tick.
 *   `settle()` finalizes every active segment and awaits durable writes so a
 *   normal extension shutdown does not count later downtime.
 *
 * Residual risk (documented): after an abnormal crash, a persisted entry may
 * still carry an `activeStart` marker with no matching settle event. The
 * backend supplies no start timestamp, so that stale marker is preserved
 * conservatively; the segment keeps counting from the stale marker until the
 * next status event settles it.
 */

import type { Store } from "./host"

/** Per-session cumulative runtime record, persisted across restarts. */
export interface SessionTimingEntry {
  /** Settled milliseconds across all completed active segments. */
  elapsedMs: number
  /** Epoch ms when the current active segment started; absent when idle/settled. */
  activeStart?: number
}

/** All persisted per-session timing entries, keyed by sessionID. */
export type SessionTimingMap = Record<string, SessionTimingEntry>

/** Versioned storage key — bump only with a migration for the old shape. */
export const TIMING_KEY = "kilo.agentManager.sessionTiming.v1"

const ACTIVE = new Set(["busy", "retry", "offline"])

/** True when a session status keeps the cumulative clock running. */
export function isActiveStatus(status: string): boolean {
  return ACTIVE.has(status)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isEntry(value: unknown): value is SessionTimingEntry {
  return (
    isRecord(value) &&
    typeof value.elapsedMs === "number" &&
    value.elapsedMs >= 0 &&
    (value.activeStart === undefined || typeof value.activeStart === "number")
  )
}

export class SessionTiming {
  private readonly map = new Map<string, SessionTimingEntry>()
  private pending: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {
    this.load()
  }

  /** Read persisted state, skipping entries that do not match the current shape. */
  private load(): void {
    const raw = this.store.get<unknown>(TIMING_KEY)
    if (!isRecord(raw)) return
    for (const [sid, entry] of Object.entries(raw)) {
      if (!isEntry(entry)) continue
      this.map.set(sid, {
        elapsedMs: entry.elapsedMs,
        ...(entry.activeStart !== undefined && { activeStart: entry.activeStart }),
      })
    }
  }

  /** Plain snapshot for state pushes and persistence. */
  snapshot(): SessionTimingMap {
    const out: SessionTimingMap = {}
    for (const [sid, entry] of this.map) {
      out[sid] = {
        elapsedMs: entry.elapsedMs,
        ...(entry.activeStart !== undefined && { activeStart: entry.activeStart }),
      }
    }
    return out
  }

  /**
   * Apply a session status event. Idempotent: repeated non-idle events do not
   * restart the segment, and repeated idle events do not double-settle.
   *
   * Returns `true` when the transition changed timing state (and persisted);
   * `false` for duplicate or no-op events that changed nothing, so callers can
   * skip redundant state pushes.
   */
  onStatus(sid: string, status: string): boolean {
    if (isActiveStatus(status)) {
      const prev = this.map.get(sid)
      if (prev?.activeStart !== undefined) return false
      this.map.set(sid, { elapsedMs: prev?.elapsedMs ?? 0, activeStart: this.now() })
      this.persist()
      return true
    }
    const prev = this.map.get(sid)
    if (!prev || prev.activeStart === undefined) return false
    const elapsedMs = prev.elapsedMs + Math.max(0, this.now() - prev.activeStart)
    this.map.set(sid, { elapsedMs })
    this.persist()
    return true
  }

  /** Remove a session's timing state (explicit forget or backend delete). */
  forget(sid: string): void {
    if (!this.map.delete(sid)) return
    this.persist()
  }

  /**
   * Settle every active segment and await durable writes. Called on normal
   * extension shutdown so later downtime is never counted as runtime.
   */
  async settle(): Promise<void> {
    const now = this.now()
    let changed = false
    for (const [sid, entry] of this.map) {
      if (entry.activeStart === undefined) continue
      this.map.set(sid, { elapsedMs: entry.elapsedMs + Math.max(0, now - entry.activeStart) })
      changed = true
    }
    if (changed) this.persist()
    await this.pending
  }

  /** Await in-flight durable writes (teardown/test aid). */
  wait(): Promise<void> {
    return this.pending
  }

  private persist(): void {
    this.pending = this.pending
      .then(() => this.store.update(TIMING_KEY, this.snapshot()))
      .catch((err) => {
        console.warn("[Kilo New] Failed to persist session timing:", err)
      })
  }
}
