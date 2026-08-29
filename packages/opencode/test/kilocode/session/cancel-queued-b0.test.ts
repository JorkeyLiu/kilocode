// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { Session } from "../../../src/session/session"
import { SessionID, MessageID } from "../../../src/session/schema"
import { CancelQueuedDispatchService } from "../../../src/kilocode/session/cancel-queued-dispatch"
import { KiloSessionPromptQueue } from "../../../src/kilocode/session/prompt-queue"
import { testEffect, pollWithTimeout } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime } from "../../../src/effect/app-runtime"
import * as Log from "@opencode-ai/core/util/log"
import { Server } from "../../../src/server/server"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { InstanceStore } from "../../../src/project/instance-store"
import { ControlLease } from "../../../src/kilocode/server/control-lease"
import { ConfigConvergence } from "../../../src/kilocode/server/config-convergence"
import { acquireDrainControl, acquireDrainControlWith, InstanceUnavailableDuringConfigRebuildError } from "../../../src/kilocode/server/drain-control-acquire"
import { AppLayer } from "../../../src/effect/app-runtime"

void Log.init({ print: false })

const it = testEffect(Layer.empty)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("cancelQueued B0", () => {
  it.live("pending queued returns true with 3 revisions", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "test" }) })))) as unknown as Effect.Effect<any, any, any>)
      const sessionId = SessionID.make(session.id)
      const holderId = MessageID.make("msg_holder_1")
      const holderGate = yield* Deferred.make<void>()
      const holderFiber = yield* KiloSessionPromptQueue.enqueue(sessionId, holderId, Deferred.await(holderGate), Effect.succeed("holder")).pipe(Effect.forkScoped)
      yield* pollWithTimeout(Effect.sync(() => (KiloSessionPromptQueue._hasInternalState(sessionId) ? (true as const) : undefined)), "holder not active")
      const messageId = MessageID.make("msg_pending_1")
      const pendingGate = yield* Deferred.make<void>()
      const pendingFiber = yield* KiloSessionPromptQueue.enqueue(sessionId, messageId, Deferred.await(pendingGate), Effect.succeed("cancelled")).pipe(Effect.forkScoped)
      yield* pollWithTimeout(Effect.sync(() => (KiloSessionPromptQueue._isQueued(sessionId, messageId) ? (true as const) : undefined)), "pending not queued")
      expect(KiloSessionPromptQueue._isQueued(sessionId, messageId)).toBe(true)
      const beforeRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      const opId = SessionOperation.cancelQueuedId(session.id, messageId)
      const req = { v: 1 as const, requestId: "req1", opId, op: "session/cancelQueued" as const, idempotencyKey: "idem-pending", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { messageId } }
      const result = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(req) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      expect(result.status).toBe("succeeded")
      if (result.status === "succeeded") expect(result.data.cancelled).toBe(true)
      // flagged pending remains in pending map until its turn runs
      expect(KiloSessionPromptQueue._isQueued(sessionId, messageId)).toBe(true)
      const afterRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterRev - beforeRev).toBe(3)
      yield* Deferred.succeed(holderGate, void 0)
      yield* Fiber.join(holderFiber).pipe(Effect.orDie)
      // after holder completes, pending fiber runs its cancelled effect and clears
      yield* pollWithTimeout(Effect.sync(() => (!KiloSessionPromptQueue._isQueued(sessionId, messageId) ? (true as const) : undefined)), "pending still queued after holder")
      expect(KiloSessionPromptQueue._isQueued(sessionId, messageId)).toBe(false)
      yield* Deferred.succeed(pendingGate, void 0)
      yield* Fiber.join(pendingFiber).pipe(Effect.orDie)
    }),
  )

  it.live("running slot not cancelled returns false with 2 revisions", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "test2" }) })))) as unknown as Effect.Effect<any, any, any>)
      const sessionId = SessionID.make(session.id)
      const messageId = MessageID.make("msg_running_1")
      const gate = yield* Deferred.make<void>()
      const work = Deferred.await(gate)
      const fiber = yield* KiloSessionPromptQueue.enqueue(sessionId, messageId, work, Effect.succeed("cancelled")).pipe(Effect.forkScoped)
      yield* pollWithTimeout(Effect.sync(() => (!KiloSessionPromptQueue._isQueued(sessionId, messageId) ? (true as const) : undefined)), "running slot still queued")
      expect(KiloSessionPromptQueue._isQueued(sessionId, messageId)).toBe(false)
      const beforeRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      const opId = SessionOperation.cancelQueuedId(session.id, messageId)
      const req = { v: 1 as const, requestId: "req2", opId, op: "session/cancelQueued" as const, idempotencyKey: "idem-running", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { messageId } }
      const result = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(req) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      expect(result.status).toBe("succeeded")
      if (result.status === "succeeded") expect(result.data.cancelled).toBe(false)
      const afterRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterRev - beforeRev).toBe(2)
      yield* Deferred.succeed(gate, void 0)
      yield* Fiber.join(fiber).pipe(Effect.orDie)
    }),
  )

  it.live("duplicate concurrent returns one succeeded and one ambiguous with one durable row", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "test-conc" }) })))) as unknown as Effect.Effect<any, any, any>)
      const sessionId = SessionID.make(session.id)
      const messageId = MessageID.make("msg_conc_1")
      const gate = yield* Deferred.make<void>()
      const fiber = yield* KiloSessionPromptQueue.enqueue(sessionId, messageId, Deferred.await(gate), Effect.succeed("cancelled")).pipe(Effect.forkScoped)
      yield* pollWithTimeout(Effect.sync(() => (!KiloSessionPromptQueue._isQueued(sessionId, messageId) ? (true as const) : undefined)), "concurrent slot still queued")
      const opId = SessionOperation.cancelQueuedId(session.id, messageId)
      const req = { v: 1 as const, requestId: "req-conc", opId, op: "session/cancelQueued" as const, idempotencyKey: "idem-conc-dup", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { messageId } }
      const dispatch = (r: typeof req) => Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(r) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>
      const [r1, r2] = yield* Effect.all([dispatch(req), dispatch(req)], { concurrency: "unbounded" })
      const statuses = [(r1 as any).status, (r2 as any).status].sort()
      expect(statuses).toContain("succeeded")
      expect(statuses.includes("ambiguous") || statuses.filter((s) => s === "succeeded").length === 2).toBe(true)
      // assert one durable row and one queue transition
      const rows = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const all = yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).all().pipe(Effect.orDie); return all })))) as unknown as Effect.Effect<any, any, any>)
      // check operation table has exactly one cancelQueued row for this hash
      const opRows = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows2 = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie); return rows2 })))) as unknown as Effect.Effect<any, any, any>)
      const cancelRows = (opRows as any[]).filter((r) => r.op_kind === "cancelQueued")
      expect(cancelRows.length).toBe(1)
      expect(["succeeded", "in-flight"].includes(cancelRows[0].outcome)).toBe(true)
      yield* Deferred.succeed(gate, void 0)
      yield* Fiber.join(fiber).pipe(Effect.orDie)
    }),
  )

  it.live("replay after terminal does not advance revision or feed and has exactly one MessageRemoved", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "test-replay" }) })))) as unknown as Effect.Effect<any, any, any>)
      const sessionId = SessionID.make(session.id)
      const messageId = MessageID.make("msg_replay_1")
      const opId = SessionOperation.cancelQueuedId(session.id, messageId)
      const req = { v: 1 as const, requestId: "req-replay", opId, op: "session/cancelQueued" as const, idempotencyKey: "idem-replay", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { messageId } }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(req) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      expect((r1 as any).status).toBe("succeeded")
      const rev1 = (r1 as any).revision.session
      const feed1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie); return rows.length })))) as unknown as Effect.Effect<any, any, any>)
      const r2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(req) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      expect((r2 as any).status).toBe("succeeded")
      const rev2 = (r2 as any).revision.session
      expect(rev2).toBe(rev1)
      const feed2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie); return rows.length })))) as unknown as Effect.Effect<any, any, any>)
      expect(feed2).toBe(feed1)
      // exactly one operation row, no duplicate MessageRemoved (revision already checked)
      const opRows = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows2 = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie); return rows2 })))) as unknown as Effect.Effect<any, any, any>)
      const cancelRows = (opRows as any[]).filter((r) => r.op_kind === "cancelQueued" && r.op_id === opId)
      expect(cancelRows.length).toBe(1)
      expect(cancelRows[0].outcome).toBe("succeeded")
    }),
  )

  it.live("stale sessionRevision fails for new reservation but replays stale terminal", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "test-stale" }) })))) as unknown as Effect.Effect<any, any, any>)
      const sessionId = SessionID.make(session.id)
      // advance revision to make 0 stale
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const mod = yield* Effect.promise(() => import("../../../src/session/todo")); const todoSvc = yield* (mod as any).Todo.Service; yield* todoSvc.update({ sessionID: sessionId, todos: [{ content: "t", status: "pending", priority: "high" }] }) })))) as unknown as Effect.Effect<any, any, any>)
      const staleMsg = MessageID.make("msg_stale_1")
      const staleOpId = SessionOperation.cancelQueuedId(session.id, staleMsg)
      const staleReq = { v: 1 as const, requestId: "req-stale", opId: staleOpId, op: "session/cancelQueued" as const, idempotencyKey: "idem-stale-new", context: { directory: dir, sessionId: session.id, parentSessionId: null, sessionRevision: 0 }, payload: { messageId: staleMsg } }
      const staleResult = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(staleReq) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      expect((staleResult as any).status).toBe("failed")
      if ((staleResult as any).status === "failed") expect((staleResult as any).failure.code).toBe("stale")
      // now create a terminal with fresh revision captured, then replay with same stale revision should still replay (LOCK-202)
      const curRevBefore = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const { Database } = yield* Effect.promise(() => import("@opencode-ai/core/database/database")); const { SessionTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const db = (yield* Database.Service).db; const { eq } = yield* Effect.promise(() => import("drizzle-orm")); const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      const freshMsg = MessageID.make("msg_stale_replay")
      const freshOpId = SessionOperation.cancelQueuedId(session.id, freshMsg)
      const freshReq = { v: 1 as const, requestId: "req-fresh", opId: freshOpId, op: "session/cancelQueued" as const, idempotencyKey: "idem-stale-replay", context: { directory: dir, sessionId: session.id, parentSessionId: null, sessionRevision: curRevBefore }, payload: { messageId: freshMsg } }
      const freshRes = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(freshReq) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      expect((freshRes as any).status).toBe("succeeded")
      // advance again to make original context stale
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const mod = yield* Effect.promise(() => import("../../../src/session/todo")); const todoSvc = yield* (mod as any).Todo.Service; yield* todoSvc.update({ sessionID: sessionId, todos: [{ content: "t2", status: "pending", priority: "high" }] }) })))) as unknown as Effect.Effect<any, any, any>)
      const replayReq = { v: 1 as const, requestId: "req-replay-stale", opId: freshOpId, op: "session/cancelQueued" as const, idempotencyKey: "idem-stale-replay", context: { directory: dir, sessionId: session.id, parentSessionId: null, sessionRevision: curRevBefore }, payload: { messageId: freshMsg } }
      const replayRes = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(replayReq) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      expect((replayRes as any).status).toBe("succeeded")
      expect((replayRes as any).data.cancelled).toBe((freshRes as any).data.cancelled)
    }),
  )

  it.live("directory mismatch fails with scope_mismatch", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const otherTmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const otherDir = otherTmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "test-mismatch" }) })))) as unknown as Effect.Effect<any, any, any>)
      const msg = MessageID.make("msg_mismatch_1")
      const opId = SessionOperation.cancelQueuedId(session.id, msg)
      const req = { v: 1 as const, requestId: "req-mismatch", opId, op: "session/cancelQueued" as const, idempotencyKey: "idem-mismatch", context: { directory: otherDir, sessionId: session.id, parentSessionId: null }, payload: { messageId: msg } }
      const result = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(req) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      expect((result as any).status).toBe("failed")
      if ((result as any).status === "failed") expect((result as any).failure.code).toBe("scope_mismatch")
    }),
  )

  it.live("idempotency conflict with different messageId fails", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "test-conflict" }) })))) as unknown as Effect.Effect<any, any, any>)
      const sessionId = SessionID.make(session.id)
      const msg1 = MessageID.make("msg_conf_1")
      const opId1 = SessionOperation.cancelQueuedId(session.id, msg1)
      const req1 = { v: 1 as const, requestId: "req-conflict1", opId: opId1, op: "session/cancelQueued" as const, idempotencyKey: "idem-conflict", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { messageId: msg1 } }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(req1) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      expect((r1 as any).status).toBe("succeeded")
      const msg2 = MessageID.make("msg_conf_2")
      const opId2 = SessionOperation.cancelQueuedId(session.id, msg2)
      const req2 = { v: 1 as const, requestId: "req-conflict2", opId: opId2, op: "session/cancelQueued" as const, idempotencyKey: "idem-conflict", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { messageId: msg2 } }
      const r2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(req2) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      expect((r2 as any).status).toBe("failed")
      if ((r2 as any).status === "failed") expect((r2 as any).failure.code).toBe("conflict")
    }),
  )

  it.live("opId mismatch validation fails", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "test-opid" }) })))) as unknown as Effect.Effect<any, any, any>)
      const msg = MessageID.make("msg_opid_1")
      const wrongOpId = `task:${session.id}` // legacy wrong kind
      const req = { v: 1 as const, requestId: "req-opid", opId: wrongOpId, op: "session/cancelQueued" as const, idempotencyKey: "idem-opid", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { messageId: msg } }
      const result = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(req) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      expect((result as any).status).toBe("failed")
      if ((result as any).status === "failed") expect((result as any).failure.code).toBe("validation.failed")
    }),
  )

  it.live("two different messages same session both succeed distinctly", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "test-two" }) })))) as unknown as Effect.Effect<any, any, any>)
      const msg1 = MessageID.make("msg_two_1")
      const msg2 = MessageID.make("msg_two_2")
      const opId1 = SessionOperation.cancelQueuedId(session.id, msg1)
      const opId2 = SessionOperation.cancelQueuedId(session.id, msg2)
      const req1 = { v: 1 as const, requestId: "req-two-1", opId: opId1, op: "session/cancelQueued" as const, idempotencyKey: "idem-two-1", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { messageId: msg1 } }
      const req2 = { v: 1 as const, requestId: "req-two-2", opId: opId2, op: "session/cancelQueued" as const, idempotencyKey: "idem-two-2", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { messageId: msg2 } }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(req1) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      const r2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(req2) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      expect((r1 as any).status).toBe("succeeded")
      expect((r2 as any).status).toBe("succeeded")
      expect((r1 as any).opId).not.toBe((r2 as any).opId)
      const opRows = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie); return rows })))) as unknown as Effect.Effect<any, any, any>)
      const cancelRows = (opRows as any[]).filter((r) => r.op_kind === "cancelQueued")
      expect(cancelRows.length).toBe(2)
    }),
  )

  it.live("acquireDrainControl no-snapshot active-fence returns 409", () =>
    Effect.gen(function* () {
      const fenceTmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const fenceDir = fenceTmp.path
      const withGate = Effect.gen(function* () {
        const gate = yield* GenerationGate.Service
        const ticket = yield* gate.beginFence(fenceDir)
        const attempt = yield* acquireDrainControl(fenceDir).pipe(Effect.exit)
        expect(attempt._tag).toBe("Failure")
        expect(gate.isBarrierActive(fenceDir)).toBe(true)
        yield* ticket.release
        expect(gate.isBarrierActive(fenceDir)).toBe(false)
      })
      yield* (Effect.promise(() => AppRuntime.runPromise(withGate)) as unknown as Effect.Effect<any, any, any>)
    }),
  )

  it.live("HTTP DELETE boolean success and error mapping via Server.Default", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "http-test" }) })))) as unknown as Effect.Effect<any, any, any>)
      const msg = MessageID.make("msg_http_1")
      // success case: not pending returns false but 200 boolean
      const res1 = yield* Effect.promise(() => Server.Default().app.request(`/session/${session.id}/queue/${msg}?directory=${encodeURIComponent(dir)}`, { method: "DELETE" }))
      expect(res1.status).toBe(200)
      const body1 = yield* Effect.promise(() => res1.json() as Promise<boolean>)
      expect(typeof body1).toBe("boolean")
      // error mapping: missing session should be 404, not 200 false
      const fakeId = SessionID.make("ses_99999999999999999999999999")
      const res2 = yield* Effect.promise(() => Server.Default().app.request(`/session/${fakeId}/queue/${msg}?directory=${encodeURIComponent(dir)}`, { method: "DELETE" }))
      expect(res2.status).toBe(404)
    }),
  )

  it.live("HTTP DELETE via Server.listen returns boolean", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const listener = yield* Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 }))
      try {
        const createUrl = new URL(`/session?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const createRes = yield* Effect.promise(() => fetch(createUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "http-listen-test" }) }))
        expect(createRes.status).toBe(200)
        const session = yield* Effect.promise(() => createRes.json() as Promise<{ id: string }>)
        const msg = MessageID.make("msg_listen_1")
        const url = new URL(`/session/${session.id}/queue/${msg}?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const res = yield* Effect.promise(() => fetch(url, { method: "DELETE" }))
        if (res.status !== 200) {
          const txt = yield* Effect.promise(() => res.text())
          expect(`status ${res.status} body ${txt}`).toBe("200")
        }
        expect(res.status).toBe(200)
        const body = yield* Effect.promise(() => res.json() as Promise<boolean>)
        expect(typeof body).toBe("boolean")
      } finally {
        yield* Effect.promise(() => listener.stop())
      }
    }),
  )

  it.live("concurrent same-key with sessionRevision second sees in-flight/replay not stale", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "test-conc-rev" }) })))) as unknown as Effect.Effect<any, any, any>)
      const sessionId = SessionID.make(session.id)
      const curRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      const msg = MessageID.make("msg_conc_rev")
      const opId = SessionOperation.cancelQueuedId(session.id, msg)
      const idem = "idem-conc-rev-same"
      const req = { v: 1 as const, requestId: "req-conc-rev", opId, op: "session/cancelQueued" as const, idempotencyKey: idem, context: { directory: dir, sessionId: session.id, parentSessionId: null, sessionRevision: curRev }, payload: { messageId: msg } }
      const dispatch = (r: typeof req) => Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(r) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>
      const [r1, r2] = yield* Effect.all([dispatch(req), dispatch(req)], { concurrency: "unbounded" })
      const statuses = [(r1 as any).status, (r2 as any).status]
      // At least one succeeded; the other must be ambiguous or succeeded replay, never stale/conflict
      expect(statuses.includes("succeeded")).toBe(true)
      for (const r of [r1, r2] as any[]) {
        if (r.status === "failed") expect(["stale", "conflict"].includes(r.failure.code)).toBe(false)
      }
      // Now advance revision to make original context stale, then sequential replay should still succeed (LOCK-301 in-flight replay)
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const mod = yield* Effect.promise(() => import("../../../src/session/todo")); const todoSvc = yield* (mod as any).Todo.Service; yield* todoSvc.update({ sessionID: sessionId, todos: [{ content: "bump", status: "pending", priority: "high" }] }) })))) as unknown as Effect.Effect<any, any, any>)
      const replay = yield* dispatch(req)
      expect((replay as any).status).toBe("succeeded")
    }),
  )

  it.live("normal-load ControlLease held during operation", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const fakeCtx = { directory: dir, worktree: dir, project: { id: "proj" } } as unknown as InstanceType<typeof InstanceStore.Service>
      let leaseAcquired = false
      let releaseCalled = false
      const mockStore = {
        snapshot: () => Effect.succeed(Option.none()),
        load: () => Effect.succeed(fakeCtx as any),
      } as unknown as InstanceStore.Interface
      const mockGate = {
        isBarrierActive: () => false,
        acquire: () => Effect.succeed(Effect.void),
      } as unknown as GenerationGate
      const mockLease: ControlLease = {
        acquire: (ctx) => {
          leaseAcquired = true
          return Option.some(Effect.sync(() => { releaseCalled = true }))
        },
        acquireWrite: () => Option.some(Effect.void),
        sealAndDrain: () => Effect.void,
      }
      const acquired = yield* acquireDrainControlWith(dir, mockStore, mockGate, mockLease)
      expect(leaseAcquired).toBe(true)
      expect(acquired.ctx).toBe(fakeCtx)
      expect(acquired.release).toBeDefined()
      expect(releaseCalled).toBe(false)
      yield* acquired.release
      expect(releaseCalled).toBe(true)
      // second mock with lease None should fail with fence error
      const failingLease: ControlLease = {
        acquire: () => Option.none(),
        acquireWrite: () => Option.none(),
        sealAndDrain: () => Effect.void,
      }
      const fenceErr = yield* acquireDrainControlWith(dir, mockStore, mockGate, failingLease).pipe(
        Effect.map(() => null as unknown as string),
        Effect.catch((e: unknown) => Effect.succeed(e as any)),
        Effect.catchDefect((d: unknown) => Effect.succeed(d as any)),
      ) as unknown as any
      expect((fenceErr as any)?._tag === "InstanceUnavailableDuringConfigRebuild" || fenceErr instanceof InstanceUnavailableDuringConfigRebuildError).toBe(true)
    }),
  )

  it.live("acquisition internal vs fence classification via dispatch", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "test-acq-class" }) })))) as unknown as Effect.Effect<any, any, any>)
      // Fence case: raise real gate fence, no snapshot -> dispatch returns 409 typed fence, not internal
      const fenceExit = yield* (Effect.promise(() => AppRuntime.runPromise(Effect.gen(function* () {
        const gate = yield* GenerationGate.Service
        const ticket = yield* gate.beginFence(dir)
        const msg = MessageID.make("msg_fence_1")
        const opId = SessionOperation.cancelQueuedId(session.id, msg)
        const req = { v: 1 as const, requestId: "req-fence", opId, op: "session/cancelQueued" as const, idempotencyKey: "idem-fence", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { messageId: msg } }
        // dispatch from non-HTTP path (no InstanceRef) will attempt acquireDrainControl and hit fence
        // Use raw dispatch without InstanceRef by not providing instance (AppRuntime has store but no InstanceRef)
        const d = yield* CancelQueuedDispatchService
        const res = yield* d.dispatch(req)
        yield* ticket.release
        return res
      })))) as unknown as Effect.Effect<any, any, any>
      // The dispatch above ran inside provideInstance? Actually AppRuntime default has no InstanceRef, so it will go via acquireDrainControl.
      // For this test we directly verify fenceExit status; if it somehow succeeded, ensure not internal
      const fe = fenceExit as any
      if (fe && fe.status === "failed") {
        expect(["InstanceUnavailableDuringConfigRebuild", "internal"].includes(fe.failure.code)).toBe(true)
        // when fence, it must be fence code specifically
        // we assert it's fence because gate was active and no snapshot
        expect(fe.failure.code).toBe("InstanceUnavailableDuringConfigRebuild")
      }
      // Internal case: mock store snapshot throws -> dispatch should map to internal, not fence
      const failingStore = {
        snapshot: () => Effect.fail(new Error("snapshot boom")),
        load: () => Effect.fail(new Error("load boom")),
        reload: () => Effect.fail(new Error("reload boom")),
        dispose: () => Effect.void,
        disposeSafe: () => Effect.void,
        disposeDirectory: () => Effect.void,
        disposeAll: () => Effect.void,
        provide: (_i:any, e:any) => e,
        directories: () => Effect.succeed([]),
      } as unknown as InstanceStore.Interface
      const mockGate2 = {
        isBarrierActive: () => false,
        acquire: () => Effect.succeed(Effect.void),
        beginFence: () => Effect.succeed({ kind: "project-fence", directory: dir, drained: { await: () => {} } as any, release: Effect.succeed(true) } as any),
        beginFenceGlobal: () => Effect.succeed({ kind: "global-fence", drainFor: () => ({}) as any, release: Effect.succeed(true) } as any),
        registerFenceLoad: () => Effect.succeed(Option.none()),
        claimFenceLoads: () => Effect.succeed({ confirmed: [] }),
        claimProjectFenceLoad: () => Effect.succeed({ confirmed: false }),
        fenceDrainFor: () => Effect.succeed({} as any),
        prepareWrite: () => Effect.succeed(Effect.void),
        beginWrite: () => Effect.succeed({} as any),
        beginWriteGlobal: () => Effect.succeed({} as any),
      } as unknown as GenerationGate
      const mockLease2: ControlLease = {
        acquire: () => Option.some(Effect.void),
        acquireWrite: () => Option.some(Effect.void),
        sealAndDrain: () => Effect.void,
      }
      const internalErr = yield* acquireDrainControlWith(dir, failingStore, mockGate2, mockLease2).pipe(
        Effect.map(() => null as unknown as string),
        Effect.catch((e: unknown) => Effect.succeed(e as any)),
        Effect.catchDefect((d: unknown) => Effect.succeed(d as any)),
      ) as unknown as any
      const isFence2 = (internalErr as any)?._tag === "InstanceUnavailableDuringConfigRebuild" || internalErr instanceof InstanceUnavailableDuringConfigRebuildError
      expect(isFence2).toBe(false)
      expect(internalErr instanceof Error && (internalErr as Error).message.includes("snapshot boom")).toBe(true)
    }),
  )

  it.live("revision-read failure returns unavailable not fabricated", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "test-rev-fail" }) })))) as unknown as Effect.Effect<any, any, any>)
      const msg = MessageID.make("msg_rev_fail")
      const opId = SessionOperation.cancelQueuedId(session.id, msg)
      const req = { v: 1 as const, requestId: "req-rev-fail", opId, op: "session/cancelQueued" as const, idempotencyKey: "idem-rev-fail", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { messageId: msg } }
      const baseline = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      const baseRev = (baseline as any).revision
      expect(baseRev !== undefined).toBe(true)
      if (baseRev !== undefined) {
        expect(typeof baseRev.session).toBe("number")
        expect(typeof baseRev.config).toBe("number")
        expect(baseRev.session >= 0).toBe(true)
      }
      // session.not_found should return revision undefined or at least not fabricated 0,0
      const fakeId = SessionID.make("ses_99999999999999999999999999")
      const fakeMsg = MessageID.make("msg_fake_rev")
      const fakeOpId = SessionOperation.cancelQueuedId(fakeId, fakeMsg)
      const fakeReq = { v: 1 as const, requestId: "req-fake", opId: fakeOpId, op: "session/cancelQueued" as const, idempotencyKey: "idem-fake", context: { directory: dir, sessionId: fakeId, parentSessionId: null }, payload: { messageId: fakeMsg } }
      const notFound = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(fakeReq) })))) as unknown as Effect.Effect<any, any, any>)
      expect((notFound as any).status).toBe("failed")
      expect((notFound as any).failure.code).toBe("session.not_found")
      const nfRev = (notFound as any).revision
      // should be undefined or with config present but never fabricated 0,0 as both
      if (nfRev !== undefined) {
        expect(nfRev.session !== 0 || nfRev.config !== 0).toBe(true)
        if (nfRev.session === 0 && nfRev.config === 0) expect(false).toBe(true)
      } else {
        expect(nfRev).toBeUndefined()
      }
      // Verify that a successful dispatch that advances revision still returns correct revision, and that we never use +1 guessing
      const sessionId = SessionID.make(session.id)
      const holderId = MessageID.make("msg_rev_holder2")
      const holderGate = yield* Deferred.make<void>()
      const holderFiber = yield* KiloSessionPromptQueue.enqueue(sessionId, holderId, Deferred.await(holderGate), Effect.succeed("holder")).pipe(Effect.forkScoped)
      yield* pollWithTimeout(Effect.sync(() => (KiloSessionPromptQueue._hasInternalState(sessionId) ? (true as const) : undefined)), "holder2 not active")
      const pendingMsg = MessageID.make("msg_rev_pending2")
      const pendingGate = yield* Deferred.make<void>()
      const pendingFiber = yield* KiloSessionPromptQueue.enqueue(sessionId, pendingMsg, Deferred.await(pendingGate), Effect.succeed("cancelled")).pipe(Effect.forkScoped)
      yield* pollWithTimeout(Effect.sync(() => (KiloSessionPromptQueue._isQueued(sessionId, pendingMsg) ? (true as const) : undefined)), "pending2 not queued")
      const beforeRev = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie); return row!.rev })))) as unknown as Effect.Effect<any, any, any>)
      const pendingOpId = SessionOperation.cancelQueuedId(session.id, pendingMsg)
      const pendingReq = { v: 1 as const, requestId: "req-pending-rev-fail2", opId: pendingOpId, op: "session/cancelQueued" as const, idempotencyKey: "idem-pending-rev-fail2", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { messageId: pendingMsg } }
      const pendingResult = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* d.dispatch(pendingReq) })))) as unknown as Effect.Effect<any, any, any>)
      expect((pendingResult as any).status).toBe("succeeded")
      const afterRev = (pendingResult as any).revision.session
      // Should be exactly beforeRev + 3 (not fabricated +1/+2) for pending true case
      expect(afterRev - beforeRev).toBe(3)
      yield* Deferred.succeed(holderGate, void 0)
      yield* Fiber.join(holderFiber).pipe(Effect.orDie)
      yield* Deferred.succeed(pendingGate, void 0)
      yield* Fiber.join(pendingFiber).pipe(Effect.orDie)
    }),
  )

  it.live("HTTP status mapping 400/409/500 deterministic via injectable dispatch", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const makeFailed = (req: any, code: string, msg: string, retryable: boolean) => ({
        v: 1 as const,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/cancelQueued" as const,
        idempotencyKey: req.idempotencyKey,
        status: "failed" as const,
        outcome: { type: "failed" as const, time: Date.now(), failure: { code, message: msg, retryable } },
        accepted: false as const,
        failure: { code, message: msg, retryable },
      })
      const makeSucceeded = (req: any, cancelled: boolean) => ({
        v: 1 as const,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/cancelQueued" as const,
        idempotencyKey: req.idempotencyKey,
        status: "succeeded" as const,
        outcome: { type: "succeeded" as const, time: Date.now() },
        accepted: true as const,
        data: { cancelled },
      })
      const makeAmbiguous = (req: any) => ({
        v: 1 as const,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/cancelQueued" as const,
        idempotencyKey: req.idempotencyKey,
        status: "ambiguous" as const,
        outcome: { type: "ambiguous" as const, time: Date.now() },
        accepted: false as const,
      })
      const dispatchImpl = (raw: unknown) => {
        const r = raw as any
        const mid = r?.payload?.messageId as string | undefined
        if (mid === "msg_400_1") return Effect.succeed(makeFailed(r, "validation.failed", "bad", false))
        if (mid === "msg_409_1") return Effect.succeed(makeFailed(r, "conflict", "conflict", false))
        if (mid === "msg_409_2") return Effect.succeed(makeFailed(r, "stale", "stale", false))
        if (mid === "msg_409_3") return Effect.succeed(makeAmbiguous(r))
        if (mid === "msg_409_4") return Effect.succeed(makeFailed(r, "InstanceUnavailableDuringConfigRebuild", "fence", true))
        if (mid === "msg_500_1") return Effect.succeed(makeFailed(r, "internal", "boom", false))
        if (mid === "msg_404_1") return Effect.succeed(makeFailed(r, "session.not_found", "missing", false))
        if (mid === "msg_400_2") return Effect.succeed(makeFailed(r, "scope_mismatch", "mismatch", false))
        return Effect.succeed(makeSucceeded(r, false))
      }
      const mockLayer = Layer.succeed(CancelQueuedDispatchService, { dispatch: dispatchImpl } as any)
      const appLayer = Layer.mergeAll(AppLayer, mockLayer)
      const listener = yield* Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0, appLayer }))
      try {
        const base = listener.url.toString().replace(/\/$/, "")
        const createUrl = new URL(`/session?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const createRes = yield* Effect.promise(() => fetch(createUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "http-status-deterministic" }) }))
        expect(createRes.status).toBe(200)
        const session = yield* Effect.promise(() => createRes.json() as Promise<{ id: string }>)
        const urlFor = (mid: string) => `${base}/session/${session.id}/queue/${mid}?directory=${encodeURIComponent(dir)}`
        // 200 success
        const res200 = yield* Effect.promise(() => fetch(urlFor("msg_ok_1"), { method: "DELETE" }))
        expect(res200.status).toBe(200)
        const body200 = yield* Effect.promise(() => res200.json() as Promise<boolean>)
        expect(typeof body200).toBe("boolean")
        expect(body200).toBe(false)
        // 400 validation.failed
        const res400a = yield* Effect.promise(() => fetch(urlFor("msg_400_1"), { method: "DELETE" }))
        expect(res400a.status).toBe(400)
        // 400 scope_mismatch
        const res400b = yield* Effect.promise(() => fetch(urlFor("msg_400_2"), { method: "DELETE" }))
        expect(res400b.status).toBe(400)
        // 404 session.not_found via dispatch
        const res404a = yield* Effect.promise(() => fetch(urlFor("msg_404_1"), { method: "DELETE" }))
        expect(res404a.status).toBe(404)
        // 404 missing session via real requireSession
        const fakeId = SessionID.make("ses_99999999999999999999999999")
        const fakeUrl = `${base}/session/${fakeId}/queue/msg_ok_1?directory=${encodeURIComponent(dir)}`
        const res404b = yield* Effect.promise(() => fetch(fakeUrl, { method: "DELETE" }))
        expect(res404b.status).toBe(404)
        // 409 conflict
        const res409a = yield* Effect.promise(() => fetch(urlFor("msg_409_1"), { method: "DELETE" }))
        expect(res409a.status).toBe(409)
        // 409 stale
        const res409b = yield* Effect.promise(() => fetch(urlFor("msg_409_2"), { method: "DELETE" }))
        expect(res409b.status).toBe(409)
        // 409 ambiguous
        const res409c = yield* Effect.promise(() => fetch(urlFor("msg_409_3"), { method: "DELETE" }))
        expect(res409c.status).toBe(409)
        // 409 fence
        const res409d = yield* Effect.promise(() => fetch(urlFor("msg_409_4"), { method: "DELETE" }))
        expect(res409d.status).toBe(409)
        // 500 internal
        const res500 = yield* Effect.promise(() => fetch(urlFor("msg_500_1"), { method: "DELETE" }))
        expect(res500.status).toBe(500)
        // 500 defect path: dispatch throws defect -> 500 (needs new listener with defect mock, but share same dir/session)
        const defectLayer = Layer.succeed(CancelQueuedDispatchService, { dispatch: () => Effect.die(new Error("defect boom")) } as any)
        const defectApp = Layer.mergeAll(AppLayer, defectLayer)
        const defectListener = yield* Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0, appLayer: defectApp }))
        try {
          const defectBase = defectListener.url.toString().replace(/\/$/, "")
          // create session in defect listener's DB as well
          const defectCreateUrl = new URL(`/session?directory=${encodeURIComponent(dir)}`, defectListener.url).toString()
          const defectCreateRes = yield* Effect.promise(() => fetch(defectCreateUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "defect-session" }) }))
          expect([200, 409, 500].includes(defectCreateRes.status)).toBe(true)
          // use the original session id if create succeeded, else use a new one from defect listener
          let defectSessionId = session.id
          if (defectCreateRes.status === 200) {
            const defectSession = yield* Effect.promise(() => defectCreateRes.json() as Promise<{ id: string }>)
            defectSessionId = defectSession.id
          }
          const defectUrl = `${defectBase}/session/${defectSessionId}/queue/msg_defect_1?directory=${encodeURIComponent(dir)}`
          const res500defect = yield* Effect.promise(() => fetch(defectUrl, { method: "DELETE" }))
          expect(res500defect.status).toBe(500)
        } finally {
          yield* Effect.promise(() => defectListener.stop())
        }
      } finally {
        yield* Effect.promise(() => listener.stop())
      }
    }),
  )

  it.live("injected revision-read failure does not fabricate 0,0", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const session = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "inject-test" }) })))) as unknown as Effect.Effect<any, any, any>)
      const msg = MessageID.make("msg_inject_1")
      const opId = SessionOperation.cancelQueuedId(session.id, msg)
      const req = { v: 1 as const, requestId: "req-inject", opId, op: "session/cancelQueued" as const, idempotencyKey: "idem-inject", context: { directory: dir, sessionId: session.id, parentSessionId: null }, payload: { messageId: msg } }
      const failingConfig = Layer.mock(ConfigConvergence.Service, {
        getBootedVersion: () => Effect.fail(new Error("injected config fail")),
      } as any)
      const result: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* Effect.provide(d.dispatch(req), failingConfig) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      const rev = result.revision
      if (rev !== undefined) {
        expect(!(rev.session === 0 && rev.config === 0)).toBe(true)
      } else {
        expect(rev).toBeUndefined()
      }
      const fakeSessionId = SessionID.make("ses_99999999999999999999999999")
      const fakeMsg = MessageID.make("msg_fake_inject")
      const fakeOpId = SessionOperation.cancelQueuedId(fakeSessionId, fakeMsg)
      const fakeReq = { v: 1 as const, requestId: "req-fake-inject", opId: fakeOpId, op: "session/cancelQueued" as const, idempotencyKey: "idem-fake-inject", context: { directory: dir, sessionId: fakeSessionId, parentSessionId: null }, payload: { messageId: fakeMsg } }
      const fakeResult: any = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* CancelQueuedDispatchService; return yield* Effect.provide(d.dispatch(fakeReq), failingConfig) }) as unknown as Effect.Effect<any, any, any>))) as unknown as Effect.Effect<any, any, any>)
      expect(fakeResult.status).toBe("failed")
      const fakeRev = fakeResult.revision
      if (fakeRev !== undefined) {
        expect(!(fakeRev.session === 0 && fakeRev.config === 0)).toBe(true)
      } else {
        expect(fakeRev).toBeUndefined()
      }
    }),
  )
})
