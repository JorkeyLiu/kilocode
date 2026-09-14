// Private-first `background-process/stop-session` cleanup contract (production).
// Request is strictly `{v:1,requestId,opId,op:"background-process/stop-session",
// idempotencyKey,context:{directory,sessionId},payload:{}}` with
// `opId === background-process-stop-session:<token>` (single opaque token,
// non-empty, no colon, no path material) and `idempotencyKey === opId`. The
// directory is routing/connection identity only (absolute path, canonical
// validation server-side); the session identity lives in `context.sessionId`
// (SessionID). The caller must reuse the same `sessionID` + `directory` for
// the private attempt and the exactly-one same-tuple SDK
// `backgroundProcess.stopSession` fallback.
//
// Source facts:
// - Private entry: `packages/opencode/src/kilocode/background-process-stop-session-private.ts`
//   (`background-process/stop-session` FD op, strict validation, existing
//   drain-control + `InstanceRef` lane, same `BackgroundProcess.stopSession`
//   as the HTTP route, redacted terminal failures, no journal/replay).
// - Consumer: `packages/kilo-vscode/src/kilo-provider/background-process-stop-session-privatefirst.ts`
//   is private-first: validated success and validated terminal
//   (`retryable === false`) close with zero SDK; unavailable/invalid/ambiguous/
//   retryable/transport/closed/timeout takes exactly one same-identity SDK
//   `backgroundProcess.stopSession` fallback. Stopping is idempotent, so an
//   ambiguous private outcome may safely repeat via the SDK fallback.

import { isAbsolute } from "path"

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}
function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function pathless(v: string): boolean {
  return !v.includes("/") && !v.includes("\\") && !v.includes("\0")
}

function isSessionId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && (v as string).startsWith("ses") && !(v as string).includes("\0")
}

export const BACKGROUND_STOP_SESSION_OP = "background-process/stop-session" as const

export function canonicalBackgroundStopSessionOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (!pathless(token)) throw new TypeError("token must not carry path material")
  return `background-process-stop-session:${token}`
}

export function parseBackgroundStopSessionOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "background-process-stop-session" || segs[1]!.length === 0)
    throw new TypeError("opId must be background-process-stop-session:<token> with nonempty colon-free token")
  const token = segs[1]!
  if (!pathless(token))
    throw new TypeError("opId must be background-process-stop-session:<token> with nonempty colon-free token")
  return { token }
}

export interface BackgroundStopSessionContractRequest {
  v: 1
  requestId: string
  opId: string
  op: typeof BACKGROUND_STOP_SESSION_OP
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
  }
  payload: Record<string, never>
}

function validateIds(raw: Record<string, unknown>): void {
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!present(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== BACKGROUND_STOP_SESSION_OP) throw new Error("op must be background-process/stop-session")
  if (!present(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId)
    throw new Error("idempotencyKey must equal opId for background stop-session contract")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must not carry path material")
  if (!pathless(raw.idempotencyKey as string)) throw new Error("idempotencyKey must not carry path material")
  const parsed = parseBackgroundStopSessionOpId(raw.opId as string)
  const idem = parseBackgroundStopSessionOpId(raw.idempotencyKey as string)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
}

function validateContext(raw: unknown): void {
  if (!record(raw)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "sessionId"])
  for (const k of Object.keys(raw)) if (!allowedCtx.has(k)) throw new Error("unexpected context field")
  if (typeof raw.directory !== "string" || raw.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  if (!isAbsolute(raw.directory) || (raw.directory as string).includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (!isSessionId((raw as Record<string, unknown>).sessionId)) throw new Error("context.sessionId must be SessionID")
}

function validatePayload(raw: unknown): void {
  if (!record(raw)) throw new Error("payload must be object")
  if (Object.keys(raw).length !== 0) throw new Error("payload must be empty object for background stop-session")
}

export function validateBackgroundStopSessionContractRequest(raw: unknown): BackgroundStopSessionContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  validateIds(raw)
  validateContext(raw.context)
  validatePayload(raw.payload)
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  return raw as unknown as BackgroundStopSessionContractRequest
}

export interface BackgroundStopSessionFailure {
  code: string
  message: string
  retryable: boolean
}

export type BackgroundStopSessionResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof BACKGROUND_STOP_SESSION_OP
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { stopped: true }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof BACKGROUND_STOP_SESSION_OP
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: BackgroundStopSessionFailure }
      accepted: boolean
      failure: BackgroundStopSessionFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof BACKGROUND_STOP_SESSION_OP
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeBackgroundStopSessionAmbiguous(
  req: BackgroundStopSessionContractRequest,
  transportUnknown = true,
): BackgroundStopSessionResult {
  const out: BackgroundStopSessionResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "background-process/stop-session",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

// Redacted failure shape ({code,message,retryable} only). Session, path,
// directory, and transport echo keys are rejected so responses cannot carry
// sensitive material.
const FAILURE_FORBIDDEN = new Set(["sessionId", "sessionID", "directory", "workspace", "token", "stack", "data"])

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

// Only CLI-authoritative terminal codes are accepted; anything else is
// invalid wire and fails closed to the SDK fallback.
const FAILURE_CODES = new Set([
  "validation.failed",
  "scope_mismatch",
  "internal",
  "InstanceUnavailableDuringConfigRebuild",
])

export function validateBackgroundStopSessionFailure(raw: unknown): BackgroundStopSessionFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (FAILURE_FORBIDDEN.has(k)) throw new Error("failure must not carry raw field")
  }
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!FAILURE_CODES.has(raw.code as string)) throw new Error("failure code is not CLI-authoritative")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as BackgroundStopSessionFailure
}

export type BackgroundStopSessionWireOutcome =
  | { kind: "valid"; result: BackgroundStopSessionResult }
  | { kind: "invalid"; detail: string }

const RESULT_SUCCEEDED = new Set([
  "v",
  "requestId",
  "opId",
  "op",
  "idempotencyKey",
  "status",
  "outcome",
  "accepted",
  "data",
])
const RESULT_FAILED = new Set([
  "v",
  "requestId",
  "opId",
  "op",
  "idempotencyKey",
  "status",
  "outcome",
  "accepted",
  "failure",
])
const RESULT_AMBIGUOUS = new Set([
  "v",
  "requestId",
  "opId",
  "op",
  "idempotencyKey",
  "status",
  "outcome",
  "accepted",
  "transportUnknown",
])
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validateBackgroundStopSessionResult(
  raw: unknown,
  req: BackgroundStopSessionContractRequest,
): BackgroundStopSessionResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== BACKGROUND_STOP_SESSION_OP) throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
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
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    for (const k of Object.keys(data)) if (k !== "stopped") throw new Error("unexpected data field")
    if (data.stopped !== true) throw new Error("succeeded data.stopped must be true")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as BackgroundStopSessionResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error("unexpected outcome field")
    const failure = validateBackgroundStopSessionFailure(rec.failure)
    const outFailure = validateBackgroundStopSessionFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as BackgroundStopSessionResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as BackgroundStopSessionResult
}

export function isSettledBackgroundStopSessionResult(
  result: unknown,
  req: BackgroundStopSessionContractRequest,
): boolean {
  if (!record(result)) return false
  const status = (result as { status?: unknown }).status
  if (status !== "succeeded" && status !== "failed") return false
  try {
    const out = validateBackgroundStopSessionResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
