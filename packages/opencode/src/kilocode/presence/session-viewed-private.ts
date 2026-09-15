import { Effect } from "effect"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import { KiloViewers } from "@/kilocode/presence/service"
import { validateSnapshot } from "@/kilocode/presence/policy"

export const VERSION = 1 as const
export const OP = "session/viewed" as const
export const CAPABILITY = "session/viewed" as const

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

export interface SessionViewedRequest {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  context: {
    directory: string
    workspace?: string
  }
  payload: SessionViewedPayload
}

export interface SessionViewedFailure {
  code: string
  message: string
  retryable: boolean
}

export interface SessionViewedSucceeded {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { applied: true }
}

export interface SessionViewedFailed {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "failed"
  outcome: { type: "failed"; time: number; failure: SessionViewedFailure }
  accepted: false
  failure: SessionViewedFailure
}

export interface SessionViewedAmbiguous {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "ambiguous"
  outcome: { type: "ambiguous"; time: number }
  accepted: false
  transportUnknown?: boolean
}

export type SessionViewedResult = SessionViewedSucceeded | SessionViewedFailed | SessionViewedAmbiguous

export const VALIDATION_MESSAGE = "invalid session-viewed request"
export const INTERNAL_MESSAGE = "internal error"

// Request identity is `requestId` only. There is no `opId`/`idempotencyKey` on
// this op by design: the semantic identity of a viewed emission is
// `(viewer.id, viewer.sequence)` inside the payload, ordered monotonically by
// `KiloViewers.Service.update`. `requestId` is transport correlation only and
// is never used for dedup or ordering, so a retry/duplicate transport can
// never create a second semantic identity. An ambiguous repeat is harmless:
// the server drops equal/lower sequences with no TTL refresh.

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
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

export function validateSessionViewedRequest(raw: unknown): SessionViewedRequest {
  if (!record(raw)) throw new Error("params must be object")
  if (raw.v !== VERSION) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must be non-empty string without path material")
  if (raw.op !== OP) throw new Error("op must be session/viewed")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error("unexpected context field")
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  if (ctx.workspace !== undefined) {
    if (typeof ctx.workspace !== "string" || ctx.workspace.length === 0 || (ctx.workspace as string).includes("\0"))
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
  const attached = checkList(payload.attached, MAX_ATTACHED, "attached")
  const visible = checkList(payload.visible, MAX_VISIBLE, "visible")
  const allowedRoot = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  // Single-source business verdict: the canonical policy owns dedupe/cap/order
  // semantics. Strict shape above guarantees the policy sees only well-formed
  // input; its rejection maps to the same terminal validation failure.
  const verdict = validateSnapshot({ viewer: { id: viewer.id as string, active: viewer.active as boolean, sequence: seq as number }, attached, visible })
  if (!verdict.ok) throw new Error("viewer snapshot rejected")
  return {
    v: VERSION,
    requestId: raw.requestId as string,
    op: OP,
    context: ctx.workspace === undefined ? { directory: ctx.directory as string } : { directory: ctx.directory as string, workspace: ctx.workspace as string },
    payload: {
      viewer: { id: viewer.id as string, active: viewer.active as boolean, sequence: seq as number },
      attached,
      visible,
    },
  }
}

type Ids = { requestId: string }

function sanitized(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !pathless(v)) return "unknown"
  return v
}

export function fallbackSessionViewedIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId) }
}

export function safeSessionViewedIds(req: { requestId: string }): Ids {
  return { requestId: sanitized(req.requestId) }
}

export function failed(ids: Ids, code: string, message: string, retryable: boolean): SessionViewedFailed {
  const failure = { code, message, retryable }
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

export function succeeded(req: SessionViewedRequest): SessionViewedSucceeded {
  return {
    v: VERSION,
    requestId: req.requestId,
    op: OP,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { applied: true },
  }
}

export function ambiguous(req: SessionViewedRequest, transportUnknown = true): SessionViewedAmbiguous {
  const out: SessionViewedAmbiguous = {
    v: VERSION,
    requestId: req.requestId,
    op: OP,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) out.transportUnknown = true
  return out
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

export function validateSessionViewedResult(raw: unknown, req: SessionViewedRequest): SessionViewedResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== VERSION) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.op !== OP) throw new Error("op mismatch")
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
  const out = outcome as Record<string, unknown>
  if (status === "succeeded") {
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(out)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    for (const k of Object.keys(data)) if (!DATA_FIELDS.has(k)) throw new Error("unexpected data field")
    if ((data as Record<string, unknown>).applied !== true) throw new Error("data.applied must be true")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (out.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as SessionViewedSucceeded
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(out)) if (!OUTCOME_FAILED.has(k)) throw new Error("unexpected outcome field")
    if (raw.accepted !== false) throw new Error("failed accepted must be false")
    const failure = checkFailure(rec.failure)
    const outFailure = checkFailure(out.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as SessionViewedFailed
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(out)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (out.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as SessionViewedAmbiguous
}

export function isSettledSessionViewedResult(result: unknown, req: SessionViewedRequest): boolean {
  if (!record(result)) return false
  const status = (result as { status?: unknown }).status
  if (status !== "succeeded" && status !== "failed") return false
  try {
    const out = validateSessionViewedResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}

// Private `session/viewed`: process-global idempotent full-snapshot write to
// the canonical `KiloViewers.Service.update` owner (same owner as
// `POST /session/viewed`). No `InstanceRef`, no drain-control lane, no config
// fence, no journal, no persistent row, no second KiloViewers layer.
// `directory`/`workspace` are routing identity only and never reach the
// presence owner. Repeating the same `(viewer.id, sequence)` is harmless: the
// owner drops equal/lower sequences with no TTL refresh.
export const sessionViewedPrivate = Effect.fn("SessionViewedPrivate.write")(function* (raw: unknown) {
  let req: SessionViewedRequest
  try {
    req = validateSessionViewedRequest(raw)
  } catch {
    return failed(fallbackSessionViewedIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeSessionViewedIds(req)
  try {
    canonicalDirectory(req.context.directory)
  } catch {
    return failed(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  const snapshot = {
    viewer: { id: req.payload.viewer.id, active: req.payload.viewer.active, sequence: req.payload.viewer.sequence },
    attached: [...req.payload.attached],
    visible: [...req.payload.visible],
  }
  const applied = yield* KiloViewers.Service.pipe(
    Effect.flatMap((svc) => svc.update(snapshot)),
    Effect.map(() => ({ tag: "ok" as const })),
    Effect.catch(() => Effect.succeed({ tag: "fail" as const })),
    Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const })),
  )
  if (applied.tag === "ok") return succeeded(req)
  // Owner internal error/defect is unresolved (`retryable: true`), never a
  // validated terminal: the caller must take exactly one same-snapshot SDK
  // fallback rather than close.
  return failed(safe, "internal", INTERNAL_MESSAGE, true)
})
