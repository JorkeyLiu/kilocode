/**
 * Tests for scroll-preservation helpers used by SidebarSessionList and
 * history SessionList.
 *
 * Validates:
 * - findBySidebarId / findByAttr find elements by data attribute without selector interpolation
 * - captureScrollAnchor finds the first visible item in the viewport
 * - restoreScrollAnchor adjusts scrollTop to keep the anchor at the same visual offset
 * - Anchor disappearance is handled gracefully (returns null, no throw)
 * - Generalized attr parameter works with data-key (history list pattern)
 */

import { describe, it, expect } from "bun:test"
import {
  findByAttr,
  findBySidebarId,
  captureScrollAnchor,
  restoreScrollAnchor,
  createScrollAnchorTracker,
  type ScrollAnchor,
} from "../../webview-ui/src/utils/scroll-anchor"

/** Minimal mock of an element with getBoundingClientRect and getAttribute. */
function mockElement(
  id: string | null,
  rect: { top: number; bottom: number; height: number },
  attr = "data-sidebar-id",
): HTMLElement {
  return {
    getAttribute: (a: string) => (a === attr ? id : null),
    getBoundingClientRect: () => ({ ...rect, left: 0, right: 100, width: 100, x: 0, y: rect.top }),
    scrollTop: 0,
  } as unknown as HTMLElement
}

function mockContainer(
  rect: { top: number; bottom: number; height: number },
  children: HTMLElement[],
): HTMLElement {
  let scrollTop = 0
  return {
    getBoundingClientRect: () => ({ ...rect, left: 0, right: 100, width: 100, x: 0, y: rect.top }),
    querySelectorAll: () => children,
    querySelector: (sel: string) => {
      // Minimal support for "[data-key=\"...\"]" selector used by findByAttr→refocus path
      const match = sel.match(/\[data-key="(.+?)"\]/)
      if (match) {
        const val = match[1]
        return children.find((c) => (c as unknown as { _key?: string })._key === val) ?? null
      }
      return null
    },
    get scrollTop() {
      return scrollTop
    },
    set scrollTop(v: number) {
      scrollTop = v
    },
  } as unknown as HTMLElement
}

describe("findBySidebarId", () => {
  it("finds element by data-sidebar-id attribute", () => {
    const items = [
      mockElement("a", { top: 0, bottom: 40, height: 40 }),
      mockElement("b", { top: 40, bottom: 80, height: 40 }),
      mockElement("c", { top: 80, bottom: 120, height: 40 }),
    ]
    const container = mockContainer({ top: 0, bottom: 300, height: 300 }, items)
    expect(findBySidebarId(container, "b")).toBe(items[1])
  })

  it("returns null when ID not found", () => {
    const items = [mockElement("a", { top: 0, bottom: 40, height: 40 })]
    const container = mockContainer({ top: 0, bottom: 300, height: 300 }, items)
    expect(findBySidebarId(container, "z")).toBeNull()
  })

  it("returns null for empty container", () => {
    const container = mockContainer({ top: 0, bottom: 300, height: 300 }, [])
    expect(findBySidebarId(container, "a")).toBeNull()
  })
})

describe("findByAttr (generic)", () => {
  it("finds element by custom attribute", () => {
    const items = [
      mockElement("x", { top: 0, bottom: 40, height: 40 }, "data-key"),
      mockElement("y", { top: 40, bottom: 80, height: 40 }, "data-key"),
    ]
    const container = mockContainer({ top: 0, bottom: 300, height: 300 }, items)
    expect(findByAttr(container, "data-key", "y")).toBe(items[1])
  })

  it("returns null when value not found", () => {
    const items = [mockElement("x", { top: 0, bottom: 40, height: 40 }, "data-key")]
    const container = mockContainer({ top: 0, bottom: 300, height: 300 }, items)
    expect(findByAttr(container, "data-key", "z")).toBeNull()
  })

  it("does not match elements with a different attribute", () => {
    const items = [
      mockElement("x", { top: 0, bottom: 40, height: 40 }, "data-sidebar-id"),
    ]
    const container = mockContainer({ top: 0, bottom: 300, height: 300 }, items)
    expect(findByAttr(container, "data-key", "x")).toBeNull()
  })
})

