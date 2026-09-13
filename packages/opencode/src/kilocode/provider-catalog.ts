import { Effect } from "effect"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ProviderCatalog } from "@/provider/catalog"
import { filterPromptTrainingModels } from "@/kilocode/provider/model-filter"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import {
  acquireDrainControl,
  InstanceUnavailableDuringConfigRebuildError,
} from "@/kilocode/server/drain-control-acquire"
import { InstanceRef } from "@/effect/instance-ref"
import { pickBy } from "remeda"

export const VERSION = 1 as const
export const OP = "provider/catalog" as const
export const CAPABILITY = "provider/catalog" as const

export interface ProviderCatalogRequest {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
}

export interface ProviderCatalogData {
  all: unknown[]
  default: Record<string, string>
  connected: string[]
  failed: string[]
}

export interface ProviderCatalogFailure {
  code: string
  message: string
  retryable: boolean
}

export interface ProviderCatalogSucceeded {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: ProviderCatalogData
}

export interface ProviderCatalogFailed {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "failed"
  outcome: { type: "failed"; time: number; failure: ProviderCatalogFailure }
  accepted: false
  failure: ProviderCatalogFailure
}

export interface ProviderCatalogAmbiguous {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "ambiguous"
  outcome: { type: "ambiguous"; time: number }
  accepted: false
  transportUnknown?: boolean
}

export type ProviderCatalogResult = ProviderCatalogSucceeded | ProviderCatalogFailed | ProviderCatalogAmbiguous

export const VALIDATION_MESSAGE = "invalid provider-catalog request"
export const SCOPE_MESSAGE = "directory mismatch"
export const FENCE_MESSAGE =
  "Instance is unavailable during config rebuild; no active runtime for this request"
export const INTERNAL_MESSAGE = "internal error"

export class ProviderCatalogInternal extends Error {
  readonly _tag = "ProviderCatalogInternal" as const
  constructor() {
    super(INTERNAL_MESSAGE)
    this.name = "ProviderCatalogInternal"
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

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

export function validateProviderCatalogRequest(raw: unknown): ProviderCatalogRequest {
  if (!record(raw)) throw new Error("params must be object")
  if (raw.v !== VERSION) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must be non-empty string without path material")
  if (raw.op !== OP) throw new Error("op must be provider/catalog")
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
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for provider-catalog")
  const allowedRoot = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  return raw as unknown as ProviderCatalogRequest
}

type Ids = { requestId: string }

function sanitized(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !pathless(v)) return "unknown"
  return v
}

export function fallbackProviderCatalogIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId) }
}

export function safeProviderCatalogIds(req: { requestId: string }): Ids {
  return { requestId: sanitized(req.requestId) }
}

