// Gate B deferred `config/warnings` read-only candidate contract evidence only.
// Pure contract helpers with no transport, no private capability, no dispatch,
// no runtime observation, no durable state, no config write, no fence, no
// cache, no redaction implementation, and no production parity claim.
// `op:"config/warnings"` below is a contract-evidence label only; it is never
// registered as a private capability and never sent over any peer. Production
// `config/warnings` stays SDK-only (`GET /config/warnings` via
// `@kilocode/sdk` `client.config.warnings`).
//
// Source facts (read-only evidence, not imported):
// - Route: `GET /config/warnings` with `WorkspaceRoutingQuery`
//   (`directory?`, `workspace?`) in
//   `packages/opencode/src/server/routes/instance/httpapi/groups/config.ts`
//   (`identifier: "config.warnings"`, success `Array(Warning)`
//   `{path,message,detail?}`, all strings).
// - Handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts`
//   `warnings` returns `configSvc.warnings()` with no payload mapping.
// - Service: `packages/opencode/src/config/config.ts` `Config.warnings()`
//   returns `InstanceState.use(state, (s) => s.warnings)` (directory-keyed
//   `InstanceState`, populated once by `loadInstanceState(ctx)`).
// - Shape: `packages/opencode/src/config/config.ts` `Warning = z.object({`
//   `path: z.string(), message: z.string(), detail: z.string().optional() })`.
// - SDK: v2 `client.config.warnings({directory?, workspace?})` issues
//   `GET /config/warnings`; v2 generated `ConfigWarningsResponses[200]` is
//   exactly `Array<{path,message,detail?}>`.
// - Consumer: `packages/kilo-vscode/src/KiloProvider.ts`
//   `checkConfigWarnings()` calls `client.config.warnings({directory: dir})`,
//   reads `data ?? []`, shows one consolidated warning once per lifecycle.
// - Other consumer: `packages/opencode/src/kilocode/config-validation.ts`
//   reads `svc.warnings()`; CLI `config` command prints count via same service.
//
// Producer notes (read-only evidence, warning origins accumulated into the
// same `warnings: Warning[]` array in `loadInstanceState`):
// - `KilocodeConfig.caught(warnings, source, err)` (`toWarning` in
//   `packages/opencode/src/kilocode/config/config.ts`): converts known errors
//   only; unknown errors are re-thrown, never converted.
//   Exact templates: `ConfigError.JsonError` ->
//   `{path: err.data.path, message: `Config file at ${path} is not valid JSON(C)`,
//   detail: err.data.message || undefined}`; `ConfigError.InvalidError` ->
//   `{path: err.data.path, message: `Configuration is invalid at ${path}: ${text}``
//   or `Configuration is invalid at ${path}`}` where `text` is
//   `formatIssues(err.data.issues) ?? err.data.message` (no `detail` field).
//   Covers global-config and project-file `loadFile` defects.
// - `KilocodeConfig.handleInvalid("agent"|"command", item, issues, cause, warnings)`:
//   exact templates: `` `Config file at ${item} is invalid: ${text}` `` or
//   `` `Config file at ${item} is invalid` `` where `text` is
//   `formatIssues(issues)`, pushed as
//   `{path: item, message, detail: text || undefined}` for schema failures
//   after markdown parse/substitution succeeded.
// - Direct pushes (no `toWarning`/`handleInvalid`): `ConfigAgent.load` and
//   `ConfigCommand.load` push `{path: item, message}` (no `detail`) with exact
//   templates `` `Failed to parse agent ${item}` `` /
//   `` `Failed to parse command ${item}` `` when `err` is not a
//   `FrontmatterError` (otherwise `FrontmatterError` `err.data.message` is used
//   verbatim); `ConfigAgent.load` prompt-substitution failures push
//   `{path: item, message}` (no `detail`) with the exact template
//   `` `Failed to substitute variables in agent ${item}` `` unless
//   `ConfigError.InvalidError` `err.data.message` is present (used verbatim).
//   There is no `Failed to substitute variables in command ...` template.
// - Trust scoping (`trusted`, `fileScope`, `sourceScope` per global vs project
//   directory) affects parse/substitution inputs, not the warning envelope.
//
// EXPLICIT UNKNOWNS (no inference without evidence):
// - Ownership: whether `warnings` is directory-isolated per `InstanceState`
//   context or shares entries across directories is UNKNOWN. Validation asserts
//   no directory binding; parity never compares the request directory.
// - Freshness: staleness/invalidation of `warnings` after config writes,
//   reloads, or convergence rebuilds is UNKNOWN; parity never claims freshness.
// - Content redaction: warning `path`/`message`/`detail` content is NOT claimed
//   sanitized. `path` may be an absolute filesystem path and `detail` may carry
//   schema-issue text. This contract validates shape only and implements no
//   redaction. Failure fixtures must stay redacted; warning payloads are
//   observed values, never redaction claims.
// - Ordering: warning array order is UNKNOWN; parity is membership-based and
//   never compares order.
// - `directory`/`workspace` in the request context are ROUTING-ONLY labels.
//   Scope checks guard request-routing identity only; a scope match says
//   nothing about payload ownership.
// - Out of scope: `config.get`, `config.update`, `config.providers`, any config
//   write/fence/convergence behavior, and any transport/wiring/cache.

