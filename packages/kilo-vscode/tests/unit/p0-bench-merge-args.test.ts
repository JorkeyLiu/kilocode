import { describe, expect, it } from "bun:test"
import { join, resolve } from "node:path"
import { MERGE_USAGE, parseMergeArgs, wantsMergeHelp } from "../../script/p0-bench/merge-args"

const REPO = "/ws/kilocode"

describe("p0 segment merger: help handling", () => {
  it("detects --help and -h before any read or output creation", () => {
    expect(wantsMergeHelp(["--help"])).toBe(true)
    expect(wantsMergeHelp(["-h"])).toBe(true)
    expect(wantsMergeHelp(["--segments", "a.jsonl"])).toBe(false)
    expect(wantsMergeHelp([])).toBe(false)
  })

  it("usage documents the merge contract, flags, exit codes, and no-live-launch guarantee", () => {
    expect(MERGE_USAGE).toContain("Usage")
    expect(MERGE_USAGE).toContain("--segments")
    expect(MERGE_USAGE).toContain("--out")
    expect(MERGE_USAGE).toContain("--required-samples")
    expect(MERGE_USAGE).toContain("no live launch")
    expect(MERGE_USAGE).toContain("many-agent-mcp-merged")
    expect(MERGE_USAGE).toContain("Interrupted runs")
    expect(MERGE_USAGE).toContain("baselineComplete")
    expect(MERGE_USAGE).toContain("not a tail-latency SLA")
  })
})

describe("p0 segment merger: argument parsing", () => {
  it("defaults the output root to the repo evidence convention with the merged dir name", () => {
    const args = parseMergeArgs(["--segments", "a.jsonl"], REPO)
    const base = join(REPO, "specs", "vscode-orchestrator", "evidence", "p0-baseline", "many-agent-mcp-merged-")
    expect(args.outDir.startsWith(base)).toBe(true)
    expect(args.requiredSamples).toBe(5)
  })

  it("accepts repeated --segments occurrences", () => {
    const args = parseMergeArgs(["--segments", "a.jsonl", "--segments", "b.jsonl", "--segments", "c.jsonl"], REPO)
    expect(args.segments).toEqual([resolve("a.jsonl"), resolve("b.jsonl"), resolve("c.jsonl")])
  })

  it("accepts space-separated and comma-separated --segments values", () => {
    const args = parseMergeArgs(["--segments", "a.jsonl b.jsonl,c.jsonl"], REPO)
    expect(args.segments).toEqual([resolve("a.jsonl"), resolve("b.jsonl"), resolve("c.jsonl")])
  })

  it("stops consuming --segments values at the next flag", () => {
    const args = parseMergeArgs(["--segments", "a.jsonl", "b.jsonl", "--out", "/tmp/merged", "--required-samples", "3"], REPO)
    expect(args.segments).toEqual([resolve("a.jsonl"), resolve("b.jsonl")])
    expect(args.outDir).toBe("/tmp/merged")
    expect(args.requiredSamples).toBe(3)
  })

  it("honors an explicit absolute --out and --required-samples", () => {
    const args = parseMergeArgs(["--segments", "a.jsonl", "--out", "/abs/out", "--required-samples", "7"], REPO)
    expect(args.outDir).toBe("/abs/out")
    expect(args.requiredSamples).toBe(7)
  })

  it("throws on missing segments, unknown flags, and invalid required-samples", () => {
    expect(() => parseMergeArgs([], REPO)).toThrow("at least one --segments")
    expect(() => parseMergeArgs(["--segments"], REPO)).toThrow("requires at least one segment path")
    expect(() => parseMergeArgs(["--segments", "a.jsonl", "--bogus"], REPO)).toThrow('unknown argument "--bogus"')
    expect(() => parseMergeArgs(["--segments", "a.jsonl", "--required-samples", "0"], REPO)).toThrow("integer >= 1")
    expect(() => parseMergeArgs(["--segments", "a.jsonl", "--required-samples", "2.5"], REPO)).toThrow("integer >= 1")
    expect(() => parseMergeArgs(["--segments", "a.jsonl", "--out"], REPO)).toThrow("--out requires a directory path")
  })
})
