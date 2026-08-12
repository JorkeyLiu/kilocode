/**
 * Pure segment merger for the P0 VS Code extension benchmark (LOCK decisions
 * LOCK-PERF-1..7; strict single-scenario merge v1).
 *
 * Externally resilient one-sample campaigns produce one segment each:
 *   segment 1:   --samples 1 --warmup 1  → one warmup + one measured record
 *   segments 2+: --samples 1 --warmup 0  → one measured record each
 *
 * This module merges those segments into ONE truthful many-agent-MCP scenario
 * artifact with exactly one warmup and `requiredSamples` (default 5) measured
 * samples, recomputed n/min/median/p95/max summaries via the existing
 * summarize(), deterministic sample renumbering, and a versioned
 * merge-manifest.json with full provenance. It never fabricates records.
 *
 * Truthfulness rules:
 *   - Interrupted runs (run/start present, no run/finish) are INVALID inputs
 *     and are rejected outright — they are never merged and never reported as
 *     merely "incomplete".
 *   - baselineComplete is true only for exactly one warmup, exactly
 *     requiredSamples measured samples, and no failed/blocked sample.
 *   - A valid-but-incomplete merge (too few measured samples, warmup count
 *     != 1, or a failed/blocked sample) still emits a merged artifact with
 *     baselineComplete:false; the CLI reports it distinctly (exit 2).
 *   - p95 at n=5 equals max and is descriptive only, never an SLA
 *     (LOCK-PERF-7 stays Open).
 *
 * Pure module (no filesystem I/O; the only runtime dependency is
 * node:crypto hashing) so the CLI (script/p0-bench-merge.ts) and the unit
 * tests (tests/unit/p0-bench-merge*.test.ts) share one implementation.
 * Input records are immutable: the merger never mutates a parsed input record
 * — every merged record is a fresh deep clone with only sample/phase
 * renumbered.
 */

import { createHash } from "node:crypto"
import type { RunRecord, SampleRecord, ScenarioID, SummaryRecord } from "./types"
import { SCENARIOS } from "./types"
import { phaseForSample } from "./phase"
import { campaignStatus } from "./status"
import { summarize } from "./stats"

export type RunStatus = "ok" | "partial" | "failed"

export type MergeErrorCode =
  | "empty"
  | "corrupt"
  | "version"
  | "kind"
  | "run-records"
  | "interrupted"
  | "scenario"
  | "count"
  | "phase"
  | "sample-number"
  | "status"
  | "sample-integrity"
  | "duplicate-path"
  | "duplicate-file"
  | "duplicate-sample"
  | "scenario-mismatch"

/** Categorized merge failure; the CLI reports the message distinctly. */
export class MergeError extends Error {
  constructor(
    readonly code: MergeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "MergeError"
  }
}

/** sha256 hex of a string or raw bytes. */
export function sha256hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex")
}

/** One parsed JSONL line: the trimmed raw text, its sha256, and the record. */
export interface MergeLine {
  line: string
  hash: string
  record: Record<string, unknown>
}

/** A sample record with its source line provenance. */
export interface SegmentSample {
  line: MergeLine
  lineNo: number
  record: SampleRecord
}

/**
 * A validated input segment: run/start + samples + run/finish from one
 * one-sample campaign, with exact source line provenance for the manifest.
 */
export interface SegmentData {
  path: string
  sha256: string
  outDir: string | null
  scenario: ScenarioID
  samples: number
  warmup: number
  status: RunStatus
  startLine: MergeLine
  startLineNo: number
  finishLine: MergeLine
  finishLineNo: number
  start: RunRecord
  finish: RunRecord
  samplesParsed: SegmentSample[]
  summaryCount: number
  recordCount: number
}

/**
 * Parse a raw JSONL text into MergeLines. Rejects empty lines (except the
 * single trailing newline artifact), invalid JSON, and non-object records —
 * a segment with unknown/corrupt records is not mergeable evidence.
 */
