import { Effect, Schema } from "effect"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import {
  acquireDrainControl,
  InstanceUnavailableDuringConfigRebuildError,
} from "@/kilocode/server/drain-control-acquire"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import * as SandboxPolicy from "@/kilocode/sandbox/policy"

export const VERSION = 1 as const
export const OP = "sandbox/status" as const
export const CAPABILITY = "sandbox/status" as const

export interface SandboxStatusRequest {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  context: { directory: string; sessionId: string }
  payload: Record<string, never>
}

export interface SandboxStatusFailure {
  code: string
  message: string
  retryable: boolean
}

export interface SandboxStatusSucceeded {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { status: { directory: string; enabled: boolean; available: boolean; reason?: string; version: number } }
}

export interface SandboxStatusFailed {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "failed"
  outcome: { type: "failed"; time: number; failure: SandboxStatusFailure }
  accepted: false
  failure: SandboxStatusFailure
}

export interface SandboxStatusAmbiguous {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "ambiguous"
  outcome: { type: "ambiguous"; time: number }
  accepted: false
  transportUnknown?: boolean
}

export type SandboxStatusResult = SandboxStatusSucceeded | SandboxStatusFailed | SandboxStatusAmbiguous

export const VALIDATION_MESSAGE = "invalid sandbox status request"
export const SCOPE_MESSAGE = "directory mismatch"
export const NOT_FOUND_MESSAGE = "session not found"
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

export function validateSandboxStatusRequest(raw: unknown): SandboxStatusRequest {
  if (!record(raw)) throw new Error("params must be object")
  if (raw.v !== VERSION) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must be non-empty string without path material")
  if (raw.op !== OP) throw new Error("op must be sandbox/status")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  for (const k of Object.keys(ctx)) if (k !== "directory" && k !== "sessionId") throw new Error("unexpected context field")
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0) throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory as string)
  if (typeof ctx.sessionId !== "string" || !Schema.is(SessionID)(ctx.sessionId)) throw new Error("context.sessionId must be SessionID")
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for sandbox status")
  for (const k of Object.keys(raw)) if (!new Set(["v", "requestId", "op", "context", "payload"]).has(k)) throw new Error("unexpected field")
  return raw as unknown as SandboxStatusRequest
}

type Ids = { requestId: string }

function sanitized(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !pathless(v)) return "unknown"
  return v
}

export function fallbackSandboxStatusIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId) }
}

export function safeSandboxStatusIds(req: { requestId: string }): Ids {
  return { requestId: sanitized(req.requestId) }
}

export function failed(ids: Ids, code: string, message: string, retryable: boolean): SandboxStatusFailed {
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
  req: SandboxStatusRequest,
  status: { directory: string; enabled: boolean; available: boolean; reason?: string; version: number },
): SandboxStatusSucceeded {
  return {
    v: VERSION,
    requestId: req.requestId,
    op: OP,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { status },
  }
}

function checkStatus(raw: unknown): { directory: string; enabled: boolean; available: boolean; reason?: string; version: number } {
  if (!record(raw)) throw new Error("status must be object")
  for (const k of Object.keys(raw)) {
    if (!new Set(["directory", "enabled", "available", "reason", "version"]).has(k)) throw new Error("unexpected status field")
  }
  if (typeof raw.directory !== "string" || raw.directory.length === 0) throw new Error("status directory invalid")
  if (typeof raw.enabled !== "boolean") throw new Error("status enabled invalid")
  if (typeof raw.available !== "boolean") throw new Error("status available invalid")
  if (raw.reason !== undefined && typeof raw.reason !== "string") throw new Error("status reason invalid")
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || (raw.version as number) < 0)
    throw new Error("status version invalid")
  return raw as unknown as { directory: string; enabled: boolean; available: boolean; reason?: string; version: number }
}

const RESULT_SUCCEEDED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "failure"])
const RESULT_AMBIGUOUS = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "transportUnknown"])
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])
const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

function checkFailure(raw: unknown): SandboxStatusFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as SandboxStatusFailure
}

export function validateSandboxStatusResult(raw: unknown, req: SandboxStatusRequest): SandboxStatusResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== VERSION) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.op !== OP) throw new Error("op mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous") throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!record(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number") throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const out = outcome as Record<string, unknown>
  if (status === "succeeded") {
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(out)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    for (const k of Object.keys(data)) if (k !== "status") throw new Error("unexpected data field")
    checkStatus((data as Record<string, unknown>).status)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (out.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as SandboxStatusSucceeded
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
    return raw as unknown as SandboxStatusFailed
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(out)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean") throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (out.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as SandboxStatusAmbiguous
}

export function isSettledSandboxStatusResult(result: unknown, req: SandboxStatusRequest): boolean {
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

export const statusSandboxPrivate = Effect.fn("SandboxStatusPrivate.read")(function* (raw: unknown) {
  let req: SandboxStatusRequest
  try {
    req = validateSandboxStatusRequest(raw)
  } catch {
    return failed(fallbackSandboxStatusIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeSandboxStatusIds(req)
  let dir: string
  try {
    dir = canonicalDirectory(req.context.directory)
  } catch {
    return failed(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  const sid = req.context.sessionId as never as import("@/session/schema").SessionID
  const acquired = yield* acquireDrainControl(dir).pipe(
    Effect.map((v) => ({ tag: "ok" as const, value: v })),
    Effect.catch((err: unknown) => {
      const fence =
        err instanceof InstanceUnavailableDuringConfigRebuildError ||
        (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
      if (fence) return Effect.succeed({ tag: "fail" as const, result: failed(safe, "InstanceUnavailableDuringConfigRebuild", FENCE_MESSAGE, true) })
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
    const sessions = yield* Session.Service
    const got = yield* sessions.get(sid).pipe(
      Effect.map((v) => ({ tag: "ok" as const, value: v })),
      Effect.catch((err: unknown) => {
        const missing = err instanceof NotFoundError || (err as { _tag?: string })?._tag === "NotFoundError"
        if (missing) return Effect.succeed({ tag: "fail" as const, result: failed(safe, "session.not_found", NOT_FOUND_MESSAGE, false) })
        return Effect.succeed({ tag: "fail" as const, result: failed(safe, "internal", INTERNAL_MESSAGE, true) })
      }),
      Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const, result: failed(safe, "internal", INTERNAL_MESSAGE, true) })),
    )
    if (got.tag !== "ok") return got.result
    let sessionDir: string
    try {
      sessionDir = canonicalDirectory(got.value.directory)
    } catch {
      return failed(safe, "internal", INTERNAL_MESSAGE, true)
    }
    if (sessionDir !== dir) return failed(safe, "scope_mismatch", SCOPE_MESSAGE, false)
    const out = yield* SandboxPolicy.status(sid).pipe(
      Effect.map((v) => ({ tag: "ok" as const, value: v })),
      Effect.catch(() => Effect.succeed({ tag: "fail" as const })),
      Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const })),
    )
    if (out.tag !== "ok") return failed(safe, "internal", INTERNAL_MESSAGE, true)
    try {
      const st = checkStatus(out.value)
      return succeeded(req, st)
    } catch {
      return failed(safe, "internal", INTERNAL_MESSAGE, true)
    }
  }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
  return yield* inner.pipe(
    Effect.catch(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, true))),
    Effect.catchDefect(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, true))),
  )
})
