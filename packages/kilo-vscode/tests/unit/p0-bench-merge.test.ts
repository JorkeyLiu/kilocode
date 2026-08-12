import { describe, expect, it } from "bun:test"
import type { RunEnv, RunRecord, SampleEnv, SampleRecord, ScenarioID, SummaryRecord } from "../../script/p0-bench/types"
import { phaseForSample } from "../../script/p0-bench/phase"
import { summarize } from "../../script/p0-bench/stats"
import {
  MergeError,
  buildManifest,
  fingerprintFromEnv,
  mergeSegments,
  parseLines,
  p95Note,
  sha256hex,
  validateSegment,
  type MergeLine,
  type MergeOptions,
  type MergeOutput,
  type RunStatus,
  type SegmentData,
} from "../../script/p0-bench/merge"

const SCENARIO: ScenarioID = "many-agent-mcp"

const BASE_ENV: SampleEnv = {
  os: "darwin",
  arch: "arm64",
  node: "v22.0.0",
  vscode: "1.132.0",
  extension: "7.4.11",
  gitHead: "abc1234",
  gitCommit: "abc1234".padEnd(40, "0"),
  gitDirty: false,
  backendCli: "/ws/packages/kilo-vscode/bin/kilo",
}

function runEnv(over: Partial<RunEnv> = {}): RunEnv {
  return {
    os: "darwin",
    arch: "arm64",
    node: "v22.0.0",
    extension: "7.4.11",
    gitHead: "abc1234",
    gitCommit: "abc1234".padEnd(40, "0"),
    gitDirty: false,
    backendCli: "/ws/packages/kilo-vscode/bin/kilo",
    ...over,
  }
}

function mkStart(
  scenario: ScenarioID,
  samples: number,
  warmup: number,
  startedAt: number,
  opts: { outDir?: string; env?: RunEnv } = {},
): RunRecord {
  const rec: RunRecord = { v: 1, kind: "run", event: "start", startedAt, scenarios: [scenario], samples, warmup }
  if (opts.outDir !== undefined) rec.outDir = opts.outDir
  if (opts.env !== undefined) rec.env = opts.env
  return rec
}

function mkFinish(
  scenario: ScenarioID,
  samples: number,
  warmup: number,
  finishedAt: number,
  status: RunStatus,
): RunRecord {
  return {
    v: 1,
    kind: "run",
    event: "finish",
    finishedAt,
    elapsedMs: finishedAt - 1000,
    scenarios: [scenario],
    samples,
    warmup,
    status,
  }
}

function mkSample(
  scenario: ScenarioID,
  sample: number,
  phase: "warmup" | "measured",
  startedAt: number,
  opts: { ok?: boolean; blocked?: boolean; key?: Record<string, number>; note?: string } = {},
): SampleRecord {
  const ok = opts.ok ?? true
  const blocked = opts.blocked ?? false
  return {
    v: 1,
    kind: "sample",
    scenario,
    condition: {
      id: scenario,
      configSeeded: scenario === SCENARIO,
      agents: scenario === SCENARIO ? 20 : 0,
      providers: 0,
      mcp: scenario === SCENARIO ? "p0-bench-mcp" : null,
      note: opts.note ?? "fixture",
    },
    sample,
    cycle: 0,
    phase,
    lifecycle: 1,
    startedAt,
    elapsedMs: 500,
    env: BASE_ENV,
    provenance: {
      cliPath: null,
      cliPathInWorkspace: false,
      cliExists: false,
      cliSha256: null,
      cliVersionHash: null,
      spawnedPid: null,
      spawnedArgsMatch: false,
      spawnedStart: null,
    },
    key: opts.key ?? (scenario === SCENARIO ? { mcpConnectMs: 100 + sample } : { activateMs: 100 + sample }),
    stages: [{ surface: "extension", stage: "activate.start", t: startedAt }],
    failures: ok ? [] : ["fixture failure"],
    blocked: ok ? null : blocked ? { reason: "fixture-failure", detail: "blocked fixture sample" } : null,
    ok,
  }
}

/** Serialize records into MergeLines the way parseLines produces them. */
function lines(records: unknown[], path: string): MergeLine[] {
  return parseLines(records.map((r) => JSON.stringify(r)).join("\n") + "\n", path)
}

function expectedStatus(oks: boolean[], blocked: boolean[], warmup: number): RunStatus {
  const anyOkMeasured = oks.slice(warmup).some((ok) => ok)
  const anyBlocked = blocked.some((b) => b)
  if (!anyOkMeasured) return "failed"
  return anyBlocked ? "partial" : "ok"
}

