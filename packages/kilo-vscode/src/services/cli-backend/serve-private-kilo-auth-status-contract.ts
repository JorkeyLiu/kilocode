// Private-authority `kilo/auth-status` read-only observation contract (production).
// Request is strictly `{v:1,requestId,op:"kilo/auth-status",
// context:{directory,workspace?},payload:{}}` with no `opId`/`idempotencyKey`
// (observation identity is `requestId` only). Success data preserves the exact
// HTTP `GET /kilo/auth-status` shape (`AuthStatus`): required
// `authenticated` boolean with optional non-null `type:"api"|"oauth"` and no
// cross-field constraint (signed-out responses simply omit `type`).
//
// Source facts:
// - Route: `GET /kilo/auth-status` with `WorkspaceRoutingQuery` in
//   `packages/opencode/src/kilocode/server/httpapi/groups/kilo-gateway.ts`
//   (`identifier: "kilo.authStatus"`, success `AuthStatus`, error `BadRequest`).
// - Handler: `packages/opencode/src/kilocode/server/httpapi/handlers/kilo-gateway.ts`
//   `authStatus` returns the shared `fetchKiloAuthStatusData`
//   (`Auth.Service.get("kilo")` + `getToken` projection). The FD handler
//   invokes the same shared read with no `InstanceRef`/drain lane.
// - Authority: the shared `fetchKiloAuthStatusPrivate` helper is the sole
//   authority with zero SDK. Validated terminal (`retryable === false`,
//   including `validation.failed`/`internal`) remains terminal; unavailable,
//   missing capability, invalid, ambiguous, transport, closed, and timeout map
//   to explicit unavailable.
// - Consumer: `provider-actions.fetchProviderData` (non-canonical) is
//   private-authority via `fetchKiloAuthStatusPrivate`: validated success
//   returns the exact shape; validated terminal and unavailable both degrade
//   to `null` via the caller. The helper never retries, posts, caches,
//   journals, or reconciles; the caller keeps catalog authority and
//   `provider.auth` parallel failure isolation untouched.
// - Distinct from `provider.catalog`, `provider.auth`, `kilo/profile`,
//   `models.discover`, canonical provider pipeline, OAuth, snapshot endpoint.
//   This contract never matches those operations.
//
// ROUTING vs PAYLOAD SEMANTICS (v1):
// - `context.directory` binds request routing and scope. A scope match says
//   nothing about payload freshness or completeness.
// - Payload is validated shape-only. No freshness, ordering, lifecycle, or
//   cross-directory claim is made.
// - Out of scope: provider writes, OAuth, `models.discover`, `config.get`,
//   caching/dedup, UI rendering, transport behavior beyond the fixed failure
//   taxonomy.

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

export interface KiloAuthStatusData {
  authenticated: boolean
  type?: "api" | "oauth"
}

export interface KiloAuthStatusContractRequest {
  v: 1
  requestId: string
  op: "kilo/auth-status"
  context: { directory: string; workspace?: string }
  payload: Record<string, never>
}

