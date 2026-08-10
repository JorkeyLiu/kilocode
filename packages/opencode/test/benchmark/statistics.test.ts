/**
 * Focused contract tests for benchmark statistics (test/benchmark/statistics.ts).
 *
 * Nearest-rank percentiles: for p in (0,1], index = max(0, ceil(p*n) - 1)
 * into the sorted ascending series.
 */

import { describe, expect, it } from "bun:test"
import { median, metricUnit, percentile, round2, summarize, summarizeKey, summarizeSamples } from "./statistics"

describe("benchmark statistics", () => {
  it("percentile uses nearest-rank on a sorted series", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    expect(percentile(values, 0.5)).toBe(50) // ceil(0.5*10)-1 = 4
    expect(percentile(values, 0.95)).toBe(100) // ceil(9.5)-1 = 9
    expect(percentile(values, 1)).toBe(100)
    expect(percentile(values, 0.1)).toBe(10) // ceil(1)-1 = 0
  })

  it("percentile throws on an empty series", () => {
    expect(() => percentile([], 0.5)).toThrow("empty")
  })

  it("median is nearest-rank p50", () => {
    expect(median([5, 1, 3])).toBe(3)
    // ceil(0.5*4)-1 = 1 → sorted[1]
    expect(median([1, 2, 3, 4])).toBe(2)
  })

  it("summarize computes n/min/median/p95/max/mean", () => {
    const stats = summarize([10, 20, 30, 40, 50])
    expect(stats).toEqual({ n: 5, min: 10, median: 30, p95: 50, max: 50, mean: 30 })
  })

  it("summarize returns zeroed stats for an empty series", () => {
    expect(summarize([])).toEqual({ n: 0, min: 0, median: 0, p95: 0, max: 0, mean: 0 })
  })

  it("round2 rounds to two decimals", () => {
    expect(round2(1.23456)).toBe(1.23)
    expect(round2(1.5)).toBe(1.5)
    expect(round2(0.001)).toBe(0)
  })

  it("summarizeKey groups by metric key", () => {
    const out = summarizeKey([
      { key: "a", value: 1 },
      { key: "b", value: 10 },
      { key: "a", value: 3 },
    ])
    const byMetric = Object.fromEntries(out.map((item) => [item.metric, item.stats]))
    // [1, 3]: median = ceil(0.5*2)-1 = 0 → sorted[0] = 1; p95 = ceil(1.9)-1 = 1 → 3
    expect(byMetric["a"]).toEqual({ n: 2, min: 1, median: 1, p95: 3, max: 3, mean: 2 })
    expect(byMetric["b"]?.n).toBe(1)
  })

  it("metricUnit derives truthful units from metric names", () => {
    expect(metricUnit("totalMs")).toBe("ms")
    expect(metricUnit("firstInstanceBootstrapMs")).toBe("ms")
    expect(metricUnit("streamBytesPerMs")).toBe("bytes/ms")
    expect(metricUnit("streamBytes")).toBe("bytes")
    expect(metricUnit("deltaEvents")).toBe("count")
    expect(metricUnit("config_commit")).toBe("count")
    expect(metricUnit("instance_bootstrap")).toBe("count")
  })

  it("summarizeSamples excludes warmup samples and reports per-metric units", () => {
    const out = summarizeSamples([
      { scenario: "6", phase: "warmup", metrics: { totalMs: 5000, startToFirstDeltaMs: 4000 }, counts: {} },
      { scenario: "6", phase: "measured", metrics: { totalMs: 1000, startToFirstDeltaMs: 800 }, counts: { deltaEvents: 1 } },
      { scenario: "6", phase: "measured", metrics: { totalMs: 1200, startToFirstDeltaMs: 900 }, counts: { deltaEvents: 1 } },
      { scenario: "7", phase: "measured", metrics: { streamBytesPerMs: 42 }, counts: {} },
    ])
    const s6 = out.filter((line) => line.scenario === "6")
    const totalMs = s6.find((line) => line.metric === "totalMs")
    // Warmup (5000) excluded → n = 2 measured samples; nearest-rank stats over [1000, 1200].
    expect(totalMs).toEqual({
      scenario: "6",
      metric: "totalMs",
      unit: "ms",
      n: 2,
      min: 1000,
      median: 1000,
      p95: 1200,
      max: 1200,
      mean: 1100,
    })
    const deltaEvents = s6.find((line) => line.metric === "deltaEvents")
    expect(deltaEvents?.unit).toBe("count")
    expect(deltaEvents?.n).toBe(2)
    const rate = out.find((line) => line.scenario === "7")
    expect(rate).toEqual({
      scenario: "7",
      metric: "streamBytesPerMs",
      unit: "bytes/ms",
      n: 1,
      min: 42,
      median: 42,
      p95: 42,
      max: 42,
      mean: 42,
    })
  })

  it("summarizeSamples rounds numeric stats to two decimals", () => {
    const out = summarizeSamples([
      { scenario: "6", phase: "measured", metrics: { totalMs: 1000 }, counts: {} },
      { scenario: "6", phase: "measured", metrics: { totalMs: 1001 }, counts: {} },
    ])
    expect(out[0]?.mean).toBe(1000.5)
    expect(out[0]?.min).toBe(1000)
    expect(out[0]?.max).toBe(1001)
  })

  it("summarizeSamples returns no lines when there are no measured samples", () => {
    expect(summarizeSamples([{ scenario: "6", phase: "warmup", metrics: { totalMs: 1 }, counts: {} }])).toEqual([])
  })
})
