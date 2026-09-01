/**
 * Pure navigation logic for the agent manager sidebar.
 *
 * All session tabs live in one LOCAL context.
 *
 * Returns the action to take: select a session by ID, go to local, or do nothing.
 */

import { deriveTopics } from "./topics"
import { buildDisplayList, dateGroupKey, DATE_GROUP_KEYS } from "../src/utils/session-tree"

/** Sentinel value for the single LOCAL session tab context. */
export const LOCAL = "local" as const

type NavResult = { action: "select"; id: string } | { action: typeof LOCAL } | { action: "none" }

type SessionLike = { id: string; parentID?: string | null; createdAt: string; updatedAt: string }

export function resolveNavigation(direction: "up" | "down", current: string | undefined, ids: string[]): NavResult {
  // Determine current position: -1 = local, 0..N-1 = session index
  if (!current) {
    // On local
    if (direction === "up") return { action: "none" }
    if (ids.length === 0) return { action: "none" }
    return { action: "select", id: ids[0]! }
  }

  const idx = ids.indexOf(current)
  // Current session not found in list — don't navigate
  if (idx === -1) return { action: "none" }

  const next = direction === "up" ? idx - 1 : idx + 1

  // Moving up past the first session → go to local
  if (next === -1) return { action: LOCAL }

  // At the bottom boundary
  if (next >= ids.length) return { action: "none" }

  return { action: "select", id: ids[next]! }
}

/**
 * Validate a persisted local session ID against the current sessions list.
 * Returns the ID if it still exists, undefined otherwise.
 */
export function validateLocalSession(persisted: string | undefined, ids: string[]): string | undefined {
  if (!persisted) return undefined
  if (ids.indexOf(persisted) === -1) return undefined
  return persisted
}

/**
 * Tab navigation (including terminal and pending) — no wrap.
 * Returns the id of the adjacent tab or undefined at the boundary or when
 * current is missing/unknown.
 */
export function resolveTabNavigation(
  direction: "prev" | "next",
  current: string | undefined,
  ids: readonly string[],
): string | undefined {
  if (!current || ids.length === 0) return undefined
  const idx = ids.indexOf(current)
  if (idx === -1) return undefined
  if (direction === "prev") return idx > 0 ? ids[idx - 1] : undefined
  return idx < ids.length - 1 ? ids[idx + 1] : undefined
}

/**
 * Visible sidebar order — date-group rank (today → older) then activity
 * descending within each group, then depth-first member order per topic,
 * respecting the current expansion state. Only sessions whose ancestors are
 * expanded appear. Collapsed topic children are skipped, matching the actual
 * rendered DOM in SidebarSessionList. This is the single source of truth for
 * both rendering and keyboard navigation to prevent drift.
 */
export function visibleSidebarIds(sessions: SessionLike[], expanded: Set<string>): string[] {
  const topics = deriveTopics(sessions as Parameters<typeof deriveTopics>[0])
  const rank = new Map<string, number>(DATE_GROUP_KEYS.map((k, i) => [k, i] as const))
  const groups = new Map<string, typeof topics>()
  for (const tp of topics) {
    const key = dateGroupKey(tp.activity)
    const list = groups.get(key)
    if (list) list.push(tp)
    else groups.set(key, [tp])
  }
  const sorted = [...groups.entries()].sort((a, b) => (rank.get(a[0]) ?? 99) - (rank.get(b[0]) ?? 99))
  const order: string[] = []
  for (const [, list] of sorted) {
    for (const tp of list) {
      const display = buildDisplayList(tp.members, expanded)
      for (const item of display) order.push(item.session.id)
    }
  }
  return order
}

/**
 * Return the keybinding hint for an item adjacent to the active item.
 * Only returns a hint when the item is exactly one step away in the flat list.
 * Returns empty string for non-adjacent items or the active item itself.
 *
 * @param itemId  - The item being hovered
 * @param activeId - The currently selected/active item (or undefined for LOCAL)
 * @param flatIds - The full ordered sidebar list (LOCAL first, then sessions)
 * @param prev    - Display string for "go up" (e.g. "⌘↑" or keybinding)
 * @param next    - Display string for "go down" (e.g. "⌘↓" or keybinding)
 */
export function adjacentHint(
  itemId: string,
  activeId: string | undefined,
  flatIds: string[],
  prev: string,
  next: string,
): string {
  if (!activeId || itemId === activeId) return ""
  const activeIdx = flatIds.indexOf(activeId)
  const itemIdx = flatIds.indexOf(itemId)
  if (activeIdx === -1 || itemIdx === -1) return ""
  const diff = itemIdx - activeIdx
  if (diff === -1) return prev
  if (diff === 1) return next
  return ""
}

export function remoteSessions(local: string[], managed: { id: string }[], pending: (id: string) => boolean): string[] {
  return [...new Set([...local.filter((id) => !pending(id)), ...managed.map((session) => session.id)])]
}

/**
 * A "focus chat search" request only reaches TaskHeader while ChatView is
 * the visible main surface — history and an active terminal tab each
 * replace it. Reset to chat first, then dispatch.
 */
export function focusChatSearch(reset: { history(v: boolean): void; terminal(): void }) {
  reset.history(false)
  reset.terminal()
  window.dispatchEvent(new CustomEvent("focusTranscriptSearch"))
}
