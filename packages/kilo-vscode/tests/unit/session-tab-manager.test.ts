/**
 * Integration contract tests for session-tab-manager.
 *
 * Verifies the manager's behavior in scenarios that the Phase 1B
 * integration depends on: viewChildSession, deletion fallback,
 * partial refresh preservation, and replace-pending-tab.
 *
 * Uses opaque IDs without any parentID/worktree classification.
 */

import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSessionTabManager } from "../../webview-ui/agent-manager/session-tab-manager"

const ROOT_A = "root-aaaa-bbbb"
const ROOT_B = "root-cccc-dddd"
const ROOT_C = "root-eeee-ffff"
const CHILD_A = "child-aaaa-bbbb"
const CHILD_B = "child-cccc-dddd"
const PENDING_1 = "pending:aaa-bbb"
const PENDING_2 = "pending:ccc-ddd"
const LOCAL = "local"
const WT_X = "worktree-x"

function withManager(fn: (mgr: ReturnType<typeof createSessionTabManager>) => void) {
  createRoot(() => {
    const mgr = createSessionTabManager()
    fn(mgr)
  })
}

describe("session-tab-manager — seed and read", () => {
  it("seed sets IDs and active for a context", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, ROOT_B], ROOT_B)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B])
      expect(mgr.active(LOCAL)).toBe(ROOT_B)
    }))

  it("different contexts are independent", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A])
      mgr.seed(WT_X, [ROOT_B])
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A])
      expect(mgr.ids(WT_X)).toEqual([ROOT_B])
    }))

  it("empty context returns empty state", () =>
    withManager((mgr) => {
      expect(mgr.ids(LOCAL)).toEqual([])
      expect(mgr.active(LOCAL)).toBeUndefined()
    }))
})

describe("session-tab-manager — viewChildSession contract", () => {
  it("open adds child to registry and it appears in ids()", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A], ROOT_A)
      mgr.open(LOCAL, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, CHILD_A])
    }))

  it("opening same child again does not duplicate", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A], ROOT_A)
      mgr.open(LOCAL, CHILD_A)
      mgr.open(LOCAL, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, CHILD_A])
    }))

  it("child appears in ids() alongside root tabs", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, ROOT_B], ROOT_A)
      mgr.open(LOCAL, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B, CHILD_A])
    }))

  it("child can be opened in a worktree context", () =>
    withManager((mgr) => {
      mgr.seed(WT_X, [ROOT_A], ROOT_A)
      mgr.open(WT_X, CHILD_A)
      expect(mgr.ids(WT_X)).toEqual([ROOT_A, CHILD_A])
    }))

  it("no parentID or worktree classification — any opaque ID accepted", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A])
      mgr.open(LOCAL, CHILD_A)
      mgr.open(LOCAL, ROOT_B)
      mgr.open(LOCAL, "wt-x-session-001")
      mgr.open(LOCAL, "child-of-child-aaaa")
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, CHILD_A, ROOT_B, "wt-x-session-001", "child-of-child-aaaa"])
    }))
})

describe("session-tab-manager — openAfter (source-relative child open)", () => {
  it("inserts a missing child immediately after its source", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, ROOT_B], ROOT_A)
      mgr.openAfter(LOCAL, ROOT_A, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, CHILD_A, ROOT_B])
      expect(mgr.active(LOCAL)).toBe(CHILD_A)
    }))

  it("preserves relative order of other tabs after a middle source", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_C, ROOT_A, ROOT_B], ROOT_A)
      mgr.openAfter(LOCAL, ROOT_A, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_C, ROOT_A, CHILD_A, ROOT_B])
    }))

  it("focuses an already-open child without reordering", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, CHILD_A, ROOT_B], ROOT_A)
      mgr.openAfter(LOCAL, ROOT_A, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, CHILD_A, ROOT_B])
      expect(mgr.active(LOCAL)).toBe(CHILD_A)
    }))

  it("appends when the source is unknown", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, ROOT_B], ROOT_A)
      mgr.openAfter(LOCAL, "missing-source", CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B, CHILD_A])
    }))

  it("appends when the source is undefined", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, ROOT_B], ROOT_A)
      mgr.openAfter(LOCAL, undefined, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B, CHILD_A])
    }))
})