/**
 * Build a complete, internally-consistent segment's records: run/start →
 * samples (numbers sequential, phase via phaseForSample) → optional summaries
 * → run/finish with the truthful campaignStatus (unless overridden).
 */
function mkSegmentRecords(opts: {
  path: string
  samples: number
  warmup: number
  scenario?: ScenarioID
  startedAt?: number
  finishedAt?: number
  status?: RunStatus
  outDir?: string
  env?: RunEnv
  sampleStarts?: number[]
  ok?: boolean[]
  blocked?: boolean[]
  sampleOverrides?: Record<number, Partial<SampleRecord>>
  summaries?: number
}): unknown[] {
  const scenario = opts.scenario ?? SCENARIO
  const n = opts.samples + opts.warmup
  const starts = opts.sampleStarts ?? Array.from({ length: n }, (_, i) => 1000 + i * 100)
  const oks = opts.ok ?? Array.from({ length: n }, () => true)
  const blocked = opts.blocked ?? Array.from({ length: n }, () => false)
  if (starts.length !== n) throw new Error(`fixture bug: ${starts.length} sampleStarts for ${n} samples`)
  const records: unknown[] = [
    mkStart(scenario, opts.samples, opts.warmup, opts.startedAt ?? 1000, { outDir: opts.outDir, env: opts.env }),
  ]
  for (let i = 0; i < n; i++) {
    const sampleNo = i + 1
    const phase = phaseForSample(sampleNo, opts.warmup)
    const rec = mkSample(scenario, sampleNo, phase, starts[i]!, { ok: oks[i], blocked: blocked[i] })
    records.push({ ...rec, ...(opts.sampleOverrides?.[sampleNo] ?? {}) })
  }
  for (let i = 0; i < (opts.summaries ?? 0); i++) {
    records.push({
      v: 1,
      kind: "summary",
      scenario,
      metric: "mcpConnectMs",
      unit: "ms",
      n: 1,
      min: 100,
      median: 100,
      p95: 100,
      max: 100,
      mean: 100,
    })
  }
  records.push(mkFinish(scenario, opts.samples, opts.warmup, opts.finishedAt ?? 1000 + n * 100, opts.status ?? expectedStatus(oks, blocked, opts.warmup)))
  return records
}

function seg(opts: Parameters<typeof mkSegmentRecords>[0]): SegmentData {
  const records = mkSegmentRecords(opts)
  return validateSegment(opts.path, sha256hex(JSON.stringify(records)), lines(records, opts.path))
}

function merge(segs: SegmentData[], opts: Partial<MergeOptions> = {}): MergeOutput {
  return mergeSegments(segs, {
    requiredSamples: 5,
    mergedAt: 1234567890,
    mergeGit: { gitCommit: "c".repeat(40), gitHead: "cccccccc", gitDirty: false },
    outDir: "/merged/out",
    ...opts,
  })
}

function expectMergeError(fn: () => unknown, code: string, messagePart?: string): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(MergeError)
    const me = err as MergeError
    expect(me.code).toBe(code)
    if (messagePart) expect(me.message).toContain(messagePart)
    return
  }
  throw new Error(`expected MergeError(${code}) but no error was thrown`)
}

/** Five-segment valid campaign: warmup-bearing + 4 measured, distinct run spans. */
function validCampaign(): SegmentData[] {
  const runTimes = [
    { startedAt: 1000, finishedAt: 1300 }, // seg1 warmup-bearing (2 samples)
    { startedAt: 1100, finishedAt: 1500 }, // seg2
    { startedAt: 1050, finishedAt: 1450 }, // seg3
    { startedAt: 1200, finishedAt: 1600 }, // seg4
    { startedAt: 1150, finishedAt: 1550 }, // seg5
  ]
  return runTimes.map((t, i) =>
    seg({
      path: `/ev/seg${i + 1}.jsonl`,
      samples: 1,
      warmup: i === 0 ? 1 : 0,
      outDir: `/ev/seg${i + 1}`,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      sampleStarts: i === 0 ? [t.startedAt + 50, t.startedAt + 100] : [t.startedAt + 100],
    }),
  )
}

