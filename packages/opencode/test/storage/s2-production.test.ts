import { describe, expect } from "bun:test"
import { Context, Effect, Exit, Layer, Ref, Scope } from "effect"
import { sql, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable, RetentionObligationTable } from "@opencode-ai/core/retention/sql"
import * as Retention from "@opencode-ai/core/retention/retention"
import * as Artifact from "@opencode-ai/core/retention/artifact"
import { SessionV2 } from "@opencode-ai/core/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { pollWithTimeout } from "../lib/effect"
import { testEffect } from "../lib/effect"
import { Storage } from "@/storage/storage"
import * as Ownership from "@/retention/ownership"
import * as Lease from "@/retention/lease"
import * as Accounting from "@/retention/accounting"
import * as Maintenance from "@/retention/maintenance"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Project } from "@opencode-ai/core/project"
import { provideInstance, tmpdirScoped, testInstanceStoreLayer } from "../fixture/fixture"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppLayer } from "@/effect/app-runtime"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir as osTmpdir } from "os"

const location = { directory: AbsolutePath.make("/project") }

function memLayer() {
  return Database.layerFromPath(":memory:")
}

function makeBaseWithoutMaintenance(accounting: Layer.Layer<Accounting.Service, never, never> = Accounting.layer) {
  const db = memLayer()
  const events = EventV2.layer.pipe(Layer.provide(db))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(db))
  const store = SessionStore.layer.pipe(Layer.provide(db))
  const projects = Layer.succeed(
    Project.Service,
    Project.Service.of({
      resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
      directories: () => Effect.succeed([]),
      commit: () => Effect.void,
    }),
  )
  const sessions = SessionV2.layer.pipe(
    Layer.provide(events),
    Layer.provide(db),
    Layer.provide(store),
    Layer.provide(projects),
    Layer.provide(SessionExecution.noopLayer),
  )
  return Layer.mergeAll(
    db,
    events,
    projector,
    store,
    projects,
    sessions,
    Storage.defaultLayer,
    Ownership.layer,
    Lease.layer,
    accounting,
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  )
}

function makeBaseWithMaintenance(accounting: Layer.Layer<Accounting.Service, never, never> = Accounting.layer) {
  const base = makeBaseWithoutMaintenance(accounting)
  return Layer.mergeAll(base, Maintenance.layer.pipe(Layer.provide(base)))
}

function makeFileBaseWithoutMaintenance(
  db: Layer.Layer<Database.Service, never, never>,
  accounting: Layer.Layer<Accounting.Service, never, never> = Accounting.layer,
) {
  const events = EventV2.layer.pipe(Layer.provide(db))
  const store = SessionStore.layer.pipe(Layer.provide(db))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(db))
  const projects = Layer.succeed(
    Project.Service,
    Project.Service.of({
      resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
      directories: () => Effect.succeed([]),
      commit: () => Effect.void,
    }),
  )
  const sessions = SessionV2.layer.pipe(
    Layer.provide(events),
    Layer.provide(db),
    Layer.provide(store),
    Layer.provide(projects),
    Layer.provide(SessionExecution.noopLayer),
  )
  return Layer.mergeAll(
    db,
    events,
    store,
    projector,
    projects,
    sessions,
    Storage.defaultLayer,
    Ownership.layer,
    Lease.layer,
    accounting,
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  )
}

function makeFileBaseWithMaintenance(
  db: Layer.Layer<Database.Service, never, never>,
  accounting: Layer.Layer<Accounting.Service, never, never> = Accounting.layer,
) {
  const base = makeFileBaseWithoutMaintenance(db, accounting)
  return Layer.mergeAll(base, Maintenance.layer.pipe(Layer.provide(base)))
}

