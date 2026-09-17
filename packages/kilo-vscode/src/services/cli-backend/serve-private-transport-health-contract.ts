// Pure fd `transport/health` capability (bounded private-channel recovery).
// Request is strictly `{v:1,requestId,op:"transport/health",context:{},payload:{}}`
// with requestId-only identity: no directory/workspace/opId/idempotencyKey.
// Success is strictly `{ok:true}` with the normal status/outcome envelope.
// Server failures are only fixed `validation.failed` or `internal`,
// non-retryable. Extension may synthesize invalid/ambiguous/transportUnknown.
// No process info, epoch, capability list, state reads, InstanceRef, drain
// fence, network, secret, cache, persistence, mutation, or HTTP endpoint.

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function pathless(v: string): boolean {
  return !v.includes("/") && !v.includes("\\") && !v.includes("\0")
}

export interface TransportHealthContractRequest {
  v: 1
  requestId: string
  op: "transport/health"
  context: Record<string, never>
  payload: Record<string, never>
}

export function validateTransportHealthContractRequest(raw: unknown): TransportHealthContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must not carry path material")
  if (raw.op !== "transport/health") throw new Error("op must be transport/health")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  if (Object.keys(ctx).length !== 0) throw new Error("context must be empty object for transport/health")
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for transport/health")
  return raw as unknown as TransportHealthContractRequest
}

export interface TransportHealthData {
  ok: true
}

export function validateTransportHealthData(raw: unknown): TransportHealthData {
  if (!record(raw)) throw new Error("data must be object")
  const keys = Object.keys(raw)
  if (keys.length !== 1 || keys[0] !== "ok") throw new Error("unexpected data field")
  if (raw.ok !== true) throw new Error("ok must be true")
  return { ok: true }
}

export type TransportHealthResult =
  | {
      v: 1
      requestId: string
      op: "transport/health"
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: TransportHealthData
    }
  | {
      v: 1
      requestId: string
      op: "transport/health"
      status: "failed"
      outcome: { type: "failed"; time: number; failure: { code: string; message: string; retryable: boolean } }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean }
    }
  | {
      v: 1
      requestId: string
      op: "transport/health"
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export type TransportHealthWireOutcome =
  | { kind: "valid"; result: TransportHealthResult }
  | { kind: "invalid"; detail: string }

// Strict success check: only `succeeded` + `accepted:true` + exact `{ok:true}`
// counts as healthy. Failed/invalid/ambiguous/MethodNotFound keep quarantine.
export function isTransportHealthSuccess(raw: unknown, req: TransportHealthContractRequest): boolean {
  try {
    const result = validateTransportHealthResult(raw, req)
    if (result.status !== "succeeded" || result.accepted !== true) return false
    validateTransportHealthData((result as { data: unknown }).data)
    return true
  } catch {
    return false
  }
}

function normalizePrivateTransportHealthWire(
  raw: unknown,
  req: TransportHealthContractRequest,
): TransportHealthWireOutcome {
  try {
    const result = validateTransportHealthResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

const RESULT_SUCCEEDED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "failure"])
const RESULT_AMBIGUOUS = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "transportUnknown"])
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validateTransportHealthResult(
  raw: unknown,
  req: TransportHealthContractRequest,
): TransportHealthResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.op !== "transport/health") throw new Error("op mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous")
    throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!record(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number")
    throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const outRec = outcome as Record<string, unknown>
  if (status === "succeeded") {
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    validateTransportHealthData(rec.data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as TransportHealthResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error(`unexpected outcome field ${k}`)
    if (raw.accepted !== false) throw new Error("failed accepted must be false")
    return raw as unknown as TransportHealthResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error(`unexpected result field ${k}`)
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as TransportHealthResult
}
