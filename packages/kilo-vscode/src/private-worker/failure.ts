/**
 * R12 bounded foundation: private-runtime Failure/Outcome/Recovery (section 7.2).
 *
 * This is the sole runtime-owned normalization boundary converting provider/session/
 * tool/permission/worker/transport errors into Failure records; classification never
 * schedules recovery (no retry fields, no timers); redaction happens inside normalize
 * before any record is emitted, so no unredacted field can reach persistence or
 * projection; field tiers are exposure ceilings (durable < diagnostic < panel-visible,
 * monotonic); closed sets; no taxonomy freeze; persistence integration lands with R11
 * and consumes records produced here; envelope version ownership per R1/R9/R12.
 *
 * Minimal closed code set (no taxonomy freeze; unknown shapes yield a stable code,
 * never invent codes):
 * - transport: transport.eof | transport.frame | transport.protocol | transport.unknown
 * - provider: provider.auth | provider.timeout | provider.http | provider.unknown
 * - session: session.aborted | session.unknown
 * - tool: tool.failed | tool.unknown
 * - permission: permission.denied | permission.unknown
 * - worker: worker.crash | worker.unknown
 * - any domain with no error → unknown
 */

export const FAILURE_ENVELOPE_VERSION = "1.0"

export const OP_KINDS = ["prompt", "provider", "tool", "permission", "task"] as const
export type OpKind = (typeof OP_KINDS)[number]

export const OUTCOMES = ["succeeded", "failed", "ambiguous", "in-flight", "superseded", "abandoned"] as const
export type Outcome = (typeof OUTCOMES)[number]

export const CANCEL_SOURCES = ["user_stop", "steering", "timeout", "network_disconnect", "unknown"] as const
export type CancelSource = (typeof CANCEL_SOURCES)[number]

export const DOMAINS = ["provider", "session", "tool", "permission", "worker", "transport"] as const
export type Domain = (typeof DOMAINS)[number]

export const TIERS = ["durable", "diagnostic", "panel-visible"] as const
export type Tier = (typeof TIERS)[number]

export type Consumer = "persist" | "diagnose" | "project"

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

export interface NormalizeInput {
  opId: string
  opKind: OpKind
  domain: Domain
  outcome?: Outcome
  error?: unknown
  cancel?: CancelSource
  message?: string
  time: number
}

export interface PanelEnvelope {
  version: string
  payload: Record<string, unknown>
}

const opKindSet = new Set<string>(OP_KINDS as readonly string[])
const outcomeSet = new Set<string>(OUTCOMES as readonly string[])
const cancelSet = new Set<string>(CANCEL_SOURCES as readonly string[])
const domainSet = new Set<string>(DOMAINS as readonly string[])

const secretKey = /\b(api[_-]?key|apikey|token|authorization|password|secret|credential)\b/i
const valueScrub = /(api[_-]?key|apikey|token|authorization|password|secret|credential)\s*[:=]\s*([^\s,;"')\]}]+)/gi

function getStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== "object") return undefined
  const rec = err as Record<string, unknown>
  const s = rec["status"]
  if (typeof s === "number" && Number.isFinite(s)) return s
  const sc = rec["statusCode"]
  if (typeof sc === "number" && Number.isFinite(sc)) return sc
  return undefined
}

function getName(err: unknown): string {
  if (err instanceof Error) return err.name
  return ""
}

function getMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err === null || err === undefined) return ""
  return String(err)
}

function cap(s: string, max: number): string {
  if (s.length > max) return s.slice(0, max) + "…"
  return s
}

// eslint-disable-next-line complexity
export function classify(domain: Domain, err: unknown): string {
  if (err === null || err === undefined) return "unknown"
  const status = getStatus(err)
  const name = getName(err)
  const msg = getMessage(err)
  const hay = `${name} ${msg}`

  if (domain === "transport") {
    if (/eof|end of file|stdin closed/i.test(hay)) return "transport.eof"
    if (/frame/i.test(hay)) return "transport.frame"
    if (/json-rpc|protocol|invalid request/i.test(hay)) return "transport.protocol"
    return "transport.unknown"
  }
  if (domain === "provider") {
    if (status === 401 || status === 403) return "provider.auth"
    if (/timeout|timed out/i.test(hay)) return "provider.timeout"
    if (typeof status === "number" && ((status >= 400 && status < 500) || (status >= 500 && status < 600))) return "provider.http"
    return "provider.unknown"
  }
  if (domain === "session") {
    if (name === "AbortError" || /aborted/i.test(hay)) return "session.aborted"
    return "session.unknown"
  }
  if (domain === "tool") {
    if (err instanceof Error) return "tool.failed"
    return "tool.unknown"
  }
  if (domain === "permission") {
    if (/denied/i.test(hay)) return "permission.denied"
    return "permission.unknown"
  }
  if (domain === "worker") {
    if (/crash|exited|spawn/i.test(hay)) return "worker.crash"
    return "worker.unknown"
  }
  return "unknown"
}

