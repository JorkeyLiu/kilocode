import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260820000000_add_retention_foundation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_changefeed\` (
          \`seq\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
          \`session_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`time\` integer NOT NULL,
          \`kind\` text NOT NULL,
          CONSTRAINT \`session_changefeed_session_revision_kind_unique\` UNIQUE(\`session_id\`,\`revision\`,\`kind\`)
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_changefeed_seq_idx\` ON \`session_changefeed\` (\`seq\`)`)
      yield* tx.run(`CREATE INDEX \`session_changefeed_session_idx\` ON \`session_changefeed\` (\`session_id\`)`)
      yield* tx.run(`
        CREATE TABLE \`retention_obligation\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
          \`family_root_id\` text NOT NULL,
          \`session_ids\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`attempts\` integer NOT NULL DEFAULT 0
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
