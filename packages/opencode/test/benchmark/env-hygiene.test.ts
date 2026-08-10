/**
 * Focused env-hygiene tests for the backend P0 benchmark.
 *
 * `bun test` executes every test file in ONE process, so a benchmark file that
 * finishes must leave process.env exactly as it found it — otherwise the next
 * file inherits HOME/XDG/TMPDIR/KILO_DB/... pointing at a removed run root.
 * These tests prove, through the module's public seam:
 *   - the run-owned env is armed at module load (first-import wins),
 *   - `restoreEnv()` returns every overridden key to its pre-load value/unset
 *     state and no key references the run root,
 *   - `registerBenchmarkEnv()` re-arms env + recreates the run root after a
 *     previous file's dispose restored them,
 *   - `cleanupRunRoot()` removes the root with no residue.
 *
 * This file registers its own cleanup (the last afterAll hook) so the process
 * ends with the pre-load env restored and the run root removed regardless of
 * whether it is run alone or co-run with the other benchmark files.
 */

import "./environment"
import { afterAll, describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { cleanupRunRoot, dirs, ENV_KEYS, envBefore, registerBenchmarkEnv, restoreEnv, runRoot } from "./environment"

// Last hook: when this file finishes (and no other benchmark file is still
// registered), restore the pre-load env and remove the run root.
afterAll(registerBenchmarkEnv())

const armedChecks: Array<[string, string | undefined]> = [
  ["TMPDIR", dirs.tmp],
  ["HOME", dirs.home],
  ["KILO_TEST_HOME", dirs.home],
  ["XDG_DATA_HOME", dirs.data],
  ["XDG_CONFIG_HOME", dirs.config],
  ["XDG_STATE_HOME", dirs.state],
  ["XDG_CACHE_HOME", dirs.cache],
  ["KILO_DB", path.join(dirs.data, "kilo-p0.sqlite")],
  ["KILO_P0_PERF", "1"],
  ["KILO_PURE", "1"],
  ["KILO_DISABLE_AUTOUPDATE", "1"],
]

const unsetChecks = ["KILO_SERVER_PASSWORD", "KILO_SERVER_USERNAME"]

describe("benchmark env hygiene", () => {
  it("arms the run-owned env at module load", () => {
    for (const [key, value] of armedChecks) expect(process.env[key], key).toBe(value)
    for (const key of unsetChecks) expect(process.env[key], key).toBeUndefined()
    expect(fs.existsSync(runRoot)).toBe(true)
    expect(fs.existsSync(dirs.data)).toBe(true)
    expect(fs.existsSync(dirs.tmp)).toBe(true)
  })

  it("restoreEnv returns every overridden key to its pre-load value/unset state", () => {
    restoreEnv()
    for (const key of ENV_KEYS) {
      expect(process.env[key], key).toBe(envBefore[key])
      const value = process.env[key]
      if (typeof value === "string") expect(value.includes(runRoot), key).toBe(false)
    }
    for (const [key, value] of armedChecks) {
      if (value !== undefined) expect(process.env[key], key).not.toBe(value)
    }
  })

  it("registerBenchmarkEnv re-arms env and the run root after a restore", () => {
    // Simulate a previous file's dispose: env restored, run root gone.
    restoreEnv()
    cleanupRunRoot()
    expect(fs.existsSync(runRoot)).toBe(false)
    for (const [key, value] of armedChecks) {
      if (value !== undefined) expect(process.env[key], key).not.toBe(value)
    }
    const dispose = registerBenchmarkEnv()
    for (const [key, value] of armedChecks) expect(process.env[key], key).toBe(value)
    for (const key of unsetChecks) expect(process.env[key], key).toBeUndefined()
    expect(fs.existsSync(runRoot)).toBe(true)
    expect(fs.existsSync(dirs.data)).toBe(true)
    expect(fs.existsSync(dirs.tmp)).toBe(true)
    // Baseline registration (the file-level afterAll) is unchanged: no restore
    // yet, so the env stays armed for the rest of this file.
    dispose()
    for (const [key, value] of armedChecks) expect(process.env[key], key).toBe(value)
  })

  it("cleanupRunRoot removes the root and restoreEnv leaves no runRoot reference", () => {
    cleanupRunRoot()
    expect(fs.existsSync(runRoot)).toBe(false)
    restoreEnv()
    for (const key of ENV_KEYS) {
      expect(process.env[key], key).toBe(envBefore[key])
      const value = process.env[key]
      if (typeof value === "string") expect(value.includes(runRoot), key).toBe(false)
    }
  })
})
