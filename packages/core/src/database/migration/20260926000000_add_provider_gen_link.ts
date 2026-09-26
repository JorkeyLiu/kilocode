import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260926000000_add_provider_gen_link",
  up(tx) {
    return Effect.gen(function* () {
      const cols = yield* tx.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('session_operation')`)
      const has = (n: string) => cols.some((c) => c.name === n)
      if (!has("gen_id")) yield* tx.run(sql`ALTER TABLE "session_operation" ADD COLUMN "gen_id" text`)
      yield* tx.run(
        sql`CREATE INDEX IF NOT EXISTS "session_operation_gen_id_idx" ON "session_operation" ("gen_id") WHERE "gen_id" IS NOT NULL`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
