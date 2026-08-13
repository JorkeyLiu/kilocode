/**
 * Focused unit tests for the session tab registry primitive.
 *
 * Uses root-looking ("root-*") and child-looking ("child-*") opaque IDs
 * to prove no parentID classification or worktree awareness.
 */

import { describe, expect, it } from "bun:test"
import {
  seedTabs,
  openTab,
  selectTab,
  closeTab,
  closeOtherTabs,
  reorderTab,
  moveTabBy,
  mergeTabs,
  refreshTabs,
  removeTab,
  type SessionTabState,
} from "../../webview-ui/agent-manager/session-tabs"

const s = (ids: string[], active?: string): SessionTabState => ({ ids, active })

// Opaque IDs that look like roots or children to prove no classification.
const ROOT_A = "root-aaaa-bbbb"
const ROOT_B = "root-cccc-dddd"
const ROOT_C = "root-eeee-ffff"
const CHILD_A = "child-aaaa-bbbb"
const CHILD_B = "child-cccc-dddd"
const CHILD_C = "child-eeee-ffff"
const GRANDCHILD = "child-of-child-aaaa"
const WORKTREE_X = "wt-x-session-001"
const WORKTREE_Y = "wt-y-session-002"

describe("seedTabs", () => {
  it("deduplicates and sets active to the first ID when no active specified", () => {
    expect(seedTabs(["a", "b", "a", "b"])).toEqual({ ids: ["a", "b"], active: "a" })
  })

  it("preserves specified active when it is in the deduplicated list", () => {
    expect(seedTabs(["a", "b", "c"], "b")).toEqual({ ids: ["a", "b", "c"], active: "b" })
  })

  it("falls back to first ID when specified active is not in the list", () => {
    expect(seedTabs(["a", "b"], "missing")).toEqual({ ids: ["a", "b"], active: "a" })
  })

  it("returns empty state for empty input", () => {
    expect(seedTabs([])).toEqual({ ids: [], active: undefined })
  })

  it("returns empty state when active specified but IDs empty", () => {
    expect(seedTabs([], "a")).toEqual({ ids: [], active: undefined })
  })

  it("handles single-element seed", () => {
    expect(seedTabs(["only"])).toEqual({ ids: ["only"], active: "only" })
  })

  it("treats root-looking and child-looking IDs as opaque strings", () => {
    const result = seedTabs([ROOT_A, CHILD_A, ROOT_B, CHILD_B], CHILD_A)
    expect(result.ids).toEqual([ROOT_A, CHILD_A, ROOT_B, CHILD_B])
    expect(result.active).toBe(CHILD_A)
  })

  it("deduplicates child-looking IDs same as any other", () => {
    const result = seedTabs([CHILD_A, ROOT_A, CHILD_A, ROOT_A])
    expect(result.ids).toEqual([CHILD_A, ROOT_A])
    expect(result.active).toBe(CHILD_A)
  })

  it("preserves insertion order after dedup", () => {
    const result = seedTabs([WORKTREE_X, CHILD_A, ROOT_A, WORKTREE_X, CHILD_A])
    expect(result.ids).toEqual([WORKTREE_X, CHILD_A, ROOT_A])
  })
})

describe("openTab", () => {
  it("appends a new ID and focuses it", () => {
    expect(openTab(s(["a"], "a"), "b")).toEqual({ ids: ["a", "b"], active: "b" })
  })

  it("focuses an already-open ID without duplicating", () => {
    const result = openTab(s(["a", "b"], "a"), "b")
    expect(result.ids).toEqual(["a", "b"])
    expect(result.active).toBe("b")
  })

  it("is idempotent for the active tab", () => {
    const state = s(["a", "b"], "b")
    expect(openTab(state, "b")).toEqual({ ids: ["a", "b"], active: "b" })
  })

  it("ignores empty string IDs", () => {
    const state = s(["a"], "a")
    expect(openTab(state, "")).toEqual(state)
  })

  it("opens child-looking IDs identically to root-looking IDs", () => {
    const result = openTab(s([ROOT_A], ROOT_A), CHILD_A)
    expect(result.ids).toEqual([ROOT_A, CHILD_A])
    expect(result.active).toBe(CHILD_A)

    const result2 = openTab(result, GRANDCHILD)
    expect(result2.ids).toEqual([ROOT_A, CHILD_A, GRANDCHILD])
    expect(result2.active).toBe(GRANDCHILD)
  })

  it("opens worktree-looking IDs without any filtering", () => {
    const result = openTab(s([ROOT_A], ROOT_A), WORKTREE_X)
    expect(result.ids).toEqual([ROOT_A, WORKTREE_X])
    expect(result.active).toBe(WORKTREE_X)
  })
})

