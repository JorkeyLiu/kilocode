/**
 * Benchmark runner: warmup/measured sample loop, JSONL output, summary stats,
 * and run-owned cleanup.
 *
 * Sample loop per scenario:
 *   1. snapshot the P0 capture index (per-sample stage isolation),
 *   2. create a fresh git project dir with the `test` provider fixture,
 *   3. run the scenario against the production listener,
 *   4. dispose the sample's instance through the production route and remove
 *      the dir (bounded memory, no residue),
 *   5. emit the `kind: "sample"` JSONL line with raw stages + metrics.
 *
 * After the measured samples, per-metric `kind: "summary"` lines carry
 * n/min/median/p95/max/mean with a truthful per-metric `unit` (ms, bytes,
 * bytes/ms, count). Warmup samples are excluded from summaries and never
 * counted in the run status; a failed warmup sample is still recorded in the
 * JSONL with `ok: false` and reported as `warmupFailures` on the finish line.
 *
 * Provenance: every sample carries `env` (os/arch/node/bun + gitHead/
 * gitCommit/gitDirty + boot description) and both `kind: "run"` envelope
 * records carry the same `env`, so a campaign's exact CLI/backend commit and
 * dirty state is unambiguous even if the artifact is later separated from the
 * checkout that produced it. Git detection is read-only, derived from the
 * repo root, and frozen ONCE at campaign start BEFORE any output artifact is
 * created — the evidence dir is not gitignored, so creating output inside the
 * repo must never flip the recorded dirty state (a clean campaign records
 * gitDirty=false even though the artifact leaves the tree technically dirty
 * afterwards).
 *
 * Stats note: with the default n=5 the nearest-rank p95 index is
 * ceil(0.95*5)-1 = 4, so p95 EQUALS max — a descriptive sample statistic,
 * not a tail-latency SLA. No threshold or service-level claim is derived from
 * these numbers (LOCK-PERF-7 thresholds remain Open).
 *
 * Cleanup: the run-owned root (XDG/DB/tmp + every sample dir) and the
 * listener/LLM are ALWAYS removed — on success, on failed samples, on early
 * seed/boot failure, and on thrown errors (e.g. unknown scenario id). The
 * JSONL artifact (opts.out) is intentionally RETAINED as historical evidence;
 * it is the only thing that survives a run. No SLA or performance claim is
 * ever stated.
 */

import path from "node:path"
import fs from "node:fs"
import { tmpdir } from "../fixture/fixture"
import { markPluginDependenciesReady, markProjectConfigReady } from "../fixture/plugin"
import { testProviderConfig } from "../lib/test-provider"
import type { BackendHandle } from "./backend"
import { bootBackend, disposeInstance } from "./backend"
import { dirs, runRoot } from "./environment"
import type { P0Record } from "./p0-records"
import { byID, type Scenario, type ScenarioCtx, type ScenarioResult } from "./scenarios"
import { resolveRepoRoot } from "./repo-root"
import { summarizeSamples, type SampleSummary } from "./statistics"

export type RunOptions = {
  /** Scenario ids to run (e.g. ["6","12"] or all seven). */
  scenarios: string[]
  /** Measured samples per scenario (>= 1). */
  samples: number
  /** Warmup samples per scenario (>= 0). */
  warmup: number
  /** JSONL output path. */
  out: string
}

export type SampleEnv = {
  os: string
  arch: string
  node: string
  bun: string
  /** Current workspace git HEAD (short). */
  gitHead: string | null
  /** Full 40-char HEAD commit (explicit commit alias; unambiguous provenance). */
  gitCommit: string | null
  /** True when `git status --porcelain` is non-empty (or git is unavailable). */
  gitDirty: boolean
  /** Truthful description of the boot model measured by this harness. */
  boot: string
}

export type SampleLine = {
  v: 1
  kind: "sample"
  scenario: string
  sample: number
  phase: "warmup" | "measured"
  condition: { id: string; note: string }
  startedAt: number
  elapsedMs: number
  env: SampleEnv
  metrics: Record<string, number>
  counts: Record<string, number>
  evidence: Record<string, unknown>
  stages: P0Record[]
  failures: string[]
  blocked: { reason: string; detail: string } | null
  ok: boolean
}

export type SummaryLine = {
  v: 1
  kind: "summary"
  scenario: string
  metric: string
  /** Truthful unit for the metric: ms | bytes | bytes/ms | count. */
  unit: string
  /** Successful measured samples this summary covers (failed measured samples are excluded). */
  n: number
  min: number
  median: number
  p95: number
  max: number
  mean: number
}

