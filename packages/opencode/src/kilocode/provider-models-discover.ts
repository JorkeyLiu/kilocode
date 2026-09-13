import { Effect } from "effect"
import { Provider } from "@/provider/provider"
import {
  ModelDiscoveryError,
  fetchModelsWithKey,
  isDiscoveryCredentialAllowed,
  isStrictBaseURL,
  normalizeBaseURL,
} from "@/provider/model-discovery"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import {
  acquireDrainControl,
  InstanceUnavailableDuringConfigRebuildError,
} from "@/kilocode/server/drain-control-acquire"
import { InstanceRef } from "@/effect/instance-ref"

export const VERSION = 1 as const
export const OP = "provider/models-discover" as const
export const CAPABILITY = "provider/models-discover" as const

export interface ProviderModelsDiscoverRequest {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  context: {
    directory: string
    workspace?: string
  }
  payload: {
    providerID: string
    baseURL: string
  }
}

export interface ProviderModelsDiscoverEntry {
  id: string
  name: string
}

export interface ProviderModelsDiscoverData {
  models: ProviderModelsDiscoverEntry[]
}

export interface ProviderModelsDiscoverFailure {
  code: string
  message: string
  retryable: boolean
}

export interface ProviderModelsDiscoverSucceeded {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: ProviderModelsDiscoverData
}

export interface ProviderModelsDiscoverFailed {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "failed"
  outcome: { type: "failed"; time: number; failure: ProviderModelsDiscoverFailure }
  accepted: false
  failure: ProviderModelsDiscoverFailure
}

export interface ProviderModelsDiscoverAmbiguous {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "ambiguous"
  outcome: { type: "ambiguous"; time: number }
  accepted: false
  transportUnknown?: boolean
}

export type ProviderModelsDiscoverResult =
  | ProviderModelsDiscoverSucceeded
  | ProviderModelsDiscoverFailed
  | ProviderModelsDiscoverAmbiguous

export const VALIDATION_MESSAGE = "invalid provider models-discover request"
export const SCOPE_MESSAGE = "directory mismatch"
export const UNAUTHORIZED_MESSAGE = "stored credential failed authentication"
export const INVALID_RESPONSE_MESSAGE = "provider returned an invalid models response"
export const UPSTREAM_MESSAGE = "provider models request failed"
export const FENCE_MESSAGE = "Instance is unavailable during config rebuild; no active runtime for this request"
export const INTERNAL_MESSAGE = "internal error"

export type ProviderModelsDiscoverKind = "bad-request" | "unauthorized" | "invalid-response" | "upstream"

export class ProviderModelsDiscoverError extends Error {
  readonly kind: ProviderModelsDiscoverKind
  constructor(kind: ProviderModelsDiscoverKind, message: string) {
    super(message)
    this.name = "ProviderModelsDiscoverError"
    this.kind = kind
  }
}

export class ProviderModelsDiscoverInternal extends Error {
  readonly _tag = "ProviderModelsDiscoverInternal" as const
  constructor() {
    super(INTERNAL_MESSAGE)
    this.name = "ProviderModelsDiscoverInternal"
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

function noNul(v: unknown): v is string {
  return typeof v === "string" && !v.includes("\0")
}

export function validateProviderModelsDiscoverRequest(raw: unknown): ProviderModelsDiscoverRequest {
  if (!record(raw)) throw new Error("params must be object")
  if (raw.v !== VERSION) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must be non-empty string without path material")
  if (raw.op !== OP) throw new Error("op must be provider/models-discover")
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
  const allowedPayload = new Set(["providerID", "baseURL"])
  for (const k of Object.keys(payload)) if (!allowedPayload.has(k)) throw new Error("unexpected payload field")
  if (
    typeof payload.providerID !== "string" ||
    payload.providerID.trim().length === 0 ||
    payload.providerID.includes("\0")
  )
    throw new Error("payload.providerID must be non-empty string")
  if (typeof payload.baseURL !== "string" || !isStrictBaseURL(payload.baseURL))
    throw new Error("payload.baseURL must be strict http(s) base URL")
  const allowedRoot = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  return raw as unknown as ProviderModelsDiscoverRequest
}

type Ids = { requestId: string }

function sanitized(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !pathless(v)) return "unknown"
  return v
}

export function fallbackProviderModelsDiscoverIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId) }
}

export function safeProviderModelsDiscoverIds(req: { requestId: string }): Ids {
  return { requestId: sanitized(req.requestId) }
}

