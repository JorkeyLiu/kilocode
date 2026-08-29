export * as SessionOperation from "./operation"

import { asc, eq, and } from "drizzle-orm"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { Database } from "../database/database"
import { SessionTable, SessionOperationTable } from "./sql"
import type { SessionSchema } from "./schema"
import * as Changefeed from "../retention/changefeed"
import { SessionRevision } from "./revision"

// ---------------------------------------------------------------------------
// R12-compatible record shape (persist tier = full redacted record)
// ---------------------------------------------------------------------------
export const OP_KINDS = ["prompt", "provider", "tool", "permission", "task", "cancelQueued"] as const
export type OpKind = (typeof OP_KINDS)[number]

export const OUTCOMES = ["succeeded", "failed", "ambiguous", "in-flight", "superseded", "abandoned"] as const
export type Outcome = (typeof OUTCOMES)[number]

export const CANCEL_SOURCES = ["user_stop", "steering", "timeout", "network_disconnect", "unknown"] as const
export type CancelSource = (typeof CANCEL_SOURCES)[number]

export interface FailureRecord {
  opId: string
  opKind: OpKind
  outcome: Outcome
  code: string
  message: string
  time: number
  cancel?: { source: CancelSource }
  detail?: string
  stack?: string
}

const opKindSet = new Set<string>(OP_KINDS as readonly string[])
const outcomeSet = new Set<string>(OUTCOMES as readonly string[])
const cancelSet = new Set<string>(CANCEL_SOURCES as readonly string[])

export function isTerminal(outcome: Outcome): boolean {
  return outcome !== "in-flight"
}

// ---------------------------------------------------------------------------
// R12 tiers + redaction/cap boundary (core-owned, persists only redacted)
// ---------------------------------------------------------------------------
export const TIERS = ["durable", "diagnostic", "panel-visible"] as const
export type Tier = (typeof TIERS)[number]
export type Consumer = "persist" | "diagnose" | "project"

export const FIELD_TIERS: Readonly<Record<keyof FailureRecord, Tier>> = {
  opId: "panel-visible",
  opKind: "durable",
  outcome: "panel-visible",
  code: "panel-visible",
  message: "panel-visible",
  time: "durable",
  cancel: "panel-visible",
  detail: "diagnostic",
  stack: "diagnostic",
}

const quotedScrub =
  /(api[_-]?key|apikey|token|authorization|password|secret|credential)\s*[:=]\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi
