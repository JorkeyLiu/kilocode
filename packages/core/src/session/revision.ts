export * as SessionRevision from "./revision"

import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { SessionSchema } from "@opencode-ai/core/session/schema"

type Db = { update: Database.Interface["db"]["update"] }

/**
 * Atomically advance a single session's revision by 1.
 *
 * Uses UPDATE … RETURNING to prove exactly one affected row in a single
 * statement, eliminating the TOCTOU window between a prior UPDATE and a
 * subsequent SELECT. If the session was deleted (or never existed) the
 * enclosing transaction is rolled back via Effect.die.
 *
 * @param db - The database instance or transaction object.
 */
export function advance(sessionID: SessionSchema.ID, db: Db): Effect.Effect<void> {
  return Effect.gen(function* () {
    const rows = yield* db
      .update(SessionTable)
      .set({ revision: sql`${SessionTable.revision} + 1`, time_updated: sql`${SessionTable.time_updated}` })
      .where(eq(SessionTable.id, sessionID))
      .returning({ id: SessionTable.id })
      .all()
      .pipe(Effect.orDie)
    if (rows.length !== 1)
      yield* Effect.die(
        `Session revision advance failed: expected exactly 1 row, got ${rows.length} for session ${sessionID}`,
      )
  })
}
