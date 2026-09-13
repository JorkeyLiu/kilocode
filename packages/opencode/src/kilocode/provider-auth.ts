import { Effect } from "effect"
import { ProviderAuth } from "@/provider/auth"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import {
  acquireDrainControl,
  InstanceUnavailableDuringConfigRebuildError,
} from "@/kilocode/server/drain-control-acquire"
import { InstanceRef } from "@/effect/instance-ref"

export const VERSION = 1 as const
export const OP = "provider/auth" as const
export const CAPABILITY = "provider/auth" as const

export interface ProviderAuthRequest {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
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

export interface ProviderAuthFailure {
  code: string
  message: string
  retryable: boolean
}

export interface ProviderAuthSucceeded {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: ProviderAuthData
}

export interface ProviderAuthFailed {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "failed"
  outcome: { type: "failed"; time: number; failure: ProviderAuthFailure }
  accepted: false
  failure: ProviderAuthFailure
}

export interface ProviderAuthAmbiguous {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "ambiguous"
  outcome: { type: "ambiguous"; time: number }
  accepted: false
  transportUnknown?: boolean
}

export type ProviderAuthResult = ProviderAuthSucceeded | ProviderAuthFailed | ProviderAuthAmbiguous

export const VALIDATION_MESSAGE = "invalid provider-auth request"
export const SCOPE_MESSAGE = "directory mismatch"
export const FENCE_MESSAGE =
  "Instance is unavailable during config rebuild; no active runtime for this request"
export const INTERNAL_MESSAGE = "internal error"

export class ProviderAuthInternal extends Error {
  readonly _tag = "ProviderAuthInternal" as const
  constructor() {
    super(INTERNAL_MESSAGE)
    this.name = "ProviderAuthInternal"
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

export function validateProviderAuthRequest(raw: unknown): ProviderAuthRequest {
  if (!record(raw)) throw new Error("params must be object")
  if (raw.v !== VERSION) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must be non-empty string without path material")
  if (raw.op !== OP) throw new Error("op must be provider/auth")
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
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for provider-auth")
  const allowedRoot = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  return raw as unknown as ProviderAuthRequest
}

type Ids = { requestId: string }

function sanitized(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !pathless(v)) return "unknown"
  return v
}

export function fallbackProviderAuthIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId) }
}

export function safeProviderAuthIds(req: { requestId: string }): Ids {
  return { requestId: sanitized(req.requestId) }
}

export function failed(ids: Ids, code: string, message: string, retryable: boolean): ProviderAuthFailed {
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

export function succeeded(req: ProviderAuthRequest, data: ProviderAuthData): ProviderAuthSucceeded {
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

export function ambiguous(req: ProviderAuthRequest, transportUnknown = true): ProviderAuthAmbiguous {
  const out: ProviderAuthAmbiguous = {
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

const RESULT_SUCCEEDED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "failure"])
const RESULT_AMBIGUOUS = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "transportUnknown"])
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])
const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

function checkFailure(raw: unknown): ProviderAuthFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as ProviderAuthFailure
}

export function validateProviderAuthResult(raw: unknown, req: ProviderAuthRequest): ProviderAuthResult {
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
    validateProviderAuthData(rec.data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (out.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ProviderAuthSucceeded
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
    return raw as unknown as ProviderAuthFailed
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(out)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (out.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as ProviderAuthAmbiguous
}

export function isSettledProviderAuthResult(result: unknown, req: ProviderAuthRequest): boolean {
  if (!record(result)) return false
  const status = (result as { status?: unknown }).status
  if (status !== "succeeded" && status !== "failed") return false
  try {
    const out = validateProviderAuthResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}

// Shared `provider/auth` read body for HTTP + fd. Only the canonical owner:
// `ProviderAuth.Service.methods()` with strict closed validation. Display
// text (`label`/`key`/`message`/`placeholder`/`value`/`hint`) is untrusted
// display: string + NUL safety only, no non-empty or secret-field guess. No
// external network, no secret, no cache. `directory`/`workspace` are carrier
// routing identity only and never reach the service beyond `InstanceState`
// selection performed by the caller lane.
export const fetchProviderAuthData = (): Effect.Effect<ProviderAuth.Methods, never, ProviderAuth.Service> =>
  Effect.gen(function* () {
    const svc = yield* ProviderAuth.Service
    const methods = yield* svc.methods().pipe(Effect.catch(() => Effect.die(new ProviderAuthInternal())))
    try {
      validateProviderAuthData(methods)
      return methods as unknown as ProviderAuth.Methods
    } catch {
      return yield* Effect.die(new ProviderAuthInternal())
    }
  })

// Private `provider/auth`: routing-only directory validation, then the shared
// read via the existing drain-control + `InstanceRef` lane (same lane as
// `provider/catalog`/`agent/list` — no new lifecycle lane, no manual
// `InstanceRef` construction, no new drain/read lease, no journal/replay).
// `directory`/`workspace` are carrier routing identity only; `workspace`
// never reaches the service. Read-only, safely repeatable: an ambiguous
// transport outcome may safely repeat via the same-directory SDK
// `client.provider.auth` fallback; the op never retries.
export const providerAuthPrivate = Effect.fn("ProviderAuthPrivate.read")(function* (raw: unknown) {
  let req: ProviderAuthRequest
  try {
    req = validateProviderAuthRequest(raw)
  } catch {
    return failed(fallbackProviderAuthIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeProviderAuthIds(req)
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
    const out = yield* fetchProviderAuthData().pipe(
      Effect.map((data) => ({ tag: "ok" as const, data })),
      Effect.catch(() => Effect.succeed({ tag: "fail" as const })),
      Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const })),
    )
    if (out.tag !== "ok") return failed(safe, "internal", INTERNAL_MESSAGE, false)
    try {
      validateProviderAuthData(out.data)
    } catch {
      return failed(safe, "internal", INTERNAL_MESSAGE, false)
    }
    return succeeded(req, out.data as unknown as ProviderAuthData)
  }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
  return yield* inner.pipe(
    Effect.catch(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, false))),
    Effect.catchDefect(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, false))),
  )
})
