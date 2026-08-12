import { describe, expect, it } from "bun:test"
import { campaignStatus } from "../../script/p0-bench/status"

/**
 * Campaign run finish status truthfulness (script/p0-bench/status.ts, consumed
 * by script/e2e-p0-bench.ts): failed when no ok measured sample exists (an
 * all-blocked campaign is a failed run, never "partial"); partial only when
 * both ok measured and blocked samples exist.
 */
describe("campaign run finish status (truthful all-blocked / partial / ok)", () => {
  it("ok measured samples and no blocked: ok", () => {
    expect(campaignStatus(true, false)).toBe("ok")
  })

  it("both ok measured and blocked samples: partial (only when both exist)", () => {
    expect(campaignStatus(true, true)).toBe("partial")
  })

  it("no ok measured sample while blocked exists: failed (all-blocked is never partial)", () => {
    expect(campaignStatus(false, true)).toBe("failed")
  })

  it("no ok measured sample and no blocked: failed (no baseline evidence at all)", () => {
    expect(campaignStatus(false, false)).toBe("failed")
  })
})
