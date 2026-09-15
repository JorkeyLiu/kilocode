// Private-first `sandbox/status` read-only observation contract (production).
// Request is strictly `{v:1,requestId,op:"sandbox/status",
// context:{directory,sessionId},payload:{}}` with no `opId`/`idempotencyKey`
// (observation identity is `requestId` only). Success data preserves the exact
// HTTP `GET /session/:sessionID/sandbox` shape from `SandboxPolicy.status`
// (`{directory,enabled,available,reason?,version}`); `available:false` is
// succeeded domain data, not failure.
//
// Source facts:
// - Route: `GET /session/:sessionID/sandbox` with `WorkspaceRoutingQuery` in
//   `packages/opencode/src/kilocode/server/httpapi/groups/sandbox.ts`
//   (`identifier: "sandbox.status"`, success `SandboxStatus`).
// - Handler: `packages/opencode/src/kilocode/server/httpapi/handlers/sandbox.ts`
//   `status` returns `SandboxPolicy.status(sessionID)` after an existence
//   guard. The FD handler invokes the same `SandboxPolicy.status` under the
//   same canonical directory + drain-control + `InstanceRef` lane.
// - Policy: `packages/opencode/src/kilocode/sandbox/policy.ts` `status`
//   (cold-read seed/store/cache via `snapshot`, exact shape; never `peek`).
// - Consumer: `KiloProvider.fetchAndSendSandboxStatus` is private-first via
//   `fetchSandboxStatusPrivateFirst`: validated success returns with zero SDK;
//   validated terminal (`validation.failed`/`scope_mismatch`/`session.not_found`,
//   `retryable === false`) closes with zero SDK; retryable fence
//   (`InstanceUnavailableDuringConfigRebuild`) plus `internal` (`retryable === true`)
//   plus unavailable/invalid/ambiguous/transport/closed/timeout takes exactly
//   one same-session/directory SDK `client.sandbox.status` fallback.
// - Distinct from `sandbox/set` (durable `sandbox-set:<sessionId>:<token>`
//   tuple), `sandbox/support`, and default reads. This contract never matches
//   those operations.
//
// ROUTING vs PAYLOAD SEMANTICS (v1):
// - `context.directory`/`context.sessionId` bind request routing and scope.
//   A scope match says nothing about payload freshness.
// - Payload is validated shape-only. No freshness, ordering, lifecycle, or
//   cross-directory claim is made.
// - Out of scope: `sandbox/set`, `sandbox/support`, default reads, SSE
//   authority, transport behavior beyond the fixed failure taxonomy.

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

export interface SandboxStatusData {
  directory: string
  enabled: boolean
  available: boolean
  reason?: string
  version: number
}

export interface SandboxStatusContractRequest {
  v: 1
  requestId: string
  op: "sandbox/status"
  context: { directory: string; sessionId: string }
  payload: Record<string, never>
}

export function validateSandboxStatusContractRequest(raw: unknown): SandboxStatusContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  clean(raw.requestId, "requestId")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must not carry path material")
  if (raw.op !== "sandbox/status") throw new Error("op must be sandbox/status")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  const ctxAllowed = new Set(["directory", "sessionId"])
  for (const k of Object.keys(ctx)) {
    if (!ctxAllowed.has(k)) throw new Error(`unexpected context field ${k}`)
  }
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (typeof ctx.sessionId !== "string" || !(ctx.sessionId as string).startsWith("ses"))
    throw new Error("context.sessionId must be SessionID")
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for sandbox-status")
  return raw as unknown as SandboxStatusContractRequest
}

const STATUS_FIELDS = new Set(["directory", "enabled", "available", "reason", "version"])

export function validateSandboxStatusData(raw: unknown): SandboxStatusData {
  if (!record(raw)) throw new Error("sandbox status must be object")
  for (const k of Object.keys(raw)) if (!STATUS_FIELDS.has(k)) throw new Error(`unexpected status field ${k}`)
  if (typeof raw.directory !== "string" || raw.directory.length === 0) throw new Error("sandbox status directory invalid")
  if (typeof raw.enabled !== "boolean") throw new Error("sandbox status enabled invalid")
  if (typeof raw.available !== "boolean") throw new Error("sandbox status available invalid")
  if (raw.reason !== undefined && typeof raw.reason !== "string") throw new Error("sandbox status reason invalid")
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || (raw.version as number) < 0)
    throw new Error("sandbox status version invalid")
  return raw as unknown as SandboxStatusData
}

