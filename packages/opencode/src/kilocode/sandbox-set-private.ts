import { Effect, Schema } from "effect"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import {
  acquireDrainControl,
  InstanceUnavailableDuringConfigRebuildError,
} from "@/kilocode/server/drain-control-acquire"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import * as SandboxActivation from "@/kilocode/sandbox/activation"
import * as SandboxPolicy from "@/kilocode/sandbox/policy"
import { BackgroundProcess } from "@/kilocode/background-process"
import { InteractiveTerminal } from "@/kilocode/interactive-terminal"
import { Service as Notebook } from "@/kilocode/notebook/service"

export const VERSION = 1 as const
export const OP = "sandbox/set" as const
export const CAPABILITY = "sandbox/set" as const

export interface SandboxSetRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  context: { directory: string; sessionId: string }
  payload: { enabled: boolean; sessionId: string }
}

export interface SandboxSetFailure {
  code: string
  message: string
  retryable: boolean
}

export interface SandboxSetSucceeded {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { status: { directory: string; enabled: boolean; available: boolean; version: number } }
}

export interface SandboxSetFailed {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  status: "failed"
  outcome: { type: "failed"; time: number; failure: SandboxSetFailure }
  accepted: false
  failure: SandboxSetFailure
}

export type SandboxSetResult = SandboxSetSucceeded | SandboxSetFailed

export const VALIDATION_MESSAGE = "invalid sandbox set request"
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

export function canonicalSandboxSetOpId(sessionId: string, token: string): string {
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("sessionId must be non-empty string")
  if (typeof token !== "string" || token.length === 0) throw new Error("token must be non-empty string")
  if (token.includes(":")) throw new Error("token must not contain ':'")
  if (!pathless(token)) throw new Error("token must not carry path material")
  return `sandbox-set:${sessionId}:${token}`
}

export function parseSandboxSetOpId(opId: string): { sessionId: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new Error("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 3 || segs[0] !== "sandbox-set" || segs[1]!.length === 0 || segs[2]!.length === 0)
    throw new Error("opId must be sandbox-set:<sessionId>:<token> with nonempty colon-free token")
  const token = segs[2]!
  if (!pathless(token)) throw new Error("opId must be sandbox-set:<sessionId>:<token> with nonempty colon-free token")
  return { sessionId: segs[1]!, token }
}

export function validateSandboxSetRequest(raw: unknown): SandboxSetRequest {
  if (!record(raw)) throw new Error("params must be object")
  if (raw.v !== VERSION) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!present(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== OP) throw new Error("op must be sandbox/set")
  if (!present(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for sandbox set")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must be non-empty string without path material")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  for (const k of Object.keys(ctx)) if (k !== "directory" && k !== "sessionId") throw new Error("unexpected context field")
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0) throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory as string)
  if (typeof ctx.sessionId !== "string" || !Schema.is(SessionID)(ctx.sessionId)) throw new Error("context.sessionId must be SessionID")
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  for (const k of Object.keys(payload)) if (k !== "enabled" && k !== "sessionId") throw new Error("unexpected payload field")
  if (typeof payload.enabled !== "boolean") throw new Error("payload.enabled must be boolean")
  if (typeof payload.sessionId !== "string" || !Schema.is(SessionID)(payload.sessionId)) throw new Error("payload.sessionId must be SessionID")
  if (payload.sessionId !== ctx.sessionId) throw new Error("payload.sessionId must equal context.sessionId")
  for (const k of Object.keys(raw)) if (!new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"]).has(k)) throw new Error("unexpected field")
  const parsed = parseSandboxSetOpId(raw.opId as string)
  const idem = parseSandboxSetOpId(raw.idempotencyKey as string)
  if (idem.token !== parsed.token || idem.sessionId !== parsed.sessionId) throw new Error("idempotencyKey token must equal opId token")
  if (parsed.sessionId !== (ctx.sessionId as string)) throw new Error("opId sessionId must equal context.sessionId")
  return raw as unknown as SandboxSetRequest
}

type Ids = { requestId: string; opId: string; idempotencyKey: string }

function sanitized(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !pathless(v)) return "unknown"
  return v
}

export function fallbackSandboxSetIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId), opId: sanitized(o.opId), idempotencyKey: sanitized(o.idempotencyKey) }
}

export function safeSandboxSetIds(req: { requestId: string; opId: string; idempotencyKey: string }): Ids {
  return { requestId: sanitized(req.requestId), opId: sanitized(req.opId), idempotencyKey: sanitized(req.idempotencyKey) }
}

export function failed(ids: Ids, code: string, message: string, retryable: boolean): SandboxSetFailed {
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

export function succeeded(req: SandboxSetRequest, status: { directory: string; enabled: boolean; available: boolean; version: number }): SandboxSetSucceeded {
  return {
    v: VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: OP,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { status },
  }
}

const RESULT_SUCCEEDED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "failure"])
const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

function checkFailure(raw: unknown): SandboxSetFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as SandboxSetFailure
}

