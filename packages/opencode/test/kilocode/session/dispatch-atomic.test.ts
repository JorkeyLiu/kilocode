// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, SessionOperationTable, SessionDeleteTombstoneTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { EventTable, EventSequenceTable } from "@opencode-ai/core/event/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { Session } from "../../../src/session/session"
import { SessionID } from "../../../src/session/schema"
import { SessionCreateDispatchService } from "../../../src/kilocode/session/session-create-dispatch"
import { SessionUpdateDispatchService } from "../../../src/kilocode/session/session-update-dispatch"
import { SessionDeleteDispatchService } from "../../../src/kilocode/session/session-delete-dispatch"
import { DispatchAtomicSeam } from "../../../src/kilocode/session/dispatch-atomic-seam"
import { testEffect } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime } from "../../../src/effect/app-runtime"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

const it = testEffect(Layer.empty)

afterEach(async () => {
  DispatchAtomicSeam.failCreateInsideTx = false
  DispatchAtomicSeam.failUpdateInsideTx = false
  DispatchAtomicSeam.failDeleteBeforeTx = false
  DispatchAtomicSeam.failDeleteInsideTx = false
  if (globalThis.__dispatchAtomicSeam) {
    globalThis.__dispatchAtomicSeam.failDeleteInsideTx = false
  }
  await disposeAllInstances()
  await resetDatabase()
})

async function countTable(db, table, where) {
  const rows = await AppRuntime.runPromise(
    provideInstance("__unused__")(
      Effect.gen(function* () {
        const d = (yield* Database.Service).db
        const q = where ? d.select().from(table).where(where).all() : d.select().from(table).all()
        return yield* q.pipe(Effect.orDie)
      }),
    ),
  )
  return rows.length
}