import { isAbsolute, normalize, resolve } from "path"

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}

function assertAllowedKeys(rec: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const k of Object.keys(rec)) if (!allowed.has(k)) throw new Error(`unexpected ${label} field ${k}`)
}

export function canonicalConfigWarningsOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `config-warnings:${token}`
}

export function parseConfigWarningsOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2) throw new TypeError(`config-warnings opId must have 1 segment: ${opId}`)
  if (segs[0] !== "config-warnings") throw new TypeError(`opId kind must be config-warnings: ${opId}`)
  const token = segs[1]!
  if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  return { token }
}

export interface ConfigWarningsContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "config/warnings"
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
}

// eslint-disable-next-line complexity
export function validateConfigWarningsContractRequest(raw: unknown): ConfigWarningsContractRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "config/warnings") throw new Error("op must be config/warnings")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId)
    throw new Error("idempotencyKey must equal opId for config-warnings contract")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx as Record<string, unknown>))
    if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (ctx.workspace !== undefined) {
    if (!isNonEmpty(ctx.workspace) || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload as Record<string, unknown>).length !== 0)
    throw new Error("payload must be empty object for config-warnings contract")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  parseConfigWarningsOpId(raw.opId as string)
  const idem = parseConfigWarningsOpId(raw.idempotencyKey as string)
  if (idem.token !== parseConfigWarningsOpId(raw.opId as string).token)
    throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as ConfigWarningsContractRequest
}

export type ConfigWarningsScopeWhich = "directory" | "workspace" | "request"

export type ConfigWarningsScopeCheck =
  | { ok: true }
  | { ok: false; code: "scope_mismatch"; which: ConfigWarningsScopeWhich }

export function checkConfigWarningsScope(
  req: ConfigWarningsContractRequest,
  expected: { directory: string; workspace?: string; token: string },
): ConfigWarningsScopeCheck {
  let want = expected.directory
  try {
    want = canonicalDir(expected.directory)
  } catch {
    return { ok: false, code: "scope_mismatch", which: "directory" }
  }
  let got = req.context.directory
  try {
    got = canonicalDir(req.context.directory)
  } catch {
    return { ok: false, code: "scope_mismatch", which: "directory" }
  }
  if (got !== want) return { ok: false, code: "scope_mismatch", which: "directory" }
  const wantWs = expected.workspace
  const gotWs = req.context.workspace
  if ((wantWs === undefined) !== (gotWs === undefined))
    return { ok: false, code: "scope_mismatch", which: "workspace" }
  if (wantWs !== undefined && gotWs !== wantWs)
    return { ok: false, code: "scope_mismatch", which: "workspace" }
  const parsed = parseConfigWarningsOpId(req.opId)
  if (parsed.token !== expected.token) return { ok: false, code: "scope_mismatch", which: "request" }
  const bound = canonicalConfigWarningsOpId(expected.token)
  if (req.opId !== bound || req.idempotencyKey !== bound)
    return { ok: false, code: "scope_mismatch", which: "request" }
  return { ok: true }
}

// Bounded warning projection: exactly production `{path,message,detail?}`.
// Shape-only: `path`/`message` are non-empty strings, `detail` when present is
// a string. Content is NOT claimed sanitized (see unknowns above); validation
// never asserts redaction, ownership, or freshness.
export interface ConfigWarning {
  path: string
  message: string
  detail?: string
}

const CONFIG_WARNING_FIELDS = new Set(["path", "message", "detail"])

