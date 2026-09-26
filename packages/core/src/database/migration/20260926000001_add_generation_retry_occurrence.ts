import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260926000001_add_generation_retry_occurrence",
  up(tx) {
    return Effect.gen(function* () {
      const cols = yield* tx.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('session_generation_owner')`)
      const has = (n: string) => cols.some((c) => c.name === n)
      if (!has("retry_occurrence_time"))
        yield* tx.run(sql`ALTER TABLE "session_generation_owner" ADD COLUMN "retry_occurrence_time" integer`)
    })
  },
} satisfies DatabaseMigration.Migration
