import { blob, check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { SessionTable } from "../session/sql"
import { Timestamps } from "../database/schema.sql"

/**
 * Snapshot v2 durable file mutation journal (queryable capture unit).
 *
 * Strictly a queryable capture: SessionRevert/Snapshot restore transport is
 * unchanged (git-backed). Blobs hold complete raw bytes (never truncated,
 * never base64, never embedded in ToolPart). Mutations bind a prepared/
 * applied/failed fact per file change with content-addressed before/after.
 * The `move` op is retained for schema compat only; new tools model move as
 * two facts (source delete + target add/update) and never write single-row move.
 */
export const SnapshotBlobTable = sqliteTable("snapshot_blob", {
  sha256: text().primaryKey(),
  bytes: blob({ mode: "buffer" }).notNull(),
  size: integer().notNull(),
  time_created: integer()
    .notNull()
    .$default(() => Date.now()),
})

export const SnapshotMutationTable = sqliteTable(
  "snapshot_mutation",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    // Deliberately no FK: avoids event projector/cleanup ordering coupling.
    message_id: text().notNull(),
    call_id: text().notNull(),
    tool: text().notNull(),
    item_index: integer().notNull(),
    sub_index: integer().notNull().default(0),
    directory: text().notNull(),
    worktree: text().notNull(),
    path: text().notNull(),
    target_path: text(),
    op: text().$type<"add" | "update" | "delete" | "move">().notNull(),
    status: text().$type<"prepared" | "applied" | "failed">().notNull(),
    before_blob: text().references(() => SnapshotBlobTable.sha256),
    after_blob: text().references(() => SnapshotBlobTable.sha256),
    before_hash: text(),
    before_size: integer(),
    after_hash: text(),
    after_size: integer(),
    encoding: text(),
    bom: integer(),
    diagnostic: text(),
    error: text(),
    time_applied: integer(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("snapshot_mutation_idempotency_idx").on(
      table.session_id,
      table.message_id,
      table.call_id,
      table.item_index,
      table.sub_index,
      table.path,
      table.op,
    ),
    index("snapshot_mutation_session_message_idx").on(table.session_id, table.message_id),
    index("snapshot_mutation_session_call_idx").on(table.session_id, table.call_id),
    index("snapshot_mutation_session_path_idx").on(table.session_id, table.path),
    index("snapshot_mutation_status_idx").on(table.status),
    check("snapshot_mutation_op_check", sql`${table.op} IN ('add','update','delete','move')`),
    check("snapshot_mutation_status_check", sql`${table.status} IN ('prepared','applied','failed')`),
  ],
)
