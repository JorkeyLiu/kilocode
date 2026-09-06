// `config/warnings` read-only private carrier contract (Active, parity-only).
// Strict v1 envelope helpers plus the locked safe warning projection. The
// private path never transmits raw paths, raw diagnostic text, or detail:
// success data is `{warnings: [{pathCategory, messageCategory}]}` with finite
// categories only. Production `config/warnings` stays SDK-only (`GET
// /config/warnings` via `@kilocode/sdk` `client.config.warnings`), which
// remains the sole user-visible authority; the private path is detached
// warn-only observation of the current directory instance snapshot with no
// freshness claim. Read-only diagnostics only; out of scope are `config.get`,
// `config.update`, `config.providers`, any config write/fence/convergence
// behavior, and any transport/wiring/cache.
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
// - Carrier: `packages/opencode/src/kilocode/server/fd-carrier.ts`
//   `config/warnings` reads `Config.Service.warnings()` through the existing
//   `acquireDrainControl(directory)` + `InstanceRef` lane and projects each
//   entry with the same category mapping below.
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
// same `warnings: Warning[]` array in `loadInstanceState`; the message
// categories below map these exact templates, anything else is `unknown`):
// - `KilocodeConfig.caught(warnings, source, err)` (`toWarning` in
//   `packages/opencode/src/kilocode/config/config.ts`): exact templates
//   `Config file at ${path} is not valid JSON(C)` (`invalid-json`) and
//   `Configuration is invalid at ${path}...` (`invalid-config`).
// - `KilocodeConfig.handleInvalid("agent"|"command", ...)`: exact templates
//   `` `Config file at ${item} is invalid...` `` (`invalid-file`).
// - Direct pushes: `` `Failed to parse agent ${item}` `` (`parse-agent`),
//   `` `Failed to parse command ${item}` `` (`parse-command`),
//   `` `Failed to substitute variables in agent ${item}` ``
//   (`substitute-agent`); verbatim `FrontmatterError`/`InvalidError` text is
//   `unknown` by design (never transmitted, never compared).
//
// EXPLICIT UNKNOWNS (no inference without evidence):
// - Freshness: staleness/invalidation of `warnings` after config writes,
//   reloads, or convergence rebuilds is UNKNOWN; parity never claims freshness.
// - Ordering: warning array order is UNKNOWN; parity is membership-based and
//   never compares order.
// - `directory`/`workspace` in the request context are ROUTING-ONLY labels.
//   Scope checks guard request-routing identity only. The payload is the
//   current directory instance snapshot read through the target directory's
//   `InstanceRef` lane (no global cache, no cross-directory aggregation).
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

function containsConfigWarningsPathMaterial(v: string): boolean {
  return v.includes("/") || v.includes("\\") || v.includes("\0")
}

function assertNoConfigWarningsPathMaterial(v: string, label: string): void {
  if (containsConfigWarningsPathMaterial(v)) throw new Error(`${label} must not carry path material`)
}

// eslint-disable-next-line complexity
export function validateConfigWarningsContractRequest(raw: unknown): ConfigWarningsContractRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  assertNoConfigWarningsPathMaterial(raw.requestId as string, "requestId")
  assertNoConfigWarningsPathMaterial(raw.opId as string, "opId")
  if (raw.op !== "config/warnings") throw new Error("op must be config/warnings")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  assertNoConfigWarningsPathMaterial(raw.idempotencyKey as string, "idempotencyKey")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for config-warnings contract")
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
  assertNoConfigWarningsPathMaterial(idem.token, "opId token")
  assertNoConfigWarningsPathMaterial(parseConfigWarningsOpId(raw.opId as string).token, "opId token")
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
  if ((wantWs === undefined) !== (gotWs === undefined)) return { ok: false, code: "scope_mismatch", which: "workspace" }
  if (wantWs !== undefined && gotWs !== wantWs) return { ok: false, code: "scope_mismatch", which: "workspace" }
  const parsed = parseConfigWarningsOpId(req.opId)
  if (parsed.token !== expected.token) return { ok: false, code: "scope_mismatch", which: "request" }
  const bound = canonicalConfigWarningsOpId(expected.token)
  if (req.opId !== bound || req.idempotencyKey !== bound) return { ok: false, code: "scope_mismatch", which: "request" }
  return { ok: true }
}

