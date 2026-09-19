// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, SessionDeleteTombstoneTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { Session } from "../../../src/session/session"
import { SessionDeleteDispatchService } from "../../../src/kilocode/session/session-delete-dispatch"
import { DispatchAtomicSeam } from "../../../src/kilocode/session/dispatch-atomic-seam"
import { Service as PrivatePeerService, Unavailable, Conflict } from "../../../src/kilocode/server/private-peer-registry"
import { OBSERVATION_NOTIFICATION } from "../../../src/private-worker/observation"
import { testEffect } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { eq } from "drizzle-orm"

const it = testEffect(Layer.empty)

afterEach(async () => {
  DispatchAtomicSeam.failDeleteBeforeTx = false
  DispatchAtomicSeam.failDeleteInsideTx = false
  if ((globalThis as any).__dispatchAtomicSeam) (globalThis as any).__dispatchAtomicSeam.failDeleteInsideTx = false
  if ((globalThis as any).__kiloLastDeleteEntries) delete (globalThis as any).__kiloLastDeleteEntries
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

describe("session/delete observation/changed producer slice", () => {
  it.live("family delete valid multi-entry notification with strict payload keys ascending seq cursor==last kind deleted revisions matching persisted", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      // create root
      const root = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "root" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      // create child via parentID
      const child = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ parentID: root.id, title: "child" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const grand = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ parentID: child.id, title: "grand" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      // capture revisions before delete
      const revsBefore = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db.select({ id: SessionTable.id, rev: SessionTable.revision }).from(SessionTable).all().pipe(Effect.orDie)
              const map = new Map(rows.map((r) => [r.id, r.rev]))
              return map
            }),
          ),
        ),
      ) as unknown as Effect.Effect<Map<string, number>>
      const captured: unknown[] = []
      const token = "obs-delete-family"
      const opId = SessionOperation.deleteId(root.id, token)
      const req = {
        v: 1 as const,
        requestId: "req-obs-delete-family",
        opId,
        op: "session/delete" as const,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: root.id, parentSessionId: null },
        payload: {},
      }
      const result = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionDeleteDispatchService
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
      const entries = params.entries as Record<string, unknown>[]
      expect(entries.length).toBe(3)
      // ascending seq strictly
      for (let i = 1; i < entries.length; i++) expect(entries[i].seq).toBeGreaterThan(entries[i - 1].seq as number)
      expect(params.cursor).toBe(entries[entries.length - 1].seq)
      // each entry exactly 5 keys payload-free
      for (const e of entries) {
        const keys = Object.keys(e).sort()
        expect(keys).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
        expect(e.kind).toBe("deleted")
        expect(typeof e.seq).toBe("number")
        expect(typeof e.session_id).toBe("string")
        expect(typeof e.revision).toBe("number")
        expect(typeof e.time).toBe("number")
        expect((e as Record<string, unknown>).title).toBeUndefined()
        expect((e as Record<string, unknown>).directory).toBeUndefined()
        expect((e as Record<string, unknown>).content).toBeUndefined()
        // revision matches revBefore +1
        const beforeRev = revsBefore.get(e.session_id as string)
        expect(beforeRev).toBeDefined()
        expect(e.revision).toBe((beforeRev as number) + 1)
      }
      // ids cover whole family
      const ids = entries.map((e) => e.session_id).sort()
      expect(ids).toEqual([root.id, child.id, grand.id].sort())
      // persisted changefeed rows match notification entries exactly (seq, revision, kind, time)
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
      for (const e of entries) {
        const found = feeds.find((f) => f.session_id === e.session_id && f.revision === e.revision && f.kind === e.kind)
        expect(found).toBeDefined()
        expect(found.seq).toBe(e.seq)
        expect(found.time).toBe(e.time)
      }
      // sessions removed
      const remaining = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(remaining.find((r) => r.id === root.id)).toBeUndefined()
      expect(remaining.find((r) => r.id === child.id)).toBeUndefined()
      expect(remaining.find((r) => r.id === grand.id)).toBeUndefined()
    }),
  )

  it.live("inside-transaction failure emits no notification and leaves no delete/changefeed/tombstone residual", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const root = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "root-fail" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const child = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ parentID: root.id, title: "child-fail" })
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
      const beforeCount = beforeFeeds.filter((f) => [root.id, child.id].includes(f.session_id)).length
      const captured: unknown[] = []
      DispatchAtomicSeam.failDeleteInsideTx = true
      ;(globalThis as any).__dispatchAtomicSeam = DispatchAtomicSeam
      const token = "obs-delete-fail-inside"
      const opId = SessionOperation.deleteId(root.id, token)
      const req = {
        v: 1 as const,
        requestId: "req-obs-delete-fail-inside",
        opId,
        op: "session/delete" as const,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: root.id, parentSessionId: null },
        payload: {},
      }
      const result = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionDeleteDispatchService
              return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(req).pipe(
                Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any),
              )
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(result.status).toBe("failed")
      expect(captured.length).toBe(0)
      DispatchAtomicSeam.failDeleteInsideTx = false
      ;(globalThis as any).__dispatchAtomicSeam.failDeleteInsideTx = false
      // no tombstone
      const tombs = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionDeleteTombstoneTable).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(tombs.filter((t) => t.session_id === root.id && t.op_id === opId).length).toBe(0)
      // sessions still present
      const rows = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(rows.find((r) => r.id === root.id)).toBeDefined()
      expect(rows.find((r) => r.id === child.id)).toBeDefined()
      // no new changefeed deleted rows for this family
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
      const afterCount = afterFeeds.filter((f) => [root.id, child.id].includes(f.session_id) && f.kind === "deleted").length
      expect(afterCount).toBe(0)
      // also ensure no new changefeed at all for those ids beyond before
      const afterFamilyFeeds = afterFeeds.filter((f) => [root.id, child.id].includes(f.session_id)).length
      const beforeFamilyFeeds = beforeFeeds.filter((f) => [root.id, child.id].includes(f.session_id)).length
      expect(afterFamilyFeeds).toBe(beforeFamilyFeeds)
    }),
  )

  it.live("unavailable/throwing peer does not fail delete", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const root = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "root-unavail" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      // case 1: no peer service
      const opId1 = SessionOperation.deleteId(root.id, "unavail-1")
      const req1 = {
        v: 1 as const,
        requestId: "req-unavail-1",
        opId: opId1,
        op: "session/delete" as const,
        idempotencyKey: opId1,
        context: { directory: dir, sessionId: root.id, parentSessionId: null },
        payload: {},
      }
      const r1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionDeleteDispatchService
              return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(req1)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r1.status).toBe("succeeded")
      // need new root for second case because first deleted family
      const root2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "root-throw" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const captured: unknown[] = []
      const opId2 = SessionOperation.deleteId(root2.id, "throw-1")
      const req2 = {
        v: 1 as const,
        requestId: "req-throw-1",
        opId: opId2,
        op: "session/delete" as const,
        idempotencyKey: opId2,
        context: { directory: dir, sessionId: root2.id, parentSessionId: null },
        payload: {},
      }
      const r2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionDeleteDispatchService
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

  it.live("idempotent replay emits no new seq or duplicate notification, and dispatchPrivate replay remains non-notifying", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const root = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "root-replay" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const child = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ parentID: root.id, title: "child-replay" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const captured: unknown[] = []
      const token = "obs-delete-replay"
      const opId = SessionOperation.deleteId(root.id, token)
      const base = {
        v: 1 as const,
        op: "session/delete" as const,
        opId,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: root.id, parentSessionId: null },
        payload: {},
      }
      const req1 = { ...base, requestId: "req-replay-1" }
      const r1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionDeleteDispatchService
              return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(req1).pipe(
                Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any),
              )
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r1.status).toBe("succeeded")
      expect(captured.length).toBe(1)
      const cursor1 = (captured[0] as { params: { cursor: number; entries: { seq: number }[] } }).params.cursor
      const seqs1 = (captured[0] as { params: { entries: { seq: number }[] } }).params.entries.map((e) => e.seq)
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
      const maxSeq1 = Math.max(...seqs1)
      expect(cursor1).toBe(maxSeq1)
      // replay with same opId different requestId
      const req2 = { ...base, requestId: "req-replay-2" }
      const r2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionDeleteDispatchService
              return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(req2).pipe(
                Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any),
              )
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r2.status).toBe("succeeded")
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
      // dispatchPrivate replay should also not notify
      const priv = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionDeleteDispatchService
              const fn = (svc as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate
              return yield* fn(req2).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(priv.status).toBe("succeeded")
      expect(captured.length).toBe(1)
      // also ensure dispatchPrivate with fresh request still succeeds but no notify (idempotent)
      const priv2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* SessionDeleteDispatchService
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
