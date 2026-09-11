import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260911125620_add_snapshot_journal",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`snapshot_blob\` (
          \`sha256\` text PRIMARY KEY NOT NULL,
          \`bytes\` blob NOT NULL,
          \`size\` integer NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`snapshot_mutation\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`session_id\` text NOT NULL REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          \`message_id\` text NOT NULL,
          \`call_id\` text NOT NULL,
          \`tool\` text NOT NULL,
          \`item_index\` integer NOT NULL,
          \`sub_index\` integer NOT NULL DEFAULT 0,
          \`directory\` text NOT NULL,
          \`worktree\` text NOT NULL,
          \`path\` text NOT NULL,
          \`target_path\` text,
          \`op\` text NOT NULL,
          \`status\` text NOT NULL,
          \`before_blob\` text REFERENCES \`snapshot_blob\`(\`sha256\`),
          \`after_blob\` text REFERENCES \`snapshot_blob\`(\`sha256\`),
          \`before_hash\` text,
          \`before_size\` integer,
          \`after_hash\` text,
          \`after_size\` integer,
          \`encoding\` text,
          \`bom\` integer,
          \`diagnostic\` text,
          \`error\` text,
          \`time_applied\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`snapshot_mutation_op_check\` CHECK(\`op\` IN ('add','update','delete','move')),
          CONSTRAINT \`snapshot_mutation_status_check\` CHECK(\`status\` IN ('prepared','applied','failed'))
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS \`snapshot_mutation_idempotency_idx\` ON \`snapshot_mutation\` (\`session_id\`,\`message_id\`,\`call_id\`,\`item_index\`,\`sub_index\`,\`path\`,\`op\`)`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`snapshot_mutation_session_message_idx\` ON \`snapshot_mutation\` (\`session_id\`,\`message_id\`)`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`snapshot_mutation_session_call_idx\` ON \`snapshot_mutation\` (\`session_id\`,\`call_id\`)`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`snapshot_mutation_session_path_idx\` ON \`snapshot_mutation\` (\`session_id\`,\`path\`)`,
      )
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`snapshot_mutation_status_idx\` ON \`snapshot_mutation\` (\`status\`)`)
    })
  },
} satisfies DatabaseMigration.Migration
