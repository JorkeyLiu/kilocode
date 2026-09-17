/**
 * Focused boundary/order tests for the CLI bootstrap P0 instrumentation
 * (`src/index.ts` + `src/kilocode/cli/setup.ts`).
 *
 * The test inspects source text only — it never imports the CLI entry or
 * executes bootstrap logic, so it cannot copy business logic. It proves:
 * - every required stage exists once as a `P0Perf.span("<snake_case>")` site,
 * - emit sites are ordered around the unchanged business awaits (boundary),
 * - telemetry identity runs in the background under explicit KiloCli
 *   ownership (no awaited network before the handler, no detached work).
 */

import { describe, expect, it } from "bun:test"
import path from "path"
import fs from "fs"

const SRC = path.join(import.meta.dir, "../../src")
const INDEX = fs.readFileSync(path.join(SRC, "index.ts"), "utf8")
const SETUP = fs.readFileSync(path.join(SRC, "kilocode/cli/setup.ts"), "utf8")

function indexOf(hay: string, needle: string): number {
  const at = hay.indexOf(needle)
  expect(at, `missing ${needle}`).toBeGreaterThan(-1)
  return at
}

describe("cli P0 instrumentation boundaries", () => {
  it("reuses the existing P0Perf API and stays default-off", () => {
    expect(INDEX).toContain('from "@/kilocode/perf/instrument"')
    expect(SETUP).toContain('from "@/kilocode/perf/instrument"')
    // No new telemetry service or storage: only span()/mark() call-sites.
    expect(INDEX).not.toContain("PostHog")
    expect(SETUP).not.toContain("PostHog")
    for (const src of [INDEX, SETUP]) {
      for (const m of src.matchAll(/P0Perf\.(span|mark)\("([^"]+)"\)/g)) {
        expect(m[2]).toMatch(/^[a-z][a-z0-9_]*$/)
      }
    }
  })

  it("index.ts distinguishes construct, parse, log_init, heap_start in order", () => {
    const construct = indexOf(INDEX, 'P0Perf.span("cli_construct")')
    const parse = indexOf(INDEX, 'P0Perf.span("cli_parse")')
    const log = indexOf(INDEX, 'P0Perf.span("log_init")')
    const heap = indexOf(INDEX, 'P0Perf.span("heap_start")')
    // Construction (yargs + KiloCli.register) precedes parse overall.
    expect(construct).toBeLessThan(parse)
    // Middleware init order is preserved under instrumentation.
    expect(log).toBeLessThan(heap)
    expect(INDEX.indexOf("await Log.init")).toBeGreaterThan(log)
    expect(INDEX.indexOf("Heap.start()")).toBeGreaterThan(heap)
    // Boundaries: construct ends before parse starts; parse ends before shutdown.
    expect(INDEX.indexOf("constructTimer.end()")).toBeGreaterThan(construct)
    expect(INDEX.indexOf("constructTimer.end()")).toBeLessThan(parse)
    expect(INDEX.indexOf("parseTimer.end()")).toBeGreaterThan(parse)
    expect(INDEX.indexOf("parseTimer.end()")).toBeLessThan(INDEX.indexOf("await KiloCli.shutdown()"))
    // Business calls unchanged.
    expect(INDEX).toContain("await KiloCli.runner()")
    expect(INDEX).toContain("await KiloCli.bootstrap()")
    expect(INDEX).toContain("await KiloCli.shutdown()")
    expect(INDEX).toContain("await cli.parse()")
  })

  it("setup.ts distinguishes runner and bootstrap sub-stages in order", () => {
    const runner = indexOf(SETUP, 'P0Perf.span("cli_runner")')
    expect(SETUP.indexOf("BackgroundProcessRunner.maybe()")).toBeGreaterThan(runner)
    const order = [
      'P0Perf.span("json_migration_bootstrap")',
      'P0Perf.span("config_get_global")',
      'P0Perf.span("telemetry_init")',
      'P0Perf.span("legacy_auth_migration")',
      'P0Perf.span("auth_get")',
      'P0Perf.span("telemetry_identity_update")',
      'P0Perf.span("telemetry_track_cli_start")',
    ]
    let prev = -1
    for (const site of order) {
      const at = indexOf(SETUP, site)
      expect(at).toBeGreaterThan(prev)
      prev = at
    }
    // Boundaries: each local span starts before its business await/call and ends after.
    // Note: `s.get("kilo")` also appears inside the legacy-migration callbacks,
    // so the auth_get boundary is pinned to the dedicated `const found` fetch.
    const pairs: Array<[string, string]> = [
      ['P0Perf.span("json_migration_bootstrap")', "JsonMigration.bootstrap()"],
      ['P0Perf.span("config_get_global")', "c.getGlobal()"],
      ['P0Perf.span("telemetry_init")', "Telemetry.init("],
      ['P0Perf.span("legacy_auth_migration")', "migrateLegacyKiloAuth("],
      ['P0Perf.span("auth_get")', "const found = await"],
    ]
    for (const [span, call] of pairs) {
      expect(SETUP.indexOf(call)).toBeGreaterThan(SETUP.indexOf(span))
    }
    // Identity dispatch span measures background start only: it ends right
    // after dispatch and never claims network completion.
    const dispatch = indexOf(SETUP, 'P0Perf.span("telemetry_identity_update")')
    expect(SETUP.indexOf("new AbortController()")).toBeGreaterThan(dispatch)
    expect(SETUP.indexOf("dispatchTimer.end()")).toBeGreaterThan(dispatch)
    expect(SETUP).toContain("config_get_global_skip")
  })

  it("setup.ts owns identity background work without blocking the handler", () => {
    // Env fast path: explicit all/off skips the global config read.
    expect(SETUP).toContain("isExplicitTelemetryLevel")
    expect(SETUP).toContain("KILO_TELEMETRY_LEVEL")
    // Explicit owner: AbortController plus retained promise, cancellable and awaitable.
    expect(SETUP).toContain("AbortController")
    expect(SETUP).toContain("pending")
    expect(SETUP).toContain(".abort()")
    // No detached work: never void-and-lose, never forkDetach.
    expect(SETUP).not.toContain("forkDetach")
    expect(SETUP).not.toMatch(/void\s+run\b/)
    // Signal flows through the fetch chain.
    expect(SETUP).toContain("signal")
    // Shutdown settles the owned task before exit/export/telemetry shutdown.
    const settle = indexOf(SETUP, "settleOwned")
    expect(SETUP.indexOf("trackCliExit")).toBeGreaterThan(settle)
    expect(SETUP.indexOf("SessionExport.shutdown()")).toBeGreaterThan(settle)
    expect(SETUP.indexOf("Telemetry.shutdown(")).toBeGreaterThan(settle)
    // CLI_START stays single-shot and follows identity settle when authed.
    expect(SETUP).toContain("markStarted")
    expect(SETUP).toContain("telemetry_identity_settle")
  })
})
