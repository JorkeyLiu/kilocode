/**
 * Summary statistics for benchmark sample series.
 *
 * Pure functions (no I/O). Percentiles use the nearest-rank method: for p in
 * (0,1], index = Math.max(0, Math.ceil(p * n) - 1) into the sorted ascending
 * series. p95 of 20 samples is therefore the 19th value (0.95*20 = 19).
 * The schema follows the extension-tier p0-bench stats for cross-tier
 * comparability (n/min/median/p95/max/mean).
 */

export type Stats = {
  /** Successful measured samples in the series (as supplied by the caller). */
  n: number
  min: number
  median: number
  p95: number
  max: number
  mean: number
}

/** Nearest-rank percentile of a non-empty numeric series. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new Error("percentile: empty series")
  const sortedValues = sorted(values)
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(p * sortedValues.length) - 1))
  return sortedValues[index]!
}

/** Median (nearest-rank p50) of a non-empty series. */
export function median(values: number[]): number {
  return percentile(values, 0.5)
}

/** Summary statistics; empty series returns zeroed stats (n = 0). */
export function summarize(values: number[]): Stats {
  if (values.length === 0) return { n: 0, min: 0, median: 0, p95: 0, max: 0, mean: 0 }
  const n = values.length
  const sortedValues = sorted(values)
  let sum = 0
  for (const value of values) sum += value
  return {
    n,
    min: sortedValues[0]!,
    median: percentile(sortedValues, 0.5),
    p95: percentile(sortedValues, 0.95),
    max: sortedValues[n - 1]!,
    mean: sum / n,
  }
}

/** Round a number to 2 decimals for JSONL output. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Truthful unit for a metric/count key, derived from its suffix:
 * ms durations, byte/ms rates, byte totals, and everything else is a count.
 * Never assume ms for non-duration keys.
 */
export function metricUnit(metric: string): string {
  if (metric.endsWith("PerMs")) return "bytes/ms"
  if (metric.endsWith("Ms")) return "ms"
  if (metric.endsWith("Bytes")) return "bytes"
  return "count"
}

/** Group numeric key values by metric and summarize each. */
export function summarizeKey(values: Array<{ key: string; value: number }>): Array<{ metric: string; stats: Stats }> {
  const byMetric = new Map<string, number[]>()
  for (const item of values) {
    const list = byMetric.get(item.key) ?? []
    list.push(item.value)
    byMetric.set(item.key, list)
  }
  const out: Array<{ metric: string; stats: Stats }> = []
  for (const [metric, list] of byMetric) {
    out.push({ metric, stats: summarize(list) })
  }
  return out
}

/** One scenario sample (metrics + counts) as produced by the runner. */
export type SampleSummary = {
  scenario: string
  phase: "warmup" | "measured"
  metrics: Record<string, number>
  counts: Record<string, number>
}

/** One `kind: "summary"` JSONL line with a truthful unit. */
export type MetricSummary = {
  scenario: string
  metric: string
  unit: string
  /** Successful measured samples this summary covers (failed measured samples are excluded). */
  n: number
  min: number
  median: number
  p95: number
  max: number
  mean: number
}

/**
 * Summarize the measured samples of one or more scenarios into per-metric
 * summary lines. The runner supplies only successful measured samples (failed
 * measured samples never reach this function), so `n` counts successful
 * measured samples only — warmup samples are excluded here by the phase
 * filter. Metrics are summarized before counts; every numeric stat is rounded
 * to 2 decimals for consistent output; each line carries the unit derived from
 * the metric name (`metricUnit`).
 */
export function summarizeSamples(samples: SampleSummary[]): MetricSummary[] {
  const measured = samples.filter((sample) => sample.phase === "measured")
  const values = new Map<string, Map<string, number[]>>()
  const order = new Map<string, string[]>()
  for (const sample of measured) {
    let byMetric = values.get(sample.scenario)
    if (!byMetric) {
      byMetric = new Map()
      values.set(sample.scenario, byMetric)
    }
    let keys = order.get(sample.scenario)
    if (!keys) {
      keys = []
      order.set(sample.scenario, keys)
    }
    for (const [key, value] of [...Object.entries(sample.metrics), ...Object.entries(sample.counts)]) {
      if (!byMetric.has(key)) keys.push(key)
      byMetric.set(key, [...(byMetric.get(key) ?? []), value])
    }
  }
  const out: MetricSummary[] = []
  for (const [scenario, byMetric] of values) {
    for (const key of order.get(scenario) ?? []) {
      const stats = summarize(byMetric.get(key) ?? [])
      out.push({
        scenario,
        metric: key,
        unit: metricUnit(key),
        n: stats.n,
        min: round2(stats.min),
        median: round2(stats.median),
        p95: round2(stats.p95),
        max: round2(stats.max),
        mean: round2(stats.mean),
      })
    }
  }
  return out
}

function sorted(values: number[]): number[] {
  return [...values].sort((a, b) => a - b)
}
