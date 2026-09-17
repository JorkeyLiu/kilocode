export const VERSION = 1 as const
export const OP = "transport/health" as const
export const CAPABILITY = "transport/health" as const

export interface TransportHealthRequest {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  context: Record<string, never>
  payload: Record<string, never>
}

export interface TransportHealthFailure {
  code: string
  message: string
  retryable: boolean
}

export interface TransportHealthSucceeded {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { ok: true }
}

export interface TransportHealthFailed {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "failed"
  outcome: { type: "failed"; time: number; failure: TransportHealthFailure }
  accepted: false
  failure: TransportHealthFailure
}

export interface TransportHealthAmbiguous {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "ambiguous"
  outcome: { type: "ambiguous"; time: number }
  accepted: false
  transportUnknown?: boolean
}

export type TransportHealthResult = TransportHealthSucceeded | TransportHealthFailed | TransportHealthAmbiguous

export const VALIDATION_MESSAGE = "invalid transport-health request"
export const INTERNAL_MESSAGE = "internal error"

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function pathless(v: string): boolean {
  return !v.includes("/") && !v.includes("\\") && !v.includes("\0")
}

export function validateTransportHealthRequest(raw: unknown): TransportHealthRequest {
  if (!record(raw)) throw new Error("params must be object")
  if (raw.v !== VERSION) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must be non-empty string without path material")
  if (raw.op !== OP) throw new Error("op must be transport/health")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  if (Object.keys(ctx).length !== 0) throw new Error("context must be empty object for transport/health")
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for transport/health")
  const allowed = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected field")
  return raw as unknown as TransportHealthRequest
}

function sanitized(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !pathless(v)) return "unknown"
  return v
}

export function fallbackTransportHealthIds(raw: unknown): { requestId: string } {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId) }
}

export function failed(
  ids: { requestId: string },
  code: string,
  message: string,
): TransportHealthFailed {
  const failure = { code, message, retryable: false }
  return {
    v: VERSION,
    requestId: ids.requestId,
    op: OP,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure },
    accepted: false,
    failure,
  }
}

export function succeeded(req: TransportHealthRequest): TransportHealthSucceeded {
  return {
    v: VERSION,
    requestId: req.requestId,
    op: OP,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { ok: true },
  }
}

export function validateTransportHealthData(raw: unknown): { ok: true } {
  if (!record(raw)) throw new Error("data must be object")
  const keys = Object.keys(raw)
  if (keys.length !== 1 || keys[0] !== "ok") throw new Error("unexpected data field")
  if (raw.ok !== true) throw new Error("ok must be true")
  return { ok: true }
}
