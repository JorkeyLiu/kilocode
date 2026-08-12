/**
 * CLI orchestration for the P0 benchmark segment merger.
 *
 * Thin Node I/O layer over the pure merge module (script/p0-bench/merge.ts):
 * reads/validates segment JSONL, freezes merge-time git state BEFORE output
 * creation, copies raw logs best-effort into the merged ignored logs/ dir,
 * writes benchmark.jsonl + merge-manifest.json, and reports a distinct result
 * for complete vs incomplete merges. Never writes into the input segments.
 *
 * Importable (returns an exit code) so the Bun unit tests exercise the real
 * CLI behavior on temp dirs; script/p0-bench-merge.ts is the tiny entry.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { isAbsolute, dirname, join, relative, resolve } from "node:path"
import { gitState } from "./git-env"
import { repoRootFrom } from "./repo-root"
import { wantsMergeHelp, parseMergeArgs, type MergeArgs } from "./merge-args"
import {
  MergeError,
  buildManifest,
  mergeSegments,
  parseLines,
  sha256hex,
  validateSegment,
  type LogCopyInfo,
  type MergeLine,
  type MergeOutput,
  type SegmentData,
} from "./merge"
import { MERGE_USAGE } from "./merge-args"

function reportFailure(err: unknown): number {
  if (err instanceof MergeError) console.error(`[p0-bench-merge] ${err.message}`)
  else console.error(`[p0-bench-merge] ${err instanceof Error ? err.message : String(err)}`)
  return 1
}

/** True when the resolved output dir is equal to or inside a segment outDir. */
function insideInput(outDir: string, segmentDir: string): boolean {
  const rel = relative(segmentDir, outDir)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * Run the merge CLI. `cwd` is the fallback root when KILO_E2E_ROOT is unset
 * (the launcher pins KILO_E2E_ROOT to packages/kilo-vscode). Returns the
 * process exit code: 0 complete, 2 incomplete (valid artifact emitted), 1
 * error (nothing emitted).
 */
export function runMergeCli(argv: string[], cwd: string): number {
  if (wantsMergeHelp(argv)) {
    console.log(MERGE_USAGE)
    return 0
  }
  const root = process.env.KILO_E2E_ROOT ? resolve(process.env.KILO_E2E_ROOT) : cwd
  const repoRoot = repoRootFrom(root)
  let args: MergeArgs
  try {
    args = parseMergeArgs(argv, repoRoot)
  } catch (err) {
    console.error(`[p0-bench-merge] ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  const segs: SegmentData[] = []
  for (const path of args.segments) {
    if (!existsSync(path)) {
      console.error(`[p0-bench-merge] segment not found: ${path}`)
      return 1
    }
    let text: string
    try {
      text = readFileSync(path, "utf8")
    } catch (err) {
      console.error(`[p0-bench-merge] cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`)
      return 1
    }
    const sha = sha256hex(text)
    let lines: MergeLine[]
    try {
      lines = parseLines(text, path)
      segs.push(validateSegment(path, sha, lines))
    } catch (err) {
      return reportFailure(err)
    }
  }
  for (const s of segs) {
    if (s.outDir !== null && insideInput(args.outDir, s.outDir)) {
      console.error(`[p0-bench-merge] refusing to write into input segment dir ${s.outDir}`)
      return 1
    }
    if (resolve(dirname(s.path)) === args.outDir) {
      console.error(`[p0-bench-merge] refusing to write into the directory of input segment ${s.path}`)
      return 1
    }
  }
  // Freeze merge-time git state BEFORE the output artifact is created: the
  // evidence dir is not gitignored, so creating it must never flip the
  // recorded dirty state (same rule as the live harness).
  const git = gitState(root)
  const mergedAt = Date.now()
  let merged: MergeOutput
  try {
    merged = mergeSegments(segs, { requiredSamples: args.requiredSamples, mergedAt, mergeGit: git, outDir: args.outDir })
  } catch (err) {
    return reportFailure(err)
  }
  // Copy raw logs best-effort into the merged ignored logs/ dir with
  // deterministic names; missing/unreadable logs are recorded, not fatal.
  const logDir = join(args.outDir, "logs")
  mkdirSync(logDir, { recursive: true })
  const logInfo: LogCopyInfo[] = []
  segs.forEach((s, i) => {
    const sourceDir = s.outDir !== null ? join(s.outDir, "logs") : null
    let present = false
    let files: string[] = []
    try {
      if (sourceDir !== null && existsSync(sourceDir)) {
        files = readdirSync(sourceDir)
        present = true
      }
    } catch {
      present = false
      files = []
    }
    const copied: string[] = []
    const missing: string[] = []
    for (const file of files) {
      const target = `seg${i}-${file}`
      try {
        copyFileSync(join(sourceDir!, file), join(logDir, target))
        copied.push(target)
      } catch {
        missing.push(file)
      }
    }
    logInfo.push({ path: s.path, sourceDir, present, files, copied, missing })
  })
  const outFile = join(args.outDir, "benchmark.jsonl")
  const manifestFile = join(args.outDir, "merge-manifest.json")
  try {
    mkdirSync(args.outDir, { recursive: true })
    writeFileSync(outFile, merged.records.map((r) => JSON.stringify(r)).join("\n") + "\n")
    const manifest = buildManifest(merged, segs, logInfo)
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n")
  } catch (err) {
    console.error(`[p0-bench-merge] failed to write output: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  console.log(`[p0-bench-merge] merged ${segs.length} segments → ${outFile}`)
  console.log(
    `[p0-bench-merge] scenario=${merged.scenario} warmup=${merged.warmupCount} measured=${merged.measuredCount} ` +
      `required=${args.requiredSamples} status=${merged.status} baselineComplete=${merged.baselineComplete}`,
  )
  if (merged.drift.length > 0) {
    console.log(`[p0-bench-merge] environment drift: ${merged.drift.map((d) => `${d.field} (${d.values.join(", ")})`).join("; ")}`)
  }
  for (const w of merged.warnings) console.log(`[p0-bench-merge] warning: ${w}`)
  if (merged.baselineComplete) {
    console.log("[p0-bench-merge] merged artifact complete")
    return 0
  }
  console.log(
    "[p0-bench-merge] merged artifact INCOMPLETE (baselineComplete=false): inputs validated but required counts / " +
      "warmup count / failed samples not met",
  )
  return 2
}
