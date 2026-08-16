import { describe, it, expect } from "bun:test"
import { GitStatsPoller } from "../../src/agent-manager/GitStatsPoller"
import { GitOps } from "../../src/agent-manager/GitOps"
import type { LocalDiffEntry } from "../../src/agent-manager/types"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean, timeout = 500): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await sleep(5)
  }
}

function diff(additions: number, deletions: number): LocalDiffEntry[] {
  return [
    {
      file: "file.ts",
      patch: "",
      before: "",
      after: "",
      additions,
      deletions,
      status: "modified",
      tracked: true,
      generatedLike: false,
      summarized: true,
      stamp: `${additions}:${deletions}`,
    },
  ]
}

function gitOps(handler: (args: string[], cwd: string) => Promise<string>): GitOps {
  return new GitOps({ log: () => undefined, runGit: handler })
}

describe("GitOps", () => {
  it("resolveDefaultBranch returns undefined on cache hit when there is no remote HEAD", async () => {
    let calls = 0
    const git = new GitOps({
      log: () => undefined,
      runGit: async (args) => {
        calls++
        if (args[0] === "symbolic-ref") throw new Error("no remote HEAD")
        if (args[0] === "branch" && args[1] === "--show-current") return "main"
        if (args[0] === "config" && args[1] === "branch.main.remote") return "origin"
        if (args[0] === "rev-parse" && args[3] === "@{upstream}") throw new Error("no upstream")
        return ""
      },
    })

    // First call sets cache
    const first = await git.resolveDefaultBranch("/test")
    expect(first).toBeUndefined()
    expect(calls).toBeGreaterThan(0)

    // Second call reads from cache
    const beforeSecondCall = calls
    const second = await git.resolveDefaultBranch("/test")
    expect(second).toBeUndefined()
    // Should not have made any new git calls for the exact same resolution
    expect(calls).toBe(beforeSecondCall)
  })
})

