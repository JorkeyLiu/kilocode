export * as SessionOperation from "./operation"

import { asc, eq, and, sql } from "drizzle-orm"
import { Data, Effect } from "effect"
import { createHash } from "node:crypto"
import { isAbsolute, normalize, resolve } from "node:path"
import { Database } from "../database/database"
import { SessionTable, SessionOperationTable, SessionDeleteTombstoneTable, SessionGenerationOwnerTable, SessionGenerationMemberTable, SessionOperationReceiptTable } from "./sql"
import type { SessionSchema } from "./schema"
import * as Changefeed from "../retention/changefeed"
import { SessionRevision } from "./revision"
import { FSUtil } from "../fs-util"

// Same-physical directory helpers for operation idempotency scope.
// New rows store the authoritative realpath spelling; legacy rows may carry
// the lexical (`/var/...`) spelling of the same physical directory.
// Comparisons resolve both sides (lexical normalize then realpath with
// ENOENT fallback); truly different physical directories stay distinct.
function lexicalDir(dir: string): string {
  if (typeof dir !== "string" || !isAbsolute(dir)) throw new Error("directory must be absolute path")
  if (dir.includes("\0")) throw new Error("directory must not contain null bytes")
  return normalize(resolve(dir))
}

function samePhysicalDir(a: string, b: string): boolean {
  if (a === b) return true
  try {
    return FSUtil.resolve(lexicalDir(a)) === FSUtil.resolve(lexicalDir(b))
  } catch {
    return false
  }
}

function matchesRequestDir(stored: string | null, requested: string): boolean {
  if (typeof stored !== "string") return false
  if (stored === requested) return true
  return samePhysicalDir(stored, requested)
}

function isDirConflict(prev: string, next: string): boolean {
  if (prev === next) return false
  try {
    return !samePhysicalDir(prev, next)
  } catch {
    return true
  }
}

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

const sensitiveKey = String.raw`api[_-]?key|apikey|token|authorization|password|secret|credential`
const bareOrQuotedKey = String.raw`(?:"(?:${sensitiveKey})"|'(?:${sensitiveKey})'|(?:${sensitiveKey}))`
const quotedScrub = new RegExp(
  String.raw`(^|[^A-Za-z0-9_-])(${bareOrQuotedKey})(?![A-Za-z0-9_-])\s*[:=]\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`,
  "gi",
)
const bearerScrub = new RegExp(
  String.raw`(^|[^A-Za-z0-9_-])((?:"authorization"|'authorization'|authorization))(?![A-Za-z0-9_-])\s*[:=]\s*Bearer\s+(?:\[redacted\]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;"')\]}]+)`,
  "gi",
)
const valueScrub = new RegExp(
  String.raw`(^|[^A-Za-z0-9_-])(${bareOrQuotedKey})(?![A-Za-z0-9_-])\s*[:=]\s*(?:\[redacted\]|[^\s,;"')\]}]+)`,
  "gi",
)
// JSON-stringified diagnostics carry backslash-escaped quotes
// (e.g. detail `{\"api_key\": \"secret\"}`); the plain quoted scrub above
// cannot see the key, so scrub the escaped form with the same redaction.
const escapedQuotedScrub = new RegExp(
  String.raw`(^|[^A-Za-z0-9_-])((?:\\"(?:${sensitiveKey})\\"|\\'(?:${sensitiveKey})\\'))(?![A-Za-z0-9_-])\s*[:=]\s*(?:\\"(?:[^"\\]|\\.)*\\"|\\'(?:[^'\\]|\\.)*\\')`,
  "gi",
)
const escapedValueScrub = new RegExp(
  String.raw`(^|[^A-Za-z0-9_-])((?:\\"(?:${sensitiveKey})\\"|\\'(?:${sensitiveKey})\\'))(?![A-Za-z0-9_-])\s*[:=]\s*(?:\[redacted\]|[^\s,;"')\]}]+)`,
  "gi",
)

function cap(s: string, max: number): string {
  if (s.length > max) return s.slice(0, max) + "…"
  return s
}

function scrubString(s: string): string {
  s = s.replace(quotedScrub, (_m: string, prefix: string, k: string) => `${prefix}${k}=[redacted]`)
  s = s.replace(bearerScrub, (_m: string, prefix: string, k: string) => `${prefix}${k}=[redacted]`)
  s = s.replace(valueScrub, (_m: string, prefix: string, k: string) => `${prefix}${k}=[redacted]`)
  s = s.replace(escapedQuotedScrub, (_m: string, prefix: string, k: string) => `${prefix}${k}=[redacted]`)
  return s.replace(escapedValueScrub, (_m: string, prefix: string, k: string) => `${prefix}${k}=[redacted]`)
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
// Normal generation terminal — sole cohesive wrapper for accepted prompt/
// command generation outcome (direction 79-94).
//
// Both session/prompt and session/command share `prompt:<messageId>` identity
// and `prompt.*` codes; crash convergence uses the same fixed safe record.
// Every accepted→succeeded/failed/abandoned terminal record must be built here
// so durable scrub/cap (normalizeRecord) cannot diverge between call sites.
// Classification never schedules recovery: this wrapper carries no budget/
// timer/retry fields; recovery stays `{budget:0,nextAt:null,provenance:
// "terminal"}` via recoveryForTerminal at write time. Success/in-flight carry
// no failure semantics beyond the shared shape; panel/diagnostic stripping
// stays in toPanelRecord/toDiagnosticRecord.
// ---------------------------------------------------------------------------
export type GenerationTerminalOutcome = "succeeded" | "failed" | "abandoned"

export function generationTerminal(input: {
  opId: string
  outcome: GenerationTerminalOutcome
  code: string
  message: string
  detail?: string
  time?: number
}): FailureRecord {
  if (typeof input.opId !== "string" || input.opId.length === 0) throw new TypeError("opId must be non-empty string")
  const parsed = parseOpId(input.opId)
  if (parsed.kind !== "prompt") throw new TypeError(`generation terminal opId kind must be prompt, got ${parsed.kind}`)
  if (input.outcome !== "succeeded" && input.outcome !== "failed" && input.outcome !== "abandoned")
    throw new TypeError("outcome must be succeeded, failed, or abandoned")
  if (typeof input.code !== "string" || input.code.length === 0) throw new TypeError("code must be non-empty string")
  if (typeof input.message !== "string") throw new TypeError("message must be string")
  if (input.detail !== undefined && typeof input.detail !== "string") throw new TypeError("detail must be string")
  const time = input.time ?? Date.now()
  if (typeof time !== "number" || !Number.isFinite(time)) throw new TypeError("time must be finite number")
  return normalizeRecord({
    opId: input.opId,
    opKind: "prompt",
    outcome: input.outcome,
    code: input.code,
    message: input.message,
    time,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  })
}

export const PROVIDER_CRASH_CONVERGE_CODE = "provider.abandoned"
export const PROVIDER_CRASH_CONVERGE_MESSAGE = "Provider attempt abandoned after runtime restart"

// ---------------------------------------------------------------------------
// Provider crash terminal — fixed safe record for an orphaned provider
// `in-flight` row after private-runtime process death.
//
// The fresh boot owns no volatile provider state by construction, so the
// converged durable row releases the last ownership at receipt (boot) time;
// the superseded accept (occurrence) time is not retained and no occurrence
// crash timestamp is fabricated. Fixed `provider.abandoned` code/message
// only (no caller-supplied code/message/detail/stack/cancel); never routes
// through prompt-only `generationTerminal`. `putTx` accounting for a
// provider terminal emits exactly one revision + one `changed` feed row —
// never a `generation` entry — and `recoveryForTerminal` yields no recovery
// columns for provider, so no recovery fields are held. No retry, no replay.
// ---------------------------------------------------------------------------
export function providerTerminal(input: { opId: string; time?: number }): FailureRecord {
  if (typeof input.opId !== "string" || input.opId.length === 0) throw new TypeError("opId must be non-empty string")
  const parsed = parseOpId(input.opId)
  if (parsed.kind !== "provider") throw new TypeError(`provider terminal opId kind must be provider, got ${parsed.kind}`)
  const time = input.time ?? Date.now()
  if (typeof time !== "number" || !Number.isFinite(time)) throw new TypeError("time must be finite number")
  return normalizeRecord({
    opId: input.opId,
    opKind: "provider",
    outcome: "abandoned",
    code: PROVIDER_CRASH_CONVERGE_CODE,
    message: PROVIDER_CRASH_CONVERGE_MESSAGE,
    time,
  })
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
  if (isDirConflict(prev.meta.directory, next.directory)) return true
  if ((prev.meta.parentSessionId ?? null) !== (next.parentSessionId ?? null)) return true
  if ((prev.meta.configVersion ?? null) !== (next.configVersion ?? null)) return true
  if ((prev.meta.sessionRevision ?? null) !== (next.sessionRevision ?? null)) return true
  if (prev.meta.messageId !== next.messageId) return true
  return false
}

// ---------------------------------------------------------------------------
// Terminal receipt — runtime-owned per-operation owner fact, same-tx only.
// ---------------------------------------------------------------------------
export const RECEIPT_REPLAY_FORBIDDEN = "forbidden" as const
export const RECEIPT_GEN_UNKNOWNS = ["non_gen_kind", "no_member", "legacy_null"] as const
export type ReceiptGenUnknown = (typeof RECEIPT_GEN_UNKNOWNS)[number]
export const RECEIPT_OWNER_LAYERS = ["provider", "incomplete", "broker", "task", "restart"] as const
export type ReceiptOwnerLayer = (typeof RECEIPT_OWNER_LAYERS)[number]
export const RECEIPT_CLOSE_REASONS = ["completed", "interrupted", "error", "crash"] as const
export type ReceiptCloseReason = (typeof RECEIPT_CLOSE_REASONS)[number]

const receiptLayerSet = new Set<string>(RECEIPT_OWNER_LAYERS as readonly string[])
const receiptCloseSet = new Set<string>(RECEIPT_CLOSE_REASONS as readonly string[])
const receiptOutcomeSet = new Set<string>(["succeeded", "failed", "ambiguous", "superseded", "abandoned"])
const receiptUnknownSet = new Set<string>(RECEIPT_GEN_UNKNOWNS as readonly string[])

export interface OperationReceipt {
  opId: string
  sessionID: string
  outcome: "succeeded" | "failed" | "ambiguous" | "superseded" | "abandoned"
  time: number
  genID: string | null
  unknown: ReceiptGenUnknown | null
  used: number | null
  limit: number | null
  layer: ReceiptOwnerLayer | null
  retryOccurrence: number | null
  nextAt: number | null
  closeReason: ReceiptCloseReason | null
  replay: typeof RECEIPT_REPLAY_FORBIDDEN
}

function assertReceiptGen(value: string) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("genID must be non-empty string")
  if (value.includes(":")) throw new TypeError("genID must not contain ':'")
}

