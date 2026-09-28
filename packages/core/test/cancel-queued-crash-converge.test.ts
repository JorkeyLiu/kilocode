import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Exit } from "effect"
import { Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Project } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionOperation } from "@opencode-ai/core/session/operation"

function stack(file: string) {
  const database = Database.layerNoLease(file)
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
  return Layer.mergeAll(database, events, projects, projector, store, SessionExecution.noopLayer, sessions)
}

async function freshFile() {
  const dir = await mkdtemp(join(tmpdir(), "cancel-crash-"))
  return { dir, file: join(dir, "kilo.db") }
}

function withStack<A>(
  file: string,
  fn: (env: { db: Database.Interface["db"]; svc: any }) => Effect.Effect<A, unknown, unknown>,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(stack(file))
        const db = Context.get(ctx, Database.Service).db
        const svc = Context.get(ctx, SessionV2.Service) as any
        return yield* fn({ db, svc })
      }),
    ) as Effect.Effect<A>,
  )
}

const setupProject = (db: Database.Interface["db"]) =>
  db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)

const feedRows = (db: Database.Interface["db"]) =>
  db
    .select({ seq: SessionChangefeedTable.seq, kind: SessionChangefeedTable.kind })
    .from(SessionChangefeedTable)
    .all()
    .pipe(Effect.orDie)

const revisionOf = (db: Database.Interface["db"], sid: string) =>
  db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, sid as never)).get().pipe(Effect.orDie)

