import { Schema, Types } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { optionalOmitUndefined } from "@opencode-ai/core/schema"
import { ModelStatus } from "./model-status"
import type { Info as ProviderInfo, Model as ProviderModel } from "./provider"

const CatalogApiInfo = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  npm: Schema.String,
})

const CatalogModalities = Schema.Struct({
  text: Schema.Boolean,
  audio: Schema.Boolean,
  image: Schema.Boolean,
  video: Schema.Boolean,
  pdf: Schema.Boolean,
})

const CatalogInterleaved = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    field: Schema.Literals(["reasoning_content", "reasoning_details"]),
  }),
])

const CatalogCapabilities = Schema.Struct({
  temperature: Schema.Boolean,
  reasoning: Schema.Boolean,
  attachment: Schema.Boolean,
  toolcall: Schema.Boolean,
  input: CatalogModalities,
  output: CatalogModalities,
  interleaved: CatalogInterleaved,
})

const CatalogCacheCost = Schema.Struct({
  read: Schema.Finite,
  write: Schema.Finite,
})

const CatalogCostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: CatalogCacheCost,
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const CatalogCost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: CatalogCacheCost,
  tiers: optionalOmitUndefined(Schema.Array(CatalogCostTier)),
  experimentalOver200K: optionalOmitUndefined(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache: CatalogCacheCost,
    }),
  ),
})

const CatalogLimit = Schema.Struct({
  context: Schema.Finite,
  input: optionalOmitUndefined(Schema.Finite),
  output: Schema.Finite,
})

const CatalogMetadata = Schema.Struct({
  noteKey: optionalOmitUndefined(Schema.String),
  icon: optionalOmitUndefined(Schema.String),
  priority: optionalOmitUndefined(Schema.Int),
})

// Closed safe variant payload — reuses the canonical approved keys only.
// Any open/variant arbitrary secret (apiKey, token, headers, nested secrets)
// is dropped by the pure projection below; only these display-safe
// reasoning controls survive.
export const CatalogVariant = Schema.Struct({
  enable_thinking: optionalOmitUndefined(Schema.Boolean),
  reasoningEffort: optionalOmitUndefined(Schema.String),
  effort: optionalOmitUndefined(Schema.String),
  thinking: optionalOmitUndefined(
    Schema.Struct({
      type: Schema.Literals(["enabled", "disabled", "adaptive"]),
    }),
  ),
  reasoning_split: optionalOmitUndefined(Schema.Boolean),
  chat_template_args: optionalOmitUndefined(
    Schema.Struct({
      enable_thinking: Schema.Boolean,
    }),
  ),
}).annotate({ identifier: "ProviderCatalogVariant" })
export type CatalogVariant = Types.DeepMutable<Schema.Schema.Type<typeof CatalogVariant>>

export const CatalogModel = Schema.Struct({
  id: ModelV2.ID,
  providerID: ProviderV2.ID,
  api: CatalogApiInfo,
  name: Schema.String,
  family: optionalOmitUndefined(Schema.String),
  capabilities: CatalogCapabilities,
  cost: CatalogCost,
  limit: CatalogLimit,
  status: ModelStatus,
  release_date: Schema.String,
  variants: optionalOmitUndefined(Schema.Record(Schema.String, CatalogVariant)),
  recommendedIndex: optionalOmitUndefined(Schema.Finite),
  isFree: optionalOmitUndefined(Schema.Boolean),
  mayTrainOnYourPrompts: optionalOmitUndefined(Schema.Boolean),
  hasUserByokAvailable: optionalOmitUndefined(Schema.Boolean),
  terminalBench: optionalOmitUndefined(
    Schema.Struct({
      overallScore: Schema.Finite,
      avgAttemptCostUsd: Schema.Finite,
    }),
  ),
  autoRouting: optionalOmitUndefined(
    Schema.Struct({
      models: Schema.Array(Schema.String),
    }),
  ),
}).annotate({ identifier: "ProviderCatalogModel" })
export type CatalogModel = Types.DeepMutable<Schema.Schema.Type<typeof CatalogModel>>

export const CatalogProvider = Schema.Struct({
  id: ProviderV2.ID,
  name: Schema.String,
  description: optionalOmitUndefined(Schema.String),
  source: Schema.Literals(["env", "config", "custom", "api"]),
  env: Schema.Array(Schema.String),
  metadata: optionalOmitUndefined(CatalogMetadata),
  hasCredential: Schema.Boolean,
  models: Schema.Record(Schema.String, CatalogModel),
}).annotate({ identifier: "ProviderCatalogProvider" })
export type CatalogProvider = Types.DeepMutable<Schema.Schema.Type<typeof CatalogProvider>>

export const CatalogResult = Schema.Struct({
  all: Schema.Array(CatalogProvider),
  default: Schema.Record(Schema.String, Schema.String),
  connected: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.String),
}).annotate({ identifier: "ProviderCatalogResult" })
export type CatalogResult = Types.DeepMutable<Schema.Schema.Type<typeof CatalogResult>>

function isRecord(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false
  return true
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function pickBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined
}

function pickFinite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

// Dynamic map keys come from provider/model config and must never mutate the
// result prototype. Reject only the three legacy magic keys; ordinary keys
// keep insertion order and shape on a plain object.
const unsafeMapKey = new Set(["__proto__", "constructor", "prototype"])