interface ReceiptOwnerSnapshot {
  used: number
  limit: number
  layer: ReceiptOwnerLayer | null
  retryOccurrence: number | null
  nextAt: number | null
  closeReason: ReceiptCloseReason | null
}

function snapshotOwnerRow(genID: string, sid: string, row: typeof SessionGenerationOwnerTable.$inferSelect): ReceiptOwnerSnapshot {
  if ((row.session_id as unknown as string) !== sid)
    throw new Error(`cross-identity gen ${genID} already owned by session ${row.session_id}`)
  if (!Number.isInteger(row.retry_consumed) || (row.retry_consumed as number) < 0)
    throw new TypeError(`invalid generation owner row ${genID}: retry_consumed invalid`)
  if (!Number.isInteger(row.retry_limit) || (row.retry_limit as number) < 0)
    throw new TypeError(`invalid generation owner row ${genID}: retry_limit invalid`)
  if ((row.retry_consumed as number) > (row.retry_limit as number))
    throw new TypeError(`invalid generation owner row ${genID}: retry_consumed exceeds limit`)
  const layer = (row.retry_layer as ReceiptOwnerLayer | null | undefined) ?? null
  if (layer !== null && !receiptLayerSet.has(layer as string))
    throw new TypeError(`invalid generation owner row ${genID}: retry_layer invalid`)
  const occurrence = (row.retry_occurrence_time as number | null | undefined) ?? null
  if (occurrence !== null && (typeof occurrence !== "number" || !Number.isFinite(occurrence)))
    throw new TypeError(`invalid generation owner row ${genID}: retry_occurrence_time invalid`)
  const nextAt = (row.retry_next_at as number | null | undefined) ?? null
  if (nextAt !== null && (typeof nextAt !== "number" || !Number.isFinite(nextAt)))
    throw new TypeError(`invalid generation owner row ${genID}: retry_next_at invalid`)
  const reason = (row.close_reason as ReceiptCloseReason | null | undefined) ?? null
  if (reason !== null && !receiptCloseSet.has(reason as string))
    throw new TypeError(`invalid generation owner row ${genID}: close_reason invalid`)
  const closed = reason !== null
  if (closed) {
    if (nextAt !== null) throw new TypeError(`invalid generation owner row ${genID}: retry_next_at must be null once closed`)
    if (occurrence !== null && layer === null)
      throw new TypeError(`invalid generation owner row ${genID}: retry_occurrence_time requires retry_layer once closed`)
  } else {
    if ((layer === null) !== (nextAt === null))
      throw new TypeError(`invalid generation owner row ${genID}: retry_layer and retry_next_at must be set together`)
    if (occurrence !== null && (layer === null || nextAt === null))
      throw new TypeError(`invalid generation owner row ${genID}: retry_occurrence_time requires retry_layer and retry_next_at`)
  }
  return { used: row.retry_consumed as number, limit: row.retry_limit as number, layer, retryOccurrence: occurrence, nextAt, closeReason: reason }
}

function resolveReceiptTx(
  tx: DbOrTx,
  normalized: FailureRecord,
  sessionID: SessionSchema.ID,
  providerLink: string | null,
): Effect.Effect<Omit<OperationReceipt, "opId" | "sessionID" | "outcome" | "time" | "replay">, unknown, never> {
  return Effect.gen(function* () {
    const sid = sessionID as unknown as string
    if (normalized.opKind === "provider") {
      if (providerLink === null) return { genID: null, unknown: "legacy_null" as const, used: null, limit: null, layer: null, retryOccurrence: null, nextAt: null, closeReason: null }
      try {
        assertReceiptGen(providerLink)
      } catch (e) {
        yield* Effect.die(e instanceof Error ? e : new TypeError(String(e)))
        return { genID: null, unknown: null, used: null, limit: null, layer: null, retryOccurrence: null, nextAt: null, closeReason: null }
      }
      const owner = yield* tx
        .select()
        .from(SessionGenerationOwnerTable)
        .where(eq(SessionGenerationOwnerTable.gen_id, providerLink))
        .get()
        .pipe(Effect.orDie)
      if (!owner) yield* Effect.die(new Error(`generation owner missing for ${providerLink}`))
      let snap: ReceiptOwnerSnapshot
      try {
        snap = snapshotOwnerRow(providerLink, sid, owner as typeof SessionGenerationOwnerTable.$inferSelect)
      } catch (e) {
        yield* Effect.die(e instanceof Error ? e : new TypeError(String(e)))
        return { genID: null, unknown: null, used: null, limit: null, layer: null, retryOccurrence: null, nextAt: null, closeReason: null }
      }
      return { genID: providerLink, unknown: null, used: snap.used, limit: snap.limit, layer: snap.layer, retryOccurrence: snap.retryOccurrence, nextAt: snap.nextAt, closeReason: snap.closeReason }
    }
    if (normalized.opKind === "prompt") {
      const members = yield* tx
        .select()
        .from(SessionGenerationMemberTable)
        .where(eq(SessionGenerationMemberTable.prompt_op_id, normalized.opId))
        .all()
        .pipe(Effect.orDie)
      const rows = members as (typeof SessionGenerationMemberTable.$inferSelect)[]
      if (rows.length === 0)
        return { genID: null, unknown: "no_member" as const, used: null, limit: null, layer: null, retryOccurrence: null, nextAt: null, closeReason: null }
      if (rows.length !== 1) yield* Effect.die(new Error(`ambiguous generation membership for ${normalized.opId}: ${rows.length} members`))
      const member = rows[0]!
      const genID = member.gen_id
      try {
        assertReceiptGen(genID)
      } catch (e) {
        yield* Effect.die(e instanceof Error ? e : new TypeError(String(e)))
        return { genID: null, unknown: null, used: null, limit: null, layer: null, retryOccurrence: null, nextAt: null, closeReason: null }
      }
      if ((member.session_id as unknown as string) !== sid)
        yield* Effect.die(new Error(`cross-identity gen ${genID} already owned by session ${member.session_id}`))
      const owner = yield* tx
        .select()
        .from(SessionGenerationOwnerTable)
        .where(eq(SessionGenerationOwnerTable.gen_id, genID))
        .get()
        .pipe(Effect.orDie)
      if (!owner) yield* Effect.die(new Error(`generation owner missing for ${genID}`))
      let snap: ReceiptOwnerSnapshot
      try {
        snap = snapshotOwnerRow(genID, sid, owner as typeof SessionGenerationOwnerTable.$inferSelect)
      } catch (e) {
        yield* Effect.die(e instanceof Error ? e : new TypeError(String(e)))
        return { genID: null, unknown: null, used: null, limit: null, layer: null, retryOccurrence: null, nextAt: null, closeReason: null }
      }
      return { genID, unknown: null, used: snap.used, limit: snap.limit, layer: snap.layer, retryOccurrence: snap.retryOccurrence, nextAt: snap.nextAt, closeReason: snap.closeReason }
    }
    return { genID: null, unknown: "non_gen_kind" as const, used: null, limit: null, layer: null, retryOccurrence: null, nextAt: null, closeReason: null }
  })
}

function writeReceiptTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  normalized: FailureRecord,
  providerLink: string | null,
): Effect.Effect<void, unknown, never> {
  return Effect.gen(function* () {
    if (!isTerminal(normalized.outcome)) return
    const part = yield* resolveReceiptTx(tx, normalized, sessionID, providerLink)
    yield* tx
      .insert(SessionOperationReceiptTable)
      .values({
        op_id: normalized.opId,
        session_id: sessionID,
        outcome: normalized.outcome as OperationReceipt["outcome"],
        time: normalized.time,
        gen_id: part.genID,
        gen_unknown: part.unknown,
        owner_used: part.used,
        owner_limit: part.limit,
        owner_layer: part.layer,
        owner_retry_occurrence: part.retryOccurrence,
        owner_next_at: part.nextAt,
        owner_close_reason: part.closeReason,
        replay: RECEIPT_REPLAY_FORBIDDEN,
      } as unknown as typeof SessionOperationReceiptTable.$inferInsert)
      .run()
      .pipe(Effect.orDie)
  })
}

function rowToReceipt(row: typeof SessionOperationReceiptTable.$inferSelect): OperationReceipt {
  const raw = row as unknown as Record<string, unknown>
  const op = raw["op_id"]
  if (typeof op !== "string" || op.length === 0) throw new TypeError("op_id must be non-empty string")
  const sid = raw["session_id"]
  if (typeof sid !== "string" || sid.length === 0) throw new TypeError("session_id must be non-empty string")
  const outcome = raw["outcome"]
  if (typeof outcome !== "string" || !receiptOutcomeSet.has(outcome))
    throw new TypeError(`outcome must be one of succeeded, failed, ambiguous, superseded, abandoned`)
  const time = raw["time"]
  if (typeof time !== "number" || !Number.isSafeInteger(time))
    throw new TypeError("time must be safe integer")
  const replay = raw["replay"]
  if (replay !== RECEIPT_REPLAY_FORBIDDEN) throw new TypeError(`replay must be forbidden`)
  const genRaw = raw["gen_id"]
  const unkRaw = raw["gen_unknown"]
  let gen: string | null
  if (genRaw === null || genRaw === undefined) gen = null
  else if (typeof genRaw === "string") gen = genRaw
  else throw new TypeError("gen_id must be string or null")
  let unk: ReceiptGenUnknown | null
  if (unkRaw === null || unkRaw === undefined) unk = null
  else if (typeof unkRaw === "string" && receiptUnknownSet.has(unkRaw)) unk = unkRaw as ReceiptGenUnknown
  else throw new TypeError(`gen_unknown must be one of ${RECEIPT_GEN_UNKNOWNS.join(", ")} or null`)
  if (gen !== null) {
    if (gen.length === 0) throw new TypeError("gen_id must be non-empty string")
    if (gen.includes(":")) throw new TypeError("gen_id must not contain ':'")
  }
  if ((gen === null) === (unk === null)) throw new TypeError("gen_id and gen_unknown must satisfy exact XOR")
  const usedRaw = raw["owner_used"]
  const limitRaw = raw["owner_limit"]
  const layerRaw = raw["owner_layer"]
  const occRaw = raw["owner_retry_occurrence"]
  const nextRaw = raw["owner_next_at"]
  const reasonRaw = raw["owner_close_reason"]
  const numOrNull = (v: unknown, label: string): number | null => {
    if (v === null || v === undefined) return null
    if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new TypeError(`${label} must be safe integer or null`)
    return v
  }
  const used = numOrNull(usedRaw, "owner_used")
  const limit = numOrNull(limitRaw, "owner_limit")
  const occ = numOrNull(occRaw, "owner_retry_occurrence")
  const next = numOrNull(nextRaw, "owner_next_at")
  let layer: ReceiptOwnerLayer | null
  if (layerRaw === null || layerRaw === undefined) layer = null
  else if (typeof layerRaw === "string" && receiptLayerSet.has(layerRaw)) layer = layerRaw as ReceiptOwnerLayer
  else throw new TypeError(`owner_layer must be one of ${RECEIPT_OWNER_LAYERS.join(", ")} or null`)
  let reason: ReceiptCloseReason | null
  if (reasonRaw === null || reasonRaw === undefined) reason = null
  else if (typeof reasonRaw === "string" && receiptCloseSet.has(reasonRaw)) reason = reasonRaw as ReceiptCloseReason
  else throw new TypeError(`owner_close_reason must be one of ${RECEIPT_CLOSE_REASONS.join(", ")} or null`)
  if (unk !== null) {
    if (used !== null || limit !== null || layer !== null || occ !== null || next !== null || reason !== null)
      throw new TypeError("owner scope must be null when gen_unknown is set")
  } else {
    if (used === null || limit === null) throw new TypeError("owner_used and owner_limit must be set when gen_id is set")
    if (used < 0 || limit < 0) throw new TypeError("owner_used and owner_limit must be nonnegative")
    if (used > limit) throw new TypeError("owner_used must not exceed owner_limit")
    const closed = reason !== null
    if (closed) {
      if (next !== null) throw new TypeError("owner_next_at must be null once closed")
      if (occ !== null && layer === null)
        throw new TypeError("owner_retry_occurrence requires owner_layer once closed")
    } else {
      if ((layer === null) !== (next === null))
        throw new TypeError("owner_layer and owner_next_at must be set together")
      if (occ !== null && (layer === null || next === null))
        throw new TypeError("owner_retry_occurrence requires owner_layer and owner_next_at")
    }
  }
  return {
    opId: op,
    sessionID: sid,
    outcome: outcome as OperationReceipt["outcome"],
    time,
    genID: gen,
    unknown: unk,
    used,
    limit,
    layer,
    retryOccurrence: occ,
    nextAt: next,
    closeReason: reason,
    replay: RECEIPT_REPLAY_FORBIDDEN,
  }
}

// ---------------------------------------------------------------------------
// Versioned redacted recovery projection — read-only, receipt + live owner.
//
// A terminal `prompt`/`provider` operation carries a durable receipt snapshot
// (written atomically with the terminal transition) plus a live generation
// owner row. This projection combines both without inventing facts:
//
// - Attribution comes from the receipt only: `gen_unknown != null`, missing
//   receipt (legacy rows, direct inserts, pre-receipt databases), or a
//   session/gen mismatch yields `undefined` (no recovery field), never a
//   placeholder budget.
// - Budget/termination/provenance come from the CURRENT owner row (live
//   truth), not the receipt snapshot: crash ordering writes the receipt while
//   the owner is still open, then the generation sweep closes the owner and
//   clears the pending intent. Projecting the snapshot's stale `nextAt`
//   would present a superseded schedule as current.
// - `nextAt`/`retryOccurrence` are informational occurrence times only and
//   are never copied from the terminal `time`; `replay` is always `false`
//   so the intent can never be read as a replayable instruction.
// - No secrets cross: `genID`, `detail`, `stack`, request identities, and
//   raw diagnostics are never projected; only counts, termination, safe
//   occurrence times, and closed-vocabulary provenance remain.
// ---------------------------------------------------------------------------
export const RECOVERY_PROJECTION_VERSION = 1 as const

export interface RecoveryProjection {
  v: typeof RECOVERY_PROJECTION_VERSION
  owner: "generation"
  scope: string
  used: number
  limit: number
  terminated: boolean
  nextAt: number | null
  retryOccurrence: number | null
  layer: ReceiptOwnerLayer | null
  closeReason: ReceiptCloseReason | null
  replay: false
}

function isSafeNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && (v as number) >= 0
}

export function validateRecoveryProjection(v: unknown): RecoveryProjection {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new TypeError("recovery must be object")
  const r = v as Record<string, unknown>
  const allowed = new Set(["v", "owner", "scope", "used", "limit", "terminated", "nextAt", "retryOccurrence", "layer", "closeReason", "replay"])
  for (const k of Object.keys(r)) if (!allowed.has(k)) throw new TypeError(`recovery has extra key ${k}`)
  if (r.v !== RECOVERY_PROJECTION_VERSION) throw new TypeError("recovery version must be 1")
  if (r.owner !== "generation") throw new TypeError(`recovery owner must be generation`)
  if (typeof r.scope !== "string" || r.scope.length === 0 || r.scope.includes("\0")) throw new TypeError("recovery scope must be non-empty string")
  if (!isSafeNonNegativeInt(r.used)) throw new TypeError("recovery used must be safe integer >=0")
  if (!isSafeNonNegativeInt(r.limit)) throw new TypeError("recovery limit must be safe integer >=0")
  if ((r.used as number) > (r.limit as number)) throw new TypeError("recovery used must not exceed limit")
  if (typeof r.terminated !== "boolean") throw new TypeError("recovery terminated must be boolean")
  if (r.nextAt !== null && !isSafeNonNegativeInt(r.nextAt)) throw new TypeError("recovery nextAt must be safe integer or null")
  if (r.retryOccurrence !== null && !isSafeNonNegativeInt(r.retryOccurrence)) throw new TypeError("recovery retryOccurrence must be safe integer or null")
  if (r.layer !== null && (typeof r.layer !== "string" || !receiptLayerSet.has(r.layer as string))) throw new TypeError("recovery layer invalid")
  if (r.closeReason !== null && (typeof r.closeReason !== "string" || !receiptCloseSet.has(r.closeReason as string))) throw new TypeError("recovery closeReason invalid")
  if (r.replay !== false) throw new TypeError("recovery replay must be false")
  const closed = r.closeReason !== null
  if ((r.terminated as boolean) !== closed) throw new TypeError("recovery terminated must match closeReason presence")
  if (closed && r.nextAt !== null) throw new TypeError("recovery nextAt must be null once closed")
  if (!closed && ((r.layer === null) !== (r.nextAt === null))) throw new TypeError("recovery layer and nextAt must be set together while open")
  if (r.retryOccurrence !== null && r.layer === null) throw new TypeError("recovery retryOccurrence requires layer")
  if (r.retryOccurrence !== null && !closed && r.nextAt === null) throw new TypeError("recovery retryOccurrence requires nextAt while open")
  return v as RecoveryProjection
}

