import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260824000000_add_operation_record",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(sql`
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
      `)
      yield* tx.run(sql`CREATE INDEX "session_operation_session_idx" ON "session_operation" ("session_id")`)
      yield* tx.run(sql`CREATE INDEX "session_operation_session_kind_idx" ON "session_operation" ("session_id", "op_kind")`)
      yield* tx.run(sql`CREATE INDEX "session_operation_session_time_idx" ON "session_operation" ("session_id", "time")`)
    })
  },
} satisfies DatabaseMigration.Migration
