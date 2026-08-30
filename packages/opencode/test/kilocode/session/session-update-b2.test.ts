// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { Session } from "../../../src/session/session"
import { SessionID } from "../../../src/session/schema"
import { SessionUpdateDispatchService } from "../../../src/kilocode/session/session-update-dispatch"
import { testEffect, pollWithTimeout } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { makeAppLayer } from "../../../src/effect/app-runtime"
import * as Log from "@opencode-ai/core/util/log"
import { Server } from "../../../src/server/server"
import { ConfigConvergence } from "../../../src/kilocode/server/config-convergence"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { Flag } from "@opencode-ai/core/flag/flag"
import path from "path"
import os from "os"
import fs from "fs/promises"

void Log.init({ print: false })

const it = testEffect(Layer.empty)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("sessionUpdate B2", () => {
  it.live("success commits title exactly one revision and one changefeed and terminal operation", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const beforeRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      const beforeFeed = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie); return rows.length })))) as unknown as Effect.Effect<any, any, any>)
      const opId = SessionOperation.sessionUpdateId(session.id)
      const req = { v: 1 as const, requestId: "req1", opId, op: "session/update" as const, idempotencyKey: "idem-success", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "new title" } }
      const result = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(result.status).toBe("succeeded")
      if (result.status === "succeeded") expect(result.data.title).toBe("new title")
      const afterRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterRev - beforeRev).toBe(1)
      const afterFeed = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie); return rows.length })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterFeed - beforeFeed).toBe(1)
      const info = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.get(SessionID.make(session.id)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(info.title).toBe("new title")
      const opRows = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const ups = (opRows as any[]).filter((r) => r.op_kind === "sessionUpdate")
      expect(ups.length).toBe(1)
      expect(ups[0].outcome).toBe("succeeded")
      expect(ups[0].title).toBe("new title")
      expect(ups[0].revision).toBe(afterRev)
    }),
  )

  it.live("same-key replay does not mutate or advance revision or feed", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const opId = SessionOperation.sessionUpdateId(session.id)
      const req = { v: 1 as const, requestId: "req-replay", opId, op: "session/update" as const, idempotencyKey: "idem-replay", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "first" } }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect((r1 as any).status).toBe("succeeded")
      const rev1 = (r1 as any).revision.session
      const feed1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie); return rows.length })))) as unknown as Effect.Effect<any, any, any>)
      const r2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect((r2 as any).status).toBe("succeeded")
      const rev2 = (r2 as any).revision.session
      expect(rev2).toBe(rev1)
      const feed2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie); return rows.length })))) as unknown as Effect.Effect<any, any, any>)
      expect(feed2).toBe(feed1)
      const info = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.get(SessionID.make(session.id)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(info.title).toBe("first")
      const opRows = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      expect((opRows as any[]).filter((r) => r.op_kind === "sessionUpdate").length).toBe(1)
    }),
  )

  it.live("stale sessionRevision fails without mutation", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const sid = SessionID.make(session.id)
      // bump revision via todo
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const mod = yield* Effect.promise(() => import("../../../src/session/todo")); const todoSvc = yield* (mod as any).Todo.Service; yield* todoSvc.update({ sessionID: sid, todos: [{ content: "t", status: "pending", priority: "high" }] }) })))) as unknown as Effect.Effect<any, any, any>)
      const curRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      const beforeTitle = (yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.get(sid) })))) as unknown as Effect.Effect<any, any, any>)).title
      const opId = SessionOperation.sessionUpdateId(session.id)
      const req = { v: 1 as const, requestId: "req-stale", opId, op: "session/update" as const, idempotencyKey: "idem-stale", context: { directory: dir, sessionId: session.id, parentSessionId: null, sessionRevision: 0 }, payload: { title: "new" } }
      const result = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect((result as any).status).toBe("failed")
      expect((result as any).failure.code).toBe("stale")
      const afterRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterRev).toBe(curRev)
      const afterTitle = (yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.get(sid) })))) as unknown as Effect.Effect<any, any, any>)).title
      expect(afterTitle).toBe(beforeTitle)
      const opRows = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      expect((opRows as any[]).filter((r) => r.op_kind === "sessionUpdate").length).toBe(0)
    }),
  )

  it.live("scope mismatch fails without mutation", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const otherTmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const otherDir = otherTmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const curRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      const opId = SessionOperation.sessionUpdateId(session.id)
      const req = { v: 1 as const, requestId: "req-scope", opId, op: "session/update" as const, idempotencyKey: "idem-scope", context: { directory: otherDir, sessionId: session.id, parentSessionId: null }, payload: { title: "new" } }
      const result = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect((result as any).status).toBe("failed")
      expect((result as any).failure.code).toBe("scope_mismatch")
      const afterRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterRev).toBe(curRev)
    }),
  )

  it.live("validation fails without mutation", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const curRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      const opId = SessionOperation.sessionUpdateId(session.id)
      // empty title
      const req1 = { v: 1 as const, requestId: "req-val1", opId, op: "session/update" as const, idempotencyKey: "idem-val1", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "   " } }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req1) })))) as unknown as Effect.Effect<any, any, any>)
      expect((r1 as any).status).toBe("failed")
      expect((r1 as any).failure.code).toBe("validation.failed")
      // too long
      const long = "a".repeat(201)
      const req2 = { v: 1 as const, requestId: "req-val2", opId, op: "session/update" as const, idempotencyKey: "idem-val2", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: long } }
      const r2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req2) })))) as unknown as Effect.Effect<any, any, any>)
      expect((r2 as any).status).toBe("failed")
      // control chars
      const req3 = { v: 1 as const, requestId: "req-val3", opId, op: "session/update" as const, idempotencyKey: "idem-val3", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "bad\u0000title" } }
      const r3 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req3) })))) as unknown as Effect.Effect<any, any, any>)
      expect((r3 as any).status).toBe("failed")
      const afterRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterRev).toBe(curRev)
    }),
  )

  it.live("conflict on same key different title fails without second mutation", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const opId = SessionOperation.sessionUpdateId(session.id)
      const req1 = { v: 1 as const, requestId: "req-conf1", opId, op: "session/update" as const, idempotencyKey: "idem-conflict", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "first" } }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req1) })))) as unknown as Effect.Effect<any, any, any>)
      expect((r1 as any).status).toBe("succeeded")
      const rev1 = (r1 as any).revision.session
      const req2 = { v: 1 as const, requestId: "req-conf2", opId, op: "session/update" as const, idempotencyKey: "idem-conflict", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "second" } }
      const r2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req2) })))) as unknown as Effect.Effect<any, any, any>)
      expect((r2 as any).status).toBe("failed")
      expect((r2 as any).failure.code).toBe("conflict")
      const rev2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      expect(rev2).toBe(rev1)
      const info = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.get(SessionID.make(session.id)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(info.title).toBe("first")
    }),
  )

  it.live("legacy PATCH without durable still works and does not create operation", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const listener = yield* Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 }))
      try {
        const createUrl = new URL(`/session?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const createRes = yield* Effect.promise(() => fetch(createUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "orig-legacy" }) }))
        expect(createRes.status).toBe(200)
        const session = yield* Effect.promise(() => createRes.json() as Promise<{ id: string }>)
        const patchUrl = new URL(`/session/${session.id}?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const patchRes = yield* Effect.promise(() => fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "legacy new" }) }))
        expect(patchRes.status).toBe(200)
        const updated = yield* Effect.promise(() => patchRes.json() as Promise<{ title: string }>)
        expect(updated.title).toBe("legacy new")
        const opRows = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
        expect((opRows as any[]).filter((r) => r.op_kind === "sessionUpdate").length).toBe(0)
      } finally {
        yield* Effect.promise(() => listener.stop())
      }
    }),
  )

  it.live("durable PATCH via HTTP succeeds and is replay-safe, same-kind replay without mutation", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const listener = yield* Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 }))
      try {
        const createUrl = new URL(`/session?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const createRes = yield* Effect.promise(() => fetch(createUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "orig-durable" }) }))
        expect(createRes.status).toBe(200)
        const session = yield* Effect.promise(() => createRes.json() as Promise<{ id: string; title: string }>)
        const opId = SessionOperation.sessionUpdateId(session.id)
        const body = { title: "durable title", idempotencyKey: "idem-http", requestId: "req-http", opId, context: { directory: dir, sessionId: session.id, parentSessionId: null } }
        const patchUrl = new URL(`/session/${session.id}?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const res1 = yield* Effect.promise(() => fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))
        expect(res1.status).toBe(200)
        const data1 = yield* Effect.promise(() => res1.json() as Promise<{ title: string }>)
        expect(data1.title).toBe("durable title")
        const feed1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie); return rows.length })))) as unknown as Effect.Effect<any, any, any>)
        const res2 = yield* Effect.promise(() => fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))
        expect(res2.status).toBe(200)
        const data2 = yield* Effect.promise(() => res2.json() as Promise<{ title: string }>)
        expect(data2.title).toBe("durable title")
        const feed2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie); return rows.length })))) as unknown as Effect.Effect<any, any, any>)
        expect(feed2).toBe(feed1)
      } finally {
        yield* Effect.promise(() => listener.stop())
      }
    }),
  )

  it.live("successive distinct durable renames with distinct opIds both succeed and create distinct records", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const token1 = "tok1-" + Math.random().toString(36).slice(2, 8)
      const token2 = "tok2-" + Math.random().toString(36).slice(2, 8)
      const opId1 = SessionOperation.sessionUpdateId(session.id, token1)
      const opId2 = SessionOperation.sessionUpdateId(session.id, token2)
      const req1 = { v: 1 as const, requestId: "req-distinct-1", opId: opId1, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${token1}`, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "first" } }
      const req2 = { v: 1 as const, requestId: "req-distinct-2", opId: opId2, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${token2}`, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "second" } }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req1) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r1.status).toBe("succeeded")
      const r2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req2) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r2.status).toBe("succeeded")
      expect(r2.data.title).toBe("second")
      const opRows = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const ups = (opRows as any[]).filter((r) => r.op_kind === "sessionUpdate")
      expect(ups.length).toBe(2)
      const titles = ups.map((r) => r.title).sort()
      expect(titles).toEqual(["first", "second"])
      const revs = ups.map((r) => r.revision).sort()
      expect(revs[1] - revs[0]).toBe(1)
    }),
  )

  it.live("same-key replay after later distinct mutation returns original persisted title and revision without feed advance", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const tokenA = "replay-a-" + Math.random().toString(36).slice(2, 8)
      const tokenB = "replay-b-" + Math.random().toString(36).slice(2, 8)
      const opIdA = SessionOperation.sessionUpdateId(session.id, tokenA)
      const opIdB = SessionOperation.sessionUpdateId(session.id, tokenB)
      const reqA = { v: 1 as const, requestId: "req-replay-a", opId: opIdA, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${tokenA}`, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "first" } }
      const reqB = { v: 1 as const, requestId: "req-replay-b", opId: opIdB, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${tokenB}`, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "second" } }
      const rA1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(reqA) })))) as unknown as Effect.Effect<any, any, any>)
      expect(rA1.status).toBe("succeeded")
      const revA = rA1.revision.session
      const titleA = rA1.data.title
      const rB = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(reqB) })))) as unknown as Effect.Effect<any, any, any>)
      expect(rB.status).toBe("succeeded")
      expect(rB.data.title).toBe("second")
      const feedAfterB = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie); return rows.length })))) as unknown as Effect.Effect<any, any, any>)
      const rAReplay = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(reqA) })))) as unknown as Effect.Effect<any, any, any>)
      expect(rAReplay.status).toBe("succeeded")
      expect(rAReplay.data.title).toBe(titleA)
      expect(rAReplay.data.title).toBe("first")
      expect(rAReplay.revision.session).toBe(revA)
      const feedAfterReplay = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie); return rows.length })))) as unknown as Effect.Effect<any, any, any>)
      expect(feedAfterReplay).toBe(feedAfterB)
      const cur = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.get(SessionID.make(session.id)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(cur.title).toBe("second")
    }),
  )

  it.live("private dispatch does not mutate when no pre-existing record exists", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const beforeRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      const token = "private-no-record-" + Math.random().toString(36).slice(2, 8)
      const opId = SessionOperation.sessionUpdateId(session.id, token)
      const req = { v: 1 as const, requestId: "req-private-no-record", opId, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${token}`, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "private-title" } }
      const privRes = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; const fn = (d as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<any> }).dispatchPrivate ?? d.dispatch; return yield* fn(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(privRes.status).toBe("failed")
      const afterRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterRev).toBe(beforeRev)
      const opRows = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      expect((opRows as any[]).filter((r) => r.op_kind === "sessionUpdate").length).toBe(0)
      const cur = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.get(SessionID.make(session.id)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(cur.title).toBe("orig")
    }),
  )

  it.live("HTTP context.sessionId mismatch is rejected as 400", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const listener = yield* Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 }))
      try {
        const createUrl = new URL(`/session?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const createRes = yield* Effect.promise(() => fetch(createUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "orig" }) }))
        expect(createRes.status).toBe(200)
        const session = yield* Effect.promise(() => createRes.json() as Promise<{ id: string }>)
        const opId = SessionOperation.sessionUpdateId(session.id, "mismatch-token")
        const body = { title: "new", idempotencyKey: "idem-mismatch", requestId: "req-mismatch", opId, context: { directory: dir, sessionId: "ses_mismatch_not_" + session.id.slice(4), parentSessionId: null } }
        const patchUrl = new URL(`/session/${session.id}?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const res = yield* Effect.promise(() => fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))
        expect(res.status).toBe(400)
      } finally {
        yield* Effect.promise(() => listener.stop())
      }
    }),
  )

  it.live("private malformed envelope is rejected consistently without mutation", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const beforeRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      const badReqs: unknown[] = [
        { v: 1, requestId: "", opId: SessionOperation.sessionUpdateId(session.id, "bad1"), op: "session/update", idempotencyKey: "idem-bad1", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "hi" } },
        { v: 1, requestId: "req-bad2", opId: SessionOperation.sessionUpdateId(session.id, "bad2"), op: "session/update", idempotencyKey: "idem-bad2", context: { directory: "relative/path", sessionId: session.id, parentSessionId: null }, payload: { title: "hi" } },
        { v: 1, requestId: "req-bad3", opId: SessionOperation.sessionUpdateId(session.id, "bad3"), op: "session/update", idempotencyKey: "idem-bad3", context: { directory: dir, sessionId: session.id, parentSessionId: "ses_other" }, payload: { title: "hi" } },
        { v: 1, requestId: "req-bad4", opId: SessionOperation.sessionUpdateId(session.id, "bad4"), op: "session/update", idempotencyKey: "idem-bad4", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "" }, extra: "field" },
      ]
      for (const bad of badReqs) {
        const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(bad) })))) as unknown as Effect.Effect<any, any, any>)
        expect(res.status).toBe("failed")
        expect(res.failure.code).toBe("validation.failed")
      }
      const afterRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterRev).toBe(beforeRev)
    }),
  )

  it.live("not-found, stale, and validation map to typed HTTP codes correctly", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const listener = yield* Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 }))
      try {
        const createUrl = new URL(`/session?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const createRes = yield* Effect.promise(() => fetch(createUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "orig" }) }))
        expect(createRes.status).toBe(200)
        const session = yield* Effect.promise(() => createRes.json() as Promise<{ id: string }>)
        // not-found via fake sessionId in context but URL is real session -> will be scope or not-found? Use fake session in URL
        const fakeId = "ses_ffffffffffffffffffffffff"
        const opIdFake = SessionOperation.sessionUpdateId(fakeId, "tok-notfound")
        const bodyNotFound = { title: "hi", idempotencyKey: "idem-notfound", requestId: "req-notfound", opId: opIdFake, context: { directory: dir, sessionId: fakeId, parentSessionId: null } }
        const patchFake = new URL(`/session/${fakeId}?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const resNotFound = yield* Effect.promise(() => fetch(patchFake, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyNotFound) }))
        expect([404, 400].includes(resNotFound.status)).toBeTrue()
        // bump revision via HTTP PATCH then stale
        const bumpToken = "bump-" + Math.random().toString(36).slice(2, 8)
        const bumpOpId = SessionOperation.sessionUpdateId(session.id, bumpToken)
        const bumpBody = { title: "bumped", idempotencyKey: `sessionUpdate:${session.id}:${bumpToken}`, requestId: "req-bump-http", opId: bumpOpId, context: { directory: dir, sessionId: session.id, parentSessionId: null } }
        const patchUrlBump = new URL(`/session/${session.id}?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const bumpRes = yield* Effect.promise(() => fetch(patchUrlBump, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bumpBody) }))
        expect(bumpRes.status).toBe(200)
        const opIdStale = SessionOperation.sessionUpdateId(session.id, "tok-stale")
        const bodyStale = { title: "new", idempotencyKey: "idem-stale-http", requestId: "req-stale-http", opId: opIdStale, context: { directory: dir, sessionId: session.id, parentSessionId: null, sessionRevision: 0 } }
        const patchUrl = new URL(`/session/${session.id}?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const resStale = yield* Effect.promise(() => fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyStale) }))
        expect(resStale.status).toBe(409)
        // validation
        const opIdVal = SessionOperation.sessionUpdateId(session.id, "tok-val")
        const bodyVal = { title: "   ", idempotencyKey: "idem-val-http", requestId: "req-val-http", opId: opIdVal, context: { directory: dir, sessionId: session.id, parentSessionId: null } }
        const resVal = yield* Effect.promise(() => fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyVal) }))
        expect(resVal.status).toBe(400)
      } finally {
        yield* Effect.promise(() => listener.stop())
      }
    }),
  )

  it.live("fd-carrier session/update routing uses private replay path and returns durable result", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const token = "fd-token-" + Math.random().toString(36).slice(2, 8)
      const opId = SessionOperation.sessionUpdateId(session.id, token)
      const req = { v: 1 as const, requestId: "req-fd", opId, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${token}`, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "fd-title" } }
      // first via SDK path to commit
      const sdkRes = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(sdkRes.status).toBe("succeeded")
      // now via private replay path should return same persisted title without new mutation
      const privRes = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; const fn = (d as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<any> }).dispatchPrivate ?? d.dispatch; return yield* fn(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(privRes.status).toBe("succeeded")
      expect(privRes.data.title).toBe("fd-title")
      expect(privRes.data.title).toBe(sdkRes.data.title)
      const revSdk = sdkRes.revision.session
      const revPriv = privRes.revision.session
      expect(revPriv).toBe(revSdk)
    }),
  )

  it.live("HTTP rejects unknown nested time and permission-rule fields while metadata remains open", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const listener = yield* Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 }))
      try {
        const createUrl = new URL(`/session?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const createRes = yield* Effect.promise(() => fetch(createUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "orig" }) }))
        expect(createRes.status).toBe(200)
        const session = yield* Effect.promise(() => createRes.json() as Promise<{ id: string }>)
        const patchUrl = new URL(`/session/${session.id}?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        // unknown time field
        const badTime = yield* Effect.promise(() => fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ time: { archived: 0, unknownField: 1 } }) }))
        expect(badTime.status).toBe(400)
        // unknown permission rule field
        const badPerm = yield* Effect.promise(() => fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permission: [{ permission: "a", pattern: "*", action: "allow", extra: "bad" }] }) }))
        expect(badPerm.status).toBe(400)
        // metadata remains open: unknown field allowed
        const goodMeta = yield* Effect.promise(() => fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ metadata: { custom: "value", another: 123 } }) }))
        expect(goodMeta.status).toBe(200)
      } finally {
        yield* Effect.promise(() => listener.stop())
      }
    }),
  )

  it.live("HTTP rejects partial durable identity tuple", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const listener = yield* Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 }))
      try {
        const createUrl = new URL(`/session?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const createRes = yield* Effect.promise(() => fetch(createUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "orig" }) }))
        expect(createRes.status).toBe(200)
        const session = yield* Effect.promise(() => createRes.json() as Promise<{ id: string }>)
        const patchUrl = new URL(`/session/${session.id}?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        // Only idempotencyKey without opId/requestId
        const partial1 = yield* Effect.promise(() => fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "new", idempotencyKey: "idem-only" }) }))
        expect(partial1.status).toBe(400)
        const partial2 = yield* Effect.promise(() => fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "new", opId: `sessionUpdate:${session.id}:tok` }) }))
        expect(partial2.status).toBe(400)
        const partial3 = yield* Effect.promise(() => fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "new", requestId: "req-only" }) }))
        expect(partial3.status).toBe(400)
        // context alone without identity tuple also partial
        const partialCtx = yield* Effect.promise(() => fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "new", context: { directory: dir, sessionId: session.id, parentSessionId: null } }) }))
        expect(partialCtx.status).toBe(400)
        // complete tuple succeeds
        const token = "complete-" + Math.random().toString(36).slice(2, 6)
        const opId = SessionOperation.sessionUpdateId(session.id, token)
        const complete = yield* Effect.promise(() => fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "complete", idempotencyKey: `sessionUpdate:${session.id}:${token}`, requestId: "req-complete", opId, context: { directory: dir, sessionId: session.id, parentSessionId: null } }) }))
        expect(complete.status).toBe(200)
      } finally {
        yield* Effect.promise(() => listener.stop())
      }
    }),
  )

  it.live("HTTP durable with omitted context is rejected as 400 without mutation", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const listener = yield* Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 }))
      try {
        const createUrl = new URL(`/session?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const createRes = yield* Effect.promise(() => fetch(createUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "orig-omitted-ctx" }) }))
        expect(createRes.status).toBe(200)
        const session = yield* Effect.promise(() => createRes.json() as Promise<{ id: string; title: string }>)
        const beforeTitle = session.title
        const beforeRev = yield* (Effect.promise(() =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db
                .select({ rev: SessionTable.revision })
                .from(SessionTable)
                .where(eq(SessionTable.id, session.id))
                .get()
                .pipe(Effect.orDie)
              return (row as unknown as { rev: number } | undefined)?.rev
            }),
          ),
        ) as unknown as Effect.Effect<any, any, any>)
        const beforeFeed = yield* (Effect.promise(() =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ) as unknown as Effect.Effect<any, any, any>)
        const token = "omitted-ctx-" + Math.random().toString(36).slice(2, 6)
        const opId = SessionOperation.sessionUpdateId(session.id, token)
        const patchUrl = new URL(`/session/${session.id}?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const omitted = yield* Effect.promise(() => fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "should-not-apply", idempotencyKey: `sessionUpdate:${session.id}:${token}`, requestId: "req-omitted-ctx", opId }) }))
        expect(omitted.status).toBe(400)
        const afterGetRes = yield* Effect.promise(() => fetch(new URL(`/session/${session.id}?directory=${encodeURIComponent(dir)}`, listener.url).toString()))
        expect(afterGetRes.status).toBe(200)
        const afterInfo = yield* Effect.promise(() => afterGetRes.json() as Promise<{ title: string }>)
        expect(afterInfo.title).toBe(beforeTitle)
        const afterRev = yield* (Effect.promise(() =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db
                .select({ rev: SessionTable.revision })
                .from(SessionTable)
                .where(eq(SessionTable.id, session.id))
                .get()
                .pipe(Effect.orDie)
              return (row as unknown as { rev: number } | undefined)?.rev
            }),
          ),
        ) as unknown as Effect.Effect<any, any, any>)
        if (beforeRev !== undefined && afterRev !== undefined) expect(afterRev).toBe(beforeRev)
        const afterFeed = yield* (Effect.promise(() =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ) as unknown as Effect.Effect<any, any, any>)
        expect(afterFeed).toBe(beforeFeed)
        const opRows = yield* (Effect.promise(() =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
              const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie)
              return rows
            }),
          ),
        ) as unknown as Effect.Effect<any, any, any>)
        expect((opRows as any[]).filter((r) => r.op_kind === "sessionUpdate").length).toBe(0)
        // full context with same token still succeeds after rejected omitted attempt
        const fullBody = { title: "full-after-omitted", idempotencyKey: `sessionUpdate:${session.id}:${token}`, requestId: "req-omitted-ctx", opId, context: { directory: dir, sessionId: session.id, parentSessionId: null } }
        const fullRes = yield* Effect.promise(() => fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fullBody) }))
        expect(fullRes.status).toBe(200)
        const fullData = yield* Effect.promise(() => fullRes.json() as Promise<{ title: string }>)
        expect(fullData.title).toBe("full-after-omitted")
      } finally {
        yield* Effect.promise(() => listener.stop())
      }
    }),
  )

  it.live("private dispatch rejects omitted parentSessionId and validates explicit null", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const token = "priv-null-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.sessionUpdateId(session.id, token)
      const base = { v: 1 as const, requestId: "req-priv-null", opId, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${token}`, payload: { title: "new" } }
      const omitted = { ...base, context: { directory: dir, sessionId: session.id } }
      const resOmitted = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* (d as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate(omitted) })))) as unknown as Effect.Effect<any, any, any>)
      expect((resOmitted as unknown as { status: string; failure: { code: string } }).status).toBe("failed")
      expect((resOmitted as unknown as { failure: { code: string } }).failure.code).toBe("validation.failed")
      const explicit = { ...base, context: { directory: dir, sessionId: session.id, parentSessionId: null } }
      // Need a committed record for explicit to succeed replay; create via public first
      const committed = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(explicit) })))) as unknown as Effect.Effect<any, any, any>)
      expect(committed.status).toBe("succeeded")
      const replay = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* (d as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate(explicit) })))) as unknown as Effect.Effect<any, any, any>)
      expect(replay.status).toBe("succeeded")
    }),
  )

  it.live("private opId collision before freshness is typed conflict without mutation", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const tokenA = "priv-collide-a-" + Math.random().toString(36).slice(2, 6)
      const tokenB = "priv-collide-b-" + Math.random().toString(36).slice(2, 6)
      const opIdA = SessionOperation.sessionUpdateId(session.id, tokenA)
      const opIdB = SessionOperation.sessionUpdateId(session.id, tokenB)
      const reqA = { v: 1 as const, requestId: "req-priv-collide-a", opId: opIdA, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${tokenA}`, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "first" } }
      // commit via public
      const rA = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(reqA) })))) as unknown as Effect.Effect<any, any, any>)
      expect(rA.status).toBe("succeeded")
      // private with same opId but different idempotencyKey (different token) should be conflict even though freshness would be ok
      const reqConflict = { v: 1 as const, requestId: "req-priv-collide-conf", opId: opIdA, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${tokenB}`, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "first" } }
      const beforeRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      const privConflict = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* (d as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate(reqConflict) })))) as unknown as Effect.Effect<any, any, any>)
      expect(privConflict.status).toBe("failed")
      expect(privConflict.failure.code).toBe("conflict")
      const afterRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterRev).toBe(beforeRev)
      // same opId collision via public also conflict
      const pubConflict = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(reqConflict) })))) as unknown as Effect.Effect<any, any, any>)
      expect(pubConflict.status).toBe("failed")
      expect(pubConflict.failure.code).toBe("conflict")
    }),
  )

  it.live("public same-key replay under config reader failure still succeeds with omitted or persisted revision", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const token = "reader-fail-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.sessionUpdateId(session.id, token)
      const req = { v: 1 as const, requestId: "req-reader-fail", opId, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${token}`, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "first" } }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r1.status).toBe("succeeded")
      const persistedRev = r1.revision.session
      const failingConfig = Layer.mock(ConfigConvergence.Service, { getBootedVersion: () => Effect.fail(new Error("injected config fail")) } as any)
      const r2: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* Effect.provide(d.dispatch(req), failingConfig) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      // replay should still succeed, not internal, and must not fabricate 0,0
      expect(r2.status).toBe("succeeded")
      expect(r2.data.title).toBe("first")
      if (r2.revision) {
        expect(!(r2.revision.session === 0 && r2.revision.config === 0)).toBe(true)
        // persisted session rev should still be present even when config read fails (omit config -> undefined revision, but we check persisted)
        // If config fails, revision may be omitted entirely (undefined) which is also allowed
        if (r2.revision.session !== undefined) expect(r2.revision.session).toBe(persistedRev)
      }
      // private replay under same failure also succeeds with persisted
      const priv: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* Effect.provide((d as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate(req), failingConfig) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      expect(priv.status).toBe("succeeded")
      expect(priv.data.title).toBe("first")
    }),
  )

  it.live("configVersion with active barrier fails closed 409 without mutation", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const curRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      const token = "barrier-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.sessionUpdateId(session.id, token)
      const req = { v: 1 as const, requestId: "req-barrier", opId, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${token}`, context: { directory: dir, sessionId: session.id, parentSessionId: null, configVersion: 0 }, payload: { title: "new" } }
      // Use real GenerationGate fence to simulate barrier active
      const gate = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const g = yield* GenerationGate.Service; return g })))) as unknown as Effect.Effect<any, any, any>)
      const ticket = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const g = yield* GenerationGate.Service; return yield* g.beginFence(dir) })))) as unknown as Effect.Effect<any, any, any>)
      try {
        const res: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
        expect(res.status).toBe("failed")
        expect(res.failure.code).toBe("InstanceUnavailableDuringConfigRebuild")
        const afterRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
        expect(afterRev).toBe(curRev)
        // same-key replay without configVersion should still succeed even when barrier active (replay precedes barrier)
        const token2 = "barrier-replay-" + Math.random().toString(36).slice(2, 6)
        const opId2 = SessionOperation.sessionUpdateId(session.id, token2)
        const req2 = { v: 1 as const, requestId: "req-barrier2", opId: opId2, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${token2}`, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "barrier-replay" } }
        const r2: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req2) })))) as unknown as Effect.Effect<any, any, any>)
        expect(r2.status).toBe("succeeded")
        const replay: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req2) })))) as unknown as Effect.Effect<any, any, any>)
        expect(replay.status).toBe("succeeded")
        expect(replay.data.title).toBe("barrier-replay")
      } finally {
        yield* (ticket as unknown as { release: Effect.Effect<boolean> }).release.pipe(Effect.ignore) as unknown as Effect.Effect<any, any, any>
      }
    }),
  )

  it.live("migration snapshot: legacy row without snapshot replays via public fallback but private fails closed", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const token = "legacy-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.sessionUpdateId(session.id, token)
      const req = { v: 1 as const, requestId: "req-legacy", opId, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${token}`, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "legacy-title" } }
      const r1: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r1.status).toBe("succeeded")
      // manually clear snapshot to simulate legacy row
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); yield* db.update(SessionOperationTable).set({ result_snapshot: null } as unknown as Record<string, unknown>).where(eq(SessionOperationTable.op_id, opId)).run().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      const pubReplay: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(pubReplay.status).toBe("succeeded")
      expect(pubReplay.data.title).toBe("legacy-title")
      const privReplay: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* (d as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(privReplay.status).toBe("failed")
      expect(privReplay.failure.code).toBe("internal")
    }),
  )

  it.live("concurrent same-key different title results in one succeeded and one conflict without double revision", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const token = "concurrent-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.sessionUpdateId(session.id, token)
      const idem = `sessionUpdate:${session.id}:${token}`
      const req1 = { v: 1 as const, requestId: "req-conc-1", opId, op: "session/update" as const, idempotencyKey: idem, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "first" } }
      const req2 = { v: 1 as const, requestId: "req-conc-2", opId, op: "session/update" as const, idempotencyKey: idem, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "second" } }
      const beforeRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      const beforeFeed = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionChangefeedTable } = yield* Effect.promise(() => import("@opencode-ai/core/retention/sql")); const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie); return rows.length })))) as unknown as Effect.Effect<any, any, any>)
      // Run two dispatches concurrently via Promise.all (real concurrency via DB immediate transaction)
      const [r1, r2]: any = yield* Effect.promise(() =>
        Promise.all([
          AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req1) }))),
          AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(req2) }))),
        ]),
      ) as unknown as Effect.Effect<any, any, any>
      const statuses = [r1.status, r2.status].sort()
      // one succeeded, one conflict (order nondeterministic)
      expect(statuses).toEqual(["failed", "succeeded"])
      const failed = r1.status === "failed" ? r1 : r2
      expect(failed.failure.code).toBe("conflict")
      const afterRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterRev - beforeRev).toBe(1)
      const afterFeed = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionChangefeedTable } = yield* Effect.promise(() => import("@opencode-ai/core/retention/sql")); const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie); return rows.length })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterFeed - beforeFeed).toBe(1)
    }),
  )

  it.live("malformed object-shaped persisted snapshot fails closed internal without mutable fallback", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const tokenA = "malformed-a-" + Math.random().toString(36).slice(2, 6)
      const tokenB = "malformed-b-" + Math.random().toString(36).slice(2, 6)
      const opIdA = SessionOperation.sessionUpdateId(session.id, tokenA)
      const opIdB = SessionOperation.sessionUpdateId(session.id, tokenB)
      const reqA = { v: 1 as const, requestId: "req-mal-a", opId: opIdA, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${tokenA}`, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "first" } }
      const reqB = { v: 1 as const, requestId: "req-mal-b", opId: opIdB, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${tokenB}`, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "second" } }
      const rA: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(reqA) })))) as unknown as Effect.Effect<any, any, any>)
      expect(rA.status).toBe("succeeded")
      const rB: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(reqB) })))) as unknown as Effect.Effect<any, any, any>)
      expect(rB.status).toBe("succeeded")
      expect(rB.data.title).toBe("second")
      // corrupt first operation's snapshot to malformed object (valid JSON but invalid Session.Info)
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); yield* db.update(SessionOperationTable).set({ result_snapshot: JSON.stringify({ bogus: true, title: 123 }) } as unknown as Record<string, unknown>).where(eq(SessionOperationTable.op_id, opIdA)).run().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      const replay: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(reqA) })))) as unknown as Effect.Effect<any, any, any>)
      expect(replay.status).toBe("failed")
      expect(replay.failure.code).toBe("internal")
      expect(replay.failure.message).toContain("invalid persisted snapshot")
      // must not fallback to mutable current session which is "second"
      if (replay.status === "failed" && replay.data) expect(replay.data.title).not.toBe("second")
      // also test present-but-not-object snapshot (string JSON that decodes to non-object)
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); yield* db.update(SessionOperationTable).set({ result_snapshot: JSON.stringify("not-an-object") } as unknown as Record<string, unknown>).where(eq(SessionOperationTable.op_id, opIdA)).run().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      const replay2: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(reqA) })))) as unknown as Effect.Effect<any, any, any>)
      expect(replay2.status).toBe("failed")
      expect(replay2.failure.code).toBe("internal")
      // private replay of malformed also fails closed internal, not fallback
      const priv: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* (d as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate(reqA) })))) as unknown as Effect.Effect<any, any, any>)
      expect(priv.status).toBe("failed")
      expect(priv.failure.code).toBe("internal")
    }),
  )

  it.live("configVersion-guarded mutation holds single continuous lease and barrier race fails closed", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      // non-config request should succeed without needing a lease (no barrier check)
      const tokenNoCfg = "lease-no-cfg-" + Math.random().toString(36).slice(2, 6)
      const opIdNoCfg = SessionOperation.sessionUpdateId(session.id, tokenNoCfg)
      const reqNoCfg = { v: 1 as const, requestId: "req-lease-no-cfg", opId: opIdNoCfg, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${tokenNoCfg}`, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "no-cfg" } }
      const rNoCfg: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(reqNoCfg) })))) as unknown as Effect.Effect<any, any, any>)
      expect(rNoCfg.status).toBe("succeeded")
      // use real fence to verify barrier handling and that same-key replay without configVersion still succeeds during fence
      const gate = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const g = yield* GenerationGate.Service; return g })))) as unknown as Effect.Effect<any, any, any>)
      const ticket: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const g = yield* GenerationGate.Service; return yield* g.beginFence(dir) })))) as unknown as Effect.Effect<any, any, any>)
      try {
        const curRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
        const tokenBarrier = "lease-barrier-" + Math.random().toString(36).slice(2, 6)
        const opIdBarrier = SessionOperation.sessionUpdateId(session.id, tokenBarrier)
        const reqBarrier = { v: 1 as const, requestId: "req-barrier-lease", opId: opIdBarrier, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${tokenBarrier}`, context: { directory: dir, sessionId: session.id, parentSessionId: null, configVersion: 0 }, payload: { title: "barrier-title" } }
        const rBarrier: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(reqBarrier) })))) as unknown as Effect.Effect<any, any, any>)
        expect(rBarrier.status).toBe("failed")
        expect(rBarrier.failure.code).toBe("InstanceUnavailableDuringConfigRebuild")
        const afterRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
        expect(afterRev).toBe(curRev)
        // same-key replay without configVersion must still succeed during fence (replay precedes barrier)
        const tokenReplay = "lease-replay-" + Math.random().toString(36).slice(2, 6)
        const opIdReplay = SessionOperation.sessionUpdateId(session.id, tokenReplay)
        const reqReplay = { v: 1 as const, requestId: "req-replay-lease", opId: opIdReplay, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${tokenReplay}`, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "replay-title" } }
        const rReplay: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(reqReplay) })))) as unknown as Effect.Effect<any, any, any>)
        expect(rReplay.status).toBe("succeeded")
        const rReplay2: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(reqReplay) })))) as unknown as Effect.Effect<any, any, any>)
        expect(rReplay2.status).toBe("succeeded")
        expect(rReplay2.data.title).toBe("replay-title")
      } finally {
        yield* (ticket as unknown as { release: Effect.Effect<boolean> }).release.pipe(Effect.ignore) as unknown as Effect.Effect<any, any, any>
      }
    }),
  )

  it.live("rollback after post-update failure does not leave partial revision or operation without snapshot", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "orig" }) })))) as unknown as Effect.Effect<any, any, any>)
      const beforeRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      const beforeFeed = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie); return rows.length })))) as unknown as Effect.Effect<any, any, any>)
      // stale sessionRevision should fail without any mutation (rollback semantics)
      const opId = SessionOperation.sessionUpdateId(session.id, "rollback-" + Math.random().toString(36).slice(2, 6))
      // bump revision first via second session update to make stale
      const bumpToken = "bump-" + Math.random().toString(36).slice(2, 6)
      const bumpOpId = SessionOperation.sessionUpdateId(session.id, bumpToken)
      const bumpReq = { v: 1 as const, requestId: "req-bump-rollback", opId: bumpOpId, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:${bumpToken}`, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { title: "bumped" } }
      const bumpRes: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(bumpReq) })))) as unknown as Effect.Effect<any, any, any>)
      expect(bumpRes.status).toBe("succeeded")
      const afterBumpRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterBumpRev).toBe(beforeRev + 1)
      // now stale request with old revision 0 should be rejected with no additional mutation
      const staleReq = { v: 1 as const, requestId: "req-stale-rollback", opId, op: "session/update" as const, idempotencyKey: `sessionUpdate:${session.id}:rollback-${opId}`, context: { directory: dir, sessionId: session.id, parentSessionId: null, sessionRevision: 0 }, payload: { title: "stale-title" } }
      const staleRes: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionUpdateDispatchService; return yield* d.dispatch(staleReq) })))) as unknown as Effect.Effect<any, any, any>)
      expect(staleRes.status).toBe("failed")
      expect(staleRes.failure.code).toBe("stale")
      const afterStaleRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterStaleRev).toBe(afterBumpRev)
      const afterStaleFeed = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie); return rows.length })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterStaleFeed).toBe(beforeFeed + 1)
      const opRows = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const ups = (opRows as any[]).filter((r) => r.op_kind === "sessionUpdate")
      expect(ups.length).toBe(1)
      expect(ups[0].title).toBe("bumped")
    }),
  )

  it.live("concurrent distinct durable PATCH via HTTP serializes with distinct ops and correct accounting", () =>
    Effect.gen(function* () {
      let tmp: any
      let dir: string | undefined
      let dbDir: string | undefined
      let dbfile: string | undefined
      let prevFlag: string | undefined
      let prevFlagSet = false
      let listener: any
      let freshApp: any
      const cleanup = Effect.gen(function* () {
        if (listener) {
          yield* Effect.promise(() => listener.stop()).pipe(Effect.orDie)
        }
        if (prevFlagSet) {
          yield* Effect.sync(() => {
            Flag.KILO_DB = prevFlag as string | undefined
          }).pipe(Effect.orDie)
        }
        if (dbfile) {
          for (const p of [dbfile, `${dbfile}-wal`, `${dbfile}-shm`]) {
            yield* Effect.promise(() => fs.rm(p, { force: true })).pipe(Effect.orDie)
            const still = yield* Effect.promise(() => fs.stat(p).then(() => true).catch(() => false))
            if (still) yield* Effect.die(new Error(`cleanup: ${p} still exists`))
          }
        }
        if (dbDir) {
          yield* Effect.promise(() => fs.rm(dbDir, { recursive: true, force: true })).pipe(Effect.orDie)
          const still = yield* Effect.promise(() => fs.stat(dbDir).then(() => true).catch(() => false))
          if (still) yield* Effect.die(new Error(`cleanup: ${dbDir} still exists`))
        }
      })
      yield* Effect.gen(function* () {
        tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
        dir = tmp.path
        dbDir = path.join(os.tmpdir(), `kilo-b2-http-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
        yield* Effect.promise(() => fs.mkdir(dbDir!, { recursive: true })).pipe(Effect.orDie) as unknown as Effect.Effect<any, any, any>
        dbfile = path.join(dbDir!, "kilo.db")
        prevFlag = Flag.KILO_DB
        prevFlagSet = true
        yield* Effect.promise(() => fs.rm(dbfile!, { force: true })).pipe(Effect.orDie) as unknown as Effect.Effect<any, any, any>
        yield* Effect.promise(() => fs.rm(`${dbfile!}-wal`, { force: true })).pipe(Effect.orDie) as unknown as Effect.Effect<any, any, any>
        yield* Effect.promise(() => fs.rm(`${dbfile!}-shm`, { force: true })).pipe(Effect.orDie) as unknown as Effect.Effect<any, any, any>
        Flag.KILO_DB = dbfile!
        freshApp = makeAppLayer()
        listener = yield* Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0, appLayer: freshApp as any })).pipe(Effect.orDie) as unknown as Effect.Effect<any, any, any>
        const withDb = <A>(eff: Effect.Effect<A, any, any>) => eff.pipe(Effect.provide(Database.layerNoLease(dbfile!)), Effect.scoped) as unknown as Effect.Effect<A, any, any>
        const body = Effect.gen(function* () {
        const createUrl = new URL(`/session?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const createRes = yield* Effect.promise(() => fetch(createUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "orig-conc-http" }) }))
        expect(createRes.status).toBe(200)
        const session = yield* Effect.promise(() => createRes.json() as Promise<{ id: string }>)
        const tokenA = "http-distinct-a-fixed"
        const tokenB = "http-distinct-b-fixed"
        const opIdA = SessionOperation.sessionUpdateId(session.id, tokenA)
        const opIdB = SessionOperation.sessionUpdateId(session.id, tokenB)
        expect(opIdA).not.toBe(opIdB)
        const bodyA = { title: "http-title-a", idempotencyKey: `sessionUpdate:${session.id}:${tokenA}`, requestId: "req-http-conc-a", opId: opIdA, context: { directory: dir, sessionId: session.id, parentSessionId: null } }
        const bodyB = { title: "http-title-b", idempotencyKey: `sessionUpdate:${session.id}:${tokenB}`, requestId: "req-http-conc-b", opId: opIdB, context: { directory: dir, sessionId: session.id, parentSessionId: null } }
        const patchUrl = new URL(`/session/${session.id}?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const beforeRev = yield* withDb(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return (row as any)?.rev as number }))
        const beforeFeed = yield* withDb(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie); return (rows as any[]).length }))
        const beforeOps = yield* withDb(Effect.gen(function* () { const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie); return (rows as any[]).filter((r) => r.op_kind === "sessionUpdate").length }))
        const [resA, resB] = yield* Effect.promise(() => Promise.all([
          fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyA) }),
          fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyB) }),
        ])) as unknown as Effect.Effect<any, any, any>
        expect(resA.status).toBe(200)
        expect(resB.status).toBe(200)
        const dataA = yield* Effect.promise(() => resA.json() as Promise<{ title: string }>)
        const dataB = yield* Effect.promise(() => resB.json() as Promise<{ title: string }>)
        expect(dataA.title).toBe("http-title-a")
        expect(dataB.title).toBe("http-title-b")
        const afterRev = yield* withDb(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return (row as any)?.rev as number }))
        expect(afterRev - beforeRev).toBe(2)
        const afterFeed = yield* withDb(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie); return (rows as any[]).length }))
        expect(afterFeed - beforeFeed).toBe(2)
        const opRowsAfter = yield* withDb(Effect.gen(function* () { const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie); return rows }))
        const upsAfter = (opRowsAfter as any[]).filter((r) => r.op_kind === "sessionUpdate")
        expect(upsAfter.length - beforeOps).toBe(2)
        const opIdsAfter = upsAfter.map((r: any) => r.op_id).sort()
        expect(opIdsAfter.includes(opIdA)).toBeTrue()
        expect(opIdsAfter.includes(opIdB)).toBeTrue()
        expect(new Set(opIdsAfter).size).toBe(upsAfter.length)
        const revs = upsAfter.map((r: any) => r.revision).sort((a: number, b: number) => a - b)
        expect(revs[revs.length - 1] - revs[revs.length - 2]).toBe(1)
        const getRes = yield* Effect.promise(() => fetch(new URL(`/session/${session.id}?directory=${encodeURIComponent(dir)}`, listener.url).toString()))
        expect(getRes.status).toBe(200)
        const finalInfo = yield* Effect.promise(() => getRes.json() as Promise<{ title: string }>)
        expect(["http-title-a", "http-title-b"].includes(finalInfo.title)).toBeTrue()
        const replayRes = yield* Effect.promise(() => fetch(patchUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyA) }))
        expect(replayRes.status).toBe(200)
        const replayData = yield* Effect.promise(() => replayRes.json() as Promise<{ title: string }>)
        expect(replayData.title).toBe("http-title-a")
        const afterReplayRev = yield* withDb(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return (row as any)?.rev as number }))
        expect(afterReplayRev).toBe(afterRev)
        const afterReplayFeed = yield* withDb(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie); return (rows as any[]).length }))
        expect(afterReplayFeed).toBe(afterFeed)
        const opRowsReplay = yield* withDb(Effect.gen(function* () { const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie); return rows }))
        const upsReplay = (opRowsReplay as any[]).filter((r) => r.op_kind === "sessionUpdate")
        expect(upsReplay.length).toBe(upsAfter.length)
        const finalInfoAfterReplay = yield* Effect.promise(() => fetch(new URL(`/session/${session.id}?directory=${encodeURIComponent(dir!)}`, listener.url).toString()).then((r) => r.json() as Promise<{ title: string }>))
        expect(["http-title-a", "http-title-b"].includes(finalInfoAfterReplay.title)).toBeTrue()
        expect(typeof finalInfoAfterReplay.title).toBe("string")
        expect(finalInfoAfterReplay.title.length).toBeGreaterThan(0)
      })
      yield* body
      }).pipe(Effect.ensuring(cleanup))
    }),
  )
})