export function validateKiloAuthStatusContractRequest(raw: unknown): KiloAuthStatusContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  clean(raw.requestId, "requestId")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must not carry path material")
  if (raw.op !== "kilo/auth-status") throw new Error("op must be kilo/auth-status")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  const ctxAllowed = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx)) {
    if (!ctxAllowed.has(k)) throw new Error(`unexpected context field ${k}`)
  }
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (ctx.workspace !== undefined) {
    if (!present(ctx.workspace) || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for kilo-auth-status")
  return raw as unknown as KiloAuthStatusContractRequest
}

export function validateKiloAuthStatusData(raw: unknown): KiloAuthStatusData {
  if (!record(raw)) throw new Error("data must be object")
  const allowed = new Set(["authenticated", "type"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected data field ${k}`)
  }
  if (typeof raw.authenticated !== "boolean") throw new Error("authenticated must be boolean")
  const type = (raw as { type?: unknown }).type
  if (type !== undefined && type !== "api" && type !== "oauth")
    throw new Error("type must be api|oauth when present")
  return raw as unknown as KiloAuthStatusData
}

export interface KiloAuthStatusFailure {
  code: string
  message: string
  retryable: boolean
}

export const KILO_AUTH_STATUS_FAILURE_CODES = new Set(["validation.failed", "internal"] as const)
export type KiloAuthStatusFailureCode = "validation.failed" | "internal"
export const KILO_AUTH_STATUS_FAILURE_MESSAGES: Record<KiloAuthStatusFailureCode, string> = {
  "validation.failed": "invalid kilo-auth-status request",
  internal: "internal error",
}
export const KILO_AUTH_STATUS_FAILURE_RETRYABLE: Record<KiloAuthStatusFailureCode, boolean> = {
  "validation.failed": false,
  internal: false,
}

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateKiloAuthStatusFailure(raw: unknown): KiloAuthStatusFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (!FAILURE_FIELDS.has(k)) throw new Error(`unexpected failure field ${k}`)
  }
  if (typeof raw.code !== "string" || !KILO_AUTH_STATUS_FAILURE_CODES.has(raw.code as KiloAuthStatusFailureCode))
    throw new Error("failure code must be a known kilo-auth-status category")
  const code = raw.code as KiloAuthStatusFailureCode
  if (raw.message !== KILO_AUTH_STATUS_FAILURE_MESSAGES[code])
    throw new Error("failure message must be the fixed message for its code")
  if (raw.retryable !== KILO_AUTH_STATUS_FAILURE_RETRYABLE[code])
    throw new Error("failure retryable must match its code")
  return raw as unknown as KiloAuthStatusFailure
}

export type KiloAuthStatusResult =
  | {
      v: 1
      requestId: string
      op: "kilo/auth-status"
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: KiloAuthStatusData
    }
  | {
      v: 1
      requestId: string
      op: "kilo/auth-status"
      status: "failed"
      outcome: { type: "failed"; time: number; failure: KiloAuthStatusFailure }
      accepted: boolean
      failure: KiloAuthStatusFailure
    }
  | {
      v: 1
      requestId: string
      op: "kilo/auth-status"
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeKiloAuthStatusAmbiguous(
  req: KiloAuthStatusContractRequest,
  transportUnknown = true,
): KiloAuthStatusResult {
  const out: KiloAuthStatusResult = {
    v: 1,
    requestId: req.requestId,
    op: "kilo/auth-status",
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type KiloAuthStatusWireOutcome =
  | { kind: "valid"; result: KiloAuthStatusResult }
  | { kind: "invalid"; detail: string }

export class KiloAuthStatusValidationError extends Error {
  readonly kind = "private-kilo-auth-status-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "KiloAuthStatusValidationError"
    this.detail = detail
  }
}

export function isKiloAuthStatusValidationError(v: unknown): v is KiloAuthStatusValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-kilo-auth-status-validation"
}

export function normalizePrivateKiloAuthStatusWire(
  raw: unknown,
  req: KiloAuthStatusContractRequest,
): KiloAuthStatusWireOutcome {
  try {
    const result = validateKiloAuthStatusResult(raw, req)
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
export function validateKiloAuthStatusResult(
  raw: unknown,
  req: KiloAuthStatusContractRequest,
): KiloAuthStatusResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.op !== "kilo/auth-status") throw new Error("op mismatch")
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
    validateKiloAuthStatusData(data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as KiloAuthStatusResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error(`unexpected outcome field ${k}`)
    const failure = validateKiloAuthStatusFailure(rec.failure)
    const outFailure = validateKiloAuthStatusFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as KiloAuthStatusResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error(`unexpected result field ${k}`)
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as KiloAuthStatusResult
}

export function isSettledKiloAuthStatusResult(result: unknown, req: KiloAuthStatusContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed") return false
  try {
    const out = validateKiloAuthStatusResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
