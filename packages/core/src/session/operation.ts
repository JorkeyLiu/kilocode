export * as SessionOperation from "./operation"

import { asc, eq, and, sql } from "drizzle-orm"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { Database } from "../database/database"
import { SessionTable, SessionOperationTable, SessionDeleteTombstoneTable } from "./sql"
import type { SessionSchema } from "./schema"
import * as Changefeed from "../retention/changefeed"
import { SessionRevision } from "./revision"

// ---------------------------------------------------------------------------
// R12-compatible record shape (persist tier = full redacted record)
// ---------------------------------------------------------------------------
export const OP_KINDS = ["prompt", "provider", "tool", "permission", "task", "cancelQueued", "sessionUpdate", "fork", "create", "delete", "revert", "unrevert"] as const
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

export interface RecoveryVisible {
  budget: 0
  nextAt: number | null
  provenance: "terminal"
}

export function needsRecovery(opKind: OpKind, outcome: Outcome): boolean {
  return opKind === "prompt" && (outcome === "failed" || outcome === "abandoned")
}

export function recoveryForTerminal(opKind: OpKind, outcome: Outcome): RecoveryVisible | undefined {
  if (!needsRecovery(opKind, outcome)) return undefined
  return { budget: 0, nextAt: null, provenance: "terminal" as const }
}

function recoveryColumns(rec: RecoveryVisible | undefined): { budget: number | null; nextAt: number | null; provenance: string | null } {
  if (!rec) return { budget: null, nextAt: null, provenance: null }
  return { budget: rec.budget, nextAt: rec.nextAt, provenance: rec.provenance }
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
  // preserve 9-field shape, scrub + cap string fields — required fields stay strict, optional fields honor schema nullability
  if (typeof record.message !== "string") throw new TypeError("message must be string")
  if (typeof record.code !== "string" || record.code.length === 0) throw new TypeError("code must be non-empty string")
  if (typeof record.time !== "number" || !Number.isFinite(record.time)) throw new TypeError("time must be finite number")
  const out: FailureRecord = {
    opId: record.opId,
    opKind: record.opKind,
    outcome: record.outcome,
    code: record.code,
    message: cap(scrubString(record.message), 500),
    time: record.time,
  }
  if (record.cancel !== undefined) {
    if (record.cancel === null || typeof record.cancel !== "object" || Array.isArray(record.cancel))
      throw new TypeError("cancel must be object")
    const src = (record.cancel as Record<string, unknown>).source
    if (typeof src !== "string" || !cancelSet.has(src)) throw new TypeError("cancel.source invalid")
    out.cancel = { source: src as CancelSource }
  }
  if (record.detail !== undefined) {
    if (typeof record.detail !== "string") throw new TypeError("detail must be string")
    out.detail = cap(scrubString(record.detail), 1000)
  }
  if (record.stack !== undefined) {
    if (typeof record.stack !== "string") throw new TypeError("stack must be string")
    out.stack = cap(scrubString(record.stack), 2000)
  }
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

export function sessionUpdateId(sessionID: string, token?: string): string {
  if (typeof sessionID !== "string" || sessionID.length === 0) throw new TypeError("sessionID must be non-empty string")
  assertNoColon(sessionID, "sessionID")
  if (token !== undefined) {
    if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
    assertNoColon(token, "token")
    return `sessionUpdate:${sessionID}:${token}`
  }
  return `sessionUpdate:${sessionID}`
}

export function forkId(sessionID: string, token?: string): string {
  if (typeof sessionID !== "string" || sessionID.length === 0) throw new TypeError("sessionID must be non-empty string")
  assertNoColon(sessionID, "sessionID")
  if (token !== undefined) {
    if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
    assertNoColon(token, "token")
    return `fork:${sessionID}:${token}`
  }
  return `fork:${sessionID}`
}

export function createId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  assertNoColon(token, "token")
  return `create:${token}`
}

export function deleteId(sessionID: string, token: string): string {
  if (typeof sessionID !== "string" || sessionID.length === 0) throw new TypeError("sessionID must be non-empty string")
  assertNoColon(sessionID, "sessionID")
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  assertNoColon(token, "token")
  return `delete:${sessionID}:${token}`
}

export function revertId(sessionID: string, token: string): string {
  if (typeof sessionID !== "string" || sessionID.length === 0) throw new TypeError("sessionID must be non-empty string")
  assertNoColon(sessionID, "sessionID")
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  assertNoColon(token, "token")
  return `revert:${sessionID}:${token}`
}

export function unrevertId(sessionID: string, token: string): string {
  if (typeof sessionID !== "string" || sessionID.length === 0) throw new TypeError("sessionID must be non-empty string")
  assertNoColon(sessionID, "sessionID")
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  assertNoColon(token, "token")
  return `unrevert:${sessionID}:${token}`
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
  } else if (kind === "sessionUpdate") {
    if (rest.length !== 1 && rest.length !== 2) throw new TypeError(`sessionUpdate opId must have 1 or 2 segments: ${opId}`)
    if (rest.length === 2 && rest[1]!.length === 0) throw new TypeError(`sessionUpdate token must be non-empty: ${opId}`)
  } else if (kind === "fork") {
    if (rest.length !== 1 && rest.length !== 2) throw new TypeError(`fork opId must have 1 or 2 segments: ${opId}`)
    if (rest.length === 2 && rest[1]!.length === 0) throw new TypeError(`fork token must be non-empty: ${opId}`)
  } else if (kind === "create") {
    if (rest.length !== 1) throw new TypeError(`create opId must have 1 segment: ${opId}`)
  } else if (kind === "delete") {
    if (rest.length !== 2) throw new TypeError(`delete opId must have 2 segments: ${opId}`)
    if (rest[1]!.length === 0) throw new TypeError(`delete token must be non-empty: ${opId}`)
  } else if (kind === "revert") {
    if (rest.length !== 2) throw new TypeError(`revert opId must have 2 segments: ${opId}`)
    if (rest[1]!.length === 0) throw new TypeError(`revert token must be non-empty: ${opId}`)
  } else if (kind === "unrevert") {
    if (rest.length !== 2) throw new TypeError(`unrevert opId must have 2 segments: ${opId}`)
    if (rest[1]!.length === 0) throw new TypeError(`unrevert token must be non-empty: ${opId}`)
  }
  return { kind: kind as OpKind, parts: rest }
}

export function parseForkOpIdForSession(opId: string, sessionId: string): { kind: "fork"; sessionId: string; token?: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId must be non-empty string")
  const prefix = `fork:${sessionId}`
  if (opId === prefix) return { kind: "fork", sessionId }
  if (opId.startsWith(prefix + ":")) {
    const token = opId.slice(prefix.length + 1)
    if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
    if (token.includes(":")) throw new TypeError(`token must not contain ':'`)
    return { kind: "fork", sessionId, token }
  }
  const parsed = parseOpId(opId)
  if (parsed.kind !== "fork") throw new TypeError(`opId kind must be fork: ${opId}`)
  if (parsed.parts[0] !== sessionId) throw new TypeError(`opId session binding mismatch: ${opId} vs ${sessionId}`)
  if (parsed.parts.length === 1) return { kind: "fork", sessionId }
  return { kind: "fork", sessionId, token: parsed.parts[1] }
}

export function parseDeleteOpIdForSession(opId: string, sessionId: string): { kind: "delete"; sessionId: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId must be non-empty string")
  const prefix = `delete:${sessionId}:`
  if (opId.startsWith(prefix)) {
    const token = opId.slice(prefix.length)
    if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
    if (token.includes(":")) throw new TypeError(`token must not contain ':'`)
    return { kind: "delete", sessionId, token }
  }
  const parsed = parseOpId(opId)
  if (parsed.kind !== "delete") throw new TypeError(`opId kind must be delete: ${opId}`)
  if (parsed.parts[0] !== sessionId) throw new TypeError(`opId session binding mismatch: ${opId} vs ${sessionId}`)
  if (parsed.parts.length !== 2) throw new TypeError(`delete opId must have 2 segments: ${opId}`)
  return { kind: "delete", sessionId, token: parsed.parts[1]! }
}

