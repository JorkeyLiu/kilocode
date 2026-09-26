import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260925000000_add_generation_owner",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(sql`
        CREATE TABLE IF NOT EXISTS "session_generation_owner" (
          "gen_id" text PRIMARY KEY NOT NULL,
          "session_id" text NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
          "occurrence_time" integer NOT NULL,
          "close_time" integer,
          "close_reason" text CHECK("close_reason" IS NULL OR "close_reason" IN ('completed','interrupted','error','crash')),
          "retry_limit" integer NOT NULL,
          "retry_consumed" integer NOT NULL DEFAULT 0
        )
      `)
      yield* tx.run(sql`CREATE INDEX IF NOT EXISTS "session_generation_owner_session_idx" ON "session_generation_owner" ("session_id")`)
      yield* tx.run(sql`
        CREATE TABLE IF NOT EXISTS "session_generation_member" (
          "gen_id" text NOT NULL REFERENCES "session_generation_owner"("gen_id") ON DELETE CASCADE,
          "prompt_op_id" text NOT NULL,
          "session_id" text NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
          "added_time" integer NOT NULL,
          PRIMARY KEY ("gen_id", "prompt_op_id")
        )
      `)
      yield* tx.run(sql`CREATE INDEX IF NOT EXISTS "session_generation_member_session_idx" ON "session_generation_member" ("session_id")`)
      yield* tx.run(sql`CREATE INDEX IF NOT EXISTS "session_generation_member_gen_idx" ON "session_generation_member" ("gen_id")`)
      yield* tx.run(sql`CREATE INDEX IF NOT EXISTS "session_generation_member_op_idx" ON "session_generation_member" ("prompt_op_id")`)
    })
  },
} satisfies DatabaseMigration.Migration
