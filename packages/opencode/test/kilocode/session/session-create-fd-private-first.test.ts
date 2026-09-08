// @ts-nocheck
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionCreateDispatchService } from "../../../src/kilocode/session/session-create-dispatch"
import { provideInstance, tmpdir } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, SessionOperationTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { EventTable } from "@opencode-ai/core/event/sql"

const it = testEffect(Layer.empty)

describe("FD session/create now commits via dispatch (authoritative) and idempotent replay does not duplicate", () => {
  it.live("private-first commit creates session atomically and replay returns same session without duplicate", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = (tmp as { path: string }).path
      const token = "tok-fd-first"
      const opId = `create:${token}`
      const req = {
        v: 1 as const,
        requestId: "req-fd-first",
        opId,
        op: "session/create" as const,
        idempotencyKey: opId,
        context: { directory: dir, parentSessionId: null },
        payload: { title: "fd-first", platform: "linux", metadata: { kilocode: { sandbox: { enabled: true } } } },
      }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      const typed1 = r1 as { status: string; data?: { id: string; title: string }; requestId: string; opId: string; idempotencyKey: string; revision?: { session: number } }
      expect(typed1.status).toBe("succeeded")
      expect(typed1.requestId).toBe("req-fd-first")
      expect(typed1.opId).toBe(opId)
      expect(typed1.idempotencyKey).toBe(opId)
      const id1 = typed1.data?.id
      expect(typeof id1).toBe("string")
      expect(typed1.data?.title).toBe("fd-first")
      expect(typed1.revision?.session).toBe(0)
      const sessions = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionTable).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect((sessions as unknown[]).filter((s: unknown) => (s as { directory: string }).directory === dir).length).toBe(1)
      const ops = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect((ops as unknown[]).filter((o: unknown) => (o as { op_id: string }).op_id === opId).length).toBe(1)
      const feeds = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect((feeds as unknown[]).filter((f: unknown) => (f as { session_id: string }).session_id === id1).length).toBe(1)
      const events = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(EventTable).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect((events as unknown[]).length).toBeGreaterThan(0)

      const replayReq = { ...req, requestId: "req-fd-replay" }
      const r2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(replayReq) })))) as unknown as Effect.Effect<any, any, any>)
      const typed2 = r2 as { status: string; data?: { id: string }; revision?: { session: number } }
      expect(typed2.status).toBe("succeeded")
      expect(typed2.data?.id).toBe(id1)
      expect(typed2.revision?.session).toBe(0)
      const sessionsAfter = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionTable).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect((sessionsAfter as unknown[]).filter((s: unknown) => (s as { directory: string }).directory === dir).length).toBe(1)
      const opsAfter = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect((opsAfter as unknown[]).filter((o: unknown) => (o as { op_id: string }).op_id === opId).length).toBe(1)
      const feedsAfter = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect((feedsAfter as unknown[]).filter((f: unknown) => (f as { session_id: string }).session_id === id1).length).toBe(1)

      const fdReq = { ...req, requestId: "req-fd-private" }
      const rFd = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(fdReq) })))) as unknown as Effect.Effect<any, any, any>)
      const typedFd = rFd as { status: string; data?: { id: string } }
      expect(typedFd.status).toBe("succeeded")
      expect(typedFd.data?.id).toBe(id1)
    }))

  it.live("dispatchPrivate replay-only still returns persisted snapshot without new insert", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = (tmp as { path: string }).path
      const token = "tok-replay"
      const opId = `create:${token}`
      const req = {
        v: 1 as const,
        requestId: "req-replay",
        opId,
        op: "session/create" as const,
        idempotencyKey: opId,
        context: { directory: dir, parentSessionId: null },
        payload: { title: "replay" },
      }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      const typed1 = r1 as { status: string; data?: { id: string } }
      expect(typed1.status).toBe("succeeded")
      const rPriv = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatchPrivate({ ...req, requestId: "req-priv-replay" }) })))) as unknown as Effect.Effect<any, any, any>)
      const typedPriv = rPriv as { status: string; data?: { session?: { id: string } }; requestId: string; opId: string }
      expect(typedPriv.status).toBe("succeeded")
      expect(typedPriv.requestId).toBe("req-priv-replay")
      expect(typedPriv.opId).toBe(opId)
      expect(typedPriv.data?.session?.id).toBe(typed1.data?.id)
    }))

  it.live("concurrent same-identity dispatches are idempotent via transaction", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = (tmp as { path: string }).path
      const token = "tok-concurrent"
      const opId = `create:${token}`
      const base = {
        v: 1 as const,
        op: "session/create" as const,
        opId,
        idempotencyKey: opId,
        context: { directory: dir, parentSessionId: null },
        payload: { title: "concurrent" },
      }
      const reqA = { ...base, requestId: "req-con-a" }
      const reqB = { ...base, requestId: "req-con-b" }
      const [rA, rB] = yield* Effect.all(
        [
          Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(reqA) })))) as unknown as Effect.Effect<any, any, any>,
          Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionCreateDispatchService; return yield* d.dispatch(reqB) })))) as unknown as Effect.Effect<any, any, any>,
        ],
        { concurrency: 2 },
      )
      expect((rA as { status: string }).status).toBe("succeeded")
      expect((rB as { status: string }).status).toBe("succeeded")
      expect((rA as { data: { id: string } }).data.id).toBe((rB as { data: { id: string } }).data.id)
      // Same identity plus dispatch transaction (BEGIN IMMEDIATE + hash lookup + idempotency check) guarantees at most one insert; concurrent same-key commits are serialized and second replays persisted row without new insert.
    }))
})
