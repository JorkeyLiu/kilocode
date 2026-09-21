export * as Changefeed from "./changefeed"

import { and, asc, eq, inArray, lte } from "drizzle-orm"
import { Cause, Effect, Exit } from "effect"
import { Database } from "../database/database"
import { SessionChangefeedStateTable, SessionChangefeedTable } from "./sql"

export const MAX_ROWS = 50_000
export const MAX_BYTES = 64 * 1024 * 1024

export type Kind = "changed" | "deleted" | "generation"
const VALID_KINDS = new Set<string>(["changed", "deleted", "generation"])
function assertKind(kind: string): asserts kind is Kind {
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`invalid changefeed kind: ${kind}`)
  }
}

/**
 * Deterministic logical persisted metadata byte size for a changefeed row.
 *
 * UTF-8 byte lengths of `session_id` and `kind`, plus 8 bytes each for
 * persisted integer fields `seq`, `revision`, and `time` (24 bytes).
 * Uses 24-byte integer allowance so size is known before seq assignment.
 */
export function byteSize(sessionID: string, kind: string): number {
  const enc = new TextEncoder()
  return enc.encode(sessionID).length + enc.encode(kind).length + 24
}

export type Entry = {
  readonly seq: number
  readonly session_id: string
  readonly revision: number
  readonly kind: Kind
  readonly time: number
}

export type ReadResult =
  | { readonly type: "deltas"; readonly cursor: number; readonly entries: ReadonlyArray<Entry> }
  | { readonly type: "rehydrate"; readonly cursor: number; readonly reason: string }

export class CursorAheadError extends Error {
  override name = "CursorAheadError"
  constructor(
    readonly cursor: number,
    readonly latest: number,
  ) {
    super(`ack cursor ${cursor} ahead of latest ${latest}`)
  }
}

type Tx = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]
type DbOrTx = Database.Interface["db"] | Tx

function ensureStateTx(tx: DbOrTx) {
  return Effect.gen(function* () {
    const row = yield* tx.select().from(SessionChangefeedStateTable).where(eq(SessionChangefeedStateTable.id, 1)).get().pipe(Effect.orDie)
    if (row) return row as { id: number; latest_seq: number; retained_rows: number; retained_bytes: number }
    const inserted = yield* tx
      .insert(SessionChangefeedStateTable)
      .values({ id: 1, latest_seq: 0, retained_rows: 0, retained_bytes: 0 })
      .onConflictDoNothing()
      .returning({
        id: SessionChangefeedStateTable.id,
        latest_seq: SessionChangefeedStateTable.latest_seq,
        retained_rows: SessionChangefeedStateTable.retained_rows,
        retained_bytes: SessionChangefeedStateTable.retained_bytes,
      })
      .get()
      .pipe(Effect.orDie)
    if (inserted) return inserted as { id: number; latest_seq: number; retained_rows: number; retained_bytes: number }
    const fallback = yield* tx.select().from(SessionChangefeedStateTable).where(eq(SessionChangefeedStateTable.id, 1)).get().pipe(Effect.orDie)
    if (!fallback) yield* Effect.die("changefeed state missing after ensure")
    return fallback as { id: number; latest_seq: number; retained_rows: number; retained_bytes: number }
  })
}

// Tx-only internal: must be called inside an active transaction (immediate)
export function appendTx(
  tx: DbOrTx,
  input: { readonly session_id: string; readonly revision: number; readonly kind: Kind; readonly time: number },
): Effect.Effect<Entry> {
  return appendWithCapsTx(tx, input, { maxRows: MAX_ROWS, maxBytes: MAX_BYTES })
}

