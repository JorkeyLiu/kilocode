/**
 * Thin entry for the backend P0 benchmark CLI.
 *
 * Run from packages/opencode:
 *   bun run bench:p0 -- --scenarios 6,12,13 --samples 3 --warmup 0
 *
 * The environment isolation module (`test/benchmark/environment.ts`) is the
 * first import inside the CLI entry itself, so every kilo module sees the
 * run-owned env before it snapshots it.
 */
import "../test/benchmark/index"
