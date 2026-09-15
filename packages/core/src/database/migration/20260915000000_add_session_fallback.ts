import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260915000000_add_session_fallback",
  up(tx) {
    return Effect.gen(function* () {
      const cols = yield* tx.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('session')`)
      const has = (name: string) => cols.some((c) => c.name === name)
      // Nullable JSON sticky custom-fallback takeover state. Old rows default
      // to NULL (no takeover); session code maps NULL to omitted.
      if (!has("fallback")) yield* tx.run(sql`ALTER TABLE "session" ADD COLUMN "fallback" text`)
    })
  },
} satisfies DatabaseMigration.Migration