export function validateConfigWarning(raw: unknown): ConfigWarning {
  if (!isRecord(raw)) throw new Error("warning must be object")
  assertAllowedKeys(raw as Record<string, unknown>, CONFIG_WARNING_FIELDS, "warning")
  if (!isNonEmpty(raw.path) || (raw.path as string).includes("\0"))
    throw new Error("warning.path must be non-empty string")
  if (!isNonEmpty(raw.message) || (raw.message as string).includes("\0"))
    throw new Error("warning.message must be non-empty string")
  if (raw.detail !== undefined) {
    if (typeof raw.detail !== "string" || (raw.detail as string).includes("\0"))
      throw new Error("warning.detail must be string when present")
  }
  return raw as unknown as ConfigWarning
}

export function validateConfigWarnings(raw: unknown): ConfigWarning[] {
  if (!Array.isArray(raw)) throw new Error("warnings must be array")
  return (raw as unknown[]).map((item) => validateConfigWarning(item))
}

export function configWarningKey(w: ConfigWarning): string {
  // Delimited JSON-tuple encoding so field boundaries cannot collide:
  // ("ab","c") and ("a","bc") produce distinct keys. `detail` absent maps to
  // null so missing vs empty-string detail stay distinct.
  return JSON.stringify([w.path, w.message, w.detail ?? null])
}