export function validateSandboxSetResult(raw: unknown, req: SandboxSetRequest): SandboxSetResult {
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
  if (!record(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number") throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const out = outcome as Record<string, unknown>
  if (status === "succeeded") {
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error("unexpected result field")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    for (const k of Object.keys(data)) if (k !== "status") throw new Error("unexpected data field")
    const st = (data as Record<string, unknown>).status
    if (!record(st)) throw new Error("succeeded data.status must be object")
    for (const k of Object.keys(st)) if (!new Set(["directory", "enabled", "available", "version"]).has(k)) throw new Error("unexpected status field")
    if (typeof st.directory !== "string" || typeof st.enabled !== "boolean" || typeof st.available !== "boolean" || typeof st.version !== "number")
      throw new Error("succeeded data.status invalid")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (out.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as SandboxSetSucceeded
  }
  for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error("unexpected result field")
  const failure = checkFailure(rec.failure)
  const outFailure = checkFailure(out.failure)
  if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
  if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
  if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
  if (rec.data !== undefined) throw new Error("failed must not have data")
  return raw as unknown as SandboxSetFailed
}

export const setSandboxPrivate = Effect.fn("SandboxSetPrivate.set")(function* (raw: unknown) {
  let req: SandboxSetRequest
  try {
    req = validateSandboxSetRequest(raw)
  } catch {
    return failed(fallbackSandboxSetIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeSandboxSetIds(req)
  let dir: string
  try {
    dir = canonicalDirectory(req.context.directory)
  } catch {
    return failed(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  const sid = req.context.sessionId as never as import("@/session/schema").SessionID
  const target = req.payload.enabled
  const acquired = yield* acquireDrainControl(dir).pipe(
    Effect.map((v) => ({ tag: "ok" as const, value: v })),
    Effect.catch((err: unknown) => {
      const fence =
        err instanceof InstanceUnavailableDuringConfigRebuildError ||
        (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
      if (fence) return Effect.succeed({ tag: "fail" as const, result: failed(safe, "InstanceUnavailableDuringConfigRebuild", FENCE_MESSAGE, true) })
      return Effect.succeed({ tag: "fail" as const, result: failed(safe, "internal", INTERNAL_MESSAGE, false) })
    }),
    Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const, result: failed(safe, "internal", INTERNAL_MESSAGE, false) })),
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
    const sessions = yield* Session.Service
    const notebook = yield* Notebook
    const exists = Effect.mapError(sessions.get(sid), () => failed(safe, "session.not_found", "session not found", false))
    const got = yield* exists.pipe(
      Effect.map((v) => ({ tag: "ok" as const, value: v })),
      Effect.catch((f) => Effect.succeed({ tag: "fail" as const, result: f as SandboxSetFailed })),
    )
    if (got.tag !== "ok") return got.result
    const guard = (enabling: boolean, family: readonly SandboxPolicy.Target[]) =>
      enabling
        ? Effect.gen(function* () {
            if (!(yield* SandboxActivation.idle(sid, family))) return yield* Effect.fail(failed(safe, "session.busy", "Stop the active session and its subagents before enabling sandbox confinement", false))
            const stopped = yield* Effect.all(
              [
                Effect.promise(() => BackgroundProcess.stopSession(sid)),
                Effect.promise(() => InteractiveTerminal.stopSession(sid)),
                notebook.cancelSession(sid),
              ],
              { discard: true },
            ).pipe(
              Effect.map(() => ({ tag: "ok" as const })),
              Effect.catch(() => Effect.succeed({ tag: "fail" as const })),
              Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const })),
            )
            if (stopped.tag !== "ok") return yield* Effect.fail(failed(safe, "internal", INTERNAL_MESSAGE, false))
          })
        : Effect.void
    const family = SandboxActivation.family(sid)
    const preflight = (fam: readonly SandboxPolicy.Target[]) =>
      Effect.gen(function* () {
        const cur = yield* Effect.mapError(sessions.get(sid), () => failed(safe, "session.not_found", "session not found", false))
        void cur
        if (!(yield* SandboxActivation.idle(sid, fam))) return yield* Effect.fail(failed(safe, "session.busy", "Stop the active session and its subagents before enabling sandbox confinement", false))
      })
    const out = yield* SandboxPolicy.setGuarded(sid, target, guard, family, preflight).pipe(
      Effect.map((v) => ({ tag: "ok" as const, value: v })),
      Effect.catch((e) => {
        if (record(e) && (e as Record<string, unknown>).status === "failed") return Effect.succeed({ tag: "fail" as const, result: e as unknown as SandboxSetFailed })
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes("Stop the active session")) return Effect.succeed({ tag: "fail" as const, result: failed(safe, "session.busy", msg.slice(0, 200), false) })
        if (msg.includes("unavailable during config rebuild") || msg.includes("InstanceUnavailableDuringConfigRebuild")) return Effect.succeed({ tag: "fail" as const, result: failed(safe, "InstanceUnavailableDuringConfigRebuild", FENCE_MESSAGE, true) })
        return Effect.succeed({ tag: "fail" as const, result: failed(safe, "internal", INTERNAL_MESSAGE, false) })
      }),
      Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const, result: failed(safe, "internal", INTERNAL_MESSAGE, false) })),
    )
    if (out.tag !== "ok") return out.result
    const st = out.value as { directory: string; enabled: boolean; available: boolean; version: number }
    return succeeded(req, { directory: st.directory, enabled: st.enabled, available: st.available, version: st.version })
  }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
  return yield* inner.pipe(
    Effect.catch(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, false))),
    Effect.catchDefect(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, false))),
  )
})