describe("dispatch atomic S1", () => {
  it.live("create tx failure leaves no session/operation/changefeed/event residual", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      // baseline counts before any create in this dir
      const beforeSessions = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.directory, dir))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const beforeOps = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie)
              return rows.filter((r) => r.directory === dir).length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const beforeFeed = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const beforeEvents = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const beforeSeq = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>

      DispatchAtomicSeam.failCreateInsideTx = true
      const opId = SessionOperation.createId("atomic-create-fail")
      const req = {
        v: 1 as const,
        requestId: "req-atomic-create",
        opId,
        op: "session/create" as const,
        idempotencyKey: "create:atomic-create-fail",
        context: { directory: dir, parentSessionId: null },
        payload: { title: "should-not-persist" },
      }
      const result = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionCreateDispatchService
              return yield* d.dispatch(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(result.status).toBe("failed")
      expect(result.failure.code).toBe("internal")
      DispatchAtomicSeam.failCreateInsideTx = false

      const afterSessions = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.directory, dir))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const afterOps = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie)
              return rows.filter((r) => r.directory === dir).length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const afterFeed = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const afterEvents = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const afterSeq = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>

      expect(afterSessions).toBe(beforeSessions)
      expect(afterOps).toBe(beforeOps)
      expect(afterFeed).toBe(beforeFeed)
      expect(afterEvents).toBe(beforeEvents)
      expect(afterSeq).toBe(beforeSeq)
    }),
  )

  it.live("update tx failure keeps original title/revision/operation/feed/event", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const session = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "orig-title" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const sid = SessionID.make(session.id)
      const beforeTitle = session.title
      const beforeRev = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db
                .select({ rev: SessionTable.revision })
                .from(SessionTable)
                .where(eq(SessionTable.id, sid))
                .get()
                .pipe(Effect.orDie)
              return row!.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const beforeFeed = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionChangefeedTable)
                .where(eq(SessionChangefeedTable.session_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const beforeOps = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionOperationTable)
                .where(eq(SessionOperationTable.session_id, sid))
                .all()
                .pipe(Effect.orDie)
              return rows.filter((r) => r.op_kind === "sessionUpdate").length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const beforeEvents = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(EventTable)
                .where(eq(EventTable.aggregate_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>

      DispatchAtomicSeam.failUpdateInsideTx = true
      const opId = SessionOperation.sessionUpdateId(session.id, "atomic-update-fail")
      const req = {
        v: 1 as const,
        requestId: "req-atomic-update",
        opId,
        op: "session/update" as const,
        idempotencyKey: `sessionUpdate:${session.id}:atomic-update-fail`,
        context: { directory: dir, sessionId: session.id, parentSessionId: null },
        payload: { title: "new-title-should-not-persist" },
      }
      const result = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionUpdateDispatchService
              return yield* d.dispatch(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(result.status).toBe("failed")
      expect(result.failure.code).toBe("internal")
      DispatchAtomicSeam.failUpdateInsideTx = false

      const afterRev = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db
                .select({ rev: SessionTable.revision })
                .from(SessionTable)
                .where(eq(SessionTable.id, sid))
                .get()
                .pipe(Effect.orDie)
              return row!.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const afterTitle = (yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.get(sid)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>).title
      const afterFeed = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionChangefeedTable)
                .where(eq(SessionChangefeedTable.session_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const afterOps = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionOperationTable)
                .where(eq(SessionOperationTable.session_id, sid))
                .all()
                .pipe(Effect.orDie)
              return rows.filter((r) => r.op_kind === "sessionUpdate").length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const afterEvents = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(EventTable)
                .where(eq(EventTable.aggregate_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>

      expect(afterRev).toBe(beforeRev)
      expect(afterTitle).toBe(beforeTitle)
      expect(afterFeed).toBe(beforeFeed)
      expect(afterOps).toBe(beforeOps)
      expect(afterEvents).toBe(beforeEvents)
    }),
  )

  it.live("delete before-tx failure keeps session/tombstone/feed/operation/event", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const session = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "to-delete" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const sid = SessionID.make(session.id)
      const beforeRev = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db
                .select({ rev: SessionTable.revision })
                .from(SessionTable)
                .where(eq(SessionTable.id, sid))
                .get()
                .pipe(Effect.orDie)
              return row?.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number | undefined>
      const beforeFeed = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionChangefeedTable)
                .where(eq(SessionChangefeedTable.session_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const beforeTomb = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionDeleteTombstoneTable)
                .where(eq(SessionDeleteTombstoneTable.session_id, sid))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const beforeEvents = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(EventTable)
                .where(eq(EventTable.aggregate_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const beforeSeq = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>

      DispatchAtomicSeam.failDeleteBeforeTx = true
      const token = "atomic-delete-fail-before"
      const opId = SessionOperation.deleteId(session.id, token)
      const req = {
        v: 1 as const,
        requestId: "req-atomic-delete",
        opId,
        op: "session/delete" as const,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: session.id, parentSessionId: null },
        payload: {},
      }
      const result = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionDeleteDispatchService
              return yield* d.dispatch(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(result.status).toBe("failed")
      expect(result.failure.code).toBe("internal")
      DispatchAtomicSeam.failDeleteBeforeTx = false

      const afterSession = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.get(sid)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(afterSession.id).toBe(session.id)
      const afterRev = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db
                .select({ rev: SessionTable.revision })
                .from(SessionTable)
                .where(eq(SessionTable.id, sid))
                .get()
                .pipe(Effect.orDie)
              return row?.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number | undefined>
      expect(afterRev).toBe(beforeRev)
      const afterFeed = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionChangefeedTable)
                .where(eq(SessionChangefeedTable.session_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(afterFeed).toBe(beforeFeed)
      const afterTomb = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionDeleteTombstoneTable)
                .where(eq(SessionDeleteTombstoneTable.session_id, sid))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(afterTomb).toBe(beforeTomb)
      const afterEvents = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(EventTable)
                .where(eq(EventTable.aggregate_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(afterEvents).toBe(beforeEvents)
      const afterSeq = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(afterSeq).toBe(beforeSeq)
      // FS obligation not created on before-tx failure (no RetentionObligation row), outer failure is explicitly covered.
    }),
  )

  it.live("delete inside-tx failure rolls back Event/EventSequence + changefeed/tombstone/session atomically", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const session = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "to-delete-inner" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const sid = SessionID.make(session.id)
      const beforeTitle = session.title
      const beforeRev = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db
                .select({ rev: SessionTable.revision })
                .from(SessionTable)
                .where(eq(SessionTable.id, sid))
                .get()
                .pipe(Effect.orDie)
              return row!.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const beforeFeed = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionChangefeedTable)
                .where(eq(SessionChangefeedTable.session_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const beforeTomb = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionDeleteTombstoneTable)
                .where(eq(SessionDeleteTombstoneTable.session_id, sid))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const beforeEvents = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(EventTable)
                .where(eq(EventTable.aggregate_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const beforeSeq = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>

      DispatchAtomicSeam.failDeleteInsideTx = true
      ;(globalThis as any).__dispatchAtomicSeam = DispatchAtomicSeam
      const token = "atomic-delete-fail-inside"
      const opId = SessionOperation.deleteId(session.id, token)
      const req = {
        v: 1 as const,
        requestId: "req-atomic-delete-inner",
        opId,
        op: "session/delete" as const,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: session.id, parentSessionId: null },
        payload: {},
      }
      const result = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionDeleteDispatchService
              return yield* d.dispatch(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(result.status).toBe("failed")
      expect(result.failure.code).toBe("internal")
      DispatchAtomicSeam.failDeleteInsideTx = false
      ;(globalThis as any).__dispatchAtomicSeam.failDeleteInsideTx = false

      const afterSession = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.get(sid)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(afterSession.id).toBe(session.id)
      expect(afterSession.title).toBe(beforeTitle)
      const afterRev = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db
                .select({ rev: SessionTable.revision })
                .from(SessionTable)
                .where(eq(SessionTable.id, sid))
                .get()
                .pipe(Effect.orDie)
              return row!.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(afterRev).toBe(beforeRev)
      const afterFeed = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionChangefeedTable)
                .where(eq(SessionChangefeedTable.session_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(afterFeed).toBe(beforeFeed)
      const afterTomb = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionDeleteTombstoneTable)
                .where(eq(SessionDeleteTombstoneTable.session_id, sid))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(afterTomb).toBe(beforeTomb)
      const afterEvents = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(EventTable)
                .where(eq(EventTable.aggregate_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(afterEvents).toBe(beforeEvents)
      const afterSeq = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(afterSeq).toBe(beforeSeq)
    }),
  )

  it.live("success path still atomically commits and remains idempotent", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      // create success
      const createOp = SessionOperation.createId("atomic-success-create")
      const createReq = {
        v: 1 as const,
        requestId: "req-success-create",
        opId: createOp,
        op: "session/create" as const,
        idempotencyKey: "create:atomic-success-create",
        context: { directory: dir, parentSessionId: null },
        payload: { title: "success-title" },
      }
      const c1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionCreateDispatchService
              return yield* d.dispatch(createReq)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(c1.status).toBe("succeeded")
      const sid = SessionID.make(c1.data.id)
      const revAfterCreate = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db
                .select({ rev: SessionTable.revision })
                .from(SessionTable)
                .where(eq(SessionTable.id, sid))
                .get()
                .pipe(Effect.orDie)
              return row!.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(revAfterCreate).toBe(0)
      const feedAfterCreate = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionChangefeedTable)
                .where(eq(SessionChangefeedTable.session_id, c1.data.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(feedAfterCreate).toBe(1)
      // create replay idempotent
      const c2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionCreateDispatchService
              return yield* d.dispatch(createReq)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(c2.status).toBe("succeeded")
      expect(c2.data.id).toBe(c1.data.id)
      expect(c2.revision.session).toBe(c1.revision.session)

      // update success
      const updOp = SessionOperation.sessionUpdateId(c1.data.id, "atomic-success-upd")
      const updReq = {
        v: 1 as const,
        requestId: "req-success-upd",
        opId: updOp,
        op: "session/update" as const,
        idempotencyKey: `sessionUpdate:${c1.data.id}:atomic-success-upd`,
        context: { directory: dir, sessionId: c1.data.id, parentSessionId: null },
        payload: { title: "updated-title" },
      }
      const u1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionUpdateDispatchService
              return yield* d.dispatch(updReq)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(u1.status).toBe("succeeded")
      expect(u1.data.title).toBe("updated-title")
      const revAfterUpd = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db
                .select({ rev: SessionTable.revision })
                .from(SessionTable)
                .where(eq(SessionTable.id, sid))
                .get()
                .pipe(Effect.orDie)
              return row!.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(revAfterUpd).toBe(1)
      const feedAfterUpd = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionChangefeedTable)
                .where(eq(SessionChangefeedTable.session_id, c1.data.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(feedAfterUpd).toBe(2)
      // update replay
      const u2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionUpdateDispatchService
              return yield* d.dispatch(updReq)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(u2.status).toBe("succeeded")
      expect(u2.data.title).toBe("updated-title")
      expect(u2.revision.session).toBe(u1.revision.session)

      // delete success — Event/EventSequence, changefeed deleted row, tombstone and obligation co-commit atomically
      const beforeDelEvents = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(EventTable)
                .where(eq(EventTable.aggregate_id, c1.data.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(beforeDelEvents).toBeGreaterThan(0)
      const beforeDelSeq = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, c1.data.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(beforeDelSeq).toBe(1)
      const delToken = "atomic-success-del"
      const delOp = SessionOperation.deleteId(c1.data.id, delToken)
      const delReq = {
        v: 1 as const,
        requestId: "req-success-del",
        opId: delOp,
        op: "session/delete" as const,
        idempotencyKey: delOp,
        context: { directory: dir, sessionId: c1.data.id, parentSessionId: null },
        payload: {},
      }
      const d1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionDeleteDispatchService
              return yield* d.dispatch(delReq)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(d1.status).toBe("succeeded")
      const afterDel = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sid)).get().pipe(Effect.orDie)
              return row
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(afterDel).toBeUndefined()
      const tombAfter = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionDeleteTombstoneTable)
                .where(eq(SessionDeleteTombstoneTable.session_id, sid))
                .all()
                .pipe(Effect.orDie)
              return rows
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(tombAfter.length).toBe(1)
      expect(tombAfter[0].outcome).toBe("succeeded")
      const feedAfterDel = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionChangefeedTable)
                .where(eq(SessionChangefeedTable.session_id, c1.data.id))
                .all()
                .pipe(Effect.orDie)
              return rows
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(feedAfterDel.some((r: any) => r.kind === "deleted")).toBe(true)
      const afterDelEvents = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(EventTable)
                .where(eq(EventTable.aggregate_id, c1.data.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(afterDelEvents).toBe(0)
      const afterDelSeq = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, c1.data.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(afterDelSeq).toBe(0)
      // delete replay remains idempotent and does not resurrect events
      const d2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionDeleteDispatchService
              return yield* d.dispatch(delReq)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(d2.status).toBe("succeeded")
      const afterReplayEvents = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(EventTable)
                .where(eq(EventTable.aggregate_id, c1.data.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(afterReplayEvents).toBe(0)
    }),
  )
})
