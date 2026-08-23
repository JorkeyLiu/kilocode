/**
 * R14 bounded foundation: private-runtime worker-crash in-flight disposition (section 7.2).
 *
 * Pure, immutable, non-persistent module that records deterministic disposition
 * for an accepted in-flight operation at worker crash. Caller supplies occurrence
 * and receipt times and all facts. Provenance is explicit worker-crash, cleanup
 * is an explicit fact, receipt is distinct from occurrence, and no silent replay
 * is performed. Same crash event replay is idempotent, conflicting facts reject,
 * only in-flight -> terminal or intermediate transitions are allowed, terminal
 * exact replay is allowed, and invalid cross-kind, cross-identity or regressive
 * transitions reject. No new ledger, no store, no clock.
 */

export const DISPOSITION_VERSION = "1.0"

export const OP_KINDS = ["prompt", "provider", "tool", "permission", "task"] as const
export type OpKind = (typeof OP_KINDS)[number]

export const OUTCOMES = ["succeeded", "failed", "ambiguous", "in-flight", "superseded", "abandoned"] as const
export type Outcome = (typeof OUTCOMES)[number]

export const PROVENANCES = ["worker-crash"] as const
export type Provenance = (typeof PROVENANCES)[number]

export interface Cleanup {
  released: boolean
}

export interface DispositionRecord {
  version: string
  opId: string
  opKind: OpKind
  outcome: Outcome
  provenance: Provenance
  occurrenceTime: number
  receiptTime: number
  crashId: string
  cleanup: Cleanup
  replayed: false
}

export interface CreateInput {
  opId: string
  opKind: OpKind
  occurrenceTime: number
  receiptTime: number
  crashId: string
  cleanup?: Cleanup
  outcome?: Outcome
  provenance?: Provenance
}

export interface ApplyInput {
  opId: string
  opKind: OpKind
  outcome: Outcome
  occurrenceTime: number
  receiptTime: number
  crashId: string
  cleanup: Cleanup
  provenance?: Provenance
  replayed?: false
}

const opKindSet = new Set<string>(OP_KINDS as readonly string[])
const outcomeSet = new Set<string>(OUTCOMES as readonly string[])
const provenanceSet = new Set<string>(PROVENANCES as readonly string[])

function isFiniteNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v)
}

