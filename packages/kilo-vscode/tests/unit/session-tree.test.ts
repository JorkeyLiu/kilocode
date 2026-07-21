/**
 * Tests for shared session tree utilities.
 *
 * Covers: descendant closure after root classification, deep nesting,
 * orphan/cycle handling, inherited date groups, and ownership (children
 * never become independent root owners).
 */

import { describe, it, expect } from "bun:test"
import {
  buildDisplayList,
  buildByID,
  buildDescendantsClosure,
  ancestorIDs,
  resolveGroupKey,
  dateGroupKey,
  DATE_GROUP_KEYS,
  type SessionLike,
} from "../../webview-ui/src/utils/session-tree"

const at = (day: number, hour = 0) =>
  `2026-01-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`

function s(id: string, parentID: string | null = null, day = 1, updatedAt?: number): SessionLike {
  return { id, parentID, createdAt: at(day), updatedAt: at(updatedAt ?? day) }
}

describe("buildByID", () => {
  it("creates a lookup map from session ID to session", () => {
    const sessions = [s("a"), s("b", "a")]
    const map = buildByID(sessions)
    expect(map.size).toBe(2)
    expect(map.get("a")?.id).toBe("a")
    expect(map.get("b")?.id).toBe("b")
  })

  it("last-write-wins for duplicate IDs", () => {
    const sessions = [s("a", null, 1), s("a", null, 2)]
    const map = buildByID(sessions)
    expect(map.get("a")?.createdAt).toBe(at(2))
  })
})

describe("ancestorIDs", () => {
  it("returns empty for root sessions", () => {
    const sessions = [s("root")]
    expect(ancestorIDs(sessions[0], buildByID(sessions))).toEqual([])
  })

  it("returns parent ID for direct child", () => {
    const sessions = [s("root"), s("child", "root")]
    expect(ancestorIDs(sessions[1], buildByID(sessions))).toEqual(["root"])
  })

  it("returns ancestor chain for deep nesting", () => {
    const sessions = [s("a"), s("b", "a"), s("c", "b"), s("d", "c")]
    expect(ancestorIDs(sessions[3], buildByID(sessions))).toEqual(["c", "b", "a"])
  })

  it("stops at cycle boundary", () => {
    // a -> b -> a (cycle)
    const sessions = [s("a", "b"), s("b", "a")]
    const result = ancestorIDs(sessions[0], buildByID(sessions))
    // b is parent of a, but b's parent is a which is already visited
    expect(result).toEqual(["b"])
  })

  it("handles missing parent gracefully", () => {
    const sessions = [s("orphan", "missing")]
    expect(ancestorIDs(sessions[0], buildByID(sessions))).toEqual(["missing"])
  })
})

describe("buildDescendantsClosure", () => {
  it("returns only roots when roots have no children", () => {
    const sessions = [s("r1"), s("r2")]
    const result = buildDescendantsClosure(new Set(["r1", "r2"]), sessions)
    expect(result.map((i) => i.id)).toEqual(["r1", "r2"])
  })

  it("includes children of roots in depth-first order", () => {
    const sessions = [s("r1", null, 1), s("c1", "r1", 2), s("c2", "r1", 3), s("r2", null, 4)]
    const result = buildDescendantsClosure(new Set(["r1", "r2"]), sessions)
    expect(result.map((i) => i.id)).toEqual(["r1", "c1", "c2", "r2"])
  })

  it("includes grandchildren (deep nesting)", () => {
    const sessions = [s("r"), s("c", "r"), s("gc", "c")]
    const result = buildDescendantsClosure(new Set(["r"]), sessions)
    expect(result.map((i) => i.id)).toEqual(["r", "c", "gc"])
  })

  it("does not include children of non-root sessions that are not in the closure", () => {
    const sessions = [s("r1", null, 1), s("c1", "r1", 2), s("r2", null, 3), s("c2", "r2", 4)]
    // Only r1 is a root
    const result = buildDescendantsClosure(new Set(["r1"]), sessions)
    expect(result.map((i) => i.id)).toEqual(["r1", "c1"])
    // r2 and c2 are excluded
    expect(result.find((i) => i.id === "r2")).toBeUndefined()
  })

  it("children never become independent owners (only root set determines ownership)", () => {
    const sessions = [s("r", null, 1), s("child", "r", 2)]
    // If "child" is not in rootIDs, it only appears as a descendant of "r"
    const result = buildDescendantsClosure(new Set(["r"]), sessions)
    expect(result[0].id).toBe("r")
    expect(result[1].id).toBe("child")
    // child is not an independent root
    expect(result.length).toBe(2)
  })

  it("skips unknown root IDs gracefully", () => {
    const sessions = [s("r")]
    const result = buildDescendantsClosure(new Set(["r", "missing"]), sessions)
    expect(result.map((i) => i.id)).toEqual(["r"])
  })

  it("handles cycle safely (a -> b -> a)", () => {
    const sessions = [s("a", "b", 1), s("b", "a", 2)]
    const result = buildDescendantsClosure(new Set(["a"]), sessions)
    // "a" is the root, "b" is a child of "a" (since parentID of b = a), so b is included
    expect(result.map((i) => i.id)).toEqual(["a", "b"])
  })

  it("handles empty root set", () => {
    const sessions = [s("r")]
    const result = buildDescendantsClosure(new Set(), sessions)
    expect(result).toEqual([])
  })

  it("handles empty sessions", () => {
    const result = buildDescendantsClosure(new Set(["r"]), [])
    expect(result).toEqual([])
  })
})