describe("captureScrollAnchor", () => {
  it("captures the first item visible in the viewport", () => {
    // Container viewport starts at y=100
    const items = [
      mockElement("a", { top: 10, bottom: 50, height: 40 }), // above viewport
      mockElement("b", { top: 90, bottom: 130, height: 40 }), // overlaps top
      mockElement("c", { top: 130, bottom: 170, height: 40 }), // fully inside
    ]
    const container = mockContainer({ top: 100, bottom: 400, height: 300 }, items)
    const anchor = captureScrollAnchor(container)
    expect(anchor).not.toBeNull()
    expect(anchor!.id).toBe("b") // first item whose bottom > container top
    expect(anchor!.offset).toBe(-10) // 90 - 100
  })

  it("returns null when no items exist", () => {
    const container = mockContainer({ top: 100, bottom: 400, height: 300 }, [])
    expect(captureScrollAnchor(container)).toBeNull()
  })

  it("returns null when all items are above viewport", () => {
    const items = [
      mockElement("a", { top: 10, bottom: 50, height: 40 }),
      mockElement("b", { top: 50, bottom: 90, height: 40 }),
    ]
    // Container top at 100 — both items have bottom <= 100
    const container = mockContainer({ top: 100, bottom: 400, height: 300 }, items)
    expect(captureScrollAnchor(container)).toBeNull()
  })

  it("captures anchor using custom attr (data-key for history list)", () => {
    const items = [
      mockElement("session-1", { top: 10, bottom: 50, height: 40 }, "data-key"),
      mockElement("session-2", { top: 90, bottom: 130, height: 40 }, "data-key"),
    ]
    const container = mockContainer({ top: 100, bottom: 400, height: 300 }, items)
    const anchor = captureScrollAnchor(container, "data-key")
    expect(anchor).not.toBeNull()
    expect(anchor!.id).toBe("session-2")
    expect(anchor!.offset).toBe(-10)
  })
})

describe("restoreScrollAnchor", () => {
  it("adjusts scrollTop to maintain anchor visual offset", () => {
    // After DOM update, the anchor "b" moved from offset -10 to offset 50
    const items = [
      mockElement("a", { top: 60, bottom: 100, height: 40 }),
      mockElement("b", { top: 150, bottom: 190, height: 40 }),
      mockElement("c", { top: 190, bottom: 230, height: 40 }),
    ]
    const container = mockContainer({ top: 100, bottom: 400, height: 300 }, items)
    const anchor: ScrollAnchor = { id: "b", offset: -10 }

    restoreScrollAnchor(container, anchor)

    // currentOffset = 150 - 100 = 50
    // adjustment = 50 - (-10) = 60
    expect(container.scrollTop).toBe(60)
  })

  it("does nothing when anchor element disappears", () => {
    // Anchor "z" not in the list
    const items = [mockElement("a", { top: 100, bottom: 140, height: 40 })]
    const container = mockContainer({ top: 100, bottom: 400, height: 300 }, items)
    const anchor: ScrollAnchor = { id: "z", offset: 0 }

    // Should not throw
    restoreScrollAnchor(container, anchor)
    expect(container.scrollTop).toBe(0)
  })

  it("handles anchor already at correct position (no-op)", () => {
    const items = [
      mockElement("a", { top: 100, bottom: 140, height: 40 }),
      mockElement("b", { top: 140, bottom: 180, height: 40 }),
    ]
    const container = mockContainer({ top: 100, bottom: 400, height: 300 }, items)
    // Anchor "b" was at offset 40, now at offset 40 — no change needed
    const anchor: ScrollAnchor = { id: "b", offset: 40 }

    restoreScrollAnchor(container, anchor)
    expect(container.scrollTop).toBe(0)
  })

  it("restores scroll using custom attr (data-key for history list)", () => {
    const items = [
      mockElement("s1", { top: 60, bottom: 100, height: 40 }, "data-key"),
      mockElement("s2", { top: 150, bottom: 190, height: 40 }, "data-key"),
    ]
    const container = mockContainer({ top: 100, bottom: 400, height: 300 }, items)
    const anchor: ScrollAnchor = { id: "s2", offset: -10 }

    restoreScrollAnchor(container, anchor, "data-key")

    // currentOffset = 150 - 100 = 50
    // adjustment = 50 - (-10) = 60
    expect(container.scrollTop).toBe(60)
  })
})

