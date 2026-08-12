/**
 * Parser for P0 benchmark records.
 *
 * Pure functions (no I/O, no Node deps) so they are unit-testable under Bun
 * and reusable by the harness and the per-sample probe. They parse:
 *
 *  1. extension-host / webview records — single-line JSON after the stable
 *     `[Kilo New][P0-Perf] ` prefix emitted by src/perf/perf-instrument.ts,
 *  2. backend records — `service=p0-perf event=p0.mark|p0.start|p0.end ...`
 *     key=value lines from the `kilo serve` process (relayed by the extension
 *     host's ServerManager stderr/stdout log forwarding),
 *  3. backend provenance lines — the extension's `ServerManager: 📦 CLI path:`
 *     log line.
 */

import type { StageRecord } from "./types"

export const P0_PREFIX = "[Kilo New][P0-Perf] "
export const CLI_PATH_PREFIX = "[Kilo New] ServerManager: 📍 CLI path:"
export const SPAWN_DONE_PREFIX = "[Kilo New] ServerManager: 📦 Process spawned with PID:"

/**
 * Parse a single extension/webview P0 record line. Returns undefined when the
 * line is not a P0 record. The JSON after the prefix carries: corr, stage, t,
 * d, surface, wd, and stage-specific extras.
 */
export function parseExtensionPerfLine(line: string): StageRecord | undefined {
  const idx = line.indexOf(P0_PREFIX)
  if (idx < 0) return undefined
  const json = line.slice(idx + P0_PREFIX.length).trim()
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(json) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (typeof raw.stage !== "string" || typeof raw.t !== "number") return undefined
  const surface = raw.surface === "webview" ? "webview" : "extension"
  const rec: StageRecord = { surface, stage: raw.stage, t: raw.t }
  if (typeof raw.corr === "string") rec.corr = raw.corr
  if (typeof raw.d === "number") rec.d = raw.d
  if (typeof raw.wd === "number") rec.wd = raw.wd
  if (typeof raw.pid === "number" && raw.pid > 0) rec.pid = raw.pid
  // Bounded span/metadata extras (p0Span records + sse.event dispatch): only
  // the known keys are copied, never arbitrary payload data.
  const extra: Record<string, unknown> = {}
  if (raw.span === "start" || raw.span === "end") extra.span = raw.span
  if (typeof raw.dur === "number") extra.dur = raw.dur
  if (typeof raw.eventType === "string") extra.eventType = raw.eventType
  if (typeof raw.dir === "string") extra.dir = raw.dir
  if (typeof raw.transaction === "string") extra.transaction = raw.transaction
  if (Object.keys(extra).length > 0) rec.extra = extra
  return rec
}

/** Backend record field names emitted by @opencode-ai/core/util/log. */
const BACKEND_FIELDS = ["event", "stage", "ts", "duration", "id", "dir", "meta"] as const

/**
 * Parse a backend `service=p0-perf` log line. The backend log format is
 * `INFO  <iso> +<diff>ms service=p0-perf event=p0.mark stage=... ts=... ...`
 * and the extension host relays the raw backend stderr line inside its own
 * `[Kilo New] ServerManager: ⚠️ CLI Server stderr: ...` wrapper, so the match
 * scans the whole line rather than requiring a specific prefix.
 */
export function parseBackendLogLine(line: string): StageRecord | undefined {
  if (!line.includes("service=p0-perf")) return undefined
  if (!line.includes("event=p0.")) return undefined
  const fields: Record<string, string> = {}
  for (const name of BACKEND_FIELDS) {
    const match = line.match(new RegExp(`\\b${name}=([^ ]+)`))
    if (match) fields[name] = match[1]
  }
  const event = fields.event
  const stage = fields.stage
  const ts = Number(fields.ts)
  if (!event || !stage || !Number.isFinite(ts)) return undefined
  const rec: StageRecord = { surface: "backend", stage, t: ts, event: event as StageRecord["event"] }
  if (fields.duration !== undefined) {
    const duration = Number(fields.duration)
    if (Number.isFinite(duration)) rec.duration = duration
  }
  if (fields.id !== undefined) rec.id = fields.id
  if (fields.dir !== undefined) rec.dir = fields.dir
  if (fields.meta !== undefined) rec.meta = fields.meta
  return rec
}

