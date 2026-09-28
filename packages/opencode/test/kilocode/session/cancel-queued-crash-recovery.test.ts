// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { Session } from "../../../src/session/session"
import { SessionID, MessageID } from "../../../src/session/schema"
import { CancelQueuedDispatchService } from "../../../src/kilocode/session/cancel-queued-dispatch"
import { testEffect } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime } from "../../../src/effect/app-runtime"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

import { Layer } from "effect"
const it = testEffect(Layer.empty)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("cancelQueued crash recovery dispatch", () => {
  it.live("converged orphan replays as explicit ambiguous with no revision advance", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "crash-replay" }) })))) as unknown as Effect.Effect<any, any, any>)
      const messageId = MessageID.make("msg_crash_1")
      const opId = SessionOperation.cancelQueuedId(session.id, messageId)
      const idem = "idem-crash-replay-1"
      const hash = SessionOperation.hashIdempotencyKey(idem)
      // Simulate crash: reserve durable in-flight then die before terminal.
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const { db } = yield* Database.Service
        const now = Date.now()
        yield* db.transaction((tx) =>
          SessionOperation.insertCancelQueuedInFlightTx(tx as never, session.id, {
            opId,
            opKind: "cancelQueued",
            outcome: "in-flight",
            code: "cancelQueued.inflight",
            message: "cancelQueued in-flight",
            time: now,
          }, {
            idempotencyHash: hash,
            requestId: "req-crash-1",
            directory: dir,
            messageId,
            parentSessionId: null,
            configVersion: null,
            sessionRevision: null,
            cancelled: null,
          }),
        )
      })))) as unknown as Effect.Effect<any, any, any>)
      // Converge via pre-bind sweep.
      const sweep = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* SessionOperation.convergeOrphanedInFlight(db)
      })))) as unknown as Effect.Effect<any, any, any>)
      expect(sweep.converged).toEqual([opId])
      const req = { v: 1 as const, requestId: "req-crash-retry", opId, op: "session/cancelQueued" as const, idempotencyKey: idem, context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { messageId } }
      const dispatch = (r: typeof req) => Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(r) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>
      const feedBefore = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      const revBefore = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      const r1 = yield* dispatch(req)
      expect((r1 as any).status).toBe("ambiguous")
      expect((r1 as any).accepted).toBe(false)
      expect((r1 as any).data).toBeUndefined()
      const r2 = yield* dispatch(req)
      expect((r2 as any).status).toBe("ambiguous")
      expect((r2 as any).accepted).toBe(false)
      const revAfter = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      expect(revAfter).toBe(revBefore)
      const feedAfter = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect((feedAfter as any[]).length).toBe((feedBefore as any[]).length)
      const opRows = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); return yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      const cancelRows = (opRows as any[]).filter((r) => r.op_kind === "cancelQueued" && r.op_id === opId)
      expect(cancelRows.length).toBe(1)
      expect(cancelRows[0].outcome).toBe("ambiguous")
      expect(cancelRows[0].cancelled).toBeNull()
    }),
  )

  it.live("normal successful cancellation still returns succeeded cancelled false", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "crash-normal" }) })))) as unknown as Effect.Effect<any, any, any>)
      const messageId = MessageID.make("msg_normal_1")
      const opId = SessionOperation.cancelQueuedId(session.id, messageId)
      const req = { v: 1 as const, requestId: "req-normal-1", opId, op: "session/cancelQueued" as const, idempotencyKey: "idem-normal-1", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { messageId } }
      const result = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(req) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      expect((result as any).status).toBe("succeeded")
      if ((result as any).status === "succeeded") {
        expect((result as any).accepted).toBe(true)
        expect((result as any).data.cancelled).toBe(false)
      }
    }),
  )
})
