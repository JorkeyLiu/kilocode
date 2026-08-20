/**
 * S0 Baseline and Fixtures — P4.2a storage foundation.
 *
 * Verifies fixture construction, ownership relationships, deterministic
 * measurement, and present-system baseline behavior through service APIs
 * (SessionNs.Service) that share the same DB context as session operations.
 *
 * The section 10 sqlite3 CLI commands are frozen as the canonical production
 * measurement surface in s0-fixtures.ts (not executed in tests due to the
 * separate-:memory: SQLite architecture).
 *
 * Does NOT: implement S1-S5, invent R15/R16/R17 values, assert future
 * retention protection, or freeze wire/schema contracts.
 */
import { describe, expect, test as bunTest } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session as SessionNs } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionStatus } from "@/session/status"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import {
  SECTION_10_SQL,
  renderSection10Command,
  section10FileStoresCommand,
  section10Sqlite3Command,
  acquireTestHold,
} from "./s0-fixtures"

const it = testEffect(
  Layer.mergeAll(
    Database.defaultLayer,
    SessionNs.defaultLayer,
    Storage.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    SessionStatus.defaultLayer,
    testInstanceStoreLayer,
  ),
)

// Bounded timeout for it.instance() integration tests. Each creates a scoped
// tmpdir + Effect runtime with SessionNs/Storage services that depend on
// InstanceRef. Under combined-suite I/O contention (multi-file migrations +
// concurrent tmpdir creation), individual tests can exceed the bun default of
// 5000ms. Measured worst-case in combined suite: ~5571ms; 3x margin → 15s.
const S0_TIMEOUT = 15_000

// ---------------------------------------------------------------------------
// Fixture builders — deterministic inputs for S1-S5
//
// Each builder creates sessions and registers cleanup (via
// Effect.addFinalizer) immediately after session creation so partial
// construction failures clean exact session/sidecar/status state.
// The caller receives an object containing sessionID and hold (where
// applicable); the builder owns the lifecycle guarantee.
// ---------------------------------------------------------------------------

/**
 * Retained family: completed, idle session retained for continuation.
 * - 2 messages with 2 parts (deterministic payload sizes)
 * - session_diff sidecar present (session-owned artifact)
 * - No active lease (eligible for retention pruning in S2)
 * - Finalizer registered immediately after session creation.
 */
function buildRetainedFamily() {
  return Effect.gen(function* () {
    const session = yield* SessionNs.Service
    const storage = yield* Storage.Service
    const info = yield* session.create({ title: "S0-retained-family" })
    // Register cleanup immediately — partial construction failures now clean
    // the session and sidecar state.
    yield* Effect.addFinalizer(() => session.remove(info.id).pipe(Effect.ignore))

    const msg1 = MessageID.ascending()
    yield* session.updateMessage({
      id: msg1,
      sessionID: info.id,
      role: "user",
      time: { created: Date.now() },
      agent: "user",
      model: { providerID: ProviderV2.ID.make("test-provider"), modelID: ModelV2.ID.make("test-model") },
      tools: {},
      mode: "",
    })
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID: msg1,
      sessionID: info.id,
      type: "text" as const,
      text: "S0-RETAINED-CONTENT-PART-1",
    })

    const msg2 = MessageID.ascending()
    yield* session.updateMessage({
      id: msg2,
      sessionID: info.id,
      role: "user",
      time: { created: Date.now() },
      agent: "user",
      model: { providerID: ProviderV2.ID.make("test-provider"), modelID: ModelV2.ID.make("test-model") },
      tools: {},
      mode: "",
    })
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID: msg2,
      sessionID: info.id,
      type: "text" as const,
      text: "S0-RETAINED-CONTENT-PART-2-EXTRA-DATA",
    })

    yield* storage.write(
      ["session_diff", info.id],
      [
        { file: "retained.ts", additions: 10, deletions: 2 },
        { file: "retained-util.ts", additions: 5, deletions: 0 },
      ],
    )

    return { sessionID: info.id }
  })
}

