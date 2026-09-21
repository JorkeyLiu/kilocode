import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, SessionOperationTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { EventV2 } from "@opencode-ai/core/event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projects = Layer.succeed(
  Project.Service,
  Project.Service.of({
    resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projects),
  Layer.provide(SessionExecution.noopLayer),
)
const it = testEffect(Layer.mergeAll(database, events, projects, projector, store, SessionExecution.noopLayer, sessions))
const location = { directory: AbsolutePath.make("/project") }
const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
})

describe("durable operation entry in same transaction", () => {
  it.effect("fresh ensurePromptInFlight entry seq/revision equals same-transaction Session row/operation revision", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const opId = SessionOperation.promptId("msg_entry_fresh")
      const beforeFeed = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, s.id)).all().pipe(Effect.orDie)
      const res = yield* SessionOperation.ensurePromptInFlight(db, s.id, opId)
      expect(res.fresh).toBe(true)
      if (!res.fresh) throw new Error("expected fresh")
      expect(res.entry).toBeDefined()
      const entry = res.entry
      expect(entry.session_id).toBe(s.id)
      expect(entry.kind).toBe("changed")
      // entry revision equals session row revision and operation revision in same transaction
      const sessRow = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, s.id)).get().pipe(Effect.orDie)
      expect(sessRow).toBeDefined()
      expect(entry.revision).toBe(sessRow!.rev)
      const opRow = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, opId)).get().pipe(Effect.orDie)
      expect(opRow).toBeDefined()
      expect(opRow!.revision).toBe(entry.revision)
      expect(opRow!.revision).toBe(sessRow!.rev)
      // seq is the persisted feed seq — ordered check
      const feedRows = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, s.id)).all().pipe(Effect.orDie)
      expect(feedRows.length).toBe(beforeFeed.length + 1)
      const last = feedRows.reduce((a, b) => (a.seq > b.seq ? a : b))
      expect(last.seq).toBe(entry.seq)
      expect(last.revision).toBe(entry.revision)
    }),
  )

  it.effect("replay ensurePromptInFlight has no entry and does not advance revision/feed", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const opId = SessionOperation.promptId("msg_entry_replay")
      const first = yield* SessionOperation.ensurePromptInFlight(db, s.id, opId)
      expect(first.fresh).toBe(true)
      const rev1 = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, s.id)).get().pipe(Effect.orDie)
      const feed1 = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, s.id)).all().pipe(Effect.orDie)
      const count1 = feed1.length
      const maxSeq1 = feed1.reduce((a, b) => (a.seq > b.seq ? a : b)).seq
      const second = yield* SessionOperation.ensurePromptInFlight(db, s.id, opId)
      expect(second.fresh).toBe(false)
      // replay must have no entry (optional undefined)
      expect((second as unknown as { entry?: unknown }).entry).toBeUndefined()
      const rev2 = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, s.id)).get().pipe(Effect.orDie)
      expect(rev2!.rev).toBe(rev1!.rev)
      const feed2 = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, s.id)).all().pipe(Effect.orDie)
      expect(feed2.length).toBe(count1)
      const maxSeq2 = feed2.reduce((a, b) => (a.seq > b.seq ? a : b)).seq
      expect(maxSeq2).toBe(maxSeq1)
      const maxRev2 = feed2.reduce((a, b) => (a.seq > b.seq ? a : b)).revision
      expect(maxRev2).toBe(rev1!.rev)
      // ensure no new feed rows added
    }),
  )

  it.effect("tryTransitionPromptTerminal applied has entry, no-op has no entry", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const opId = SessionOperation.promptId("msg_entry_term")
      const fresh = yield* SessionOperation.ensurePromptInFlight(db, s.id, opId)
      expect(fresh.fresh).toBe(true)
      const revAfterFresh = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, s.id)).get().pipe(Effect.orDie)
      const feedAfterFresh = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, s.id)).all().pipe(Effect.orDie)
      const countAfterFresh = feedAfterFresh.length
      const termRec: SessionOperation.FailureRecord = { opId, opKind: "prompt", outcome: "succeeded", code: "prompt.succeeded", message: "ok", time: Date.now() }
      const applied = yield* SessionOperation.tryTransitionPromptTerminal(db, s.id, termRec)
      expect(applied.applied).toBe(true)
      if (!applied.applied) throw new Error("expected applied")
      expect(applied.entry).toBeDefined()
      expect(applied.entry.session_id).toBe(s.id)
      expect(applied.entry.kind).toBe("changed")
      // entry revision equals session and operation revision
      const sessRow = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, s.id)).get().pipe(Effect.orDie)
      expect(applied.entry.revision).toBe(sessRow!.rev)
      const opRow = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, opId)).get().pipe(Effect.orDie)
      expect(opRow!.revision).toBe(applied.entry.revision)
      expect(opRow!.outcome).toBe("succeeded")
      // seq monotonic increasing vs fresh
      if (fresh.fresh) expect(applied.entry.seq).toBeGreaterThan(fresh.entry.seq)
      const feedAfterApplied = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, s.id)).all().pipe(Effect.orDie)
      expect(feedAfterApplied.length).toBe(countAfterFresh + 2)
      expect(applied.generationEntry).toBeDefined()
      expect(applied.generationEntry!.kind).toBe("generation")
      expect(applied.generationEntry!.revision).toBe(applied.entry.revision)
      expect(applied.generationEntry!.seq).toBeGreaterThan(applied.entry.seq)
      const revAfterApplied = sessRow!.rev
      expect(revAfterApplied).toBe((revAfterFresh!.rev as number) + 1)
      // second terminal attempt should be no-op with no entry and no revision advance
      const termRec2: SessionOperation.FailureRecord = { opId, opKind: "prompt", outcome: "failed", code: "prompt.failed", message: "fail2", time: Date.now() }
      const noop = yield* SessionOperation.tryTransitionPromptTerminal(db, s.id, termRec2)
      expect(noop.applied).toBe(false)
      expect((noop as unknown as { entry?: unknown }).entry).toBeUndefined()
      expect((noop as unknown as { generationEntry?: unknown }).generationEntry).toBeUndefined()
      const sessRow2 = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, s.id)).get().pipe(Effect.orDie)
      expect(sessRow2!.rev).toBe(revAfterApplied)
      const feedAfterNoop = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, s.id)).all().pipe(Effect.orDie)
      expect(feedAfterNoop.length).toBe(countAfterFresh + 2)
      // record returned for no-op should be the existing terminal
      expect(noop.record).toBeDefined()
      expect(noop.record!.outcome).toBe("succeeded")
    }),
  )
})
