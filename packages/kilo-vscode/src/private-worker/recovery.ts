/**
 * R13 bounded foundation: private-runtime Recovery accounting/coordination (section 7.2).
 *
 * Pure, immutable, non-persistent accounting module keyed by one R11 generation-path
 * opId and explicit R11 opKind. Scope is operation, owner is runtime. Caller supplies
 * nonnegative integer budget limit; this module records and enforces it. Every semantic
 * and every nested low-level SDK/provider/transport attempt is a visible charge against
 * that same operation budget; transport reconnect not executing the semantic operation
 * is not an attempt. Provenance is who requested the attempt (runtime/user/offline-restore)
 * and layer distinguishes semantic/sdk/provider/transport/task. R13 attempt time and
 * optional nextAt are runtime-owned occurrence times (never receipt times); no clock
 * or timer is embedded, callers pass them. Scheduling requires explicit replay safety;
 * if unsafe, termination is recorded and no nextAt survives. Classification never
 * schedules retry. Termination reasons are minimal accounting outcomes (budget-exhausted,
 * non-retryable, replay-unsafe, cancelled, completed); R14 worker-crash is excluded.
 * Pure module: zero production imports/wiring, no DB/migration/store/Map, no
 * notification, no retry algorithm/delay constants, no R11/R12 contract changes.
 */

export const RECOVERY_VERSION = "1.0"

export const OP_KINDS = ["prompt", "provider", "tool", "permission", "task"] as const
export type OpKind = (typeof OP_KINDS)[number]

export const OWNERS = ["runtime"] as const
export type Owner = (typeof OWNERS)[number]

export const SCOPES = ["operation"] as const
export type Scope = (typeof SCOPES)[number]

export const PROVENANCES = ["runtime", "user", "offline-restore"] as const
export type Provenance = (typeof PROVENANCES)[number]

export const LAYERS = ["semantic", "sdk", "provider", "transport", "task"] as const
export type Layer = (typeof LAYERS)[number]

export const TERMINATIONS = [
  "budget-exhausted",
  "non-retryable",
  "replay-unsafe",
  "cancelled",
  "completed",
] as const
export type Termination = (typeof TERMINATIONS)[number]

export interface RecoveryAttempt {
  id: string
  time: number
  provenance: Provenance
  layer: Layer
  nextAt?: number
}

export interface RecoveryRecord {
  version: string
  opId: string
  opKind: OpKind
  owner: Owner
  scope: Scope
  limit: number
  consumed: number
  attempts: readonly RecoveryAttempt[]
  terminated?: { reason: Termination; time: number }
  nextAt?: number
}

export interface RecoverySnapshot {
  version: string
  opId: string
  opKind: OpKind
  owner: Owner
  scope: Scope
  limit: number
  consumed: number
  remaining: number
  terminated?: { reason: Termination; time: number }
  nextAt?: number
  attempts: readonly RecoveryAttempt[]
}

export interface CreateInput {
  opId: string
  opKind: OpKind
  limit: number
}

export interface ChargeInput {
  id: string
  time: number
  provenance: Provenance
  layer: Layer
  nextAt?: number
  replaySafe?: boolean
}

export interface TerminateInput {
  reason: Termination
  time: number
}

const opKindSet = new Set<string>(OP_KINDS as readonly string[])
const ownerSet = new Set<string>(OWNERS as readonly string[])
const scopeSet = new Set<string>(SCOPES as readonly string[])
const provSet = new Set<string>(PROVENANCES as readonly string[])
const layerSet = new Set<string>(LAYERS as readonly string[])
const termSet = new Set<string>(TERMINATIONS as readonly string[])

function isFiniteNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v)
}

function assertNonNegInt(v: number, label: string): void {
  if (!Number.isInteger(v) || v < 0) throw new TypeError(`${label} must be nonnegative integer`)
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
    const s = rest[1]!
    if (!/^(0|[1-9][0-9]*)$/.test(s)) throw new TypeError(`provider attempt must be nonnegative integer: ${opId}`)
  } else if (kind === "tool") {
    if (rest.length !== 2) throw new TypeError(`tool opId must have 2 segments: ${opId}`)
  } else if (kind === "permission") {
    if (rest.length !== 1) throw new TypeError(`permission opId must have 1 segment: ${opId}`)
  } else if (kind === "task") {
    if (rest.length !== 1 && rest.length !== 2) throw new TypeError(`task opId must have 1 or 2 segments: ${opId}`)
  }
  return { kind: kind as OpKind, parts: rest }
}

