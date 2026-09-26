export * as SessionGeneration from "./generation"

import { and, asc, eq, sql } from "drizzle-orm"
import { Data, Effect } from "effect"
import { Database } from "../database/database"
import { SessionTable, SessionGenerationMemberTable, SessionGenerationOwnerTable, SessionOperationTable } from "./sql"
import type { SessionSchema } from "./schema"

export const CLOSE_REASONS = ["completed", "interrupted", "error", "crash"] as const
export type CloseReason = (typeof CLOSE_REASONS)[number]

export const RETRY_LAYERS = ["provider", "incomplete", "broker", "task", "restart"] as const
export type RetryLayer = (typeof RETRY_LAYERS)[number]

const closeSet = new Set<string>(CLOSE_REASONS as readonly string[])
const layerSet = new Set<string>(RETRY_LAYERS as readonly string[])

export interface Owner {
  genID: string
  sessionID: string
  occurrence: number
  closedAt: number | null
  reason: CloseReason | null
  limit: number
  used: number
  /** Last charged retry layer (provenance only, not a scheduler). Retained after close. */
  layer: RetryLayer | null
  /** Failure occurrence time for the last charged retry (ms). Null when never charged or for legacy rows charged before this column existed; retained after close. Never fabricated from operation time or boot receipt. */
  retryOccurrence: number | null
  /** Last scheduled occurrence intent (next-at ms). Null when no intent is pending or after terminal close/crash. */
  nextAt: number | null
}

export interface Member {
  genID: string
  promptOpID: string
  sessionID: string
  added: number
}

type DbOrTx = Database.Interface["db"] | Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]

function assertGen(value: string) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("genID must be non-empty string")
  if (value.includes(":")) throw new TypeError("genID must not contain ':'")
}

function assertLimit(value: number) {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) throw new TypeError("limit must be integer >=0")
}

function promptOp(messageID: string): string {
  if (typeof messageID !== "string" || messageID.length === 0) throw new TypeError("messageID must be non-empty string")
  if (messageID.includes(":")) throw new TypeError("messageID must not contain ':'")
  return `prompt:${messageID}`
}

function assertNoCrossGenMember(
  existing: typeof SessionGenerationMemberTable.$inferSelect | undefined,
  op: string,
  genID: string,
): void {
  if (!existing) return
  if (existing.gen_id === genID) return
  throw new Error(`prompt ${op} already owned by generation ${existing.gen_id}, cannot join ${genID}`)
}

function lookupMemberByOp(
  tx: DbOrTx,
  op: string,
): Effect.Effect<typeof SessionGenerationMemberTable.$inferSelect | undefined, unknown, never> {
  return Effect.gen(function* () {
    const row = yield* tx
      .select()
      .from(SessionGenerationMemberTable)
      .where(eq(SessionGenerationMemberTable.prompt_op_id, op))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    return row as typeof SessionGenerationMemberTable.$inferSelect
  })
}

function rowToOwner(row: typeof SessionGenerationOwnerTable.$inferSelect): Owner {
  return {
    genID: row.gen_id,
    sessionID: row.session_id as unknown as string,
    occurrence: row.occurrence_time,
    closedAt: (row.close_time as number | null | undefined) ?? null,
    reason: (row.close_reason as CloseReason | null | undefined) ?? null,
    limit: row.retry_limit,
    used: row.retry_consumed,
    layer: (row.retry_layer as RetryLayer | null | undefined) ?? null,
    retryOccurrence: (row.retry_occurrence_time as number | null | undefined) ?? null,
    nextAt: (row.retry_next_at as number | null | undefined) ?? null,
  }
}