function isMissingTableError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e ?? "")
  return msg.includes("no such table") || msg.includes("no such column") || msg.includes("gen_id")
}

export function getRecoveryProjection(
  db: Database.Interface["db"],
  opId: string,
  sessionID: SessionSchema.ID,
): Effect.Effect<RecoveryProjection | undefined> {
  return Effect.gen(function* () {
    if (typeof opId !== "string" || opId.length === 0) yield* Effect.die(new TypeError("opId must be non-empty string"))
    const sid = sessionID as unknown as string
    if (typeof sid !== "string" || sid.length === 0) yield* Effect.die(new TypeError("session_id must be non-empty"))
    let kind: OpKind
    try {
      kind = parseOpId(opId).kind
    } catch {
      return undefined
    }
    if (kind !== "prompt" && kind !== "provider") return undefined
    const opRow = yield* db
      .select()
      .from(SessionOperationTable)
      .where(eq(SessionOperationTable.op_id, opId))
      .get()
      .pipe(Effect.orDie)
    if (!opRow) return undefined
    let rec: FailureRecord
    try {
      rec = rowToValidatedRecord(opRow as typeof SessionOperationTable.$inferSelect)
    } catch {
      return undefined
    }
    if ((opRow.session_id as unknown as string) !== sid) return undefined
    if (rec.outcome !== "failed" && rec.outcome !== "abandoned") return undefined
    let receipt: OperationReceipt | undefined
    try {
      receipt = yield* getReceipt(db, opId)
    } catch (e) {
      if (isMissingTableError(e)) return undefined
      return undefined
    }
    if (!receipt) return undefined
    if (receipt.unknown !== null || receipt.genID === null) return undefined
    if (receipt.sessionID !== sid) return undefined
    if (receipt.outcome !== rec.outcome || receipt.time !== rec.time) return undefined
    let ownerRow: typeof SessionGenerationOwnerTable.$inferSelect | undefined
    try {
      const found = yield* db
        .select()
        .from(SessionGenerationOwnerTable)
        .where(eq(SessionGenerationOwnerTable.gen_id, receipt.genID!))
        .get()
        .pipe(Effect.orDie)
      ownerRow = (found ?? undefined) as typeof SessionGenerationOwnerTable.$inferSelect | undefined
    } catch (e) {
      if (isMissingTableError(e)) return undefined
      return undefined
    }
    if (!ownerRow) return undefined
    if ((ownerRow.session_id as unknown as string) !== sid) return undefined
    let snap: ReceiptOwnerSnapshot
    try {
      snap = snapshotOwnerRow(receipt.genID!, sid, ownerRow)
    } catch {
      return undefined
    }
    if (snap.limit !== receipt.limit) return undefined
    if (snap.used < (receipt.used ?? 0)) return undefined
    const candidate: RecoveryProjection = {
      v: RECOVERY_PROJECTION_VERSION,
      owner: "generation",
      scope: sid,
      used: snap.used,
      limit: snap.limit,
      terminated: snap.closeReason !== null,
      nextAt: snap.nextAt,
      retryOccurrence: snap.retryOccurrence,
      layer: snap.layer,
      closeReason: snap.closeReason,
      replay: false as const,
    }
    try {
      return validateRecoveryProjection(candidate)
    } catch {
      return undefined
    }
  }).pipe(Effect.orDie) as Effect.Effect<RecoveryProjection | undefined>
}

export function getReceipt(
  db: Database.Interface["db"],
  opId: string,
): Effect.Effect<OperationReceipt | undefined> {
  return Effect.gen(function* () {
    if (typeof opId !== "string" || opId.length === 0) yield* Effect.die(new TypeError("opId must be non-empty string"))
    const row = yield* db
      .select()
      .from(SessionOperationReceiptTable)
      .where(eq(SessionOperationReceiptTable.op_id, opId))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    try {
      return rowToReceipt(row as typeof SessionOperationReceiptTable.$inferSelect)
    } catch (e) {
      return yield* Effect.die(
        new TypeError(`invalid persisted operation receipt row ${opId}: ${e instanceof Error ? e.message : String(e)}`),
      )
    }
  }).pipe(Effect.orDie) as Effect.Effect<OperationReceipt | undefined>
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
      yield* writeReceiptTx(tx, sessionID, normalized, rowLink(existingRow))
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
      yield* writeReceiptTx(tx, sessionID, normalized, null)
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
      yield* writeReceiptTx(tx, sessionID, normalized, rowLink(existingRow))
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
      yield* writeReceiptTx(tx, sessionID, normalized, null)
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

export type TryTransitionProviderTerminalResult =
  | { applied: true; record: FailureRecord; entry: Changefeed.Entry; generationEntry?: undefined }
  | { applied: false; record: FailureRecord | undefined; entry?: undefined }

// ---------------------------------------------------------------------------
// Provider-specific terminal CAS — `in-flight` → `abandoned` only.
//
// Fail-closed adapter: only the fixed crash record shape is accepted
// (`opKind` provider, `abandoned`, `provider.abandoned` code/message, no
// cancel/detail/stack). Anything else dies without a write. Delegates to the
// original `putTx`, so a provider terminal emits exactly one revision + one
// `changed` feed row, never a `generation` entry, and holds no recovery
// fields (`recoveryForTerminal` is prompt-only). A live terminal win races
// safely: the loser observes `applied: false` and emits nothing.
// ---------------------------------------------------------------------------
function assertProviderCrashRecord(record: FailureRecord) {
  if (record.opKind !== "provider") throw new TypeError(`provider terminal opKind must be provider, got ${record.opKind}`)
  if (record.outcome !== "abandoned") throw new TypeError(`provider terminal outcome must be abandoned, got ${record.outcome}`)
  if (record.code !== PROVIDER_CRASH_CONVERGE_CODE) throw new TypeError(`provider terminal code must be ${PROVIDER_CRASH_CONVERGE_CODE}`)
  if (record.message !== PROVIDER_CRASH_CONVERGE_MESSAGE) throw new TypeError(`provider terminal message mismatch`)
  if (record.cancel !== undefined) throw new TypeError(`provider terminal must not carry cancel`)
  if (record.detail !== undefined) throw new TypeError(`provider terminal must not carry detail`)
  if (record.stack !== undefined) throw new TypeError(`provider terminal must not carry stack`)
  assertOpIdMatchesKind(record.opId, "provider")
}

export function tryTransitionProviderTerminalTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  record: FailureRecord,
): Effect.Effect<TryTransitionProviderTerminalResult, unknown, never> {
  return Effect.gen(function* () {
    try {
      validateRecord(record)
      assertProviderCrashRecord(record)
    } catch (e) {
      yield* Effect.die(e instanceof Error ? e : new TypeError(String(e)))
      return { applied: false as const, record: undefined, entry: undefined }
    }
    const existingRow = yield* tx.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, record.opId)).get().pipe(Effect.orDie)
    if (!existingRow) {
      yield* Effect.die(new Error(`provider terminal requires existing in-flight row for ${record.opId}`))
      return { applied: false as const, record: undefined, entry: undefined }
    }
    let existing: FailureRecord
    try {
      existing = rowToValidatedRecord(existingRow as typeof SessionOperationTable.$inferSelect)
    } catch (e) {
      yield* Effect.die(new TypeError(`invalid persisted operation row ${record.opId}: ${e instanceof Error ? e.message : String(e)}`))
      return { applied: false as const, record: undefined, entry: undefined }
    }
    if ((existingRow as typeof SessionOperationTable.$inferSelect).session_id !== sessionID) {
      yield* Effect.die(new Error(`cross-identity opId ${record.opId} already owned by session ${(existingRow as typeof SessionOperationTable.$inferSelect).session_id}`))
      return { applied: false as const, record: undefined, entry: undefined }
    }
    if (existing.opKind !== "provider" || existing.outcome !== "in-flight") return { applied: false as const, record: existing, entry: undefined }
    const { record: applied, entry, generationEntry } = yield* putTx(tx as DbOrTx, sessionID, record)
    if (generationEntry) yield* Effect.die(new Error(`provider terminal must never emit generation entry for ${record.opId}`))
    return { applied: true as const, record: applied, entry }
  })
}