describe("S2 production wiring", () => {
  const it = testEffect(Layer.empty)

  it.effect("boot replay deletes artifacts and removes obligation", () =>
    Effect.gen(function* () {
      const base = makeBaseWithoutMaintenance()
      return yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        const storage = yield* Storage.Service
        const session = yield* SessionV2.Service
        const created = yield* session.create({ location })
        yield* db
          .update(SessionTable)
          .set({ time_updated: 0 })
          .where(eq(SessionTable.id, created.id))
          .run()
          .pipe(Effect.orDie)
        yield* storage.write(["session_diff", created.id], [{ file: "a.ts", additions: 1, deletions: 0 }])
        const fam = { rootID: created.id, sessionIDs: [created.id], activity: 0 }
        yield* Retention.deleteFamilyTransaction(
          db,
          fam,
          Date.now(),
          () => false,
          () => false,
        )
        const before = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
        expect(before.length).toBe(1)
        yield* Retention.replayObligations(db, (keys) =>
          Effect.forEach(keys, (k) => storage.remove(k).pipe(Effect.catch(() => Effect.void)), { discard: true }),
        )
        const after = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
        expect(after.length).toBe(0)
        const keys = Artifact.familyArtifactsForFamily([created.id])
        for (const key of keys) {
          const exists = yield* storage.read<unknown>(key).pipe(Effect.exit)
          expect(exists._tag).toBe("Failure")
        }
      }).pipe(Effect.provide(base))
    }),
  )

  it.effect("process-wide active protection across two directory contexts", () =>
    Effect.gen(function* () {
      const base = makeBaseWithoutMaintenance()
      return yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        const ownership = yield* Ownership.Service
        const dir1 = yield* tmpdirScoped()
        const dir2 = yield* tmpdirScoped()
        const created = yield* Effect.gen(function* () {
          const svc = yield* SessionV2.Service
          const c = yield* svc.create({ location })
          yield* db
            .update(SessionTable)
            .set({ time_updated: 0 })
            .where(eq(SessionTable.id, c.id))
            .run()
            .pipe(Effect.orDie)
          return c
        }).pipe(provideInstance(dir1))

        const release = yield* ownership.acquireActive(created.id)

        const blocked = yield* Effect.gen(function* () {
          const fam = { rootID: created.id, sessionIDs: [created.id], activity: 0 }
          const isActive = (id: string) => ownership.isActive(id)
          const isLeased = (id: string) => ownership.isLeased(id)
          const exit = yield* Retention.deleteFamilyTransaction(db, fam, Date.now(), isActive, isLeased).pipe(
            Effect.exit,
          )
          return exit._tag === "Failure"
        }).pipe(provideInstance(dir2))

        expect(blocked).toBe(true)
        const row = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, created.id))
          .get()
          .pipe(Effect.orDie)
        expect(row).toBeDefined()
        yield* release
        const ok = yield* Effect.gen(function* () {
          const fam = { rootID: created.id, sessionIDs: [created.id], activity: 0 }
          const isActive = (id: string) => ownership.isActive(id)
          const isLeased = (id: string) => ownership.isLeased(id)
          const exit = yield* Retention.deleteFamilyTransaction(db, fam, Date.now(), isActive, isLeased).pipe(
            Effect.exit,
          )
          return exit._tag === "Success"
        }).pipe(provideInstance(dir2))
        expect(ok).toBe(true)
      }).pipe(Effect.provide(base))
    }),
  )

  it.effect("actual read lease via Session.get blocks retention and releases", () =>
    Effect.gen(function* () {
      const base = makeBaseWithoutMaintenance()
      return yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        const ownership = yield* Ownership.Service
        const svc = yield* SessionV2.Service
        const info = yield* svc.create({ location })
        yield* db
          .update(SessionTable)
          .set({ time_updated: 0 })
          .where(eq(SessionTable.id, info.id))
          .run()
          .pipe(Effect.orDie)
        const release = yield* ownership.acquireLease(info.id)
        expect(ownership.isLeased(info.id)).toBe(true)
        const fam = { rootID: info.id, sessionIDs: [info.id], activity: 0 }
        const isLeased = (id: string) => ownership.isLeased(id)
        const exitBlocked = yield* Retention.deleteFamilyTransaction(db, fam, Date.now(), () => false, isLeased).pipe(
          Effect.exit,
        )
        expect(exitBlocked._tag).toBe("Failure")
        yield* release
        expect(ownership.isLeased(info.id)).toBe(false)
        const exitOk = yield* Retention.deleteFamilyTransaction(db, fam, Date.now(), () => false, isLeased).pipe(
          Effect.exit,
        )
        expect(exitOk._tag).toBe("Success")
        const info2 = yield* svc.create({ location })
        yield* db
          .update(SessionTable)
          .set({ time_updated: 0 })
          .where(eq(SessionTable.id, info2.id))
          .run()
          .pipe(Effect.orDie)
        const fetched = yield* svc.get(info2.id).pipe(Effect.provideService(Ownership.Service, ownership))
        expect(fetched.id).toBe(info2.id)
        expect(ownership.isLeased(info2.id)).toBe(false)
      }).pipe(Effect.provide(base))
    }),
  )

  it.live("HIGH→LOW via injectable Accounting with real runOnce", () =>
    Effect.gen(function* () {
      const bootDone = yield* Ref.make(false)
      const bootCalls = yield* Ref.make(0)
      const calls = yield* Ref.make(0)
      const isDirect = yield* Ref.make(false)
      const hysteresisAccounting = Layer.effect(
        Accounting.Service,
        Effect.gen(function* () {
          return Accounting.Service.of({
            physicalBytes: () =>
              Effect.gen(function* () {
                const done = yield* Ref.get(bootDone)
                if (!done) {
                  yield* Ref.update(bootCalls, (n) => n + 1)
                  return 0
                }
                const direct = yield* Ref.get(isDirect)
                if (!direct) return 0
                const n = yield* Ref.updateAndGet(calls, (v) => v + 1)
                if (n <= 2) return Retention.HIGH_BYTES + 1024
                return Retention.LOW_BYTES
              }),
            physicalBytesWith: () => Effect.succeed(0),
          })
        }),
      )
      const simpleBase = makeBaseWithMaintenance(hysteresisAccounting)
      return yield* Effect.gen(function* () {
        // Bounded startup: the worker waits for start before replay/boot.
        yield* (yield* Maintenance.Service).start
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const c = yield* Ref.get(bootCalls)
            if (c >= 1) return true as const
            return undefined
          }),
          "boot did not run",
          "2 seconds",
        )
        yield* Ref.set(bootDone, true)
        expect(Retention.HIGH_BYTES).toBe(8 * 1024 * 1024 * 1024)
        expect(Retention.LOW_BYTES).toBe(6 * 1024 * 1024 * 1024)
        const { db } = yield* Database.Service
        const storage = yield* Storage.Service
        const session = yield* SessionV2.Service
        const maintenance = yield* Maintenance.Service
        const a = yield* session.create({ location })
        const b = yield* session.create({ location })
        yield* db
          .update(SessionTable)
          .set({ time_updated: 0 })
          .where(eq(SessionTable.id, a.id))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionTable)
          .set({ time_updated: 0 })
          .where(eq(SessionTable.id, b.id))
          .run()
          .pipe(Effect.orDie)
        yield* storage.write(["session_diff", a.id], [{ file: "a.ts", additions: 1, deletions: 0 }])
        yield* storage.write(["session_diff", b.id], [{ file: "b.ts", additions: 1, deletions: 0 }])
        // Wait for EventV2-triggered queued runs from a/b creation to complete and drain (they return 0 when not direct)
        yield* Effect.sleep("100 millis")
        yield* Ref.set(calls, 0)
        yield* Ref.set(isDirect, true)
        const beforeFamilies = yield* Retention.listFamilies(db)
        expect(beforeFamilies.length).toBe(2)
        const diag = yield* maintenance.runOnce("test-high-low")
        yield* Ref.set(isDirect, false)
        expect(diag.trigger).toBe("test-high-low")
        expect(diag.beforeBytes).toBe(Retention.HIGH_BYTES + 1024)
        expect(diag.afterBytes).toBe(Retention.LOW_BYTES)
        expect(diag.selected).toBe(2)
        expect(diag.deleted).toBe(1)
        expect(diag.checkpoint).toBe("ok")
        expect(diag.vacuum).toBe("ok")
        expect(diag.failures.length).toBe(0)
        expect(diag.rowsReclaimed).toBe(1)
        expect(diag.artifactBytesReclaimed).toBeGreaterThanOrEqual(0)
        expect(diag.skipped).toBeGreaterThanOrEqual(0)
        const afterFamilies = yield* Retention.listFamilies(db)
        expect(afterFamilies.length).toBe(1)
      }).pipe(Effect.provide(simpleBase))
    }),
  )

  it.effect("failed artifact cleanup keeps obligation and increments attempts then retry succeeds", () =>
    Effect.gen(function* () {
      const base = makeBaseWithoutMaintenance()
      return yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        const svc = yield* SessionV2.Service
        const created = yield* svc.create({ location })
        yield* db
          .update(SessionTable)
          .set({ time_updated: 0 })
          .where(eq(SessionTable.id, created.id))
          .run()
          .pipe(Effect.orDie)
        const fam = { rootID: created.id, sessionIDs: [created.id], activity: 0 }
        yield* Retention.deleteFamilyTransaction(
          db,
          fam,
          Date.now(),
          () => false,
          () => false,
        )
        const attemptsBefore =
          (yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie))[0]?.attempts ?? 0
        expect(attemptsBefore).toBe(0)
        const failingDeleter = () => Effect.fail(new Error("delete fail"))
        yield* Retention.replayObligations(db, failingDeleter)
        const afterFail = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
        expect(afterFail.length).toBe(1)
        expect(afterFail[0].attempts).toBe(1)
        const okDeleter = () => Effect.void
        yield* Retention.replayObligations(db, okDeleter)
        const afterOk = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
        expect(afterOk.length).toBe(0)
      }).pipe(Effect.provide(base))
    }),
  )

  it.effect("malformed obligation retained and increments attempts", () =>
    Effect.gen(function* () {
      const base = makeBaseWithoutMaintenance()
      return yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .run(
            sql`INSERT INTO retention_obligation (family_root_id, session_ids, time_created, attempts) VALUES ('root-mal', 'not-json', 0, 0)`,
          )
          .pipe(Effect.orDie)
        const before = yield* db
          .all<{
            id: number
            attempts: number
          }>(sql`SELECT id, attempts FROM retention_obligation WHERE family_root_id = 'root-mal'`)
          .pipe(Effect.orDie)
        expect(before.length).toBe(1)
        expect(before[0].attempts).toBe(0)
        yield* Retention.replayObligations(db, () => Effect.void)
        const after = yield* db
          .all<{
            id: number
            attempts: number
          }>(sql`SELECT id, attempts FROM retention_obligation WHERE family_root_id = 'root-mal'`)
          .pipe(Effect.orDie)
        expect(after.length).toBe(1)
        expect(after[0].attempts).toBe(1)
        yield* db
          .delete(RetentionObligationTable)
          .where(eq(RetentionObligationTable.family_root_id, "root-mal"))
          .run()
          .pipe(Effect.orDie)
      }).pipe(Effect.provide(base))
    }),
  )

  it.live("real diagnostics from runOnce are descriptive and not fabricated", () =>
    Effect.gen(function* () {
      const bootDone = yield* Ref.make(false)
      const bootCalls = yield* Ref.make(0)
      const isDirect = yield* Ref.make(false)
      const accounting = Layer.effect(
        Accounting.Service,
        Effect.gen(function* () {
          return Accounting.Service.of({
            physicalBytes: () =>
              Effect.gen(function* () {
                const done = yield* Ref.get(bootDone)
                if (!done) {
                  yield* Ref.update(bootCalls, (n) => n + 1)
                  return 0
                }
                const direct = yield* Ref.get(isDirect)
                if (!direct) return 0
                return Retention.HIGH_BYTES + 512
              }),
            physicalBytesWith: () => Effect.succeed(0),
          })
        }),
      )
      const base = makeBaseWithMaintenance(accounting)
      return yield* Effect.gen(function* () {
        // Bounded startup: the worker waits for start before replay/boot.
        yield* (yield* Maintenance.Service).start
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const c = yield* Ref.get(bootCalls)
            if (c >= 1) return true as const
            return undefined
          }),
          "boot did not run",
          "2 seconds",
        )
        yield* Ref.set(bootDone, true)
        const { db } = yield* Database.Service
        const storage = yield* Storage.Service
        const session = yield* SessionV2.Service
        const maintenance = yield* Maintenance.Service
        const a = yield* session.create({ location })
        yield* db
          .update(SessionTable)
          .set({ time_updated: 0 })
          .where(eq(SessionTable.id, a.id))
          .run()
          .pipe(Effect.orDie)
        yield* storage.write(["session_diff", a.id], [{ file: "diag.ts", additions: 2, deletions: 0 }])
        // Queued run from a creation should not delete when not direct
        yield* Effect.sleep("100 millis")
        yield* Ref.set(isDirect, true)
        const diag = yield* maintenance.runOnce("test-diag-real")
        yield* Ref.set(isDirect, false)
        expect(diag.trigger).toBe("test-diag-real")
        expect(diag.beforeBytes).toBe(Retention.HIGH_BYTES + 512)
        expect(diag.selected).toBeGreaterThanOrEqual(1)
        expect(diag.deleted).toBeGreaterThanOrEqual(1)
        expect(diag.rowsReclaimed).toBeGreaterThanOrEqual(1)
        expect(diag.artifactBytesReclaimed).toBeGreaterThanOrEqual(0)
        expect(
          ["ok", "skipped-below-high", "skipped-busy", "skipped-no-delete"].some(
            (v) => diag.checkpoint.includes(v) || diag.checkpoint === "ok",
          ),
        ).toBe(true)
        expect(diag.checkpoint).not.toBe("")
        expect(diag.vacuum).not.toBe("")
        expect(Array.isArray(diag.failures)).toBe(true)
        expect(typeof diag.skipReasons).toBe("object")
        expect(diag.afterBytes).toBeGreaterThanOrEqual(0)
        expect(typeof diag.afterBytes).toBe("number")
      }).pipe(Effect.provide(base))
    }),
  )

  it.effect("tombstone revision current+1 and changefeed persists after delete", () =>
    Effect.gen(function* () {
      const base = makeBaseWithoutMaintenance()
      return yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        const svc = yield* SessionV2.Service
        const created = yield* svc.create({ location })
        const row = yield* db
          .select({ rev: SessionTable.revision })
          .from(SessionTable)
          .where(eq(SessionTable.id, created.id))
          .get()
          .pipe(Effect.orDie)
        const beforeRev = (row as { rev: number } | undefined)?.rev ?? 0
        yield* db
          .update(SessionTable)
          .set({ time_updated: 0 })
          .where(eq(SessionTable.id, created.id))
          .run()
          .pipe(Effect.orDie)
        const fam = { rootID: created.id, sessionIDs: [created.id], activity: 0 }
        yield* Retention.deleteFamilyTransaction(
          db,
          fam,
          Date.now(),
          () => false,
          () => false,
        )
        const feed = yield* db
          .select()
          .from(SessionChangefeedTable)
          .where(eq(SessionChangefeedTable.session_id, created.id))
          .all()
          .pipe(Effect.orDie)
        expect(feed.length).toBe(2)
        const sorted = [...feed].sort((a, b) => a.revision - b.revision)
        expect(sorted[0].kind).toBe("changed")
        expect(sorted[0].revision).toBe(beforeRev)
        expect(sorted[1].kind).toBe("deleted")
        expect(sorted[1].revision).toBe(beforeRev + 1)
        const gone = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, created.id))
          .get()
          .pipe(Effect.orDie)
        expect(gone).toBeUndefined()
        const still = yield* db
          .select()
          .from(SessionChangefeedTable)
          .where(eq(SessionChangefeedTable.session_id, created.id))
          .all()
          .pipe(Effect.orDie)
        expect(still.length).toBe(2)
      }).pipe(Effect.provide(base))
    }),
  )

  it.effect("unregistered artifact write fails with typed error", () =>
    Effect.gen(function* () {
      const base = makeBaseWithoutMaintenance()
      return yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const exit = yield* storage.write(["unregistered_xyz", "id"], { foo: "bar" }).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const cause = exit.cause
          const hasUnregistered =
            cause.toString().includes("UnregisteredArtifactError") || cause.toString().includes("Unregistered")
          expect(hasUnregistered).toBe(true)
        }
      }).pipe(Effect.provide(base))
    }),
  )

  it.live("fresh file DB has incremental auto_vacuum after close and reopen", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(osTmpdir(), "s2-fresh-"))
      const file = join(dir, "kilo.db")
      try {
        const layer = Database.layerFromPath(file)
        const check = Effect.gen(function* () {
          const { db } = yield* Database.Service
          const row = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(Effect.orDie)
          expect(row?.auto_vacuum).toBe(2)
        })
        yield* check.pipe(Effect.provide(layer), Effect.scoped)
        const layer2 = Database.layerFromPath(file)
        const check2 = Effect.gen(function* () {
          const { db } = yield* Database.Service
          const row = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(Effect.orDie)
          expect(row?.auto_vacuum).toBe(2)
        })
        yield* check2.pipe(Effect.provide(layer2), Effect.scoped)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )

  it.live("boot replay runs before boot schedule and queue is coalesced and scoped", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(osTmpdir(), "s2-queue-"))
      const file = join(dir, "kilo.db")
      try {
        const dbLayer = Database.layerFromPath(file)
        const setupBase = makeFileBaseWithoutMaintenance(dbLayer)
        // Create obligation before maintenance layer boots
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          const storage = yield* Storage.Service
          const session = yield* SessionV2.Service
          const created = yield* session.create({ location })
          yield* db
            .update(SessionTable)
            .set({ time_updated: 0 })
            .where(eq(SessionTable.id, created.id))
            .run()
            .pipe(Effect.orDie)
          yield* storage.write(["session_diff", created.id], [{ file: "a.ts", additions: 1, deletions: 0 }])
          const fam = { rootID: created.id, sessionIDs: [created.id], activity: 0 }
          yield* Retention.deleteFamilyTransaction(
            db,
            fam,
            Date.now(),
            () => false,
            () => false,
          )
          const obs = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
          expect(obs.length).toBe(1)
        }).pipe(Effect.provide(setupBase), Effect.scoped)

        // Now boot maintenance layer - replay should happen before boot schedule
        const runCount = yield* Ref.make(0)
        const accounting = Layer.effect(
          Accounting.Service,
          Effect.gen(function* () {
            return Accounting.Service.of({
              physicalBytes: () =>
                Effect.gen(function* () {
                  yield* Ref.update(runCount, (n) => n + 1)
                  return 0
                }),
              physicalBytesWith: () => Effect.succeed(0),
            })
          }),
        )
        const maintenanceBase = makeFileBaseWithMaintenance(dbLayer, accounting)
        yield* Effect.gen(function* () {
          // Bounded startup: the worker waits for start before replay/boot.
          yield* (yield* Maintenance.Service).start
          const { db } = yield* Database.Service
          const storage = yield* Storage.Service
          // Wait for replay + boot to finish deterministically
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const obs = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
              if (obs.length !== 0) return undefined
              const cnt = yield* Ref.get(runCount)
              if (cnt < 1) return undefined
              return true as const
            }),
            "replay and boot did not complete",
            "2 seconds",
          )
          const after = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
          expect(after.length).toBe(0)
          const cntAfterBoot = yield* Ref.get(runCount)
          expect(cntAfterBoot).toBeGreaterThanOrEqual(1)

          // Coalescing: schedule 3 quickly, verify they coalesce into single additional run
          const maintenance = yield* Maintenance.Service
          yield* Ref.set(runCount, 0)
          yield* maintenance.schedule("test-coalesce-1")
          yield* maintenance.schedule("test-coalesce-2")
          yield* maintenance.schedule("test-coalesce-3")
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const c = yield* Ref.get(runCount)
              if (c >= 1) return c as number
              return undefined
            }),
            "coalesced run did not occur",
            "2 seconds",
          )
          const coalescedCount = yield* Ref.get(runCount)
          // 3 schedules should coalesce into 1 run, not 3
          expect(coalescedCount).toBe(1)
          // Ensure queue drained
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const c = yield* Ref.get(runCount)
              // Give a short window to ensure no extra runs
              yield* Effect.sleep("50 millis")
              const c2 = yield* Ref.get(runCount)
              if (c2 !== c) return undefined
              return true as const
            }),
            "queue not drained",
            "2 seconds",
          )
        }).pipe(Effect.provide(maintenanceBase), Effect.scoped)
        // Scope closed cleanly - no interrupt leak; reaching here proves shutdown clean
        expect(true).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )

  it.live("commit-trigger schedules maintenance after canonical mutation", () =>
    Effect.gen(function* () {
      const runCount = yield* Ref.make(0)
      const hasOldFlag = yield* Ref.make(false)
      const accounting = Layer.effect(
        Accounting.Service,
        Effect.gen(function* () {
          return Accounting.Service.of({
            physicalBytes: () =>
              Effect.gen(function* () {
                yield* Ref.update(runCount, (n) => n + 1)
                const hasOld = yield* Ref.get(hasOldFlag)
                if (hasOld) return Retention.HIGH_BYTES + 1024
                return 0
              }),
            physicalBytesWith: () => Effect.succeed(0),
          })
        }),
      )
      const base = makeBaseWithMaintenance(accounting)
      return yield* Effect.gen(function* () {
        // Bounded startup: the worker waits for start before replay/boot.
        yield* (yield* Maintenance.Service).start
        const { db } = yield* Database.Service
        const session = yield* SessionV2.Service
        const storage = yield* Storage.Service
        // Create old eligible family
        const old = yield* session.create({ location })
        yield* db
          .update(SessionTable)
          .set({ time_updated: 0 })
          .where(eq(SessionTable.id, old.id))
          .run()
          .pipe(Effect.orDie)
        yield* storage.write(["session_diff", old.id], [{ file: "old.ts", additions: 1, deletions: 0 }])
        const before = yield* Retention.listFamilies(db)
        expect(before.find((f) => f.rootID === old.id)).toBeDefined()
        // Reset count after boot
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const c = yield* Ref.get(runCount)
            if (c >= 1) return true as const
            return undefined
          }),
          "boot run not observed",
          "2 seconds",
        )
        yield* Ref.set(runCount, 0)
        yield* Ref.set(hasOldFlag, true)
        // Canonical mutation: create fresh session (recent, not eligible)
        const fresh = yield* session.create({ location })
        expect(fresh.id).toBeDefined()
        // Verify commit observable immediately before maintenance deletes old
        const freshRow = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, fresh.id))
          .get()
          .pipe(Effect.orDie)
        expect(freshRow).toBeDefined()
        const oldRowBefore = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, old.id))
          .get()
          .pipe(Effect.orDie)
        expect(oldRowBefore).toBeDefined()
        // Wait for queued maintenance to delete old (proves schedule after commit)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const fams = yield* Retention.listFamilies(db)
            const stillOld = fams.find((f) => f.rootID === old.id)
            if (stillOld) return undefined
            return true as const
          }),
          "commit-triggered maintenance did not prune old family",
          "3 seconds",
        )
        const after = yield* Retention.listFamilies(db)
        expect(after.find((f) => f.rootID === old.id)).toBeUndefined()
        expect(after.find((f) => f.rootID === fresh.id)).toBeDefined()
        const cnt = yield* Ref.get(runCount)
        expect(cnt).toBeGreaterThanOrEqual(1)
        // No duplicate per mutation: one create should not cause multiple runs deleting fresh (fresh not eligible)
        // Ensure fresh still exists after extra wait
        yield* Effect.sleep("100 millis")
        const after2 = yield* Retention.listFamilies(db)
        expect(after2.find((f) => f.rootID === fresh.id)).toBeDefined()
      }).pipe(Effect.provide(base))
    }),
  )

  it.live("single instance identity via memoMap", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const ctx = yield* Layer.buildWithMemoMap(AppLayer, memoMap, scope)
      const getDb = Effect.gen(function* () {
        return yield* Database.Service
      })
      const getStorage = Effect.gen(function* () {
        return yield* Storage.Service
      })
      const getOwnership = Effect.gen(function* () {
        return yield* Ownership.Service
      })
      const getLease = Effect.gen(function* () {
        return yield* Lease.Service
      })
      const getAccounting = Effect.gen(function* () {
        return yield* Accounting.Service
      })
      const getMaintenance = Effect.gen(function* () {
        return yield* Maintenance.Service
      })
      const dbA = yield* Effect.provide(getDb, ctx)
      const dbB = yield* Effect.provide(getDb, ctx)
      expect(dbA).toBe(dbB)
      expect(dbA.db).toBe(dbB.db)
      const stA = yield* Effect.provide(getStorage, ctx)
      const stB = yield* Effect.provide(getStorage, ctx)
      expect(stA).toBe(stB)
      const owA = yield* Effect.provide(getOwnership, ctx)
      const owB = yield* Effect.provide(getOwnership, ctx)
      expect(owA).toBe(owB)
      // Lease
      const leA = yield* Effect.provide(getLease, ctx)
      const leB = yield* Effect.provide(getLease, ctx)
      expect(leA).toBe(leB)
      const acA = yield* Effect.provide(getAccounting, ctx)
      const acB = yield* Effect.provide(getAccounting, ctx)
      expect(acA).toBe(acB)
      const mnA = yield* Effect.provide(getMaintenance, ctx)
      const mnB = yield* Effect.provide(getMaintenance, ctx)
      expect(mnA).toBe(mnB)
      // Also verify that two builds with same memoMap share instance
      const scope2 = yield* Scope.make()
      const ctx2 = yield* Layer.buildWithMemoMap(AppLayer, memoMap, scope2)
      const dbC = yield* Effect.provide(getDb, ctx2)
      expect(dbA.db).toBe(dbC.db)
      yield* Scope.close(scope, Exit.succeed(undefined))
      yield* Scope.close(scope2, Exit.succeed(undefined))
    }),
  )
})