describe("GitStatsPoller (local workspace stats)", () => {
  it("does not overlap polling runs", async () => {
    let running = 0
    let max = 0
    let calls = 0

    const localDiff = async () => {
      calls += 1
      running += 1
      max = Math.max(max, running)
      await sleep(40)
      running -= 1
      return diff(2, 1)
    }

    const poller = new GitStatsPoller({
      getWorkspaceRoot: () => "/workspace",
      localDiff,
      onLocalStats: () => undefined,
      log: () => undefined,
      intervalMs: 5,
      git: gitOps(async (args) => {
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") return "main"
        if (args[0] === "rev-parse" && args[2] === "@{upstream}") return "origin/main"
        if (args[0] === "rev-list" && args[1] === "--left-right") return "0\t1"
        return ""
      }),
    })

    poller.setEnabled(true)
    await waitFor(() => calls >= 2)
    poller.stop()

    expect(max).toBe(1)
  })

  it("preserves local stats when diff fails after initial success", async () => {
    let diffCalls = 0
    const emitted: Array<{
      branch: string
      files: number
      additions: number
      deletions: number
      ahead: number
      behind: number
    }> = []

    const localDiff = async () => {
      diffCalls += 1
      if (diffCalls === 1) return diff(5, 2)
      throw new Error("transient backend failure")
    }

    const poller = new GitStatsPoller({
      getWorkspaceRoot: () => "/workspace",
      localDiff,
      onLocalStats: (stats) => emitted.push(stats),
      log: () => undefined,
      intervalMs: 5,
      git: gitOps(async (args) => {
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") return "feature"
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "@{upstream}") return "origin/feature"
        if (args[0] === "rev-list" && args[1] === "--left-right") return "0\t3"
        if (args[0] === "branch") return "feature"
        if (args[0] === "config") return "origin"
        return ""
      }),
    })

    poller.setEnabled(true)
    await waitFor(() => diffCalls >= 2)
    poller.stop()

    expect(emitted.length).toBeGreaterThan(0)
    expect(emitted[0]).toEqual({ branch: "feature", files: 1, additions: 5, deletions: 2, ahead: 3, behind: 0 })
    expect(emitted.length).toBe(1)
  })

  it("falls back to <remote>/HEAD when no upstream and no <remote>/<branch>", async () => {
    const emitted: Array<{
      branch: string
      files: number
      additions: number
      deletions: number
      ahead: number
      behind: number
    }> = []

    const poller = new GitStatsPoller({
      getWorkspaceRoot: () => "/workspace",
      localDiff: async () => diff(10, 4),
      onLocalStats: (stats) => emitted.push(stats),
      log: () => undefined,
      intervalMs: 500,
      git: gitOps(async (args) => {
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") return "my-feature"
        // no upstream configured (used by resolveTrackingBranch and resolveRemote)
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "@{upstream}")
          throw new Error("no upstream")
        if (args[0] === "rev-parse" && args[3] === "@{upstream}") throw new Error("no upstream")
        // branch.my-feature.remote = myfork
        if (args[0] === "config" && args[1] === "branch.my-feature.remote") return "myfork"
        // myfork/my-feature does not exist
        if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "myfork/my-feature")
          throw new Error("no ref")
        // myfork/HEAD resolves to the default branch
        if (args[0] === "symbolic-ref" && args[2] === "refs/remotes/myfork/HEAD") return "myfork/develop"
        if (args[0] === "branch") return "my-feature"
        if (args[0] === "rev-list" && args[1] === "--left-right") return "0\t5"
        return ""
      }),
    })

    poller.setEnabled(true)
    await waitFor(() => emitted.length >= 1)
    poller.stop()

    expect(emitted[0]).toEqual({ branch: "my-feature", files: 1, additions: 10, deletions: 4, ahead: 5, behind: 0 })
  })

  it("falls back to workingTreeStats when no tracking, no default branch, and no remote refs exist", async () => {
    const emitted: Array<{
      branch: string
      files: number
      additions: number
      deletions: number
      ahead: number
      behind: number
    }> = []

    const poller = new GitStatsPoller({
      getWorkspaceRoot: () => "/workspace",
      localDiff: async () => diff(0, 0),
      onLocalStats: (stats) => emitted.push(stats),
      log: () => undefined,
      intervalMs: 500,
      git: gitOps(async (args) => {
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") return "orphan-branch"
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "@{upstream}")
          throw new Error("no upstream")
        if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/orphan-branch")
          throw new Error("no ref")
        if (args[0] === "symbolic-ref") throw new Error("no symbolic ref")
        if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "--quiet") throw new Error("no ref")
        // workingTreeStats fallback: no tracked changes, no untracked files
        if (args[0] === "diff") return ""
        if (args[0] === "ls-files") return ""
        return ""
      }),
    })

    poller.setEnabled(true)
    await waitFor(() => emitted.length >= 1)
    poller.stop()

    expect(emitted[0]).toEqual({
      branch: "orphan-branch",
      files: 0,
      additions: 0,
      deletions: 0,
      ahead: 0,
      behind: 0,
    })
  })

  it("snapshot(refresh) computes local stats on demand", async () => {
    const poller = new GitStatsPoller({
      getWorkspaceRoot: () => "/workspace",
      localDiff: async () => diff(2, 1),
      onLocalStats: () => undefined,
      log: () => undefined,
      intervalMs: 500,
      git: gitOps(async (args) => {
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") return "main"
        if (args[0] === "rev-parse" && args[2] === "@{upstream}") return "origin/main"
        if (args[0] === "rev-list" && args[1] === "--left-right") return "0\t2"
        return ""
      }),
    })

    const snap = await poller.snapshot(true)
    expect(snap.local).toEqual({ branch: "main", files: 1, additions: 2, deletions: 1, ahead: 2, behind: 0 })
    poller.stop()
  })
})
