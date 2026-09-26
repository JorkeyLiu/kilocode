import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
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
import { SessionGeneration } from "@opencode-ai/core/session/generation"

// Real file-backed SQLite scoped tests for durable generation close CAS.
// Proves BEGIN IMMEDIATE + open-only conditional close: any terminal close
// never overwrites an already-written final state, no-op emits no feed, and
// a live close vs crash sweep has exactly one winner.

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
  const dir = await mkdtemp(join(tmpdir(), "gen-close-converge-"))
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

const feedCount = (db: Database.Interface["db"]) =>
  db.select({ seq: SessionChangefeedTable.seq }).from(SessionChangefeedTable).all().pipe(Effect.orDie)

describe("generation close CAS + crash convergence winner", () => {
  test("live close vs crash sweep has a unique winner with no overwrite and no feed", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          const op = SessionOperation.promptId("msg_close_race")
          const inception = yield* SessionOperation.ensurePromptInFlight(db, sid, op)
          expect(inception.fresh).toBe(true)
          const gen = `gen_close_race_${Date.now()}`
          const begun = yield* SessionGeneration.begin(db, sid, gen, "msg_close_race", 2).pipe(Effect.orDie)
          expect(begun).toEqual({ created: true, added: op })
          const orphan = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(orphan?.reason).toBeNull()
          const before = ((yield* feedCount(db)) as unknown[]).length

          const live = SessionGeneration.close(db, sid, gen, "completed")
          const sweep = SessionGeneration.convergeOrphaned(db)
          const [liveRes, sweepRes] = yield* Effect.all([live, sweep], { concurrency: "unbounded" })
          const wins = (liveRes.applied ? 1 : 0) + sweepRes.converged.length
          expect(wins).toBe(1)
          if (liveRes.applied) {
            expect(sweepRes.converged).toEqual([])
            expect(sweepRes.raced.length <= 1).toBe(true)
            if (sweepRes.raced.length === 1) expect(sweepRes.raced).toEqual([gen])
          } else {
            expect(sweepRes.converged).toEqual([gen])
            expect(sweepRes.raced).toEqual([])
          }
          expect(sweepRes.skipped).toEqual([])

          const final = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(final?.reason).toBe(liveRes.applied ? "completed" : "crash")
          expect(final?.occurrence).toBe(orphan?.occurrence)
          expect(final?.limit).toBe(2)
          expect(final?.used).toBe(0)

          const after = ((yield* feedCount(db)) as unknown[]).length
          expect(after).toBe(before)

          const settled = yield* SessionGeneration.convergeOrphaned(db)
          expect(settled).toEqual({ converged: [], raced: [], skipped: [] })
          const rerunClose = yield* SessionGeneration.close(db, sid, gen, "error").pipe(Effect.orDie)
          expect(rerunClose).toEqual({ applied: false })
          const still = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(still?.reason).toBe(final?.reason)
          const end = ((yield* feedCount(db)) as unknown[]).length
          expect(end).toBe(before)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("close vs close with different reasons has a unique winner with no overwrite", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          const op = SessionOperation.promptId("msg_close_dual")
          yield* SessionOperation.ensurePromptInFlight(db, sid, op)
          const gen = `gen_close_dual_${Date.now()}`
          yield* SessionGeneration.begin(db, sid, gen, "msg_close_dual", 2).pipe(Effect.orDie)
          const before = ((yield* feedCount(db)) as unknown[]).length
          const [a, b] = yield* Effect.all(
            [SessionGeneration.close(db, sid, gen, "completed"), SessionGeneration.close(db, sid, gen, "error")],
            { concurrency: "unbounded" },
          )
          expect((a.applied ? 1 : 0) + (b.applied ? 1 : 0)).toBe(1)
          const final = yield* SessionGeneration.getOwner(db, gen).pipe(Effect.orDie)
          expect(final?.reason).toBe(a.applied ? "completed" : "error")
          const after = ((yield* feedCount(db)) as unknown[]).length
          expect(after).toBe(before)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