function isSafeMapKey(key: string): boolean {
  return !unsafeMapKey.has(key)
}

// Whitelist projection for one variant value. Drops every non-approved key,
// so arbitrary plugin/config secrets in variants never reach JSON.
export function toCatalogVariant(input: unknown): CatalogVariant {
  if (!isRecord(input)) return {}
  const out: Record<string, unknown> = {}
  const thinkingType = isRecord(input.thinking) ? pickString(input.thinking.type) : undefined
  if (pickBoolean(input.enable_thinking) !== undefined) out.enable_thinking = input.enable_thinking
  if (pickString(input.reasoningEffort) !== undefined) out.reasoningEffort = input.reasoningEffort
  if (pickString(input.effort) !== undefined) out.effort = input.effort
  if (thinkingType === "enabled" || thinkingType === "disabled" || thinkingType === "adaptive") {
    out.thinking = { type: thinkingType }
  }
  if (pickBoolean(input.reasoning_split) !== undefined) out.reasoning_split = input.reasoning_split
  if (isRecord(input.chat_template_args) && pickBoolean(input.chat_template_args.enable_thinking) !== undefined) {
    out.chat_template_args = { enable_thinking: input.chat_template_args.enable_thinking }
  }
  return out as CatalogVariant
}

export function toCatalogVariantMap(input: unknown): Record<string, CatalogVariant> | undefined {
  if (!isRecord(input)) return undefined
  const out: Record<string, CatalogVariant> = {}
  for (const [k, v] of Object.entries(input)) {
    if (typeof k !== "string" || k.length === 0) continue
    if (!isSafeMapKey(k)) continue
    out[k] = toCatalogVariant(v)
  }
  return out
}

export function hasCredentialFor(provider: Pick<ProviderInfo, "key">): boolean {
  return typeof provider.key === "string" && provider.key.length > 0
}

// Pure redacted projection. Explicitly omits provider `key`/`options` and
// model `options`/`headers`; picks only closed display-safe fields.
export function toCatalogModel(model: ProviderModel): CatalogModel {
  const raw = model as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {
    id: model.id,
    providerID: model.providerID,
    api: model.api,
    name: model.name,
    capabilities: model.capabilities,
    cost: model.cost,
    limit: model.limit,
    status: model.status,
    release_date: model.release_date,
  }
  const family = pickString(raw.family ?? (model as unknown as { family?: unknown }).family)
  if (family !== undefined) out.family = family
  const variants = toCatalogVariantMap((model as unknown as { variants?: unknown }).variants)
  if (variants !== undefined) out.variants = variants
  const rec = pickFinite(raw.recommendedIndex)
  if (rec !== undefined) out.recommendedIndex = rec
  const free = pickBoolean(raw.isFree)
  if (free !== undefined) out.isFree = free
  const train = pickBoolean(raw.mayTrainOnYourPrompts)
  if (train !== undefined) out.mayTrainOnYourPrompts = train
  const byok = pickBoolean(raw.hasUserByokAvailable)
  if (byok !== undefined) out.hasUserByokAvailable = byok
  if (isRecord(raw.terminalBench)) {
    const score = pickFinite(raw.terminalBench.overallScore)
    const cost = pickFinite(raw.terminalBench.avgAttemptCostUsd)
    if (score !== undefined && cost !== undefined) out.terminalBench = { overallScore: score, avgAttemptCostUsd: cost }
  }
  if (isRecord(raw.autoRouting) && Array.isArray(raw.autoRouting.models)) {
    const models = (raw.autoRouting.models as unknown[]).filter((x): x is string => typeof x === "string")
    if (models.length === (raw.autoRouting.models as unknown[]).length) out.autoRouting = { models }
  }
  return out as unknown as CatalogModel
}

export function toCatalogProvider(provider: ProviderInfo): CatalogProvider {
  const raw = provider as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {
    id: provider.id,
    name: provider.name,
    source: provider.source,
    env: Array.isArray(provider.env) ? provider.env.filter((x): x is string => typeof x === "string") : [],
    hasCredential: hasCredentialFor(provider),
    models: {},
  }
  const desc = pickString(raw.description)
  if (desc !== undefined) out.description = desc
  if (isRecord(raw.metadata)) {
    const meta: Record<string, unknown> = {}
    const note = pickString(raw.metadata.noteKey)
    if (note !== undefined) meta.noteKey = note
    const icon = pickString(raw.metadata.icon)
    if (icon !== undefined) meta.icon = icon
    const pri = raw.metadata.priority
    if (typeof pri === "number" && Number.isInteger(pri)) meta.priority = pri
    if (Object.keys(meta).length > 0) out.metadata = meta
  }
  const models: Record<string, CatalogModel> = {}
  for (const [k, m] of Object.entries(provider.models ?? {})) {
    if (typeof k !== "string" || k.length === 0) continue
    if (!isSafeMapKey(k)) continue
    if (!m) continue
    models[k] = toCatalogModel(m as ProviderModel)
  }
  out.models = models
  return out as unknown as CatalogProvider
}

export function toCatalogResult(input: {
  providers: Record<string, ProviderInfo>
  def: Record<string, string>
  connected: string[]
  failed: string[]
}): CatalogResult {
  return {
    all: Object.values(input.providers).map(toCatalogProvider),
    default: { ...input.def },
    connected: [...input.connected],
    failed: [...input.failed],
  }
}

export * as ProviderCatalog from "./catalog"
