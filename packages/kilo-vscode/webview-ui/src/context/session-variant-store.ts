import type { ModelSelection } from "../types/messages"

export function legacyVariantKey(sel: ModelSelection) {
  return `${sel.providerID}/${sel.modelID}`
}

/**
 * Build the canonical variant store key.
 *
 * LOCK-001: the session-scoped key includes the agent
 * (`session/{sessionID}/{agent}/{providerID}/{modelID}`) so a variant picked
 * for one agent in a session never shadows the per-agent tier for other
 * agents. The agent-scoped key (`agent/{agent}/{providerID}/{modelID}`) and
 * the model-only legacy key (`{providerID}/{modelID}`) are unchanged.
 */
export function variantKey(sel: ModelSelection, agent: string, session?: string) {
  const base = legacyVariantKey(sel)
  if (session) return `session/${session}/${agent}/${base}`
  return `agent/${agent}/${base}`
}

/**
 * Canonical variant resolution result separating explicit user selection
 * from configured/remembered fallback. Used by production (currentVariant)
 * and tests.
 *
 * LOCK-003: Distinguishes explicit session choice from configured/remembered
 * fallback.
 * LOCK-002: Precedence is explicit session > recovered > configured override
 * > configured global > agent+model memory > model-only memory > variants[0].
 */
export interface VariantResolution {
  /** The resolved variant name. `undefined` means "no explicit variant"
   *  (provider default) — e.g. recovered history that actually ran default. */
  variant: string | undefined
  /** True only when the variant is an explicit session-scoped user choice */
  explicit: boolean
}

/**
 * Resolve the effective variant for a session, separating explicit user
 * selection from configured defaults and usage memory.
 *
 * Precedence (LOCK-002/LOCK-003/LOCK-004):
 * 1. Valid explicit session-scoped choice (variantSelections session key)
 * 2. Valid recovered continuity variant (for the recovered/effective model) —
 *    including the meaningful "ran with no explicit variant" state, which
 *    blocks fall-through to config/legacy memory (LOCK-003). Skipped when the
 *    user has explicitly selected an agent (LOCK-004: no leakage across an
 *    agent switch).
 * 3. Valid configured model_variant_overrides
 * 4. Valid configured global model_variant
 * 5. Valid agent+model usage memory (agent key)
 * 6. Valid model-only usage memory (legacy key)
 * 7. variants[0] (fallback)
 *
 * LOCK-001: recovered variant provenance includes model identity.
 * It is eligible only when effective selected model exactly matches
 * its recovered model and variant is supported.
 *
 * LOCK-002/LOCK-004: configured strength resolves before remembered
 * strength, so usage memory only applies when no configured value exists.
 * LOCK-005: a manual in-session pick (tier 1) persists memory tiers (5/6)
 * but never rewrites the configured tiers (3/4).
 *
 * @param store - The variantSelections map
 * @param sel - The resolved model selection
 * @param variants - The list of supported variant names for the model
 * @param agent - The effective agent name
 * @param session - The session ID (if any)
 * @param overrideVariant - Configured model_variant_overrides for this model
 * @param globalVariant - Configured global model_variant
 * @param recovered - Recovered variant with model provenance (continuity)
 * @param explicitAgent - True when the user explicitly selected the agent
 * @param memoryAllowed - True when usage-memory tiers (5/6) may resolve. A
 *   restored session whose history has not been recovered yet passes false so
 *   a stale remembered strength can never display as if it were
 *   current-session state before recovery lands. Explicit session choices
 *   (tier 1) and configured tiers (3/4) still resolve.
 * @returns The resolved variant and whether it was explicitly selected
 */
/** First valid usage-memory variant for the exact (agent, model): agent+model key, then model-only key. */
function rememberedVariant(
  store: Record<string, string>,
  sel: ModelSelection,
  variants: string[],
  agent: string,
): string | undefined {
  const agentStored = store[variantKey(sel, agent)]
  if (agentStored && variants.includes(agentStored)) return agentStored
  const legacyStored = store[legacyVariantKey(sel)]
  return legacyStored && variants.includes(legacyStored) ? legacyStored : undefined
}

export function resolveSessionVariant(
  store: Record<string, string>,
  sel: ModelSelection,
  variants: string[],
  agent: string,
  session?: string,
  overrideVariant?: string,
  globalVariant?: string,
  recovered?: { variant: string | undefined; model: ModelSelection },
  explicitAgent?: boolean,
  memoryAllowed = true,
): VariantResolution {
  if (variants.length === 0) return { variant: undefined, explicit: false }
  // 1. Explicit session-scoped choice — the current manual session pick
  //    (LOCK-003). Keyed per agent so one agent's pick never leaks to another.
  const sessionKey = session ? variantKey(sel, agent, session) : undefined
  const sessionStored = sessionKey ? store[sessionKey] : undefined
  if (sessionStored && variants.includes(sessionStored)) return { variant: sessionStored, explicit: true }
  // 2. Recovered continuity variant — eligible only when effective model
  //    exactly matches the recovered model (LOCK-001). An explicit agent
  //    switch resolves the target agent's own chain, never the previous
  //    agent's recovered strength (LOCK-004).
  if (
    !explicitAgent &&
    recovered &&
    sel.providerID === recovered.model.providerID &&
    sel.modelID === recovered.model.modelID
  ) {
    // LOCK-003: a recovered record with an undefined variant is the meaningful
    // "ran with no explicit variant (provider default)" state. Return it so
    // display and future sends do not fall through to configured or legacy
    // memory. A stale non-empty variant (no longer supported) still falls
    // through to the configured/memory tiers.
    if (recovered.variant === undefined) return { variant: undefined, explicit: false }
    if (variants.includes(recovered.variant)) return { variant: recovered.variant, explicit: false }
  }
  // 3. Valid configured model override (LOCK-002/004: configured specified start)
  if (overrideVariant && variants.includes(overrideVariant)) return { variant: overrideVariant, explicit: false }
  // 4. Valid configured global model variant
  if (globalVariant && variants.includes(globalVariant)) return { variant: globalVariant, explicit: false }
  // 5/6. Agent+model then model-only usage memory. Skipped until a restored
  //    session's history has been recovered so a stale remembered strength
  //    cannot display before recovery lands.
  if (memoryAllowed) {
    const memory = rememberedVariant(store, sel, variants, agent)
    if (memory) return { variant: memory, explicit: false }
  }
  // 7. Fallback to first supported variant
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
  recovered?: { variant: string | undefined; model: ModelSelection },
  explicitAgent?: boolean,
) {
  return resolveSessionVariant(
    store,
    sel,
    variants,
    agent,
    session,
    overrideVariant,
    globalVariant,
    recovered,
    explicitAgent,
  ).variant
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

/**
 * Apply a `variantsLoaded` payload to the live store with replace semantics
 * for persistent memory while preserving live session-scoped picks
 * (LOCK-004): reset posts `variantsLoaded {}`, so the empty payload must
 * clear remembered agent+model and model-only keys from the live store
 * without a reload — and never touch current-session explicit choices.
 */
export function mergeLoadedVariants(current: Record<string, string>, loaded: Record<string, string>) {
  const live: Record<string, string> = {}
  for (const [key, value] of Object.entries(current)) {
    if (key.startsWith("session/")) live[key] = value
  }
  return { ...live, ...loaded }
}
