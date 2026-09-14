import { Effect } from "effect"
import { BackgroundProcess } from "@/kilocode/background-process"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import {
  acquireDrainControl,
  InstanceUnavailableDuringConfigRebuildError,
} from "@/kilocode/server/drain-control-acquire"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"

export const VERSION = 1 as const
export const OP = "background-process/stop-session" as const
export const CAPABILITY = "background-process/stop-session" as const

export interface BackgroundStopSessionRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
  }
  payload: Record<string, never>
}

export interface BackgroundStopSessionFailure {
  code: string
  message: string
  retryable: boolean
}

export interface BackgroundStopSessionSucceeded {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { stopped: true }
}

export interface BackgroundStopSessionFailed {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  status: "failed"
  outcome: { type: "failed"; time: number; failure: BackgroundStopSessionFailure }
  accepted: false
  failure: BackgroundStopSessionFailure
}

export type BackgroundStopSessionResult = BackgroundStopSessionSucceeded | BackgroundStopSessionFailed

export const VALIDATION_MESSAGE = "invalid background stop-session request"
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

export function canonicalBackgroundStopSessionOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new Error("token must be non-empty string")
  if (token.includes(":")) throw new Error("token must not contain ':'")
  if (!pathless(token)) throw new Error("token must not carry path material")
  return `background-process-stop-session:${token}`
}

export function parseBackgroundStopSessionOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new Error("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "background-process-stop-session" || segs[1]!.length === 0)
    throw new Error("opId must be background-process-stop-session:<token> with nonempty colon-free token")
  const token = segs[1]!
  if (!pathless(token))
    throw new Error("opId must be background-process-stop-session:<token> with nonempty colon-free token")
  return { token }
}

export function validateBackgroundStopSessionRequest(raw: unknown): BackgroundStopSessionRequest {
  if (!record(raw)) throw new Error("params must be object")
  if (raw.v !== VERSION) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!present(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== OP) throw new Error("op must be background-process/stop-session")
  if (!present(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for background stop-session")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must be non-empty string without path material")
  if (!pathless(raw.idempotencyKey as string))
    throw new Error("idempotencyKey must be non-empty string without path material")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "sessionId"])
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error("unexpected context field")
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  if (typeof ctx.sessionId !== "string" || !Schema.is(SessionID)(ctx.sessionId))
    throw new Error("context.sessionId must be SessionID")
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for background stop-session")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  const parsed = parseBackgroundStopSessionOpId(raw.opId as string)
  const idem = parseBackgroundStopSessionOpId(raw.idempotencyKey as string)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as BackgroundStopSessionRequest
}

type Ids = { requestId: string; opId: string; idempotencyKey: string }

function sanitized(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !pathless(v)) return "unknown"
  return v
}

export function fallbackBackgroundStopSessionIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId), opId: sanitized(o.opId), idempotencyKey: sanitized(o.idempotencyKey) }
}

export function safeBackgroundStopSessionIds(req: { requestId: string; opId: string; idempotencyKey: string }): Ids {
  return {
    requestId: sanitized(req.requestId),
    opId: sanitized(req.opId),
    idempotencyKey: sanitized(req.idempotencyKey),
  }
}

export function failed(ids: Ids, code: string, message: string, retryable: boolean): BackgroundStopSessionFailed {
  const failure = { code, message, retryable }
  return {
    v: VERSION,
    requestId: ids.requestId,
    opId: ids.opId,
    op: OP,
    idempotencyKey: ids.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure },
    accepted: false,
    failure,
  }
}

export function succeeded(req: BackgroundStopSessionRequest): BackgroundStopSessionSucceeded {
  return {
    v: VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: OP,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { stopped: true },
  }
}

const RESULT_SUCCEEDED = new Set([
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
const RESULT_FAILED = new Set([
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
const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

function checkFailure(raw: unknown): BackgroundStopSessionFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as BackgroundStopSessionFailure
}

export function validateBackgroundStopSessionResult(
  raw: unknown,
  req: BackgroundStopSessionRequest,
): BackgroundStopSessionResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== VERSION) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== OP) throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed") throw new Error("status must be succeeded/failed")
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
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    for (const k of Object.keys(data)) if (k !== "stopped") throw new Error("unexpected data field")
    if (data.stopped !== true) throw new Error("succeeded data.stopped must be true")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (out.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as BackgroundStopSessionSucceeded
  }
  for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error("unexpected result field")
  const failure = checkFailure(rec.failure)
  const outFailure = checkFailure(out.failure)
  if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
  if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
  if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
  if (rec.data !== undefined) throw new Error("failed must not have data")
  return raw as unknown as BackgroundStopSessionFailed
}

// Private `background-process/stop-session`: the same session-scoped cleanup
// as the HTTP `backgroundProcess.stopSession` route — `BackgroundProcess.
// stopSession(sessionID)` under the existing drain-control + `InstanceRef`
// lane (canonical routing directory, scope_mismatch on stored drift, fence
// retryable, no journal/replay/new fence). Stopping is idempotent (second
// call is a no-op), so an ambiguous transport outcome may safely repeat via
// the same-identity SDK `backgroundProcess.stopSession` fallback.
export const stopSessionProcessesPrivate = Effect.fn("BackgroundStopSessionPrivate.stop")(function* (raw: unknown) {
  let req: BackgroundStopSessionRequest
  try {
    req = validateBackgroundStopSessionRequest(raw)
  } catch {
    return failed(fallbackBackgroundStopSessionIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeBackgroundStopSessionIds(req)
  let dir: string
  try {
    dir = canonicalDirectory(req.context.directory)
  } catch {
    return failed(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  let sid: string
  try {
    if (!Schema.is(SessionID)(req.context.sessionId)) throw new Error("bad session")
    sid = req.context.sessionId
  } catch {
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
      return Effect.succeed({ tag: "fail" as const, result: failed(safe, "internal", INTERNAL_MESSAGE, false) })
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
    const out = yield* Effect.promise(() => BackgroundProcess.stopSession(sid as never)).pipe(
      Effect.map(() => ({ tag: "ok" as const })),
      Effect.catch(() => Effect.succeed({ tag: "fail" as const })),
      Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const })),
    )
    if (out.tag === "ok") return succeeded(req)
    return failed(safe, "internal", INTERNAL_MESSAGE, false)
  }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
  return yield* inner.pipe(
    Effect.catch(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, false))),
    Effect.catchDefect(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, false))),
  )
})
