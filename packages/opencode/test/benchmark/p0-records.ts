/**
 * Parser for backend P0 instrumentation records.
 *
 * Pure functions (no I/O, no kilo imports) so they are unit-testable and
 * shared by the harness and the focused tests. Backend records are emitted by
 * `src/kilocode/perf/instrument.ts` through the existing `@opencode-ai/core/
 * util/log` stream with `service=p0-perf`; with `Log.init({ print: true })`
 * each record is one complete stderr line of the form:
 *
 *   INFO  2026-08-10T10:00:00 +12ms service=p0-perf event=p0.mark \
 *     stage=config_commit ts=1754822942000 id=... dir=... meta={...} \
 *     <stage-name>
 *
 * The parser scans any text (a line, a chunk, a whole file) for the
 * `service=p0-perf` fragment and extracts the documented record fields.
 */

export type P0Event = "p0.mark" | "p0.start" | "p0.end"

export type P0Record = {
  event: P0Event
  stage: string
  /** Wall-clock epoch ms at record time (instrument.ts `ts` field). */
  ts: number
  /** Span duration ms (p0.end records only). */
  duration?: number
  /** Correlation id (process id for serve_cli_entry, "global" for global scope). */
  id?: string
  /** Directory-scope correlation (config_load/instance_bootstrap/...). */
  dir?: string
  /** JSON-safe extra context (config_commit seq, listener port, ...). */
  meta?: Record<string, unknown>
}

/** Known instrument stages (documentation; the parser accepts any stage). */
export const STAGES = [
  "serve_cli_entry",
  "listener",
  "app_layer_define",
  "app_runtime_make",
  "config_load",
  "instance_bootstrap",
  "provider_state_init",
  "processor_entry",
  "tool_execute",
  "tool_execute_plugin",
  "permission_wait",
  "question_wait",
  "config_commit",
  "convergence_complete",
  "kilo_viewers_module_load",
] as const

/**
 * Stages emitted as p0.start/p0.end span pairs (every other stage is a single
 * p0.mark point). Verified against the emit sites in src/kilocode/perf/
 * instrument.ts consumers: server.ts (listener), effect/app-runtime.ts
 * (app_layer_define, app_runtime_make), config.ts (config_load),
 * project/bootstrap.ts (instance_bootstrap), provider/provider.ts
 * (provider_state_init), session/tools.ts (tool_execute — the outer session-
 * loop span, one pair per tool call), tool/registry.ts (tool_execute_plugin —
 * the distinct plugin-body span nested under the outer pair, covering
 * def.execute + result normalization + output truncation, so a custom tool
 * call never emits two identical tool_execute pairs), permission/index.ts
 * (permission_wait), question/index.ts (question_wait),
 * kilocode/presence/service.ts (kilo_viewers_module_load — the lazy
 * kilo-sessions heavy-graph import on first viewed, never at layer build).
 */
export const SPAN_STAGES = [
  "listener",
  "app_layer_define",
  "app_runtime_make",
  "config_load",
  "instance_bootstrap",
  "provider_state_init",
  "tool_execute",
  "tool_execute_plugin",
  "permission_wait",
  "question_wait",
  "kilo_viewers_module_load",
] as const

const FIELD_RE = /\b(event=p0\.(?:mark|start|end)|stage=(\S+)|ts=(\d+)|duration=(\d+)|id=(\S+)|dir=(\S+)|meta=(\{.*\}))/

/**
 * Parse a single P0 record from any text containing a `service=p0-perf` log
 * line. Returns undefined when no valid record is present. `meta` is the JSON
 * serialization produced by the log formatter (JSON.stringify of the object,
 * so `{...}` without spaces for the current emit sites).
 */
