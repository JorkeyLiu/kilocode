// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { createHash } from "node:crypto"
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
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { SessionTable, SessionOperationTable } from "@opencode-ai/core/session/sql"
import { Service as PrivatePeerService, Unavailable, Conflict } from "../../../src/kilocode/server/private-peer-registry"
import { OBSERVATION_NOTIFICATION } from "../../../src/private-worker/observation"

void Log.init({ print: false })
const it = testEffect(Layer.empty)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
  try { SandboxInheritance._resetForTest() } catch {}
  DispatchAtomicSeam.failCreateInsideTx = false
})

function sha256Hex(s: string): string { return createHash("sha256").update(s).digest("hex") }

function makeMockPeer(captured: unknown[]) {
  return PrivatePeerService.of({
    install: () => Effect.fail(new Conflict()),
    release: () => Effect.void,
    negotiate: () => Effect.void,
    current: Effect.succeed(Option.none()),
    request: () => Effect.fail(new Unavailable()),
    requestWithEvents: () => Effect.fail(new Unavailable()),
    supports: () => Effect.succeed(false),
    notify: (method: string, params?: unknown) => Effect.gen(function* () { captured.push({ method, params }) }),
  } as unknown as any)
}

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
      const independent = sha256Hex(token)
      expect(expectedHash).toBe(independent)
      const opId = SessionOperation.createId("tok-sb-" + Math.random().toString(36).slice(2, 6))
      const req = { v: 1, requestId: "req-sb", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: token } }
      const captured: unknown[] = []
      const res = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any)) })))) as any
      expect(res.status).toBe("succeeded")
      const dbRows = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from((yield* Effect.promise(() => import("@opencode-ai/core/session/sql")) as any).SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as any
      const row = (dbRows as any[]).find((r) => r.op_id === opId)
      expect(row.sandbox_token_hash).toBe(expectedHash)
      expect(row.sandbox_token_hash).toBe(independent)
      expect(row.sandbox_token_hash).not.toContain("si-")
      expect(row.sandbox_source_session_id).toBe(srcRes.data.id)
      // result_snapshot and any persisted JSON/diagnostic must not contain plaintext token
      expect(JSON.stringify(JSON.parse(row.result_snapshot))).not.toContain(token)
      expect(JSON.stringify(row)).not.toContain(token)
      // full durable dump must not contain plaintext
      const allOps = dbRows as any[]
      expect(JSON.stringify(allOps)).not.toContain(token)
      const allSessions = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionTable).all().pipe(Effect.orDie) })))) as any
      expect(JSON.stringify(allSessions)).not.toContain(token)
      const allFeeds = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as any
      expect(JSON.stringify(allFeeds)).not.toContain(token)
      // observable result must not leak plaintext (result itself, diagnostic)
      expect(JSON.stringify(res)).not.toContain(token)
      // observation notification payload-free 5 keys, never token
      expect(captured.length).toBe(1)
      const note = captured[0] as { method: string; params: unknown }
      expect(note.method).toBe(OBSERVATION_NOTIFICATION)
      expect(JSON.stringify(note.params)).not.toContain(token)
      expect(JSON.stringify(note.params)).not.toContain("si-")
      const params = note.params as Record<string, unknown>
      const entries = params.entries as unknown[]
      expect(entries.length).toBe(1)
      const entry = entries[0] as Record<string, unknown>
      expect(Object.keys(entry).sort()).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
      expect(SandboxInheritance._getGrant(token)?.remaining ?? 0).toBe(1)
      expect(SandboxInheritance._getReservation(opId)).toBeUndefined()
      // replay via dispatch and dispatchPrivate must also not leak and must return same hash
      const replay = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(replay.status).toBe("succeeded")
      expect(replay.data.id).toBe(res.data.id)
      expect(JSON.stringify(replay)).not.toContain(token)
      const dbRowsReplay = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from((yield* Effect.promise(() => import("@opencode-ai/core/session/sql")) as any).SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as any
      const rowReplay = (dbRowsReplay as any[]).find((r) => r.op_id === opId)
      expect(rowReplay.sandbox_token_hash).toBe(expectedHash)
      expect(JSON.stringify(rowReplay)).not.toContain(token)
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
      const expectedHash = SandboxInheritance.hashToken(token)
      const opId = SessionOperation.createId("replay-" + Math.random().toString(36).slice(2, 6))
      const req = { v: 1, requestId: "req-r1", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: token } }
      const captured1: unknown[] = []
      const r1 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured1) as unknown as any)) })))) as any
      expect(r1.status).toBe("succeeded")
      expect(JSON.stringify(r1)).not.toContain(token)
      const feedsAfter1 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as any
      const feedCount1 = (feedsAfter1 as any[]).length
      const seq1 = (captured1[0] as { params: { cursor: number } })?.params?.cursor
      expect(captured1.length).toBe(1)
      expect(JSON.stringify(captured1)).not.toContain(token)
      const captured2: unknown[] = []
      const r2 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured2) as unknown as any)) })))) as any
      expect(r2.status).toBe("succeeded")
      expect(r2.data.id).toBe(r1.data.id)
      expect(r2.revision.session).toBe(r1.revision.session)
      expect(JSON.stringify(r2)).not.toContain(token)
      expect(captured2.length).toBe(0)
      const rPriv = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatchPrivate(req) })))) as any
      expect(rPriv.status).toBe("succeeded")
      expect(rPriv.data.session.id).toBe(r1.data.id)
      expect(JSON.stringify(rPriv)).not.toContain(token)
      const dbAfter = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from((yield* Effect.promise(() => import("@opencode-ai/core/session/sql")) as any).SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as any
      expect((dbAfter as any[]).filter((r) => r.op_id === opId).length).toBe(1)
      const row = (dbAfter as any[]).find((r) => r.op_id === opId)
      expect(row.sandbox_token_hash).toBe(expectedHash)
      expect(JSON.stringify(row)).not.toContain(token)
      expect(JSON.stringify(dbAfter)).not.toContain(token)
      expect(SandboxInheritance._getGrant(token).remaining).toBe(4)
      // changefeed seq must not advance on replay (no new observation seq)
      const feedsAfter2 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as any
      expect((feedsAfter2 as any[]).length).toBe(feedCount1)
      const found = (feedsAfter2 as any[]).find((f) => f.session_id === r1.data.id)
      expect(found).toBeDefined()
      expect(found.seq).toBe(seq1)
      expect(JSON.stringify(feedsAfter2)).not.toContain(token)
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
      expect(JSON.stringify(r1)).not.toContain(tok1)
      expect(JSON.stringify(r1)).not.toContain(tok2)
      const feeds1 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as any
      const req2 = { v: 1, requestId: "req-c2", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: tok2 } }
      const r2 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req2) })))) as any
      expect(r2.status).toBe("failed")
      expect((r2 as any).failure.code).toBe("conflict")
      expect(JSON.stringify(r2)).not.toContain(tok1)
      expect(JSON.stringify(r2)).not.toContain(tok2)
      const rPriv = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatchPrivate(req2) })))) as any
      expect(rPriv.status).toBe("failed")
      expect((rPriv as any).failure.code).toBe("conflict")
      expect(JSON.stringify(rPriv)).not.toContain(tok2)
      expect(JSON.stringify(rPriv)).not.toContain(tok1)
      // persisted artifacts must not contain either plaintext token
      const dbRows = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as any
      const row = (dbRows as any[]).find((r) => r.op_id === opId)
      expect(row.sandbox_token_hash).toBe(SandboxInheritance.hashToken(tok1))
      expect(JSON.stringify(row)).not.toContain(tok1)
      expect(JSON.stringify(row)).not.toContain(tok2)
      expect(JSON.stringify(dbRows)).not.toContain(tok1)
      expect(JSON.stringify(dbRows)).not.toContain(tok2)
      const feeds2 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as any
      expect((feeds2 as any[]).length).toBe((feeds1 as any[]).length)
      expect(JSON.stringify(feeds2)).not.toContain(tok1)
      expect(JSON.stringify(feeds2)).not.toContain(tok2)
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
      expect(JSON.stringify(res)).not.toContain(fake)
      const rows = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const r = yield* db.select().from((yield* Effect.promise(() => import("@opencode-ai/core/session/sql")) as any).SessionOperationTable).all().pipe(Effect.orDie); return r })))) as any
      expect((rows as any[]).find((r) => r.op_id === opId)).toBeUndefined()
      expect(JSON.stringify(rows)).not.toContain(fake)
      const feeds = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as any
      expect(JSON.stringify(feeds)).not.toContain(fake)
      // dispatchPrivate for same invalid token also must not leak
      const rPriv = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatchPrivate(req) })))) as any
      expect(rPriv.status).toBe("failed")
      expect(JSON.stringify(rPriv)).not.toContain(fake)
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
      const captured: unknown[] = []
      // attach mock peer to first concurrent via singleflight path; subsequent replays produce no new notifications
      const promises = Array.from({ length: 5 }, () => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any)) }))))
      const results = yield* Effect.promise(() => Promise.all(promises)) as any
      for (const r of results as any[]) {
        expect(r.status).toBe("succeeded")
        expect(JSON.stringify(r)).not.toContain(token)
      }
      expect(new Set((results as any[]).map((r) => r.data.id)).size).toBe(1)
      expect(SandboxInheritance._getGrant(token).remaining).toBe(4)
      expect(JSON.stringify(captured)).not.toContain(token)
      // only one observation notification despite 5 concurrent callers (single commit)
      expect(captured.length).toBe(1)
      const feeds = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as any
      expect(JSON.stringify(feeds)).not.toContain(token)
      const ops = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie) })))) as any
      expect((ops as any[]).filter((r) => r.op_id === opId).length).toBe(1)
      expect(JSON.stringify(ops)).not.toContain(token)
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
      const beforeFeeds = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as any
      DispatchAtomicSeam.failCreateInsideTx = true
      const captured: unknown[] = []
      const r = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any)) })))) as any
      expect(r.status).toBe("failed")
      expect(JSON.stringify(r)).not.toContain(token)
      expect(captured.length).toBe(0)
      expect(SandboxInheritance._getReservation(opId)).toBeUndefined()
      expect(SandboxInheritance._getGrant(token).remaining).toBe(3)
      const afterFeeds = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as any
      expect((afterFeeds as any[]).length).toBe((beforeFeeds as any[]).length)
      expect(JSON.stringify(afterFeeds)).not.toContain(token)
      const rows = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie) })))) as any
      expect((rows as any[]).find((r) => r.op_id === opId)).toBeUndefined()
      expect(JSON.stringify(rows)).not.toContain(token)
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
      expect(JSON.stringify(r1)).not.toContain(token)
      expect(SandboxInheritance._getGrant(token)).toBeUndefined()
      const feeds1 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as any
      const r2 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(r2.status).toBe("succeeded")
      expect(r2.data.id).toBe(r1.data.id)
      expect(JSON.stringify(r2)).not.toContain(token)
      const feeds2 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as any
      expect((feeds2 as any[]).length).toBe((feeds1 as any[]).length)
      expect(JSON.stringify(feeds2)).not.toContain(token)
      const dbRows = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie) })))) as any
      const row = (dbRows as any[]).find((r) => r.op_id === opId)
      expect(row.sandbox_token_hash).toBe(sha256Hex(token))
      expect(JSON.stringify(row)).not.toContain(token)
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
      expect(JSON.stringify(rFail)).not.toContain(token)
      expect(SandboxInheritance._getReservation(opId)).toBeUndefined()
      expect(SandboxInheritance._getGrant(token)?.remaining).toBe(2)
      DispatchAtomicSeam.failCreateInsideTx = false
      const rOk = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(rOk.status).toBe("succeeded")
      expect(JSON.stringify(rOk)).not.toContain(token)
      expect(SandboxInheritance._getGrant(token)?.remaining).toBe(1)
      const rReplay = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(rReplay.data.id).toBe(rOk.data.id)
      expect(JSON.stringify(rReplay)).not.toContain(token)
      expect(SandboxInheritance._getGrant(token)?.remaining).toBe(1)
      const feeds = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as any
      expect(JSON.stringify(feeds)).not.toContain(token)
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
      expect(JSON.stringify(rBad)).not.toContain(bad)
      expect(SandboxInheritance._getReservation(opBad)).toBeUndefined()
      const rowsBad = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie) })))) as any
      expect(JSON.stringify(rowsBad)).not.toContain(bad)
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
      expect(JSON.stringify(r1)).not.toContain(token)
      const op2 = SessionOperation.createId("exp2-" + Math.random().toString(36).slice(2, 6))
      const req2 = { v: 1, requestId: "req-exp2", opId: op2, op: "session/create", idempotencyKey: op2, context: { directory: dir, parentSessionId: null }, payload: { title: "child2", sandboxInheritanceToken: token } }
      const r2 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req2) })))) as any
      expect(r2.status).toBe("failed")
      expect((r2 as any).failure.code).toBe("validation.failed")
      expect(JSON.stringify(r2)).not.toContain(token)
      const rows2 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie) })))) as any
      expect(JSON.stringify(rows2)).not.toContain(token)
      // replay of succeeded first op even though grant now expired should still succeed without reservation
      const rReplay = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req1) })))) as any
      expect(rReplay.status).toBe("succeeded")
      expect(JSON.stringify(rReplay)).not.toContain(token)
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
      expect(JSON.stringify(res)).not.toContain(token)
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
      const rows = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie) })))) as any
      expect(JSON.stringify(rows)).not.toContain(token)
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
        expect(JSON.stringify(res)).not.toContain(token)
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
        const rows = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie) })))) as any
        expect(JSON.stringify(rows)).not.toContain(token)
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
      expect(JSON.stringify(r1)).not.toContain(token1)
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
      expect(JSON.stringify(rPriv)).not.toContain(token1)
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
      expect(JSON.stringify(afterCounts)).not.toContain(token1)
      // 換token仍 conflict
      const req2 = { v: 1, requestId: "req-priv-ex2", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: token2 } }
      const rPriv2: any = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatchPrivate(req2) })))) as any
      expect(rPriv2.status).toBe("failed")
      expect(rPriv2.failure.code).toBe("conflict")
      expect(JSON.stringify(rPriv2)).not.toContain(token2)
      expect(JSON.stringify(rPriv2)).not.toContain(token1)
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
      expect(JSON.stringify(res)).not.toContain(token)
      const childId = res.data.id as string
      const targetSnap = yield* Effect.promise(() => SandboxStore.read(dirB, childId as never).catch(() => undefined)) as unknown as { enabled: boolean; mode: string } | undefined
      expect(targetSnap).toBeDefined()
      expect(targetSnap!.enabled).toBe(snap.enabled)
      expect(targetSnap!.mode).toBe(snap.mode)
      const wrongSnap = yield* Effect.promise(() => SandboxStore.read(dirA, childId as never).catch(() => undefined)) as unknown as unknown
      expect(wrongSnap).toBeUndefined()
      // ensure grant remaining decremented and no plaintext in durable
      expect(SandboxInheritance._getGrant(token)?.remaining).toBe(1)
      const rows = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dirB)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie) })))) as any
      const row = (rows as any[]).find((r) => r.op_id === opId)
      expect(row.sandbox_token_hash).toBe(sha256Hex(token))
      expect(JSON.stringify(row)).not.toContain(token)
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

  it.live("sandbox token durable replay does not re-deduct and keeps hash stable across dispatch+private", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as any
      const dir = tmp.path
      const srcOp = SessionOperation.createId("src-stable-" + Math.random().toString(36).slice(2, 6))
      const srcReq = { v: 1, requestId: "req-src-stable", opId: srcOp, op: "session/create", idempotencyKey: srcOp, context: { directory: dir, parentSessionId: null }, payload: { title: "src" } }
      const srcRes = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(srcReq) })))) as any
      const token = SandboxInheritance.issue({ sessionID: srcRes.data.id, directory: dir, count: 3 })
      const hash = sha256Hex(token)
      const opId = SessionOperation.createId("stable-" + Math.random().toString(36).slice(2, 6))
      const req = { v: 1, requestId: "req-stable", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: token } }
      const r1 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(r1.status).toBe("succeeded")
      expect(SandboxInheritance._getGrant(token)?.remaining).toBe(2)
      const feeds1 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as any
      const ops1 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie) })))) as any
      const row1 = (ops1 as any[]).find((r) => r.op_id === opId)
      expect(row1.sandbox_token_hash).toBe(hash)
      // replay via dispatch: no new deduction, no new feed, same hash
      const r2 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(r2.status).toBe("succeeded")
      expect(r2.data.id).toBe(r1.data.id)
      expect(SandboxInheritance._getGrant(token)?.remaining).toBe(2)
      const feeds2 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as any
      expect((feeds2 as any[]).length).toBe((feeds1 as any[]).length)
      const ops2 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie) })))) as any
      expect((ops2 as any[]).find((r) => r.op_id === opId).sandbox_token_hash).toBe(hash)
      expect(JSON.stringify(ops2)).not.toContain(token)
      // replay via private: still no deduction, no new feed
      const rPriv = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatchPrivate(req) })))) as any
      expect(rPriv.status).toBe("succeeded")
      expect(rPriv.data.session.id).toBe(r1.data.id)
      expect(SandboxInheritance._getGrant(token)?.remaining).toBe(2)
      const feeds3 = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as any
      expect((feeds3 as any[]).length).toBe((feeds1 as any[]).length)
      expect(JSON.stringify(rPriv)).not.toContain(token)
      expect(JSON.stringify(feeds3)).not.toContain(token)
    }),
  )

  it.live("pre-commit reservation same-hash reentry is idempotent via manual reserve before dispatch", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as any
      const dir = tmp.path
      const srcOp = SessionOperation.createId("src-pre-" + Math.random().toString(36).slice(2, 6))
      const srcReq = { v: 1, requestId: "req-src-pre", opId: srcOp, op: "session/create", idempotencyKey: srcOp, context: { directory: dir, parentSessionId: null }, payload: { title: "src" } }
      const srcRes = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(srcReq) })))) as any
      expect(srcRes.status).toBe("succeeded")
      const token = SandboxInheritance.issue({ sessionID: srcRes.data.id, directory: dir, count: 3 })
      const opId = SessionOperation.createId("pre-" + Math.random().toString(36).slice(2, 6))
      // simulate pre-commit window: reserve before dispatch holds reservation
      const pre = SandboxInheritance.reserve(opId, token)!
      expect(pre.hash).toBe(sha256Hex(token))
      expect(SandboxInheritance._getReservation(opId)).toBeDefined()
      expect(SandboxInheritance._getGrant(token)?.remaining).toBe(3)
      const req = { v: 1, requestId: "req-pre", opId, op: "session/create", idempotencyKey: opId, context: { directory: dir, parentSessionId: null }, payload: { title: "child", sandboxInheritanceToken: token } }
      const res = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(res.status).toBe("succeeded")
      expect(JSON.stringify(res)).not.toContain(token)
      // single deduction despite manual reserve + dispatch reserve idempotent
      expect(SandboxInheritance._getGrant(token)?.remaining).toBe(2)
      expect(SandboxInheritance._getReservation(opId)).toBeUndefined()
      const dbRows = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from((yield* Effect.promise(() => import("@opencode-ai/core/session/sql")) as any).SessionOperationTable).all().pipe(Effect.orDie); return rows })))) as any
      const row = (dbRows as any[]).find((r) => r.op_id === opId)
      expect(row.sandbox_token_hash).toBe(sha256Hex(token))
      expect(JSON.stringify(row)).not.toContain(token)
      // replay does not re-deduct
      const replay = yield* Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as any
      expect(replay.status).toBe("succeeded")
      expect(replay.data.id).toBe(res.data.id)
      expect(SandboxInheritance._getGrant(token)?.remaining).toBe(2)
      expect(JSON.stringify(replay)).not.toContain(token)
    }),
  )
})
