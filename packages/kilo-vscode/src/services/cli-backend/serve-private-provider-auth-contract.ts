// Private-first `provider/auth` read-only observation contract (production).
// Request is strictly `{v:1,requestId,op:"provider/auth",
// context:{directory,workspace?},payload:{}}` with no `opId`/`idempotencyKey`
// (observation identity is `requestId` only). Success data preserves the exact
// HTTP `GET /provider/auth` shape (open providerID→Method[] map with closed
// methods): `type:"oauth"|"api"`, display `label`, optional `prompts`.
// Unknown nested fields are rejected fail-closed so malformed display text
// falls back instead of silently succeeding.
//
// Source facts:
// - Route: `GET /provider/auth` with `WorkspaceRoutingQuery` in
//   `packages/opencode/src/server/routes/instance/httpapi/groups/provider.ts`
//   (`identifier: "provider.auth"`, success `ProviderAuth.Methods`).
// - Handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts`
//   `auth` returns the shared `fetchProviderAuthData`
//   (`ProviderAuth.Service.methods()` + strict closed validation).
// - Service: `packages/opencode/src/kilocode/provider-auth.ts`
//   (`fetchProviderAuthData` + `providerAuthPrivate`, same
//   drain-control + `InstanceRef` lane as `provider/catalog`).
// - SDK: v2 `client.provider.auth({directory})` issues
//   `GET /provider/auth` and remains the exactly-one fallback for
//   unavailable/retryable/invalid/ambiguous/transport/closed/timeout outcomes.
//   Validated terminal (`retryable === false`, including `validation.failed`/
//   `scope_mismatch`/`internal`) closes with zero SDK.
// - Consumer: `provider-actions.fetchProviderData` (non-canonical) is
//   private-first via `fetchProviderAuthPrivateFirst`: validated success
//   returns with zero SDK; validated terminal closes with zero SDK (the caller
//   degrades to `{}`); otherwise exactly one same-directory SDK fallback. The
//   helper never retries, posts, caches, journals, or reconciles; the caller
//   keeps catalog authority and `kilo.authStatus` parallel failure isolation
//   untouched.
// - Distinct from `provider.catalog`, `kilo.authStatus`, `models.discover`,
//   canonical provider pipeline, OAuth, snapshot endpoint. This contract
//   never matches those operations.
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

function noNul(v: unknown): v is string {
  return typeof v === "string" && !v.includes("\0")
}

export interface ProviderAuthContractRequest {
  v: 1
  requestId: string
  op: "provider/auth"
  context: { directory: string; workspace?: string }
  payload: Record<string, never>
}

export function validateProviderAuthContractRequest(raw: unknown): ProviderAuthContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  clean(raw.requestId, "requestId")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must not carry path material")
  if (raw.op !== "provider/auth") throw new Error("op must be provider/auth")
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
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for provider-auth")
  return raw as unknown as ProviderAuthContractRequest
}

export interface ProviderAuthWhen {
  key: string
  op: "eq" | "neq"
  value: string
}

export interface ProviderAuthTextPrompt {
  type: "text"
  key: string
  message: string
  placeholder?: string
  when?: ProviderAuthWhen
}

export interface ProviderAuthSelectOption {
  label: string
  value: string
  hint?: string
}

export interface ProviderAuthSelectPrompt {
  type: "select"
  key: string
  message: string
  options: ProviderAuthSelectOption[]
  when?: ProviderAuthWhen
}

export type ProviderAuthPrompt = ProviderAuthTextPrompt | ProviderAuthSelectPrompt

export interface ProviderAuthMethod {
  type: "oauth" | "api"
  label: string
  prompts?: ProviderAuthPrompt[]
}

export type ProviderAuthData = Record<string, ProviderAuthMethod[]>

const METHOD_FIELDS = new Set(["type", "label", "prompts"])
const TEXT_FIELDS = new Set(["type", "key", "message", "placeholder", "when"])
const SELECT_FIELDS = new Set(["type", "key", "message", "options", "when"])
const WHEN_FIELDS = new Set(["key", "op", "value"])
const OPTION_FIELDS = new Set(["label", "value", "hint"])

function checkWhen(raw: unknown): void {
  if (!record(raw)) throw new Error("when must be object")
  for (const k of Object.keys(raw)) if (!WHEN_FIELDS.has(k)) throw new Error(`unexpected when field ${k}`)
  if (!noNul(raw.key)) throw new Error("when.key invalid")
  if (raw.op !== "eq" && raw.op !== "neq") throw new Error("when.op invalid")
  if (!noNul(raw.value)) throw new Error("when.value invalid")
}

function checkOption(raw: unknown): void {
  if (!record(raw)) throw new Error("option must be object")
  for (const k of Object.keys(raw)) if (!OPTION_FIELDS.has(k)) throw new Error(`unexpected option field ${k}`)
  if (!noNul(raw.label)) throw new Error("option.label invalid")
  if (!noNul(raw.value)) throw new Error("option.value invalid")
  if (raw.hint !== undefined && !noNul(raw.hint)) throw new Error("option.hint invalid")
}