export function parseP0Line(text: string): P0Record | undefined {
  const at = text.indexOf("service=p0-perf")
  if (at < 0) return undefined
  const tail = text.slice(at)
  const event = tail.match(/\bevent=(p0\.(?:mark|start|end))\b/)?.[1] as P0Event | undefined
  if (!event) return undefined
  const stage = tail.match(/\bstage=(\S+)/)?.[1]
  const ts = tail.match(/\bts=(\d+)/)?.[1]
  if (!stage || !ts) return undefined
  const rec: P0Record = { event, stage, ts: Number(ts) }
  const duration = tail.match(/\bduration=(\d+)/)?.[1]
  if (duration !== undefined) rec.duration = Number(duration)
  const id = tail.match(/\bid=(\S+)/)?.[1]
  if (id !== undefined) rec.id = id
  const dir = tail.match(/\bdir=(\S+)/)?.[1]
  if (dir !== undefined) rec.dir = dir
  const meta = tail.match(/\bmeta=(\{.*\})/)?.[1]
  if (meta !== undefined) {
    try {
      rec.meta = JSON.parse(meta) as Record<string, unknown>
    } catch {
      rec.meta = { raw: meta }
    }
  }
  return rec
}

/** Parse every P0 record found across newline-separated text (order preserved). */
export function extractP0Records(text: string): P0Record[] {
  const out: P0Record[] = []
  for (const line of text.split("\n")) {
    const rec = parseP0Line(line)
    if (rec) out.push(rec)
  }
  return out
}

/** All records of one stage, in arrival order. */
export function stageRecords(records: P0Record[], stage: string): P0Record[] {
  return records.filter((rec) => rec.stage === stage)
}

/** First record of a stage (or undefined). */
export function firstStage(records: P0Record[], stage: string): P0Record | undefined {
  return records.find((rec) => rec.stage === stage)
}

/** Count of stage records (ALL event kinds: a completed span contributes its p0.start AND its p0.end). */
export function countStage(records: P0Record[], stage: string): number {
  let count = 0
  for (const rec of records) if (rec.stage === stage) count += 1
  return count
}

/**
 * Completed spans for a stage: each p0.end is matched to the earliest
 * unmatched p0.start with the same id/dir correlation. Unmatched p0.start
 * records are reported separately as `unmatchedStarts` and never counted as
 * spans — per the instrument.ts contract a lone p0.start without a matching
 * p0.end signals failure/interruption.
 */
export function stageSpans(records: P0Record[], stage: string): { spans: number; unmatchedStarts: number } {
  let spans = 0
  const open: Array<{ id?: string; dir?: string }> = []
  for (const rec of records) {
    if (rec.stage !== stage) continue
    if (rec.event === "p0.start") {
      open.push({ id: rec.id, dir: rec.dir })
    } else if (rec.event === "p0.end") {
      const index = open.findIndex((candidate) => candidate.id === rec.id && candidate.dir === rec.dir)
      if (index >= 0) {
        open.splice(index, 1)
        spans += 1
      }
    }
  }
  return { spans, unmatchedStarts: open.length }
}

/** Span durations for a stage: p0.end records carry `duration` (ms). */
export function stageDurations(records: P0Record[], stage: string): number[] {
  const out: number[] = []
  for (const rec of records) {
    if (rec.stage === stage && rec.event === "p0.end" && rec.duration !== undefined) out.push(rec.duration)
  }
  return out
}

/**
 * Duration between two records in ms (b.ts - a.ts); undefined when either is
 * missing or the order is inverted.
 */
export function between(a: P0Record | undefined, b: P0Record | undefined): number | undefined {
  if (!a || !b) return undefined
  const ms = b.ts - a.ts
  return ms >= 0 ? ms : undefined
}

/** Config-commit / convergence `meta.seq` of a record (0 when absent). */
export function seqOf(rec: P0Record): number {
  const seq = rec.meta?.seq
  return typeof seq === "number" ? seq : 0
}

/** Config-commit / convergence `meta.seq` values for a stage. */
export function seqs(records: P0Record[], stage: string): number[] {
  const out: number[] = []
  for (const rec of stageRecords(records, stage)) {
    const seq = rec.meta?.seq
    if (typeof seq === "number") out.push(seq)
  }
  return out
}
