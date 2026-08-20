export * as SessionRevision from "./revision"

import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { SessionSchema } from "@opencode-ai/core/session/schema"
import * as Changefeed from "../retention/changefeed"

type Tx = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]
type DbOrTx = Database.Interface["db"] | Tx

/**
 * Transaction-owned advance: must be called inside an active transaction.
 * No nested transaction is opened; caller provides the transaction handle
 * (or the database handle when already inside a transaction context).
 */
export function advanceTx(sessionID: SessionSchema.ID, tx: DbOrTx): Effect.Effect<void> {
  return Effect.gen(function* () {
    const rows = yield* tx
      .update(SessionTable)
      .set({ revision: sql`${SessionTable.revision} + 1`, time_updated: sql`${SessionTable.time_updated}` })
      .where(eq(SessionTable.id, sessionID))
      .returning({ id: SessionTable.id, revision: SessionTable.revision })
      .all()
      .pipe(Effect.orDie)
    if (rows.length !== 1)
      yield* Effect.die(
        `Session revision advance failed: expected exactly 1 row, got ${rows.length} for session ${sessionID}`,
      )
    const next = rows[0]!.revision
    yield* Changefeed.appendTx(tx, { session_id: sessionID, revision: next, kind: "changed", time: Date.now() })
  })
}

/**
 * Root convenience wrapper: opens one immediate transaction around the advance + feed.
 */
export function advance(sessionID: SessionSchema.ID, db: Database.Interface["db"]): Effect.Effect<void> {
  return db.transaction((tx) => advanceTx(sessionID, tx), { behavior: "immediate" }).pipe(Effect.orDie)
}
