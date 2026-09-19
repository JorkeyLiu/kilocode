// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { Session } from "../../../src/session/session"
import { SessionForkDispatchService } from "../../../src/kilocode/session/session-fork-dispatch"
import { ForkSeam } from "../../../src/kilocode/session/fork-seam"
import { SessionChangefeedTable as CF } from "@opencode-ai/core/retention/sql"
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

const it = testEffect(Layer.empty)

afterEach(async () => {
  ForkSeam.nextId = undefined
  ForkSeam.failTxAfterFs = false
  ForkSeam.failFirstDiffWrite = false
  ForkSeam.failSecondDiffWrite = false
  ForkSeam.failSandboxWrite = false
  ForkSeam.failCleanupFs = false
  ForkSeam.failCleanupStorage = false
  ForkSeam.capturedCleanupWarnings.length = 0
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

describe("session/fork observation/changed producer slice", () => {
  it.live("fresh fork emits single five-key v1.0 changed@0 with cursor===seq and source has no new entry", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const source = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "source-fork-notify" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const beforeSrcFeeds = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, source.id)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(beforeSrcFeeds.length).toBe(1)
      expect(beforeSrcFeeds[0].revision).toBe(0)
      expect(beforeSrcFeeds[0].kind).toBe("changed")
      const beforeAll = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      const captured: unknown[] = []
      const token = "fork-obs-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.forkId(source.id, token)
      const req = {
        v: 1 as const,
        requestId: "req-fork-obs-1",
        opId,
        op: "session/fork" as const,
        idempotencyKey: `fork:${source.id}:${token}`,
        context: { directory: dir, sessionId: source.id, parentSessionId: null },
        payload: {},
      }
      const result = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionForkDispatchService
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
      expect(entry.revision).toBe(0)
      expect(entry.session_id).toBe(result.data.id)
      expect(params.cursor).toBe(entry.seq)
      expect((entry as Record<string, unknown>).title).toBeUndefined()
      expect((entry as Record<string, unknown>).directory).toBeUndefined()
      expect((entry as Record<string, unknown>).content).toBeUndefined()
      // persisted changefeed matches notification exactly
      const feeds = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, result.data.id)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(feeds.length).toBe(1)
      const found = feeds[0] as Record<string, unknown>
      expect(found.seq).toBe(entry.seq)
      expect(found.revision).toBe(entry.revision)
      expect(found.kind).toBe(entry.kind)
      expect(found.time).toBe(entry.time)
      expect(found.session_id).toBe(entry.session_id)
      // source has no new entry
      const afterSrcFeeds = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, source.id)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(afterSrcFeeds.length).toBe(1)
      expect(afterSrcFeeds[0].seq).toBe(beforeSrcFeeds[0].seq)
      expect(afterSrcFeeds[0].revision).toBe(0)
      // exactly one new global seq beyond beforeAll
      const afterAll = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(afterAll.length).toBe(beforeAll.length + 1)
    }),
  )

  it.live("transaction failure via ForkSeam emits no notification and leaves no fork/changefeed residual", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const source = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "source-tx-fail-notify" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
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
      const beforeCount = beforeFeeds.length
      const beforeSessions = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      const captured: unknown[] = []
      ForkSeam.failTxAfterFs = true
      const token = "fork-fail-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.forkId(source.id, token)
      const req = {
        v: 1 as const,
        requestId: "req-fork-fail",
        opId,
        op: "session/fork" as const,
        idempotencyKey: `fork:${source.id}:${token}`,
        context: { directory: dir, sessionId: source.id, parentSessionId: null },
        payload: {},
      }
      const result = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionForkDispatchService
              return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(req).pipe(
                Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any),
              )
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(result.status).toBe("failed")
      expect(captured.length).toBe(0)
      ForkSeam.failTxAfterFs = false
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
      expect(afterFeeds.length).toBe(beforeCount)
      const afterSessions = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(afterSessions.length).toBe(beforeSessions.length)
      // no operation for this opId
      const opRow = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* SessionOperation.get(db, opId).pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(opRow).toBeUndefined()
    }),
  )

  it.live("peer unavailable/throwing does not fail fork", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const source = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "source-unavail" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      // case 1: no peer service
      const token1 = "fork-unavail-" + Math.random().toString(36).slice(2, 6)
      const opId1 = SessionOperation.forkId(source.id, token1)
      const req1 = {
        v: 1 as const,
        requestId: "req-fork-unavail-1",
        opId: opId1,
        op: "session/fork" as const,
        idempotencyKey: `fork:${source.id}:${token1}`,
        context: { directory: dir, sessionId: source.id, parentSessionId: null },
        payload: {},
      }
      const r1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionForkDispatchService
              return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(req1)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r1.status).toBe("succeeded")
      // case 2: throwing peer
      const captured: unknown[] = []
      const token2 = "fork-throw-" + Math.random().toString(36).slice(2, 6)
      const opId2 = SessionOperation.forkId(source.id, token2)
      const req2 = {
        v: 1 as const,
        requestId: "req-fork-throw",
        opId: opId2,
        op: "session/fork" as const,
        idempotencyKey: `fork:${source.id}:${token2}`,
        context: { directory: dir, sessionId: source.id, parentSessionId: null },
        payload: {},
      }
      const r2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionForkDispatchService
              return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(req2).pipe(
                Effect.provideService(PrivatePeerService, makeMockPeer(captured, true) as unknown as any),
              )
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r2.status).toBe("succeeded")
      expect(captured.length).toBe(0)
      // both forks actually created distinct children
      expect(r1.data.id).not.toBe(r2.data.id)
      expect(r1.data.id).not.toBe(source.id)
      expect(r2.data.id).not.toBe(source.id)
    }),
  )

  it.live("idempotent replay produces no new seq/duplicate notification and dispatchPrivate remains non-notifying", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const source = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "source-replay-notify" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const captured: unknown[] = []
      const token = "fork-replay-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.forkId(source.id, token)
      const base = {
        v: 1 as const,
        op: "session/fork" as const,
        opId,
        idempotencyKey: `fork:${source.id}:${token}`,
        context: { directory: dir, sessionId: source.id, parentSessionId: null },
        payload: {},
      }
      const req1 = { ...base, requestId: "req-replay-1" }
      const r1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionForkDispatchService
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
      const childId = r1.data.id
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
      // replay with same opId different requestId
      const req2 = { ...base, requestId: "req-replay-2" }
      const r2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionForkDispatchService
              return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(req2).pipe(
                Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any),
              )
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r2.status).toBe("succeeded")
      expect(r2.data.id).toBe(childId)
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
      const seq2 = feeds2.find((f) => f.session_id === childId)?.seq
      expect(seq2).toBe(seq1)
      // dispatchPrivate replay must also not notify
      const priv = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionForkDispatchService
              const fn = (svc as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate
              return yield* fn(req2).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(priv.status).toBe("succeeded")
      expect(captured.length).toBe(1)
      // dispatchPrivate with fresh requestId also not notifying (replay path)
      const priv2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionForkDispatchService
              const fn = (svc as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate
              return yield* fn({ ...base, requestId: "req-replay-private-2" }).pipe(
                Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any),
              )
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(priv2.status).toBe("succeeded")
      expect(captured.length).toBe(1)
    }),
  )
})
