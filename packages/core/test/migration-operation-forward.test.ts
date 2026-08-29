// @ts-nocheck
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import migrationNew from "@opencode-ai/core/database/migration/20260825000000_add_cancel_queued_metadata"
import { Project } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { EventV2 } from "@opencode-ai/core/event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { ProjectTable } from "@opencode-ai/core/project/sql"

describe("forward migration operation CHECK rebuild", () => {
  test("upgrade from old CHECK preserves rows and allows cancelQueued", async () => {
    const program = Effect.gen(function* () {
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
      const store = SessionStore.layer.pipe(Layer.provide(database))
      const sessions = SessionV2.layer.pipe(
        Layer.provide(events),
        Layer.provide(database),
        Layer.provide(store),
        Layer.provide(projects),
        Layer.provide(SessionExecution.noopLayer),
      )
      const layer = Layer.mergeAll(database, events, projects, SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database)), store, SessionExecution.noopLayer, sessions)

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const svc = yield* SessionV2.Service
          const location = { directory: AbsolutePath.make("/project") }
          const s = yield* svc.create({ location } as any)

          const opIdOld = SessionOperation.providerId("msg_old", 0)
          const rec: SessionOperation.FailureRecord = { opId: opIdOld, opKind: "provider", outcome: "succeeded", code: "c", message: "m", time: 123 }
          yield* SessionOperation.put(db as any, s.id, rec).pipe(Effect.orDie as any)

          // Downgrade operation table to old CHECK (simulate already-applied DB without cancelQueued)
          yield* (db as any).run(sql`DROP INDEX IF EXISTS "session_operation_session_idx"`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`DROP INDEX IF EXISTS "session_operation_session_kind_idx"`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`DROP INDEX IF EXISTS "session_operation_session_time_idx"`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`DROP INDEX IF EXISTS "session_operation_session_idempotency_idx"`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`DROP INDEX IF EXISTS "session_operation_message_id_idx"`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`ALTER TABLE "session_operation" RENAME TO "_session_operation_old"`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`
            CREATE TABLE "session_operation" (
              "op_id" text PRIMARY KEY NOT NULL,
              "session_id" text NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
              "op_kind" text NOT NULL CHECK("op_kind" IN ('prompt','provider','tool','permission','task')),
              "outcome" text NOT NULL CHECK("outcome" IN ('succeeded','failed','ambiguous','in-flight','superseded','abandoned')),
              "code" text NOT NULL,
              "message" text NOT NULL,
              "time" integer NOT NULL,
              "cancel" text,
              "detail" text,
              "stack" text,
              "revision" integer NOT NULL
            )
          `).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "cancel", "detail", "stack", "revision") SELECT "op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "cancel", "detail", "stack", "revision" FROM "_session_operation_old"`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`DROP TABLE "_session_operation_old"`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`CREATE INDEX "session_operation_session_idx" ON "session_operation" ("session_id")`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`CREATE INDEX "session_operation_session_kind_idx" ON "session_operation" ("session_id", "op_kind")`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`CREATE INDEX "session_operation_session_time_idx" ON "session_operation" ("session_id", "time")`).pipe(Effect.orDie as any)

          const opIdX = `cancelQueued:${s.id}:msg_x`
          const reject: any = yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision") VALUES (${opIdX}, ${s.id}, 'cancelQueued', 'succeeded', 'c', 'm', 124, 2)`).pipe(Effect.exit as any)
          expect(reject._tag).toBe("Failure")

          // Directly invoke migration up (bypass journal check) to simulate upgrade from old DB
          yield* (db as any).transaction((tx: any) => migrationNew.up(tx as any)).pipe(Effect.orDie as any)

          const rows: any = yield* (db as any).all(sql`SELECT op_id, op_kind FROM "session_operation" WHERE "session_id" = ${s.id}`).pipe(Effect.orDie as any)
          expect(rows.length).toBe(1)
          expect(rows[0].op_id).toBe(opIdOld)

          const opIdY = `cancelQueued:${s.id}:msg_y`
          const resY: any = yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision") VALUES (${opIdY}, ${s.id}, 'cancelQueued', 'succeeded', 'c', 'm', 125, 2)`).pipe(Effect.exit as any)
          expect(resY._tag).toBe("Success")
          const afterRows: any = yield* (db as any).all(sql`SELECT op_id FROM "session_operation"`).pipe(Effect.orDie as any)
          expect(afterRows.length).toBe(2)

          const cols: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation')`).pipe(Effect.orDie as any)
          const names = cols.map((c: any) => c.name)
          for (const col of ["idempotency_hash", "request_id", "directory", "message_id", "parent_session_id", "config_version", "session_revision", "cancelled"]) {
            expect(names).toContain(col)
          }
          const idx: any = yield* (db as any).all(sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_operation'`).pipe(Effect.orDie as any)
          const idxNames = idx.map((r: any) => r.name)
          expect(idxNames).toContain("session_operation_session_idempotency_idx")
          expect(idxNames).toContain("session_operation_message_id_idx")
          expect(idxNames).toContain("session_operation_session_idx")

          const badFk: any = yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision") VALUES ('provider:msg_bad:0', 'nonexistent', 'provider', 'succeeded', 'c', 'm', 126, 1)`).pipe(Effect.exit as any)
          expect(badFk._tag).toBe("Failure")

          const ddl: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
          expect(ddl.sql).toContain("cancelQueued")

          // Rerun should be idempotent (directly invoke again)
          yield* (db as any).transaction((tx: any) => migrationNew.up(tx as any)).pipe(Effect.orDie as any)
          const ddl2: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
          expect(ddl2.sql).toContain("cancelQueued")
        }).pipe(Effect.provide(layer)),
      )
    })
    await (Effect as any).runPromise(program as any)
  })

  test("fresh install has correct CHECK and rerun is idempotent", async () => {
    const program: any = Effect.gen(function* () {
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
      const store = SessionStore.layer.pipe(Layer.provide(database))
      const sessions = SessionV2.layer.pipe(
        Layer.provide(events),
        Layer.provide(database),
        Layer.provide(store),
        Layer.provide(projects),
        Layer.provide(SessionExecution.noopLayer),
      )
      const layer = Layer.mergeAll(database, events, projects, SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database)), store, SessionExecution.noopLayer, sessions)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const ddl: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
          expect(ddl.sql).toContain("cancelQueued")
          const cols: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation')`).pipe(Effect.orDie as any)
          const names = cols.map((c: any) => c.name)
          for (const col of ["idempotency_hash", "request_id", "directory", "message_id", "parent_session_id", "config_version", "session_revision", "cancelled"]) {
            expect(names).toContain(col)
          }
          yield* DatabaseMigration.applyOnly(db as any, [migrationNew as unknown as DatabaseMigration.Migration])
          const ddl2: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
          expect(ddl2.sql).toContain("cancelQueued")
          const svc2 = yield* SessionV2.Service
          const loc2 = { directory: AbsolutePath.make("/project") }
          const s = yield* svc2.create({ location: loc2 } as any)
          const opId = SessionOperation.cancelQueuedId(s.id, "msg_1" as any)
          const rec: SessionOperation.FailureRecord = { opId, opKind: "cancelQueued", outcome: "succeeded", code: "c", message: "m", time: Date.now() }
          yield* SessionOperation.put(db as any, s.id, rec).pipe(Effect.orDie as any)
          const rows: any = yield* (db as any).all(sql`SELECT op_id FROM "session_operation" WHERE "session_id" = ${s.id}`).pipe(Effect.orDie as any)
          expect(rows.length).toBe(1)
        }).pipe(Effect.provide(layer)),
      )
    })
    await (Effect as any).runPromise(program as any)
  })
})