describe("cancelQueued crash convergence", () => {
  test("valid orphan converges to ambiguous unknown, one revision+changed, no generation", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const msg = "msg_orphan_1"
          const opId = SessionOperation.cancelQueuedId(s.id, msg)
          const hash = SessionOperation.hashIdempotencyKey("idem-orphan-1")
          yield* db.transaction((tx) =>
            SessionOperation.insertCancelQueuedInFlightTx(tx as never, s.id, {
              opId,
              opKind: "cancelQueued",
              outcome: "in-flight",
              code: "cancelQueued.inflight",
              message: "cancelQueued in-flight",
              time: Date.now(),
            }, {
              idempotencyHash: hash,
              requestId: "req-orphan-1",
              directory: "/project",
              messageId: msg,
              parentSessionId: null,
              configVersion: null,
              sessionRevision: null,
              cancelled: null,
            }),
          )
          const feed = (yield* feedRows(db)) as { seq: number; kind: string }[]
          const rev = (yield* revisionOf(db, s.id as string)) as { rev: number }
          return { sid: s.id as string, opId, hash, feed: feed.length, rev: rev.rev }
        }),
      )
      await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const before = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(before).toBe(ids.feed)
          const beforeRev = ((yield* revisionOf(db, ids.sid)) as { rev: number }).rev
          expect(beforeRev).toBe(ids.rev)
          const res = yield* SessionOperation.convergeOrphanedInFlight(db).pipe(
            Effect.map((x) => ({ ok: true as const, x })),
            Effect.catch((f) => Effect.succeed({ ok: false as const, f: f as SessionOperation.ConvergeOrphanedFailure })),
          )
          expect(res.ok).toBe(true)
          if (!res.ok) return
          expect(res.x.converged).toEqual([ids.opId])
          expect(res.x.raced).toEqual([])
          const rec = yield* SessionOperation.get(db, ids.opId)
          expect(rec?.outcome).toBe("ambiguous")
          expect(rec?.code).toBe(SessionOperation.CANCEL_QUEUED_CRASH_CONVERGE_CODE)
          expect(rec?.message).toBe(SessionOperation.CANCEL_QUEUED_CRASH_CONVERGE_MESSAGE)
          expect(rec?.opKind).toBe("cancelQueued")
          const stored = yield* SessionOperation.getByIdempotencyHash(db, ids.sid as never, ids.hash)
          expect(stored?.outcome).toBe("ambiguous")
          expect(stored?.meta.cancelled).toBeNull()
          const afterRev = ((yield* revisionOf(db, ids.sid)) as { rev: number }).rev
          expect(afterRev - beforeRev).toBe(1)
          const after = (yield* feedRows(db)) as { seq: number; kind: string }[]
          expect(after.length - before).toBe(1)
          expect(after.slice(before).map((r) => r.kind)).toEqual(["changed"])
          expect(yield* SessionOperation.getReceipt(db, ids.opId)).toBeUndefined()
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("repeated sweep is no-op with no duplicate revision or feed", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const msg = "msg_repeat_1"
          const opId = SessionOperation.cancelQueuedId(s.id, msg)
          const hash = SessionOperation.hashIdempotencyKey("idem-repeat-1")
          yield* db.transaction((tx) =>
            SessionOperation.insertCancelQueuedInFlightTx(tx as never, s.id, {
              opId,
              opKind: "cancelQueued",
              outcome: "in-flight",
              code: "cancelQueued.inflight",
              message: "cancelQueued in-flight",
              time: Date.now(),
            }, {
              idempotencyHash: hash,
              requestId: "req-repeat-1",
              directory: "/project",
              messageId: msg,
              parentSessionId: null,
              configVersion: null,
              sessionRevision: null,
              cancelled: null,
            }),
          )
          return { sid: s.id as string, opId }
        }),
      )
      await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const first = yield* SessionOperation.convergeOrphanedInFlight(db).pipe(Effect.orDie)
          expect(first.converged).toEqual([ids.opId])
          const midFeed = ((yield* feedRows(db)) as { seq: number }[]).length
          const midRev = ((yield* revisionOf(db, ids.sid)) as { rev: number }).rev
          const second = yield* SessionOperation.convergeOrphanedInFlight(db).pipe(Effect.orDie)
          expect(second).toEqual({ converged: [], raced: [], skipped: [] })
          const finFeed = ((yield* feedRows(db)) as { seq: number }[]).length
          expect(finFeed).toBe(midFeed)
          const finRev = ((yield* revisionOf(db, ids.sid)) as { rev: number }).rev
          expect(finRev).toBe(midRev)
          const rec = yield* SessionOperation.get(db, ids.opId)
          expect(rec?.outcome).toBe("ambiguous")
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("invalid row refuses gate but valid orphan still lands, no silent replay", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const msg = "msg_valid_1"
          const good = SessionOperation.cancelQueuedId(s.id, msg)
          const hash = SessionOperation.hashIdempotencyKey("idem-valid-1")
          yield* db.transaction((tx) =>
            SessionOperation.insertCancelQueuedInFlightTx(tx as never, s.id, {
              opId: good,
              opKind: "cancelQueued",
              outcome: "in-flight",
              code: "cancelQueued.inflight",
              message: "cancelQueued in-flight",
              time: Date.now(),
            }, {
              idempotencyHash: hash,
              requestId: "req-valid-1",
              directory: "/project",
              messageId: msg,
              parentSessionId: null,
              configVersion: null,
              sessionRevision: null,
              cancelled: null,
            }),
          )
          const bad = "bad-op-id-without-colon"
          yield* db
            .insert(SessionOperationTable)
            .values({
              op_id: bad,
              session_id: s.id,
              op_kind: "cancelQueued",
              outcome: "in-flight",
              code: "cancelQueued.inflight",
              message: "poison",
              time: Date.now(),
              revision: 0,
              idempotency_hash: SessionOperation.hashIdempotencyKey("idem-bad"),
              request_id: "req-bad",
              directory: "/project",
              message_id: "msg_bad",
            })
            .run()
            .pipe(Effect.orDie)
          const feed = (yield* feedRows(db)) as { seq: number }[]
          return { sid: s.id as string, good, bad, feed: feed.length }
        }),
      )
      await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const before = ((yield* feedRows(db)) as { seq: number }[]).length
          expect(before).toBe(ids.feed)
          const res = yield* SessionOperation.convergeOrphanedInFlight(db).pipe(
            Effect.map((x) => ({ ok: true as const, x })),
            Effect.catch((f) => Effect.succeed({ ok: false as const, f: f as SessionOperation.ConvergeOrphanedFailure })),
          )
          expect(res.ok).toBe(false)
          if (res.ok) return
          expect(res.f.opIds).toEqual([ids.bad])
          expect(res.f.converged).toEqual([ids.good])
          const goodRec = yield* SessionOperation.get(db, ids.good)
          expect(goodRec?.outcome).toBe("ambiguous")
          expect(goodRec?.code).toBe(SessionOperation.CANCEL_QUEUED_CRASH_CONVERGE_CODE)
          const after = ((yield* feedRows(db)) as { seq: number }[]).length
          expect(after - before).toBe(1)
          const again = yield* SessionOperation.convergeOrphanedCancelQueuedInFlight(db).pipe(
            Effect.map((x) => ({ ok: true as const, x })),
            Effect.catch((f) => Effect.succeed({ ok: false as const, f: f as SessionOperation.ConvergeOrphanedFailure })),
          )
          expect(again.ok).toBe(false)
          const fin = ((yield* feedRows(db)) as { seq: number }[]).length
          expect(fin).toBe(after)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("cross-scope opId session mismatch refuses gate", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const other = "ses_other_000000000000000000000001"
          const cross = SessionOperation.cancelQueuedId(other, "msg_cross_1")
          yield* db
            .insert(SessionOperationTable)
            .values({
              op_id: cross,
              session_id: s.id,
              op_kind: "cancelQueued",
              outcome: "in-flight",
              code: "cancelQueued.inflight",
              message: "cross",
              time: Date.now(),
              revision: 0,
              idempotency_hash: SessionOperation.hashIdempotencyKey("idem-cross"),
              request_id: "req-cross",
              directory: "/project",
              message_id: "msg_cross_1",
            })
            .run()
            .pipe(Effect.orDie)
          return { cross }
        }),
      )
      await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const res = yield* SessionOperation.convergeOrphanedInFlight(db).pipe(
            Effect.map((x) => ({ ok: true as const, x })),
            Effect.catch((f) => Effect.succeed({ ok: false as const, f: f as SessionOperation.ConvergeOrphanedFailure })),
          )
          expect(res.ok).toBe(false)
          if (res.ok) return
          expect(res.f.opIds).toEqual([ids.cross])
          expect(res.f.converged).toEqual([])
          const rec = yield* SessionOperation.get(db, ids.cross)
          expect(rec?.outcome).toBe("in-flight")
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("normal succeeded terminal is untouched by sweep", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const msg = "msg_ok_1"
          const opId = SessionOperation.cancelQueuedId(s.id, msg)
          const hash = SessionOperation.hashIdempotencyKey("idem-ok-1")
          yield* db.transaction((tx) =>
            SessionOperation.insertCancelQueuedInFlightTx(tx as never, s.id, {
              opId,
              opKind: "cancelQueued",
              outcome: "in-flight",
              code: "cancelQueued.inflight",
              message: "cancelQueued in-flight",
              time: Date.now(),
            }, {
              idempotencyHash: hash,
              requestId: "req-ok-1",
              directory: "/project",
              messageId: msg,
              parentSessionId: null,
              configVersion: null,
              sessionRevision: null,
              cancelled: null,
            }),
          )
          yield* db.transaction((tx) =>
            SessionOperation.updateCancelQueuedTerminalTx(tx as never, s.id, opId, true, Date.now()),
          )
          const feed = (yield* feedRows(db)) as { seq: number }[]
          return { sid: s.id as string, opId, feed: feed.length }
        }),
      )
      await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const before = ((yield* feedRows(db)) as { seq: number }[]).length
          expect(before).toBe(ids.feed)
          const res = yield* SessionOperation.convergeOrphanedInFlight(db).pipe(Effect.orDie)
          expect(res).toEqual({ converged: [], raced: [], skipped: [] })
          const after = ((yield* feedRows(db)) as { seq: number }[]).length
          expect(after).toBe(before)
          const rec = yield* SessionOperation.get(db, ids.opId)
          expect(rec?.outcome).toBe("succeeded")
          expect(rec?.code).toBe("cancelQueued.succeeded")
          const stored = yield* SessionOperation.getByIdempotencyHash(db, ids.sid as never, SessionOperation.hashIdempotencyKey("idem-ok-1"))
          expect(stored?.meta.cancelled).toBe(true)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("combined prompt+provider+cancelQueued gate converges all three with exact feed", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const promptOp = SessionOperation.promptId("msg_gate_all")
          yield* SessionOperation.ensurePromptInFlight(db, s.id as never, promptOp)
          const provOp = SessionOperation.providerId("msg_gate_all", 0)
          yield* SessionOperation.put(db, s.id as never, {
            opId: provOp,
            opKind: "provider",
            outcome: "in-flight",
            code: "provider.inflight",
            message: "provider accepted",
            time: Date.now(),
          })
          const cancelMsg = "msg_gate_cancel"
          const cancelOp = SessionOperation.cancelQueuedId(s.id, cancelMsg)
          const cancelHash = SessionOperation.hashIdempotencyKey("idem-gate-all")
          yield* db.transaction((tx) =>
            SessionOperation.insertCancelQueuedInFlightTx(tx as never, s.id, {
              opId: cancelOp,
              opKind: "cancelQueued",
              outcome: "in-flight",
              code: "cancelQueued.inflight",
              message: "cancelQueued in-flight",
              time: Date.now(),
            }, {
              idempotencyHash: cancelHash,
              requestId: "req-gate-all",
              directory: "/project",
              messageId: cancelMsg,
              parentSessionId: null,
              configVersion: null,
              sessionRevision: null,
              cancelled: null,
            }),
          )
          const feed = (yield* feedRows(db)) as { seq: number; kind: string }[]
          return { sid: s.id as string, promptOp, provOp, cancelOp, feed: feed.length }
        }),
      )
      await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const before = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(before).toBe(ids.feed)
          const res = yield* SessionOperation.convergeOrphanedInFlight(db).pipe(Effect.orDie)
          expect(res.converged.sort()).toEqual([ids.promptOp, ids.provOp, ids.cancelOp].sort())
          expect(res.raced).toEqual([])
          const promptRec = yield* SessionOperation.get(db, ids.promptOp)
          expect(promptRec?.outcome).toBe("abandoned")
          const provRec = yield* SessionOperation.get(db, ids.provOp)
          expect(provRec?.outcome).toBe("abandoned")
          const cancelRec = yield* SessionOperation.get(db, ids.cancelOp)
          expect(cancelRec?.outcome).toBe("ambiguous")
          expect(cancelRec?.code).toBe(SessionOperation.CANCEL_QUEUED_CRASH_CONVERGE_CODE)
          const after = (yield* feedRows(db)) as { seq: number; kind: string }[]
          expect(after.length - before).toBe(4)
          expect(after.slice(before).map((r) => r.kind).sort()).toEqual(["changed", "changed", "changed", "generation"])
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
