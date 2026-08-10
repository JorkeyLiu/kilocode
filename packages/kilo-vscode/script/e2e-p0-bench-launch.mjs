#!/usr/bin/env node
/**
 * Launcher for the P0 benchmark harness. Compiles script/e2e-p0-bench.ts to
 * CJS under out/ and executes it with Node.
 *
 * Node (not Bun) is required: Playwright's connectOverCDP WebSocket transport
 * hangs under Bun's runtime against VS Code's Electron CDP endpoint.
 *
 * Usage:
 *   node script/e2e-p0-bench-launch.mjs [--no-build]
 *   node script/e2e-p0-bench-launch.mjs --scenarios 1,5,10 --samples 3 --warmup 1
 *   (package shortcut: `bun run test:p0-bench`.)
 *
 * Scenario selection (--scenarios, default 1,2,3,4,5,10) accepts P0 numbers
 * or names: 1=cold-start 2=warm-view 3=no-provider 4=custom-provider
 * 5=many-agent-mcp 10=session-switch.
 */
import { build } from "esbuild"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const outfile = join(root, "out", "e2e-p0-bench.cjs")

await build({
  entryPoints: [join(here, "e2e-p0-bench.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["@vscode/test-electron", "@playwright/test", "esbuild"],
  outfile,
  logLevel: "silent",
})

// Pin the CWD to the package root so @vscode/test-electron's auto-download
// (when no VSCODE_TEST_EXECUTABLE/cache exists) always lands in the
// deterministic packages/kilo-vscode/.vscode-test regardless of where the
// launcher was invoked from.
const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, KILO_E2E_ROOT: root },
})
process.exit(result.status ?? 1)
