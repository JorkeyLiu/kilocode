import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260925000001_add_generation_retry_intent",
  up(tx) {
    return Effect.gen(function* () {
      const cols = yield* tx.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('session_generation_owner')`)
      const has = (n: string) => cols.some((c) => c.name === n)
      if (!has("retry_layer"))
        yield* tx.run(
          sql`ALTER TABLE "session_generation_owner" ADD COLUMN "retry_layer" text CHECK("retry_layer" IS NULL OR "retry_layer" IN ('provider','incomplete','broker','task','restart'))`,
        )
      if (!has("retry_next_at")) yield* tx.run(sql`ALTER TABLE "session_generation_owner" ADD COLUMN "retry_next_at" integer`)
    })
  },
} satisfies DatabaseMigration.Migration