export function parseRevertOpIdForSession(opId: string, sessionId: string): { kind: "revert"; sessionId: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId must be non-empty string")
  const prefix = `revert:${sessionId}:`
  if (opId.startsWith(prefix)) {
    const token = opId.slice(prefix.length)
    if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
    if (token.includes(":")) throw new TypeError(`token must not contain ':'`)
    return { kind: "revert", sessionId, token }
  }
  const parsed = parseOpId(opId)
  if (parsed.kind !== "revert") throw new TypeError(`opId kind must be revert: ${opId}`)
  if (parsed.parts[0] !== sessionId) throw new TypeError(`opId session binding mismatch: ${opId} vs ${sessionId}`)
  if (parsed.parts.length !== 2) throw new TypeError(`revert opId must have 2 segments: ${opId}`)
  return { kind: "revert", sessionId, token: parsed.parts[1]! }
}

export function parseUnrevertOpIdForSession(opId: string, sessionId: string): { kind: "unrevert"; sessionId: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId must be non-empty string")
  const prefix = `unrevert:${sessionId}:`
  if (opId.startsWith(prefix)) {
    const token = opId.slice(prefix.length)
    if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
    if (token.includes(":")) throw new TypeError(`token must not contain ':'`)
    return { kind: "unrevert", sessionId, token }
  }
  const parsed = parseOpId(opId)
  if (parsed.kind !== "unrevert") throw new TypeError(`opId kind must be unrevert: ${opId}`)
  if (parsed.parts[0] !== sessionId) throw new TypeError(`opId session binding mismatch: ${opId} vs ${sessionId}`)
  if (parsed.parts.length !== 2) throw new TypeError(`unrevert opId must have 2 segments: ${opId}`)
  return { kind: "unrevert", sessionId, token: parsed.parts[1]! }
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

// ---------------------------------------------------------------------------
// Fork session-aware validation (colon-containing SessionID parity)
// Generic validateRecord/parseOpId remain unchanged; fork persistence uses
// session-bound parse so SessionIDs accepted by request validation (e.g.
// "ses:colon:id") are accepted at the succeeded-record insertion boundary.
// Token colon rejection and session binding stay strict via the bound parser.
// ---------------------------------------------------------------------------
export function validateForkRecordForSession(record: unknown, sessionId: string): FailureRecord {
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId must be non-empty string")
  if (record === null || typeof record !== "object") throw new TypeError("record must be object")
  const r = record as Record<string, unknown>
  const opId = r["opId"]
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  parseForkOpIdForSession(opId, sessionId)
  const opKind = r["opKind"]
  if (opKind !== "fork") throw new TypeError(`opKind must be fork for fork record`)
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

function isOpIdDuplicateError(err: unknown): boolean {
  const rec = err as Record<string, unknown> | null | undefined
  const code = typeof rec?.["code"] === "string" ? String(rec["code"]) : ""
  const msg = String((rec?.["message"] as unknown) ?? err ?? "")
  const errnoVal = rec?.["errno"]
  const extVal = rec?.["extendedCode"]
  const errnoNum = typeof errnoVal === "number" ? errnoVal : typeof extVal === "number" ? extVal : undefined
  if (errnoNum === 1555 || errnoNum === 2067) return true
  const errnoStr = typeof errnoVal === "string" ? errnoVal : typeof extVal === "string" ? extVal : ""
  if (errnoStr === "1555" || errnoStr === "2067") return true
  if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") return true
  if (msg.includes("SQLITE_CONSTRAINT_PRIMARYKEY") || msg.includes("SQLITE_CONSTRAINT_UNIQUE")) return true
  // strict op_id scoped message: must mention session_operation.op_id with UNIQUE/PRIMARY
  if (msg.includes("session_operation.op_id") && (msg.includes("UNIQUE constraint failed") || msg.includes("PRIMARY KEY"))) return true
  return false
}

function isSqliteBusyError(err: unknown): boolean {
  const rec = err as Record<string, unknown> | null | undefined
  const code = typeof rec?.["code"] === "string" ? String(rec["code"]) : ""
  const msg = String((rec?.["message"] as unknown) ?? err ?? "")
  if (code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY")) return true
  if (msg.includes("SQLITE_BUSY")) return true
  if (msg.includes("database is locked") || msg.includes("database table is locked")) return true
  return false
}

// keep narrow alias for internal clarity; legacy name deprecated
function isSqliteConstraintError(err: unknown): boolean {
  return isOpIdDuplicateError(err)
}

function rowToValidatedRecord(row: typeof SessionOperationTable.$inferSelect): FailureRecord {
  if (typeof row.op_id !== "string" || row.op_id.length === 0) throw new TypeError("op_id must be non-empty string")
  if (typeof row.session_id !== "string" || row.session_id.length === 0) throw new TypeError("session_id must be non-empty string")
  if (typeof row.op_kind !== "string" || !opKindSet.has(row.op_kind)) throw new TypeError(`op_kind must be one of ${OP_KINDS.join(", ")}`)
  if (typeof row.outcome !== "string" || !outcomeSet.has(row.outcome)) throw new TypeError(`outcome must be one of ${OUTCOMES.join(", ")}`)
  if (typeof row.code !== "string" || row.code.length === 0) throw new TypeError("code must be non-empty string")
  if (typeof row.message !== "string") throw new TypeError("message must be string")
  if (typeof row.time !== "number" || !Number.isFinite(row.time)) throw new TypeError("time must be finite number")
  parseOpId(row.op_id)
  const candidate: unknown = {
    opId: row.op_id,
    opKind: row.op_kind,
    outcome: row.outcome,
    code: row.code,
    message: row.message,
    time: row.time,
    ...(row.cancel !== null && row.cancel !== undefined ? { cancel: { source: row.cancel } } : {}),
    ...(row.detail !== null && row.detail !== undefined ? { detail: row.detail } : {}),
    ...(row.stack !== null && row.stack !== undefined ? { stack: row.stack } : {}),
  }
  const validated = validateRecord(candidate)
  return normalizeRecord(validated)
}

export function validatedRowToRecord(row: typeof SessionOperationTable.$inferSelect): FailureRecord {
  return rowToValidatedRecord(row)
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

function putTx(tx: DbOrTx, sessionID: SessionSchema.ID, record: FailureRecord): Effect.Effect<{ record: FailureRecord; entry: Changefeed.Entry; generationEntry?: Changefeed.Entry }, unknown, never> {
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
      let existingRecord: FailureRecord
      try {
        existingRecord = rowToValidatedRecord(existingRow as typeof SessionOperationTable.$inferSelect)
      } catch (e) {
        yield* Effect.die(new TypeError(`invalid persisted operation row ${normalized.opId}: ${e instanceof Error ? e.message : String(e)}`))
        return undefined as unknown as { record: FailureRecord; entry: Changefeed.Entry }
      }
      // cross-session identity check (also enforced by validated row, but keep explicit for fail-closed)
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
      if (recordsEqual(existingRecord, normalized)) {
        // idempotent — no revision, no feed; fail-closed on idempotent replay no entry
        yield* Effect.die(new Error(`putTx idempotent replay should not be called for entry path`))
        return undefined as unknown as { record: FailureRecord; entry: Changefeed.Entry }
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
      // allowed update: advance revision then update row — capture real feed entry in same tx, no extra select
      const entry = yield* SessionRevision.advanceTx(sessionID, tx)
      const nextRev = entry.revision
      const rec = recoveryForTerminal(normalized.opKind, normalized.outcome)
      const cols = recoveryColumns(rec)
      const shouldGen = isTerminal(normalized.outcome) && normalized.opKind === "prompt"
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
          recovery_budget: cols.budget,
          recovery_next_at: cols.nextAt,
          recovery_provenance: cols.provenance as unknown as "terminal" | null,
        } as unknown as typeof SessionOperationTable.$inferInsert)
        .where(eq(SessionOperationTable.op_id, normalized.opId))
        .run()
        .pipe(Effect.orDie)
      let genEntry: Changefeed.Entry | undefined
      if (shouldGen) {
        genEntry = yield* Changefeed.appendTx(tx, { session_id: sessionID, revision: nextRev, kind: "generation", time: entry.time })
      }
      const updated = yield* tx
        .select()
        .from(SessionOperationTable)
        .where(eq(SessionOperationTable.op_id, normalized.opId))
        .get()
        .pipe(Effect.orDie)
      if (!updated) yield* Effect.die(new Error(`operation row missing after update ${normalized.opId}`))
      let updatedRecord: FailureRecord
      try {
        updatedRecord = rowToValidatedRecord(updated as typeof SessionOperationTable.$inferSelect)
      } catch (e) {
        yield* Effect.die(new TypeError(`invalid persisted operation row ${normalized.opId}: ${e instanceof Error ? e.message : String(e)}`))
        return undefined as unknown as { record: FailureRecord; entry: Changefeed.Entry; generationEntry?: Changefeed.Entry }
      }
      return { record: updatedRecord, entry, ...(genEntry ? { generationEntry: genEntry } : {}) }
    } else {
      // new operation: advance revision then insert — capture real entry, no extra select
      const entry = yield* SessionRevision.advanceTx(sessionID, tx)
      const nextRev = entry.revision
      const rec = recoveryForTerminal(normalized.opKind, normalized.outcome)
      const cols = recoveryColumns(rec)
      const shouldGen = isTerminal(normalized.outcome) && normalized.opKind === "prompt"
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
          recovery_budget: cols.budget,
          recovery_next_at: cols.nextAt,
          recovery_provenance: cols.provenance as unknown as "terminal" | null,
        } as unknown as typeof SessionOperationTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      let genEntry: Changefeed.Entry | undefined
      if (shouldGen) {
        genEntry = yield* Changefeed.appendTx(tx, { session_id: sessionID, revision: nextRev, kind: "generation", time: entry.time })
      }
      const inserted = yield* tx
        .select()
        .from(SessionOperationTable)
        .where(eq(SessionOperationTable.op_id, normalized.opId))
        .get()
        .pipe(Effect.orDie)
      if (!inserted) yield* Effect.die(new Error(`operation row missing after insert ${normalized.opId}`))
      let insertedRecord: FailureRecord
      try {
        insertedRecord = rowToValidatedRecord(inserted as typeof SessionOperationTable.$inferSelect)
      } catch (e) {
        yield* Effect.die(new TypeError(`invalid persisted operation row ${normalized.opId}: ${e instanceof Error ? e.message : String(e)}`))
        return undefined as unknown as { record: FailureRecord; entry: Changefeed.Entry; generationEntry?: Changefeed.Entry }
      }
      return { record: insertedRecord, entry, ...(genEntry ? { generationEntry: genEntry } : {}) }
    }
  })
}