export function isTerminal(outcome: Outcome): boolean {
  if (outcome === "in-flight") return false
  return true
}

export function redact(value: unknown): unknown {
  const seen = new WeakSet<object>()
  function inner(v: unknown, depth: number): unknown {
    if (depth > 8) return "[truncated]"
    if (v === null) return null
    if (typeof v === "string") {
      const scrubbed = v.replace(valueScrub, (_m: string, k: string) => `${k}=[redacted]`)
      return scrubbed
    }
    if (typeof v === "number" || typeof v === "boolean") return v
    if (typeof v !== "object") return v
    if (seen.has(v as object)) return "[truncated]"
    if (Array.isArray(v)) {
      seen.add(v as object)
      const out: unknown[] = []
      for (const e of v) out.push(inner(e, depth + 1))
      return out
    }
    seen.add(v as object)
    const rec = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(rec)) {
      if (secretKey.test(k)) {
        out[k] = "[redacted]"
        continue
      }
      out[k] = inner(rec[k], depth + 1)
    }
    return out
  }
  try {
    return inner(value, 0)
  } catch {
    return "[redacted]"
  }
}

// eslint-disable-next-line complexity
export function normalize(input: NormalizeInput): FailureRecord {
  if (typeof input.opId !== "string" || input.opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (!opKindSet.has(input.opKind as string)) throw new TypeError(`opKind must be one of ${OP_KINDS.join(", ")}`)
  if (!domainSet.has(input.domain as string)) throw new TypeError(`domain must be one of ${DOMAINS.join(", ")}`)
  if (input.cancel !== undefined && !cancelSet.has(input.cancel as string)) throw new TypeError(`cancel must be one of ${CANCEL_SOURCES.join(", ")}`)
  if (typeof input.time !== "number" || !Number.isFinite(input.time)) throw new TypeError("time must be finite number")
  if (input.outcome !== undefined && !outcomeSet.has(input.outcome as string)) throw new TypeError(`outcome must be one of ${OUTCOMES.join(", ")}`)
  if (input.message !== undefined && typeof input.message !== "string") throw new TypeError("message must be string")

  const hasError = input.error !== undefined && input.error !== null

  let outcome: Outcome
  let cancelField: { source: CancelSource } | undefined
  if (input.cancel !== undefined) {
    outcome = "abandoned"
    cancelField = { source: input.cancel }
  } else if (hasError) {
    outcome = "failed"
  } else {
    if (input.outcome === undefined) throw new TypeError("outcome is required when no cancel or error")
    outcome = input.outcome
  }

  let rawMsg: string
  if (input.message !== undefined) rawMsg = input.message
  else if (input.error instanceof Error) rawMsg = input.error.message
  else if (hasError) rawMsg = String(input.error)
  else rawMsg = ""

  const redactedMsg = String(redact(rawMsg) ?? "")
  const message = cap(redactedMsg, 500)

  const code = classify(input.domain, hasError ? input.error : null)

  let detail: string | undefined
  if (hasError) {
    let rawDetail: string
    if (input.error instanceof Error) {
      rawDetail = `${input.error.name}: ${input.error.message}`
      const status = getStatus(input.error)
      if (typeof status === "number" && Number.isFinite(status)) rawDetail += ` status=${status}`
    } else {
      rawDetail = String(input.error)
    }
    const redactedDetail = String(redact(rawDetail) ?? "")
    detail = cap(redactedDetail, 1000)
  }

  let stack: string | undefined
  if (input.error instanceof Error && typeof input.error.stack === "string" && input.error.stack.length > 0) {
    const redactedStack = String(redact(input.error.stack) ?? "")
    stack = cap(redactedStack, 2000)
  }

  const rec: FailureRecord = {
    opId: input.opId,
    opKind: input.opKind,
    outcome,
    code,
    message,
    time: input.time,
  }
  if (cancelField) rec.cancel = cancelField
  if (detail !== undefined) rec.detail = detail
  if (stack !== undefined) rec.stack = stack
  return rec
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

export function buildPanelEnvelope(record: FailureRecord): PanelEnvelope {
  return { version: FAILURE_ENVELOPE_VERSION, payload: select(record, "project") as Record<string, unknown> }
}