function validateOwnerRow(row: typeof SessionGenerationOwnerTable.$inferSelect): Owner {
  assertGen(row.gen_id)
  if (typeof row.session_id !== "string" || row.session_id.length === 0) throw new TypeError("session_id must be non-empty")
  if (typeof row.occurrence_time !== "number" || !Number.isFinite(row.occurrence_time))
    throw new TypeError("occurrence_time must be finite number")
  if (row.close_time !== null && row.close_time !== undefined) {
    if (typeof row.close_time !== "number" || !Number.isFinite(row.close_time)) throw new TypeError("close_time must be finite")
  }
  if (row.close_reason !== null && row.close_reason !== undefined) {
    if (!closeSet.has(row.close_reason as string)) throw new TypeError(`close_reason invalid ${row.close_reason}`)
  }
  assertLimit(row.retry_limit)
  if (!Number.isInteger(row.retry_consumed) || row.retry_consumed < 0) throw new TypeError("retry_consumed invalid")
  if (row.retry_consumed > row.retry_limit) throw new TypeError("retry_consumed exceeds limit")
  const layer = (row.retry_layer as RetryLayer | null | undefined) ?? null
  if (layer !== null && !layerSet.has(layer as string)) throw new TypeError(`retry_layer invalid ${row.retry_layer}`)
  const retryOccurrence = (row.retry_occurrence_time as number | null | undefined) ?? null
  // Row validation stays finite-based for legacy nullable compat: historical
  // non-safe-integer values are not retro-rejected here. The strict
  // safe-integer >= 0 gate lives only in assertSchedule for new writes; rows
  // die here only when structurally damaged (orphan occurrence, split intent,
  // closed pending intent).
  if (retryOccurrence !== null && (typeof retryOccurrence !== "number" || !Number.isFinite(retryOccurrence)))
    throw new TypeError("retry_occurrence_time must be finite number or null")
  const nextAt = (row.retry_next_at as number | null | undefined) ?? null
  if (nextAt !== null && (typeof nextAt !== "number" || !Number.isFinite(nextAt)))
    throw new TypeError("retry_next_at must be finite number or null")
  const closed = row.close_reason !== null && row.close_reason !== undefined
  if (closed) {
    // Terminal rows never carry a pending intent; the last layer and the last
    // failure occurrence are retained as provenance only. A closed orphan
    // occurrence without its layer is never valid and dies here.
    if (nextAt !== null) throw new TypeError("retry_next_at must be null once closed")
    if (retryOccurrence !== null && layer === null)
      throw new TypeError("retry_occurrence_time requires retry_layer once closed")
  } else {
    // Open rows carry either no intent yet (all null) or one atomic intent.
    // Legacy rows charged before retry_occurrence_time existed keep
    // (layer, nextAt) with a null occurrence; new charges persist all three
    // together, so an occurrence without its layer/nextAt is never valid.
    if ((layer === null) !== (nextAt === null)) throw new TypeError("retry_layer and retry_next_at must be set together")
    if (retryOccurrence !== null && (layer === null || nextAt === null))
      throw new TypeError("retry_occurrence_time requires retry_layer and retry_next_at")
  }
  return rowToOwner(row)
}

function isAcceptedPromptRow(row: typeof SessionOperationTable.$inferSelect, sessionID: string): boolean {
  if ((row.session_id as unknown as string) !== sessionID) return false
  if (row.op_kind !== "prompt") return false
  if (row.outcome !== "in-flight") return false
  return true
}

function beginTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  genID: string,
  baseID: string,
  limit: number,
): Effect.Effect<{ created: true; added: string } | { created: false; empty: true } | { created: false; empty: false }, unknown, never> {
  return Effect.gen(function* () {
    assertGen(genID)
    assertLimit(limit)
    const op = promptOp(baseID)
    const sid = sessionID as unknown as string
    const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    if (!session) yield* Effect.die(new Error(`session not found ${sid}`))
    const existingOwner = yield* tx
      .select()
      .from(SessionGenerationOwnerTable)
      .where(eq(SessionGenerationOwnerTable.gen_id, genID))
      .get()
      .pipe(Effect.orDie)
    if (existingOwner) {
      const own = existingOwner as typeof SessionGenerationOwnerTable.$inferSelect
      if ((own.session_id as unknown as string) !== sid)
        yield* Effect.die(new Error(`cross-identity gen ${genID} already owned by session ${own.session_id}`))
      const member = yield* tx
        .select()
        .from(SessionGenerationMemberTable)
        .where(
          and(eq(SessionGenerationMemberTable.gen_id, genID), eq(SessionGenerationMemberTable.prompt_op_id, op)),
        )
        .get()
        .pipe(Effect.orDie)
      if (member) return { created: false as const, empty: false as const }
      const promptRow = yield* tx
        .select()
        .from(SessionOperationTable)
        .where(eq(SessionOperationTable.op_id, op))
        .get()
        .pipe(Effect.orDie)
      if (!promptRow || !isAcceptedPromptRow(promptRow as typeof SessionOperationTable.$inferSelect, sid))
        return { created: false as const, empty: false as const }
      // Ownership invariant: one prompt operation belongs to at most one
      // generation lifetime. Same-gen re-begin is idempotent above; an
      // accepted prompt already linked elsewhere fails closed here, even
      // when the prior owner is closed. Terminal/synthetic/missing rows
      // already returned above and never reach this guard.
      const clash = yield* lookupMemberByOp(tx, op)
      if (clash) {
        try {
          assertNoCrossGenMember(clash, op, genID)
        } catch (e) {
          yield* Effect.die(e instanceof Error ? e : new Error(String(e)))
        }
      }
      const now = Date.now()
      yield* tx
        .insert(SessionGenerationMemberTable)
        .values({ gen_id: genID, prompt_op_id: op, session_id: sessionID, added_time: now })
        .run()
        .pipe(Effect.orDie)
      return { created: false as const, empty: false as const }
    }
    const promptRow = yield* tx
      .select()
      .from(SessionOperationTable)
      .where(eq(SessionOperationTable.op_id, op))
      .get()
      .pipe(Effect.orDie)
    if (!promptRow || !isAcceptedPromptRow(promptRow as typeof SessionOperationTable.$inferSelect, sid)) {
      return { created: false as const, empty: true as const }
    }
    // Brand-new owner path: check cross-generation membership before any
    // owner/member mutation so a duplicate dies with no orphan owner row;
    // the enclosing immediate transaction rolls back as one unit. A UNIQUE
    // violation on the member insert below is the concurrent-race backstop
    // for the same invariant.
    const clash = yield* lookupMemberByOp(tx, op)
    if (clash) {
      try {
        assertNoCrossGenMember(clash, op, genID)
      } catch (e) {
        yield* Effect.die(e instanceof Error ? e : new Error(String(e)))
      }
    }
    const now = Date.now()
    yield* tx
      .insert(SessionGenerationOwnerTable)
      .values({
        gen_id: genID,
        session_id: sessionID,
        occurrence_time: now,
        close_time: null,
        close_reason: null,
        retry_limit: limit,
        retry_consumed: 0,
        retry_layer: null,
        retry_occurrence_time: null,
        retry_next_at: null,
      })
      .run()
      .pipe(Effect.orDie)
    yield* tx
      .insert(SessionGenerationMemberTable)
      .values({ gen_id: genID, prompt_op_id: op, session_id: sessionID, added_time: now })
      .run()
      .pipe(Effect.orDie)
    return { created: true as const, added: op }
  })
}

export function begin(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  genID: string,
  baseID: string,
  limit: number,
): Effect.Effect<{ created: true; added: string } | { created: false; empty: true } | { created: false; empty: false }> {
  return Effect.gen(function* () {
    return yield* (db as unknown as { transaction: (cb: (tx: unknown) => Effect.Effect<unknown>) => Effect.Effect<{ created: true; added: string } | { created: false; empty: true } | { created: false; empty: false }> })
      // @ts-expect-error - drizzle transaction options vary by driver
      .transaction((tx) => beginTx(tx as unknown as DbOrTx, sessionID, genID, baseID, limit), { behavior: "immediate" })
  }).pipe(Effect.orDie) as Effect.Effect<{ created: true; added: string } | { created: false; empty: true } | { created: false; empty: false }>
}

