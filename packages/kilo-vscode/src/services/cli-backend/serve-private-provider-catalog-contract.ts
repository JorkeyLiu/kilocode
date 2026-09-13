// Private-first `provider/catalog` read-only observation contract (production).
// Request is strictly `{v:1,requestId,op:"provider/catalog",
// context:{directory,workspace?},payload:{}}` with no `opId`/`idempotencyKey`
// (observation identity is `requestId` only). Success data preserves the exact
// HTTP `GET /provider/catalog` shape (closed `ProviderCatalog.CatalogResult`):
// `all/default/connected/failed` with redacted providers/models; provider
// `key`/`options` and model `options`/`headers` or any other unlisted field is
// rejected fail-closed so secrets can never cross.
//
// Source facts:
// - Route: `GET /provider/catalog` with `WorkspaceRoutingQuery` in
//   `packages/opencode/src/server/routes/instance/httpapi/groups/provider.ts`
//   (`identifier: "provider.catalog"`, success `ProviderCatalog.CatalogResult`).
// - Handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts`
//   `catalog` returns the shared `fetchProviderCatalogData`
//   (`Config.Service.get()` + `Provider.Service.list()` +
//   `filterPromptTrainingModels` + `toCatalogResult`).
// - Service: `packages/opencode/src/kilocode/provider-catalog.ts`
//   (`fetchProviderCatalogData` + `providerCatalogPrivate`, same
//   drain-control + `InstanceRef` lane as `agent/list`).
// - SDK: v2 `client.provider.catalog({directory})` issues
//   `GET /provider/catalog` and remains the exactly-one fallback for
//   unavailable/retryable/invalid/ambiguous/transport/closed/timeout outcomes.
//   Validated terminal (`retryable === false`, including `validation.failed`/
//   `scope_mismatch`/`internal`) closes with zero SDK.
// - Consumer: `provider-actions.fetchProviderData` (non-canonical) is
//   private-first via `fetchProviderCatalogPrivateFirst`: validated success
//   returns with zero SDK; validated terminal closes with zero SDK (the whole
//   `fetchProviderData` rejects, outer `KiloProvider` keeps its old cache);
//   otherwise exactly one same-directory SDK fallback. The helper never
//   retries, posts, caches, journals, or reconciles; the caller keeps
//   `provider.auth`/`kilo.authStatus` parallel `catch`-to-`{}`/`null` failure
//   isolation untouched.
// - Distinct from `provider.auth`, `kilo.authStatus`, `models.discover`,
//   canonical provider pipeline, OAuth, snapshot endpoint. This contract
//   never matches those operations.
//
// ROUTING vs PAYLOAD SEMANTICS (v1):
// - `context.directory` binds request routing and scope. A scope match says
//   nothing about payload freshness or completeness.
// - Payload is validated shape-only. No freshness, ordering, lifecycle, or
//   cross-directory claim is made.
// - Out of scope: provider writes, OAuth, `models.discover`, `config.get`,
//   caching/dedup, UI rendering, transport behavior beyond the fixed failure
//   taxonomy.

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

function noNul(v: unknown): v is string {
  return typeof v === "string" && !v.includes("\0")
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

export interface ProviderCatalogContractRequest {
  v: 1
  requestId: string
  op: "provider/catalog"
  context: { directory: string; workspace?: string }
  payload: Record<string, never>
}

export function validateProviderCatalogContractRequest(raw: unknown): ProviderCatalogContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  clean(raw.requestId, "requestId")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must not carry path material")
  if (raw.op !== "provider/catalog") throw new Error("op must be provider/catalog")
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
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for provider-catalog")
  return raw as unknown as ProviderCatalogContractRequest
}

