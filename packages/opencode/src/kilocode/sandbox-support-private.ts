import { Effect } from "effect"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import {
  acquireDrainControl,
  InstanceUnavailableDuringConfigRebuildError,
} from "@/kilocode/server/drain-control-acquire"
import { InstanceRef } from "@/effect/instance-ref"
import * as SandboxPolicy from "@/kilocode/sandbox/policy"

export const VERSION = 1 as const
export const OP = "sandbox/support" as const
export const CAPABILITY = "sandbox/support" as const

export interface SandboxSupportRequest {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  context: { directory: string; workspace?: string }
  payload: Record<string, never>
}

export interface SandboxSupportData {
  available: boolean
  reason?: string
}

export interface SandboxSupportFailure {
  code: string
  message: string
  retryable: boolean
}

export interface SandboxSupportSucceeded {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: SandboxSupportData
}

export interface SandboxSupportFailed {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "failed"
  outcome: { type: "failed"; time: number; failure: SandboxSupportFailure }
  accepted: false
  failure: SandboxSupportFailure
}

export interface SandboxSupportAmbiguous {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "ambiguous"
  outcome: { type: "ambiguous"; time: number }
  accepted: false
  transportUnknown?: boolean
}

export type SandboxSupportResult = SandboxSupportSucceeded | SandboxSupportFailed | SandboxSupportAmbiguous

export const VALIDATION_MESSAGE = "invalid sandbox support request"
export const SCOPE_MESSAGE = "directory mismatch"
export const FENCE_MESSAGE = "Instance is unavailable during config rebuild; no active runtime for this request"
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

export function validateSandboxSupportRequest(raw: unknown): SandboxSupportRequest {
  if (!record(raw)) throw new Error("params must be object")
  if (raw.v !== VERSION) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must be non-empty string without path material")
  if (raw.op !== OP) throw new Error("op must be sandbox/support")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  for (const k of Object.keys(ctx)) {
    if (k !== "directory" && k !== "workspace") throw new Error("unexpected context field")
  }
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory as string)
  if (ctx.workspace !== undefined) {
    if (typeof ctx.workspace !== "string" || ctx.workspace.length === 0 || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for sandbox support")
  for (const k of Object.keys(raw)) {
    if (!new Set(["v", "requestId", "op", "context", "payload"]).has(k)) throw new Error("unexpected field")
  }
  return raw as unknown as SandboxSupportRequest
}

type Ids = { requestId: string }

function sanitized(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !pathless(v)) return "unknown"
  return v
}

export function fallbackSandboxSupportIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId) }
}

export function safeSandboxSupportIds(req: { requestId: string }): Ids {
  return { requestId: sanitized(req.requestId) }
}

export function failed(ids: Ids, code: string, message: string, retryable: boolean): SandboxSupportFailed {
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

export function succeeded(req: SandboxSupportRequest, data: SandboxSupportData): SandboxSupportSucceeded {
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

export function validateSandboxSupportData(raw: unknown): SandboxSupportData {
  if (!record(raw)) throw new Error("support must be object")
  for (const k of Object.keys(raw)) {
    if (k !== "available" && k !== "reason") throw new Error("unexpected support field")
  }
  if (typeof raw.available !== "boolean") throw new Error("support available must be boolean")
  if (raw.reason !== undefined && typeof raw.reason !== "string") throw new Error("support reason must be string")
  return raw as unknown as SandboxSupportData
}

const RESULT_SUCCEEDED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "failure"])
const RESULT_AMBIGUOUS = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "transportUnknown"])
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])
const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

function checkFailure(raw: unknown): SandboxSupportFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as SandboxSupportFailure
}

export function validateSandboxSupportResult(raw: unknown, req: SandboxSupportRequest): SandboxSupportResult {
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
    validateSandboxSupportData(rec.data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (out.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as SandboxSupportSucceeded
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(out)) if (!OUTCOME_FAILED.has(k)) throw new Error("unexpected outcome field")
    const failure = checkFailure(rec.failure)
    const outFailure = checkFailure(out.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as SandboxSupportFailed
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(out)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (out.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as SandboxSupportAmbiguous
}

export function isSettledSandboxSupportResult(result: unknown, req: SandboxSupportRequest): boolean {
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

// Private `sandbox/support`: sessionless directory-scoped read of the same
// canonical `SandboxPolicy.configuredSupport` owner as `GET /sandbox/support`
// (same effective config projection, exact `{available,reason?}` shape).
// Routing follows the existing drain-control + `InstanceRef` lane; no session
// existence, SandboxStore, preference, status version/event, second
// layer/store, persistence/journal, or new fence. `available:false` with an
// optional reason is succeeded domain data. Internal/defect stays retryable
// (fallback-eligible), never synthesized terminal.
export const supportSandboxPrivate = Effect.fn("SandboxSupportPrivate.read")(function* (raw: unknown) {
  let req: SandboxSupportRequest
  try {
    req = validateSandboxSupportRequest(raw)
  } catch {
    return failed(fallbackSandboxSupportIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeSandboxSupportIds(req)
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
      if (fence)
        return Effect.succeed({
          tag: "fail" as const,
          result: failed(safe, "InstanceUnavailableDuringConfigRebuild", FENCE_MESSAGE, true),
        })
      return Effect.succeed({ tag: "fail" as const, result: failed(safe, "internal", INTERNAL_MESSAGE, true) })
    }),
    Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const, result: failed(safe, "internal", INTERNAL_MESSAGE, true) })),
  )
  if (acquired.tag !== "ok") return acquired.result
  const inner = Effect.gen(function* () {
    let stored: string
    try {
      stored = canonicalDirectory(acquired.value.ctx.directory)
    } catch {
      return failed(safe, "internal", INTERNAL_MESSAGE, true)
    }
    if (stored !== dir) return failed(safe, "scope_mismatch", SCOPE_MESSAGE, false)
    const out = yield* SandboxPolicy.configuredSupport().pipe(
      Effect.map((v) => ({ tag: "ok" as const, value: v })),
      Effect.catch(() => Effect.succeed({ tag: "fail" as const })),
      Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const })),
    )
    if (out.tag !== "ok") return failed(safe, "internal", INTERNAL_MESSAGE, true)
    try {
      const data = validateSandboxSupportData(out.value)
      return succeeded(req, data)
    } catch {
      return failed(safe, "internal", INTERNAL_MESSAGE, true)
    }
  }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
  return yield* inner.pipe(
    Effect.catch(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, true))),
    Effect.catchDefect(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, true))),
  )
})
