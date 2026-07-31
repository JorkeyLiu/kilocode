/**
 * Pure session-recovery helpers.
 *
 * LOCK-001: Never use raw message ID comparison as chronology for recovery.
 * LOCK-002: Authoritative full arrays replace recovered model exactly.
 * LOCK-003: Stale/out-of-order events must not overwrite newer state.
 *
 * All recovery is recomputed from the authoritative visible message array.
 * No monotonic guard, no raw ID comparison — store order IS the chronology.
 */

import type { Message, ModelSelection } from "../types/messages"
import type { RevertBoundary } from "./session-queue"

export interface RecoveredPrefs {
  model?: ModelSelection
  variant?: string
  agent?: string
}

/**
 * Recovery-specific visibility: find the boundary message by identity
 * (reference equality) and slice by array index. This replaces the
 * global `visibleMessages` dependency on raw `id < revert.messageID`
 * which breaks with non-sortable/custom IDs.
 *
 * Behavior when boundary absent: all messages visible (same as unrevert).
 * Behavior with partID: boundary message is visible (partial revert).
 * Behavior without partID: boundary message is excluded (full revert).
 */
export function recoveryVisible(messages: Message[], revert?: RevertBoundary): Message[] {
  if (!revert) return messages
  const idx = messages.findIndex((m) => m.id === revert.messageID)
  if (idx < 0) return messages
  // With partID: boundary message visible (partial revert)
  if (revert.partID) return messages.slice(0, idx + 1)
  // Without partID: boundary message excluded (full revert)
  return messages.slice(0, idx)
}

/**
 * Scan a message array newest-first for the last-used agent, model, and variant.
 * Used by `recomputeRecovered` after filtering to visible messages.
 */
export function resolveMessagePrefs(messages: Message[], names: Set<string>): {
  model?: ModelSelection
  variant?: string
  agent?: string
} {
  const prefs: { model?: ModelSelection; variant?: string; agent?: string } = {}
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    if (!prefs.agent) {
      const agent = msg.agent?.trim()
      if (agent && names.has(agent)) prefs.agent = agent
    }
    if (!prefs.model && msg.role === "user" && msg.model?.providerID && msg.model.modelID) {
      prefs.model = { providerID: msg.model.providerID, modelID: msg.model.modelID }
      prefs.variant = msg.model.variant
    }
    if (prefs.agent && prefs.model) break
  }
  return prefs
}

/**
 * Recompute recovery from the authoritative visible message array.
 *
 * Per LOCK-002: always replace recovered state with newest user message
 * by authoritative array order, or clear if none remain.
 *
 * Per LOCK-004: uses `recoveryVisible` (index-based) to apply the revert
 * boundary — never raw ID comparisons, never the global `visibleMessages`
 * which depends on `id < revert.messageID`.
 *
 * @param messages - The full authoritative messages array for the session
 * @param revert - The revert boundary (if any)
 * @param names - Valid agent names
 * @returns The recomputed recovered prefs (model may be undefined if no user message has a model)
 */
export function recomputeRecovered(
  messages: Message[],
  revert: RevertBoundary | null | undefined,
  names: Set<string>,
): RecoveredPrefs {
  const visible = recoveryVisible(messages, revert ?? undefined)
  return resolveMessagePrefs(visible, names)
}

/**
 * Validate a configured subagent/default variant against the model's
 * supported variants. Per LOCK-007: accepts only values in current variants.
 *
 * @param configured - The configured value (from config or override)
 * @param supported - The list of supported variant names for the model
 * @returns The validated variant, or undefined if none
 */
export function resolveValidVariant(
  configured: string | undefined | null,
  supported: string[],
): string | undefined {
  if (supported.length === 0) return undefined
  if (configured && supported.includes(configured)) return configured
  return undefined
}
