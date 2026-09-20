// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, SessionOperationTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { Session } from "../../../src/session/session"
import { SessionID, MessageID, PartID } from "../../../src/session/schema"
import { SessionRevertDispatchService } from "../../../src/kilocode/session/session-revert-dispatch"
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
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

const it = testEffect(Layer.empty)

afterEach(async () => {
  DispatchAtomicSeam.failRevertInsideTx = false
  DispatchAtomicSeam.failUnrevertInsideTx = false
  if ((globalThis as any).__dispatchAtomicSeam) {
    ;(globalThis as any).__dispatchAtomicSeam.failRevertInsideTx = false
    ;(globalThis as any).__dispatchAtomicSeam.failUnrevertInsideTx = false
  }
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

async function createRevertableSession(dir: string) {
  const ids = (await AppRuntime.runPromise(
    provideInstance(dir)(
      Effect.gen(function* () {
        const svc = yield* Session.Service
        const session = yield* svc.create({ title: "orig" })
        const providerID = ProviderV2.ID.make("test")
        const user = yield* svc.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          agent: "default",
          model: { providerID, modelID: ModelV2.ID.make("test") },
          time: { created: Date.now() },
        })
        const assistant = yield* svc.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "assistant",
          parentID: user.id,
          mode: "default",
          agent: "default",
          path: { cwd: dir, root: dir },
          cost: 1,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("test"),
          providerID,
          time: { created: Date.now(), completed: Date.now() },
          finish: "stop",
        })
        yield* svc.updatePart({
          id: PartID.ascending(),
          messageID: assistant.id,
          sessionID: session.id,
          type: "text",
          text: "hello",
        })
        return { sid: session.id, mid: assistant.id }
      }),
    ),
  )) as { sid: string; mid: string }
  return ids
}

