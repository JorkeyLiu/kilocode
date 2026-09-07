// Gate B deferred `sessionModelUsage` read-only candidate contract evidence only.
// Pure contract helpers with no transport, no private capability, no dispatch,
// no runtime observation, no durable state, no enable/disable, no event stream,
// and no production parity claim.
// `op:"session/model-usage"` below is a contract-evidence label only; it is
// never registered as a private capability and never sent over any peer.
// Production `sessionModelUsage` stays SDK-only
// (`GET /session/:sessionID/model-usage` via `@kilocode/sdk`
// `client.kilocode.sessionModelUsage`).
//
// Source facts (read-only evidence, not imported):
// - Route: `GET /session/:sessionID/model-usage` with `WorkspaceRoutingQuery`
//   (`directory?`, `workspace?`) in
//   `packages/opencode/src/kilocode/server/httpapi/groups/kilocode.ts:197-208`
//   (`identifier: "kilocode.sessionModelUsage"`, success `ModelUsage.Info`
//   `{sessionIDs, totals, models}`, error `NotFound`).
// - Handler: `packages/opencode/src/kilocode/server/httpapi/handlers/kilocode.ts:158-164`
//   `sessionModelUsage` returns `ModelUsage.get(sessionID)` and maps missing
//   usage to `NotFound`.
// - Model: `packages/opencode/src/kilocode/session/model-usage.ts:10-40,115-186`
//   `Tokens {input,output,reasoning,cache:{read,write}}` (all NonNegativeInt),
//   `Usage {steps,cost,tokens}`, `Model {providerID,modelID,...Usage}`,
//   `Info {sessionIDs: SessionID[], totals: Usage, models: Model[]}`.
// - SDK: `client.kilocode.sessionModelUsage({sessionID, directory})` is the
//   sole authority.
// - Consumer: `packages/kilo-vscode/src/KiloProvider.ts:2782-2794`
//   `fetchAndSendSessionModelUsage` calls the SDK with `{sessionID, directory}`
//   and posts `sessionModelUsageLoaded` (reads only `response.data.sessionIDs`
//   plus the opaque `response.data`).
//
// ROUTING-ONLY vs PAYLOAD SEMANTICS (explicit, honest v1):
// - `context.directory`/`context.sessionId` are ROUTING-ONLY labels. Scope
//   checks guard request-routing identity only; a scope match says nothing
//   about payload ownership, freshness, or completeness.
// - Payload `sessionIDs`/`totals`/`models` are validated shape-only. No
//   freshness, ordering, cost-completeness, or cross-directory claim is made.
// - `models` ordering (production SQL `ORDER BY cost DESC, providerID,
//   modelID`) is explicitly UNRESOLVED here: parity never compares order.
// - Out of scope: prompt submission, lifecycle mutations, abort/cancelQueued,
//   event-stream/SSE parity, transport behavior, and any other operation.

import { isAbsolute, normalize, resolve } from "path"

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function isSessionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("ses")
}

function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}

function assertAllowedKeys(rec: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const k of Object.keys(rec)) if (!allowed.has(k)) throw new Error(`unexpected ${label} field ${k}`)
}

function isNonNegativeInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && (v as number) >= 0
}

function isFiniteNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v)
}

export function canonicalSessionModelUsageOpId(sessionId: string, token: string): string {
  if (typeof sessionId !== "string" || sessionId.length === 0)
    throw new TypeError("sessionId must be non-empty string")
  if (sessionId.includes(":")) throw new TypeError("sessionId must not contain ':'")
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `session-model-usage:${sessionId}:${token}`
}

export function parseSessionModelUsageOpId(opId: string): { sessionId: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 3) throw new TypeError(`session-model-usage opId must have 2 segments: ${opId}`)
  if (segs[0] !== "session-model-usage") throw new TypeError(`opId kind must be session-model-usage: ${opId}`)
  const sid = segs[1]!
  const token = segs[2]!
  if (sid.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  return { sessionId: sid, token }
}