describe("p0 segment merger: input validation", () => {
  it("accepts a valid warmup-bearing segment (samples=1, warmup=1) and a measured-only segment (samples=1, warmup=0)", () => {
    const warmupSeg = seg({ path: "/ev/a.jsonl", samples: 1, warmup: 1, outDir: "/ev/a" })
    expect(warmupSeg.samplesParsed).toHaveLength(2)
    expect(warmupSeg.samplesParsed[0]!.record.phase).toBe("warmup")
    expect(warmupSeg.samplesParsed[1]!.record.phase).toBe("measured")
    expect(warmupSeg.status).toBe("ok")
    const measuredSeg = seg({ path: "/ev/b.jsonl", samples: 1, warmup: 0, outDir: "/ev/b" })
    expect(measuredSeg.samplesParsed).toHaveLength(1)
    expect(measuredSeg.samplesParsed[0]!.record.phase).toBe("measured")
    expect(measuredSeg.recordCount).toBe(3)
  })

  it("rejects empty and whitespace-only files", () => {
    expectMergeError(() => parseLines("", "/ev/empty.jsonl"), "empty", "no records")
    expectMergeError(() => parseLines("\n", "/ev/empty.jsonl"), "empty", "no records")
  })

  it("rejects the exact interrupted shape: run/start + samples, no run/finish", () => {
    const interrupted = mkSegmentRecords({ path: "/ev/i.jsonl", samples: 1, warmup: 1, sampleStarts: [100, 200] }).slice(0, 3)
    expectMergeError(() => validateSegment("/ev/i.jsonl", "sha", lines(interrupted, "/ev/i.jsonl")), "interrupted", "no run/finish")
    // A summary as the trailing record is still interrupted (finish missing).
    const trailingSummary = [
      ...mkSegmentRecords({ path: "/ev/i.jsonl", samples: 1, warmup: 0, sampleStarts: [100] }).slice(0, 2),
      { v: 1, kind: "summary", scenario: SCENARIO, metric: "mcpConnectMs", unit: "ms", n: 1, min: 1, median: 1, p95: 1, max: 1, mean: 1 },
    ]
    expectMergeError(() => validateSegment("/ev/i.jsonl", "sha", lines(trailingSummary, "/ev/i.jsonl")), "interrupted")
  })

  it("rejects corrupt JSON, non-object records, and truncated records", () => {
    expectMergeError(() => parseLines('{"v":1}\nnot-json\n', "/ev/c.jsonl"), "corrupt", "invalid JSON")
    expectMergeError(() => parseLines("[1,2,3]\n", "/ev/c.jsonl"), "corrupt", "not a JSON object")
    expectMergeError(() => parseLines('"string"\n', "/ev/c.jsonl"), "corrupt", "not a JSON object")
    expectMergeError(() => parseLines('{"v":1,"kind":"sample","sample":1', "/ev/c.jsonl"), "corrupt", "invalid JSON")
  })

  it("rejects unsupported record version", () => {
    const recs = mkSegmentRecords({ path: "/ev/v.jsonl", samples: 1, warmup: 0 })
    ;(recs[1] as Record<string, unknown>).v = 2
    expectMergeError(() => validateSegment("/ev/v.jsonl", "sha", lines(recs, "/ev/v.jsonl")), "version", "schema v1")
  })

  it("rejects unknown record kinds and extra run records", () => {
    const recs = mkSegmentRecords({ path: "/ev/k.jsonl", samples: 1, warmup: 0 })
    recs.splice(2, 0, { v: 1, kind: "banana", n: 1 })
    expectMergeError(() => validateSegment("/ev/k.jsonl", "sha", lines(recs, "/ev/k.jsonl")), "kind", "unknown record kind")
    const twoRuns = mkSegmentRecords({ path: "/ev/k.jsonl", samples: 1, warmup: 0 })
    twoRuns.splice(2, 0, { v: 1, kind: "run", event: "start", startedAt: 1, scenarios: [SCENARIO], samples: 1, warmup: 0 })
    expectMergeError(() => validateSegment("/ev/k.jsonl", "sha", lines(twoRuns, "/ev/k.jsonl")), "run-records")
  })

  it("rejects a first record that is not run/start", () => {
    const recs = mkSegmentRecords({ path: "/ev/f.jsonl", samples: 1, warmup: 0 })
    recs[0] = { v: 1, kind: "sample", scenario: SCENARIO }
    expectMergeError(() => validateSegment("/ev/f.jsonl", "sha", lines(recs, "/ev/f.jsonl")), "kind", "must be run/start")
  })

  it("rejects finish status missing, invalid, or not matching the samples", () => {
    const missing = mkSegmentRecords({ path: "/ev/s.jsonl", samples: 1, warmup: 0 })
    delete (missing[missing.length - 1] as Record<string, unknown>).status
    expectMergeError(() => validateSegment("/ev/s.jsonl", "sha", lines(missing, "/ev/s.jsonl")), "status")
    const allBlocked = mkSegmentRecords({ path: "/ev/s.jsonl", samples: 1, warmup: 0, ok: [false], blocked: [true], status: "ok" })
    expectMergeError(() => validateSegment("/ev/s.jsonl", "sha", lines(allBlocked, "/ev/s.jsonl")), "status", "does not match its samples")
  })

  it("rejects multi-scenario run/start and per-sample scenario mismatch", () => {
    const multi = mkSegmentRecords({ path: "/ev/m.jsonl", samples: 1, warmup: 0 })
    ;(multi[0] as Record<string, unknown>).scenarios = ["many-agent-mcp", "cold-start"]
    expectMergeError(() => validateSegment("/ev/m.jsonl", "sha", lines(multi, "/ev/m.jsonl")), "scenario", "exactly one known scenario")
    const mismatch = mkSegmentRecords({ path: "/ev/m.jsonl", samples: 1, warmup: 0, sampleOverrides: { 1: { scenario: "cold-start" as ScenarioID } } })
    expectMergeError(() => validateSegment("/ev/m.jsonl", "sha", lines(mismatch, "/ev/m.jsonl")), "scenario", "does not match run scenario")
  })

  it("rejects sample count inconsistent with start.samples+start.warmup", () => {
    const recs = mkSegmentRecords({ path: "/ev/c.jsonl", samples: 1, warmup: 0 })
    recs.splice(2, 0, mkSample(SCENARIO, 2, "measured", 999))
    expectMergeError(() => validateSegment("/ev/c.jsonl", "sha", lines(recs, "/ev/c.jsonl")), "count", "does not match")
  })

  it("rejects phase inconsistent with phaseForSample and non-sequential sample numbers", () => {
    const recs = mkSegmentRecords({ path: "/ev/p.jsonl", samples: 1, warmup: 1 })
    ;(recs[1] as Record<string, unknown>).phase = "measured" // sample 1 should be warmup
    expectMergeError(() => validateSegment("/ev/p.jsonl", "sha", lines(recs, "/ev/p.jsonl")), "phase", "phaseForSample")
    const nonSeq = mkSegmentRecords({ path: "/ev/p.jsonl", samples: 1, warmup: 0 })
    ;(nonSeq[1] as Record<string, unknown>).sample = 7
    expectMergeError(() => validateSegment("/ev/p.jsonl", "sha", lines(nonSeq, "/ev/p.jsonl")), "sample-number", "sequential")
  })

  it("rejects a successful sample carrying blocked/failures and a failed sample without evidence", () => {
    const blockedOk = mkSegmentRecords({
      path: "/ev/io.jsonl",
      samples: 1,
      warmup: 0,
      sampleOverrides: { 1: { blocked: { reason: "x", detail: "y" } } },
    })
    expectMergeError(() => validateSegment("/ev/io.jsonl", "sha", lines(blockedOk, "/ev/io.jsonl")), "sample-integrity", "ok:true")
    const failedNoEvidence = mkSegmentRecords({
      path: "/ev/io.jsonl",
      samples: 1,
      warmup: 0,
      sampleOverrides: { 1: { ok: false, failures: [], blocked: null } },
    })
    expectMergeError(() => validateSegment("/ev/io.jsonl", "sha", lines(failedNoEvidence, "/ev/io.jsonl")), "sample-integrity", "no failure evidence")
  })
})

