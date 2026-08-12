/**
 * Deterministic repository-root resolution for the P0 extension benchmark.
 *
 * The default output convention requires the evidence dir to land under the
 * exact checkout that produced it:
 *
 *   <repo>/specs/vscode-orchestrator/evidence/p0-baseline/<run-id>/
 *
 * Git-first: `git rev-parse --show-toplevel` returns the checkout root from
 * any directory, including linked worktrees. When git is unavailable the
 * harness layout provides the fallback: the launcher pins cwd +
 * KILO_E2E_ROOT to packages/kilo-vscode, whose repo root is two levels up.
 *
 * Pure Node module (no Bun, no kilo/extension imports) so both the Node
 * harness and the Bun unit tests share one implementation.
 */

import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

/**
 * Repo-root resolution for a directory: `git rev-parse --show-toplevel`
 * first (worktree-safe, cwd-independent), then the package-root layout
 * fallback (`resolve(dir, "../..")` for packages/kilo-vscode).
 */
export function repoRootFrom(dir: string): string {
  const proc = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" })
  if (proc.status === 0) {
    const root = (proc.stdout ?? "").trim()
    if (root) return root
  }
  return resolve(dir, "../..")
}
