/**
 * Factory for tab-order mutations used when sessions/terminals are created,
 * a pending tab is promoted to a real session id, or a session is forked.
 *
 * Exists as a separate module to keep the tab-order branching out of
 * AgentManagerApp's main message-handler arrow (complexity cap).
 */
import { replaceInTabOrder, insertInTabOrderAfter } from "./tab-order"

export interface TabOrderSyncDeps {
  /** Constant that identifies the local context. */
  LOCAL: string
  /** Read/update the `contextKey → ordered tab ids` map (in-memory). */
  order: () => Record<string, string[]>
  setOrder: (updater: (prev: Record<string, string[]>) => Record<string, string[]>) => void
  /** Persist to durable state. Callers should strip transient ids here. */
  persist: (key: string, value: string[]) => void
  /** State accessors used to rebuild the base order `[sessions, terminals]`. */
  localSessionIDs: () => string[]
  terminalIdsFor: (key: string) => string[]
}

export function createTabOrderSync(deps: TabOrderSyncDeps) {
  const baseFor = (key: string): string[] => {
    // All sessions and terminals live in the LOCAL context — no other keys.
    const sids = key === deps.LOCAL ? deps.localSessionIDs() : []
    return [...sids, ...deps.terminalIdsFor(key)]
  }

  const commit = (key: string, next: string[]) => {
    deps.setOrder((prev) => ({ ...prev, [key]: next }))
    deps.persist(key, next)
  }

  const resolve = (key: string | undefined): string => key ?? deps.LOCAL

  // Merge stored + any base ids not yet in stored — mirrors `applyTabOrder`'s
  // output so we can pin `id` at a specific rendered position (tail for
  // append, right-of-anchor for insertAfter) regardless of whether the
  // caller already mutated source state (localSessionIDs, terms, etc).
  const merge = (key: string): string[] => {
    const stored = deps.order()[key] ?? []
    const set = new Set(stored)
    const unknowns = baseFor(key).filter((x) => !set.has(x))
    return [...stored, ...unknowns]
  }

  const api = {
    /** Place `id` at the tail of the persisted order for `key`. */
    append(key: string | undefined, id: string) {
      const k = resolve(key)
      const rest = merge(k).filter((x) => x !== id)
      commit(k, [...rest, id])
    },
    /** Swap `oldId` for `newId` preserving position, or append if missing. */
    replaceOrAppend(key: string | undefined, oldId: string, newId: string) {
      const k = resolve(key)
      const stored = deps.order()[k] ?? []
      const swapped = replaceInTabOrder(stored, oldId, newId)
      if (swapped) return commit(k, swapped)
      const rest = merge(k).filter((x) => x !== newId)
      commit(k, [...rest, newId])
    },
    /**
     * Place `id` directly after `anchorId`; append if anchor is missing.
     * An id already present in the persisted order is left exactly where it
     * is (focus-only — no reorder), matching the "already-open child is
     * focused without reordering" contract. New ids are inserted after the
     * anchor, or appended when the anchor is missing/unknown.
     */
    insertAfter(key: string | undefined, anchorId: string | undefined, id: string) {
      const k = resolve(key)
      const stored = deps.order()[k] ?? []
      if (stored.includes(id)) return
      const rest = merge(k).filter((x) => x !== id)
      const next = insertInTabOrderAfter(rest, anchorId, id)
      commit(k, next)
    },
    /**
     * Source-relative child-open coordination: keeps the local session
     * inventory AND the persisted tab order consistent with the tab registry
     * (see tabMgr.openAfter). An already-open child leaves both stores
     * untouched so the visible strip never reorders; a new child is inserted
     * immediately after its source in both, and appended when the source is
     * missing/undefined.
     */
    insertLocalAfter(
      source: string | undefined,
      id: string,
      setLocal: (updater: (prev: string[]) => string[]) => void,
    ) {
      setLocal((prev) => insertInTabOrderAfter(prev, source, id))
      api.insertAfter(deps.LOCAL, source, id)
    },
  }
  return api
}
