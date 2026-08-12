/**
 * Focused tests for the backend benchmark repo-root resolution and the
 * durable-evidence convention.
 *
 * The audit blocker was `path.resolve(import.meta.dir, "../../..")` resolving
 * to `<repo>/packages` instead of the repo root, which moved the default
 * evidence dir out of the intended
 * `<repo>/specs/vscode-orchestrator/evidence/p0-baseline/<run-id>/` location
 * and pointed git provenance at the wrong directory. These tests pin:
 *   - `resolveRepoRoot()` returns the git checkout toplevel (worktree-safe),
 *   - `repoRootFrom()` prefers git over the layout fallback,
 *   - the layout fallback arithmetic is correct at the benchmark depth,
 *   - the evidence convention: with only the narrow `logs/` ignore, JSONL is
 *     untracked/trackable while raw logs under the run dir's logs/ stay
 *     ignored (durable versionable evidence + separately ignorable raw logs).
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
  it("resolveRepoRoot returns the git checkout toplevel with the expected layout", () => {
    const root = resolveRepoRoot()
    // The resolved root IS a git toplevel (worktree-safe by construction).
    expect(gitToplevel(root)).toBe(root)
    // The repo layout exists below it — the evidence convention lands here.
    expect(fs.existsSync(path.join(root, "specs", "vscode-orchestrator"))).toBe(true)
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

describe("benchmark durable-evidence convention", () => {
  it("JSONL is trackable and only the run dir's raw logs/ are ignored", async () => {
    await using repo = await tmpdir({ git: true })
    // The narrow raw-log ignore only (the broad evidence-dir ignore was
    // removed): machine-readable JSONL must surface as untracked/trackable.
    await Bun.write(path.join(repo.path, ".gitignore"), "logs/\n")
    const runDir = path.join(
      repo.path,
      "specs",
      "vscode-orchestrator",
      "evidence",
      "p0-baseline",
      "run-1",
    )
    await fs.promises.mkdir(path.join(runDir, "logs"), { recursive: true })
    await Bun.write(path.join(runDir, "backend.jsonl"), "{}\n")
    await Bun.write(path.join(runDir, "logs", "sample-1.log"), "raw capture\n")

    const proc = Bun.spawnSync(["git", "-C", repo.path, "status", "--porcelain", "--untracked-files=all"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const porcelain = proc.stdout.toString()
    // The JSONL evidence is visible to git (trackable/versionable), while the
    // raw log under logs/ is ignored and never appears.
    expect(porcelain).toContain("specs/vscode-orchestrator/evidence/p0-baseline/run-1/backend.jsonl")
    expect(porcelain).not.toContain("logs/")
  })
})