// Durable join persists only accepted prompt/in-flight rows. The volatile
// queue snapshot may contain terminal or synthetic retarget IDs that are
// actually executing; they are skipped here (never members) without changing
// queue scope() behavior.
function addTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  genID: string,
  ids: readonly string[],
): Effect.Effect<{ added: string[]; skipped: string[] }, unknown, never> {
  return Effect.gen(function* () {
    assertGen(genID)
    const sid = sessionID as unknown as string
    const owner = yield* tx
      .select()
      .from(SessionGenerationOwnerTable)
      .where(eq(SessionGenerationOwnerTable.gen_id, genID))
      .get()
      .pipe(Effect.orDie)
    if (!owner) return { added: [], skipped: [...ids].map((id) => promptOp(id)) }
    const own = owner as typeof SessionGenerationOwnerTable.$inferSelect
    if ((own.session_id as unknown as string) !== sid)
      yield* Effect.die(new Error(`cross-identity gen ${genID} already owned by session ${own.session_id}`))
    if (own.close_reason !== null && own.close_reason !== undefined) {
      return { added: [], skipped: [...ids].map((id) => promptOp(id)) }
    }
    const added: string[] = []
    const skipped: string[] = []
    const now = Date.now()
    // Pre-flight ownership check before any member mutation: an accepted
    // prompt already linked to another generation fails the whole add
    // closed, so the enclosing immediate transaction rolls back with no
    // partial inserts. Same-gen members and non-accepted (terminal/
    // synthetic/missing) rows stay skip-only and never trigger this guard.
    for (const id of ids) {
      const op = promptOp(id)
      const promptRow = yield* tx
        .select()
        .from(SessionOperationTable)
        .where(eq(SessionOperationTable.op_id, op))
        .get()
        .pipe(Effect.orDie)
      if (!promptRow || !isAcceptedPromptRow(promptRow as typeof SessionOperationTable.$inferSelect, sid)) continue
      const same = yield* tx
        .select()
        .from(SessionGenerationMemberTable)
        .where(and(eq(SessionGenerationMemberTable.gen_id, genID), eq(SessionGenerationMemberTable.prompt_op_id, op)))
        .get()
        .pipe(Effect.orDie)
      if (same) continue
      const clash = yield* lookupMemberByOp(tx, op)
      if (clash) {
        try {
          assertNoCrossGenMember(clash, op, genID)
        } catch (e) {
          yield* Effect.die(e instanceof Error ? e : new Error(String(e)))
        }
      }
    }
    for (const id of ids) {
      const op = promptOp(id)
      const promptRow = yield* tx
        .select()
        .from(SessionOperationTable)
        .where(eq(SessionOperationTable.op_id, op))
        .get()
        .pipe(Effect.orDie)
      if (!promptRow || !isAcceptedPromptRow(promptRow as typeof SessionOperationTable.$inferSelect, sid)) {
        skipped.push(op)
        continue
      }
      const member = yield* tx
        .select()
        .from(SessionGenerationMemberTable)
        .where(and(eq(SessionGenerationMemberTable.gen_id, genID), eq(SessionGenerationMemberTable.prompt_op_id, op)))
        .get()
        .pipe(Effect.orDie)
      if (member) {
        skipped.push(op)
        continue
      }
      yield* tx
        .insert(SessionGenerationMemberTable)
        .values({ gen_id: genID, prompt_op_id: op, session_id: sessionID, added_time: now })
        .run()
        .pipe(Effect.orDie)
      added.push(op)
    }
    return { added, skipped }
  })
}

export function add(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  genID: string,
  ids: readonly string[],
): Effect.Effect<{ added: string[]; skipped: string[] }> {
  if (ids.length === 0) return Effect.succeed({ added: [], skipped: [] })
  return Effect.gen(function* () {
    return yield* (db as unknown as { transaction: (cb: (tx: unknown) => Effect.Effect<unknown>) => Effect.Effect<{ added: string[]; skipped: string[] }> })
      // @ts-expect-error - drizzle transaction options vary by driver
      .transaction((tx) => addTx(tx as unknown as DbOrTx, sessionID, genID, ids), { behavior: "immediate" })
  }).pipe(Effect.orDie) as Effect.Effect<{ added: string[]; skipped: string[] }>
}

function closeTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  genID: string,
  reason: CloseReason,
): Effect.Effect<{ applied: boolean }, unknown, never> {
  return Effect.gen(function* () {
    assertGen(genID)
    if (!closeSet.has(reason)) yield* Effect.die(new TypeError(`close reason invalid ${reason}`))
    const sid = sessionID as unknown as string
    const owner = yield* tx
      .select()
      .from(SessionGenerationOwnerTable)
      .where(eq(SessionGenerationOwnerTable.gen_id, genID))
      .get()
      .pipe(Effect.orDie)
    if (!owner) return { applied: false }
    const own = owner as typeof SessionGenerationOwnerTable.$inferSelect
    if ((own.session_id as unknown as string) !== sid)
      yield* Effect.die(new Error(`cross-identity gen ${genID} already owned by session ${own.session_id}`))
    if (own.close_reason !== null && own.close_reason !== undefined) return { applied: false }
    const now = Date.now()
    // Open-only conditional CAS: only the first writer moves open -> terminal.
    // Any terminal close never overwrites an already-written final state; the
    // loser observes 0 updated rows and returns applied:false with no feed.
    // Terminal close clears any pending next-at intent while retaining the
    // last layer and the last failure occurrence as provenance
    // (non-scheduler, no replay; close_time is receipt, never occurrence).
    const updated = yield* tx
      .update(SessionGenerationOwnerTable)
      .set({ close_reason: reason, close_time: now, retry_next_at: null })
      .where(
        and(
          eq(SessionGenerationOwnerTable.gen_id, genID),
          sql`${SessionGenerationOwnerTable.close_reason} IS NULL`,
        ),
      )
      .returning({ gen_id: SessionGenerationOwnerTable.gen_id })
      .all()
      .pipe(Effect.orDie)
    if ((updated as unknown[]).length !== 1) return { applied: false }
    return { applied: true }
  })
}

export function close(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  genID: string,
  reason: CloseReason,
): Effect.Effect<{ applied: boolean }> {
  return Effect.gen(function* () {
    return yield* ((db as any).transaction(
      (tx: unknown) => closeTx(tx as unknown as DbOrTx, sessionID, genID, reason),
      { behavior: "immediate" },
    ) as Effect.Effect<{ applied: boolean }>)
  }).pipe(Effect.orDie) as Effect.Effect<{ applied: boolean }>
}

export interface ChargeResult {
  charged: boolean
  used: number
  limit: number
  missing: boolean
  closed: boolean
  exhausted: boolean
  layer: RetryLayer | null
  /** Failure occurrence time for the last charged retry (ms). Null when never charged or for legacy rows; retained after close. */
  occurrenceTime: number | null
  nextAt: number | null
}

/**
 * Atomic schedule intent for one actual retry (never the free initial
 * attempt). Each charge consumes one budget unit; the persisted
 * layer/occurrenceTime/nextAt always reflect the last charged failure
 * occurrence, so a later charge overwrites the earlier intent (last-writer
 * wins, no idempotency key, no scheduler). Callers compute `wait` from the
 * existing error/retry-after policy plus the failure occurrence time
 * (`occurrenceTime`) first, then pass `nextAt = occurrenceTime + wait` here
 * so a single DB CAS persists the charge, the layer attribution, and the
 * next-at occurrence intent together. A failed CAS persists nothing: no
 * deducted-without-scheduled state exists.
 */
export interface ChargeSchedule {
  layer: RetryLayer
  occurrenceTime: number
  nextAt: number
}

function assertSchedule(schedule: ChargeSchedule): void {
  if (!schedule || typeof schedule !== "object") throw new TypeError("schedule must be object")
  if (!layerSet.has(schedule.layer as string)) throw new TypeError(`schedule layer invalid ${schedule.layer}`)
  if (typeof schedule.occurrenceTime !== "number" || !Number.isSafeInteger(schedule.occurrenceTime) || schedule.occurrenceTime < 0)
    throw new TypeError("schedule occurrenceTime must be safe integer >= 0")
  if (typeof schedule.nextAt !== "number" || !Number.isSafeInteger(schedule.nextAt) || schedule.nextAt < 0)
    throw new TypeError("schedule nextAt must be safe integer >= 0")
  if (schedule.nextAt < schedule.occurrenceTime) throw new TypeError("schedule nextAt must not precede occurrenceTime")
}