export type RunLine = {
  v: 1
  kind: "run"
  event: "start" | "finish"
  startedAt?: number
  finishedAt?: number
  elapsedMs?: number
  scenarios: string[]
  samples: number
  warmup: number
  status?: "ok" | "partial" | "failed"
  /** Failed MEASURED samples (drive the status). */
  failures?: number
  /** Failed warmup samples (recorded, do not affect the status). */
  warmupFailures?: number
  outDir?: string
  /** Campaign provenance (commit/head/dirty + runtime versions), both events. */
  env?: SampleEnv
}

// ---------------------------------------------------------------------------
// Environment + git (read-only; never mutates git)
// ---------------------------------------------------------------------------

const repoRoot = resolveRepoRoot()

function gitOut(dir: string, args: string[]): string | null {
  const proc = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) return null
  return proc.stdout.toString().trim()
}

export type GitState = {
  /** Short HEAD (backward-compatible alias). */
  gitHead: string | null
  /** Full 40-char HEAD commit (explicit commit alias). */
  gitCommit: string | null
  /** True when `git status --porcelain` is non-empty; non-git dirs are dirty. */
  gitDirty: boolean
}

/**
 * Read-only git provenance for a directory. A non-git or failed directory
 * reports null head/commit and dirty=true (unknown state is treated as dirty
 * rather than silently clean).
 */
export function gitState(dir: string): GitState {
  const head = gitOut(dir, ["rev-parse", "--short", "HEAD"])
  const commit = gitOut(dir, ["rev-parse", "HEAD"])
  const dirty = (gitOut(dir, ["status", "--porcelain"]) ?? "dirty").length > 0
  return { gitHead: head, gitCommit: commit, gitDirty: dirty }
}

/**
 * Capture the full sample environment (runtime versions + git provenance) for
 * a directory. Pure and uncached: the CALLER decides when to freeze it. The
 * campaign captures it once, BEFORE creating any output artifact, and reuses
 * the frozen value on every record so a campaign's provenance is unambiguous
 * and self-output never flips the recorded dirty state.
 */
export function envFor(dir: string): SampleEnv {
  const git = gitState(dir)
  return {
    os: process.platform,
    arch: process.arch,
    node: process.versions.node,
    bun: Bun.version,
    gitHead: git.gitHead,
    gitCommit: git.gitCommit,
    gitDirty: git.gitDirty,
    boot:
      "in-process production Server.listen/AppLayer HTTP/SSE path (same as kilo serve); " +
      "process-level stages (listener) emit once per process; serve_cli_entry is CLI-process-tier and not emitted here",
  }
}

