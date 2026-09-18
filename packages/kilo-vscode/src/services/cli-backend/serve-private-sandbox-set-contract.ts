import { isAbsolute } from "path"

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

export const SANDBOX_SET_OP = "sandbox/set" as const

export function canonicalSandboxSetOpId(sessionId: string, token: string): string {
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId must be non-empty string")
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `sandbox-set:${sessionId}:${token}`
}

export function parseSandboxSetOpId(opId: string): { sessionId: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 3 || segs[0] !== "sandbox-set" || segs[1]!.length === 0 || segs[2]!.length === 0)
    throw new TypeError("opId must be sandbox-set:<sessionId>:<token>")
  return { sessionId: segs[1]!, token: segs[2]! }
}

export interface SandboxSetContractRequest {
  v: 1
  requestId: string
  opId: string
  op: typeof SANDBOX_SET_OP
  idempotencyKey: string
  context: { directory: string; sessionId: string }
  payload: { enabled: boolean; sessionId: string }
}

// eslint-disable-next-line complexity
export function validateSandboxSetContractRequest(raw: unknown): SandboxSetContractRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== SANDBOX_SET_OP) throw new Error("op must be sandbox/set")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for sandbox-set contract")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  for (const k of Object.keys(ctx as Record<string, unknown>))
    if (k !== "directory" && k !== "sessionId") throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (typeof ctx.sessionId !== "string" || !ctx.sessionId.startsWith("ses"))
    throw new Error("context.sessionId must be SessionID")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  for (const k of Object.keys(payload as Record<string, unknown>))
    if (k !== "enabled" && k !== "sessionId") throw new Error(`unexpected payload field ${k}`)
  if (typeof payload.enabled !== "boolean") throw new Error("payload.enabled must be boolean")
  if (typeof payload.sessionId !== "string" || !(payload.sessionId as string).startsWith("ses"))
    throw new Error("payload.sessionId must be SessionID")
  if (payload.sessionId !== ctx.sessionId) throw new Error("payload.sessionId must equal context.sessionId")
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"]).has(k))
      throw new Error(`unexpected field ${k}`)
  const parsed = parseSandboxSetOpId(raw.opId as string)
  const idem = parseSandboxSetOpId(raw.idempotencyKey as string)
  if (idem.token !== parsed.token || idem.sessionId !== parsed.sessionId)
    throw new Error("idempotencyKey token must equal opId token")
  if (parsed.sessionId !== (ctx.sessionId as string)) throw new Error("opId sessionId must equal context.sessionId")
  return raw as unknown as SandboxSetContractRequest
}

export interface SandboxSetStatus {
  directory: string
  enabled: boolean
  available: boolean
  reason?: string
  version: number
}

const STATUS_FIELDS = new Set(["directory", "enabled", "available", "reason", "version"])

export function validateSandboxSetStatus(raw: unknown): SandboxSetStatus {
  if (!isRecord(raw)) throw new Error("sandbox-set status must be object")
  for (const k of Object.keys(raw)) if (!STATUS_FIELDS.has(k)) throw new Error(`unexpected status field ${k}`)
  if (typeof raw.directory !== "string" || typeof raw.enabled !== "boolean" || typeof raw.available !== "boolean")
    throw new Error("sandbox-set status invalid")
  if (raw.reason !== undefined && typeof raw.reason !== "string") throw new Error("sandbox-set status reason invalid")
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 0)
    throw new Error("sandbox-set status version invalid")
  return raw as unknown as SandboxSetStatus
}

export interface SandboxSetFailure {
  code: string
  message: string
  retryable: boolean
}

const FAILURE_FORBIDDEN = new Set(["session", "sessionId", "prompt", "tool", "error", "raw", "output", "detail", "token", "url", "credential"])
const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateSandboxSetFailure(raw: unknown): SandboxSetFailure {
  if (!isRecord(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (FAILURE_FORBIDDEN.has(k)) throw new Error(`failure must not carry ${k}`)
  }
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error(`unexpected failure field ${k}`)
  if (!isNonEmpty(raw.code)) throw new Error("failure code must be non-empty string")
  if (!isNonEmpty(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as SandboxSetFailure
}

export type SandboxSetResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof SANDBOX_SET_OP
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { status: SandboxSetStatus }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof SANDBOX_SET_OP
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: SandboxSetFailure }
      accepted: boolean
      failure: SandboxSetFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof SANDBOX_SET_OP
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeSandboxSetAmbiguous(req: SandboxSetContractRequest, transportUnknown = true): SandboxSetResult {
  const out: SandboxSetResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type SandboxSetWireOutcome = { kind: "valid"; result: SandboxSetResult } | { kind: "invalid"; detail: string }

const RESULT_SUCCEEDED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "failure"])
const RESULT_AMBIGUOUS = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "transportUnknown"])
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])

function assertAllowed(rec: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const k of Object.keys(rec)) if (!allowed.has(k)) throw new Error(`unexpected ${label} field ${k}`)
}

// eslint-disable-next-line complexity
export function validateSandboxSetResult(raw: unknown, req: SandboxSetContractRequest): SandboxSetResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== req.op) throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous") throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!isRecord(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number") throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const outRec = outcome as Record<string, unknown>
  if (status === "succeeded") {
    assertAllowed(rec, RESULT_SUCCEEDED, "result")
    assertAllowed(outRec, OUTCOME_PLAIN, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    for (const k of Object.keys(data as Record<string, unknown>)) if (k !== "status") throw new Error(`unexpected data field ${k}`)
    validateSandboxSetStatus((data as Record<string, unknown>).status)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as SandboxSetResult
  }
  if (status === "failed") {
    assertAllowed(rec, RESULT_FAILED, "result")
    assertAllowed(outRec, OUTCOME_FAILED, "outcome")
    const failure = validateSandboxSetFailure(rec.failure)
    const outFailure = validateSandboxSetFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as SandboxSetResult
  }
  assertAllowed(rec, RESULT_AMBIGUOUS, "result")
  assertAllowed(outRec, OUTCOME_PLAIN, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean") throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as SandboxSetResult
}

export function isSettledSandboxSetResult(result: unknown, req: SandboxSetContractRequest): boolean {
  if (!isRecord(result)) return false
  const status = (result as { status?: unknown }).status
  if (status !== "succeeded" && status !== "failed") return false
  try {
    const out = validateSandboxSetResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