function chargeSelect(
  tx: DbOrTx,
  genID: string,
): Effect.Effect<typeof SessionGenerationOwnerTable.$inferSelect | undefined, unknown, never> {
  return Effect.gen(function* () {
    const row = yield* tx
      .select()
      .from(SessionGenerationOwnerTable)
      .where(eq(SessionGenerationOwnerTable.gen_id, genID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    return row as typeof SessionGenerationOwnerTable.$inferSelect
  })
}

function classifyNoCharge(
  row: typeof SessionGenerationOwnerTable.$inferSelect | undefined,
  sid: string,
): ChargeResult {
  if (!row) return { charged: false, used: 0, limit: 0, missing: true, closed: false, exhausted: false, layer: null, occurrenceTime: null, nextAt: null }
  const own = validateOwnerRow(row)
  if ((row.session_id as unknown as string) !== sid)
    throw new Error(`cross-identity gen ${row.gen_id} already owned by session ${row.session_id}`)
  if (own.closedAt !== null || own.reason !== null)
    return { charged: false, used: own.used, limit: own.limit, missing: false, closed: true, exhausted: false, layer: own.layer, occurrenceTime: own.retryOccurrence, nextAt: null }
  if (own.used >= own.limit)
    return { charged: false, used: own.used, limit: own.limit, missing: false, closed: false, exhausted: true, layer: own.layer, occurrenceTime: own.retryOccurrence, nextAt: own.nextAt }
  return { charged: false, used: own.used, limit: own.limit, missing: false, closed: false, exhausted: true, layer: own.layer, occurrenceTime: own.retryOccurrence, nextAt: own.nextAt }
}

export function charge(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  genID: string,
  schedule?: ChargeSchedule,
): Effect.Effect<ChargeResult> {
  return Effect.gen(function* () {
    assertGen(genID)
    if (schedule !== undefined) assertSchedule(schedule)
    const sid = sessionID as unknown as string
    if (typeof sid !== "string" || sid.length === 0) yield* Effect.die(new TypeError("session_id must be non-empty"))
    const pre = yield* chargeSelect(db as unknown as DbOrTx, genID)
    if (!pre) return { charged: false, used: 0, limit: 0, missing: true, closed: false, exhausted: false, layer: null, occurrenceTime: null, nextAt: null } as ChargeResult
    if ((pre.session_id as unknown as string) !== sid)
      yield* Effect.die(new Error(`cross-identity gen ${genID} already owned by session ${pre.session_id}`))
    let cur: Owner
    try {
      cur = validateOwnerRow(pre)
    } catch (e) {
      return yield* Effect.die(new TypeError(`invalid generation owner row ${genID}: ${e instanceof Error ? e.message : String(e)}`))
    }
    if (cur.closedAt !== null || cur.reason !== null)
      return { charged: false, used: cur.used, limit: cur.limit, missing: false, closed: true, exhausted: false, layer: cur.layer, occurrenceTime: cur.retryOccurrence, nextAt: null }
    if (cur.used >= cur.limit)
      return { charged: false, used: cur.used, limit: cur.limit, missing: false, closed: false, exhausted: true, layer: cur.layer, occurrenceTime: cur.retryOccurrence, nextAt: cur.nextAt }
    // Single atomic CAS: consumed +1 with the layer attribution, the failure
    // occurrence time, and the precomputed next-at intent in the same
    // conditional UPDATE. Each charge is one budget consumption and overwrites
    // the last occurrence (last-writer wins). A failed CAS writes nothing, so
    // a retry is never deducted without its schedule.
    const set = schedule
      ? {
          retry_consumed: sql`${SessionGenerationOwnerTable.retry_consumed} + 1`,
          retry_layer: schedule.layer,
          retry_occurrence_time: schedule.occurrenceTime,
          retry_next_at: schedule.nextAt,
        }
      : { retry_consumed: sql`${SessionGenerationOwnerTable.retry_consumed} + 1` }
    const updated = yield* (db as unknown as DbOrTx)
      .update(SessionGenerationOwnerTable)
      .set(set)
      .where(
        and(
          eq(SessionGenerationOwnerTable.gen_id, genID),
          sql`${SessionGenerationOwnerTable.close_reason} IS NULL`,
          sql`${SessionGenerationOwnerTable.retry_consumed} < ${SessionGenerationOwnerTable.retry_limit}`,
        ),
      )
      .returning({
        retry_consumed: SessionGenerationOwnerTable.retry_consumed,
        retry_limit: SessionGenerationOwnerTable.retry_limit,
        retry_layer: SessionGenerationOwnerTable.retry_layer,
        retry_occurrence_time: SessionGenerationOwnerTable.retry_occurrence_time,
        retry_next_at: SessionGenerationOwnerTable.retry_next_at,
      })
      .all()
      .pipe(Effect.orDie)
    const rows = updated as unknown as { retry_consumed: number; retry_limit: number; retry_layer: RetryLayer | null; retry_occurrence_time: number | null; retry_next_at: number | null }[]
    if (rows.length === 1) {
      const first = rows[0]!
      const layer = (first.retry_layer as RetryLayer | null | undefined) ?? null
      const occurrenceTime = (first.retry_occurrence_time as number | null | undefined) ?? null
      const nextAt = (first.retry_next_at as number | null | undefined) ?? null
      return { charged: true, used: first.retry_consumed, limit: first.retry_limit, missing: false, closed: false, exhausted: false, layer, occurrenceTime, nextAt }
    }
    const fresh = yield* chargeSelect(db as unknown as DbOrTx, genID)
    return classifyNoCharge(fresh, sid)
  }).pipe(Effect.orDie) as Effect.Effect<ChargeResult>
}

export function getOwner(
  db: Database.Interface["db"],
  genID: string,
): Effect.Effect<Owner | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(SessionGenerationOwnerTable)
      .where(eq(SessionGenerationOwnerTable.gen_id, genID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    try {
      return validateOwnerRow(row as typeof SessionGenerationOwnerTable.$inferSelect)
    } catch (e) {
      return yield* Effect.die(new TypeError(`invalid generation owner row ${genID}: ${e instanceof Error ? e.message : String(e)}`))
    }
  }).pipe(Effect.orDie) as Effect.Effect<Owner | undefined>
}

/**
 * Typed durable retry-intent read, fact-backed only.
 *
 * Returns the owning scope plus the last scheduled occurrence intent with
 * `replay: false` (this intent never replays observed output and never drives
 * a scheduler; callers sleep once then issue the next attempt). Returns
 * `undefined` when no intent is pending: missing row, never-charged open row,
 * or terminally closed/crashed row (close/crash clear `nextAt` while
 * retaining `consumed`/last-layer provenance). This never reads or writes the
 * legacy `session_operation.recovery_*` stub: the old panel `nextAt` stays
 * `null` and must not be filled from this owner intent.
 */
export interface RetryIntent {
  genID: string
  sessionID: string
  /** Owning scope: the session that owns this generation. */
  scope: string
  layer: RetryLayer
  /** Failure occurrence time for the last charged retry (ms). Null for legacy rows charged before this column existed; never fabricated. */
  occurrenceTime: number | null
  nextAt: number
  used: number
  limit: number
  replay: false
}

export function getRetryIntent(
  db: Database.Interface["db"],
  genID: string,
): Effect.Effect<RetryIntent | undefined> {
  return Effect.gen(function* () {
    const owner = yield* getOwner(db, genID)
    if (!owner) return undefined
    if (owner.closedAt !== null || owner.reason !== null) return undefined
    if (owner.layer === null || owner.nextAt === null) return undefined
    return {
      genID: owner.genID,
      sessionID: owner.sessionID,
      scope: owner.sessionID,
      layer: owner.layer,
      occurrenceTime: owner.retryOccurrence,
      nextAt: owner.nextAt,
      used: owner.used,
      limit: owner.limit,
      replay: false as const,
    }
  }).pipe(Effect.orDie) as Effect.Effect<RetryIntent | undefined>
}

export function listMembers(
  db: Database.Interface["db"],
  genID: string,
): Effect.Effect<Member[]> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(SessionGenerationMemberTable)
      .where(eq(SessionGenerationMemberTable.gen_id, genID))
      .orderBy(asc(SessionGenerationMemberTable.prompt_op_id))
      .all()
      .pipe(Effect.orDie)
    return (rows as (typeof SessionGenerationMemberTable.$inferSelect)[]).map((r) => ({
      genID: r.gen_id,
      promptOpID: r.prompt_op_id,
      sessionID: r.session_id as unknown as string,
      added: r.added_time,
    }))
  }).pipe(Effect.orDie) as Effect.Effect<Member[]>
}

