/**
 * Read-only git provenance for the P0 benchmark harness.
 *
 * Pure Node module (no kilo/extension imports) so both the Node harness
 * (script/e2e-p0-bench.ts) and Bun unit tests (tests/unit/) share one
 * implementation. Git detection is derived ONCE at campaign start and
 * propagated into every record; it never mutates the worktree.
 */

import { spawnSync } from "node:child_process"

export interface GitState {
  /** Full 40-char HEAD commit (explicit commit alias). */
  gitCommit: string | null
  /** Short HEAD (backward-compatible alias). */
  gitHead: string | null
  /** True when `git status --porcelain` is non-empty; non-git dirs are dirty. */
  gitDirty: boolean
}

function gitOut(dir: string, args: string[]): string | null {
  const proc = spawnSync("git", args, { cwd: dir, encoding: "utf8" })
  if (proc.status !== 0) return null
  // Return the raw output even when empty: an empty `status --porcelain`
  // output means CLEAN, and `?? "dirty"` must only fall back on failure.
  return (proc.stdout ?? "").trim()
}

/**
 * Read-only git provenance for a directory. A non-git or failed directory
 * reports null commit/head and dirty=true (unknown state is treated as dirty
 * rather than silently clean).
 */
export function gitState(dir: string): GitState {
  const commit = gitOut(dir, ["rev-parse", "HEAD"])
  const head = gitOut(dir, ["rev-parse", "--short", "HEAD"])
  const dirty = (gitOut(dir, ["status", "--porcelain"]) ?? "dirty").length > 0
  return { gitCommit: commit, gitHead: head, gitDirty: dirty }
}
