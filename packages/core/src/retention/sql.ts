import { sqliteTable, text, integer, index, uniqueIndex, check } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"

export const SessionChangefeedTable = sqliteTable(
  "session_changefeed",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    session_id: text().notNull(),
    revision: integer().notNull(),
    kind: text().$type<"changed" | "deleted" | "generation">().notNull(),
    time: integer().notNull(),
  },
  (table) => [
    uniqueIndex("session_changefeed_session_revision_kind_idx").on(table.session_id, table.revision, table.kind),
    index("session_changefeed_seq_idx").on(table.seq),
    index("session_changefeed_session_idx").on(table.session_id),
    check("session_changefeed_kind_check", sql`${table.kind} IN ('changed', 'deleted', 'generation')`),
  ],
)

export const RetentionObligationTable = sqliteTable("retention_obligation", {
  id: integer().primaryKey({ autoIncrement: true }),
  family_root_id: text().notNull(),
  session_ids: text({ mode: "json" }).$type<string[]>().notNull(),
  time_created: integer().notNull(),
  attempts: integer().notNull().default(0),
})

export const SessionChangefeedStateTable = sqliteTable("session_changefeed_state", {
  id: integer().primaryKey(),
  latest_seq: integer().notNull().default(0),
  retained_rows: integer().notNull().default(0),
  retained_bytes: integer().notNull().default(0),
})
