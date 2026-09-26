// @ts-nocheck
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import migrationIntent from "@opencode-ai/core/database/migration/20260925000001_add_generation_retry_intent"
import migrationOccurrence from "@opencode-ai/core/database/migration/20260926000001_add_generation_retry_occurrence"
import { Project } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { EventV2 } from "@opencode-ai/core/event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionGeneration } from "@opencode-ai/core/session/generation"
import { tmpdir } from "./fixture/tmpdir"

function stack(database: any) {
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projects = Layer.succeed(
    Project.Service,
    Project.Service.of({
      resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
      directories: () => Effect.succeed([]),
      commit: () => Effect.void,
    }),
  )
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const sessions = SessionV2.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(store),
    Layer.provide(projects),
    Layer.provide(SessionExecution.noopLayer),
  )
  return Layer.mergeAll(
    database,
    events,
    projects,
    SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database)),
    store,
    SessionExecution.noopLayer,
    sessions,
  )
}

describe("generation retry intent successor migration", () => {
  test("fresh install has retry columns with CHECK and charge works", async () => {
    const program = Effect.gen(function* () {
      const database = Database.layerFromPath(":memory:")
      const layer = stack(database)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const cols: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_generation_owner')`).pipe(Effect.orDie as any)
          const names = cols.map((c: any) => c.name)
          expect(names).toContain("retry_layer")
          expect(names).toContain("retry_occurrence_time")
          expect(names).toContain("retry_next_at")
          // CHECK rejects an invalid layer on fresh schema.
          const svc = yield* SessionV2.Service
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } } as any)
          yield* SessionOperation.ensurePromptInFlight(db as any, s.id, SessionOperation.promptId("msg_fresh_intent"))
          const gen = `gen_fresh_intent_${Date.now()}`
          yield* SessionGeneration.begin(db as any, s.id, gen, "msg_fresh_intent", 2).pipe(Effect.orDie as any)
          const bad: any = yield* (db as any)
            .run(sql`UPDATE "session_generation_owner" SET "retry_layer" = 'nope' WHERE "gen_id" = ${gen}`)
            .pipe(Effect.exit as any)
          expect(bad._tag).toBe("Failure")
          // New atomic charge persists layer plus occurrence plus nextAt.
          const at = Date.now()
          const nextAt = at + 1000
          const c1: any = yield* SessionGeneration.charge(db as any, s.id, gen, { layer: "provider", occurrenceTime: at, nextAt }).pipe(Effect.orDie as any)
          expect(c1).toEqual({ charged: true, used: 1, limit: 2, missing: false, closed: false, exhausted: false, layer: "provider", occurrenceTime: at, nextAt })
          const owner: any = yield* SessionGeneration.getOwner(db as any, gen).pipe(Effect.orDie as any)
          expect(owner?.used).toBe(1)
          expect(owner?.layer).toBe("provider")
          expect(owner?.retryOccurrence).toBe(at)
          expect(owner?.nextAt).toBe(nextAt)
          // Rerun successor directly is idempotent and preserves the charged intent.
          yield* (db as any).transaction((tx: any) => (migrationIntent as any).up(tx)).pipe(Effect.orDie as any)
          yield* (db as any).transaction((tx: any) => (migrationOccurrence as any).up(tx)).pipe(Effect.orDie as any)
          yield* DatabaseMigration.applyOnly(db as any, [migrationIntent as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
          yield* DatabaseMigration.applyOnly(db as any, [migrationOccurrence as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
          const kept: any = yield* SessionGeneration.getOwner(db as any, gen).pipe(Effect.orDie as any)
          expect(kept?.used).toBe(1)
          expect(kept?.layer).toBe("provider")
          expect(kept?.retryOccurrence).toBe(at)
          expect(kept?.nextAt).toBe(nextAt)
          // Terminal close clears pending nextAt but retains layer and occurrence provenance.
          yield* SessionGeneration.close(db as any, s.id, gen, "completed").pipe(Effect.orDie as any)
          const closed: any = yield* SessionGeneration.getOwner(db as any, gen).pipe(Effect.orDie as any)
          expect(closed?.reason).toBe("completed")
          expect(closed?.used).toBe(1)
          expect(closed?.layer).toBe("provider")
          expect(closed?.retryOccurrence).toBe(at)
          expect(closed?.nextAt).toBeNull()
        }).pipe(Effect.provide(layer)),
      )
    })
    await (Effect as any).runPromise(program as any)
  })

  test("upgrade from executed old owner schema preserves rows and enables charge", async () => {
    const program = Effect.gen(function* () {
      const database = Database.layerFromPath(":memory:")
      const layer = stack(database)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const svc = yield* SessionV2.Service
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } } as any)
          yield* SessionOperation.ensurePromptInFlight(db as any, s.id, SessionOperation.promptId("msg_legacy_intent"))
          yield* SessionOperation.ensurePromptInFlight(db as any, s.id, SessionOperation.promptId("msg_legacy_closed"))

          // Recreate the already-executed historical table: no retry columns.
          yield* (db as any).run(sql`ALTER TABLE "session_generation_owner" RENAME TO "_session_generation_owner_old"`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`
            CREATE TABLE "session_generation_owner" (
              "gen_id" text PRIMARY KEY NOT NULL,
              "session_id" text NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
              "occurrence_time" integer NOT NULL,
              "close_time" integer,
              "close_reason" text CHECK("close_reason" IS NULL OR "close_reason" IN ('completed','interrupted','error','crash')),
              "retry_limit" integer NOT NULL,
              "retry_consumed" integer NOT NULL DEFAULT 0
            )
          `).pipe(Effect.orDie as any)
          const openGen = `gen_legacy_open_${Date.now()}`
          const closedGen = `gen_legacy_closed_${Date.now()}`
          const openAt = 1700000000000
          const closedAt = 1700000001000
          yield* (db as any)
            .run(sql`INSERT INTO "session_generation_owner" ("gen_id", "session_id", "occurrence_time", "close_time", "close_reason", "retry_limit", "retry_consumed") VALUES (${openGen}, ${s.id}, ${openAt}, NULL, NULL, 2, 1)`)
            .pipe(Effect.orDie as any)
          yield* (db as any)
            .run(sql`INSERT INTO "session_generation_owner" ("gen_id", "session_id", "occurrence_time", "close_time", "close_reason", "retry_limit", "retry_consumed") VALUES (${closedGen}, ${s.id}, ${openAt}, ${closedAt}, 'completed', 2, 2)`)
            .pipe(Effect.orDie as any)
          yield* (db as any).run(sql`DROP TABLE "_session_generation_owner_old"`).pipe(Effect.orDie as any)
          const preCols: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_generation_owner')`).pipe(Effect.orDie as any)
          expect(preCols.map((c: any) => c.name)).not.toContain("retry_layer")
          expect(preCols.map((c: any) => c.name)).not.toContain("retry_occurrence_time")
          expect(preCols.map((c: any) => c.name)).not.toContain("retry_next_at")

          // Simulate the canonical executed journal: base recorded, successors pending.
          yield* (db as any).run(sql`DELETE FROM ${sql.identifier("migration")} WHERE id = ${(migrationIntent as any).id}`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`DELETE FROM ${sql.identifier("migration")} WHERE id = ${(migrationOccurrence as any).id}`).pipe(Effect.orDie as any)
          const pending: any = yield* (db as any).get(sql`SELECT id FROM ${sql.identifier("migration")} WHERE id = ${(migrationIntent as any).id}`).pipe(Effect.orDie as any)
          expect(pending == null).toBe(true)

          // Upgrade through the real journal runner (normal gate, no drain bypass).
          yield* DatabaseMigration.applyOnly(db as any, [migrationIntent as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
          yield* DatabaseMigration.applyOnly(db as any, [migrationOccurrence as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
          const journal: any = yield* (db as any).get(sql`SELECT id, time_completed FROM ${sql.identifier("migration")} WHERE id = ${(migrationIntent as any).id}`).pipe(Effect.orDie as any)
          expect(journal?.id).toBe((migrationIntent as any).id)
          expect(typeof journal?.time_completed).toBe("number")

          const cols: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_generation_owner')`).pipe(Effect.orDie as any)
          const names = cols.map((c: any) => c.name)
          expect(names).toContain("retry_layer")
          expect(names).toContain("retry_occurrence_time")
          expect(names).toContain("retry_next_at")

          // Old rows survive with used/limit/close intact and new intent defaults null.
          const open: any = yield* SessionGeneration.getOwner(db as any, openGen).pipe(Effect.orDie as any)
          expect(open?.used).toBe(1)
          expect(open?.limit).toBe(2)
          expect(open?.reason).toBeNull()
          expect(open?.occurrence).toBe(openAt)
          expect(open?.layer).toBeNull()
          expect(open?.retryOccurrence).toBeNull()
          expect(open?.nextAt).toBeNull()
          const wasClosed: any = yield* SessionGeneration.getOwner(db as any, closedGen).pipe(Effect.orDie as any)
          expect(wasClosed?.used).toBe(2)
          expect(wasClosed?.reason).toBe("completed")
          expect(wasClosed?.closedAt).toBe(closedAt)
          expect(wasClosed?.layer).toBeNull()
          expect(wasClosed?.retryOccurrence).toBeNull()
          expect(wasClosed?.nextAt).toBeNull()

          // CHECK is enforced after upgrade: invalid layer rejected.
          const bad: any = yield* (db as any)
            .run(sql`UPDATE "session_generation_owner" SET "retry_layer" = 'nope' WHERE "gen_id" = ${openGen}`)
            .pipe(Effect.exit as any)
          expect(bad._tag).toBe("Failure")

          // New charge runs on the upgraded open row.
          const at = Date.now()
          const nextAt = at + 700
          const c1: any = yield* SessionGeneration.charge(db as any, s.id, openGen, { layer: "broker", occurrenceTime: at, nextAt }).pipe(Effect.orDie as any)
          expect(c1).toEqual({ charged: true, used: 2, limit: 2, missing: false, closed: false, exhausted: false, layer: "broker", occurrenceTime: at, nextAt })
          const intent: any = yield* SessionGeneration.getRetryIntent(db as any, openGen).pipe(Effect.orDie as any)
          expect(intent?.layer).toBe("broker")
          expect(intent?.occurrenceTime).toBe(at)
          expect(intent?.nextAt).toBe(nextAt)
          expect(intent?.replay).toBe(false)
          // Closed legacy row stays fail-closed.
          const shut: any = yield* SessionGeneration.charge(db as any, s.id, closedGen, { layer: "provider", occurrenceTime: at, nextAt: at + 10 }).pipe(Effect.orDie as any)
          expect(shut.charged).toBe(false)
          expect(shut.closed).toBe(true)

          // Rerun is idempotent and preserves data.
          yield* (db as any).transaction((tx: any) => (migrationIntent as any).up(tx)).pipe(Effect.orDie as any)
          yield* (db as any).transaction((tx: any) => (migrationOccurrence as any).up(tx)).pipe(Effect.orDie as any)
          yield* DatabaseMigration.applyOnly(db as any, [migrationIntent as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
          yield* DatabaseMigration.applyOnly(db as any, [migrationOccurrence as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
          const kept: any = yield* SessionGeneration.getOwner(db as any, openGen).pipe(Effect.orDie as any)
          expect(kept?.used).toBe(2)
          expect(kept?.layer).toBe("broker")
          expect(kept?.retryOccurrence).toBe(at)
          expect(kept?.nextAt).toBe(nextAt)
        }).pipe(Effect.provide(layer)),
      )
    })
    await (Effect as any).runPromise(program as any)
  })

  test("upgrade preserves old pending intent with null occurrence (nextAt is not failure time)", async () => {
    const program = Effect.gen(function* () {
      const database = Database.layerFromPath(":memory:")
      const layer = stack(database)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const svc = yield* SessionV2.Service
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } } as any)
          yield* SessionOperation.ensurePromptInFlight(db as any, s.id, SessionOperation.promptId("msg_legacy_pending"))
          yield* SessionOperation.ensurePromptInFlight(db as any, s.id, SessionOperation.promptId("msg_legacy_pending_closed"))

          // Recreate the already-executed historical table: no retry columns.
          yield* (db as any).run(sql`ALTER TABLE "session_generation_owner" RENAME TO "_session_generation_owner_old"`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`
            CREATE TABLE "session_generation_owner" (
              "gen_id" text PRIMARY KEY NOT NULL,
              "session_id" text NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
              "occurrence_time" integer NOT NULL,
              "close_time" integer,
              "close_reason" text CHECK("close_reason" IS NULL OR "close_reason" IN ('completed','interrupted','error','crash')),
              "retry_limit" integer NOT NULL,
              "retry_consumed" integer NOT NULL DEFAULT 0
            )
          `).pipe(Effect.orDie as any)
          const openGen = `gen_legacy_pending_${Date.now()}`
          const openAt = 1700000000000
          const pendingNext = 1700000005000
          yield* (db as any)
            .run(sql`INSERT INTO "session_generation_owner" ("gen_id", "session_id", "occurrence_time", "close_time", "close_reason", "retry_limit", "retry_consumed") VALUES (${openGen}, ${s.id}, ${openAt}, NULL, NULL, 2, 1)`)
            .pipe(Effect.orDie as any)
          yield* (db as any).run(sql`DROP TABLE "_session_generation_owner_old"`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`DELETE FROM ${sql.identifier("migration")} WHERE id = ${(migrationIntent as any).id}`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`DELETE FROM ${sql.identifier("migration")} WHERE id = ${(migrationOccurrence as any).id}`).pipe(Effect.orDie as any)

          // Apply only the intent successor: pending layer+nextAt charged
          // before retry_occurrence_time existed.
          yield* DatabaseMigration.applyOnly(db as any, [migrationIntent as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
          yield* (db as any)
            .run(sql`UPDATE "session_generation_owner" SET "retry_layer" = 'provider', "retry_next_at" = ${pendingNext} WHERE "gen_id" = ${openGen}`)
            .pipe(Effect.orDie as any)
          const midCols: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_generation_owner')`).pipe(Effect.orDie as any)
          expect(midCols.map((c: any) => c.name)).not.toContain("retry_occurrence_time")

          // Apply the occurrence successor: old pending keeps null occurrence.
          yield* DatabaseMigration.applyOnly(db as any, [migrationOccurrence as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
          const open: any = yield* SessionGeneration.getOwner(db as any, openGen).pipe(Effect.orDie as any)
          expect(open?.used).toBe(1)
          expect(open?.limit).toBe(2)
          expect(open?.reason).toBeNull()
          expect(open?.layer).toBe("provider")
          expect(open?.nextAt).toBe(pendingNext)
          expect(open?.retryOccurrence).toBeNull()
          // nextAt is the scheduled intent, never the failure time.
          const intent: any = yield* SessionGeneration.getRetryIntent(db as any, openGen).pipe(Effect.orDie as any)
          expect(intent?.layer).toBe("provider")
          expect(intent?.nextAt).toBe(pendingNext)
          expect(intent?.occurrenceTime).toBeNull()
          expect(intent?.occurrenceTime).not.toBe(pendingNext)
          expect(intent?.replay).toBe(false)

          // A new charge overwrites the legacy pending intent with the last occurrence.
          const at = Date.now()
          const nextAt = at + 700
          const c1: any = yield* SessionGeneration.charge(db as any, s.id, openGen, { layer: "broker", occurrenceTime: at, nextAt }).pipe(Effect.orDie as any)
          expect(c1).toEqual({ charged: true, used: 2, limit: 2, missing: false, closed: false, exhausted: false, layer: "broker", occurrenceTime: at, nextAt })
        }).pipe(Effect.provide(layer)),
      )
    })
    await (Effect as any).runPromise(program as any)
  })

  test("file database fresh boot plus reopen preserves intent under normal lease gate", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "gen-intent-lease.db")
    let sid: string | undefined
    let gen: string | undefined
    let at = 0
    let nextAt = 0
    {
      const database = Database.layerFromPath(filename)
      const layer = stack(database)
      const program = Effect.gen(function* () {
        const { db } = yield* Database.Service
        const svc = yield* SessionV2.Service
        const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } } as any)
        sid = s.id
        yield* SessionOperation.ensurePromptInFlight(db as any, s.id, SessionOperation.promptId("msg_file_intent"))
        gen = `gen_file_intent_${Date.now()}`
        yield* SessionGeneration.begin(db as any, s.id, gen, "msg_file_intent", 2).pipe(Effect.orDie as any)
        at = Date.now()
        nextAt = at + 500
        yield* SessionGeneration.charge(db as any, s.id, gen, { layer: "task", occurrenceTime: at, nextAt }).pipe(Effect.orDie as any)
      })
      await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))) as any)
    }
    {
      const database = Database.layerFromPath(filename)
      const layer = stack(database)
      const program = Effect.gen(function* () {
        const { db } = yield* Database.Service
        const owner: any = yield* SessionGeneration.getOwner(db as any, gen as string).pipe(Effect.orDie as any)
        expect(owner?.used).toBe(1)
        expect(owner?.layer).toBe("task")
        expect(owner?.retryOccurrence).toBe(at)
        expect(owner?.nextAt).toBe(nextAt)
        yield* DatabaseMigration.applyOnly(db as any, [migrationIntent as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
        yield* DatabaseMigration.applyOnly(db as any, [migrationOccurrence as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
        const kept: any = yield* SessionGeneration.getOwner(db as any, gen as string).pipe(Effect.orDie as any)
        expect(kept?.used).toBe(1)
        expect(kept?.layer).toBe("task")
        expect(kept?.retryOccurrence).toBe(at)
        expect(kept?.nextAt).toBe(nextAt)
        expect(sid).toBeDefined()
      })
      await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))) as any)
    }
  })
})
