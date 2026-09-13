import { Effect } from "effect"
import { getToken } from "@kilocode/kilo-gateway"
import { Auth } from "@/auth"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"

export const VERSION = 1 as const
export const OP = "kilo/auth-status" as const
export const CAPABILITY = "kilo/auth-status" as const

export interface KiloAuthStatusData {
  authenticated: boolean
  type?: "api" | "oauth"
}

export interface KiloAuthStatusRequest {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
}

export interface KiloAuthStatusFailure {
  code: string
  message: string
  retryable: boolean
}

export interface KiloAuthStatusSucceeded {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: KiloAuthStatusData
}

export interface KiloAuthStatusFailed {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "failed"
  outcome: { type: "failed"; time: number; failure: KiloAuthStatusFailure }
  accepted: false
  failure: KiloAuthStatusFailure
}

export interface KiloAuthStatusAmbiguous {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "ambiguous"
  outcome: { type: "ambiguous"; time: number }
  accepted: false
  transportUnknown?: boolean
}

export type KiloAuthStatusResult = KiloAuthStatusSucceeded | KiloAuthStatusFailed | KiloAuthStatusAmbiguous

export const VALIDATION_MESSAGE = "invalid kilo-auth-status request"
export const INTERNAL_MESSAGE = "internal error"

export class KiloAuthStatusInternal extends Error {
  readonly _tag = "KiloAuthStatusInternal" as const
  constructor() {
    super(INTERNAL_MESSAGE)
    this.name = "KiloAuthStatusInternal"
  }
}

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function pathless(v: string): boolean {
  return !v.includes("/") && !v.includes("\\") && !v.includes("\0")
}

export function validateKiloAuthStatusRequest(raw: unknown): KiloAuthStatusRequest {
  if (!record(raw)) throw new Error("params must be object")
  if (raw.v !== VERSION) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must be non-empty string without path material")
  if (raw.op !== OP) throw new Error("op must be kilo/auth-status")
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
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for kilo-auth-status")
  const allowedRoot = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  return raw as unknown as KiloAuthStatusRequest
}

type Ids = { requestId: string }

function sanitized(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !pathless(v)) return "unknown"
  return v
}

export function fallbackKiloAuthStatusIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId) }
}

export function safeKiloAuthStatusIds(req: { requestId: string }): Ids {
  return { requestId: sanitized(req.requestId) }
}

export function failed(ids: Ids, code: string, message: string, retryable: boolean): KiloAuthStatusFailed {
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

export function succeeded(req: KiloAuthStatusRequest, data: KiloAuthStatusData): KiloAuthStatusSucceeded {
  return {
    v: VERSION,
    requestId: req.requestId,
    op: OP,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data,
  }
}

export function ambiguous(req: KiloAuthStatusRequest, transportUnknown = true): KiloAuthStatusAmbiguous {
  const out: KiloAuthStatusAmbiguous = {
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

// Closed success shape mirroring `GET /kilo/auth-status` (`AuthStatus`):
// `authenticated` required boolean, `type` optional non-null `"api"|"oauth"`.
// No cross-field constraint: whether `authenticated` is true or false says
// nothing about `type` presence here — the HTTP route simply omits `type`
// while signed out. Unknown/secret fields (tokens, credentials) are rejected.
export function validateKiloAuthStatusData(raw: unknown): KiloAuthStatusData {
  if (!record(raw)) throw new Error("data must be object")
  const allowed = new Set(["authenticated", "type"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected data field")
  if (typeof raw.authenticated !== "boolean") throw new Error("authenticated must be boolean")
  const type = (raw as { type?: unknown }).type
  if (type !== undefined && type !== "api" && type !== "oauth")
    throw new Error("type must be api|oauth when present")
  return raw as unknown as KiloAuthStatusData
}

const RESULT_SUCCEEDED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "failure"])
const RESULT_AMBIGUOUS = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "transportUnknown"])
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])
const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

function checkFailure(raw: unknown): KiloAuthStatusFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as KiloAuthStatusFailure
}

export function validateKiloAuthStatusResult(raw: unknown, req: KiloAuthStatusRequest): KiloAuthStatusResult {
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
    validateKiloAuthStatusData(rec.data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (out.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as KiloAuthStatusSucceeded
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
    return raw as unknown as KiloAuthStatusFailed
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(out)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (out.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as KiloAuthStatusAmbiguous
}

export function isSettledKiloAuthStatusResult(result: unknown, req: KiloAuthStatusRequest): boolean {
  if (!record(result)) return false
  const status = (result as { status?: unknown }).status
  if (status !== "succeeded" && status !== "failed") return false
  try {
    const out = validateKiloAuthStatusResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}

// Shared `kilo.authStatus` read body for HTTP + fd. The sole production
// projection of `Auth.Service.get("kilo")` + `getToken` into
// `{authenticated:boolean,type?:"api"|"oauth"}`: a stored api/oauth
// credential with a token is `{authenticated:true,type}`, everything else
// (missing entry, wellknown, empty token) is `{authenticated:false}` with no
// `type`. Tokens and `Auth.Info` never leave this function. Like the HTTP
// route, an `Auth.get` store failure is `KiloAuthStatusInternal` (HTTP keeps
// its original `BadRequest` mapping; fd maps to terminal `internal` with zero
// SDK). `directory`/`workspace` are carrier routing identity only and never
// reach the auth store. No `InstanceRef`, no drain/read lease, no config
// fence, no cache, no timeout, no `AbortSignal`, no network.
export const fetchKiloAuthStatusData = (): Effect.Effect<
  KiloAuthStatusData,
  KiloAuthStatusInternal,
  Auth.Service
> =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const info = yield* auth.get("kilo").pipe(
      Effect.catch(() => Effect.fail(new KiloAuthStatusInternal() as KiloAuthStatusInternal)),
    )
    const type = getToken(info) && (info?.type === "api" || info?.type === "oauth") ? info.type : undefined
    const data: unknown = !type ? { authenticated: false } : { authenticated: true, type }
    try {
      return validateKiloAuthStatusData(data)
    } catch {
      return yield* Effect.fail(new KiloAuthStatusInternal())
    }
  })

// Private `kilo/auth-status`: routing-only directory validation, then the
// shared read. No `acquireDrainControl`, no `InstanceRef` lane (process-global
// `Auth` read-only, like `kilo/profile`), no journal/replay.
export const kiloAuthStatusPrivate = Effect.fn("KiloAuthStatusPrivate.read")(function* (raw: unknown) {
  let req: KiloAuthStatusRequest
  try {
    req = validateKiloAuthStatusRequest(raw)
  } catch {
    return failed(fallbackKiloAuthStatusIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeKiloAuthStatusIds(req)
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
  const out = yield* fetchKiloAuthStatusData().pipe(
    Effect.map((data) => ({ tag: "ok" as const, data })),
    Effect.catch(() => Effect.succeed({ tag: "fail" as const })),
    Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const })),
  )
  if (out.tag === "ok") {
    try {
      validateKiloAuthStatusData(out.data)
    } catch {
      return failed(safe, "internal", INTERNAL_MESSAGE, false)
    }
    return succeeded(req, out.data)
  }
  return failed(safe, "internal", INTERNAL_MESSAGE, false)
})
