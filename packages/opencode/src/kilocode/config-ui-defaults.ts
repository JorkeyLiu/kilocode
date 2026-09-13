import { Effect } from "effect"
import { Config } from "@/config/config"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import {
  acquireDrainControl,
  InstanceUnavailableDuringConfigRebuildError,
} from "@/kilocode/server/drain-control-acquire"
import { InstanceRef } from "@/effect/instance-ref"

export const VERSION = 1 as const
export const OP = "config/ui-defaults" as const
export const CAPABILITY = "config/ui-defaults" as const

export interface ConfigUiDefaultsRequest {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
}

export interface UiDefaultsWorkStyle {
  hasPermission: boolean
  terminalCommandDisplay?: "expanded" | "collapsed"
  autoCollapseReasoning?: boolean
}

export interface UiDefaultsSandbox {
  enabled: boolean
}

export interface UiDefaultsData {
  workStyle: UiDefaultsWorkStyle
  sandbox: UiDefaultsSandbox
}

export interface ConfigUiDefaultsFailure {
  code: string
  message: string
  retryable: boolean
}

export interface ConfigUiDefaultsSucceeded {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: UiDefaultsData
}

export interface ConfigUiDefaultsFailed {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "failed"
  outcome: { type: "failed"; time: number; failure: ConfigUiDefaultsFailure }
  accepted: false
  failure: ConfigUiDefaultsFailure
}

export interface ConfigUiDefaultsAmbiguous {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "ambiguous"
  outcome: { type: "ambiguous"; time: number }
  accepted: false
  transportUnknown?: boolean
}

export type ConfigUiDefaultsResult =
  | ConfigUiDefaultsSucceeded
  | ConfigUiDefaultsFailed
  | ConfigUiDefaultsAmbiguous

export const VALIDATION_MESSAGE = "invalid config-ui-defaults request"
export const SCOPE_MESSAGE = "directory mismatch"
export const FENCE_MESSAGE =
  "Instance is unavailable during config rebuild; no active runtime for this request"
export const INTERNAL_MESSAGE = "internal error"

export class ConfigUiDefaultsInternal extends Error {
  readonly _tag = "ConfigUiDefaultsInternal" as const
  constructor() {
    super(INTERNAL_MESSAGE)
    this.name = "ConfigUiDefaultsInternal"
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

export function validateConfigUiDefaultsRequest(raw: unknown): ConfigUiDefaultsRequest {
  if (!record(raw)) throw new Error("params must be object")
  if (raw.v !== VERSION) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must be non-empty string without path material")
  if (raw.op !== OP) throw new Error("op must be config/ui-defaults")
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
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for config-ui-defaults")
  const allowedRoot = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  return raw as unknown as ConfigUiDefaultsRequest
}

type Ids = { requestId: string }

function sanitized(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !pathless(v)) return "unknown"
  return v
}

export function fallbackConfigUiDefaultsIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId) }
}

export function safeConfigUiDefaultsIds(req: { requestId: string }): Ids {
  return { requestId: sanitized(req.requestId) }
}

export function failed(ids: Ids, code: string, message: string, retryable: boolean): ConfigUiDefaultsFailed {
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

export function succeeded(req: ConfigUiDefaultsRequest, data: UiDefaultsData): ConfigUiDefaultsSucceeded {
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

export function ambiguous(req: ConfigUiDefaultsRequest, transportUnknown = true): ConfigUiDefaultsAmbiguous {
  const out: ConfigUiDefaultsAmbiguous = {
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

const DATA_FIELDS = new Set(["workStyle", "sandbox"])
const WORK_STYLE_FIELDS = new Set(["hasPermission", "terminalCommandDisplay", "autoCollapseReasoning"])
const SANDBOX_FIELDS = new Set(["enabled"])

export function validateUiDefaultsData(raw: unknown): UiDefaultsData {
  if (!record(raw)) throw new Error("data must be object")
  for (const k of Object.keys(raw)) if (!DATA_FIELDS.has(k)) throw new Error(`unexpected data field ${k}`)
  const style = raw.workStyle
  if (!record(style)) throw new Error("workStyle must be object")
  for (const k of Object.keys(style)) if (!WORK_STYLE_FIELDS.has(k)) throw new Error(`unexpected workStyle field ${k}`)
  if (typeof style.hasPermission !== "boolean") throw new Error("workStyle.hasPermission must be boolean")
  if (style.terminalCommandDisplay !== undefined && style.terminalCommandDisplay !== "expanded" && style.terminalCommandDisplay !== "collapsed")
    throw new Error("workStyle.terminalCommandDisplay invalid")
  if (style.autoCollapseReasoning !== undefined && typeof style.autoCollapseReasoning !== "boolean")
    throw new Error("workStyle.autoCollapseReasoning must be boolean when present")
  const box = raw.sandbox
  if (!record(box)) throw new Error("sandbox must be object")
  for (const k of Object.keys(box)) if (!SANDBOX_FIELDS.has(k)) throw new Error(`unexpected sandbox field ${k}`)
  if (typeof box.enabled !== "boolean") throw new Error("sandbox.enabled must be boolean")
  return raw as unknown as UiDefaultsData
}

const RESULT_SUCCEEDED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "failure"])
const RESULT_AMBIGUOUS = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "transportUnknown"])
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])
const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