/** Extract the absolute CLI path logged by the extension's ServerManager. */
export function parseCliPath(line: string): string | null {
  const idx = line.indexOf(CLI_PATH_PREFIX)
  if (idx < 0) return null
  return line.slice(idx + CLI_PATH_PREFIX.length).trim() || null
}

/** Extract the backend process PID logged after spawn. */
export function parseSpawnedPid(line: string): number | null {
  const idx = line.indexOf(SPAWN_DONE_PREFIX)
  if (idx < 0) return null
  const tail = line.slice(idx + SPAWN_DONE_PREFIX.length).trim()
  const match = tail.match(/^(\d+)/)
  if (!match) return null
  const pid = Number(match[1])
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

/** Parsed P0 records extracted from a capture buffer (see extractRecords). */
export interface ParsedRecords {
  stages: StageRecord[]
  cliPath: string | null
  spawnedPid: number | null
}

/**
 * Parse a whole capture buffer (extension host stdout+stderr, including the
 * relayed backend stream) into normalized stage records and provenance lines.
 * Splits on newlines because the extension host relays each backend data chunk
 * with console.log/error, so one wrapped line may contain several backend
 * records separated by `\n`; every such fragment is scanned independently.
 */
export function extractRecords(text: string): ParsedRecords {
  const stages: StageRecord[] = []
  let cliPath: string | null = null
  let spawnedPid: number | null = null
  const lines = text.split("\n")
  for (const line of lines) {
    const ext = parseExtensionPerfLine(line)
    if (ext) {
      stages.push(ext)
      continue
    }
    const backend = parseBackendLogLine(line)
    if (backend) {
      stages.push(backend)
      continue
    }
    const path = parseCliPath(line)
    if (path) cliPath = path
    const pid = parseSpawnedPid(line)
    if (pid !== null) spawnedPid = pid
  }
  stages.sort((a, b) => a.t - b.t)
  return { stages, cliPath, spawnedPid }
}

// ---------------------------------------------------------------------------
// Bounded incremental capture
// ---------------------------------------------------------------------------
//
// The harness tees the probe's own stdout/stderr (which relay VS Code and the
// in-process extension host output) and polls the capture live for readiness
// gates. Raw output is retained only as a bounded tail (`capBytes`) so a hung
// sample cannot grow the process memory without bound; P0 records are parsed
// incrementally as complete lines arrive, so pollers read the parsed record
// view (O(1)) instead of re-concatenating and re-parsing the whole buffer
// every 100ms. When the raw cap is exceeded, the oldest bytes are dropped and
// `truncated` is flagged; parsed stage records are never dropped. The pending
// partial line (text after the last newline) is bounded to the same `capBytes`
// with a head-indexed, coalescing segment queue, so a writer emitting a long
// unterminated line can neither grow memory without bound nor force O(n²)
// re-copies on every ingest; when pending bytes are discarded, `truncated` is
// flagged the same way.
//
// Both segment queues (the raw tail `chunks` and the pending partial line
// `pending`) are head-indexed (no O(n) shift) and coalesced so the live segment
// count stays at or below MAX_SEGMENTS no matter how small the incoming chunks
// are. That makes object retention bounded by a constant instead of
// `capBytes / minChunk` (a 1-byte writer against the 5 MiB cap used to retain
// millions of tiny string objects and grow memory without bound).

/**
 * Hard cap on the number of live segments retained in either bounded queue
 * (the raw tail `chunks` and the pending partial line `pending`). Coalescing
 * (see coalesceSegs) keeps the live count at or below this bound regardless of
 * how small the incoming chunks are, so memory stays bounded by `capBytes`
 * plus a constant number of string objects instead of `capBytes / minChunk`.
 */
const MAX_SEGMENTS = 32

/**
 * Compact dead head slots once this many accumulate. Drops are amortized O(1):
 * each drop advances the head, and compaction (a splice over the dead prefix)
 * runs only every COMPACT_AT drops over an array at most COMPACT_AT + live
 * long. The dead slots hold at most COMPACT_AT dropped segments in between.
 */
const COMPACT_AT = 8

/** UTF-8 byte length of a string (pure; no Node/Buffer dependency). */
export function utf8ByteLength(s: string): number {
  let bytes = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const low = s.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4
        i++
      } else {
        bytes += 3
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      bytes += 3
    } else if (c < 0x80) {
      bytes += 1
    } else if (c < 0x800) {
      bytes += 2
    } else {
      bytes += 3
    }
  }
  return bytes
}

