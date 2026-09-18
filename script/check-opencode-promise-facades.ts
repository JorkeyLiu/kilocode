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
  "kilocode/server/listener-runtime.test.ts": { count: 1, reason: "listener and AppRuntime integration test" },
  "kilocode/server/config-rebuild-stream.test.ts": {
    count: 3,
    reason:
      "in-process server and AppRuntime integration test (global writer vs unseen-directory PATCH intake regression)",
  },
  "kilocode/server/config-transaction.test.ts": {
    count: 29,
    reason:
      "production AppRuntime integration test (transaction, lock interruption, first-file creation race, held stream + real Server.listen)",
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
    reason:
      "production AppRuntime integration test (shared memoized seeding/assertion, ticket interruption, deferred final events boundary)",
  },
  "kilocode/server/custom-provider-save.test.ts": {
    count: 11,
    reason:
      "production AppRuntime integration test (shared memoized seeding/assertion, deferred final events boundary, gate ticket interruption)",
  },
  "preload.ts": {
    count: 4,
    reason:
      "test preload harness: dispose the process-wide AppRuntime Config service before per-process data-dir cleanup",
  },
  "kilocode/config/config-snapshot.test.ts": {
    count: 3,
    reason: "production AppRuntime config snapshot integration test",
  },
  "tool/recall.test.ts": { count: 11, reason: "existing runtime integration test" },
  "kilocode/session/cancel-queued-b0.test.ts": {
    count: 55,
    reason:
      "B0 durable cancelQueued integration test via AppRuntime and InstanceRef (LOCK-301..307 bounded corrections)",
  },
  "kilocode/server/fd-carrier.test.ts": {
    count: 10,
    reason:
      "B1 fd-carrier integration test via AppRuntime for real B0 dispatch and B2 sessionUpdate replay via carrier (carrier + HTTP fallback, positive persisted replay via createFdCarrier)",
  },
  "kilocode/session/session-update-b2.test.ts": {
    count: 131,
    reason:
      "B2 durable sessionUpdate integration test via AppRuntime and InstanceRef (title-only, replay, stale, scope, validation, rollback, legacy, HTTP, successive distinct, replay after mutation, private read-only, context mismatch, malformed, not-found, fd-carrier, HTTP unknown fields, partial identity, private explicit null, private opId collision, reader-failure replay, barrier, migration snapshot, concurrency, malformed object snapshot, single lease, rollback, omitted-context durable HTTP 400, HTTP concurrent distinct via Server.listen)",
  },
  "kilocode/session/session-update-b2-event.test.ts": {
    count: 146,
    reason:
      "B2 EventV2 atomic propagation integration test via AppRuntime and InstanceRef (concurrent distinct, fault-injection rollback, aggregateEvents propagation, prior/future generation, same-key replay, seq monotonic, location regressions, notify isolation, deterministic aggregate rollback, present invalid resultSnapshot fail-closed, empty-string present invalid, JSON null text present invalid)",
  },
  "kilocode/session/session-fork-b3.test.ts": {
    count: 34,
    reason:
      "B3 durable fork integration test via AppRuntime and InstanceRef (success, replay, conflict, validation, private replay, HTTP, fd-carrier, canonical identity mismatch/colon)",
  },
  "kilocode/session/session-fork-regression.test.ts": {
    count: 21,
    reason: "B3 fork regression: transcript checkpoint, cross-directory, stale, SDK payload, private validation",
  },
  "kilocode/session/session-fork-additional.test.ts": {
    count: 17,
    reason: "B3 fork additional: cross-directory identity, event, raw unknown-field, SDK generation, private exact",
  },
  "kilocode/session/session-fork-http-mapping.test.ts": {
    count: 14,
    reason:
      "B3 fork HTTP mapping integration test via AppRuntime and InstanceRef (error mapping matrix 400/404/409/500, directory/sessionId/idempotencyKey/opId/barrier cases)",
  },
  "kilocode/session/session-create-b4.test.ts": {
    count: 54,
    reason:
      "B4 durable create integration test via AppRuntime and InstanceRef (success, replay, opId collision, private replay, validation, fd-carrier, HTTP via Server.listen, directory mismatch, parent conflict + private parent conflict, rollback ghost, payload preserve, default route mismatch, token rejection, snapshot consistency, durable no-mutation assertions for private dispatch and fd-carrier replay/no-record, canonical identity mismatch/colon)",
  },
  "kilocode/session/session-fork-persistence.test.ts": {
    count: 65,
    reason:
      "B3 fork persistence boundary integration test via AppRuntime and InstanceRef (success diff carry and replay, diff read failure ghost check, write cleanup, failure ghost)",
  },
  "kilocode/session/session-fork-ownership.test.ts": {
    count: 88,
    reason:
      "B3 fork ownership claim integration test via AppRuntime and InstanceRef (probe fail closed, first/second diff, sandbox, Tx cleanup, preexisting, ID collision, legacy ghost, late failure event aggregate + retry, deterministic cleanup fs failure with warning and retained file)",
  },
  "kilocode/session/session-fork-event-preflight.test.ts": {
    count: 29,
    reason:
      "B3 fork durable event aggregate preflight integration test via AppRuntime and InstanceRef (orphaned EventSequence/EventTable without SessionTable conflict, no FS/DB mutation, preserved event, full no-mutation assertions for both orphaned aggregate and sequence-only cases)",
  },
  "kilocode/session/changefeed-creation.test.ts": {
    count: 50,
    reason:
      "creation changefeed integration test via AppRuntime and InstanceRef (ordinary projector + durable create/fork + fresh import service + CLI aggregate success/rollback/replay)",
  },
  "kilocode/server/fd-carrier-delete.test.ts": {
    count: 7,
    reason:
      "B5 durable delete fd-carrier integration test via AppRuntime (carrier authoritative delete, replay, strict validation without mutation, instance cleanup)",
  },
  "kilocode/session/session-delete-fd-private-first.test.ts": {
    count: 14,
    reason:
      "B5 durable delete FD private-first integration test via AppRuntime and InstanceRef (commit, missing, strict parentSessionId, scope mismatch)",
  },
  "kilocode/session/session-delete-regression.test.ts": {
    count: 15,
    reason:
      "B5 durable delete regression integration test via AppRuntime and InstanceRef (atomic tombstone, conflict, instance cleanup)",
  },
  "kilocode/session/session-delete-concurrent.test.ts": {
    count: 12,
    reason:
      "B5 durable delete concurrent disappearance integration test via AppRuntime and InstanceRef (empty family die, dispatch not-found, no fabricate)",
  },
  "kilocode/session/session-create-fd-private-first.test.ts": {
    count: 15,
    reason:
      "B4 durable create FD private-first integration test via AppRuntime and InstanceRef (atomic create, replay, concurrent)",
  },
  "kilocode/session/session-fork-fd-private-first.test.ts": {
    count: 7,
    reason: "B3 durable fork FD private-first integration test via AppRuntime and InstanceRef (dispatch, replay, list)",
  },
  "server/experimental-session-list-cursor.test.ts": {
    count: 4,
    reason:
      "session list cursor pagination integration test via AppRuntime (equal-updated tie handling, cursor grammar)",
  },
  "server/probe-concurrent-mutation-pagination.test.ts": {
    count: 8,
    reason:
      "probe inter-page mutation pagination observations via AppRuntime (insert/update/delete/archive between pages)",
  },
  "kilocode/server/fd-carrier-private-peer.test.ts": {
    count: 7,
    reason:
      "private peer registry integration test via AppRuntime (same-identity carrier install, CLI->extension request, drop abort, dispose unavailable, conflict keeps old)",
  },
  "kilocode/server/listener-app-sharing.test.ts": {
    count: 9,
    reason:
      "listener standalone topology integration test via the canonical production runtime (two Server.listen transports share SessionStatus with AppRuntime; a local layer cannot prove cross-transport sharing or listener-stop ownership)",
  },
  "kilocode/server/listener-retention-boot.test.ts": {
    count: 7,
    reason:
      "listener retention-boot integration test via the canonical production runtime (retention replay blocked until post-bind gate release with shared AppLayer ownership; a local layer cannot prove the gate topology)",
  },
  "kilocode/server/fd-carrier-permission.test.ts": {
    count: 9,
    reason:
      "fd-carrier permission integration test via the canonical production runtime (real permission dispatch and ticket lifecycle over the production runtime identity with live carriers; a local layer cannot serve the carrier path)",
  },
  "kilocode/server/fd-carrier-suggestion.test.ts": {
    count: 26,
    reason:
      "fd-carrier suggestion integration test via the canonical production runtime (real suggestion create/list/dispatch over the production runtime identity with live carriers; a local layer cannot serve the carrier path)",
  },
  "kilocode/server/fd-carrier-background-stop-session.test.ts": {
    count: 2,
    reason:
      "fd-carrier background stop-session integration test via the canonical production runtime (real instance load for carrier dispatch identity; a local layer cannot serve the carrier path)",
  },
  "kilocode/server/fd-carrier-notebook.test.ts": {
    count: 14,
    reason:
      "fd-carrier notebook integration test via the canonical production runtime (real notebook create/snapshot/dispatch over the production runtime identity with live carriers; a local layer cannot serve the carrier path)",
  },
  "kilocode/server/fd-carrier-pty.test.ts": {
    count: 2,
    reason:
      "fd-carrier PTY integration test via the canonical production runtime (HTTP-created PTY shares the AppLayer-owned PtyServiceMap owner with fd update/remove; a local layer cannot prove the shared-owner topology)",
  },
  "kilocode/pty/pty-map-lifecycle.test.ts": {
    count: 3,
    reason:
      "PTY map lifecycle integration test via the canonical production runtime (HTTP-created PTY reaped by InstanceStore load/dispose and reload through the AppLayer-owned map; a local layer cannot prove production-path invalidation)",
  },
  "kilocode/server/fd-carrier-abort.test.ts": {
    count: 13,
    reason:
      "fd-carrier abort integration test via AppRuntime and InstanceRef (real session create/snapshot/dispatch over the production runtime identity with live carriers)",
  },
  "kilocode/server/fd-carrier-question.test.ts": {
    count: 15,
    reason:
      "fd-carrier question integration test via AppRuntime and InstanceRef (real session create/snapshot/dispatch over the production runtime identity with live carriers)",
  },
  "kilocode/server/fd-carrier-initialize-offer.test.ts": {
    count: 3,
    reason:
      "single production AppRuntime integration test for initialize reverse-capability negotiation via the global registry identity (reverse offer binds supports, close clears); all other capability tests use an isolated PrivatePeer layer",
  },
  "kilocode/canonical-provenance-regression.test.ts": {
    count: 35,
    reason:
      "production AppRuntime canonical provenance regression via AppRuntime and InstanceRef (distinct scopes, duplicate suppression, credential/invalid classes, resolver via Config.Service + resolveFromSnapshot, atomic withConfigSnapshot + withGenerationAdmission pinning, recoverable failures, parse secrecy token, no provenance in public JSON)",
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
  return [
    `  packages/opencode/src/${file}: expected ${entry.count} classified ALS bridge site(s), found ${count} (${entry.reason})`,
  ]
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

if (
  invalid.length > 0 ||
  drift.length > 0 ||
  testInvalid.length > 0 ||
  testDrift.length > 0 ||
  bridgeInvalid.length > 0 ||
  bridgeDrift.length > 0
) {
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
  console.error(
    "Do not add ad hoc instanceContext.provide + Effect.runPromise nesting; use runInInstance (als-bridge).",
  )
  process.exit(1)
}

console.log(
  `check-opencode-promise-facades: ${hits.length} classified runtime site(s), ${bridgeHits.length} classified ALS bridge site(s), ${testHits.length} classified test reference(s), no runtime drift found.`,
)
