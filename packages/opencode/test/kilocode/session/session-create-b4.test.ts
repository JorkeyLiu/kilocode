// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { Session } from "../../../src/session/session"
import { SessionID } from "../../../src/session/schema"
import { SessionCreateDispatchService } from "../../../src/kilocode/session/session-create-dispatch"
import { testEffect } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime, makeAppLayer } from "../../../src/effect/app-runtime"
import * as Log from "@opencode-ai/core/util/log"
import { PassThrough } from "node:stream"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { Server } from "../../../src/server/server"
import { createKiloClient } from "@kilocode/sdk/v2/client"

void Log.init({ print: false })

const it = testEffect(Layer.empty)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("sessionCreate B4", () => {
  it.live("success creates session exactly one operation and snapshot", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const opId = SessionOperation.createId("tok1")
      const req = { v: 1 as const, requestId: "req1", opId, op: "session/create" as const, idempotencyKey: "create:tok1", context: { directory: dir, parentSessionId: null }, payload: { title: "hello" } }
      const result = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(result.status).toBe("succeeded")
      expect(result.data.title).toBe("hello")
      expect(result.data.directory).toBe(dir)
      const db2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const creates = (db2 as any[]).filter((r) => r.op_kind === "create" && r.op_id === opId)
      expect(creates.length).toBe(1)
      expect(creates[0].outcome).toBe("succeeded")
    }),
  )

  it.live("same-key replay returns identical persisted result with no duplicate", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const opId = SessionOperation.createId("tok2")
      const req = { v: 1 as const, requestId: "req2", opId, op: "session/create" as const, idempotencyKey: "create:tok2", context: { directory: dir, parentSessionId: null }, payload: { title: "first" } }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r1.status).toBe("succeeded")
      const id1 = r1.data.id
      const rev1 = r1.revision.session
      const r2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r2.status).toBe("succeeded")
      expect(r2.data.id).toBe(id1)
      expect(r2.revision.session).toBe(rev1)
      const db = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const creates = (db as any[]).filter((r) => r.op_kind === "create" && r.op_id === opId)
      expect(creates.length).toBe(1)
      const sessions = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const dirSessions = (sessions as any[]).filter((s) => s.directory === dir)
      expect(dirSessions.length).toBe(1)
    }),
  )

  it.live("opId collision with different idempotencyKey fails validation (canonical identity)", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const opId = SessionOperation.createId("tok3")
      const req1 = { v: 1 as const, requestId: "r1", opId, op: "session/create" as const, idempotencyKey: "create:tok3", context: { directory: dir, parentSessionId: null }, payload: { title: "a" } }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req1) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r1.status).toBe("succeeded")
      const req2 = { v: 1 as const, requestId: "r2", opId, op: "session/create" as const, idempotencyKey: "different-key", context: { directory: dir, parentSessionId: null }, payload: { title: "a" } }
      const r2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req2) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r2.status).toBe("failed")
      expect((r2 as any).failure.code).toBe("validation.failed")
    }),
  )

  it.live("private dispatchPrivate replay-only returns persisted snapshot", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const opId = SessionOperation.createId("tok4")
      const req = { v: 1 as const, requestId: "req4", opId, op: "session/create" as const, idempotencyKey: "create:tok4", context: { directory: dir, parentSessionId: null }, payload: { title: "priv" } }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r1.status).toBe("succeeded")
      const beforeSessions = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionTable).all().pipe(Effect.orDie); return rows.filter((r: { directory: string }) => r.directory === dir) })))) as unknown as Effect.Effect<any, any, any>)
      const beforeOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows.filter((r: { op_kind: string }) => r.op_kind === "create") })))) as unknown as Effect.Effect<any, any, any>)
      const beforeCount = (beforeSessions as unknown[]).length
      const beforeOpCount = (beforeOps as unknown[]).length
      const rPriv = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatchPrivate(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(rPriv.status).toBe("succeeded")
      expect(rPriv.data.session.id).toBe(r1.data.id)
      expect(rPriv.data.session.directory).toBe(r1.data.directory)
      const afterSessions = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionTable).all().pipe(Effect.orDie); return rows.filter((r: { directory: string }) => r.directory === dir) })))) as unknown as Effect.Effect<any, any, any>)
      const afterOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows.filter((r: { op_kind: string }) => r.op_kind === "create") })))) as unknown as Effect.Effect<any, any, any>)
      expect((afterSessions as unknown[]).length).toBe(beforeCount)
      expect((afterOps as unknown[]).length).toBe(beforeOpCount)
      const dupPriv = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatchPrivate(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(dupPriv.status).toBe("succeeded")
      expect(dupPriv.data.session.id).toBe(r1.data.id)
      const afterDupOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows.filter((r: { op_kind: string }) => r.op_kind === "create") })))) as unknown as Effect.Effect<any, any, any>)
      expect((afterDupOps as unknown[]).length).toBe(beforeOpCount)
    }),
  )

  it.live("private without committed record fails internal no committed", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const opId = SessionOperation.createId("tok5")
      const req = { v: 1 as const, requestId: "req5", opId, op: "session/create" as const, idempotencyKey: "create:tok5", context: { directory: dir, parentSessionId: null }, payload: { title: "nocommit" } }
      const beforeSessions = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const beforeOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const rPriv = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatchPrivate(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(rPriv.status).toBe("failed")
      expect((rPriv as any).failure.code).toBe("internal")
      expect((rPriv as any).failure.message).toBe("no committed create record")
      expect((rPriv as any).failure.retryable).toBe(false)
      expect((rPriv as any).accepted).toBe(false)
      expect((rPriv as any).outcome.type).toBe("failed")
      expect((rPriv as any).outcome.failure.code).toBe("internal")
      expect((rPriv as any).outcome.failure.message).toBe("no committed create record")
      expect((rPriv as any).v).toBe(1)
      expect((rPriv as any).requestId).toBe("req5")
      expect((rPriv as any).opId).toBe(opId)
      expect((rPriv as any).op).toBe("session/create")
      expect((rPriv as any).idempotencyKey).toBe("create:tok5")
      expect((rPriv as any).data).toBeUndefined()
      const afterSessions = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const afterOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      expect((afterSessions as unknown[]).length).toBe((beforeSessions as unknown[]).length)
      expect((afterOps as unknown[]).length).toBe((beforeOps as unknown[]).length)
    }),
  )

  it.live("validation fails for bad directory", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const opId = SessionOperation.createId("tok6")
      const req = { v: 1 as const, requestId: "req6", opId, op: "session/create" as const, idempotencyKey: "create:tok6", context: { directory: "relative/path", parentSessionId: null }, payload: { title: "bad" } }
      const r = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r.status).toBe("failed")
      expect((r as any).failure.code).toBe("validation.failed")
    }),
  )

  it.live("fd-carrier session/create is replay-only and positive replay works", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const opId = SessionOperation.createId("tok-fd")
      const req = { v: 1 as const, requestId: "req-fd", opId, op: "session/create" as const, idempotencyKey: "create:tok-fd", context: { directory: dir, parentSessionId: null }, payload: { title: "fd-title" } }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r1.status).toBe("succeeded")
      const extToCarrier = new PassThrough()
      const carrierToExt = new PassThrough()
      const { JsonRpcPeer } = yield* Effect.promise(() => import("../../../src/private-worker/peer")) as unknown as Effect.Effect<any, any, any>
      const carrier = createFdCarrier(extToCarrier as unknown as NodeJS.ReadableStream, carrierToExt as unknown as NodeJS.WritableStream)
      const extPeer = new JsonRpcPeer({ reader: carrierToExt as unknown as NodeJS.ReadableStream, writer: extToCarrier as unknown as NodeJS.WritableStream })
      const initRes = yield* Effect.promise(() => extPeer.request("initialize", { protocol: { name: "kilo-private", major: 1, minor: 0 }, clientInfo: { name: "test", version: "0" }, capabilities: ["session/create"] })) as unknown as Effect.Effect<any, any, any>
      expect((initRes as any).capabilities).toContain("session/create")
      const beforeSessions = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const beforeOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const privRes = yield* Effect.promise(() => extPeer.request("session/create", req)) as unknown as Effect.Effect<any, any, any>
      expect(privRes.status).toBe("succeeded")
      expect((privRes.data as Record<string, unknown>).session).toBeDefined()
      expect(((privRes.data as Record<string, unknown>).session as Record<string, unknown>).id).toBe(r1.data.id)
      const afterReplaySessions = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const afterReplayOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      expect((afterReplaySessions as unknown[]).length).toBe((beforeSessions as unknown[]).length)
      expect((afterReplayOps as unknown[]).length).toBe((beforeOps as unknown[]).length)
      const opId2 = SessionOperation.createId("tok-fd2")
      const req2 = { v: 1 as const, requestId: "req-fd2", opId: opId2, op: "session/create" as const, idempotencyKey: "create:tok-fd2", context: { directory: dir, parentSessionId: null }, payload: { title: "no-commit" } }
      const beforeNoCommitOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const privNo = yield* Effect.promise(() => extPeer.request("session/create", req2).catch((e: unknown) => e)) as unknown as Effect.Effect<any, any, any>
      if (privNo && typeof privNo === "object" && "status" in (privNo as Record<string, unknown>)) {
        expect((privNo as any).status).toBe("failed")
      }
      const afterNoCommitSessions = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const afterNoCommitOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      expect((afterNoCommitSessions as unknown[]).length).toBe((afterReplaySessions as unknown[]).length)
      expect((afterNoCommitOps as unknown[]).length).toBe((beforeNoCommitOps as unknown[]).length)
      extPeer.dispose()
      carrier.dispose()
    }),
  )

  it.live("HTTP durable create via Server.listen returns same session on same idempotencyKey", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const appLayer = makeAppLayer()
      const server = yield* Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1", appLayer } as unknown as never)) as unknown as Effect.Effect<any, any, any>
      try {
        const baseUrl = `http://127.0.0.1:${(server as any).port}`
        const opId = SessionOperation.createId("tok-http")
        const idem = "create:tok-http"
        const body = JSON.stringify({ title: "http-title", opId, idempotencyKey: idem, requestId: "req-http", context: { directory: dir, parentSessionId: null } })
        const res1 = yield* Effect.promise(() => fetch(`${baseUrl}/session`, { method: "POST", headers: { "Content-Type": "application/json", "x-kilo-directory": dir }, body })) as unknown as Effect.Effect<any, any, any>
        expect(res1.status).toBe(200)
        const j1 = yield* Effect.promise(() => res1.json()) as unknown as Effect.Effect<any, any, any>
        const id1 = j1.id
        expect(typeof id1).toBe("string")
        const res2 = yield* Effect.promise(() => fetch(`${baseUrl}/session`, { method: "POST", headers: { "Content-Type": "application/json", "x-kilo-directory": dir }, body })) as unknown as Effect.Effect<any, any, any>
        expect(res2.status).toBe(200)
        const j2 = yield* Effect.promise(() => res2.json()) as unknown as Effect.Effect<any, any, any>
        expect(j2.id).toBe(id1)
        const body2 = JSON.stringify({ title: "different", opId, idempotencyKey: idem, requestId: "req-http", context: { directory: dir, parentSessionId: null } })
        const res3 = yield* Effect.promise(() => fetch(`${baseUrl}/session`, { method: "POST", headers: { "Content-Type": "application/json", "x-kilo-directory": dir }, body: body2 })) as unknown as Effect.Effect<any, any, any>
        expect(res3.status).toBe(409)
      } finally {
        yield* Effect.promise(() => (server as any).stop(true)) as unknown as Effect.Effect<any, any, any>
      }
    }),
  )

  it.live("directory mismatch rejects with 400 and does not create session", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const other = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const otherDir = other.path
      const appLayer = makeAppLayer()
      const server = yield* Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1", appLayer } as unknown as never)) as unknown as Effect.Effect<any, any, any>
      try {
        const baseUrl = `http://127.0.0.1:${(server as any).port}`
        const opId = SessionOperation.createId("tok-mismatch")
        const body = JSON.stringify({ title: "mismatch", opId, idempotencyKey: "create:tok-mismatch", requestId: "req-m", context: { directory: dir, parentSessionId: null } })
        const res = yield* Effect.promise(() => fetch(`${baseUrl}/session`, { method: "POST", headers: { "Content-Type": "application/json", "x-kilo-directory": otherDir }, body })) as unknown as Effect.Effect<any, any, any>
        expect(res.status).toBe(400)
        const count = yield* (Effect.promise(() =>
          AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionTable).all().pipe(Effect.orDie); return rows.filter((r: { directory: string }) => r.directory === dir) }))),
        ) as unknown as Effect.Effect<any, any, any>)
        expect((count as unknown[]).length).toBe(0)
      } finally {
        yield* Effect.promise(() => (server as any).stop(true)) as unknown as Effect.Effect<any, any, any>
      }
    }),
  )

  it.live("parentID conflict: same idempotencyKey different parentID => 409, and private replay with different parentID => conflict", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const appLayer = makeAppLayer()
      const server = yield* Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1", appLayer } as unknown as never)) as unknown as Effect.Effect<any, any, any>
      try {
        const baseUrl = `http://127.0.0.1:${(server as any).port}`
        const uniq = Math.random().toString(36).slice(2, 6)
        const parentOpA = SessionOperation.createId(`parent-${uniq}-a`)
        const parentBodyA = JSON.stringify({ title: "parent", opId: parentOpA, idempotencyKey: `create:parent-${uniq}-a`, requestId: `req-p-${uniq}-a`, context: { directory: dir, parentSessionId: null } })
        const parentResA = yield* Effect.promise(() => fetch(`${baseUrl}/session`, { method: "POST", headers: { "Content-Type": "application/json", "x-kilo-directory": dir }, body: parentBodyA })) as unknown as Effect.Effect<any, any, any>
        const parentJ = yield* Effect.promise(() => (parentResA as Response).json()) as unknown as Effect.Effect<any, any, any>
        const parentId = (parentJ as { id: string }).id
        const parentOpB = SessionOperation.createId(`parent-${uniq}-b`)
        const parentBodyB = JSON.stringify({ title: "parent2", opId: parentOpB, idempotencyKey: `create:parent-${uniq}-b`, requestId: `req-p-${uniq}-b`, context: { directory: dir, parentSessionId: null } })
        const parentResB = yield* Effect.promise(() => fetch(`${baseUrl}/session`, { method: "POST", headers: { "Content-Type": "application/json", "x-kilo-directory": dir }, body: parentBodyB })) as unknown as Effect.Effect<any, any, any>
        const otherParentJ = yield* Effect.promise(() => (parentResB as Response).json()) as unknown as Effect.Effect<any, any, any>
        const otherParentId = (otherParentJ as { id: string }).id
        const opId = SessionOperation.createId(`tok-parent-conflict-${uniq}`)
        const idem = `create:tok-parent-conflict-${uniq}`
        const body1 = JSON.stringify({ title: "child", parentID: parentId, opId, idempotencyKey: idem, requestId: `req1-${uniq}`, context: { directory: dir, parentSessionId: null } })
        const res1 = yield* Effect.promise(() => fetch(`${baseUrl}/session`, { method: "POST", headers: { "Content-Type": "application/json", "x-kilo-directory": dir }, body: body1 })) as unknown as Effect.Effect<any, any, any>
        expect(res1.status).toBe(200)
        const body2 = JSON.stringify({ title: "child", parentID: otherParentId, opId, idempotencyKey: idem, requestId: `req1-${uniq}`, context: { directory: dir, parentSessionId: null } })
        const res2 = yield* Effect.promise(() => fetch(`${baseUrl}/session`, { method: "POST", headers: { "Content-Type": "application/json", "x-kilo-directory": dir }, body: body2 })) as unknown as Effect.Effect<any, any, any>
        expect(res2.status).toBe(409)
      } finally {
        yield* Effect.promise(() => (server as any).stop(true)) as unknown as Effect.Effect<any, any, any>
      }
    }),
  )

  it.live("private parentID conflict via dispatchPrivate replay-only returns conflict", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const uniq = Math.random().toString(36).slice(2, 6)
      // create two parents via dispatch
      const parentOpA = SessionOperation.createId(`parent-priv-${uniq}-a`)
      const parentReqA = { v: 1 as const, requestId: `req-p-priv-${uniq}-a`, opId: parentOpA, op: "session/create" as const, idempotencyKey: `create:parent-priv-${uniq}-a`, context: { directory: dir, parentSessionId: null }, payload: { title: "parentA" } }
      const parentResA = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(parentReqA) })))) as unknown as Effect.Effect<any, any, any>)
      expect(parentResA.status).toBe("succeeded")
      const parentId = (parentResA as any).data.id
      const parentOpB = SessionOperation.createId(`parent-priv-${uniq}-b`)
      const parentReqB = { v: 1 as const, requestId: `req-p-priv-${uniq}-b`, opId: parentOpB, op: "session/create" as const, idempotencyKey: `create:parent-priv-${uniq}-b`, context: { directory: dir, parentSessionId: null }, payload: { title: "parentB" } }
      const parentResB = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(parentReqB) })))) as unknown as Effect.Effect<any, any, any>)
      expect(parentResB.status).toBe("succeeded")
      const otherParentId = (parentResB as any).data.id
      const opId = SessionOperation.createId(`tok-parent-priv-${uniq}`)
      const idem = `create:tok-parent-priv-${uniq}`
      const childReq = { v: 1 as const, requestId: `req-child-${uniq}`, opId, op: "session/create" as const, idempotencyKey: idem, context: { directory: dir, parentSessionId: null }, payload: { title: "child", parentID: parentId } }
      const childRes = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(childReq) })))) as unknown as Effect.Effect<any, any, any>)
      expect(childRes.status).toBe("succeeded")
      const beforeConflictOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      // private replay with different parentID must be conflict
      const privConflictReq = { v: 1 as const, requestId: `req-priv-conflict-${uniq}`, opId, op: "session/create" as const, idempotencyKey: idem, context: { directory: dir, parentSessionId: null }, payload: { title: "child", parentID: otherParentId } }
      const privConflict = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatchPrivate(privConflictReq) })))) as unknown as Effect.Effect<any, any, any>)
      expect(privConflict.status).toBe("failed")
      expect((privConflict as any).failure.code).toBe("conflict")
      expect((privConflict as any).failure.message).toContain("idempotencyKey conflict")
      expect((privConflict as any).accepted).toBe(false)
      expect((privConflict as any).outcome.type).toBe("failed")
      const afterConflictOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      expect((afterConflictOps as unknown[]).length).toBe((beforeConflictOps as unknown[]).length)
      // private replay with identical facts must succeed and return same child id
      const privReplayReq = { v: 1 as const, requestId: `req-priv-replay-${uniq}`, opId, op: "session/create" as const, idempotencyKey: idem, context: { directory: dir, parentSessionId: null }, payload: { title: "child", parentID: parentId } }
      const privReplay = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatchPrivate(privReplayReq) })))) as unknown as Effect.Effect<any, any, any>)
      expect(privReplay.status).toBe("succeeded")
      expect((privReplay as any).data.session.id).toBe(childRes.data.id)
      const afterReplayOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      expect((afterReplayOps as unknown[]).length).toBe((beforeConflictOps as unknown[]).length)
    }),
  )

  it.live("failed transaction does not leave ghost KiloSession or sandbox state", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const opId = SessionOperation.createId("tok-ghost")
      const fakeParent = "ses_ffffffffffffffffffffffff"
      const req = { v: 1 as const, requestId: "req-ghost", opId, op: "session/create" as const, idempotencyKey: "create:tok-ghost", context: { directory: dir, parentSessionId: null }, payload: { title: "ghost", parentID: fakeParent } }
      const result = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(result.status).toBe("failed")
      expect((result as { failure: { code: string } }).failure.code).toBe("validation.failed")
      const rows = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionTable).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      const ghost = (rows as Array<{ id: string }>).find((r) => r.id === fakeParent)
      expect(ghost).toBeUndefined()
      const ghostSessions = (rows as Array<{ title: string }>).filter((r) => r.title === "ghost")
      expect(ghostSessions.length).toBe(0)
    }),
  )

  it.live("durable payload preserves agent/model/metadata/permission/platform via SDK serialization", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const appLayer = makeAppLayer()
      const server = yield* Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1", appLayer } as unknown as never)) as unknown as Effect.Effect<any, any, any>
      try {
        const baseUrl = `http://127.0.0.1:${(server as any).port}`
        const uniq = Math.random().toString(36).slice(2, 6)
        const opId = SessionOperation.createId(`tok-preserve-${uniq}`)
        const idem = `create:tok-preserve-${uniq}`
        const model = { id: "test-model", providerID: "test-provider", variant: "v1" }
        const metadata = { foo: "bar" }
        const permission = [{ permission: "read", pattern: "*", action: "allow" } as unknown]
        const workspaceID = `wrk_${uniq}`
        const body = JSON.stringify({
          title: "preserve",
          agent: "my-agent",
          model,
          metadata,
          permission,
          platform: "linux",
          workspaceID,
          opId,
          idempotencyKey: idem,
          requestId: `req-pres-${uniq}`,
          context: { directory: dir, parentSessionId: null },
        })
        const res = yield* Effect.promise(() => fetch(`${baseUrl}/session`, { method: "POST", headers: { "Content-Type": "application/json", "x-kilo-directory": dir }, body })) as unknown as Effect.Effect<any, any, any>
        expect(res.status).toBe(200)
        const j = yield* Effect.promise(() => res.json()) as unknown as Effect.Effect<any, any, any>
        expect(j.title).toBe("preserve")
        expect(j.agent).toBe("my-agent")
        expect(j.model).toEqual(model)
        expect(j.metadata).toEqual(metadata)
        expect(j.permission).toEqual(permission)
        expect(j.workspaceID).toBe(workspaceID)
        // platform is stored via KiloSession, not Session.Info
        const { KiloSession: KS } = yield* Effect.promise(() => import("../../../src/kilocode/session")) as unknown as Effect.Effect<any, any, any>
        expect(KS.getPlatformOverride(j.id)).toBe("linux")
      } finally {
        yield* Effect.promise(() => (server as any).stop(true)) as unknown as Effect.Effect<any, any, any>
      }
    }),
  )

  it.live("default route mismatch without explicit directory is fail-closed 400", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const appLayer = makeAppLayer()
      const server = yield* Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1", appLayer } as unknown as never)) as unknown as Effect.Effect<any, any, any>
      try {
        const baseUrl = `http://127.0.0.1:${(server as any).port}`
        const opId = SessionOperation.createId("tok-default-mismatch")
        const body = JSON.stringify({ title: "default-mismatch", opId, idempotencyKey: "create:tok-default-mismatch", requestId: "req-default-mismatch", context: { directory: dir, parentSessionId: null } })
        // No x-kilo-directory and no query directory -> effective is cwd (process.cwd()) which differs from tmp dir -> must be 400
        const res = yield* Effect.promise(() => fetch(`${baseUrl}/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body })) as unknown as Effect.Effect<any, any, any>
        expect(res.status).toBe(400)
      } finally {
        yield* Effect.promise(() => (server as any).stop(true)) as unknown as Effect.Effect<any, any, any>
      }
    }),
  )

  it.live("durable create with sandboxInheritanceToken is explicitly rejected 400", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const opId = SessionOperation.createId("tok-token-reject")
      const req = { v: 1 as const, requestId: "req-token", opId, op: "session/create" as const, idempotencyKey: "create:tok-token-reject", context: { directory: dir, parentSessionId: null }, payload: { title: "token", sandboxInheritanceToken: "si-fake-token" } }
      const result = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(result.status).toBe("failed")
      expect((result as any).failure.code).toBe("validation.failed")
      // HTTP also 400
      const appLayer = makeAppLayer()
      const server = yield* Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1", appLayer } as unknown as never)) as unknown as Effect.Effect<any, any, any>
      try {
        const baseUrl = `http://127.0.0.1:${(server as any).port}`
        const body = JSON.stringify({ title: "token-http", opId: SessionOperation.createId("tok-token-http"), idempotencyKey: "create:tok-token-http", requestId: "req-token-http", context: { directory: dir, parentSessionId: null }, sandboxInheritanceToken: "si-fake-http" })
        const res = yield* Effect.promise(() => fetch(`${baseUrl}/session`, { method: "POST", headers: { "Content-Type": "application/json", "x-kilo-directory": dir }, body })) as unknown as Effect.Effect<any, any, any>
        expect(res.status).toBe(400)
      } finally {
        yield* Effect.promise(() => (server as any).stop(true)) as unknown as Effect.Effect<any, any, any>
      }
    }),
  )

  it.live("replay snapshot consistency: SDK and private replay return identical session id/directory/revision", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const opId = SessionOperation.createId("tok-snap-consistency")
      const req = { v: 1 as const, requestId: "req-snap", opId, op: "session/create" as const, idempotencyKey: "create:tok-snap-consistency", context: { directory: dir, parentSessionId: null }, payload: { title: "snap" } }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r1.status).toBe("succeeded")
      const beforeSessions = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const beforeOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const priv = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatchPrivate(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(priv.status).toBe("succeeded")
      expect(priv.data.session.id).toBe(r1.data.id)
      expect(priv.data.session.directory).toBe(r1.data.directory)
      const afterPrivSessions = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const afterPrivOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      expect((afterPrivSessions as unknown[]).length).toBe((beforeSessions as unknown[]).length)
      expect((afterPrivOps as unknown[]).length).toBe((beforeOps as unknown[]).length)
      // private via fd-carrier also consistent and does not mutate
      const extToCarrier = new PassThrough()
      const carrierToExt = new PassThrough()
      const { JsonRpcPeer } = yield* Effect.promise(() => import("../../../src/private-worker/peer")) as unknown as Effect.Effect<any, any, any>
      const carrier = createFdCarrier(extToCarrier as unknown as NodeJS.ReadableStream, carrierToExt as unknown as NodeJS.WritableStream)
      const extPeer = new JsonRpcPeer({ reader: carrierToExt as unknown as NodeJS.ReadableStream, writer: extToCarrier as unknown as NodeJS.WritableStream })
      yield* Effect.promise(() => extPeer.request("initialize", { protocol: { name: "kilo-private", major: 1, minor: 0 }, clientInfo: { name: "test", version: "0" }, capabilities: ["session/create"] })) as unknown as Effect.Effect<any, any, any>
      const privCarrier = yield* Effect.promise(() => extPeer.request("session/create", req)) as unknown as Effect.Effect<any, any, any>
      expect(privCarrier.status).toBe("succeeded")
      expect(((privCarrier.data as Record<string, unknown>).session as Record<string, unknown>).id).toBe(r1.data.id)
      const afterCarrierSessions = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const afterCarrierOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      expect((afterCarrierSessions as unknown[]).length).toBe((beforeSessions as unknown[]).length)
      expect((afterCarrierOps as unknown[]).length).toBe((beforeOps as unknown[]).length)
      // revision bounded: both have revision from same operation
      expect(r1.revision?.session).toBe(priv.revision?.session)
      extPeer.dispose()
      carrier.dispose()
    }),
  )

  it.live("create rejects mismatched idempotencyKey and colon in token", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const opId = SessionOperation.createId("tok-ok")
      // mismatched idempotencyKey
      const reqMismatch = { v: 1 as const, requestId: "req-m", opId, op: "session/create" as const, idempotencyKey: "create:different", context: { directory: dir, parentSessionId: null }, payload: { title: "m" } }
      const rMismatch = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(reqMismatch) })))) as unknown as Effect.Effect<any, any, any>)
      expect(rMismatch.status).toBe("failed")
      expect((rMismatch as any).failure.code).toBe("validation.failed")
      // colon in token via idempotencyKey
      const opIdColon = "create:bad:token"
      const reqColon = { v: 1 as const, requestId: "req-c", opId: opIdColon, op: "session/create" as const, idempotencyKey: opIdColon, context: { directory: dir, parentSessionId: null }, payload: { title: "m" } }
      const rColon = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(reqColon) })))) as unknown as Effect.Effect<any, any, any>)
      expect(rColon.status).toBe("failed")
      expect((rColon as any).failure.code).toBe("validation.failed")
      // private mismatch also
      const rPrivMismatch = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatchPrivate(reqMismatch) })))) as unknown as Effect.Effect<any, any, any>)
      expect(rPrivMismatch.status).toBe("failed")
      expect((rPrivMismatch as any).failure.code).toBe("validation.failed")
      // HTTP mismatch via Server.listen
      const appLayer = makeAppLayer()
      const server = yield* Effect.promise(() => Server.listen({ port: 0, hostname: "127.0.0.1", appLayer } as unknown as never)) as unknown as Effect.Effect<any, any, any>
      try {
        const baseUrl = `http://127.0.0.1:${(server as any).port}`
        const body = JSON.stringify({ title: "m", opId, idempotencyKey: "create:different", requestId: "req-http-m", context: { directory: dir, parentSessionId: null } })
        const res = yield* Effect.promise(() => fetch(`${baseUrl}/session`, { method: "POST", headers: { "Content-Type": "application/json", "x-kilo-directory": dir }, body })) as unknown as Effect.Effect<any, any, any>
        expect(res.status).toBe(400)
      } finally {
        yield* Effect.promise(() => (server as any).stop(true)) as unknown as Effect.Effect<any, any, any>
      }
    }),
  )
})
