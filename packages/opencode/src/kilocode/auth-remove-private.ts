import { Effect } from "effect"
import { Auth } from "@/auth"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import { invalidateAfterProviderAuthChange } from "@/kilocode/server/provider-auth-lifecycle"

export const VERSION = 1 as const
export const OP = "auth/remove" as const
export const CAPABILITY = "auth/remove" as const

export interface AuthRemoveRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: {
    providerID: string
  }
}

export interface AuthRemoveFailure {
  code: string
  message: string
  retryable: boolean
}

export interface AuthRemoveSucceeded {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { removed: true }
}

export interface AuthRemoveFailed {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  status: "failed"
  outcome: { type: "failed"; time: number; failure: AuthRemoveFailure }
  accepted: false
  failure: AuthRemoveFailure
}

export type AuthRemoveResult = AuthRemoveSucceeded | AuthRemoveFailed

export const VALIDATION_MESSAGE = "invalid auth-remove request"
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

export function canonicalAuthRemoveOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new Error("token must be non-empty string")
  if (token.includes(":")) throw new Error("token must not contain ':'")
  if (!pathless(token)) throw new Error("token must not carry path material")
  return `auth-remove:${token}`
}

export function parseAuthRemoveOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new Error("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "auth-remove" || segs[1]!.length === 0)
    throw new Error("opId must be auth-remove:<token> with nonempty colon-free token")
  const token = segs[1]!
  if (!pathless(token)) throw new Error("opId must be auth-remove:<token> with nonempty colon-free token")
  return { token }
}

export function validateAuthRemoveRequest(raw: unknown): AuthRemoveRequest {
  if (!record(raw)) throw new Error("params must be object")
  if (raw.v !== VERSION) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!present(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== OP) throw new Error("op must be auth/remove")
  if (!present(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for auth-remove")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must be non-empty string without path material")
  if (!pathless(raw.idempotencyKey as string))
    throw new Error("idempotencyKey must be non-empty string without path material")
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
  const allowedPayload = new Set(["providerID"])
  for (const k of Object.keys(payload)) if (!allowedPayload.has(k)) throw new Error("unexpected payload field")
  const providerID = (payload as Record<string, unknown>).providerID
  if (typeof providerID !== "string" || providerID.length === 0)
    throw new Error("payload.providerID must be non-empty string")
  if (providerID.includes("\0")) throw new Error("payload.providerID must not contain null bytes")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  const parsed = parseAuthRemoveOpId(raw.opId as string)
  const idem = parseAuthRemoveOpId(raw.idempotencyKey as string)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as AuthRemoveRequest
}

type Ids = { requestId: string; opId: string; idempotencyKey: string }

function sanitized(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !pathless(v)) return "unknown"
  return v
}

export function fallbackAuthRemoveIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId), opId: sanitized(o.opId), idempotencyKey: sanitized(o.idempotencyKey) }
}

export function safeAuthRemoveIds(req: { requestId: string; opId: string; idempotencyKey: string }): Ids {
  return { requestId: sanitized(req.requestId), opId: sanitized(req.opId), idempotencyKey: sanitized(req.idempotencyKey) }
}

export function failed(ids: Ids, code: string, message: string, retryable: boolean): AuthRemoveFailed {
  const failure = { code, message, retryable }
  return {
    v: VERSION,
    requestId: ids.requestId,
    opId: ids.opId,
    op: OP,
    idempotencyKey: ids.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure },
    accepted: false,
    failure,
  }
}

export function succeeded(req: AuthRemoveRequest): AuthRemoveSucceeded {
  return {
    v: VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: OP,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { removed: true },
  }
}

const RESULT_SUCCEEDED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "failure"])
const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

function checkFailure(raw: unknown): AuthRemoveFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as AuthRemoveFailure
}

export function validateAuthRemoveResult(raw: unknown, req: AuthRemoveRequest): AuthRemoveResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== VERSION) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== OP) throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed") throw new Error("status must be succeeded/failed")
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
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    for (const k of Object.keys(data)) if (k !== "removed") throw new Error("unexpected data field")
    if (data.removed !== true) throw new Error("succeeded data.removed must be true")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (out.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as AuthRemoveSucceeded
  }
  for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error("unexpected result field")
  const failure = checkFailure(rec.failure)
  const outFailure = checkFailure(out.failure)
  if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
  if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
  if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
  if (rec.data !== undefined) throw new Error("failed must not have data")
  return raw as unknown as AuthRemoveFailed
}

// Private `auth/remove`: the same global cold mutation as the HTTP
// `auth.remove` route — `invalidateAfterProviderAuthChange(providerID,
// Auth.remove(providerID).pipe(orDie))` with no `cleanupDisabled`. The
// request directory is routing/connection identity only (canonical
// validation, never an auth scope): there is no directory scope mismatch,
// no `acquireDrainControl`, no `InstanceRef` lane, no journal/replay/store,
// and no new fence. `Auth.remove` is idempotent, so an ambiguous transport
// outcome may safely repeat via the same-tuple SDK `auth.remove` fallback.
export const removeAuthPrivate = Effect.fn("AuthRemovePrivate.remove")(function* (raw: unknown) {
  let req: AuthRemoveRequest
  try {
    req = validateAuthRemoveRequest(raw)
  } catch {
    return failed(fallbackAuthRemoveIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeAuthRemoveIds(req)
  try {
    canonicalDirectory(req.context.directory)
  } catch {
    return failed(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  if (req.context.workspace !== undefined) {
    const ws = req.context.workspace
    if (typeof ws !== "string" || ws.length === 0 || ws.includes("\0"))
      return failed(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  const providerID = req.payload.providerID
  const out = yield* invalidateAfterProviderAuthChange(
    providerID,
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.remove(providerID).pipe(Effect.orDie)
    }),
  ).pipe(
    Effect.map(() => ({ tag: "ok" as const })),
    Effect.catch(() => Effect.succeed({ tag: "fail" as const })),
    Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const })),
  )
  if (out.tag === "ok") return succeeded(req)
  return failed(safe, "internal", INTERNAL_MESSAGE, false)
})