/**
 * Active/in-flight family: session with a message that has settled parts
 * and whose session status is set to "busy" via the production
 * SessionStatus.Service — making it observably active/in-flight through
 * real current production state.
 *
 * The busy status is the same in-memory lifecycle signal the production
 * processor sets during generation (session/prompt.ts:1534).
 *
 * Finalizer registered immediately after session creation.
 */
function buildActiveFamily() {
  return Effect.gen(function* () {
    const session = yield* SessionNs.Service
    const status = yield* SessionStatus.Service
    const info = yield* session.create({ title: "S0-active-family" })
    // Register cleanup immediately — partial construction failures clean the
    // session status and session state.
    yield* Effect.addFinalizer(() =>
      Effect.all([
        status.set(info.id, { type: "idle" }).pipe(Effect.ignore),
        session.remove(info.id).pipe(Effect.ignore),
      ]),
    )

    // Add a message with a part — represents content in-flight during generation
    const msgID = MessageID.ascending()
    yield* session.updateMessage({
      id: msgID,
      sessionID: info.id,
      role: "user",
      time: { created: Date.now() },
      agent: "user",
      model: { providerID: ProviderV2.ID.make("test-provider"), modelID: ModelV2.ID.make("test-model") },
      tools: {},
      mode: "",
    })
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID: msgID,
      sessionID: info.id,
      type: "text" as const,
      text: "S0-ACTIVE-CONTENT-PART-1",
    })

    // Mark session as busy via the production SessionStatus lifecycle signal
    yield* status.set(info.id, { type: "busy" })

    return { sessionID: info.id }
  })
}

/**
 * Maintenance-leased family: session with a scoped run-owned hold token.
 *
 * S0 does NOT use event_sequence.owner_id as a maintenance lease — that
 * is a legacy sync claim (ADR-0005, storage spec section 3.4), not a
 * current production maintenance/read hold.
 *
 * Since no production maintenance/read lease primitive exists today, S0
 * models the fixture input with a scoped run-owned hold token explicitly
 * named as a test fixture state.  S2 must bind this input to its future
 * production lease — never write legacy owner_id or claim target
 * protection exists.
 *
 * Finalizer registered immediately after session creation.  The hold
 * acquire/release lifecycle is tested separately via TestHoldToken.
 */