export interface SessionModelUsageContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/model-usage"
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
  }
  payload: Record<string, never>
}

// eslint-disable-next-line complexity
export function validateSessionModelUsageContractRequest(raw: unknown): SessionModelUsageContractRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/model-usage") throw new Error("op must be session/model-usage")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId)
    throw new Error("idempotencyKey must equal opId for session-model-usage contract")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "sessionId"])
  for (const k of Object.keys(ctx as Record<string, unknown>))
    if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (!isSessionId(ctx.sessionId)) throw new Error("context.sessionId must be SessionID")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload as Record<string, unknown>).length !== 0)
    throw new Error("payload must be empty object for session-model-usage contract")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const parsed = parseSessionModelUsageOpId(raw.opId as string)
  if (parsed.sessionId !== ctx.sessionId)
    throw new Error(`opId session binding mismatch: ${raw.opId} vs ${ctx.sessionId}`)
  const idem = parseSessionModelUsageOpId(raw.idempotencyKey as string)
  if (idem.sessionId !== ctx.sessionId)
    throw new Error(`idempotencyKey session binding mismatch: ${raw.idempotencyKey} vs ${ctx.sessionId}`)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as SessionModelUsageContractRequest
}

export type SessionModelUsageScopeWhich = "directory" | "session" | "request"

export type SessionModelUsageScopeCheck =
  | { ok: true }
  | { ok: false; code: "scope_mismatch"; which: SessionModelUsageScopeWhich }

export function checkSessionModelUsageScope(
  req: SessionModelUsageContractRequest,
  expected: { directory: string; sessionId: string; token: string },
): SessionModelUsageScopeCheck {
  let want = expected.directory
  try {
    want = canonicalDir(expected.directory)
  } catch {
    return { ok: false, code: "scope_mismatch", which: "directory" }
  }
  let got = req.context.directory
  try {
    got = canonicalDir(req.context.directory)
  } catch {
    return { ok: false, code: "scope_mismatch", which: "directory" }
  }
  if (got !== want) return { ok: false, code: "scope_mismatch", which: "directory" }
  if (req.context.sessionId !== expected.sessionId)
    return { ok: false, code: "scope_mismatch", which: "session" }
  const parsed = parseSessionModelUsageOpId(req.opId)
  if (parsed.sessionId !== expected.sessionId || parsed.token !== expected.token)
    return { ok: false, code: "scope_mismatch", which: "request" }
  const bound = canonicalSessionModelUsageOpId(expected.sessionId, expected.token)
  if (req.opId !== bound || req.idempotencyKey !== bound)
    return { ok: false, code: "scope_mismatch", which: "request" }
  return { ok: true }
}

// Safe v1 payload projection: exactly the production `ModelUsage.Info` fields
// (`sessionIDs`, `totals`, `models`) with required numeric/token shapes only.
// Shape-only validation; no freshness, ordering, or completeness claim.
export interface SessionModelUsageTokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface SessionModelUsageUsage {
  steps: number
  cost: number
  tokens: SessionModelUsageTokens
}

export interface SessionModelUsageModel {
  providerID: string
  modelID: string
  steps: number
  cost: number
  tokens: SessionModelUsageTokens
}

export interface SessionModelUsagePayload {
  sessionIDs: string[]
  totals: SessionModelUsageUsage
  models: SessionModelUsageModel[]
}

const MODEL_USAGE_PAYLOAD_FIELDS = new Set(["sessionIDs", "totals", "models"])
const MODEL_USAGE_USAGE_FIELDS = new Set(["steps", "cost", "tokens"])
const MODEL_USAGE_TOKENS_FIELDS = new Set(["input", "output", "reasoning", "cache"])
const MODEL_USAGE_CACHE_FIELDS = new Set(["read", "write"])
const MODEL_USAGE_MODEL_FIELDS = new Set(["providerID", "modelID", "steps", "cost", "tokens"])

