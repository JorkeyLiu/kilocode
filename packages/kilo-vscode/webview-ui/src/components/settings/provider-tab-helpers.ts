/**
 * Pure helper functions for ProvidersTab provider classification, control policy,
 * and configured/add list construction. Keeping these outside the component
 * ensures they are testable without a DOM and avoids eager-forward-const TDZ
 * issues (LOCK-009).
 */

import type { Provider, ProviderAuthState } from "../../types/messages"
import { isCustomProviderPackage, KILO_PROVIDER_ID } from "../../../../src/shared/provider-model"
import { isCanonicalProviderProtocol } from "../../../../src/config/types"
import { sortProviders } from "./provider-catalog"

/** The single control rendered in the primary grid slot of a configured row. */
export type PrimarySlot = "edit" | "apiKey" | "chatgpt" | "anaconda" | "placeholder"

export type ProviderSource = "env" | "api" | "config" | "custom"

/** Extract the source field from a Provider if present and valid. */
export function providerSource(item: Provider): ProviderSource | undefined {
  if (!("source" in item)) return undefined
  const value = (item as Provider & { source?: string }).source
  if (value === "env" || value === "api" || value === "config" || value === "custom") return value
  return undefined
}

/**
 * Internal reserved IDs that are never custom providers. Mirrors the host
 * canonical gate (KiloProvider RESERVED_CUSTOM_IDS): only these existing
 * internal routing IDs are denied. Ordinary IDs — including future
 * built-in-like IDs — are never added here.
 */
const RESERVED_CUSTOM_IDS = new Set([KILO_PROVIDER_ID, "_custom", "anaconda-desktop"])

/** True when a config entry carries the legal canonical custom shape (endpoint + protocol). */
function isCanonicalCustomConfig(cfg: unknown): boolean {
  if (!cfg || typeof cfg !== "object") return false
  const rec = cfg as Record<string, unknown>
  return (
    typeof rec.endpoint === "string" && rec.endpoint.length > 0 && isCanonicalProviderProtocol(rec.protocol)
  )
}

/**
 * Determine if a provider is a custom provider.
 * Accepts (a) the canonical view signal `source === "custom"` on a
 * non-reserved ID (canonical providers always carry `source: "custom"`),
 * (b) the legal canonical authored shape `{endpoint, protocol}`, or
 * (c) the legacy compat shape `{npm: <custom package>}`.
 */
export function isCustom(item: Provider, configProvider?: Record<string, unknown>): boolean {
  if (RESERVED_CUSTOM_IDS.has(item.id)) return false
  const cfg = configProvider?.[item.id]
  if (cfg && typeof cfg === "object") {
    const rec = cfg as Record<string, unknown>
    if (isCustomProviderPackage(rec.npm)) return true
    if (isCanonicalCustomConfig(cfg)) return true
  }
  if (providerSource(item) === "custom") return true
  return false
}

/**
 * Pure predicate: is this a configured custom (non-Kilo) provider?
 * Kilo fallback source "custom" must never be treated as custom for
 * Edit/Delete purposes (LOCK-045).
 */
export function isCustomConfigured(item: Provider, configProvider?: Record<string, unknown>): boolean {
  if (item.id === KILO_PROVIDER_ID) return false
  return isCustom(item, configProvider)
}

/**
 * Collect all "configured" provider IDs — any provider the user has interacted
 * with (connected, disabled, has config entry, or has stored auth).
 */
export function allConfiguredIds(
  connected: string[],
  disabledIds: Set<string>,
  configProvider: Record<string, unknown> | undefined,
  authStates: Record<string, ProviderAuthState>,
): Set<string> {
  const ids = new Set<string>()
  for (const id of connected) ids.add(id)
  for (const id of disabledIds) ids.add(id)
  if (configProvider) {
    for (const id of Object.keys(configProvider)) ids.add(id)
  }
  for (const id of Object.keys(authStates)) ids.add(id)
  return ids
}

/**
 * Resolve a Provider object for a configured ID.
 * Falls back through: backend providers → config metadata → synthetic ID.
 * Synthetic Kilo (`KILO_PROVIDER_ID`) is never reconstructed when the backend
 * omits it — even if auth/config state contains that ID (bounded
 * settings-surface removal, LOCK-006). Generic custom provider IDs remain
 * reconstructible from auth/config.
 */