function validateAttempt(at: RecoveryAttempt): void {
  if (typeof at.id !== "string" || at.id.length === 0) throw new TypeError("attempt id must be non-empty string")
  if (!isFiniteNumber(at.time)) throw new TypeError("attempt time must be finite number")
  if (!provSet.has(at.provenance as string)) throw new TypeError(`provenance must be one of ${PROVENANCES.join(", ")}`)
  if (!layerSet.has(at.layer as string)) throw new TypeError(`layer must be one of ${LAYERS.join(", ")}`)
  if (at.nextAt !== undefined) {
    if (!isFiniteNumber(at.nextAt)) throw new TypeError("nextAt must be finite number")
    if (at.nextAt < at.time) throw new TypeError("nextAt must be >= time")
  }
  const allowed = new Set(["id", "time", "provenance", "layer", "nextAt"])
  for (const k of Object.keys(at)) if (!allowed.has(k)) throw new TypeError(`attempt has unexpected field ${k}`)
}

// eslint-disable-next-line complexity
export function validateRecord(rec: RecoveryRecord): void {
  if (rec === null || typeof rec !== "object") throw new TypeError("record must be object")
  const r = rec as unknown as Record<string, unknown>
  if (r["version"] !== RECOVERY_VERSION) throw new TypeError(`version must be ${RECOVERY_VERSION}`)
  if (typeof r["opId"] !== "string" || (r["opId"] as string).length === 0) throw new TypeError("opId must be non-empty string")
  parseOpId(r["opId"] as string)
  if (typeof r["opKind"] !== "string" || !opKindSet.has(r["opKind"] as string)) throw new TypeError(`opKind must be one of ${OP_KINDS.join(", ")}`)
  const parsed = parseOpId(r["opId"] as string)
  if (parsed.kind !== r["opKind"]) throw new TypeError(`opId kind ${parsed.kind} does not match opKind ${r["opKind"]}`)
  if (typeof r["owner"] !== "string" || !ownerSet.has(r["owner"] as string)) throw new TypeError(`owner must be one of ${OWNERS.join(", ")}`)
  if (typeof r["scope"] !== "string" || !scopeSet.has(r["scope"] as string)) throw new TypeError(`scope must be one of ${SCOPES.join(", ")}`)
  if (!isFiniteNumber(r["limit"])) throw new TypeError("limit must be finite number")
  assertNonNegInt(r["limit"] as number, "limit")
  if (!isFiniteNumber(r["consumed"])) throw new TypeError("consumed must be finite number")
  assertNonNegInt(r["consumed"] as number, "consumed")
  if ((r["consumed"] as number) > (r["limit"] as number)) throw new TypeError("consumed must be <= limit")
  if (!Array.isArray(r["attempts"])) throw new TypeError("attempts must be array")
  const attempts = r["attempts"] as unknown[]
  const seen = new Set<string>()
  for (const a of attempts) {
    validateAttempt(a as RecoveryAttempt)
    const id = (a as RecoveryAttempt).id
    if (seen.has(id)) throw new TypeError(`duplicate attempt id ${id}`)
    seen.add(id)
  }
  if ((r["consumed"] as number) !== attempts.length) throw new TypeError("consumed must equal attempts length")
  if (r["terminated"] !== undefined) {
    const t = r["terminated"] as Record<string, unknown>
    if (t === null || typeof t !== "object" || Array.isArray(t)) throw new TypeError("terminated must be object")
    if (typeof t["reason"] !== "string" || !termSet.has(t["reason"] as string)) throw new TypeError(`terminated.reason must be one of ${TERMINATIONS.join(", ")}`)
    if (!isFiniteNumber(t["time"])) throw new TypeError("terminated.time must be finite number")
    const extra = Object.keys(t).filter((k) => k !== "reason" && k !== "time")
    if (extra.length > 0) throw new TypeError(`terminated has extra keys: ${extra.join(",")}`)
    if (r["nextAt"] !== undefined) throw new TypeError("nextAt must be absent when terminated")
  } else if (r["nextAt"] !== undefined) {
    if (!isFiniteNumber(r["nextAt"])) throw new TypeError("nextAt must be finite number")
    if (attempts.length === 0) throw new TypeError("nextAt requires at least one attempt")
    const last = attempts[attempts.length - 1] as RecoveryAttempt
    if (last.nextAt !== r["nextAt"]) throw new TypeError("record nextAt must equal last attempt nextAt")
  }
  if (r["nextAt"] !== undefined && r["terminated"] !== undefined) throw new TypeError("nextAt must be absent when terminated")
  const allowed = new Set(["version", "opId", "opKind", "owner", "scope", "limit", "consumed", "attempts", "terminated", "nextAt"])
  for (const k of Object.keys(r)) if (!allowed.has(k)) throw new TypeError(`record has unexpected field ${k}`)
}

