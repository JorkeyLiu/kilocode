import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260823000000_add_storage_identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(sql`
        CREATE TABLE "storage_identity" (
          "id" integer PRIMARY KEY CHECK("id" = 1) NOT NULL,
          "uuid" text NOT NULL,
          "schema_version" text NOT NULL,
          "created_at" integer NOT NULL,
          "cutover_archive_id" text NOT NULL
        )
      `)
    })
  },
} satisfies DatabaseMigration.Migration