function buildMaintenanceLeasedFamily() {
  return Effect.gen(function* () {
    const session = yield* SessionNs.Service
    const info = yield* session.create({ title: "S0-maintenance-leased-family" })
    // Register cleanup immediately — partial construction failures clean the
    // session and any hold state.
    yield* Effect.addFinalizer(() => session.remove(info.id).pipe(Effect.ignore))

    const msgID = MessageID.ascending()
    yield* session.updateMessage({
      id: msgID,
      sessionID: info.id,
      role: "user",
      time: { created: Date.now() },
      agent: "user",
      model: { providerID: ProviderV2.ID.make("test-provider"), modelID: ModelV2.ID.make("test-model") },
      tools: {},
      mode: "",
    })
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID: msgID,
      sessionID: info.id,
      type: "text" as const,
      text: "S0-LEASED-CONTENT",
    })

    // Acquire a scoped hold token — test fixture state, NOT a production lease.
    // S2 must bind this to its future production maintenance/read hold.
    const hold = acquireTestHold(info.id)
    yield* Effect.addFinalizer(() => Effect.sync(() => hold.release()))

    return { sessionID: info.id, hold }
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("S0 — Frozen measurement commands", () => {
  it.effect(
    "section 10 SQL commands are exact sqlite3 CLI strings",
    () =>
      Effect.gen(function* () {
        const dbPath = "/tmp/test-kilo.db"

        // SQL commands must be wrapped in sqlite3 invocation
        const eventCmd = section10Sqlite3Command(dbPath, SECTION_10_SQL.eventAggregate)
        expect(eventCmd).toBe(
          `sqlite3 "file:/tmp/test-kilo.db?mode=ro" "SELECT 'event', count(*), round(sum(length(data))/1024.0/1024.0, 1) FROM event;"`,
        )
        expect(eventCmd).toContain("sqlite3")
        expect(eventCmd).toContain("mode=ro")
        expect(eventCmd).toContain("FROM event")

        const messageCmd = section10Sqlite3Command(dbPath, SECTION_10_SQL.messageAggregate)
        expect(messageCmd).toBe(
          `sqlite3 "file:/tmp/test-kilo.db?mode=ro" "SELECT 'message', count(*), round(sum(length(data))/1024.0/1024.0, 1) FROM message;"`,
        )

        const partCmd = section10Sqlite3Command(dbPath, SECTION_10_SQL.partAggregate)
        expect(partCmd).toBe(
          `sqlite3 "file:/tmp/test-kilo.db?mode=ro" "SELECT 'part', count(*), round(sum(length(data))/1024.0/1024.0, 1) FROM part;"`,
        )

        const sessionCmd = section10Sqlite3Command(dbPath, SECTION_10_SQL.sessionAggregate)
        expect(sessionCmd).toBe(
          `sqlite3 "file:/tmp/test-kilo.db?mode=ro" "SELECT 'session', count(*), round(sum(length(data))/1024.0/1024.0, 1) FROM session;"`,
        )

        const breakdownCmd = section10Sqlite3Command(dbPath, SECTION_10_SQL.eventTypeBreakdown)
        expect(breakdownCmd).toBe(
          `sqlite3 "file:/tmp/test-kilo.db?mode=ro" "SELECT type, count(*), round(sum(length(data))/1024.0/1024.0, 1) FROM event GROUP BY type ORDER BY 3 DESC;"`,
        )
      }),
    S0_TIMEOUT,
  )

  bunTest("section 10 file-stores command is a du shell string, not sqlite3", () => {
    const cmd = section10FileStoresCommand()
    expect(cmd).toBe("du -sh ~/.local/share/kilo/storage/* ~/.local/share/kilo/snapshot")
    expect(cmd).not.toContain("sqlite3")
    expect(cmd).toContain("du -sh")
    expect(cmd).toContain("storage")
    expect(cmd).toContain("snapshot")
  })

  bunTest("renderSection10Command dispatches correctly by key", () => {
    const dbPath = "/tmp/k.db"

    // SQL keys produce sqlite3 invocations
    const eventSql = renderSection10Command(dbPath, "eventAggregate")
    expect(eventSql).toContain("sqlite3")
    expect(eventSql).toContain("FROM event")

    // fileStores produces a du invocation
    const fileCmd = renderSection10Command(dbPath, "fileStores")
    expect(fileCmd).toBe("du -sh ~/.local/share/kilo/storage/* ~/.local/share/kilo/snapshot")
    expect(fileCmd).not.toContain("sqlite3")
  })
})

describe("S0 — Lossless-family fixture construction", () => {
  it.instance(
    "retained family: session exists with correct title",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { sessionID } = yield* buildRetainedFamily()
        const got = yield* session.get(sessionID)
        expect(got.title).toBe("S0-retained-family")
      }),
    S0_TIMEOUT,
  )

  it.instance(
    "retained family: child count is zero (root session)",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { sessionID } = yield* buildRetainedFamily()
        const children = yield* session.children(sessionID)
        expect(children.length).toBe(0)
      }),
    S0_TIMEOUT,
  )

  it.instance(
    "retained family: sidecar artifact is writable and readable",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const storage = yield* Storage.Service
        const { sessionID } = yield* buildRetainedFamily()
        const diff = yield* storage.read<{ file: string; additions: number; deletions: number }[]>([
          "session_diff",
          sessionID,
        ])
        expect(diff).toHaveLength(2)
        expect(diff[0].file).toBe("retained.ts")
        expect(diff[0].additions).toBe(10)
        expect(diff[0].deletions).toBe(2)
        expect(diff[1].file).toBe("retained-util.ts")
        expect(diff[1].additions).toBe(5)
        expect(diff[1].deletions).toBe(0)
      }),
    S0_TIMEOUT,
  )

  it.instance(
    "retained family: session removal cleans sidecar",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const storage = yield* Storage.Service
        const info = yield* session.create({ title: "S0-retained-family" })
        yield* storage.write(["session_diff", info.id], [{ file: "retained.ts", additions: 10, deletions: 2 }])

        // Verify sidecar exists before removal
        const before = yield* storage.read(["session_diff", info.id]).pipe(Effect.exit)
        expect(before._tag).toBe("Success")

        yield* session.remove(info.id)

        // Sidecar removed by Session.remove
        const after = yield* storage.read(["session_diff", info.id]).pipe(Effect.exit)
        expect(after._tag).toBe("Failure")
      }),
    S0_TIMEOUT,
  )

  it.instance(
    "retained family: messages have expected content",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { sessionID } = yield* buildRetainedFamily()
        const msgs = yield* session.messages({ sessionID })
        expect(msgs).toHaveLength(2)
        // Messages carry parts; verify part content matches the fixture
        const partTexts = msgs
          .flatMap((m) => m.parts.map((p) => (p.type === "text" ? p.text : undefined)))
          .filter(Boolean)
        expect(partTexts).toContain("S0-RETAINED-CONTENT-PART-1")
        expect(partTexts).toContain("S0-RETAINED-CONTENT-PART-2-EXTRA-DATA")
      }),
    S0_TIMEOUT,
  )

  it.instance(
    "active family: session exists with busy status",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const status = yield* SessionStatus.Service
        const { sessionID } = yield* buildActiveFamily()
        const got = yield* session.get(sessionID)
        expect(got.title).toBe("S0-active-family")
        // Assert genuinely busy/in-flight — not idle
        const statusInfo = yield* status.get(sessionID)
        expect(statusInfo.type).toBe("busy")
      }),
    S0_TIMEOUT,
  )

  it.instance(
    "active family: messages have expected content",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { sessionID } = yield* buildActiveFamily()
        const msgs = yield* session.messages({ sessionID })
        expect(msgs).toHaveLength(1)
        const partTexts = msgs
          .flatMap((m) => m.parts.map((p) => (p.type === "text" ? p.text : undefined)))
          .filter(Boolean)
        expect(partTexts).toContain("S0-ACTIVE-CONTENT-PART-1")
      }),
    S0_TIMEOUT,
  )

  it.instance(
    "maintenance-leased family: session exists with hold token",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { sessionID, hold } = yield* buildMaintenanceLeasedFamily()
        const got = yield* session.get(sessionID)
        expect(got.title).toBe("S0-maintenance-leased-family")
        // Assert hold token is held — test fixture state, not production lease
        expect(hold.sessionID).toBe(sessionID)
        expect(hold.holder).toBe("s0-test-fixture")
        expect(hold.acquiredAt).toBeGreaterThan(0)
        expect(hold.isHeld).toBe(true)
        expect(hold.isReleased).toBe(false)
      }),
    S0_TIMEOUT,
  )

  it.instance(
    "maintenance-leased family: messages have expected content",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { sessionID } = yield* buildMaintenanceLeasedFamily()
        const msgs = yield* session.messages({ sessionID })
        expect(msgs).toHaveLength(1)
        const partTexts = msgs
          .flatMap((m) => m.parts.map((p) => (p.type === "text" ? p.text : undefined)))
          .filter(Boolean)
        expect(partTexts).toContain("S0-LEASED-CONTENT")
      }),
    S0_TIMEOUT,
  )

  it.instance(
    "maintenance-leased family: hold held during use, released after scope closure",
    () =>
      Effect.gen(function* () {
        const ref = yield* Ref.make<null | { isReleased: boolean }>(null)

        yield* Effect.scoped(
          Effect.gen(function* () {
            const { hold } = yield* buildMaintenanceLeasedFamily()
            // Hold is held while the scope is open
            expect(hold.isHeld).toBe(true)
            expect(hold.isReleased).toBe(false)
            yield* Ref.set(ref, hold)
          }),
        )

        // After scope closure, the finalizer called hold.release()
        const after = yield* Ref.get(ref)
        expect(after).not.toBeNull()
        expect(after!.isReleased).toBe(true)
      }),
    S0_TIMEOUT,
  )

  it.instance(
    "child sessions are owned by parent via parentID FK",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const parent = yield* session.create({ title: "S0-parent" })
        yield* Effect.addFinalizer(() => session.remove(parent.id).pipe(Effect.ignore))
        const c1 = yield* session.create({ parentID: parent.id, title: "S0-child-1" })
        yield* Effect.addFinalizer(() => session.remove(c1.id).pipe(Effect.ignore))
        const c2 = yield* session.create({ parentID: parent.id, title: "S0-child-2" })
        yield* Effect.addFinalizer(() => session.remove(c2.id).pipe(Effect.ignore))

        expect((yield* session.get(c1.id)).parentID).toBe(parent.id)
        expect((yield* session.get(c2.id)).parentID).toBe(parent.id)

        const children = yield* session.children(parent.id)
        expect(children.length).toBe(2)
      }),
    S0_TIMEOUT,
  )
})

