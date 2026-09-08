import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908000000_add_delete_tombstone",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(sql`
        CREATE TABLE IF NOT EXISTS "session_delete_tombstone" (
          "op_id" text PRIMARY KEY NOT NULL,
          "session_id" text NOT NULL,
          "idempotency_hash" text NOT NULL,
          "request_id" text,
          "directory" text,
          "parent_session_id" text,
          "config_version" integer,
          "session_revision" integer,
          "time" integer NOT NULL,
          "code" text NOT NULL,
          "message" text NOT NULL,
          "outcome" text NOT NULL CHECK("outcome" IN ('succeeded','failed'))
        )
      `)
      yield* tx.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS "session_delete_tombstone_session_hash_idx" ON "session_delete_tombstone" ("session_id", "idempotency_hash")`)
      yield* tx.run(sql`CREATE INDEX IF NOT EXISTS "session_delete_tombstone_session_idx" ON "session_delete_tombstone" ("session_id")`)
      // Update session_operation op_kind check to include delete if needed
      const tbl = yield* tx.get<{ sql: string | null }>(sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation'`)
      if (tbl?.sql && !tbl.sql.includes("'delete'")) {
        const cols = yield* tx.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('session_operation')`)
        const has = (name: string) => cols.some((c) => c.name === name)
        yield* tx.run(sql`DROP INDEX IF EXISTS "session_operation_session_idx"`)
        yield* tx.run(sql`DROP INDEX IF EXISTS "session_operation_session_kind_idx"`)
        yield* tx.run(sql`DROP INDEX IF EXISTS "session_operation_session_time_idx"`)
        yield* tx.run(sql`DROP INDEX IF EXISTS "session_operation_session_idempotency_idx"`)
        yield* tx.run(sql`DROP INDEX IF EXISTS "session_operation_message_id_idx"`)
        yield* tx.run(sql`ALTER TABLE "session_operation" RENAME TO "_session_operation_old"`)
        yield* tx.run(sql`
          CREATE TABLE "session_operation" (
            "op_id" text PRIMARY KEY NOT NULL,
            "session_id" text NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
            "op_kind" text NOT NULL CHECK("op_kind" IN ('prompt','provider','tool','permission','task','cancelQueued','sessionUpdate','fork','create','delete')),
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
        `)
        const desired = [
          "op_id",
          "session_id",
          "op_kind",
          "outcome",
          "code",
          "message",
          "time",
          "cancel",
          "detail",
          "stack",
          "revision",
          "idempotency_hash",
          "request_id",
          "directory",
          "message_id",
          "parent_session_id",
          "config_version",
          "session_revision",
          "cancelled",
          "title",
          "result_snapshot",
        ] as const
        const insertCols = desired.map((c) => `"${c}"`).join(", ")
        const selectExprs = desired.map((c) => (has(c) ? `"${c}"` : "NULL")).join(", ")
        yield* tx.run(sql.raw(`INSERT INTO "session_operation" (${insertCols}) SELECT ${selectExprs} FROM "_session_operation_old"`))
        yield* tx.run(sql`DROP TABLE "_session_operation_old"`)
        yield* tx.run(sql`CREATE INDEX "session_operation_session_idx" ON "session_operation" ("session_id")`)
        yield* tx.run(sql`CREATE INDEX "session_operation_session_kind_idx" ON "session_operation" ("session_id", "op_kind")`)
        yield* tx.run(sql`CREATE INDEX "session_operation_session_time_idx" ON "session_operation" ("session_id", "time")`)
        yield* tx.run(sql`CREATE UNIQUE INDEX "session_operation_session_idempotency_idx" ON "session_operation" ("session_id", "idempotency_hash") WHERE "idempotency_hash" IS NOT NULL`)
        yield* tx.run(sql`CREATE INDEX "session_operation_message_id_idx" ON "session_operation" ("message_id") WHERE "message_id" IS NOT NULL`)
      }
    })
  },
} satisfies DatabaseMigration.Migration