// internal put helper that retains old idempotent semantics for public `put` compatibility
function putTxIdempotent(tx: DbOrTx, sessionID: SessionSchema.ID, record: FailureRecord): Effect.Effect<FailureRecord, unknown, never> {
  return Effect.gen(function* () {
    validateRecord(record)
    const normalized = normalizeRecord(record)
    const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    if (!session) yield* Effect.die(new Error(`session not found ${sessionID}`))
    const existingRow = yield* tx
      .select()
      .from(SessionOperationTable)
      .where(eq(SessionOperationTable.op_id, normalized.opId))
      .get()
      .pipe(Effect.orDie)
    if (existingRow) {
      let existingRecord: FailureRecord
      try {
        existingRecord = rowToValidatedRecord(existingRow as typeof SessionOperationTable.$inferSelect)
      } catch (e) {
        yield* Effect.die(new TypeError(`invalid persisted operation row ${normalized.opId}: ${e instanceof Error ? e.message : String(e)}`))
        return undefined as unknown as FailureRecord
      }
      if (existingRow.session_id !== sessionID)
        yield* Effect.die(new Error(`cross-identity opId ${normalized.opId} already owned by session ${existingRow.session_id}`))
      if (existingRow.op_kind !== normalized.opKind)
        yield* Effect.die(new Error(`cross-kind conflict for ${normalized.opId}: existing ${existingRow.op_kind} vs new ${normalized.opKind}`))
      if (recordsEqual(existingRecord, normalized)) {
        return existingRecord
      }
      if (isTerminal(existingRecord.outcome) && normalized.outcome === "in-flight") {
        yield* Effect.die(new Error(`terminal outcome ${existingRecord.outcome} cannot regress to in-flight for ${normalized.opId}`))
      }
      if (isTerminal(existingRecord.outcome) && isTerminal(normalized.outcome)) {
        yield* Effect.die(new Error(`terminal outcome already recorded for ${normalized.opId}: ${existingRecord.outcome} vs ${normalized.outcome}`))
      }
      if (existingRecord.outcome === "in-flight" && isTerminal(normalized.outcome)) {
      } else {
        yield* Effect.die(new Error(`conflicting update for ${normalized.opId}: ${existingRecord.outcome} -> ${normalized.outcome}`))
      }
      const entry = yield* SessionRevision.advanceTx(sessionID, tx)
      const nextRev = entry.revision
      const recU = recoveryForTerminal(normalized.opKind, normalized.outcome)
      const colsU = recoveryColumns(recU)
      const shouldGenU = isTerminal(normalized.outcome) && normalized.opKind === "prompt"
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
          recovery_budget: colsU.budget,
          recovery_next_at: colsU.nextAt,
          recovery_provenance: colsU.provenance as unknown as "terminal" | null,
        } as unknown as typeof SessionOperationTable.$inferInsert)
        .where(eq(SessionOperationTable.op_id, normalized.opId))
        .run()
        .pipe(Effect.orDie)
      if (shouldGenU) yield* Changefeed.appendTx(tx, { session_id: sessionID, revision: nextRev, kind: "generation", time: entry.time })
      const updated = yield* tx.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, normalized.opId)).get().pipe(Effect.orDie)
      if (!updated) yield* Effect.die(new Error(`operation row missing after update ${normalized.opId}`))
      let updatedRecord: FailureRecord
      try {
        updatedRecord = rowToValidatedRecord(updated as typeof SessionOperationTable.$inferSelect)
      } catch (e) {
        yield* Effect.die(new TypeError(`invalid persisted operation row ${normalized.opId}: ${e instanceof Error ? e.message : String(e)}`))
        return undefined as unknown as FailureRecord
      }
      return updatedRecord
    } else {
      const entry = yield* SessionRevision.advanceTx(sessionID, tx)
      const nextRev = entry.revision
      const recI = recoveryForTerminal(normalized.opKind, normalized.outcome)
      const colsI = recoveryColumns(recI)
      const shouldGenI = isTerminal(normalized.outcome) && normalized.opKind === "prompt"
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
          recovery_budget: colsI.budget,
          recovery_next_at: colsI.nextAt,
          recovery_provenance: colsI.provenance as unknown as "terminal" | null,
        } as unknown as typeof SessionOperationTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      if (shouldGenI) yield* Changefeed.appendTx(tx, { session_id: sessionID, revision: nextRev, kind: "generation", time: entry.time })
      const inserted = yield* tx.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, normalized.opId)).get().pipe(Effect.orDie)
      if (!inserted) yield* Effect.die(new Error(`operation row missing after insert ${normalized.opId}`))
      let insertedRecord: FailureRecord
      try {
        insertedRecord = rowToValidatedRecord(inserted as typeof SessionOperationTable.$inferSelect)
      } catch (e) {
        yield* Effect.die(new TypeError(`invalid persisted operation row ${normalized.opId}: ${e instanceof Error ? e.message : String(e)}`))
        return undefined as unknown as FailureRecord
      }
      return insertedRecord
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
    return yield* db.transaction((tx) => putTxIdempotent(tx as DbOrTx, sessionID, record), { behavior: "immediate" })
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
    try {
      return rowToValidatedRecord(row as typeof SessionOperationTable.$inferSelect)
    } catch (e) {
      return yield* Effect.die(new TypeError(`invalid persisted operation row ${opId}: ${e instanceof Error ? e.message : String(e)}`))
    }
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
    const out: FailureRecord[] = []
    for (const r of rows) {
      try {
        out.push(rowToValidatedRecord(r as typeof SessionOperationTable.$inferSelect))
      } catch (e) {
        return yield* Effect.die(new TypeError(`invalid persisted operation row ${r.op_id}: ${e instanceof Error ? e.message : String(e)}`))
      }
    }
    return out
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
    try {
      return rowToValidatedRecord(row as typeof SessionOperationTable.$inferSelect)
    } catch (e) {
      return yield* Effect.die(new TypeError(`invalid persisted operation row ${opId}: ${e instanceof Error ? e.message : String(e)}`))
    }
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
    const out: FailureRecord[] = []
    for (const r of rows) {
      try {
        out.push(rowToValidatedRecord(r as typeof SessionOperationTable.$inferSelect))
      } catch (e) {
        return yield* Effect.die(new TypeError(`invalid persisted operation row ${r.op_id}: ${e instanceof Error ? e.message : String(e)}`))
      }
    }
    return out
  }).pipe(Effect.orDie) as Effect.Effect<FailureRecord[]>
}

