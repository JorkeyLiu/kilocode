import { describe, expect, it } from "bun:test"
import { percentile, summarize, summarizeKey } from "../../script/p0-bench/stats"

describe("p0 benchmark statistics", () => {
  it("computes nearest-rank percentiles", () => {
    // 20 values 1..20: p95 → index ceil(0.95*20)-1 = 19-1 = 18 → value 19
    const values = Array.from({ length: 20 }, (_, i) => i + 1)
    expect(percentile(values, 0.95)).toBe(19)
    expect(percentile(values, 0.5)).toBe(10)
    expect(percentile(values, 1)).toBe(20)
  })

  it("summarizes min/median/p95/max/mean", () => {
    const values = [10, 20, 30, 40, 100]
    const stats = summarize(values)
    expect(stats.n).toBe(5)
    expect(stats.min).toBe(10)
    expect(stats.max).toBe(100)
    expect(stats.median).toBe(30)
    expect(stats.mean).toBe(40)
    expect(stats.p95).toBe(100)
  })

  it("returns zeroed stats for an empty series", () => {
    const stats = summarize([])
    expect(stats).toEqual({ n: 0, min: 0, median: 0, p95: 0, max: 0, mean: 0 })
  })

  it("groups key latencies by metric for per-scenario summaries", () => {
    const out = summarizeKey([
      { key: "activateToDataReadyMs", value: 1000 },
      { key: "activateToDataReadyMs", value: 2000 },
      { key: "webviewLoadToPaintMs", value: 300 },
    ])
    expect(out).toHaveLength(2)
    const readiness = out.find((item) => item.metric === "activateToDataReadyMs")!
    expect(readiness.stats.n).toBe(2)
    // nearest-rank median of [1000, 2000] picks the lower (index ceil(0.5*2)-1 = 0)
    expect(readiness.stats.median).toBe(1000)
    const paint = out.find((item) => item.metric === "webviewLoadToPaintMs")!
    expect(paint.stats.n).toBe(1)
    expect(paint.stats.min).toBe(300)
  })
})
