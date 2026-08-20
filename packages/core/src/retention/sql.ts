import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"

export const SessionChangefeedTable = sqliteTable(
  "session_changefeed",
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    session_id: text().notNull(),
    revision: integer().notNull(),
    kind: text().notNull(),
    time: integer().notNull(),
  },
  (table) => [
    uniqueIndex("session_changefeed_session_revision_kind_idx").on(table.session_id, table.revision, table.kind),
    index("session_changefeed_seq_idx").on(table.seq),
    index("session_changefeed_session_idx").on(table.session_id),
  ],
)

export const RetentionObligationTable = sqliteTable("retention_obligation", {
  id: integer().primaryKey({ autoIncrement: true }),
  family_root_id: text().notNull(),
  session_ids: text({ mode: "json" }).$type<string[]>().notNull(),
  time_created: integer().notNull(),
  attempts: integer().notNull().default(0),
})
