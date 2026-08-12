import type { ModelSelection, Provider } from "../types/messages"
import { isModelValid } from "./provider-utils"

function validate(
  providers: Record<string, Provider>,
  connected: string[],
  selection: ModelSelection | null | undefined,
): ModelSelection | null {
  if (!selection) return null
  // LOCK-001: empty catalog → cannot validate → return null so
  // resolveModelSelection falls through to its fallback (KILO_AUTO),
  // never leaking a raw unvalidated config/override.
  if (Object.keys(providers).length === 0) return null
  return isModelValid(providers, connected, selection) ? selection : null
}

function recent(
  providers: Record<string, Provider>,
  connected: string[],
  selections: ModelSelection[] | undefined,
): ModelSelection | null {
  for (const item of selections ?? []) {
    const selection = validate(providers, connected, item)
    if (selection) return selection
  }
  return null
}

/**
 * Resolve a model selection following the locked precedence:
 *
 * LOCK-002 (new-session / initialization candidates):
 *   explicit override > configured per-agent model > configured global model
 *   > per-agent usage memory > recent model memory > fallback.
 *
 * LOCK-004 (selector transitions): a target agent's configured model resolves
 * first, then that agent's remembered model, then model memory.
 *
 * Every candidate tier is validated against the current provider catalog so a
 * stale memory/config value never leaks raw into the UI (LOCK-001). The
 * fallback tier is deliberately unvalidated so KILO_AUTO remains reachable
 * before the catalog arrives.
 */
export function resolveModelSelection(input: {
  providers: Record<string, Provider>
  connected: string[]
  override?: ModelSelection | null
  mode?: ModelSelection | null
  global?: ModelSelection | null
  memory?: ModelSelection | null
  recent?: ModelSelection[]
  fallback?: ModelSelection | null
}): ModelSelection | null {
  return (
    validate(input.providers, input.connected, input.override) ??
    validate(input.providers, input.connected, input.mode) ??
    validate(input.providers, input.connected, input.global) ??
    validate(input.providers, input.connected, input.memory) ??
    recent(input.providers, input.connected, input.recent) ??
    input.fallback ??
    null
  )
}
