// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionCreateDispatchService, layer as DispatchLayer } from "../../../src/kilocode/session/session-create-dispatch"
import { testEffect } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime } from "../../../src/effect/app-runtime"
import * as SandboxInheritance from "../../../src/kilocode/sandbox/inheritance"
import { SandboxStore } from "../../../src/kilocode/sandbox/store"
import * as Log from "@opencode-ai/core/util/log"
import { DispatchAtomicSeam } from "../../../src/kilocode/session/dispatch-atomic-seam"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { ConfigConvergence } from "../../../src/kilocode/server/config-convergence"
import { EventV2 } from "@opencode-ai/core/event"
import { InstanceStore } from "../../../src/project/instance-store"
import { ManagedRuntime } from "effect"

void Log.init({ print: false })
const it = testEffect(Layer.empty)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
  try { SandboxInheritance._resetForTest() } catch {}
  DispatchAtomicSeam.failCreateInsideTx = false
})

describe("sessionCreate sandbox inheritance durable", () => {
  it.live("valid token success persists hash not plaintext", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as any
      const dir = tmp.path
      const srcOp = SessionOperation.createId("src-" + Math.random().toString(36).slice(2, 6))
      const srcReq = { v: 1, requestId: "req-src", opId: srcOp, op: "session/create", idempotencyKey: srcOp, context: { directory: dir, parentSessionId: null }, payload: { title: "src" } }
      const srcRes = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(srcReq) })))) as any
      expect(srcRes.status).toBe("succeeded")
      const token = SandboxInheritance.issue({ sessionID: srcRes.data.id, directory: dir, count: 2 })
      const expectedHash = SandboxInheritance.hashToken(token)
      const opId = SessionOperation.createId("tok-sb-" + Math.random().toString(36).slice(2, 6))
      const req = { v: 1, requestId: "req-sb", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: token } }
      const res = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(res.status).toBe("succeeded")
      const dbRows = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from((yield* Effect.promise(() => import("@opencode-ai/core/session/sql")) as any).SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as any
      const row = (dbRows as any[]).find((r) => r.op_id === opId)
      expect(row.sandbox_token_hash).toBe(expectedHash)
      expect(row.sandbox_token_hash).not.toContain("si-")
      expect(row.sandbox_source_session_id).toBe(srcRes.data.id)
      expect(JSON.stringify(JSON.parse(row.result_snapshot))).not.toContain(token)
      expect(SandboxInheritance._getGrant(token)?.remaining ?? 0).toBe(1)
      expect(SandboxInheritance._getReservation(opId)).toBeUndefined()
    }),
  )

  it.live("replay same op same token same session no new row", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as any
      const dir = tmp.path
      const srcOp = SessionOperation.createId("src-replay-" + Math.random().toString(36).slice(2, 6))
      const srcReq = { v: 1, requestId: "req-src-r", opId: srcOp, op: "session/create", idempotencyKey: srcOp, context: { directory: dir, parentSessionId: null }, payload: { title: "src" } }
      const srcRes = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(srcReq) })))) as any
      const token = SandboxInheritance.issue({ sessionID: srcRes.data.id, directory: dir, count: 5 })
      const opId = SessionOperation.createId("replay-" + Math.random().toString(36).slice(2, 6))
      const req = { v: 1, requestId: "req-r1", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: token } }
      const r1 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(r1.status).toBe("succeeded")
      const r2 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(r2.status).toBe("succeeded")
      expect(r2.data.id).toBe(r1.data.id)
      expect(r2.revision.session).toBe(r1.revision.session)
      const rPriv = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatchPrivate(req) })))) as any
      expect(rPriv.status).toBe("succeeded")
      expect(rPriv.data.session.id).toBe(r1.data.id)
      const dbAfter = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from((yield* Effect.promise(() => import("@opencode-ai/core/session/sql")) as any).SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as any
      expect((dbAfter as any[]).filter((r) => r.op_id === opId).length).toBe(1)
      expect(SandboxInheritance._getGrant(token).remaining).toBe(4)
    }),
  )

  it.live("same op different token conflict", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as any
      const dir = tmp.path
      const mkSrc = (t: string) => Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const op = SessionOperation.createId(t); const req = { v: 1, requestId: t, opId: op, op: "session/create", idempotencyKey: op, context: { directory: dir, parentSessionId: null }, payload: { title: t } }; const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      const s1 = yield* mkSrc("s1-" + Math.random().toString(36).slice(2, 6))
      const s2 = yield* mkSrc("s2-" + Math.random().toString(36).slice(2, 6))
      const tok1 = SandboxInheritance.issue({ sessionID: s1.data.id, directory: dir, count: 1 })
      const tok2 = SandboxInheritance.issue({ sessionID: s2.data.id, directory: dir, count: 1 })
      const opId = SessionOperation.createId("conf-" + Math.random().toString(36).slice(2, 6))
      const req1 = { v: 1, requestId: "req-c1", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: tok1 } }
      const r1 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req1) })))) as any
      expect(r1.status).toBe("succeeded")
      const req2 = { v: 1, requestId: "req-c2", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: tok2 } }
      const r2 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req2) })))) as any
      expect(r2.status).toBe("failed")
      expect((r2 as any).failure.code).toBe("conflict")
      const rPriv = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatchPrivate(req2) })))) as any
      expect(rPriv.status).toBe("failed")
      expect((rPriv as any).failure.code).toBe("conflict")
    }),
  )

  it.live("invalid token zero DB", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as any
      const dir = tmp.path
      const fake = `si-${"0".repeat(8)}-${"0".repeat(4)}-4${"0".repeat(3)}-8${"0".repeat(3)}-${"0".repeat(12)}`
      const opId = SessionOperation.createId("inv-" + Math.random().toString(36).slice(2, 6))
      const req = { v: 1, requestId: "req-inv", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "bad", sandboxInheritanceToken: fake } }
      const res = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(res.status).toBe("failed")
      expect((res as any).failure.code).toBe("validation.failed")
      const rows = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const r = yield* db.select().from((yield* Effect.promise(() => import("@opencode-ai/core/session/sql")) as any).SessionOperationTable).all().pipe(Effect.orDie); return r })))) as any
      expect((rows as any[]).find((r) => r.op_id === opId)).toBeUndefined()
    }),
  )

  it.live("Promise.all same op same token single deduction", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as any
      const dir = tmp.path
      const srcOp = SessionOperation.createId("src-conc-" + Math.random().toString(36).slice(2, 6))
      const srcReq = { v: 1, requestId: "req-src-conc", opId: srcOp, op: "session/create", idempotencyKey: srcOp, context: { directory: dir, parentSessionId: null }, payload: { title: "src" } }
      const srcRes = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(srcReq) })))) as any
      const token = SandboxInheritance.issue({ sessionID: srcRes.data.id, directory: dir, count: 5 })
      const opId = SessionOperation.createId("conc-" + Math.random().toString(36).slice(2, 6))
      const req = { v: 1, requestId: "req-conc", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: token } }
      const promises = Array.from({ length: 5 }, () => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) }))))
      const results = yield* Effect.promise(() => Promise.all(promises)) as any
      for (const r of results as any[]) expect(r.status).toBe("succeeded")
      expect(new Set((results as any[]).map((r) => r.data.id)).size).toBe(1)
      expect(SandboxInheritance._getGrant(token).remaining).toBe(4)
    }),
  )

  it.live("tx defect releases reservation", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as any
      const dir = tmp.path
      const srcOp = SessionOperation.createId("src-def-" + Math.random().toString(36).slice(2, 6))
      const srcReq = { v: 1, requestId: "req-src-def", opId: srcOp, op: "session/create", idempotencyKey: srcOp, context: { directory: dir, parentSessionId: null }, payload: { title: "src" } }
      const srcRes = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(srcReq) })))) as any
      const token = SandboxInheritance.issue({ sessionID: srcRes.data.id, directory: dir, count: 3 })
      const opId = SessionOperation.createId("def-" + Math.random().toString(36).slice(2, 6))
      const req = { v: 1, requestId: "req-def", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: token } }
      DispatchAtomicSeam.failCreateInsideTx = true
      const r = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(r.status).toBe("failed")
      expect(SandboxInheritance._getReservation(opId)).toBeUndefined()
      expect(SandboxInheritance._getGrant(token).remaining).toBe(3)
      DispatchAtomicSeam.failCreateInsideTx = false
    }),
  )

  it.live("replay after grant exhausted still succeeds", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as any
      const dir = tmp.path
      const srcOp = SessionOperation.createId("src-ex-" + Math.random().toString(36).slice(2, 6))
      const srcReq = { v: 1, requestId: "req-src-ex", opId: srcOp, op: "session/create", idempotencyKey: srcOp, context: { directory: dir, parentSessionId: null }, payload: { title: "src" } }
      const srcRes = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(srcReq) })))) as any
      const token = SandboxInheritance.issue({ sessionID: srcRes.data.id, directory: dir, count: 1 })
      const opId = SessionOperation.createId("ex-" + Math.random().toString(36).slice(2, 6))
      const req = { v: 1, requestId: "req-ex", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: token } }
      const r1 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(r1.status).toBe("succeeded")
      expect(SandboxInheritance._getGrant(token)).toBeUndefined()
      const r2 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(r2.status).toBe("succeeded")
      expect(r2.data.id).toBe(r1.data.id)
    }),
  )

  it.live("first defect then second fresh succeeds single deduction", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as any
      const dir = tmp.path
      const srcOp = SessionOperation.createId("src-retry-" + Math.random().toString(36).slice(2, 6))
      const srcReq = { v: 1, requestId: "req-src-retry", opId: srcOp, op: "session/create", idempotencyKey: srcOp, context: { directory: dir, parentSessionId: null }, payload: { title: "src" } }
      const srcRes = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(srcReq) })))) as any
      const token = SandboxInheritance.issue({ sessionID: srcRes.data.id, directory: dir, count: 2 })
      const opId = SessionOperation.createId("retry-" + Math.random().toString(36).slice(2, 6))
      const req = { v: 1, requestId: "req-retry", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: token } }
      DispatchAtomicSeam.failCreateInsideTx = true
      const rFail = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(rFail.status).toBe("failed")
      expect(SandboxInheritance._getReservation(opId)).toBeUndefined()
      expect(SandboxInheritance._getGrant(token)?.remaining).toBe(2)
      DispatchAtomicSeam.failCreateInsideTx = false
      const rOk = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(rOk.status).toBe("succeeded")
      expect(SandboxInheritance._getGrant(token)?.remaining).toBe(1)
      const rReplay = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(rReplay.data.id).toBe(rOk.data.id)
      expect(SandboxInheritance._getGrant(token)?.remaining).toBe(1)
    }),
  )

  it.live("invalid shape and expired grant are validation.failed without reservation", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as any
      const dir = tmp.path
      // invalid shape
      const bad = "si-not-a-uuid"
      const opBad = SessionOperation.createId("badshape-" + Math.random().toString(36).slice(2, 6))
      const reqBad = { v: 1, requestId: "req-bad", opId: opBad, op: "session/create", idempotencyKey: opBad, context: { directory: dir, parentSessionId: null }, payload: { title: "bad", sandboxInheritanceToken: bad } }
      const rBad = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(reqBad) })))) as any
      expect(rBad.status).toBe("failed")
      expect((rBad as any).failure.code).toBe("validation.failed")
      expect(SandboxInheritance._getReservation(opBad)).toBeUndefined()
      // expired grant: issue with count 1, consume it, then try to use same token again fresh op should be invalid (grant gone) but replay still works
      const srcOp = SessionOperation.createId("src-exp2-" + Math.random().toString(36).slice(2, 6))
      const srcReq = { v: 1, requestId: "req-src-exp2", opId: srcOp, op: "session/create", idempotencyKey: srcOp, context: { directory: dir, parentSessionId: null }, payload: { title: "src" } }
      const srcRes = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(srcReq) })))) as any
      const token = SandboxInheritance.issue({ sessionID: srcRes.data.id, directory: dir, count: 1 })
      const op1 = SessionOperation.createId("exp1-" + Math.random().toString(36).slice(2, 6))
      const req1 = { v: 1, requestId: "req-exp1", opId: op1, op: "session/create", idempotencyKey: op1, context: { directory: dir, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: token } }
      const r1 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req1) })))) as any
      expect(r1.status).toBe("succeeded")
      expect(SandboxInheritance._getGrant(token)).toBeUndefined()
      const op2 = SessionOperation.createId("exp2-" + Math.random().toString(36).slice(2, 6))
      const req2 = { v: 1, requestId: "req-exp2", opId: op2, op: "session/create", idempotencyKey: op2, context: { directory: dir, parentSessionId: null }, payload: { title: "child2", sandboxInheritanceToken: token } }
      const r2 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req2) })))) as any
      expect(r2.status).toBe("failed")
      expect((r2 as any).failure.code).toBe("validation.failed")
      // replay of succeeded first op even though grant now expired should still succeed without reservation
      const rReplay = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req1) })))) as any
      expect(rReplay.status).toBe("succeeded")
    }),
  )

  it.live("stale configVersion with valid token fails stale and fully refunds", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as any
      const dir = tmp.path
      const srcOp = SessionOperation.createId("src-stale-" + Math.random().toString(36).slice(2, 6))
      const srcReq = { v: 1, requestId: "req-src-stale", opId: srcOp, op: "session/create", idempotencyKey: srcOp, context: { directory: dir, parentSessionId: null }, payload: { title: "src" } }
      const srcRes = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(srcReq) })))) as any
      expect(srcRes.status).toBe("succeeded")
      const token = SandboxInheritance.issue({ sessionID: srcRes.data.id, directory: dir, count: 2 })
      const beforeCounts = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const { SessionTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
        const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
        const { SessionChangefeedTable } = yield* Effect.promise(() => import("@opencode-ai/core/retention/sql"))
        const sessions = yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
        const ops = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie)
        const feeds = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
        return { sessions: sessions.length, ops: ops.length, feeds: feeds.length }
      })))) as any
      const opId = SessionOperation.createId("stale-" + Math.random().toString(36).slice(2, 6))
      const req = { v: 1, requestId: "req-stale", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null, configVersion: 0 }, payload: { title: "child", sandboxInheritanceToken: token } }
      // mock ConfigConvergence to return booted version 5 => 0 is stale
      const base = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const dbSvc = yield* Database.Service
        const ev = yield* EventV2.Service
        const gate = yield* GenerationGate.Service
        const cfg = yield* ConfigConvergence.Service
        const store = yield* InstanceStore.Service
        return { dbSvc, ev, gate, cfg, store }
      })))) as any
      const mockedCfg = ConfigConvergence.Service.of({
        ...base.cfg,
        getBootedVersion: (_d: string) => Effect.succeed(5),
        begin: base.cfg.begin,
        commit: base.cfg.commit,
        abort: base.cfg.abort,
        shutdown: base.cfg.shutdown,
      } as any)
      const isolated = Layer.mergeAll(
        Layer.succeed(Database.Service, base.dbSvc),
        Layer.succeed(EventV2.Service, base.ev),
        Layer.succeed(GenerationGate.Service, base.gate),
        Layer.succeed(ConfigConvergence.Service, mockedCfg),
        Layer.succeed(InstanceStore.Service, base.store),
      )
      const layer = DispatchLayer.pipe(Layer.provideMerge(isolated))
      const rt = ManagedRuntime.make(layer)
      let res: any
      try {
        const svc = yield* Effect.promise(() => rt.runPromise(Effect.gen(function* () { const s = yield* SessionCreateDispatchService; return s } as any))) as any
        res = yield* Effect.promise(() => rt.runPromise(svc.dispatch(req) as any)) as any
      } finally {
        yield* Effect.promise(() => rt.dispose()) as any
      }
      expect(res.status).toBe("failed")
      expect(res.failure.code).toBe("stale")
      expect(SandboxInheritance._getReservation(opId)).toBeUndefined()
      expect(SandboxInheritance._getGrant(token)?.remaining).toBe(2)
      const afterCounts = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const { SessionTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
        const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
        const { SessionChangefeedTable } = yield* Effect.promise(() => import("@opencode-ai/core/retention/sql"))
        const sessions = yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
        const ops = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie)
        const feeds = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
        return { sessions: sessions.length, ops: ops.length, feeds: feeds.length }
      })))) as any
      expect(afterCounts.sessions).toBe(beforeCounts.sessions)
      expect(afterCounts.ops).toBe(beforeCounts.ops)
      expect(afterCounts.feeds).toBe(beforeCounts.feeds)
    }),
  )

  it.live("fence with valid token fails InstanceUnavailableDuringConfigRebuild and fully refunds", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as any
      const dir = tmp.path
      const srcOp = SessionOperation.createId("src-fence-" + Math.random().toString(36).slice(2, 6))
      const srcReq = { v: 1, requestId: "req-src-fence", opId: srcOp, op: "session/create", idempotencyKey: srcOp, context: { directory: dir, parentSessionId: null }, payload: { title: "src" } }
      const srcRes = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(srcReq) })))) as any
      expect(srcRes.status).toBe("succeeded")
      const token = SandboxInheritance.issue({ sessionID: srcRes.data.id, directory: dir, count: 2 })
      const beforeCounts = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const { SessionTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
        const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
        const { SessionChangefeedTable } = yield* Effect.promise(() => import("@opencode-ai/core/retention/sql"))
        const sessions = yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
        const ops = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie)
        const feeds = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
        return { sessions: sessions.length, ops: ops.length, feeds: feeds.length }
      })))) as any
      const gate = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const g = yield* GenerationGate.Service; return g })))) as any
      const ticket: any = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const g = yield* GenerationGate.Service; return yield* g.beginFence(dir) })))) as any
      try {
        const opId = SessionOperation.createId("fence-" + Math.random().toString(36).slice(2, 6))
        const req = { v: 1, requestId: "req-fence", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null, configVersion: 0 }, payload: { title: "child", sandboxInheritanceToken: token } }
        const res: any = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
        expect(res.status).toBe("failed")
        expect(res.failure.code).toBe("InstanceUnavailableDuringConfigRebuild")
        expect(SandboxInheritance._getReservation(opId)).toBeUndefined()
        expect(SandboxInheritance._getGrant(token)?.remaining).toBe(2)
        const afterCounts = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const { SessionTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
          const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
          const { SessionChangefeedTable } = yield* Effect.promise(() => import("@opencode-ai/core/retention/sql"))
          const sessions = yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
          const ops = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie)
          const feeds = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
          return { sessions: sessions.length, ops: ops.length, feeds: feeds.length }
        })))) as any
        expect(afterCounts.sessions).toBe(beforeCounts.sessions)
        expect(afterCounts.ops).toBe(beforeCounts.ops)
        expect(afterCounts.feeds).toBe(beforeCounts.feeds)
      } finally {
        yield* (ticket.release as any).pipe(Effect.ignore) as any
        // give fence a tick to clear
        yield* Effect.sleep(10) as any
      }
    }),
  )

  it.live("dispatchPrivate replay after grant exhausted succeeds,換token still conflict", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as any
      const dir = tmp.path
      const srcOp = SessionOperation.createId("src-priv-ex-" + Math.random().toString(36).slice(2, 6))
      const srcReq = { v: 1, requestId: "req-src-priv-ex", opId: srcOp, op: "session/create", idempotencyKey: srcOp, context: { directory: dir, parentSessionId: null }, payload: { title: "src" } }
      const srcRes = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(srcReq) })))) as any
      expect(srcRes.status).toBe("succeeded")
      const src2Op = SessionOperation.createId("src-priv-ex2-" + Math.random().toString(36).slice(2, 6))
      const src2Req = { v: 1, requestId: "req-src-priv-ex2", opId: src2Op, op: "session/create", idempotencyKey: src2Op, context: { directory: dir, parentSessionId: null }, payload: { title: "src2" } }
      const src2Res = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(src2Req) })))) as any
      const token1 = SandboxInheritance.issue({ sessionID: srcRes.data.id, directory: dir, count: 1 })
      const token2 = SandboxInheritance.issue({ sessionID: src2Res.data.id, directory: dir, count: 1 })
      const opId = SessionOperation.createId("priv-ex-" + Math.random().toString(36).slice(2, 6))
      const req = { v: 1, requestId: "req-priv-ex", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: token1 } }
      const r1: any = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(r1.status).toBe("succeeded")
      expect(SandboxInheritance._getGrant(token1)).toBeUndefined()
      const beforeCounts = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
        const { SessionChangefeedTable } = yield* Effect.promise(() => import("@opencode-ai/core/retention/sql"))
        const ops = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie)
        const feeds = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
        return { ops: ops.length, feeds: feeds.length }
      })))) as any
      const rPriv: any = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatchPrivate(req) })))) as any
      expect(rPriv.status).toBe("succeeded")
      expect(rPriv.data.session.id).toBe(r1.data.id)
      expect(rPriv.revision).toEqual(r1.revision)
      expect(SandboxInheritance._getReservation(opId)).toBeUndefined()
      const afterCounts = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
        const { SessionChangefeedTable } = yield* Effect.promise(() => import("@opencode-ai/core/retention/sql"))
        const ops = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie)
        const feeds = yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
        return { ops: ops.length, feeds: feeds.length }
      })))) as any
      expect(afterCounts.ops).toBe(beforeCounts.ops)
      expect(afterCounts.feeds).toBe(beforeCounts.feeds)
      // 換token仍 conflict
      const req2 = { v: 1, requestId: "req-priv-ex2", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: token2 } }
      const rPriv2: any = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatchPrivate(req2) })))) as any
      expect(rPriv2.status).toBe("failed")
      expect(rPriv2.failure.code).toBe("conflict")
      expect(SandboxInheritance._getReservation(opId)).toBeUndefined()
    }),
  )

  it.live("cross-directory token only writes to target canonDir", () =>
    Effect.gen(function* () {
      const tmpA = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as any
      const tmpB = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as any
      const dirA = tmpA.path
      const dirB = tmpB.path
      const srcOp = SessionOperation.createId("src-cross-" + Math.random().toString(36).slice(2, 6))
      const srcReq = { v: 1, requestId: "req-src-cross", opId: srcOp, op: "session/create", idempotencyKey: srcOp, context: { directory: dirA, parentSessionId: null }, payload: { title: "src" } }
      const srcRes = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dirA)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(srcReq) })))) as any
      expect(srcRes.status).toBe("succeeded")
      const srcId = srcRes.data.id as string
      const snap = { enabled: true, mode: "deny" as const, allowedHosts: [] as string[], writablePaths: [] as string[], version: 0 }
      yield* Effect.promise(() => SandboxStore.write(dirA, srcId as never, snap))
      const token = SandboxInheritance.issue({ sessionID: srcId as never, directory: dirA, count: 2 })
      const opId = SessionOperation.createId("cross-" + Math.random().toString(36).slice(2, 6))
      const req = { v: 1, requestId: "req-cross", opId, op: "session/create", idempotencyKey: opId, context: { directory: dirB, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: token } }
      const res = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dirB)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(res.status).toBe("succeeded")
      const childId = res.data.id as string
      const targetSnap = yield* Effect.promise(() => SandboxStore.read(dirB, childId as never).catch(() => undefined)) as unknown as { enabled: boolean; mode: string } | undefined
      expect(targetSnap).toBeDefined()
      expect(targetSnap!.enabled).toBe(snap.enabled)
      expect(targetSnap!.mode).toBe(snap.mode)
      const wrongSnap = yield* Effect.promise(() => SandboxStore.read(dirA, childId as never).catch(() => undefined)) as unknown as unknown
      expect(wrongSnap).toBeUndefined()
      // ensure grant remaining decremented
      expect(SandboxInheritance._getGrant(token)?.remaining).toBe(1)
    }),
  )

  it.live("normal parent create retains inheritance regression", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as any
      const dir = tmp.path
      const parentOp = SessionOperation.createId("parent-reg-" + Math.random().toString(36).slice(2, 6))
      const parentReq = { v: 1, requestId: "req-parent-reg", opId: parentOp, op: "session/create", idempotencyKey: parentOp, context: { directory: dir, parentSessionId: null }, payload: { title: "parent" } }
      const parentRes = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(parentReq) })))) as any
      expect(parentRes.status).toBe("succeeded")
      const parentId = parentRes.data.id as string
      const snap = { enabled: true, mode: "deny" as const, allowedHosts: [] as string[], writablePaths: [] as string[], version: 0 }
      yield* Effect.promise(() => SandboxStore.write(dir, parentId as never, snap))
      const childOp = SessionOperation.createId("child-reg-" + Math.random().toString(36).slice(2, 6))
      const childReq = { v: 1, requestId: "req-child-reg", opId: childOp, op: "session/create", idempotencyKey: childOp, context: { directory: dir, parentSessionId: null }, payload: { title: "child", parentID: parentId } }
      const childRes = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(childReq) })))) as any
      expect(childRes.status).toBe("succeeded")
      const childId = childRes.data.id as string
      const childSnap = yield* Effect.promise(() => SandboxStore.read(dir, childId as never).catch(() => undefined)) as unknown as { enabled: boolean } | undefined
      expect(childSnap).toBeDefined()
      expect(childSnap!.enabled).toBe(true)
    }),
  )
})