const bearerScrub =
  /(authorization)\s*[:=]\s*Bearer\s+(?:\[redacted\]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;"')\]}]+)/gi
const valueScrub =
  /(api[_-]?key|apikey|token|authorization|password|secret|credential)\s*[:=]\s*(?:\[redacted\]|[^\s,;"')\]}]+)/gi

function cap(s: string, max: number): string {
  if (s.length > max) return s.slice(0, max) + "…"
  return s
}

function scrubString(s: string): string {
  s = s.replace(quotedScrub, (_m: string, k: string) => `${k}=[redacted]`)
  s = s.replace(bearerScrub, (_m: string, k: string) => `${k}=[redacted]`)
  return s.replace(valueScrub, (_m: string, k: string) => `${k}=[redacted]`)
}

export function normalizeRecord(record: FailureRecord): FailureRecord {
  // preserve 9-field shape, scrub + cap string fields
  const out: FailureRecord = {
    opId: record.opId,
    opKind: record.opKind,
    outcome: record.outcome,
    code: record.code,
    message: cap(scrubString(record.message), 500),
    time: record.time,
  }
  if (record.cancel !== undefined) out.cancel = { source: record.cancel.source }
  if (record.detail !== undefined) out.detail = cap(scrubString(record.detail), 1000)
  if (record.stack !== undefined) out.stack = cap(scrubString(record.stack), 2000)
  return out
}

export function select(record: FailureRecord, consumer: Consumer): Partial<FailureRecord> {
  const allowed = new Set<Tier>()
  if (consumer === "persist") {
    allowed.add("durable")
    allowed.add("diagnostic")
    allowed.add("panel-visible")
  } else if (consumer === "diagnose") {
    allowed.add("diagnostic")
    allowed.add("panel-visible")
  } else {
    allowed.add("panel-visible")
  }
  const out: Partial<FailureRecord> = {}
  for (const k of Object.keys(FIELD_TIERS) as (keyof FailureRecord)[]) {
    const tier = FIELD_TIERS[k]
    if (!allowed.has(tier)) continue
    const v = record[k]
    if (v === undefined) continue
    ;(out as Record<string, unknown>)[k] = v
  }
  return out
}

export function toPersistedRecord(record: FailureRecord): FailureRecord {
  return normalizeRecord(record)
}

export function toPanelRecord(record: FailureRecord): Partial<FailureRecord> {
  return select(normalizeRecord(record), "project")
}

export function toDiagnosticRecord(record: FailureRecord): Partial<FailureRecord> {
  return select(normalizeRecord(record), "diagnose")
}

// ---------------------------------------------------------------------------
// Identity constructors — stable, deterministic, no colon in embedded IDs
// ---------------------------------------------------------------------------
function assertNoColon(value: string, label: string) {
  if (value.includes(":")) throw new TypeError(`${label} must not contain ':'`)
  if (value.length === 0) throw new TypeError(`${label} must be non-empty string`)
}

export function promptId(messageId: string): string {
  if (typeof messageId !== "string" || messageId.length === 0) throw new TypeError("messageId must be non-empty string")
  assertNoColon(messageId, "messageId")
  return `prompt:${messageId}`
}

export function providerId(assistantMessageId: string, attempt: number): string {
  if (typeof assistantMessageId !== "string" || assistantMessageId.length === 0)
    throw new TypeError("assistantMessageId must be non-empty string")
  assertNoColon(assistantMessageId, "assistantMessageId")
  if (!Number.isInteger(attempt) || attempt < 0) throw new TypeError("attempt must be nonnegative integer")
  return `provider:${assistantMessageId}:${attempt}`
}

export function toolId(assistantMessageId: string, callId: string): string {
  if (typeof assistantMessageId !== "string" || assistantMessageId.length === 0)
    throw new TypeError("assistantMessageId must be non-empty string")
  assertNoColon(assistantMessageId, "assistantMessageId")
  if (typeof callId !== "string" || callId.length === 0) throw new TypeError("callId must be non-empty string")
  assertNoColon(callId, "callId")
  return `tool:${assistantMessageId}:${callId}`
}

export function permissionId(requestId: string): string {
  if (typeof requestId !== "string" || requestId.length === 0) throw new TypeError("requestId must be non-empty string")
  assertNoColon(requestId, "requestId")
  return `permission:${requestId}`
}

export function taskId(childSessionId: string, parentCallId?: string): string {
  if (typeof childSessionId !== "string" || childSessionId.length === 0)
    throw new TypeError("childSessionId must be non-empty string")
  assertNoColon(childSessionId, "childSessionId")
  if (parentCallId !== undefined) {
    if (typeof parentCallId !== "string" || parentCallId.length === 0)
      throw new TypeError("parentCallId must be non-empty string")
    assertNoColon(parentCallId, "parentCallId")
    return `task:${childSessionId}:${parentCallId}`
  }
  return `task:${childSessionId}`
}

export function cancelQueuedId(sessionID: string, messageID: string): string {
  if (typeof sessionID !== "string" || sessionID.length === 0) throw new TypeError("sessionID must be non-empty string")
  assertNoColon(sessionID, "sessionID")
  if (typeof messageID !== "string" || messageID.length === 0) throw new TypeError("messageID must be non-empty string")
  assertNoColon(messageID, "messageID")
  return `cancelQueued:${sessionID}:${messageID}`
}

export function parseOpId(opId: string): { kind: OpKind; parts: string[] } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segments = opId.split(":")
  if (segments.length < 2) throw new TypeError(`opId must contain ':' separator: ${opId}`)
  const kind = segments[0]!
  if (!opKindSet.has(kind)) throw new TypeError(`opId kind must be one of ${OP_KINDS.join(", ")}: ${opId}`)
  const rest = segments.slice(1)
  for (const p of rest) if (p.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  if (kind === "prompt") {
    if (rest.length !== 1) throw new TypeError(`prompt opId must have 1 segment after kind: ${opId}`)
  } else if (kind === "provider") {
    if (rest.length !== 2) throw new TypeError(`provider opId must have 2 segments: ${opId}`)
    const attemptStr = rest[1]!
    if (!/^(0|[1-9][0-9]*)$/.test(attemptStr))
      throw new TypeError(`provider attempt must be nonnegative integer: ${opId}`)
  } else if (kind === "tool") {
    if (rest.length !== 2) throw new TypeError(`tool opId must have 2 segments: ${opId}`)
  } else if (kind === "permission") {
    if (rest.length !== 1) throw new TypeError(`permission opId must have 1 segment: ${opId}`)
  } else if (kind === "task") {
    if (rest.length !== 1 && rest.length !== 2) throw new TypeError(`task opId must have 1 or 2 segments: ${opId}`)
  } else if (kind === "cancelQueued") {
    if (rest.length !== 2) throw new TypeError(`cancelQueued opId must have 2 segments: ${opId}`)
  }
  return { kind: kind as OpKind, parts: rest }
}

function assertOpIdMatchesKind(opId: string, opKind: OpKind) {
  const parsed = parseOpId(opId)
  if (parsed.kind !== opKind) throw new TypeError(`opId kind ${parsed.kind} does not match record opKind ${opKind}`)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
export function validateRecord(record: unknown): FailureRecord {
  if (record === null || typeof record !== "object") throw new TypeError("record must be object")
  const r = record as Record<string, unknown>
  const opId = r["opId"]
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  parseOpId(opId)
  const opKind = r["opKind"]
  if (typeof opKind !== "string" || !opKindSet.has(opKind))
    throw new TypeError(`opKind must be one of ${OP_KINDS.join(", ")}`)
  assertOpIdMatchesKind(opId, opKind as OpKind)
  const outcome = r["outcome"]
  if (typeof outcome !== "string" || !outcomeSet.has(outcome))
    throw new TypeError(`outcome must be one of ${OUTCOMES.join(", ")}`)
  const code = r["code"]
  if (typeof code !== "string" || code.length === 0) throw new TypeError("code must be non-empty string")
  const message = r["message"]
  if (typeof message !== "string") throw new TypeError("message must be string")
  const time = r["time"]
  if (typeof time !== "number" || !Number.isFinite(time)) throw new TypeError("time must be finite number")
  const cancel = r["cancel"]
  if (cancel !== undefined) {
    if (cancel === null || typeof cancel !== "object" || Array.isArray(cancel))
      throw new TypeError("cancel must be object")
    const c = cancel as Record<string, unknown>
    const source = c["source"]
    if (typeof source !== "string" || !cancelSet.has(source))
      throw new TypeError(`cancel.source must be one of ${CANCEL_SOURCES.join(", ")}`)
    const extraKeys = Object.keys(c).filter((k) => k !== "source")
    if (extraKeys.length > 0) throw new TypeError(`cancel has extra keys: ${extraKeys.join(",")}`)
  }
  const detail = r["detail"]
  if (detail !== undefined && typeof detail !== "string") throw new TypeError("detail must be string")
  const stack = r["stack"]
  if (stack !== undefined && typeof stack !== "string") throw new TypeError("stack must be string")
  // reject unexpected keys beyond the 9
  const allowed = new Set(["opId", "opKind", "outcome", "code", "message", "time", "cancel", "detail", "stack"])
  for (const k of Object.keys(r)) if (!allowed.has(k)) throw new TypeError(`unexpected field ${k}`)
  return r as unknown as FailureRecord
}

function recordsEqual(a: FailureRecord, b: FailureRecord): boolean {
  if (a.opId !== b.opId) return false
  if (a.opKind !== b.opKind) return false
  if (a.outcome !== b.outcome) return false
  if (a.code !== b.code) return false
  if (a.message !== b.message) return false
  if (a.time !== b.time) return false
  const aCancel = a.cancel?.source
  const bCancel = b.cancel?.source
  if (aCancel !== bCancel) return false
  if ((a.cancel === undefined) !== (b.cancel === undefined)) return false
  if ((a.detail ?? undefined) !== (b.detail ?? undefined)) return false
  if ((a.stack ?? undefined) !== (b.stack ?? undefined)) return false
  return true
}

function rowToRecord(row: typeof SessionOperationTable.$inferSelect): FailureRecord {
  const rec: FailureRecord = {
    opId: row.op_id,
    opKind: row.op_kind as OpKind,
    outcome: row.outcome as Outcome,
    code: row.code,
    message: row.message,
    time: row.time,
  }
  if (row.cancel !== null && row.cancel !== undefined) rec.cancel = { source: row.cancel as CancelSource }
  if (row.detail !== null && row.detail !== undefined) rec.detail = row.detail
  if (row.stack !== null && row.stack !== undefined) rec.stack = row.stack
  return rec
}

export interface CancelQueuedMeta {
  idempotencyHash: string
  requestId: string
  directory: string
  messageId: string
  parentSessionId?: string | null
  configVersion?: number | null
  sessionRevision?: number | null
  cancelled?: boolean | null
}

export interface CancelQueuedRecord extends FailureRecord {
  meta: CancelQueuedMeta
}

function rowToCancelQueuedRecord(row: typeof SessionOperationTable.$inferSelect): CancelQueuedRecord {
  const base = rowToRecord(row)
  return {
    ...base,
    meta: {
      idempotencyHash: row.idempotency_hash ?? "",
      requestId: row.request_id ?? "",
      directory: row.directory ?? "",
      messageId: row.message_id ?? "",
      parentSessionId: row.parent_session_id ?? null,
      configVersion: row.config_version ?? null,
      sessionRevision: row.session_revision ?? null,
      cancelled: row.cancelled ?? null,
    },
  }
}

export function hashIdempotencyKey(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

export function getByIdempotencyHash(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  hash: string,
): Effect.Effect<CancelQueuedRecord | undefined> {
  return Effect.gen(function* () {
    if (typeof hash !== "string" || hash.length === 0) yield* Effect.die(new TypeError("hash must be non-empty string"))
    const row = yield* db
      .select()
      .from(SessionOperationTable)
      .where(and(eq(SessionOperationTable.session_id, sessionID), eq(SessionOperationTable.idempotency_hash, hash)))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    return rowToCancelQueuedRecord(row)
  }).pipe(Effect.orDie) as Effect.Effect<CancelQueuedRecord | undefined>
}

export function getByIdempotencyHashTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  hash: string,
): Effect.Effect<CancelQueuedRecord | undefined> {
  return Effect.gen(function* () {
    const row = yield* tx
      .select()
      .from(SessionOperationTable)
      .where(and(eq(SessionOperationTable.session_id, sessionID), eq(SessionOperationTable.idempotency_hash, hash)))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    return rowToCancelQueuedRecord(row)
  }).pipe(Effect.orDie) as Effect.Effect<CancelQueuedRecord | undefined>
}

export function isCancelQueuedConflict(
  prev: CancelQueuedRecord,
  next: {
    opId: string
    directory: string
    parentSessionId?: string | null
    configVersion?: number | null
    sessionRevision?: number | null
    messageId: string
  },
): boolean {
  if (prev.opId !== next.opId) return true
  if (prev.meta.directory !== next.directory) return true
  if ((prev.meta.parentSessionId ?? null) !== (next.parentSessionId ?? null)) return true
  if ((prev.meta.configVersion ?? null) !== (next.configVersion ?? null)) return true
  if ((prev.meta.sessionRevision ?? null) !== (next.sessionRevision ?? null)) return true
  if (prev.meta.messageId !== next.messageId) return true
  return false
}

// ---------------------------------------------------------------------------
// Public API: put / get / list
// ---------------------------------------------------------------------------
type DbOrTx = Database.Interface["db"] | Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]

function putTx(tx: DbOrTx, sessionID: SessionSchema.ID, record: FailureRecord): Effect.Effect<FailureRecord> {
  return Effect.gen(function* () {
    // validate shape then enforce redacted/capped boundary before any persistence
    validateRecord(record)
    const normalized = normalizeRecord(record)
    // ensure session exists
    const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    if (!session) yield* Effect.die(new Error(`session not found ${sessionID}`))
    // need to fetch existing operation if any
    const existingRow = yield* tx
      .select()
      .from(SessionOperationTable)
      .where(eq(SessionOperationTable.op_id, normalized.opId))
      .get()
      .pipe(Effect.orDie)
    if (existingRow) {
      // cross-session identity check
      if (existingRow.session_id !== sessionID)
        yield* Effect.die(
          new Error(`cross-identity opId ${normalized.opId} already owned by session ${existingRow.session_id}`),
        )
      if (existingRow.op_kind !== normalized.opKind)
        yield* Effect.die(
          new Error(
            `cross-kind conflict for ${normalized.opId}: existing ${existingRow.op_kind} vs new ${normalized.opKind}`,
          ),
        )
      const existingRecord = rowToRecord(existingRow)
      if (recordsEqual(existingRecord, normalized)) {
        // idempotent — no revision, no feed
        return existingRecord
      }
      // not equal: enforce terminal regression and narrowest transition
      if (isTerminal(existingRecord.outcome) && normalized.outcome === "in-flight") {
        yield* Effect.die(
          new Error(`terminal outcome ${existingRecord.outcome} cannot regress to in-flight for ${normalized.opId}`),
        )
      }
      if (isTerminal(existingRecord.outcome) && isTerminal(normalized.outcome)) {
        yield* Effect.die(
          new Error(
            `terminal outcome already recorded for ${normalized.opId}: ${existingRecord.outcome} vs ${normalized.outcome}`,
          ),
        )
      }
      if (existingRecord.outcome === "in-flight" && isTerminal(normalized.outcome)) {
        // allowed transition — fall through to update
      } else {
        // any other non-identical transition (e.g., in-flight -> in-flight with different message) is conflict
        yield* Effect.die(
          new Error(`conflicting update for ${normalized.opId}: ${existingRecord.outcome} -> ${normalized.outcome}`),
        )
      }
      // allowed update: advance revision then update row
      yield* SessionRevision.advanceTx(sessionID, tx)
      const after = yield* tx
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      const nextRev = after!.rev
      yield* tx
        .update(SessionOperationTable)
        .set({
          op_kind: normalized.opKind,
          outcome: normalized.outcome,
          code: normalized.code,
          message: normalized.message,
          time: normalized.time,
          cancel: normalized.cancel?.source ?? null,
          detail: normalized.detail ?? null,
          stack: normalized.stack ?? null,
          revision: nextRev,
          session_id: sessionID,
        })
        .where(eq(SessionOperationTable.op_id, normalized.opId))
        .run()
        .pipe(Effect.orDie)
      const updated = yield* tx
        .select()
        .from(SessionOperationTable)
        .where(eq(SessionOperationTable.op_id, normalized.opId))
        .get()
        .pipe(Effect.orDie)
      if (!updated) yield* Effect.die(new Error(`operation row missing after update ${normalized.opId}`))
      return rowToRecord(updated as typeof SessionOperationTable.$inferSelect)
    } else {
      // new operation: advance revision then insert
      yield* SessionRevision.advanceTx(sessionID, tx)
      const after = yield* tx
        .select({ rev: SessionTable.revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      const nextRev = after!.rev
      yield* tx
        .insert(SessionOperationTable)
        .values({
          op_id: normalized.opId,
          session_id: sessionID,
          op_kind: normalized.opKind,
          outcome: normalized.outcome,
          code: normalized.code,
          message: normalized.message,
          time: normalized.time,
          cancel: normalized.cancel?.source ?? null,
          detail: normalized.detail ?? null,
          stack: normalized.stack ?? null,
          revision: nextRev,
        })
        .run()
        .pipe(Effect.orDie)
      const inserted = yield* tx
        .select()
        .from(SessionOperationTable)
        .where(eq(SessionOperationTable.op_id, normalized.opId))
        .get()
        .pipe(Effect.orDie)
      if (!inserted) yield* Effect.die(new Error(`operation row missing after insert ${normalized.opId}`))
      return rowToRecord(inserted as typeof SessionOperationTable.$inferSelect)
    }
  })
}

export function put(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  record: FailureRecord,
): Effect.Effect<FailureRecord> {
  return Effect.gen(function* () {
    validateRecord(record)
    return yield* db.transaction((tx) => putTx(tx as DbOrTx, sessionID, record), { behavior: "immediate" })
  }).pipe(Effect.orDie) as Effect.Effect<FailureRecord>
}

export function get(db: Database.Interface["db"], opId: string): Effect.Effect<FailureRecord | undefined> {
  return Effect.gen(function* () {
    if (typeof opId !== "string" || opId.length === 0) yield* Effect.die(new TypeError("opId must be non-empty string"))
    const row = yield* db
      .select()
      .from(SessionOperationTable)
      .where(eq(SessionOperationTable.op_id, opId))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    return rowToRecord(row)
  }).pipe(Effect.orDie) as Effect.Effect<FailureRecord | undefined>
}

export function list(db: Database.Interface["db"], sessionID: SessionSchema.ID): Effect.Effect<FailureRecord[]> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(SessionOperationTable)
      .where(eq(SessionOperationTable.session_id, sessionID))
      .orderBy(asc(SessionOperationTable.op_id))
      .all()
      .pipe(Effect.orDie)
    return rows.map(rowToRecord)
  }).pipe(Effect.orDie) as Effect.Effect<FailureRecord[]>
}

export function getTx(tx: DbOrTx, opId: string): Effect.Effect<FailureRecord | undefined> {
  return Effect.gen(function* () {
    const row = yield* tx
      .select()
      .from(SessionOperationTable)
      .where(eq(SessionOperationTable.op_id, opId))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    return rowToRecord(row)
  }).pipe(Effect.orDie) as Effect.Effect<FailureRecord | undefined>
}

export function listTx(tx: DbOrTx, sessionID: SessionSchema.ID): Effect.Effect<FailureRecord[]> {
  return Effect.gen(function* () {
    const rows = yield* tx
      .select()
      .from(SessionOperationTable)
      .where(eq(SessionOperationTable.session_id, sessionID))
      .orderBy(asc(SessionOperationTable.op_id))
      .all()
      .pipe(Effect.orDie)
    return rows.map(rowToRecord)
  }).pipe(Effect.orDie) as Effect.Effect<FailureRecord[]>
}

// ---------------------------------------------------------------------------
// CancelQueued durable helpers (P4.4-G3-B0)
// ---------------------------------------------------------------------------
export function insertCancelQueuedInFlightTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  record: FailureRecord,
  meta: CancelQueuedMeta,
): Effect.Effect<CancelQueuedRecord> {
  return Effect.gen(function* () {
    validateRecord(record)
    if (record.outcome !== "in-flight") yield* Effect.die(new Error("insertCancelQueuedInFlightTx requires in-flight outcome"))
    const normalized = normalizeRecord(record)
    const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    if (!session) yield* Effect.die(new Error(`session not found ${sessionID}`))
    yield* SessionRevision.advanceTx(sessionID, tx)
    const after = yield* tx
      .select({ rev: SessionTable.revision })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    const nextRev = after!.rev
    yield* tx
      .insert(SessionOperationTable)
      .values({
        op_id: normalized.opId,
        session_id: sessionID,
        op_kind: normalized.opKind,
        outcome: normalized.outcome,
        code: normalized.code,
        message: normalized.message,
        time: normalized.time,
        cancel: normalized.cancel?.source ?? null,
        detail: normalized.detail ?? null,
        stack: normalized.stack ?? null,
        revision: nextRev,
        idempotency_hash: meta.idempotencyHash,
        request_id: meta.requestId,
        directory: meta.directory,
        message_id: meta.messageId,
        parent_session_id: meta.parentSessionId ?? null,
        config_version: meta.configVersion ?? null,
        session_revision: meta.sessionRevision ?? null,
        cancelled: meta.cancelled ?? null,
      })
      .run()
      .pipe(Effect.orDie)
    const rowRaw = yield* tx
      .select()
      .from(SessionOperationTable)
      .where(eq(SessionOperationTable.op_id, normalized.opId))
      .get()
      .pipe(Effect.orDie)
    if (!rowRaw) yield* Effect.die(new Error(`operation row missing after insert ${normalized.opId}`))
    return rowToCancelQueuedRecord(rowRaw as typeof SessionOperationTable.$inferSelect)
  })
}

export function updateCancelQueuedTerminalTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  opId: string,
  cancelled: boolean,
  time: number,
): Effect.Effect<CancelQueuedRecord> {
  return Effect.gen(function* () {
    const existingRowRaw = yield* tx
      .select()
      .from(SessionOperationTable)
      .where(eq(SessionOperationTable.op_id, opId))
      .get()
      .pipe(Effect.orDie)
    if (!existingRowRaw) yield* Effect.die(new Error(`operation not found ${opId}`))
    const existingRow = existingRowRaw as typeof SessionOperationTable.$inferSelect
    if (existingRow.session_id !== sessionID)
      yield* Effect.die(new Error(`cross-identity opId ${opId} already owned by session ${existingRow.session_id}`))
    const existing = rowToRecord(existingRow)
    if (existing.outcome !== "in-flight")
      yield* Effect.die(new Error(`terminal update requires in-flight, got ${existing.outcome}`))
    const normalized = normalizeRecord({
      opId,
      opKind: existing.opKind,
      outcome: "succeeded",
      code: "cancelQueued.succeeded",
      message: cancelled ? "cancelQueued cancelled" : "cancelQueued not cancelled",
      time,
    })
    yield* SessionRevision.advanceTx(sessionID, tx)
    const after = yield* tx
      .select({ rev: SessionTable.revision })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    const nextRev = after!.rev
    yield* tx
      .update(SessionOperationTable)
      .set({
        outcome: normalized.outcome,
        code: normalized.code,
        message: normalized.message,
        time: normalized.time,
        revision: nextRev,
        cancelled,
      })
      .where(eq(SessionOperationTable.op_id, opId))
      .run()
      .pipe(Effect.orDie)
    const updatedRaw = yield* tx
      .select()
      .from(SessionOperationTable)
      .where(eq(SessionOperationTable.op_id, opId))
      .get()
      .pipe(Effect.orDie)
    if (!updatedRaw) yield* Effect.die(new Error(`operation row missing after update ${opId}`))
    return rowToCancelQueuedRecord(updatedRaw as typeof SessionOperationTable.$inferSelect)
  })
}