// ---------------------------------------------------------------------------
// Prompt durable helpers — cross-process atomic inception + terminal CAS
// ---------------------------------------------------------------------------
export type EnsurePromptInFlightResult =
  | { fresh: true; record: FailureRecord; entry: Changefeed.Entry }
  | { fresh: false; record: FailureRecord; rowSessionId: string; entry?: undefined }

function ensurePromptInFlightTxInner(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  opId: string,
): Effect.Effect<EnsurePromptInFlightResult> {
  return Effect.gen(function* () {
    const existingRow = yield* tx.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, opId)).get().pipe(Effect.orDie)
    if (existingRow) {
      let existing: FailureRecord
      try {
        existing = rowToValidatedRecord(existingRow as typeof SessionOperationTable.$inferSelect)
      } catch (e) {
        yield* Effect.die(new TypeError(`invalid persisted operation row ${opId}: ${e instanceof Error ? e.message : String(e)}`))
        return { fresh: false as const, record: undefined as unknown as FailureRecord, rowSessionId: existingRow.session_id as unknown as string, entry: undefined }
      }
      return { fresh: false as const, record: existing, rowSessionId: existingRow.session_id as unknown as string, entry: undefined }
    }
    const normalized = normalizeRecord({
      opId,
      opKind: "prompt",
      outcome: "in-flight",
      code: "prompt.inflight",
      message: "prompt accepted",
      time: Date.now(),
    })
    const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    if (!session) yield* Effect.die(new Error(`session not found ${sessionID}`))
    const entry = yield* SessionRevision.advanceTx(sessionID, tx)
    const nextRev = entry.revision
    const insertOutcome = yield* tx
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
      .pipe(
        Effect.map(() => ({ ok: true as const })),
        Effect.catch((err: unknown) => {
          if (isOpIdDuplicateError(err) || isSqliteBusyError(err)) return Effect.succeed({ ok: false as const, conflict: true as const })
          return Effect.fail(err)
        }),
        Effect.catchDefect((defect: unknown) => {
          if (isOpIdDuplicateError(defect) || isSqliteBusyError(defect)) return Effect.succeed({ ok: false as const, conflict: true as const })
          return Effect.fail(defect)
        }),
        Effect.orDie,
      )
    if (!insertOutcome.ok) {
      const reread = yield* tx.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, opId)).get().pipe(Effect.orDie)
      if (!reread) yield* Effect.die(new Error(`operation row missing after constraint ${opId}`))
      let rereadRecord: FailureRecord
      try {
        rereadRecord = rowToValidatedRecord(reread as typeof SessionOperationTable.$inferSelect)
      } catch (e) {
        yield* Effect.die(new TypeError(`invalid persisted operation row ${opId}: ${e instanceof Error ? e.message : String(e)}`))
        return { fresh: false as const, record: undefined as unknown as FailureRecord, rowSessionId: (reread as unknown as { session_id: string }).session_id, entry: undefined }
      }
      return { fresh: false as const, record: rereadRecord, rowSessionId: (reread as unknown as { session_id: string }).session_id, entry: undefined }
    }
    const inserted = yield* tx.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, opId)).get().pipe(Effect.orDie)
    if (!inserted) yield* Effect.die(new Error(`operation row missing after insert ${opId}`))
    let insertedRecord: FailureRecord
    try {
      insertedRecord = rowToValidatedRecord(inserted as typeof SessionOperationTable.$inferSelect)
    } catch (e) {
      yield* Effect.die(new TypeError(`invalid persisted operation row ${opId}: ${e instanceof Error ? e.message : String(e)}`))
      return { fresh: true as const, record: undefined as unknown as FailureRecord, entry: undefined as unknown as Changefeed.Entry }
    }
    return { fresh: true as const, record: insertedRecord, entry }
  })
}

export function ensurePromptInFlight(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  opId: string,
): Effect.Effect<EnsurePromptInFlightResult> {
  const maybeTx = (db as unknown as { transaction?: (cb: unknown, opts?: unknown) => Effect.Effect<unknown> }).transaction
  if (typeof maybeTx !== "function") {
    return ensurePromptInFlightTxInner(db as unknown as DbOrTx, sessionID, opId)
  }
  return (db as unknown as { transaction: (cb: (tx: unknown) => Effect.Effect<unknown>, opts?: unknown) => Effect.Effect<unknown> })
    .transaction((tx) => ensurePromptInFlightTxInner(tx as unknown as DbOrTx, sessionID, opId), { behavior: "immediate" } as unknown)
    .pipe(
      Effect.catch((err: unknown) => {
        if (isOpIdDuplicateError(err) || isSqliteBusyError(err)) {
          return Effect.gen(function* () {
            const row = yield* db
              .select()
              .from(SessionOperationTable)
              .where(eq(SessionOperationTable.op_id, opId))
              .get()
              .pipe(Effect.orDie)
            if (!row) return yield* Effect.fail(err)
            let rec: FailureRecord
            try {
              rec = rowToValidatedRecord(row as typeof SessionOperationTable.$inferSelect)
            } catch (e) {
              return yield* Effect.fail(new TypeError(`invalid persisted operation row ${opId}: ${e instanceof Error ? e.message : String(e)}`))
            }
            return { fresh: false as const, record: rec, rowSessionId: (row as unknown as { session_id: string }).session_id, entry: undefined }
          })
        }
        return Effect.fail(err)
      }),
      Effect.catchDefect((defect: unknown) => {
        if (isOpIdDuplicateError(defect) || isSqliteBusyError(defect)) {
          return Effect.gen(function* () {
            const row = yield* db
              .select()
              .from(SessionOperationTable)
              .where(eq(SessionOperationTable.op_id, opId))
              .get()
              .pipe(Effect.orDie)
            if (!row) return yield* Effect.fail(defect)
            let rec: FailureRecord
            try {
              rec = rowToValidatedRecord(row as typeof SessionOperationTable.$inferSelect)
            } catch (e) {
              return yield* Effect.fail(new TypeError(`invalid persisted operation row ${opId}: ${e instanceof Error ? e.message : String(e)}`))
            }
            return { fresh: false as const, record: rec, rowSessionId: (row as unknown as { session_id: string }).session_id, entry: undefined }
          })
        }
        return Effect.fail(defect)
      }),
      Effect.orDie,
    ) as Effect.Effect<EnsurePromptInFlightResult>
}

export function ensurePromptInFlightTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  opId: string,
): Effect.Effect<EnsurePromptInFlightResult> {
  return ensurePromptInFlightTxInner(tx, sessionID, opId)
}

export type TryTransitionPromptTerminalResult =
  | { applied: true; record: FailureRecord; entry: Changefeed.Entry; generationEntry?: Changefeed.Entry }
  | { applied: false; record: FailureRecord | undefined; entry?: undefined }

