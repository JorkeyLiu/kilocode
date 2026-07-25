/**
 * Regression tests for the active-preservation decision logic used in
 * useFilteredList's grouped effect.
 *
 * The hook uses createResource (requires browser runtime), so these tests
 * verify the decision algorithm directly — the same filter-change detection
 * and active-preservation logic that the effect implements.
 *
 * Contract:
 * - Filter changed  → don't preserve (reset to first)
 * - Items changed, active still in list → preserve active (viewport anchor)
 * - Items changed, active removed → don't preserve (reset to first)
 */

import { describe, it, expect } from "bun:test"
import { shouldPreserveActive } from "./use-filtered-list"

describe("useFilteredList active-preservation logic", () => {
  it("preserves active when items change without filter change", () => {
    expect(shouldPreserveActive(false, "b", ["a", "b", "c", "d"])).toBe(true)
  })

  it("resets active when filter changes", () => {
    expect(shouldPreserveActive(true, "b", ["c", "d"])).toBe(false)
  })

  it("falls back to first when active item is removed", () => {
    expect(shouldPreserveActive(false, "c", ["a", "b"])).toBe(false)
  })

  it("preserves active when more items are added", () => {
    expect(shouldPreserveActive(false, "a", ["a", "b", "c", "d", "e"])).toBe(true)
  })

  it("resets to first when current active is empty", () => {
    expect(shouldPreserveActive(false, "", ["a", "b", "c"])).toBe(false)
  })

  it("handles single-item list", () => {
    expect(shouldPreserveActive(false, "a", ["a"])).toBe(true)
  })

  it("handles filter change even when active still exists", () => {
    // User was on "b", starts typing a filter — should not preserve
    expect(shouldPreserveActive(true, "b", ["a", "b", "c"])).toBe(false)
  })
})