function freezeAttempt(at: RecoveryAttempt): RecoveryAttempt {
  const copy: RecoveryAttempt = { id: at.id, time: at.time, provenance: at.provenance, layer: at.layer }
  if (at.nextAt !== undefined) copy.nextAt = at.nextAt
  return Object.freeze(copy) as RecoveryAttempt
}

function cloneRecord(rec: RecoveryRecord): RecoveryRecord {
  const out: RecoveryRecord = {
    version: rec.version,
    opId: rec.opId,
    opKind: rec.opKind,
    owner: rec.owner,
    scope: rec.scope,
    limit: rec.limit,
    consumed: rec.consumed,
    attempts: Object.freeze(rec.attempts.map((a) => freezeAttempt(a))) as readonly RecoveryAttempt[],
  }
  if (rec.terminated !== undefined) out.terminated = Object.freeze({ ...rec.terminated }) as { reason: Termination; time: number }
  if (rec.nextAt !== undefined) out.nextAt = rec.nextAt
  return Object.freeze(out) as RecoveryRecord
}

export function create(input: CreateInput): RecoveryRecord {
  if (input === null || typeof input !== "object") throw new TypeError("input must be object")
  const opId = (input as unknown as Record<string, unknown>)["opId"]
  const opKind = (input as unknown as Record<string, unknown>)["opKind"]
  const limit = (input as unknown as Record<string, unknown>)["limit"]
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (typeof opKind !== "string" || !opKindSet.has(opKind as string)) throw new TypeError(`opKind must be one of ${OP_KINDS.join(", ")}`)
  parseOpId(opId)
  const parsed = parseOpId(opId)
  if (parsed.kind !== opKind) throw new TypeError(`opId kind ${parsed.kind} does not match opKind ${opKind}`)
  if (!isFiniteNumber(limit)) throw new TypeError("limit must be finite number")
  assertNonNegInt(limit as number, "limit")
  const allowed = new Set(["opId", "opKind", "limit"])
  for (const k of Object.keys(input as unknown as Record<string, unknown>)) if (!allowed.has(k)) throw new TypeError(`create has unexpected field ${k}`)
  const rec: RecoveryRecord = {
    version: RECOVERY_VERSION,
    opId,
    opKind: opKind as OpKind,
    owner: "runtime",
    scope: "operation",
    limit: limit as number,
    consumed: 0,
    attempts: Object.freeze([]) as readonly RecoveryAttempt[],
  }
  return Object.freeze(rec) as RecoveryRecord
}

function attemptsEqual(a: RecoveryAttempt, b: RecoveryAttempt): boolean {
  if (a.id !== b.id) return false
  if (a.time !== b.time) return false
  if (a.provenance !== b.provenance) return false
  if (a.layer !== b.layer) return false
  if ((a.nextAt ?? undefined) !== (b.nextAt ?? undefined)) return false
  return true
}