describe("selectTab", () => {
  it("activates an existing ID", () => {
    expect(selectTab(s(["a", "b"], "a"), "b")).toEqual({ ids: ["a", "b"], active: "b" })
  })

  it("is a no-op when the ID is not in the list", () => {
    const state = s(["a", "b"], "a")
    expect(selectTab(state, "missing")).toBe(state)
  })

  it("is idempotent when already active", () => {
    const state = s(["a", "b"], "b")
    expect(selectTab(state, "b")).toEqual(state)
  })

  it("selects child-looking IDs identically to root-looking IDs", () => {
    const state = s([ROOT_A, CHILD_A, ROOT_B], ROOT_A)
    const result = selectTab(state, CHILD_A)
    expect(result.active).toBe(CHILD_A)
    expect(result.ids).toEqual([ROOT_A, CHILD_A, ROOT_B])
  })
})

describe("closeTab", () => {
  it("removes the closed tab and activates the previous adjacent tab", () => {
    expect(closeTab(s(["a", "b", "c"], "b"), "b")).toEqual({ ids: ["a", "c"], active: "a" })
  })

  it("falls back to the next tab when closing the first one", () => {
    expect(closeTab(s(["a", "b", "c"], "a"), "a")).toEqual({ ids: ["b", "c"], active: "b" })
  })

  it("prefers the previous tab when closing the last one", () => {
    expect(closeTab(s(["a", "b", "c"], "c"), "c")).toEqual({ ids: ["a", "b"], active: "b" })
  })

  it("returns empty state when closing the only tab", () => {
    expect(closeTab(s(["a"], "a"), "a")).toEqual({ ids: [], active: undefined })
  })

  it("returns state unchanged when ID is not present", () => {
    const state = s(["a", "b"], "a")
    expect(closeTab(state, "missing")).toBe(state)
  })

  it("does not change active when closing a non-active tab", () => {
    expect(closeTab(s(["a", "b", "c"], "b"), "a")).toEqual({ ids: ["b", "c"], active: "b" })
  })

  it("handles closing the first tab when it is not active", () => {
    expect(closeTab(s(["a", "b", "c"], "c"), "a")).toEqual({ ids: ["b", "c"], active: "c" })
  })

  it("handles child-looking and grandchild-looking IDs as opaque", () => {
    const state = s([ROOT_A, CHILD_A, GRANDCHILD], CHILD_A)
    const result = closeTab(state, CHILD_A)
    expect(result.ids).toEqual([ROOT_A, GRANDCHILD])
    expect(result.active).toBe(ROOT_A)
  })

  it("handles closing the active root-looking tab with child-looking neighbors", () => {
    const state = s([CHILD_A, ROOT_A, CHILD_B], ROOT_A)
    const result = closeTab(state, ROOT_A)
    expect(result.ids).toEqual([CHILD_A, CHILD_B])
    expect(result.active).toBe(CHILD_A)
  })

  it("handles closing the active tab with worktree-looking neighbors", () => {
    const state = s([WORKTREE_X, ROOT_A, WORKTREE_Y], ROOT_A)
    const result = closeTab(state, ROOT_A)
    expect(result.ids).toEqual([WORKTREE_X, WORKTREE_Y])
    expect(result.active).toBe(WORKTREE_X)
  })
})

describe("closeOtherTabs", () => {
  it("keeps only the specified tab", () => {
    expect(closeOtherTabs(s(["a", "b", "c"], "a"), "a")).toEqual({ ids: ["a"], active: "a" })
  })

  it("returns state unchanged when ID is not present", () => {
    const state = s(["a", "b"], "a")
    expect(closeOtherTabs(state, "missing")).toBe(state)
  })

  it("keeps a child-looking tab and removes root-looking tabs", () => {
    const state = s([ROOT_A, CHILD_A, ROOT_B], ROOT_A)
    const result = closeOtherTabs(state, CHILD_A)
    expect(result.ids).toEqual([CHILD_A])
    expect(result.active).toBe(CHILD_A)
  })

  it("keeps a root-looking tab and removes child-looking tabs", () => {
    const state = s([CHILD_A, ROOT_A, CHILD_B], CHILD_A)
    const result = closeOtherTabs(state, ROOT_A)
    expect(result.ids).toEqual([ROOT_A])
    expect(result.active).toBe(ROOT_A)
  })

  it("keeps a worktree-looking tab and removes all others", () => {
    const state = s([ROOT_A, WORKTREE_X, CHILD_A], ROOT_A)
    const result = closeOtherTabs(state, WORKTREE_X)
    expect(result.ids).toEqual([WORKTREE_X])
    expect(result.active).toBe(WORKTREE_X)
  })
})