export function appendWithCapsTx(
  tx: DbOrTx,
  input: { readonly session_id: string; readonly revision: number; readonly kind: string; readonly time: number },
  caps: { readonly maxRows: number; readonly maxBytes: number },
): Effect.Effect<Entry> {
  return Effect.gen(function* () {
    assertKind(input.kind as string)
    // Fast path: if row already exists, return it without attempting insert (avoids seq consumption)
    const preExisting = yield* tx
      .select()
      .from(SessionChangefeedTable)
      .where(
        and(
          eq(SessionChangefeedTable.session_id, input.session_id),
          eq(SessionChangefeedTable.revision, input.revision),
          eq(SessionChangefeedTable.kind, input.kind as Kind),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (preExisting) {
      return {
        seq: preExisting.seq,
        session_id: preExisting.session_id,
        revision: preExisting.revision,
        kind: preExisting.kind as Kind,
        time: preExisting.time,
      } as Entry
    }
    // Try insert; on UNIQUE race, return existing without consuming extra seq
    const insertExit = yield* tx
      .insert(SessionChangefeedTable)
      .values({
        session_id: input.session_id,
        revision: input.revision,
        kind: input.kind as Kind,
        time: input.time,
      })
      .returning({
        seq: SessionChangefeedTable.seq,
        session_id: SessionChangefeedTable.session_id,
        revision: SessionChangefeedTable.revision,
        kind: SessionChangefeedTable.kind,
        time: SessionChangefeedTable.time,
      })
      .get()
      .pipe(Effect.exit)
    let attempted: typeof SessionChangefeedTable.$inferSelect | undefined
    if (Exit.isSuccess(insertExit)) {
      attempted = insertExit.value
    } else {
      const cause = insertExit.cause
      const err = Cause.squash(cause) as unknown
      const msg = String((err as any)?.message ?? err ?? "")
      const isUnique = msg.includes("UNIQUE") || msg.includes("constraint") || msg.includes("unique")
      if (!isUnique) yield* Effect.die(cause as unknown as Error)
      attempted = undefined
    }
    if (!attempted) {
      const existing = yield* tx
        .select()
        .from(SessionChangefeedTable)
        .where(
          and(
            eq(SessionChangefeedTable.session_id, input.session_id),
            eq(SessionChangefeedTable.revision, input.revision),
            eq(SessionChangefeedTable.kind, input.kind as Kind),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!existing) yield* Effect.die("changefeed duplicate missing after conflict")
      return {
        seq: existing!.seq,
        session_id: existing!.session_id,
        revision: existing!.revision,
        kind: existing!.kind as Kind,
        time: existing!.time,
      } as Entry
    }
    const inserted = attempted as Entry
    const size = byteSize(input.session_id, input.kind)
    const state = yield* ensureStateTx(tx)
    const newSeq = inserted.seq
    let newRows = state.retained_rows + 1
    let newBytes = state.retained_bytes + size
    if (newRows > caps.maxRows || newBytes > caps.maxBytes) {
      const rows = yield* tx.select().from(SessionChangefeedTable).orderBy(asc(SessionChangefeedTable.seq)).all().pipe(Effect.orDie)
      let tempRows = newRows
      let tempBytes = newBytes
      let evictCount = 0
      for (let i = 0; i < rows.length; i++) {
        if (tempRows <= caps.maxRows && tempBytes <= caps.maxBytes) break
        const r = rows[i]!
        const s = byteSize(r.session_id, r.kind as string)
        tempRows -= 1
        tempBytes -= s
        evictCount += 1
      }
      if (evictCount > 0) {
        const toEvict = rows.slice(0, evictCount).map((r) => r.seq)
        yield* tx.delete(SessionChangefeedTable).where(inArray(SessionChangefeedTable.seq, toEvict)).run().pipe(Effect.orDie)
        newRows = tempRows
        newBytes = tempBytes
      }
    }
    yield* tx
      .update(SessionChangefeedStateTable)
      .set({ latest_seq: newSeq, retained_rows: newRows, retained_bytes: newBytes })
      .where(eq(SessionChangefeedStateTable.id, 1))
      .run()
      .pipe(Effect.orDie)
    return inserted
  })
}

// Root wrappers: open one immediate transaction
export function append(
  db: Database.Interface["db"],
  input: { readonly session_id: string; readonly revision: number; readonly kind: Kind; readonly time: number },
): Effect.Effect<Entry> {
  return db.transaction((tx) => appendTx(tx, input), { behavior: "immediate" }).pipe(Effect.orDie) as Effect.Effect<Entry>
}

export function appendWithCaps(
  db: Database.Interface["db"],
  input: { readonly session_id: string; readonly revision: number; readonly kind: string; readonly time: number },
  caps: { readonly maxRows: number; readonly maxBytes: number },
): Effect.Effect<Entry> {
  return db.transaction((tx) => appendWithCapsTx(tx, input, caps), { behavior: "immediate" }).pipe(Effect.orDie) as Effect.Effect<Entry>
}

export function currentCursorTx(tx: DbOrTx) {
  return Effect.gen(function* () {
    const state = yield* ensureStateTx(tx)
    return state.latest_seq
  })
}

export function currentCursor(db: Database.Interface["db"]) {
  return db.transaction((tx) => currentCursorTx(tx as DbOrTx), { behavior: "immediate" }).pipe(Effect.orDie)
}

export function getStateTx(tx: DbOrTx) {
  return Effect.gen(function* () {
    const state = yield* ensureStateTx(tx)
    return { latest_seq: state.latest_seq, retained_rows: state.retained_rows, retained_bytes: state.retained_bytes }
  })
}

export function getState(db: Database.Interface["db"]) {
  return db.transaction((tx) => getStateTx(tx as DbOrTx), { behavior: "immediate" }).pipe(Effect.orDie)
}

export function readAfterTx(tx: DbOrTx, cursor: number): Effect.Effect<ReadResult> {
  return Effect.gen(function* () {
    const state = yield* ensureStateTx(tx)
    const latest = state.latest_seq
    if (cursor < 0 || !Number.isInteger(cursor)) {
      return { type: "rehydrate", cursor: latest, reason: "invalid cursor" } as ReadResult
    }
    if (cursor > latest) {
      return { type: "rehydrate", cursor: latest, reason: "cursor ahead" } as ReadResult
    }
    const rows = yield* tx.select().from(SessionChangefeedTable).orderBy(asc(SessionChangefeedTable.seq)).all().pipe(Effect.orDie)
    if (rows.length === 0) {
      if (cursor === latest) return { type: "deltas", cursor: latest, entries: [] } as ReadResult
      return { type: "rehydrate", cursor: latest, reason: "truncated" } as ReadResult
    }
    const minSeq = rows[0]!.seq
    if (cursor + 1 < minSeq) {
      return { type: "rehydrate", cursor: latest, reason: "evicted" } as ReadResult
    }
    const entries = rows
      .filter((r) => r.seq > cursor)
      .map((r) => ({ seq: r.seq, session_id: r.session_id, revision: r.revision, kind: r.kind as Kind, time: r.time }) as Entry)
    // interior gap detection: any missing seq in returned window => rehydrate
    if (entries.length > 0) {
      let expected = cursor + 1
      for (const e of entries) {
        if (e.seq !== expected) {
          return { type: "rehydrate", cursor: latest, reason: "gap" } as ReadResult
        }
        expected += 1
      }
    }
    if (cursor < latest) {
      if (entries.length === 0) {
        return { type: "rehydrate", cursor: latest, reason: "gap" } as ReadResult
      }
      const last = entries[entries.length - 1]!.seq
      if (last !== latest) {
        return { type: "rehydrate", cursor: latest, reason: "gap" } as ReadResult
      }
      if (entries.length !== latest - cursor) {
        return { type: "rehydrate", cursor: latest, reason: "gap" } as ReadResult
      }
    }
    return { type: "deltas", cursor: latest, entries } as ReadResult
  })
}

export function readAfter(db: Database.Interface["db"], cursor: number): Effect.Effect<ReadResult> {
  return db.transaction((tx) => readAfterTx(tx as DbOrTx, cursor), { behavior: "immediate" }).pipe(Effect.orDie)
}

export function ackTx(tx: DbOrTx, cursor: number): Effect.Effect<void, CursorAheadError> {
  return Effect.gen(function* () {
    const state = yield* ensureStateTx(tx)
    const latest = state.latest_seq
    if (cursor > latest) {
      return yield* Effect.fail(new CursorAheadError(cursor, latest))
    }
    if (cursor < 0 || !Number.isInteger(cursor)) {
      return yield* Effect.fail(new CursorAheadError(cursor, latest))
    }
    const toDelete = yield* tx.select().from(SessionChangefeedTable).where(lte(SessionChangefeedTable.seq, cursor)).all().pipe(Effect.orDie)
    if (toDelete.length === 0) return
    yield* tx.delete(SessionChangefeedTable).where(lte(SessionChangefeedTable.seq, cursor)).run().pipe(Effect.orDie)
    const remaining = yield* tx.select().from(SessionChangefeedTable).orderBy(asc(SessionChangefeedTable.seq)).all().pipe(Effect.orDie)
    let newRows = remaining.length
    let newBytes = 0
    for (const r of remaining) newBytes += byteSize(r.session_id, r.kind as string)
    yield* tx
      .update(SessionChangefeedStateTable)
      .set({ retained_rows: newRows, retained_bytes: newBytes })
      .where(eq(SessionChangefeedStateTable.id, 1))
      .run()
      .pipe(Effect.orDie)
  })
}

export function ack(db: Database.Interface["db"], cursor: number): Effect.Effect<void, CursorAheadError> {
  return db.transaction((tx) => ackTx(tx, cursor), { behavior: "immediate" }) as Effect.Effect<void, CursorAheadError>
}