// eslint-disable-next-line complexity
export function charge(record: RecoveryRecord, input: ChargeInput): RecoveryRecord {
  validateRecord(record)
  if (input === null || typeof input !== "object") throw new TypeError("charge input must be object")
  const rec = input as unknown as Record<string, unknown>
  const id = rec["id"]
  const time = rec["time"]
  const provenance = rec["provenance"]
  const layer = rec["layer"]
  const nextAt = rec["nextAt"]
  const replaySafe = rec["replaySafe"]
  if (typeof id !== "string" || id.length === 0) throw new TypeError("id must be non-empty string")
  if (!isFiniteNumber(time)) throw new TypeError("time must be finite number")
  if (typeof provenance !== "string" || !provSet.has(provenance as string)) throw new TypeError(`provenance must be one of ${PROVENANCES.join(", ")}`)
  if (typeof layer !== "string" || !layerSet.has(layer as string)) throw new TypeError(`layer must be one of ${LAYERS.join(", ")}`)
  if (nextAt !== undefined) {
    if (!isFiniteNumber(nextAt)) throw new TypeError("nextAt must be finite number")
    if ((nextAt as number) < (time as number)) throw new TypeError("nextAt must be >= time")
    if (replaySafe !== true) throw new TypeError("nextAt requires replaySafe === true")
  }
  if (replaySafe !== undefined && typeof replaySafe !== "boolean") throw new TypeError("replaySafe must be boolean")
  const allowed = new Set(["id", "time", "provenance", "layer", "nextAt", "replaySafe"])
  for (const k of Object.keys(rec)) if (!allowed.has(k)) throw new TypeError(`charge has unexpected field ${k}`)

  if (record.terminated !== undefined) throw new TypeError("cannot charge terminated record")

  const existing = record.attempts.find((a) => a.id === (id as string))
  const candidate: RecoveryAttempt = { id: id as string, time: time as number, provenance: provenance as Provenance, layer: layer as Layer }
  if (nextAt !== undefined) candidate.nextAt = nextAt as number

  if (existing !== undefined) {
    if (attemptsEqual(existing, candidate)) {
      if (Object.isFrozen(record) && Object.isFrozen(record.attempts) && record.attempts.every((a) => Object.isFrozen(a))) return record
      return cloneRecord(record)
    }
    throw new TypeError(`conflicting attempt id ${id as string}`)
  }

  if (record.consumed >= record.limit) throw new TypeError("budget exhausted")

  const attempt = freezeAttempt(candidate)
  const frozenBase = record.attempts.map((a) => freezeAttempt(a))
  const nextAttempts = Object.freeze([...frozenBase, attempt]) as readonly RecoveryAttempt[]
  const out: RecoveryRecord = {
    version: record.version,
    opId: record.opId,
    opKind: record.opKind,
    owner: record.owner,
    scope: record.scope,
    limit: record.limit,
    consumed: record.consumed + 1,
    attempts: nextAttempts,
  }
  if (candidate.nextAt !== undefined) out.nextAt = candidate.nextAt
  return Object.freeze(out) as RecoveryRecord
}

export function terminate(record: RecoveryRecord, input: TerminateInput): RecoveryRecord {
  validateRecord(record)
  if (input === null || typeof input !== "object") throw new TypeError("terminate input must be object")
  const rec = input as unknown as Record<string, unknown>
  const reason = rec["reason"]
  const time = rec["time"]
  if (typeof reason !== "string" || !termSet.has(reason as string)) throw new TypeError(`reason must be one of ${TERMINATIONS.join(", ")}`)
  if (!isFiniteNumber(time)) throw new TypeError("time must be finite number")
  const allowed = new Set(["reason", "time"])
  for (const k of Object.keys(rec)) if (!allowed.has(k)) throw new TypeError(`terminate has unexpected field ${k}`)

  if (record.terminated !== undefined) {
    if (record.terminated.reason === reason && record.terminated.time === (time as number)) {
      if (Object.isFrozen(record) && Object.isFrozen(record.attempts) && record.attempts.every((a) => Object.isFrozen(a)) && Object.isFrozen(record.terminated)) return record
      return cloneRecord(record)
    }
    throw new TypeError("already terminated with different reason/time")
  }

  const frozenAttempts = Object.freeze(record.attempts.map((a) => freezeAttempt(a))) as readonly RecoveryAttempt[]
  const out: RecoveryRecord = {
    version: record.version,
    opId: record.opId,
    opKind: record.opKind,
    owner: record.owner,
    scope: record.scope,
    limit: record.limit,
    consumed: record.consumed,
    attempts: frozenAttempts,
    terminated: Object.freeze({ reason: reason as Termination, time: time as number }) as { reason: Termination; time: number },
  }
  return Object.freeze(out) as RecoveryRecord
}

export function snapshot(record: RecoveryRecord): RecoverySnapshot {
  validateRecord(record)
  const snap: RecoverySnapshot = {
    version: record.version,
    opId: record.opId,
    opKind: record.opKind,
    owner: record.owner,
    scope: record.scope,
    limit: record.limit,
    consumed: record.consumed,
    remaining: record.limit - record.consumed,
    attempts: Object.freeze(record.attempts.map((a) => freezeAttempt(a))) as readonly RecoveryAttempt[],
  }
  if (record.terminated !== undefined) snap.terminated = Object.freeze({ ...record.terminated }) as { reason: Termination; time: number }
  if (record.nextAt !== undefined) snap.nextAt = record.nextAt
  return Object.freeze(snap) as RecoverySnapshot
}

export function isTerminated(record: RecoveryRecord): boolean {
  return record.terminated !== undefined
}

export function isBudgetExhausted(record: RecoveryRecord): boolean {
  return record.consumed >= record.limit
}