export function tryTransitionPromptTerminal(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  record: FailureRecord,
): Effect.Effect<TryTransitionPromptTerminalResult, unknown, never> {
  return db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const existingRow = yield* tx.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, record.opId)).get().pipe(Effect.orDie)
          if (!existingRow) {
            const { record: applied, entry, generationEntry } = yield* putTx(tx as DbOrTx, sessionID, record)
            return { applied: true as const, record: applied, entry, ...(generationEntry ? { generationEntry } : {}) }
          }
          let existing: FailureRecord
          try {
            existing = rowToValidatedRecord(existingRow as typeof SessionOperationTable.$inferSelect)
          } catch (e) {
            yield* Effect.die(new TypeError(`invalid persisted operation row ${record.opId}: ${e instanceof Error ? e.message : String(e)}`))
            return { applied: false as const, record: undefined, entry: undefined }
          }
          if (isTerminal(existing.outcome)) return { applied: false as const, record: existing, entry: undefined }
          if (existing.outcome !== "in-flight") return { applied: false as const, record: existing, entry: undefined }
          const { record: applied, entry, generationEntry } = yield* putTx(tx as DbOrTx, sessionID, record)
          return { applied: true as const, record: applied, entry, ...(generationEntry ? { generationEntry } : {}) }
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie) as Effect.Effect<TryTransitionPromptTerminalResult, unknown, never>
}

export function tryTransitionPromptTerminalTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  record: FailureRecord,
): Effect.Effect<TryTransitionPromptTerminalResult, unknown, never> {
  return Effect.gen(function* () {
    const existingRow = yield* tx.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, record.opId)).get().pipe(Effect.orDie)
    if (!existingRow) {
      const { record: applied, entry, generationEntry } = yield* putTx(tx as DbOrTx, sessionID, record)
      return { applied: true as const, record: applied, entry, ...(generationEntry ? { generationEntry } : {}) }
    }
    let existing: FailureRecord
    try {
      existing = rowToValidatedRecord(existingRow as typeof SessionOperationTable.$inferSelect)
    } catch (e) {
      yield* Effect.die(new TypeError(`invalid persisted operation row ${record.opId}: ${e instanceof Error ? e.message : String(e)}`))
      return { applied: false as const, record: undefined, entry: undefined }
    }
    if (isTerminal(existing.outcome)) return { applied: false as const, record: existing, entry: undefined }
    if (existing.outcome !== "in-flight") return { applied: false as const, record: existing, entry: undefined }
    const { record: applied, entry, generationEntry } = yield* putTx(tx as DbOrTx, sessionID, record)
    return { applied: true as const, record: applied, entry, ...(generationEntry ? { generationEntry } : {}) }
  })
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

// ---------------------------------------------------------------------------
// SessionUpdate durable helpers (P4.4-G3-B2 title-only)
// ---------------------------------------------------------------------------
export interface SessionUpdateMeta {
  idempotencyHash: string
  requestId: string
  directory: string
  parentSessionId?: string | null
  configVersion?: number | null
  sessionRevision?: number | null
  title: string
}

export interface SessionUpdateRecord extends FailureRecord {
  meta: SessionUpdateMeta
  resultSnapshot?: unknown
  revision: number
}

export function hasSnapshot(record: SessionUpdateRecord): boolean {
  return Object.hasOwn(record as object, "resultSnapshot")
}

function rowToSessionUpdateRecord(row: typeof SessionOperationTable.$inferSelect): SessionUpdateRecord {
  const base = rowToRecord(row)
  let snapshot: unknown | undefined
  const rawSnap = (row as unknown as Record<string, unknown>).result_snapshot as string | null | undefined
  if (rawSnap !== null && rawSnap !== undefined) {
    if (typeof rawSnap === "string") {
      try {
        snapshot = JSON.parse(rawSnap)
      } catch {
        snapshot = rawSnap
      }
    } else {
      snapshot = rawSnap
    }
  }
  return {
    ...base,
    revision: row.revision as number,
    meta: {
      idempotencyHash: row.idempotency_hash ?? "",
      requestId: row.request_id ?? "",
      directory: row.directory ?? "",
      parentSessionId: row.parent_session_id ?? null,
      configVersion: row.config_version ?? null,
      sessionRevision: row.session_revision ?? null,
      title: row.title ?? "",
    },
    ...(snapshot !== undefined ? { resultSnapshot: snapshot } : {}),
  }
}

export function getSessionUpdateByIdempotencyHash(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  hash: string,
): Effect.Effect<SessionUpdateRecord | undefined> {
  return Effect.gen(function* () {
    if (typeof hash !== "string" || hash.length === 0) yield* Effect.die(new TypeError("hash must be non-empty string"))
    const row = yield* db
      .select()
      .from(SessionOperationTable)
      .where(and(eq(SessionOperationTable.session_id, sessionID), eq(SessionOperationTable.idempotency_hash, hash)))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    if ((row.op_kind as string) !== "sessionUpdate") return rowToSessionUpdateRecord(row as typeof SessionOperationTable.$inferSelect)
    return rowToSessionUpdateRecord(row as typeof SessionOperationTable.$inferSelect)
  }).pipe(Effect.orDie) as Effect.Effect<SessionUpdateRecord | undefined>
}

export function getSessionUpdateByIdempotencyHashTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  hash: string,
): Effect.Effect<SessionUpdateRecord | undefined> {
  return Effect.gen(function* () {
    const row = yield* tx
      .select()
      .from(SessionOperationTable)
      .where(and(eq(SessionOperationTable.session_id, sessionID), eq(SessionOperationTable.idempotency_hash, hash)))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    return rowToSessionUpdateRecord(row as typeof SessionOperationTable.$inferSelect)
  }).pipe(Effect.orDie) as Effect.Effect<SessionUpdateRecord | undefined>
}

export function isSessionUpdateConflict(
  prev: SessionUpdateRecord,
  next: {
    opId: string
    directory: string
    parentSessionId?: string | null
    configVersion?: number | null
    sessionRevision?: number | null
    title: string
  },
): boolean {
  if (prev.opId !== next.opId) return true
  if (prev.meta.directory !== next.directory) return true
  if ((prev.meta.parentSessionId ?? null) !== (next.parentSessionId ?? null)) return true
  if ((prev.meta.configVersion ?? null) !== (next.configVersion ?? null)) return true
  if ((prev.meta.sessionRevision ?? null) !== (next.sessionRevision ?? null)) return true
  if (prev.meta.title !== next.title) return true
  return false
}

export function insertSessionUpdateSucceededTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  record: FailureRecord,
  meta: SessionUpdateMeta,
): Effect.Effect<SessionUpdateRecord> {
  return Effect.gen(function* () {
    validateRecord(record)
    if (record.outcome !== "succeeded") yield* Effect.die(new Error("insertSessionUpdateSucceededTx requires succeeded outcome"))
    if (record.opKind !== "sessionUpdate") yield* Effect.die(new Error("insertSessionUpdateSucceededTx requires sessionUpdate opKind"))
    const normalized = normalizeRecord(record)
    const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    if (!session) yield* Effect.die(new Error(`session not found ${sessionID}`))
    // title update + revision in one atomic step
    const now = normalized.time
    const updated = yield* tx
      .update(SessionTable)
      .set({ title: meta.title, time_updated: now, revision: sql`${SessionTable.revision} + 1` })
      .where(eq(SessionTable.id, sessionID))
      .returning({ rev: SessionTable.revision })
      .all()
      .pipe(Effect.orDie)
    if (updated.length !== 1) yield* Effect.die(new Error(`session title update failed for ${sessionID}`))
    const nextRev = (updated[0] as { rev: number }).rev
    yield* Changefeed.appendTx(tx, { session_id: sessionID, revision: nextRev, kind: "changed", time: now })
    const updatedRow = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    const snapshotJson = updatedRow ? JSON.stringify(updatedRow) : null
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
        parent_session_id: meta.parentSessionId ?? null,
        config_version: meta.configVersion ?? null,
        session_revision: meta.sessionRevision ?? null,
        title: meta.title,
        result_snapshot: snapshotJson,
      } as unknown as typeof SessionOperationTable.$inferInsert)
      .run()
      .pipe(Effect.orDie)
    const rowRaw = yield* tx
      .select()
      .from(SessionOperationTable)
      .where(eq(SessionOperationTable.op_id, normalized.opId))
      .get()
      .pipe(Effect.orDie)
    if (!rowRaw) yield* Effect.die(new Error(`operation row missing after insert ${normalized.opId}`))
    return rowToSessionUpdateRecord(rowRaw as typeof SessionOperationTable.$inferSelect)
  })
}