describe("history disclosure scroll anchor lifecycle", () => {
  /**
   * Simulates the real lifecycle: before toggle, the scroll container has
   * items with data-key attributes.  After toggle, the DOM is replaced
   * (new object references from buildDisplayList), but the anchor item
   * should still be found and scroll adjusted.
   */
  it("preserves viewport across expand/collapse with data-key items", () => {
    // Before: parent "p" visible at offset 20, child items below
    const beforeItems = [
      mockElement("p", { top: 120, bottom: 160, height: 40 }, "data-key"),
      mockElement("q", { top: 160, bottom: 200, height: 40 }, "data-key"),
    ]
    const beforeContainer = mockContainer({ top: 100, bottom: 400, height: 300 }, beforeItems)

    // Capture anchor — "p" is the first visible item
    const anchor = captureScrollAnchor(beforeContainer, "data-key")
    expect(anchor).not.toBeNull()
    expect(anchor!.id).toBe("p")
    expect(anchor!.offset).toBe(20) // 120 - 100

    // After: children inserted, "p" pushed down (simulating expand)
    const afterItems = [
      mockElement("p", { top: 120, bottom: 160, height: 40 }, "data-key"),
      mockElement("p-c1", { top: 160, bottom: 200, height: 40 }, "data-key"),
      mockElement("p-c2", { top: 200, bottom: 240, height: 40 }, "data-key"),
      mockElement("q", { top: 240, bottom: 280, height: 40 }, "data-key"),
    ]
    // Same container with new children (scrollTop reset to 0 as browser would do)
    const afterContainer = mockContainer({ top: 100, bottom: 400, height: 300 }, afterItems)

    // Restore should keep "p" at offset 20
    restoreScrollAnchor(afterContainer, anchor!, "data-key")
    // "p" is already at 120, container at 100, currentOffset=20, anchor offset=20 → no change
    expect(afterContainer.scrollTop).toBe(0)
  })

  it("adjusts scrollTop when children push anchor down", () => {
    // Before: "p" at offset 0 (top of viewport)
    const beforeItems = [
      mockElement("p", { top: 100, bottom: 140, height: 40 }, "data-key"),
      mockElement("q", { top: 140, bottom: 180, height: 40 }, "data-key"),
    ]
    const beforeContainer = mockContainer({ top: 100, bottom: 400, height: 300 }, beforeItems)
    const anchor = captureScrollAnchor(beforeContainer, "data-key")
    expect(anchor!.id).toBe("p")
    expect(anchor!.offset).toBe(0)

    // After: "p" scrolled off screen because collapse removed children above
    const afterItems = [
      mockElement("r", { top: 60, bottom: 100, height: 40 }, "data-key"),
      mockElement("p", { top: 180, bottom: 220, height: 40 }, "data-key"),
    ]
    const afterContainer = mockContainer({ top: 100, bottom: 400, height: 300 }, afterItems)
    restoreScrollAnchor(afterContainer, anchor!, "data-key")
    // currentOffset = 180 - 100 = 80, anchor offset = 0 → scrollTop += 80
    expect(afterContainer.scrollTop).toBe(80)
  })
})

// ---------------------------------------------------------------------------
// createScrollAnchorTracker tests
// ---------------------------------------------------------------------------

/** Mock container that also tracks addEventListener/removeEventListener calls. */
function mockTrackedContainer(
  rect: { top: number; bottom: number; height: number },
  initialChildren: HTMLElement[],
) {
  let scrollTop = 0
  let children = initialChildren
  const listeners: Record<string, Function[]> = {}

  const el = {
    getBoundingClientRect: () => ({ ...rect, left: 0, right: 100, width: 100, x: 0, y: rect.top }),
    querySelectorAll: () => children,
    get scrollTop() {
      return scrollTop
    },
    set scrollTop(v: number) {
      scrollTop = v
    },
    addEventListener(type: string, handler: Function) {
      if (!listeners[type]) listeners[type] = []
      listeners[type].push(handler)
    },
    removeEventListener(type: string, handler: Function) {
      if (listeners[type]) listeners[type] = listeners[type].filter((h) => h !== handler)
    },
    /** Test helper: fire a scroll event to simulate user scrolling. */
    emitScroll() {
      for (const handler of listeners["scroll"] ?? []) handler()
    },
    /** Test helper: replace children (simulates DOM mutation from reactive update). */
    setChildren(next: HTMLElement[]) {
      children = next
    },
  }

  return el as unknown as HTMLElement & {
    emitScroll(): void
    setChildren(next: HTMLElement[]): void
  }
}

