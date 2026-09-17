/**
 * Close-last production fix: bottom-page final invariant is real-content-only.
 *
 * After closing the last real session tab, one internal pending draft remains
 * but bottom/home stays active so the tab strip has no visible
 * `.am-tab-sortable`. Lone pending (or empty) with no terminals keeps bottom;
 * any non-pending real tab or terminal content clears it.
 *
 * Uses the real pure decision helper (no mocks).
 */
import { describe, expect, it } from "bun:test"
import { shouldClearBottomPage } from "../../webview-ui/agent-manager/cover-bottom-page"
import { isPending } from "../../webview-ui/agent-manager/hydration"

const pending = "pending:lone"
const pending2 = "pending:other"
const real = "ses_real1"
const real2 = "ses_real2"

describe("bottom-page final invariant (real-content-only)", () => {
  it("empty with no terminals keeps bottom", () => {
    expect(shouldClearBottomPage([], 0, isPending)).toBe(false)
  })

  it("lone pending with no terminals keeps bottom (close-last hidden draft)", () => {
    expect(shouldClearBottomPage([pending], 0, isPending)).toBe(false)
  })

  it("single real tab clears bottom", () => {
    expect(shouldClearBottomPage([real], 0, isPending)).toBe(true)
  })

  it("pending alongside real clears bottom", () => {
    expect(shouldClearBottomPage([pending, real], 0, isPending)).toBe(true)
    expect(shouldClearBottomPage([real, pending], 0, isPending)).toBe(true)
    expect(shouldClearBottomPage([pending, real, real2], 0, isPending)).toBe(true)
  })

  it("multiple pendings with no real keep bottom", () => {
    expect(shouldClearBottomPage([pending, pending2], 0, isPending)).toBe(false)
  })

  it("terminal boundary: empty or lone pending with terminal clears bottom", () => {
    expect(shouldClearBottomPage([], 1, isPending)).toBe(true)
    expect(shouldClearBottomPage([pending], 1, isPending)).toBe(true)
    expect(shouldClearBottomPage([real], 1, isPending)).toBe(true)
  })
})
