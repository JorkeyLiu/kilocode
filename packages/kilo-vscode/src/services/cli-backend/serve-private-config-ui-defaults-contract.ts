// Private-first `config/ui-defaults` read-only observation contract (production).
// Request is strictly `{v:1,requestId,op:"config/ui-defaults",
// context:{directory,workspace?},payload:{}}` with no `opId`/`idempotencyKey`
// (observation identity is `requestId` only). Success data is the closed
// minimal projection of the effective config (global/project merge) that the
// work-style and sandbox readers need: work-style presence plus scalar
// display values plus `sandbox.enabled`. Permission rule content, provider
// records, MCP config, and any other field are rejected fail-closed so
// secrets can never cross.
//
// Source facts:
// - Source: the same effective `Config.Service.get()` the `GET /config`
//   handler reads (`identifier: "config.get"` in
//   `packages/opencode/src/server/routes/instance/httpapi/groups/config.ts`).
//   There is no HTTP route for this op; the fd carrier is the only transport.
// - Owner: `packages/opencode/src/kilocode/config-ui-defaults.ts`
//   (`fetchUiDefaultsData` + `configUiDefaultsPrivate`, same
//   drain-control + `InstanceRef` lane as `provider/catalog`).
// - SDK: v2 `client.config.get({directory})` issues `GET /config` and remains
//   the exactly-one fallback for
//   unavailable/retryable/invalid/ambiguous/transport/closed/timeout outcomes,
//   projected locally to this same closed shape for old-CLI compatibility.
//   Validated terminal (`retryable === false`, including `validation.failed`/
//   `scope_mismatch`/`internal`) closes with zero SDK.
// - Consumers: `shared/config-ui-defaults-privatefirst.ts`
//   (`fetchConfigUiDefaultsPrivateFirst`) feeds the work-style apply reader
//   (`kilo-provider/work-style-apply-handler.ts`) and the sandbox default
//   reader (`shared/sandbox-session.ts`). The helper never retries, posts,
//   caches, journals, or reconciles; both callers keep their throw-on-failure
//   error propagation.
// - Distinct from `config/warnings`, `config/update`, `provider/catalog`,
//   `provider/auth`, and `global.config.update`. This contract never matches
//   those operations.
//
// ROUTING vs PAYLOAD SEMANTICS (v1):
// - `context.directory` binds request routing and scope. A scope match says
//   nothing about payload freshness or completeness.
// - Payload is validated shape-only. No freshness, ordering, lifecycle, or
//   cross-directory claim is made.
// - Out of scope: config writes, `config.get` full reads, permission presets,
//   provider/MCP secrets, caching/dedup, UI rendering, transport behavior
//   beyond the fixed failure taxonomy.

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

export interface ConfigUiDefaultsContractRequest {
  v: 1
  requestId: string
  op: "config/ui-defaults"
  context: { directory: string; workspace?: string }
  payload: Record<string, never>
}

export function validateConfigUiDefaultsContractRequest(raw: unknown): ConfigUiDefaultsContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  clean(raw.requestId, "requestId")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must not carry path material")
  if (raw.op !== "config/ui-defaults") throw new Error("op must be config/ui-defaults")
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
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for config-ui-defaults")
  return raw as unknown as ConfigUiDefaultsContractRequest
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

const DATA_FIELDS = new Set(["workStyle", "sandbox"])
const WORK_STYLE_FIELDS = new Set(["hasPermission", "terminalCommandDisplay", "autoCollapseReasoning"])
const SANDBOX_FIELDS = new Set(["enabled"])

export function validateUiDefaultsData(raw: unknown): UiDefaultsData {
  if (!record(raw)) throw new Error("data must be object")
  for (const k of Object.keys(raw)) {
    if (!DATA_FIELDS.has(k)) throw new Error(`unexpected data field ${k}`)
  }
  const style = raw.workStyle
  if (!record(style)) throw new Error("workStyle must be object")
  for (const k of Object.keys(style)) {
    if (!WORK_STYLE_FIELDS.has(k)) throw new Error(`unexpected workStyle field ${k}`)
  }
  if (typeof style.hasPermission !== "boolean") throw new Error("workStyle.hasPermission must be boolean")
  if (
    style.terminalCommandDisplay !== undefined &&
    style.terminalCommandDisplay !== "expanded" &&
    style.terminalCommandDisplay !== "collapsed"
  )
    throw new Error("workStyle.terminalCommandDisplay invalid")
  if (style.autoCollapseReasoning !== undefined && typeof style.autoCollapseReasoning !== "boolean")
    throw new Error("workStyle.autoCollapseReasoning must be boolean when present")
  const box = raw.sandbox
  if (!record(box)) throw new Error("sandbox must be object")
  for (const k of Object.keys(box)) {
    if (!SANDBOX_FIELDS.has(k)) throw new Error(`unexpected sandbox field ${k}`)
  }
  if (typeof box.enabled !== "boolean") throw new Error("sandbox.enabled must be boolean")
  return raw as unknown as UiDefaultsData
}