/**
 * Incremental capture state. Raw output is retained as `chunks` (a bounded
 * tail of `capBytes` UTF-8 bytes, chunk-granular), and `records` accumulates
 * every parsed P0 record regardless of raw truncation.
 */
export interface CaptureState {
  /** Maximum raw bytes retained; older bytes are dropped beyond this. */
  capBytes: number
  /**
   * Retained raw text segments — a bounded tail of `capBytes` UTF-8 bytes,
   * head-indexed (only `chunks[chunksHead..]` is live) and coalesced so the
   * live segment count never exceeds MAX_SEGMENTS. Merged segments preserve
   * raw-tail order; dead head slots are compacted in batches.
   */
  chunks: string[]
  /** UTF-8 byte length of each `chunks` entry (parallel, kept in sync). */
  chunksLens: number[]
  /** Index of the first live segment in `chunks`. */
  chunksHead: number
  /** Bytes of raw text currently retained. */
  retainedBytes: number
  /** Total raw bytes observed since the capture started. */
  totalBytes: number
  /** True once raw output exceeded capBytes (oldest bytes were dropped). */
  truncated: boolean
  /**
   * Partial line awaiting completion across chunk boundaries, held as a queue
   * of segments bounded by capBytes and MAX_SEGMENTS (head-indexed and
   * coalesced like `chunks`). Dropped segments stay in the array; only
   * `pending[pendingHead..]` is live (see pendingText).
   */
  pending: string[]
  /** UTF-8 byte length of each `pending` entry (parallel, kept in sync). */
  pendingLens: number[]
  /** Index of the first live segment in `pending`. */
  pendingHead: number
  /** Exact bytes held across live pending segments. */
  pendingBytes: number
  /** Incrementally parsed records and provenance. */
  records: ParsedRecords
}

/** Result of stopping a capture: bounded raw tail + parsed records + evidence. */
export interface CaptureResult {
  text: string
  totalBytes: number
  retainedBytes: number
  truncated: boolean
  records: ParsedRecords
}

export function createCapture(capBytes: number): CaptureState {
  return {
    capBytes,
    chunks: [],
    chunksLens: [],
    chunksHead: 0,
    retainedBytes: 0,
    totalBytes: 0,
    truncated: false,
    pending: [],
    pendingLens: [],
    pendingHead: 0,
    pendingBytes: 0,
    records: { stages: [], cliPath: null, spawnedPid: null },
  }
}

/**
 * Advance the head of a segment queue past its oldest segment, compacting the
 * now-dead head slots in batches so drops stay amortized O(1) with no O(n)
 * shift per ingest. Returns the dropped segment and its byte length so the
 * caller can keep its running byte count exact.
 */
function dropHeadSeg(
  segs: string[],
  lens: number[],
  hi: number,
): { dropped: string; bytes: number; hi: number } {
  const dropped = segs[hi]!
  const bytes = lens[hi]!
  let next = hi + 1
  if (next >= COMPACT_AT) {
    segs.splice(0, next)
    lens.splice(0, next)
    next = 0
  }
  return { dropped, bytes, hi: next }
}

