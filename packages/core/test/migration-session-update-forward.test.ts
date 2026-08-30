// @ts-nocheck
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import migrationSessionUpdate from "@opencode-ai/core/database/migration/20260826000000_add_session_update_operation"
import migrationSnapshot from "@opencode-ai/core/database/migration/20260830000000_add_session_update_snapshot"
import { Project } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { EventV2 } from "@opencode-ai/core/event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionOperation } from "@opencode-ai/core/session/operation"

describe("forward migration sessionUpdate CHECK rebuild and result_snapshot", () => {
  test("upgrade from pre-sessionUpdate preserves rows, allows sessionUpdate, and snapshot rerun is safe", async () => {
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

          // Insert existing rows with rich data before downgrade
          const opIdOld = SessionOperation.providerId("msg_old", 0)
          const recOld: SessionOperation.FailureRecord = {
            opId: opIdOld,
            opKind: "provider",
            outcome: "succeeded",
            code: "c",
            message: "m",
            time: 123,
            detail: "detail-preserve",
            stack: "stack-preserve",
          }
          yield* SessionOperation.put(db as any, s.id, recOld).pipe(Effect.orDie as any)

          // Also insert a cancelQueued-style row with metadata via raw SQL to exercise column preservation
          const opIdCancel = SessionOperation.cancelQueuedId(s.id, "msg_cq")
          const hash = SessionOperation.hashIdempotencyKey(`cancelQueued:${s.id}:msg_cq`)
          yield* (db as any)
            .run(
              sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision", "idempotency_hash", "request_id", "directory", "message_id", "parent_session_id", "config_version", "session_revision", "cancelled") VALUES (${opIdCancel}, ${s.id}, 'cancelQueued', 'succeeded', 'c2', 'm2', 124, 2, ${hash}, 'req_1', '/project', 'msg_cq', NULL, 1, 1, 0)`,
            )
            .pipe(Effect.orDie as any)

          // Downgrade to pre-sessionUpdate schema: cancelQueued ERA without sessionUpdate/title/result_snapshot
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
              "op_kind" text NOT NULL CHECK("op_kind" IN ('prompt','provider','tool','permission','task','cancelQueued')),
              "outcome" text NOT NULL CHECK("outcome" IN ('succeeded','failed','ambiguous','in-flight','superseded','abandoned')),
              "code" text NOT NULL,
              "message" text NOT NULL,
              "time" integer NOT NULL,
              "cancel" text,
              "detail" text,
              "stack" text,
              "revision" integer NOT NULL,
              "idempotency_hash" text,
              "request_id" text,
              "directory" text,
              "message_id" text,
              "parent_session_id" text,
              "config_version" integer,
              "session_revision" integer,
              "cancelled" integer
            )
          `).pipe(Effect.orDie as any)
          yield* (db as any)
            .run(
              sql.raw(
                `INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "cancel", "detail", "stack", "revision", "idempotency_hash", "request_id", "directory", "message_id", "parent_session_id", "config_version", "session_revision", "cancelled") SELECT "op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "cancel", "detail", "stack", "revision", "idempotency_hash", "request_id", "directory", "message_id", "parent_session_id", "config_version", "session_revision", "cancelled" FROM "_session_operation_old"`,
              ),
            )
            .pipe(Effect.orDie as any)
          yield* (db as any).run(sql`DROP TABLE "_session_operation_old"`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`CREATE INDEX "session_operation_session_idx" ON "session_operation" ("session_id")`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`CREATE INDEX "session_operation_session_kind_idx" ON "session_operation" ("session_id", "op_kind")`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`CREATE INDEX "session_operation_session_time_idx" ON "session_operation" ("session_id", "time")`).pipe(Effect.orDie as any)
          yield* (db as any)
            .run(
              sql`CREATE UNIQUE INDEX "session_operation_session_idempotency_idx" ON "session_operation" ("session_id", "idempotency_hash") WHERE "idempotency_hash" IS NOT NULL`,
            )
            .pipe(Effect.orDie as any)
          yield* (db as any)
            .run(sql`CREATE INDEX "session_operation_message_id_idx" ON "session_operation" ("message_id") WHERE "message_id" IS NOT NULL`)
            .pipe(Effect.orDie as any)

          // Verify downgrade removed sessionUpdate and title/result_snapshot
          const colsPre: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation')`).pipe(Effect.orDie as any)
          const namesPre = colsPre.map((c: any) => c.name)
          expect(namesPre).not.toContain("title")
          expect(namesPre).not.toContain("result_snapshot")
          const ddlPre: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
          expect(ddlPre.sql).not.toContain("sessionUpdate")
          expect(ddlPre.sql).toContain("cancelQueued")

          // sessionUpdate should be rejected before migration
          const opIdX = `sessionUpdate:${s.id}:tok_x`
          const reject: any = yield* (db as any)
            .run(
              sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision") VALUES (${opIdX}, ${s.id}, 'sessionUpdate', 'succeeded', 'c', 'm', 125, 2)`,
            )
            .pipe(Effect.exit as any)
          expect(reject._tag).toBe("Failure")

          // Apply sessionUpdate migration (20260826) directly
          yield* (db as any).transaction((tx: any) => migrationSessionUpdate.up(tx as any)).pipe(Effect.orDie as any)

          // Verify preservation and new schema
          const rows: any = yield* (db as any).all(sql`SELECT op_id, op_kind, code, message, detail, stack FROM "session_operation" WHERE "session_id" = ${s.id} ORDER BY op_id`).pipe(Effect.orDie as any)
          expect(rows.length).toBe(2)
          const byId = Object.fromEntries(rows.map((r: any) => [r.op_id, r]))
          expect(byId[opIdOld].code).toBe("c")
          expect(byId[opIdOld].detail).toBe("detail-preserve")
          expect(byId[opIdOld].stack).toBe("stack-preserve")
          expect(byId[opIdCancel].op_kind).toBe("cancelQueued")

          const cols: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation')`).pipe(Effect.orDie as any)
          const names = cols.map((c: any) => c.name)
          for (const col of ["idempotency_hash", "request_id", "directory", "message_id", "parent_session_id", "config_version", "session_revision", "cancelled", "title"]) {
            expect(names).toContain(col)
          }
          expect(names).not.toContain("result_snapshot")

          const ddl: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
          expect(ddl.sql).toContain("sessionUpdate")
          expect(ddl.sql).toContain("cancelQueued")

          const idx: any = yield* (db as any).all(sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_operation'`).pipe(Effect.orDie as any)
          const idxNames = idx.map((r: any) => r.name)
          expect(idxNames).toContain("session_operation_session_idx")
          expect(idxNames).toContain("session_operation_session_kind_idx")
          expect(idxNames).toContain("session_operation_session_time_idx")
          expect(idxNames).toContain("session_operation_session_idempotency_idx")
          expect(idxNames).toContain("session_operation_message_id_idx")

          const badFk: any = yield* (db as any)
            .run(
              sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision") VALUES ('provider:msg_bad:0', 'nonexistent', 'provider', 'succeeded', 'c', 'm', 126, 1)`,
            )
            .pipe(Effect.exit as any)
          expect(badFk._tag).toBe("Failure")

          // Now sessionUpdate should succeed, with title
          const opIdY = `sessionUpdate:${s.id}:tok_y`
          const resY: any = yield* (db as any)
            .run(
              sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision", "title") VALUES (${opIdY}, ${s.id}, 'sessionUpdate', 'succeeded', 'c', 'm', 127, 3, 'new-title')`,
            )
            .pipe(Effect.exit as any)
          expect(resY._tag).toBe("Success")
          const afterRows: any = yield* (db as any).all(sql`SELECT op_id, title FROM "session_operation" WHERE "session_id" = ${s.id}`).pipe(Effect.orDie as any)
          expect(afterRows.length).toBe(3)
          const yRow = afterRows.find((r: any) => r.op_id === opIdY)
          expect(yRow.title).toBe("new-title")

          // Apply snapshot migration and verify result_snapshot column added preserving rows
          yield* (db as any).transaction((tx: any) => migrationSnapshot.up(tx as any)).pipe(Effect.orDie as any)
          const colsSnap: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation')`).pipe(Effect.orDie as any)
          const namesSnap = colsSnap.map((c: any) => c.name)
          expect(namesSnap).toContain("result_snapshot")
          expect(namesSnap).toContain("title")
          const rowsAfterSnap: any = yield* (db as any).all(sql`SELECT op_id, title, result_snapshot FROM "session_operation" WHERE "session_id" = ${s.id}`).pipe(Effect.orDie as any)
          expect(rowsAfterSnap.length).toBe(3)
          // pre-existing rows have NULL snapshot
          for (const r of rowsAfterSnap) expect(r.result_snapshot).toBeNull()

          // Verify via SessionOperation helper as well (insertSessionUpdateSucceededTx) now that snapshot column exists
          const token2 = "tok_helper"
          const opIdHelper = SessionOperation.sessionUpdateId(s.id, token2)
          const hashHelper = SessionOperation.hashIdempotencyKey(`sessionUpdate:${s.id}:${token2}`)
          const recHelper: SessionOperation.FailureRecord = {
            opId: opIdHelper,
            opKind: "sessionUpdate",
            outcome: "succeeded",
            code: "sessionUpdate.succeeded",
            message: "ok",
            time: Date.now(),
          }
          const meta = {
            idempotencyHash: hashHelper,
            requestId: "req_helper",
            directory: "/project",
            parentSessionId: null,
            configVersion: null,
            sessionRevision: null,
            title: "helper-title",
          }
          const inserted: any = yield* (db as any)
            .transaction((tx: any) => SessionOperation.insertSessionUpdateSucceededTx(tx as any, s.id, recHelper, meta as any))
            .pipe(Effect.orDie as any)
          expect(inserted.meta.title).toBe("helper-title")
          expect(inserted.resultSnapshot).toBeDefined()
          const helperRow: any = yield* (db as any).get(sql`SELECT result_snapshot, title FROM "session_operation" WHERE op_id = ${opIdHelper}`).pipe(Effect.orDie as any)
          expect(helperRow.title).toBe("helper-title")
          expect(typeof helperRow.result_snapshot).toBe("string")
          const parsed = JSON.parse(helperRow.result_snapshot)
          expect(parsed.id).toBe(s.id)
          expect(parsed.title).toBe("helper-title")

          // Rerun both migrations idempotently preserves snapshot
          yield* (db as any).transaction((tx: any) => migrationSessionUpdate.up(tx as any)).pipe(Effect.orDie as any)
          yield* (db as any).transaction((tx: any) => migrationSnapshot.up(tx as any)).pipe(Effect.orDie as any)
          const helperRow2: any = yield* (db as any).get(sql`SELECT result_snapshot FROM "session_operation" WHERE op_id = ${opIdHelper}`).pipe(Effect.orDie as any)
          expect(helperRow2.result_snapshot).toBe(helperRow.result_snapshot)
          const ddlAfterRerun: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
          expect(ddlAfterRerun.sql).toContain("sessionUpdate")
        }).pipe(Effect.provide(layer)),
      )
    })
    await (Effect as any).runPromise(program as any)
  })

  test("snapshot migration adds result_snapshot preserving rows and is idempotent, fresh install allows sessionUpdate with snapshot", async () => {
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

          // Fresh install already has both migrations; verify
          const ddlFresh: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
          expect(ddlFresh.sql).toContain("sessionUpdate")
          const colsFresh: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation')`).pipe(Effect.orDie as any)
          const namesFresh = colsFresh.map((c: any) => c.name)
          expect(namesFresh).toContain("title")
          expect(namesFresh).toContain("result_snapshot")

          // Downgrade to remove result_snapshot to simulate upgrade
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
              "op_kind" text NOT NULL CHECK("op_kind" IN ('prompt','provider','tool','permission','task','cancelQueued','sessionUpdate')),
              "outcome" text NOT NULL CHECK("outcome" IN ('succeeded','failed','ambiguous','in-flight','superseded','abandoned')),
              "code" text NOT NULL,
              "message" text NOT NULL,
              "time" integer NOT NULL,
              "cancel" text,
              "detail" text,
              "stack" text,
              "revision" integer NOT NULL,
              "idempotency_hash" text,
              "request_id" text,
              "directory" text,
              "message_id" text,
              "parent_session_id" text,
              "config_version" integer,
              "session_revision" integer,
              "cancelled" integer,
              "title" text
            )
          `).pipe(Effect.orDie as any)
          yield* (db as any)
            .run(
              sql.raw(
                `INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "cancel", "detail", "stack", "revision", "idempotency_hash", "request_id", "directory", "message_id", "parent_session_id", "config_version", "session_revision", "cancelled", "title") SELECT "op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "cancel", "detail", "stack", "revision", "idempotency_hash", "request_id", "directory", "message_id", "parent_session_id", "config_version", "session_revision", "cancelled", "title" FROM "_session_operation_old"`,
              ),
            )
            .pipe(Effect.orDie as any)
          yield* (db as any).run(sql`DROP TABLE "_session_operation_old"`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`CREATE INDEX "session_operation_session_idx" ON "session_operation" ("session_id")`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`CREATE INDEX "session_operation_session_kind_idx" ON "session_operation" ("session_id", "op_kind")`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`CREATE INDEX "session_operation_session_time_idx" ON "session_operation" ("session_id", "time")`).pipe(Effect.orDie as any)
          yield* (db as any)
            .run(sql`CREATE UNIQUE INDEX "session_operation_session_idempotency_idx" ON "session_operation" ("session_id", "idempotency_hash") WHERE "idempotency_hash" IS NOT NULL`)
            .pipe(Effect.orDie as any)
          yield* (db as any)
            .run(sql`CREATE INDEX "session_operation_message_id_idx" ON "session_operation" ("message_id") WHERE "message_id" IS NOT NULL`)
            .pipe(Effect.orDie as any)

          const colsPre: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation')`).pipe(Effect.orDie as any)
          const namesPre = colsPre.map((c: any) => c.name)
          expect(namesPre).toContain("title")
          expect(namesPre).not.toContain("result_snapshot")

          // Insert existing rows before snapshot upgrade (raw SQL to avoid ORM SELECT requiring result_snapshot column)
          const svc = yield* SessionV2.Service
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } } as any)
          const opIdPre = SessionOperation.providerId("msg_pre", 0)
          yield* (db as any)
            .run(
              sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision") VALUES (${opIdPre}, ${s.id}, 'provider', 'succeeded', 'c', 'm', 200, 1)`,
            )
            .pipe(Effect.orDie as any)
          const opIdUpdPre = `sessionUpdate:${s.id}:tok_pre`
          yield* (db as any)
            .run(
              sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision", "title") VALUES (${opIdUpdPre}, ${s.id}, 'sessionUpdate', 'succeeded', 'c', 'm', 201, 2, 'pre-title')`,
            )
            .pipe(Effect.orDie as any)

          // Apply snapshot migration
          yield* (db as any).transaction((tx: any) => migrationSnapshot.up(tx as any)).pipe(Effect.orDie as any)

          const colsAfter: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation')`).pipe(Effect.orDie as any)
          const namesAfter = colsAfter.map((c: any) => c.name)
          expect(namesAfter).toContain("result_snapshot")
          expect(namesAfter).toContain("title")

          const rows: any = yield* (db as any).all(sql`SELECT op_id, title, result_snapshot FROM "session_operation" WHERE "session_id" = ${s.id} ORDER BY op_id`).pipe(Effect.orDie as any)
          expect(rows.length).toBe(2)
          // pre-existing rows should have NULL snapshot
          const preRow = rows.find((r: any) => r.op_id === opIdPre)
          expect(preRow.result_snapshot).toBeNull()
          const updRow = rows.find((r: any) => r.op_id === opIdUpdPre)
          expect(updRow.title).toBe("pre-title")
          expect(updRow.result_snapshot).toBeNull()

          // Insert new sessionUpdate with snapshot via helper after column exists
          const token = "tok_snap"
          const opIdSnap = SessionOperation.sessionUpdateId(s.id, token)
          const hash = SessionOperation.hashIdempotencyKey(`sessionUpdate:${s.id}:${token}`)
          const recSnap: SessionOperation.FailureRecord = {
            opId: opIdSnap,
            opKind: "sessionUpdate",
            outcome: "succeeded",
            code: "sessionUpdate.succeeded",
            message: "ok",
            time: Date.now(),
          }
          const meta = {
            idempotencyHash: hash,
            requestId: "req_snap",
            directory: "/project",
            parentSessionId: null,
            configVersion: null,
            sessionRevision: null,
            title: "snap-title",
          }
          const inserted: any = yield* (db as any)
            .transaction((tx: any) => SessionOperation.insertSessionUpdateSucceededTx(tx as any, s.id, recSnap, meta as any))
            .pipe(Effect.orDie as any)
          expect(inserted.meta.title).toBe("snap-title")
          expect(inserted.resultSnapshot).toBeDefined()
          // verify snapshot JSON persisted and decodable
          const snapRow: any = yield* (db as any)
            .get(sql`SELECT result_snapshot, title FROM "session_operation" WHERE op_id = ${opIdSnap}`)
            .pipe(Effect.orDie as any)
          expect(snapRow.title).toBe("snap-title")
          expect(typeof snapRow.result_snapshot).toBe("string")
          const parsed = JSON.parse(snapRow.result_snapshot)
          expect(parsed.id).toBe(s.id)
          expect(parsed.title).toBe("snap-title")

          // Rerun snapshot migration should be safe and preserve snapshot
          yield* (db as any).transaction((tx: any) => migrationSnapshot.up(tx as any)).pipe(Effect.orDie as any)
          const snapRow2: any = yield* (db as any)
            .get(sql`SELECT result_snapshot FROM "session_operation" WHERE op_id = ${opIdSnap}`)
            .pipe(Effect.orDie as any)
          expect(snapRow2.result_snapshot).toBe(snapRow.result_snapshot)

          // Fresh install idempotency via DatabaseMigration.applyOnly
          yield* DatabaseMigration.applyOnly(db as any, [migrationSessionUpdate as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
          yield* DatabaseMigration.applyOnly(db as any, [migrationSnapshot as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
          const ddl2: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
          expect(ddl2.sql).toContain("sessionUpdate")
          const cols2: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation')`).pipe(Effect.orDie as any)
          const names2 = cols2.map((c: any) => c.name)
          expect(names2).toContain("result_snapshot")

          // applyOnly via transaction wrapper also tested implicitly
          // Verify successive sessionUpdate distinct tokens don't collide
          const tok2 = "tok_snap2"
          const opId2 = SessionOperation.sessionUpdateId(s.id, tok2)
          const hash2 = SessionOperation.hashIdempotencyKey(`sessionUpdate:${s.id}:${tok2}`)
          const rec2: SessionOperation.FailureRecord = {
            opId: opId2,
            opKind: "sessionUpdate",
            outcome: "succeeded",
            code: "sessionUpdate.succeeded",
            message: "ok2",
            time: Date.now(),
          }
          const meta2 = { ...meta, idempotencyHash: hash2, requestId: "req2", title: "second" }
          const inserted2: any = yield* (db as any)
            .transaction((tx: any) => SessionOperation.insertSessionUpdateSucceededTx(tx as any, s.id, { ...rec2, opId: opId2 }, meta2 as any))
            .pipe(Effect.orDie as any)
          expect(inserted2.meta.title).toBe("second")
          const allRows: any = yield* (db as any).all(sql`SELECT op_id FROM "session_operation" WHERE "session_id" = ${s.id}`).pipe(Effect.orDie as any)
          expect(allRows.length).toBe(4)
        }).pipe(Effect.provide(layer)),
      )
    })
    await (Effect as any).runPromise(program as any)
  })
})
