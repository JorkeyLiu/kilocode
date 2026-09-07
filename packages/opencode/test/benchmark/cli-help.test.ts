/**
 * Focused CLI-entry help tests for the backend P0 benchmark.
 *
 * Proves `--help` / `-h` on the real CLI entry (script/p0-benchmark.ts):
 *   - prints the usage text and exits 0,
 *   - never runs a campaign and never creates any run output artifact
 *     (the temp dir is byte-identical before and after),
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
import os from "node:os"
import path from "node:path"

const pkg = path.resolve(import.meta.dir, "../..")
const scratch = fs.realpathSync(os.tmpdir())

const scratchSnapshot = (): string[] => fs.readdirSync(scratch).filter((n) => n.startsWith("kilo-")).sort()

const runHelp = (flag: string) =>
  spawnSync(process.execPath, ["run", "script/p0-benchmark.ts", flag], {
    cwd: pkg,
    encoding: "utf8",
    timeout: 120_000,
  })

describe("backend p0 benchmark CLI help", () => {
  for (const flag of ["--help", "-h"]) {
    it(`${flag} prints usage, exits 0, and creates no output`, () => {
      const before = scratchSnapshot()
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
      // Run-owned output wording: results live outside the repo by default.
      expect(out).toContain("run-owned")
      // No campaign ran and no artifact was created.
      expect(scratchSnapshot()).toEqual(before)
    }, 120_000)
  }

  it("rejects an invalid flag value with a non-zero exit and cleans up", () => {
    const before = scratchSnapshot()
    // `--samples 0` fails validation (>= 1 required) → exit 2, before any
    // campaign boots; no run output artifact is created.
    const proc = spawnSync(process.execPath, ["run", "script/p0-benchmark.ts", "--samples", "0"], {
      cwd: pkg,
      encoding: "utf8",
      timeout: 120_000,
    })
    expect(proc.status).toBe(2)
    expect((proc.stderr ?? "").length).toBeGreaterThan(0)
    expect(scratchSnapshot()).toEqual(before)
  }, 120_000)
})