export function failed(ids: Ids, code: string, message: string, retryable: boolean): ProviderCatalogFailed {
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

export function succeeded(req: ProviderCatalogRequest, data: ProviderCatalogData): ProviderCatalogSucceeded {
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

export function ambiguous(req: ProviderCatalogRequest, transportUnknown = true): ProviderCatalogAmbiguous {
  const out: ProviderCatalogAmbiguous = {
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

const PROVIDER_FIELDS = new Set([
  "id",
  "name",
  "description",
  "source",
  "env",
  "metadata",
  "hasCredential",
  "models",
])
const FORBIDDEN_PROVIDER_FIELDS = ["key", "options", "headers"]
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
const FORBIDDEN_MODEL_FIELDS = ["key", "options", "headers"]
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

function checkModel(raw: unknown): void {
  if (!record(raw)) throw new Error("model must be object")
  for (const k of Object.keys(raw)) {
    if (FORBIDDEN_MODEL_FIELDS.includes(k)) throw new Error(`forbidden model field ${k}`)
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

export function validateProviderCatalogEntry(raw: unknown): void {
  if (!record(raw)) throw new Error("provider entry must be object")
  for (const k of Object.keys(raw)) {
    if (FORBIDDEN_PROVIDER_FIELDS.includes(k)) throw new Error(`forbidden provider field ${k}`)
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

export function validateProviderCatalogData(raw: unknown): ProviderCatalogData {
  if (!record(raw)) throw new Error("data must be object")
  const allowed = new Set(["all", "default", "connected", "failed"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected data field")
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

const RESULT_SUCCEEDED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "failure"])
const RESULT_AMBIGUOUS = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "transportUnknown"])
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])
const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

function checkFailure(raw: unknown): ProviderCatalogFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as ProviderCatalogFailure
}

export function validateProviderCatalogResult(raw: unknown, req: ProviderCatalogRequest): ProviderCatalogResult {
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
    validateProviderCatalogData(rec.data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (out.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ProviderCatalogSucceeded
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
    return raw as unknown as ProviderCatalogFailed
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(out)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (out.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as ProviderCatalogAmbiguous
}

export function isSettledProviderCatalogResult(result: unknown, req: ProviderCatalogRequest): boolean {
  if (!record(result)) return false
  const status = (result as { status?: unknown }).status
  if (status !== "succeeded" && status !== "failed") return false
  try {
    const out = validateProviderCatalogResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}

// Shared `provider/catalog` read body for HTTP + fd. Only the redacted owner:
// `Config.Service.get()` + `Provider.Service.list()` +
// `filterPromptTrainingModels` + `ProviderCatalog.toCatalogResult`. Never the
// legacy `provider.list` raw secrets; `directory`/`workspace` are carrier
// routing identity only and never reach the service beyond `InstanceState`
// selection performed by the caller lane. The wire projection is the exact
// closed `ProviderCatalog.CatalogResult`; unknown fields are rejected so
// `key`/`options`/`headers` or other secrets can never cross.
export const fetchProviderCatalogData = (): Effect.Effect<
  ProviderCatalog.CatalogResult,
  never,
  Config.Service | Provider.Service
> =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const svc = yield* Provider.Service
    const config = yield* cfg.get().pipe(Effect.catch(() => Effect.die(new ProviderCatalogInternal())))
    const connected = yield* svc.list().pipe(Effect.catch(() => Effect.die(new ProviderCatalogInternal())))
    try {
      const providers = filterPromptTrainingModels(connected, config.hide_prompt_training_models === true)
      const valid = pickBy(providers, (item, id) => Object.keys(item.models).length > 0 || id in connected)
      const out = ProviderCatalog.toCatalogResult({
        providers: valid,
        def: Provider.defaultModelIDs(pickBy(valid, (item) => Object.keys(item.models).length > 0)),
        connected: Object.keys(connected),
        failed: [],
      })
      validateProviderCatalogData(out)
      return out
    } catch {
      return yield* Effect.die(new ProviderCatalogInternal())
    }
  })

// Private `provider/catalog`: routing-only directory validation, then the shared
// read via the existing drain-control + `InstanceRef` lane (same lane as
// `agent/list`/`skill/list`/`command/list` — no new lifecycle lane, no manual
// `InstanceRef` construction, no new drain/read lease, no journal/replay).
// `directory`/`workspace` are carrier routing identity only; `workspace`
// never reaches the service. Read-only, safely repeatable: an ambiguous
// transport outcome may safely repeat via the same-directory SDK
// `client.provider.catalog` fallback; the op never retries.
export const providerCatalogPrivate = Effect.fn("ProviderCatalogPrivate.read")(function* (raw: unknown) {
  let req: ProviderCatalogRequest
  try {
    req = validateProviderCatalogRequest(raw)
  } catch {
    return failed(fallbackProviderCatalogIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeProviderCatalogIds(req)
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
    const out = yield* fetchProviderCatalogData().pipe(
      Effect.map((data) => ({ tag: "ok" as const, data })),
      Effect.catch(() => Effect.succeed({ tag: "fail" as const })),
      Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const })),
    )
    if (out.tag !== "ok") return failed(safe, "internal", INTERNAL_MESSAGE, false)
    try {
      validateProviderCatalogData(out.data)
    } catch {
      return failed(safe, "internal", INTERNAL_MESSAGE, false)
    }
    return succeeded(req, out.data as unknown as ProviderCatalogData)
  }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
  return yield* inner.pipe(
    Effect.catch(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, false))),
    Effect.catchDefect(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, false))),
  )
})