// Locked safe warning projection: finite categories only. Raw paths, raw
// diagnostic text, and detail never cross the private boundary: `path` maps
// to a coarse file kind, `message` maps to the stable producer template, and
// `detail` is omitted entirely. The carrier (`fd-carrier.ts`
// `projectConfigWarningForCarrier`) applies the same mapping; parity projects
// the SDK raw entries with `projectConfigWarningToSafe` so both sides compare
// the identical safe multiset. Verbatim `FrontmatterError`/`InvalidError`
// text and any future template fall into `unknown` by design.
export type ConfigWarningsPathCategory = "config-file" | "agent-file" | "command-file" | "other"
export type ConfigWarningsMessageCategory =
  | "invalid-json"
  | "invalid-config"
  | "invalid-file"
  | "parse-agent"
  | "parse-command"
  | "substitute-agent"
  | "unknown"

export interface ConfigWarning {
  pathCategory: ConfigWarningsPathCategory
  messageCategory: ConfigWarningsMessageCategory
}

const CONFIG_WARNING_PATH_CATEGORIES = new Set(["config-file", "agent-file", "command-file", "other"])
const CONFIG_WARNING_MESSAGE_CATEGORIES = new Set([
  "invalid-json",
  "invalid-config",
  "invalid-file",
  "parse-agent",
  "parse-command",
  "substitute-agent",
  "unknown",
])
const CONFIG_WARNING_FIELDS = new Set(["pathCategory", "messageCategory"])

export function configWarningsPathCategory(p: string): ConfigWarningsPathCategory {
  const lower = p.toLowerCase()
  if (lower.includes("agent")) return "agent-file"
  if (lower.includes("command")) return "command-file"
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "config-file"
  return "other"
}

export function configWarningsMessageCategory(m: string): ConfigWarningsMessageCategory {
  if (m.startsWith("Config file at") && m.includes("is not valid JSON")) return "invalid-json"
  if (m.startsWith("Configuration is invalid at")) return "invalid-config"
  if (m.startsWith("Config file at") && m.includes("is invalid")) return "invalid-file"
  if (m.startsWith("Failed to parse agent")) return "parse-agent"
  if (m.startsWith("Failed to parse command")) return "parse-command"
  if (m.startsWith("Failed to substitute variables in agent")) return "substitute-agent"
  return "unknown"
}

export function projectConfigWarningToSafe(path: string, message: string): ConfigWarning {
  return { pathCategory: configWarningsPathCategory(path), messageCategory: configWarningsMessageCategory(message) }
}

function isRawSdkWarning(raw: unknown): raw is { path: string; message: string } {
  if (!isRecord(raw)) return false
  const rec = raw as Record<string, unknown>
  if (!isNonEmpty(rec.path) || (rec.path as string).includes("\0")) return false
  if (!isNonEmpty(rec.message) || (rec.message as string).includes("\0")) return false
  if (rec.detail !== undefined && (typeof rec.detail !== "string" || (rec.detail as string).includes("\0")))
    return false
  return true
}

export function validateConfigWarning(raw: unknown): ConfigWarning {
  if (!isRecord(raw)) throw new Error("warning must be object")
  assertAllowedKeys(raw as Record<string, unknown>, CONFIG_WARNING_FIELDS, "warning")
  if (typeof raw.pathCategory !== "string" || !CONFIG_WARNING_PATH_CATEGORIES.has(raw.pathCategory as string))
    throw new Error("warning.pathCategory must be config-file/agent-file/command-file/other")
  if (typeof raw.messageCategory !== "string" || !CONFIG_WARNING_MESSAGE_CATEGORIES.has(raw.messageCategory as string))
    throw new Error("warning.messageCategory must be a known category")
  return raw as unknown as ConfigWarning
}

export function validateConfigWarnings(raw: unknown): ConfigWarning[] {
  if (!Array.isArray(raw)) throw new Error("warnings must be array")
  return (raw as unknown[]).map((item) => validateConfigWarning(item))
}

