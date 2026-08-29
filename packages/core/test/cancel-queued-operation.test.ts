import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { sql, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, SessionOperationTable } from "@opencode-ai/core/session/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
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
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
})

describe("cancelQueued operation metadata", () => {
  it.effect("hashIdempotencyKey is deterministic and non-reversible", () =>
    Effect.gen(function* () {
      const h1 = SessionOperation.hashIdempotencyKey("key123")
      const h2 = SessionOperation.hashIdempotencyKey("key123")
      const h3 = SessionOperation.hashIdempotencyKey("different")
      expect(h1).toBe(h2)
      expect(h1).not.toBe(h3)
      expect(h1.length).toBe(64)
      expect(h1).not.toContain("key123")
    }),
  )

  it.effect("cancelQueuedId binds session and message and validates", () =>
    Effect.gen(function* () {
      const id = SessionOperation.cancelQueuedId("ses_123", "msg_456")
      expect(id).toBe("cancelQueued:ses_123:msg_456")
      expect(SessionOperation.parseOpId(id).kind).toBe("cancelQueued")
      expect(() => SessionOperation.cancelQueuedId("bad:colon", "msg_1")).toThrow()
      expect(() => SessionOperation.cancelQueuedId("ses_1", "bad:colon")).toThrow()
      expect(() => SessionOperation.parseOpId("cancelQueued:onlyone")).toThrow()
      expect(() => SessionOperation.parseOpId("task:ses_123")).not.toThrow()
      // mismatch kind vs opId should be caught by validateRecord
      const bad = {
        opId: "cancelQueued:ses_1:msg_1",
        opKind: "task" as const,
        outcome: "in-flight" as const,
        code: "c",
        message: "m",
        time: Date.now(),
      }
      expect(() => SessionOperation.validateRecord(bad)).toThrow()
      const good = {
        opId: "cancelQueued:ses_1:msg_1",
        opKind: "cancelQueued" as const,
        outcome: "in-flight" as const,
        code: "c",
        message: "m",
        time: Date.now(),
      }
      expect(() => SessionOperation.validateRecord(good)).not.toThrow()
    }),
  )

  it.effect("migration adds cancelQueued columns and indexes", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const ddl = yield* db
        .get<{ sql: string }>(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`)
        .pipe(Effect.orDie)
      expect(ddl!.sql).toContain("idempotency_hash")
      expect(ddl!.sql).toContain("request_id")
      expect(ddl!.sql).toContain("directory")
      expect(ddl!.sql).toContain("message_id")
      expect(ddl!.sql).toContain("cancelled")
      const idx = yield* db
        .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_operation'`)
        .pipe(Effect.orDie)
      const names = idx.map((r) => r.name)
      expect(names).toContain("session_operation_session_idempotency_idx")
      expect(names).toContain("session_operation_message_id_idx")
      expect(ddl!.sql).toContain("cancelQueued")
    }),
  )

  it.effect("insertCancelQueuedInFlight and update to terminal", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const msg = "msg_123"
      const opId = SessionOperation.cancelQueuedId(s.id, msg)
      const hash = SessionOperation.hashIdempotencyKey("idem1")
      const rec: SessionOperation.FailureRecord = {
        opId,
        opKind: "cancelQueued",
        outcome: "in-flight",
        code: "cancelQueued.inflight",
        message: "inflight",
        time: Date.now(),
      }
      const meta: SessionOperation.CancelQueuedMeta = {
        idempotencyHash: hash,
        requestId: "req1",
        directory: "/project",
        messageId: msg,
        parentSessionId: null,
        configVersion: 1,
        sessionRevision: 0,
        cancelled: null,
      }
      const inserted = yield* db.transaction((tx) =>
        SessionOperation.insertCancelQueuedInFlightTx(tx as unknown as typeof db, s.id, rec, meta),
      )
      expect(inserted.opId).toBe(opId)
      expect(inserted.outcome).toBe("in-flight")
      expect(inserted.meta.idempotencyHash).toBe(hash)
      expect(inserted.meta.cancelled).toBeNull()

      const beforeRev = yield* db
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, s.id))
        .get()
        .pipe(Effect.orDie)
      expect(beforeRev!.rev).toBe(1)

      const updated = yield* db.transaction((tx) =>
        SessionOperation.updateCancelQueuedTerminalTx(tx as unknown as typeof db, s.id, opId, true, Date.now()),
      )
      expect(updated.outcome).toBe("succeeded")
      expect(updated.meta.cancelled).toBe(true)

      const afterRev = yield* db
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, s.id))
        .get()
        .pipe(Effect.orDie)
      expect(afterRev!.rev).toBe(2)
    }),
  )

  it.effect("getByIdempotencyHash and isCancelQueuedConflict", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const msgA = "msg_aaa"
      const opId = SessionOperation.cancelQueuedId(s.id, msgA)
      const hash = SessionOperation.hashIdempotencyKey("idem-conflict")
      const rec: SessionOperation.FailureRecord = {
        opId,
        opKind: "cancelQueued",
        outcome: "in-flight",
        code: "cancelQueued.inflight",
        message: "inflight",
        time: Date.now(),
      }
      const meta: SessionOperation.CancelQueuedMeta = {
        idempotencyHash: hash,
        requestId: "req1",
        directory: "/project",
        messageId: msgA,
        parentSessionId: null,
        configVersion: 1,
        sessionRevision: 0,
        cancelled: null,
      }
      yield* db.transaction((tx) =>
        SessionOperation.insertCancelQueuedInFlightTx(tx as unknown as typeof db, s.id, rec, meta),
      )
      const fetched = yield* SessionOperation.getByIdempotencyHash(db, s.id, hash)
      expect(fetched).toBeDefined()
      expect(fetched!.meta.messageId).toBe(msgA)

      const conflict = SessionOperation.isCancelQueuedConflict(fetched!, {
        opId,
        directory: "/project",
        parentSessionId: null,
        configVersion: 1,
        sessionRevision: 0,
        messageId: "msg_bbb",
      })
      expect(conflict).toBe(true)

      const same = SessionOperation.isCancelQueuedConflict(fetched!, {
        opId,
        directory: "/project",
        parentSessionId: null,
        configVersion: 1,
        sessionRevision: 0,
        messageId: msgA,
      })
      expect(same).toBe(false)

      // opId mismatch should be conflict
      const differentOpId = SessionOperation.cancelQueuedId(s.id, "msg_bbb")
      const opConflict = SessionOperation.isCancelQueuedConflict(fetched!, {
        opId: differentOpId,
        directory: "/project",
        parentSessionId: null,
        configVersion: 1,
        sessionRevision: 0,
        messageId: msgA,
      })
      expect(opConflict).toBe(true)
    }),
  )

  it.effect("two different messages same session distinct ops", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const msg1 = "msg_one"
      const msg2 = "msg_two"
      const opId1 = SessionOperation.cancelQueuedId(s.id, msg1)
      const opId2 = SessionOperation.cancelQueuedId(s.id, msg2)
      expect(opId1).not.toBe(opId2)
      const hash1 = SessionOperation.hashIdempotencyKey("idem1")
      const hash2 = SessionOperation.hashIdempotencyKey("idem2")
      const rec1: SessionOperation.FailureRecord = {
        opId: opId1,
        opKind: "cancelQueued",
        outcome: "in-flight",
        code: "cancelQueued.inflight",
        message: "inflight",
        time: Date.now(),
      }
      const meta1: SessionOperation.CancelQueuedMeta = {
        idempotencyHash: hash1,
        requestId: "req1",
        directory: "/project",
        messageId: msg1,
        parentSessionId: null,
        configVersion: null,
        sessionRevision: null,
        cancelled: null,
      }
      const rec2: SessionOperation.FailureRecord = {
        opId: opId2,
        opKind: "cancelQueued",
        outcome: "in-flight",
        code: "cancelQueued.inflight",
        message: "inflight",
        time: Date.now(),
      }
      const meta2: SessionOperation.CancelQueuedMeta = {
        idempotencyHash: hash2,
        requestId: "req2",
        directory: "/project",
        messageId: msg2,
        parentSessionId: null,
        configVersion: null,
        sessionRevision: null,
        cancelled: null,
      }
      yield* db.transaction((tx) => SessionOperation.insertCancelQueuedInFlightTx(tx as unknown as typeof db, s.id, rec1, meta1))
      yield* db.transaction((tx) => SessionOperation.insertCancelQueuedInFlightTx(tx as unknown as typeof db, s.id, rec2, meta2))
      const f1 = yield* SessionOperation.getByIdempotencyHash(db, s.id, hash1)
      const f2 = yield* SessionOperation.getByIdempotencyHash(db, s.id, hash2)
      expect(f1).toBeDefined()
      expect(f2).toBeDefined()
      expect(f1!.opId).toBe(opId1)
      expect(f2!.opId).toBe(opId2)
      const list = yield* SessionOperation.list(db, s.id)
      expect(list.filter((r) => r.opKind === "cancelQueued").length).toBe(2)
    }),
  )

  it.effect("idempotency scoped to sessionID", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const s1 = yield* svc.create({ location })
      const s2 = yield* svc.create({ location })
      const hash = SessionOperation.hashIdempotencyKey("same-key")
      const m1 = "msg_1"
      const m2 = "msg_2"
      const opId1 = SessionOperation.cancelQueuedId(s1.id, m1)
      const opId2 = SessionOperation.cancelQueuedId(s2.id, m2)
      const rec1: SessionOperation.FailureRecord = {
        opId: opId1,
        opKind: "cancelQueued",
        outcome: "in-flight",
        code: "cancelQueued.inflight",
        message: "inflight",
        time: Date.now(),
      }
      const meta1: SessionOperation.CancelQueuedMeta = {
        idempotencyHash: hash,
        requestId: "req1",
        directory: "/project",
        messageId: m1,
        parentSessionId: null,
        configVersion: null,
        sessionRevision: null,
        cancelled: null,
      }
      const rec2: SessionOperation.FailureRecord = {
        opId: opId2,
        opKind: "cancelQueued",
        outcome: "in-flight",
        code: "cancelQueued.inflight",
        message: "inflight",
        time: Date.now(),
      }
      const meta2: SessionOperation.CancelQueuedMeta = {
        idempotencyHash: hash,
        requestId: "req2",
        directory: "/project",
        messageId: m2,
        parentSessionId: null,
        configVersion: null,
        sessionRevision: null,
        cancelled: null,
      }
      yield* db.transaction((tx) => SessionOperation.insertCancelQueuedInFlightTx(tx as unknown as typeof db, s1.id, rec1, meta1))
      yield* db.transaction((tx) => SessionOperation.insertCancelQueuedInFlightTx(tx as unknown as typeof db, s2.id, rec2, meta2))
      const f1 = yield* SessionOperation.getByIdempotencyHash(db, s1.id, hash)
      const f2 = yield* SessionOperation.getByIdempotencyHash(db, s2.id, hash)
      expect(f1).toBeDefined()
      expect(f2).toBeDefined()
      expect(f1!.opId).toBe(opId1)
      expect(f2!.opId).toBe(opId2)
    }),
  )

  it.effect("terminal false increments revision exactly once more (2 total) and true would be 2 more", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const msg = "msg_rev"
      const opId = SessionOperation.cancelQueuedId(s.id, msg)
      const hash = SessionOperation.hashIdempotencyKey("rev-test")
      const rec: SessionOperation.FailureRecord = {
        opId,
        opKind: "cancelQueued",
        outcome: "in-flight",
        code: "cancelQueued.inflight",
        message: "inflight",
        time: Date.now(),
      }
      const meta: SessionOperation.CancelQueuedMeta = {
        idempotencyHash: hash,
        requestId: "req",
        directory: "/project",
        messageId: msg,
        parentSessionId: null,
        configVersion: null,
        sessionRevision: null,
        cancelled: null,
      }
      yield* db.transaction((tx) => SessionOperation.insertCancelQueuedInFlightTx(tx as unknown as typeof db, s.id, rec, meta))
      const rev1 = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, s.id)).get().pipe(Effect.orDie)
      expect(rev1!.rev).toBe(1)
      yield* db.transaction((tx) => SessionOperation.updateCancelQueuedTerminalTx(tx as unknown as typeof db, s.id, opId, false, Date.now()))
      const rev2 = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, s.id)).get().pipe(Effect.orDie)
      expect(rev2!.rev).toBe(2)
    }),
  )

  it.effect("provider operation still persisted via generic put without idempotency", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const opId = SessionOperation.providerId("msg_prov", 0)
      const rec: SessionOperation.FailureRecord = {
        opId,
        opKind: "provider",
        outcome: "failed",
        code: "provider.http",
        message: "http error",
        time: Date.now(),
      }
      const stored = yield* SessionOperation.put(db, s.id, rec)
      expect(stored.opId).toBe(opId)
      expect(stored.opKind).toBe("provider")
      const fetched = yield* SessionOperation.get(db, opId)
      expect(fetched).toBeDefined()
      expect(fetched!.code).toBe("provider.http")
    }),
  )
})
