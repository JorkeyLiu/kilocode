import type { ModelSelection } from "../types/messages"
import { sessionVariantKeys, variantKey } from "./session-variant-store"

/**
 * LOCK-005 pending composer choices — pure helpers (vscode-free) so
 * session.tsx stays under its max-lines lint cap.
 */

export interface PendingVariant {
  value: string
  model: ModelSelection
}

export interface PendingChoices {
  model: ModelSelection | null
  variant: PendingVariant | null
}

/**
 * Materialize explicit fresh-composer picks into a target (draft or session)
 * as explicit state. The pending snapshot is the user's latest intent and
 * REPLACES the target's previously-seeded state (LOCK-002: explicit picks win
 * for every send attempt, including reuse of an existing draft after a
 * failed/in-flight send), while entries for other targets stay untouched.
 * Stale session-scoped seeds from an earlier pick are pruned so
 * transferDraftState cannot promote old first-seed state alongside the new
 * choices. Memory tiers stay below configured tiers (LOCK-005/LOCK-002).
 */
export function seedPendingChoices(
  target: string,
  agent: string,
  pending: PendingChoices,
  overrides: Record<string, ModelSelection>,
  variants: Record<string, string>,
): { overrides: Record<string, ModelSelection>; variants: Record<string, string> } {
  const nextOverrides = pending.model ? { ...overrides, [target]: pending.model } : overrides
  let nextVariants = variants
  if (pending.model || pending.variant) {
    nextVariants = { ...variants }
    for (const key of sessionVariantKeys(variants, target)) delete nextVariants[key]
  }
  if (pending.variant) {
    nextVariants[variantKey(pending.variant.model, agent, target)] = pending.variant.value
  }
  return { overrides: nextOverrides, variants: nextVariants }
}