describe("createScrollAnchorTracker", () => {
  it("capture() reads the current visible anchor from the container", () => {
    const items = [
      mockElement("a", { top: 10, bottom: 50, height: 40 }),
      mockElement("b", { top: 90, bottom: 130, height: 40 }),
    ]
    const container = mockTrackedContainer({ top: 100, bottom: 400, height: 300 }, items)
    const tracker = createScrollAnchorTracker(() => container)

    const anchor = tracker.capture()
    expect(anchor).not.toBeNull()
    expect(anchor!.id).toBe("b")
    expect(anchor!.offset).toBe(-10)
  })

  it("capture() returns null when no items are visible", () => {
    const container = mockTrackedContainer({ top: 100, bottom: 400, height: 300 }, [])
    const tracker = createScrollAnchorTracker(() => container)
    expect(tracker.capture()).toBeNull()
  })

  it("restore() adjusts scrollTop using the last captured anchor", () => {
    // Pre-update: "b" at offset -10
    const beforeItems = [
      mockElement("a", { top: 10, bottom: 50, height: 40 }),
      mockElement("b", { top: 90, bottom: 130, height: 40 }),
    ]
    const container = mockTrackedContainer({ top: 100, bottom: 400, height: 300 }, beforeItems)
    const tracker = createScrollAnchorTracker(() => container)
    tracker.capture()

    // Post-update: "b" moved to offset 50 (new items prepended above)
    const afterItems = [
      mockElement("a", { top: 60, bottom: 100, height: 40 }),
      mockElement("b", { top: 150, bottom: 190, height: 40 }),
    ]
    container.setChildren(afterItems)

    tracker.restore()
    // currentOffset = 150 - 100 = 50, anchor offset = -10 → scrollTop += 60
    expect(container.scrollTop).toBe(60)
  })

  it("restore() is a no-op when no anchor has been captured", () => {
    const items = [mockElement("a", { top: 100, bottom: 140, height: 40 })]
    const container = mockTrackedContainer({ top: 100, bottom: 400, height: 300 }, items)
    const tracker = createScrollAnchorTracker(() => container)

    // Never called capture() — internal state is null
    tracker.restore()
    expect(container.scrollTop).toBe(0)
  })

  it("restore() is a no-op when anchor element disappeared", () => {
    const items = [mockElement("a", { top: 90, bottom: 130, height: 40 })]
    const container = mockTrackedContainer({ top: 100, bottom: 400, height: 300 }, items)
    const tracker = createScrollAnchorTracker(() => container)
    tracker.capture()

    // "a" removed from DOM
    container.setChildren([])
    tracker.restore()
    expect(container.scrollTop).toBe(0)
  })

  it("restore() is a no-op when container getter returns undefined", () => {
    const tracker = createScrollAnchorTracker(() => undefined)
    // Should not throw
    tracker.restore()
  })

  it("start() captures immediately so restore works before any scroll event", () => {
    // User has scrolled — "b" is visible at offset 20
    const items = [
      mockElement("a", { top: 60, bottom: 100, height: 40 }),
      mockElement("b", { top: 120, bottom: 160, height: 40 }),
      mockElement("c", { top: 160, bottom: 200, height: 40 }),
    ]
    const container = mockTrackedContainer({ top: 100, bottom: 400, height: 300 }, items)
    const tracker = createScrollAnchorTracker(() => container)

    // start() should capture the current visible anchor immediately
    tracker.start()

    // DOM changes without any scroll event in between
    const afterItems = [
      mockElement("a", { top: 60, bottom: 100, height: 40 }),
      mockElement("b", { top: 200, bottom: 240, height: 40 }),
    ]
    container.setChildren(afterItems)

    // Restore should work because start() captured "b" at offset 20
    tracker.restore()
    // currentOffset = 200 - 100 = 100, anchor offset = 20 → scrollTop += 80
    expect(container.scrollTop).toBe(80)

    tracker.stop()
  })

  it("scroll events update the internal anchor", () => {
    // Initial items: "a" is visible
    const itemsA = [mockElement("a", { top: 90, bottom: 130, height: 40 })]
    const container = mockTrackedContainer({ top: 100, bottom: 400, height: 300 }, itemsA)
    const tracker = createScrollAnchorTracker(() => container)
    tracker.start()

    // User scrolls — "a" is still the first visible item
    container.emitScroll()

    // Now the DOM changes: "a" shifts down (items prepended above)
    const itemsB = [mockElement("a", { top: 180, bottom: 220, height: 40 })]
    container.setChildren(itemsB)

    tracker.restore()
    // anchor was { id: "a", offset: -10 }, current offset = 80, adjustment = 80 - (-10) = 90
    expect(container.scrollTop).toBe(90)

    tracker.stop()
  })

  it("stop() removes scroll listener so events no longer update anchor", () => {
    const items = [mockElement("a", { top: 90, bottom: 130, height: 40 })]
    const container = mockTrackedContainer({ top: 100, bottom: 400, height: 300 }, items)
    const tracker = createScrollAnchorTracker(() => container)

    // Start — attach listener and capture initial anchor
    tracker.start()
    // After start(), an immediate capture should have happened; verify via restore
    container.setChildren([mockElement("a", { top: 180, bottom: 220, height: 40 })])
    tracker.restore()
    // anchor was { id: "a", offset: -10 }, current offset = 80, adjustment = 90
    expect(container.scrollTop).toBe(90)

    // Reset scrollTop and verify scroll events update the anchor
    container.scrollTop = 0
    container.setChildren(items)
    container.emitScroll() // scroll event captures "a" at offset -10

    // Stop — detach listener
    tracker.stop()

    // After stop, scroll events should NOT update the internal anchor.
    // Change children so "a" moves far away; if the listener were still active,
    // a scroll event would update the anchor to the new position.
    const farItems = [mockElement("a", { top: 500, bottom: 540, height: 40 })]
    container.setChildren(farItems)
    container.emitScroll() // should be ignored since listener was removed

    // Restore with the anchor captured before stop (offset -10)
    // "a" is now at 500, container at 100, currentOffset = 400
    // adjustment = 400 - (-10) = 410
    tracker.restore()
    expect(container.scrollTop).toBe(410)
  })

  it("external append at bottom does not pin to new bottom", () => {
    // User at bottom: last item "c" at offset 170
    const items = [
      mockElement("a", { top: 10, bottom: 50, height: 40 }),
      mockElement("b", { top: 50, bottom: 90, height: 40 }),
      mockElement("c", { top: 90, bottom: 130, height: 40 }),
    ]
    const container = mockTrackedContainer({ top: -100, bottom: 200, height: 300 }, items)
    const tracker = createScrollAnchorTracker(() => container)
    tracker.start()

    // Simulate user scroll that establishes anchor
    container.emitScroll()
    // Capture anchor: "a" is the first visible (bottom 50 > top -100)
    // Actually with container top at -100, all items have bottom > -100, so "a" is anchor
    const anchor = tracker.capture()
    expect(anchor).not.toBeNull()
    expect(anchor!.id).toBe("a")

    // External load-more appends items at bottom
    const extendedItems = [
      ...items,
      mockElement("d", { top: 130, bottom: 170, height: 40 }),
      mockElement("e", { top: 170, bottom: 210, height: 40 }),
    ]
    container.setChildren(extendedItems)

    // Restore should keep "a" at the same offset
    tracker.restore()
    // "a" is still at top=10, container at -100, currentOffset=110
    // anchor offset was 110 → scrollTop += 0
    // The point: scrollTop was NOT adjusted to show the new bottom items
    expect(container.scrollTop).toBe(0)

    tracker.stop()
  })

  it("external append at non-bottom preserves visible anchor", () => {
    // User scrolled down, viewing "b" at offset 20
    const items = [
      mockElement("a", { top: 60, bottom: 100, height: 40 }),
      mockElement("b", { top: 120, bottom: 160, height: 40 }),
      mockElement("c", { top: 160, bottom: 200, height: 40 }),
    ]
    const container = mockTrackedContainer({ top: 100, bottom: 400, height: 300 }, items)
    const tracker = createScrollAnchorTracker(() => container)
    const anchor = tracker.capture()
    expect(anchor!.id).toBe("b")
    expect(anchor!.offset).toBe(20)

    // External load-more appends items at bottom (doesn't affect "b" position)
    const extendedItems = [
      ...items,
      mockElement("d", { top: 200, bottom: 240, height: 40 }),
    ]
    container.setChildren(extendedItems)

    tracker.restore()
    // "b" still at top=120, container at 100, currentOffset=20, anchor=20 → no change
    expect(container.scrollTop).toBe(0)
  })
})