describe("reorderTab", () => {
  it("reorders tabs and preserves active", () => {
    expect(reorderTab(s(["a", "b", "c"], "b"), "c", "a")).toEqual({ ids: ["c", "a", "b"], active: "b" })
  })

  it("returns state unchanged when from equals to", () => {
    const state = s(["a", "b"], "a")
    expect(reorderTab(state, "a", "a")).toBe(state)
  })

  it("returns state unchanged when from ID is missing", () => {
    const state = s(["a", "b"], "a")
    expect(reorderTab(state, "missing", "b")).toBe(state)
  })

  it("returns state unchanged when to ID is missing", () => {
    const state = s(["a", "b"], "a")
    expect(reorderTab(state, "a", "missing")).toBe(state)
  })

  it("preserves active even when active tab itself is moved", () => {
    const result = reorderTab(s(["a", "b", "c"], "c"), "c", "a")
    expect(result.ids).toEqual(["c", "a", "b"])
    expect(result.active).toBe("c")
  })

  it("reorders mixed root/child/worktree IDs without classification", () => {
    const state = s([ROOT_A, CHILD_A, WORKTREE_X, CHILD_B], CHILD_A)
    const result = reorderTab(state, CHILD_B, ROOT_A)
    expect(result.ids).toEqual([CHILD_B, ROOT_A, CHILD_A, WORKTREE_X])
    expect(result.active).toBe(CHILD_A)
  })
})

describe("moveTabBy", () => {
  it("moves a tab one position to the right", () => {
    expect(moveTabBy(s(["a", "b", "c"], "a"), "a", 1)).toEqual({ ids: ["b", "a", "c"], active: "a" })
  })

  it("moves a tab one position to the left", () => {
    expect(moveTabBy(s(["a", "b", "c"], "c"), "c", -1)).toEqual({ ids: ["a", "c", "b"], active: "c" })
  })

  it("returns state unchanged at left boundary", () => {
    const state = s(["a", "b"], "a")
    expect(moveTabBy(state, "a", -1)).toBe(state)
  })

  it("returns state unchanged at right boundary", () => {
    const state = s(["a", "b"], "b")
    expect(moveTabBy(state, "b", 1)).toBe(state)
  })

  it("returns state unchanged when ID is missing", () => {
    const state = s(["a", "b"], "a")
    expect(moveTabBy(state, "missing", 1)).toBe(state)
  })

  it("preserves active regardless of which tab is moved", () => {
    const state = s([ROOT_A, CHILD_A, WORKTREE_X], CHILD_A)
    const result = moveTabBy(state, WORKTREE_X, -1)
    expect(result.ids).toEqual([ROOT_A, WORKTREE_X, CHILD_A])
    expect(result.active).toBe(CHILD_A)
  })
})

describe("mergeTabs", () => {
  it("appends new IDs without removing existing ones", () => {
    expect(mergeTabs(s(["a"], "a"), ["b", "c"])).toEqual({ ids: ["a", "b", "c"], active: "a" })
  })

  it("skips IDs already present", () => {
    expect(mergeTabs(s(["a", "b"], "a"), ["b", "c"])).toEqual({ ids: ["a", "b", "c"], active: "a" })
  })

  it("returns state unchanged when all incoming IDs already present", () => {
    const state = s(["a", "b"], "a")
    expect(mergeTabs(state, ["a", "b"])).toBe(state)
  })

  it("returns state unchanged for empty incoming list", () => {
    const state = s(["a"], "a")
    expect(mergeTabs(state, [])).toBe(state)
  })

  it("preserves active even when active is not in incoming", () => {
    const result = mergeTabs(s(["active-tab"], "active-tab"), [ROOT_A, ROOT_B])
    expect(result.ids).toEqual(["active-tab", ROOT_A, ROOT_B])
    expect(result.active).toBe("active-tab")
  })

  it("merges legacy root IDs without evicting already-open child IDs", () => {
    // Key invariant: child-looking IDs already open must not be removed
    const state = s([CHILD_A, GRANDCHILD, WORKTREE_X], GRANDCHILD)
    const legacyRoots = [ROOT_A, ROOT_B, ROOT_C]
    const result = mergeTabs(state, legacyRoots)
    expect(result.ids).toEqual([CHILD_A, GRANDCHILD, WORKTREE_X, ROOT_A, ROOT_B, ROOT_C])
    expect(result.active).toBe(GRANDCHILD)
  })

  it("skips empty strings in incoming", () => {
    const result = mergeTabs(s(["a"], "a"), ["", "b", ""])
    expect(result.ids).toEqual(["a", "b"])
  })

  it("merges worktree-looking IDs without filtering", () => {
    const state = s([ROOT_A], ROOT_A)
    const result = mergeTabs(state, [WORKTREE_X, WORKTREE_Y])
    expect(result.ids).toEqual([ROOT_A, WORKTREE_X, WORKTREE_Y])
  })
})

