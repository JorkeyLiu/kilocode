// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, SessionOperationTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { EventTable, EventSequenceTable } from "@opencode-ai/core/event/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { Session } from "../../../src/session/session"
import { SessionID, MessageID, PartID } from "../../../src/session/schema"
import { SessionRevertDispatchService } from "../../../src/kilocode/session/session-revert-dispatch"
import { DispatchAtomicSeam } from "../../../src/kilocode/session/dispatch-atomic-seam"
import { testEffect } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime } from "../../../src/effect/app-runtime"
import * as Log from "@opencode-ai/core/util/log"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

void Log.init({ print: false })

const it = testEffect(Layer.empty)

afterEach(async () => {
  DispatchAtomicSeam.failRevertInsideTx = false
  DispatchAtomicSeam.failUnrevertInsideTx = false
  if (globalThis.__dispatchAtomicSeam) {
    globalThis.__dispatchAtomicSeam.failRevertInsideTx = false
    globalThis.__dispatchAtomicSeam.failUnrevertInsideTx = false
  }
  await disposeAllInstances()
  await resetDatabase()
})

async function getRevision(dir: string, sid: string): Promise<number> {
  return AppRuntime.runPromise(
    provideInstance(dir)(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, sid as unknown as SessionID)).get().pipe(Effect.orDie)
        return row!.rev
      }),
    ),
  ) as unknown as number
}

async function getSession(dir: string, sid: string): Promise<any> {
  return AppRuntime.runPromise(
    provideInstance(dir)(
      Effect.gen(function* () {
        const svc = yield* Session.Service
        return yield* svc.get(sid as unknown as SessionID)
      }),
    ),
  ) as unknown as any
}

async function countChangefeed(dir: string, sid: string): Promise<number> {
  return AppRuntime.runPromise(
    provideInstance(dir)(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie)
        return rows.length
      }),
    ),
  ) as unknown as number
}

async function countOps(dir: string, sid: string, kind: string): Promise<number> {
  return AppRuntime.runPromise(
    provideInstance(dir)(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, sid as unknown as SessionID)).all().pipe(Effect.orDie)
        return rows.filter((r: any) => r.op_kind === kind).length
      }),
    ),
  ) as unknown as number
}

async function countEvents(dir: string, sid: string): Promise<number> {
  return AppRuntime.runPromise(
    provideInstance(dir)(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const rows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sid)).all().pipe(Effect.orDie)
        return rows.length
      }),
    ),
  ) as unknown as number
}

async function countSeq(dir: string, sid: string): Promise<number> {
  return AppRuntime.runPromise(
    provideInstance(dir)(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const rows = yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sid)).all().pipe(Effect.orDie)
        return rows.length
      }),
    ),
  ) as unknown as number
}

