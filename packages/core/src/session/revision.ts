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
 * Returns the real `ChangefeedEntry` appended in the same transaction.
 * Any append failure remains fail-closed (transaction aborts).
 */
export function advanceTx(sessionID: SessionSchema.ID, tx: DbOrTx): Effect.Effect<Changefeed.Entry> {
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
    const entry = yield* Changefeed.appendTx(tx, { session_id: sessionID, revision: next, kind: "changed", time: Date.now() })
    return entry
  })
}

/**
 * Root convenience wrapper: opens one immediate transaction around the advance + feed.
 * Returns the appended `ChangefeedEntry` from the same transaction.
 */
export function advance(sessionID: SessionSchema.ID, db: Database.Interface["db"]): Effect.Effect<Changefeed.Entry> {
  return db.transaction((tx) => advanceTx(sessionID, tx), { behavior: "immediate" }).pipe(Effect.orDie) as Effect.Effect<Changefeed.Entry>
}

export class RevisionNotFoundError extends Error {
  constructor(public readonly sessionID: SessionSchema.ID) {
    super(`Session not found: ${sessionID}`)
    this.name = "RevisionNotFoundError"
  }
}

export function getTx(tx: DbOrTx, sessionID: SessionSchema.ID): Effect.Effect<number, RevisionNotFoundError> {
  return Effect.gen(function* () {
    const row = yield* tx
      .select({ revision: SessionTable.revision })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* Effect.fail(new RevisionNotFoundError(sessionID))
    return (row as { revision: number }).revision
  }) as Effect.Effect<number, RevisionNotFoundError>
}

export function get(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
): Effect.Effect<number, RevisionNotFoundError> {
  return db.transaction((tx) => getTx(tx as DbOrTx, sessionID), { behavior: "immediate" }) as Effect.Effect<
    number,
    RevisionNotFoundError
  >
}
