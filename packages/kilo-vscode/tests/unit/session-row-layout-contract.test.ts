/**
 * Layout contract tests for session row fixed-column alignment.
 *
 * Validates that `buildDisplayList` produces DisplayItem shapes that
 * satisfy the rendering contract for the four row forms:
 *
 *   root leaf  | root parent | child leaf | nested parent
 *
 * Each row must be able to render:
 *   hierarchy indent | disclosure slot | sequence slot | title | description
 *
 * The disclosure and sequence slots are always present — either a real
 * interactive element or an inert placeholder — so titles align.
 *
 * Visual rendering itself requires a browser and is not tested here;
 * these tests validate the data-shape contract the component relies on.
 *
 * Disclosure hit-area contract:
 *   The disclosure column's visual width is ~12–14px (compact indent),
 *   but the interactive hit target must be ≥24×24 CSS pixels for
 *   accessibility. CSS achieves this via transparent padding + negative
 *   margin so the layout contribution stays compact. The tests below
 *   verify the data-shape supports this two-sizes contract.
 */

import { describe, it, expect } from "bun:test"
import { buildDisplayList, type SessionLike } from "../../webview-ui/src/utils/session-tree"

/** Minimal session factory for contract tests. */
function session(id: string, opts?: { parentID?: string; createdAt?: string }): SessionLike {
  return {
    id,
    parentID: opts?.parentID ?? null,
    createdAt: opts?.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }
}

describe("session row layout contract — buildDisplayList", () => {
  it("produces a root leaf when no children exist", () => {
    const sessions = [session("a")]
    const items = buildDisplayList(sessions, new Set())
    expect(items).toHaveLength(1)
    const item = items[0]
    expect(item.depth).toBe(0)
    expect(item.hasChildren).toBe(false)
    // seq is undefined for root rows (slot renders placeholder)
    expect(item.seq).toBeUndefined()
  })

  it("produces a root parent when children exist but are collapsed", () => {
    const sessions = [session("p"), session("c1", { parentID: "p" }), session("c2", { parentID: "p" })]
    const items = buildDisplayList(sessions, new Set())
    // Only the parent is visible when collapsed
    expect(items).toHaveLength(1)
    const item = items[0]
    expect(item.depth).toBe(0)
    expect(item.hasChildren).toBe(true)
    expect(item.seq).toBeUndefined()
  })

  it("produces child leaf rows with sequential seq numbers when parent is expanded (newest first)", () => {
    const sessions = [
      session("p"),
      session("c1", { parentID: "p", createdAt: "2026-01-01T00:00:00Z" }),
      session("c2", { parentID: "p", createdAt: "2026-01-02T00:00:00Z" }),
    ]
    const items = buildDisplayList(sessions, new Set(["p"]))
    expect(items).toHaveLength(3)
    // Parent
    expect(items[0].depth).toBe(0)
    expect(items[0].hasChildren).toBe(true)
    // Children — newest (c2) first, oldest (c1) last
    expect(items[1].session.id).toBe("c2")
    expect(items[1].depth).toBe(1)
    expect(items[1].seq).toBe(2)
    expect(items[2].session.id).toBe("c1")
    expect(items[2].depth).toBe(1)
    expect(items[2].seq).toBe(1)
  })

  it("produces nested parent rows (child that has its own children)", () => {
    const sessions = [
      session("p"),
      session("c1", { parentID: "p", createdAt: "2026-01-01T00:00:00Z" }),
      session("gc1", { parentID: "c1" }),
    ]
    const items = buildDisplayList(sessions, new Set(["p", "c1"]))
    expect(items).toHaveLength(3)
    // c1 is a nested parent: depth=1, hasChildren=true, seq=1
    const nestedParent = items[1]
    expect(nestedParent.depth).toBe(1)
    expect(nestedParent.hasChildren).toBe(true)
    expect(nestedParent.seq).toBe(1)
    // gc1 is a nested leaf: depth=2, hasChildren=false, seq=1
    const nestedLeaf = items[2]
    expect(nestedLeaf.depth).toBe(2)
    expect(nestedLeaf.hasChildren).toBe(false)
    expect(nestedLeaf.seq).toBe(1)
  })

  it("all row types carry the required shape for fixed-column rendering", () => {
    const sessions = [
      session("root-leaf", { createdAt: "2026-01-01T00:00:00Z" }),
      session("root-parent", { createdAt: "2026-01-02T00:00:00Z" }),
      session("child-leaf", { parentID: "root-parent", createdAt: "2026-01-03T00:00:00Z" }),
      session("nested-parent", { parentID: "root-parent", createdAt: "2026-01-04T00:00:00Z" }),
      session("grandchild", { parentID: "nested-parent", createdAt: "2026-01-05T00:00:00Z" }),
    ]
    const items = buildDisplayList(sessions, new Set(["root-parent", "nested-parent"]))

    // All items must have depth (for indent) and hasChildren (for disclosure slot)
    for (const item of items) {
      expect(typeof item.depth).toBe("number")
      expect(typeof item.hasChildren).toBe("boolean")
    }

    // Root rows: seq is undefined → component renders sequence placeholder
    const rootItems = items.filter((i) => i.depth === 0)
    for (const item of rootItems) {
      expect(item.seq).toBeUndefined()
    }

    // Child rows: seq is a positive integer → component renders real sequence
    const childItems = items.filter((i) => i.depth > 0)
    for (const item of childItems) {
      expect(typeof item.seq).toBe("number")
      expect(item.seq).toBeGreaterThan(0)
    }
  })
})

