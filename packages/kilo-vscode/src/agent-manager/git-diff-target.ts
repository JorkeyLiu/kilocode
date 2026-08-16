import type { GitOps } from "./GitOps"
import { resolveBase } from "./local-diff"

/**
 * Neutral git diff target/revert helpers retained after the custom Diff Viewer
 * surface removal (P3.2). Consumers: `kilo-provider/git-changes-target.ts`
 * (local git-changes prompt context) and the Agent Manager revert flow tests.
 */

/**
 * A diff target: the working directory and the base branch we diff
 * against (usually the tracking branch).
 */
export type DiffTarget = { directory: string; baseBranch: string }

export type DiffStatus = "added" | "deleted" | "modified"
export type StatusResolver = (target: DiffTarget, file: string) => Promise<DiffStatus | undefined>

export async function resolveLocalDiffTarget(
  gitOps: GitOps,
  log: (...args: unknown[]) => void,
  root?: string,
): Promise<{ directory: string; baseBranch: string } | undefined> {
  if (!root) {
    log("Local diff: no workspace root")
    return
  }

  const branch = await gitOps.currentBranch(root)
  if (!branch || branch === "HEAD") {
    log("Local diff: detached HEAD or no branch")
    return
  }

  const tracking = await gitOps.resolveTrackingBranch(root, branch)
  const fallback = tracking ? undefined : await gitOps.resolveDefaultBranch(root, branch)
  const raw = tracking || fallback || "HEAD"
  const base = await resolveBase(gitOps, root, raw)

  log(`Local diff: branch=${branch} tracking=${tracking ?? "none"} default=${fallback ?? "none"} base=${base}`)

  return { directory: root, baseBranch: base }
}

/**
 * Thin coordinator that wraps local diff status lookup with GitOps revert
 * behavior used by the Agent Manager revert flows.
 */
export class DiffReverter {
  constructor(
    private readonly git: GitOps,
    private readonly status: StatusResolver,
    private readonly log: (...args: unknown[]) => void,
  ) {}

  /**
   * Look up the diff status for a single file. Used by revert flows to pick
   * the right git strategy (added means delete, modified/deleted means checkout).
   * Returns `undefined` on error so callers can still attempt a best-effort
   * revert, `GitOps.revertFile` defaults to a modified-file strategy.
   */
  async fileStatus(target: DiffTarget, file: string): Promise<DiffStatus | undefined> {
    try {
      return await this.status(target, file)
    } catch (err) {
      this.log("Failed to look up file status for revert:", err)
      return undefined
    }
  }

  /**
   * Revert a single file in the working directory. Composes `fileStatus` and `GitOps.revertFile`.
   * Returns a normalized result; callers handle UI/messaging.
   */
  async revertFile(target: DiffTarget, file: string): Promise<{ ok: boolean; message: string }> {
    const status = await this.fileStatus(target, file)
    return this.git.revertFile(target.directory, target.baseBranch, file, status)
  }
}