// ---------------------------------------------------------------------------
// Fork durable helpers (P4.4-G3-B3 fork)
// ---------------------------------------------------------------------------
export interface SessionForkMeta {
  idempotencyHash: string
  requestId: string
  directory: string
  parentSessionId?: string | null
  configVersion?: number | null
  sessionRevision?: number | null
  messageId?: string | null
  forkedSessionId?: string | null
}

export interface SessionForkRecord extends FailureRecord {
  meta: SessionForkMeta
  resultSnapshot?: unknown
  revision: number
}

function rowToSessionForkRecord(row: typeof SessionOperationTable.$inferSelect): SessionForkRecord {
  const base = rowToRecord(row)
  let snapshot: unknown | undefined
  const rawSnap = (row as unknown as Record<string, unknown>).result_snapshot as string | null | undefined
  if (rawSnap !== null && rawSnap !== undefined) {
    if (typeof rawSnap === "string") {
      try {
        snapshot = JSON.parse(rawSnap)
      } catch {
        snapshot = rawSnap
      }
    } else {
      snapshot = rawSnap
    }
  }
  return {
    ...base,
    revision: row.revision as number,
    meta: {
      idempotencyHash: row.idempotency_hash ?? "",
      requestId: row.request_id ?? "",
      directory: row.directory ?? "",
      parentSessionId: row.parent_session_id ?? null,
      configVersion: row.config_version ?? null,
      sessionRevision: row.session_revision ?? null,
      messageId: row.message_id ?? null,
      forkedSessionId: row.title ? row.title : null,
    },
    ...(snapshot !== undefined ? { resultSnapshot: snapshot } : {}),
  }
}

export function getSessionForkByIdempotencyHash(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  hash: string,
): Effect.Effect<SessionForkRecord | undefined> {
  return Effect.gen(function* () {
    if (typeof hash !== "string" || hash.length === 0) yield* Effect.die(new TypeError("hash must be non-empty string"))
    const row = yield* db
      .select()
      .from(SessionOperationTable)
      .where(
        and(
          eq(SessionOperationTable.session_id, sessionID),
          eq(SessionOperationTable.idempotency_hash, hash),
          eq(SessionOperationTable.op_kind, "fork"),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    return rowToSessionForkRecord(row as typeof SessionOperationTable.$inferSelect)
  }).pipe(Effect.orDie) as Effect.Effect<SessionForkRecord | undefined>
}

export function getSessionForkByIdempotencyHashTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  hash: string,
): Effect.Effect<SessionForkRecord | undefined> {
  return Effect.gen(function* () {
    const row = yield* tx
      .select()
      .from(SessionOperationTable)
      .where(
        and(
          eq(SessionOperationTable.session_id, sessionID),
          eq(SessionOperationTable.idempotency_hash, hash),
          eq(SessionOperationTable.op_kind, "fork"),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    return rowToSessionForkRecord(row as typeof SessionOperationTable.$inferSelect)
  }).pipe(Effect.orDie) as Effect.Effect<SessionForkRecord | undefined>
}

export function isSessionForkConflict(
  prev: SessionForkRecord,
  next: {
    opId: string
    directory: string
    parentSessionId?: string | null
    configVersion?: number | null
    sessionRevision?: number | null
    messageId?: string | null
  },
): boolean {
  if (prev.opId !== next.opId) return true
  if (prev.meta.directory !== next.directory) return true
  if ((prev.meta.parentSessionId ?? null) !== (next.parentSessionId ?? null)) return true
  if ((prev.meta.configVersion ?? null) !== (next.configVersion ?? null)) return true
  if ((prev.meta.sessionRevision ?? null) !== (next.sessionRevision ?? null)) return true
  if ((prev.meta.messageId ?? null) !== (next.messageId ?? null)) return true
  return false
}

export function insertSessionForkSucceededTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  record: FailureRecord,
  meta: SessionForkMeta,
  snapshotJson: string | null,
): Effect.Effect<SessionForkRecord> {
  return Effect.gen(function* () {
    validateForkRecordForSession(record, sessionID as unknown as string)
    if (record.outcome !== "succeeded") yield* Effect.die(new Error("insertSessionForkSucceededTx requires succeeded outcome"))
    if (record.opKind !== "fork") yield* Effect.die(new Error("insertSessionForkSucceededTx requires fork opKind"))
    const normalized = normalizeRecord(record)
    const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    if (!session) yield* Effect.die(new Error(`session not found ${sessionID}`))
    // fork does not bump source revision, but we record current source revision
    const cur = yield* tx
      .select({ rev: SessionTable.revision })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    const nextRev = cur ? (cur as unknown as { rev: number }).rev : 0
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
        message_id: meta.messageId ?? null,
        parent_session_id: meta.parentSessionId ?? null,
        config_version: meta.configVersion ?? null,
        session_revision: meta.sessionRevision ?? null,
        title: meta.forkedSessionId ?? null,
        result_snapshot: snapshotJson,
      } as unknown as typeof SessionOperationTable.$inferInsert)
      .run()
      .pipe(Effect.orDie)
    const rowRaw = yield* tx
      .select()
      .from(SessionOperationTable)
      .where(eq(SessionOperationTable.op_id, normalized.opId))
      .get()
      .pipe(Effect.orDie)
    if (!rowRaw) yield* Effect.die(new Error(`operation row missing after insert ${normalized.opId}`))
    return rowToSessionForkRecord(rowRaw as typeof SessionOperationTable.$inferSelect)
  })
}

// ---------------------------------------------------------------------------
// Create durable helpers (P4.4-G3-B4 create)
// ---------------------------------------------------------------------------
export interface SessionCreateMeta {
  idempotencyHash: string
  requestId: string
  directory: string
  parentSessionId?: string | null
  configVersion?: number | null
  title?: string | null
  parentID?: string | null
  createdSessionId?: string | null
  sandboxTokenHash?: string | null
  sandboxSourceSessionId?: string | null
  sandboxSourceDirectory?: string | null
}

export interface SessionCreateRecord extends FailureRecord {
  meta: SessionCreateMeta
  resultSnapshot?: unknown
  revision: number
}

function rowToSessionCreateRecord(row: typeof SessionOperationTable.$inferSelect): SessionCreateRecord {
  const base = rowToRecord(row)
  let snapshot: unknown | undefined
  const rawSnap = (row as unknown as Record<string, unknown>).result_snapshot as string | null | undefined
  if (rawSnap !== null && rawSnap !== undefined) {
    if (typeof rawSnap === "string") {
      try {
        snapshot = JSON.parse(rawSnap)
      } catch {
        snapshot = rawSnap
      }
    } else {
      snapshot = rawSnap
    }
  }
  return {
    ...base,
    revision: row.revision as number,
    meta: {
      idempotencyHash: row.idempotency_hash ?? "",
      requestId: row.request_id ?? "",
      directory: row.directory ?? "",
      parentSessionId: row.parent_session_id ?? null,
      configVersion: row.config_version ?? null,
      title: row.title ?? null,
      parentID: (row as unknown as { message_id?: string | null }).message_id ?? null,
      createdSessionId: row.session_id as unknown as string,
      sandboxTokenHash: (row as unknown as { sandbox_token_hash?: string | null }).sandbox_token_hash ?? null,
      sandboxSourceSessionId: (row as unknown as { sandbox_source_session_id?: string | null }).sandbox_source_session_id ?? null,
      sandboxSourceDirectory: (row as unknown as { sandbox_source_directory?: string | null }).sandbox_source_directory ?? null,
    },
    ...(snapshot !== undefined ? { resultSnapshot: snapshot } : {}),
  }
}