function checkPrompt(raw: unknown): void {
  if (!record(raw)) throw new Error("prompt must be object")
  const kind = raw.type
  if (kind === "text") {
    for (const k of Object.keys(raw)) if (!TEXT_FIELDS.has(k)) throw new Error(`unexpected text prompt field ${k}`)
    if (!noNul(raw.key)) throw new Error("prompt.key invalid")
    if (!noNul(raw.message)) throw new Error("prompt.message invalid")
    if (raw.placeholder !== undefined && !noNul(raw.placeholder)) throw new Error("prompt.placeholder invalid")
    if (raw.when !== undefined) checkWhen(raw.when)
    return
  }
  if (kind === "select") {
    for (const k of Object.keys(raw)) if (!SELECT_FIELDS.has(k)) throw new Error(`unexpected select prompt field ${k}`)
    if (!noNul(raw.key)) throw new Error("prompt.key invalid")
    if (!noNul(raw.message)) throw new Error("prompt.message invalid")
    if (!Array.isArray(raw.options)) throw new Error("prompt.options must be array")
    for (const item of raw.options as unknown[]) checkOption(item)
    if (raw.when !== undefined) checkWhen(raw.when)
    return
  }
  throw new Error("prompt.type invalid")
}

export function validateProviderAuthMethod(raw: unknown): void {
  if (!record(raw)) throw new Error("method must be object")
  for (const k of Object.keys(raw)) if (!METHOD_FIELDS.has(k)) throw new Error(`unexpected method field ${k}`)
  if (raw.type !== "oauth" && raw.type !== "api") throw new Error("method.type invalid")
  if (!noNul(raw.label)) throw new Error("method.label invalid")
  if (raw.prompts !== undefined) {
    if (!Array.isArray(raw.prompts)) throw new Error("method.prompts must be array")
    for (const item of raw.prompts as unknown[]) checkPrompt(item)
  }
}

export function validateProviderAuthData(raw: unknown): ProviderAuthData {
  if (!record(raw)) throw new Error("data must be object")
  for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!present(id) || !pathless(id)) throw new Error("provider id invalid")
    if (!Array.isArray(list)) throw new Error("provider methods must be array")
    for (const item of list as unknown[]) validateProviderAuthMethod(item)
  }
  return raw as unknown as ProviderAuthData
}

export interface ProviderAuthFailure {
  code: string
  message: string
  retryable: boolean
}

export const PROVIDER_AUTH_FAILURE_CODES = new Set([
  "validation.failed",
  "scope_mismatch",
  "InstanceUnavailableDuringConfigRebuild",
  "internal",
] as const)
export type ProviderAuthFailureCode =
  | "validation.failed"
  | "scope_mismatch"
  | "InstanceUnavailableDuringConfigRebuild"
  | "internal"
export const PROVIDER_AUTH_FAILURE_MESSAGES: Record<ProviderAuthFailureCode, string> = {
  "validation.failed": "invalid provider-auth request",
  scope_mismatch: "directory mismatch",
  InstanceUnavailableDuringConfigRebuild:
    "Instance is unavailable during config rebuild; no active runtime for this request",
  internal: "internal error",
}
export const PROVIDER_AUTH_FAILURE_RETRYABLE: Record<ProviderAuthFailureCode, boolean> = {
  "validation.failed": false,
  scope_mismatch: false,
  InstanceUnavailableDuringConfigRebuild: true,
  internal: false,
}

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateProviderAuthFailure(raw: unknown): ProviderAuthFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (!FAILURE_FIELDS.has(k)) throw new Error(`unexpected failure field ${k}`)
  }
  if (typeof raw.code !== "string" || !PROVIDER_AUTH_FAILURE_CODES.has(raw.code as ProviderAuthFailureCode))
    throw new Error("failure code must be a known provider-auth category")
  const code = raw.code as ProviderAuthFailureCode
  if (raw.message !== PROVIDER_AUTH_FAILURE_MESSAGES[code])
    throw new Error("failure message must be the fixed message for its code")
  if (raw.retryable !== PROVIDER_AUTH_FAILURE_RETRYABLE[code])
    throw new Error("failure retryable must match its code")
  return raw as unknown as ProviderAuthFailure
}

export type ProviderAuthResult =
  | {
      v: 1
      requestId: string
      op: "provider/auth"
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: ProviderAuthData
    }
  | {
      v: 1
      requestId: string
      op: "provider/auth"
      status: "failed"
      outcome: { type: "failed"; time: number; failure: ProviderAuthFailure }
      accepted: boolean
      failure: ProviderAuthFailure
    }
  | {
      v: 1
      requestId: string
      op: "provider/auth"
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeProviderAuthAmbiguous(
  req: ProviderAuthContractRequest,
  transportUnknown = true,
): ProviderAuthResult {
  const out: ProviderAuthResult = {
    v: 1,
    requestId: req.requestId,
    op: "provider/auth",
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type ProviderAuthWireOutcome =
  | { kind: "valid"; result: ProviderAuthResult }
  | { kind: "invalid"; detail: string }

export class ProviderAuthValidationError extends Error {
  readonly kind = "private-provider-auth-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "ProviderAuthValidationError"
    this.detail = detail
  }
}

export function isProviderAuthValidationError(v: unknown): v is ProviderAuthValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-provider-auth-validation"
}

export function normalizePrivateProviderAuthWire(
  raw: unknown,
  req: ProviderAuthContractRequest,
): ProviderAuthWireOutcome {
  try {
    const result = validateProviderAuthResult(raw, req)
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
export function validateProviderAuthResult(
  raw: unknown,
  req: ProviderAuthContractRequest,
): ProviderAuthResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.op !== "provider/auth") throw new Error("op mismatch")
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
    validateProviderAuthData(data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ProviderAuthResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error(`unexpected outcome field ${k}`)
    const failure = validateProviderAuthFailure(rec.failure)
    const outFailure = validateProviderAuthFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as ProviderAuthResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error(`unexpected result field ${k}`)
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as ProviderAuthResult
}

export function isSettledProviderAuthResult(result: unknown, req: ProviderAuthContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed") return false
  try {
    const out = validateProviderAuthResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
