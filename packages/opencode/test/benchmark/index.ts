/**
 * Backend P0 benchmark CLI.
 *
 * Usage (from packages/opencode):
 *   bun run script/p0-benchmark.ts --scenarios all --samples 5 --warmup 1
 *   bun run script/p0-benchmark.ts --scenarios 6,12,13 --samples 3 --warmup 0 --out /tmp/out.jsonl
 *
 * Flags:
 *   --scenarios <list|all>  scenario ids to run (6,7,8,9,11,12,13 or all)
 *   --samples <n>           measured samples per scenario (default 5, >= 1)
 *   --warmup <n>            warmup samples per scenario (default 1, >= 0)
 *   --out <path>            JSONL output path (default: repo-relative durable
 *                           evidence dir, see below)
 *   -h, --help              show this help and exit before any benchmark runs
 *
 * Durable output convention: when `--out` is omitted the JSONL lands at
 *   <repo>/specs/vscode-orchestrator/evidence/p0-baseline/<ts>/backend.jsonl
 * (repo-relative, one timestamped run dir per campaign — the extension
 * harness writes benchmark.jsonl + logs/ into the same convention). The
 * machine-readable JSONL and run metadata are durable, VERSIONABLE tracker
 * evidence and are NOT gitignored; only bulky per-run raw logs under the
 * run dir's `logs/` may remain local/ignored (the root `logs/` pattern).
 * Git provenance (commit/head/dirty) is captured BEFORE the output artifact
 * is created and reused frozen for the whole campaign, so creating evidence
 * inside the repo never flips the recorded dirty state.
 *
 * Stats note: with the default n=5, nearest-rank p95 equals max — descriptive
 * only, not a tail-latency SLA (LOCK-PERF-7 thresholds remain Open).
 *
 * Environment isolation (run-owned XDG/DB/temp + KILO_P0_PERF) is applied by
 * `./environment`, which MUST be the first module evaluated — it is imported
 * before every other module here.
 */

import "./environment"
import * as Log from "@opencode-ai/core/util/log"
import path from "node:path"
import fs from "node:fs"
import { cleanupRunRoot } from "./environment"
import { runCampaign } from "./runner"
import { resolveRepoRoot } from "./repo-root"
import { SCENARIOS } from "./scenarios"

await Log.init({ print: true })

const ALL = SCENARIOS.map((scenario) => scenario.id)

const repoRoot = resolveRepoRoot()

const help = `Backend P0 benchmark (scenarios ${ALL.join(",")})

Usage: bun run script/p0-benchmark.ts [flags]

  --scenarios <ids|all>  scenario ids to run, comma-separated or "all"
  --samples <n>          measured samples per scenario (default 5, >= 1)
  --warmup <n>           warmup samples per scenario (default 1, >= 0)
  --out <path>           JSONL output path (default: repo-relative durable
                         evidence dir:
                         specs/vscode-orchestrator/evidence/p0-baseline/<ts>/backend.jsonl)
  -h, --help             show this help and exit before any benchmark runs

Durable evidence: the JSONL is versionable tracker evidence and is NOT
gitignored; only bulky raw logs under the run dir's logs/ may remain
local/ignored (the root logs/ pattern). Git provenance is captured before
the output artifact is created and frozen for the campaign.

Stats note: n=5 default means nearest-rank p95 equals max — descriptive
sample statistics only, not a tail-latency SLA.
`

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

function main(): void {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    console.log(help)
    // environment.ts created the run-owned root at import; remove it before
    // exiting (validation-only invocation, no runCampaign cleanup runs).
    cleanupRunRoot()
    return
  }
  const rawScenarios = flagValue(args, "scenarios") ?? "all"
  const rawSamples = flagValue(args, "samples") ?? "5"
  const rawWarmup = flagValue(args, "warmup") ?? "1"
  const rawOut = flagValue(args, "out")

  const scenarios = rawScenarios === "all" ? ALL : rawScenarios.split(",").map((id) => id.trim())
  for (const id of scenarios) {
    if (!ALL.includes(id)) {
      console.error(`unknown scenario "${id}" (valid: ${ALL.join(",")})`)
      process.exitCode = 2
      cleanupRunRoot()
      return
    }
  }
  const samples = Number(rawSamples)
  const warmup = Number(rawWarmup)
  if (!Number.isInteger(samples) || samples < 1) {
    console.error(`--samples must be an integer >= 1 (got "${rawSamples}")`)
    process.exitCode = 2
    cleanupRunRoot()
    return
  }
  if (!Number.isInteger(warmup) || warmup < 0) {
    console.error(`--warmup must be an integer >= 0 (got "${rawWarmup}")`)
    process.exitCode = 2
    cleanupRunRoot()
    return
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const out =
    rawOut ??
    path.join(
      repoRoot,
      "specs",
      "vscode-orchestrator",
      "evidence",
      "p0-baseline",
      ts,
      "backend.jsonl",
    )
  fs.mkdirSync(path.dirname(out), { recursive: true })

  console.log(`[p0-bench] scenarios=${scenarios.join(",")} samples=${samples} warmup=${warmup} out=${out}`)
  runCampaign({ scenarios, samples, warmup, out })
    .then((result) => {
      console.log(
        `[p0-bench] status=${result.status} samples=${result.samples} failures=${result.failures} warmupFailures=${result.warmupFailures}`,
      )
      console.log(`[p0-bench] output: ${result.out}`)
      // runCampaign's finally already ran cleanup (listener/LLM/run-root);
      // exit explicitly so in-process runtime handles never hold the loop.
      process.exit(result.status === "ok" ? 0 : 1)
    })
    .catch((error: unknown) => {
      console.error(`[p0-bench] run failed: ${error instanceof Error ? error.message : String(error)}`)
      // runCampaign's finally already removed the run root even on thrown
      // errors (unknown scenario, seed/boot failure).
      process.exit(1)
    })
}

main()
