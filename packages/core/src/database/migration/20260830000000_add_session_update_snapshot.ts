import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260830000000_add_session_update_snapshot",
  up(tx) {
    return Effect.gen(function* () {
      const cols = yield* tx.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('session_operation')`)
      const has = (name: string) => cols.some((c) => c.name === name)
      if (!has("result_snapshot")) yield* tx.run(sql`ALTER TABLE "session_operation" ADD COLUMN "result_snapshot" text`)
    })
  },
} satisfies DatabaseMigration.Migration
