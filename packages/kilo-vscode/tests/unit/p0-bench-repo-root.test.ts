import { afterAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { repoRootFrom } from "../../script/p0-bench/repo-root"

const dirs: string[] = []

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kilo-p0-root-"))
  dirs.push(dir)
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

function makeNonGit(): string {
  const dir = mkdtempSync(join(tmpdir(), "kilo-p0-nongit-"))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe("p0 extension repo-root resolution", () => {
  it("resolves via git to the checkout toplevel for a run-owned repo", () => {
    const repo = makeRepo()
    // git reports paths via the OS-resolved root (e.g. /private/var on macOS
    // where os.tmpdir() gives /var), so compare realpaths.
    expect(realpathSync(repoRootFrom(repo))).toBe(realpathSync(repo))
  })

  it("falls back to the package-root layout when git is unavailable", () => {
    // Mirror the real depth <repo>/packages/kilo-vscode: the fallback (two
    // levels up) must recover the intended repo root.
    const base = makeNonGit()
    const pkgDir = join(base, "packages", "kilo-vscode")
    expect(repoRootFrom(pkgDir)).toBe(base)
  })

  it("resolves the real packages/kilo-vscode to the repo root in the current checkout", () => {
    // The unit tests run from packages/kilo-vscode; the resolved repo root
    // must hold the repo layout the evidence convention depends on.
    const here = resolve(import.meta.dir, "..", "..")
    const root = repoRootFrom(here)
    expect(join(root, "packages", "kilo-vscode")).toBe(here)
  })
})