export interface ConvergeSummary {
  converged: string[]
  raced: string[]
  skipped: string[]
}

export class ConvergeFailure extends Data.TaggedError("SessionGeneration.ConvergeFailure")<{
  opIds: string[]
  count: number
  converged: string[]
  raced: string[]
}> {}

function safeGen(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "unknown"
  const flat = raw.replace(/[\r\n\t]+/g, " ")
  return flat.length > 200 ? flat.slice(0, 200) : flat
}

export function convergeOrphaned(
  db: Database.Interface["db"],
): Effect.Effect<ConvergeSummary, ConvergeFailure> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(SessionGenerationOwnerTable)
      .where(sql`${SessionGenerationOwnerTable.close_reason} IS NULL`)
      .orderBy(asc(SessionGenerationOwnerTable.gen_id))
      .all()
      .pipe(
        Effect.mapError(() => new ConvergeFailure({ opIds: [], count: 0, converged: [], raced: [] })),
        Effect.catchDefect(() => Effect.fail(new ConvergeFailure({ opIds: [], count: 0, converged: [], raced: [] }))),
      )
    const now = Date.now()
    const converged: string[] = []
    const raced: string[] = []
    const bad: string[] = []
    const ordered = [...(rows as (typeof SessionGenerationOwnerTable.$inferSelect)[])].sort((a, b) =>
      a.gen_id < b.gen_id ? -1 : a.gen_id > b.gen_id ? 1 : 0,
    )
    for (const row of ordered) {
      const id = safeGen((row as { gen_id?: unknown }).gen_id)
      const out = yield* Effect.gen(function* () {
        try {
          validateOwnerRow(row)
        } catch {
          return yield* Effect.fail({ opId: id })
        }
        // Per-row BEGIN IMMEDIATE + open-only CAS: re-validate, require the
        // session, then conditional UPDATE ... WHERE close_reason IS NULL with
        // RETURNING. A concurrent live close winning first leaves 0 updated
        // rows and the loser reports raced with no overwrite and no feed.
        const verdict = yield* ((db as any).transaction(
          (tx: unknown) =>
            Effect.gen(function* () {
              const t = tx as unknown as DbOrTx
              const sid = row.session_id as unknown as SessionSchema.ID
              const session = yield* t
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, sid))
                .get()
                .pipe(Effect.orDie)
              if (!session) return yield* Effect.fail({ opId: id })
              const fresh = yield* t
                .select()
                .from(SessionGenerationOwnerTable)
                .where(eq(SessionGenerationOwnerTable.gen_id, row.gen_id))
                .get()
                .pipe(Effect.orDie)
              if (!fresh) return yield* Effect.fail({ opId: id })
              const cur = fresh as typeof SessionGenerationOwnerTable.$inferSelect
              try {
                validateOwnerRow(cur)
              } catch {
                return yield* Effect.fail({ opId: id })
              }
              if ((cur.session_id as unknown as string) !== (row.session_id as unknown as string))
                return yield* Effect.fail({ opId: id })
              if (cur.close_reason !== null && cur.close_reason !== undefined) return { tag: "raced" as const }
              const updated = yield* t
                .update(SessionGenerationOwnerTable)
                .set({ close_reason: "crash" as CloseReason, close_time: now, retry_next_at: null })
                .where(
                  and(
                    eq(SessionGenerationOwnerTable.gen_id, row.gen_id),
                    sql`${SessionGenerationOwnerTable.close_reason} IS NULL`,
                  ),
                )
                .returning({ gen_id: SessionGenerationOwnerTable.gen_id })
                .all()
                .pipe(Effect.orDie)
              if ((updated as unknown[]).length !== 1) return { tag: "raced" as const }
              return { tag: "converged" as const }
            }) as Effect.Effect<{ tag: "converged" | "raced" }, { opId: string }>,
          { behavior: "immediate" },
        ) as Effect.Effect<{ tag: "converged" | "raced" }, { opId: string }>).pipe(
            Effect.mapError(() => ({ opId: id })),
            Effect.catchDefect(() => Effect.fail({ opId: id })),
          )
        return { tag: verdict.tag as "converged" | "raced", opId: id }
      }).pipe(
        Effect.map((v) => ({ ok: true as const, v })),
        Effect.catch((f: { opId: string }) => Effect.succeed({ ok: false as const, opId: f.opId })),
        Effect.catchDefect((d: unknown) => Effect.succeed({ ok: false as const, opId: safeGen((row as { gen_id?: unknown }).gen_id ?? d) })),
      )
      if (out.ok) {
        if (out.v.tag === "converged") converged.push(out.v.opId)
        else raced.push(out.v.opId)
      } else {
        bad.push(out.opId)
      }
    }
    if (bad.length > 0) {
      return yield* Effect.fail(new ConvergeFailure({ opIds: [...bad], count: bad.length, converged: [...converged], raced: [...raced] }))
    }
    return { converged, raced, skipped: [] }
  })
}