/**
 * Coalesce a segment queue into a doubling rope so the live segment count stays
 * bounded regardless of chunk size. After each append, merge the tail pair
 * while the newer segment is at least as large as the one before it; every such
 * merge at least doubles the newer operand, so each byte is copied O(log T)
 * times (O(T log T) total for T retained bytes — linear-ish even for 1-byte
 * writers) and the live count stays at most ⌈log₂ T⌉ + 1. Merging preserves
 * order and never re-splits a line, so the joined queue text is identical
 * before and after, and the merged byte length is recomputed exactly (a
 * surrogate pair straddling the boundary is counted correctly once joined).
 * A safety net then caps the live count at MAX_SEGMENTS unconditionally.
 */
function coalesceSegs(segs: string[], lens: number[], hi: number): void {
  let i = segs.length - 1
  while (i > hi && lens[i]! >= lens[i - 1]!) {
    const joined = segs[i - 1]! + segs[i]!
    segs.splice(i - 1, 2, joined)
    lens.splice(i - 1, 2, utf8ByteLength(joined))
    i--
  }
  while (segs.length - hi > MAX_SEGMENTS) {
    // Unreachable for real captures (the doubling rope keeps the count at
    // O(log capBytes)); keep a hard cap so the segment bound is absolute.
    const joined = segs[segs.length - 2]! + segs[segs.length - 1]!
    segs.splice(segs.length - 2, 2, joined)
    lens.splice(segs.length - 2, 2, utf8ByteLength(joined))
  }
}

/**
 * Append one decoded text chunk to the capture: parse newly completed lines,
 * retain the chunk, drop the oldest raw bytes past the byte cap by advancing
 * the queue head, and coalesce so the raw segment count stays bounded. The
 * pending partial line is bounded to the same cap, so a long unterminated line
 * cannot grow memory without bound or force a full pending re-copy per ingest.
 */
export function ingestCapture(state: CaptureState, chunk: string): void {
  const bytes = utf8ByteLength(chunk)
  if (chunk.indexOf("\n") < 0) {
    // Fast path: no newline in this chunk, so the partial line grows by the
    // chunk alone — no scan of the whole pending text and no re-copy.
    appendPending(state, chunk, bytes)
  } else {
    // Newline(s) arrived: materialize the bounded pending text + chunk, parse
    // every complete line, and keep only the trailing partial line.
    const text = pendingText(state) + chunk
    const nl = text.lastIndexOf("\n")
    const parsed = extractRecords(text.slice(0, nl + 1))
    state.records.stages.push(...parsed.stages)
    if (parsed.cliPath !== null) state.records.cliPath = parsed.cliPath
    if (parsed.spawnedPid !== null) state.records.spawnedPid = parsed.spawnedPid
    const tail = text.slice(nl + 1)
    state.pending = tail.length > 0 ? [tail] : []
    state.pendingLens = tail.length > 0 ? [utf8ByteLength(tail)] : []
    state.pendingHead = 0
    state.pendingBytes = utf8ByteLength(tail)
    if (state.pendingBytes > state.capBytes) {
      const kept = dropHeadBytes(tail, state.pendingBytes - state.capBytes)
      state.pending = [kept]
      state.pendingLens = [utf8ByteLength(kept)]
      state.pendingHead = 0
      state.pendingBytes = utf8ByteLength(kept)
      state.truncated = true
    }
  }
  state.totalBytes += bytes
  if (bytes === 0) return // an empty chunk changes nothing in the raw tail
  const prev = lastNonEmpty(state.chunks, state.chunksLens)
  if (prev !== undefined && highSurrogateEnds(prev) && lowSurrogateStarts(chunk)) {
    // The pair spans the segment boundary: 4 bytes joined but counted as two
    // unpaired surrogates (3 + 3), so restore exact accounting.
    state.retainedBytes -= 2
  }
  state.chunks.push(chunk)
  state.chunksLens.push(bytes)
  state.retainedBytes += bytes
  while (state.retainedBytes > state.capBytes && state.chunks.length - state.chunksHead > 1) {
    // Drop the oldest whole segment by advancing the head (O(1), never a
    // shift); dropping a whole segment can leave retained below the cap, which
    // is the original chunk-granular semantic. Splitting a huge head segment to
    // hit the cap exactly would re-scan it per ingest (O(n²)), so we do not.
    const head = dropHeadSeg(state.chunks, state.chunksLens, state.chunksHead)
    state.chunksHead = head.hi
    state.retainedBytes -= head.bytes
    state.truncated = true
    const nextIdx = nextNonEmpty(state.chunks, state.chunksLens, state.chunksHead)
    const next = state.chunks[nextIdx]
    if (next !== undefined && highSurrogateEnds(head.dropped) && lowSurrogateStarts(next)) {
      // The dropped segment held the pair's high half; drop the orphaned low
      // half too. Its residual contribution is 1 byte (3 − the 2-byte pair
      // correction above), so exact accounting is kept.
      const kept = next.slice(1)
      state.chunks[nextIdx] = kept
      state.chunksLens[nextIdx] = utf8ByteLength(kept)
      state.retainedBytes -= 1
    }
  }
  if (state.retainedBytes > state.capBytes) state.truncated = true
  coalesceSegs(state.chunks, state.chunksLens, state.chunksHead)
}