describe("session-tab-manager — close and deletion fallback", () => {
  it("close removes ID and returns the previous adjacent fallback", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, CHILD_A, ROOT_B], CHILD_A)
      const next = mgr.close(LOCAL, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B])
      expect(next).toBe(ROOT_A) // prefer the previous tab
    }))

  it("close non-active tab preserves active", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, CHILD_A, ROOT_B], ROOT_B)
      const next = mgr.close(LOCAL, ROOT_A)
      expect(mgr.ids(LOCAL)).toEqual([CHILD_A, ROOT_B])
      expect(next).toBe(ROOT_B)
    }))

  it("close only tab returns undefined", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [CHILD_A], CHILD_A)
      const next = mgr.close(LOCAL, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([])
      expect(next).toBeUndefined()
    }))

  it("remove behaves identically to close (explicit deletion)", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, CHILD_A, ROOT_B], CHILD_A)
      const next = mgr.remove(LOCAL, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B])
      expect(next).toBe(ROOT_A)
    }))

  it("close on absent ID is a no-op", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A], ROOT_A)
      const next = mgr.close(LOCAL, "missing")
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A])
      expect(next).toBe(ROOT_A)
    }))
})

describe("session-tab-manager — partial refresh preserves open IDs", () => {
  it("refresh adds new IDs without removing existing ones", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, CHILD_A], CHILD_A)
      mgr.refresh(LOCAL, [ROOT_A, ROOT_B, ROOT_C])
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, CHILD_A, ROOT_B, ROOT_C])
      expect(mgr.active(LOCAL)).toBe(CHILD_A)
    }))

  it("refresh with empty available does not change state", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [CHILD_A, ROOT_A], CHILD_A)
      mgr.refresh(LOCAL, [])
      expect(mgr.ids(LOCAL)).toEqual([CHILD_A, ROOT_A])
    }))

  it("refresh preserves child even when available only has roots", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, CHILD_A, CHILD_B, ROOT_B], CHILD_B)
      mgr.refresh(LOCAL, [ROOT_A]) // partial — missing ROOT_B, CHILD_A, CHILD_B
      // CHILD_A, CHILD_B, ROOT_B survive because refresh is additive
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, CHILD_A, CHILD_B, ROOT_B])
      expect(mgr.active(LOCAL)).toBe(CHILD_B)
    }))
})

describe("session-tab-manager — replace (pending → real)", () => {
  it("replace swaps ID in-place preserving position", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, PENDING_1, ROOT_B], PENDING_1)
      mgr.replace(LOCAL, PENDING_1, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, CHILD_A, ROOT_B])
      expect(mgr.active(LOCAL)).toBe(CHILD_A)
    }))

  it("replace when oldId is absent falls back to open", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A], ROOT_A)
      mgr.replace(LOCAL, "missing", CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, CHILD_A])
    }))

  it("replace preserves active when oldId is not active", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [PENDING_1, ROOT_A], ROOT_A)
      mgr.replace(LOCAL, PENDING_1, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([CHILD_A, ROOT_A])
      expect(mgr.active(LOCAL)).toBe(ROOT_A)
    }))
})

describe("session-tab-manager — closeOthers", () => {
  it("keeps only the specified tab", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, CHILD_A, ROOT_B], ROOT_A)
      mgr.closeOthers(LOCAL, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([CHILD_A])
      expect(mgr.active(LOCAL)).toBe(CHILD_A)
    }))
})

describe("session-tab-manager — reorder and setOrder", () => {
  it("reorder moves tab to new position", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, CHILD_A, ROOT_B], ROOT_A)
      mgr.reorder(LOCAL, ROOT_B, ROOT_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_B, ROOT_A, CHILD_A])
    }))

  it("setOrder replaces the full ID list", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, CHILD_A, ROOT_B], CHILD_A)
      mgr.setOrder(LOCAL, [ROOT_B, ROOT_A, CHILD_A])
      expect(mgr.ids(LOCAL)).toEqual([ROOT_B, ROOT_A, CHILD_A])
      expect(mgr.active(LOCAL)).toBe(CHILD_A) // preserved
    }))

  it("setOrder deduplicates", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A], ROOT_A)
      mgr.setOrder(LOCAL, [ROOT_A, ROOT_A, ROOT_B])
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B])
    }))
})

describe("session-tab-manager — select", () => {
  it("select activates existing ID", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, CHILD_A], ROOT_A)
      mgr.select(LOCAL, CHILD_A)
      expect(mgr.active(LOCAL)).toBe(CHILD_A)
    }))

  it("select is no-op for absent ID", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A], ROOT_A)
      mgr.select(LOCAL, "missing")
      expect(mgr.active(LOCAL)).toBe(ROOT_A)
    }))
})