export function failed(ids: Ids, code: string, message: string, retryable: boolean): ProviderModelsDiscoverFailed {
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

export function succeeded(
  req: ProviderModelsDiscoverRequest,
  data: ProviderModelsDiscoverData,
): ProviderModelsDiscoverSucceeded {
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

export function ambiguous(
  req: ProviderModelsDiscoverRequest,
  transportUnknown = true,
): ProviderModelsDiscoverAmbiguous {
  const out: ProviderModelsDiscoverAmbiguous = {
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

export const MAX_MODELS = 500
export const MAX_ID_LENGTH = 256

export function validateProviderModelsDiscoverEntry(raw: unknown): void {
  if (!record(raw)) throw new Error("model entry must be object")
  const allowed = new Set(["id", "name"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error(`unexpected model field ${k}`)
  if (!present(raw.id) || (raw.id as string).includes("\0") || (raw.id as string).length > MAX_ID_LENGTH)
    throw new Error("model.id invalid")
  if (!noNul(raw.name) || (raw.name as string).length === 0) throw new Error("model.name invalid")
}

export function validateProviderModelsDiscoverData(raw: unknown): ProviderModelsDiscoverData {
  if (!record(raw)) throw new Error("data must be object")
  const allowed = new Set(["models"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected data field")
  if (!Array.isArray(raw.models)) throw new Error("models must be array")
  if (raw.models.length > MAX_MODELS) throw new Error("models too many")
  for (const item of raw.models as unknown[]) validateProviderModelsDiscoverEntry(item)
  return raw as unknown as ProviderModelsDiscoverData
}

const RESULT_SUCCEEDED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "failure"])
const RESULT_AMBIGUOUS = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "transportUnknown"])
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])
const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

function checkFailure(raw: unknown): ProviderModelsDiscoverFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as ProviderModelsDiscoverFailure
}

export function validateProviderModelsDiscoverResult(
  raw: unknown,
  req: ProviderModelsDiscoverRequest,
): ProviderModelsDiscoverResult {
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
    validateProviderModelsDiscoverData(rec.data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (out.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ProviderModelsDiscoverSucceeded
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
    return raw as unknown as ProviderModelsDiscoverFailed
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(out)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (out.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as ProviderModelsDiscoverAmbiguous
}

export function isSettledProviderModelsDiscoverResult(result: unknown, req: ProviderModelsDiscoverRequest): boolean {
  if (!record(result)) return false
  const status = (result as { status?: unknown }).status
  if (status !== "succeeded" && status !== "failed") return false
  try {
    const out = validateProviderModelsDiscoverResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}

// Shared `provider/models-discover` read body for HTTP + fd. Only the stored
// backend credential owner: exact provider plus exact stored `baseURL` with
// the backend-held Bearer key. Never request text, never user headers, never
// a persisted or logged secret. `directory`/`workspace` are carrier routing
// identity only and never reach the service beyond `InstanceState` selection
// performed by the caller lane. The wire projection is the exact
// `ProviderModelsResult` `{models: [{id, name}]}`; unknown entry fields are
// rejected so secrets can never cross.
export const fetchProviderModelsDiscoverData = (input: {
  providerID: string
  baseURL: string
}): Effect.Effect<ProviderModelsDiscoverData, ProviderModelsDiscoverError, Provider.Service> =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const providerID = String(input.providerID ?? "").trim()
    const requestedBaseURL = typeof input.baseURL === "string" ? input.baseURL : ""
    const bad = () => new ProviderModelsDiscoverError("bad-request", "Provider model discovery request is invalid")
    if (!providerID) return yield* Effect.fail(bad())
    // Strict URL shape on the request URL first: plain http(s) only, no
    // embedded credentials, query, or fragment.
    if (!isStrictBaseURL(requestedBaseURL)) return yield* Effect.fail(bad())
    const connected = yield* provider.list().pipe(Effect.catch(() => Effect.die(new ProviderModelsDiscoverInternal())))
    const target = connected[providerID as keyof typeof connected]
    if (!target) return yield* Effect.fail(bad())
    const raw = target as unknown as Record<string, unknown>
    const allowed = isDiscoveryCredentialAllowed({
      providerID,
      source: raw.source,
      key: raw.key,
      env: raw.env,
    })
    if (!allowed) return yield* Effect.fail(bad())
    const storedBaseURL =
      raw.options && typeof raw.options === "object" && !Array.isArray(raw.options)
        ? (raw.options as Record<string, unknown>).baseURL
        : undefined
    // Stored URL must satisfy the same strict shape; the request itself is
    // served from the stored URL, never from request text.
    if (typeof storedBaseURL !== "string" || !isStrictBaseURL(storedBaseURL)) return yield* Effect.fail(bad())
    // Exact stored baseURL match keeps the stored key from being sent to an
    // arbitrary host (e.g. after the user edits the URL field). User input
    // headers are never accepted here, so no stored key injection is possible.
    if (normalizeBaseURL(storedBaseURL) !== normalizeBaseURL(requestedBaseURL)) return yield* Effect.fail(bad())
    const key = raw.key as string
    const discovered = yield* Effect.tryPromise({
      try: () => fetchModelsWithKey({ baseURL: normalizeBaseURL(storedBaseURL), key }),
      catch: (cause) => {
        if (cause instanceof ModelDiscoveryError) {
          if (cause.kind === "auth") return new ProviderModelsDiscoverError("unauthorized", cause.message)
          if (cause.kind === "invalid") return new ProviderModelsDiscoverError("invalid-response", cause.message)
          return new ProviderModelsDiscoverError("upstream", cause.message)
        }
        return new ProviderModelsDiscoverError("upstream", "Provider models request failed")
      },
    })
    try {
      const data = { models: discovered }
      validateProviderModelsDiscoverData(data)
      return data
    } catch {
      return yield* Effect.die(new ProviderModelsDiscoverInternal())
    }
  })

function domainToFailed(safe: Ids, err: ProviderModelsDiscoverError): ProviderModelsDiscoverFailed {
  if (err.kind === "unauthorized") return failed(safe, "unauthorized", UNAUTHORIZED_MESSAGE, false)
  if (err.kind === "invalid-response") return failed(safe, "invalid_response", INVALID_RESPONSE_MESSAGE, false)
  if (err.kind === "upstream") return failed(safe, "upstream_error", UPSTREAM_MESSAGE, false)
  return failed(safe, "validation.failed", VALIDATION_MESSAGE, false)
}

// Private `provider/models-discover`: routing-only directory validation plus
// strict `{providerID, baseURL}` payload validation, then the shared read via
// the existing drain-control + `InstanceRef` lane (same lane as
// `provider/catalog` — no new lifecycle lane, no manual `InstanceRef`
// construction, no new drain/read lease, no journal/replay). `directory`/
// `workspace` are carrier routing identity only; `workspace` never reaches
// the service. The outbound upstream fetch is bounded by
// `MODEL_DISCOVERY_TIMEOUT_MS`; a slow upstream surfaces to the extension as
// the 3 s observer timeout, which takes the same-directory SDK fallback.
// Read-only, safely repeatable: an ambiguous transport outcome may safely
// repeat via the same-directory SDK `client.provider.models.discover`
// fallback; the op never retries.
export const providerModelsDiscoverPrivate = Effect.fn("ProviderModelsDiscoverPrivate.read")(function* (raw: unknown) {
  let req: ProviderModelsDiscoverRequest
  try {
    req = validateProviderModelsDiscoverRequest(raw)
  } catch {
    return failed(fallbackProviderModelsDiscoverIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeProviderModelsDiscoverIds(req)
  let dir: string
  try {
    dir = canonicalDirectory(req.context.directory)
  } catch {
    return failed(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  if (req.context.workspace !== undefined) {
    const ws = req.context.workspace
    if (typeof ws !== "string" || ws.length === 0 || ws.includes("\0"))
      return failed(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  const acquired = yield* acquireDrainControl(dir).pipe(
    Effect.map((v) => ({ tag: "ok" as const, value: v })),
    Effect.catch((err: unknown) => {
      const fence =
        err instanceof InstanceUnavailableDuringConfigRebuildError ||
        (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
      const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
      const message = fence ? FENCE_MESSAGE : INTERNAL_MESSAGE
      return Effect.succeed({ tag: "fail" as const, result: failed(safe, code, message, fence) })
    }),
    Effect.catchDefect(() =>
      Effect.succeed({ tag: "fail" as const, result: failed(safe, "internal", INTERNAL_MESSAGE, false) }),
    ),
  )
  if (acquired.tag !== "ok") return acquired.result
  const inner = Effect.gen(function* () {
    let stored: string
    try {
      stored = canonicalDirectory(acquired.value.ctx.directory)
    } catch {
      return failed(safe, "internal", INTERNAL_MESSAGE, false)
    }
    if (stored !== dir) return failed(safe, "scope_mismatch", SCOPE_MESSAGE, false)
    const out = yield* fetchProviderModelsDiscoverData({
      providerID: req.payload.providerID,
      baseURL: req.payload.baseURL,
    }).pipe(
      Effect.map((data) => ({ tag: "ok" as const, data })),
      Effect.catch((err: unknown) => {
        if (err instanceof ProviderModelsDiscoverError)
          return Effect.succeed({ tag: "fail" as const, result: domainToFailed(safe, err) })
        return Effect.succeed({ tag: "fail" as const, result: failed(safe, "internal", INTERNAL_MESSAGE, false) })
      }),
      Effect.catchDefect(() =>
        Effect.succeed({ tag: "fail" as const, result: failed(safe, "internal", INTERNAL_MESSAGE, false) }),
      ),
    )
    if (out.tag !== "ok") return out.result
    try {
      validateProviderModelsDiscoverData(out.data)
    } catch {
      return failed(safe, "internal", INTERNAL_MESSAGE, false)
    }
    return succeeded(req, out.data)
  }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
  return yield* inner.pipe(
    Effect.catch(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, false))),
    Effect.catchDefect(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, false))),
  )
})
