/**
 * Scroll-anchor helpers for preserving scroll position across DOM updates.
 *
 * Used by SidebarSessionList (data-sidebar-id) and history SessionList
 * (data-key on [data-slot="list-item"]) to keep the viewport stable when
 * expanding/collapsing items or loading more sessions.
 */

export interface ScrollAnchor {
  id: string
  offset: number
}

/**
 * Generic find: locate an element inside `container` whose attribute `attr`
 * equals `id`.  Iterates results instead of interpolating into the selector
 * to avoid CSS-injection through attribute values.
 */
export function findByAttr(container: HTMLElement, attr: string, id: string): HTMLElement | null {
  const items = container.querySelectorAll<HTMLElement>(`[${attr}]`)
  for (const item of items) {
    if (item.getAttribute(attr) === id) return item
  }
  return null
}

/** Convenience wrapper: find by data-sidebar-id. */
export function findBySidebarId(container: HTMLElement, id: string): HTMLElement | null {
  return findByAttr(container, "data-sidebar-id", id)
}

/**
 * Capture the scroll anchor: the first anchored item whose bottom edge is
 * below the container's top, along with its pixel offset from that top.
 *
 * @param container  The scrollable viewport element.
 * @param attr       The data-* attribute that identifies anchored items.
 *                   Defaults to `"data-sidebar-id"` for backward compat.
 */
export function captureScrollAnchor(container: HTMLElement, attr = "data-sidebar-id"): ScrollAnchor | null {
  const containerRect = container.getBoundingClientRect()
  const items = container.querySelectorAll<HTMLElement>(`[${attr}]`)
  for (const item of items) {
    const rect = item.getBoundingClientRect()
    if (rect.bottom > containerRect.top) {
      const id = item.getAttribute(attr)
      if (id) return { id, offset: rect.top - containerRect.top }
    }
  }
  return null
}

/**
 * Restore scroll so the anchor element is at the same visual offset.
 *
 * @param container  The scrollable viewport element.
 * @param anchor     Previously captured anchor.
 * @param attr       The data-* attribute used during capture.
 *                   Defaults to `"data-sidebar-id"` for backward compat.
 */
export function restoreScrollAnchor(container: HTMLElement, anchor: ScrollAnchor, attr = "data-sidebar-id") {
  const target = findByAttr(container, attr, anchor.id)
  if (!target) return
  const containerTop = container.getBoundingClientRect().top
  const targetTop = target.getBoundingClientRect().top
  const currentOffset = targetTop - containerTop
  container.scrollTop += currentOffset - anchor.offset
}

/**
 * Continuously maintained scroll anchor state for a container.
 *
 * Unlike the one-shot capture/restore pair (which requires the caller to
 * capture before a known mutation), a tracker maintains the latest visible
 * anchor from ongoing scroll events so that any subsequent DOM mutation —
 * regardless of source — has a reliable pre-update anchor available.
 *
 * The scroll-event-maintained anchor is guaranteed to be pre-update because
 * scroll events fire on user interaction (a macrotask), which always
 * precedes any reactive update (a microtask) that might follow.
 */
export interface ScrollAnchorTracker {
  /** Capture the current scroll position and update the internal anchor. */
  capture(): ScrollAnchor | null
  /** Restore the container to the last captured anchor. No-op if no anchor or container. */
  restore(): void
  /** Attach the scroll listener. Call once after the container is available. */
  start(): void
  /** Detach the scroll listener. Call in onCleanup. */
  stop(): void
}

/**
 * Create a scroll anchor tracker for a container.
 *
 * @param container  Getter for the scrollable container element.
 * @param attr       The data-* attribute that identifies anchored items.
 */
export function createScrollAnchorTracker(
  container: () => HTMLElement | undefined,
  attr = "data-sidebar-id",
): ScrollAnchorTracker {
  let current: ScrollAnchor | null = null

  const onScroll = () => {
    const el = container()
    if (el) current = captureScrollAnchor(el, attr)
  }

  return {
    capture() {
      const el = container()
      if (!el) return null
      current = captureScrollAnchor(el, attr)
      return current
    },
    restore() {
      const el = container()
      if (!el || !current) return
      restoreScrollAnchor(el, current, attr)
    },
    start() {
      const el = container()
      if (el) {
        el.addEventListener("scroll", onScroll, { passive: true })
        // Capture immediately so the tracker has an anchor from the very first render
        current = captureScrollAnchor(el, attr)
      }
    },
    stop() {
      const el = container()
      if (el) el.removeEventListener("scroll", onScroll)
    },
  }
}