describe("session-tab-manager — full lifecycle contract", () => {
  it("seed → open child → close child → open same child again", () =>
    withManager((mgr) => {
      // Initial seed from ownership-derived inventory
      mgr.seed(LOCAL, [ROOT_A, ROOT_B], ROOT_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B])

      // viewChildSession opens child
      mgr.open(LOCAL, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B, CHILD_A])

      // Opening same child again focuses without duplicate
      mgr.open(LOCAL, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B, CHILD_A])

      // Close child
      const next = mgr.close(LOCAL, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B])
      expect(next).toBeDefined()

      // Open same child again — still works
      mgr.open(LOCAL, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B, CHILD_A])
    }))

  it("partial refresh after child open preserves child", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A], ROOT_A)
      mgr.open(LOCAL, CHILD_A)
      mgr.open(LOCAL, CHILD_B)

      // Partial inventory refresh — only roots
      mgr.refresh(LOCAL, [ROOT_A, ROOT_B])

      // Children preserved, new root added
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, CHILD_A, CHILD_B, ROOT_B])
    }))

  it("explicit deletion removes child and activates adjacent", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, CHILD_A, ROOT_B], CHILD_A)
      const next = mgr.remove(LOCAL, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B])
      // Adjacent fallback: ROOT_A (prefer the previous tab)
      expect(next).toBe(ROOT_A)
    }))
})

describe("session-tab-manager — contexts()", () => {
  it("returns empty array for fresh manager", () =>
    withManager((mgr) => {
      expect(mgr.contexts()).toEqual([])
    }))

  it("returns all populated context keys", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A])
      mgr.seed(WT_X, [ROOT_B])
      const keys = mgr.contexts()
      expect(keys).toContain(LOCAL)
      expect(keys).toContain(WT_X)
      expect(keys).toHaveLength(2)
    }))

  it("includes context after open", () =>
    withManager((mgr) => {
      mgr.open(LOCAL, ROOT_A)
      expect(mgr.contexts()).toContain(LOCAL)
    }))
})

describe("session-tab-manager — deletion across contexts", () => {
  it("remove from LOCAL does not affect worktree context", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, CHILD_A], CHILD_A)
      mgr.seed(WT_X, [CHILD_A, ROOT_B], CHILD_A)
      mgr.remove(LOCAL, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A])
      expect(mgr.ids(WT_X)).toEqual([CHILD_A, ROOT_B])
    }))

  it("remove from all contexts cleans up everywhere", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, CHILD_A], ROOT_A)
      mgr.seed(WT_X, [CHILD_A, ROOT_B], CHILD_A)
      for (const ctx of mgr.contexts()) {
        mgr.remove(ctx, CHILD_A)
      }
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A])
      expect(mgr.ids(WT_X)).toEqual([ROOT_B])
      expect(mgr.active(WT_X)).toBe(ROOT_B)
    }))

  it("remove nonexistent session from all contexts is a no-op", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A], ROOT_A)
      mgr.seed(WT_X, [ROOT_B], ROOT_B)
      for (const ctx of mgr.contexts()) {
        mgr.remove(ctx, "missing")
      }
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A])
      expect(mgr.ids(WT_X)).toEqual([ROOT_B])
    }))
})

