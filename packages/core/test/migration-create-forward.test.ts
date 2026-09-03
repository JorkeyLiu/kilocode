// @ts-nocheck
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import migrationCreate from "@opencode-ai/core/database/migration/20260903000000_add_create_operation"
import { Project } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { EventV2 } from "@opencode-ai/core/event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { tmpdir } from "./fixture/tmpdir"

describe("forward migration create operation idempotent", () => {
  test("fresh install has create CHECK and rerun is idempotent", async () => {
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
      const layer = Layer.mergeAll(
        database,
        events,
        projects,
        SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database)),
        store,
        SessionExecution.noopLayer,
        sessions,
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { db } = yield* Database.Service

          const ddl: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
          expect(ddl.sql).toContain("'create'")
          expect(ddl.sql).toContain("'fork'")
          expect(ddl.sql).toContain("'sessionUpdate'")

          const cols: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation')`).pipe(Effect.orDie as any)
          const names = cols.map((c: any) => c.name)
          for (const col of ["op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "cancel", "detail", "stack", "revision", "idempotency_hash", "request_id", "directory", "message_id", "parent_session_id", "config_version", "session_revision", "cancelled", "title", "result_snapshot"]) {
            expect(names).toContain(col)
          }

          const idx: any = yield* (db as any).all(sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_operation'`).pipe(Effect.orDie as any)
          const idxNames = idx.map((r: any) => r.name)
          expect(idxNames).toContain("session_operation_session_idx")
          expect(idxNames).toContain("session_operation_session_kind_idx")
          expect(idxNames).toContain("session_operation_session_time_idx")
          expect(idxNames).toContain("session_operation_session_idempotency_idx")
          expect(idxNames).toContain("session_operation_message_id_idx")

          const badFk: any = yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision") VALUES ('create:bad', 'nonexistent', 'create', 'succeeded', 'c', 'm', 126, 1)`).pipe(Effect.exit as any)
          expect(badFk._tag).toBe("Failure")

          // create insert should succeed on fresh install
          const svc = yield* SessionV2.Service
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } } as any)
          const tok = "tok_fresh_create"
          const opIdCreate = SessionOperation.createId(tok)
          const hash = SessionOperation.hashIdempotencyKey(`create:${tok}`)
          const rec: SessionOperation.FailureRecord = { opId: opIdCreate, opKind: "create", outcome: "succeeded", code: "create.succeeded", message: "ok", time: Date.now() }
          const meta = { idempotencyHash: hash, requestId: "req_fresh", directory: "/project", parentSessionId: null, configVersion: null, title: "fresh-title", parentID: null, createdSessionId: s.id }
          const snapshotJson = JSON.stringify({ id: s.id, title: "fresh" })
          // Insert via session-create helper using a new session id
          const newId = s.id // reuse for simplicity, but op_id must be unique - use fresh op
          // Use direct insert via helper: create a new session for create operation
          const createSvc = yield* Effect.promise(() => import("@opencode-ai/core/session/store")) as any
          // Instead use dispatch helper: directly test migration, not dispatch - just insert operation row manually
          const rowBefore: any = yield* (db as any).get(sql`SELECT count(*) as c FROM "session_operation"`).pipe(Effect.orDie as any)
          // Insert create operation manually via SQL to verify table accepts it
          const opId2 = SessionOperation.createId("tok_manual")
          yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision", "idempotency_hash", "request_id", "directory", "title", "result_snapshot") VALUES (${opId2}, ${s.id}, 'create', 'succeeded', 'create.succeeded', 'ok', ${Date.now()}, 0, ${hash}, 'req_manual', '/project', 'fresh-title', ${snapshotJson})`).pipe(Effect.orDie as any)
          const row: any = yield* (db as any).get(sql`SELECT op_kind, title, result_snapshot FROM "session_operation" WHERE op_id = ${opId2}`).pipe(Effect.orDie as any)
          expect(row.op_kind).toBe("create")
          expect(row.title).toBe("fresh-title")
          expect(typeof row.result_snapshot).toBe("string")

          // rerun via migration runner should be idempotent
          yield* DatabaseMigration.applyOnly(db as any, [migrationCreate as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
          const ddl2: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
          expect(ddl2.sql).toContain("'create'")
          // direct transaction rerun also idempotent
          yield* (db as any).transaction((tx: any) => migrationCreate.up(tx as any)).pipe(Effect.orDie as any)
          const row2: any = yield* (db as any).get(sql`SELECT op_kind FROM "session_operation" WHERE op_id = ${opId2}`).pipe(Effect.orDie as any)
          expect(row2.op_kind).toBe("create")
        }).pipe(Effect.provide(layer)),
      )
    })
    await (Effect as any).runPromise(program as any)
  })

  test("upgrade from pre-create schema preserves rows and allows create", async () => {
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
      const layer = Layer.mergeAll(
        database,
        events,
        projects,
        SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database)),
        store,
        SessionExecution.noopLayer,
        sessions,
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const svc = yield* SessionV2.Service
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } } as any)

          // insert rich rows before downgrade
          const opIdOld = SessionOperation.providerId("msg_old", 0)
          const recOld: SessionOperation.FailureRecord = { opId: opIdOld, opKind: "provider", outcome: "succeeded", code: "c", message: "m", time: 123, detail: "detail-preserve", stack: "stack-preserve" }
          yield* SessionOperation.put(db as any, s.id, recOld).pipe(Effect.orDie as any)

          const opIdUpd = SessionOperation.sessionUpdateId(s.id, "tok_pre")
          const hashUpd = SessionOperation.hashIdempotencyKey(`sessionUpdate:${s.id}:tok_pre`)
          const recUpd: SessionOperation.FailureRecord = { opId: opIdUpd, opKind: "sessionUpdate", outcome: "succeeded", code: "sessionUpdate.succeeded", message: "ok", time: 124 }
          const metaUpd = { idempotencyHash: hashUpd, requestId: "req_pre", directory: "/project", parentSessionId: null, configVersion: 1, sessionRevision: 1, title: "pre-title" }
          yield* (db as any).transaction((tx: any) => SessionOperation.insertSessionUpdateSucceededTx(tx as any, s.id, recUpd as any, metaUpd as any)).pipe(Effect.orDie as any)

          const opIdFork = SessionOperation.forkId(s.id, "tok_fork_pre")
          const hashFork = SessionOperation.hashIdempotencyKey(`fork:${s.id}:tok_fork_pre`)
          const recFork: SessionOperation.FailureRecord = { opId: opIdFork, opKind: "fork", outcome: "succeeded", code: "fork.succeeded", message: "ok", time: 125 }
          const metaFork = { idempotencyHash: hashFork, requestId: "req_fork_pre", directory: "/project", parentSessionId: null, configVersion: null, sessionRevision: null, messageId: "msg_1", forkedSessionId: "ses_forked_pre" }
          const snapFork = JSON.stringify({ id: "ses_forked_pre", title: "fork-pre" })
          yield* (db as any).transaction((tx: any) => SessionOperation.insertSessionForkSucceededTx(tx as any, s.id, recFork as any, metaFork as any, snapFork)).pipe(Effect.orDie as any)

          const opIdCancel = SessionOperation.cancelQueuedId(s.id, "msg_cq")
          const hashCq = SessionOperation.hashIdempotencyKey(`cancelQueued:${s.id}:msg_cq`)
          yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision", "idempotency_hash", "request_id", "directory", "message_id", "parent_session_id", "config_version", "session_revision", "cancelled") VALUES (${opIdCancel}, ${s.id}, 'cancelQueued', 'succeeded', 'c2', 'm2', 126, 2, ${hashCq}, 'req_1', '/project', 'msg_cq', NULL, 1, 1, 0)`).pipe(Effect.orDie as any)

          // downgrade to pre-create: same columns but CHECK without create
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
              "op_kind" text NOT NULL CHECK("op_kind" IN ('prompt','provider','tool','permission','task','cancelQueued','sessionUpdate','fork')),
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
              "title" text,
              "result_snapshot" text
            )
          `).pipe(Effect.orDie as any)
          yield* (db as any).run(sql.raw(`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "cancel", "detail", "stack", "revision", "idempotency_hash", "request_id", "directory", "message_id", "parent_session_id", "config_version", "session_revision", "cancelled", "title", "result_snapshot") SELECT "op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "cancel", "detail", "stack", "revision", "idempotency_hash", "request_id", "directory", "message_id", "parent_session_id", "config_version", "session_revision", "cancelled", "title", "result_snapshot" FROM "_session_operation_old"`)).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`DROP TABLE "_session_operation_old"`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`CREATE INDEX "session_operation_session_idx" ON "session_operation" ("session_id")`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`CREATE INDEX "session_operation_session_kind_idx" ON "session_operation" ("session_id", "op_kind")`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`CREATE INDEX "session_operation_session_time_idx" ON "session_operation" ("session_id", "time")`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`CREATE UNIQUE INDEX "session_operation_session_idempotency_idx" ON "session_operation" ("session_id", "idempotency_hash") WHERE "idempotency_hash" IS NOT NULL`).pipe(Effect.orDie as any)
          yield* (db as any).run(sql`CREATE INDEX "session_operation_message_id_idx" ON "session_operation" ("message_id") WHERE "message_id" IS NOT NULL`).pipe(Effect.orDie as any)

          const ddlPre: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
          expect(ddlPre.sql).not.toContain("'create'")
          expect(ddlPre.sql).toContain("'fork'")
          const colsPre: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation')`).pipe(Effect.orDie as any)
          const namesPre = colsPre.map((c: any) => c.name)
          expect(namesPre).toContain("title")
          expect(namesPre).toContain("result_snapshot")

          const opIdCreateX = `create:tok_x`
          const reject: any = yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision") VALUES (${opIdCreateX}, ${s.id}, 'create', 'succeeded', 'c', 'm', 127, 2)`).pipe(Effect.exit as any)
          expect(reject._tag).toBe("Failure")

          // upgrade via real migration journal runner: delete journal row then applyOnly so journal gating is exercised
          yield* (db as any).run(sql`DELETE FROM ${sql.identifier("migration")} WHERE id = ${migrationCreate.id}`).pipe(Effect.orDie as any)
          const preJournal: any = yield* (db as any).get(sql`SELECT id FROM ${sql.identifier("migration")} WHERE id = ${migrationCreate.id}`).pipe(Effect.orDie as any)
          expect(preJournal == null).toBe(true)
          yield* DatabaseMigration.applyOnly(db as any, [migrationCreate as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
          const journalRow: any = yield* (db as any).get(sql`SELECT id, time_completed FROM ${sql.identifier("migration")} WHERE id = ${migrationCreate.id}`).pipe(Effect.orDie as any)
          expect(journalRow).toBeDefined()
          expect(journalRow.id).toBe(migrationCreate.id)
          expect(typeof journalRow.time_completed).toBe("number")

          const rows: any = yield* (db as any).all(sql`SELECT op_id, op_kind, code, detail, stack, title FROM "session_operation" WHERE "session_id" = ${s.id} ORDER BY op_id`).pipe(Effect.orDie as any)
          expect(rows.length).toBe(4)
          const byId = Object.fromEntries(rows.map((r: any) => [r.op_id, r]))
          expect(byId[opIdOld].code).toBe("c")
          expect(byId[opIdOld].detail).toBe("detail-preserve")
          expect(byId[opIdOld].stack).toBe("stack-preserve")
          expect(byId[opIdUpd].title).toBe("pre-title")
          expect(byId[opIdFork].op_kind).toBe("fork")
          expect(byId[opIdCancel].op_kind).toBe("cancelQueued")

          const ddl: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
          expect(ddl.sql).toContain("'create'")
          expect(ddl.sql).toContain("'fork'")

          const cols: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation')`).pipe(Effect.orDie as any)
          const names = cols.map((c: any) => c.name)
          for (const col of ["idempotency_hash", "request_id", "directory", "message_id", "parent_session_id", "config_version", "session_revision", "cancelled", "title", "result_snapshot"]) {
            expect(names).toContain(col)
          }

          const idx: any = yield* (db as any).all(sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_operation'`).pipe(Effect.orDie as any)
          const idxNames = idx.map((r: any) => r.name)
          expect(idxNames).toContain("session_operation_session_idx")
          expect(idxNames).toContain("session_operation_session_kind_idx")
          expect(idxNames).toContain("session_operation_session_time_idx")
          expect(idxNames).toContain("session_operation_session_idempotency_idx")
          expect(idxNames).toContain("session_operation_message_id_idx")

          const badFk: any = yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision") VALUES ('create:bad2', 'nonexistent', 'create', 'succeeded', 'c', 'm', 128, 1)`).pipe(Effect.exit as any)
          expect(badFk._tag).toBe("Failure")

          // now create should succeed via manual insert
          const tokY = "tok_y_create"
          const opIdY = SessionOperation.createId(tokY)
          const hashY = SessionOperation.hashIdempotencyKey(`create:${tokY}`)
          const snapY = JSON.stringify({ id: "ses_created_y", title: "create-y" })
          yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision", "idempotency_hash", "request_id", "directory", "title", "result_snapshot") VALUES (${opIdY}, ${s.id}, 'create', 'succeeded', 'create.succeeded', 'ok', ${Date.now()}, 0, ${hashY}, 'req_y', '/project', 'create-y', ${snapY})`).pipe(Effect.orDie as any)
          const afterRows: any = yield* (db as any).all(sql`SELECT op_id FROM "session_operation" WHERE "session_id" = ${s.id}`).pipe(Effect.orDie as any)
          expect(afterRows.length).toBe(5)
          const yRow: any = yield* (db as any).get(sql`SELECT result_snapshot, title FROM "session_operation" WHERE op_id = ${opIdY}`).pipe(Effect.orDie as any)
          expect(typeof yRow.result_snapshot).toBe("string")
          expect(yRow.title).toBe("create-y")
          const parsed = JSON.parse(yRow.result_snapshot)
          expect(parsed.id).toBe("ses_created_y")

          // rerun idempotently preserves data
          yield* (db as any).transaction((tx: any) => migrationCreate.up(tx as any)).pipe(Effect.orDie as any)
          const yRow2: any = yield* (db as any).get(sql`SELECT result_snapshot FROM "session_operation" WHERE op_id = ${opIdY}`).pipe(Effect.orDie as any)
          expect(yRow2.result_snapshot).toBe(yRow.result_snapshot)
          yield* DatabaseMigration.applyOnly(db as any, [migrationCreate as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
          const ddlAfter: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
          expect(ddlAfter.sql).toContain("'create'")
        }).pipe(Effect.provide(layer)),
      )
    })
    await (Effect as any).runPromise(program as any)
  })

  test("file database repeated convergence preserves create schema and data", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "create-forward-file.db")

    let sid: string | undefined
    let opIdCreate1: string | undefined
    let snap1: string | undefined

    // phase 1: create file db, insert provider + create, verify schema
    {
      const database = Database.layerFromPath(filename)
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
      const layer = Layer.mergeAll(
        database,
        events,
        projects,
        SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database)),
        store,
        SessionExecution.noopLayer,
        sessions,
      )
      const program = Effect.gen(function* () {
        const { db } = yield* Database.Service
        const svc = yield* SessionV2.Service
        const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } } as any)
        sid = s.id
        const opIdProv = SessionOperation.providerId("msg_file", 0)
        yield* SessionOperation.put(db as any, s.id, { opId: opIdProv, opKind: "provider", outcome: "succeeded", code: "c", message: "m", time: 200 }).pipe(Effect.orDie as any)
        const tok1 = "tok_file1_create"
        opIdCreate1 = SessionOperation.createId(tok1)
        const hash1 = SessionOperation.hashIdempotencyKey(`create:${tok1}`)
        snap1 = JSON.stringify({ id: "ses_created_file1", title: "file1" })
        yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision", "idempotency_hash", "request_id", "directory", "title", "result_snapshot") VALUES (${opIdCreate1}, ${s.id}, 'create', 'succeeded', 'create.succeeded', 'ok1', ${Date.now()}, 0, ${hash1}, 'req_file1', '/project', 'file1', ${snap1})`).pipe(Effect.orDie as any)
        const ddl: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
        expect(ddl.sql).toContain("'create'")
        const cols: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation')`).pipe(Effect.orDie as any)
        expect(cols.map((c: any) => c.name)).toContain("result_snapshot")
      })
      await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))) as any)
    }

    // phase 2: reopen same file, verify data preserved, rerun migrations idempotently, insert second create
    {
      const database = Database.layerFromPath(filename)
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
      const layer = Layer.mergeAll(
        database,
        events,
        projects,
        SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database)),
        store,
        SessionExecution.noopLayer,
        sessions,
      )
      const program = Effect.gen(function* () {
        const { db } = yield* Database.Service
        expect(sid).toBeDefined()
        const rows: any = yield* (db as any).all(sql`SELECT op_id, result_snapshot FROM "session_operation" WHERE "session_id" = ${sid}`).pipe(Effect.orDie as any)
        expect(rows.length).toBe(2)
        const createRow: any = yield* (db as any).get(sql`SELECT result_snapshot, title FROM "session_operation" WHERE op_id = ${opIdCreate1}`).pipe(Effect.orDie as any)
        expect(createRow.title).toBe("file1")
        expect(createRow.result_snapshot).toBe(snap1)

        const ddlPre: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
        expect(ddlPre.sql).toContain("'create'")

        // repeated convergence via runner and direct up should be idempotent and preserve data
        yield* DatabaseMigration.applyOnly(db as any, [migrationCreate as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
        yield* (db as any).transaction((tx: any) => migrationCreate.up(tx as any)).pipe(Effect.orDie as any)
        // second convergence again
        yield* DatabaseMigration.applyOnly(db as any, [migrationCreate as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)

        const createRowAfter: any = yield* (db as any).get(sql`SELECT result_snapshot FROM "session_operation" WHERE op_id = ${opIdCreate1}`).pipe(Effect.orDie as any)
        expect(createRowAfter.result_snapshot).toBe(snap1)

        const idx: any = yield* (db as any).all(sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_operation'`).pipe(Effect.orDie as any)
        const idxNames = idx.map((r: any) => r.name)
        expect(idxNames).toContain("session_operation_session_idempotency_idx")
        expect(idxNames).toContain("session_operation_message_id_idx")

        // insert second create succeeds
        const tok2 = "tok_file2_create"
        const opId2 = SessionOperation.createId(tok2)
        const hash2 = SessionOperation.hashIdempotencyKey(`create:${tok2}`)
        const snap2 = JSON.stringify({ id: "ses_created_file2", title: "file2" })
        yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision", "idempotency_hash", "request_id", "directory", "title", "result_snapshot") VALUES (${opId2}, ${sid}, 'create', 'succeeded', 'create.succeeded', 'ok2', ${Date.now()}, 0, ${hash2}, 'req_file2', '/project', 'file2', ${snap2})`).pipe(Effect.orDie as any)
        const allRows: any = yield* (db as any).all(sql`SELECT op_id FROM "session_operation" WHERE "session_id" = ${sid}`).pipe(Effect.orDie as any)
        expect(allRows.length).toBe(3)
        const ddlAfter: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
        expect(ddlAfter.sql).toContain("'create'")
      })
      await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))) as any)
    }
  })
})