describe("session row layout contract — disclosure slot vs hit area", () => {
  // The disclosure column renders at a compact visual width (~12–14px)
  // for alignment, but the interactive hit target must be ≥24×24 CSS
  // pixels (WCAG 2.5.8 Target Size). CSS achieves this with transparent
  // padding + negative margin on `.am-session-expand-toggle`.
  //
  // These tests verify the data-shape contract that enables the
  // two-sizes pattern. The actual CSS pixel sizes are validated by
  // visual inspection / browser dev tools, not unit tests.

  it("disclosure slot is controlled by hasChildren flag", () => {
    // Parent rows have hasChildren=true → real toggle button rendered
    const parent = buildDisplayList([session("p"), session("c", { parentID: "p" })], new Set())
    expect(parent[0].hasChildren).toBe(true)

    // Leaf rows have hasChildren=false → inert placeholder rendered
    const leaf = buildDisplayList([session("l")], new Set())
    expect(leaf[0].hasChildren).toBe(false)
  })

  it("disclosure slot exists at every depth level (titles stay aligned)", () => {
    const sessions = [
      session("r"),
      session("c", { parentID: "r", createdAt: "2026-01-02T00:00:00Z" }),
      session("gc", { parentID: "c" }),
    ]
    const items = buildDisplayList(sessions, new Set(["r", "c"]))
    // Every row has hasChildren — true or false — so the disclosure
    // column always occupies space and titles align across depths.
    for (const item of items) {
      expect(typeof item.hasChildren).toBe("boolean")
    }
  })

  it("visual indent is depth × DEPTH_PX (12px per level, compact column)", () => {
    // The component uses DEPTH_PX = 12 for the indent multiplier.
    // This is the visual column width, not the hit target size.
    const DEPTH_PX = 12
    const sessions = [session("r"), session("c", { parentID: "r", createdAt: "2026-01-02T00:00:00Z" })]
    const items = buildDisplayList(sessions, new Set(["r"]))
    // Root: depth=0 → indent=0px
    expect(items[0].depth * DEPTH_PX).toBe(0)
    // Child: depth=1 → indent=12px (compact visual column)
    expect(items[1].depth * DEPTH_PX).toBe(12)
    // The hit target is expanded to ≥24×24 via CSS padding + negative margin,
    // which does not affect the depth-based indent calculation.
  })
})