describe("session-tab-manager — deterministic fallback on deletion", () => {
  it("active first tab → fallback to next tab", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, ROOT_B, ROOT_C], ROOT_A)
      const next = mgr.remove(LOCAL, ROOT_A)
      expect(next).toBe(ROOT_B)
    }))

  it("active middle tab → prefer previous adjacent tab", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, ROOT_B, ROOT_C], ROOT_B)
      const next = mgr.remove(LOCAL, ROOT_B)
      expect(next).toBe(ROOT_A)
    }))

  it("active last tab → prefer previous tab", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, ROOT_B, ROOT_C], ROOT_C)
      const next = mgr.remove(LOCAL, ROOT_C)
      expect(next).toBe(ROOT_B)
    }))

  it("only tab → returns undefined", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A], ROOT_A)
      const next = mgr.remove(LOCAL, ROOT_A)
      expect(next).toBeUndefined()
      expect(mgr.ids(LOCAL)).toEqual([])
    }))

  it("non-active deletion preserves active", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, ROOT_B, ROOT_C], ROOT_B)
      const next = mgr.remove(LOCAL, ROOT_A)
      expect(next).toBe(ROOT_B)
      expect(mgr.active(LOCAL)).toBe(ROOT_B)
    }))

  // Phase 1B race fix: proves the registry's active() is the correct source of
  // truth for wasActive determination, independent of SessionProvider.currentSessionID().
  // The sequence mirrors the fixed handleSessionDeletedFromBackend: check
  // tabMgr.active(ctx) === sid BEFORE removal, remove across all contexts, then
  // read tabMgr.active(ctx) for the deterministic fallback.
  it("registry active determines fallback without external state (Phase 1B race)", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, CHILD_A, ROOT_B], CHILD_A)
      mgr.seed(WT_X, [ROOT_B, ROOT_C], ROOT_B)

      const sid = CHILD_A
      const ctx = LOCAL

      // wasActive from registry — no dependency on SessionProvider
      expect(mgr.active(ctx)).toBe(sid)

      // Remove from all contexts (mirrors sessionDeleted handler)
      for (const c of mgr.contexts()) mgr.remove(c, sid)

      // Fallback is deterministic from registry
      expect(mgr.active(ctx)).toBe(ROOT_A)
      // Worktree context unaffected
      expect(mgr.active(WT_X)).toBe(ROOT_B)
    }))

  it("registry active returns false when deleted session is not active in context", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, CHILD_A, ROOT_B], ROOT_A)
      mgr.seed(WT_X, [CHILD_A, ROOT_C], CHILD_A)

      const sid = CHILD_A
      const ctx = LOCAL

      // wasActive is false — CHILD_A is not active in LOCAL
      expect(mgr.active(ctx)).not.toBe(sid)

      // Simulate handler early return when wasActive is false:
      // removing CHILD_A preserves the original active in LOCAL
      for (const c of mgr.contexts()) mgr.remove(c, sid)
      expect(mgr.active(LOCAL)).toBe(ROOT_A)
      // Worktree lost CHILD_A but fallback kicks in there independently
      expect(mgr.active(WT_X)).toBe(ROOT_C)
    }))

  it("fallback works when only one context has the deleted session", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, ROOT_B], ROOT_A)
      // WT_X does not contain ROOT_A at all
      mgr.seed(WT_X, [ROOT_B, ROOT_C], ROOT_C)

      const ctx = LOCAL
      const wasActive = mgr.active(ctx) === ROOT_A
      expect(wasActive).toBe(true)

      for (const c of mgr.contexts()) mgr.remove(c, ROOT_A)

      // Fallback from registry, not from SessionProvider
      expect(mgr.active(LOCAL)).toBe(ROOT_B)
      // WT_X unaffected (ROOT_A was never there)
      expect(mgr.active(WT_X)).toBe(ROOT_C)
    }))
})

describe("session-tab-manager — atomic closeOthers", () => {
  it("keeps only the target tab and activates it", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, ROOT_B, CHILD_A, ROOT_C], ROOT_B)
      mgr.closeOthers(LOCAL, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([CHILD_A])
      expect(mgr.active(LOCAL)).toBe(CHILD_A)
    }))

  it("closeOthers on absent target is a no-op", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, ROOT_B], ROOT_A)
      mgr.closeOthers(LOCAL, "missing")
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B])
    }))

  it("closeOthers with single tab is a no-op", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A], ROOT_A)
      mgr.closeOthers(LOCAL, ROOT_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A])
      expect(mgr.active(LOCAL)).toBe(ROOT_A)
    }))

  it("closeOthers affects only the target context", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, ROOT_B, ROOT_C], ROOT_A)
      mgr.seed(WT_X, [CHILD_A, CHILD_B], CHILD_A)
      mgr.closeOthers(LOCAL, ROOT_B)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_B])
      expect(mgr.ids(WT_X)).toEqual([CHILD_A, CHILD_B])
    }))
})

describe("Phase 3A — single LOCAL context contract", () => {
  it("Agent Manager uses only LOCAL context for all session tabs", () =>
    withManager((mgr) => {
      // Phase 3A: the manager is always used with LOCAL only.
      // This test documents the integration contract.
      mgr.seed(LOCAL, [ROOT_A, ROOT_B], ROOT_A)
      mgr.open(LOCAL, CHILD_A)
      mgr.open(LOCAL, CHILD_B)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B, CHILD_A, CHILD_B])
      // No worktree contexts are created
      expect(mgr.contexts()).toEqual([LOCAL])
    }))

  it("sessionAdded keeps session in LOCAL (not moved to worktree context)", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A], ROOT_A)
      // Simulate sessionAdded: session stays in LOCAL
      mgr.open(LOCAL, ROOT_B)
      expect(mgr.ids(LOCAL)).toContain(ROOT_B)
      // No worktree context was created
      expect(mgr.contexts()).toEqual([LOCAL])
    }))

  it("sessionForked keeps forked session in LOCAL", () =>
    withManager((mgr) => {
      mgr.seed(LOCAL, [ROOT_A, ROOT_B], ROOT_A)
      // Simulate fork: new session opened in LOCAL
      mgr.open(LOCAL, CHILD_A)
      expect(mgr.ids(LOCAL)).toEqual([ROOT_A, ROOT_B, CHILD_A])
      expect(mgr.contexts()).toEqual([LOCAL])
    }))
})
