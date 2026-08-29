#!/usr/bin/env bun
// kilocode_change - new file

/**
 * Prevents new service-local runtimes in shared Effect modules while the
 * remaining Kilo Promise facades are migrated away. It also prevents tests
 * from reaching through the global application runtime unless the integration
 * boundary is explicitly classified.
 *
 * Existing sites are allowed only when classified below. Remove transitional
 * entries after their migration lands so later reintroductions fail CI.
 */

import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const DIR = path.join(ROOT, "packages", "opencode", "src")
const TEST_DIR = path.join(ROOT, "packages", "opencode", "test")
const PATTERN = /makeRuntime\s*\(\s*Service\s*,/g
const TEST_PATTERN = /\bAppRuntime\b/g

/**
 * Legacy AsyncLocalStorage bridge sites. The ALS scope only propagates into
 * async continuations created inside `storage.run`, so an effect whose
 * Promise-side code reads `Instance.current` must be started in that callback
 * (see `src/kilocode/effect/als-bridge.ts`). New ad hoc nesting anywhere in
 * `src` — Kilo-owned or shared — fails CI unless classified here.
 */
const BRIDGE_PATTERN = /instanceContext\.provide\([^)]*,\s*\(\)\s*=>\s*Effect\.run(Promise|Fork)\(/g
const bridgeAllow: Record<string, { count: number; reason: string }> = {
  "kilocode/effect/als-bridge.ts": {
    count: 1,
    reason: "canonical legacy ALS bridge (runInInstance): Effect run bound to the AsyncLocalStorage instance scope",
  },
  "project/instance-store.ts": {
    count: 1,
    reason: "pre-existing InstanceStore ALS bridge for instance boot (bootstrap under Instance context)",
  },
}

const allow: Record<string, string> = {
  "bus/index.ts": "core bus callback and synchronous runtime boundary",
  "cli/cmd/run/runtime.boot.ts": "direct run startup resolver runtime boundary",
  "cli/cmd/run/stream.transport.ts": "per-subscription direct run transport runtime boundary",
  "cli/cmd/run/variant.shared.ts": "direct run variant persistence runtime boundary with test filesystem injection",
  "cli/cmd/tui/config/tui.ts": "separately tracked TUI config facade",
  "installation/index.ts": "existing installation facade outside #10655",
}

const testAllow: Record<string, { count: number; reason: string }> = {
  "kilocode/config-resilience.test.ts": { count: 4, reason: "existing runtime integration test" },
  "kilocode/config-validation.test.ts": { count: 2, reason: "existing runtime integration test" },
  "kilocode/cli-shutdown.test.ts": { count: 1, reason: "mocked runtime boundary for shutdown unit tests" },
  "kilocode/plan-followup.test.ts": { count: 3, reason: "existing runtime integration test" },
  "kilocode/session-compaction-chunks.test.ts": {
    count: 2,
    reason: "disk-backed instance integration test cleanup",
  },
  "kilocode/session-fork-remap.test.ts": {
    count: 2,
    reason: "disk-backed instance integration test cleanup",
  },
  "kilocode/session/platform-attribution.test.ts": { count: 2, reason: "existing runtime integration test" },
  "kilocode/session-prompt-queue.test.ts": { count: 6, reason: "prompt queue legacy instance bridge regression" },
  "server/experimental-session-list.test.ts": { count: 2, reason: "Kilo session list integration test" },
  "kilocode/server/listener-runtime.test.ts": { count: 4, reason: "listener and AppRuntime integration test" },
  "kilocode/server/config-rebuild-stream.test.ts": {
    count: 3,
    reason: "in-process server and AppRuntime integration test (global writer vs unseen-directory PATCH intake regression)",
  },
  "kilocode/server/config-transaction.test.ts": {
    count: 29,
    reason: "production AppRuntime integration test (transaction, lock interruption, first-file creation race, held stream + real Server.listen)",
  },
  "kilocode/server/config-overlay-lifecycle.test.ts": {
    count: 4,
    reason: "production AppRuntime integration test for cold overlay rebuild lifecycle",
  },
  "kilocode/server/drain-control.test.ts": {
    count: 2,
    reason: "production AppRuntime integration test for the drain-control snapshot admission lane",
  },
  "kilocode/server/custom-provider-delete.test.ts": {
    count: 10,
    reason: "production AppRuntime integration test (shared memoized seeding/assertion, ticket interruption, deferred final events boundary)",
  },
  "kilocode/server/custom-provider-save.test.ts": {
    count: 11,
    reason: "production AppRuntime integration test (shared memoized seeding/assertion, deferred final events boundary, gate ticket interruption)",
  },
  "preload.ts": {
    count: 4,
    reason: "test preload harness: dispose the process-wide AppRuntime Config service before per-process data-dir cleanup",
  },
  "kilocode/config/config-snapshot.test.ts": { count: 3, reason: "production AppRuntime config snapshot integration test" },
  "tool/recall.test.ts": { count: 11, reason: "existing runtime integration test" },
  "kilocode/session/cancel-queued-b0.test.ts": {
    count: 55,
    reason: "B0 durable cancelQueued integration test via AppRuntime and InstanceRef (LOCK-301..307 bounded corrections)",
  },
}

const owned = (file: string) => file.startsWith("kilocode/") || file.startsWith("kilo-sessions/")
const hits: Array<{ file: string; line: number }> = []
const glob = new Bun.Glob("**/*.ts")

for (const file of glob.scanSync({ cwd: DIR, onlyFiles: true })) {
  if (owned(file)) continue
  const text = await Bun.file(path.join(DIR, file)).text()
  for (const match of text.matchAll(PATTERN)) {
    const line = text.slice(0, match.index ?? 0).split("\n").length
    hits.push({ file, line })
  }
}

const invalid = hits.filter((hit) => !allow[hit.file])
const drift = Object.entries(allow).flatMap(([file, reason]) => {
  const count = hits.filter((hit) => hit.file === file).length
  if (count === 1) return []
  return [`  packages/opencode/src/${file}: expected 1 classified site, found ${count} (${reason})`]
})

const bridgeHits: Array<{ file: string; line: number }> = []
for (const file of glob.scanSync({ cwd: DIR, onlyFiles: true })) {
  const text = await Bun.file(path.join(DIR, file)).text()
  for (const match of text.matchAll(BRIDGE_PATTERN)) {
    const line = text.slice(0, match.index ?? 0).split("\n").length
    bridgeHits.push({ file, line })
  }
}
const bridgeInvalid = bridgeHits.filter((hit) => !bridgeAllow[hit.file])
const bridgeDrift = Object.entries(bridgeAllow).flatMap(([file, entry]) => {
  const count = bridgeHits.filter((hit) => hit.file === file).length
  if (count === entry.count) return []
  return [`  packages/opencode/src/${file}: expected ${entry.count} classified ALS bridge site(s), found ${count} (${entry.reason})`]
})

const testHits: Array<{ file: string; line: number }> = []
for (const file of glob.scanSync({ cwd: TEST_DIR, onlyFiles: true })) {
  const text = await Bun.file(path.join(TEST_DIR, file)).text()
  for (const match of text.matchAll(TEST_PATTERN)) {
    const line = text.slice(0, match.index ?? 0).split("\n").length
    testHits.push({ file, line })
  }
}

const testInvalid = testHits.filter((hit) => !testAllow[hit.file])
const testDrift = Object.entries(testAllow).flatMap(([file, entry]) => {
  const count = testHits.filter((hit) => hit.file === file).length
  if (count === entry.count) return []
  return [
    `  packages/opencode/test/${file}: expected ${entry.count} classified reference(s), found ${count} (${entry.reason})`,
  ]
})

if (invalid.length > 0 || drift.length > 0 || testInvalid.length > 0 || testDrift.length > 0 || bridgeInvalid.length > 0 || bridgeDrift.length > 0) {
  if (invalid.length > 0) {
    console.error("Found unclassified service-local Effect runtimes in shared opencode modules:")
    for (const hit of invalid) console.error(`  packages/opencode/src/${hit.file}:${hit.line}`)
    console.error("")
  }
  if (drift.length > 0) {
    console.error("Classified service-local runtime exceptions no longer match the current source:")
    for (const item of drift) console.error(item)
    console.error("")
  }
  if (bridgeInvalid.length > 0) {
    console.error("Found unclassified legacy AsyncLocalStorage bridge sites:")
    for (const hit of bridgeInvalid) console.error(`  packages/opencode/src/${hit.file}:${hit.line}`)
    console.error("")
  }
  if (bridgeDrift.length > 0) {
    console.error("Classified legacy AsyncLocalStorage bridge sites no longer match the current source:")
    for (const item of bridgeDrift) console.error(item)
    console.error("")
  }
  if (testInvalid.length > 0) {
    console.error("Found unclassified AppRuntime use in opencode tests:")
    for (const hit of testInvalid) console.error(`  packages/opencode/test/${hit.file}:${hit.line}`)
    console.error("")
  }
  if (testDrift.length > 0) {
    console.error("Classified test AppRuntime exceptions no longer match the current source:")
    for (const item of testDrift) console.error(item)
    console.error("")
  }
  console.error("Do not add Promise facades to shared Effect services or global AppRuntime dependencies to tests.")
  console.error("Yield services directly in scoped layers, or classify intentional integration boundaries explicitly.")
  console.error("Remove migrated exceptions, or classify intentional runtime changes with an explicit reason.")
  console.error("Do not add ad hoc instanceContext.provide + Effect.runPromise nesting; use runInInstance (als-bridge).")
  process.exit(1)
}

console.log(
  `check-opencode-promise-facades: ${hits.length} classified runtime site(s), ${bridgeHits.length} classified ALS bridge site(s), ${testHits.length} classified test reference(s), no runtime drift found.`,
)
