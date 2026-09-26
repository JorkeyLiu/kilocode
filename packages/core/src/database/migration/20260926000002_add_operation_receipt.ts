import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260926000002_add_operation_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(sql`CREATE TABLE IF NOT EXISTS "session_operation_receipt" ("op_id" text PRIMARY KEY REFERENCES "session_operation"("op_id") ON DELETE CASCADE, "session_id" text NOT NULL REFERENCES "session"("id") ON DELETE CASCADE, "outcome" text NOT NULL, "time" integer NOT NULL, "gen_id" text, "gen_unknown" text, "owner_used" integer, "owner_limit" integer, "owner_layer" text, "owner_retry_occurrence" integer, "owner_next_at" integer, "owner_close_reason" text, "replay" text NOT NULL DEFAULT 'forbidden', CONSTRAINT "session_operation_receipt_outcome_check" CHECK("outcome" IN ('succeeded','failed','ambiguous','superseded','abandoned')), CONSTRAINT "session_operation_receipt_gen_check" CHECK((("gen_id" IS NOT NULL AND "gen_unknown" IS NULL) OR ("gen_id" IS NULL AND "gen_unknown" IS NOT NULL))), CONSTRAINT "session_operation_receipt_replay_check" CHECK("replay" = 'forbidden'), CONSTRAINT "session_operation_receipt_layer_check" CHECK("owner_layer" IS NULL OR "owner_layer" IN ('provider','incomplete','broker','task','restart')), CONSTRAINT "session_operation_receipt_close_reason_check" CHECK("owner_close_reason" IS NULL OR "owner_close_reason" IN ('completed','interrupted','error','crash')) )`)
      yield* tx.run(
        sql`CREATE INDEX IF NOT EXISTS "session_operation_receipt_session_idx" ON "session_operation_receipt" ("session_id")`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