export function tryTransitionProviderTerminal(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  record: FailureRecord,
): Effect.Effect<TryTransitionProviderTerminalResult, unknown, never> {
  return db
    .transaction((tx) => tryTransitionProviderTerminalTx(tx as DbOrTx, sessionID, record), { behavior: "immediate" })
    .pipe(Effect.orDie) as Effect.Effect<TryTransitionProviderTerminalResult, unknown, never>
}

// ---------------------------------------------------------------------------
// Provider generation link — minimal durable fact `provider op -> genID`.
//
// Only a strictly durable owner may persist the link: the caller passes the
// ambient `KiloRetryBudget.Durable` binding's genID with its sessionID match
// already checked. Ownerless/legacy (memory or absent binding) never writes
// a link — the caller uses the plain provider path instead and no row is
// fabricated. No derivation from `assistant.parentID` or string parsing
// happens here; the genID is an explicit caller-supplied fact.
//
// The link lives in `session_operation.gen_id` (nullable, never part of the
// 9-field `FailureRecord`, never `result_snapshot`). A single provider
// in-flight insert carries the link in the same `BEGIN IMMEDIATE` row write,
// so insert + link are transaction-atomic. Terminal transitions (`put` and
// `tryTransitionProviderTerminal`) omit the column on UPDATE and therefore
// preserve the link with idempotent replay; they never emit a `generation`
// feed entry. Old databases without the column read as no link (existing
// crash behavior, no guess); a strict write without the column dies
// fail-closed instead of silently dropping the link.
// ---------------------------------------------------------------------------
function assertLinkGen(value: string) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("genID must be non-empty string")
  if (value.includes(":")) throw new TypeError("genID must not contain ':'")
}

function rowLink(row: unknown): string | null {
  const v = (row as Record<string, unknown> | null | undefined)?.["gen_id"]
  if (typeof v !== "string" || v.length === 0) return null
  return v
}

function hasLinkColumnTx(
  tx: DbOrTx,
): Effect.Effect<boolean, unknown, never> {
  return Effect.gen(function* () {
    const cols = yield* (tx as unknown as { all: (q: unknown) => Effect.Effect<{ name: string }[]> })
      .all(sql`SELECT name FROM pragma_table_info('session_operation')`)
      .pipe(
        Effect.orDie,
        Effect.catchDefect(() => Effect.succeed([] as { name: string }[])),
      )
    return cols.some((c) => c.name === "gen_id")
  })
}

export function getProviderGen(
  db: Database.Interface["db"],
  opId: string,
): Effect.Effect<string | null | undefined> {
  return Effect.gen(function* () {
    if (typeof opId !== "string" || opId.length === 0) yield* Effect.die(new TypeError("opId must be non-empty string"))
    const parsed = parseOpId(opId)
    if (parsed.kind !== "provider") yield* Effect.die(new TypeError(`provider gen opId kind must be provider, got ${parsed.kind}`))
    const row = yield* db
      .select()
      .from(SessionOperationTable)
      .where(eq(SessionOperationTable.op_id, opId))
      .get()
      .pipe(
        Effect.orDie,
        Effect.catchIf(
          (e) => typeof (e as Error)?.message === "string" && (e as Error).message.includes("gen_id"),
          () => Effect.succeed(undefined),
        ),
        Effect.catchDefect((d) =>
          typeof (d as Error)?.message === "string" && (d as Error).message.includes("gen_id")
            ? Effect.succeed(undefined)
            : Effect.fail(d),
        ),
      )
    if (!row) return undefined
    try {
      return rowLink(row)
    } catch {
      return null
    }
  }).pipe(Effect.orDie) as Effect.Effect<string | null | undefined>
}

function putProviderInFlightTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  record: FailureRecord,
  genID: string | null | undefined,
): Effect.Effect<{ record: FailureRecord; entry?: Changefeed.Entry; fresh: boolean }, unknown, never> {
  return Effect.gen(function* () {
    validateRecord(record)
    if (record.opKind !== "provider") yield* Effect.die(new TypeError(`provider in-flight opKind must be provider, got ${record.opKind}`))
    if (record.outcome !== "in-flight") yield* Effect.die(new TypeError(`provider in-flight outcome must be in-flight, got ${record.outcome}`))
    assertOpIdMatchesKind(record.opId, "provider")
    const link = genID ?? null
    if (link !== null) assertLinkGen(link)
    const sid = sessionID as unknown as string
    if (typeof sid !== "string" || sid.length === 0) yield* Effect.die(new TypeError("session_id must be non-empty"))
    const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    if (!session) yield* Effect.die(new Error(`session not found ${sid}`))
    const existingRow = yield* tx
      .select()
      .from(SessionOperationTable)
      .where(eq(SessionOperationTable.op_id, record.opId))
      .get()
      .pipe(Effect.orDie)
    if (existingRow) {
      const existing = existingRow as typeof SessionOperationTable.$inferSelect
      if ((existing.session_id as unknown as string) !== sid)
        yield* Effect.die(new Error(`cross-identity opId ${record.opId} already owned by session ${existing.session_id}`))
      if (existing.op_kind !== "provider")
        yield* Effect.die(new Error(`cross-kind conflict for ${record.opId}: existing ${existing.op_kind} vs provider`))
      let existingRecord: FailureRecord
      try {
        existingRecord = rowToValidatedRecord(existing)
      } catch (e) {
        yield* Effect.die(new TypeError(`invalid persisted operation row ${record.opId}: ${e instanceof Error ? e.message : String(e)}`))
        return undefined as unknown as { record: FailureRecord; fresh: boolean }
      }
      const normalized = normalizeRecord(record)
      if (!recordsEqual(existingRecord, normalized))
        yield* Effect.die(new Error(`conflicting update for ${record.opId}: ${existingRecord.outcome} -> ${normalized.outcome}`))
      const prev = rowLink(existing)
      if (link !== null && prev !== link)
        yield* Effect.die(new Error(`cross-generation conflict for ${record.opId}: existing ${prev ?? "null"} vs new ${link}`))
      // Idempotent replay carries no revision and no feed. A legacy null
      // link never backfills: the same 9-field record with a new link is a
      // different durable fact and fails closed above instead of fabricating
      // a link. True idempotence is exact record + exact link only.
      return { record: existingRecord, fresh: false as const }
    }
    if (link !== null) {
      const has = yield* hasLinkColumnTx(tx)
      if (!has) yield* Effect.die(new Error(`provider gen link column missing for ${record.opId}`))
      const owner = yield* tx
        .select()
        .from(SessionGenerationOwnerTable)
        .where(eq(SessionGenerationOwnerTable.gen_id, link))
        .get()
        .pipe(Effect.orDie)
      if (!owner) yield* Effect.die(new Error(`generation owner missing for ${link}`))
      const own = owner as typeof SessionGenerationOwnerTable.$inferSelect
      if ((own.session_id as unknown as string) !== sid)
        yield* Effect.die(new Error(`cross-identity gen ${link} already owned by session ${own.session_id}`))
      if (own.close_reason !== null && own.close_reason !== undefined)
        yield* Effect.die(new Error(`generation owner closed for ${link}`))
    }
    const normalized = normalizeRecord(record)
    const entry = yield* SessionRevision.advanceTx(sessionID, tx)
    const nextRev = entry.revision
    const has = link !== null ? true : yield* hasLinkColumnTx(tx)
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
        ...(has && link !== null ? { gen_id: link } : {}),
      } as unknown as typeof SessionOperationTable.$inferInsert)
      .run()
      .pipe(Effect.orDie)
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
      return undefined as unknown as { record: FailureRecord; entry: undefined; fresh: boolean }
    }
    if (link !== null && rowLink(inserted) !== link)
      yield* Effect.die(new Error(`provider gen link missing after insert ${normalized.opId}`))
    return { record: insertedRecord, entry, fresh: true as const }
  })
}

function putProviderInFlightIdempotentTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  record: FailureRecord,
  genID: string | null | undefined,
): Effect.Effect<FailureRecord, unknown, never> {
  return Effect.gen(function* () {
    const out = yield* putProviderInFlightTx(tx, sessionID, record, genID)
    return out.record
  })
}

export function putProviderInFlight(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  record: FailureRecord,
  genID?: string | null,
): Effect.Effect<FailureRecord> {
  return Effect.gen(function* () {
    validateRecord(record)
    if (record.opKind !== "provider") yield* Effect.die(new TypeError(`provider in-flight opKind must be provider`))
    if (record.outcome !== "in-flight") yield* Effect.die(new TypeError(`provider in-flight outcome must be in-flight`))
    if (genID !== undefined && genID !== null) assertLinkGen(genID)
    return yield* db.transaction((tx) => putProviderInFlightIdempotentTx(tx as DbOrTx, sessionID, record, genID ?? null), {
      behavior: "immediate",
    })
  }).pipe(Effect.orDie) as Effect.Effect<FailureRecord>
}

