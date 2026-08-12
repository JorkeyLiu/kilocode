/**
 * Deterministic repository-root resolution for the backend P0 benchmark.
 *
 * The default output convention requires the evidence dir to land under the
 * exact checkout that produced it:
 *
 *   <repo>/specs/vscode-orchestrator/evidence/p0-baseline/<run-id>/
 *
 * Git-first: `git rev-parse --show-toplevel` returns the checkout root from
 * any directory, including linked worktrees — the evidence must live in the
 * same checkout whose commit/head/dirty state the records report. When git is
 * unavailable (e.g. a source tarball without `.git`) the fixed benchmark
 * layout provides the fallback arithmetic: this module always lives at
 * packages/opencode/test/benchmark/, four levels below the repo root.
 *
 * Pure module (no kilo imports) so tests can exercise it in isolation.
 */

import path from "node:path"

/**
 * Repo-root resolution for a directory. Tries `git rev-parse --show-toplevel`
 * first (works in worktrees, ignores cwd); falls back to the benchmark layout
 * arithmetic (four levels up from `dir`) when git is unavailable. The fallback
 * is only correct when `dir` IS the benchmark module dir, which is exactly how
 * the harness calls it — tests mirror that depth explicitly.
 */
export function repoRootFrom(dir: string): string {
  const proc = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode === 0) {
    const root = proc.stdout.toString().trim()
    if (root) return root
  }
  return path.resolve(dir, "../../../..")
}

/** Repo root for this module (always the packages/opencode/test/benchmark layout). */
export function resolveRepoRoot(): string {
  return repoRootFrom(import.meta.dir)
}