const PROVIDER_FIELDS = new Set(["id", "name", "description", "source", "env", "metadata", "hasCredential", "models"])
const FORBIDDEN_PROVIDER = new Set(["key", "options", "headers"])
const MODEL_FIELDS = new Set([
  "id",
  "providerID",
  "api",
  "name",
  "family",
  "capabilities",
  "cost",
  "limit",
  "status",
  "release_date",
  "variants",
  "recommendedIndex",
  "isFree",
  "mayTrainOnYourPrompts",
  "hasUserByokAvailable",
  "terminalBench",
  "autoRouting",
])
const FORBIDDEN_MODEL = new Set(["key", "options", "headers"])
const VARIANT_FIELDS = new Set([
  "enable_thinking",
  "reasoningEffort",
  "effort",
  "thinking",
  "reasoning_split",
  "chat_template_args",
])
const API_FIELDS = new Set(["id", "url", "npm"])
const MODALITY_FIELDS = new Set(["text", "audio", "image", "video", "pdf"])
const CAPABILITY_FIELDS = new Set(["temperature", "reasoning", "attachment", "toolcall", "input", "output", "interleaved"])
const METADATA_FIELDS = new Set(["noteKey", "icon", "priority"])

function checkBool(v: unknown, label: string): void {
  if (typeof v !== "boolean") throw new Error(`${label} invalid`)
}

function checkModalities(raw: unknown, label: string): void {
  if (!record(raw)) throw new Error(`${label} invalid`)
  for (const k of Object.keys(raw)) if (!MODALITY_FIELDS.has(k)) throw new Error(`unexpected ${label} field ${k}`)
  for (const k of MODALITY_FIELDS) checkBool((raw as Record<string, unknown>)[k], `${label}.${k}`)
}

function checkInterleaved(raw: unknown): void {
  if (typeof raw === "boolean") return
  if (!record(raw)) throw new Error("capabilities.interleaved invalid")
  for (const k of Object.keys(raw)) if (k !== "field") throw new Error("unexpected capabilities.interleaved field")
  const f = (raw as Record<string, unknown>).field
  if (f !== "reasoning_content" && f !== "reasoning_details") throw new Error("capabilities.interleaved.field invalid")
}

function checkCapabilities(raw: unknown): void {
  if (!record(raw)) throw new Error("capabilities invalid")
  for (const k of Object.keys(raw)) if (!CAPABILITY_FIELDS.has(k)) throw new Error(`unexpected capabilities field ${k}`)
  checkBool(raw.temperature, "capabilities.temperature")
  checkBool(raw.reasoning, "capabilities.reasoning")
  checkBool(raw.attachment, "capabilities.attachment")
  checkBool(raw.toolcall, "capabilities.toolcall")
  checkModalities(raw.input, "capabilities.input")
  checkModalities(raw.output, "capabilities.output")
  checkInterleaved(raw.interleaved)
}

function checkCacheCost(raw: unknown, label: string): void {
  if (!record(raw)) throw new Error(`${label} invalid`)
  for (const k of Object.keys(raw)) if (k !== "read" && k !== "write") throw new Error(`unexpected ${label} field ${k}`)
  if (!finite(raw.read) || !finite(raw.write)) throw new Error(`${label} invalid`)
}

