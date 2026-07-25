import type { ModelSelection } from "../../types/messages"
import type { EnrichedModel } from "../../context/provider"
import {
  KILO_PROVIDER_ID as KILO_GATEWAY_ID,
  PROVIDER_PRIORITY as PROVIDER_ORDER,
  providerOrderIndex,
} from "../../../../src/shared/provider-model"

export { KILO_GATEWAY_ID, PROVIDER_ORDER }

// ---------------------------------------------------------------------------
// Row / group key helpers — single source of truth for key formatting
// ---------------------------------------------------------------------------

export const FAVORITES_KEY = "favorites"

export function modelKey(providerID: string, modelID: string) {
  return `${providerID}/${modelID}`
}

export function rowKey(kind: "model" | "favorite", providerID: string, modelID: string) {
  return `${kind}:${providerID}/${modelID}`
}

// ---------------------------------------------------------------------------
// Model grouping types and builder
// ---------------------------------------------------------------------------

interface ModelGroupRow {
  key: string
  kind: "favorite" | "model"
  model: EnrichedModel
}

interface ModelGroupData {
  key: string
  label: string
  rows: ModelGroupRow[]
}

/**
 * Build model groups for the model selector popover.
 *
 * Favorites is the only special top-level group. All other models — including
 * Kilo Auto models and recommended models — are grouped under their provider.
 * Within each provider group auto models sort first, then recommended (by
 * recommendedIndex), then alphabetical.
 */
export function buildModelGroups(
  models: EnrichedModel[],
  favorites: EnrichedModel[],
  favoritesLabel: string,
): ModelGroupData[] {
  const map = new Map<string, EnrichedModel[]>()

  for (const m of models) {
    const list = map.get(m.providerID) ?? []
    list.push(m)
    map.set(m.providerID, list)
  }

  const result: ModelGroupData[] = []

  if (favorites.length > 0) {
    result.push({
      key: FAVORITES_KEY,
      label: favoritesLabel,
      rows: favorites.map((m) => ({
        key: rowKey("favorite", m.providerID, m.id),
        kind: "favorite" as const,
        model: m,
      })),
    })
  }

  const rest: ModelGroupData[] = [...map.entries()]
    .sort(([a], [b]) => providerSortKey(a) - providerSortKey(b))
    .map(([id, list]) => {
      list.sort((a, b) => {
        // Auto models first within provider group
        const aAuto = isAuto(a) ? 0 : 1
        const bAuto = isAuto(b) ? 0 : 1
        if (aAuto !== bAuto) return aAuto - bAuto
        // Then by recommended index (undefined → Infinity)
        const aRec = a.recommendedIndex ?? Infinity
        const bRec = b.recommendedIndex ?? Infinity
        if (aRec !== bRec) return aRec - bRec
        // Then alphabetical
        return a.name.localeCompare(b.name)
      })
      return {
        key: id,
        label: list[0]?.providerName ?? id,
        rows: list.map((m) => ({
          key: rowKey("model", m.providerID, m.id),
          kind: "model" as const,
          model: m,
        })),
      }
    })

  return [...result, ...rest]
}

export const KILO_AUTO_SMALL_IDS = new Set(["kilo-auto/small", "auto-small"])
export const KILO_AUTO_EFFICIENT_ID = "kilo-auto/efficient"
const AUTO_FALLBACK = "Routes requests automatically."

interface Choice {
  id: string
  name: string
}

export function isAuto(model: Pick<EnrichedModel, "providerID" | "id">): boolean {
  return (
    model.providerID === KILO_GATEWAY_ID && (model.id.startsWith("kilo-auto/") || KILO_AUTO_SMALL_IDS.has(model.id))
  )
}

export function isAutoEfficient(model: Pick<EnrichedModel, "providerID" | "id">): boolean {
  return model.providerID === KILO_GATEWAY_ID && model.id === KILO_AUTO_EFFICIENT_ID
}

export function autoChoices(
  model: Pick<EnrichedModel, "providerID" | "id" | "autoRouting">,
  catalog: readonly Pick<EnrichedModel, "id" | "name">[] = [],
): readonly Choice[] {
  if (!isAutoEfficient(model)) return []
  const ids = model.autoRouting?.models
  if (!ids?.length) return []
  const names = new Map(catalog.map((item) => [item.id, stripSubProviderPrefix(sanitizeName(item.name))]))
  return ids.map((id) => ({ id, name: names.get(id) ?? id }))
}

export function autoSummary(model: Pick<EnrichedModel, "options">): string {
  const raw = model.options?.description?.split(/\n\s*\n/)[0]
  if (!raw) return AUTO_FALLBACK
  return raw.replace(/\s+/g, " ").trim() || AUTO_FALLBACK
}

export function isSmall(model: Pick<EnrichedModel, "providerID" | "id">): boolean {
  return model.providerID === KILO_GATEWAY_ID && KILO_AUTO_SMALL_IDS.has(model.id)
}

export function providerSortKey(providerID: string, order: readonly string[] = PROVIDER_ORDER): number {
  return providerOrderIndex(providerID, order as typeof PROVIDER_ORDER)
}

export function isFree(model: Pick<EnrichedModel, "isFree">): boolean {
  return model.isFree === true
}

export function isDataCollectedModel(model: Pick<EnrichedModel, "mayTrainOnYourPrompts">): boolean {
  return model.mayTrainOnYourPrompts === true
}

export function hasByok(model: Pick<EnrichedModel, "hasUserByokAvailable">): boolean {
  return model.hasUserByokAvailable === true
}

export function freeDataLabel(_free: string, data: string): string {
  return data
}

// Strips trailing "(free)" parenthesized suffix from model display names, e.g.
// "Llama 3 (free)" → "Llama 3". A separate "Free" label/tag is rendered
// elsewhere, so preserve bare trailing "Free" words (e.g. "Kilo Auto Free").
export function sanitizeName(name: string): string {
  return name.replace(/[\s:_-]*\(free\)\s*$/i, "").trim()
}

export function stripSubProviderPrefix(name: string): string {
  const colon = name.indexOf(": ")
  if (colon < 0) return name
  const prefix = name.slice(0, colon)
  if (prefix.toLowerCase() === KILO_GATEWAY_ID) return name
  return name.slice(colon + 2)
}

export function buildTriggerLabel(
  resolvedName: string | undefined,
  providerID: string | undefined,
  providerName: string | undefined,
  raw: ModelSelection | null,
  allowClear: boolean,
  clearLabel: string,
  hasProviders: boolean,
  labels: { select: string; noProviders: string; notSet: string },
): string {
  if (resolvedName) {
    if (providerID === KILO_GATEWAY_ID) return stripSubProviderPrefix(resolvedName)
    if (providerName) return `${providerName} / ${resolvedName}`
    return resolvedName
  }
  if (raw?.providerID && raw?.modelID) {
    return raw.providerID === KILO_GATEWAY_ID ? raw.modelID : `${raw.providerID} / ${raw.modelID}`
  }
  if (allowClear) return clearLabel || labels.notSet
  return hasProviders ? labels.select : labels.noProviders
}
