import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260822000000_add_changefeed_kind_check",
  up(tx) {
    return Effect.gen(function* () {
      // Validate existing rows are within closed set before enforcing
      const bad = yield* tx.get<{ count: number }>(
        sql`SELECT count(*) as count FROM "session_changefeed" WHERE kind NOT IN ('changed','deleted')`,
      )
      if (bad && bad.count > 0) {
        yield* Effect.die(`session_changefeed contains ${bad.count} rows with invalid kind`)
      }
      // Create triggers to enforce closed kind at DB boundary (SQLite CHECK via ALTER not available without recreate)
      yield* tx.run(sql`DROP TRIGGER IF EXISTS session_changefeed_kind_insert_check`)
      yield* tx.run(sql`DROP TRIGGER IF EXISTS session_changefeed_kind_update_check`)
      yield* tx.run(
        sql`CREATE TRIGGER session_changefeed_kind_insert_check BEFORE INSERT ON "session_changefeed" FOR EACH ROW WHEN NEW.kind NOT IN ('changed','deleted') BEGIN SELECT RAISE(ABORT, 'invalid changefeed kind'); END`,
      )
      yield* tx.run(
        sql`CREATE TRIGGER session_changefeed_kind_update_check BEFORE UPDATE ON "session_changefeed" FOR EACH ROW WHEN NEW.kind NOT IN ('changed','deleted') BEGIN SELECT RAISE(ABORT, 'invalid changefeed kind'); END`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
