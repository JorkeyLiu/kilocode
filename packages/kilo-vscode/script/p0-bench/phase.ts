/**
 * Sample phase assignment for the P0 extension benchmark.
 *
 * A 1-based sample index is warmup while `index <= warmup`, measured after —
 * the same rule the probe applies to cold-type sample records. Pure function
 * (no I/O) so the harness and the unit tests share one implementation and the
 * blocked-sample path can never hardcode the phase again.
 */

export function phaseForSample(sample: number, warmup: number): "warmup" | "measured" {
  return sample <= warmup ? "warmup" : "measured"
}
