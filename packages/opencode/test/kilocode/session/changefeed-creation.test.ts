// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, MessageTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { Session } from "../../../src/session/session"
import { SessionID } from "../../../src/session/schema"
import { SessionCreateDispatchService } from "../../../src/kilocode/session/session-create-dispatch"
import { SessionForkDispatchService } from "../../../src/kilocode/session/session-fork-dispatch"
import { testEffect } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime } from "../../../src/effect/app-runtime"
import * as Log from "@opencode-ai/core/util/log"
import { SessionImportService } from "../../../src/kilocode/session-import/service"
import { applyImportAggregate } from "../../../src/cli/cmd/import"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { MessageID, PartID } from "../../../src/session/schema"

void Log.init({ print: false })

const it = testEffect(Layer.empty)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("creation changefeed - durable and import", () => {
  it.live("durable create success emits exactly one changed@0 for new id", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as any)
      const dir = tmp.path
      const opId = SessionOperation.createId("cf-create-" + Math.random().toString(36).slice(2, 6))
      const req = { v: 1 as const, requestId: "req-cf", opId, op: "session/create" as const, idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "cf-create" } }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any)
      expect(res.status).toBe("succeeded")
      const newId = res.data.id
      const feed = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, newId)).all().pipe(Effect.orDie) })))) as any)
      expect(feed.length).toBe(1)
      expect(feed[0].revision).toBe(0)
      expect(feed[0].kind).toBe("changed")
      expect(feed[0].session_id).toBe(newId)
      const sess = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionTable).where(eq(SessionTable.id, newId)).get().pipe(Effect.orDie) })))) as any)
      expect(sess.revision).toBe(0)
    }),
  )

  it.live("durable create failure emits none", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as any)
      const dir = tmp.path
      const opId = SessionOperation.createId("cf-fail-" + Math.random().toString(36).slice(2, 6))
      const fakeParent = "ses_ffffffffffffffffffffffff"
      const req = { v: 1 as const, requestId: "req-fail", opId, op: "session/create" as const, idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "fail", parentID: fakeParent } }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any)
      expect(res.status).toBe("failed")
      const count = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as any)
      // no entry for non-existent session; count should be 0 or at least no entry for fakeParent
      const ghost = (count as any[]).filter((r) => r.session_id === fakeParent)
      expect(ghost.length).toBe(0)
      // also ensure no session with title fail created
      const sessions = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionTable).all().pipe(Effect.orDie) })))) as any)
      expect((sessions as any[]).filter((s) => s.title === "fail").length).toBe(0)
    }),
  )

  it.live("durable create replay does not consume another seq", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as any)
      const dir = tmp.path
      const opId = SessionOperation.createId("cf-replay-" + Math.random().toString(36).slice(2, 6))
      const req = { v: 1 as const, requestId: "req-replay", opId, op: "session/create" as const, idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "replay" } }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any)
      expect(r1.status).toBe("succeeded")
      const feed1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, r1.data.id)).all().pipe(Effect.orDie) })))) as any)
      const seq1 = feed1[0].seq
      const r2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any)
      expect(r2.status).toBe("succeeded")
      expect(r2.data.id).toBe(r1.data.id)
      const feed2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, r1.data.id)).all().pipe(Effect.orDie) })))) as any)
      expect(feed2.length).toBe(1)
      expect(feed2[0].seq).toBe(seq1)
      // next distinct create must be seq+1
      const opId2 = SessionOperation.createId("cf-replay2-" + Math.random().toString(36).slice(2, 6))
      const req2 = { v: 1 as const, requestId: "req-replay2", opId: opId2, op: "session/create" as const, idempotencyKey: opId2, context: { directory: dir, parentSessionId: null }, payload: { title: "replay2" } }
      const r3 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req2) })))) as any)
      expect(r3.status).toBe("succeeded")
      const feed3 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, r3.data.id)).all().pipe(Effect.orDie) })))) as any)
      expect(feed3[0].seq).toBe(seq1 + 1)
    }),
  )

  it.live("durable fork success emits child changed@0 not source", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as any)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source" }) })))) as any)
      const beforeSrcFeed = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, source.id)).all().pipe(Effect.orDie) })))) as any)
      expect(beforeSrcFeed.length).toBe(1) // creation
      expect(beforeSrcFeed[0].revision).toBe(0)
      const token = "fork-cf-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-fork-cf", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as any)
      expect(res.status).toBe("succeeded")
      const childId = res.data.id
      const childFeed = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, childId)).all().pipe(Effect.orDie) })))) as any)
      expect(childFeed.length).toBe(1)
      expect(childFeed[0].revision).toBe(0)
      expect(childFeed[0].kind).toBe("changed")
      expect(childFeed[0].session_id).toBe(childId)
      const srcFeedAfter = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, source.id)).all().pipe(Effect.orDie) })))) as any)
      // source should still have only its creation, no extra for fork
      expect(srcFeedAfter.length).toBe(1)
      expect(srcFeedAfter[0].revision).toBe(0)
    }),
  )

  it.live("durable fork replay does not duplicate child feed", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as any)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source-replay" }) })))) as any)
      const token = "fork-replay-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-fork-replay", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as any)
      expect(r1.status).toBe("succeeded")
      const feed1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, r1.data.id)).all().pipe(Effect.orDie) })))) as any)
      const seq1 = feed1[0].seq
      const r2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as any)
      expect(r2.status).toBe("succeeded")
      expect(r2.data.id).toBe(r1.data.id)
      const feed2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, r1.data.id)).all().pipe(Effect.orDie) })))) as any)
      expect(feed2.length).toBe(1)
      expect(feed2[0].seq).toBe(seq1)
    }),
  )

  it.live("fresh import via service emits changed@0 and is idempotent via skipped path", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as any)
      const dir = tmp.path
      // ensure project exists via instance
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "warm" }) })))) as any)
      const projectId = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const { db } = yield* Database.Service; const row = yield* db.select().from(ProjectTable).all().pipe(Effect.orDie); return (row[0] as any).id })))) as any)
      const sid = "ses_import_" + Math.random().toString(36).slice(2, 8)
      const payload = { id: sid, projectID: projectId, slug: "import", directory: dir, title: "fresh-import", version: "v2", timeCreated: Date.now(), timeUpdated: Date.now() }
      const r1 = yield* Effect.promise(() => SessionImportService.session(payload as any))
      expect(r1.ok).toBe(true)
      const feed1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie) })))) as any)
      expect(feed1.length).toBe(1)
      expect(feed1[0].revision).toBe(0)
      // replay without force should be skipped and not duplicate
      const r2 = yield* Effect.promise(() => SessionImportService.session(payload as any))
      expect((r2 as any).skipped).toBe(true)
      const feed2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie) })))) as any)
      expect(feed2.length).toBe(1)
      expect(feed2[0].seq).toBe(feed1[0].seq)
      // next fresh import distinct id must be +1
      const sid2 = "ses_import2_" + Math.random().toString(36).slice(2, 6)
      const payload2 = { ...payload, id: sid2 }
      yield* Effect.promise(() => SessionImportService.session(payload2 as any))
      const feed3 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid2)).all().pipe(Effect.orDie) })))) as any)
      expect(feed3[0].seq).toBe(feed1[0].seq + 1)
    }),
  )

  it.live("fresh import failure via missing parent emits none", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as any)
      const dir = tmp.path
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "warm" }) })))) as any)
      const projectId = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const { db } = yield* Database.Service; const row = yield* db.select().from(ProjectTable).all().pipe(Effect.orDie); return (row[0] as any).id })))) as any)
      const sid = "ses_import_fail_" + Math.random().toString(36).slice(2, 6)
      const badParent = "ses_missing_" + Math.random().toString(36).slice(2, 6)
      const payload = { id: sid, projectID: projectId, slug: "import", directory: dir, title: "fail", version: "v2", parentID: badParent, timeCreated: Date.now(), timeUpdated: Date.now() }
      const exit = yield* Effect.promise(() => SessionImportService.session(payload as any)).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      const feed = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie) })))) as any)
      expect(feed.length).toBe(0)
    }),
  )

  it.live("CLI fresh import aggregate emits changed@0 and is idempotent", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as any)
      const dir = tmp.path
      const projectId = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const { db } = yield* Database.Service; const rows = yield* db.select().from(ProjectTable).all().pipe(Effect.orDie); if (rows.length === 0) { const svc = yield* Session.Service; yield* svc.create({ title: "warm" }); const rows2 = yield* db.select().from(ProjectTable).all().pipe(Effect.orDie); return (rows2[0] as any).id } return (rows[0] as any).id })))) as any)
      const sid = "ses_cli_cf_" + Math.random().toString(36).slice(2, 6)
      const msgId = "msg_" + Math.random().toString(36).slice(2, 6)
      const partId = "prt_" + Math.random().toString(36).slice(2, 6)
      const msgs = [{ info: { id: msgId, sessionID: sid, role: "user", time: { created: 1 }, agent: "test", model: { providerID: "t", modelID: "t" } }, parts: [{ id: partId, sessionID: sid, messageID: msgId, type: "text", text: "hello" }] }]
      const run = (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { return yield* applyImportAggregate({ session: { id: sid, project_id: projectId, directory: dir, path: "" }, messages: msgs as any }).pipe(Effect.orDie) })))) as any)
      const r1 = yield* run
      expect(r1.changed).toBe(true)
      const feed1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie) })))) as any)
      expect(feed1.length).toBe(1)
      expect(feed1[0].revision).toBe(0)
      const seq1 = feed1[0].seq
      // exact retry should be no-op and not duplicate feed
      const r2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { return yield* applyImportAggregate({ session: { id: sid, project_id: projectId, directory: dir, path: "" }, messages: msgs as any }).pipe(Effect.orDie) })))) as any)
      expect(r2.changed).toBe(false)
      const feed2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie) })))) as any)
      expect(feed2.length).toBe(1)
      expect(feed2[0].seq).toBe(seq1)
      // next distinct session must be +1
      const sid2 = "ses_cli_cf2_" + Math.random().toString(36).slice(2, 6)
      const msgs2 = [{ info: { id: "msg2_" + sid2, sessionID: sid2, role: "user", time: { created: 1 }, agent: "test", model: { providerID: "t", modelID: "t" } }, parts: [] }]
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { return yield* applyImportAggregate({ session: { id: sid2, project_id: projectId, directory: dir, path: "" }, messages: msgs2 as any }).pipe(Effect.orDie) })))) as any)
      const feed3 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid2)).all().pipe(Effect.orDie) })))) as any)
      expect(feed3[0].seq).toBe(seq1 + 1)
    }),
  )

  it.live("CLI import failure rolls back without feed", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as any)
      const dir = tmp.path
      const projectId = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const { db } = yield* Database.Service; const rows = yield* db.select().from(ProjectTable).all().pipe(Effect.orDie); if (rows.length === 0) { const svc = yield* Session.Service; yield* svc.create({ title: "warm" }); const rows2 = yield* db.select().from(ProjectTable).all().pipe(Effect.orDie); return (rows2[0] as any).id } return (rows[0] as any).id })))) as any)
      const sid = "ses_cli_fail_" + Math.random().toString(36).slice(2, 6)
      // create a conflicting message in another session to force cross-session ownership failure
      const otherSid = "ses_cli_other_" + Math.random().toString(36).slice(2, 6)
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; yield* db.insert(SessionTable).values({ id: SessionID.make(otherSid), project_id: ProjectV2.ID.make(projectId), slug: "other", directory: dir, title: "other", version: "v2", time_created: 1, time_updated: 1, revision: 0 } as any).run().pipe(Effect.orDie); yield* db.insert(MessageTable).values({ id: MessageID.make("msg_conflict"), session_id: SessionID.make(otherSid), time_created: 1, data: { role: "user", time: { created: 1 } } as any }).run().pipe(Effect.orDie) })))) as any)
      const msgs = [{ info: { id: "msg_conflict", sessionID: sid, role: "user", time: { created: 1 }, agent: "test", model: { providerID: "t", modelID: "t" } }, parts: [] }]
      const exit = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { return yield* applyImportAggregate({ session: { id: sid, project_id: projectId, directory: dir, path: "" }, messages: msgs as any }).pipe(Effect.orDie) }))) ).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      const feed = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie) })))) as any)
      expect(feed.length).toBe(0)
      const sess = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionTable).where(eq(SessionTable.id, sid as any)).get().pipe(Effect.orDie) })))) as any)
      expect(sess).toBeUndefined()
    }),
  )

  it.live("force import via service advances revision and appends new feed, replay stays stable", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as any)
      const dir = tmp.path
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "warm" }) })))) as any)
      const projectId = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const { db } = yield* Database.Service; const row = yield* db.select().from(ProjectTable).all().pipe(Effect.orDie); return (row[0] as any).id })))) as any)
      const sid = "ses_force_" + Math.random().toString(36).slice(2, 6)
      const base = { id: sid, projectID: projectId, slug: "force", directory: dir, title: "initial", version: "v2", timeCreated: Date.now(), timeUpdated: Date.now() }
      const r1 = yield* Effect.promise(() => SessionImportService.session(base as any))
      expect(r1.ok).toBe(true)
      const feed1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie) })))) as any)
      expect(feed1.length).toBe(1)
      expect(feed1[0].revision).toBe(0)
      const seq0 = feed1[0].seq
      const row0 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionTable).where(eq(SessionTable.id, sid as any)).get().pipe(Effect.orDie) })))) as any)
      expect((row0 as any).revision).toBe(0)
      const forced = { ...base, title: "forced", force: true }
      const r2 = yield* Effect.promise(() => SessionImportService.session(forced as any))
      expect(r2.ok).toBe(true)
      const feed2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie) })))) as any)
      expect(feed2.length).toBe(2)
      const revs = (feed2 as any[]).map((r) => r.revision).sort((a: number, b: number) => a - b)
      expect(revs).toEqual([0, 1])
      expect((feed2 as any[]).find((r) => r.revision === 1)!.seq).toBeGreaterThan(seq0)
      const row1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionTable).where(eq(SessionTable.id, sid as any)).get().pipe(Effect.orDie) })))) as any)
      expect((row1 as any).revision).toBe(1)
      expect((row1 as any).title).toBe("forced")
      const r3 = yield* Effect.promise(() => SessionImportService.session(base as any))
      expect((r3 as any).skipped).toBe(true)
      const feed3 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie) })))) as any)
      expect(feed3.length).toBe(2)
    }),
  )
})