describe("refreshTabs", () => {
  it("behaves identically to mergeTabs (additive only)", () => {
    const state = s([CHILD_A, ROOT_A], ROOT_A)
    const available = [ROOT_B, CHILD_B]
    const result = refreshTabs(state, available)
    expect(result.ids).toEqual([CHILD_A, ROOT_A, ROOT_B, CHILD_B])
    expect(result.active).toBe(ROOT_A)
  })

  it("does not implicitly remove open IDs absent from the available set", () => {
    // Critical invariant: partial inventory must never evict open tabs
    const state = s([ROOT_A, CHILD_A, CHILD_B, GRANDCHILD], CHILD_A)
    // Available set only mentions ROOT_A — CHILD_A, CHILD_B, GRANDCHILD must survive
    const result = refreshTabs(state, [ROOT_A])
    expect(result.ids).toEqual([ROOT_A, CHILD_A, CHILD_B, GRANDCHILD])
    expect(result.active).toBe(CHILD_A)
  })

  it("adds new IDs from partial inventory", () => {
    const state = s([ROOT_A], ROOT_A)
    const result = refreshTabs(state, [ROOT_A, ROOT_B, CHILD_A])
    expect(result.ids).toEqual([ROOT_A, ROOT_B, CHILD_A])
    expect(result.active).toBe(ROOT_A)
  })

  it("handles empty available set without changing state", () => {
    const state = s([ROOT_A, CHILD_A], CHILD_A)
    expect(refreshTabs(state, [])).toBe(state)
  })
})

describe("removeTab", () => {
  it("behaves identically to closeTab (explicit deletion semantics)", () => {
    const state = s(["a", "b", "c"], "b")
    expect(removeTab(state, "b")).toEqual(closeTab(state, "b"))
  })

  it("removes a child-looking tab on explicit deletion", () => {
    const state = s([ROOT_A, CHILD_A, CHILD_B], CHILD_A)
    const result = removeTab(state, CHILD_A)
    expect(result.ids).toEqual([ROOT_A, CHILD_B])
    expect(result.active).toBe(ROOT_A)
  })

  it("removes a root-looking tab without affecting child-looking tabs", () => {
    const state = s([ROOT_A, CHILD_A, CHILD_B], ROOT_A)
    const result = removeTab(state, ROOT_A)
    expect(result.ids).toEqual([CHILD_A, CHILD_B])
    expect(result.active).toBe(CHILD_A)
  })

  it("removes a worktree-looking tab without classification", () => {
    const state = s([WORKTREE_X, ROOT_A, WORKTREE_Y], WORKTREE_X)
    const result = removeTab(state, WORKTREE_X)
    expect(result.ids).toEqual([ROOT_A, WORKTREE_Y])
    expect(result.active).toBe(ROOT_A)
  })

  it("returns state unchanged when tab not present", () => {
    const state = s([ROOT_A], ROOT_A)
    expect(removeTab(state, "missing")).toBe(state)
  })
})

describe("no classification invariant", () => {
  it("all operations treat root-looking, child-looking, and worktree-looking IDs identically", () => {
    const ids = [ROOT_A, CHILD_A, ROOT_B, CHILD_B, GRANDCHILD, WORKTREE_X, WORKTREE_Y]

    // seed: preserves all IDs without filtering
    const seeded = seedTabs(ids, GRANDCHILD)
    expect(seeded.ids).toHaveLength(7)
    expect(seeded.active).toBe(GRANDCHILD)

    // open: adds a new child-looking ID
    const opened = openTab(seeded, "child-new-xxxx")
    expect(opened.ids).toHaveLength(8)
    expect(opened.active).toBe("child-new-xxxx")

    // select: activates any ID
    const selected = selectTab(opened, WORKTREE_Y)
    expect(selected.active).toBe(WORKTREE_Y)

    // close: removes any ID
    const closed = closeTab(selected, ROOT_A)
    expect(closed.ids).toHaveLength(7)
    expect(closed.ids).not.toContain(ROOT_A)

    // closeOthers: retains any ID
    const solo = closeOtherTabs(closed, GRANDCHILD)
    expect(solo.ids).toEqual([GRANDCHILD])
    expect(solo.active).toBe(GRANDCHILD)

    // merge: adds without evicting
    const merged = mergeTabs(solo, [ROOT_A, CHILD_A, WORKTREE_X])
    expect(merged.ids).toEqual([GRANDCHILD, ROOT_A, CHILD_A, WORKTREE_X])
    expect(merged.active).toBe(GRANDCHILD)

    // refresh: additive only
    const refreshed = refreshTabs(merged, [ROOT_B, CHILD_B, WORKTREE_Y])
    expect(refreshed.ids).toEqual([GRANDCHILD, ROOT_A, CHILD_A, WORKTREE_X, ROOT_B, CHILD_B, WORKTREE_Y])
    expect(refreshed.active).toBe(GRANDCHILD)
  })
})