function validateUsageTokens(raw: unknown, label: string): SessionModelUsageTokens {
  if (!isRecord(raw)) throw new Error(`${label}.tokens must be object`)
  assertAllowedKeys(raw as Record<string, unknown>, MODEL_USAGE_TOKENS_FIELDS, label)
  const rec = raw as Record<string, unknown>
  for (const field of ["input", "output", "reasoning"]) {
    if (!isNonNegativeInt(rec[field])) throw new Error(`${label}.tokens.${field} must be non-negative integer`)
  }
  const cache = rec.cache
  if (!isRecord(cache)) throw new Error(`${label}.tokens.cache must be object`)
  assertAllowedKeys(cache as Record<string, unknown>, MODEL_USAGE_CACHE_FIELDS, label)
  if (!isNonNegativeInt((cache as Record<string, unknown>).read))
    throw new Error(`${label}.tokens.cache.read must be non-negative integer`)
  if (!isNonNegativeInt((cache as Record<string, unknown>).write))
    throw new Error(`${label}.tokens.cache.write must be non-negative integer`)
  return raw as unknown as SessionModelUsageTokens
}

function validateUsage(raw: unknown, label: string): SessionModelUsageUsage {
  if (!isRecord(raw)) throw new Error(`${label} must be object`)
  assertAllowedKeys(raw as Record<string, unknown>, MODEL_USAGE_USAGE_FIELDS, label)
  const rec = raw as Record<string, unknown>
  if (!isNonNegativeInt(rec.steps)) throw new Error(`${label}.steps must be non-negative integer`)
  if (!isFiniteNumber(rec.cost)) throw new Error(`${label}.cost must be finite number`)
  validateUsageTokens(rec.tokens, label)
  return raw as unknown as SessionModelUsageUsage
}

export function validateSessionModelUsagePayload(raw: unknown): SessionModelUsagePayload {
  if (!isRecord(raw)) throw new Error("session-model-usage payload must be object")
  assertAllowedKeys(raw as Record<string, unknown>, MODEL_USAGE_PAYLOAD_FIELDS, "session-model-usage")
  const rec = raw as Record<string, unknown>
  if (!Array.isArray(rec.sessionIDs)) throw new Error("sessionIDs must be array")
  for (const id of rec.sessionIDs as unknown[]) {
    if (!isSessionId(id)) throw new Error("sessionIDs entries must be SessionID")
  }
  validateUsage(rec.totals, "totals")
  if (!Array.isArray(rec.models)) throw new Error("models must be array")
  for (const entry of rec.models as unknown[]) {
    if (!isRecord(entry)) throw new Error("models entries must be object")
    assertAllowedKeys(entry as Record<string, unknown>, MODEL_USAGE_MODEL_FIELDS, "model")
    const m = entry as Record<string, unknown>
    if (typeof m.providerID !== "string") throw new Error("model.providerID must be string")
    if (typeof m.modelID !== "string") throw new Error("model.modelID must be string")
    if (!isNonNegativeInt(m.steps)) throw new Error("model.steps must be non-negative integer")
    if (!isFiniteNumber(m.cost)) throw new Error("model.cost must be finite number")
    validateUsageTokens(m.tokens, "model")
  }
  return raw as unknown as SessionModelUsagePayload
}

