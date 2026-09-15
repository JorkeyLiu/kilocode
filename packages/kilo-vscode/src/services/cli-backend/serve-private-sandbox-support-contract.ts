// Private-first `sandbox/support` sessionless directory-scoped read contract (production).
// Request is strictly `{v:1,requestId,op:"sandbox/support",
// context:{directory,workspace?},payload:{}}` with no `opId`/`idempotencyKey`
// (observation identity is `requestId` only). Success data preserves the exact
// HTTP `GET /sandbox/support` shape from `SandboxPolicy.configuredSupport`
// (`{available,reason?}`); `available:false` is succeeded domain data, not failure.
//
// Source facts:
// - Route: `GET /sandbox/support` with `WorkspaceRoutingQuery` in
//   `packages/opencode/src/kilocode/server/httpapi/groups/sandbox.ts`
//   (`identifier: "sandbox.support"`, success `SandboxSupport`).
// - Handler: `packages/opencode/src/kilocode/server/httpapi/handlers/sandbox.ts`
//   `support` returns `SandboxPolicy.configuredSupport()` with no session.
//   The FD handler invokes the same `SandboxPolicy.configuredSupport` under the
//   same canonical directory + drain-control + `InstanceRef` lane.
// - Policy: `packages/opencode/src/kilocode/sandbox/policy.ts`
//   `configuredSupport` (effective config projection, exact shape).
// - Consumers: `KiloProvider.fetchAndSendSandboxDefault` and
//   `KiloProvider.handleSetSandboxDefault` are private-first via
//   `fetchSandboxSupportPrivateFirst`: validated success returns with zero SDK;
//   validated terminal (`validation.failed`/`scope_mismatch`,
//   `retryable === false`) closes with zero SDK; retryable fence
//   (`InstanceUnavailableDuringConfigRebuild`) plus `internal` (`retryable === true`)
//   plus unavailable/invalid/ambiguous/transport/closed/timeout takes exactly
//   one same-directory SDK `client.sandbox.support` fallback.
// - Distinct from `sandbox/set`, `sandbox/status`, and default reads. This contract never matches
//   those operations.
//
// ROUTING vs PAYLOAD SEMANTICS (v1):
// - `context.directory`/`context.workspace` bind request routing and scope.
//   A scope match says nothing about payload freshness.
// - Payload is validated shape-only. No freshness, ordering, lifecycle, or
//   cross-directory claim is made.
// - Out of scope: `sandbox/set`, `sandbox/status`, default reads, SSE
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

export interface SandboxSupportData {
  available: boolean
  reason?: string
}

export interface SandboxSupportContractRequest {
  v: 1
  requestId: string
  op: "sandbox/support"
  context: { directory: string; workspace?: string }
  payload: Record<string, never>
}

export function validateSandboxSupportContractRequest(raw: unknown): SandboxSupportContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  clean(raw.requestId, "requestId")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must not carry path material")
  if (raw.op !== "sandbox/support") throw new Error("op must be sandbox/support")
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
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for sandbox-support")
  return raw as unknown as SandboxSupportContractRequest
}

const SUPPORT_FIELDS = new Set(["available", "reason"])

export function validateSandboxSupportData(raw: unknown): SandboxSupportData {
  if (!record(raw)) throw new Error("sandbox support must be object")
  for (const k of Object.keys(raw)) if (!SUPPORT_FIELDS.has(k)) throw new Error(`unexpected support field ${k}`)
  if (typeof raw.available !== "boolean") throw new Error("sandbox support available invalid")
  if (raw.reason !== undefined && typeof raw.reason !== "string") throw new Error("sandbox support reason invalid")
  return raw as unknown as SandboxSupportData
}

export interface SandboxSupportFailure {
  code: string
  message: string
  retryable: boolean
}

export const SANDBOX_SUPPORT_FAILURE_CODES = new Set([
  "validation.failed",
  "scope_mismatch",
  "InstanceUnavailableDuringConfigRebuild",
  "internal",
] as const)
export type SandboxSupportFailureCode =
  | "validation.failed"
  | "scope_mismatch"
  | "InstanceUnavailableDuringConfigRebuild"
  | "internal"
export const SANDBOX_SUPPORT_FAILURE_MESSAGES: Record<SandboxSupportFailureCode, string> = {
  "validation.failed": "invalid sandbox support request",
  scope_mismatch: "directory mismatch",
  InstanceUnavailableDuringConfigRebuild:
    "Instance is unavailable during config rebuild; no active runtime for this request",
  internal: "internal error",
}
export const SANDBOX_SUPPORT_FAILURE_RETRYABLE: Record<SandboxSupportFailureCode, boolean> = {
  "validation.failed": false,
  scope_mismatch: false,
  InstanceUnavailableDuringConfigRebuild: true,
  internal: true,
}

export const SANDBOX_SUPPORT_TERMINAL_CODES = new Set(["validation.failed", "scope_mismatch"])

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateSandboxSupportFailure(raw: unknown): SandboxSupportFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (!FAILURE_FIELDS.has(k)) throw new Error(`unexpected failure field ${k}`)
  }
  if (typeof raw.code !== "string" || !SANDBOX_SUPPORT_FAILURE_CODES.has(raw.code as SandboxSupportFailureCode))
    throw new Error("failure code must be a known sandbox-support category")
  const code = raw.code as SandboxSupportFailureCode
  if (raw.message !== SANDBOX_SUPPORT_FAILURE_MESSAGES[code])
    throw new Error("failure message must be the fixed message for its code")
  if (raw.retryable !== SANDBOX_SUPPORT_FAILURE_RETRYABLE[code])
    throw new Error("failure retryable must match its code")
  return raw as unknown as SandboxSupportFailure
}

export type SandboxSupportResult =
  | {
      v: 1
      requestId: string
      op: "sandbox/support"
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: SandboxSupportData
    }
  | {
      v: 1
      requestId: string
      op: "sandbox/support"
      status: "failed"
      outcome: { type: "failed"; time: number; failure: SandboxSupportFailure }
      accepted: boolean
      failure: SandboxSupportFailure
    }
  | {
      v: 1
      requestId: string
      op: "sandbox/support"
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeSandboxSupportAmbiguous(req: SandboxSupportContractRequest, transportUnknown = true): SandboxSupportResult {
  const out: SandboxSupportResult = {
    v: 1,
    requestId: req.requestId,
    op: "sandbox/support",
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type SandboxSupportWireOutcome = { kind: "valid"; result: SandboxSupportResult } | { kind: "invalid"; detail: string }

export class SandboxSupportValidationError extends Error {
  readonly kind = "private-sandbox-support-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "SandboxSupportValidationError"
    this.detail = detail
  }
}

export function isSandboxSupportValidationError(v: unknown): v is SandboxSupportValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-sandbox-support-validation"
}

export function normalizePrivateSandboxSupportWire(
  raw: unknown,
  req: SandboxSupportContractRequest,
): SandboxSupportWireOutcome {
  try {
    const result = validateSandboxSupportResult(raw, req)
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
export function validateSandboxSupportResult(raw: unknown, req: SandboxSupportContractRequest): SandboxSupportResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.op !== "sandbox/support") throw new Error("op mismatch")
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
    validateSandboxSupportData(rec.data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as SandboxSupportResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error(`unexpected outcome field ${k}`)
    const failure = validateSandboxSupportFailure(rec.failure)
    const outFailure = validateSandboxSupportFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as SandboxSupportResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error(`unexpected result field ${k}`)
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as SandboxSupportResult
}

export function isSettledSandboxSupportResult(result: unknown, req: SandboxSupportContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed") return false
  try {
    const out = validateSandboxSupportResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
