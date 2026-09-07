/**
 * CLI argument parsing + help for the P0 extension benchmark harness.
 *
 * Pure Node module (no Bun, no kilo/extension imports, no side effects) so
 * the harness (script/e2e-p0-bench.ts) and the Bun unit tests share one
 * implementation. `--help` / `-h` are detected BEFORE any build or VS Code
 * launch and exit with the usage text only.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ScenarioID } from "./types"
import { SCENARIO_NUMBERS, SCENARIOS } from "./types"

export interface BenchArgs {
  scenarios: ScenarioID[]
  samples: number
  warmup: number
  outDir: string
  switchSessions: number
  mcpAgents: number
}

export const USAGE = `P0 VS Code extension benchmark (scenarios 1,2,3,4,5,10)

Usage: bun run test:p0-bench -- [flags]

  --scenarios <ids|names>  scenario ids/names to run, comma-separated
                           (default 1,2,3,4,5,10)
  --samples <n>            measured samples per scenario (default 5, >= 1)
  --warmup <n>             warmup samples per scenario (default 1, >= 0)
  --switch-sessions <n>    seeded sessions for session-switch (default 5)
  --mcp-agents <n>         seeded agents for many-agent-mcp (default 20)
  --out <dir>              JSONL output directory (default: a run-owned temp
                            dir outside the repo, e.g.
                            $TMPDIR/kilo-p0-bench-XXXXXX; pass --out explicitly
                            to keep results in a chosen location)
  --no-build               skip the extension/webview esbuild
  -h, --help               show this help and exit before any build/launch

Run output: the machine-readable JSONL (benchmark.jsonl) plus run metadata
under the output dir are run-owned and live outside the repo by default.
Pass --out explicitly to persist results elsewhere. Only bulky per-run raw
capture logs under <out>/logs/ are local by nature (the root logs/ pattern).
Git provenance is captured before the output artifact is created and frozen
for the campaign.

Stats note: n=5 default means nearest-rank p95 equals max — descriptive
sample statistics only, not a tail-latency SLA.
`

/** True when the argv contains a help request (checked before anything else). */
export function wantsHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h")
}

function parseScenarios(value: string): ScenarioID[] {
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (parts.length === 0) throw new Error(`[p0-bench] --scenarios requires at least one value`)
  const out: ScenarioID[] = []
  for (const part of parts) {
    const byNumber = SCENARIO_NUMBERS[part]
    const id = byNumber ?? (SCENARIOS as readonly string[]).find((s) => s === part)
    if (!id) {
      throw new Error(
        `[p0-bench] unknown scenario "${part}". Supported: ${Object.entries(SCENARIO_NUMBERS)
          .map(([n, name]) => `${n}=${name}`)
          .join(", ")} (default: 1,2,3,4,5,10).`,
      )
    }
    if (!out.includes(id as ScenarioID)) out.push(id as ScenarioID)
  }
  return out
}

/**
 * Parse benchmark flags. `repoRoot` is retained for callers that resolve git
 * provenance from the checkout; the default output dir is a run-owned temp
 * dir created here via `mkdtemp` (each parse gets a unique dir). An explicit
 * `--out` is used as-is and never created or deleted here; only the default
 * dir is created by this parse and owned by the calling campaign run.
 * `KILO_P0_*` env vars are fallbacks for every numeric/selection flag. Throws
 * on invalid values (the harness exits 1).
 */
export function parseArgs(argv: string[], _repoRoot: string): BenchArgs {
  const get = (name: string): string | undefined => {
    const idx = argv.indexOf(name)
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined
  }
  const scenariosValue = get("--scenarios") ?? process.env.KILO_P0_SCENARIOS ?? "1,2,3,4,5,10"
  const rawSamples = get("--samples") ?? process.env.KILO_P0_SAMPLES ?? "5"
  const rawWarmup = get("--warmup") ?? process.env.KILO_P0_WARMUP ?? "1"
  const samples = Number(rawSamples)
  const warmup = Number(rawWarmup)
  const rawOut = get("--out")
  const outDir = rawOut ?? mkdtempSync(join(tmpdir(), "kilo-p0-bench-"))
  const switchSessions = Number(get("--switch-sessions") ?? process.env.KILO_P0_SWITCH_SESSIONS ?? "5")
  const mcpAgents = Number(get("--mcp-agents") ?? process.env.KILO_P0_MCP_AGENTS ?? "20")
  if (!Number.isInteger(samples) || samples < 1) throw new Error(`[p0-bench] --samples must be an integer >= 1 (got "${rawSamples}")`)
  if (!Number.isInteger(warmup) || warmup < 0) throw new Error(`[p0-bench] --warmup must be an integer >= 0 (got "${rawWarmup}")`)
  return { scenarios: parseScenarios(scenariosValue), samples, warmup, outDir, switchSessions, mcpAgents }
}