describe("p0 segment merger: merging", () => {
  it("merges 1 warmup-bearing + 4 measured segments into exactly 1 warmup + 5 measured, baselineComplete true", () => {
    const out = merge(validCampaign())
    expect(out.warmupCount).toBe(1)
    expect(out.measuredCount).toBe(5)
    expect(out.baselineComplete).toBe(true)
    expect(out.status).toBe("ok")
    const kinds = out.records.map((r) => (r as { kind: string }).kind)
    expect(kinds[0]).toBe("run")
    expect((out.records[0] as RunRecord).event).toBe("start")
    expect(kinds[kinds.length - 1]).toBe("run")
    expect((out.records[kinds.length - 1] as RunRecord).event).toBe("finish")
    const samples = out.records.filter((r) => (r as { kind: string }).kind === "sample")
    expect(samples).toHaveLength(6)
    expect(samples[0]).toMatchObject({ sample: 1, phase: "warmup" })
    for (let i = 1; i <= 5; i++) expect(samples[i]).toMatchObject({ sample: i, phase: "measured" })
    expect(out.records.filter((r) => (r as { kind: string }).kind === "summary").length).toBeGreaterThan(0)
  })

  it("renumbers measured samples deterministically by startedAt (ties by input order)", () => {
    const campaign = [
      seg({ path: "/ev/s1.jsonl", samples: 1, warmup: 1, outDir: "/ev/s1", sampleStarts: [100, 200] }),
      seg({ path: "/ev/s2.jsonl", samples: 1, warmup: 0, outDir: "/ev/s2", sampleStarts: [500] }),
      seg({ path: "/ev/s3.jsonl", samples: 1, warmup: 0, outDir: "/ev/s3", sampleStarts: [300] }),
      seg({ path: "/ev/s4.jsonl", samples: 1, warmup: 0, outDir: "/ev/s4", sampleStarts: [400] }),
      seg({ path: "/ev/s5.jsonl", samples: 1, warmup: 0, outDir: "/ev/s5", sampleStarts: [400], sampleOverrides: { 1: { key: { mcpConnectMs: 555 } } } }), // startedAt tie with s4 → input order
    ]
    const out = merge(campaign)
    const measured = out.records.filter(
      (r) => (r as { kind: string }).kind === "sample" && (r as { phase: string }).phase === "measured",
    )
    expect(measured.map((m) => (m as { startedAt: number }).startedAt)).toEqual([200, 300, 400, 400, 500])
    expect(measured.map((m) => (m as { sample: number }).sample)).toEqual([1, 2, 3, 4, 5])
    // Tie between s4 (input index 3) and s5 (input index 4): s4 wins the lower number.
    expect(out.sampleMappings.find((m) => m.mergedSample === 3)?.segment).toBe("/ev/s4.jsonl")
    expect(out.sampleMappings.find((m) => m.mergedSample === 4)?.segment).toBe("/ev/s5.jsonl")
  })

  it("preserves every non-sample/phase field of a sample deeply unchanged", () => {
    const source = mkSample(SCENARIO, 2, "measured", 700, {
      key: { mcpConnectMs: 420, activateMs: 999 },
      note: "deep-preservation marker",
    })
    const segmentRecs = [
      mkStart(SCENARIO, 1, 1, 1000, { outDir: "/ev/x" }),
      mkSample(SCENARIO, 1, "warmup", 100),
      source,
      mkFinish(SCENARIO, 1, 1, 2000, "ok"),
    ]
    const data = validateSegment("/ev/x.jsonl", "sha", lines(segmentRecs, "/ev/x.jsonl"))
    const out = merge([data])
    const merged = out.records.find(
      (r) =>
        (r as { kind: string }).kind === "sample" && (r as { sample: number }).sample === 1 && (r as { phase: string }).phase === "measured",
    )!
    const mergedPlain = JSON.parse(JSON.stringify(merged)) as SampleRecord
    const sourcePlain = JSON.parse(JSON.stringify(source)) as SampleRecord
    mergedPlain.sample = sourcePlain.sample
    mergedPlain.phase = sourcePlain.phase
    expect(mergedPlain).toEqual(sourcePlain)
    expect(mergedPlain.condition.note).toBe("deep-preservation marker")
    expect(mergedPlain.key).toEqual({ mcpConnectMs: 420, activateMs: 999 })
    expect(mergedPlain.stages).toEqual(sourcePlain.stages)
  })

  it("recomputes summaries with the existing summarize() over merged measured+ok numeric keys and drops segment summaries", () => {
    const segmentRecs = [
      mkStart(SCENARIO, 1, 1, 1000, { outDir: "/ev/x" }),
      mkSample(SCENARIO, 1, "warmup", 100, { key: { mcpConnectMs: 1 } }),
      mkSample(SCENARIO, 2, "measured", 200, { key: { mcpConnectMs: 10, activateMs: 100 } }),
      { v: 1, kind: "summary", scenario: SCENARIO, metric: "mcpConnectMs", unit: "ms", n: 5, min: 0, median: 0, p95: 0, max: 0, mean: 0 },
      mkFinish(SCENARIO, 1, 1, 2000, "ok"),
    ]
    const data = validateSegment("/ev/x.jsonl", "sha", lines(segmentRecs, "/ev/x.jsonl"))
    const out = merge([
      data,
      seg({ path: "/ev/y.jsonl", samples: 1, warmup: 0, sampleStarts: [300], sampleOverrides: { 1: { key: { mcpConnectMs: 30, activateMs: 200 } } } }),
      seg({ path: "/ev/z.jsonl", samples: 1, warmup: 0, sampleStarts: [400], sampleOverrides: { 1: { key: { mcpConnectMs: 20 } } } }),
      seg({ path: "/ev/w.jsonl", samples: 1, warmup: 0, sampleStarts: [500], sampleOverrides: { 1: { key: { mcpConnectMs: 40 } } } }),
      seg({ path: "/ev/u.jsonl", samples: 1, warmup: 0, sampleStarts: [600], sampleOverrides: { 1: { key: { mcpConnectMs: 50 } } } }),
    ])
    const byMetric = new Map<string, SummaryRecord>()
    for (const s of out.summaryRecords) byMetric.set(s.metric, s)
    // Segment summary records were dropped; only recomputed summaries exist.
    expect(byMetric.get("mcpConnectMs")).toBeDefined()
    expect(byMetric.get("activateMs")).toBeDefined()
    const mcp = byMetric.get("mcpConnectMs")!
    expect(mcp).toEqual({ v: 1, kind: "summary", scenario: SCENARIO, metric: "mcpConnectMs", unit: "ms", ...summarize([10, 30, 20, 40, 50]) })
    const act = byMetric.get("activateMs")!
    expect(act).toEqual({ v: 1, kind: "summary", scenario: SCENARIO, metric: "activateMs", unit: "ms", ...summarize([100, 200]) })
    // Warmup key values never enter summaries.
    expect(out.summaryRecords.filter((s) => s.n !== 5 && s.n !== 2)).toHaveLength(0)
  })

  it("emits a valid-but-incomplete artifact (1+3) with baselineComplete false and status ok", () => {
    const out = merge(validCampaign().slice(0, 3)) // warmup-bearing + 2 measured-only → 1 warmup + 3 measured
    expect(out.baselineComplete).toBe(false)
    expect(out.status).toBe("ok")
    expect(out.measuredCount).toBe(3)
    expect(out.warmupCount).toBe(1)
    expect(out.warnings.join(" ")).toContain("3 != required 5")
    const samples = out.records.filter((r) => (r as { kind: string }).kind === "sample")
    expect(samples).toHaveLength(4)
  })

  it("marks baselineComplete false when warmup count != 1", () => {
    const twoWarmups = [
      seg({ path: "/ev/a.jsonl", samples: 1, warmup: 1, sampleStarts: [100, 200] }),
      seg({ path: "/ev/b.jsonl", samples: 1, warmup: 1, sampleStarts: [110, 210] }),
      seg({ path: "/ev/c.jsonl", samples: 1, warmup: 0, sampleStarts: [300] }),
      seg({ path: "/ev/d.jsonl", samples: 1, warmup: 0, sampleStarts: [400] }),
      seg({ path: "/ev/e.jsonl", samples: 1, warmup: 0, sampleStarts: [500] }),
    ]
    const out = merge(twoWarmups)
    expect(out.warmupCount).toBe(2)
    expect(out.measuredCount).toBe(5)
    expect(out.baselineComplete).toBe(false)
    expect(out.warnings.join(" ")).toContain("warmup records 2")
  })

  it("rejects duplicate segment paths and duplicate file hashes", () => {
    const dupPath = validCampaign()
    dupPath.push({ ...validCampaign()[0]! })
    expectMergeError(() => merge(dupPath), "duplicate-path")
    const a = seg({ path: "/ev/a.jsonl", samples: 1, warmup: 0, sampleStarts: [300] })
    const b = seg({ path: "/ev/b.jsonl", samples: 1, warmup: 0, sampleStarts: [300] })
    expectMergeError(() => merge([a, b]), "duplicate-file", "identical content")
  })

  it("rejects duplicate sample records across segments (identical canonical record)", () => {
    // Files differ (different outDir) but the measured sample records are identical.
    const a = seg({ path: "/ev/a.jsonl", samples: 1, warmup: 0, outDir: "/ev/a", sampleStarts: [300] })
    const b = seg({ path: "/ev/b.jsonl", samples: 1, warmup: 0, outDir: "/ev/b", sampleStarts: [300] })
    expectMergeError(() => merge([a, b]), "duplicate-sample", "duplicate sample record")
  })

  it("rejects mixed scenarios across segments", () => {
    const mixed = validCampaign()
    mixed[1] = seg({ path: "/ev/other.jsonl", samples: 1, warmup: 0, scenario: "cold-start", sampleStarts: [300] })
    expectMergeError(() => merge(mixed), "scenario-mismatch", "mix scenarios")
  })

  it("classifies an explicit failed segment as partial/failed and baselineComplete false", () => {
    const partial = [
      seg({ path: "/ev/s1.jsonl", samples: 1, warmup: 1, sampleStarts: [100, 200] }),
      seg({ path: "/ev/s2.jsonl", samples: 1, warmup: 0, sampleStarts: [300], ok: [false], blocked: [true] }),
      seg({ path: "/ev/s3.jsonl", samples: 1, warmup: 0, sampleStarts: [400] }),
      seg({ path: "/ev/s4.jsonl", samples: 1, warmup: 0, sampleStarts: [500] }),
      seg({ path: "/ev/s5.jsonl", samples: 1, warmup: 0, sampleStarts: [600] }),
    ]
    const out = merge(partial)
    expect(out.status).toBe("partial") // ok measured + blocked measured
    expect(out.baselineComplete).toBe(false)
    expect(out.warnings.join(" ")).toContain("failed/blocked")
    // All-blocked: no ok measured sample → failed, never partial.
    const allFailed = [
      seg({ path: "/ev/s1.jsonl", samples: 1, warmup: 1, sampleStarts: [100, 200], ok: [false, false], blocked: [true, true] }),
      seg({ path: "/ev/s2.jsonl", samples: 1, warmup: 0, sampleStarts: [300], ok: [false], blocked: [true] }),
      seg({ path: "/ev/s3.jsonl", samples: 1, warmup: 0, sampleStarts: [400], ok: [false], blocked: [true] }),
      seg({ path: "/ev/s4.jsonl", samples: 1, warmup: 0, sampleStarts: [500], ok: [false], blocked: [true] }),
      seg({ path: "/ev/s5.jsonl", samples: 1, warmup: 0, sampleStarts: [600], ok: [false], blocked: [true] }),
    ]
    const failed = merge(allFailed)
    expect(failed.status).toBe("failed")
    expect(failed.baselineComplete).toBe(false)
  })

  it("emits merged run records with evidence-span timestamps, merged counts, and no fabricated env", () => {
    const out = merge(validCampaign())
    expect(out.runStart.startedAt).toBe(1000) // earliest segment start (seg1)
    expect(out.runFinish.finishedAt).toBe(1600) // latest segment finish (seg4)
    expect(out.runFinish.elapsedMs).toBe(600)
    expect(out.startMapping.segment).toBe("/ev/seg1.jsonl")
    expect(out.finishMapping.segment).toBe("/ev/seg4.jsonl")
    expect(out.runStart.scenarios).toEqual([SCENARIO])
    expect(out.runStart.samples).toBe(5)
    expect(out.runStart.warmup).toBe(1)
    expect(out.runFinish.samples).toBe(5)
    expect(out.runFinish.warmup).toBe(1)
    expect(out.runFinish.status).toBe("ok")
    expect(out.runStart.env).toBeUndefined()
    expect(out.runFinish.env).toBeUndefined()
  })
})

