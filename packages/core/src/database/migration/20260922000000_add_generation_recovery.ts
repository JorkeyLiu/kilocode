import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260922000000_add_generation_recovery",
  up(tx) {
    return Effect.gen(function* () {
      const opCols = yield* tx.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('session_operation')`)
      const has = (n: string) => opCols.some((c) => c.name === n)
      if (!has("recovery_budget")) yield* tx.run(sql`ALTER TABLE "session_operation" ADD COLUMN "recovery_budget" integer`)
      if (!has("recovery_next_at")) yield* tx.run(sql`ALTER TABLE "session_operation" ADD COLUMN "recovery_next_at" integer`)
      if (!has("recovery_provenance")) yield* tx.run(sql`ALTER TABLE "session_operation" ADD COLUMN "recovery_provenance" text`)
      // update changefeed triggers to allow generation; recreate triggers if they exist
      const bad = yield* tx.get<{ count: number }>(sql`SELECT count(*) as count FROM "session_changefeed" WHERE kind NOT IN ('changed','deleted','generation')`)
      if (bad && bad.count > 0) yield* Effect.die(`session_changefeed contains ${bad.count} rows with invalid kind`)
      yield* tx.run(sql`DROP TRIGGER IF EXISTS session_changefeed_kind_insert_check`)
      yield* tx.run(sql`DROP TRIGGER IF EXISTS session_changefeed_kind_update_check`)
      yield* tx.run(sql`CREATE TRIGGER session_changefeed_kind_insert_check BEFORE INSERT ON "session_changefeed" FOR EACH ROW WHEN NEW.kind NOT IN ('changed','deleted','generation') BEGIN SELECT RAISE(ABORT, 'invalid changefeed kind'); END`)
      yield* tx.run(sql`CREATE TRIGGER session_changefeed_kind_update_check BEFORE UPDATE ON "session_changefeed" FOR EACH ROW WHEN NEW.kind NOT IN ('changed','deleted','generation') BEGIN SELECT RAISE(ABORT, 'invalid changefeed kind'); END`)
    })
  },
} satisfies DatabaseMigration.Migration
