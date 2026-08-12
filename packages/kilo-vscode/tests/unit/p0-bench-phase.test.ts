import { describe, expect, it } from "bun:test"
import { phaseForSample } from "../../script/p0-bench/phase"

/**
 * Blocked-sample phase contract: a blocked sample's phase must follow the
 * sample/warmup rule like every other record — a blocked MEASURED sample
 * stays measured and is never hardcoded to warmup (the audited blocker).
 */
describe("p0 benchmark sample phase", () => {
  it("labels samples before or at the warmup count as warmup", () => {
    expect(phaseForSample(1, 1)).toBe("warmup")
    expect(phaseForSample(2, 2)).toBe("warmup")
    expect(phaseForSample(1, 0)).toBe("measured")
  })

  it("labels samples beyond the warmup count as measured", () => {
    expect(phaseForSample(2, 1)).toBe("measured")
    expect(phaseForSample(3, 2)).toBe("measured")
    // A measured-only campaign (warmup=0): every sample, including a blocked
    // first sample, is measured.
    expect(phaseForSample(1, 0)).toBe("measured")
    expect(phaseForSample(5, 0)).toBe("measured")
  })
})
