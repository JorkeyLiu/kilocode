/**
 * Run-owned environment isolation for the backend P0 benchmark.
 *
 * MUST be the first module imported in the benchmark entry chain (index.ts,
 * script/p0-benchmark.ts, and the focused benchmark tests). The modules that
 * snapshot process.env at load time are: `@opencode-ai/core/flag/flag`
 * (KILO_DB, KILO_PURE, ...), `@opencode-ai/core/global` (XDG_* → Path.data/
 * config/log/...), `@opencode-ai/core/database/database` (KILO_DB resolution)
 * and `@/kilocode/perf/instrument` (`KILO_P0_PERF` → enabled once). If any of
 * them evaluates before these variables are set, the benchmark writes to the
 * real user state and measures the wrong (disabled) instrumentation.
 *
 * Env hygiene: `bun test` executes every test file in ONE process, so a
 * benchmark file that finishes must not leave HOME/XDG/TMPDIR/KILO_DB/...
 * pointing at its (now removed) run root for the next file. Each benchmark
 * test file calls `registerBenchmarkEnv()` at top level and hands the returned
 * dispose to `afterAll`; the LAST registered benchmark file to finish restores
 * the pre-load env and removes the run root. The CLI entry never registers —
 * it owns the whole process, removes the run root itself, and exits.
 *
 * This module only uses node builtins — it must never import a kilo module.
 */

import os from "node:os"
import path from "node:path"
import fs from "node:fs"

/** System temp root captured BEFORE TMPDIR is overridden (survives run cleanup). */
export const systemTmp = os.tmpdir()

/** Run-owned root (one per process). Everything the benchmark creates lives here. */
export const runRoot = path.join(os.tmpdir(), `kilo-p0-backend-${process.pid}`)

export const dirs = {
  home: runRoot,
  data: path.join(runRoot, "data"),
  config: path.join(runRoot, "config"),
  state: path.join(runRoot, "state"),
  cache: path.join(runRoot, "cache"),
  tmp: path.join(runRoot, "tmp"),
}

/** Env keys this module overrides (or unsets) at load; restored by `restoreEnv`. */
export const ENV_KEYS = [
  "KILO_P0_PERF",
  "TMPDIR",
  "HOME",
  "KILO_TEST_HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "KILO_DB",
  "KILO_PURE",
  "KILO_DISABLE_AUTOUPDATE",
  "KILO_DISABLE_AUTOCOMPACT",
  "KILO_DISABLE_MODELS_FETCH",
  "KILO_DISABLE_LSP_DOWNLOAD",
  "KILO_DISABLE_EMBEDDED_WEB_UI",
  "KILO_AUTH_CONTENT",
  "KILO_SERVER_PASSWORD",
  "KILO_SERVER_USERNAME",
] as const

type EnvMap = Record<string, string | undefined>

/** Pre-load values (restore target); captured before any override below. */
export const envBefore: EnvMap = {}
for (const key of ENV_KEYS) envBefore[key] = process.env[key]

function applyEnv(values: EnvMap): void {
  for (const key of ENV_KEYS) {
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

/** Benchmark values; re-applied by `registerBenchmarkEnv` for later files. */
const benchEnv: EnvMap = {
  // P0 instrumentation on: every mark/span becomes a `service=p0-perf` record.
  KILO_P0_PERF: "1",
  // Run-owned paths: any module reading HOME/XDG_*/KILO_DB before these are
  // set would resolve the real user profile. os.tmpdir() honors TMPDIR, so
  // fixture tmpdirs land under the run root as well (one `rm -rf` cleans all).
  TMPDIR: dirs.tmp,
  HOME: dirs.home,
  KILO_TEST_HOME: dirs.home,
  XDG_DATA_HOME: dirs.data,
  XDG_CONFIG_HOME: dirs.config,
  XDG_STATE_HOME: dirs.state,
  XDG_CACHE_HOME: dirs.cache,
  // Absolute path → Database.path() uses it verbatim (no kilo data dir).
  KILO_DB: path.join(dirs.data, "kilo-p0.sqlite"),
  // No background work, no plugin discovery/install, no network beyond loopback.
  KILO_PURE: "1",
  KILO_DISABLE_AUTOUPDATE: "1",
  KILO_DISABLE_AUTOCOMPACT: "1",
  KILO_DISABLE_MODELS_FETCH: "1",
  KILO_DISABLE_LSP_DOWNLOAD: "1",
  KILO_DISABLE_EMBEDDED_WEB_UI: "1",
  KILO_AUTH_CONTENT: "{}",
  // Unsecured server: if the parent shell exported a server password, the
  // listener would require basic auth and every benchmark request would 401.
  KILO_SERVER_PASSWORD: undefined,
  KILO_SERVER_USERNAME: undefined,
}

function ensureRunDirs(): void {
  // Global.Path runs `ensureRealDir` for data/config/state/tmp/log/bin/repos
  // at module load; create the parents now so those succeed under the run root.
  for (const dir of [dirs.data, dirs.config, dirs.state, dirs.cache, dirs.tmp]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

applyEnv(benchEnv)
ensureRunDirs()

/**
 * Restore every overridden env key to its pre-load value (or unset state).
 * Idempotent; safe to call multiple times.
 */
export function restoreEnv(): void {
  applyEnv(envBefore)
}

/**
 * Remove the run-owned root (idempotent). Called from CLI early exits (help,
 * invalid flags), from runCampaign cleanup, and from the last benchmark test
 * file's dispose — the root is created at module load, so even a
 * validation-only invocation must remove it before exiting.
 */
export function cleanupRunRoot(): void {
  fs.rmSync(runRoot, { recursive: true, force: true })
}

let activeFiles = 0

/**
 * Benchmark test file registration. Call at top level and pass the returned
 * dispose to `afterAll`:
 *
 *   afterAll(registerBenchmarkEnv())
 *
 * Registering re-arms the run-owned env (a previous benchmark file's dispose
 * may have restored it) and recreates the run-root dirs; disposing decrements
 * the counter and, when the LAST registered benchmark file finishes, restores
 * the pre-load env and removes the run root — so later non-benchmark test
 * files in the same `bun test` process never inherit removed runRoot paths.
 * The CLI entry (index.ts / script/p0-benchmark.ts) never registers: it owns
 * the whole process, removes the run root itself, and exits.
 */
export function registerBenchmarkEnv(): () => void {
  applyEnv(benchEnv)
  ensureRunDirs()
  activeFiles += 1
  return () => {
    activeFiles -= 1
    if (activeFiles <= 0) {
      activeFiles = 0
      restoreEnv()
      cleanupRunRoot()
    }
  }
}