export function getSessionCreateByIdempotencyHash(
  db: Database.Interface["db"],
  hash: string,
  directory: string,
): Effect.Effect<SessionCreateRecord | undefined> {
  return Effect.gen(function* () {
    if (typeof hash !== "string" || hash.length === 0) yield* Effect.die(new TypeError("hash must be non-empty string"))
    const rows = yield* db.select().from(SessionOperationTable).where(and(eq(SessionOperationTable.idempotency_hash, hash), eq(SessionOperationTable.op_kind, "create" as const))).all().pipe(Effect.orDie)
    const row = rows.find((r) => (r as unknown as { directory: string | null }).directory === directory)
    if (!row) return undefined
    return rowToSessionCreateRecord(row as typeof SessionOperationTable.$inferSelect)
  }).pipe(Effect.orDie) as Effect.Effect<SessionCreateRecord | undefined>
}

export function getSessionCreateByIdempotencyHashTx(
  tx: DbOrTx,
  hash: string,
  directory: string,
): Effect.Effect<SessionCreateRecord | undefined> {
  return Effect.gen(function* () {
    const rows = yield* tx.select().from(SessionOperationTable).where(and(eq(SessionOperationTable.idempotency_hash, hash), eq(SessionOperationTable.op_kind, "create" as const))).all().pipe(Effect.orDie)
    const row = rows.find((r) => (r as unknown as { directory: string | null }).directory === directory)
    if (!row) return undefined
    return rowToSessionCreateRecord(row as typeof SessionOperationTable.$inferSelect)
  }).pipe(Effect.orDie) as Effect.Effect<SessionCreateRecord | undefined>
}

export function isSessionCreateConflict(
  prev: SessionCreateRecord,
  next: {
    opId: string
    directory: string
    parentSessionId?: string | null
    configVersion?: number | null
    title?: string | null
    parentID?: string | null
    sandboxTokenHash?: string | null
    sandboxSourceSessionId?: string | null
    sandboxSourceDirectory?: string | null
  },
): boolean {
  if (prev.opId !== next.opId) return true
  if (prev.meta.directory !== next.directory) return true
  if ((prev.meta.parentSessionId ?? null) !== (next.parentSessionId ?? null)) return true
  if ((prev.meta.configVersion ?? null) !== (next.configVersion ?? null)) return true
  if ((prev.meta.title ?? null) !== (next.title ?? null)) return true
  if ((prev.meta.parentID ?? null) !== (next.parentID ?? null)) return true
  if ((prev.meta.sandboxTokenHash ?? null) !== (next.sandboxTokenHash ?? null)) return true
  if ((prev.meta.sandboxSourceSessionId ?? null) !== (next.sandboxSourceSessionId ?? null)) return true
  if ((prev.meta.sandboxSourceDirectory ?? null) !== (next.sandboxSourceDirectory ?? null)) return true
  return false
}

export function insertSessionCreateSucceededTx(
  tx: DbOrTx,
  createdSessionId: SessionSchema.ID,
  record: FailureRecord,
  meta: SessionCreateMeta,
  snapshotJson: string | null,
): Effect.Effect<SessionCreateRecord> {
  return Effect.gen(function* () {
    validateRecord(record)
    if (record.outcome !== "succeeded") yield* Effect.die(new Error("insertSessionCreateSucceededTx requires succeeded outcome"))
    if (record.opKind !== "create") yield* Effect.die(new Error("insertSessionCreateSucceededTx requires create opKind"))
    const normalized = normalizeRecord(record)
    const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, createdSessionId)).get().pipe(Effect.orDie)
    if (!session) yield* Effect.die(new Error(`session not found ${createdSessionId}`))
    const cur = yield* tx.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, createdSessionId)).get().pipe(Effect.orDie)
    const nextRev = cur ? (cur as unknown as { rev: number }).rev : 0
    yield* tx
      .insert(SessionOperationTable)
      .values({
        op_id: normalized.opId,
        session_id: createdSessionId,
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
        parent_session_id: meta.parentSessionId ?? null,
        config_version: meta.configVersion ?? null,
        title: meta.title ?? null,
        message_id: meta.parentID ?? null,
        result_snapshot: snapshotJson,
        sandbox_token_hash: meta.sandboxTokenHash ?? null,
        sandbox_source_session_id: meta.sandboxSourceSessionId ?? null,
        sandbox_source_directory: meta.sandboxSourceDirectory ?? null,
      } as unknown as typeof SessionOperationTable.$inferInsert)
      .run()
      .pipe(Effect.orDie)
    const rowRaw = yield* tx.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, normalized.opId)).get().pipe(Effect.orDie)
    if (!rowRaw) yield* Effect.die(new Error(`operation row missing after insert ${normalized.opId}`))
    return rowToSessionCreateRecord(rowRaw as typeof SessionOperationTable.$inferSelect)
  })
}

 // ---------------------------------------------------------------------------
 // SessionDelete tombstone helpers (delete survives cascade via separate table)
 // ---------------------------------------------------------------------------
export interface SessionDeleteMeta {
  idempotencyHash: string
  requestId: string
  directory: string
  parentSessionId?: string | null
  configVersion?: number | null
  sessionRevision?: number | null
}

export interface SessionDeleteRecord {
  opId: string
  sessionId: string
  opKind: "delete"
  outcome: "succeeded" | "failed"
  code: string
  message: string
  time: number
  meta: SessionDeleteMeta
}

function rowToSessionDeleteRecord(row: typeof SessionDeleteTombstoneTable.$inferSelect): SessionDeleteRecord {
  return {
    opId: row.op_id,
    sessionId: row.session_id,
    opKind: "delete",
    outcome: row.outcome as "succeeded" | "failed",
    code: row.code,
    message: row.message,
    time: row.time,
    meta: {
      idempotencyHash: row.idempotency_hash,
      requestId: row.request_id ?? "",
      directory: row.directory ?? "",
      parentSessionId: row.parent_session_id ?? null,
      configVersion: row.config_version ?? null,
      sessionRevision: row.session_revision ?? null,
    },
  }
}

export function getSessionDeleteByIdempotencyHash(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  hash: string,
): Effect.Effect<SessionDeleteRecord | undefined> {
  return Effect.gen(function* () {
    if (typeof hash !== "string" || hash.length === 0) yield* Effect.die(new TypeError("hash must be non-empty string"))
    const row = yield* db.select().from(SessionDeleteTombstoneTable).where(and(eq(SessionDeleteTombstoneTable.session_id, sessionID), eq(SessionDeleteTombstoneTable.idempotency_hash, hash))).get().pipe(Effect.orDie)
    if (!row) return undefined
    return rowToSessionDeleteRecord(row as typeof SessionDeleteTombstoneTable.$inferSelect)
  }).pipe(Effect.orDie) as Effect.Effect<SessionDeleteRecord | undefined>
}

export function getSessionDeleteByIdempotencyHashTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  hash: string,
): Effect.Effect<SessionDeleteRecord | undefined> {
  return Effect.gen(function* () {
    const row = yield* tx.select().from(SessionDeleteTombstoneTable).where(and(eq(SessionDeleteTombstoneTable.session_id, sessionID), eq(SessionDeleteTombstoneTable.idempotency_hash, hash))).get().pipe(Effect.orDie)
    if (!row) return undefined
    return rowToSessionDeleteRecord(row as typeof SessionDeleteTombstoneTable.$inferSelect)
  }).pipe(Effect.orDie) as Effect.Effect<SessionDeleteRecord | undefined>
}

export function isSessionDeleteConflict(
  prev: SessionDeleteRecord,
  next: { opId: string; directory: string; parentSessionId?: string | null; configVersion?: number | null; sessionRevision?: number | null },
): boolean {
  if (prev.opId !== next.opId) return true
  if (prev.meta.directory !== next.directory) return true
  if ((prev.meta.parentSessionId ?? null) !== (next.parentSessionId ?? null)) return true
  if ((prev.meta.configVersion ?? null) !== (next.configVersion ?? null)) return true
  if ((prev.meta.sessionRevision ?? null) !== (next.sessionRevision ?? null)) return true
  return false
}

export function insertSessionDeleteSucceededTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  record: FailureRecord,
  meta: SessionDeleteMeta,
): Effect.Effect<SessionDeleteRecord> {
  return Effect.gen(function* () {
    validateRecord(record)
    if (record.outcome !== "succeeded") yield* Effect.die(new Error("insertSessionDeleteSucceededTx requires succeeded outcome"))
    if (record.opKind !== "delete") yield* Effect.die(new Error("insertSessionDeleteSucceededTx requires delete opKind"))
    const normalized = normalizeRecord(record)
    yield* tx.insert(SessionDeleteTombstoneTable).values({
      op_id: normalized.opId,
      session_id: sessionID,
      idempotency_hash: meta.idempotencyHash,
      request_id: meta.requestId,
      directory: meta.directory,
      parent_session_id: meta.parentSessionId ?? null,
      config_version: meta.configVersion ?? null,
      session_revision: meta.sessionRevision ?? null,
      time: normalized.time,
      code: normalized.code,
      message: normalized.message,
      outcome: normalized.outcome as "succeeded",
    }).run().pipe(Effect.orDie)
    const rowRaw = yield* tx.select().from(SessionDeleteTombstoneTable).where(eq(SessionDeleteTombstoneTable.op_id, normalized.opId)).get().pipe(Effect.orDie)
    if (!rowRaw) yield* Effect.die(new Error(`delete tombstone missing after insert ${normalized.opId}`))
    return rowToSessionDeleteRecord(rowRaw as typeof SessionDeleteTombstoneTable.$inferSelect)
  })
}

export interface SessionRevertMeta {
  idempotencyHash: string
  requestId: string
  directory: string
  parentSessionId?: string | null
  configVersion?: number | null
  sessionRevision?: number | null
  messageId?: string | null
  partId?: string | null
}

export interface SessionRevertRecord extends FailureRecord {
  meta: SessionRevertMeta
  resultSnapshot?: unknown
  revision: number
}

function rowToSessionRevertRecord(row: typeof SessionOperationTable.$inferSelect, kind: "revert" | "unrevert"): SessionRevertRecord {
  const base = rowToRecord(row)
  let snapshot: unknown | undefined
  const rawSnap = (row as unknown as Record<string, unknown>).result_snapshot as string | null | undefined
  if (rawSnap !== null && rawSnap !== undefined) {
    if (typeof rawSnap === "string") {
      try {
        snapshot = JSON.parse(rawSnap)
      } catch {
        snapshot = rawSnap
      }
    } else snapshot = rawSnap
  }
  return {
    ...base,
    revision: row.revision as number,
    meta: {
      idempotencyHash: row.idempotency_hash ?? "",
      requestId: row.request_id ?? "",
      directory: row.directory ?? "",
      parentSessionId: row.parent_session_id ?? null,
      configVersion: row.config_version ?? null,
      sessionRevision: row.session_revision ?? null,
      messageId: (row as unknown as { message_id?: string | null }).message_id ?? null,
      partId: (row as unknown as { title?: string | null }).title ?? null,
    },
    ...(snapshot !== undefined ? { resultSnapshot: snapshot } : {}),
  }
}

function getSessionCheckpointByHash(
  db: Database.Interface["db"] | DbOrTx,
  sessionID: SessionSchema.ID,
  hash: string,
  kind: "revert" | "unrevert",
  tx: boolean,
): Effect.Effect<SessionRevertRecord | undefined> {
  return Effect.gen(function* () {
    const q = tx
      ? (db as DbOrTx).select().from(SessionOperationTable).where(and(eq(SessionOperationTable.session_id, sessionID), eq(SessionOperationTable.idempotency_hash, hash), eq(SessionOperationTable.op_kind, kind))).get()
      : (db as Database.Interface["db"]).select().from(SessionOperationTable).where(and(eq(SessionOperationTable.session_id, sessionID), eq(SessionOperationTable.idempotency_hash, hash), eq(SessionOperationTable.op_kind, kind))).get()
    const row = yield* q.pipe(Effect.orDie)
    if (!row) return undefined
    return rowToSessionRevertRecord(row as typeof SessionOperationTable.$inferSelect, kind)
  }).pipe(Effect.orDie) as Effect.Effect<SessionRevertRecord | undefined>
}

export function getSessionRevertByIdempotencyHash(db: Database.Interface["db"], sessionID: SessionSchema.ID, hash: string) {
  return getSessionCheckpointByHash(db, sessionID, hash, "revert", false)
}

export function getSessionRevertByIdempotencyHashTx(tx: DbOrTx, sessionID: SessionSchema.ID, hash: string) {
  return getSessionCheckpointByHash(tx, sessionID, hash, "revert", true)
}

export function getSessionUnrevertByIdempotencyHash(db: Database.Interface["db"], sessionID: SessionSchema.ID, hash: string) {
  return getSessionCheckpointByHash(db, sessionID, hash, "unrevert", false)
}

export function getSessionUnrevertByIdempotencyHashTx(tx: DbOrTx, sessionID: SessionSchema.ID, hash: string) {
  return getSessionCheckpointByHash(tx, sessionID, hash, "unrevert", true)
}

export function isSessionCheckpointConflict(
  prev: SessionRevertRecord,
  next: { opId: string; directory: string; parentSessionId?: string | null; configVersion?: number | null; sessionRevision?: number | null; messageId?: string | null; partId?: string | null },
): boolean {
  if (prev.opId !== next.opId) return true
  if (prev.meta.directory !== next.directory) return true
  if ((prev.meta.parentSessionId ?? null) !== (next.parentSessionId ?? null)) return true
  if ((prev.meta.configVersion ?? null) !== (next.configVersion ?? null)) return true
  if ((prev.meta.sessionRevision ?? null) !== (next.sessionRevision ?? null)) return true
  if ((prev.meta.messageId ?? null) !== (next.messageId ?? null)) return true
  if ((prev.meta.partId ?? null) !== (next.partId ?? null)) return true
  return false
}

function insertSessionCheckpointSucceededTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  record: FailureRecord,
  meta: SessionRevertMeta,
  snapshotJson: string | null,
  kind: "revert" | "unrevert",
): Effect.Effect<SessionRevertRecord> {
  return Effect.gen(function* () {
    validateRecord(record)
    if (record.outcome !== "succeeded") yield* Effect.die(new Error("insertSessionCheckpointSucceededTx requires succeeded outcome"))
    if (record.opKind !== kind) yield* Effect.die(new Error(`insertSessionCheckpointSucceededTx requires ${kind} opKind`))
    const normalized = normalizeRecord(record)
    const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    if (!session) yield* Effect.die(new Error(`session not found ${sessionID}`))
    const cur = yield* tx.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    const nextRev = cur ? (cur as unknown as { rev: number }).rev : 0
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
        parent_session_id: meta.parentSessionId ?? null,
        config_version: meta.configVersion ?? null,
        session_revision: meta.sessionRevision ?? null,
        message_id: meta.messageId ?? null,
        title: meta.partId ?? null,
        result_snapshot: snapshotJson,
      } as unknown as typeof SessionOperationTable.$inferInsert)
      .run()
      .pipe(Effect.orDie)
    const rowRaw = yield* tx.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, normalized.opId)).get().pipe(Effect.orDie)
    if (!rowRaw) yield* Effect.die(new Error(`operation row missing after insert ${normalized.opId}`))
    return rowToSessionRevertRecord(rowRaw as typeof SessionOperationTable.$inferSelect, kind)
  })
}

export function insertSessionRevertSucceededTx(tx: DbOrTx, sessionID: SessionSchema.ID, record: FailureRecord, meta: SessionRevertMeta, snapshotJson: string | null) {
  return insertSessionCheckpointSucceededTx(tx, sessionID, record, meta, snapshotJson, "revert")
}

export function insertSessionUnrevertSucceededTx(tx: DbOrTx, sessionID: SessionSchema.ID, record: FailureRecord, meta: SessionRevertMeta, snapshotJson: string | null) {
  return insertSessionCheckpointSucceededTx(tx, sessionID, record, meta, snapshotJson, "unrevert")
}
