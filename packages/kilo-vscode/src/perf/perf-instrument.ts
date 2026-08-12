import * as crypto from "crypto"

/**
 * Opt-in P0 performance instrumentation (extension side).
 *
 * Gated by the narrowly scoped env flag `KILO_P0_PERF` (values `1` / `true`).
 * Default off — there is no user-visible setting. When off, every call site
 * is a single env read and no record is emitted, so the disabled path has no
 * behavior impact.
 *
 * Records are single-line JSON on stdout with a stable, grep-able prefix:
 *
 *   [Kilo New][P0-Perf] {"corr":"...","stage":"spawn.done","t":1766...,"d":12.3,"surface":"extension","pid":1234}
 *
 * Fields:
 *   corr     correlation id, one per extension activation (reset by p0Begin)
 *   stage    instrumentation point (see callers)
 *   t        epoch ms (Date.now()); webview-forwarded records carry the
 *            webview's own wall-clock t (same host, negligible skew)
 *   d        ms since the first record of the current correlation
 *   surface  "extension" | "webview"
 *   ...      stage-specific extras
 *
 * Timestamps come from Date.now() so extension-host and webview records share
 * a common wall clock; `d` turns them into a joinable timeline.
 */

const PREFIX = "[Kilo New][P0-Perf]"

export function isP0PerfEnabled(): boolean {
  const raw = process.env.KILO_P0_PERF
  return raw === "1" || raw === "true"
}

let corr: string | undefined
let t0: number | undefined

/**
 * Start a new correlation (one per extension activation). Call once at the
 * top of activate(); records before the first p0Begin share the module-lifetime
 * correlation.
 */
export function p0Begin(): string {
  if (!isP0PerfEnabled()) return ""
  corr = crypto.randomUUID()
  t0 = Date.now()
  return corr
}

function emit(stage: string, surface: "extension" | "webview", t: number, extra?: Record<string, unknown>): void {
  if (!isP0PerfEnabled()) return
  corr ??= crypto.randomUUID()
  t0 ??= t
  const record: Record<string, unknown> = {
    corr,
    stage,
    t,
    d: Math.round((t - t0) * 100) / 100,
    surface,
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) record[key] = value
  }
  console.log(`${PREFIX} ${JSON.stringify(record)}`)
}

/** Record a point-in-time stage on the extension-host timeline. */
export function p0Stage(stage: string, extra?: Record<string, unknown>): void {
  emit(stage, "extension", Date.now(), extra)
}

/**
 * Span record on the extension-host timeline: emits a `span: "start"` record
 * now and a `span: "end"` record (with `dur` = elapsed ms) when `end()` runs.
 * When disabled both calls are no-ops. `end()` is only emitted on the normal
 * completion path; a caller that fails or is interrupted before calling
 * `end()` leaves an unmatched `span: "start"` record as the failure signal —
 * mirroring the backend `p0.start`/`p0.end` contract.
 */
export function p0Span(
  stage: string,
  extra?: Record<string, unknown>,
): { end: (extra?: Record<string, unknown>) => void } {
  if (!isP0PerfEnabled()) return { end() {} }
  const t0 = Date.now()
  emit(stage, "extension", t0, { span: "start", ...(extra ?? {}) })
  return {
    end(endExtra?: Record<string, unknown>) {
      emit(stage, "extension", Date.now(), {
        span: "end",
        dur: Math.round((Date.now() - t0) * 100) / 100,
        // Carry the start metadata forward so each record is self-describing
        // (bounded: only the caller-provided extra fields, never payloads).
        ...(extra ?? {}),
        ...(endExtra ?? {}),
      })
    },
  }
}

/**
 * Forward a webview-recorded point into the extension timeline. `t` is the
 * webview's wall-clock epoch ms, `wd` the webview-internal delta since its own
 * module load.
 */
export function p0Webview(stage: string, t: number, wd: number, extra?: Record<string, unknown>): void {
  // Guard against malformed webview payloads (the p0Perf message is untrusted).
  if (typeof t !== "number" || !Number.isFinite(t)) return
  emit(stage, "webview", t, { wd, ...(extra ?? {}) })
}
