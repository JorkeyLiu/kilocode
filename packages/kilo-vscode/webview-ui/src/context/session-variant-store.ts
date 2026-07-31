import type { ModelSelection } from "../types/messages"

export function legacyVariantKey(sel: ModelSelection) {
  return `${sel.providerID}/${sel.modelID}`
}

export function variantKey(sel: ModelSelection, agent: string, session?: string) {
  const base = legacyVariantKey(sel)
  if (session) return `session/${session}/${base}`
  return `agent/${agent}/${base}`
}

/**
 * Canonical variant resolution result separating explicit user selection
 * from configured fallback. Used by production (currentVariant) and tests.
 *
 * LOCK-003: Distinguishes explicit selection from configured fallback.
 * LOCK-002: Precedence is explicit > recovered > override > global > variants[0].
 */
export interface VariantResolution {
  /** The resolved variant name */
  variant: string
  /** True if the variant came from an explicit user selection (session or agent store) */
  explicit: boolean
}

/**
 * Resolve the effective variant for a session, separating explicit user
 * selection from configured defaults.
 *
 * Precedence (LOCK-002):
 * 1. Valid explicit session/agent selection from variantSelections
 * 2. Valid recovered continuity variant (for the recovered/effective model)
 * 3. Valid configured model_variant_overrides
 * 4. Valid configured global model_variant
 * 5. variants[0] (fallback)
 *
 * LOCK-001: recovered variant provenance includes model identity.
 * It is eligible only when effective selected model exactly matches
 * its recovered model and variant is supported.
 *
 * @param store - The variantSelections map
 * @param sel - The resolved model selection
 * @param variants - The list of supported variant names for the model
 * @param agent - The effective agent name
 * @param session - The session ID (if any)
 * @param overrideVariant - Configured model_variant_overrides for this model
 * @param globalVariant - Configured global model_variant
 * @param recovered - Recovered variant with model provenance (continuity)
 * @returns The resolved variant and whether it was explicitly selected
 */
export function resolveSessionVariant(
  store: Record<string, string>,
  sel: ModelSelection,
  variants: string[],
  agent: string,
  session?: string,
  overrideVariant?: string,
  globalVariant?: string,
  recovered?: { variant: string; model: ModelSelection },
): VariantResolution {
  if (variants.length === 0) return { variant: "", explicit: false }
  const key = variantKey(sel, agent, session)
  const fallback = session ? store[variantKey(sel, agent)] : undefined
  const stored = store[key] ?? fallback ?? store[legacyVariantKey(sel)]
  // 1. Explicit user selection from store (session or agent scoped)
  if (stored && variants.includes(stored)) return { variant: stored, explicit: true }
  // 2. Recovered continuity variant — eligible only when effective model
  //    exactly matches the recovered model (LOCK-001).
  if (recovered && recovered.variant && variants.includes(recovered.variant)
    && sel.providerID === recovered.model.providerID && sel.modelID === recovered.model.modelID) {
    return { variant: recovered.variant, explicit: false }
  }
  // 3. Valid configured model override
  if (overrideVariant && variants.includes(overrideVariant)) return { variant: overrideVariant, explicit: false }
  // 4. Valid configured global model variant
  if (globalVariant && variants.includes(globalVariant)) return { variant: globalVariant, explicit: false }
  // 5. Fallback to first supported variant
  return { variant: variants[0], explicit: false }
}

/**
 * Legacy getVariant — returns only the variant string (no provenance).
 * Kept for backward compatibility; new code should use resolveSessionVariant.
 */
export function getVariant(
  store: Record<string, string>,
  sel: ModelSelection,
  variants: string[],
  agent: string,
  session?: string,
  overrideVariant?: string,
  globalVariant?: string,
) {
  return resolveSessionVariant(store, sel, variants, agent, session, overrideVariant, globalVariant).variant
}

export function transferVariants(store: Record<string, string>, from: string, to: string) {
  const prefix = `session/${from}/`
  return Object.fromEntries(
    Object.entries(store)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [`session/${to}/${key.slice(prefix.length)}`, value]),
  )
}

export function sessionVariantKeys(store: Record<string, string>, session: string) {
  const prefix = `session/${session}/`
  return Object.keys(store).filter((key) => key.startsWith(prefix))
}

export function sessionVariants(store: Record<string, string>, session: string) {
  const prefix = `session/${session}/`
  return Object.fromEntries(
    Object.entries(store)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value]),
  )
}