describe("buildDisplayList — descendant closure from complete session set", () => {
  it("renders children that are not roots when their parent is expanded", () => {
    // Simulates: root "r" is classified as unassigned, child "c" is not a root
    // but should appear when r is expanded
    const sessions = [s("r"), s("c", "r")]
    const items = buildDisplayList(sessions, new Set(["r"]))
    expect(items).toHaveLength(2)
    expect(items[0].session.id).toBe("r")
    expect(items[0].depth).toBe(0)
    expect(items[1].session.id).toBe("c")
    expect(items[1].depth).toBe(1)
    expect(items[1].seq).toBe(1)
  })

  it("hides children when parent is collapsed (default)", () => {
    const sessions = [s("r"), s("c", "r")]
    const items = buildDisplayList(sessions, new Set())
    expect(items).toHaveLength(1)
    expect(items[0].session.id).toBe("r")
    expect(items[0].hasChildren).toBe(true)
  })

  it("renders deep nesting correctly", () => {
    const sessions = [s("r"), s("c", "r"), s("gc", "c")]
    const items = buildDisplayList(sessions, new Set(["r", "c"]))
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ session: { id: "r" }, depth: 0 })
    expect(items[1]).toMatchObject({ session: { id: "c" }, depth: 1, seq: 1 })
    expect(items[2]).toMatchObject({ session: { id: "gc" }, depth: 2, seq: 1 })
  })
})

describe("buildDisplayList — cycle-only component fallback", () => {
  it("renders cycle-only sessions at depth 0 when no root is reachable", () => {
    // a -> b -> a (mutual cycle, no null parent)
    const sessions = [s("a", "b"), s("b", "a")]
    const items = buildDisplayList(sessions, new Set())
    expect(items).toHaveLength(2)
    // Both rendered at depth 0 as orphans
    expect(items.every((i) => i.depth === 0)).toBe(true)
  })

  it("renders cycle sessions mixed with normal roots", () => {
    const sessions = [s("root"), s("a", "b"), s("b", "a")]
    const items = buildDisplayList(sessions, new Set())
    expect(items).toHaveLength(3)
    // root is a normal root, a and b form a cycle rendered as orphans
    expect(items[0].session.id).toBe("root")
    expect(items[0].depth).toBe(0)
    // a and b are orphans (cycle)
    expect(items.slice(1).every((i) => i.depth === 0)).toBe(true)
  })
})

describe("resolveGroupKey — date group inheritance", () => {
  it("root uses its own updatedAt for grouping", () => {
    const root = s("r", null, 5)
    const byID = buildByID([root])
    const item = { session: root, depth: 0, hasChildren: false }
    expect(resolveGroupKey(item, byID)).toBe(dateGroupKey(root.updatedAt))
  })

  it("child inherits root ancestor's date group", () => {
    const root = s("r", null, 5)
    const child = s("c", "r", 10)
    const byID = buildByID([root, child])
    const item = { session: child, depth: 1, seq: 1, hasChildren: false }
    // Child's group should be based on root's updatedAt (day 5), not child's (day 10)
    expect(resolveGroupKey(item, byID)).toBe(dateGroupKey(root.updatedAt))
  })

  it("grandchild inherits root's date group through chain", () => {
    const root = s("r", null, 1)
    const child = s("c", "r", 5)
    const grandchild = s("gc", "c", 10)
    const byID = buildByID([root, child, grandchild])
    const item = { session: grandchild, depth: 2, seq: 1, hasChildren: false }
    expect(resolveGroupKey(item, byID)).toBe(dateGroupKey(root.updatedAt))
  })

  it("handles cycle gracefully (falls back to last reachable ancestor or self)", () => {
    const a = s("a", "b", 1)
    const b = s("b", "a", 5)
    const byID = buildByID([a, b])
    const item = { session: a, depth: 0, hasChildren: false }
    // Should not throw; cycle detected, uses fallback
    const result = resolveGroupKey(item, byID)
    expect(typeof result).toBe("string")
    expect(DATE_GROUP_KEYS).toContain(result)
  })

  it("orphan with missing parent uses its own updatedAt", () => {
    const orphan = s("orphan", "missing", 3)
    const byID = buildByID([orphan])
    const item = { session: orphan, depth: 0, hasChildren: false }
    expect(resolveGroupKey(item, byID)).toBe(dateGroupKey(orphan.updatedAt))
  })
})