describe("session/revert+unrevert observation/changed producer slice", () => {
  it.live("fresh revert emits valid five-key v1.0 changed with cursor===seq and committed revision/time", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const { sid, mid } = yield* Effect.promise(() => createRevertableSession(dir)) as unknown as Effect.Effect<{ sid: string; mid: string }>
      const beforeRev = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, sid as unknown as SessionID)).get().pipe(Effect.orDie)
              return row!.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const captured: unknown[] = []
      const opId = SessionOperation.revertId(sid, "obs-revert-1")
      const req = {
        v: 1 as const,
        requestId: "req-obs-revert-1",
        opId,
        op: "session/revert" as const,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: { messageId: mid },
      }
      const result = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert(req).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any))
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
      expect(entry.session_id).toBe(sid)
      expect(entry.revision).toBe(beforeRev + 1)
      expect(result.revision.session).toBe(entry.revision)
      expect(params.cursor).toBe(entry.seq)
      expect((entry as Record<string, unknown>).title).toBeUndefined()
      expect((entry as Record<string, unknown>).directory).toBeUndefined()
      // persisted row matches exactly
      const feeds = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      const found = feeds.find((f) => f.revision === entry.revision)
      expect(found).toBeDefined()
      expect(found.seq).toBe(entry.seq)
      expect(found.session_id).toBe(entry.session_id)
      expect(found.revision).toBe(entry.revision)
      expect(found.kind).toBe(entry.kind)
      expect(found.time).toBe(entry.time)
    }),
  )

  it.live("fresh unrevert emits valid five-key v1.0 changed with cursor===seq and committed revision/time", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const { sid, mid } = yield* Effect.promise(() => createRevertableSession(dir)) as unknown as Effect.Effect<{ sid: string; mid: string }>
      // first revert to have marker
      const revertOp = SessionOperation.revertId(sid, "obs-revert-for-unrevert")
      yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert({
                v: 1 as const,
                requestId: "req-pre-revert-unrevert",
                opId: revertOp,
                op: "session/revert" as const,
                idempotencyKey: revertOp,
                context: { directory: dir, sessionId: sid, parentSessionId: null },
                payload: { messageId: mid },
              })
            }),
          ),
        ),
      )
      const beforeRev = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, sid as unknown as SessionID)).get().pipe(Effect.orDie)
              return row!.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const captured: unknown[] = []
      const opId = SessionOperation.unrevertId(sid, "obs-unrevert-1")
      const req = {
        v: 1 as const,
        requestId: "req-obs-unrevert-1",
        opId,
        op: "session/unrevert" as const,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: {},
      }
      const result = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchUnrevert(req).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any))
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
      const entry = (params.entries as unknown[])[0] as Record<string, unknown>
      const keys = Object.keys(entry).sort()
      expect(keys).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
      expect(entry.kind).toBe("changed")
      expect(entry.session_id).toBe(sid)
      expect(entry.revision).toBe(beforeRev + 1)
      expect(result.revision.session).toBe(entry.revision)
      expect(params.cursor).toBe(entry.seq)
      const feeds = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      const found = feeds.find((f) => f.revision === entry.revision)
      expect(found).toBeDefined()
      expect(found.seq).toBe(entry.seq)
      expect(found.time).toBe(entry.time)
    }),
  )

  it.live("no-op revert and no-op unrevert do not notify", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const { sid } = yield* Effect.promise(() => createRevertableSession(dir)) as unknown as Effect.Effect<{ sid: string; mid: string }>
      // no-op revert: unknown messageId
      const unknownMid = MessageID.ascending() as unknown as string
      const capturedRevert: unknown[] = []
      const opIdR = SessionOperation.revertId(sid, "obs-noop-revert")
      const reqR = {
        v: 1 as const,
        requestId: "req-noop-revert",
        opId: opIdR,
        op: "session/revert" as const,
        idempotencyKey: opIdR,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: { messageId: unknownMid },
      }
      const r = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert(reqR).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(capturedRevert) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r.status).toBe("succeeded")
      expect(capturedRevert.length).toBe(0)
      const feedsAfterRevert = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      const beforeUnrevertCount = feedsAfterRevert.length
      // no-op unrevert: no marker present (already no marker after no-op revert)
      const capturedUnrevert: unknown[] = []
      const opIdU = SessionOperation.unrevertId(sid, "obs-noop-unrevert")
      const reqU = {
        v: 1 as const,
        requestId: "req-noop-unrevert",
        opId: opIdU,
        op: "session/unrevert" as const,
        idempotencyKey: opIdU,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: {},
      }
      const u = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchUnrevert(reqU).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(capturedUnrevert) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(u.status).toBe("succeeded")
      expect(capturedUnrevert.length).toBe(0)
      const feedsAfterUnrevert = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(feedsAfterUnrevert.length).toBe(beforeUnrevertCount)
    }),
  )

  it.live("peer unavailable/throw does not affect revert/unrevert success and produces no notification", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const { sid, mid } = yield* Effect.promise(() => createRevertableSession(dir)) as unknown as Effect.Effect<{ sid: string; mid: string }>
      // revert with unavailable peer (no service)
      const opId1 = SessionOperation.revertId(sid, "obs-unavail-revert")
      const req1 = {
        v: 1 as const,
        requestId: "req-unavail-revert",
        opId: opId1,
        op: "session/revert" as const,
        idempotencyKey: opId1,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: { messageId: mid },
      }
      const r1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert(req1)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r1.status).toBe("succeeded")
      // unrevert with throwing peer still succeeds but no capture
      const captured: unknown[] = []
      const opId2 = SessionOperation.unrevertId(sid, "obs-throw-unrevert")
      const req2 = {
        v: 1 as const,
        requestId: "req-throw-unrevert",
        opId: opId2,
        op: "session/unrevert" as const,
        idempotencyKey: opId2,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: {},
      }
      const r2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchUnrevert(req2).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured, true) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r2.status).toBe("succeeded")
      expect(captured.length).toBe(0)
      // revert with throwing peer also isolated
      const captured2: unknown[] = []
      // need a new session for revert throw isolation (sid already unreverted, so we can revert again)
      const tmp2 = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir2 = tmp2.path
      const ids2 = yield* Effect.promise(() => createRevertableSession(dir2)) as unknown as Effect.Effect<{ sid: string; mid: string }>
      const sid2 = ids2.sid
      const mid2 = ids2.mid
      const opId3 = SessionOperation.revertId(sid2, "obs-throw-revert")
      const req3 = {
        v: 1 as const,
        requestId: "req-throw-revert",
        opId: opId3,
        op: "session/revert" as const,
        idempotencyKey: opId3,
        context: { directory: dir2, sessionId: sid2, parentSessionId: null },
        payload: { messageId: mid2 },
      }
      const r3 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir2)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert(req3).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured2, true) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r3.status).toBe("succeeded")
      expect(captured2.length).toBe(0)
    }),
  )

  it.live("idempotent replay does not produce new seq nor duplicate notification; dispatchPrivate never notifies", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const { sid, mid } = yield* Effect.promise(() => createRevertableSession(dir)) as unknown as Effect.Effect<{ sid: string; mid: string }>
      const captured: unknown[] = []
      const opId = SessionOperation.revertId(sid, "obs-replay-revert")
      const base = {
        v: 1 as const,
        op: "session/revert" as const,
        opId,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: { messageId: mid },
      }
      const req1 = { ...base, requestId: "req-replay-revert-1" }
      const r1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert(req1).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any))
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
              return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      const count1 = feeds1.length
      // replay same opId different requestId -> no new notification
      const req2 = { ...base, requestId: "req-replay-revert-2" }
      const r2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert(req2).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r2.status).toBe("succeeded")
      expect(r2.data.revert?.messageID).toBe(r1.data.revert?.messageID)
      expect(captured.length).toBe(1)
      const feeds2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(feeds2.length).toBe(count1)
      const seq2 = feeds2.find((f) => f.revision === r1.revision.session)?.seq
      expect(seq2).toBe(seq1)
      // dispatchPrivate replay must also not notify
      const priv = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchPrivateRevert(req2).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(priv.status).toBe("succeeded")
      expect(captured.length).toBe(1)

      // unrevert replay similarly
      const opIdU = SessionOperation.unrevertId(sid, "obs-replay-unrevert")
      const baseU = {
        v: 1 as const,
        op: "session/unrevert" as const,
        opId: opIdU,
        idempotencyKey: opIdU,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: {},
      }
      const capturedU: unknown[] = []
      const reqU1 = { ...baseU, requestId: "req-replay-unrevert-1" }
      const ru1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchUnrevert(reqU1).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(capturedU) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(ru1.status).toBe("succeeded")
      expect(capturedU.length).toBe(1)
      const seqU1 = (capturedU[0] as { params: { cursor: number } }).params.cursor
      const feedsU1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      const countU1 = feedsU1.length
      const reqU2 = { ...baseU, requestId: "req-replay-unrevert-2" }
      const ru2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchUnrevert(reqU2).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(capturedU) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(ru2.status).toBe("succeeded")
      expect(capturedU.length).toBe(1)
      const feedsU2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(feedsU2.length).toBe(countU1)
      const seqU2 = feedsU2.find((f) => f.revision === ru1.revision.session)?.seq
      expect(seqU2).toBe(seqU1)
      // dispatchPrivateUnrevert also never notifies
      const privU = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchPrivateUnrevert(reqU2).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(capturedU) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(privU.status).toBe("succeeded")
      expect(capturedU.length).toBe(1)
    }),
  )

  it.live("transaction failure does not notify and leaves no DB residual", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const { sid, mid } = yield* Effect.promise(() => createRevertableSession(dir)) as unknown as Effect.Effect<{ sid: string; mid: string }>
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
      const beforeRev = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, sid as unknown as SessionID)).get().pipe(Effect.orDie)
              return row!.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      DispatchAtomicSeam.failRevertInsideTx = true
      if ((globalThis as any).__dispatchAtomicSeam) (globalThis as any).__dispatchAtomicSeam.failRevertInsideTx = true
      const captured: unknown[] = []
      const opId = SessionOperation.revertId(sid, "obs-fail-revert")
      const req = {
        v: 1 as const,
        requestId: "req-fail-revert",
        opId,
        op: "session/revert" as const,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: { messageId: mid },
      }
      const result = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert(req).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(result.status).toBe("failed")
      expect(captured.length).toBe(0)
      DispatchAtomicSeam.failRevertInsideTx = false
      if ((globalThis as any).__dispatchAtomicSeam) (globalThis as any).__dispatchAtomicSeam.failRevertInsideTx = false
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
      const afterRev = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, sid as unknown as SessionID)).get().pipe(Effect.orDie)
              return row!.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(afterRev).toBe(beforeRev)
      const ops = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, opId)).get().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(ops).toBeUndefined()

      // unrevert failure similarly
      // first create a valid revert to have marker for unrevert attempt
      const revertOp = SessionOperation.revertId(sid, "obs-fail-unrevert-pre")
      yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert({
                v: 1 as const,
                requestId: "req-pre-unrevert-fail",
                opId: revertOp,
                op: "session/revert" as const,
                idempotencyKey: revertOp,
                context: { directory: dir, sessionId: sid, parentSessionId: null },
                payload: { messageId: mid },
              })
            }),
          ),
        ),
      )
      const beforeRevU = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, sid as unknown as SessionID)).get().pipe(Effect.orDie)
              return row!.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      const beforeFeedsU = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      const beforeCountU = beforeFeedsU.length
      DispatchAtomicSeam.failUnrevertInsideTx = true
      if ((globalThis as any).__dispatchAtomicSeam) (globalThis as any).__dispatchAtomicSeam.failUnrevertInsideTx = true
      const capturedU: unknown[] = []
      const opIdU = SessionOperation.unrevertId(sid, "obs-fail-unrevert")
      const reqU = {
        v: 1 as const,
        requestId: "req-fail-unrevert",
        opId: opIdU,
        op: "session/unrevert" as const,
        idempotencyKey: opIdU,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: {},
      }
      const resultU = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchUnrevert(reqU).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(capturedU) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(resultU.status).toBe("failed")
      expect(capturedU.length).toBe(0)
      DispatchAtomicSeam.failUnrevertInsideTx = false
      if ((globalThis as any).__dispatchAtomicSeam) (globalThis as any).__dispatchAtomicSeam.failUnrevertInsideTx = false
      const afterFeedsU = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(afterFeedsU.length).toBe(beforeCountU)
      const afterRevU = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, sid as unknown as SessionID)).get().pipe(Effect.orDie)
              return row!.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<number>
      expect(afterRevU).toBe(beforeRevU)
      const opsU = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, opIdU)).get().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(opsU).toBeUndefined()
    }),
  )

  it.live("dispatchPrivate never notifies even on fresh committed read", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const { sid, mid } = yield* Effect.promise(() => createRevertableSession(dir)) as unknown as Effect.Effect<{ sid: string; mid: string }>
      const opId = SessionOperation.revertId(sid, "obs-private-revert")
      const req = {
        v: 1 as const,
        requestId: "req-private-revert",
        opId,
        op: "session/revert" as const,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: { messageId: mid },
      }
      // first fresh commit via dispatch
      const captured: unknown[] = []
      const r = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert(req).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(r.status).toBe("succeeded")
      expect(captured.length).toBe(1)
      // now private read should not add notification
      const priv = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchPrivateRevert(req).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(priv.status).toBe("succeeded")
      expect(captured.length).toBe(1)
      // also private with new opId that has committed record but called via private still not notifies
      // unrevert private
      const opIdU = SessionOperation.unrevertId(sid, "obs-private-unrevert")
      const reqU = {
        v: 1 as const,
        requestId: "req-private-unrevert-pre",
        opId: opIdU,
        op: "session/unrevert" as const,
        idempotencyKey: opIdU,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: {},
      }
      const ru = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchUnrevert(reqU).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(ru.status).toBe("succeeded")
      expect(captured.length).toBe(2)
      const privU = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchPrivateUnrevert(reqU).pipe(Effect.provideService(PrivatePeerService, makeMockPeer(captured) as unknown as any))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(privU.status).toBe("succeeded")
      expect(captured.length).toBe(2)
    }),
  )
})
