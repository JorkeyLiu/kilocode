#!/usr/bin/env node
/**
 * CLI entry for the P0 benchmark segment merger.
 *
 * Thin entry over script/p0-bench/merge-run.ts (compiled to CJS by
 * script/p0-bench-merge-launch.mjs and executed under Node). Pure merge CLI —
 * no VS Code, no benchmark samples, no live launch; it only reads existing
 * segment JSONL evidence and writes a new merged evidence dir. Exit codes:
 * 0 complete, 2 incomplete (valid artifact emitted, baselineComplete=false),
 * 1 validation error (nothing emitted).
 */

import { runMergeCli } from "./p0-bench/merge-run"

process.exit(runMergeCli(process.argv.slice(2), process.cwd()))