function checkFailure(raw: unknown): ConfigUiDefaultsFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as ConfigUiDefaultsFailure
}

export function validateConfigUiDefaultsResult(raw: unknown, req: ConfigUiDefaultsRequest): ConfigUiDefaultsResult {
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
    validateUiDefaultsData(rec.data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (out.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ConfigUiDefaultsSucceeded
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
    return raw as unknown as ConfigUiDefaultsFailed
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(out)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (out.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as ConfigUiDefaultsAmbiguous
}

export function isSettledConfigUiDefaultsResult(result: unknown, req: ConfigUiDefaultsRequest): boolean {
  if (!record(result)) return false
  const status = (result as { status?: unknown }).status
  if (status !== "succeeded" && status !== "failed") return false
  try {
    const out = validateConfigUiDefaultsResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}

export interface UiDefaultsSource {
  permission?: unknown
  terminal_command_display?: unknown
  auto_collapse_reasoning?: unknown
  sandbox?: { enabled?: unknown }
}

// Closed minimal projection of the effective config for work-style and
// sandbox readers. `hasPermission` carries only `permission !== undefined`
// (empty objects and full rulesets are both `true`); rule content, provider
// records, MCP config, and any other field never leave this function. Scalar
// work-style fields pass through only with their exact schema values;
// `sandbox.enabled` is strictly `=== true`, every other value reads `false`.
export function projectUiDefaults(source: UiDefaultsSource): UiDefaultsData {
  const style: UiDefaultsWorkStyle = { hasPermission: source.permission !== undefined }
  if (source.terminal_command_display !== undefined) {
    if (source.terminal_command_display !== "expanded" && source.terminal_command_display !== "collapsed")
      throw new ConfigUiDefaultsInternal()
    style.terminalCommandDisplay = source.terminal_command_display
  }
  if (source.auto_collapse_reasoning !== undefined) {
    if (typeof source.auto_collapse_reasoning !== "boolean") throw new ConfigUiDefaultsInternal()
    style.autoCollapseReasoning = source.auto_collapse_reasoning
  }
  return {
    workStyle: style,
    sandbox: { enabled: source.sandbox?.enabled === true },
  }
}

// Shared `config/ui-defaults` read body (fd only; no HTTP route). Reads the
// same effective `Config.Service.get()` (global/project merge) the
// `GET /config` handler reads, then immediately projects the closed
// whitelist above. `directory`/`workspace` are carrier routing identity only
// and never reach the service beyond `InstanceState` selection performed by
// the caller lane.
export const fetchUiDefaultsData = (): Effect.Effect<UiDefaultsData, never, Config.Service> =>
  Effect.gen(function* () {
    const svc = yield* Config.Service
    const config = yield* svc.get().pipe(Effect.catch(() => Effect.die(new ConfigUiDefaultsInternal())))
    try {
      const data = projectUiDefaults(config as UiDefaultsSource)
      validateUiDefaultsData(data)
      return data
    } catch {
      return yield* Effect.die(new ConfigUiDefaultsInternal())
    }
  })

// Private `config/ui-defaults`: routing-only directory validation, then the
// shared read via the existing drain-control + `InstanceRef` lane (same lane
// as `provider/catalog`/`agent/list` — no new lifecycle lane, no manual
// `InstanceRef` construction, no new drain/read lease, no journal/replay).
// `directory`/`workspace` are carrier routing identity only; `workspace`
// never reaches the service. Read-only, safely repeatable: an ambiguous
// transport outcome may safely repeat via the same-directory SDK
// `client.config.get` fallback projected locally; the op never retries.
export const configUiDefaultsPrivate = Effect.fn("ConfigUiDefaultsPrivate.read")(function* (raw: unknown) {
  let req: ConfigUiDefaultsRequest
  try {
    req = validateConfigUiDefaultsRequest(raw)
  } catch {
    return failed(fallbackConfigUiDefaultsIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeConfigUiDefaultsIds(req)
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
    const out = yield* fetchUiDefaultsData().pipe(
      Effect.map((data) => ({ tag: "ok" as const, data })),
      Effect.catch(() => Effect.succeed({ tag: "fail" as const })),
      Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const })),
    )
    if (out.tag !== "ok") return failed(safe, "internal", INTERNAL_MESSAGE, false)
    try {
      validateUiDefaultsData(out.data)
    } catch {
      return failed(safe, "internal", INTERNAL_MESSAGE, false)
    }
    return succeeded(req, out.data)
  }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
  return yield* inner.pipe(
    Effect.catch(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, false))),
    Effect.catchDefect(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, false))),
  )
})