// ---------------------------------------------------------------------------
// Crash convergence — pre-bind fail-closed sweep for orphaned prompt +
// provider + cancelQueued in-flight rows
//
// A dead private runtime process (worker crash = the private `kilo-serve`
// process itself, not an independent provider scheduler/worker) leaves
// accepted `prompt:<messageId>`, `provider:<assistant>:<attempt>`, and
// `cancelQueued:<session>:<message>` rows in `in-flight` with no live owner
// (fibers, Runner epochs, and dispatch inflight maps die with the process).
// The fresh boot owns no volatile provider or generation state by
// construction, so converging each durable row releases the last ownership:
// each orphaned prompt row CASes once via `tryTransitionPromptTerminal` to
// terminal `abandoned` through the same `normalizeRecord` scrub/cap boundary
// and the same revision + `changed` + `generation` changefeed accounting as
// live terminalization, while each orphaned provider row CASes once via the
// provider-only `tryTransitionProviderTerminal` to terminal `abandoned`
// (`provider.abandoned`, fixed receipt-time message) with exactly one
// revision + one `changed` feed row — never a `generation` entry, never
// recovery fields. Each orphaned cancelQueued row CASes once via
// `tryTransitionCancelQueuedAmbiguous` to terminal `ambiguous`
// (`cancelQueued.ambiguous`, result unknown, `cancelled` NULL, never
// `succeeded` or a fabricated `cancelled` flag) with exactly one revision +
// one `changed` row — never a `generation` entry, never recovery fields,
// never a repeated `cancelOne`/`removeMessage` side effect. No new ledger,
// no scheduler, no retry, no replay: a converged row replays as terminal
// through the existing dispatch replay path and never restarts generation
// or triggers a provider retry. A concurrent live terminal win races safely
// — the loser observes `applied: false` and emits nothing (reported as
// `raced`, which is success, not failure).
//
// Fail-closed: a single invalid in-flight row (rowToValidatedRecord failure,
// missing session, cancelQueued opId/session/message binding mismatch or
// missing durable meta, DB error) never fabricates a terminal. Valid rows
// still CAS idempotently in row order, then the sweep fails with a typed
// `ConvergeOrphanedFailure` carrying only safe opIds + counts (no
// detail/stack/secret). The caller must refuse listener startup on that
// failure. `skipped` is retained for compatibility and is always `[]` on
// success; non-empty poison is never returned as success. Only
// `op_kind=prompt|provider|cancelQueued` rows are swept; other kinds stay
// untouched. Cross-process concurrency is serialized by the canonical DB
// exclusive lease (second process fails lease acquisition before the sweep).
// Terminal `time` is the runtime-owned convergence (receipt) time; the
// superseded accept (occurrence) time is not retained and no occurrence
// crash timestamp is fabricated, matching live terminalization which also
// stamps `Date.now()`.
// Disposition detail (occurrence/receipt pair, cleanup proof) and any retry
// budget remain out of scope: converged rows carry no disposition record
// and no scheduler follows the sweep.
//
// Callers must run this BEFORE `Server.listen` bind on the canonical
// `Database.Service` (same memoMap lease+marker gate as the listener), and
// must never open the listener when the sweep fails.
// ---------------------------------------------------------------------------
export const CRASH_CONVERGE_CODE = "prompt.abandoned"
export const CRASH_CONVERGE_MESSAGE = "prompt abandoned due to runtime restart"

export interface ConvergeOrphanedSummary {
  converged: string[]
  raced: string[]
  skipped: string[]
}

export class ConvergeOrphanedFailure extends Data.TaggedError("SessionOperation.ConvergeOrphanedFailure")<{
  opIds: string[]
  count: number
  converged: string[]
  raced: string[]
}> {}

interface ConvergeVerdict {
  tag: "converged" | "raced"
  opId: string
}

function safeOpId(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "unknown"
  const flat = raw.replace(/[\r\n\t]+/g, " ")
  return flat.length > 200 ? flat.slice(0, 200) : flat
}

function convergeOrphanedRow(
  db: Database.Interface["db"],
  row: typeof SessionOperationTable.$inferSelect,
  now: number,
): Effect.Effect<ConvergeVerdict, { opId: string }> {
  const rawOpId = safeOpId((row as { op_id?: unknown }).op_id)
  const fail = { opId: rawOpId }
  return Effect.gen(function* () {
    let rec: FailureRecord
    try {
      rec = rowToValidatedRecord(row)
    } catch {
      return yield* Effect.fail(fail)
    }
    if (rec.opKind !== "prompt" || rec.outcome !== "in-flight") return yield* Effect.fail(fail)
    const sid = row.session_id as unknown as SessionSchema.ID
    const session = yield* db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, sid))
      .get()
      .pipe(
        Effect.mapError(() => fail),
        Effect.catchDefect(() => Effect.fail(fail)),
      )
    if (!session) return yield* Effect.fail(fail)
    const opId = rec.opId
    const terminal = generationTerminal({
      opId,
      outcome: "abandoned",
      code: CRASH_CONVERGE_CODE,
      message: CRASH_CONVERGE_MESSAGE,
      time: now,
    })
    const res = yield* tryTransitionPromptTerminal(db, sid, terminal).pipe(
      Effect.mapError(() => fail),
      Effect.catchDefect(() => Effect.fail(fail)),
    )
    if (res.applied) return { tag: "converged" as const, opId }
    return { tag: "raced" as const, opId }
  })
}

export function convergeOrphanedPromptInFlight(
  db: Database.Interface["db"],
): Effect.Effect<ConvergeOrphanedSummary, ConvergeOrphanedFailure> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(SessionOperationTable)
      .where(and(eq(SessionOperationTable.op_kind, "prompt"), eq(SessionOperationTable.outcome, "in-flight")))
      .orderBy(asc(SessionOperationTable.op_id))
      .all()
      .pipe(
        Effect.mapError(
          () => new ConvergeOrphanedFailure({ opIds: [], count: 0, converged: [], raced: [] }),
        ),
        Effect.catchDefect(
          () => Effect.fail(new ConvergeOrphanedFailure({ opIds: [], count: 0, converged: [], raced: [] })),
        ),
      )
    const now = Date.now()
    const converged: string[] = []
    const raced: string[] = []
    const bad: string[] = []
    for (const raw of rows) {
      const row = raw as typeof SessionOperationTable.$inferSelect
      const out = yield* convergeOrphanedRow(db, row, now).pipe(
        Effect.map((v) => ({ ok: true as const, v })),
        Effect.catch((f: { opId: string }) => Effect.succeed({ ok: false as const, opId: f.opId })),
        Effect.catchDefect((d: unknown) =>
          Effect.succeed({ ok: false as const, opId: safeOpId((row as { op_id?: unknown }).op_id ?? d) }),
        ),
      )
      if (out.ok) {
        if (out.v.tag === "converged") converged.push(out.v.opId)
        else raced.push(out.v.opId)
      } else {
        bad.push(out.opId)
      }
    }
    if (bad.length > 0) {
      return yield* Effect.fail(
        new ConvergeOrphanedFailure({ opIds: [...bad], count: bad.length, converged: [...converged], raced: [...raced] }),
      )
    }
    return { converged, raced, skipped: [] }
  })
}

function convergeOrphanedProviderRow(
  db: Database.Interface["db"],
  row: typeof SessionOperationTable.$inferSelect,
  now: number,
): Effect.Effect<ConvergeVerdict, { opId: string }> {
  const rawOpId = safeOpId((row as { op_id?: unknown }).op_id)
  const fail = { opId: rawOpId }
  return Effect.gen(function* () {
    let rec: FailureRecord
    try {
      rec = rowToValidatedRecord(row)
    } catch {
      return yield* Effect.fail(fail)
    }
    if (rec.opKind !== "provider" || rec.outcome !== "in-flight") return yield* Effect.fail(fail)
    const sid = row.session_id as unknown as SessionSchema.ID
    const session = yield* db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, sid))
      .get()
      .pipe(
        Effect.mapError(() => fail),
        Effect.catchDefect(() => Effect.fail(fail)),
      )
    if (!session) return yield* Effect.fail(fail)
    const opId = rec.opId
    let terminal: FailureRecord
    try {
      terminal = providerTerminal({ opId, time: now })
    } catch {
      return yield* Effect.fail(fail)
    }
    const res = yield* tryTransitionProviderTerminal(db, sid, terminal).pipe(
      Effect.mapError(() => fail),
      Effect.catchDefect(() => Effect.fail(fail)),
    )
    if (res.applied) return { tag: "converged" as const, opId }
    return { tag: "raced" as const, opId }
  })
}

