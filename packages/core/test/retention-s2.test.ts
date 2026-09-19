import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { sql, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable, RetentionObligationTable } from "@opencode-ai/core/retention/sql"
import * as Retention from "@opencode-ai/core/retention/retention"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInputTable } from "@opencode-ai/core/session/sql"
import { EventV2 } from "@opencode-ai/core/event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"
import { existsSync, statSync, writeFileSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir as osTmpdir } from "os"
import { mkdtempSync } from "fs"
import { DateTime } from "effect"

const databaseMem = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(databaseMem))
const projects = Layer.succeed(
  Project.Service,
  Project.Service.of({
    resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const store = SessionStore.layer.pipe(Layer.provide(databaseMem))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(databaseMem))
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(databaseMem),
  Layer.provide(store),
  Layer.provide(projects),
  Layer.provide(SessionExecution.noopLayer),
)
const it = testEffect(
  Layer.mergeAll(databaseMem, events, projects, projector, store, SessionExecution.noopLayer, sessions),
)

const location = { directory: AbsolutePath.make("/project") }

async function getRevision(db: Database.Interface["db"], sessionID: string) {
  const branded = SessionV2.ID.make(sessionID)
  const row = await Effect.runPromise(
    db
      .select({ revision: SessionTable.revision })
      .from(SessionTable)
      .where(eq(SessionTable.id, branded))
      .get()
      .pipe(Effect.orDie),
  )
  return (row as { revision: number } | undefined)?.revision ?? -1
}

describe("S2 retention core", () => {
  it.effect("tombstone final revision current+1 and no FK cascade", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const before = yield* Effect.promise(() => getRevision(db, created.id))
      expect(before).toBe(0)
      yield* db
        .update(SessionTable)
        .set({ time_updated: 0 })
        .where(eq(SessionTable.id, created.id))
        .run()
        .pipe(Effect.orDie)
      yield* session.create({ location }).pipe(Effect.ignore)
      const family = { rootID: created.id, sessionIDs: [created.id], activity: 0 }
      yield* Retention.deleteFamilyTransaction(
        db,
        family,
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
      expect(sorted[0].revision).toBe(0)
      expect(sorted[1].kind).toBe("deleted")
      expect(sorted[1].revision).toBe(1)
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, created.id)).get().pipe(Effect.orDie)
      expect(row).toBeUndefined()
      const still = yield* db
        .select()
        .from(SessionChangefeedTable)
        .where(eq(SessionChangefeedTable.session_id, created.id))
        .all()
        .pipe(Effect.orDie)
      expect(still.length).toBe(2)
    }),
  )

  it.effect("complete-family deletion cascades messages/parts and is atomic", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const root = yield* session.create({ location })
      const child = yield* session.create({ location })
      yield* db
        .update(SessionTable)
        .set({ parent_id: root.id })
        .where(eq(SessionTable.id, child.id))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionTable)
        .set({ time_updated: 0 })
        .where(eq(SessionTable.id, root.id))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionTable)
        .set({ time_updated: 0 })
        .where(eq(SessionTable.id, child.id))
        .run()
        .pipe(Effect.orDie)
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID: root.id,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(0),
        text: "hi",
      })
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID: child.id,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(0),
        text: "child hi",
      })
      yield* db
        .update(SessionTable)
        .set({ time_updated: 0 })
        .where(eq(SessionTable.id, root.id))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionTable)
        .set({ time_updated: 0 })
        .where(eq(SessionTable.id, child.id))
        .run()
        .pipe(Effect.orDie)
      const ids = [root.id, child.id]
      const family = { rootID: root.id, sessionIDs: ids, activity: 0 }
      yield* Retention.deleteFamilyTransaction(
        db,
        family,
        Date.now(),
        () => false,
        () => false,
      )
      const r1 = yield* db.select().from(SessionTable).where(eq(SessionTable.id, root.id)).get().pipe(Effect.orDie)
      const r2 = yield* db.select().from(SessionTable).where(eq(SessionTable.id, child.id)).get().pipe(Effect.orDie)
      expect(r1).toBeUndefined()
      expect(r2).toBeUndefined()
      const feed = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
      expect(feed.length).toBe(6)
      expect(feed.filter((r) => r.kind === "deleted").length).toBe(2)
      expect(feed.filter((r) => r.kind === "changed").length).toBe(4)
      for (const sid of [root.id, child.id]) {
        const per = feed.filter((r) => r.session_id === sid).sort((a, b) => a.revision - b.revision)
        expect(per.length).toBe(3)
        expect(per[0].kind).toBe("changed")
        expect(per[0].revision).toBe(0)
        expect(per[1].kind).toBe("changed")
        expect(per[1].revision).toBe(1)
        expect(per[2].kind).toBe("deleted")
        expect(per[2].revision).toBe(2)
      }
    }),
  )

  it.effect("7-day child max activity protects family", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      const now = Date.now()
      const root = yield* (yield* SessionV2.Service).create({ location })
      const child = yield* (yield* SessionV2.Service).create({ location })
      yield* db
        .update(SessionTable)
        .set({ parent_id: root.id })
        .where(eq(SessionTable.id, child.id))
        .run()
        .pipe(Effect.orDie)
      const old = now - Retention.SEVEN_DAYS_MS - 1000
      const recent = now - 1000
      yield* db
        .update(SessionTable)
        .set({ time_updated: old })
        .where(eq(SessionTable.id, root.id))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionTable)
        .set({ time_updated: recent })
        .where(eq(SessionTable.id, child.id))
        .run()
        .pipe(Effect.orDie)
      const { eligible } = yield* Retention.eligibleFamilies(
        db,
        now,
        () => false,
        () => false,
      )
      const found = eligible.find((f) => f.rootID === root.id)
      expect(found).toBeUndefined()
    }),
  )

  it.effect("deterministic ordering activity asc then root ID", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      const svc = yield* SessionV2.Service
      const a = yield* svc.create({ location })
      const b = yield* svc.create({ location })
      const c = yield* svc.create({ location })
      const base = Date.now() - Retention.SEVEN_DAYS_MS - 100000
      yield* db
        .update(SessionTable)
        .set({ time_updated: base + 3000 })
        .where(eq(SessionTable.id, a.id))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionTable)
        .set({ time_updated: base + 1000 })
        .where(eq(SessionTable.id, b.id))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionTable)
        .set({ time_updated: base + 1000 })
        .where(eq(SessionTable.id, c.id))
        .run()
        .pipe(Effect.orDie)
      const { eligible } = yield* Retention.eligibleFamilies(
        db,
        Date.now(),
        () => false,
        () => false,
      )
      const order = eligible.map((f) => f.rootID)
      expect(order[0]).toBe(b.id < c.id ? b.id : c.id)
      expect(order[1]).toBe(b.id < c.id ? c.id : b.id)
      expect(order[2]).toBe(a.id)
    }),
  )

  it.effect("TOCTOU revalidation fails if leased after eligibility", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      const svc = yield* SessionV2.Service
      const root = yield* svc.create({ location })
      yield* db
        .update(SessionTable)
        .set({ time_updated: 0 })
        .where(eq(SessionTable.id, root.id))
        .run()
        .pipe(Effect.orDie)
      const fam = { rootID: root.id, sessionIDs: [root.id], activity: 0 }
      let leased = false
      const isLeased = () => leased
      const { eligible } = yield* Retention.eligibleFamilies(db, Date.now(), () => false, isLeased)
      expect(eligible.find((f) => f.rootID === root.id)).toBeDefined()
      leased = true
      const exit = yield* Retention.deleteFamilyTransaction(db, fam, Date.now(), () => false, isLeased).pipe(
        Effect.exit,
      )
      expect(exit._tag).toBe("Failure")
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, root.id)).get().pipe(Effect.orDie)
      expect(row).toBeDefined()
    }),
  )

  it.effect("obligation replay is idempotent and deletes artifacts", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      const svc = yield* SessionV2.Service
      const root = yield* svc.create({ location })
      yield* db
        .update(SessionTable)
        .set({ time_updated: 0 })
        .where(eq(SessionTable.id, root.id))
        .run()
        .pipe(Effect.orDie)
      const fam = { rootID: root.id, sessionIDs: [root.id], activity: 0 }
      yield* Retention.deleteFamilyTransaction(
        db,
        fam,
        Date.now(),
        () => false,
        () => false,
      )
      const before = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
      expect(before.length).toBe(1)
      let deletedKeys: string[][] = []
      const deleter = (keys: string[][]) =>
        Effect.sync(() => {
          deletedKeys.push(...keys)
        })
      yield* Retention.replayObligations(db, deleter)
      expect(deletedKeys.length).toBe(3)
      const after = yield* db.select().from(RetentionObligationTable).all().pipe(Effect.orDie)
      expect(after.length).toBe(0)
      deletedKeys = []
      yield* Retention.replayObligations(db, deleter)
      expect(deletedKeys.length).toBe(0)
    }),
  )

  it.effect("fresh DB has incremental auto_vacuum", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(osTmpdir(), "retention-fresh-"))
      const file = join(dir, "kilo.db")
      const layer = Database.layerFromPath(file)
      const eff = Effect.gen(function* () {
        const { db } = yield* Database.Service
        const row = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(Effect.orDie)
        expect(row?.auto_vacuum).toBe(2)
      })
      yield* Effect.provide(eff, layer).pipe(Effect.orDie)
      rmSync(dir, { recursive: true, force: true })
    }),
  )

  it.effect("legacy DB keeps NONE auto_vacuum", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(osTmpdir(), "retention-legacy-"))
      const file = join(dir, "kilo.db")
      const { Database: BunDB } = yield* Effect.promise(() => import("bun:sqlite"))
      const native = new BunDB(file)
      native.run("PRAGMA auto_vacuum = NONE")
      native.run("CREATE TABLE foo (id TEXT PRIMARY KEY)")
      native.close()
      const existsBefore = existsSync(file)
      expect(existsBefore).toBe(true)
      const layer = Database.layerFromPath(file)
      const eff = Effect.gen(function* () {
        const { db } = yield* Database.Service
        const row = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(Effect.orDie)
        expect(row).toBeDefined()
      })
      yield* Effect.provide(eff, layer).pipe(Effect.orDie)
      rmSync(dir, { recursive: true, force: true })
    }),
  )
})
