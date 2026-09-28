import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable } from "@opencode-ai/core/session/sql"
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
import { gateThenListen } from "../../src/cli/cmd/serve"

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
  const dir = await mkdtemp(join(tmpdir(), "serve-cancel-gate-"))
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

describe("serve cancelQueued crash gate pre-bind", () => {
  test("valid orphan converges before listen, second gate no-op", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const msg = "msg_cancel_gate_1"
          const opId = SessionOperation.cancelQueuedId(s.id, msg)
          const hash = SessionOperation.hashIdempotencyKey("idem-cancel-gate-1")
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
              requestId: "req-cancel-gate-1",
              directory: "/project",
              messageId: msg,
              parentSessionId: null,
              configVersion: null,
              sessionRevision: null,
              cancelled: null,
            }),
          )
          const feed = (yield* feedRows(db)) as { seq: number }[]
          return { sid: s.id as string, opId, feed: feed.length }
        }),
      )
      const out = await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          const before = ((yield* feedRows(db)) as { seq: number; kind: string }[]).length
          expect(before).toBe(ids.feed)
          const calls: string[] = []
          const res = yield* gateThenListen(db, async () => {
            calls.push("listen")
            const rec = await Effect.runPromise(SessionOperation.get(db, ids.opId) as Effect.Effect<any>)
            expect(rec?.outcome).toBe("ambiguous")
            expect(rec?.code).toBe(SessionOperation.CANCEL_QUEUED_CRASH_CONVERGE_CODE)
            return { fake: true as const }
          }).pipe(Effect.orDie)
          expect(calls).toEqual(["listen"])
          expect(res.sweep.converged).toEqual([ids.opId])
          const after = (yield* feedRows(db)) as { seq: number; kind: string }[]
          expect(after.length - before).toBe(1)
          expect(after.slice(before).map((r) => r.kind)).toEqual(["changed"])
          const rerun = yield* gateThenListen(db, async () => ({ fake: true as const })).pipe(Effect.orDie)
          expect(rerun.sweep).toEqual({ converged: [], raced: [], skipped: [] })
          const fin = (yield* feedRows(db)) as { seq: number }[]
          expect(fin.length).toBe(after.length)
          return true
        }),
      )
      expect(out).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("invalid cancelQueued row blocks listen, valid still lands", async () => {
    const { dir, file } = await freshFile()
    try {
      const ids = await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const msg = "msg_cancel_good"
          const good = SessionOperation.cancelQueuedId(s.id, msg)
          yield* db.transaction((tx) =>
            SessionOperation.insertCancelQueuedInFlightTx(tx as never, s.id, {
              opId: good,
              opKind: "cancelQueued",
              outcome: "in-flight",
              code: "cancelQueued.inflight",
              message: "cancelQueued in-flight",
              time: Date.now(),
            }, {
              idempotencyHash: SessionOperation.hashIdempotencyKey("idem-cancel-good"),
              requestId: "req-good",
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
          return { good, bad }
        }),
      )
      const out = await withStack(file, ({ db }) =>
        Effect.gen(function* () {
          let listened = false
          const res = yield* gateThenListen(db, async () => {
            listened = true
            return { fake: true as const }
          }).pipe(
            Effect.map((v) => ({ ok: true as const, v })),
            Effect.catch((e) => Effect.succeed({ ok: false as const, e: e as { message: string } })),
          )
          expect(res.ok).toBe(false)
          expect(listened).toBe(false)
          if (res.ok) return false
          expect(res.e.message.includes(ids.bad)).toBe(true)
          const goodRec = yield* SessionOperation.get(db, ids.good).pipe(Effect.orDie)
          expect(goodRec?.outcome).toBe("ambiguous")
          expect(goodRec?.code).toBe(SessionOperation.CANCEL_QUEUED_CRASH_CONVERGE_CODE)
          return true
        }),
      )
      expect(out).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