export interface ConfigUiDefaultsFailure {
  code: string
  message: string
  retryable: boolean
}

export const CONFIG_UI_DEFAULTS_FAILURE_CODES = new Set([
  "validation.failed",
  "scope_mismatch",
  "InstanceUnavailableDuringConfigRebuild",
  "internal",
] as const)
export type ConfigUiDefaultsFailureCode =
  | "validation.failed"
  | "scope_mismatch"
  | "InstanceUnavailableDuringConfigRebuild"
  | "internal"
export const CONFIG_UI_DEFAULTS_FAILURE_MESSAGES: Record<ConfigUiDefaultsFailureCode, string> = {
  "validation.failed": "invalid config-ui-defaults request",
  scope_mismatch: "directory mismatch",
  InstanceUnavailableDuringConfigRebuild:
    "Instance is unavailable during config rebuild; no active runtime for this request",
  internal: "internal error",
}
export const CONFIG_UI_DEFAULTS_FAILURE_RETRYABLE: Record<ConfigUiDefaultsFailureCode, boolean> = {
  "validation.failed": false,
  scope_mismatch: false,
  InstanceUnavailableDuringConfigRebuild: true,
  internal: false,
}

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateConfigUiDefaultsFailure(raw: unknown): ConfigUiDefaultsFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (!FAILURE_FIELDS.has(k)) throw new Error(`unexpected failure field ${k}`)
  }
  if (typeof raw.code !== "string" || !CONFIG_UI_DEFAULTS_FAILURE_CODES.has(raw.code as ConfigUiDefaultsFailureCode))
    throw new Error("failure code must be a known config-ui-defaults category")
  const code = raw.code as ConfigUiDefaultsFailureCode
  if (raw.message !== CONFIG_UI_DEFAULTS_FAILURE_MESSAGES[code])
    throw new Error("failure message must be the fixed message for its code")
  if (raw.retryable !== CONFIG_UI_DEFAULTS_FAILURE_RETRYABLE[code])
    throw new Error("failure retryable must match its code")
  return raw as unknown as ConfigUiDefaultsFailure
}

export type ConfigUiDefaultsResult =
  | {
      v: 1
      requestId: string
      op: "config/ui-defaults"
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: UiDefaultsData
    }
  | {
      v: 1
      requestId: string
      op: "config/ui-defaults"
      status: "failed"
      outcome: { type: "failed"; time: number; failure: ConfigUiDefaultsFailure }
      accepted: boolean
      failure: ConfigUiDefaultsFailure
    }
  | {
      v: 1
      requestId: string
      op: "config/ui-defaults"
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeConfigUiDefaultsAmbiguous(
  req: ConfigUiDefaultsContractRequest,
  transportUnknown = true,
): ConfigUiDefaultsResult {
  const out: ConfigUiDefaultsResult = {
    v: 1,
    requestId: req.requestId,
    op: "config/ui-defaults",
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type ConfigUiDefaultsWireOutcome =
  | { kind: "valid"; result: ConfigUiDefaultsResult }
  | { kind: "invalid"; detail: string }

export class ConfigUiDefaultsValidationError extends Error {
  readonly kind = "private-config-ui-defaults-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "ConfigUiDefaultsValidationError"
    this.detail = detail
  }
}

export function isConfigUiDefaultsValidationError(v: unknown): v is ConfigUiDefaultsValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-config-ui-defaults-validation"
}

export function normalizePrivateConfigUiDefaultsWire(
  raw: unknown,
  req: ConfigUiDefaultsContractRequest,
): ConfigUiDefaultsWireOutcome {
  try {
    const result = validateConfigUiDefaultsResult(raw, req)
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
export function validateConfigUiDefaultsResult(
  raw: unknown,
  req: ConfigUiDefaultsContractRequest,
): ConfigUiDefaultsResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.op !== "config/ui-defaults") throw new Error("op mismatch")
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
    validateUiDefaultsData(data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ConfigUiDefaultsResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error(`unexpected outcome field ${k}`)
    const failure = validateConfigUiDefaultsFailure(rec.failure)
    const outFailure = validateConfigUiDefaultsFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as ConfigUiDefaultsResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error(`unexpected result field ${k}`)
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as ConfigUiDefaultsResult
}

export function isSettledConfigUiDefaultsResult(result: unknown, req: ConfigUiDefaultsContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed") return false
  try {
    const out = validateConfigUiDefaultsResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
