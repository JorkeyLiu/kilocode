#!/usr/bin/env node
/**
 * Launcher for the P0 benchmark segment merger CLI. Compiles
 * script/p0-bench-merge.ts to CJS under out/ and executes it with Node,
 * mirroring the e2e launchers (script/e2e-p0-bench-launch.mjs).
 *
 * Pure merge CLI — no VS Code, no benchmark samples, no live launch; a help
 * invocation exits before any read/write.
 *
 * Usage:
 *   node script/p0-bench-merge-launch.mjs --segments <a.jsonl> <b.jsonl> [--out <dir>] [--required-samples 5]
 *   (package shortcut: `bun run test:p0-bench:merge`.)
 */
import { build } from "esbuild"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const outfile = join(root, "out", "p0-bench-merge.cjs")

await build({
  entryPoints: [join(here, "p0-bench-merge.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["@vscode/test-electron", "@playwright/test", "esbuild"],
  outfile,
  logLevel: "silent",
})

// Pin the CWD/root to the package root so the repo-root and git-freeze
// resolution is deterministic regardless of where the launcher was invoked.
const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, KILO_E2E_ROOT: root },
})
process.exit(result.status ?? 1)
