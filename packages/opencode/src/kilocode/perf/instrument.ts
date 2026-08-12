// P0 baseline timing instrumentation (bounded, opt-in, evidence-only).
//
// Activation: `KILO_P0_PERF=true|1` (local P0 environment flag, same truthy
// convention as the Flag module). When disabled every call is a no-op — no
// records are produced and normal behavior/logging is unchanged. When
// enabled, structured records are emitted through the existing
// `@opencode-ai/core/util/log` stream with a machine-readable shape:
//   event    - record kind: `p0.mark` (point) | `p0.start` / `p0.end` (span)
//   stage    - the instrumented backend stage (e.g. `listener`, `config_load`)
//   ts       - wall-clock epoch ms at record time
//   duration - ms between span start and end (span records only)
//   id / dir - correlation key (session, directory, address, pid)
//   meta     - optional JSON-safe extra context
//
// Span failure semantics (explicit contract): `span()` emits `p0.start` at
// begin and `end()` emits `p0.end` with duration. If the instrumented block
// fails or is interrupted before `end()` runs, no `p0.end` is emitted — a
// lone `p0.start` without a matching `p0.end` is the failure/interruption
// signal. Consumers must treat unmatched starts as incomplete spans; callers
// must not synthesize `p0.end` records after the fact. Callers that want a
// failure marked on a normally-closed span pass an explicit flag in `end()`'s
// extra fields.
//
// This module is the entire instrumentation surface: no new telemetry
// service, no persistent storage, no public API, no detached work, and no
// timing claims. Records are evidence only — nothing downstream reads them.
// Keep the flag and event shape local to this module.
//
// Enablement is DYNAMIC: the flag is read on every call, not latched at
// module load. Bun runs every test file in one process, so a module-load
// latch would make scoped benchmark assertions depend on which file imported
// this module first; per-call evaluation keeps opt-in enablement truthful no
// matter the import order (a span created while disabled but ended after the
// flag turns on is skipped entirely, and a p0.end without a p0.start is
// ignored by span matching — the contract is unchanged).

import * as Log from "@opencode-ai/core/util/log"
import { truthy } from "@opencode-ai/core/flag/flag"

const log = Log.create({ service: "p0-perf" })

/** Opt-in activation, evaluated per record (dynamic, not a module-load latch). */
export const isEnabled = () => truthy("KILO_P0_PERF")

export type P0Fields = {
  id?: string
  dir?: string
  meta?: Record<string, unknown>
}

type P0Event = "p0.mark" | "p0.start" | "p0.end"

function emit(event: P0Event, stage: string, fields: P0Fields | undefined, ts: number, duration?: number) {
  if (!isEnabled()) return
  log.info(stage, { event, stage, ts, duration, ...fields })
}

/** Point-in-time record for a stage (no duration). */
export function mark(stage: string, fields?: P0Fields): void {
  if (!isEnabled()) return
  emit("p0.mark", stage, fields, Date.now())
}

/** Span record: emit `p0.start` now; `end()` emits `p0.end` with duration. */
export function span(stage: string, fields?: P0Fields): { end: (extra?: P0Fields) => void } {
  if (!isEnabled()) return { end() {} }
  const wall = Date.now()
  const mono = performance.now()
  emit("p0.start", stage, fields, wall)
  return {
    end(extra?: P0Fields) {
      emit("p0.end", stage, { ...fields, ...extra }, Date.now(), Math.round(performance.now() - mono))
    },
  }
}
