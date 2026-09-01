// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Stream, Fiber, Deferred, Scope, ManagedRuntime } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "../../../src/session/session"
import { SessionID } from "../../../src/session/schema"
import { SessionUpdateDispatchService } from "../../../src/kilocode/session/session-update-dispatch"
import * as SessionUpdateDispatch from "../../../src/kilocode/session/session-update-dispatch"
import { GlobalBus } from "../../../src/bus/global"
import { testEffect, pollWithTimeout } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { ConfigConvergence } from "../../../src/kilocode/server/config-convergence"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import * as Log from "@opencode-ai/core/util/log"
import { InstanceRef, WorkspaceRef } from "../../../src/effect/instance-ref"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import * as path from "path"
import * as fs from "fs/promises"

void Log.init({ print: false })

const it = testEffect(Layer.empty)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("sessionUpdate B2 eventV2 atomic propagation", () => {
  it.live(
    "first durable update: revision +1, feed +1, operation +1, EventSequence +1, EventTable +1, emitted seq >0",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<
          any,
          any,
          any
        >
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
        ) as unknown as Effect.Effect<any, any, any>
        const beforeRev = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db
                  .select({ rev: SessionTable.revision })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, session.id))
                  .get()
                  .pipe(Effect.orDie)
                return row!.rev
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const beforeFeed = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db
                  .select()
                  .from(SessionChangefeedTable)
                  .where(eq(SessionChangefeedTable.session_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const beforeOp = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
                const rows = yield* db
                  .select()
                  .from(SessionOperationTable)
                  .where(eq(SessionOperationTable.session_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return (rows as any[]).filter((r) => r.op_kind === "sessionUpdate").length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const beforeSeqRow = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db
                  .select()
                  .from(EventSequenceTable)
                  .where(eq(EventSequenceTable.aggregate_id, session.id))
                  .get()
                  .pipe(Effect.orDie)
                return row
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const beforeSeq = beforeSeqRow?.seq ?? -1
        const beforeEvents = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db
                  .select()
                  .from(EventTable)
                  .where(eq(EventTable.aggregate_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>

        const captured: any[] = []
        const handler = (ev: any) => {
          if (ev.payload?.type === "sync" && ev.payload?.syncEvent?.type === "session.updated.1")
            captured.push(ev.payload.syncEvent)
        }
        GlobalBus.on("event", handler)
        try {
          const opId = SessionOperation.sessionUpdateId(session.id, "ev1-" + Math.random().toString(36).slice(2, 6))
          const req = {
            v: 1 as const,
            requestId: "req-ev1",
            opId,
            op: "session/update" as const,
            idempotencyKey: `idem-ev1-${Math.random().toString(36).slice(2, 6)}`,
            context: { directory: dir, sessionId: session.id, parentSessionId: null },
            payload: { title: "new title ev1" },
          }
          const result = yield* Effect.promise(() =>
            AppRuntime.runPromise(
              provideInstance(dir)(
                Effect.gen(function* () {
                  const d = yield* SessionUpdateDispatchService
                  return yield* d.dispatch(req)
                }),
              ),
            ),
          ) as unknown as Effect.Effect<any, any, any>
          expect(result.status).toBe("succeeded")
          expect(captured.length).toBe(1)
          expect(captured[0].seq).toBeGreaterThan(0)
          // seq must be > beforeSeq and monotonic
          expect(captured[0].seq).toBe(beforeSeq + 1)

          const afterRev = yield* Effect.promise(() =>
            AppRuntime.runPromise(
              provideInstance(dir)(
                Effect.gen(function* () {
                  const db = (yield* Database.Service).db
                  const row = yield* db
                    .select({ rev: SessionTable.revision })
                    .from(SessionTable)
                    .where(eq(SessionTable.id, session.id))
                    .get()
                    .pipe(Effect.orDie)
                  return row!.rev
                }),
              ),
            ),
          ) as unknown as Effect.Effect<any, any, any>
          expect(afterRev - beforeRev).toBe(1)
          const afterFeed = yield* Effect.promise(() =>
            AppRuntime.runPromise(
              provideInstance(dir)(
                Effect.gen(function* () {
                  const db = (yield* Database.Service).db
                  const rows = yield* db
                    .select()
                    .from(SessionChangefeedTable)
                    .where(eq(SessionChangefeedTable.session_id, session.id))
                    .all()
                    .pipe(Effect.orDie)
                  return rows.length
                }),
              ),
            ),
          ) as unknown as Effect.Effect<any, any, any>
          expect(afterFeed - beforeFeed).toBe(1)
          const afterOp = yield* Effect.promise(() =>
            AppRuntime.runPromise(
              provideInstance(dir)(
                Effect.gen(function* () {
                  const db = (yield* Database.Service).db
                  const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
                  const rows = yield* db
                    .select()
                    .from(SessionOperationTable)
                    .where(eq(SessionOperationTable.session_id, session.id))
                    .all()
                    .pipe(Effect.orDie)
                  return (rows as any[]).filter((r) => r.op_kind === "sessionUpdate").length
                }),
              ),
            ),
          ) as unknown as Effect.Effect<any, any, any>
          expect(afterOp - beforeOp).toBe(1)
          const afterSeqRow = yield* Effect.promise(() =>
            AppRuntime.runPromise(
              provideInstance(dir)(
                Effect.gen(function* () {
                  const db = (yield* Database.Service).db
                  const row = yield* db
                    .select()
                    .from(EventSequenceTable)
                    .where(eq(EventSequenceTable.aggregate_id, session.id))
                    .get()
                    .pipe(Effect.orDie)
                  return row
                }),
              ),
            ),
          ) as unknown as Effect.Effect<any, any, any>
          expect(afterSeqRow.seq - beforeSeq).toBe(1)
          const afterEvents = yield* Effect.promise(() =>
            AppRuntime.runPromise(
              provideInstance(dir)(
                Effect.gen(function* () {
                  const db = (yield* Database.Service).db
                  const rows = yield* db
                    .select()
                    .from(EventTable)
                    .where(eq(EventTable.aggregate_id, session.id))
                    .all()
                    .pipe(Effect.orDie)
                  return rows.length
                }),
              ),
            ),
          ) as unknown as Effect.Effect<any, any, any>
          expect(afterEvents - beforeEvents).toBe(1)
          // verify EventTable row seq matches emitted seq and type versioned
          const evtRow = yield* Effect.promise(() =>
            AppRuntime.runPromise(
              provideInstance(dir)(
                Effect.gen(function* () {
                  const db = (yield* Database.Service).db
                  const row = yield* db
                    .select()
                    .from(EventTable)
                    .where(eq(EventTable.aggregate_id, session.id))
                    .all()
                    .pipe(Effect.orDie)
                  return (row as any[]).find((r) => r.seq === captured[0].seq)
                }),
              ),
            ),
          ) as unknown as Effect.Effect<any, any, any>
          expect(evtRow).toBeDefined()
          expect(evtRow.type).toBe("session.updated.1")
        } finally {
          GlobalBus.off("event", handler)
        }
      }),
  )

  it.live("two distinct sequential updates: event seq strictly increases with no collision", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<
        any,
        any,
        any
      >
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
      ) as unknown as Effect.Effect<any, any, any>
      const captured: any[] = []
      const handler = (ev: any) => {
        if (ev.payload?.type === "sync" && ev.payload?.syncEvent?.type === "session.updated.1")
          captured.push(ev.payload.syncEvent)
      }
      GlobalBus.on("event", handler)
      try {
        const token1 = "tokA-" + Math.random().toString(36).slice(2, 6)
        const token2 = "tokB-" + Math.random().toString(36).slice(2, 6)
        const opId1 = SessionOperation.sessionUpdateId(session.id, token1)
        const opId2 = SessionOperation.sessionUpdateId(session.id, token2)
        const req1 = {
          v: 1 as const,
          requestId: "req-seq1",
          opId: opId1,
          op: "session/update" as const,
          idempotencyKey: `sessionUpdate:${session.id}:${token1}`,
          context: { directory: dir, sessionId: session.id, parentSessionId: null },
          payload: { title: "first seq" },
        }
        const req2 = {
          v: 1 as const,
          requestId: "req-seq2",
          opId: opId2,
          op: "session/update" as const,
          idempotencyKey: `sessionUpdate:${session.id}:${token2}`,
          context: { directory: dir, sessionId: session.id, parentSessionId: null },
          payload: { title: "second seq" },
        }
        const r1 = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req1)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(r1.status).toBe("succeeded")
        const r2 = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req2)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(r2.status).toBe("succeeded")
        expect(captured.length).toBe(2)
        expect(captured[1].seq).toBeGreaterThan(captured[0].seq)
        expect(captured[1].seq - captured[0].seq).toBe(1)
        // verify both rows in EventTable with distinct seq
        const rows = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rs = yield* db
                  .select()
                  .from(EventTable)
                  .where(eq(EventTable.aggregate_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return rs as any[]
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const seqs = rows
          .filter((r: any) => r.type === "session.updated.1")
          .map((r: any) => r.seq)
          .sort((a: number, b: number) => a - b)
        expect(seqs).toEqual([captured[0].seq, captured[1].seq])
        // also check revision incremented twice
        const rev = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db
                  .select({ rev: SessionTable.revision })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, session.id))
                  .get()
                  .pipe(Effect.orDie)
                return row!.rev
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        // initial revision is 0, after two updates should be 2
        expect(rev).toBe(2)
      } finally {
        GlobalBus.off("event", handler)
      }
    }),
  )

  it.live("same-key replay: no growth and no second notification", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<
        any,
        any,
        any
      >
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
      ) as unknown as Effect.Effect<any, any, any>
      const opId = SessionOperation.sessionUpdateId(session.id, "replay-" + Math.random().toString(36).slice(2, 6))
      const idem = `idem-replay-${Math.random().toString(36).slice(2, 6)}`
      const req = {
        v: 1 as const,
        requestId: "req-replay-ev",
        opId,
        op: "session/update" as const,
        idempotencyKey: idem,
        context: { directory: dir, sessionId: session.id, parentSessionId: null },
        payload: { title: "first replay" },
      }
      const captured: any[] = []
      const handler = (ev: any) => {
        if (ev.payload?.type === "sync" && ev.payload?.syncEvent?.type === "session.updated.1")
          captured.push(ev.payload.syncEvent)
      }
      GlobalBus.on("event", handler)
      try {
        const r1 = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(r1.status).toBe("succeeded")
        expect(captured.length).toBe(1)
        const beforeRev = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db
                  .select({ rev: SessionTable.revision })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, session.id))
                  .get()
                  .pipe(Effect.orDie)
                return row!.rev
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const beforeFeed = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db
                  .select()
                  .from(SessionChangefeedTable)
                  .where(eq(SessionChangefeedTable.session_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const beforeOp = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
                const rows = yield* db
                  .select()
                  .from(SessionOperationTable)
                  .where(eq(SessionOperationTable.session_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return (rows as any[]).filter((r) => r.op_kind === "sessionUpdate").length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const beforeSeqRow = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db
                  .select()
                  .from(EventSequenceTable)
                  .where(eq(EventSequenceTable.aggregate_id, session.id))
                  .get()
                  .pipe(Effect.orDie)
                return row
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const beforeSeq = beforeSeqRow?.seq
        const beforeEvents = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db
                  .select()
                  .from(EventTable)
                  .where(eq(EventTable.aggregate_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const r2 = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(r2.status).toBe("succeeded")
        expect(captured.length).toBe(1) // no second notification
        const afterRev = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db
                  .select({ rev: SessionTable.revision })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, session.id))
                  .get()
                  .pipe(Effect.orDie)
                return row!.rev
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterRev).toBe(beforeRev)
        const afterFeed = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db
                  .select()
                  .from(SessionChangefeedTable)
                  .where(eq(SessionChangefeedTable.session_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterFeed).toBe(beforeFeed)
        const afterOp = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
                const rows = yield* db
                  .select()
                  .from(SessionOperationTable)
                  .where(eq(SessionOperationTable.session_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return (rows as any[]).filter((r) => r.op_kind === "sessionUpdate").length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterOp).toBe(beforeOp)
        const afterSeqRow = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db
                  .select()
                  .from(EventSequenceTable)
                  .where(eq(EventSequenceTable.aggregate_id, session.id))
                  .get()
                  .pipe(Effect.orDie)
                return row
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterSeqRow.seq).toBe(beforeSeq)
        const afterEvents = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db
                  .select()
                  .from(EventTable)
                  .where(eq(EventTable.aggregate_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterEvents).toBe(beforeEvents)
      } finally {
        GlobalBus.off("event", handler)
      }
    }),
  )

  it.live("prior generation title event followed by durable update: durable seq greater and passes dedup", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<
        any,
        any,
        any
      >
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
      ) as unknown as Effect.Effect<any, any, any>
      // prior generation via normal EventV2 publish (session.update via SessionV1.Event.Updated)
      const priorInfo = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, session.id))
                .get()
                .pipe(Effect.orDie)
              const info = Session.fromRow(row as any) as unknown as Session.Info
              return { ...info, title: "prior gen title" }
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const priorSeq = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const events = yield* EventV2.Service
              const ev = yield* events.publish(SessionV1.Event.Updated, { sessionID: session.id, info: priorInfo })
              return ev.seq
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      expect(priorSeq).toBeDefined()
      const beforeDurableSeqRow = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db
                .select()
                .from(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, session.id))
                .get()
                .pipe(Effect.orDie)
              return row
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeDurableSeq = beforeDurableSeqRow?.seq
      expect(beforeDurableSeq).toBe(priorSeq)
      const captured: any[] = []
      const handler = (ev: any) => {
        if (ev.payload?.type === "sync" && ev.payload?.syncEvent?.type === "session.updated.1")
          captured.push(ev.payload.syncEvent)
      }
      GlobalBus.on("event", handler)
      try {
        const opId = SessionOperation.sessionUpdateId(session.id, "prior-dur-" + Math.random().toString(36).slice(2, 6))
        const req = {
          v: 1 as const,
          requestId: "req-prior-dur",
          opId,
          op: "session/update" as const,
          idempotencyKey: `idem-prior-dur-${Math.random().toString(36).slice(2, 6)}`,
          context: { directory: dir, sessionId: session.id, parentSessionId: null },
          payload: { title: "durable after prior" },
        }
        const res = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(res.status).toBe("succeeded")
        expect(captured.length).toBe(1)
        const durableSeq = captured[0].seq
        expect(durableSeq).toBeGreaterThan(priorSeq)
        // simulate KiloProvider dedup: revision after prior is priorSeq, durable should not be dropped
        const versioned = durableSeq > 0 || (priorSeq ?? 0) > 0
        const isDropped = versioned ? durableSeq <= priorSeq : false
        expect(isDropped).toBe(false)
      } finally {
        GlobalBus.off("event", handler)
      }
    }),
  )

  it.live("future normal EventV2 after durable gets greater seq", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<
        any,
        any,
        any
      >
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
      ) as unknown as Effect.Effect<any, any, any>
      const captured: any[] = []
      const handler = (ev: any) => {
        if (ev.payload?.type === "sync" && ev.payload?.syncEvent?.type === "session.updated.1")
          captured.push(ev.payload.syncEvent)
      }
      GlobalBus.on("event", handler)
      try {
        const opId = SessionOperation.sessionUpdateId(
          session.id,
          "future-pre-" + Math.random().toString(36).slice(2, 6),
        )
        const req = {
          v: 1 as const,
          requestId: "req-future-pre",
          opId,
          op: "session/update" as const,
          idempotencyKey: `idem-future-pre-${Math.random().toString(36).slice(2, 6)}`,
          context: { directory: dir, sessionId: session.id, parentSessionId: null },
          payload: { title: "durable first" },
        }
        const r = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(r.status).toBe("succeeded")
        expect(captured.length).toBe(1)
        const durableSeq = captured[0].seq
        // now publish normal EventV2 session.updated after durable
        const infoAfter = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db
                  .select()
                  .from(SessionTable)
                  .where(eq(SessionTable.id, session.id))
                  .get()
                  .pipe(Effect.orDie)
                return Session.fromRow(row as any) as unknown as Session.Info
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const nextInfo = { ...infoAfter, title: "future normal" }
        const futureEv = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const events = yield* EventV2.Service
                const ev = yield* events.publish(SessionV1.Event.Updated, { sessionID: session.id, info: nextInfo })
                return ev
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(futureEv.seq).toBeGreaterThan(durableSeq)
        // also check second sync event captured via GlobalBus (bridge) for future publish
        // futureEv's GlobalBus sync should have been captured as second entry if handler still on
        // but future publish goes through same bridge, so captured length should be 2
        expect(captured.length).toBe(2)
        expect(captured[1].seq).toBe(futureEv.seq)
        expect(captured[1].seq).toBeGreaterThan(captured[0].seq)
      } finally {
        GlobalBus.off("event", handler)
      }
    }),
  )

  it.live("rollback/conflict does not leave event row/sequence or notification", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<
        any,
        any,
        any
      >
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
      ) as unknown as Effect.Effect<any, any, any>
      // first successful to have baseline seq
      const opIdOk = SessionOperation.sessionUpdateId(session.id, "ok-" + Math.random().toString(36).slice(2, 6))
      const reqOk = {
        v: 1 as const,
        requestId: "req-ok",
        opId: opIdOk,
        op: "session/update" as const,
        idempotencyKey: `idem-ok-${Math.random().toString(36).slice(2, 6)}`,
        context: { directory: dir, sessionId: session.id, parentSessionId: null },
        payload: { title: "ok title" },
      }
      const captured: any[] = []
      const handler = (ev: any) => {
        if (ev.payload?.type === "sync" && ev.payload?.syncEvent?.type === "session.updated.1")
          captured.push(ev.payload.syncEvent)
      }
      GlobalBus.on("event", handler)
      try {
        const rOk = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(reqOk)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(rOk.status).toBe("succeeded")
        expect(captured.length).toBe(1)
        const beforeSeqRow = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db
                  .select()
                  .from(EventSequenceTable)
                  .where(eq(EventSequenceTable.aggregate_id, session.id))
                  .get()
                  .pipe(Effect.orDie)
                return row
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const beforeSeq = beforeSeqRow.seq
        const beforeEvents = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db
                  .select()
                  .from(EventTable)
                  .where(eq(EventTable.aggregate_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        // conflict: same idempotencyKey different title
        const reqConflict = {
          v: 1 as const,
          requestId: "req-conf-ev",
          opId: opIdOk,
          op: "session/update" as const,
          idempotencyKey: reqOk.idempotencyKey,
          context: { directory: dir, sessionId: session.id, parentSessionId: null },
          payload: { title: "different title conflict" },
        }
        const rConf = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(reqConflict)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(rConf.status).toBe("failed")
        expect((rConf as any).failure.code).toBe("conflict")
        expect(captured.length).toBe(1) // no second notification
        const afterSeqRow = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db
                  .select()
                  .from(EventSequenceTable)
                  .where(eq(EventSequenceTable.aggregate_id, session.id))
                  .get()
                  .pipe(Effect.orDie)
                return row
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterSeqRow.seq).toBe(beforeSeq)
        const afterEvents = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db
                  .select()
                  .from(EventTable)
                  .where(eq(EventTable.aggregate_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterEvents).toBe(beforeEvents)
        // stale failure: try stale sessionRevision
        const curRev = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db
                  .select({ rev: SessionTable.revision })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, session.id))
                  .get()
                  .pipe(Effect.orDie)
                return row!.rev
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const opIdStale = SessionOperation.sessionUpdateId(
          session.id,
          "stale-" + Math.random().toString(36).slice(2, 6),
        )
        const reqStale = {
          v: 1 as const,
          requestId: "req-stale-ev",
          opId: opIdStale,
          op: "session/update" as const,
          idempotencyKey: `idem-stale-${Math.random().toString(36).slice(2, 6)}`,
          context: { directory: dir, sessionId: session.id, parentSessionId: null, sessionRevision: curRev - 1 },
          payload: { title: "stale attempt" },
        }
        const rStale = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(reqStale)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(rStale.status).toBe("failed")
        expect((rStale as any).failure.code).toBe("stale")
        expect(captured.length).toBe(1)
        const afterStaleSeqRow = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db
                  .select()
                  .from(EventSequenceTable)
                  .where(eq(EventSequenceTable.aggregate_id, session.id))
                  .get()
                  .pipe(Effect.orDie)
                return row
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterStaleSeqRow.seq).toBe(beforeSeq)
        const afterStaleEvents = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db
                  .select()
                  .from(EventTable)
                  .where(eq(EventTable.aggregate_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterStaleEvents).toBe(beforeEvents)
      } finally {
        GlobalBus.off("event", handler)
      }
    }),
  )

  it.live("concurrent distinct session/updates allocate contiguous seqs and one notification per operation", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<
        any,
        any,
        any
      >
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
      ) as unknown as Effect.Effect<any, any, any>
      const beforeRev = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db
                .select({ rev: SessionTable.revision })
                .from(SessionTable)
                .where(eq(SessionTable.id, session.id))
                .get()
                .pipe(Effect.orDie)
              return row!.rev
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeFeed = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionChangefeedTable)
                .where(eq(SessionChangefeedTable.session_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeOp = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
              const rows = yield* db
                .select()
                .from(SessionOperationTable)
                .where(eq(SessionOperationTable.session_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return (rows as any[]).filter((r) => r.op_kind === "sessionUpdate").length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeSeqRow = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db
                .select()
                .from(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, session.id))
                .get()
                .pipe(Effect.orDie)
              return row
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeSeq = beforeSeqRow?.seq ?? -1
      const beforeEvents = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(EventTable)
                .where(eq(EventTable.aggregate_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const captured: any[] = []
      const handler = (ev: any) => {
        if (ev.payload?.type === "sync" && ev.payload?.syncEvent?.type === "session.updated.1")
          captured.push(ev.payload.syncEvent)
      }
      GlobalBus.on("event", handler)
      try {
        const token1 = "concA-" + Math.random().toString(36).slice(2, 6)
        const token2 = "concB-" + Math.random().toString(36).slice(2, 6)
        const opId1 = SessionOperation.sessionUpdateId(session.id, token1)
        const opId2 = SessionOperation.sessionUpdateId(session.id, token2)
        const req1 = {
          v: 1 as const,
          requestId: "req-conc1",
          opId: opId1,
          op: "session/update" as const,
          idempotencyKey: `sessionUpdate:${session.id}:${token1}`,
          context: { directory: dir, sessionId: session.id, parentSessionId: null },
          payload: { title: "concurrent first" },
        }
        const req2 = {
          v: 1 as const,
          requestId: "req-conc2",
          opId: opId2,
          op: "session/update" as const,
          idempotencyKey: `sessionUpdate:${session.id}:${token2}`,
          context: { directory: dir, sessionId: session.id, parentSessionId: null },
          payload: { title: "concurrent second" },
        }
        const dispatch = (req: unknown) =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req)
              }),
            ),
          )
        const [r1, r2] = yield* Effect.promise(() =>
          Promise.all([dispatch(req1), dispatch(req2)]),
        ) as unknown as Effect.Effect<any, any, any>
        expect(r1.status).toBe("succeeded")
        expect(r2.status).toBe("succeeded")
        expect(captured.length).toBe(2)
        const seqs = captured.map((c: any) => c.seq).sort((a: number, b: number) => a - b)
        expect(new Set(seqs).size).toBe(2)
        expect(seqs[1] - seqs[0]).toBe(1)
        expect(seqs).toEqual([beforeSeq + 1, beforeSeq + 2])
        const afterRev = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db
                  .select({ rev: SessionTable.revision })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, session.id))
                  .get()
                  .pipe(Effect.orDie)
                return row!.rev
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterRev - beforeRev).toBe(2)
        const afterFeed = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db
                  .select()
                  .from(SessionChangefeedTable)
                  .where(eq(SessionChangefeedTable.session_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterFeed - beforeFeed).toBe(2)
        const afterOp = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
                const rows = yield* db
                  .select()
                  .from(SessionOperationTable)
                  .where(eq(SessionOperationTable.session_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return (rows as any[]).filter((r) => r.op_kind === "sessionUpdate").length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterOp - beforeOp).toBe(2)
        const afterSeqRow = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db
                  .select()
                  .from(EventSequenceTable)
                  .where(eq(EventSequenceTable.aggregate_id, session.id))
                  .get()
                  .pipe(Effect.orDie)
                return row
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterSeqRow.seq - beforeSeq).toBe(2)
        const afterEvents = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db
                  .select()
                  .from(EventTable)
                  .where(eq(EventTable.aggregate_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterEvents - beforeEvents).toBe(2)
        const rows = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rs = yield* db
                  .select()
                  .from(EventTable)
                  .where(eq(EventTable.aggregate_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return rs as any[]
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const eventSeqs = rows
          .filter((r: any) => r.type === "session.updated.1")
          .map((r: any) => r.seq)
          .sort((a: number, b: number) => a - b)
        expect(eventSeqs.slice(-2)).toEqual(seqs)
      } finally {
        GlobalBus.off("event", handler)
      }
    }),
  )

  it.live("fault-injection after mutation start rolls back all five surfaces and emits zero notification", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<
        any,
        any,
        any
      >
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
      ) as unknown as Effect.Effect<any, any, any>
      const beforeInfo = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db
                .select({ rev: SessionTable.revision, title: SessionTable.title })
                .from(SessionTable)
                .where(eq(SessionTable.id, session.id))
                .get()
                .pipe(Effect.orDie)
              return row!
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeFeed = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(SessionChangefeedTable)
                .where(eq(SessionChangefeedTable.session_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeOp = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
              const rows = yield* db
                .select()
                .from(SessionOperationTable)
                .where(eq(SessionOperationTable.session_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return (rows as any[]).filter((r) => r.op_kind === "sessionUpdate").length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeSeqRow = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db
                .select()
                .from(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, session.id))
                .get()
                .pipe(Effect.orDie)
              return row
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeSeq = beforeSeqRow?.seq ?? -1
      const beforeEvents = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db
                .select()
                .from(EventTable)
                .where(eq(EventTable.aggregate_id, session.id))
                .all()
                .pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const targetTitle = "trigger-rollback-" + Math.random().toString(36).slice(2, 6)
      let guardArmed = true
      yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const events = yield* EventV2.Service
              yield* events.beforeCommit((event) => {
                if (!guardArmed) return Effect.void
                const data = event.data as unknown as { info?: { title?: string } }
                if (event.type === SessionV1.Event.Updated.type && data?.info?.title === targetTitle) {
                  return Effect.die(new Error("injected EventV2 commit guard failure"))
                }
                return Effect.void
              })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const captured: any[] = []
      const handler = (ev: any) => {
        if (ev.payload?.type === "sync" && ev.payload?.syncEvent?.type === "session.updated.1")
          captured.push(ev.payload.syncEvent)
      }
      GlobalBus.on("event", handler)
      try {
        const opId = SessionOperation.sessionUpdateId(session.id, "rollback-" + Math.random().toString(36).slice(2, 6))
        const req = {
          v: 1 as const,
          requestId: "req-rollback",
          opId,
          op: "session/update" as const,
          idempotencyKey: `idem-rollback-${Math.random().toString(36).slice(2, 6)}`,
          context: { directory: dir, sessionId: session.id, parentSessionId: null },
          payload: { title: targetTitle },
        }
        const result = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(result.status).toBe("failed")
        const afterInfo = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db
                  .select({ rev: SessionTable.revision, title: SessionTable.title })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, session.id))
                  .get()
                  .pipe(Effect.orDie)
                return row!
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterInfo.rev).toBe(beforeInfo.rev)
        expect(afterInfo.title).toBe(beforeInfo.title)
        const afterFeed = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db
                  .select()
                  .from(SessionChangefeedTable)
                  .where(eq(SessionChangefeedTable.session_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterFeed).toBe(beforeFeed)
        const afterOp = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
                const rows = yield* db
                  .select()
                  .from(SessionOperationTable)
                  .where(eq(SessionOperationTable.session_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return (rows as any[]).filter((r) => r.op_kind === "sessionUpdate").length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterOp).toBe(beforeOp)
        const afterSeqRow = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db
                  .select()
                  .from(EventSequenceTable)
                  .where(eq(EventSequenceTable.aggregate_id, session.id))
                  .get()
                  .pipe(Effect.orDie)
                return row
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const afterSeq = afterSeqRow?.seq ?? -1
        expect(afterSeq).toBe(beforeSeq)
        const afterEvents = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db
                  .select()
                  .from(EventTable)
                  .where(eq(EventTable.aggregate_id, session.id))
                  .all()
                  .pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterEvents).toBe(beforeEvents)
        expect(captured.length).toBe(0)
      } finally {
        guardArmed = false
        GlobalBus.off("event", handler)
      }
    }),
  )

  it.live("location: subdir session keeps canon dir and project worktree distinct on GlobalBus/EventV2", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>
      const dir = tmp.path
      const sub = path.join(dir, "sub")
      yield* Effect.promise(() => fs.mkdir(sub, { recursive: true }))
      const session = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(sub)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "orig-sub" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const persisted = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(sub)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const srow = yield* db.select({ directory: SessionTable.directory, project_id: SessionTable.project_id }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
              const prow = yield* db.select({ worktree: ProjectTable.worktree }).from(ProjectTable).where(eq(ProjectTable.id, srow!.project_id)).get().pipe(Effect.orDie)
              return { srow, prow }
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      expect(persisted.srow.directory).toBe(sub)
      expect(persisted.prow.worktree).toBe(dir)
      const capturedBus: any[] = []
      const capturedEvt: any[] = []
      const busHandler = (ev: any) => {
        if (ev.payload?.type === "sync" && ev.payload?.syncEvent?.type === "session.updated.1") capturedBus.push(ev)
      }
      GlobalBus.on("event", busHandler)
      const unsub = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(sub)(
            Effect.gen(function* () {
              const ev = yield* EventV2.Service
              return yield* ev.listen((e) => Effect.sync(() => capturedEvt.push(e)))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      try {
        const opId = SessionOperation.sessionUpdateId(session.id, "loc-sub-" + Math.random().toString(36).slice(2, 6))
        const req = {
          v: 1 as const,
          requestId: "req-loc-sub",
          opId,
          op: "session/update" as const,
          idempotencyKey: `idem-loc-sub-${Math.random().toString(36).slice(2, 6)}`,
          context: { directory: sub, sessionId: session.id, parentSessionId: null },
          payload: { title: "loc sub title" },
        }
        const result = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(sub)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(result.status).toBe("succeeded")
        expect(capturedBus.length).toBe(1)
        expect(capturedBus[0].directory).toBe(sub)
        expect(capturedBus[0].project).toBe(persisted.srow.project_id)
        expect(capturedEvt.length).toBe(1)
        const loc = capturedEvt[0].location as any
        expect(loc.directory).toBe(sub)
        expect(loc.project.directory).toBe(dir)
        expect(loc.project.id).toBe(persisted.srow.project_id)
      } finally {
        GlobalBus.off("event", busHandler)
        yield* unsub as unknown as Effect.Effect<any, any, any>
      }
    }),
  )

  it.live("location: persisted workspace wins over ambient on GlobalBus", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>
      const dir = tmp.path
      const session = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "orig-ws" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const persistedWS = WorkspaceV2.ID.make("wrk_" + Math.random().toString(36).slice(2, 8))
      const ambientWS = WorkspaceV2.ID.make("wrk_" + Math.random().toString(36).slice(2, 8))
      yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              yield* db.update(SessionTable).set({ workspace_id: persistedWS as string }).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const capturedBus: any[] = []
      const capturedEvt: any[] = []
      const handler = (ev: any) => {
        if (ev.payload?.type === "sync" && ev.payload?.syncEvent?.type === "session.updated.1") capturedBus.push(ev)
      }
      GlobalBus.on("event", handler)
      const unsub = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const ev = yield* EventV2.Service
              return yield* ev.listen((e) => Effect.sync(() => capturedEvt.push(e)))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      try {
        const opId = SessionOperation.sessionUpdateId(session.id, "ws-" + Math.random().toString(36).slice(2, 6))
        const req = {
          v: 1 as const,
          requestId: "req-ws",
          opId,
          op: "session/update" as const,
          idempotencyKey: `idem-ws-${Math.random().toString(36).slice(2, 6)}`,
          context: { directory: dir, sessionId: session.id, parentSessionId: null },
          payload: { title: "ws title" },
        }
        const result = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req).pipe(Effect.provideService(WorkspaceRef, ambientWS as unknown as any))
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(result.status).toBe("succeeded")
        expect(capturedBus.length).toBe(1)
        expect(capturedBus[0].workspace).toBe(persistedWS)
        expect(capturedEvt.length).toBe(1)
        expect((capturedEvt[0].location as any).workspaceID).toBe(persistedWS)
      } finally {
        GlobalBus.off("event", handler)
        yield* unsub as unknown as Effect.Effect<any, any, any>
      }
    }),
  )

  it.live("location: absent persisted workspace not filled with ambient", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>
      const dir = tmp.path
      const session = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "orig-nowws" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              yield* db.update(SessionTable).set({ workspace_id: null }).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const ambientWS = WorkspaceV2.ID.make("wrk_" + Math.random().toString(36).slice(2, 8))
      const capturedBus: any[] = []
      const capturedEvt: any[] = []
      const handler = (ev: any) => {
        if (ev.payload?.type === "sync" && ev.payload?.syncEvent?.type === "session.updated.1") capturedBus.push(ev)
      }
      GlobalBus.on("event", handler)
      const unsub = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const ev = yield* EventV2.Service
              return yield* ev.listen((e) => Effect.sync(() => capturedEvt.push(e)))
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      try {
        const opId = SessionOperation.sessionUpdateId(session.id, "nows-" + Math.random().toString(36).slice(2, 6))
        const req = {
          v: 1 as const,
          requestId: "req-nows",
          opId,
          op: "session/update" as const,
          idempotencyKey: `idem-nows-${Math.random().toString(36).slice(2, 6)}`,
          context: { directory: dir, sessionId: session.id, parentSessionId: null },
          payload: { title: "nows title" },
        }
        const result = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req).pipe(Effect.provideService(WorkspaceRef, ambientWS as unknown as any))
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(result.status).toBe("succeeded")
        expect(capturedBus.length).toBe(1)
        expect(capturedBus[0].workspace).toBeUndefined()
        expect(capturedEvt.length).toBe(1)
        expect((capturedEvt[0].location as any).workspaceID).toBeUndefined()
      } finally {
        GlobalBus.off("event", handler)
        yield* unsub as unknown as Effect.Effect<any, any, any>
      }
    }),
  )

  it.live("aggregateEvents subscriber receives durable after commit and not on replay/rollback (deterministic)", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>
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
      ) as unknown as Effect.Effect<any, any, any>
      const inner = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const events = yield* EventV2.Service
              const dispatchSvc = yield* SessionUpdateDispatchService
              const received: any[] = []
              const fiber = yield* Effect.forkScoped(events.aggregateEvents({ aggregateID: session.id }).pipe(Stream.runForEach((evt) => Effect.sync(() => received.push(evt)))))
              // deterministic readiness via probe event instead of fixed sleep
              const probeTitle = "probe-ready-" + Math.random().toString(36).slice(2, 6)
              const curRow: any = yield* (yield* Database.Service).db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
              const curInfo: any = Session.fromRow(curRow as any)
              const probeInfo = { ...curInfo, title: probeTitle }
              yield* (yield* EventV2.Service).publish(SessionV1.Event.Updated, { sessionID: session.id, info: probeInfo })
              yield* pollWithTimeout(
                Effect.gen(function* () {
                  return received.length > 0 ? (true as const) : undefined
                }),
                "aggregate subscription not ready",
                "2 seconds",
              )
              received.length = 0
              const before = received.length
              const tokenOk = "agg-" + Math.random().toString(36).slice(2, 6)
              const opIdOk = SessionOperation.sessionUpdateId(session.id, tokenOk)
              const reqOk = {
                v: 1 as const,
                requestId: "req-agg-ok",
                opId: opIdOk,
                op: "session/update" as const,
                idempotencyKey: `idem-agg-ok-${tokenOk}`,
                context: { directory: dir, sessionId: session.id, parentSessionId: null },
                payload: { title: "agg title" },
              }
              const rollbackTitle = "rollback-" + Math.random().toString(36).slice(2, 6)
              let armed = true
              yield* events.beforeCommit((event) => {
                if (!armed) return Effect.void
                const data = event.data as any
                if (event.type === SessionV1.Event.Updated.type && data?.info?.title === rollbackTitle) {
                  return Effect.die(new Error("injected rollback"))
                }
                return Effect.void
              })
              const dispatchResult = yield* Effect.gen(function* () {
                const dr = yield* dispatchSvc.dispatch(reqOk)
                if (dr.status !== "succeeded") return yield* Effect.die(new Error("first dispatch failed"))
                yield* pollWithTimeout(
                  Effect.gen(function* () {
                    return received.length === before + 1 ? true : undefined
                  }),
                  "aggregateEvents did not receive committed event",
                  "2 seconds",
                )
                const last = received[received.length - 1] as any
                if (last.event.data.info.title !== "agg title") return yield* Effect.die(new Error("aggregate title mismatch"))
                const replayResult = yield* dispatchSvc.dispatch(reqOk)
                if (replayResult.status !== "succeeded") return yield* Effect.die(new Error("replay failed"))
                yield* Effect.sleep("200 millis")
                if (received.length !== before + 1) return yield* Effect.die(new Error(`replay woke aggregate: ${received.length} vs ${before + 1}`))
                const tokenRb = "rb-" + Math.random().toString(36).slice(2, 6)
                const opIdRb = SessionOperation.sessionUpdateId(session.id, tokenRb)
                const reqRb = {
                  v: 1 as const,
                  requestId: "req-agg-rb",
                  opId: opIdRb,
                  op: "session/update" as const,
                  idempotencyKey: `idem-agg-rb-${tokenRb}`,
                  context: { directory: dir, sessionId: session.id, parentSessionId: null },
                  payload: { title: rollbackTitle },
                }
                const beforeRb = received.length
                const rbResult = yield* dispatchSvc.dispatch(reqRb)
                if (rbResult.status !== "failed") return yield* Effect.die(new Error("rollback should have failed"))
                yield* Effect.sleep("200 millis")
                if (received.length !== beforeRb) return yield* Effect.die(new Error(`rollback woke aggregate: ${received.length} vs ${beforeRb}`))
                const rbReplay = yield* dispatchSvc.dispatch(reqRb)
                if (rbReplay.status !== "failed") return yield* Effect.die(new Error("rollback replay should still fail"))
                yield* Effect.sleep("200 millis")
                if (received.length !== beforeRb) return yield* Effect.die(new Error(`rollback replay woke aggregate`))
                return dr
              }).pipe(Effect.ensuring(Effect.sync(() => { armed = false })), Effect.ensuring(Fiber.interrupt(fiber)))
              return dispatchResult
            }).pipe(Effect.scoped),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      expect((inner as any).status).toBe("succeeded")
    }),
  )

  it.live("post-commit notify typed failure does not turn succeeded into failed", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>
      const dir = tmp.path
      const session = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "orig-notify" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      let notifyCalls = 0
      const base = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const dbSvc = yield* Database.Service
              const baseEvents = yield* EventV2.Service
              const gateSvc = yield* GenerationGate.Service
              const cfgSvc = yield* ConfigConvergence.Service
              return { dbSvc, baseEvents, gateSvc, cfgSvc }
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const failingEvents = EventV2.Service.of({
        ...base.baseEvents,
        notifyCommitted: (ev: any) =>
          Effect.gen(function* () {
            notifyCalls++
            return yield* Effect.fail(new Error("notify failed"))
          }),
      } as any)
      const isolated = Layer.mergeAll(
        Layer.succeed(Database.Service, base.dbSvc),
        Layer.succeed(EventV2.Service, failingEvents),
        Layer.succeed(GenerationGate.Service, base.gateSvc),
        Layer.succeed(ConfigConvergence.Service, base.cfgSvc),
      )
      const dispatchLayer = SessionUpdateDispatch.layer.pipe(Layer.provideMerge(isolated))
      const rt = ManagedRuntime.make(dispatchLayer)
      try {
        const dispatchSvc = yield* Effect.promise(() => rt.runPromise(Effect.gen(function* () { const s = yield* SessionUpdateDispatchService; return s }) as any)) as unknown as Effect.Effect<any, any, any>
        const opId = SessionOperation.sessionUpdateId(session.id, "notify-fail-" + Math.random().toString(36).slice(2, 6))
        const req = {
          v: 1 as const,
          requestId: "req-notify-fail",
          opId,
          op: "session/update" as const,
          idempotencyKey: `idem-notify-fail-${Math.random().toString(36).slice(2, 6)}`,
          context: { directory: dir, sessionId: session.id, parentSessionId: null },
          payload: { title: "notify fail title" },
        }
        const result = yield* Effect.promise(() => rt.runPromise((dispatchSvc as any).dispatch(req) as any)) as unknown as Effect.Effect<any, any, any>
        expect(result.status).toBe("succeeded")
        expect((result as any).data.title).toBe("notify fail title")
        expect(notifyCalls).toBe(1)
        const persisted = yield* Effect.promise(() =>
          rt.runPromise(
            Effect.gen(function* () {
              const svc = yield* Database.Service
              const row = yield* (svc as any).db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
              return row as any
            }) as any,
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(persisted.title).toBe("notify fail title")
      } finally {
        yield* Effect.promise(() => rt.dispose())
      }
    }),
  )

  it.live("post-commit notify defect does not turn succeeded into failed", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>
      const dir = tmp.path
      const session = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "orig-defect" })
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      let notifyCalls = 0
      const base = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const dbSvc = yield* Database.Service
              const baseEvents = yield* EventV2.Service
              const gateSvc = yield* GenerationGate.Service
              const cfgSvc = yield* ConfigConvergence.Service
              return { dbSvc, baseEvents, gateSvc, cfgSvc }
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const defectEvents = EventV2.Service.of({
        ...base.baseEvents,
        notifyCommitted: (ev: any) =>
          Effect.gen(function* () {
            notifyCalls++
            return yield* Effect.die(new Error("notify defect"))
          }),
      } as any)
      const isolated = Layer.mergeAll(
        Layer.succeed(Database.Service, base.dbSvc),
        Layer.succeed(EventV2.Service, defectEvents),
        Layer.succeed(GenerationGate.Service, base.gateSvc),
        Layer.succeed(ConfigConvergence.Service, base.cfgSvc),
      )
      const dispatchLayer = SessionUpdateDispatch.layer.pipe(Layer.provideMerge(isolated))
      const rt = ManagedRuntime.make(dispatchLayer)
      try {
        const dispatchSvc = yield* Effect.promise(() => rt.runPromise(Effect.gen(function* () { const s = yield* SessionUpdateDispatchService; return s }) as any)) as unknown as Effect.Effect<any, any, any>
        const opId = SessionOperation.sessionUpdateId(session.id, "notify-defect-" + Math.random().toString(36).slice(2, 6))
        const req = {
          v: 1 as const,
          requestId: "req-notify-defect",
          opId,
          op: "session/update" as const,
          idempotencyKey: `idem-notify-defect-${Math.random().toString(36).slice(2, 6)}`,
          context: { directory: dir, sessionId: session.id, parentSessionId: null },
          payload: { title: "notify defect title" },
        }
        const result = yield* Effect.promise(() => rt.runPromise((dispatchSvc as any).dispatch(req) as any)) as unknown as Effect.Effect<any, any, any>
        expect(result.status).toBe("succeeded")
        expect((result as any).data.title).toBe("notify defect title")
        expect(notifyCalls).toBe(1)
        const persisted = yield* Effect.promise(() =>
          rt.runPromise(
            Effect.gen(function* () {
              const svc = yield* Database.Service
              const row = yield* (svc as any).db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
              return row as any
            }) as any,
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(persisted.title).toBe("notify defect title")
      } finally {
        yield* Effect.promise(() => rt.dispose())
      }
    }),
  )

  it.live("present invalid resultSnapshot fails closed with rollback and zero notification (absent fallback only)", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>
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
      ) as unknown as Effect.Effect<any, any, any>
      const beforeInfo = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db.select({ rev: SessionTable.revision, title: SessionTable.title }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
              return row!
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeFeed = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeOp = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
              const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie)
              return (rows as any[]).filter((r) => r.op_kind === "sessionUpdate").length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeSeqRow = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, session.id)).get().pipe(Effect.orDie)
              return row
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeSeq = beforeSeqRow?.seq ?? -1
      const beforeEvents = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, session.id)).all().pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      // Corrupt a non-mutated field to make the produced snapshot invalid (time_created <0 fails Session.Info NonNegativeInt)
      // This uses a real DB seam (direct row update) without mocks — snapshot is present but invalid.
      yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              yield* db.update(SessionTable).set({ time_created: -1 } as unknown as Record<string, unknown>).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const captured: any[] = []
      const handler = (ev: any) => {
        if (ev.payload?.type === "sync" && ev.payload?.syncEvent?.type === "session.updated.1") captured.push(ev.payload.syncEvent)
      }
      GlobalBus.on("event", handler)
      try {
        const opId = SessionOperation.sessionUpdateId(session.id, "invalid-snap-" + Math.random().toString(36).slice(2, 6))
        const req = {
          v: 1 as const,
          requestId: "req-invalid-snap",
          opId,
          op: "session/update" as const,
          idempotencyKey: `idem-invalid-snap-${Math.random().toString(36).slice(2, 6)}`,
          context: { directory: dir, sessionId: session.id, parentSessionId: null },
          payload: { title: "new title invalid snap" },
        }
        const result = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(result.status).toBe("failed")
        expect((result as any).failure.code).toBe("internal")
        // Must be fail-closed: no notify, no surface growth, title unchanged (mutates via rollback)
        expect(captured.length).toBe(0)
        const afterInfo = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db.select({ rev: SessionTable.revision, title: SessionTable.title }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
                return row!
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        // revision must not have advanced (transaction rolled back), title still original despite corruption of time_created persisting
        expect(afterInfo.rev).toBe(beforeInfo.rev)
        expect(afterInfo.title).toBe(beforeInfo.title)
        // time_created corruption persists outside tx (not rolled back) but title/revision/feed/operation/event must not have changed due to failed tx
        const afterFeed = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterFeed).toBe(beforeFeed)
        const afterOp = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
                const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie)
                return (rows as any[]).filter((r) => r.op_kind === "sessionUpdate").length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterOp).toBe(beforeOp)
        const afterSeqRow = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, session.id)).get().pipe(Effect.orDie)
                return row
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const afterSeq = afterSeqRow?.seq ?? -1
        expect(afterSeq).toBe(beforeSeq)
        const afterEvents = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, session.id)).all().pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterEvents).toBe(beforeEvents)
        // Absent snapshot fallback must still work — restore valid time_created and retry with same op should succeed
        yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                yield* db.update(SessionTable).set({ time_created: Date.now() } as unknown as Record<string, unknown>).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const opId2 = SessionOperation.sessionUpdateId(session.id, "valid-after-" + Math.random().toString(36).slice(2, 6))
        const req2 = {
          v: 1 as const,
          requestId: "req-valid-after",
          opId: opId2,
          op: "session/update" as const,
          idempotencyKey: `idem-valid-after-${Math.random().toString(36).slice(2, 6)}`,
          context: { directory: dir, sessionId: session.id, parentSessionId: null },
          payload: { title: "valid after corrupt" },
        }
        const r2 = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req2)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(r2.status).toBe("succeeded")
        expect((r2 as any).data.title).toBe("valid after corrupt")
      } finally {
        GlobalBus.off("event", handler)
      }
    }),
  )

  it.live("empty string present invalid resultSnapshot fails closed with rollback and zero notification (no mutable fallback)", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>
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
      ) as unknown as Effect.Effect<any, any, any>
      const token = "empty-snap-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.sessionUpdateId(session.id, token)
      const idem = `idem-empty-snap-${Math.random().toString(36).slice(2, 6)}`
      const req = {
        v: 1 as const,
        requestId: "req-empty-snap",
        opId,
        op: "session/update" as const,
        idempotencyKey: idem,
        context: { directory: dir, sessionId: session.id, parentSessionId: null },
        payload: { title: "empty-snap-title" },
      }
      const r1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionUpdateDispatchService
              return yield* d.dispatch(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      expect(r1.status).toBe("succeeded")
      const persistedRev = (r1 as any).revision.session
      const beforeInfo = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db.select({ rev: SessionTable.revision, title: SessionTable.title }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
              return row!
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeFeed = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeOp = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
              const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie)
              return (rows as any[]).filter((r) => r.op_kind === "sessionUpdate").length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeSeqRow = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, session.id)).get().pipe(Effect.orDie)
              return row
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeSeq = beforeSeqRow?.seq ?? -1
      const beforeEvents = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, session.id)).all().pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      // corrupt persisted snapshot to empty string (present invalid)
      yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
              yield* db.update(SessionOperationTable).set({ result_snapshot: "" } as unknown as Record<string, unknown>).where(eq(SessionOperationTable.op_id, opId)).run().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const captured: any[] = []
      const handler = (ev: any) => {
        if (ev.payload?.type === "sync" && ev.payload?.syncEvent?.type === "session.updated.1") captured.push(ev.payload.syncEvent)
      }
      GlobalBus.on("event", handler)
      try {
        const replay = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(replay.status).toBe("failed")
        expect((replay as any).failure.code).toBe("internal")
        expect(captured.length).toBe(0)
        const afterInfo = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db.select({ rev: SessionTable.revision, title: SessionTable.title }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
                return row!
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterInfo.rev).toBe(beforeInfo.rev)
        expect(afterInfo.title).toBe(beforeInfo.title)
        expect(afterInfo.title).toBe("empty-snap-title")
        const afterFeed = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterFeed).toBe(beforeFeed)
        const afterOp = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
                const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie)
                return (rows as any[]).filter((r) => r.op_kind === "sessionUpdate").length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterOp).toBe(beforeOp)
        const afterSeqRow = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, session.id)).get().pipe(Effect.orDie)
                return row
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const afterSeq = afterSeqRow?.seq ?? -1
        expect(afterSeq).toBe(beforeSeq)
        const afterEvents = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, session.id)).all().pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterEvents).toBe(beforeEvents)
        // private replay must also fail closed internal with same empty snapshot, no mutable fallback
        const privReplay = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* (d as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate(req)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(privReplay.status).toBe("failed")
        expect((privReplay as any).failure.code).toBe("internal")
        expect(captured.length).toBe(0)
        // absent fallback still works: new distinct operation should succeed
        const token2 = "empty-after-" + Math.random().toString(36).slice(2, 6)
        const opId2 = SessionOperation.sessionUpdateId(session.id, token2)
        const req2 = {
          v: 1 as const,
          requestId: "req-empty-after",
          opId: opId2,
          op: "session/update" as const,
          idempotencyKey: `idem-empty-after-${Math.random().toString(36).slice(2, 6)}`,
          context: { directory: dir, sessionId: session.id, parentSessionId: null },
          payload: { title: "valid after empty" },
        }
        const r2 = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req2)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(r2.status).toBe("succeeded")
        expect((r2 as any).data.title).toBe("valid after empty")
        // original empty snapshot replay must still fail closed after later mutation (no mutable fallback to "valid after empty")
        const replayAfter = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(replayAfter.status).toBe("failed")
        expect((replayAfter as any).failure.code).toBe("internal")
        if ((replayAfter as any).data) expect((replayAfter as any).data.title).not.toBe("valid after empty")
      } finally {
        GlobalBus.off("event", handler)
      }
    }),
  )

  it.live("JSON null text present invalid resultSnapshot fails closed with rollback and zero notification (no mutable fallback, both surfaces)", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>
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
      ) as unknown as Effect.Effect<any, any, any>
      const token = "null-snap-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.sessionUpdateId(session.id, token)
      const idem = `idem-null-snap-${Math.random().toString(36).slice(2, 6)}`
      const req = {
        v: 1 as const,
        requestId: "req-null-snap",
        opId,
        op: "session/update" as const,
        idempotencyKey: idem,
        context: { directory: dir, sessionId: session.id, parentSessionId: null },
        payload: { title: "null-snap-title" },
      }
      const r1 = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const d = yield* SessionUpdateDispatchService
              return yield* d.dispatch(req)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      expect(r1.status).toBe("succeeded")
      const beforeInfo = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db.select({ rev: SessionTable.revision, title: SessionTable.title }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
              return row!
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeFeed = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeOp = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
              const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie)
              return (rows as any[]).filter((r) => r.op_kind === "sessionUpdate").length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeSeqRow = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const row = yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, session.id)).get().pipe(Effect.orDie)
              return row
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      const beforeSeq = beforeSeqRow?.seq ?? -1
      const beforeEvents = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const rows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, session.id)).all().pipe(Effect.orDie)
              return rows.length
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      // corrupt persisted snapshot to JSON text "null" (DB text "null" parses to JS null, must be present invalid)
      yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
              yield* db.update(SessionOperationTable).set({ result_snapshot: "null" } as unknown as Record<string, unknown>).where(eq(SessionOperationTable.op_id, opId)).run().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      // also verify mapper invariant directly: hasSnapshot must be true for JS null, absent only for DB NULL
      const mapperCheck = yield* Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const db = (yield* Database.Service).db
              const hash = SessionOperation.hashIdempotencyKey(idem)
              const rec = yield* SessionOperation.getSessionUpdateByIdempotencyHash(db, session.id, hash).pipe(Effect.orDie)
              return { has: rec ? SessionOperation.hasSnapshot(rec) : false, snap: (rec as any)?.resultSnapshot }
            }),
          ),
        ),
      ) as unknown as Effect.Effect<any, any, any>
      expect(mapperCheck.has).toBe(true)
      expect(mapperCheck.snap).toBeNull()
      const captured: any[] = []
      const handler = (ev: any) => {
        if (ev.payload?.type === "sync" && ev.payload?.syncEvent?.type === "session.updated.1") captured.push(ev.payload.syncEvent)
      }
      GlobalBus.on("event", handler)
      try {
        const replay = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(replay.status).toBe("failed")
        expect((replay as any).failure.code).toBe("internal")
        expect(captured.length).toBe(0)
        const afterInfo = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db.select({ rev: SessionTable.revision, title: SessionTable.title }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
                return row!
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterInfo.rev).toBe(beforeInfo.rev)
        expect(afterInfo.title).toBe(beforeInfo.title)
        expect(afterInfo.title).toBe("null-snap-title")
        const afterFeed = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, session.id)).all().pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterFeed).toBe(beforeFeed)
        const afterOp = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
                const rows = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, session.id)).all().pipe(Effect.orDie)
                return (rows as any[]).filter((r) => r.op_kind === "sessionUpdate").length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterOp).toBe(beforeOp)
        const afterSeqRow = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const row = yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, session.id)).get().pipe(Effect.orDie)
                return row
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        const afterSeq = afterSeqRow?.seq ?? -1
        expect(afterSeq).toBe(beforeSeq)
        const afterEvents = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const rows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, session.id)).all().pipe(Effect.orDie)
                return rows.length
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(afterEvents).toBe(beforeEvents)
        // private replay must also fail closed internal with same null snapshot, no mutable fallback
        const privReplay = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* (d as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate(req)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(privReplay.status).toBe("failed")
        expect((privReplay as any).failure.code).toBe("internal")
        expect(captured.length).toBe(0)
        // absent fallback still works: new distinct operation should succeed
        const token2 = "null-after-" + Math.random().toString(36).slice(2, 6)
        const opId2 = SessionOperation.sessionUpdateId(session.id, token2)
        const req2 = {
          v: 1 as const,
          requestId: "req-null-after",
          opId: opId2,
          op: "session/update" as const,
          idempotencyKey: `idem-null-after-${Math.random().toString(36).slice(2, 6)}`,
          context: { directory: dir, sessionId: session.id, parentSessionId: null },
          payload: { title: "valid after null" },
        }
        const r2 = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req2)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(r2.status).toBe("succeeded")
        expect((r2 as any).data.title).toBe("valid after null")
        // original null snapshot replay must still fail closed after later mutation (no mutable fallback to "valid after null")
        const replayAfter = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(dir)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(req)
              }),
            ),
          ),
        ) as unknown as Effect.Effect<any, any, any>
        expect(replayAfter.status).toBe("failed")
        expect((replayAfter as any).failure.code).toBe("internal")
        if ((replayAfter as any).data) expect((replayAfter as any).data.title).not.toBe("valid after null")
      } finally {
        GlobalBus.off("event", handler)
      }
    }),
  )
})
