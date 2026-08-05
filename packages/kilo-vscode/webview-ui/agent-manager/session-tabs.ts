/**
 * Session tab registry for Agent Manager.
 *
 * Pure immutable functions operating on opaque string session IDs.
 * No parentID inspection, no pending-tab concept.
 */

import { reorderTabs, moveTab } from "../src/utils/tab-order"

export interface SessionTabState {
  readonly ids: readonly string[]
  readonly active: string | undefined
}

const unique = (ids: readonly string[]) => [...new Set(ids)]

/** Seed/deduplicate ordered IDs with optional active ID. Empty input → empty state. */
export function seedTabs(ids: readonly string[], active?: string): SessionTabState {
  const deduped = unique(ids)
  const safe = active !== undefined && deduped.includes(active) ? active : deduped.length > 0 ? deduped[0] : undefined
  return { ids: deduped, active: safe }
}

/** Open or focus a non-empty session ID. Appends if missing, focuses if present. */
export function openTab(state: SessionTabState, id: string): SessionTabState {
  if (!id) return state
  if (state.ids.includes(id)) return { ids: state.ids, active: id }
  return { ids: [...state.ids, id], active: id }
}

/**
 * Open or focus a session immediately after its source session.
 * Focuses an already-open ID without reordering; appends when the
 * source is missing or undefined (same as openTab).
 */
export function openTabAfter(state: SessionTabState, source: string | undefined, id: string): SessionTabState {
  if (!id) return state
  if (state.ids.includes(id)) return { ids: state.ids, active: id }
  if (!source) return openTab(state, id)
  const index = state.ids.indexOf(source)
  if (index === -1) return openTab(state, id)
  const ids = [...state.ids]
  ids.splice(index + 1, 0, id)
  return { ids, active: id }
}

/** Select an existing ID safely. No-op if the ID is not in the list. */
export function selectTab(state: SessionTabState, id: string): SessionTabState {
  if (!state.ids.includes(id)) return state
  return { ids: state.ids, active: id }
}

/** Compute the next active ID after closing `id` at `index`. */
function adjacentFallback(ids: readonly string[], index: number): string | undefined {
  const remaining = ids.filter((_, i) => i !== index)
  return remaining.length > 0 ? remaining[Math.min(index, remaining.length - 1)] : undefined
}

/**
 * Close a tab with deterministic adjacent fallback.
 * Returns the state unchanged if the ID is not present.
 */
export function closeTab(state: SessionTabState, id: string): SessionTabState {
  const index = state.ids.indexOf(id)
  if (index === -1) return state
  const remaining = state.ids.filter((t) => t !== id)
  if (state.active !== id) return { ids: remaining, active: state.active }
  return { ids: remaining, active: adjacentFallback(state.ids, index) }
}

/**
 * Close all tabs except the specified one.
 * Returns the state unchanged if the ID is not present.
 */
export function closeOtherTabs(state: SessionTabState, id: string): SessionTabState {
  if (!state.ids.includes(id)) return state
  return { ids: [id], active: id }
}

/**
 * Reorder tabs (drag-and-drop) while preserving the active tab.
 * Uses the shared reorderTabs primitive from tab-order.
 */
export function reorderTab(state: SessionTabState, from: string, to: string): SessionTabState {
  const next = reorderTabs(state.ids, from, to)
  return next ? { ids: next, active: state.active } : state
}

/**
 * Move a tab by offset while preserving the active tab.
 * Uses the shared moveTab primitive from tab-order.
 */
export function moveTabBy(state: SessionTabState, id: string, offset: -1 | 1): SessionTabState {
  const next = moveTab(state.ids, id, offset)
  return next ? { ids: next, active: state.active } : state
}

/**
 * Merge legacy root IDs without evicting already-open IDs.
 * Appends any IDs from `incoming` that are not yet present.
 * The active tab is preserved; order of existing IDs is preserved.
 * Use case: seeding from a legacy root-only inventory.
 */
export function mergeTabs(state: SessionTabState, incoming: readonly string[]): SessionTabState {
  const existing = new Set(state.ids)
  const additions = incoming.filter((id) => id && !existing.has(id))
  if (additions.length === 0) return state
  return { ids: [...state.ids, ...additions], active: state.active }
}

/**
 * Partial session inventory refresh — add new IDs, never implicitly remove open IDs.
 * Appends any IDs from `available` that are not yet present.
 * Semantically identical to mergeTabs; named differently to signal the
 * "refresh from partial server response" use case.
 */
export function refreshTabs(state: SessionTabState, available: readonly string[]): SessionTabState {
  return mergeTabs(state, available)
}

/**
 * Remove a tab on explicit session deletion.
 * Identical to closeTab — separated for semantic clarity
 * (explicit deletion vs user-initiated close).
 */
export function removeTab(state: SessionTabState, id: string): SessionTabState {
  return closeTab(state, id)
}
