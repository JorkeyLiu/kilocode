/**
 * Deterministic bottom-page / lone-pending cover decision for Agent Manager.
 *
 * Fresh webview hydration creates exactly one pending tab with
 * `isBottomPage === false`. The first real session must cover (remove) that
 * lone pending tab instead of appending beside it — otherwise hydration
 * preserves `[pending, real...]` divergence.
 *
 * Pure and vscode-free so unit tests exercise the real decision without mocks.
 */

export interface CoverDecision {
  /** Pending/singleton id to remove, if any. */
  coverId?: string
  /** Whether the bottom-page flag must be cleared. */
  clearBottom: boolean
}

export function resolveCoverBottomPage(
  ids: readonly string[],
  isBottom: boolean,
  isPending: (id: string) => boolean,
): CoverDecision | undefined {
  // Lone pending tab is fresh-empty hydration, not intentional user state:
  // cover it regardless of the bottom flag so the first real tab replaces it.
  if (ids.length === 1 && isPending(ids[0]!)) return { coverId: ids[0]!, clearBottom: true }
  if (!isBottom) return undefined
  // Explicit bottom page: preserve existing behavior.
  if (ids.length === 1) return { coverId: ids[0]!, clearBottom: true }
  return { clearBottom: true }
}

/**
 * Close-last final invariant: bottom page stays active while only an
 * internal pending draft (or nothing) exists. Any non-pending real tab or
 * any terminal content is real content and must clear bottom.
 *
 * Pure and vscode-free so unit tests exercise the real decision without mocks.
 */
export function shouldClearBottomPage(
  ids: readonly string[],
  terminalCount: number,
  isPending: (id: string) => boolean,
): boolean {
  if (terminalCount > 0) return true
  return ids.some((id) => !isPending(id))
}
