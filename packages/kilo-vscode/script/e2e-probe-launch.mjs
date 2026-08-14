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
 *
 * KILO_E2E_SCENARIO (all | tab-close | child-task-order | variant-memory |
 * topic-navigation, default all) is forwarded to the probe and the
 * extension-host runner via the environment; the probe validates it before VS
 * Code launches.
 */
import { build } from "esbuild"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const outfile = join(root, "out", "e2e-probe.cjs")

await build({
  entryPoints: [join(here, "e2e-probe.ts")],
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
