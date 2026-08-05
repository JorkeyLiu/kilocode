/**
 * Canonical open-session transaction for Agent Manager.
 *
 * Single entry point for ordinary session navigation:
 *   1. Tab registry add-or-focus in the given UI context
 *   2. Set active session/tab
 *   3. Clear history/terminal/review/pending overlays
 *   4. Call session.selectSession(id)
 *
 * No parent/root classification, no managed ownership mutation,
 * no directory inheritance, no read-only path.
 */

import type { createSessionTabManager } from "./session-tab-manager"
import { LOCAL } from "./navigate"

export interface OpenSessionDeps {
  tabMgr: ReturnType<typeof createSessionTabManager>
  selectSession: (id: string) => void
  setActivePendingId: (id: string | undefined) => void
  setHistory: (v: boolean) => void
  setReviewActive: (v: boolean) => void
  setTermsActiveId: (id: string | undefined) => void
  setSelection: (sel: string) => void
  isPending: (id: string) => boolean
  /** Ensure the session ID is tracked in localSessionIDs and tab order. */
  ensureLocal: (id: string) => void
}

/**
 * Source-relative child-open deps: the caller provides a helper that keeps the
 * local session inventory and persisted tab order consistent with the tab
 * registry (AgentManagerApp wires this to tabOrderSync.insertLocalAfter).
 */
export interface OpenChildSessionDeps extends OpenSessionDeps {
  /** Insert `id` after `source` in the local inventory and persisted tab order. */
  insertLocalAfter: (source: string | undefined, id: string) => void
}

/**
 * Canonical transaction to open/focus a session by ID.
 *
 * Single entry point for all ordinary Agent Manager session navigation:
 *   1. Tab registry add-or-focus in LOCAL UI context
 *   2. Set active session/tab
 *   3. Clear history/terminal/review/pending overlays
 *   4. Call session.selectSession(id)
 *
 * No parent/root classification, no managed ownership mutation,
 * no directory inheritance, no read-only path.
 *
 * Returns true if the transaction succeeded (id was non-empty).
 * Returns false if the id is empty/undefined — caller must NOT close
 * history on false.
 */
export function openSession(id: string, deps: OpenSessionDeps): boolean {
  if (!id) return false

  deps.setHistory(false)
  deps.setReviewActive(false)
  deps.setTermsActiveId(undefined)
  deps.setSelection(LOCAL)

  // Ensure the session is in the local inventory and tab order.
  if (!deps.isPending(id)) deps.ensureLocal(id)

  // Register in tab registry — add-or-focus semantics.
  deps.tabMgr.open(LOCAL, id)

  if (deps.isPending(id)) {
    deps.setActivePendingId(id)
  } else {
    deps.setActivePendingId(undefined)
    deps.selectSession(id)
  }

  return true
}

/**
 * Canonical transaction to open a related child session immediately to the
 * right of its source session (Agent Manager child task/tool-call open action).
 *
 * Same overlay-clearing and selection semantics as openSession, but the tab
 * placement is source-relative:
 *   1. localSessionIDs + persisted tabOrder updated via insertLocalAfter
 *   2. tab registry insert-after via tabMgr.openAfter
 *   3. clear history/terminal/review/pending overlays
 *   4. select the child session
 *
 * An already-open child is focused without reordering; a missing/unknown source
 * falls back to the append-or-focus behavior of openSession.
 */
export function openChildSession(id: string, source: string | undefined, deps: OpenChildSessionDeps): boolean {
  if (!id) return false

  deps.setHistory(false)
  deps.setReviewActive(false)
  deps.setTermsActiveId(undefined)
  deps.setSelection(LOCAL)

  // Keep inventory + persisted order + tab registry consistent before selection.
  if (!deps.isPending(id)) deps.insertLocalAfter(source, id)
  deps.tabMgr.openAfter(LOCAL, source, id)

  if (deps.isPending(id)) {
    deps.setActivePendingId(id)
  } else {
    deps.setActivePendingId(undefined)
    deps.selectSession(id)
  }

  return true
}