// eslint-disable-next-line complexity
function checkCost(raw: unknown): void {
  if (!record(raw)) throw new Error("cost invalid")
  const allowed = new Set(["input", "output", "cache", "tiers", "experimentalOver200K"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error(`unexpected cost field ${k}`)
  if (!finite(raw.input) || !finite(raw.output)) throw new Error("cost invalid")
  checkCacheCost(raw.cache, "cost.cache")
  if (raw.tiers !== undefined) {
    if (!Array.isArray(raw.tiers)) throw new Error("cost.tiers invalid")
    for (const t of raw.tiers as unknown[]) {
      if (!record(t)) throw new Error("cost.tiers entry invalid")
      for (const k of Object.keys(t)) if (!["input", "output", "cache", "tier"].includes(k)) throw new Error("unexpected cost.tiers field")
      if (!finite(t.input) || !finite(t.output)) throw new Error("cost.tiers entry invalid")
      checkCacheCost(t.cache, "cost.tiers.cache")
      const tier = t.tier
      if (!record(tier)) throw new Error("cost.tiers.tier invalid")
      for (const k of Object.keys(tier)) if (k !== "type" && k !== "size") throw new Error("unexpected cost.tiers.tier field")
      if (tier.type !== "context" || !finite(tier.size)) throw new Error("cost.tiers.tier invalid")
    }
  }
  if (raw.experimentalOver200K !== undefined) {
    const e = raw.experimentalOver200K
    if (!record(e)) throw new Error("cost.experimentalOver200K invalid")
    for (const k of Object.keys(e)) if (!["input", "output", "cache"].includes(k)) throw new Error("unexpected cost.experimentalOver200K field")
    if (!finite(e.input) || !finite(e.output)) throw new Error("cost.experimentalOver200K invalid")
    checkCacheCost(e.cache, "cost.experimentalOver200K.cache")
  }
}

function checkLimit(raw: unknown): void {
  if (!record(raw)) throw new Error("limit invalid")
  const allowed = new Set(["context", "input", "output"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error(`unexpected limit field ${k}`)
  if (!finite(raw.context) || !finite(raw.output)) throw new Error("limit invalid")
  if (raw.input !== undefined && !finite(raw.input)) throw new Error("limit.input invalid")
}

// eslint-disable-next-line complexity
function checkVariant(raw: unknown): void {
  if (!record(raw)) throw new Error("variant invalid")
  for (const k of Object.keys(raw)) if (!VARIANT_FIELDS.has(k)) throw new Error(`unexpected variant field ${k}`)
  if (raw.enable_thinking !== undefined) checkBool(raw.enable_thinking, "variant.enable_thinking")
  if (raw.reasoningEffort !== undefined && typeof raw.reasoningEffort !== "string") throw new Error("variant.reasoningEffort invalid")
  if (raw.effort !== undefined && typeof raw.effort !== "string") throw new Error("variant.effort invalid")
  if (raw.thinking !== undefined) {
    const t = raw.thinking
    if (!record(t)) throw new Error("variant.thinking invalid")
    for (const k of Object.keys(t)) if (k !== "type") throw new Error("unexpected variant.thinking field")
    const ty = (t as Record<string, unknown>).type
    if (ty !== "enabled" && ty !== "disabled" && ty !== "adaptive") throw new Error("variant.thinking.type invalid")
  }
  if (raw.reasoning_split !== undefined) checkBool(raw.reasoning_split, "variant.reasoning_split")
  if (raw.chat_template_args !== undefined) {
    const c = raw.chat_template_args
    if (!record(c)) throw new Error("variant.chat_template_args invalid")
    for (const k of Object.keys(c)) if (k !== "enable_thinking") throw new Error("unexpected variant.chat_template_args field")
    checkBool((c as Record<string, unknown>).enable_thinking, "variant.chat_template_args.enable_thinking")
  }
}

// eslint-disable-next-line complexity
function checkModel(raw: unknown): void {
  if (!record(raw)) throw new Error("model must be object")
  for (const k of Object.keys(raw)) {
    if (FORBIDDEN_MODEL.has(k)) throw new Error(`forbidden model field ${k}`)
    if (!MODEL_FIELDS.has(k)) throw new Error(`unexpected model field ${k}`)
  }
  if (!present(raw.id) || (raw.id as string).includes("\0")) throw new Error("model.id invalid")
  if (!present(raw.providerID) || (raw.providerID as string).includes("\0")) throw new Error("model.providerID invalid")
  const api = raw.api
  if (!record(api)) throw new Error("model.api invalid")
  for (const k of Object.keys(api)) if (!API_FIELDS.has(k)) throw new Error(`unexpected model.api field ${k}`)
  if (typeof api.id !== "string" || typeof api.url !== "string" || typeof api.npm !== "string")
    throw new Error("model.api invalid")
  if (!noNul(raw.name)) throw new Error("model.name invalid")
  if (raw.family !== undefined && !noNul(raw.family)) throw new Error("model.family invalid")
  checkCapabilities(raw.capabilities)
  checkCost(raw.cost)
  checkLimit(raw.limit)
  const st = raw.status
  if (st !== "alpha" && st !== "beta" && st !== "deprecated" && st !== "active") throw new Error("model.status invalid")
  if (typeof raw.release_date !== "string") throw new Error("model.release_date invalid")
  if (raw.variants !== undefined) {
    if (!record(raw.variants)) throw new Error("model.variants invalid")
    for (const v of Object.values(raw.variants as Record<string, unknown>)) checkVariant(v)
  }
  if (raw.recommendedIndex !== undefined && !finite(raw.recommendedIndex)) throw new Error("model.recommendedIndex invalid")
  if (raw.isFree !== undefined) checkBool(raw.isFree, "model.isFree")
  if (raw.mayTrainOnYourPrompts !== undefined) checkBool(raw.mayTrainOnYourPrompts, "model.mayTrainOnYourPrompts")
  if (raw.hasUserByokAvailable !== undefined) checkBool(raw.hasUserByokAvailable, "model.hasUserByokAvailable")
  if (raw.terminalBench !== undefined) {
    const t = raw.terminalBench
    if (!record(t)) throw new Error("model.terminalBench invalid")
    for (const k of Object.keys(t)) if (k !== "overallScore" && k !== "avgAttemptCostUsd") throw new Error("unexpected model.terminalBench field")
    if (!finite(t.overallScore) || !finite(t.avgAttemptCostUsd)) throw new Error("model.terminalBench invalid")
  }
  if (raw.autoRouting !== undefined) {
    const a = raw.autoRouting
    if (!record(a)) throw new Error("model.autoRouting invalid")
    for (const k of Object.keys(a)) if (k !== "models") throw new Error("unexpected model.autoRouting field")
    if (!Array.isArray(a.models)) throw new Error("model.autoRouting.models invalid")
    for (const m of a.models as unknown[]) if (typeof m !== "string") throw new Error("model.autoRouting.models invalid")
  }
}

// eslint-disable-next-line complexity
export function validateProviderCatalogEntry(raw: unknown): void {
  if (!record(raw)) throw new Error("provider entry must be object")
  for (const k of Object.keys(raw)) {
    if (FORBIDDEN_PROVIDER.has(k)) throw new Error(`forbidden provider field ${k}`)
    if (!PROVIDER_FIELDS.has(k)) throw new Error(`unexpected provider field ${k}`)
  }
  if (!present(raw.id) || (raw.id as string).includes("\0")) throw new Error("provider.id invalid")
  if (!noNul(raw.name)) throw new Error("provider.name invalid")
  if (raw.description !== undefined && !noNul(raw.description)) throw new Error("provider.description invalid")
  const src = raw.source
  if (src !== "env" && src !== "config" && src !== "custom" && src !== "api") throw new Error("provider.source invalid")
  if (!Array.isArray(raw.env)) throw new Error("provider.env invalid")
  for (const e of raw.env as unknown[]) if (typeof e !== "string") throw new Error("provider.env invalid")
  if (raw.metadata !== undefined) {
    const m = raw.metadata
    if (!record(m)) throw new Error("provider.metadata invalid")
    for (const k of Object.keys(m)) if (!METADATA_FIELDS.has(k)) throw new Error(`unexpected provider.metadata field ${k}`)
    if (m.noteKey !== undefined && typeof m.noteKey !== "string") throw new Error("provider.metadata.noteKey invalid")
    if (m.icon !== undefined && typeof m.icon !== "string") throw new Error("provider.metadata.icon invalid")
    if (m.priority !== undefined && (typeof m.priority !== "number" || !Number.isInteger(m.priority)))
      throw new Error("provider.metadata.priority invalid")
  }
  checkBool(raw.hasCredential, "provider.hasCredential")
  const models = raw.models
  if (!record(models)) throw new Error("provider.models invalid")
  for (const m of Object.values(models as Record<string, unknown>)) checkModel(m)
}

export function validateProviderCatalogEntries(raw: unknown): void {
  if (!Array.isArray(raw)) throw new Error("all must be array")
  for (const item of raw as unknown[]) validateProviderCatalogEntry(item)
}

export interface ProviderCatalogData {
  all: Array<Record<string, unknown>>
  default: Record<string, string>
  connected: string[]
  failed: string[]
}

export function validateProviderCatalogData(raw: unknown): ProviderCatalogData {
  if (!record(raw)) throw new Error("data must be object")
  const allowed = new Set(["all", "default", "connected", "failed"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error(`unexpected data field ${k}`)
  validateProviderCatalogEntries(raw.all)
  const def = raw.default
  if (!record(def)) throw new Error("default must be object")
  for (const [k, v] of Object.entries(def as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0) throw new Error("default key invalid")
    if (typeof v !== "string" || v.length === 0) throw new Error("default value invalid")
  }
  if (!Array.isArray(raw.connected)) throw new Error("connected must be array")
  for (const c of raw.connected as unknown[]) if (typeof c !== "string") throw new Error("connected entry invalid")
  if (!Array.isArray(raw.failed)) throw new Error("failed must be array")
  for (const f of raw.failed as unknown[]) if (typeof f !== "string") throw new Error("failed entry invalid")
  return raw as unknown as ProviderCatalogData
}

export interface ProviderCatalogFailure {
  code: string
  message: string
  retryable: boolean
}

export const PROVIDER_CATALOG_FAILURE_CODES = new Set([
  "validation.failed",
  "scope_mismatch",
  "InstanceUnavailableDuringConfigRebuild",
  "internal",
] as const)
export type ProviderCatalogFailureCode =
  | "validation.failed"
  | "scope_mismatch"
  | "InstanceUnavailableDuringConfigRebuild"
  | "internal"
export const PROVIDER_CATALOG_FAILURE_MESSAGES: Record<ProviderCatalogFailureCode, string> = {
  "validation.failed": "invalid provider-catalog request",
  scope_mismatch: "directory mismatch",
  InstanceUnavailableDuringConfigRebuild:
    "Instance is unavailable during config rebuild; no active runtime for this request",
  internal: "internal error",
}
export const PROVIDER_CATALOG_FAILURE_RETRYABLE: Record<ProviderCatalogFailureCode, boolean> = {
  "validation.failed": false,
  scope_mismatch: false,
  InstanceUnavailableDuringConfigRebuild: true,
  internal: false,
}

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateProviderCatalogFailure(raw: unknown): ProviderCatalogFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (!FAILURE_FIELDS.has(k)) throw new Error(`unexpected failure field ${k}`)
  }
  if (typeof raw.code !== "string" || !PROVIDER_CATALOG_FAILURE_CODES.has(raw.code as ProviderCatalogFailureCode))
    throw new Error("failure code must be a known provider-catalog category")
  const code = raw.code as ProviderCatalogFailureCode
  if (raw.message !== PROVIDER_CATALOG_FAILURE_MESSAGES[code])
    throw new Error("failure message must be the fixed message for its code")
  if (raw.retryable !== PROVIDER_CATALOG_FAILURE_RETRYABLE[code])
    throw new Error("failure retryable must match its code")
  return raw as unknown as ProviderCatalogFailure
}

export type ProviderCatalogResult =
  | {
      v: 1
      requestId: string
      op: "provider/catalog"
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: ProviderCatalogData
    }
  | {
      v: 1
      requestId: string
      op: "provider/catalog"
      status: "failed"
      outcome: { type: "failed"; time: number; failure: ProviderCatalogFailure }
      accepted: boolean
      failure: ProviderCatalogFailure
    }
  | {
      v: 1
      requestId: string
      op: "provider/catalog"
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeProviderCatalogAmbiguous(
  req: ProviderCatalogContractRequest,
  transportUnknown = true,
): ProviderCatalogResult {
  const out: ProviderCatalogResult = {
    v: 1,
    requestId: req.requestId,
    op: "provider/catalog",
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type ProviderCatalogWireOutcome =
  | { kind: "valid"; result: ProviderCatalogResult }
  | { kind: "invalid"; detail: string }

export class ProviderCatalogValidationError extends Error {
  readonly kind = "private-provider-catalog-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "ProviderCatalogValidationError"
    this.detail = detail
  }
}

export function isProviderCatalogValidationError(v: unknown): v is ProviderCatalogValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-provider-catalog-validation"
}

export function normalizePrivateProviderCatalogWire(
  raw: unknown,
  req: ProviderCatalogContractRequest,
): ProviderCatalogWireOutcome {
  try {
    const result = validateProviderCatalogResult(raw, req)
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
export function validateProviderCatalogResult(
  raw: unknown,
  req: ProviderCatalogContractRequest,
): ProviderCatalogResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.op !== "provider/catalog") throw new Error("op mismatch")
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
    validateProviderCatalogData(data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ProviderCatalogResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error(`unexpected outcome field ${k}`)
    const failure = validateProviderCatalogFailure(rec.failure)
    const outFailure = validateProviderCatalogFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as ProviderCatalogResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error(`unexpected result field ${k}`)
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as ProviderCatalogResult
}

export function isSettledProviderCatalogResult(result: unknown, req: ProviderCatalogContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed") return false
  try {
    const out = validateProviderCatalogResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
