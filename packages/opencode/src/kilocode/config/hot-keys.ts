/**
 * Classifies config patch keys as "hot" (no instance disposal needed) or "cold" (requires disposal).
 *
 * Hot keys are lazy model-preference fields consumed via config.get() at request time.
 * Provider state does not bake in these fields, so updating them should not trigger
 * instance disposal or provider catalog reload races.
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
])

/**
 * Returns true if every key in the patch is a hot key (no disposal needed).
 */
export function isHotPatch(patch: Record<string, unknown>): boolean {
  const keys = Object.keys(patch)
  if (keys.length === 0) return false
  return keys.every((key) => HOT_KEYS.has(key))
}
