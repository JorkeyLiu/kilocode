import { afterAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitState } from "../../script/p0-bench/git-env"

const repos: string[] = []

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kilo-p0-git-"))
  repos.push(dir)
  const git = (args: string[]) => {
    const proc = spawnSync("git", args, { cwd: dir, encoding: "utf8" })
    if (proc.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`)
  }
  git(["init"])
  git(["config", "user.email", "test@p0.test"])
  git(["config", "user.name", "P0 Test"])
  git(["commit", "--allow-empty", "-m", "root"])
  return dir
}

afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true })
})

describe("p0 benchmark git provenance", () => {
  it("reports full commit, short head, and clean in a fresh git repo", () => {
    const dir = makeRepo()
    const state = gitState(dir)
    expect(state.gitCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(state.gitHead).toBeTruthy()
    expect(state.gitHead).toBe(state.gitCommit!.slice(0, state.gitHead!.length))
    expect(state.gitDirty).toBe(false)
  })

  it("reports dirty when the repo has an untracked change", () => {
    const dir = makeRepo()
    writeFileSync(join(dir, "untracked.txt"), "dirty")
    expect(gitState(dir).gitDirty).toBe(true)
    // Commit/head remain resolved while dirty.
    const state = gitState(dir)
    expect(state.gitCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(state.gitDirty).toBe(true)
  })

  it("reports null commit/head and dirty for a non-git directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-p0-nongit-"))
    repos.push(dir)
    const state = gitState(dir)
    expect(state.gitCommit).toBeNull()
    expect(state.gitHead).toBeNull()
    expect(state.gitDirty).toBe(true)
  })
})