describe("dateGroupKey", () => {
  it("returns a valid date group key for any ISO string", () => {
    const key = dateGroupKey("2020-01-01T00:00:00Z")
    expect(DATE_GROUP_KEYS).toContain(key)
  })

  it("returns 'time.older' for very old dates", () => {
    const key = dateGroupKey("2000-01-01T00:00:00Z")
    expect(key).toBe("time.older")
  })
})

describe("ownership semantics", () => {
  it("descendants of a root are returned but do not own worktree/local slots", () => {
    // This test documents the invariant: children inherit ownership from their root.
    // The root "r" is unassigned; "child" appears in the display list via the root
    // but is not independently classified as worktree/local/unassigned.
    const sessions = [s("r", null, 1), s("child", "r", 2), s("worktree-root", null, 3)]
    const worktree = new Set(["worktree-root"])
    const local = new Set<string>()

    // filterUnassignedSessions returns only roots
    const roots = sessions.filter((sess) => sess.parentID === null && !worktree.has(sess.id) && !local.has(sess.id))
    expect(roots.map((i) => i.id)).toEqual(["r"])

    // buildDescendantsClosure with only "r" includes "child"
    const closure = buildDescendantsClosure(new Set(roots.map((i) => i.id)), sessions)
    expect(closure.map((i) => i.id)).toEqual(["r", "child"])

    // "child" is NOT an independent root — it would fail isKnownRootSession
    expect(closure[1].parentID).toBe("r")
  })

  it("deep nested descendants are all included in closure", () => {
    const sessions = [s("r", null, 1), s("c1", "r", 2), s("c2", "r", 3), s("gc1", "c1", 4), s("ggc1", "gc1", 5)]
    const closure = buildDescendantsClosure(new Set(["r"]), sessions)
    expect(closure.map((i) => i.id)).toEqual(["r", "c1", "gc1", "ggc1", "c2"])
  })

  it("multiple roots each get their own descendant trees", () => {
    const sessions = [s("r1", null, 1), s("c1", "r1", 2), s("r2", null, 3), s("c2", "r2", 4)]
    const closure = buildDescendantsClosure(new Set(["r1", "r2"]), sessions)
    expect(closure.map((i) => i.id)).toEqual(["r1", "c1", "r2", "c2"])
  })
})

describe("worktree display — descendant closure for sidebar", () => {
  it("worktree root includes deep descendants in display closure", () => {
    const sessions = [
      s("wt-root", null, 1),
      s("wt-child", "wt-root", 2),
      s("wt-grandchild", "wt-child", 3),
      s("wt-ggc", "wt-grandchild", 4),
      s("other-root", null, 5),
    ]
    // Worktree owns only wt-root; its descendants must appear
    const closure = buildDescendantsClosure(new Set(["wt-root"]), sessions)
    expect(closure.map((i) => i.id)).toEqual(["wt-root", "wt-child", "wt-grandchild", "wt-ggc"])
    // other-root is NOT included
    expect(closure.find((i) => i.id === "other-root")).toBeUndefined()
  })

  it("multiple worktree roots each get their own descendant trees", () => {
    const sessions = [
      s("wt1-root", null, 1),
      s("wt1-child", "wt1-root", 2),
      s("wt2-root", null, 3),
      s("wt2-child", "wt2-root", 4),
    ]
    const closure = buildDescendantsClosure(new Set(["wt1-root", "wt2-root"]), sessions)
    expect(closure.map((i) => i.id)).toEqual(["wt1-root", "wt1-child", "wt2-root", "wt2-child"])
  })

  it("excluded worktree root excludes its entire descendant tree", () => {
    const sessions = [
      s("wt1-root", null, 1),
      s("wt1-child", "wt1-root", 2),
      s("wt1-grandchild", "wt1-child", 3),
      s("wt2-root", null, 4),
      s("wt2-child", "wt2-root", 5),
    ]
    // Only wt2-root is a worktree owner; wt1's entire tree is excluded
    const closure = buildDescendantsClosure(new Set(["wt2-root"]), sessions)
    expect(closure.map((i) => i.id)).toEqual(["wt2-root", "wt2-child"])
    expect(closure.find((i) => i.id === "wt1-root")).toBeUndefined()
    expect(closure.find((i) => i.id === "wt1-child")).toBeUndefined()
    expect(closure.find((i) => i.id === "wt1-grandchild")).toBeUndefined()
  })
})

