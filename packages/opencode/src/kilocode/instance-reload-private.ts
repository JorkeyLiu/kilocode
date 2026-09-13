import { Effect, Option } from "effect"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { SessionStatus } from "@/session/status"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { ControlLease } from "@/kilocode/server/control-lease"
import { hasActiveSession } from "@/kilocode/server/httpapi/handlers/instance-reload"

export const VERSION = 1 as const
export const OP = "instance/reload" as const
export const CAPABILITY = "instance/reload" as const

export interface InstanceReloadRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
}

export interface InstanceReloadFailure {
  code: string
  message: string
  retryable: boolean
}

export interface InstanceReloadSucceeded {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { reloaded: true }
}

export interface InstanceReloadFailed {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  status: "failed"
  outcome: { type: "failed"; time: number; failure: InstanceReloadFailure }
  accepted: false
  failure: InstanceReloadFailure
}

export type InstanceReloadResult = InstanceReloadSucceeded | InstanceReloadFailed

export const VALIDATION_MESSAGE = "invalid instance-reload request"
export const CONFLICT_MESSAGE =
  "Cannot reload while a session is running. Wait for it to finish or abort it first."
export const SCOPE_MESSAGE = "directory mismatch"
export const FENCE_MESSAGE =
  "Instance is unavailable during config rebuild; no active runtime for this request"
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

export function canonicalInstanceReloadOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new Error("token must be non-empty string")
  if (token.includes(":")) throw new Error("token must not contain ':'")
  if (!pathless(token)) throw new Error("token must not carry path material")
  return `instance-reload:${token}`
}

export function parseInstanceReloadOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new Error("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "instance-reload" || segs[1]!.length === 0)
    throw new Error("opId must be instance-reload:<token> with nonempty colon-free token")
  const token = segs[1]!
  if (!pathless(token)) throw new Error("opId must be instance-reload:<token> with nonempty colon-free token")
  return { token }
}

export function validateInstanceReloadRequest(raw: unknown): InstanceReloadRequest {
  if (!record(raw)) throw new Error("params must be object")
  if (raw.v !== VERSION) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!present(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== OP) throw new Error("op must be instance/reload")
  if (!present(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for instance-reload")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must be non-empty string without path material")
  if (!pathless(raw.idempotencyKey as string))
    throw new Error("idempotencyKey must be non-empty string without path material")
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
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for instance-reload")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  const parsed = parseInstanceReloadOpId(raw.opId as string)
  const idem = parseInstanceReloadOpId(raw.idempotencyKey as string)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as InstanceReloadRequest
}

type Ids = { requestId: string; opId: string; idempotencyKey: string }

function sanitized(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !pathless(v)) return "unknown"
  return v
}

export function fallbackInstanceReloadIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId), opId: sanitized(o.opId), idempotencyKey: sanitized(o.idempotencyKey) }
}

export function safeInstanceReloadIds(req: { requestId: string; opId: string; idempotencyKey: string }): Ids {
  return { requestId: sanitized(req.requestId), opId: sanitized(req.opId), idempotencyKey: sanitized(req.idempotencyKey) }
}

export function failed(ids: Ids, code: string, message: string, retryable: boolean): InstanceReloadFailed {
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

export function succeeded(req: InstanceReloadRequest): InstanceReloadSucceeded {
  return {
    v: VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: OP,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { reloaded: true },
  }
}

const RESULT_SUCCEEDED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "failure"])
const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

function checkFailure(raw: unknown): InstanceReloadFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as InstanceReloadFailure
}

export function validateInstanceReloadResult(raw: unknown, req: InstanceReloadRequest): InstanceReloadResult {
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
    for (const k of Object.keys(data)) if (k !== "reloaded") throw new Error("unexpected data field")
    if (data.reloaded !== true) throw new Error("succeeded data.reloaded must be true")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (out.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as InstanceReloadSucceeded
  }
  for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error("unexpected result field")
  const failure = checkFailure(rec.failure)
  const outFailure = checkFailure(out.failure)
  if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
  if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
  if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
  if (rec.data !== undefined) throw new Error("failed must not have data")
  return raw as unknown as InstanceReloadFailed
}