describe("p0 segment merger: manifest", () => {
  it("reports environment drift across segments and fingerprints with CLI snapshot SHA", () => {
    const envA = runEnv({ gitHead: "abc1234", gitCommit: "abc1234".padEnd(40, "0") })
    const envB = runEnv({
      gitHead: "def5678",
      gitCommit: "def5678".padEnd(40, "0"),
      cliSnapshot: {
        sourcePath: "/ws/bin/kilo",
        snapshotPath: "/tmp/snap/kilo",
        sourceSha256: "a".repeat(64),
        snapshotSha256: "a".repeat(64),
        sourceSize: 1,
        snapshotSize: 1,
        createdAt: 1,
      },
    })
    const campaign = [
      seg({ path: "/ev/s1.jsonl", samples: 1, warmup: 1, sampleStarts: [100, 200], env: envA }),
      seg({ path: "/ev/s2.jsonl", samples: 1, warmup: 0, sampleStarts: [300], env: envB }),
      seg({ path: "/ev/s3.jsonl", samples: 1, warmup: 0, sampleStarts: [400], env: envB }),
      seg({ path: "/ev/s4.jsonl", samples: 1, warmup: 0, sampleStarts: [500], env: envB }),
      seg({ path: "/ev/s5.jsonl", samples: 1, warmup: 0, sampleStarts: [600], env: envB }),
    ]
    const out = merge(campaign)
    const fields = new Set(out.drift.map((d) => d.field))
    expect(fields.has("gitHead")).toBe(true)
    expect(fields.has("gitCommit")).toBe(true)
    expect(fields.has("cliSnapshotSha256")).toBe(true)
    const gitHead = out.drift.find((d) => d.field === "gitHead")!
    expect(gitHead.values.sort()).toEqual(["abc1234", "def5678"])
    const manifest = buildManifest(out, campaign, [])
    expect(manifest.environmentDrift).toEqual(out.drift)
    expect(manifest.inputs[0]!.envFingerprint.gitHead).toBe("abc1234")
    expect(manifest.inputs[1]!.envFingerprint.cliSnapshotSha256).toBe("a".repeat(64))
    expect(manifest.inputs[1]!.envFingerprint.envPresent).toBe(true)
  })

  it("reports no drift when all segment fingerprints match", () => {
    const env = runEnv()
    const campaign = validCampaign().map((s) => ({ ...s, start: { ...s.start, env } }))
    const out = merge(campaign)
    expect(out.drift).toEqual([])
  })

  it("treats a segment without run env as envPresent false and reports drift", () => {
    const noEnv = seg({ path: "/ev/n.jsonl", samples: 1, warmup: 0, sampleStarts: [300] })
    const withEnv = seg({ path: "/ev/y.jsonl", samples: 1, warmup: 0, sampleStarts: [400], env: runEnv() })
    const out = merge([noEnv, withEnv])
    expect(out.fingerprints.find((f) => f.path === "/ev/n.jsonl")!.fingerprint.envPresent).toBe(false)
    expect(out.drift.map((d) => d.field)).toContain("envPresent")
  })

  it("carries full record mapping, input hashes, counts, freeze git state, and p95 note", () => {
    const campaign = validCampaign()
    const out = merge(campaign)
    const manifest = buildManifest(out, campaign, [])
    expect(manifest.schema).toBe(1)
    expect(manifest.command).toBe("p0-bench-merge")
    expect(manifest.mergedAt).toBe(1234567890)
    expect(manifest.mergeGit).toEqual({ gitCommit: "c".repeat(40), gitHead: "cccccccc", gitDirty: false })
    expect(manifest.requiredSamples).toBe(5)
    expect(manifest.actual).toEqual({ warmup: 1, measured: 5, samples: 6 })
    expect(manifest.baselineComplete).toBe(true)
    expect(manifest.status).toBe("ok")
    expect(manifest.inputs).toHaveLength(5)
    expect(manifest.inputs[0]).toMatchObject({ samples: 1, warmup: 1, status: "ok", recordCount: 4 })
    for (const input of manifest.inputs.slice(1)) {
      expect(input).toMatchObject({ samples: 1, warmup: 0, recordCount: 3 })
      expect(input.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(input.outDir).not.toBeNull()
    }
    expect(manifest.recordMapping.run.start).toMatchObject({ segment: "/ev/seg1.jsonl", line: 1 })
    expect(manifest.recordMapping.run.finish).toMatchObject({ segment: "/ev/seg4.jsonl", line: 3 })
    expect(manifest.recordMapping.samples).toHaveLength(6)
    expect(manifest.recordMapping.samples[0]!).toMatchObject({
      mergedSample: 1,
      mergedPhase: "warmup",
      segment: "/ev/seg1.jsonl",
      sourceSample: 1,
      sourcePhase: "warmup",
    })
    expect(manifest.recordMapping.samples[1]!).toMatchObject({
      mergedSample: 1,
      mergedPhase: "measured",
      segment: "/ev/seg1.jsonl",
      sourceSample: 2,
      sourcePhase: "measured",
    })
    for (const m of manifest.recordMapping.samples) expect(m.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.p95Note).toContain("p95 equals max")
    expect(manifest.p95Note).toContain("tail-latency SLA")
    expect(manifest.warnings).toEqual([])
  })

  it("records missing logs as not present without failing (manifest only)", () => {
    const campaign = validCampaign()
    const out = merge(campaign)
    const logInfo = campaign.map((s) => ({
      path: s.path,
      sourceDir: s.outDir !== null ? `${s.outDir}/logs` : null,
      present: false,
      files: [],
      copied: [],
      missing: [],
    }))
    const manifest = buildManifest(out, campaign, logInfo)
    for (const input of manifest.inputs) expect(input.logs.present).toBe(false)
    expect(manifest.inputs[0]!.logs.sourceDir).toBe("/ev/seg1/logs")
  })

  it("p95Note is descriptive: equals max at n=5, never an SLA", () => {
    expect(p95Note(5)).toContain("p95 equals max")
    expect(p95Note(5)).toContain("NOT a tail-latency SLA")
    expect(p95Note(5)).toContain("LOCK-PERF-7")
    expect(p95Note(20)).toContain("may differ from max")
  })

  it("fingerprintFromEnv handles a missing env object", () => {
    const fp = fingerprintFromEnv(undefined)
    expect(fp.envPresent).toBe(false)
    expect(fp.gitHead).toBeNull()
    expect(fp.cliSnapshotSha256).toBeNull()
  })
})
