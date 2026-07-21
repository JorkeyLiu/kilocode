/**
 * Pure navigation logic for the agent manager sidebar.
 *
 * All session tabs live in one LOCAL context.
 *
 * Returns the action to take: select a session by ID, go to local, or do nothing.
 */

/** Sentinel value for the single LOCAL session tab context. */
export const LOCAL = "local" as const

type NavResult = { action: "select"; id: string } | { action: typeof LOCAL } | { action: "none" }

type SessionLike = { id: string; parentID?: string | null; createdAt: string }

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

export function remoteSessions(
  local: string[],
  managed: { id: string; worktreeId: string | null }[], // worktreeId is a legacy field name from the extension message contract
  pending: (id: string) => boolean,
): string[] {
  return [
    ...new Set([
      ...local.filter((id) => !pending(id)),
      ...managed.filter((session) => session.worktreeId).map((session) => session.id),
    ]),
  ]
}

/**
 * A "focus chat search" request only reaches TaskHeader while ChatView is
 * the visible main surface — history, an active terminal tab, and the
 * full-screen review each replace it. Reset to chat first, then dispatch.
 */
export function focusChatSearch(reset: { history(v: boolean): void; review(v: boolean): void; terminal(): void }) {
  reset.history(false)
  reset.review(false)
  reset.terminal()
  window.dispatchEvent(new CustomEvent("focusTranscriptSearch"))
}
