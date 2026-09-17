/**
 * Root fix: deterministic extra-pending divergence.
 *
 * Fresh webview has exactly one pending tab with isBottomPage false.
 * Old coverBottomPage returned before inspecting it, so the first real
 * sessionAdded appended beside it -> [pending, real...].
 *
 * Uses the real decision helper + real session tab manager (no mocks).
 */
import { describe, expect, it } from "bun:test"
import { resolveCoverBottomPage } from "../../webview-ui/agent-manager/cover-bottom-page"
import { createSessionTabManager } from "../../webview-ui/agent-manager/session-tab-manager"
import { isPending } from "../../webview-ui/agent-manager/hydration"
import { LOCAL } from "../../webview-ui/agent-manager/navigate"

const pending = "pending:lone"
const real = "ses_real1"

function applyCover(ids: string[], bottom: boolean) {
  const mgr = createSessionTabManager()
  mgr.seed(LOCAL, ids, ids[0])
  let local = [...ids]
  let order = [...ids]
  let active: string | undefined = ids[0]
  let flag = bottom
  const decision = resolveCoverBottomPage(mgr.ids(LOCAL), flag, isPending)
  if (decision) {
    if (decision.coverId !== undefined) {
      const cover = decision.coverId
      local = local.filter((x) => x !== cover)
      mgr.remove(LOCAL, cover)
      order = order.filter((x) => x !== cover)
      if (active === cover) active = undefined
    }
    if (decision.clearBottom) flag = false
  }
  return { decision, local, order, mgrIds: [...mgr.ids(LOCAL)], active, flag }
}

describe("coverBottomPage lone-pending fix", () => {
  it("lone pending with bottom false is covered (fails on old early-return)", () => {
    const out = applyCover([pending], false)
    expect(out.decision?.coverId).toBe(pending)
    expect(out.local).toEqual([])
    expect(out.mgrIds).toEqual([])
    expect(out.order).toEqual([])
    expect(out.flag).toBe(false)
    // Then the real tab proceeds alone: [real], no divergence.
    expect([...out.local, real]).toEqual([real])
  })

  it("explicit bottom page with lone pending still covers", () => {
    const out = applyCover([pending], true)
    expect(out.decision?.coverId).toBe(pending)
    expect(out.local).toEqual([])
    expect(out.flag).toBe(false)
  })

  it("single real with bottom false is preserved (no removal)", () => {
    const out = applyCover([real], false)
    expect(out.decision).toBeUndefined()
    expect(out.local).toEqual([real])
    expect(out.mgrIds).toEqual([real])
  })

  it("pending alongside real is preserved (intentional user state)", () => {
    const a = applyCover([pending, real], false)
    expect(a.decision).toBeUndefined()
    expect(a.local).toEqual([pending, real])
    const b = applyCover([real, pending], false)
    expect(b.decision).toBeUndefined()
    expect(b.local).toEqual([real, pending])
  })

  it("multiple tabs with bottom true clears flag only, removes nothing", () => {
    const out = applyCover([pending, real], true)
    expect(out.decision?.coverId).toBeUndefined()
    expect(out.decision?.clearBottom).toBe(true)
    expect(out.local).toEqual([pending, real])
    expect(out.flag).toBe(false)
  })

  it("empty order with bottom false is a no-op", () => {
    const decision = resolveCoverBottomPage([], false, isPending)
    expect(decision).toBeUndefined()
  })

  it("covering preserves position: lone pending replaced by real at same index", () => {
    const mgr = createSessionTabManager()
    mgr.seed(LOCAL, [pending], pending)
    const decision = resolveCoverBottomPage(mgr.ids(LOCAL), false, isPending)
    expect(decision?.coverId).toBe(pending)
    mgr.remove(LOCAL, pending)
    mgr.open(LOCAL, real)
    expect([...mgr.ids(LOCAL)]).toEqual([real])
    expect(mgr.active(LOCAL)).toBe(real)
  })
})
