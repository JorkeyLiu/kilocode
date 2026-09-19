// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, SessionOperationTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionCreateDispatchService } from "../../../src/kilocode/session/session-create-dispatch"
import { DispatchAtomicSeam } from "../../../src/kilocode/session/dispatch-atomic-seam"
import {
  Service as PrivatePeerService,
  Unavailable,
  Conflict,
} from "../../../src/kilocode/server/private-peer-registry"
import { OBSERVATION_NOTIFICATION } from "../../../src/private-worker/observation"
import { testEffect } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { eq } from "drizzle-orm"

const it = testEffect(Layer.empty)

afterEach(async () => {
  DispatchAtomicSeam.failCreateInsideTx = false
  await disposeAllInstances()
  await resetDatabase()
})

function makeMockPeer(captured: unknown[], fail?: boolean) {
  return PrivatePeerService.of({
    install: () => Effect.fail(new Conflict()),
    release: () => Effect.void,
    negotiate: () => Effect.void,
    current: Effect.succeed(Option.none()),
    request: () => Effect.fail(new Unavailable()),
    requestWithEvents: () => Effect.fail(new Unavailable()),
    supports: () => Effect.succeed(false),
    notify: (method: string, params?: unknown) =>
      Effect.gen(function* () {
        if (fail) return yield* Effect.fail(new Unavailable())
        captured.push({ method, params })
      }),
  } as unknown as any)
}

describe("session/create observation/changed producer slice", () => {
  it.live("create success notifies after commit with payload-free 5 keys cursor==seq", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const captured: unknown[] = []
      const token = "obs-notify-1"
      const opId = `create:${token}`
      const req = {
        v: 1 as const,
        requestId: "req-obs-1",
        opId,
        op: "session/create" as const,
        idempotencyKey: opId,
        context: { directory: dir, parentSessionId: null },
        payload: { title: "obs-title" },
      }
      const result = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionCreateDispatchService
              return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(req).pipe(
                Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any),
              )
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(result.status).toBe("succeeded")
      expect(captured.length).toBe(1)
      const note = captured[0] as { method: string; params: unknown }
      expect(note.method).toBe(OBSERVATION_NOTIFICATION)
      const params = note.params as Record<string, unknown>
      expect(params.v).toBe("1.0")
      expect(typeof params.cursor).toBe("number")
      expect(Array.isArray(params.entries)).toBeTrue()
      const entries = params.entries as unknown[]
      expect(entries.length).toBe(1)
      const entry = entries[0] as Record<string, unknown>
      // payload-free: exactly five keys
      const keys = Object.keys(entry).sort()
      expect(keys).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
      expect(entry.kind).toBe("changed")
      expect(entry.revision).toBe(0)
      expect(entry.session_id).toBe(result.data.id)
      expect(params.cursor).toBe(entry.seq)
      // ensure no title/content/directory leaked
      expect((entry as Record<string, unknown>).title).toBeUndefined()
      expect((entry as Record<string, unknown>).directory).toBeUndefined()
      expect((entry as Record<string, unknown>).content).toBeUndefined()
      // ensure changefeed entry persisted and cursor matches
      const feeds = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      const found = feeds.find((f) => f.session_id === result.data.id)
      expect(found).toBeDefined()
      expect(found.seq).toBe(entry.seq)
    }),
  )

  it.live("create tx failure does not notify and leaves no DB residual", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const captured: unknown[] = []
      const beforeFeeds = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      DispatchAtomicSeam.failCreateInsideTx = true
      const token = "obs-fail-tx"
      const opId = `create:${token}`
      const req = {
        v: 1 as const,
        requestId: "req-obs-fail",
        opId,
        op: "session/create" as const,
        idempotencyKey: opId,
        context: { directory: dir, parentSessionId: null },
        payload: { title: "fail-title" },
      }
      const result = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionCreateDispatchService
              return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(req).pipe(
                Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any),
              )
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(result.status).toBe("failed")
      expect(captured.length).toBe(0)
      // no DB residual for this dir/op
      const sessions = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.directory, dir))
                .all()
                .pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(sessions.length).toBe(0)
      const ops = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(ops.filter((o) => o.op_id === opId).length).toBe(0)
      const afterFeeds = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(afterFeeds.length).toBe(beforeFeeds.length)
      DispatchAtomicSeam.failCreateInsideTx = false
    }),
  )

  it.live("peer unavailable/notify throw does not affect create success", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const captured: unknown[] = []
      const token = "obs-unavailable"
      const opId = `create:${token}`
      const req = {
        v: 1 as const,
        requestId: "req-obs-unavail",
        opId,
        op: "session/create" as const,
        idempotencyKey: opId,
        context: { directory: dir, parentSessionId: null },
        payload: { title: "unavail-title" },
      }
      // case 1: peer unavailable (no service) -> no captured but success
      const r1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionCreateDispatchService
              // no mock peer provided -> serviceOption None, should still succeed
              return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r1.status).toBe("succeeded")
      // case 2: peer throws -> still success, captured empty
      const token2 = "obs-throw"
      const opId2 = `create:${token2}`
      const req2 = {
        ...req,
        requestId: "req-obs-throw",
        opId: opId2,
        idempotencyKey: opId2,
        payload: { title: "throw-title" },
      }
      const r2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionCreateDispatchService
              return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(req2).pipe(
                Effect.provideService(PrivatePeerService, makeMockPeer(captured, true) as unknown as any),
              )
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r2.status).toBe("succeeded")
      expect(captured.length).toBe(0)
    }),
  )

  it.live("idempotent replay does not produce new changefeed seq nor duplicate notification", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const captured: unknown[] = []
      const token = "obs-replay"
      const opId = `create:${token}`
      const base = {
        v: 1 as const,
        op: "session/create" as const,
        opId,
        idempotencyKey: opId,
        context: { directory: dir, parentSessionId: null },
        payload: { title: "replay-title" },
      }
      const req1 = { ...base, requestId: "req-replay-1" }
      const r1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionCreateDispatchService
              return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(req1).pipe(
                Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any),
              )
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r1.status).toBe("succeeded")
      expect(captured.length).toBe(1)
      const seq1 = (captured[0] as { params: { cursor: number } }).params.cursor
      const feeds1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      const count1 = feeds1.length
      // replay with same opId but different requestId
      const req2 = { ...base, requestId: "req-replay-2" }
      const r2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionCreateDispatchService
              return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(req2).pipe(
                Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any),
              )
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r2.status).toBe("succeeded")
      expect(r2.data.id).toBe(r1.data.id)
      // no new notification
      expect(captured.length).toBe(1)
      // no new changefeed seq
      const feeds2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(feeds2.length).toBe(count1)
      const seq2 = feeds2.find((f) => f.session_id === r1.data.id)?.seq
      expect(seq2).toBe(seq1)
    }),
  )
})
