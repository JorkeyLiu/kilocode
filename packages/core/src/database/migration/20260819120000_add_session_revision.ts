import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260819120000_add_session_revision",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD COLUMN \`revision\` integer NOT NULL DEFAULT 0`)
    })
  },
} satisfies DatabaseMigration.Migration