describe("S0 — Hold token lifecycle", () => {
  bunTest("acquire transitions to held state", () => {
    const hold = acquireTestHold("ses-test-1")
    expect(hold.isHeld).toBe(true)
    expect(hold.isReleased).toBe(false)
    expect(hold.sessionID).toBe("ses-test-1")
    expect(hold.holder).toBe("s0-test-fixture")
    expect(hold.acquiredAt).toBeGreaterThan(0)
  })

  bunTest("release transitions to released state", () => {
    const hold = acquireTestHold("ses-test-2")
    hold.assertHeld()
    hold.release()
    expect(hold.isHeld).toBe(false)
    expect(hold.isReleased).toBe(true)
  })

  bunTest("release is idempotent", () => {
    const hold = acquireTestHold("ses-test-3")
    hold.release()
    hold.release() // second call is a no-op
    expect(hold.isReleased).toBe(true)
  })

  bunTest("assertHeld throws after release", () => {
    const hold = acquireTestHold("ses-test-4")
    hold.release()
    expect(() => hold.assertHeld()).toThrow(/released/)
  })

  bunTest("assertReleased throws before release", () => {
    const hold = acquireTestHold("ses-test-5")
    expect(() => hold.assertReleased()).toThrow(/still held/)
  })

  bunTest("assertHeld and assertReleased succeed in correct states", () => {
    const hold = acquireTestHold("ses-test-6")
    hold.assertHeld()
    hold.release()
    hold.assertReleased()
  })
})

