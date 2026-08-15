import type { SessionStatus } from "../../types/messages"
import type { SessionTimingEntry } from "../../types/messages"

export function tracksElapsed(status: SessionStatus, submitting: boolean, since: number | undefined): since is number {
  return since !== undefined && (status !== "idle" || submitting)
}

/**
 * True when the Agent Manager snapshot has a still-running segment. Such a
 * snapshot alone is enough to render and tick the indicator after a panel
 * reopen, even before webview-local status/busySince is reseeded. It also
 * covers a conservatively preserved stale marker after an abnormal crash.
 */
export function hasActiveSegment(snap: SessionTimingEntry | undefined): boolean {
  return snap?.activeStart !== undefined
}

/**
 * True when the elapsed counter should keep ticking: the session is locally
 * active/submitting, or the Agent Manager snapshot has a running segment or a
 * settled cumulative total worth displaying.
 */
export function tracksElapsedMs(
  status: SessionStatus,
  submitting: boolean,
  since: number | undefined,
  snap: SessionTimingEntry | undefined,
): boolean {
  return tracksElapsed(status, submitting, since) || showIdleCumulative(snap) || hasActiveSegment(snap)
}

/**
 * Outer gate: whether the working indicator renders at all. A submitting
 * session, a locally active unblocked session, a settled cumulative total, or
 * a running snapshot segment all keep it visible.
 */
export function showWorkingIndicator(
  submitting: boolean,
  status: SessionStatus,
  blocked: boolean,
  snap: SessionTimingEntry | undefined,
): boolean {
  return submitting || (status !== "idle" && !blocked) || showIdleCumulative(snap) || hasActiveSegment(snap)
}

/**
 * Inner gate: whether the spinner and status text render, versus a bare static
 * total. Submission feedback always wins over an idle settled cumulative so a
 * follow-up prompt is immediately visible (LOCK-003).
 */
export function showSpinner(snap: SessionTimingEntry | undefined, submitting: boolean): boolean {
  return !showIdleCumulative(snap) || submitting
}

/**
 * Cumulative elapsed seconds in ms for the current session, at the given `now`.
 * Prefers the Agent Manager extension snapshot when present (settled `elapsedMs`
 * plus the still-running segment from `activeStart`); otherwise falls back to the
 * legacy `since` timestamp used by the editor-tab webviews.
 */
export function cumulativeElapsedMs(
  snap: SessionTimingEntry | undefined,
  since: number | undefined,
  now: number,
): number {
  if (snap) return snap.elapsedMs + (snap.activeStart !== undefined ? Math.max(0, now - snap.activeStart) : 0)
  return since !== undefined ? Math.max(0, now - since) : 0
}

/**
 * True when a settled Agent Manager snapshot should keep the indicator visible
 * while the session is idle, showing the persisted final cumulative duration.
 * Requires at least one displayable second (sub-second totals never rendered an
 * elapsed label during activity either).
 */
export function showIdleCumulative(snap: SessionTimingEntry | undefined): boolean {
  return snap !== undefined && snap.activeStart === undefined && snap.elapsedMs >= 1000
}

/**
 * Compact English elapsed-time label, matching the existing `Xm Ys` style:
 * under one minute renders seconds only; under one hour renders `Xm Ys`; one
 * hour or more renders `Xh Ym Zs`. Components are always explicit down to the
 * seconds, consistent with the existing `1m 0s` (never collapsed) form.
 */
export function formatElapsedSeconds(total: number): string {
  if (total < 60) return `${total}s`
  const h = Math.floor(total / 3600)
  if (h < 1) {
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${m}m ${s}s`
  }
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${h}h ${m}m ${s}s`
}
