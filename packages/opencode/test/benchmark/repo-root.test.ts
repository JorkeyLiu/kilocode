/**
 * Focused tests for the backend benchmark repo-root resolution and the
 * run-owned output convention.
 *
 * These tests pin:
 *   - `resolveRepoRoot()` returns the git checkout toplevel (worktree-safe),
 *   - `repoRootFrom()` prefers git over the layout fallback,
 *   - the layout fallback arithmetic is correct at the benchmark depth,
 *   - benchmark output defaults outside the repo: nothing from a run-owned
 *     output dir leaks into the repo's git status.
 *
 * Pure Node/git tests — no kilo modules, no env override needed.
 */

import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { repoRootFrom, resolveRepoRoot } from "./repo-root"

const gitToplevel = (dir: string): string | null => {
  const proc = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" })
  return proc.exitCode === 0 ? proc.stdout.toString().trim() : null
}

describe("benchmark repo-root resolution", () => {
  it("resolveRepoRoot returns the git checkout toplevel", () => {
    const root = resolveRepoRoot()
    // The resolved root IS a git toplevel (worktree-safe by construction).
    expect(gitToplevel(root)).toBe(root)
    // The benchmark layout exists below it.
    expect(fs.existsSync(path.join(root, "packages", "opencode", "test", "benchmark"))).toBe(true)
  })

  it("repoRootFrom prefers git toplevel over layout arithmetic on a run-owned repo", async () => {
    // A temp repo whose path has NOTHING to do with the benchmark layout: only
    // the git-first resolution can return the repo itself.
    await using repo = await tmpdir({ git: true })
    expect(repoRootFrom(repo.path)).toBe(repo.path)
  })

  it("repoRootFrom falls back to the layout arithmetic when git is unavailable", async () => {
    // Mirror the real depth packages/opencode/test/benchmark inside a
    // run-owned non-git tree; the fallback (4 levels up) must recover the
    // intended repo root even though git is absent.
    await using base = await tmpdir()
    const benchDir = path.join(base.path, "packages", "opencode", "test", "benchmark")
    await fs.promises.mkdir(benchDir, { recursive: true })
    expect(gitToplevel(benchDir)).toBeNull()
    expect(repoRootFrom(benchDir)).toBe(base.path)
  })
})

describe("benchmark run-owned output convention", () => {
  it("run output lives outside the repo while only the run dir's raw logs/ are ignored", async () => {
    await using repo = await tmpdir({ git: true })
    // Benchmark output defaults to a run-owned temp dir outside the repo, so
    // the repo tree stays clean; only bulky raw logs under the run dir's
    // logs/ are local by nature (the narrow `logs/` ignore).
    await Bun.write(path.join(repo.path, ".gitignore"), "logs/\n")
    const out = path.join(fs.realpathSync(await fs.promises.mkdtemp(path.join(fs.realpathSync("/tmp"), "kilo-bench-convention-"))), "run-1")
    await fs.promises.mkdir(path.join(out, "logs"), { recursive: true })
    await Bun.write(path.join(out, "backend.jsonl"), "{}\n")
    await Bun.write(path.join(out, "logs", "sample-1.log"), "raw capture\n")

    const proc = Bun.spawnSync(["git", "-C", repo.path, "status", "--porcelain", "--untracked-files=all"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const porcelain = proc.stdout.toString()
    // Nothing from the run-owned output dir leaks into the repo status.
    expect(porcelain).not.toContain("backend.jsonl")
    expect(porcelain).not.toContain("run-1")
    await fs.promises.rm(path.dirname(out), { recursive: true, force: true })
  })
})