export function resolveConfiguredProvider(
  id: string,
  allProviders: Record<string, Provider>,
  configProvider?: Record<string, unknown>,
): Provider | undefined {
  const fromBackend = allProviders[id]
  if (fromBackend) return fromBackend
  if (id === KILO_PROVIDER_ID) return undefined

  const cfg = configProvider?.[id]
  if (cfg && typeof cfg === "object") {
    const c = cfg as Record<string, unknown>
    return {
      id,
      name: typeof c.name === "string" ? c.name : id,
      models: {},
      source: isCustomProviderPackage(c.npm) || isCanonicalCustomConfig(cfg) ? "custom" : "config",
    }
  }

  return { id, name: id, models: {} }
}

/** Neutral configured sort: alphabetical by name, id as stable tiebreak. */
function sortConfigured(items: Provider[]): Provider[] {
  return items.slice().sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** Build the Configured providers list. Suppresses synthetic Kilo when backend omits it. */
export function buildConfiguredList(
  allProviders: Record<string, Provider>,
  connected: string[],
  disabledIds: Set<string>,
  configProvider: Record<string, unknown> | undefined,
  authStates: Record<string, ProviderAuthState>,
): Provider[] {
  const ids = allConfiguredIds(connected, disabledIds, configProvider, authStates)
  const list = Array.from(ids)
    .map((id) => resolveConfiguredProvider(id, allProviders, configProvider))
    .filter((item): item is Provider => item !== undefined)
  return sortConfigured(list)
}

/** Build the Add providers list: generic unconfigured providers (alphabetical; no preset popularity). */
export function buildAddList(allProviders: Record<string, Provider>, configuredIds: Set<string>): Provider[] {
  return sortProviders(Object.values(allProviders).filter((item) => !configuredIds.has(item.id)))
}

/**
 * Temporary custom-only product boundary (VS Code orchestrator).
 * Only user-created custom providers are supported; built-in provider
 * configuration/connection is hidden in the product surface. Dormant
 * backend/OAuth implementation is retained but must not be triggered.
 */
export const CUSTOM_ONLY_UNSUPPORTED =
  "Only custom providers are supported temporarily — built-in provider setup is unavailable"

export function isCustomOnlyConfigured(item: Provider, configProvider?: Record<string, unknown>): boolean {
  return isCustomConfigured(item, configProvider)
}

/** Custom-only configured list: keep only custom configured providers. */
export function buildCustomConfiguredList(
  allProviders: Record<string, Provider>,
  connected: string[],
  disabledIds: Set<string>,
  configProvider: Record<string, unknown> | undefined,
  authStates: Record<string, ProviderAuthState>,
): Provider[] {
  return buildConfiguredList(allProviders, connected, disabledIds, configProvider, authStates).filter((item) =>
    isCustomConfigured(item, configProvider),
  )
}

/** Custom-only add list: built-in add rows are hidden; custom entry is rendered separately. */
export function buildCustomAddList(): Provider[] {
  return []
}

/**
 * Determine whether the inline API Key button should be visible for a
 * configured provider row (LOCK-032 / LOCK-035).
 *
 * Visible when:
 *  - authStates[id] === "api"  (the provider uses an API key credential)
 *  - source is NOT "env"       (env keys come from the shell, not the user)
 *  - source is NOT "config"    (config keys are host-managed and never revealed to the webview)
 *
 * Kilo OAuth rows never show an API Key button. If a hypothetical Kilo auth
 * api occurs, the button is shown but Kilo fallback is not treated as custom.
 */
export function showInlineApiKey(item: Provider, authStates: Record<string, ProviderAuthState>): boolean {
  const id = item.id
  const src = providerSource(item)
  const auth = authStates[id]
  if (auth !== "api") return false
  if (src === "env" || src === "config") return false
  return true
}

/**
 * Resolve which single control occupies the primary grid slot of a configured
 * provider row (LOCK-052 / LOCK-053).
 *
 * Priority: custom Edit → API Key → ChatGPT → Anaconda → placeholder.
 * Exactly one result — the caller renders exactly one Grid child.
 */
export function resolvePrimarySlot(opts: {
  isCustom: boolean
  hasApiKey: boolean
  hasChatGPT: boolean
  isAnaconda: boolean
}): PrimarySlot {
  if (opts.isCustom) return "edit"
  if (opts.hasApiKey) return "apiKey"
  if (opts.hasChatGPT) return "chatgpt"
  if (opts.isAnaconda) return "anaconda"
  return "placeholder"
}
