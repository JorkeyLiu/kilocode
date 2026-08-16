import type { GitOps } from "./GitOps"
import type { Semaphore } from "./semaphore"

export interface LocalStats {
  branch: string
  files: number
  additions: number
  deletions: number
  ahead: number
  behind: number
}

interface GitStatsPollerOptions {
  getWorkspaceRoot: () => string | undefined
  /**
   * Compute diff summaries locally (in the extension host) rather than over
   * HTTP to `kilo serve`. Keeps git spawning out of the Bun process, which
   * leaks native memory on Windows (oven-sh/bun#18265).
   */
  localDiff: (dir: string, base: string) => Promise<{ additions: number; deletions: number }[]>
  git: GitOps
  onLocalStats: (stats: LocalStats) => void
  log: (...args: unknown[]) => void
  intervalMs?: number
  /** Shared concurrency gate for child process spawning. */
  semaphore?: Semaphore
  hiddenIntervalMs?: number
}

export class GitStatsPoller {
  private timer: ReturnType<typeof setTimeout> | undefined
  private active = false
  private busy = false
  private lastLocalHash: string | undefined
  private lastLocalStats: LocalStats | undefined
  private readonly intervalMs: number
  private readonly hiddenIntervalMs: number
  private readonly git: GitOps
  private visible = true

  constructor(private readonly options: GitStatsPollerOptions) {
    this.intervalMs = options.intervalMs ?? 5000
    this.hiddenIntervalMs = options.hiddenIntervalMs ?? 60000
    this.git = options.git
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    if (this.active && this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.schedule(this.visible ? this.intervalMs : this.hiddenIntervalMs)
    }
  }

  setEnabled(enabled: boolean): void {
    if (enabled) {
      if (this.active) return
      this.active = true
      void this.poll()
      return
    }
    this.stop()
  }

  stop(): void {
    this.active = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.busy = false
    this.lastLocalHash = undefined
    this.lastLocalStats = undefined
  }

  async snapshot(refresh = false): Promise<{ local?: LocalStats }> {
    if (refresh && !this.busy) {
      this.busy = true
      await this.fetchLocalStats().finally(() => {
        this.busy = false
      })
    }
    return {
      ...(this.lastLocalStats ? { local: this.lastLocalStats } : {}),
    }
  }

  private currentInterval(): number {
    return this.visible ? this.intervalMs : this.hiddenIntervalMs
  }

  private schedule(delay: number): void {
    if (!this.active) return
    this.timer = setTimeout(() => {
      void this.poll()
    }, delay)
  }

  private poll(): Promise<void> {
    if (!this.active) return Promise.resolve()
    if (this.busy) return Promise.resolve()
    this.busy = true
    return this.fetchLocalStats().finally(() => {
      this.busy = false
      this.schedule(this.currentInterval())
    })
  }

  private async fetchLocalStats(): Promise<void> {
    const root = this.options.getWorkspaceRoot()
    if (!root) return

    try {
      const branch = await this.git.currentBranch(root)
      if (!branch || branch === "HEAD") return

      const tracking = await this.git.resolveTrackingBranch(root, branch)
      const base = tracking ?? (await this.git.resolveDefaultBranch(root, branch))

      let files: number
      let additions: number
      let deletions: number
      let ahead: number
      let behind: number
      try {
        if (base) {
          this.options.log(`Local stats: using localDiff with base=${base}`)
          const [diffs, ab] = await Promise.all([this.options.localDiff(root, base), this.git.aheadBehind(root, base)])
          files = diffs.length
          additions = diffs.reduce((sum, d) => sum + d.additions, 0)
          deletions = diffs.reduce((sum, d) => sum + d.deletions, 0)
          ahead = ab.ahead
          behind = ab.behind
        } else {
          this.options.log(`Local stats: fallback to workingTreeStats (no base branch)`)
          const wt = await this.git.workingTreeStats(root)
          files = wt.files
          additions = wt.additions
          deletions = wt.deletions
          ahead = 0
          behind = 0
        }
      } catch (err) {
        this.options.log("Failed to fetch local diff stats:", err)
        if (this.lastLocalStats && this.lastLocalStats.branch === branch) return
        return
      }

      const hash = `local:${branch}:${files}:${additions}:${deletions}:${ahead}:${behind}`
      if (hash === this.lastLocalHash) {
        this.options.log(`Local stats: unchanged (${hash})`)
        return
      }
      this.lastLocalHash = hash

      this.options.log(`Local stats: emitting files=${files} +${additions} -${deletions} ↑${ahead} ↓${behind}`)
      const stats: LocalStats = { branch, files, additions, deletions, ahead, behind }
      this.lastLocalStats = stats
      this.options.onLocalStats(stats)
    } catch (err) {
      this.options.log("Failed to fetch local stats:", err)
    }
  }
}