/** True when the string ends with a high (pair-leading) surrogate. */
function highSurrogateEnds(s: string): boolean {
  const c = s.charCodeAt(s.length - 1)
  return c >= 0xd800 && c <= 0xdbff
}

/** True when the string starts with a low (pair-trailing) surrogate. */
function lowSurrogateStarts(s: string): boolean {
  const c = s.charCodeAt(0)
  return c >= 0xdc00 && c <= 0xdfff
}

/**
 * The last live segment with non-zero byte length. Empty segments (an empty
 * input chunk, or a segment emptied by the orphan-low-surrogate trim) are
 * transparent for surrogate-pair accounting: a pair can straddle the boundary
 * between the last non-empty segment and the next pushed chunk even when empty
 * segments sit in between.
 */
function lastNonEmpty(segs: string[], lens: number[]): string | undefined {
  for (let i = segs.length - 1; i >= 0; i--) {
    if (lens[i]! > 0) return segs[i]
  }
  return undefined
}

/**
 * Index of the first live segment at or after `start` with non-zero byte
 * length (empty segments are transparent for orphan-low-surrogate handling).
 */
function nextNonEmpty(segs: string[], lens: number[], start: number): number {
  let i = start
  while (i < segs.length && lens[i] === 0) i++
  return i
}

/**
 * Append one newline-free chunk to the bounded partial line. Appends are O(1);
 * once the cap is reached the oldest whole segments are dropped from the head
 * (amortized O(1), never a shift), and coalescing keeps the live segment count
 * at or below MAX_SEGMENTS, so per-ingest work stays O(1) amortized and total
 * memory is bounded by the cap plus a constant number of string objects.
 */