describe("S0 — Deterministic measurement (service API surface)", () => {
  it.instance(
    "children count is deterministic for same fixture",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { sessionID } = yield* buildRetainedFamily()

        const c1 = yield* session.children(sessionID)
        const c2 = yield* session.children(sessionID)
        expect(c1.length).toBe(c2.length)
        expect(c1.length).toBe(0)
      }),
    S0_TIMEOUT,
  )

  it.instance(
    "three families produce additive child counts",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const retained = yield* buildRetainedFamily()
        const active = yield* buildActiveFamily()
        const leased = yield* buildMaintenanceLeasedFamily()

        // Each family is a root session with 0 children
        const rc = yield* session.children(retained.sessionID)
        const ac = yield* session.children(active.sessionID)
        const lc = yield* session.children(leased.sessionID)
        expect(rc.length + ac.length + lc.length).toBe(0)
      }),
    S0_TIMEOUT,
  )

  it.instance(
    "retained family: sidecar count matches expected",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const storage = yield* Storage.Service
        const { sessionID } = yield* buildRetainedFamily()
        const diff = yield* storage.read<{ file: string }[]>(["session_diff", sessionID])
        expect(diff).toHaveLength(2)
      }),
    S0_TIMEOUT,
  )
})

describe("S0 — Present-system baseline behavior", () => {
  it.instance(
    "session get returns consistent results",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const info = yield* session.create({ title: "S0-consistent" })
        yield* Effect.addFinalizer(() => session.remove(info.id).pipe(Effect.ignore))

        const got1 = yield* session.get(info.id)
        const got2 = yield* session.get(info.id)
        expect(got1.id).toBe(got2.id)
        expect(got1.title).toBe(got2.title)
      }),
    S0_TIMEOUT,
  )

  it.instance(
    "session removal fails for already-removed sessions",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const info = yield* session.create({ title: "S0-idempotent" })

        yield* session.remove(info.id)
        // Second removal should fail (session already deleted)
        const exit = yield* session.remove(info.id).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    S0_TIMEOUT,
  )

  it.instance(
    "create/remove/create produces independent sessions",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service

        const s1 = yield* session.create({ title: "S0-cycle-1" })
        yield* session.remove(s1.id)

        const s2 = yield* session.create({ title: "S0-cycle-2" })
        expect(s2.id).not.toBe(s1.id)
        expect(s2.title).toBe("S0-cycle-2")

        yield* session.remove(s2.id)
      }),
    S0_TIMEOUT,
  )

  it.instance(
    "session removal cleans up child sessions recursively",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const parent = yield* session.create({ title: "S0-recursive" })
        const child = yield* session.create({ parentID: parent.id, title: "S0-recursive-child" })

        yield* session.remove(parent.id)

        // Both parent and child are removed
        const parentExit = yield* session.get(parent.id).pipe(Effect.exit)
        expect(parentExit._tag).toBe("Failure")
        const childExit = yield* session.get(child.id).pipe(Effect.exit)
        expect(childExit._tag).toBe("Failure")
      }),
    S0_TIMEOUT,
  )

  it.instance(
    "session sidecar files are session-scoped",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const storage = yield* Storage.Service

        const a = yield* session.create({ title: "S0-scoped-a" })
        const b = yield* session.create({ title: "S0-scoped-b" })

        yield* storage.write(["session_diff", a.id], [{ file: "a.ts", additions: 1, deletions: 0 }])
        yield* storage.write(["session_diff", b.id], [{ file: "b.ts", additions: 2, deletions: 1 }])

        // Each session's sidecar is independent
        const diffA = yield* storage.read<{ file: string }[]>(["session_diff", a.id])
        const diffB = yield* storage.read<{ file: string }[]>(["session_diff", b.id])
        expect(diffA[0].file).toBe("a.ts")
        expect(diffB[0].file).toBe("b.ts")

        yield* session.remove(a.id)
        // B's sidecar is untouched by A's removal
        const diffBAfter = yield* storage.read<{ file: string }[]>(["session_diff", b.id])
        expect(diffBAfter[0].file).toBe("b.ts")

        yield* session.remove(b.id)
      }),
    S0_TIMEOUT,
  )

  it.instance(
    "active family: status transitions to idle on cleanup",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const status = yield* SessionStatus.Service
        const info = yield* session.create({ title: "S0-status-transition" })
        yield* Effect.addFinalizer(() => session.remove(info.id).pipe(Effect.ignore))

        yield* status.set(info.id, { type: "busy" })
        const busy = yield* status.get(info.id)
        expect(busy.type).toBe("busy")

        yield* status.set(info.id, { type: "idle" })
        const idle = yield* status.get(info.id)
        expect(idle.type).toBe("idle")
      }),
    S0_TIMEOUT,
  )
})
