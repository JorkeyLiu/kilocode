import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260913000000_add_create_sandbox_inheritance",
  up(tx) {
    return Effect.gen(function* () {
      const cols = yield* tx.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('session_operation')`)
      const has = (name: string) => cols.some((c) => c.name === name)
      if (!has("sandbox_token_hash")) yield* tx.run(sql`ALTER TABLE "session_operation" ADD COLUMN "sandbox_token_hash" text`)
      if (!has("sandbox_source_session_id")) yield* tx.run(sql`ALTER TABLE "session_operation" ADD COLUMN "sandbox_source_session_id" text`)
      if (!has("sandbox_source_directory")) yield* tx.run(sql`ALTER TABLE "session_operation" ADD COLUMN "sandbox_source_directory" text`)
    })
  },
} satisfies DatabaseMigration.Migration
