import type { CanonicalProviderProtocol, CanonicalProviderVariantPayload } from "../../../../src/config/types"
import { isCanonicalProviderProtocol } from "../../../../src/config/types"

// Provider/model types for model selector

export interface ProviderModel {
  id: string
  name: string
  inputPrice?: number
  outputPrice?: number
  contextLength?: number
  releaseDate?: string
  latest?: boolean
  // Actual shape returned by the server (Provider.Model)
  limit?: { context: number; input?: number; output: number }
  variants?: Record<string, Record<string, unknown>>
  capabilities?: {
    reasoning: boolean
    input?: { text: boolean; image: boolean; audio: boolean; video: boolean; pdf: boolean }
  }
  options?: { description?: string }
  autoRouting?: { models: string[] }
  recommendedIndex?: number
  isFree?: boolean
  mayTrainOnYourPrompts?: boolean
  hasUserByokAvailable?: boolean
  terminalBench?: {
    overallScore: number
    avgAttemptCostUsd: number
  }
  cost?: {
    input: number
    output: number
    cache?: {
      read: number
      write: number
    }
  }
}

/** Fields shared by provider selectors in both legacy and canonical modes. */
export interface ProviderView {
  id: string
  name: string
  models: Record<string, ProviderModel>
  hasCredential?: boolean
  source?: "env" | "config" | "custom" | "api"
}

export interface Provider extends ProviderView {
  source?: "env" | "config" | "custom" | "api"
  env?: string[]
  metadata?: {
    noteKey?: string
    icon?: string
    priority?: number
  }
  protocol?: string
}

/** Selector-only provider model data used by canonical configuration. */
export interface CanonicalProviderModelView {
  readonly id: string
  readonly name: string
  readonly variants?: Readonly<Record<string, Readonly<CanonicalProviderVariantPayload>>>
}

/** Selector-only provider data used by canonical configuration. */
export interface CanonicalProviderView {
  readonly id: string
  readonly name: string
  readonly models: Readonly<Record<string, CanonicalProviderModelView>>
  readonly hasCredential: boolean
}

export interface ModelSelection {
  providerID: string
  modelID: string
}

export type ProviderAuthState = "api" | "oauth" | "wellknown"

export interface ProviderConfig {
  name?: string
  base_url?: string
  models?: Record<string, unknown>
  npm?: string
  env?: string[]
  options?: Record<string, unknown>
}

/**
 * Authored canonical provider config surfaced to the webview.
 * Exactly {name?, endpoint?, protocol?, models?} — never a credential
 * ref, headers, npm, env, or options. The extension host owns credentials.
 */
export interface CanonicalAuthoredProviderConfig {
  name?: string
  endpoint?: string
  protocol?: CanonicalProviderProtocol
  models?: Record<string, unknown>
}

/** Dialog-facing provider record: canonical shape or legacy shape. */
export interface ExistingProvider {
  providerID: string
  name: string
  config: CanonicalAuthoredProviderConfig | ProviderConfig
}

/**
 * Narrow an authored record to its canonical shape. True when the
 * canonical endpoint marker is present or a valid canonical protocol
 * token is present — including mixed legacy/canonical objects, where
 * the canonical side always wins.
 */
export function isCanonicalAuthoredConfig(cfg: unknown): cfg is CanonicalAuthoredProviderConfig {
  if (!cfg || typeof cfg !== "object") return false
  const rec = cfg as Record<string, unknown>
  if ("endpoint" in rec) return true
  return isCanonicalProviderProtocol(rec.protocol)
}

/** Legacy backend transport shape. Canonical messages must not use this type. */
export interface LegacyProviderConfig extends ProviderConfig {
  api_key?: string
}
