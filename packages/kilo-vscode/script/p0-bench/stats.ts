/**
 * Statistics for P0 benchmark samples.
 *
 * Pure functions (no I/O, no Node deps) so they are unit-testable under Bun.
 * Percentiles use the nearest-rank method: for p in (0,1], index =
 * Math.max(0, Math.ceil(p * n) - 1) into the sorted ascending series. p95 of
 * 20 samples is therefore the 19th value (0.95*20 = 19).
 *
 * Descriptive-only tail note: with the default n=5 the p95 index is
 * ceil(0.95*5)-1 = 4, so p95 EQUALS max for every metric. These summaries are
 * descriptive sample statistics only — NOT a tail-latency SLA; no threshold
 * or service-level claim derives from them (LOCK-PERF-7 thresholds remain
 * Open).
 */

import type { Stats } from "./types"

function sorted(values: number[]): number[] {
  return [...values].sort((a, b) => a - b)
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

/** Summary statistics of a series; empty series returns all-undefined stats. */
export function summarize(values: number[]): Stats {
  if (values.length === 0) {
    return { n: 0, min: 0, median: 0, p95: 0, max: 0, mean: 0 }
  }
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

/** Build a per-metric summary from key-latency values measured across samples. */
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