describe("revert/unrevert atomic S1", () => {
  it.live("revert fresh success increments revision once, appends changefeed, persists revert, inserts operation, records event", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const ids = yield* Effect.promise(() =>
        AppRuntime.runPromise(
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
              return { sessionId: session.id, messageId: assistant.id }
            }),
          ),
        ),
      ) as unknown as Effect.Effect<{ sessionId: string; messageId: string }>
      const sid = ids.sessionId
      const mid = ids.messageId
      const beforeRev = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      const beforeFeed = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      const beforeOps = yield* Effect.promise(() => countOps(dir, sid, "revert")) as unknown as Effect.Effect<number>
      expect(beforeOps).toBe(0)
      const beforeEvents = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      expect(beforeEvents).toBeGreaterThan(0)
      const beforeSeqRows = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sid)).get().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const beforeSeqVal = beforeSeqRows ? (beforeSeqRows as any).seq : -1
      const beforeSession = yield* Effect.promise(() => getSession(dir, sid)) as unknown as Effect.Effect<any>
      const beforeTime = beforeSession.time.updated

      const opId = SessionOperation.revertId(sid, "tok-revert-1")
      const req = {
        v: 1 as const,
        requestId: "req-revert-1",
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
              return yield* d.dispatchRevert(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(result.status).toBe("succeeded")
      expect(result.revision.session).toBe(beforeRev + 1)
      const afterRev = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterRev).toBe(beforeRev + 1)
      const afterFeed = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterFeed).toBe(beforeFeed + 1)
      const feedRows = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      const revertFeed = feedRows.find((r) => r.revision === afterRev)
      expect(revertFeed).toBeDefined()
      expect(revertFeed.kind).toBe("changed")
      // Exactly one feed row at committed revision
      expect(feedRows.filter((r) => r.revision === afterRev).length).toBe(1)
      const sessionAfter = yield* Effect.promise(() => getSession(dir, sid)) as unknown as Effect.Effect<any>
      expect(sessionAfter.revert).toBeDefined()
      expect(sessionAfter.revert.messageID).toBeDefined()
      // Persisted summary and time_updated advance
      expect(sessionAfter.summary).toBeDefined()
      expect(sessionAfter.summary.additions).toBeDefined()
      expect(sessionAfter.summary.deletions).toBeDefined()
      expect(sessionAfter.summary.files).toBeDefined()
      expect(sessionAfter.time.updated).toBeGreaterThanOrEqual(beforeTime)
      expect(sessionAfter.time.updated).toBeGreaterThan(0)
      const afterOps = yield* Effect.promise(() => countOps(dir, sid, "revert")) as unknown as Effect.Effect<number>
      expect(afterOps).toBe(1)
      const opRows = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, sid as unknown as SessionID)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      const opRevert = opRows.find((r) => r.op_id === opId)
      expect(opRevert).toBeDefined()
      expect(opRevert.revision).toBe(afterRev)
      expect(opRevert.result_snapshot).toBeDefined()
      const snapInfo = JSON.parse(opRevert.result_snapshot as string)
      expect(snapInfo.revert).toBeDefined()
      const afterEvents = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterEvents).toBe(beforeEvents + 1)
      // Verify seq value incremented
      const seqRow = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sid)).get().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(seqRow.seq).toBe(beforeSeqVal + 1)
    }),
  )

  it.live("unrevert fresh success increments revision, clears revert, appends changefeed/event/operation", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const ids = yield* Effect.promise(() =>
        AppRuntime.runPromise(
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
              return { sessionId: session.id, messageId: assistant.id }
            }),
          ),
        ),
      ) as unknown as Effect.Effect<{ sessionId: string; messageId: string }>
      const sid = ids.sessionId
      const mid = ids.messageId
      const revertOp = SessionOperation.revertId(sid, "tok-revert-u1")
      const revertReq = {
        v: 1 as const,
        requestId: "req-revert-u1",
        opId: revertOp,
        op: "session/revert" as const,
        idempotencyKey: revertOp,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: { messageId: mid },
      }
      const beforeRevForRevert = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      const revertRes = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert(revertReq)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(revertRes.status).toBe("succeeded")
      const revAfterRevert = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(revAfterRevert).toBe(beforeRevForRevert + 1)
      const unrevertOp = SessionOperation.unrevertId(sid, "tok-unrevert-1")
      const unrevertReq = {
        v: 1 as const,
        requestId: "req-unrevert-1",
        opId: unrevertOp,
        op: "session/unrevert" as const,
        idempotencyKey: unrevertOp,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: {},
      }
      const beforeFeed = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      const beforeOpsU = yield* Effect.promise(() => countOps(dir, sid, "unrevert")) as unknown as Effect.Effect<number>
      const beforeEvents = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      const beforeSessionU = yield* Effect.promise(() => getSession(dir, sid)) as unknown as Effect.Effect<any>
      const beforeTimeU = beforeSessionU.time.updated
      const unrevertRes = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchUnrevert(unrevertReq)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(unrevertRes.status).toBe("succeeded")
      expect(unrevertRes.revision.session).toBe(revAfterRevert + 1)
      const afterRev = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterRev).toBe(revAfterRevert + 1)
      const afterFeed = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterFeed).toBe(beforeFeed + 1)
      const feedRowsU = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      expect(feedRowsU.filter((r) => r.revision === afterRev).length).toBe(1)
      const sessionAfter = yield* Effect.promise(() => getSession(dir, sid)) as unknown as Effect.Effect<any>
      expect(sessionAfter.revert).toBeUndefined()
      expect(sessionAfter.time.updated).toBeGreaterThanOrEqual(beforeTimeU)
      const afterOpsU = yield* Effect.promise(() => countOps(dir, sid, "unrevert")) as unknown as Effect.Effect<number>
      expect(afterOpsU).toBe(beforeOpsU + 1)
      const opRows = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, sid as unknown as SessionID)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      const opUnrevert = opRows.find((r) => r.op_id === unrevertOp)
      expect(opUnrevert.revision).toBe(revAfterRevert + 1)
      const afterEvents = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterEvents).toBe(beforeEvents + 1)
      const seqRow = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sid)).get().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(seqRow.seq).toBeGreaterThan(0)
    }),
  )

  it.live("replay same revert creates no additional revision/changefeed/operation/event", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const ids = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              const s = yield* svc.create({ title: "orig" })
              const providerID = ProviderV2.ID.make("test")
              const user = yield* svc.updateMessage({
                id: MessageID.ascending(),
                sessionID: s.id,
                role: "user",
                agent: "default",
                model: { providerID, modelID: ModelV2.ID.make("test") },
                time: { created: Date.now() },
              })
              const assistant = yield* svc.updateMessage({
                id: MessageID.ascending(),
                sessionID: s.id,
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
                sessionID: s.id,
                type: "text",
                text: "hello",
              })
              return { sid: s.id, mid: assistant.id }
            }),
          ),
        ),
      ) as unknown as Effect.Effect<{ sid: string; mid: string }>
      const sid = ids.sid
      const mid = ids.mid
      const opId = SessionOperation.revertId(sid, "tok-replay")
      const req = {
        v: 1 as const,
        requestId: "req-replay",
        opId,
        op: "session/revert" as const,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: { messageId: mid },
      }
      const first = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(first.status).toBe("succeeded")
      const rev1 = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      const feed1 = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      const ops1 = yield* Effect.promise(() => countOps(dir, sid, "revert")) as unknown as Effect.Effect<number>
      const ev1 = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      const second = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(second.status).toBe("succeeded")
      expect(second.data).toEqual(first.data)
      expect(second.revision.session).toBe(first.revision.session)
      const rev2 = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(rev2).toBe(rev1)
      const feed2 = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      expect(feed2).toBe(feed1)
      const ops2 = yield* Effect.promise(() => countOps(dir, sid, "revert")) as unknown as Effect.Effect<number>
      expect(ops2).toBe(ops1)
      const ev2 = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      expect(ev2).toBe(ev1)
      // private replay
      const priv = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchPrivateRevert(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(priv.status).toBe("succeeded")
      expect(priv.data.session).toEqual(first.data)
      const rev3 = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(rev3).toBe(rev1)
    }),
  )

  it.live("conflict and stale remain non-mutating", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const ids = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              const s = yield* svc.create({ title: "orig" })
              const providerID = ProviderV2.ID.make("test")
              const user = yield* svc.updateMessage({
                id: MessageID.ascending(),
                sessionID: s.id,
                role: "user",
                agent: "default",
                model: { providerID, modelID: ModelV2.ID.make("test") },
                time: { created: Date.now() },
              })
              const assistant = yield* svc.updateMessage({
                id: MessageID.ascending(),
                sessionID: s.id,
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
                sessionID: s.id,
                type: "text",
                text: "hello",
              })
              return { sid: s.id, mid: assistant.id }
            }),
          ),
        ),
      ) as unknown as Effect.Effect<{ sid: string; mid: string }>
      const sid = ids.sid
      const mid = ids.mid
      const opId = SessionOperation.revertId(sid, "tok-conflict")
      const req = {
        v: 1 as const,
        requestId: "req-conflict",
        opId,
        op: "session/revert" as const,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: { messageId: mid },
      }
      const first = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(first.status).toBe("succeeded")
      const rev1 = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      // conflict: same idempotencyKey but different opId facts (different message)
      const otherMid = MessageID.ascending() as unknown as string
      const conflictReq = {
        v: 1 as const,
        requestId: "req-conflict2",
        opId,
        op: "session/revert" as const,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: { messageId: otherMid },
      }
      const conflict = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert(conflictReq)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(conflict.status).toBe("failed")
      expect(conflict.failure.code).toBe("conflict")
      const revAfterConflict = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(revAfterConflict).toBe(rev1)
      const opsAfterConflict = yield* Effect.promise(() => countOps(dir, sid, "revert")) as unknown as Effect.Effect<number>
      expect(opsAfterConflict).toBe(1)
      // stale: provide old sessionRevision
      const staleReq = {
        v: 1 as const,
        requestId: "req-stale",
        opId: SessionOperation.revertId(sid, "tok-stale"),
        op: "session/revert" as const,
        idempotencyKey: SessionOperation.revertId(sid, "tok-stale"),
        context: { directory: dir, sessionId: sid, parentSessionId: null, sessionRevision: 0 },
        payload: { messageId: mid },
      }
      const stale = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert(staleReq)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(stale.status).toBe("failed")
      expect(stale.failure.code).toBe("stale")
      const revAfterStale = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(revAfterStale).toBe(rev1)
    }),
  )

  it.live("revert inside-tx failure leaves no DB residual (revision/changefeed/operation/event unchanged)", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const ids = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              const s = yield* svc.create({ title: "orig" })
              const providerID = ProviderV2.ID.make("test")
              const user = yield* svc.updateMessage({
                id: MessageID.ascending(),
                sessionID: s.id,
                role: "user",
                agent: "default",
                model: { providerID, modelID: ModelV2.ID.make("test") },
                time: { created: Date.now() },
              })
              const assistant = yield* svc.updateMessage({
                id: MessageID.ascending(),
                sessionID: s.id,
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
                sessionID: s.id,
                type: "text",
                text: "hello",
              })
              return { sid: s.id, mid: assistant.id }
            }),
          ),
        ),
      ) as unknown as Effect.Effect<{ sid: string; mid: string }>
      const sid = ids.sid
      const mid = ids.mid
      const beforeRev = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      const beforeFeed = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      const beforeOps = yield* Effect.promise(() => countOps(dir, sid, "revert")) as unknown as Effect.Effect<number>
      const beforeEvents = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      const beforeSeq = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sid)).get().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const beforeSeqVal = beforeSeq ? (beforeSeq as any).seq : -1

      DispatchAtomicSeam.failRevertInsideTx = true
      if (globalThis.__dispatchAtomicSeam) globalThis.__dispatchAtomicSeam.failRevertInsideTx = true
      const opId = SessionOperation.revertId(sid, "tok-fail")
      const req = {
        v: 1 as const,
        requestId: "req-fail",
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
              return yield* d.dispatchRevert(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(result.status).toBe("failed")
      expect(result.failure.code).toBe("internal")
      DispatchAtomicSeam.failRevertInsideTx = false
      if (globalThis.__dispatchAtomicSeam) globalThis.__dispatchAtomicSeam.failRevertInsideTx = false

      const afterRev = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterRev).toBe(beforeRev)
      const afterFeed = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterFeed).toBe(beforeFeed)
      const afterOps = yield* Effect.promise(() => countOps(dir, sid, "revert")) as unknown as Effect.Effect<number>
      expect(afterOps).toBe(beforeOps)
      const afterEvents = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterEvents).toBe(beforeEvents)
      const afterSeq = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sid)).get().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const afterSeqVal = afterSeq ? (afterSeq as any).seq : -1
      expect(afterSeqVal).toBe(beforeSeqVal)
      const sessionAfter = yield* Effect.promise(() => getSession(dir, sid)) as unknown as Effect.Effect<any>
      expect(sessionAfter.revert).toBeUndefined()
    }),
  )

  it.live("unrevert inside-tx failure leaves no DB residual", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const ids = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              const s = yield* svc.create({ title: "orig" })
              const providerID = ProviderV2.ID.make("test")
              const user = yield* svc.updateMessage({
                id: MessageID.ascending(),
                sessionID: s.id,
                role: "user",
                agent: "default",
                model: { providerID, modelID: ModelV2.ID.make("test") },
                time: { created: Date.now() },
              })
              const assistant = yield* svc.updateMessage({
                id: MessageID.ascending(),
                sessionID: s.id,
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
                sessionID: s.id,
                type: "text",
                text: "hello",
              })
              return { sid: s.id, mid: assistant.id }
            }),
          ),
        ),
      ) as unknown as Effect.Effect<{ sid: string; mid: string }>
      const sid = ids.sid
      const mid = ids.mid
      const revertOp = SessionOperation.revertId(sid, "tok-revert-for-unfail")
      yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert({
                v: 1 as const,
                requestId: "req-revert-pre",
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
      const beforeRev = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(beforeRev).toBeGreaterThan(0)
      const beforeFeed = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      const beforeOps = yield* Effect.promise(() => countOps(dir, sid, "unrevert")) as unknown as Effect.Effect<number>
      const beforeEvents = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      DispatchAtomicSeam.failUnrevertInsideTx = true
      if (globalThis.__dispatchAtomicSeam) globalThis.__dispatchAtomicSeam.failUnrevertInsideTx = true
      const unrevertOp = SessionOperation.unrevertId(sid, "tok-unfail")
      const req = {
        v: 1 as const,
        requestId: "req-unfail",
        opId: unrevertOp,
        op: "session/unrevert" as const,
        idempotencyKey: unrevertOp,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: {},
      }
      const result = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchUnrevert(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(result.status).toBe("failed")
      expect(result.failure.code).toBe("internal")
      DispatchAtomicSeam.failUnrevertInsideTx = false
      if (globalThis.__dispatchAtomicSeam) globalThis.__dispatchAtomicSeam.failUnrevertInsideTx = false
      const afterRev = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterRev).toBe(beforeRev)
      const afterFeed = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterFeed).toBe(beforeFeed)
      const afterOps = yield* Effect.promise(() => countOps(dir, sid, "unrevert")) as unknown as Effect.Effect<number>
      expect(afterOps).toBe(beforeOps)
      const afterEvents = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterEvents).toBe(beforeEvents)
      const sessionAfter = yield* Effect.promise(() => getSession(dir, sid)) as unknown as Effect.Effect<any>
      expect(sessionAfter.revert).toBeDefined()
    }),
  )

  it.live("no-op revert (undefined boundary) inserts one operation at current revision without revision/feed/event/sequence bump; same-key replay is idempotent", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const ids = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              const s = yield* svc.create({ title: "orig-noop-r" })
              const providerID = ProviderV2.ID.make("test")
              const user = yield* svc.updateMessage({
                id: MessageID.ascending(),
                sessionID: s.id,
                role: "user",
                agent: "default",
                model: { providerID, modelID: ModelV2.ID.make("test") },
                time: { created: Date.now() },
              })
              const assistant = yield* svc.updateMessage({
                id: MessageID.ascending(),
                sessionID: s.id,
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
              yield* svc.updatePart({ id: PartID.ascending(), messageID: assistant.id, sessionID: s.id, type: "text", text: "hello" })
              return { sid: s.id, knownMid: assistant.id }
            }),
          ),
        ),
      ) as unknown as Effect.Effect<{ sid: string; knownMid: string }>
      const sid = ids.sid
      // Unknown messageId -> SessionRevertBoundary.resolve returns undefined -> prepareRevert returns undefined
      const unknownMid = MessageID.ascending() as unknown as string
      const beforeRev = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      const beforeFeed = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      const beforeOps = yield* Effect.promise(() => countOps(dir, sid, "revert")) as unknown as Effect.Effect<number>
      const beforeEvents = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      const beforeSeqRow = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sid)).get().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const beforeSeq = beforeSeqRow ? (beforeSeqRow as any).seq : -1
      const beforeSession = yield* Effect.promise(() => getSession(dir, sid)) as unknown as Effect.Effect<any>

      const opId = SessionOperation.revertId(sid, "tok-noop-revert")
      const req = {
        v: 1 as const,
        requestId: "req-noop-revert",
        opId,
        op: "session/revert" as const,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: { messageId: unknownMid },
      }
      const first = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(first.status).toBe("succeeded")
      // No revision bump for no-op
      expect(first.revision.session).toBe(beforeRev)
      const afterRev = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterRev).toBe(beforeRev)
      const afterFeed = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterFeed).toBe(beforeFeed)
      const afterOps = yield* Effect.promise(() => countOps(dir, sid, "revert")) as unknown as Effect.Effect<number>
      expect(afterOps).toBe(beforeOps + 1)
      const opRows = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, sid as unknown as SessionID)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      const opNoop = opRows.find((r) => r.op_id === opId)
      expect(opNoop).toBeDefined()
      expect(opNoop.revision).toBe(beforeRev)
      const afterEvents = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterEvents).toBe(beforeEvents)
      const afterSeqRow = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sid)).get().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const afterSeq = afterSeqRow ? (afterSeqRow as any).seq : -1
      expect(afterSeq).toBe(beforeSeq)
      const afterSession = yield* Effect.promise(() => getSession(dir, sid)) as unknown as Effect.Effect<any>
      // No mutation to revert marker or summary
      expect(afterSession.revert).toEqual(beforeSession.revert)
      expect(afterSession.summary).toEqual(beforeSession.summary)

      // Same-key replay: no further operation or counters
      const second = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(second.status).toBe("succeeded")
      expect(second.revision.session).toBe(beforeRev)
      expect(second.data).toEqual(first.data)
      const rev2 = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(rev2).toBe(beforeRev)
      const feed2 = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      expect(feed2).toBe(beforeFeed)
      const ops2 = yield* Effect.promise(() => countOps(dir, sid, "revert")) as unknown as Effect.Effect<number>
      expect(ops2).toBe(afterOps)
      const ev2 = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      expect(ev2).toBe(beforeEvents)
      // Private replay also non-mutating
      const priv = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchPrivateRevert(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(priv.status).toBe("succeeded")
      expect(priv.data.session).toEqual(first.data)
      const rev3 = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(rev3).toBe(beforeRev)
    }),
  )

  it.live("no-op unrevert (no marker) inserts one operation at current revision without revision/feed/event/sequence bump; same-key replay is idempotent", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const sid = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              const s = yield* svc.create({ title: "orig-noop-u" })
              const providerID = ProviderV2.ID.make("test")
              const user = yield* svc.updateMessage({
                id: MessageID.ascending(),
                sessionID: s.id,
                role: "user",
                agent: "default",
                model: { providerID, modelID: ModelV2.ID.make("test") },
                time: { created: Date.now() },
              })
              const assistant = yield* svc.updateMessage({
                id: MessageID.ascending(),
                sessionID: s.id,
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
              yield* svc.updatePart({ id: PartID.ascending(), messageID: assistant.id, sessionID: s.id, type: "text", text: "hello" })
              return s.id
            }),
          ),
        ),
      ) as unknown as Effect.Effect<string>
      const beforeRev = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      const beforeFeed = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      const beforeOps = yield* Effect.promise(() => countOps(dir, sid, "unrevert")) as unknown as Effect.Effect<number>
      const beforeEvents = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      const beforeSeqRow = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sid)).get().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const beforeSeq = beforeSeqRow ? (beforeSeqRow as any).seq : -1
      const beforeSession = yield* Effect.promise(() => getSession(dir, sid)) as unknown as Effect.Effect<any>
      expect(beforeSession.revert).toBeUndefined()

      const opId = SessionOperation.unrevertId(sid, "tok-noop-unrevert")
      const req = {
        v: 1 as const,
        requestId: "req-noop-unrevert",
        opId,
        op: "session/unrevert" as const,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: {},
      }
      const first = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchUnrevert(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(first.status).toBe("succeeded")
      expect(first.revision.session).toBe(beforeRev)
      const afterRev = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterRev).toBe(beforeRev)
      const afterFeed = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterFeed).toBe(beforeFeed)
      const afterOps = yield* Effect.promise(() => countOps(dir, sid, "unrevert")) as unknown as Effect.Effect<number>
      expect(afterOps).toBe(beforeOps + 1)
      const opRows = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, sid as unknown as SessionID)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any[]>
      const opNoop = opRows.find((r) => r.op_id === opId)
      expect(opNoop).toBeDefined()
      expect(opNoop.revision).toBe(beforeRev)
      const afterEvents = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      expect(afterEvents).toBe(beforeEvents)
      const afterSeqRow = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sid)).get().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const afterSeq = afterSeqRow ? (afterSeqRow as any).seq : -1
      expect(afterSeq).toBe(beforeSeq)
      const afterSession = yield* Effect.promise(() => getSession(dir, sid)) as unknown as Effect.Effect<any>
      expect(afterSession.revert).toBeUndefined()
      expect(afterSession.summary).toEqual(beforeSession.summary)

      const second = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchUnrevert(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(second.status).toBe("succeeded")
      expect(second.revision.session).toBe(beforeRev)
      expect(second.data).toEqual(first.data)
      const rev2 = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(rev2).toBe(beforeRev)
      const feed2 = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      expect(feed2).toBe(beforeFeed)
      const ops2 = yield* Effect.promise(() => countOps(dir, sid, "unrevert")) as unknown as Effect.Effect<number>
      expect(ops2).toBe(afterOps)
      const priv = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchPrivateUnrevert(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(priv.status).toBe("succeeded")
      expect(priv.data.session).toEqual(first.data)
      const rev3 = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(rev3).toBe(beforeRev)
    }),
  )

  it.live("unrevert replay, conflict and stale remain non-mutating (configVersion/sessionRevision checked)", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any>
      const dir = tmp.path
      const ids = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              const s = yield* svc.create({ title: "orig-unrevert-2" })
              const providerID = ProviderV2.ID.make("test")
              const user = yield* svc.updateMessage({
                id: MessageID.ascending(),
                sessionID: s.id,
                role: "user",
                agent: "default",
                model: { providerID, modelID: ModelV2.ID.make("test") },
                time: { created: Date.now() },
              })
              const assistant = yield* svc.updateMessage({
                id: MessageID.ascending(),
                sessionID: s.id,
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
              yield* svc.updatePart({ id: PartID.ascending(), messageID: assistant.id, sessionID: s.id, type: "text", text: "hello" })
              return { sid: s.id, mid: assistant.id }
            }),
          ),
        ),
      ) as unknown as Effect.Effect<{ sid: string; mid: string }>
      const sid = ids.sid
      const mid = ids.mid
      // Fresh revert first
      const revertOp = SessionOperation.revertId(sid, "tok-unrevert-conflict-revert")
      const revertReq = {
        v: 1 as const,
        requestId: "req-unrevert-conflict-revert",
        opId: revertOp,
        op: "session/revert" as const,
        idempotencyKey: revertOp,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: { messageId: mid },
      }
      const revertRes = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchRevert(revertReq)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(revertRes.status).toBe("succeeded")
      const revAfterRevert = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>

      // Fresh unrevert
      const unrevertOp = SessionOperation.unrevertId(sid, "tok-unrevert-replay")
      const unrevertReq = {
        v: 1 as const,
        requestId: "req-unrevert-replay",
        opId: unrevertOp,
        op: "session/unrevert" as const,
        idempotencyKey: unrevertOp,
        context: { directory: dir, sessionId: sid, parentSessionId: null },
        payload: {},
      }
      const first = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchUnrevert(unrevertReq)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(first.status).toBe("succeeded")
      const rev1 = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(rev1).toBe(revAfterRevert + 1)
      const feed1 = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      const ops1 = yield* Effect.promise(() => countOps(dir, sid, "unrevert")) as unknown as Effect.Effect<number>
      const ev1 = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      const seqRow1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sid)).get().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      const seq1 = seqRow1 ? (seqRow1 as any).seq : -1

      // Replay same unrevert: no additional revision/changefeed/operation/event
      const second = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchUnrevert(unrevertReq)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(second.status).toBe("succeeded")
      expect(second.data).toEqual(first.data)
      expect(second.revision.session).toBe(first.revision.session)
      const rev2 = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(rev2).toBe(rev1)
      const feed2 = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      expect(feed2).toBe(feed1)
      const ops2 = yield* Effect.promise(() => countOps(dir, sid, "unrevert")) as unknown as Effect.Effect<number>
      expect(ops2).toBe(ops1)
      const ev2 = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      expect(ev2).toBe(ev1)
      const seqRow2 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sid)).get().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect((seqRow2 as any).seq).toBe(seq1)
      // Private replay also non-mutating
      const priv = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchPrivateUnrevert(unrevertReq)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(priv.status).toBe("succeeded")
      expect(priv.data.session).toEqual(first.data)
      const revPriv = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(revPriv).toBe(rev1)

      // Conflict: same idempotencyKey (same token/opId) but different configVersion
      const conflictReq = {
        v: 1 as const,
        requestId: "req-unrevert-conflict2",
        opId: unrevertOp,
        op: "session/unrevert" as const,
        idempotencyKey: unrevertOp,
        context: { directory: dir, sessionId: sid, parentSessionId: null, configVersion: 999 },
        payload: {},
      }
      const conflict = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchUnrevert(conflictReq)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(conflict.status).toBe("failed")
      expect(conflict.failure.code).toBe("conflict")
      const revAfterConflict = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(revAfterConflict).toBe(rev1)
      const opsAfterConflict = yield* Effect.promise(() => countOps(dir, sid, "unrevert")) as unknown as Effect.Effect<number>
      expect(opsAfterConflict).toBe(ops1)
      const feedAfterConflict = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      expect(feedAfterConflict).toBe(feed1)
      const evAfterConflict = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      expect(evAfterConflict).toBe(ev1)

      // Stale: sessionRevision 0 after revision has advanced
      const staleOp = SessionOperation.unrevertId(sid, "tok-unrevert-stale")
      const staleReq = {
        v: 1 as const,
        requestId: "req-unrevert-stale",
        opId: staleOp,
        op: "session/unrevert" as const,
        idempotencyKey: staleOp,
        context: { directory: dir, sessionId: sid, parentSessionId: null, sessionRevision: 0 },
        payload: {},
      }
      const stale = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionRevertDispatchService
              return yield* d.dispatchUnrevert(staleReq)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any>
      expect(stale.status).toBe("failed")
      expect(stale.failure.code).toBe("stale")
      const revAfterStale = yield* Effect.promise(() => getRevision(dir, sid)) as unknown as Effect.Effect<number>
      expect(revAfterStale).toBe(rev1)
      const opsAfterStale = yield* Effect.promise(() => countOps(dir, sid, "unrevert")) as unknown as Effect.Effect<number>
      expect(opsAfterStale).toBe(ops1)
      const feedAfterStale = yield* Effect.promise(() => countChangefeed(dir, sid)) as unknown as Effect.Effect<number>
      expect(feedAfterStale).toBe(feed1)
      const evAfterStale = yield* Effect.promise(() => countEvents(dir, sid)) as unknown as Effect.Effect<number>
      expect(evAfterStale).toBe(ev1)
    }),
  )
})
