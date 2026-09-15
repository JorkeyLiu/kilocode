// kilocode_change - shared pure canonical provider/model validators (host-compatible)
// Single source for closed canonical record/model validation.
// No SecretStorage or HTTP, only pure checks. Used by CLI provenance extraction
// and by VS Code (imported via @opencode-ai/core).

import { parseOwnedCredentialRef as parseOwnedCredentialRefCore } from "./credential-ref"
import { isProviderExecuteProtocol } from "./provider-execute"

function isRecord(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(obj).every((k) => allowed.has(k))
}

const THINKING_TYPES = new Set(["enabled", "disabled", "adaptive"])

function isThinkingRecord(v: unknown): boolean {
  if (!isRecord(v)) return false
  const r = v as Record<string, unknown>
  return hasOnlyKeys(r, new Set(["type"])) && typeof r.type === "string" && THINKING_TYPES.has(r.type)
}

function isChatTemplateArgsRecord(v: unknown): boolean {
  if (!isRecord(v)) return false
  const r = v as Record<string, unknown>
  return hasOnlyKeys(r, new Set(["enable_thinking"])) && typeof r.enable_thinking === "boolean"
}

export const APPROVED_VARIANT_KEYS = new Set(["enable_thinking", "reasoningEffort", "effort", "thinking", "reasoning_split", "chat_template_args"])
const APPROVED_MODEL_KEYS = new Set(["name", "reasoning", "modalities", "variants"])
const APPROVED_PROVIDER_KEYS = new Set(["name", "endpoint", "protocol", "models", "credential"])

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((item) => typeof item === "string")
}

export function isValidVariantEntry(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!hasOnlyKeys(v, APPROVED_VARIANT_KEYS)) return false
  if (v.enable_thinking !== undefined && typeof v.enable_thinking !== "boolean") return false
  if (v.reasoningEffort !== undefined && typeof v.reasoningEffort !== "string") return false
  if (v.effort !== undefined && typeof v.effort !== "string") return false
  if (v.thinking !== undefined && !isThinkingRecord(v.thinking)) return false
  if (v.reasoning_split !== undefined && typeof v.reasoning_split !== "boolean") return false
  if (v.chat_template_args !== undefined && !isChatTemplateArgsRecord(v.chat_template_args)) return false
  return true
}

function isValidModalities(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (!hasOnlyKeys(v, new Set(["input", "output"]))) return false
  if (v.input !== undefined && !isStringArray(v.input)) return false
  if (v.output !== undefined && !isStringArray(v.output)) return false
  return true
}

function isValidEndpoint(v: unknown): boolean {
  if (typeof v !== "string") return false
  if (!/^https?:\/\//.test(v)) return false
  try {
    // eslint-disable-next-line no-new
    new URL(v)
  } catch {
    return false
  }
  return true
}

export type CanonicalProviderValidationContext = {
  readonly providerId?: string
  readonly scope?: "global" | "project"
}

function normalizeCredentialContext(
  context?: string | CanonicalProviderValidationContext,
): CanonicalProviderValidationContext | undefined {
  if (context === undefined) return undefined
  if (typeof context === "string") return { providerId: context }
  return context
}

function isValidProviderCredential(v: unknown, context?: string | CanonicalProviderValidationContext): boolean {
  if (typeof v !== "string") return false
  const parsed = parseOwnedCredentialRefCore(v)
  if (!parsed) return false
  if (parsed.kind !== "provider") return false
  const ctx = normalizeCredentialContext(context)
  if (ctx?.providerId !== undefined && parsed.id !== ctx.providerId) return false
  if (ctx?.scope !== undefined && parsed.scope !== ctx.scope) return false
  return true
}

export function isValidModelEntry(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (typeof v.name !== "string" || v.name.length === 0) return false
  if (!hasOnlyKeys(v, APPROVED_MODEL_KEYS)) return false
  if (v.reasoning !== undefined && typeof v.reasoning !== "boolean") return false
  if (v.modalities !== undefined && !isValidModalities(v.modalities)) return false
  if (v.variants !== undefined) {
    if (!isRecord(v.variants)) return false
    for (const variant of Object.values(v.variants as Record<string, unknown>)) {
      if (!isValidVariantEntry(variant)) return false
    }
  }
  return true
}

export function isValidModelsMap(v: unknown): boolean {
  if (!isRecord(v)) return false
  return Object.values(v).every(isValidModelEntry)
}

export function isValidCanonicalProviderEntry(
  v: unknown,
  context?: string | CanonicalProviderValidationContext,
): boolean {
  if (!isRecord(v)) return false
  if (!hasOnlyKeys(v, APPROVED_PROVIDER_KEYS)) return false
  if (v.name !== undefined && (typeof v.name !== "string" || v.name.length === 0)) return false
  if (v.endpoint !== undefined && !isValidEndpoint(v.endpoint)) return false
  if (v.protocol !== undefined && !isProviderExecuteProtocol(v.protocol)) return false
  if (v.credential !== undefined && !isValidProviderCredential(v.credential, context)) return false
  if (v.models !== undefined) {
    if (!isValidModelsMap(v.models)) return false
    if (Object.keys(v.models as Record<string, unknown>).length === 0) return false
  }
  return true
}

export type CanonicalProviderVariantPayload = {
  readonly enable_thinking?: boolean
  readonly reasoningEffort?: string
  readonly effort?: string
  readonly thinking?: { readonly type: "enabled" | "disabled" | "adaptive" }
  readonly reasoning_split?: boolean
  readonly chat_template_args?: { readonly enable_thinking: boolean }
}

export type CanonicalProviderModelPayload = {
  readonly name: string
  readonly reasoning?: boolean
  readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] }
  readonly variants?: { readonly [name: string]: CanonicalProviderVariantPayload }
}

export type CanonicalProviderPayload = {
  readonly name?: string
  readonly endpoint?: string
  readonly protocol?: string
  readonly models?: { readonly [id: string]: CanonicalProviderModelPayload }
  readonly credential?: string
}

const FALLBACK_PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-_]*$/i

export type FallbackModelRef = {
  readonly providerID: string
  readonly modelID: string
}

/**
 * Parse a single active-fallback selection in "provider/model" format.
 * Additive preference only: callers never route the ordinary primary model
 * selector through this value. Returns undefined for absent/malformed input.
 */
export function parseFallbackModelRef(v: unknown): FallbackModelRef | undefined {
  if (typeof v !== "string") return undefined
  const text = v.trim()
  if (!text || text.length > 256) return undefined
  const slash = text.indexOf("/")
  if (slash <= 0 || slash === text.length - 1) return undefined
  const providerID = text.slice(0, slash)
  const modelID = text.slice(slash + 1)
  if (!FALLBACK_PROVIDER_PATTERN.test(providerID)) return undefined
  if (!modelID || /[\s\0]/.test(modelID)) return undefined
  return { providerID, modelID }
}

export * as CanonicalRecord from "./canonical-record"