function appendPending(state: CaptureState, chunk: string, bytes: number): void {
  if (bytes === 0) return // an empty chunk changes nothing in the partial line
  const prev = lastNonEmpty(state.pending, state.pendingLens)
  if (prev !== undefined && highSurrogateEnds(prev) && lowSurrogateStarts(chunk)) {
    // The pair spans the segment boundary: it is 4 bytes joined but was counted
    // as two unpaired surrogates (3 + 3), so restore exact accounting.
    state.pendingBytes -= 2
  }
  state.pending.push(chunk)
  state.pendingLens.push(bytes)
  state.pendingBytes += bytes
  while (state.pendingBytes > state.capBytes && state.pending.length - state.pendingHead > 1) {
    // Drop the oldest whole segment by advancing the head (O(1), never a
    // shift); splitting a huge head to hit the cap exactly would re-scan it
    // per ingest (O(n²)), so we do not.
    const head = dropHeadSeg(state.pending, state.pendingLens, state.pendingHead)
    state.pendingHead = head.hi
    state.pendingBytes -= head.bytes
    state.truncated = true
    const nextIdx = nextNonEmpty(state.pending, state.pendingLens, state.pendingHead)
    const next = state.pending[nextIdx]
    if (next !== undefined && highSurrogateEnds(head.dropped) && lowSurrogateStarts(next)) {
      // The dropped segment held the pair's high half; drop the orphaned low
      // half too. Its residual contribution is 1 byte (3 − the 2-byte pair
      // correction above), so exact accounting is kept.
      const kept = next.slice(1)
      state.pending[nextIdx] = kept
      state.pendingLens[nextIdx] = utf8ByteLength(kept)
      state.pendingBytes -= 1
    }
  }
  if (state.pendingBytes > state.capBytes) {
    // A single segment alone exceeds the cap: keep only its newest bytes.
    const head = state.pending[state.pendingHead]!
    const kept = dropHeadBytes(head, state.pendingBytes - state.capBytes)
    state.pending = [kept]
    state.pendingLens = [utf8ByteLength(kept)]
    state.pendingHead = 0
    state.pendingBytes = utf8ByteLength(kept)
    state.truncated = true
  }
  coalesceSegs(state.pending, state.pendingLens, state.pendingHead)
}

/** Materialize the bounded pending partial line (O(pendingBytes), rarely called). */
export function pendingText(state: CaptureState): string {
  return state.pending.slice(state.pendingHead).join("")
}

/**
 * Drop the first `drop` UTF-8 bytes of `s` at a character boundary that never
 * splits a surrogate pair, returning the retained tail. Used to bound a pending
 * partial line when a single chunk alone exceeds the cap: the oldest bytes of
 * the line are discarded and the newest retained.
 */
function dropHeadBytes(s: string, drop: number): string {
  let cut = 0
  let bytes = 0
  while (cut < s.length && bytes < drop) {
    const c = s.charCodeAt(cut)
    const low = s.charCodeAt(cut + 1)
    if (c >= 0xd800 && c <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
      bytes += 4
      cut += 2
    } else {
      bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3
      cut += 1
    }
  }
  const tail = s.slice(cut)
  // Never leave a lone low surrogate at the head of the retained tail.
  return lowSurrogateStarts(tail) ? tail.slice(1) : tail
}

/**
 * Parse any pending partial line and return the final capture result. Called
 * once at capture stop (the raw tail becomes the sample log artifact).
 */
export function flushCapture(state: CaptureState): CaptureResult {
  const tail = pendingText(state)
  if (tail.length > 0) {
    const parsed = extractRecords(tail)
    state.records.stages.push(...parsed.stages)
    if (parsed.cliPath !== null) state.records.cliPath = parsed.cliPath
    if (parsed.spawnedPid !== null) state.records.spawnedPid = parsed.spawnedPid
  }
  state.pending = []
  state.pendingLens = []
  state.pendingHead = 0
  state.pendingBytes = 0
  return {
    text: state.chunks.slice(state.chunksHead).join(""),
    totalBytes: state.totalBytes,
    retainedBytes: state.retainedBytes,
    truncated: state.truncated,
    records: state.records,
  }
}

// ---------------------------------------------------------------------------
// Ordered teardown (lifecycle cleanup)
// ---------------------------------------------------------------------------
//
// The probe's cleanup sequence (done marker → browser close → capture stop →
// VS Code exit → exact-owned cleanup) must run to completion even when an
// earlier step throws. runCleanupSteps executes every step and collects each
// failure instead of letting one throw skip the steps after it.

