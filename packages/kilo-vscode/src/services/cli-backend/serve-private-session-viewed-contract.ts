// Private-first `session/viewed` presence-write contract (production).
// Request is strictly `{v:1,requestId,op:"session/viewed",
// context:{directory,workspace?},payload:{viewer:{id,active,sequence},
// attached,visible}}` with no `opId`/`idempotencyKey` (request identity is
// `requestId` only). The semantic identity is `(viewer.id, sequence)` inside
// the payload, ordered monotonically by `KiloViewers.Service.update`; the
// transport `requestId` is correlation only and never creates a second
// semantic identity, so an ambiguous repeat is harmless and never refreshes
// TTL. `directory`/`workspace` are routing identity only and never reach the
// presence owner. Success data is exactly `{applied:true}`.
//
// Source facts:
// - Route: `POST /session/viewed` with `ViewedPayload`
//   (`viewer{id,active,sequence},attached,visible`) in
//   `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`
//   (`identifier: "session.viewed"`, success `Boolean`).
// - Handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
//   `viewed` calls the canonical process-global `KiloViewers.Service.update`.
// - Service: `packages/opencode/src/kilocode/presence/service.ts`
//   (`KiloViewers.Service.update` with per-viewer monotonic sequence, stale
//   drops with no TTL refresh) over `packages/opencode/src/kilocode/presence/policy.ts`
//   (`validateSnapshot`, caps 1000/199, ses-prefixed ids).
// - FD handler: `packages/opencode/src/kilocode/presence/session-viewed-private.ts`
//   (`sessionViewedPrivate` over the same owner, no `InstanceRef`/drain/fence/
//   journal/row/second layer) reached as capability `session/viewed`.
// - SDK fallback: v2 `client.session.viewed({viewer,attached,visible})`
//   remains the exactly-one fallback for unavailable/retryable/invalid/
//   ambiguous/transport/closed/timeout outcomes. Validated terminal
//   (`retryable === false`) closes with zero SDK.

import { isAbsolute } from "path"

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function clean(v: unknown, label: string): string {
  if (!present(v)) throw new Error(`${label} must be non-empty string`)
  const text = v as string
  if (text.includes("\0")) throw new Error(`${label} must not contain null bytes`)
  return text
}

function pathless(v: string): boolean {
  return !v.includes("/") && !v.includes("\\") && !v.includes("\0")
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_ATTACHED = 1000
const MAX_VISIBLE = 199
const MAX_SESSION_ID_LENGTH = 234

function checkSessionId(sid: unknown): string {
  if (typeof sid !== "string" || !sid.startsWith("ses") || sid.length > MAX_SESSION_ID_LENGTH || sid.includes("\0"))
    throw new Error("session id must be ses-prefixed string")
  return sid
}

function checkList(raw: unknown, cap: number, label: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${label} must be array`)
  if (raw.length > cap) throw new Error(`${label} too many`)
  return (raw as unknown[]).map((sid) => checkSessionId(sid))
}

export interface SessionViewedViewer {
  id: string
  active: boolean
  sequence: number
}

export interface SessionViewedPayload {
  viewer: SessionViewedViewer
  attached: string[]
  visible: string[]
}

export interface SessionViewedContractRequest {
  v: 1
  requestId: string
  op: "session/viewed"
  context: { directory: string; workspace?: string }
  payload: SessionViewedPayload
}

// eslint-disable-next-line complexity
export function validateSessionViewedContractRequest(raw: unknown): SessionViewedContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  clean(raw.requestId, "requestId")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must not carry path material")
  if (raw.op !== "session/viewed") throw new Error("op must be session/viewed")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  const ctxAllowed = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx)) {
    if (!ctxAllowed.has(k)) throw new Error(`unexpected context field ${k}`)
  }
  const dir = ctx.directory
  if (typeof dir !== "string" || dir.length === 0 || dir.includes("\0")) throw new Error("context.directory must be non-empty string")
  if (!isAbsolute(dir)) throw new Error("context.directory must be absolute path")
  if (ctx.workspace !== undefined) {
    if (!present(ctx.workspace) || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  const allowedPayload = new Set(["viewer", "attached", "visible"])
  for (const k of Object.keys(payload)) if (!allowedPayload.has(k)) throw new Error("unexpected payload field")
  const viewer = payload.viewer
  if (!record(viewer)) throw new Error("viewer must be object")
  const allowedViewer = new Set(["id", "active", "sequence"])
  for (const k of Object.keys(viewer)) if (!allowedViewer.has(k)) throw new Error("unexpected viewer field")
  if (typeof viewer.id !== "string" || !UUID_RE.test(viewer.id)) throw new Error("viewer id must be UUID")
  if (typeof viewer.active !== "boolean") throw new Error("viewer active must be boolean")
  const seq = viewer.sequence
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 || seq > Number.MAX_SAFE_INTEGER)
    throw new Error("viewer sequence must be safe non-negative integer")
  checkList(payload.attached, MAX_ATTACHED, "attached")
  checkList(payload.visible, MAX_VISIBLE, "visible")
  return raw as unknown as SessionViewedContractRequest
}

export interface SessionViewedFailure {
  code: string
  message: string
  retryable: boolean
}

export type SessionViewedResult =
  | {
      v: 1
      requestId: string
      op: "session/viewed"
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { applied: true }
    }
    | {
        v: 1
        requestId: string
        op: "session/viewed"
        status: "failed"
        outcome: { type: "failed"; time: number; failure: SessionViewedFailure }
        accepted: false
        failure: SessionViewedFailure
      }
  | {
      v: 1
      requestId: string
      op: "session/viewed"
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeSessionViewedAmbiguous(req: SessionViewedContractRequest, transportUnknown = true): SessionViewedResult {
  const out: SessionViewedResult = {
    v: 1,
    requestId: req.requestId,
    op: "session/viewed",
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type SessionViewedWireOutcome = { kind: "valid"; result: SessionViewedResult } | { kind: "invalid"; detail: string }

export class SessionViewedValidationError extends Error {
  readonly kind = "private-session-viewed-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "SessionViewedValidationError"
    this.detail = detail
  }
}

export function isSessionViewedValidationError(v: unknown): v is SessionViewedValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-session-viewed-validation"
}

export function normalizePrivateSessionViewedWire(raw: unknown, req: SessionViewedContractRequest): SessionViewedWireOutcome {
  try {
    const result = validateSessionViewedResult(raw, req)
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
const FAILURE_FIELDS = new Set(["code", "message", "retryable"])
const DATA_FIELDS = new Set(["applied"])

function checkFailure(raw: unknown): SessionViewedFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as SessionViewedFailure
}

// eslint-disable-next-line complexity
export function validateSessionViewedResult(raw: unknown, req: SessionViewedContractRequest): SessionViewedResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.op !== "session/viewed") throw new Error("op mismatch")
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
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    for (const k of Object.keys(data)) if (!DATA_FIELDS.has(k)) throw new Error(`unexpected data field ${k}`)
    if ((data as Record<string, unknown>).applied !== true) throw new Error("data.applied must be true")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as SessionViewedResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error(`unexpected outcome field ${k}`)
    if (raw.accepted !== false) throw new Error("failed accepted must be false")
    const failure = checkFailure(rec.failure)
    const outFailure = checkFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as SessionViewedResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error(`unexpected result field ${k}`)
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as SessionViewedResult
}

export function isSettledSessionViewedResult(result: unknown, req: SessionViewedContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed") return false
  try {
    const out = validateSessionViewedResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
