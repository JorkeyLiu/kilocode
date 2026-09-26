import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260926000003_add_generation_member_unique",
  up(tx) {
    return Effect.gen(function* () {
      const dups = yield* tx.all<{ prompt_op_id: string; count: number }>(
        sql`SELECT "prompt_op_id" AS "prompt_op_id", COUNT(*) AS "count" FROM "session_generation_member" GROUP BY "prompt_op_id" HAVING COUNT(*) > 1`,
      )
      if (dups.length > 0) {
        const sample = dups
          .slice(0, 5)
          .map((row) => `${row.prompt_op_id} x${row.count}`)
          .join(", ")
        yield* Effect.die(
          new Error(
            `refusing to enforce UNIQUE(prompt_op_id): ${dups.length} duplicate prompt operation(s) already span generations (${sample}${dups.length > 5 ? ", ..." : ""}). No dedup applied; resolve duplicates manually before upgrading.`,
          ),
        )
      }
      yield* tx.run(sql`DROP INDEX IF EXISTS "session_generation_member_op_idx"`)
      yield* tx.run(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS "session_generation_member_op_idx" ON "session_generation_member" ("prompt_op_id")`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
