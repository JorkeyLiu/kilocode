import { describe, expect } from "bun:test"
import { Database as CoreDatabase } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { EventTable } from "@opencode-ai/core/event/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Effect, Layer } from "effect"
import { asc, eq } from "drizzle-orm"
import { Session as SessionNs } from "@/session/session"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { testEffect } from "../../lib/effect"
import { testInstanceStoreLayer } from "../../fixture/fixture"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Ownership from "@/retention/ownership"
import { Todo } from "@/session/todo"


const recorded: Array<{ seq: number; session_id: string; revision: number; kind: string; time: number }> = []

const testNotifier = Layer.succeed(EventV2.ObservationNotifier, {
  notify: (entry) => Effect.sync(() => recorded.push(entry as any)),
})

const ownership = Ownership.layer
const status = SessionStatus.defaultLayer
const bg = BackgroundJob.defaultLayer
const runState = SessionRunState.layer.pipe(Layer.provide(status), Layer.provide(bg), Layer.provide(ownership))
const sessionLayer = SessionNs.layer.pipe(
  Layer.provide(runState),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(CoreDatabase.defaultLayer),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
  Layer.provide(SessionProjector.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
  Layer.provide(ownership),
  Layer.provide(bg),
)

const it = testEffect(
  Layer.mergeAll(
    CoreDatabase.defaultLayer,
    EventV2.defaultLayer,
    sessionLayer,
    runState,
    status,
    bg,
    ownership,
    Todo.layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provide(CoreDatabase.defaultLayer)),
    testInstanceStoreLayer,
    testNotifier,
  ),
)

