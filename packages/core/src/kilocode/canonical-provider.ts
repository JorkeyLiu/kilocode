// kilocode_change - V1-only canonical-only predicate for inert preservation
// A provider is canonical-only (excluded from legacy Provider DB) iff it has a definitive
// signal (endpoint/protocol/credential) and lacks any legacy operational key at provider
// or model/variant level. Definitive signals are only endpoint/protocol/credential (never name/models).
// Any legacy provider key (api, npm, env, options, id, whitelist, blacklist) or legacy
// model/variant operational key makes it non-canonical and preserves legacy/hybrid behavior.
// Unknown nested keys follow existing ConfigV1 excess-property policy (not treated as legacy).

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

const V1_LEGACY_PROVIDER_KEYS = new Set(["api", "npm", "env", "options", "id", "whitelist", "blacklist"])
const V1_LEGACY_MODEL_KEYS = new Set([
  "id",
  "family",
  "prompt",
  "isFree",
  "ai_sdk_provider",
  "release_date",
  "attachment",
  "temperature",
  "tool_call",
  "interleaved",
  "cost",
  "limit",
  "experimental",
  "status",
  "provider",
  "options",
  "headers",
])

const APPROVED_VARIANT_KEYS = new Set(["enable_thinking", "reasoningEffort", "effort", "thinking", "reasoning_split", "chat_template_args"])
const THINKING_TYPES = new Set(["enabled", "disabled", "adaptive"])

function isThinkingRecord(v: unknown): boolean {
  if (!isRecord(v)) return false
  const r = v as Record<string, unknown>
  const keys = Object.keys(r)
  if (keys.length !== 1 || keys[0] !== "type") return false
  return typeof r.type === "string" && THINKING_TYPES.has(r.type)
}

function isChatTemplateArgsRecord(v: unknown): boolean {
  if (!isRecord(v)) return false
  const r = v as Record<string, unknown>
  const keys = Object.keys(r)
  if (keys.length !== 1 || keys[0] !== "enable_thinking") return false
  return typeof r.enable_thinking === "boolean"
}

function isCanonicalVariantBody(v: unknown): boolean {
  if (v === undefined) return true
  if (!isRecord(v)) return false
  const r = v as Record<string, unknown>
  for (const k of Object.keys(r)) if (!APPROVED_VARIANT_KEYS.has(k)) return false
  if (r.enable_thinking !== undefined && typeof r.enable_thinking !== "boolean") return false
  if (r.reasoningEffort !== undefined && typeof r.reasoningEffort !== "string") return false
  if (r.effort !== undefined && typeof r.effort !== "string") return false
  if (r.thinking !== undefined && !isThinkingRecord(r.thinking)) return false
  if (r.reasoning_split !== undefined && typeof r.reasoning_split !== "boolean") return false
  if (r.chat_template_args !== undefined && !isChatTemplateArgsRecord(r.chat_template_args)) return false
  return true
}

function hasLegacyProviderKeys(info: Record<string, unknown>): boolean {
  for (const key of Object.keys(info)) {
    if (V1_LEGACY_PROVIDER_KEYS.has(key) && info[key] !== undefined) return true
  }
  return false
}

function hasLegacyModelKeys(model: Record<string, unknown>): boolean {
  for (const key of Object.keys(model)) {
    if (V1_LEGACY_MODEL_KEYS.has(key) && model[key] !== undefined) return true
  }
  const variants = (model as Record<string, unknown>).variants
  if (variants !== undefined) {
    if (!isRecord(variants)) return true
    for (const variant of Object.values(variants)) {
      if (variant === null) continue
      if (!isRecord(variant)) return true
      // disabled is an accepted operational variant field — any presence makes it hybrid
      if (Object.prototype.hasOwnProperty.call(variant, "disabled")) return true
      for (const k of Object.keys(variant)) {
        if (!APPROVED_VARIANT_KEYS.has(k)) return true
      }
      if (!isCanonicalVariantBody(variant)) return true
    }
  }
  return false
}

function hasDefinitiveSignal(info: Record<string, unknown>): boolean {
  return info.endpoint !== undefined || info.protocol !== undefined || info.credential !== undefined
}

export function isCanonicalOnlyProviderV1(info: unknown): boolean {
  if (!isRecord(info)) return false
  if (!hasDefinitiveSignal(info)) return false
  if (hasLegacyProviderKeys(info)) return false
  const models = info.models
  if (models !== undefined) {
    if (!isRecord(models)) return false
    for (const model of Object.values(models)) {
      if (model === null) continue
      if (!isRecord(model)) return false
      if (hasLegacyModelKeys(model)) return false
    }
  }
  return true
}