export type SessionModelUsageResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/model-usage"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { usage: SessionModelUsagePayload }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/model-usage"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: SessionModelUsageFailure }
      accepted: boolean
      failure: SessionModelUsageFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/model-usage"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeSessionModelUsageAmbiguous(
  req: SessionModelUsageContractRequest,
  transportUnknown = true,
): SessionModelUsageResult {
  const out: SessionModelUsageResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/model-usage",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

// Redacted failure shape ({code,message,retryable} only). Usage/session echo
// keys are rejected so fixtures cannot carry usage or session material.
export interface SessionModelUsageFailure {
  code: string
  message: string
  retryable: boolean
}

const MODEL_USAGE_FAILURE_FORBIDDEN = new Set([
  "session",
  "sessionId",
  "sessionIDs",
  "prompt",
  "tool",
  "error",
  "raw",
  "output",
  "detail",
  "directory",
  "workspace",
  "providerID",
  "modelID",
  "cost",
  "tokens",
  "totals",
  "models",
  "usage",
])

const MODEL_USAGE_FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export const SESSION_MODEL_USAGE_FAILED_CODE = "session-model-usage.failed"
export const SESSION_MODEL_USAGE_FAILED_MESSAGE = "private session-model-usage failed"

export function validateSessionModelUsageFailure(raw: unknown): SessionModelUsageFailure {
  if (!isRecord(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (MODEL_USAGE_FAILURE_FORBIDDEN.has(k)) throw new Error("failure must not carry raw field")
  }
  assertAllowedKeys(raw as Record<string, unknown>, MODEL_USAGE_FAILURE_FIELDS, "failure")
  if (!isNonEmpty(raw.code)) throw new Error("failure code must be non-empty string")
  if (!isNonEmpty(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as SessionModelUsageFailure
}

export type SessionModelUsageWireOutcome =
  | { kind: "valid"; result: SessionModelUsageResult }
  | { kind: "invalid"; detail: string }

export const SESSION_MODEL_USAGE_INVALID_DETAIL = "invalid private response shape"

export class SessionModelUsageValidationError extends Error {
  readonly kind = "private-session-model-usage-validation" as const
  readonly detail: string
  constructor(_detail: string) {
    super(SESSION_MODEL_USAGE_INVALID_DETAIL)
    this.name = "SessionModelUsageValidationError"
    this.detail = SESSION_MODEL_USAGE_INVALID_DETAIL
  }
}

export function isSessionModelUsageValidationError(v: unknown): v is SessionModelUsageValidationError {
  return (
    !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-session-model-usage-validation"
  )
}

export function normalizePrivateSessionModelUsageWire(
  raw: unknown,
  req: SessionModelUsageContractRequest,
): SessionModelUsageWireOutcome {
  try {
    const result = validateSessionModelUsageResult(raw, req)
    if (result.status === "failed") {
      const retryable = result.failure.retryable
      const fixed = { code: SESSION_MODEL_USAGE_FAILED_CODE, message: SESSION_MODEL_USAGE_FAILED_MESSAGE, retryable }
      const redacted: SessionModelUsageResult = {
        ...result,
        failure: fixed,
        outcome: { ...result.outcome, failure: fixed },
      }
      return { kind: "valid", result: redacted }
    }
    return { kind: "valid", result }
  } catch {
    return { kind: "invalid", detail: SESSION_MODEL_USAGE_INVALID_DETAIL }
  }
}

const MODEL_USAGE_RESULT_SUCCEEDED = new Set([
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
const MODEL_USAGE_RESULT_FAILED = new Set([
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
const MODEL_USAGE_RESULT_AMBIGUOUS = new Set([
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
const MODEL_USAGE_OUTCOME_PLAIN = new Set(["type", "time"])
const MODEL_USAGE_OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validateSessionModelUsageResult(
  raw: unknown,
  req: SessionModelUsageContractRequest,
): SessionModelUsageResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/model-usage") throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous")
    throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!isRecord(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number")
    throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const outRec = outcome as Record<string, unknown>
  if (status === "succeeded") {
    assertAllowedKeys(rec, MODEL_USAGE_RESULT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, MODEL_USAGE_OUTCOME_PLAIN, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["usage"])
    for (const k of Object.keys(data as Record<string, unknown>))
      if (!allowedData.has(k)) throw new Error("unexpected data field")
    // Shape-only projection validation. No freshness, ordering, or directory
    // binding is asserted here by design; the request directory/sessionId are
    // routing-only.
    validateSessionModelUsagePayload((data as Record<string, unknown>).usage)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as SessionModelUsageResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, MODEL_USAGE_RESULT_FAILED, "result")
    assertAllowedKeys(outRec, MODEL_USAGE_OUTCOME_FAILED, "outcome")
    const failure = validateSessionModelUsageFailure(rec.failure)
    const outFailure = validateSessionModelUsageFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as SessionModelUsageResult
  }
  assertAllowedKeys(rec, MODEL_USAGE_RESULT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, MODEL_USAGE_OUTCOME_PLAIN, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as SessionModelUsageResult
}

// Detached parity only (contract evidence, never production parity):
// compares ONLY the shared `sessionIDs`/`totals`/`models` projection for the
// same request. Order is never compared (`orderIgnored: true`); `sessionIDs`
// and `models` length/membership gaps are reported as
// `session-model-usage-membership-unknown`, never as a match. The request
// directory is never compared; only observed payload values are.
// eslint-disable-next-line complexity
export function compareSessionModelUsageParity(
  priv: SessionModelUsageResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
): { divergence: string | null; details: Record<string, unknown> } {
  const base = { orderIgnored: true }
  const privStatus: string = priv.status
  if (!!(priv as Record<string, unknown>).transportUnknown) {
    return { divergence: "transport-unknown", details: { privStatus, transportUnknown: true, ...base } }
  }
  const sdkError = sdk.error !== undefined && sdk.error !== null
  const sdkStatus: string = sdkError ? "failed" : "succeeded"
  if (sdkStatus !== privStatus) {
    return {
      divergence: `status-mismatch:sdk=${sdkStatus} priv=${privStatus}`,
      details: { sdkStatus, privStatus, ...base },
    }
  }
  if (sdkStatus === "succeeded" && privStatus === "succeeded") {
    const sdkPayload = (sdk.data ?? {}) as Record<string, unknown>
    const pdata = (priv as Extract<SessionModelUsageResult, { status: "succeeded" }>).data as Record<string, unknown>
    const privPayload = (pdata.usage ?? {}) as Record<string, unknown>
    try {
      validateSessionModelUsagePayload(sdkPayload)
    } catch {
      return { divergence: "session-model-usage-shape-mismatch", details: { ...base, mismatch: true } }
    }
    const sdkIds = [...((sdkPayload.sessionIDs ?? []) as string[])].sort()
    const privIds = [...((privPayload.sessionIDs ?? []) as string[])].sort()
    if (sdkIds.length !== privIds.length || sdkIds.some((id, i) => id !== (privIds[i] as string))) {
      return { divergence: "session-model-usage-membership-unknown", details: { ...base, mismatch: true } }
    }
    if (JSON.stringify(sdkPayload.totals) !== JSON.stringify(privPayload.totals)) {
      return {
        divergence: "session-model-usage-totals-mismatch",
        details: { ...base, mismatch: true, field: "totals" },
      }
    }
    const key = (m: Record<string, unknown>) => `${String(m.providerID)}::${String(m.modelID)}`
    const sdkModels = ((sdkPayload.models ?? []) as Record<string, unknown>[]).map((m) => ({
      k: key(m),
      v: JSON.stringify(m),
    }))
    const privModels = ((privPayload.models ?? []) as Record<string, unknown>[]).map((m) => ({
      k: key(m),
      v: JSON.stringify(m),
    }))
    const sdkKeys = sdkModels.map((m) => m.k).sort()
    const privKeys = privModels.map((m) => m.k).sort()
    if (sdkKeys.length !== privKeys.length || sdkKeys.some((k, i) => k !== privKeys[i])) {
      return { divergence: "session-model-usage-membership-unknown", details: { ...base, mismatch: true } }
    }
    const privByKey = new Map(privModels.map((m) => [m.k, m.v] as const))
    for (const m of sdkModels) {
      if (privByKey.get(m.k) !== m.v) {
        return {
          divergence: "session-model-usage-model-mismatch",
          details: { ...base, mismatch: true, field: "models" },
        }
      }
    }
    return { divergence: null, details: { ...base } }
  }
  return { divergence: null, details: { ...base } }
}
