/**
 * Per-context session tab manager for Agent Manager.
 *
 * Wraps the pure session-tabs.ts registry into a Solid reactive store.
 * Each sidebar context has its own independent SessionTabState. After
 * initial seeding the manager is the sole authority for tab membership;
 * it never inspects parentID or directory.
 */

import { createSignal } from "solid-js"
import {
  seedTabs,
  openTab,
  openTabAfter,
  selectTab,
  closeTab,
  closeOtherTabs,
  reorderTab,
  moveTabBy,
  refreshTabs,
  removeTab,
  type SessionTabState,
} from "./session-tabs"

const EMPTY: SessionTabState = { ids: [], active: undefined }

export function createSessionTabManager() {
  const [store, setStore] = createSignal<Record<string, SessionTabState>>({})

  const get = (ctx: string): SessionTabState => store()[ctx] ?? EMPTY

  const update = (ctx: string, fn: (prev: SessionTabState) => SessionTabState) => {
    setStore((prev) => {
      const cur = prev[ctx] ?? EMPTY
      const next = fn(cur)
      return next === cur ? prev : { ...prev, [ctx]: next }
    })
  }

  return {
    /** All context keys that have been populated. */
    contexts(): string[] {
      return Object.keys(store())
    },

    /** Current tab IDs for a context. */
    ids(ctx: string): readonly string[] {
      return get(ctx).ids
    },

    /** Active tab ID for a context. */
    active(ctx: string): string | undefined {
      return get(ctx).active
    },

    /** Seed a context with initial tab IDs (replaces current state). */
    seed(ctx: string, ids: readonly string[], active?: string) {
      setStore((prev) => ({ ...prev, [ctx]: seedTabs(ids, active) }))
    },

    /** Open or focus a session tab. Appends if missing, focuses if present. */
    open(ctx: string, id: string) {
      update(ctx, (s) => openTab(s, id))
    },

    /** Open or focus a session right after its source; appends if source is missing. */
    openAfter(ctx: string, source: string | undefined, id: string) {
      update(ctx, (s) => openTabAfter(s, source, id))
    },

    /** Select an existing tab. No-op if not present. */
    select(ctx: string, id: string) {
      update(ctx, (s) => selectTab(s, id))
    },

    /** Close a tab with deterministic adjacent fallback. Returns new active ID. */
    close(ctx: string, id: string): string | undefined {
      const after = closeTab(get(ctx), id)
      setStore((prev) => ({ ...prev, [ctx]: after }))
      return after.active
    },

    /** Close all tabs except the specified one. */
    closeOthers(ctx: string, id: string) {
      update(ctx, (s) => closeOtherTabs(s, id))
    },

    /** Reorder tabs via drag-and-drop. */
    reorder(ctx: string, from: string, to: string) {
      update(ctx, (s) => reorderTab(s, from, to))
    },

    /** Move a tab by offset. */
    moveBy(ctx: string, id: string, offset: -1 | 1) {
      update(ctx, (s) => moveTabBy(s, id, offset))
    },

    /** Additive refresh from partial inventory — never removes open IDs. */
    refresh(ctx: string, available: readonly string[]) {
      update(ctx, (s) => refreshTabs(s, available))
    },

    /** Remove a tab on explicit session deletion. Returns new active ID. */
    remove(ctx: string, id: string): string | undefined {
      const after = removeTab(get(ctx), id)
      setStore((prev) => ({ ...prev, [ctx]: after }))
      return after.active
    },

    /** Replace one tab ID with another, preserving position and active state. */
    replace(ctx: string, oldId: string, newId: string) {
      update(ctx, (s) => {
        const index = s.ids.indexOf(oldId)
        if (index === -1) return openTab(s, newId)
        const ids = [...s.ids]
        ids[index] = newId
        const active = s.active === oldId ? newId : s.active
        return { ids, active }
      })
    },

    /** Set session ID order directly (used after drag reordering). */
    setOrder(ctx: string, ids: readonly string[]) {
      update(ctx, (s) => {
        const deduped = [...new Set(ids)]
        const active = s.active !== undefined && deduped.includes(s.active) ? s.active : deduped[0]
        return { ids: deduped, active }
      })
    },
  }
}
