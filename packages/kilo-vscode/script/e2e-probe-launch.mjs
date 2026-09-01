#!/usr/bin/env node
/**
 * Launcher for the E2E probe. Compiles script/e2e-probe.ts to CJS under
 * out/ and executes it with Node.
 *
 * Node (not Bun) is required: Playwright's connectOverCDP WebSocket transport
 * hangs under Bun's runtime against VS Code's Electron CDP endpoint.
 *
 * Usage:
 *   node script/e2e-probe-launch.mjs [--no-build]      (all scenarios)
 *   KILO_E2E_SCENARIO=tab-close         node script/e2e-probe-launch.mjs
 *   KILO_E2E_SCENARIO=child-task-order  node script/e2e-probe-launch.mjs
 *   KILO_E2E_SCENARIO=variant-memory    node script/e2e-probe-launch.mjs
 *   KILO_E2E_SCENARIO=topic-navigation  node script/e2e-probe-launch.mjs
 *   KILO_E2E_SCENARIO=real-session      node script/e2e-probe-launch.mjs
 *   KILO_E2E_SCENARIO=real-completed    node script/e2e-probe-launch.mjs
 *   KILO_E2E_SCENARIO=real-overflow     node script/e2e-probe-launch.mjs
 *   KILO_E2E_SCENARIO=real-restart      node script/e2e-probe-launch.mjs
 *   KILO_E2E_SCENARIO=sidebar-removal   node script/e2e-probe-launch.mjs
 *   KILO_E2E_SCENARIO=worktree-removal  node script/e2e-probe-launch.mjs
 *   KILO_E2E_SCENARIO=cloud-claw-removal node script/e2e-probe-launch.mjs
 *   KILO_E2E_SCENARIO=p3-4-removal      node script/e2e-probe-launch.mjs
 *
 * KILO_E2E_SCENARIO (all | tab-close | child-task-order | variant-memory |
 * topic-navigation | real-session | real-completed | real-overflow |
 * real-restart | sidebar-removal | worktree-removal | cloud-claw-removal |
 * p3-4-removal, default all) is
 * forwarded to the probe and the extension-host runner via the environment;
 * the probe validates it before VS Code launches.
 *
 * Durable evidence handoff (KILO_E2E_EVIDENCE_DIR, test-only): when the env
 * var is set, this launcher owns the capture log and the atomic finalize:
 *
 *   1. validates the destination fail-fast (absolute, parent exists,
 *      absent-or-empty — never overwrites a pre-existing dir),
 *   2. creates a sibling staging dir (`.${dest}.staging-<rand>`) and tees the
 *      probe's stdout+stderr into `<staging>/run.log` LIVE (the probe and its
 *      spawned VS Code all write to fd 1/2, so the whole run is captured),
 *   3. the probe copies the run-owned evidence set into the staging dir and
 *      writes manifest.json + the `evidence-ready` marker before exiting,
 *   4. after the probe exits and its stdio pipes close (deterministic — no
 *      polling race), this launcher appends the run.log entry to the manifest
 *      (byte size + sha256), then atomically renames staging → destination so
 *      an external poller sees either nothing or the complete evidence set.
 *
 * Without KILO_E2E_EVIDENCE_DIR the launcher behaves exactly as before
 * (spawnSync + inherited stdio).
 */
import { build } from "esbuild"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { randomBytes } from "node:crypto"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { basename, dirname, join, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const outfile = join(root, "out", "e2e-probe.cjs")

const evidenceEnv = process.env.KILO_E2E_EVIDENCE_DIR

/**
 * Force jsonc-parser to resolve to its ESM module entry instead of the UMD
 * main entry. The UMD bundle uses runtime `require2("./impl/format")` calls
 * that fail at extension-host load time because the impl submodules are not
 * shipped in dist. The ESM entry statically imports its dependencies, so
 * esbuild can bundle them all into a single file.
 * Mirrors packages/kilo-vscode/esbuild.js jsoncParserEsmPlugin (lines ~67-76).
 */
const jsoncParserEsmPlugin = {
  name: "jsonc-parser-esm",
  setup(build) {
    build.onResolve({ filter: /^jsonc-parser$/ }, () => {
      const require = createRequire(import.meta.url)
      const pkg = require.resolve("jsonc-parser/package.json")
      const dir = dirname(pkg)
      return { path: join(dir, "lib", "esm", "main.js") }
    })
  },
}

function fail(message) {
  console.error(`[e2e-launch] FAIL: ${message}`)
  process.exit(1)
}

// Validate the evidence destination fail-fast BEFORE any build or VS Code
// launch (a bad destination must never spawn an owned Electron process).
let dest
if (evidenceEnv) {
  dest = resolve(evidenceEnv)
  if (!dest.startsWith("/")) fail(`KILO_E2E_EVIDENCE_DIR must be an absolute path, got "${evidenceEnv}"`)
  const parent = dirname(dest)
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    fail(`KILO_E2E_EVIDENCE_DIR parent does not exist or is not a directory: "${parent}"`)
  }
  if (existsSync(dest)) {
    if (!statSync(dest).isDirectory()) fail(`KILO_E2E_EVIDENCE_DIR exists but is not a directory: "${dest}"`)
    const entries = readdirSync(dest)
    if (entries.length > 0) {
      fail(
        `KILO_E2E_EVIDENCE_DIR exists and is not empty (${entries.slice(0, 5).join(", ")}...) — refusing to overwrite`,
      )
    }
  }
}