// Private `instance/reload`: the same directory-scoped reboot as the HTTP
// `instance.reload` route — existing `hasActiveSession -> 409` guard plus the
// unique `InstanceStore.reload` path (lease sealing, config fence handshake,
// exactly-one `server.instance.disposed` per successful invocation). The
// request directory is canonical routing identity (`directory` + optional
// `workspace?` never reach the store beyond selection); the payload is empty
// and there is no durable operation row. The op never retries on either path:
// an ambiguous transport outcome may repeat via the same-tuple SDK
// `client.instance.reload` fallback, which can produce at most two underlying
// reloads and two disposed events (merged by the existing coordinator).
export const reloadInstancePrivate = Effect.fn("InstanceReloadPrivate.reload")(function* (raw: unknown) {
  let req: InstanceReloadRequest
  try {
    req = validateInstanceReloadRequest(raw)
  } catch {
    return failed(fallbackInstanceReloadIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeInstanceReloadIds(req)
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
  const store = yield* InstanceStore.Service
  const gate = Option.getOrElse(yield* Effect.serviceOption(GenerationGate.Service), () => GenerationGate.noop)
  const leases = Option.getOrElse(yield* Effect.serviceOption(ControlLease.Service), () => ControlLease.noop)
  const snap = yield* store.snapshot(dir).pipe(
    Effect.catch(() => Effect.succeed(Option.none())),
    Effect.catchDefect(() => Effect.succeed(Option.none())),
  )
  if (Option.isNone(snap)) {
    if (gate.isBarrierActive(dir)) return failed(safe, "InstanceUnavailableDuringConfigRebuild", FENCE_MESSAGE, true)
    const out = yield* store
      .reload({ directory: dir })
      .pipe(
        Effect.map(() => ({ tag: "ok" as const })),
        Effect.catch(() => Effect.succeed({ tag: "fail" as const })),
        Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const })),
      )
    if (out.tag === "ok") return succeeded(req)
    return failed(safe, "internal", INTERNAL_MESSAGE, false)
  }
  const ctx = snap.value
  let stored: string
  try {
    stored = canonicalDirectory(ctx.directory)
  } catch {
    return failed(safe, "internal", INTERNAL_MESSAGE, false)
  }
  if (stored !== dir) return failed(safe, "scope_mismatch", SCOPE_MESSAGE, false)
  const lease = yield* Effect.sync(() => leases.acquire(ctx))
  if (Option.isNone(lease)) return failed(safe, "InstanceUnavailableDuringConfigRebuild", FENCE_MESSAGE, true)
  const exit = yield* Effect.gen(function* () {
    const svc = yield* SessionStatus.Service
    return yield* svc.list()
  }).pipe(
    Effect.provideService(InstanceRef, ctx),
    Effect.ensuring(lease.value),
    Effect.exit,
  )
  // A status-list failure is fail-closed internal: never reload on unknown
  // liveness. Note: the lease is already released above, so the reload below
  // never self-deadlocks against its own control lease;
  // `InstanceStore.reload` still seals and drains any other outstanding lease
  // for the replaced identity before its disposers run.
  if (exit._tag === "Failure") return failed(safe, "internal", INTERNAL_MESSAGE, false)
  try {
    if (hasActiveSession(exit.value)) {
      return failed(safe, "conflict", CONFLICT_MESSAGE, false)
    }
  } catch {
    return failed(safe, "internal", INTERNAL_MESSAGE, false)
  }
  const out = yield* store
    .reload({ directory: dir })
    .pipe(
      Effect.map(() => ({ tag: "ok" as const })),
      Effect.catch(() => Effect.succeed({ tag: "fail" as const })),
      Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const })),
    )
  if (out.tag === "ok") return succeeded(req)
  return failed(safe, "internal", INTERNAL_MESSAGE, false)
})