/** Sample environment for the resolved repo root (convenience; uncached). */
export function sampleEnv(): SampleEnv {
  return envFor(repoRoot)
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type RunResult = {
  status: "ok" | "partial" | "failed"
  out: string
  samples: number
  failures: number
  warmupFailures: number
}

/** Map measured-sample failure counts onto a run status. */
export function runStatus(failures: number, total: number): "ok" | "partial" | "failed" {
  if (failures === 0) return "ok"
  return failures < total ? "partial" : "failed"
}

/**
 * Run the campaign. Scenario ids are validated BEFORE any resource creation
 * (unknown ids reject without booting the listener) but INSIDE the cleanup
 * scope, so even the validation throw path removes the run root. Then the
 * run-owned global config is seeded, the production backend boots once, each
 * scenario's warmup + measured samples run, the JSONL artifact is written, and
 * — in all paths — the listener/LLM shut down and the run root is removed. The
 * JSONL artifact (opts.out) is intentionally retained as historical evidence.
 */
export async function runCampaign(opts: RunOptions): Promise<RunResult> {
  let backend: BackendHandle | undefined
  const startedAt = Date.now()
  // Freeze provenance BEFORE any artifact is created: the evidence dir is not
  // gitignored, so creating the output file inside the repo must never flip
  // the recorded dirty state. This frozen value is reused on every record.
  const env = envFor(repoRoot)
  const emit = async (line: unknown) => {
    await fs.promises.appendFile(opts.out, JSON.stringify(line) + "\n")
  }

  try {
    // Unknown ids throw here — inside the try, so the finally below always
    // runs (run-owned root is created at environment.ts module load).
    const scenarios = opts.scenarios.map((id) => byID(id))
    await fs.promises.mkdir(path.dirname(opts.out), { recursive: true })
    await seedGlobalConfig()
    const booted = await bootBackend()
    backend = booted
    await Bun.write(opts.out, "")

    await emit({
      v: 1,
      kind: "run",
      event: "start",
      startedAt,
      scenarios: opts.scenarios,
      samples: opts.samples,
      warmup: opts.warmup,
      outDir: path.dirname(opts.out),
      env,
    } satisfies RunLine)

    let failures = 0
    let warmupFailures = 0
    const measured: SampleSummary[] = []

    for (let s = 0; s < scenarios.length; s++) {
      const id = opts.scenarios[s]!
      const scenario = scenarios[s]!
      const phases: Array<{ phase: "warmup" | "measured"; count: number }> = [
        { phase: "warmup", count: opts.warmup },
        { phase: "measured", count: opts.samples },
      ]
      for (const { phase, count } of phases) {
        for (let i = 1; i <= count; i++) {
          const line = await runOneSample(booted, scenario, i, phase, env)
          await emit(line)
          if (line.ok) {
            if (phase === "measured") measured.push({ scenario: id, phase, metrics: line.metrics, counts: line.counts })
          } else if (phase === "measured") {
            failures += 1
            console.error(
              `[p0-bench] ${scenario.id} ${phase} sample ${i} failed: ${line.failures.join("; ")}${line.blocked ? ` blocked: ${line.blocked.reason}` : ""}`,
            )
          } else {
            warmupFailures += 1
            console.error(
              `[p0-bench] ${scenario.id} ${phase} sample ${i} failed: ${line.failures.join("; ")}${line.blocked ? ` blocked: ${line.blocked.reason}` : ""}`,
            )
          }
        }
      }
      // Per-metric summary across the measured samples of this scenario
      // (warmup excluded; truthful units; rounded to 2 decimals).
      for (const summary of summarizeSamples(measured.filter((item) => item.scenario === id))) {
        await emit({ v: 1, kind: "summary", ...summary } satisfies SummaryLine)
      }
    }

    const total = opts.scenarios.length * opts.samples
    const status = runStatus(failures, total)
    await emit({
      v: 1,
      kind: "run",
      event: "finish",
      finishedAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
      scenarios: opts.scenarios,
      samples: opts.samples,
      warmup: opts.warmup,
      status,
      failures,
      warmupFailures,
      outDir: path.dirname(opts.out),
      env,
    } satisfies RunLine)
    return { status, out: opts.out, samples: total, failures, warmupFailures }
  } finally {
    // Run-owned cleanup in ALL paths: the listener/LLM (if booted) and the run
    // root are always removed — on success, on failed samples, on early
    // seed/boot failure, and on thrown errors (unknown scenario id). The JSONL
    // artifact (opts.out) is intentionally retained as historical evidence.
    if (backend) await backend.stop().catch(() => undefined)
    await fs.promises.rm(runRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function runOneSample(
  backend: BackendHandle,
  scenario: Scenario,
  sampleNo: number,
  phase: "warmup" | "measured",
  env: SampleEnv,
): Promise<SampleLine> {
  const recordStart = backend.capture.mark()
  const tmp = await tmpdir({ git: true, config: testProviderConfig(backend.llm.url) })
  await markProjectConfigReady(tmp.path)
  const startedAt = Date.now()
  const ctx: ScenarioCtx = { backend, dir: tmp.path, sampleNo, phase, recordStart }
  let result: ScenarioResult
  try {
    result = await scenario.run(ctx)
  } catch (error) {
    result = {
      ok: false,
      blocked: null,
      metrics: {},
      counts: {},
      evidence: {},
      failures: [error instanceof Error ? error.message : String(error)],
    }
  } finally {
    await disposeInstance(backend.base, tmp.path).catch(() => undefined)
    await tmp[Symbol.asyncDispose]().catch(() => undefined)
  }
  return {
    v: 1,
    kind: "sample",
    scenario: scenario.id,
    sample: sampleNo,
    phase,
    condition: { id: scenario.id, note: scenario.name },
    startedAt,
    elapsedMs: Date.now() - startedAt,
    env,
    metrics: result.metrics,
    counts: result.counts,
    evidence: result.evidence,
    stages: backend.capture.slice(recordStart),
    failures: result.failures,
    blocked: result.blocked,
    ok: result.ok,
  }
}

/** Seed the run-owned global config dir (plugin deps stub + empty config). */
async function seedGlobalConfig(): Promise<void> {
  const globalDir = path.join(dirs.config, "kilo")
  await fs.promises.mkdir(globalDir, { recursive: true })
  await markPluginDependenciesReady(globalDir)
  const configFile = path.join(globalDir, "kilo.jsonc")
  await fs.promises.writeFile(configFile, "{}", "utf8")
}
