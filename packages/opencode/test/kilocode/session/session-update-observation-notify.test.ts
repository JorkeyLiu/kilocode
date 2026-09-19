// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, SessionOperationTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { Session } from "../../../src/session/session"
import { SessionUpdateDispatchService } from "../../../src/kilocode/session/session-update-dispatch"
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
  DispatchAtomicSeam.failUpdateInsideTx = false
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

describe("session/update observation/changed producer slice", () => {
  it.live("fresh update emits valid five-key v1.0 notification with cursor===seq and committed revision", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const session = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "orig" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const beforeRev = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
              return row!.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const captured: unknown[] = []
      const token = "obs-update-1"
      const opId = SessionOperation.sessionUpdateId(session.id, token)
      const req = {
        v: 1 as const,
        requestId: "req-obs-update-1",
        opId,
        op: "session/update" as const,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: session.id, parentSessionId: null },
        payload: { title: "new-title" },
      }
      const result = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionUpdateDispatchService
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
      const keys = Object.keys(entry).sort()
      expect(keys).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
      expect(entry.kind).toBe("changed")
      expect(entry.session_id).toBe(session.id)
      expect(params.cursor).toBe(entry.seq)
      expect((entry as Record<string, unknown>).title).toBeUndefined()
      expect((entry as Record<string, unknown>).directory).toBeUndefined()
      expect((entry as Record<string, unknown>).content).toBeUndefined()
      // revision is committed post-update revision (beforeRev + 1)
      expect(entry.revision).toBe(beforeRev + 1)
      expect(result.revision.session).toBe(entry.revision)
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
      const found = feeds.find((f) => f.session_id === session.id && f.revision === entry.revision)
      expect(found).toBeDefined()
      expect(found.seq).toBe(entry.seq)
      expect(found.kind).toBe("changed")
    }),
  )

  it.live("update tx failure does not notify and leaves no committed changefeed/update artifact", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const session = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "orig-tx-fail" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const beforeRev = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
              return row!.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
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
      const beforeOps = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      DispatchAtomicSeam.failUpdateInsideTx = true
      const captured: unknown[] = []
      const token = "obs-update-fail-tx"
      const opId = SessionOperation.sessionUpdateId(session.id, token)
      const req = {
        v: 1 as const,
        requestId: "req-obs-update-fail",
        opId,
        op: "session/update" as const,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: session.id, parentSessionId: null },
        payload: { title: "fail-title" },
      }
      const result = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionUpdateDispatchService
              return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(req).pipe(
                Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any),
              )
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(result.status).toBe("failed")
      expect(captured.length).toBe(0)
      const afterRev = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
              return row!.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(afterRev).toBe(beforeRev)
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
      const afterOps = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      // no new sessionUpdate operation for this opId
      expect(afterOps.filter((o) => o.op_id === opId).length).toBe(0)
      // title unchanged
      const info = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              const sid = yield* Effect.promise(() => import("../../../src/session/schema")).pipe(Effect.map((m: any) => m.SessionID.make(session.id)))
              return yield* svc.get(sid)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(info.title).toBe("orig-tx-fail")
      DispatchAtomicSeam.failUpdateInsideTx = false
    }),
  )

  it.live("peer unavailable/notify throw does not affect update success", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const session = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "orig-unavail" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const captured: unknown[] = []
      const token1 = "obs-update-unavailable"
      const opId1 = SessionOperation.sessionUpdateId(session.id, token1)
      const req1 = {
        v: 1 as const,
        requestId: "req-obs-update-unavail",
        opId: opId1,
        op: "session/update" as const,
        idempotencyKey: opId1,
        context: { directory: dir, sessionId: session.id, parentSessionId: null },
        payload: { title: "unavail-title" },
      }
      const r1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionUpdateDispatchService
              return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(req1)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r1.status).toBe("succeeded")
      const token2 = "obs-update-throw"
      const opId2 = SessionOperation.sessionUpdateId(session.id, token2)
      const req2 = {
        v: 1 as const,
        requestId: "req-obs-update-throw",
        opId: opId2,
        op: "session/update" as const,
        idempotencyKey: opId2,
        context: { directory: dir, sessionId: session.id, parentSessionId: null },
        payload: { title: "throw-title" },
      }
      const r2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionUpdateDispatchService
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
      const session = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "orig-replay" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const captured: unknown[] = []
      const token = "obs-update-replay"
      const opId = SessionOperation.sessionUpdateId(session.id, token)
      const base = {
        v: 1 as const,
        op: "session/update" as const,
        opId,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: session.id, parentSessionId: null },
        payload: { title: "replay-title" },
      }
      const req1 = { ...base, requestId: "req-update-replay-1" }
      const r1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionUpdateDispatchService
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
      const rev1 = r1.revision.session
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
      const req2 = { ...base, requestId: "req-update-replay-2" }
      const r2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionUpdateDispatchService
              return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(req2).pipe(
                Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any),
              )
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r2.status).toBe("succeeded")
      expect(r2.data.title).toBe(r1.data.title)
      expect(r2.revision.session).toBe(rev1)
      expect(captured.length).toBe(1)
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
      const seq2 = feeds2.find((f) => f.session_id === session.id && f.revision === rev1)?.seq
      expect(seq2).toBe(seq1)
      // also verify dispatchPrivate replay does not notify
      const priv = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionUpdateDispatchService
              const fn = (svc as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate
              return yield* fn(req2).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(priv.status).toBe("succeeded")
      expect(captured.length).toBe(1)
    }),
  )
})