export function parseLines(text: string, path: string): MergeLine[] {
  const raw = text.split("\n")
  if (raw.every((l) => l.trim().length === 0)) {
    throw new MergeError("empty", `no records in ${path}`)
  }
  const out: MergeLine[] = []
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!.trim()
    if (line.length === 0) {
      // A file written with a trailing newline yields one empty final element;
      // any other empty line inside the stream is a corrupt artifact.
      if (i === raw.length - 1) continue
      throw new MergeError("corrupt", `empty line ${i + 1} in ${path}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new MergeError("corrupt", `invalid JSON at line ${i + 1} of ${path}`)
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new MergeError("corrupt", `record at line ${i + 1} of ${path} is not a JSON object`)
    }
    out.push({ line, hash: sha256hex(line), record: parsed as Record<string, unknown> })
  }
  if (out.length === 0) throw new MergeError("empty", `no records in ${path}`)
  return out
}

/** Extract the single scenario id from a run/start scenarios array. */
function scenarioOf(value: unknown, path: string): ScenarioID {
  const list = Array.isArray(value) ? value : null
  if (!list || list.length !== 1 || typeof list[0] !== "string" || !(SCENARIOS as readonly string[]).includes(list[0])) {
    throw new MergeError("scenario", `run/start scenarios must be exactly one known scenario (got ${JSON.stringify(value)}) in ${path}`)
  }
  return list[0] as ScenarioID
}

function sameScenarios(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

/** Verify one sample's schema shape; throws when the record is self-inconsistent. */
function assertSampleShape(rec: SampleRecord, lineNo: number, path: string, scenario: ScenarioID): void {
  if (rec.scenario !== scenario) {
    throw new MergeError(
      "scenario",
      `sample scenario ${JSON.stringify(rec.scenario)} at line ${lineNo} of ${path} does not match run scenario ${scenario}`,
    )
  }
  if (typeof rec.startedAt !== "number" || !Number.isFinite(rec.startedAt)) {
    throw new MergeError("status", `sample ${rec.sample} startedAt missing at line ${lineNo} of ${path}`)
  }
  if (typeof rec.ok !== "boolean") {
    throw new MergeError("sample-integrity", `sample ${rec.sample} ok must be a boolean at line ${lineNo} of ${path}`)
  }
  if (rec.key === null || typeof rec.key !== "object" || Array.isArray(rec.key)) {
    throw new MergeError("sample-integrity", `sample ${rec.sample} key must be an object at line ${lineNo} of ${path}`)
  }
  const failures = Array.isArray(rec.failures) ? rec.failures : null
  if (rec.ok) {
    // A successful sample must be exactly ok:true / blocked:null / empty failures.
    if (rec.blocked !== null || (failures !== null && failures.length > 0)) {
      throw new MergeError(
        "sample-integrity",
        `successful sample ${rec.sample} at line ${lineNo} of ${path} must be ok:true with blocked:null and empty failures`,
      )
    }
  } else if (rec.blocked === null && (failures === null || failures.length === 0)) {
    // An explicit failure without any failure evidence would be fabricated.
    throw new MergeError(
      "sample-integrity",
      `failed sample ${rec.sample} at line ${lineNo} of ${path} has no failure evidence (blocked null and empty failures)`,
    )
  }
}

function isRunStart(rec: Record<string, unknown>): boolean {
  return rec.kind === "run" && rec.event === "start"
}

function isRunFinish(rec: Record<string, unknown>): boolean {
  return rec.kind === "run" && rec.event === "finish"
}

/** Walk the middle records (between run/start and run/finish) with shape checks. */
function extractMiddle(lines: MergeLine[], path: string): { samples: SegmentSample[]; summaryCount: number } {
  const samples: SegmentSample[] = []
  let summaryCount = 0
  for (let i = 1; i < lines.length - 1; i++) {
    const entry = lines[i]!
    const rec = entry.record
    if (rec.v !== 1) {
      throw new MergeError("version", `unsupported record version ${JSON.stringify(rec.v)} at line ${i + 1} of ${path} (schema v1 required)`)
    }
    if (rec.kind === "sample") {
      samples.push({ line: entry, lineNo: i + 1, record: rec as unknown as SampleRecord })
    } else if (rec.kind === "summary") {
      summaryCount++
    } else if (rec.kind === "run") {
      throw new MergeError("run-records", `multiple run records in ${path} (line ${i + 1}); a segment has exactly one run/start and one run/finish`)
    } else {
      throw new MergeError("kind", `unknown record kind ${JSON.stringify(rec.kind)} at line ${i + 1} of ${path}`)
    }
  }
  return { samples, summaryCount }
}

/** Validate the run/start envelope; returns the declared scenario/counts. */
function checkRunStart(start: RunRecord, path: string): { scenario: ScenarioID; samples: number; warmup: number } {
  const scenario = scenarioOf(start.scenarios, path)
  const samples = start.samples
  const warmup = start.warmup
  if (!Number.isInteger(samples) || samples < 0) {
    throw new MergeError("count", `start.samples must be an integer >= 0 (got ${JSON.stringify(start.samples)}) in ${path}`)
  }
  if (!Number.isInteger(warmup) || warmup < 0) {
    throw new MergeError("count", `start.warmup must be an integer >= 0 (got ${JSON.stringify(start.warmup)}) in ${path}`)
  }
  if (typeof start.startedAt !== "number" || !Number.isFinite(start.startedAt)) {
    throw new MergeError("status", `run/start startedAt missing in ${path}`)
  }
  return { scenario, samples, warmup }
}

/** Validate the run/finish envelope against the run/start envelope. */
function checkRunFinish(finish: RunRecord, start: RunRecord, samples: number, warmup: number, path: string): void {
  if (typeof finish.finishedAt !== "number" || !Number.isFinite(finish.finishedAt)) {
    throw new MergeError("status", `run/finish finishedAt missing in ${path}`)
  }
  if (finish.samples !== samples || finish.warmup !== warmup) {
    throw new MergeError(
      "count",
      `run/finish samples/warmup (${finish.samples}/${finish.warmup}) does not match run/start (${samples}/${warmup}) in ${path}`,
    )
  }
  if (!sameScenarios(finish.scenarios, start.scenarios)) {
    throw new MergeError("scenario", `run/finish scenarios do not match run/start in ${path}`)
  }
  if (finish.status !== "ok" && finish.status !== "partial" && finish.status !== "failed") {
    throw new MergeError("status", `run/finish status ${JSON.stringify(finish.status)} invalid or missing in ${path}`)
  }
}

/** Per-sample checks (numbering, phase vs phaseForSample, shape) with truthful aggregation. */
function checkSamples(
  samples: SegmentSample[],
  warmup: number,
  scenario: ScenarioID,
  path: string,
): { anyOkMeasured: boolean; anyBlocked: boolean } {
  let anyOkMeasured = false
  let anyBlocked = false
  for (let i = 0; i < samples.length; i++) {
    const entry = samples[i]!
    const rec = entry.record
    if (!Number.isInteger(rec.sample) || rec.sample < 1) {
      throw new MergeError("sample-number", `sample number ${JSON.stringify(rec.sample)} at line ${entry.lineNo} of ${path} must be a positive integer`)
    }
    if (rec.sample !== i + 1) {
      throw new MergeError(
        "sample-number",
        `sample numbers in ${path} must be sequential 1..N (expected ${i + 1}, got ${rec.sample} at line ${entry.lineNo})`,
      )
    }
    if (rec.phase !== "warmup" && rec.phase !== "measured") {
      throw new MergeError("phase", `sample ${rec.sample} phase ${JSON.stringify(rec.phase)} invalid at line ${entry.lineNo} of ${path}`)
    }
    const expectedPhase = phaseForSample(rec.sample, warmup)
    if (rec.phase !== expectedPhase) {
      throw new MergeError(
        "phase",
        `sample ${rec.sample} phase ${rec.phase} at line ${entry.lineNo} of ${path} does not match ` +
          `phaseForSample(${rec.sample}, warmup=${warmup}) = ${expectedPhase}`,
      )
    }
    assertSampleShape(rec, entry.lineNo, path, scenario)
    if (rec.phase === "measured" && rec.ok) anyOkMeasured = true
    if (rec.blocked !== null) anyBlocked = true
  }
  return { anyOkMeasured, anyBlocked }
}

/**
 * Validate one segment's parsed lines. Throws MergeError on every invalid
 * shape: interrupted runs (missing finish), corrupt records, wrong version,
 * unknown kinds, extra run records, scenario drift, count/phase mismatches
 * against run/start samples+warmup, and a finish status that does not match
 * the segment's samples.
 */
export function validateSegment(path: string, sha256: string, lines: MergeLine[]): SegmentData {
  if (lines.length === 0) throw new MergeError("empty", `no records in ${path}`)
  const first = lines[0]!
  if (!isRunStart(first.record)) {
    throw new MergeError(
      "kind",
      `first record of ${path} must be run/start (got kind=${JSON.stringify(first.record.kind)} event=${JSON.stringify(first.record.event)})`,
    )
  }
  const last = lines[lines.length - 1]!
  if (!isRunFinish(last.record)) {
    throw new MergeError(
      "interrupted",
      `interrupted run: ${path} has no run/finish record (last record kind=${JSON.stringify(last.record.kind)} event=${JSON.stringify(last.record.event)}); ` +
        `interrupted runs without finish are invalid inputs`,
    )
  }
  const { samples, summaryCount } = extractMiddle(lines, path)
  const start = first.record as unknown as RunRecord
  const finish = last.record as unknown as RunRecord
  const { scenario, samples: samplesN, warmup } = checkRunStart(start, path)
  checkRunFinish(finish, start, samplesN, warmup, path)
  const { anyOkMeasured, anyBlocked } = checkSamples(samples, warmup, scenario, path)
  if (samples.length !== samplesN + warmup) {
    throw new MergeError(
      "count",
      `sample count ${samples.length} in ${path} does not match start.samples+start.warmup (${samplesN}+${warmup}=${samplesN + warmup})`,
    )
  }
  const expected = campaignStatus(anyOkMeasured, anyBlocked)
  if (finish.status !== expected) {
    throw new MergeError("status", `run/finish status ${finish.status} in ${path} does not match its samples (expected ${expected})`)
  }
  return {
    path,
    sha256,
    outDir: typeof start.outDir === "string" ? start.outDir : null,
    scenario,
    samples: samplesN,
    warmup,
    status: finish.status,
    startLine: first,
    startLineNo: 1,
    finishLine: last,
    finishLineNo: lines.length,
    start,
    finish,
    samplesParsed: samples,
    summaryCount,
    recordCount: lines.length,
  }
}

/**
 * Per-segment environment fingerprint recorded in the manifest (run records
 * may omit merged env; the manifest carries the segment fingerprints and the
 * environment drift instead).
 */
export interface EnvFingerprint {
  envPresent: boolean
  os: string | null
  arch: string | null
  node: string | null
  extension: string | null
  gitHead: string | null
  gitCommit: string | null
  gitDirty: boolean | null
  backendCli: string | null
  cliSnapshotSha256: string | null
}

const NULL_FINGERPRINT: EnvFingerprint = {
  envPresent: false,
  os: null,
  arch: null,
  node: null,
  extension: null,
  gitHead: null,
  gitCommit: null,
  gitDirty: null,
  backendCli: null,
  cliSnapshotSha256: null,
}

/** Fingerprint of a segment's run/start env (missing env → all-null + envPresent false). */
export function fingerprintFromEnv(env: unknown): EnvFingerprint {
  if (env === null || typeof env !== "object" || Array.isArray(env)) return { ...NULL_FINGERPRINT }
  const e = env as Record<string, unknown>
  const snap = typeof e.cliSnapshot === "object" && e.cliSnapshot !== null ? (e.cliSnapshot as Record<string, unknown>) : null
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
  return {
    envPresent: true,
    os: str(e.os),
    arch: str(e.arch),
    node: str(e.node),
    extension: str(e.extension),
    gitHead: str(e.gitHead),
    gitCommit: str(e.gitCommit),
    gitDirty: typeof e.gitDirty === "boolean" ? e.gitDirty : null,
    backendCli: str(e.backendCli),
    cliSnapshotSha256: str(snap?.sourceSha256),
  }
}

const FINGERPRINT_FIELDS = [
  "os",
  "arch",
  "node",
  "extension",
  "gitHead",
  "gitCommit",
  "gitDirty",
  "backendCli",
  "cliSnapshotSha256",
  "envPresent",
] as const

/** Cross-segment environment drift: every field with more than one distinct value. */
export function driftReport(fps: EnvFingerprint[]): Array<{ field: string; values: string[] }> {
  const out: Array<{ field: string; values: string[] }> = []
  for (const field of FINGERPRINT_FIELDS) {
    const values = [...new Set(fps.map((fp) => String(fp[field])))].sort()
    if (values.length > 1) out.push({ field, values })
  }
  return out
}

export interface MergeOptions {
  requiredSamples: number
  /** Current merge timestamp carried into the manifest. */
  mergedAt: number
  /** Freeze-time git state captured BEFORE the output artifact is created. */
  mergeGit: { gitCommit: string | null; gitHead: string | null; gitDirty: boolean }
  /** Resolved absolute merged output directory. */
  outDir: string
}

/** Provenance mapping for one merged sample (manifest recordMapping.samples). */
export interface SampleMapping {
  mergedSample: number
  mergedPhase: "warmup" | "measured"
  segment: string
  line: number
  hash: string
  sourceSample: number
  sourcePhase: "warmup" | "measured"
}

export interface MergeOutput {
  /** Full merged JSONL record stream (v1 schema, harness order). */
  records: unknown[]
  /** Current merge timestamp (manifest mergedAt). */
  mergedAt: number
  /** Freeze-time git state captured before output creation (manifest mergeGit). */
  mergeGit: { gitCommit: string | null; gitHead: string | null; gitDirty: boolean }
  requiredSamples: number
  scenario: ScenarioID
  warmupCount: number
  measuredCount: number
  baselineComplete: boolean
  status: RunStatus
  warnings: string[]
  drift: Array<{ field: string; values: string[] }>
  fingerprints: Array<{ path: string; fingerprint: EnvFingerprint }>
  p95Note: string
  summaryRecords: SummaryRecord[]
  runStart: RunRecord
  runFinish: RunRecord
  sampleMappings: SampleMapping[]
  startMapping: { segment: string; line: number; hash: string }
  finishMapping: { segment: string; line: number; hash: string }
}

interface FlatSample {
  seg: SegmentData
  line: MergeLine
  lineNo: number
  idx: number
  record: SampleRecord
}

function cloneRecord<T>(rec: T): T {
  return JSON.parse(JSON.stringify(rec)) as T
}

function byStart(a: FlatSample, b: FlatSample): number {
  // Order by startedAt; ties break by input order (flatten order), so the
  // renumbering is deterministic for any input ordering.
  return a.record.startedAt - b.record.startedAt || a.idx - b.idx
}

function summariesFor(measured: FlatSample[], scenario: ScenarioID): SummaryRecord[] {
  const metrics = new Map<string, number[]>()
  for (const f of measured) {
    if (!f.record.ok) continue
    for (const [metric, value] of Object.entries(f.record.key)) {
      if (typeof value === "number") {
        const list = metrics.get(metric) ?? []
        list.push(value)
        metrics.set(metric, list)
      }
    }
  }
  const out: SummaryRecord[] = []
  for (const [metric, values] of metrics) {
    out.push({ v: 1, kind: "summary", scenario, metric, unit: "ms", ...summarize(values) })
  }
  return out
}

/** Descriptive p95 note: at merged n=5 nearest-rank p95 equals max (never an SLA). */
export function p95Note(n: number): string {
  const equality = n < 20 ? "nearest-rank p95 equals max" : "nearest-rank p95 may differ from max"
  return (
    `Merged measured n=${n}: ${equality}. Descriptive sample statistics only — NOT a tail-latency SLA; ` +
    `no threshold or service-level claim derives from them (LOCK-PERF-7 thresholds remain Open).`
  )
}

/**
 * Merge validated segments into one truthful artifact. Throws MergeError on
 * duplicate segment paths, duplicate file hashes, duplicate sample records,
 * and mixed scenarios. Every merged sample is a fresh clone with only
 * sample/phase renumbered (deterministic: warmup stays sample 1 phase warmup;
 * measured become sample 1..N by startedAt, ties by input order).
 */
export function mergeSegments(segs: SegmentData[], opts: MergeOptions): MergeOutput {
  if (segs.length === 0) throw new MergeError("empty", "no segments to merge")
  const seenPaths = new Set<string>()
  const seenSha = new Map<string, string>()
  for (const s of segs) {
    if (seenPaths.has(s.path)) throw new MergeError("duplicate-path", `duplicate segment path ${s.path}`)
    seenPaths.add(s.path)
    const prev = seenSha.get(s.sha256)
    if (prev !== undefined) throw new MergeError("duplicate-file", `segments ${prev} and ${s.path} have identical content (sha256 ${s.sha256})`)
    seenSha.set(s.sha256, s.path)
  }
  const scenario = segs[0]!.scenario
  for (const s of segs) {
    if (s.scenario !== scenario) {
      throw new MergeError("scenario-mismatch", `segments mix scenarios: ${segs[0]!.path}=${scenario}, ${s.path}=${s.scenario}`)
    }
  }
  const all: FlatSample[] = []
  for (const seg of segs) {
    for (const s of seg.samplesParsed) {
      all.push({ seg, line: s.line, lineNo: s.lineNo, idx: all.length, record: s.record })
    }
  }
  const seenSample = new Map<string, string>()
  for (const f of all) {
    const h = sha256hex(JSON.stringify(f.record))
    const prev = seenSample.get(h)
    if (prev !== undefined) throw new MergeError("duplicate-sample", `duplicate sample record (sha256 ${h}) in ${prev} and ${f.seg.path}`)
    seenSample.set(h, `${f.seg.path}:${f.lineNo}`)
  }
  const warmups = all.filter((f) => f.record.phase === "warmup")
  const measured = all.filter((f) => f.record.phase === "measured")
  const warmupCount = warmups.length
  const measuredCount = measured.length
  const anyFailed = all.some((f) => !f.record.ok)
  const anyBlocked = all.some((f) => f.record.blocked !== null)
  const anyOkMeasured = measured.some((f) => f.record.ok)
  const status = campaignStatus(anyOkMeasured, anyBlocked)
  const warnings: string[] = []
  if (measuredCount !== opts.requiredSamples) warnings.push(`measured samples ${measuredCount} != required ${opts.requiredSamples}`)
  if (warmupCount !== 1) warnings.push(`warmup records ${warmupCount} != required 1`)
  if (anyFailed) warnings.push(`${all.filter((f) => !f.record.ok).length} failed/blocked sample(s)`)
  const baselineComplete = warmupCount === 1 && measuredCount === opts.requiredSamples && !anyFailed
  const warmupSorted = [...warmups].sort(byStart)
  const measuredSorted = [...measured].sort(byStart)
  const sampleMappings: SampleMapping[] = []
  const mergedSamples: Array<{ record: SampleRecord }> = []
  warmupSorted.forEach((f, i) => {
    const merged = cloneRecord(f.record)
    merged.sample = i + 1
    merged.phase = "warmup"
    mergedSamples.push({ record: merged })
    sampleMappings.push({
      mergedSample: i + 1,
      mergedPhase: "warmup",
      segment: f.seg.path,
      line: f.lineNo,
      hash: f.line.hash,
      sourceSample: f.record.sample,
      sourcePhase: f.record.phase,
    })
  })
  measuredSorted.forEach((f, i) => {
    const merged = cloneRecord(f.record)
    merged.sample = i + 1
    merged.phase = "measured"
    mergedSamples.push({ record: merged })
    sampleMappings.push({
      mergedSample: i + 1,
      mergedPhase: "measured",
      segment: f.seg.path,
      line: f.lineNo,
      hash: f.line.hash,
      sourceSample: f.record.sample,
      sourcePhase: f.record.phase,
    })
  })
  const summaryRecords = summariesFor(measuredSorted, scenario)
  const startedAt = Math.min(...segs.map((s) => s.start.startedAt!))
  const finishedAt = Math.max(...segs.map((s) => s.finish.finishedAt!))
  const runStart: RunRecord = {
    v: 1,
    kind: "run",
    event: "start",
    startedAt,
    scenarios: [scenario],
    samples: measuredCount,
    warmup: warmupCount,
    outDir: opts.outDir,
  }
  const runFinish: RunRecord = {
    v: 1,
    kind: "run",
    event: "finish",
    finishedAt,
    elapsedMs: finishedAt - startedAt,
    scenarios: [scenario],
    samples: measuredCount,
    warmup: warmupCount,
    status,
    outDir: opts.outDir,
  }
  const startSeg = segs.reduce((a, b) => (a.start.startedAt! <= b.start.startedAt! ? a : b))
  const finishSeg = segs.reduce((a, b) => (a.finish.finishedAt! >= b.finish.finishedAt! ? a : b))
  const records: unknown[] = [runStart]
  for (const s of mergedSamples) records.push(s.record)
  for (const s of summaryRecords) records.push(s)
  records.push(runFinish)
  const fingerprints = segs.map((s) => ({ path: s.path, fingerprint: fingerprintFromEnv(s.start.env) }))
  return {
    records,
    mergedAt: opts.mergedAt,
    mergeGit: opts.mergeGit,
    requiredSamples: opts.requiredSamples,
    scenario,
    warmupCount,
    measuredCount,
    baselineComplete,
    status,
    warnings,
    drift: driftReport(fingerprints.map((f) => f.fingerprint)),
    fingerprints,
    p95Note: p95Note(measuredCount),
    summaryRecords,
    runStart,
    runFinish,
    sampleMappings,
    startMapping: { segment: startSeg.path, line: startSeg.startLineNo, hash: startSeg.startLine.hash },
    finishMapping: { segment: finishSeg.path, line: finishSeg.finishLineNo, hash: finishSeg.finishLine.hash },
  }
}

/** Best-effort raw log copy result for one segment (missing logs recorded, never fatal). */
export interface LogCopyInfo {
  path: string
  sourceDir: string | null
  present: boolean
  files: string[]
  copied: string[]
  missing: string[]
}

/**
 * Versioned merge manifest (merge-manifest.json). Versionable/trackable
 * evidence: input paths + SHA256, per-segment env fingerprints, environment
 * drift, record mapping, source log references/presence, required/actual
 * counts, baselineComplete, and the descriptive p95 note.
 */
export interface MergeManifest {
  schema: 1
  command: "p0-bench-merge"
  scenario: ScenarioID
  /** Current merge timestamp. */
  mergedAt: number
  /** Freeze-time git state captured before output creation. */
  mergeGit: { gitCommit: string | null; gitHead: string | null; gitDirty: boolean }
  requiredSamples: number
  actual: { warmup: number; measured: number; samples: number }
  baselineComplete: boolean
  status: RunStatus
  inputs: Array<{
    path: string
    sha256: string
    recordCount: number
    samples: number
    warmup: number
    status: RunStatus
    outDir: string | null
    envFingerprint: EnvFingerprint
    logs: LogCopyInfo
  }>
  environmentDrift: Array<{ field: string; values: string[] }>
  recordMapping: {
    run: {
      start: { segment: string; line: number; hash: string }
      finish: { segment: string; line: number; hash: string }
    }
    samples: SampleMapping[]
  }
  p95Note: string
  warnings: string[]
}

/** Assemble the manifest from the merge output, the validated segments, and log copy info. */
export function buildManifest(out: MergeOutput, segs: SegmentData[], logInfo: LogCopyInfo[]): MergeManifest {
  const byPath = new Map(logInfo.map((l) => [l.path, l]))
  const inputs = segs.map((s) => ({
    path: s.path,
    sha256: s.sha256,
    recordCount: s.recordCount,
    samples: s.samples,
    warmup: s.warmup,
    status: s.status,
    outDir: s.outDir,
    envFingerprint: fingerprintFromEnv(s.start.env),
    logs: byPath.get(s.path) ?? { path: s.path, sourceDir: null, present: false, files: [], copied: [], missing: [] },
  }))
  return {
    schema: 1,
    command: "p0-bench-merge",
    scenario: out.scenario,
    mergedAt: out.mergedAt,
    mergeGit: out.mergeGit,
    requiredSamples: out.requiredSamples,
    actual: { warmup: out.warmupCount, measured: out.measuredCount, samples: out.warmupCount + out.measuredCount },
    baselineComplete: out.baselineComplete,
    status: out.status,
    inputs,
    environmentDrift: out.drift,
    recordMapping: {
      run: { start: out.startMapping, finish: out.finishMapping },
      samples: out.sampleMappings,
    },
    p95Note: out.p95Note,
    warnings: out.warnings,
  }
}
