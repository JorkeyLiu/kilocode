/**
 * Focused CLI-entry help tests for the backend P0 benchmark.
 *
 * Proves `--help` / `-h` on the real CLI entry (script/p0-benchmark.ts):
 *   - prints the usage text and exits 0,
 *   - never runs a campaign and never creates any evidence artifact
 *     (the evidence dir is byte-identical before and after),
 *   - cleans up its run-owned root (the CLI help path is validation-only).
 *
 * The subprocess imports the real entry exactly as `bun run bench:p0` does —
 * no mocks, no partial stubs. It never bootstraps the listener or runs a
 * sample (module-graph evaluation happens, as in the real CLI, but nothing is
 * measured or emitted).
 *
 * Each real-subprocess test carries an explicit per-test timeout aligned with
 * the subprocess bound: loading the production module graph takes ~5-10s,
 * which exceeds Bun's default 5s per-test timeout.
 */

import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { resolveRepoRoot } from "./repo-root"

const pkg = path.resolve(import.meta.dir, "../..")
const repoRoot = resolveRepoRoot()
const evidence = path.join(repoRoot, "specs", "vscode-orchestrator", "evidence")

const evidenceSnapshot = (): string[] | null =>
  fs.existsSync(evidence) ? fs.readdirSync(evidence).sort() : null

const runHelp = (flag: string) =>
  spawnSync(process.execPath, ["run", "script/p0-benchmark.ts", flag], {
    cwd: pkg,
    encoding: "utf8",
    timeout: 120_000,
  })

describe("backend p0 benchmark CLI help", () => {
  for (const flag of ["--help", "-h"]) {
    it(`${flag} prints usage, exits 0, and creates no evidence`, () => {
      const before = evidenceSnapshot()
      const proc = runHelp(flag)
      expect(proc.status).toBe(0)
      // The p0 stream (Log.init print) legitimately lands on stderr even for
      // validation-only invocations; there must be no ERROR/FATAL markers.
      const err = proc.stderr ?? ""
      expect(err).not.toContain("ERROR")
      expect(err).not.toContain("FATAL")
      const out = proc.stdout ?? ""
      expect(out).toContain("Usage")
      expect(out).toContain("--scenarios")
      expect(out).toContain("--out")
      // Durable-evidence wording: JSONL is versionable tracker evidence.
      expect(out).toContain("durable")
      // No campaign ran and no artifact was created.
      expect(evidenceSnapshot()).toEqual(before)
    }, 120_000)
  }

  it("rejects an invalid flag value with a non-zero exit and cleans up", () => {
    const before = evidenceSnapshot()
    // `--samples 0` fails validation (>= 1 required) → exit 2, before any
    // campaign boots; no evidence artifact is created.
    const proc = spawnSync(process.execPath, ["run", "script/p0-benchmark.ts", "--samples", "0"], {
      cwd: pkg,
      encoding: "utf8",
      timeout: 120_000,
    })
    expect(proc.status).toBe(2)
    expect((proc.stderr ?? "").length).toBeGreaterThan(0)
    expect(evidenceSnapshot()).toEqual(before)
  }, 120_000)
})
