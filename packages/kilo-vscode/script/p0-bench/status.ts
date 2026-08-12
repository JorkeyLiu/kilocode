/**
 * Campaign run finish status for the P0 extension benchmark.
 *
 * Truthful run-finish classification over the campaign's tracked aggregates
 * (script/e2e-p0-bench.ts):
 *   failed  — no ok MEASURED sample exists. An all-blocked campaign has no
 *             baseline evidence, so it is a failed run — never "partial".
 *   partial — at least one ok measured sample AND at least one blocked sample.
 *   ok      — at least one ok measured sample and no blocked sample.
 * Pure function (no I/O) so the harness and the unit tests share one
 * implementation and the JSONL `kind:"run" event:"finish"` status can never
 * drift from the tested rule.
 */

export function campaignStatus(anyOkMeasured: boolean, anyBlocked: boolean): "ok" | "partial" | "failed" {
  if (!anyOkMeasured) return "failed"
  return anyBlocked ? "partial" : "ok"
}
