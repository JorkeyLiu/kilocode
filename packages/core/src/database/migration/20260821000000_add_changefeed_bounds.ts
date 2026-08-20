import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

const MAX_ROWS = 50_000
const MAX_BYTES = 64 * 1024 * 1024

export default {
  id: "20260821000000_add_changefeed_bounds",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(sql`CREATE TABLE IF NOT EXISTS "session_changefeed_state" (
        "id" integer PRIMARY KEY NOT NULL,
        "latest_seq" integer NOT NULL DEFAULT 0,
        "retained_rows" integer NOT NULL DEFAULT 0,
        "retained_bytes" integer NOT NULL DEFAULT 0
      )`)
      const rows = yield* tx.all<{ seq: number; session_id: string; kind: string }>(
        sql`SELECT seq, session_id, kind FROM "session_changefeed" ORDER BY seq ASC`,
      )
      let maxSeq = 0
      const enc = new TextEncoder()
      for (const r of rows) if (r.seq > maxSeq) maxSeq = r.seq
      // Enforce production caps oldest-first before state init, so over-cap legacy feeds become bounded immediately.
      let retainedRows = rows.length
      let retainedBytes = 0
      for (const r of rows) retainedBytes += enc.encode(r.session_id).length + enc.encode(r.kind).length + 24

      let evictCount = 0
      let tempRows = retainedRows
      let tempBytes = retainedBytes
      for (let i = 0; i < rows.length; i++) {
        if (tempRows <= MAX_ROWS && tempBytes <= MAX_BYTES) break
        const r = rows[i]!
        tempRows -= 1
        tempBytes -= enc.encode(r.session_id).length + enc.encode(r.kind).length + 24
        evictCount += 1
      }
      if (evictCount > 0) {
        const cutoff = rows[evictCount - 1]!.seq
        yield* tx.run(sql`DELETE FROM "session_changefeed" WHERE seq <= ${cutoff}`)
        retainedRows = tempRows
        retainedBytes = tempBytes
      }
      // Preserve monotonic latest_seq: never decrease on rerun even if retained rows are empty after ack/truncation.
      const existingState = yield* tx.get<{ latest_seq: number }>(sql`SELECT latest_seq FROM "session_changefeed_state" WHERE id = 1`)
      const latest = existingState ? Math.max(existingState.latest_seq, maxSeq) : maxSeq
      // Upsert singleton state idempotently: if row exists, update to accurate wartości; else insert.
      const existing = yield* tx.get<{ count: number }>(sql`SELECT count(*) as count FROM "session_changefeed_state" WHERE id = 1`)
      if (existing && existing.count > 0) {
        yield* tx.run(
          sql`UPDATE "session_changefeed_state" SET latest_seq = ${latest}, retained_rows = ${retainedRows}, retained_bytes = ${retainedBytes} WHERE id = 1`,
        )
      } else {
        yield* tx.run(
          sql`INSERT OR IGNORE INTO "session_changefeed_state" (id, latest_seq, retained_rows, retained_bytes) VALUES (1, ${latest}, ${retainedRows}, ${retainedBytes})`,
        )
        // If race inserted, ensure values are updated to our computed bounded values while preserving monotonic latest
        const raced = yield* tx.get<{ latest_seq: number }>(sql`SELECT latest_seq FROM "session_changefeed_state" WHERE id = 1`)
        const racedLatest = raced ? Math.max(raced.latest_seq, latest) : latest
        yield* tx.run(
          sql`UPDATE "session_changefeed_state" SET latest_seq = ${racedLatest}, retained_rows = ${retainedRows}, retained_bytes = ${retainedBytes} WHERE id = 1 AND (latest_seq != ${racedLatest} OR retained_rows != ${retainedRows} OR retained_bytes != ${retainedBytes})`,
        )
      }
    })
  },
} satisfies DatabaseMigration.Migration