await build({
  entryPoints: [join(here, "e2e-probe.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["@vscode/test-electron", "@playwright/test", "esbuild"],
  define: { __KILO_E2E_BUNDLE__: "true" },
  outfile,
  logLevel: "silent",
  plugins: [jsoncParserEsmPlugin],
})

// Pin the CWD to the package root so @vscode/test-electron's auto-download
// (when no VSCODE_TEST_EXECUTABLE/cache exists) always lands in the
// deterministic packages/kilo-vscode/.vscode-test regardless of where the
// launcher was invoked from.
if (!evidenceEnv) {
  const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, KILO_E2E_ROOT: root },
  })
  process.exit(result.status ?? 1)
}

// --- Durable evidence handoff (launcher-owned capture log + atomic finalize) ---
// The manifest schema literal mirrors script/e2e-evidence.ts (the harness owns
// the authoritative shape; this file only appends the launcher-owned entry).

const staging = join(dirname(dest), `.${basename(dest)}.staging-${randomBytes(4).toString("hex")}`)
mkdirSync(staging, { recursive: true })

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

console.log(`[e2e-launch] evidence destination: ${dest} (staging ${staging}, run.log capture on)`)
const logStream = createWriteStream(join(staging, "run.log"))
const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, KILO_E2E_ROOT: root, KILO_E2E_EVIDENCE_DIR: dest, KILO_E2E_EVIDENCE_STAGING: staging },
  stdio: ["inherit", "pipe", "pipe"],
})
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk)
  logStream.write(chunk)
})
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk)
  logStream.write(chunk)
})

// `close` (not `exit`) guarantees the stdio pipes are drained, so run.log is
// complete before the finalize reads it — deterministic, no polling.
const code = await new Promise((resolve) => child.on("close", resolve))
await new Promise((resolve) => logStream.end(resolve))

// Finalize: append the capture-log entry, verify the probe's evidence copy
// completed (evidence-ready marker), and atomically rename staging -> dest.
const logFile = join(staging, "run.log")
const manifestPath = join(staging, "manifest.json")
const ready = existsSync(join(staging, "evidence-ready"))
let manifest
if (existsSync(manifestPath)) {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
} else {
  manifest = {
    schema: "kilo-e2e-evidence/1",
    run: { fixtureId: "<probe-did-not-report>", scenario: process.env.KILO_E2E_SCENARIO ?? "<unset>" },
    destination: dest,
    required: [],
    files: [],
    missing: [],
    malformed: [],
    notes: ["probe exited before writing the evidence manifest (failed fast or crashed)"],
    captureLog: null,
    status: "failed",
    validated: false,
    finalizedAt: null,
  }
}
const stats = statSync(logFile)
const entry = {
  source: "launcher:probe stdout+stderr",
  sourceRel: "launcher:run.log",
  dest: "run.log",
  bytes: stats.size,
  sha256: hashFile(logFile),
}
manifest.files.push(entry)
manifest.captureLog = entry
if (!ready && manifest.status === "complete") {
  manifest.status = "failed"
  manifest.notes.push("evidence-ready marker missing: the probe did not complete its evidence copy")
}
manifest.finalizedAt = new Date().toISOString()
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
try {
  renameSync(staging, dest)
} catch (err) {
  fail(`could not rename staging into destination: ${err instanceof Error ? err.message : String(err)}`)
}
console.log(
  `[e2e-launch] evidence finalized: ${dest}/manifest.json (status ${manifest.status}, ${manifest.files.length} files, run.log ${stats.size} bytes)`,
)
process.exit(code ?? 1)