describe("local display — descendant closure for sidebar", () => {
  it("local root includes descendants", () => {
    const sessions = [
      s("local-root", null, 1),
      s("local-child", "local-root", 2),
      s("local-grandchild", "local-child", 3),
      s("unassigned-root", null, 4),
    ]
    const closure = buildDescendantsClosure(new Set(["local-root"]), sessions)
    expect(closure.map((i) => i.id)).toEqual(["local-root", "local-child", "local-grandchild"])
    expect(closure.find((i) => i.id === "unassigned-root")).toBeUndefined()
  })

  it("local root with no children returns only the root", () => {
    const sessions = [s("local-root", null, 1)]
    const closure = buildDescendantsClosure(new Set(["local-root"]), sessions)
    expect(closure.map((i) => i.id)).toEqual(["local-root"])
  })
})

describe("child sessions never become independent owners", () => {
  it("child in worktree display closure is not an independent root", () => {
    const sessions = [s("wt-root", null, 1), s("wt-child", "wt-root", 2)]
    const closure = buildDescendantsClosure(new Set(["wt-root"]), sessions)
    // child appears as descendant, not as root
    expect(closure[0].parentID).toBeNull()
    expect(closure[1].parentID).toBe("wt-root")
    // child would fail isKnownRootSession
    expect(closure[1].parentID).not.toBeNull()
  })

  it("child in local display closure is not an independent root", () => {
    const sessions = [s("local-root", null, 1), s("local-child", "local-root", 2)]
    const closure = buildDescendantsClosure(new Set(["local-root"]), sessions)
    expect(closure[0].parentID).toBeNull()
    expect(closure[1].parentID).toBe("local-root")
  })

  it("deep descendants are not independent owners", () => {
    const sessions = [s("root", null, 1), s("c", "root", 2), s("gc", "c", 3), s("ggc", "gc", 4)]
    const closure = buildDescendantsClosure(new Set(["root"]), sessions)
    // Only root is an owner (parentID === null)
    const owners = closure.filter((s) => s.parentID === null)
    expect(owners.map((i) => i.id)).toEqual(["root"])
    // All others have parentIDs
    const children = closure.filter((s) => s.parentID !== null)
    expect(children.map((i) => i.id)).toEqual(["c", "gc", "ggc"])
  })
})

describe("active child expands ancestors — ancestorIDs integration", () => {
  it("active child deep in tree resolves full ancestor chain", () => {
    const sessions = [s("root", null, 1), s("c", "root", 2), s("gc", "c", 3), s("ggc", "gc", 4)]
    const byID = buildByID(sessions)
    // The deepest descendant should resolve all ancestors
    const ancestors = ancestorIDs(sessions[3], byID)
    expect(ancestors).toEqual(["gc", "c", "root"])
  })

  it("ancestorIDs resolves when parent is missing from the map (orphan)", () => {
    // Simulates delayed metadata: child arrives before its parent.
    const child = { id: "child", parentID: "root", createdAt: at(2), updatedAt: at(2) }
    const emptyBy = buildByID([])
    // parentID "root" is pushed even though root is not in the map
    expect(ancestorIDs(child, emptyBy)).toEqual(["root"])

    // After metadata loads, ancestorIDs resolves correctly
    const full = [s("root", null, 1), s("child", "root", 2)]
    expect(ancestorIDs(child, buildByID(full))).toEqual(["root"])
  })

  it("display list recovers when sessions load after active child is set", () => {
    // Before sessions load: empty list, no child visible
    const empty = buildDisplayList([], new Set())
    expect(empty).toHaveLength(0)

    // After sessions load: child and root appear, child expandable under root
    const full = [s("root", null, 1), s("child", "root", 2)]
    const expanded = new Set(["root"])
    const items = buildDisplayList(full, expanded)
    expect(items).toHaveLength(2)
    expect(items[0].session.id).toBe("root")
    expect(items[1].session.id).toBe("child")
    expect(items[1].depth).toBe(1)
  })

  it("active child at depth 1 resolves only root ancestor", () => {
    const sessions = [s("root", null, 1), s("c", "root", 2)]
    const byID = buildByID(sessions)
    const ancestors = ancestorIDs(sessions[1], byID)
    expect(ancestors).toEqual(["root"])
  })

  it("root session has no ancestors to expand", () => {
    const sessions = [s("root", null, 1), s("c", "root", 2)]
    const byID = buildByID(sessions)
    const ancestors = ancestorIDs(sessions[0], byID)
    expect(ancestors).toEqual([])
  })
})
