/**
 * Classifies config patch keys as "hot" (no instance disposal needed) or "cold" (requires disposal).
 *
 * Hot keys are lazy model-preference fields consumed via config.get() at request time.
 * Provider state does not bake in these fields, so updating them should not trigger
 * instance disposal or provider catalog reload races.
 *
 * Agent overrides (`agent`, `default_agent`, legacy `mode`) are hot because Agent.state
 * is fully derived: its cacheKey includes these fields (see KiloAgent.cacheKey), so the
 * next Agent fetch invalidates and rebuilds from the new config. In-flight generations
 * keep reading their pinned ConfigSnapshot; no provider/instance resource owns agent
 * config, so updating it never requires a runtime swap.
 *
 * Cold keys include provider-coupled fields and all unclassified config fields.
 */

/** Keys that are safe to update without disposing provider/session instances. */
const HOT_KEYS = new Set([
  "console", // existing hot key (UI preferences)
  "model",
  "small_model",
  "model_variant",
  "model_variant_overrides",
  "subagent_model",
  "subagent_variant",
  "subagent_variant_overrides",
  // per-agent overrides are lazy derived state (LOCK-001)
  "agent", // Agent.state cacheKey includes agent; no runtime owns it
  "default_agent", // Agent.state cacheKey includes default_agent
  "mode", // legacy per-agent overrides; Agent.state cacheKey includes mode
])

/**
 * Returns true if every key in the patch is a hot key (no disposal needed).
 */
export function isHotPatch(patch: Record<string, unknown>): boolean {
  const keys = Object.keys(patch)
  if (keys.length === 0) return false
  return keys.every((key) => HOT_KEYS.has(key))
}