function runConvergeLoop(
  db: Database.Interface["db"],
  rows: (typeof SessionOperationTable.$inferSelect)[],
  now: number,
  converge: (db: Database.Interface["db"], row: typeof SessionOperationTable.$inferSelect, now: number) => Effect.Effect<ConvergeVerdict, { opId: string }>,
): Effect.Effect<ConvergeOrphanedSummary, ConvergeOrphanedFailure> {
  return Effect.gen(function* () {
    const converged: string[] = []
    const raced: string[] = []
    const bad: string[] = []
    const ordered = [...rows].sort((a, b) => (a.op_id < b.op_id ? -1 : a.op_id > b.op_id ? 1 : 0))
    for (const row of ordered) {
      const out = yield* converge(db, row, now).pipe(
        Effect.map((v) => ({ ok: true as const, v })),
        Effect.catch((f: { opId: string }) => Effect.succeed({ ok: false as const, opId: f.opId })),
        Effect.catchDefect((d: unknown) =>
          Effect.succeed({ ok: false as const, opId: safeOpId((row as { op_id?: unknown }).op_id ?? d) }),
        ),
      )
      if (out.ok) {
        if (out.v.tag === "converged") converged.push(out.v.opId)
        else raced.push(out.v.opId)
      } else {
        bad.push(out.opId)
      }
    }
    if (bad.length > 0) {
      return yield* Effect.fail(
        new ConvergeOrphanedFailure({ opIds: [...bad], count: bad.length, converged: [...converged], raced: [...raced] }),
      )
    }
    return { converged, raced, skipped: [] }
  })
}

export function convergeOrphanedProviderInFlight(
  db: Database.Interface["db"],
): Effect.Effect<ConvergeOrphanedSummary, ConvergeOrphanedFailure> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(SessionOperationTable)
      .where(and(eq(SessionOperationTable.op_kind, "provider"), eq(SessionOperationTable.outcome, "in-flight")))
      .orderBy(asc(SessionOperationTable.op_id))
      .all()
      .pipe(
        Effect.mapError(
          () => new ConvergeOrphanedFailure({ opIds: [], count: 0, converged: [], raced: [] }),
        ),
        Effect.catchDefect(
          () => Effect.fail(new ConvergeOrphanedFailure({ opIds: [], count: 0, converged: [], raced: [] })),
        ),
      )
    return yield* runConvergeLoop(db, rows as (typeof SessionOperationTable.$inferSelect)[], Date.now(), convergeOrphanedProviderRow)
  })
}

// ---------------------------------------------------------------------------
// CancelQueued crash terminal — fixed safe record for an orphaned
// cancelQueued `in-flight` row after private-runtime process death.
//
// The dispatch reserves durable `in-flight` before `cancelOne` and before
// the terminal write in separate transactions, so a crash between reserve
// and terminal leaves the queue side effect unknown: volatile dropped state
// and any `MessageRemoved` projector step died with the process. The result
// cannot be asserted `cancelled:true/false`, so the orphan converges to
// terminal `ambiguous` (result unknown), never `succeeded` and never a
// fabricated `cancelled` flag (`cancelled` stays NULL). No cancellation side
// effect repeats, no scheduler follows. Same-key idempotency replays the
// stored ambiguous row as an explicit dispatch `ambiguous` (`accepted:false`,
// never success); terminal replay never calls `cancelOne`/`removeMessage`
// and never advances revision.
// ---------------------------------------------------------------------------
export const CANCEL_QUEUED_CRASH_CONVERGE_CODE = "cancelQueued.ambiguous"
export const CANCEL_QUEUED_CRASH_CONVERGE_MESSAGE = "cancelQueued result unknown after runtime restart"

export function cancelQueuedAmbiguousTerminal(input: { opId: string; time?: number }): FailureRecord {
  if (typeof input.opId !== "string" || input.opId.length === 0) throw new TypeError("opId must be non-empty string")
  const parsed = parseOpId(input.opId)
  if (parsed.kind !== "cancelQueued") throw new TypeError(`cancelQueued terminal opId kind must be cancelQueued, got ${parsed.kind}`)
  const time = input.time ?? Date.now()
  if (typeof time !== "number" || !Number.isFinite(time)) throw new TypeError("time must be finite number")
  return normalizeRecord({
    opId: input.opId,
    opKind: "cancelQueued",
    outcome: "ambiguous",
    code: CANCEL_QUEUED_CRASH_CONVERGE_CODE,
    message: CANCEL_QUEUED_CRASH_CONVERGE_MESSAGE,
    time,
  })
}

function assertCancelQueuedCrashRecord(record: FailureRecord) {
  if (record.opKind !== "cancelQueued") throw new TypeError(`cancelQueued terminal opKind must be cancelQueued, got ${record.opKind}`)
  if (record.outcome !== "ambiguous") throw new TypeError(`cancelQueued terminal outcome must be ambiguous, got ${record.outcome}`)
  if (record.code !== CANCEL_QUEUED_CRASH_CONVERGE_CODE) throw new TypeError(`cancelQueued terminal code must be ${CANCEL_QUEUED_CRASH_CONVERGE_CODE}`)
  if (record.message !== CANCEL_QUEUED_CRASH_CONVERGE_MESSAGE) throw new TypeError(`cancelQueued terminal message mismatch`)
  if (record.cancel !== undefined) throw new TypeError(`cancelQueued terminal must not carry cancel`)
  if (record.detail !== undefined) throw new TypeError(`cancelQueued terminal must not carry detail`)
  if (record.stack !== undefined) throw new TypeError(`cancelQueued terminal must not carry stack`)
  assertOpIdMatchesKind(record.opId, "cancelQueued")
}

export type TryTransitionCancelQueuedAmbiguousResult =
  | { applied: true; record: CancelQueuedRecord; entry: Changefeed.Entry }
  | { applied: false; record: CancelQueuedRecord | undefined; entry?: undefined }

export function tryTransitionCancelQueuedAmbiguousTx(
  tx: DbOrTx,
  sessionID: SessionSchema.ID,
  record: FailureRecord,
): Effect.Effect<TryTransitionCancelQueuedAmbiguousResult, unknown, never> {
  return Effect.gen(function* () {
    try {
      validateRecord(record)
      assertCancelQueuedCrashRecord(record)
    } catch (e) {
      yield* Effect.die(e instanceof Error ? e : new TypeError(String(e)))
      return { applied: false as const, record: undefined, entry: undefined }
    }
    const sid = sessionID as unknown as string
    try {
      const parsed = parseOpId(record.opId)
      if (parsed.parts[0] !== sid) yield* Effect.die(new Error(`cross-identity opId ${record.opId} already owned by session ${sid}`))
    } catch (e) {
      yield* Effect.die(e instanceof Error ? e : new TypeError(String(e)))
      return { applied: false as const, record: undefined, entry: undefined }
    }
    const existingRow = yield* tx.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, record.opId)).get().pipe(Effect.orDie)
    if (!existingRow) {
      yield* Effect.die(new Error(`cancelQueued terminal requires existing in-flight row for ${record.opId}`))
      return { applied: false as const, record: undefined, entry: undefined }
    }
    const typed = existingRow as typeof SessionOperationTable.$inferSelect
    if ((typed.session_id as unknown as string) !== sid) {
      yield* Effect.die(new Error(`cross-identity opId ${record.opId} already owned by session ${typed.session_id}`))
      return { applied: false as const, record: undefined, entry: undefined }
    }
    let existing: FailureRecord
    try {
      existing = rowToValidatedRecord(typed)
    } catch (e) {
      yield* Effect.die(new TypeError(`invalid persisted operation row ${record.opId}: ${e instanceof Error ? e.message : String(e)}`))
      return { applied: false as const, record: undefined, entry: undefined }
    }
    if (existing.opKind !== "cancelQueued" || existing.outcome !== "in-flight")
      return { applied: false as const, record: rowToCancelQueuedRecord(typed) }
    try {
      const parsed = parseOpId(existing.opId)
      if (parsed.parts[0] !== sid) yield* Effect.die(new Error(`cross-identity opId ${record.opId} already owned by session ${typed.session_id}`))
      const msgPart = parsed.parts[1]!
      const storedMsg = (typed as unknown as { message_id?: string | null }).message_id
      if (typeof storedMsg !== "string" || storedMsg.length === 0 || storedMsg !== msgPart)
        yield* Effect.die(new Error(`cancelQueued opId/message binding mismatch for ${record.opId}`))
    } catch (e) {
      yield* Effect.die(e instanceof Error ? e : new TypeError(String(e)))
      return { applied: false as const, record: undefined, entry: undefined }
    }
    const entry = yield* SessionRevision.advanceTx(sessionID, tx)
    const nextRev = entry.revision
    yield* tx
      .update(SessionOperationTable)
      .set({
        outcome: record.outcome,
        code: record.code,
        message: record.message,
        time: record.time,
        revision: nextRev,
        cancelled: null,
      })
      .where(eq(SessionOperationTable.op_id, record.opId))
      .run()
      .pipe(Effect.orDie)
    const updated = yield* tx.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, record.opId)).get().pipe(Effect.orDie)
    if (!updated) yield* Effect.die(new Error(`operation row missing after update ${record.opId}`))
    return { applied: true as const, record: rowToCancelQueuedRecord(updated as typeof SessionOperationTable.$inferSelect), entry }
  })
}