export interface SandboxStatusFailure {
  code: string
  message: string
  retryable: boolean
}

export const SANDBOX_STATUS_FAILURE_CODES = new Set([
  "validation.failed",
  "scope_mismatch",
  "session.not_found",
  "InstanceUnavailableDuringConfigRebuild",
  "internal",
] as const)
export type SandboxStatusFailureCode =
  | "validation.failed"
  | "scope_mismatch"
  | "session.not_found"
  | "InstanceUnavailableDuringConfigRebuild"
  | "internal"
export const SANDBOX_STATUS_FAILURE_MESSAGES: Record<SandboxStatusFailureCode, string> = {
  "validation.failed": "invalid sandbox status request",
  scope_mismatch: "directory mismatch",
  "session.not_found": "session not found",
  InstanceUnavailableDuringConfigRebuild:
    "Instance is unavailable during config rebuild; no active runtime for this request",
  internal: "internal error",
}
export const SANDBOX_STATUS_FAILURE_RETRYABLE: Record<SandboxStatusFailureCode, boolean> = {
  "validation.failed": false,
  scope_mismatch: false,
  "session.not_found": false,
  InstanceUnavailableDuringConfigRebuild: true,
  internal: true,
}

export const SANDBOX_STATUS_TERMINAL_CODES = new Set(["validation.failed", "scope_mismatch", "session.not_found"])

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateSandboxStatusFailure(raw: unknown): SandboxStatusFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (!FAILURE_FIELDS.has(k)) throw new Error(`unexpected failure field ${k}`)
  }
  if (typeof raw.code !== "string" || !SANDBOX_STATUS_FAILURE_CODES.has(raw.code as SandboxStatusFailureCode))
    throw new Error("failure code must be a known sandbox-status category")
  const code = raw.code as SandboxStatusFailureCode
  if (raw.message !== SANDBOX_STATUS_FAILURE_MESSAGES[code])
    throw new Error("failure message must be the fixed message for its code")
  if (raw.retryable !== SANDBOX_STATUS_FAILURE_RETRYABLE[code])
    throw new Error("failure retryable must match its code")
  return raw as unknown as SandboxStatusFailure
}

export type SandboxStatusResult =
  | {
      v: 1
      requestId: string
      op: "sandbox/status"
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { status: SandboxStatusData }
    }
  | {
      v: 1
      requestId: string
      op: "sandbox/status"
      status: "failed"
      outcome: { type: "failed"; time: number; failure: SandboxStatusFailure }
      accepted: boolean
      failure: SandboxStatusFailure
    }
  | {
      v: 1
      requestId: string
      op: "sandbox/status"
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeSandboxStatusAmbiguous(req: SandboxStatusContractRequest, transportUnknown = true): SandboxStatusResult {
  const out: SandboxStatusResult = {
    v: 1,
    requestId: req.requestId,
    op: "sandbox/status",
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type SandboxStatusWireOutcome = { kind: "valid"; result: SandboxStatusResult } | { kind: "invalid"; detail: string }

export class SandboxStatusValidationError extends Error {
  readonly kind = "private-sandbox-status-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "SandboxStatusValidationError"
    this.detail = detail
  }
}

export function isSandboxStatusValidationError(v: unknown): v is SandboxStatusValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-sandbox-status-validation"
}

export function normalizePrivateSandboxStatusWire(
  raw: unknown,
  req: SandboxStatusContractRequest,
): SandboxStatusWireOutcome {
  try {
    const result = validateSandboxStatusResult(raw, req)
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
export function validateSandboxStatusResult(raw: unknown, req: SandboxStatusContractRequest): SandboxStatusResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.op !== "sandbox/status") throw new Error("op mismatch")
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
    const allowedData = new Set(["status"])
    for (const k of Object.keys(data)) if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    validateSandboxStatusData((data as Record<string, unknown>).status)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as SandboxStatusResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error(`unexpected outcome field ${k}`)
    const failure = validateSandboxStatusFailure(rec.failure)
    const outFailure = validateSandboxStatusFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as SandboxStatusResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error(`unexpected result field ${k}`)
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as SandboxStatusResult
}

export function isSettledSandboxStatusResult(result: unknown, req: SandboxStatusContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed") return false
  try {
    const out = validateSandboxStatusResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