export function configWarningKey(w: ConfigWarning): string {
  // Delimited JSON-tuple encoding so category boundaries cannot collide.
  // Categories are a finite fixed set, so keys carry no path or text material.
  return JSON.stringify([w.pathCategory, w.messageCategory])
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
//
// Finite failure taxonomy (LOCK-005): only fixed categories and fixed messages
// cross the private wire. Arbitrary backend codes/text are rejected as invalid
// wire; local transport maps to `transport` with its fixed message and never
// copies host codes or raw error strings.
export const CONFIG_WARNINGS_FAILURE_CODES = new Set([
  "validation.failed",
  "InstanceUnavailableDuringConfigRebuild",
  "internal",
  "transport",
] as const)
export type ConfigWarningsFailureCode =
  | "validation.failed"
  | "InstanceUnavailableDuringConfigRebuild"
  | "internal"
  | "transport"
export const CONFIG_WARNINGS_TRANSPORT_FAILURE_CODE: ConfigWarningsFailureCode = "transport"
export const CONFIG_WARNINGS_FAILURE_MESSAGES: Record<ConfigWarningsFailureCode, string> = {
  "validation.failed": "invalid config-warnings request",
  InstanceUnavailableDuringConfigRebuild:
    "Instance is unavailable during config rebuild; no active runtime for this request",
  internal: "internal error",
  transport: "private config-warnings transport failed",
}
export const CONFIG_WARNINGS_FAILURE_RETRYABLE: Record<ConfigWarningsFailureCode, boolean> = {
  "validation.failed": false,
  InstanceUnavailableDuringConfigRebuild: true,
  internal: false,
  transport: false,
}
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
  if (typeof raw.code !== "string" || !CONFIG_WARNINGS_FAILURE_CODES.has(raw.code as ConfigWarningsFailureCode))
    throw new Error("failure code must be a known config-warnings category")
  const code = raw.code as ConfigWarningsFailureCode
  if (raw.message !== CONFIG_WARNINGS_FAILURE_MESSAGES[code])
    throw new Error("failure message must be the fixed message for its code")
  if (raw.retryable !== CONFIG_WARNINGS_FAILURE_RETRYABLE[code])
    throw new Error("failure retryable must match its code")
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
export function validateConfigWarningsResult(raw: unknown, req: ConfigWarningsContractRequest): ConfigWarningsResult {
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
    // Safe projection: finite `{pathCategory,messageCategory}` entries only.
    // Raw paths, raw text, and detail are never accepted here by design.
    validateConfigWarnings((data as Record<string, unknown>).warnings)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ConfigWarningsResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, CONFIG_WARNINGS_RESULT_FAILED, "result")
    assertAllowedKeys(outRec, CONFIG_WARNINGS_OUTCOME_FAILED, "outcome")
    if (raw.accepted !== false) throw new Error("failed accepted must be false")
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

// Detached parity only (never production parity): the SDK raw entries are
// projected with the same `projectConfigWarningToSafe` mapping the carrier
// applies, then both sides compare as a multiset of safe category tuples.
// Order is never compared; length/membership/duplicate-count gaps on either
// side are reported as explicit unknowns
// (`config-warnings-membership-unknown`) because freshness is unknown.
// Malformed SDK entries are reported as `config-warnings-shape-mismatch`,
// never skipped silently. The request directory is never compared; the
// private payload is the current directory instance snapshot with no
// freshness claim. Failed-vs-failed status agreement holds with no content
// comparison. Details carry fixed categories, counts, and booleans only.
export function compareConfigWarningsParity(
  priv: ConfigWarningsResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
): { divergence: string | null; details: Record<string, unknown> } {
  const base = { directorySnapshot: true, freshnessUnknown: true, orderingUnknown: true }
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
      if (!isRawSdkWarning(item)) {
        return { divergence: "config-warnings-shape-mismatch", details: { ...base, mismatch: true } }
      }
      sdkKeys.push(configWarningKey(projectConfigWarningToSafe(item.path, item.message)))
    }
    const privKeys = privWarnings.map((w) => configWarningKey(w))
    const privCounts = new Map<string, number>()
    for (const key of privKeys) privCounts.set(key, (privCounts.get(key) ?? 0) + 1)
    const sdkCounts = new Map<string, number>()
    for (const key of sdkKeys) sdkCounts.set(key, (sdkCounts.get(key) ?? 0) + 1)
    // Multiset comparison: membership AND duplicate-count gaps on either side
    // are membership-unknowns (freshness unknown), never order.
    for (const [key, privCount] of privCounts) {
      const sdkCount = sdkCounts.get(key) ?? 0
      if (sdkCount !== privCount) {
        return { divergence: "config-warnings-membership-unknown", details: { ...base, privCount, sdkCount } }
      }
    }
    for (const [key, sdkCount] of sdkCounts) {
      if (!privCounts.has(key)) {
        return { divergence: "config-warnings-membership-unknown", details: { ...base, privCount: 0, sdkCount } }
      }
    }
    return { divergence: null, details: { ...base, compared: privWarnings.length } }
  }
  return { divergence: null, details: { ...base } }
}