export type ConfigWarningsResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "config/warnings"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { warnings: ConfigWarning[] }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "config/warnings"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: ConfigWarningsFailure }
      accepted: boolean
      failure: ConfigWarningsFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "config/warnings"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeConfigWarningsAmbiguous(
  req: ConfigWarningsContractRequest,
  transportUnknown = true,
): ConfigWarningsResult {
  const out: ConfigWarningsResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "config/warnings",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

// Redacted failure shape following `remote.status` / `session/list` / `path/get`
// conventions ({code,message,retryable} only). Warning echo keys (`path`,
// `detail`, `warnings`) and routing keys are rejected so fixtures cannot carry
// host path or warning content material. `message`/`code`/`retryable` are the
// allowed failure keys and are never forbidden.
export interface ConfigWarningsFailure {
  code: string
  message: string
  retryable: boolean
}

export const CONFIG_WARNINGS_FAILURE_FORBIDDEN = new Set([
  "session",
  "sessionId",
  "prompt",
  "tool",
  "error",
  "raw",
  "output",
  "detail",
  "path",
  "warnings",
  "warning",
  "directory",
  "workspace",
  "config",
])

const CONFIG_WARNINGS_FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateConfigWarningsFailure(raw: unknown): ConfigWarningsFailure {
  if (!isRecord(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (CONFIG_WARNINGS_FAILURE_FORBIDDEN.has(k)) throw new Error(`failure must not carry ${k}`)
  }
  assertAllowedKeys(raw as Record<string, unknown>, CONFIG_WARNINGS_FAILURE_FIELDS, "failure")
  if (!isNonEmpty(raw.code)) throw new Error("failure code must be non-empty string")
  if (!isNonEmpty(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as ConfigWarningsFailure
}

export type ConfigWarningsWireOutcome =
  | { kind: "valid"; result: ConfigWarningsResult }
  | { kind: "invalid"; detail: string }

export class ConfigWarningsValidationError extends Error {
  readonly kind = "private-config-warnings-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "ConfigWarningsValidationError"
    this.detail = detail
  }
}

export function isConfigWarningsValidationError(v: unknown): v is ConfigWarningsValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-config-warnings-validation"
}

export function normalizePrivateConfigWarningsWire(
  raw: unknown,
  req: ConfigWarningsContractRequest,
): ConfigWarningsWireOutcome {
  try {
    const result = validateConfigWarningsResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

const CONFIG_WARNINGS_RESULT_SUCCEEDED = new Set([
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
const CONFIG_WARNINGS_RESULT_FAILED = new Set([
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
const CONFIG_WARNINGS_RESULT_AMBIGUOUS = new Set([
  "v",
  "requestId",
  "opId",
  "op",
  "idempotencyKey",
  "status",
  "outcome",
  "accepted",
  "transportUnknown",
])
const CONFIG_WARNINGS_OUTCOME_PLAIN = new Set(["type", "time"])
const CONFIG_WARNINGS_OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validateConfigWarningsResult(
  raw: unknown,
  req: ConfigWarningsContractRequest,
): ConfigWarningsResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "config/warnings") throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous")
    throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!isRecord(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number")
    throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const outRec = outcome as Record<string, unknown>
  if (status === "succeeded") {
    assertAllowedKeys(rec, CONFIG_WARNINGS_RESULT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, CONFIG_WARNINGS_OUTCOME_PLAIN, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["warnings"])
    for (const k of Object.keys(data as Record<string, unknown>))
      if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    // Shape-only projection. No directory binding, ordering, freshness, or
    // redaction is asserted here by design.
    validateConfigWarnings((data as Record<string, unknown>).warnings)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ConfigWarningsResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, CONFIG_WARNINGS_RESULT_FAILED, "result")
    assertAllowedKeys(outRec, CONFIG_WARNINGS_OUTCOME_FAILED, "outcome")
    const failure = validateConfigWarningsFailure(rec.failure)
    const outFailure = validateConfigWarningsFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as ConfigWarningsResult
  }
  assertAllowedKeys(rec, CONFIG_WARNINGS_RESULT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, CONFIG_WARNINGS_OUTCOME_PLAIN, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as ConfigWarningsResult
}

// Detached parity only (contract evidence, never production parity):
// membership-based multiset comparison of the bounded `{path,message,detail?}`
// projection. Order is never compared; length/membership/duplicate-count gaps
// on either side are reported as explicit unknowns
// (`config-warnings-membership-unknown`) because ownership, freshness, and
// lifecycle are unknown. Malformed SDK entries are reported as
// `config-warnings-shape-mismatch`, never skipped silently. The request
// directory is never compared; failed-vs-failed status agreement holds with
// no content comparison.
export function compareConfigWarningsParity(
  priv: ConfigWarningsResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
): { divergence: string | null; details: Record<string, unknown> } {
  const base = { ownerUnknown: true, freshnessUnknown: true, redactionUnknown: true, orderingUnknown: true }
  const privStatus: string = priv.status
  if (!!(priv as Record<string, unknown>).transportUnknown) {
    return { divergence: "transport-unknown", details: { privStatus, transportUnknown: true, ...base } }
  }
  const sdkError = sdk.error !== undefined && sdk.error !== null
  const sdkStatus: string = sdkError ? "failed" : "succeeded"
  if (sdkStatus !== privStatus) {
    return {
      divergence: `status-mismatch:sdk=${sdkStatus} priv=${privStatus}`,
      details: { sdkStatus, privStatus, ...base },
    }
  }
  if (sdkStatus === "succeeded" && privStatus === "succeeded") {
    const sdkRaw = sdk.data
    if (!Array.isArray(sdkRaw)) {
      return { divergence: "config-warnings-shape-mismatch", details: { ...base, mismatch: true } }
    }
    const privWarnings = (priv as Extract<ConfigWarningsResult, { status: "succeeded" }>).data.warnings
    const sdkKeys: string[] = []
    for (const item of sdkRaw as unknown[]) {
      try {
        sdkKeys.push(configWarningKey(validateConfigWarning(item)))
      } catch {
        return { divergence: "config-warnings-shape-mismatch", details: { ...base, mismatch: true } }
      }
    }
    const privKeys = privWarnings.map((w) => configWarningKey(w))
    const privCounts = new Map<string, number>()
    for (const key of privKeys) privCounts.set(key, (privCounts.get(key) ?? 0) + 1)
    const sdkCounts = new Map<string, number>()
    for (const key of sdkKeys) sdkCounts.set(key, (sdkCounts.get(key) ?? 0) + 1)
    // Multiset comparison: membership AND duplicate-count gaps on either side
    // are membership-unknowns (ownership/freshness unknown), never order.
    for (const [key, privCount] of privCounts) {
      const sdkCount = sdkCounts.get(key) ?? 0
      if (sdkCount !== privCount) {
        return { divergence: `config-warnings-membership-unknown:${key}`, details: { ...base, key, privCount, sdkCount } }
      }
    }
    for (const [key, sdkCount] of sdkCounts) {
      if (!privCounts.has(key)) {
        return { divergence: `config-warnings-membership-unknown:${key}`, details: { ...base, key, privCount: 0, sdkCount } }
      }
    }
    return { divergence: null, details: { ...base, compared: privWarnings.length } }
  }
  return { divergence: null, details: { ...base } }
}
