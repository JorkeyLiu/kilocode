/**
 * CLI argument parsing + help for the P0 benchmark segment merger.
 *
 * Pure Node module (no side effects, no filesystem I/O) so the CLI
 * (script/p0-bench-merge.ts) and the Bun unit tests share one implementation.
 * `--help` / `-h` are detected BEFORE any read or output creation and exit
 * with the usage text only — a help invocation never launches anything and
 * never creates evidence.
 *
 * `--segments` accepts repeated occurrences AND space-separated values:
 *   --segments a.jsonl b.jsonl
 *   --segments a.jsonl --segments b.jsonl
 *   --segments "a.jsonl b.jsonl"
 * Values are resolved to absolute paths before anything is read.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

export interface MergeArgs {
  /** Resolved absolute segment JSONL paths, input order. */
  segments: string[]
  /** Resolved absolute merged output directory. */
  outDir: string
  /** Required measured sample count for baselineComplete (default 5). */
  requiredSamples: number
}

export const MERGE_USAGE = `P0 benchmark segment merger (strict single-scenario merge v1)

Merges externally resilient one-sample campaign segments into ONE truthful
many-agent-MCP scenario artifact: exactly one warmup + requiredSamples (default
5) measured samples, recomputed summaries, full provenance manifest, and no
fabricated records. Pure merge CLI — no live launch: no VS Code, no benchmark
samples; it only reads existing segment JSONL evidence and writes a new merged
evidence dir. Interrupted runs (no run/finish) are rejected as invalid inputs.

Usage: bun run test:p0-bench:merge -- [flags]

  --segments <paths>        segment benchmark.jsonl paths, repeated and/or
                            space-separated (at least one required)
  --out <dir>               merged output directory (absolute path; default:
                            a run-owned temp dir outside the repo, e.g.
                            $TMPDIR/kilo-p0-bench-merged-XXXXXX; pass --out
                            explicitly to keep results in a chosen location)
  --required-samples <n>    required measured samples for baselineComplete
                            (default 5, >= 1)
  -h, --help                show this help and exit before any read/write

Exit codes:
  0  merged artifact complete (baselineComplete=true)
  2  merged artifact INCOMPLETE but emitted (inputs validated; required
     measured count / warmup count / failed samples not met)
  1  validation error or failure (no artifact emitted)

Durable evidence: the merged benchmark.jsonl and merge-manifest.json are
run-owned output and live outside the repo by default; pass --out explicitly
to persist them elsewhere. Only copied raw logs
under <out>/logs/ are local by nature (the root logs/ pattern). Git
provenance is frozen BEFORE the output artifact is created. Segment inputs are
never written to.

Stats note: merged n=5 default means nearest-rank p95 equals max —
descriptive sample statistics only, not a tail-latency SLA (LOCK-PERF-7
thresholds remain Open).
`

/** True when the argv contains a help request (checked before anything else). */
export function wantsMergeHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h")
}

function isFlag(token: string): boolean {
  return token.startsWith("--")
}

/**
 * Parse merge flags. `repoRoot` is retained for callers that resolve git
 * provenance from the checkout; the default output dir is a run-owned temp
 * dir created here via `mkdtemp` (each parse gets a unique dir). An explicit
 * `--out` is resolved as-is and never created or deleted here; only the
 * default dir is created by this parse and owned by the calling merge run.
 * Throws on invalid values (the CLI exits 1).
 */
export function parseMergeArgs(argv: string[], _repoRoot: string): MergeArgs {
  const rawSegments: string[] = []
  let outDir: string | undefined
  let requiredSamples = 5
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]!
    if (arg === "--segments") {
      // Consume every following non-flag token (space-separated values), and
      // allow repeated --segments occurrences; each token may itself contain
      // space/comma separated paths.
      let j = i + 1
      let picked = 0
      while (j < argv.length && !isFlag(argv[j]!)) {
        for (const part of argv[j]!.split(/[\s,]+/)) {
          if (part.length > 0) {
            rawSegments.push(part)
            picked++
          }
        }
        j++
      }
      if (picked === 0) throw new Error("[p0-bench-merge] --segments requires at least one segment path")
      i = j
      continue
    }
    if (arg === "--out") {
      if (i + 1 >= argv.length || isFlag(argv[i + 1]!)) throw new Error("[p0-bench-merge] --out requires a directory path")
      outDir = argv[i + 1]!
      i += 2
      continue
    }
    if (arg === "--required-samples") {
      if (i + 1 >= argv.length || isFlag(argv[i + 1]!)) throw new Error("[p0-bench-merge] --required-samples requires an integer >= 1")
      requiredSamples = Number(argv[i + 1]!)
      if (!Number.isInteger(requiredSamples) || requiredSamples < 1) {
        throw new Error(`[p0-bench-merge] --required-samples must be an integer >= 1 (got "${argv[i + 1]}")`)
      }
      i += 2
      continue
    }
    throw new Error(`[p0-bench-merge] unknown argument "${arg}"`)
  }
  if (rawSegments.length === 0) throw new Error("[p0-bench-merge] at least one --segments path is required")
  const out = outDir !== undefined ? resolve(outDir) : mkdtempSync(join(tmpdir(), "kilo-p0-bench-merged-"))
  return { segments: rawSegments.map((s) => resolve(s)), outDir: out, requiredSamples }
}
