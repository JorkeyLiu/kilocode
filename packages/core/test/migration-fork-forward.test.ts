// @ts-nocheck
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import migrationFork from "@opencode-ai/core/database/migration/20260902000000_add_fork_operation"
import { Project } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { EventV2 } from "@opencode-ai/core/event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { tmpdir } from "./fixture/tmpdir"

describe("forward migration fork operation idempotent", () => {
  test("fresh install has fork CHECK and rerun is idempotent", async () => {
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
          expect(ddl.sql).toContain("'fork'")
          expect(ddl.sql).toContain("'sessionUpdate'")
          expect(ddl.sql).toContain("'cancelQueued'")

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

          const badFk: any = yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision") VALUES ('provider:msg_bad:0', 'nonexistent', 'provider', 'succeeded', 'c', 'm', 126, 1)`).pipe(Effect.exit as any)
          expect(badFk._tag).toBe("Failure")

          // fork insert should succeed on fresh install
          const svc = yield* SessionV2.Service
          const s = yield* svc.create({ location: { directory: AbsolutePath.make("/project") } } as any)
          const tok = "tok_fresh"
          const opIdFork = SessionOperation.forkId(s.id, tok)
          const hash = SessionOperation.hashIdempotencyKey(`fork:${s.id}:${tok}`)
          const rec: SessionOperation.FailureRecord = { opId: opIdFork, opKind: "fork", outcome: "succeeded", code: "fork.succeeded", message: "ok", time: Date.now() }
          const meta = { idempotencyHash: hash, requestId: "req_fresh", directory: "/project", parentSessionId: null, configVersion: null, sessionRevision: null, messageId: "msg_1", forkedSessionId: "ses_forked_1" }
          const snapshotJson = JSON.stringify({ id: "ses_forked_1", title: "forked" })
          const inserted: any = yield* (db as any).transaction((tx: any) => SessionOperation.insertSessionForkSucceededTx(tx as any, s.id, rec as any, meta as any, snapshotJson)).pipe(Effect.orDie as any)
          expect(inserted.meta.forkedSessionId).toBe("ses_forked_1")
          const row: any = yield* (db as any).get(sql`SELECT op_kind, title, result_snapshot, message_id FROM "session_operation" WHERE op_id = ${opIdFork}`).pipe(Effect.orDie as any)
          expect(row.op_kind).toBe("fork")
          expect(row.title).toBe("ses_forked_1")
          expect(row.message_id).toBe("msg_1")
          expect(typeof row.result_snapshot).toBe("string")

          // rerun via migration runner should be idempotent
          yield* DatabaseMigration.applyOnly(db as any, [migrationFork as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
          const ddl2: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
          expect(ddl2.sql).toContain("'fork'")
          // direct transaction rerun also idempotent
          yield* (db as any).transaction((tx: any) => migrationFork.up(tx as any)).pipe(Effect.orDie as any)
          const row2: any = yield* (db as any).get(sql`SELECT op_kind FROM "session_operation" WHERE op_id = ${opIdFork}`).pipe(Effect.orDie as any)
          expect(row2.op_kind).toBe("fork")
        }).pipe(Effect.provide(layer)),
      )
    })
    await (Effect as any).runPromise(program as any)
  })

  test("upgrade from pre-fork schema preserves rows and allows fork", async () => {
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

          const opIdCancel = SessionOperation.cancelQueuedId(s.id, "msg_cq")
          const hashCq = SessionOperation.hashIdempotencyKey(`cancelQueued:${s.id}:msg_cq`)
          yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision", "idempotency_hash", "request_id", "directory", "message_id", "parent_session_id", "config_version", "session_revision", "cancelled") VALUES (${opIdCancel}, ${s.id}, 'cancelQueued', 'succeeded', 'c2', 'm2', 125, 2, ${hashCq}, 'req_1', '/project', 'msg_cq', NULL, 1, 1, 0)`).pipe(Effect.orDie as any)

          // downgrade to pre-fork: same columns but CHECK without fork
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
          expect(ddlPre.sql).not.toContain("'fork'")
          expect(ddlPre.sql).toContain("'sessionUpdate'")
          const colsPre: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation')`).pipe(Effect.orDie as any)
          const namesPre = colsPre.map((c: any) => c.name)
          expect(namesPre).toContain("title")
          expect(namesPre).toContain("result_snapshot")

          const opIdForkX = `fork:${s.id}:tok_x`
          const reject: any = yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision") VALUES (${opIdForkX}, ${s.id}, 'fork', 'succeeded', 'c', 'm', 126, 2)`).pipe(Effect.exit as any)
          expect(reject._tag).toBe("Failure")

          // upgrade via real migration journal runner: delete journal row then applyOnly so journal gating is exercised
          yield* (db as any).run(sql`DELETE FROM ${sql.identifier("migration")} WHERE id = ${migrationFork.id}`).pipe(Effect.orDie as any)
          const preJournal: any = yield* (db as any).get(sql`SELECT id FROM ${sql.identifier("migration")} WHERE id = ${migrationFork.id}`).pipe(Effect.orDie as any)
          expect(preJournal == null).toBe(true)
          yield* DatabaseMigration.applyOnly(db as any, [migrationFork as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
          const journalRow: any = yield* (db as any).get(sql`SELECT id, time_completed FROM ${sql.identifier("migration")} WHERE id = ${migrationFork.id}`).pipe(Effect.orDie as any)
          expect(journalRow).toBeDefined()
          expect(journalRow.id).toBe(migrationFork.id)
          expect(typeof journalRow.time_completed).toBe("number")

          const rows: any = yield* (db as any).all(sql`SELECT op_id, op_kind, code, detail, stack, title FROM "session_operation" WHERE "session_id" = ${s.id} ORDER BY op_id`).pipe(Effect.orDie as any)
          expect(rows.length).toBe(3)
          const byId = Object.fromEntries(rows.map((r: any) => [r.op_id, r]))
          expect(byId[opIdOld].code).toBe("c")
          expect(byId[opIdOld].detail).toBe("detail-preserve")
          expect(byId[opIdOld].stack).toBe("stack-preserve")
          expect(byId[opIdUpd].title).toBe("pre-title")
          expect(byId[opIdCancel].op_kind).toBe("cancelQueued")

          const ddl: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
          expect(ddl.sql).toContain("'fork'")
          expect(ddl.sql).toContain("'sessionUpdate'")

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

          const badFk: any = yield* (db as any).run(sql`INSERT INTO "session_operation" ("op_id", "session_id", "op_kind", "outcome", "code", "message", "time", "revision") VALUES ('fork:bad:0', 'nonexistent', 'fork', 'succeeded', 'c', 'm', 127, 1)`).pipe(Effect.exit as any)
          expect(badFk._tag).toBe("Failure")

          // now fork should succeed via helper
          const tokY = "tok_y"
          const opIdY = SessionOperation.forkId(s.id, tokY)
          const hashY = SessionOperation.hashIdempotencyKey(`fork:${s.id}:${tokY}`)
          const recY: SessionOperation.FailureRecord = { opId: opIdY, opKind: "fork", outcome: "succeeded", code: "fork.succeeded", message: "ok", time: Date.now() }
          const metaY = { idempotencyHash: hashY, requestId: "req_y", directory: "/project", parentSessionId: null, configVersion: null, sessionRevision: null, messageId: "msg_y", forkedSessionId: "ses_forked_y" }
          const snapY = JSON.stringify({ id: "ses_forked_y", title: "fork-y" })
          const insertedY: any = yield* (db as any).transaction((tx: any) => SessionOperation.insertSessionForkSucceededTx(tx as any, s.id, recY as any, metaY as any, snapY)).pipe(Effect.orDie as any)
          expect(insertedY.meta.forkedSessionId).toBe("ses_forked_y")
          expect(insertedY.meta.messageId).toBe("msg_y")
          const afterRows: any = yield* (db as any).all(sql`SELECT op_id FROM "session_operation" WHERE "session_id" = ${s.id}`).pipe(Effect.orDie as any)
          expect(afterRows.length).toBe(4)
          const yRow: any = yield* (db as any).get(sql`SELECT result_snapshot, title FROM "session_operation" WHERE op_id = ${opIdY}`).pipe(Effect.orDie as any)
          expect(typeof yRow.result_snapshot).toBe("string")
          expect(yRow.title).toBe("ses_forked_y")
          const parsed = JSON.parse(yRow.result_snapshot)
          expect(parsed.id).toBe("ses_forked_y")

          // rerun idempotently preserves data
          yield* (db as any).transaction((tx: any) => migrationFork.up(tx as any)).pipe(Effect.orDie as any)
          const yRow2: any = yield* (db as any).get(sql`SELECT result_snapshot FROM "session_operation" WHERE op_id = ${opIdY}`).pipe(Effect.orDie as any)
          expect(yRow2.result_snapshot).toBe(yRow.result_snapshot)
          yield* DatabaseMigration.applyOnly(db as any, [migrationFork as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
          const ddlAfter: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
          expect(ddlAfter.sql).toContain("'fork'")
        }).pipe(Effect.provide(layer)),
      )
    })
    await (Effect as any).runPromise(program as any)
  })

  test("file database repeated convergence preserves fork schema and data", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "fork-forward-file.db")

    let sid: string | undefined
    let opIdFork1: string | undefined
    let snap1: string | undefined

    // phase 1: create file db, insert provider + fork, verify schema
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
        const tok1 = "tok_file1"
        opIdFork1 = SessionOperation.forkId(s.id, tok1)
        const hash1 = SessionOperation.hashIdempotencyKey(`fork:${s.id}:${tok1}`)
        const rec1: SessionOperation.FailureRecord = { opId: opIdFork1, opKind: "fork", outcome: "succeeded", code: "fork.succeeded", message: "ok1", time: Date.now() }
        const meta1 = { idempotencyHash: hash1, requestId: "req_file1", directory: "/project", parentSessionId: null, configVersion: null, sessionRevision: null, messageId: "msg_1", forkedSessionId: "ses_forked_file1" }
        snap1 = JSON.stringify({ id: "ses_forked_file1", title: "file1" })
        yield* (db as any).transaction((tx: any) => SessionOperation.insertSessionForkSucceededTx(tx as any, s.id, rec1 as any, meta1 as any, snap1)).pipe(Effect.orDie as any)
        const ddl: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
        expect(ddl.sql).toContain("'fork'")
        const cols: any = yield* (db as any).all(sql`SELECT name FROM pragma_table_info('session_operation')`).pipe(Effect.orDie as any)
        expect(cols.map((c: any) => c.name)).toContain("result_snapshot")
      })
      await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))) as any)
    }

    // phase 2: reopen same file, verify data preserved, rerun migrations idempotently, insert second fork
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
        const forkRow: any = yield* (db as any).get(sql`SELECT result_snapshot, title FROM "session_operation" WHERE op_id = ${opIdFork1}`).pipe(Effect.orDie as any)
        expect(forkRow.title).toBe("ses_forked_file1")
        expect(forkRow.result_snapshot).toBe(snap1)

        const ddlPre: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
        expect(ddlPre.sql).toContain("'fork'")

        // repeated convergence via runner and direct up should be idempotent and preserve data
        yield* DatabaseMigration.applyOnly(db as any, [migrationFork as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)
        yield* (db as any).transaction((tx: any) => migrationFork.up(tx as any)).pipe(Effect.orDie as any)
        // second convergence again
        yield* DatabaseMigration.applyOnly(db as any, [migrationFork as unknown as DatabaseMigration.Migration]).pipe(Effect.orDie as any)

        const forkRowAfter: any = yield* (db as any).get(sql`SELECT result_snapshot FROM "session_operation" WHERE op_id = ${opIdFork1}`).pipe(Effect.orDie as any)
        expect(forkRowAfter.result_snapshot).toBe(snap1)

        const idx: any = yield* (db as any).all(sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_operation'`).pipe(Effect.orDie as any)
        const idxNames = idx.map((r: any) => r.name)
        expect(idxNames).toContain("session_operation_session_idempotency_idx")
        expect(idxNames).toContain("session_operation_message_id_idx")

        // insert second fork succeeds
        const tok2 = "tok_file2"
        const opId2 = SessionOperation.forkId(sid!, tok2)
        const hash2 = SessionOperation.hashIdempotencyKey(`fork:${sid}:${tok2}`)
        const rec2: SessionOperation.FailureRecord = { opId: opId2, opKind: "fork", outcome: "succeeded", code: "fork.succeeded", message: "ok2", time: Date.now() }
        const meta2 = { idempotencyHash: hash2, requestId: "req_file2", directory: "/project", parentSessionId: null, configVersion: null, sessionRevision: null, messageId: "msg_2", forkedSessionId: "ses_forked_file2" }
        const snap2 = JSON.stringify({ id: "ses_forked_file2", title: "file2" })
        yield* (db as any).transaction((tx: any) => SessionOperation.insertSessionForkSucceededTx(tx as any, sid as any, rec2 as any, meta2 as any, snap2)).pipe(Effect.orDie as any)
        const allRows: any = yield* (db as any).all(sql`SELECT op_id FROM "session_operation" WHERE "session_id" = ${sid}`).pipe(Effect.orDie as any)
        expect(allRows.length).toBe(3)
        const ddlAfter: any = yield* (db as any).get(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`).pipe(Effect.orDie as any)
        expect(ddlAfter.sql).toContain("'fork'")
      })
      await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))) as any)
    }
  })
})
