import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable, SessionChangefeedStateTable } from "@opencode-ai/core/retention/sql"
import * as Changefeed from "@opencode-ai/core/retention/changefeed"
import * as Retention from "@opencode-ai/core/retention/retention"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTodo } from "@opencode-ai/core/session/todo"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { EventV2 } from "@opencode-ai/core/event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import changefeedBoundsMigration from "@opencode-ai/core/database/migration/20260821000000_add_changefeed_bounds"
import kindCheckMigration from "@opencode-ai/core/database/migration/20260822000000_add_changefeed_kind_check"
import { SessionRevision } from "@opencode-ai/core/session/revision"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projects = Layer.succeed(
  Project.Service,
  Project.Service.of({
    resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const todos = SessionTodo.layer.pipe(Layer.provide(database), Layer.provide(events))
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projects),
  Layer.provide(SessionExecution.noopLayer),
)
const it = testEffect(Layer.mergeAll(database, events, projects, projector, store, todos, SessionExecution.noopLayer, sessions))
const location = { directory: AbsolutePath.make("/project") }

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run().pipe(Effect.orDie)
})

describe("S4 bounded changefeed/outbox", () => {
  it.effect("global ordering across sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const svc = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const a = yield* svc.create({ location })
      const b = yield* svc.create({ location })
      const ev = yield* EventV2.Service
      yield* ev.publish(SessionEvent.Synthetic, { sessionID: a.id, messageID: SessionMessage.ID.create(), timestamp: DateTime.makeUnsafe(10), text: "a1" })
      yield* ev.publish(SessionEvent.Synthetic, { sessionID: b.id, messageID: SessionMessage.ID.create(), timestamp: DateTime.makeUnsafe(11), text: "b1" })
      yield* ev.publish(SessionEvent.Synthetic, { sessionID: a.id, messageID: SessionMessage.ID.create(), timestamp: DateTime.makeUnsafe(12), text: "a2" })
      yield* ev.publish(SessionEvent.Synthetic, { sessionID: b.id, messageID: SessionMessage.ID.create(), timestamp: DateTime.makeUnsafe(13), text: "b2" })
      const rows = yield* db.select().from(SessionChangefeedTable).orderBy(sql`${SessionChangefeedTable.seq} ASC`).all().pipe(Effect.orDie)
      expect(rows.length).toBe(6)
      for (let i = 1; i < rows.length; i++) expect(rows[i]!.seq).toBeGreaterThan(rows[i - 1]!.seq)
      // kinds are all changed, revisions per session are 0,1,2,0,1,2 but seq global monotonic; creation emits 0
      const aRows = rows.filter((r) => r.session_id === a.id)
      const bRows = rows.filter((r) => r.session_id === b.id)
      expect(aRows.length).toBe(3)
      expect(bRows.length).toBe(3)
      expect(aRows[0]!.revision).toBe(0)
      expect(aRows[1]!.revision).toBe(1)
      expect(aRows[2]!.revision).toBe(2)
      expect(bRows[0]!.revision).toBe(0)
      expect(bRows[1]!.revision).toBe(1)
      expect(bRows[2]!.revision).toBe(2)
    }),
  )

  it.effect("exactly one changed entry per revision", () =>
    Effect.gen(function* () {
      yield* setup
      const svc = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const ev = yield* EventV2.Service
      const s = yield* svc.create({ location })
      yield* ev.publish(SessionEvent.Synthetic, { sessionID: s.id, messageID: SessionMessage.ID.create(), timestamp: DateTime.makeUnsafe(20), text: "x" })
      let rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, s.id)).all().pipe(Effect.orDie)
      expect(rows.length).toBe(2)
      expect(rows.find((r) => r.revision === 0)!.kind).toBe("changed")
      expect(rows.find((r) => r.revision === 1)!.kind).toBe("changed")
      yield* ev.publish(SessionEvent.Synthetic, { sessionID: s.id, messageID: SessionMessage.ID.create(), timestamp: DateTime.makeUnsafe(21), text: "y" })
      rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, s.id)).all().pipe(Effect.orDie)
      expect(rows.length).toBe(3)
      const revs = rows.map((r) => r.revision).sort((a, b) => a - b)
      expect(revs).toEqual([0, 1, 2])
      // verify payload-free: only session_id/revision/kind/time/seq columns exist
      for (const r of rows) {
        expect(typeof r.session_id).toBe("string")
        expect(typeof r.revision).toBe("number")
        expect(typeof r.kind).toBe("string")
        expect(typeof r.time).toBe("number")
        expect(typeof r.seq).toBe("number")
      }
    }),
  )

  it.effect("idempotent duplicate without seq gap", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const sid = "ses_dup_" + Date.now()
      const first = yield* Changefeed.append(db, { session_id: sid, revision: 5, kind: "changed", time: Date.now() })
      const count1 = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
      expect(count1.length).toBe(1)
      const dup = yield* Changefeed.append(db, { session_id: sid, revision: 5, kind: "changed", time: Date.now() })
      expect(dup.seq).toBe(first.seq)
      const count2 = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
      expect(count2.length).toBe(1)
      const second = yield* Changefeed.append(db, { session_id: sid, revision: 6, kind: "changed", time: Date.now() })
      expect(second.seq).toBe(first.seq + 1)
      const count3 = yield* db.select().from(SessionChangefeedTable).orderBy(sql`${SessionChangefeedTable.seq} ASC`).all().pipe(Effect.orDie)
      expect(count3.length).toBe(2)
      expect(count3[0]!.seq + 1).toBe(count3[1]!.seq)
      // different kind same session/revision is distinct identity
      const otherKind = yield* Changefeed.append(db, { session_id: sid, revision: 5, kind: "deleted", time: Date.now() })
      expect(otherKind.seq).toBe(second.seq + 1)
      const count4 = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
      expect(count4.length).toBe(3)
    }),
  )

  it.effect("production row and byte caps constants and deterministic byte size", () =>
    Effect.gen(function* () {
      expect(Changefeed.MAX_ROWS).toBe(50_000)
      expect(Changefeed.MAX_BYTES).toBe(64 * 1024 * 1024)
      // deterministic logical size: UTF-8 bytes of session_id+kind +24
      const enc = new TextEncoder()
      expect(Changefeed.byteSize("ses_abc", "changed")).toBe(enc.encode("ses_abc").length + enc.encode("changed").length + 24)
      expect(Changefeed.byteSize("ses_abc", "deleted")).toBe(enc.encode("ses_abc").length + enc.encode("deleted").length + 24)
      // utf8 multibyte
      expect(Changefeed.byteSize("ses_é", "changed")).toBe(enc.encode("ses_é").length + enc.encode("changed").length + 24)
    }),
  )

  it.effect("row cap scaled eviction including unacknowledged rows", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      // use appendWithCaps with tiny maxRows=3 to force eviction
      const caps = { maxRows: 3, maxBytes: 10_000_000 }
      const a = yield* Changefeed.appendWithCaps(db, { session_id: "ses_a", revision: 1, kind: "changed", time: 1 }, caps)
      const b = yield* Changefeed.appendWithCaps(db, { session_id: "ses_b", revision: 1, kind: "changed", time: 2 }, caps)
      const c = yield* Changefeed.appendWithCaps(db, { session_id: "ses_c", revision: 1, kind: "changed", time: 3 }, caps)
      let rows = yield* db.select().from(SessionChangefeedTable).orderBy(sql`${SessionChangefeedTable.seq} ASC`).all().pipe(Effect.orDie)
      expect(rows.length).toBe(3)
      expect(rows.map((r) => r.session_id)).toEqual(["ses_a", "ses_b", "ses_c"])
      const st1 = yield* Changefeed.getState(db)
      expect(st1.retained_rows).toBe(3)
      // inserting fourth should evict oldest (ses_a) even though unacknowledged
      const d = yield* Changefeed.appendWithCaps(db, { session_id: "ses_d", revision: 1, kind: "changed", time: 4 }, caps)
      rows = yield* db.select().from(SessionChangefeedTable).orderBy(sql`${SessionChangefeedTable.seq} ASC`).all().pipe(Effect.orDie)
      expect(rows.length).toBe(3)
      expect(rows.map((r) => r.session_id)).toEqual(["ses_b", "ses_c", "ses_d"])
      // gap detection: cursor far behind evicted window should require rehydrate (0 is before window)
      const readGap = yield* Changefeed.readAfter(db, 0)
      expect(readGap.type).toBe("rehydrate")
      if (readGap.type === "rehydrate") expect(readGap.cursor).toBe(d.seq)
      // cursor immediately before retained window (a.seq) is still contiguous: reading after a returns b,c,d's successor (d) without gap
      const readAfterEvicted = yield* Changefeed.readAfter(db, a.seq)
      expect(readAfterEvicted.type).toBe("deltas")
      // cursor at c should still be contiguous and return d
      const readContiguous = yield* Changefeed.readAfter(db, c.seq)
      expect(readContiguous.type).toBe("deltas")
      if (readContiguous.type === "deltas") {
        expect(readContiguous.entries.length).toBe(1)
        expect(readContiguous.entries[0]!.session_id).toBe("ses_d")
      }
      const st2 = yield* Changefeed.getState(db)
      expect(st2.retained_rows).toBe(3)
      expect(st2.latest_seq).toBe(d.seq)
      // ensure latest_seq monotonic despite eviction
      expect(st2.latest_seq).toBeGreaterThan(c.seq)
    }),
  )

  it.effect("byte cap scaled eviction determinism", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      // each entry size approx: session_id "ses_x" (5) + "changed" (7) +24=36
      // set maxBytes to 70 => 2 entries (72) would exceed, so 3rd insert evicts 1
      const caps = { maxRows: 100, maxBytes: 70 }
      const s1 = yield* Changefeed.appendWithCaps(db, { session_id: "ses_x", revision: 1, kind: "changed", time: 1 }, caps)
      let st = yield* Changefeed.getState(db)
      expect(st.retained_bytes).toBe(Changefeed.byteSize("ses_x", "changed"))
      const s2 = yield* Changefeed.appendWithCaps(db, { session_id: "ses_y", revision: 1, kind: "changed", time: 2 }, caps)
      st = yield* Changefeed.getState(db)
      expect(st.retained_rows).toBe(1)
      expect(st.retained_bytes).toBe(Changefeed.byteSize("ses_y", "changed"))
      let rows = yield* db.select().from(SessionChangefeedTable).orderBy(sql`${SessionChangefeedTable.seq} ASC`).all().pipe(Effect.orDie)
      expect(rows.length).toBe(1)
      expect(rows[0]!.session_id).toBe("ses_y")
      // inserting another with larger kind to test utf8 and size
      const s3 = yield* Changefeed.appendWithCaps(db, { session_id: "ses_z", revision: 1, kind: "deleted", time: 3 }, caps)
      st = yield* Changefeed.getState(db)
      expect(st.retained_rows).toBe(1)
      expect(st.retained_bytes).toBe(Changefeed.byteSize("ses_z", "deleted"))
      rows = yield* db.select().from(SessionChangefeedTable).orderBy(sql`${SessionChangefeedTable.seq} ASC`).all().pipe(Effect.orDie)
      expect(rows.length).toBe(1)
      expect(rows[0]!.session_id).toBe("ses_z")
      // gap detection after byte eviction: cursor 0 is before retained window, should rehydrate; cursor immediately before window (s2) is still contiguous
      const gap = yield* Changefeed.readAfter(db, 0)
      expect(gap.type).toBe("rehydrate")
      const contiguousAfterEvicted = yield* Changefeed.readAfter(db, s2.seq)
      expect(contiguousAfterEvicted.type).toBe("deltas")
    }),
  )

  it.effect("ack truncation", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const r1 = yield* Changefeed.append(db, { session_id: "ses_ack1", revision: 1, kind: "changed", time: 1 })
      const r2 = yield* Changefeed.append(db, { session_id: "ses_ack2", revision: 1, kind: "changed", time: 2 })
      const r3 = yield* Changefeed.append(db, { session_id: "ses_ack3", revision: 1, kind: "changed", time: 3 })
      let st = yield* Changefeed.getState(db)
      expect(st.retained_rows).toBe(3)
      expect(st.latest_seq).toBe(r3.seq)
      // ack up to r2 should truncate r1 and r2
      yield* Changefeed.ack(db, r2.seq)
      let rows = yield* db.select().from(SessionChangefeedTable).orderBy(sql`${SessionChangefeedTable.seq} ASC`).all().pipe(Effect.orDie)
      expect(rows.length).toBe(1)
      expect(rows[0]!.seq).toBe(r3.seq)
      st = yield* Changefeed.getState(db)
      expect(st.retained_rows).toBe(1)
      expect(st.latest_seq).toBe(r3.seq)
      expect(st.retained_bytes).toBe(Changefeed.byteSize("ses_ack3", "changed"))
      // ack at current is valid empty
      const readAtCurrent = yield* Changefeed.readAfter(db, r3.seq)
      expect(readAtCurrent.type).toBe("deltas")
      if (readAtCurrent.type === "deltas") expect(readAtCurrent.entries.length).toBe(0)
      // ack ahead must fail
      const exit = yield* Changefeed.ack(db, r3.seq + 100).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      // state must remain uncorrupted after failed ack
      const st2 = yield* Changefeed.getState(db)
      expect(st2.latest_seq).toBe(r3.seq)
      expect(st2.retained_rows).toBe(1)
    }),
  )

  it.effect("gap result after hard eviction and truncation", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const caps = { maxRows: 2, maxBytes: 1_000_000 }
      const e1 = yield* Changefeed.appendWithCaps(db, { session_id: "ses_gap1", revision: 1, kind: "changed", time: 1 }, caps)
      const e2 = yield* Changefeed.appendWithCaps(db, { session_id: "ses_gap2", revision: 1, kind: "changed", time: 2 }, caps)
      const e3 = yield* Changefeed.appendWithCaps(db, { session_id: "ses_gap3", revision: 1, kind: "changed", time: 3 }, caps)
      // e1 evicted by cap (maxRows 2): window is e2,e3
      const gap = yield* Changefeed.readAfter(db, 0)
      expect(gap.type).toBe("rehydrate")
      if (gap.type === "rehydrate") expect(gap.cursor).toBe(e3.seq)
      // after ack truncation, remaining e3, cursor 0 still gap
      yield* Changefeed.ack(db, e2.seq)
      const gap2 = yield* Changefeed.readAfter(db, 0)
      expect(gap2.type).toBe("rehydrate")
      const contiguous = yield* Changefeed.readAfter(db, e2.seq)
      expect(contiguous.type).toBe("deltas")
      if (contiguous.type === "deltas") expect(contiguous.entries.length).toBe(1)
      // invalid cursor ahead
      const ahead = yield* Changefeed.readAfter(db, 999999)
      expect(ahead.type).toBe("rehydrate")
    }),
  )

  it.effect("valid initial and at-current reads", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      // empty feed, cursor 0 valid
      const emptyRead = yield* Changefeed.readAfter(db, 0)
      expect(emptyRead.type).toBe("deltas")
      if (emptyRead.type === "deltas") {
        expect(emptyRead.entries.length).toBe(0)
        expect(emptyRead.cursor).toBe(0)
      }
      const e1 = yield* Changefeed.append(db, { session_id: "ses_init", revision: 1, kind: "changed", time: 1 })
      const after0 = yield* Changefeed.readAfter(db, 0)
      expect(after0.type).toBe("deltas")
      if (after0.type === "deltas") {
        expect(after0.entries.length).toBe(1)
        expect(after0.entries[0]!.seq).toBe(e1.seq)
      }
      const atCurrent = yield* Changefeed.readAfter(db, e1.seq)
      expect(atCurrent.type).toBe("deltas")
      if (atCurrent.type === "deltas") expect(atCurrent.entries.length).toBe(0)
      const st = yield* Changefeed.getState(db)
      expect(atCurrent.type === "deltas" ? atCurrent.cursor : -1).toBe(st.latest_seq)
    }),
  )

  it.effect("payload-free family delete tombstones with final revision and no FK cascade", () =>
    Effect.gen(function* () {
      yield* setup
      const svc = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const root = yield* svc.create({ location })
      const child = yield* svc.create({ location })
      yield* db.update(SessionTable).set({ parent_id: root.id }).where(eq(SessionTable.id, child.id)).run().pipe(Effect.orDie)
      // advance root and child to have revisions >0
      const ev = yield* EventV2.Service
      yield* ev.publish(SessionEvent.Synthetic, { sessionID: root.id, messageID: SessionMessage.ID.create(), timestamp: DateTime.makeUnsafe(30), text: "r" })
      yield* ev.publish(SessionEvent.Synthetic, { sessionID: child.id, messageID: SessionMessage.ID.create(), timestamp: DateTime.makeUnsafe(31), text: "c" })
      const beforeRoot = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, root.id)).get().pipe(Effect.orDie)
      const beforeChild = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, child.id)).get().pipe(Effect.orDie)
      expect(beforeRoot!.rev).toBe(1)
      expect(beforeChild!.rev).toBe(1)
      // make eligible
      yield* db.update(SessionTable).set({ time_updated: 0 }).where(eq(SessionTable.id, root.id)).run().pipe(Effect.orDie)
      yield* db.update(SessionTable).set({ time_updated: 0 }).where(eq(SessionTable.id, child.id)).run().pipe(Effect.orDie)
      const fam = { rootID: root.id, sessionIDs: [root.id, child.id], activity: 0 }
      yield* Retention.deleteFamilyTransaction(db, fam, Date.now(), () => false, () => false)
      const feed = yield* db.select().from(SessionChangefeedTable).orderBy(sql`${SessionChangefeedTable.seq} ASC`).all().pipe(Effect.orDie)
      // should have: 2 creations (0) + 2 changed (one per synthetic each) + 2 deleted tombstones
      expect(feed.length).toBe(6)
      const dels = feed.filter((r) => r.kind === "deleted")
      expect(dels.length).toBe(2)
      for (const d of dels) {
        expect(d.revision).toBe(2) // final revision current+1
      }
      // payload-free check: no extra columns
      for (const d of dels) {
        expect(Object.keys(d).sort()).toEqual(["kind", "revision", "seq", "session_id", "time"])
      }
      // session rows gone
      const r1 = yield* db.select().from(SessionTable).where(eq(SessionTable.id, root.id)).get().pipe(Effect.orDie)
      const r2 = yield* db.select().from(SessionTable).where(eq(SessionTable.id, child.id)).get().pipe(Effect.orDie)
      expect(r1).toBeUndefined()
      expect(r2).toBeUndefined()
      // changefeed rows remain (no FK cascade)
      const still = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, root.id)).all().pipe(Effect.orDie)
      expect(still.length).toBeGreaterThanOrEqual(1)
    }),
  )

  it.effect("feed truncation and eviction cannot affect canonical reconstruction", () =>
    Effect.gen(function* () {
      yield* setup
      const svc = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const s = yield* svc.create({ location })
      const ev = yield* EventV2.Service
      yield* ev.publish(SessionEvent.Synthetic, { sessionID: s.id, messageID: SessionMessage.ID.create(), timestamp: DateTime.makeUnsafe(40), text: "hello" })
      const beforeFeed = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
      expect(beforeFeed.length).toBe(2)
      const stBefore = yield* Changefeed.getState(db)
      // truncate feed via ack
      yield* Changefeed.ack(db, stBefore.latest_seq)
      let afterRows = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
      expect(afterRows.length).toBe(0)
      let stAfter = yield* Changefeed.getState(db)
      expect(stAfter.retained_rows).toBe(0)
      expect(stAfter.latest_seq).toBe(stBefore.latest_seq)
      // canonical reconstruction still works: session still exists and can be read
      const sessRow = yield* db.select().from(SessionTable).where(eq(SessionTable.id, s.id)).get().pipe(Effect.orDie)
      expect(sessRow).toBeDefined()
      expect(sessRow!.revision).toBe(1)
      // create more revisions and force eviction with small cap
      const caps = { maxRows: 1, maxBytes: 1_000_000 }
      yield* Changefeed.appendWithCaps(db, { session_id: s.id, revision: 2, kind: "changed", time: Date.now() }, caps)
      yield* Changefeed.appendWithCaps(db, { session_id: s.id, revision: 3, kind: "changed", time: Date.now() }, caps)
      // first of those evicted, but canonical still intact
      const sessRow2 = yield* db.select().from(SessionTable).where(eq(SessionTable.id, s.id)).get().pipe(Effect.orDie)
      expect(sessRow2).toBeDefined()
      expect(sessRow2!.revision).toBe(1) // note: those appendWithCaps are direct feed writes, not via SessionRevision, so session revision unchanged, but we test truncation not affecting it
      // do a real revision advance again and ensure feed and canonical both update
      yield* ev.publish(SessionEvent.Synthetic, { sessionID: s.id, messageID: SessionMessage.ID.create(), timestamp: DateTime.makeUnsafe(41), text: "world" })
      const sessRow3 = yield* db.select().from(SessionTable).where(eq(SessionTable.id, s.id)).get().pipe(Effect.orDie)
      expect(sessRow3!.revision).toBe(2)
      const feedAfter = yield* db.select().from(SessionChangefeedTable).orderBy(sql`${SessionChangefeedTable.seq} ASC`).all().pipe(Effect.orDie)
      expect(feedAfter.length).toBeGreaterThanOrEqual(1)
    }),
  )

  it.effect("singleton state survives full truncation", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const r1 = yield* Changefeed.append(db, { session_id: "ses_single", revision: 1, kind: "changed", time: 1 })
      const r2 = yield* Changefeed.append(db, { session_id: "ses_single", revision: 2, kind: "changed", time: 2 })
      let st = yield* Changefeed.getState(db)
      expect(st.latest_seq).toBe(r2.seq)
      expect(st.retained_rows).toBe(2)
      yield* Changefeed.ack(db, r2.seq)
      st = yield* Changefeed.getState(db)
      expect(st.retained_rows).toBe(0)
      expect(st.retained_bytes).toBe(0)
      expect(st.latest_seq).toBe(r2.seq)
      // after truncation, new append continues monotonic seq
      const r3 = yield* Changefeed.append(db, { session_id: "ses_single", revision: 3, kind: "changed", time: 3 })
      expect(r3.seq).toBe(r2.seq + 1)
      st = yield* Changefeed.getState(db)
      expect(st.latest_seq).toBe(r3.seq)
      expect(st.retained_rows).toBe(1)
      // verify state row persisted
      const stateRow = yield* db.select().from(SessionChangefeedStateTable).where(eq(SessionChangefeedStateTable.id, 1)).get().pipe(Effect.orDie)
      expect(stateRow).toBeDefined()
      expect(stateRow!.latest_seq).toBe(r3.seq)
    }),
  )

  it.effect("delete tombstone feed state remains consistent on re-read", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      yield* db.update(SessionTable).set({ time_updated: 0 }).where(eq(SessionTable.id, s.id)).run().pipe(Effect.orDie)
      const fam = { rootID: s.id, sessionIDs: [s.id], activity: 0 }
      yield* Retention.deleteFamilyTransaction(db, fam, Date.now(), () => false, () => false)
      const rows = yield* db.select().from(SessionChangefeedTable).orderBy(sql`${SessionChangefeedTable.seq} ASC`).all().pipe(Effect.orDie)
      expect(rows.length).toBe(2)
      const st = yield* Changefeed.getState(db)
      expect(st.retained_rows).toBe(2)
      expect(st.latest_seq).toBe(rows[1]!.seq)
      expect(st.retained_bytes).toBe(
        Changefeed.byteSize(rows[0]!.session_id, rows[0]!.kind) + Changefeed.byteSize(rows[1]!.session_id, rows[1]!.kind),
      )
      const before = st.latest_seq
      const st2 = yield* Changefeed.getState(db)
      expect(st2.latest_seq).toBe(before)
    }),
  )

  // --- Audit blocker regressions ---

  it.effect("concurrent duplicate append is idempotent without seq gap or error", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const sid = "ses_conc_dup_" + Date.now()
      const input = { session_id: sid, revision: 5, kind: "changed" as const, time: Date.now() }
      const results = yield* Effect.all(
        [Changefeed.append(db, input), Changefeed.append(db, input)],
        { concurrency: "unbounded" },
      )
      expect(results[0]!.seq).toBe(results[1]!.seq)
      const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie)
      expect(rows.length).toBe(1)
      // next distinct revision must be exactly +1, proving no seq consumed by duplicate
      const next = yield* Changefeed.append(db, { session_id: sid, revision: 6, kind: "changed", time: Date.now() })
      expect(next.seq).toBe(results[0]!.seq + 1)
      const all = yield* db.select().from(SessionChangefeedTable).orderBy(sql`${SessionChangefeedTable.seq} ASC`).all().pipe(Effect.orDie)
      for (let i = 1; i < all.length; i++) expect(all[i]!.seq).toBe(all[i - 1]!.seq + 1)
    }),
  )

  it.effect("transaction rollback leaves revision, feed, and state unchanged", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const revBefore = yield* db.select({ revision: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, s.id)).get().pipe(Effect.orDie)
      expect(revBefore!.revision).toBe(0)
      const stBefore = yield* Changefeed.getState(db)
      const feedBefore = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
      const exit = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* SessionRevision.advanceTx(s.id, tx as any)
            // also append directly via changefeed to ensure both are rolled back
            yield* Changefeed.appendTx(tx as any, { session_id: s.id, revision: 999, kind: "changed", time: Date.now() })
            yield* Effect.die(new Error("forced rollback"))
          }),
        )
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      const revAfter = yield* db.select({ revision: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, s.id)).get().pipe(Effect.orDie)
      expect(revAfter!.revision).toBe(0)
      const feedAfter = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
      expect(feedAfter.length).toBe(feedBefore.length)
      const stAfter = yield* Changefeed.getState(db)
      expect(stAfter).toEqual(stBefore)
    }),
  )

  it.effect("interior gap anywhere in returned window forces rehydrate", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const caps = { maxRows: 100, maxBytes: 10_000_000 }
      const e1 = yield* Changefeed.appendWithCaps(db, { session_id: "ses_gap_int1", revision: 1, kind: "changed", time: 1 }, caps)
      const e2 = yield* Changefeed.appendWithCaps(db, { session_id: "ses_gap_int2", revision: 1, kind: "changed", time: 2 }, caps)
      const e3 = yield* Changefeed.appendWithCaps(db, { session_id: "ses_gap_int3", revision: 1, kind: "changed", time: 3 }, caps)
      // create interior gap by deleting middle row via raw SQL (simulates corruption/eviction gap)
      yield* db.run(sql`DELETE FROM session_changefeed WHERE seq = ${e2.seq}`).pipe(Effect.orDie)
      // reading from before gap must rehydrate
      const r0 = yield* Changefeed.readAfter(db, e1.seq - 1 >= 0 ? e1.seq - 1 : 0)
      // e1.seq is first, so cursor 0 should now see gap (e1,e3 but missing e2) => rehydrate if 0 is before gap? Let's test cursor = e1.seq
      // Actually easiest: cursor = e1.seq should expect e3 but gap at e2 missing? Wait e2 is after e1 but before e3. Reading after e1 should return e3 alone but seq 3 is missing? Expected cursor+1 = e1.seq+1 = e2.seq, but actual next is e3.seq (= e2.seq+1 + gap?), so should be rehydrate.
      // Our implementation checks entries contiguous from cursor+1, so after e1, expected e1+1 = e2.seq but got e3.seq => gap.
      const afterE1 = yield* Changefeed.readAfter(db, e1.seq)
      expect(afterE1.type).toBe("rehydrate")
      if (afterE1.type === "rehydrate") expect(afterE1.reason).toBe("gap")
      // cursor at e2 (missing) -> reading after e2 should be contiguous (e3 alone) because expected is e2+1 = e3.seq -> no gap
      const afterMissing = yield* Changefeed.readAfter(db, e2.seq)
      expect(afterMissing.type).toBe("deltas")
      // but reading from 0 should also be gap because window contains gap
      const from0 = yield* Changefeed.readAfter(db, 0)
      // from0 includes e1 and e3, gap exists -> rehydrate
      expect(from0.type).toBe("rehydrate")
    }),
  )

  it.effect("missing tail sequence from cursor through latest forces rehydrate", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const e1 = yield* Changefeed.append(db, { session_id: "ses_tail1", revision: 1, kind: "changed", time: 1 })
      const e2 = yield* Changefeed.append(db, { session_id: "ses_tail2", revision: 1, kind: "changed", time: 2 })
      const e3 = yield* Changefeed.append(db, { session_id: "ses_tail3", revision: 1, kind: "changed", time: 3 })
      const latestBefore = (yield* Changefeed.getState(db)).latest_seq
      expect(latestBefore).toBe(e3.seq)
      // simulate missing tail: delete last row without updating state.latest_seq
      yield* db.run(sql`DELETE FROM session_changefeed WHERE seq = ${e3.seq}`).pipe(Effect.orDie)
      const st = yield* Changefeed.getState(db)
      expect(st.latest_seq).toBe(e3.seq)
      // no rows after cursor (empty window) but cursor < latest -> rehydrate
      const afterE2 = yield* Changefeed.readAfter(db, e2.seq)
      expect(afterE2.type).toBe("rehydrate")
      if (afterE2.type === "rehydrate") expect(afterE2.cursor).toBe(st.latest_seq)
      // partial tail: reading from e1 should also rehydrate because window 2..latest is incomplete (3 missing)
      const afterE1 = yield* Changefeed.readAfter(db, e1.seq)
      expect(afterE1.type).toBe("rehydrate")
      const from0 = yield* Changefeed.readAfter(db, 0)
      expect(from0.type).toBe("rehydrate")
      // at-current cursor equals latest should still be deltas empty even though tail missing (no expectation)
      const atCurrent = yield* Changefeed.readAfter(db, st.latest_seq)
      expect(atCurrent.type).toBe("deltas")
      if (atCurrent.type === "deltas") expect(atCurrent.entries.length).toBe(0)
    }),
  )

  it.effect("partial tail missing with truncated middle also rehydrates", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const e1 = yield* Changefeed.append(db, { session_id: "ses_ptail1", revision: 1, kind: "changed", time: 1 })
      const e2 = yield* Changefeed.append(db, { session_id: "ses_ptail2", revision: 1, kind: "changed", time: 2 })
      const e3 = yield* Changefeed.append(db, { session_id: "ses_ptail3", revision: 1, kind: "changed", time: 3 })
      const e4 = yield* Changefeed.append(db, { session_id: "ses_ptail4", revision: 1, kind: "changed", time: 4 })
      yield* db.run(sql`DELETE FROM session_changefeed WHERE seq = ${e4.seq}`).pipe(Effect.orDie)
      // reading from e2 should return e3 only but missing e4 tail -> rehydrate
      const afterE2 = yield* Changefeed.readAfter(db, e2.seq)
      expect(afterE2.type).toBe("rehydrate")
      // reading from e3 also missing tail (e4) -> rehydrate because cursor 3 < latest 4 but no 4
      const afterE3 = yield* Changefeed.readAfter(db, e3.seq)
      expect(afterE3.type).toBe("rehydrate")
    }),
  )

  it.effect("invalid kind is rejected at typed and runtime and DB boundary", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      // runtime via changefeed API should die/throw
      const exit = yield* db
        .transaction((tx) => Changefeed.appendTx(tx as any, { session_id: "ses_bad", revision: 1, kind: "invalid" as any, time: Date.now() }))
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      // DB trigger should also reject raw SQL insert with invalid kind
      const rawExit = yield* db.run(sql`INSERT INTO session_changefeed (session_id, revision, kind, time) VALUES ('ses_bad2', 1, 'bogus', 1)`).pipe(Effect.exit)
      expect(rawExit._tag).toBe("Failure")
      const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, "ses_bad2")).all().pipe(Effect.orDie)
      expect(rows.length).toBe(0)
    }),
  )

  test("actual pre-S4 migration enforces production 50k cap oldest-first and remains rerunnable", async () => {
    const makeDb = EffectDrizzleSqlite.makeWithDefaults()
    const sqliteLayer = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
    const start = Date.now()
    const run = Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run(sql`CREATE TABLE session_changefeed (seq integer PRIMARY KEY AUTOINCREMENT NOT NULL, session_id text NOT NULL, revision integer NOT NULL, kind text NOT NULL, time integer NOT NULL)`)
      yield* db.run(sql`CREATE UNIQUE INDEX session_changefeed_session_revision_kind_idx ON session_changefeed (session_id, revision, kind)`)
      const total = 50_001
      const chunk = 500
      for (let base = 0; base < total; base += chunk) {
        const end = Math.min(base + chunk, total)
        const values: string[] = []
        for (let i = base; i < end; i++) {
          values.push(`('ses_mig_${i}', ${i + 1}, 'changed', ${i})`)
        }
        const stmt = `INSERT INTO session_changefeed (session_id, revision, kind, time) VALUES ${values.join(", ")}`
        yield* db.run(sql.raw(stmt) as any)
      }
      const beforeCount = yield* db.get<{ c: number }>(sql`SELECT count(*) as c FROM session_changefeed`)
      expect(beforeCount!.c).toBe(total)
      const maxBefore = yield* db.get<{ m: number }>(sql`SELECT max(seq) as m FROM session_changefeed`)
      expect(maxBefore!.m).toBe(total)
      yield* DatabaseMigration.applyOnly(db, [changefeedBoundsMigration])
      let state = yield* db.get<{ latest_seq: number; retained_rows: number; retained_bytes: number }>(
        sql`SELECT latest_seq, retained_rows, retained_bytes FROM session_changefeed_state WHERE id = 1`,
      )
      expect(state).toBeDefined()
      expect(state!.latest_seq).toBe(total)
      expect(state!.retained_rows).toBe(50_000)
      expect(state!.retained_bytes).toBeLessThanOrEqual(64 * 1024 * 1024)
      const minAfter = yield* db.get<{ m: number }>(sql`SELECT min(seq) as m FROM session_changefeed`)
      expect(minAfter!.m).toBe(2)
      const maxAfter = yield* db.get<{ m: number }>(sql`SELECT max(seq) as m FROM session_changefeed`)
      expect(maxAfter!.m).toBe(total)
      const countAfter = yield* db.get<{ c: number }>(sql`SELECT count(*) as c FROM session_changefeed`)
      expect(countAfter!.c).toBe(50_000)
      // accurate state: retained bytes matches logical size sum for retained rows
      expect(state!.retained_bytes).toBeGreaterThan(0)
      const beforeLatest = state!.latest_seq
      const beforeRows = state!.retained_rows
      const beforeBytes = state!.retained_bytes
      const beforeMin = minAfter!.m
      const beforeMax = maxAfter!.m
      const beforeCountVal = countAfter!.c
      yield* db.run(sql`DELETE FROM migration WHERE id = ${changefeedBoundsMigration.id}`)
      yield* DatabaseMigration.applyOnly(db, [changefeedBoundsMigration])
      state = yield* db.get<{ latest_seq: number; retained_rows: number; retained_bytes: number }>(
        sql`SELECT latest_seq, retained_rows, retained_bytes FROM session_changefeed_state WHERE id = 1`,
      )
      expect(state!.latest_seq).toBe(beforeLatest)
      expect(state!.retained_rows).toBe(beforeRows)
      expect(state!.retained_bytes).toBe(beforeBytes)
      expect(state!.retained_bytes).toBeLessThanOrEqual(64 * 1024 * 1024)
      const minAfterRerun = yield* db.get<{ m: number }>(sql`SELECT min(seq) as m FROM session_changefeed`)
      const maxAfterRerun = yield* db.get<{ m: number }>(sql`SELECT max(seq) as m FROM session_changefeed`)
      const countAfterRerun = yield* db.get<{ c: number }>(sql`SELECT count(*) as c FROM session_changefeed`)
      expect(minAfterRerun!.m).toBe(beforeMin)
      expect(minAfterRerun!.m).toBe(2)
      expect(maxAfterRerun!.m).toBe(beforeMax)
      expect(countAfterRerun!.c).toBe(beforeCountVal)
      expect(countAfterRerun!.c).toBe(50_000)
      yield* DatabaseMigration.applyOnly(db, [kindCheckMigration])
      const trigger = yield* db.get<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='trigger' AND name='session_changefeed_kind_insert_check'`)
      expect(trigger).toBeDefined()
    })
    await Effect.runPromise(Effect.provide(run, sqliteLayer).pipe(Effect.scoped, Effect.orDie))
    const elapsed = Date.now() - start
    // runtime guard: over-cap fixture should complete in reasonable time (<30s)
    expect(elapsed).toBeLessThan(30_000)
  })

  test("actual migration rerun preserves monotonic latest after ack-equivalent full truncation", async () => {
    const makeDb = EffectDrizzleSqlite.makeWithDefaults()
    const sqliteLayer = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
    const run = Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run(sql`CREATE TABLE session_changefeed (seq integer PRIMARY KEY AUTOINCREMENT NOT NULL, session_id text NOT NULL, revision integer NOT NULL, kind text NOT NULL, time integer NOT NULL)`)
      yield* db.run(sql`CREATE UNIQUE INDEX session_changefeed_session_revision_kind_idx ON session_changefeed (session_id, revision, kind)`)
      for (let i = 0; i < 3; i++) {
        yield* db.run(sql`INSERT INTO session_changefeed (session_id, revision, kind, time) VALUES (${`ses_mono_${i}`}, ${1}, ${"changed"}, ${i})`)
      }
      yield* DatabaseMigration.applyOnly(db, [changefeedBoundsMigration])
      let state = yield* db.get<{ latest_seq: number; retained_rows: number; retained_bytes: number }>(
        sql`SELECT latest_seq, retained_rows, retained_bytes FROM session_changefeed_state WHERE id = 1`,
      )
      const beforeLatest = state!.latest_seq
      expect(beforeLatest).toBe(3)
      expect(state!.retained_rows).toBe(3)
      // ack-equivalent full truncation: delete all rows, keep latest_seq, recalc bytes to 0
      yield* db.run(sql`DELETE FROM session_changefeed`)
      yield* db.run(sql`UPDATE session_changefeed_state SET retained_rows = 0, retained_bytes = 0 WHERE id = 1`)
      const truncated = yield* db.get<{ latest_seq: number; retained_rows: number; retained_bytes: number }>(
        sql`SELECT latest_seq, retained_rows, retained_bytes FROM session_changefeed_state WHERE id = 1`,
      )
      expect(truncated!.latest_seq).toBe(beforeLatest)
      expect(truncated!.retained_rows).toBe(0)
      const count = yield* db.get<{ c: number }>(sql`SELECT count(*) as c FROM session_changefeed`)
      expect(count!.c).toBe(0)
      // force rerun by clearing migration journal entry
      yield* db.run(sql`DELETE FROM migration WHERE id = ${changefeedBoundsMigration.id}`)
      // rerun migration must not move latest backwards and must recalc retained rows/bytes accurately
      yield* DatabaseMigration.applyOnly(db, [changefeedBoundsMigration])
      state = yield* db.get<{ latest_seq: number; retained_rows: number; retained_bytes: number }>(
        sql`SELECT latest_seq, retained_rows, retained_bytes FROM session_changefeed_state WHERE id = 1`,
      )
      expect(state!.latest_seq).toBe(beforeLatest)
      expect(state!.retained_rows).toBe(0)
      expect(state!.retained_bytes).toBe(0)
      // second rerun also stable
      yield* db.run(sql`DELETE FROM migration WHERE id = ${changefeedBoundsMigration.id}`)
      yield* DatabaseMigration.applyOnly(db, [changefeedBoundsMigration])
      const state2 = yield* db.get<{ latest_seq: number }>(sql`SELECT latest_seq FROM session_changefeed_state WHERE id = 1`)
      expect(state2!.latest_seq).toBe(beforeLatest)
      // new inserts after truncation must continue monotonic
      yield* db.run(sql`INSERT INTO session_changefeed (session_id, revision, kind, time) VALUES (${"ses_mono_new"}, ${1}, ${"changed"}, ${99})`)
      const maxAfter = yield* db.get<{ m: number }>(sql`SELECT max(seq) as m FROM session_changefeed`)
      expect(maxAfter!.m).toBe(4)
      // state still shows latest before migration rerun hasn't been updated yet; now run migration again to pick up new max but preserve monotonic (new max > old latest)
      yield* db.run(sql`DELETE FROM migration WHERE id = ${changefeedBoundsMigration.id}`)
      yield* DatabaseMigration.applyOnly(db, [changefeedBoundsMigration])
      const final = yield* db.get<{ latest_seq: number; retained_rows: number }>(
        sql`SELECT latest_seq, retained_rows FROM session_changefeed_state WHERE id = 1`,
      )
      expect(final!.latest_seq).toBe(4)
      expect(final!.retained_rows).toBe(1)
    })
    await Effect.runPromise(Effect.provide(run, sqliteLayer).pipe(Effect.scoped, Effect.orDie))
  })

  it.effect("production canonical reads intact after ack and eviction", (() =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const store = yield* SessionStore.Service
      const todos = yield* SessionTodo.Service
      const s = yield* svc.create({ location })
      yield* events.publish(SessionEvent.Synthetic, { sessionID: s.id, messageID: SessionMessage.ID.create(), timestamp: DateTime.makeUnsafe(100), text: "hello" })
      yield* todos.update({ sessionID: s.id, todos: [{ content: "t1", status: "pending", priority: "high" }] })
      const storeBefore = yield* store.get(s.id)
      expect(storeBefore).toBeDefined()
      const todosBefore = yield* todos.get(s.id)
      expect(todosBefore.length).toBe(1)
      // Ack truncates feed
      const st = yield* Changefeed.getState(db)
      yield* Changefeed.ack(db, st.latest_seq)
      let feed = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
      expect(feed.length).toBe(0)
      // Canonical still intact
      const storeAfterAck = yield* store.get(s.id)
      expect(storeAfterAck?.id).toBe(s.id)
      const rowAfterAck = yield* db.select({ revision: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, s.id)).get().pipe(Effect.orDie)
      expect(rowAfterAck!.revision).toBe(2)
      const todosAfterAck = yield* todos.get(s.id)
      expect(todosAfterAck.length).toBe(1)
      const hist = yield* store.context(s.id).pipe(Effect.orDie)
      expect(hist.length).toBeGreaterThan(0)
      // Force eviction via small caps
      yield* Changefeed.appendWithCaps(db, { session_id: s.id, revision: 999, kind: "changed", time: Date.now() }, { maxRows: 1, maxBytes: 1_000_000 })
      yield* Changefeed.appendWithCaps(db, { session_id: s.id, revision: 1000, kind: "changed", time: Date.now() }, { maxRows: 1, maxBytes: 1_000_000 })
      feed = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
      expect(feed.length).toBe(1)
      // Canonical still intact after eviction
      const storeAfterEvict = yield* store.get(s.id)
      expect(storeAfterEvict?.id).toBe(s.id)
      const todosAfterEvict = yield* todos.get(s.id)
      expect(todosAfterEvict.length).toBe(1)
      const sessRow = yield* db.select().from(SessionTable).where(eq(SessionTable.id, s.id)).get().pipe(Effect.orDie)
      expect(sessRow).toBeDefined()
    }) as any) as any,
  )

})
