// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { Session } from "../../../src/session/session"
import { SessionForkDispatchService } from "../../../src/kilocode/session/session-fork-dispatch"
import { Layer } from "effect"
import { testEffect } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime } from "../../../src/effect/app-runtime"
import * as Log from "@opencode-ai/core/util/log"
import { Storage } from "../../../src/storage/storage"
import { baseKey } from "../../../src/kilocode/session-portability/cumulative-diff"
import { SessionID } from "../../../src/session/schema"
import { ForkSeam } from "../../../src/kilocode/session/fork-seam"
import { Global } from "@opencode-ai/core/global"
import * as fs from "node:fs/promises"
import { storageFileForKey } from "../../../src/storage/claimed-file"

void Log.init({ print: false })

const it = testEffect(Layer.empty)

afterEach(async () => {
  ForkSeam.nextId = undefined
  await disposeAllInstances()
  await resetDatabase()
})

describe("sessionFork durable event aggregate preflight", () => {
  it.live("preexisting target EventSequence/EventTable without SessionTable fails conflict and preserves event and no FS/DB mutation", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "src-event-preflight" }) })))) as unknown as Effect.Effect<any, any, any>)
      const diff = [{ file: "a.txt", patch: "diff", additions: 1, deletions: 0 } as unknown as any]
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.write(baseKey(source.id), diff); yield* s.write(["session_diff", source.id], diff) })))) as unknown as Effect.Effect<any, any, any>)

      const knownTarget = SessionID.descending()
      ForkSeam.nextId = knownTarget as string

      // Insert orphaned event aggregate for knownTarget without SessionTable row
      const eventId = `evt_${Math.random().toString(36).slice(2, 10)}`
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.insert(EventSequenceTable).values({ aggregate_id: knownTarget as unknown as string, seq: 1 }).run().pipe(Effect.orDie)
        yield* db.insert(EventTable).values({ id: eventId as unknown as any, aggregate_id: knownTarget as unknown as string, seq: 1, type: "session.created.1", data: { sessionID: knownTarget } } as unknown as typeof EventTable.$inferInsert).run().pipe(Effect.orDie)
      })))) as unknown as Effect.Effect<any, any, any>)

      const beforeSeq = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, knownTarget as unknown as string)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(beforeSeq.length).toBe(1)
      expect(beforeSeq[0].seq).toBe(1)
      const beforeEvt = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, knownTarget as unknown as string)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(beforeEvt.length).toBe(1)
      expect(beforeEvt[0].id).toBe(eventId)

      const token = "evt-preflight-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-evt-preflight", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(res.status).toBe("failed")
      expect(res.failure.code).toBe("conflict")
      expect(res.failure.message).toContain("fork target already exists")

      // No FS mutation for target
      const baseExists = yield* Effect.promise(() => fs.stat(storageFileForKey(baseKey(knownTarget), Global.Path.data)).then(() => true).catch(() => false))
      expect(baseExists).toBe(false)
      const diffExists = yield* Effect.promise(() => fs.stat(storageFileForKey(["session_diff", knownTarget], Global.Path.data)).then(() => true).catch(() => false))
      expect(diffExists).toBe(false)
      const storageBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(knownTarget)).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false))) })))) as unknown as Effect.Effect<any, any, any>)
      expect(storageBase).toBe(false)

      // No DB mutation: no SessionTable row, original event preserved exactly
      const targetRow = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); return yield* db.select().from(SessionTable).where(eq(SessionTable.id, knownTarget as unknown as SessionID)).get().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(targetRow).toBeUndefined()
      const afterSeq = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, knownTarget as unknown as string)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterSeq.length).toBe(1)
      expect(afterSeq[0].seq).toBe(1)
      expect(afterSeq[0].aggregate_id).toBe(knownTarget)
      const afterEvt = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, knownTarget as unknown as string)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterEvt.length).toBe(1)
      expect(afterEvt[0].id).toBe(eventId)
      expect(afterEvt[0].seq).toBe(1)
      // No operation row for this attempt
      const opRow = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* SessionOperation.get(db, opId).pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(opRow).toBeUndefined()
      // Source preserved
      const srcBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(source.id)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(srcBase).toEqual(diff)
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).length).toBe(1)
      expect((list as any[])[0].id).toBe(source.id)

      // Cleanup orphaned event aggregate
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, knownTarget as unknown as string)).run().pipe(Effect.orDie); yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, knownTarget as unknown as string)).run().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.remove(baseKey(source.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(["session_diff", source.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)) })))) as unknown as Effect.Effect<any, any, any>)
    }),
  )

  it.live("preexisting target EventSequence alone without SessionTable fails conflict and preserves event", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "src-seq-only" }) })))) as unknown as Effect.Effect<any, any, any>)
      const knownTarget = SessionID.descending()
      ForkSeam.nextId = knownTarget as string
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.insert(EventSequenceTable).values({ aggregate_id: knownTarget as unknown as string, seq: 5 }).run().pipe(Effect.orDie)
      })))) as unknown as Effect.Effect<any, any, any>)
      const beforeSeq = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, knownTarget as unknown as string)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(beforeSeq.length).toBe(1)
      expect(beforeSeq[0].seq).toBe(5)
      const beforeEvt = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, knownTarget as unknown as string)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(beforeEvt.length).toBe(0)
      const token = "seq-only-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-seq-only", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(res.status).toBe("failed")
      expect(res.failure.code).toBe("conflict")
      expect(res.failure.message).toContain("fork target already exists")
      // No FS mutation for target — both base and diff absent via direct fs and Storage, no sandbox
      const baseExists = yield* Effect.promise(() => fs.stat(storageFileForKey(baseKey(knownTarget), Global.Path.data)).then(() => true).catch(() => false))
      expect(baseExists).toBe(false)
      const diffExists = yield* Effect.promise(() => fs.stat(storageFileForKey(["session_diff", knownTarget], Global.Path.data)).then(() => true).catch(() => false))
      expect(diffExists).toBe(false)
      const storageBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(knownTarget)).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false))) })))) as unknown as Effect.Effect<any, any, any>)
      expect(storageBase).toBe(false)
      const storageDiff = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(["session_diff", knownTarget]).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false))) })))) as unknown as Effect.Effect<any, any, any>)
      expect(storageDiff).toBe(false)
      const sandboxExists = yield* Effect.promise(() => import("../../../src/kilocode/sandbox/store").then((m) => (m as unknown as { SandboxStore: { read: (d: string, id: unknown) => Promise<unknown> } }).SandboxStore.read(dir, knownTarget as unknown as SessionID).then((v) => !!v).catch(() => false)))
      expect(sandboxExists).toBe(false)
      // No DB mutation: no SessionTable row, original EventSequence preserved exactly, no EventTable row, no operation
      const targetRow = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); return yield* db.select().from(SessionTable).where(eq(SessionTable.id, knownTarget as unknown as SessionID)).get().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(targetRow).toBeUndefined()
      const afterSeq = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, knownTarget as unknown as string)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterSeq.length).toBe(1)
      expect(afterSeq[0].seq).toBe(5)
      expect(afterSeq[0].aggregate_id).toBe(knownTarget)
      const afterEvt = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, knownTarget as unknown as string)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterEvt.length).toBe(0)
      const opRow = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* SessionOperation.get(db, opId).pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(opRow).toBeUndefined()
      // Source preserved (no diff needed for seq-only, but session still listed)
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).length).toBe(1)
      expect((list as any[])[0].id).toBe(source.id)
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, knownTarget as unknown as string)).run().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
    }),
  )
})
