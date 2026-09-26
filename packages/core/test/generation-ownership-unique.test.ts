import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
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
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import memberUniqueMigration from "@opencode-ai/core/database/migration/20260926000003_add_generation_member_unique"

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

async function freshFile(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "gen-own-unique-"))
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

const runExit = <A>(self: Effect.Effect<A, unknown, unknown>) => Effect.exit(self) as Effect.Effect<Exit.Exit<A, unknown>>

describe("generation prompt ownership invariant", () => {
  test("begin duplicate across generations dies with no orphan owner", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_dup_begin"))
          const first = yield* SessionGeneration.begin(db, sid, "gen_dup_a", "msg_dup_begin", 2)
          expect(first).toEqual({ created: true, added: SessionOperation.promptId("msg_dup_begin") })
          // Same-gen re-begin stays idempotent, not a conflict.
          const same = yield* SessionGeneration.begin(db, sid, "gen_dup_a", "msg_dup_begin", 2)
          expect(same).toEqual({ created: false, empty: false })
          // Brand-new owner with the same accepted prompt must die before any owner insert.
          const exit = yield* runExit(SessionGeneration.begin(db, sid, "gen_dup_b", "msg_dup_begin", 2))
          expect(exit._tag).toBe("Failure")
          expect(yield* SessionGeneration.getOwner(db, "gen_dup_b")).toBeUndefined()
          expect((yield* SessionGeneration.listMembers(db, "gen_dup_a")).map((m) => m.promptOpID)).toEqual([
            SessionOperation.promptId("msg_dup_begin"),
          ])
          expect(yield* SessionGeneration.listMembers(db, "gen_dup_b")).toEqual([])
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("add duplicate across generations dies with no partial mutation", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          for (const m of ["msg_add_a", "msg_add_b", "msg_add_c"]) {
            yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId(m))
          }
          yield* SessionGeneration.begin(db, sid, "gen_add_a", "msg_add_a", 2)
          yield* SessionGeneration.begin(db, sid, "gen_add_b", "msg_add_b", 2)
          // Same-gen add of an existing member stays skip-only.
          const same = yield* SessionGeneration.add(db, sid, "gen_add_a", ["msg_add_a"])
          expect(same.added).toEqual([])
          // Cross-gen add of an accepted prompt dies; the batch inserts nothing.
          const exit = yield* runExit(SessionGeneration.add(db, sid, "gen_add_b", ["msg_add_c", "msg_add_a"]))
          expect(exit._tag).toBe("Failure")
          expect((yield* SessionGeneration.listMembers(db, "gen_add_a")).map((m) => m.promptOpID)).toEqual([
            SessionOperation.promptId("msg_add_a"),
          ])
          expect((yield* SessionGeneration.listMembers(db, "gen_add_b")).map((m) => m.promptOpID)).toEqual([
            SessionOperation.promptId("msg_add_b"),
          ])
          // Terminal/synthetic rows still skip without triggering the guard.
          yield* SessionOperation.put(db, sid, {
            opId: SessionOperation.promptId("msg_add_c"),
            opKind: "prompt",
            outcome: "succeeded",
            code: "prompt.succeeded",
            message: "ok",
            time: Date.now(),
          })
          const skipped = yield* SessionGeneration.add(db, sid, "gen_add_b", ["msg_add_c", "msg_synth_missing"])
          expect(skipped.added).toEqual([])
          expect(skipped.skipped.sort()).toEqual(
            [SessionOperation.promptId("msg_add_c"), SessionOperation.promptId("msg_synth_missing")].sort(),
          )
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("closed prior owner still fails closed on duplicate begin", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_closed_dup"))
          yield* SessionGeneration.begin(db, sid, "gen_closed_a", "msg_closed_dup", 2)
          yield* SessionGeneration.close(db, sid, "gen_closed_a", "completed")
          expect((yield* SessionGeneration.getOwner(db, "gen_closed_a"))?.reason).toBe("completed")
          const exit = yield* runExit(SessionGeneration.begin(db, sid, "gen_closed_b", "msg_closed_dup", 2))
          expect(exit._tag).toBe("Failure")
          expect(yield* SessionGeneration.getOwner(db, "gen_closed_b")).toBeUndefined()
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("concurrent duplicate begins leave exactly one membership and no orphan owner", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          yield* SessionOperation.ensurePromptInFlight(db, sid, SessionOperation.promptId("msg_race_dup"))
          const exits = yield* Effect.all(
            [
              runExit(SessionGeneration.begin(db, sid, "gen_race_a", "msg_race_dup", 2)),
              runExit(SessionGeneration.begin(db, sid, "gen_race_b", "msg_race_dup", 2)),
            ],
            { concurrency: "unbounded" },
          )
          const wins = exits.filter((e) => e._tag === "Success")
          const fails = exits.filter((e) => e._tag === "Failure")
          expect(wins.length).toBe(1)
          expect(fails.length).toBe(1)
          const members = (yield* (db as any).all(sql`SELECT gen_id, prompt_op_id FROM session_generation_member WHERE prompt_op_id = ${SessionOperation.promptId("msg_race_dup")}`).pipe(Effect.orDie)) as {
            gen_id: string
          }[]
          expect(members.length).toBe(1)
          const winner = members[0]!.gen_id
          const loser = winner === "gen_race_a" ? "gen_race_b" : "gen_race_a"
          expect(yield* SessionGeneration.getOwner(db, winner)).toBeDefined()
          expect(yield* SessionGeneration.getOwner(db, loser)).toBeUndefined()
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("legacy duplicate DB upgrade fails closed with no dedup", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as string
          yield* SessionOperation.ensurePromptInFlight(db, sid as never, SessionOperation.promptId("msg_legacy_dup"))
          // Bypass guards to plant a legacy duplicate spanning two generations:
          // drop the new UNIQUE guard first so raw inserts can reproduce the
          // pre-migration shape, then restore the legacy non-unique index.
          yield* (db as any).run(sql`DROP INDEX IF EXISTS "session_generation_member_op_idx"`).pipe(Effect.orDie)
          const now = Date.now()
          for (const gen of ["gen_legacy_a", "gen_legacy_b"]) {
            yield* (db as any).run(
              sql`INSERT INTO session_generation_owner (gen_id, session_id, occurrence_time, retry_limit, retry_consumed) VALUES (${gen}, ${sid}, ${now}, 2, 0)`,
            ).pipe(Effect.orDie)
            yield* (db as any).run(
              sql`INSERT INTO session_generation_member (gen_id, prompt_op_id, session_id, added_time) VALUES (${gen}, ${SessionOperation.promptId("msg_legacy_dup")}, ${sid}, ${now})`,
            ).pipe(Effect.orDie)
          }
          yield* (db as any).run(sql`DROP INDEX IF EXISTS "session_generation_member_op_idx"`).pipe(Effect.orDie)
          yield* (db as any).run(
            sql`CREATE INDEX IF NOT EXISTS "session_generation_member_op_idx" ON "session_generation_member" ("prompt_op_id")`,
          ).pipe(Effect.orDie)
          yield* (db as any).run(sql`DELETE FROM migration WHERE id = '20260926000003_add_generation_member_unique'`).pipe(Effect.orDie)
          const before = (yield* (db as any).all(sql`SELECT gen_id FROM session_generation_member WHERE prompt_op_id = ${SessionOperation.promptId("msg_legacy_dup")} ORDER BY gen_id`).pipe(Effect.orDie)) as {
            gen_id: string
          }[]
          expect(before.map((r) => r.gen_id)).toEqual(["gen_legacy_a", "gen_legacy_b"])
          const exit = yield* runExit(DatabaseMigration.applyOnly(db as never, [memberUniqueMigration as never]))
          expect(exit._tag).toBe("Failure")
          // Fail-closed: no dedup, both rows survive, no unique index enforced.
          const after = (yield* (db as any).all(sql`SELECT gen_id FROM session_generation_member WHERE prompt_op_id = ${SessionOperation.promptId("msg_legacy_dup")} ORDER BY gen_id`).pipe(Effect.orDie)) as {
            gen_id: string
          }[]
          expect(after.map((r) => r.gen_id)).toEqual(["gen_legacy_a", "gen_legacy_b"])
          const flags = (yield* (db as any).all(sql`SELECT name, "unique" AS uniqueFlag FROM pragma_index_list('session_generation_member')`).pipe(Effect.orDie)) as {
            name: string
            uniqueFlag: number
          }[]
          const opIdx = flags.find((f) => f.name === "session_generation_member_op_idx")
          expect(opIdx?.uniqueFlag).toBe(0)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("single-owner terminal still records its receipt (no lost receipt, no ambiguity)", async () => {
    const { dir, file } = await freshFile()
    try {
      await withStack(file, ({ db, svc }) =>
        Effect.gen(function* () {
          yield* setupProject(db)
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } }).pipe(Effect.orDie)
          const sid = s.id as never
          const op = SessionOperation.promptId("msg_receipt_single")
          yield* SessionOperation.ensurePromptInFlight(db, sid, op)
          yield* SessionGeneration.begin(db, sid, "gen_receipt_single", "msg_receipt_single", 2)
          const at = Date.now()
          const res = yield* SessionOperation.tryTransitionPromptTerminal(
            db,
            sid,
            SessionOperation.generationTerminal({ opId: op, outcome: "succeeded", code: "prompt.succeeded", message: "ok", time: at }),
          )
          expect(res.applied).toBe(true)
          const receipt = yield* SessionOperation.getReceipt(db, op)
          expect(receipt?.genID).toBe("gen_receipt_single")
          expect(receipt?.outcome).toBe("succeeded")
          expect(receipt?.time).toBe(at)
          // Declared + migrated member op index is unique.
          const flags = (yield* (db as any).all(sql`SELECT name, "unique" AS uniqueFlag FROM pragma_index_list('session_generation_member')`).pipe(Effect.orDie)) as {
            name: string
            uniqueFlag: number
          }[]
          expect(flags.find((f) => f.name === "session_generation_member_op_idx")?.uniqueFlag).toBe(1)
          const cols = (yield* (db as any).all(sql`SELECT gen_id, prompt_op_id FROM session_generation_member WHERE prompt_op_id = ${op}`).pipe(Effect.orDie)) as unknown[]
          expect(cols.length).toBe(1)
        }),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