describe("legacy observation convergence", () => {
  it.instance("PATCH metadata notifies with actual changefeed row", () =>
    Effect.gen(function* () {
      recorded.length = 0
      const session = yield* SessionNs.Service
      const { db } = yield* CoreDatabase.Service
      const info = yield* Effect.acquireRelease(session.create({ title: "obs-meta" }), (s) =>
        session.remove(s.id).pipe(Effect.ignore),
      )
      const before = (yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, info.id)).get().pipe(Effect.orDie)) as any
      const beforeRev = before.rev
      const beforeSeqRow = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, info.id)).all().pipe(Effect.orDie)
      const beforeLen = beforeSeqRow.length
      yield* session.setMetadata({ sessionID: info.id, metadata: { k: "v" } })
      // allow notifier to have run (it is inside same Effect chain, so already)
      expect(recorded.length).toBe(1)
      const entry = recorded[0]!
      expect(entry.session_id).toBe(info.id)
      expect(entry.kind).toBe("changed")
      expect(entry.revision).toBe(beforeRev + 1)
      expect(typeof entry.seq).toBe("number")
      expect(typeof entry.time).toBe("number")
      // payload should have exactly 5 keys when expanded via bridge
      const keys = Object.keys(entry)
      expect(keys.sort()).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
      // actual changefeed row matches
      const rows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, info.id)).all().pipe(Effect.orDie)
      expect(rows.length).toBe(beforeLen + 1)
      const latest = rows.sort((a, b) => a.seq - b.seq)[rows.length - 1]!
      expect(latest.seq).toBe(entry.seq)
      expect(latest.revision).toBe(entry.revision)
      expect(latest.time).toBe(entry.time)
    }),
  )

  it.instance("PartUpdated notifies payload-free", () =>
    Effect.gen(function* () {
      recorded.length = 0
      const session = yield* SessionNs.Service
      const { db } = yield* CoreDatabase.Service
      const info = yield* Effect.acquireRelease(session.create({ title: "obs-part" }), (s) =>
        session.remove(s.id).pipe(Effect.ignore),
      )
      const msgID = MessageID.ascending()
      yield* session.updateMessage({
        id: msgID,
        sessionID: info.id,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as any)
      recorded.length = 0
      const before = (yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, info.id)).get().pipe(Effect.orDie)) as any
      const beforeRev = before.rev
      const partID = PartID.ascending()
      yield* session.updatePart({
        id: partID,
        messageID: msgID,
        sessionID: info.id,
        type: "text",
        text: "hello",
      } as any)
      expect(recorded.length).toBe(1)
      const e = recorded[0]!
      expect(e.session_id).toBe(info.id)
      expect(e.revision).toBe(beforeRev + 1)
      expect(e.kind).toBe("changed")
    }),
  )

  it.instance("removeMessage notifies and is idempotent via replay zero", () =>
    Effect.gen(function* () {
      recorded.length = 0
      const session = yield* SessionNs.Service
      const { db } = yield* CoreDatabase.Service
      const events = yield* EventV2.Service
      const info = yield* Effect.acquireRelease(session.create({ title: "obs-remove" }), (s) =>
        session.remove(s.id).pipe(Effect.ignore),
      )
      const msgID = MessageID.ascending()
      yield* session.updateMessage({
        id: msgID,
        sessionID: info.id,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as any)
      recorded.length = 0
      yield* session.removeMessage({ sessionID: info.id, messageID: msgID })
      expect(recorded.length).toBe(1)
      const firstSeq = recorded[0]!.seq
      const lastEvent = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, info.id)).orderBy(asc(EventTable.seq)).all().pipe(Effect.orDie)
      const target = lastEvent[lastEvent.length - 1]!
      recorded.length = 0
      yield* events.replay({ id: target.id as any, aggregateID: target.aggregate_id, seq: target.seq, type: target.type as any, data: target.data as any })
      expect(recorded.length).toBe(0)
      const afterRows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, info.id)).all().pipe(Effect.orDie)
      expect(afterRows.some((r) => r.seq === firstSeq)).toBe(true)
    }),
  )

  it.instance("rollback via missing session produces zero notification", () =>
    Effect.gen(function* () {
      recorded.length = 0
      const session = yield* SessionNs.Service
      const { db } = yield* CoreDatabase.Service
      const fakeID = SessionID.make("ses_fake_" + Date.now()) as any
      const beforeRows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, fakeID)).all().pipe(Effect.orDie)
      expect(beforeRows.length).toBe(0)
      const exit = yield* session.setMetadata({ sessionID: fakeID, metadata: { x: 1 } }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(recorded.length).toBe(0)
      const afterRows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, fakeID)).all().pipe(Effect.orDie)
      expect(afterRows.length).toBe(0)
    }),
  )

  it.instance("peer unavailable non-blocking", () =>
    Effect.gen(function* () {
      recorded.length = 0
      const session = yield* SessionNs.Service
      const info = yield* Effect.acquireRelease(session.create({ title: "obs-nopeer" }), (s) =>
        session.remove(s.id).pipe(Effect.ignore),
      )
      // simulate peer unavailable by providing a failing notifier for this operation
      // our core notifier catches errors, so we test that operation still succeeds even if notifier would fail
      const failingNotifier = Layer.succeed(EventV2.ObservationNotifier, {
        notify: () => Effect.die(new Error("peer unavailable")),
      })
      const prog = Effect.gen(function* () {
        const s = yield* SessionNs.Service
        yield* s.setMetadata({ sessionID: info.id, metadata: { a: 1 } })
        const fetched = yield* s.get(info.id)
        expect(fetched.metadata).toEqual({ a: 1 })
      })
      yield* prog.pipe(Effect.provide(failingNotifier))
      // recorded should not have increased via failing notifier (failing path catches)
      // but original recorded from outer layer should remain 0 for this failing notifier test
      // ensure at least the operation succeeded despite notifier failure
    }),
  )

  it.instance("concurrent writes produce distinct captured entries (race-free)", () =>
    Effect.gen(function* () {
      recorded.length = 0
      const session = yield* SessionNs.Service
      const { db } = yield* CoreDatabase.Service
      const info = yield* Effect.acquireRelease(session.create({ title: "obs-concurrent" }), (s) =>
        session.remove(s.id).pipe(Effect.ignore),
      )
      const beforeRows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, info.id)).all().pipe(Effect.orDie)
      const beforeLen = beforeRows.length
      recorded.length = 0
      // two concurrent legacy updates on same session – immediate transactions serialize, but captured entry inside tx is race-free
      yield* Effect.all(
        [session.setMetadata({ sessionID: info.id, metadata: { concurrent: "a" } }), session.setMetadata({ sessionID: info.id, metadata: { concurrent: "b" } })],
        { concurrency: "unbounded", discard: true },
      )
      expect(recorded.length).toBe(2)
      const seqs = recorded.map((r) => r.seq).sort((a, b) => a - b)
      const revs = recorded.map((r) => r.revision).sort((a, b) => a - b)
      expect(new Set(seqs).size).toBe(2)
      expect(new Set(revs).size).toBe(2)
      expect(seqs[1]).toBe(seqs[0] + 1)
      expect(revs[1]).toBe(revs[0] + 1)
      // each entry matches actual persisted row
      const afterRows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, info.id)).all().pipe(Effect.orDie)
      expect(afterRows.length).toBe(beforeLen + 2)
      for (const e of recorded) {
        const match = afterRows.find((r) => r.seq === e.seq)
        expect(match).toBeDefined()
        expect(match!.revision).toBe(e.revision)
        expect(match!.time).toBe(e.time)
        expect(match!.session_id).toBe(info.id)
      }
    }),
  )

  it.instance("no-row projection with prior changefeed does not notify stale entry", () =>
    Effect.gen(function* () {
      recorded.length = 0
      const { db } = yield* CoreDatabase.Service
      const events = yield* EventV2.Service
      const session = yield* SessionNs.Service
      const info = yield* Effect.acquireRelease(session.create({ title: "obs-no-row-stale" }), (s) =>
        session.remove(s.id).pipe(Effect.ignore),
      )
      yield* session.setMetadata({ sessionID: info.id, metadata: { prior: 1 } })
      expect(recorded.length).toBe(1)
      const priorEntry = recorded[0]!
      const priorRows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, info.id)).all().pipe(Effect.orDie)
      const priorLen = priorRows.length
      recorded.length = 0
      const lastEvent = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, info.id)).orderBy(asc(EventTable.seq)).all().pipe(Effect.orDie)
      const target = lastEvent[lastEvent.length - 1]!
      yield* events.replay({ id: target.id as any, aggregateID: target.aggregate_id, seq: target.seq, type: target.type as any, data: target.data as any })
      expect(recorded.length).toBe(0)
      const afterReplayRows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, info.id)).all().pipe(Effect.orDie)
      expect(afterReplayRows.length).toBe(priorLen)
      expect(afterReplayRows.some((r) => r.seq === priorEntry.seq)).toBe(true)
      recorded.length = 0
      yield* session.setMetadata({ sessionID: info.id, metadata: { fresh: 1 } })
      expect(recorded.length).toBe(1)
      expect(recorded[0]!.seq).not.toBe(priorEntry.seq)
      expect(recorded[0]!.revision).not.toBe(priorEntry.revision)
      recorded.length = 0
      const beforeConc = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, info.id)).all().pipe(Effect.orDie)
      yield* Effect.all(
        [session.setMetadata({ sessionID: info.id, metadata: { c: "x" } }), session.setMetadata({ sessionID: info.id, metadata: { c: "y" } })],
        { concurrency: "unbounded", discard: true },
      )
      expect(recorded.length).toBe(2)
      const seqs = recorded.map((r) => r.seq).sort((a, b) => a - b)
      expect(seqs[0]).not.toBe(priorEntry.seq)
      expect(new Set(seqs).size).toBe(2)
      const afterConc = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, info.id)).all().pipe(Effect.orDie)
      expect(afterConc.length).toBe(beforeConc.length + 2)
    }),
  )
})
