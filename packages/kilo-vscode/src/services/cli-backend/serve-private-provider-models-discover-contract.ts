// Private-first `provider/models-discover` read-only observation contract (production).
// Request is strictly `{v:1,requestId,op:"provider/models-discover",
// context:{directory,workspace?},payload:{providerID,baseURL}}` with no
// `opId`/`idempotencyKey` (observation identity is `requestId` only). Success
// data preserves the exact HTTP `POST /provider/:providerID/models` shape
// (`{models:[{id,name}]}`): unknown entry fields are rejected fail-closed so
// stored keys or other secrets can never cross.
//
// Source facts:
// - Route: `POST /provider/:providerID/models` with `WorkspaceRoutingQuery` in
//   `packages/opencode/src/server/routes/instance/httpapi/groups/provider.ts`
//   (`identifier: "provider.models.discover"`, success `ProviderModelsResult`).
// - Handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts`
//   `models` returns the shared `fetchProviderModelsDiscoverData` (exact
//   provider plus exact stored `baseURL`, backend-held Bearer key, strict URL
//   shape plus exact-match gate, redacted domain errors).
// - Service: `packages/opencode/src/kilocode/provider-models-discover.ts`
//   (`fetchProviderModelsDiscoverData` + `providerModelsDiscoverPrivate`, same
//   drain-control + `InstanceRef` lane as `provider/auth`).
// - SDK: v2 `client.provider.models.discover({providerID,baseURL,directory})`
//   issues `POST /provider/:providerID/models` and remains the exactly-one
//   fallback for retryable-fence/unavailable/invalid/ambiguous/transport/
//   closed/timeout outcomes. Validated terminal (`retryable === false`,
//   including `validation.failed`/`scope_mismatch`/`unauthorized`/
//   `invalid_response`/`upstream_error`/`internal`) closes with zero SDK.
// - Consumer: `KiloProvider.handleFetchCustomProviderModels` (non-canonical
//   stored-credential branch only) is private-first via
//   `discoverModelsPrivateFirst`: validated success returns with zero SDK;
//   validated terminal posts the redacted error with zero SDK (auth UX from
//   the `unauthorized` code); otherwise exactly one same-directory SDK
//   fallback. The helper never retries, posts, caches, journals, or
//   reconciles; freshly typed keys, custom headers, missing providerID, and
//   canonical `SecretStorage` discovery keep their existing extension-host
//   paths untouched.
// - Distinct from `provider.catalog`, `provider.auth`, `kilo.authStatus`,
//   canonical provider pipeline, OAuth, snapshot endpoint. This contract
//   never matches those operations.
//
// ROUTING vs PAYLOAD SEMANTICS (v1):
// - `context.directory` binds request routing and scope. A scope match says
//   nothing about payload freshness or completeness.
// - Payload is validated shape-only (strict http(s) baseURL, non-empty
//   providerID, no unknown fields). No freshness, ordering, lifecycle, or
//   cross-directory claim is made.
// - Out of scope: provider writes, OAuth, `provider.catalog`, `config.get`,
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

function noNul(v: unknown): v is string {
  return typeof v === "string" && !v.includes("\0")
}

function strictBaseURL(v: unknown): boolean {
  if (typeof v !== "string") return false
  const trimmed = v.trim()
  if (!trimmed) return false
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  if (parsed.username || parsed.password) return false
  if (parsed.search || parsed.hash) return false
  return true
}

export interface ProviderModelsDiscoverContractRequest {
  v: 1
  requestId: string
  op: "provider/models-discover"
  context: { directory: string; workspace?: string }
  payload: { providerID: string; baseURL: string }
}

function checkModelsDiscoverPayload(raw: unknown): void {
  if (!record(raw)) throw new Error("payload must be object")
  const payloadAllowed = new Set(["providerID", "baseURL"])
  for (const k of Object.keys(raw)) {
    if (!payloadAllowed.has(k)) throw new Error(`unexpected payload field ${k}`)
  }
  const rec = raw as Record<string, unknown>
  if (typeof rec.providerID !== "string" || rec.providerID.trim().length === 0 || rec.providerID.includes("\0"))
    throw new Error("payload.providerID must be non-empty string")
  if (!strictBaseURL(rec.baseURL)) throw new Error("payload.baseURL must be strict http(s) base URL")
}

export function validateProviderModelsDiscoverContractRequest(raw: unknown): ProviderModelsDiscoverContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  clean(raw.requestId, "requestId")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must not carry path material")
  if (raw.op !== "provider/models-discover") throw new Error("op must be provider/models-discover")
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
  checkModelsDiscoverPayload(payload)
  return raw as unknown as ProviderModelsDiscoverContractRequest
}

export interface ProviderModelsDiscoverEntry {
  id: string
  name: string
}

export interface ProviderModelsDiscoverData {
  models: ProviderModelsDiscoverEntry[]
}

