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
 * `permission` (LOCK-002) is hot because permission persistence is intentionally
 * in-memory-first: `Permission.reply` / `saveAlwaysRules` / allow-everything persist
 * via `updateGlobal({ permission }, { dispose: false })`, the agent cache key includes
 * permission, in-flight generations retain their pinned startup rules, and the live
 * in-memory permission state unblocks pending asks. A cold rebuild of a permission
 * save would drain the very generation a sibling permission ask is waiting on and drop
 * the in-memory pending state, so permission must never ride the convergence fence.
 * New generations observe the persisted rules through the cache-key refresh.
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
  "permission", // LOCK-002: hot permission persistence (updateGlobal dispose:false, cache-key refresh)
  // LOCK-003: explicit protected-file approvals follow the same in-memory-first
  // persistence as `permission` (updateGlobal dispose:false) and are read live by
  // Permission.ask from the global config; a cold rebuild would drain the pending
  // ask a sibling approval is waiting on.
  "protected_files",
])

/**
 * Returns true if every key in the patch is a hot key (no disposal needed).
 */
export function isHotPatch(patch: Record<string, unknown>): boolean {
  const keys = Object.keys(patch)
  if (keys.length === 0) return false
  return keys.every((key) => HOT_KEYS.has(key))
}