export function tryTransitionCancelQueuedAmbiguous(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  record: FailureRecord,
): Effect.Effect<TryTransitionCancelQueuedAmbiguousResult, unknown, never> {
  return db
    .transaction((tx) => tryTransitionCancelQueuedAmbiguousTx(tx as DbOrTx, sessionID, record), { behavior: "immediate" })
    .pipe(Effect.orDie) as Effect.Effect<TryTransitionCancelQueuedAmbiguousResult, unknown, never>
}

function convergeOrphanedCancelQueuedRow(
  db: Database.Interface["db"],
  row: typeof SessionOperationTable.$inferSelect,
  now: number,
): Effect.Effect<ConvergeVerdict, { opId: string }> {
  const rawOpId = safeOpId((row as { op_id?: unknown }).op_id)
  const fail = { opId: rawOpId }
  return Effect.gen(function* () {
    let rec: FailureRecord
    try {
      rec = rowToValidatedRecord(row)
    } catch {
      return yield* Effect.fail(fail)
    }
    if (rec.opKind !== "cancelQueued" || rec.outcome !== "in-flight") return yield* Effect.fail(fail)
    const sid = row.session_id as unknown as SessionSchema.ID
    const sidStr = sid as unknown as string
    try {
      const parsed = parseOpId(rec.opId)
      if (parsed.kind !== "cancelQueued" || parsed.parts[0] !== sidStr) return yield* Effect.fail(fail)
      const msgPart = parsed.parts[1]!
      const storedMsg = (row as unknown as { message_id?: unknown }).message_id
      if (typeof storedMsg !== "string" || storedMsg.length === 0 || storedMsg !== msgPart) return yield* Effect.fail(fail)
      const dir = (row as unknown as { directory?: unknown }).directory
      if (typeof dir !== "string" || dir.length === 0) return yield* Effect.fail(fail)
      const hash = (row as unknown as { idempotency_hash?: unknown }).idempotency_hash
      if (typeof hash !== "string" || hash.length === 0) return yield* Effect.fail(fail)
    } catch {
      return yield* Effect.fail(fail)
    }
    const session = yield* db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, sid))
      .get()
      .pipe(
        Effect.mapError(() => fail),
        Effect.catchDefect(() => Effect.fail(fail)),
      )
    if (!session) return yield* Effect.fail(fail)
    const opId = rec.opId
    let terminal: FailureRecord
    try {
      terminal = cancelQueuedAmbiguousTerminal({ opId, time: now })
    } catch {
      return yield* Effect.fail(fail)
    }
    const res = yield* tryTransitionCancelQueuedAmbiguous(db, sid, terminal).pipe(
      Effect.mapError(() => fail),
      Effect.catchDefect(() => Effect.fail(fail)),
    )
    if (res.applied) return { tag: "converged" as const, opId }
    return { tag: "raced" as const, opId }
  })
}

export function convergeOrphanedCancelQueuedInFlight(
  db: Database.Interface["db"],
): Effect.Effect<ConvergeOrphanedSummary, ConvergeOrphanedFailure> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(SessionOperationTable)
      .where(and(eq(SessionOperationTable.op_kind, "cancelQueued"), eq(SessionOperationTable.outcome, "in-flight")))
      .orderBy(asc(SessionOperationTable.op_id))
      .all()
      .pipe(
        Effect.mapError(
          () => new ConvergeOrphanedFailure({ opIds: [], count: 0, converged: [], raced: [] }),
        ),
        Effect.catchDefect(
          () => Effect.fail(new ConvergeOrphanedFailure({ opIds: [], count: 0, converged: [], raced: [] })),
        ),
      )
    return yield* runConvergeLoop(db, rows as (typeof SessionOperationTable.$inferSelect)[], Date.now(), convergeOrphanedCancelQueuedRow)
  })
}

// ---------------------------------------------------------------------------
// Combined pre-bind sweep — prompt + provider + cancelQueued in-flight rows
// under one gate.
//
// Scans all three kinds on the same canonical DB (same lease+marker gate as
// the listener) in `op_id` order: prompt rows converge with revision +
// `changed` + `generation` and terminal recovery columns; provider rows
// converge with exactly one revision + one `changed` row, never
// `generation`, never recovery fields; cancelQueued rows converge to terminal
// `ambiguous` (result unknown, `cancelled` NULL, never `succeeded` or a
// fabricated `cancelled` flag) with exactly one revision + one `changed`
// row — never a `generation` entry, never recovery fields, never a repeated
// `cancelOne`/`removeMessage` side effect. Rerun after convergence is a
// no-op (0 new feeds).
// ---------------------------------------------------------------------------
export function convergeOrphanedInFlight(
  db: Database.Interface["db"],
): Effect.Effect<ConvergeOrphanedSummary, ConvergeOrphanedFailure> {
  return Effect.gen(function* () {
    const promptRows = yield* db
      .select()
      .from(SessionOperationTable)
      .where(and(eq(SessionOperationTable.op_kind, "prompt"), eq(SessionOperationTable.outcome, "in-flight")))
      .orderBy(asc(SessionOperationTable.op_id))
      .all()
      .pipe(
        Effect.mapError(
          () => new ConvergeOrphanedFailure({ opIds: [], count: 0, converged: [], raced: [] }),
        ),
        Effect.catchDefect(
          () => Effect.fail(new ConvergeOrphanedFailure({ opIds: [], count: 0, converged: [], raced: [] })),
        ),
      )
    const providerRows = yield* db
      .select()
      .from(SessionOperationTable)
      .where(and(eq(SessionOperationTable.op_kind, "provider"), eq(SessionOperationTable.outcome, "in-flight")))
      .orderBy(asc(SessionOperationTable.op_id))
      .all()
      .pipe(
        Effect.mapError(
          () => new ConvergeOrphanedFailure({ opIds: [], count: 0, converged: [], raced: [] }),
        ),
        Effect.catchDefect(
          () => Effect.fail(new ConvergeOrphanedFailure({ opIds: [], count: 0, converged: [], raced: [] })),
        ),
      )
    const cancelRows = yield* db
      .select()
      .from(SessionOperationTable)
      .where(and(eq(SessionOperationTable.op_kind, "cancelQueued"), eq(SessionOperationTable.outcome, "in-flight")))
      .orderBy(asc(SessionOperationTable.op_id))
      .all()
      .pipe(
        Effect.mapError(
          () => new ConvergeOrphanedFailure({ opIds: [], count: 0, converged: [], raced: [] }),
        ),
        Effect.catchDefect(
          () => Effect.fail(new ConvergeOrphanedFailure({ opIds: [], count: 0, converged: [], raced: [] })),
        ),
      )
    const now = Date.now()
    const rows = [...(promptRows as (typeof SessionOperationTable.$inferSelect)[]), ...(providerRows as (typeof SessionOperationTable.$inferSelect)[]), ...(cancelRows as (typeof SessionOperationTable.$inferSelect)[])]
    const converge = (
      inner: Database.Interface["db"],
      row: typeof SessionOperationTable.$inferSelect,
      at: number,
    ): Effect.Effect<ConvergeVerdict, { opId: string }> => {
      if ((row as { op_kind?: unknown }).op_kind === "provider") return convergeOrphanedProviderRow(inner, row, at)
      if ((row as { op_kind?: unknown }).op_kind === "cancelQueued") return convergeOrphanedCancelQueuedRow(inner, row, at)
      return convergeOrphanedRow(inner, row, at)
    }
    return yield* runConvergeLoop(db, rows, now, converge)
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
  if (isDirConflict(prev.meta.directory, next.directory)) return true
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
  if (isDirConflict(prev.meta.directory, next.directory)) return true
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
    const row = rows.find((r) => matchesRequestDir((r as unknown as { directory: string | null }).directory, directory))
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
    const row = rows.find((r) => matchesRequestDir((r as unknown as { directory: string | null }).directory, directory))
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
  if (isDirConflict(prev.meta.directory, next.directory)) return true
  if ((prev.meta.parentSessionId ?? null) !== (next.parentSessionId ?? null)) return true
  if ((prev.meta.configVersion ?? null) !== (next.configVersion ?? null)) return true
  if ((prev.meta.title ?? null) !== (next.title ?? null)) return true
  if ((prev.meta.parentID ?? null) !== (next.parentID ?? null)) return true
  if ((prev.meta.sandboxTokenHash ?? null) !== (next.sandboxTokenHash ?? null)) return true
  if ((prev.meta.sandboxSourceSessionId ?? null) !== (next.sandboxSourceSessionId ?? null)) return true
  const prevSrcDir = prev.meta.sandboxSourceDirectory ?? null
  const nextSrcDir = next.sandboxSourceDirectory ?? null
  if (prevSrcDir === null || nextSrcDir === null) {
    if (prevSrcDir !== nextSrcDir) return true
  } else if (isDirConflict(prevSrcDir, nextSrcDir)) return true
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
  if (isDirConflict(prev.meta.directory, next.directory)) return true
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
  if (isDirConflict(prev.meta.directory, next.directory)) return true
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