export function validateProviderModelsDiscoverEntry(raw: unknown): void {
  if (!record(raw)) throw new Error("model entry must be object")
  const allowed = new Set(["id", "name"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected model field ${k}`)
  }
  if (!present(raw.id) || (raw.id as string).includes("\0") || (raw.id as string).length > 256)
    throw new Error("model.id invalid")
  if (!noNul(raw.name) || (raw.name as string).length === 0) throw new Error("model.name invalid")
}

export function validateProviderModelsDiscoverData(raw: unknown): ProviderModelsDiscoverData {
  if (!record(raw)) throw new Error("data must be object")
  const allowed = new Set(["models"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected data field")
  if (!Array.isArray(raw.models)) throw new Error("models must be array")
  if (raw.models.length > 500) throw new Error("models too many")
  for (const item of raw.models as unknown[]) validateProviderModelsDiscoverEntry(item)
  return raw as unknown as ProviderModelsDiscoverData
}

export interface ProviderModelsDiscoverFailure {
  code: string
  message: string
  retryable: boolean
}

export const PROVIDER_MODELS_DISCOVER_FAILURE_CODES = new Set([
  "validation.failed",
  "scope_mismatch",
  "unauthorized",
  "invalid_response",
  "upstream_error",
  "InstanceUnavailableDuringConfigRebuild",
  "internal",
] as const)
export type ProviderModelsDiscoverFailureCode =
  | "validation.failed"
  | "scope_mismatch"
  | "unauthorized"
  | "invalid_response"
  | "upstream_error"
  | "InstanceUnavailableDuringConfigRebuild"
  | "internal"
export const PROVIDER_MODELS_DISCOVER_FAILURE_MESSAGES: Record<ProviderModelsDiscoverFailureCode, string> = {
  "validation.failed": "invalid provider models-discover request",
  scope_mismatch: "directory mismatch",
  unauthorized: "stored credential failed authentication",
  invalid_response: "provider returned an invalid models response",
  upstream_error: "provider models request failed",
  InstanceUnavailableDuringConfigRebuild:
    "Instance is unavailable during config rebuild; no active runtime for this request",
  internal: "internal error",
}
export const PROVIDER_MODELS_DISCOVER_FAILURE_RETRYABLE: Record<ProviderModelsDiscoverFailureCode, boolean> = {
  "validation.failed": false,
  scope_mismatch: false,
  unauthorized: false,
  invalid_response: false,
  upstream_error: false,
  InstanceUnavailableDuringConfigRebuild: true,
  internal: false,
}

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateProviderModelsDiscoverFailure(raw: unknown): ProviderModelsDiscoverFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (!FAILURE_FIELDS.has(k)) throw new Error(`unexpected failure field ${k}`)
  }
  if (
    typeof raw.code !== "string" ||
    !PROVIDER_MODELS_DISCOVER_FAILURE_CODES.has(raw.code as ProviderModelsDiscoverFailureCode)
  )
    throw new Error("failure code must be a known provider models-discover category")
  const code = raw.code as ProviderModelsDiscoverFailureCode
  if (raw.message !== PROVIDER_MODELS_DISCOVER_FAILURE_MESSAGES[code])
    throw new Error("failure message must be the fixed message for its code")
  if (raw.retryable !== PROVIDER_MODELS_DISCOVER_FAILURE_RETRYABLE[code])
    throw new Error("failure retryable must match its code")
  return raw as unknown as ProviderModelsDiscoverFailure
}

export type ProviderModelsDiscoverResult =
  | {
      v: 1
      requestId: string
      op: "provider/models-discover"
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: ProviderModelsDiscoverData
    }
  | {
      v: 1
      requestId: string
      op: "provider/models-discover"
      status: "failed"
      outcome: { type: "failed"; time: number; failure: ProviderModelsDiscoverFailure }
      accepted: boolean
      failure: ProviderModelsDiscoverFailure
    }
  | {
      v: 1
      requestId: string
      op: "provider/models-discover"
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeProviderModelsDiscoverAmbiguous(
  req: ProviderModelsDiscoverContractRequest,
  transportUnknown = true,
): ProviderModelsDiscoverResult {
  const out: ProviderModelsDiscoverResult = {
    v: 1,
    requestId: req.requestId,
    op: "provider/models-discover",
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type ProviderModelsDiscoverWireOutcome =
  | { kind: "valid"; result: ProviderModelsDiscoverResult }
  | { kind: "invalid"; detail: string }

export class ProviderModelsDiscoverValidationError extends Error {
  readonly kind = "private-provider-models-discover-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "ProviderModelsDiscoverValidationError"
    this.detail = detail
  }
}

export function isProviderModelsDiscoverValidationError(v: unknown): v is ProviderModelsDiscoverValidationError {
  return (
    !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-provider-models-discover-validation"
  )
}

export function normalizePrivateProviderModelsDiscoverWire(
  raw: unknown,
  req: ProviderModelsDiscoverContractRequest,
): ProviderModelsDiscoverWireOutcome {
  try {
    const result = validateProviderModelsDiscoverResult(raw, req)
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
export function validateProviderModelsDiscoverResult(
  raw: unknown,
  req: ProviderModelsDiscoverContractRequest,
): ProviderModelsDiscoverResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.op !== "provider/models-discover") throw new Error("op mismatch")
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
    validateProviderModelsDiscoverData(data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ProviderModelsDiscoverResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error(`unexpected outcome field ${k}`)
    const failure = validateProviderModelsDiscoverFailure(rec.failure)
    const outFailure = validateProviderModelsDiscoverFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as ProviderModelsDiscoverResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error(`unexpected result field ${k}`)
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as ProviderModelsDiscoverResult
}

export function isSettledProviderModelsDiscoverResult(
  result: unknown,
  req: ProviderModelsDiscoverContractRequest,
): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed") return false
  try {
    const out = validateProviderModelsDiscoverResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