export function isTerminal(outcome: Outcome): boolean {
  return outcome !== "in-flight"
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

function validateCleanup(v: unknown): void {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new TypeError("cleanup must be object")
  const c = v as Record<string, unknown>
  if (typeof c["released"] !== "boolean") throw new TypeError("cleanup.released must be boolean")
  const extra = Object.keys(c).filter((k) => k !== "released")
  if (extra.length > 0) throw new TypeError(`cleanup has extra keys: ${extra.join(",")}`)
}

// eslint-disable-next-line complexity
export function validateRecord(rec: DispositionRecord): void {
  if (rec === null || typeof rec !== "object") throw new TypeError("record must be object")
  const r = rec as unknown as Record<string, unknown>
  if (r["version"] !== DISPOSITION_VERSION) throw new TypeError(`version must be ${DISPOSITION_VERSION}`)
  if (typeof r["opId"] !== "string" || (r["opId"] as string).length === 0) throw new TypeError("opId must be non-empty string")
  parseOpId(r["opId"] as string)
  if (typeof r["opKind"] !== "string" || !opKindSet.has(r["opKind"] as string)) throw new TypeError(`opKind must be one of ${OP_KINDS.join(", ")}`)
  const parsed = parseOpId(r["opId"] as string)
  if (parsed.kind !== r["opKind"]) throw new TypeError(`opId kind ${parsed.kind} does not match opKind ${r["opKind"]}`)
  if (typeof r["outcome"] !== "string" || !outcomeSet.has(r["outcome"] as string)) throw new TypeError(`outcome must be one of ${OUTCOMES.join(", ")}`)
  if (typeof r["provenance"] !== "string" || !provenanceSet.has(r["provenance"] as string)) throw new TypeError(`provenance must be one of ${PROVENANCES.join(", ")}`)
  if (!isFiniteNumber(r["occurrenceTime"])) throw new TypeError("occurrenceTime must be finite number")
  if (!isFiniteNumber(r["receiptTime"])) throw new TypeError("receiptTime must be finite number")
  if ((r["receiptTime"] as number) < (r["occurrenceTime"] as number)) throw new TypeError("receiptTime must be >= occurrenceTime")
  if (typeof r["crashId"] !== "string" || (r["crashId"] as string).length === 0) throw new TypeError("crashId must be non-empty string")
  if (!("cleanup" in r)) throw new TypeError("cleanup is required")
  validateCleanup(r["cleanup"])
  if (r["replayed"] !== false) throw new TypeError("replayed must be false")
  const allowed = new Set(["version", "opId", "opKind", "outcome", "provenance", "occurrenceTime", "receiptTime", "crashId", "cleanup", "replayed"])
  for (const k of Object.keys(r)) if (!allowed.has(k)) throw new TypeError(`record has unexpected field ${k}`)
}

function freezeCleanup(c: Cleanup): Cleanup {
  return Object.freeze({ released: c.released }) as Cleanup
}

function cloneRecord(rec: DispositionRecord): DispositionRecord {
  const out: DispositionRecord = {
    version: rec.version,
    opId: rec.opId,
    opKind: rec.opKind,
    outcome: rec.outcome,
    provenance: rec.provenance,
    occurrenceTime: rec.occurrenceTime,
    receiptTime: rec.receiptTime,
    crashId: rec.crashId,
    cleanup: freezeCleanup(rec.cleanup),
    replayed: false,
  }
  return Object.freeze(out) as DispositionRecord
}

function recordsEqual(a: DispositionRecord, b: DispositionRecord): boolean {
  if (a.version !== b.version) return false
  if (a.opId !== b.opId) return false
  if (a.opKind !== b.opKind) return false
  if (a.outcome !== b.outcome) return false
  if (a.provenance !== b.provenance) return false
  if (a.occurrenceTime !== b.occurrenceTime) return false
  if (a.receiptTime !== b.receiptTime) return false
  if (a.crashId !== b.crashId) return false
  if (a.cleanup.released !== b.cleanup.released) return false
  if (a.replayed !== b.replayed) return false
  return true
}

export function create(input: CreateInput): DispositionRecord {
  if (input === null || typeof input !== "object") throw new TypeError("input must be object")
  const r = input as unknown as Record<string, unknown>
  const opId = r["opId"]
  const opKind = r["opKind"]
  const occurrenceTime = r["occurrenceTime"]
  const receiptTime = r["receiptTime"]
  const crashId = r["crashId"]
  const cleanup = r["cleanup"]
  const outcome = r["outcome"]
  const provenance = r["provenance"]
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (typeof opKind !== "string" || !opKindSet.has(opKind as string)) throw new TypeError(`opKind must be one of ${OP_KINDS.join(", ")}`)
  parseOpId(opId)
  const parsed = parseOpId(opId)
  if (parsed.kind !== opKind) throw new TypeError(`opId kind ${parsed.kind} does not match opKind ${opKind}`)
  if (!isFiniteNumber(occurrenceTime)) throw new TypeError("occurrenceTime must be finite number")
  if (!isFiniteNumber(receiptTime)) throw new TypeError("receiptTime must be finite number")
  if ((receiptTime as number) < (occurrenceTime as number)) throw new TypeError("receiptTime must be >= occurrenceTime")
  if (typeof crashId !== "string" || crashId.length === 0) throw new TypeError("crashId must be non-empty string")
  if (outcome !== undefined) {
    if (typeof outcome !== "string" || !outcomeSet.has(outcome as string)) throw new TypeError(`outcome must be one of ${OUTCOMES.join(", ")}`)
    if ((outcome as string) !== "in-flight") throw new TypeError("create outcome must be in-flight: direct terminal creation not allowed")
  }
  if (provenance !== undefined) {
    if (typeof provenance !== "string" || !provenanceSet.has(provenance as string)) throw new TypeError(`provenance must be one of ${PROVENANCES.join(", ")}`)
    if ((provenance as string) !== "worker-crash") throw new TypeError("create provenance must be worker-crash")
  }
  const outOutcome: Outcome = "in-flight"
  const outProvenance: Provenance = "worker-crash"
  let outCleanup: Cleanup
  if (cleanup !== undefined) {
    validateCleanup(cleanup)
    outCleanup = { released: (cleanup as Cleanup).released }
  } else {
    outCleanup = { released: false }
  }
  const allowed = new Set(["opId", "opKind", "occurrenceTime", "receiptTime", "crashId", "cleanup", "outcome", "provenance"])
  for (const k of Object.keys(r)) if (!allowed.has(k)) throw new TypeError(`create has unexpected field ${k}`)
  const rec: DispositionRecord = {
    version: DISPOSITION_VERSION,
    opId,
    opKind: opKind as OpKind,
    outcome: outOutcome,
    provenance: outProvenance,
    occurrenceTime: occurrenceTime as number,
    receiptTime: receiptTime as number,
    crashId: crashId as string,
    cleanup: freezeCleanup(outCleanup),
    replayed: false,
  }
  return Object.freeze(rec) as DispositionRecord
}

// eslint-disable-next-line complexity
export function apply(record: DispositionRecord, input: ApplyInput): DispositionRecord {
  validateRecord(record)
  if (input === null || typeof input !== "object") throw new TypeError("apply input must be object")
  const r = input as unknown as Record<string, unknown>
  const opId = r["opId"]
  const opKind = r["opKind"]
  const outcome = r["outcome"]
  const occurrenceTime = r["occurrenceTime"]
  const receiptTime = r["receiptTime"]
  const crashId = r["crashId"]
  const cleanup = r["cleanup"]
  const provenance = r["provenance"]
  const replayed = r["replayed"]
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (typeof opKind !== "string" || !opKindSet.has(opKind as string)) throw new TypeError(`opKind must be one of ${OP_KINDS.join(", ")}`)
  parseOpId(opId as string)
  const parsed = parseOpId(opId as string)
  if (parsed.kind !== (opKind as string)) throw new TypeError(`opId kind ${parsed.kind} does not match opKind ${opKind as string}`)
  if (typeof outcome !== "string" || !outcomeSet.has(outcome as string)) throw new TypeError(`outcome must be one of ${OUTCOMES.join(", ")}`)
  if (!isFiniteNumber(occurrenceTime)) throw new TypeError("occurrenceTime must be finite number")
  if (!isFiniteNumber(receiptTime)) throw new TypeError("receiptTime must be finite number")
  if ((receiptTime as number) < (occurrenceTime as number)) throw new TypeError("receiptTime must be >= occurrenceTime")
  if (typeof crashId !== "string" || crashId.length === 0) throw new TypeError("crashId must be non-empty string")
  if (cleanup === undefined) throw new TypeError("cleanup is required")
  validateCleanup(cleanup)
  let prov: Provenance = "worker-crash"
  if (provenance !== undefined) {
    if (typeof provenance !== "string" || !provenanceSet.has(provenance as string)) throw new TypeError(`provenance must be one of ${PROVENANCES.join(", ")}`)
    prov = provenance as Provenance
  }
  if (replayed !== undefined && replayed !== false) throw new TypeError("replayed must be false")
  const allowed = new Set(["opId", "opKind", "outcome", "occurrenceTime", "receiptTime", "crashId", "cleanup", "provenance", "replayed"])
  for (const k of Object.keys(r)) if (!allowed.has(k)) throw new TypeError(`apply has unexpected field ${k}`)

  if (opId !== record.opId) throw new TypeError(`cross-identity opId mismatch: ${record.opId} vs ${opId as string}`)
  if (opKind !== record.opKind) throw new TypeError(`cross-kind opKind mismatch: ${record.opKind} vs ${opKind as string}`)
  if (prov !== record.provenance) throw new TypeError(`provenance mismatch: ${record.provenance} vs ${prov}`)
  if ((crashId as string) !== record.crashId) throw new TypeError(`crashId mismatch: ${record.crashId} vs ${crashId as string}`)

  const candidate: DispositionRecord = {
    version: DISPOSITION_VERSION,
    opId: opId as string,
    opKind: opKind as OpKind,
    outcome: outcome as Outcome,
    provenance: prov,
    occurrenceTime: occurrenceTime as number,
    receiptTime: receiptTime as number,
    crashId: crashId as string,
    cleanup: freezeCleanup(cleanup as Cleanup),
    replayed: false,
  }

  if (recordsEqual(record, candidate)) {
    if (Object.isFrozen(record) && Object.isFrozen(record.cleanup)) return record
    return cloneRecord(record)
  }

  if (isTerminal(record.outcome)) {
    throw new TypeError(`terminal outcome ${record.outcome} cannot transition to ${candidate.outcome}: exact replay only`)
  }

  if (record.outcome === "in-flight" && !isTerminal(candidate.outcome) && candidate.outcome !== "in-flight") {
    // should not happen because only in-flight is non-terminal
  }

  if (record.outcome === "in-flight" && isTerminal(candidate.outcome)) {
    return Object.freeze(candidate) as DispositionRecord
  }

  if (record.outcome === "in-flight" && candidate.outcome === "in-flight") {
    throw new TypeError(`conflicting in-flight disposition for ${record.opId}`)
  }

  throw new TypeError(`invalid transition ${record.outcome} -> ${candidate.outcome} for ${record.opId}`)
}