/** A cleanup step: failures are collected by runCleanupSteps, never thrown. */
export interface CleanupStep {
  label: string
  run: () => Promise<void> | void
}

/**
 * Run ordered cleanup steps so a throwing step can never skip later steps.
 * Every step executes; each failure is recorded as `${label}: ${message}` and
 * the collected notes are returned (never thrown), so the caller can report the
 * original failure alongside the cleanup evidence.
 */
export async function runCleanupSteps(steps: ReadonlyArray<CleanupStep>): Promise<string[]> {
  const notes: string[] = []
  for (const step of steps) {
    try {
      await step.run()
    } catch (err) {
      notes.push(`${step.label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return notes
}

/**
 * Closures the per-lifecycle probe binds into its teardown plan. Extracted so
 * the real composition (exact labels, order, all-run semantics) is
 * structurally testable without launching VS Code.
 */
export interface LifecycleTeardownHandles {
  /** Write the done marker file (sync). */
  writeDone: () => void
  /** Close the CDP browser if one was opened. */
  closeBrowser: () => Promise<void> | void
  /** Stop capture: restore the original writers and flush the bounded tail. */
  stopCapture: () => CaptureResult
  /** Tag every emitted sample with the capture truncation flag. */
  markTruncated: (truncated: boolean) => void
  /** Write the raw log artifact; must throw on failure so it stays visible. */
  writeRawLog: (text: string) => void
  /** Await the VS Code lifecycle exit; resolves true when it exited cleanly. */
  waitExit: () => Promise<boolean>
  /** Record the exit result (marks the run failed when not clean). */
  onExitResult: (exited: boolean) => void
  /** Exact-owned cleanup: settle → exact PID → port release → scratch delete. */
  cleanup: () => Promise<void> | void
}

/**
 * The probe's exact-ordered lifecycle teardown plan: done marker → browser
 * close → capture stop → raw log write → VS Code exit → exact-owned cleanup.
 * Every step runs; failures (including a failed raw-log write, which is
 * evidence loss and must stay visible) are collected by runCleanupSteps and
 * surface on the sample as cleanup evidence without skipping later steps.
 */
export function lifecycleTeardownSteps(h: LifecycleTeardownHandles): CleanupStep[] {
  let capturedText = ""
  return [
    { label: "done marker", run: h.writeDone },
    { label: "browser close", run: h.closeBrowser },
    {
      label: "capture stop",
      run: () => {
        const captured = h.stopCapture()
        capturedText = captured.text
        h.markTruncated(captured.truncated)
      },
    },
    { label: "raw log write", run: () => h.writeRawLog(capturedText) },
    {
      label: "VS Code exit",
      run: async () => {
        const exited = await h.waitExit()
        h.onExitResult(exited)
      },
    },
    { label: "cleanup", run: h.cleanup },
  ]
}

/** Find the first stage record matching surface+stage. */
export function findStage(
  stages: StageRecord[],
  surface: StageRecord["surface"],
  stage: string,
): StageRecord | undefined {
  return stages.find((s) => s.surface === surface && s.stage === stage)
}

/** Find all stage records matching surface+stage (ordered by t). */
export function findStages(stages: StageRecord[], surface: StageRecord["surface"], stage: string): StageRecord[] {
  return stages.filter((s) => s.surface === surface && s.stage === stage)
}

/** Duration between two stage records in ms (positive, or undefined if missing). */
export function durationBetween(a: StageRecord | undefined, b: StageRecord | undefined): number | undefined {
  if (!a || !b) return undefined
  const ms = b.t - a.t
  return ms >= 0 ? ms : undefined
}

/** Slice stage records whose t falls within [startT, endT). */
export function sliceStages(stages: StageRecord[], startT: number, endT: number): StageRecord[] {
  return stages.filter((s) => s.t >= startT && s.t < endT)
}
