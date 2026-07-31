/**
 * Pure-logic helpers for per-session agent selection and recovered agent state.
 *
 * LOCK-001: Recovered agent is continuity state, not explicit user selection.
 * Apply it only when valid and no explicit session agent selection exists.
 *
 * LOCK-005: Resolution remains explicit agent > recovered continuity > default.
 *
 * Model resolution is canonical in session-model-store.ts (`getSessionModel`).
 * This module owns only agent resolution and recovery application.
 */

export interface AgentStore {
  /** sessionID -> agent name (explicit user selection only) */
  agentSelections: Record<string, string>
  /** sessionID -> recovered agent from message history (continuity) */
  sessionRecoveredAgents: Record<string, string>
}

/**
 * Apply recovered agent preference to agent store state.
 *
 * LOCK-001: Only writes to `sessionRecoveredAgents` (continuity state),
 * never to `agentSelections` (explicit user selection). This ensures
 * recovered agent is never confused with explicit user selection and
 * never overwrites it.
 *
 * @returns The updated sessionRecoveredAgents map (immutable replacement).
 */
export function applyRecoverAgent(
  current: Record<string, string>,
  sessionID: string,
  recoveredAgent: string | undefined,
  currentExplicit: Record<string, string>,
): Record<string, string> {
  // Explicit agent exists — never write recovered, but clean up stale entry
  if (currentExplicit[sessionID]) {
    if (!current[sessionID]) return current
    const next = { ...current }
    delete next[sessionID]
    return next
  }
  if (recoveredAgent) {
    if (current[sessionID] === recoveredAgent) return current
    return { ...current, [sessionID]: recoveredAgent }
  }
  // No recovered agent — clean up stale entry if present
  if (current[sessionID]) {
    const next = { ...current }
    delete next[sessionID]
    return next
  }
  return current
}

/**
 * Resolve the effective agent for a session.
 *
 * LOCK-001/LOCK-005: explicit agent selection > recovered agent > default.
 * Recovered agent is only used when no explicit selection exists and the
 * recovered agent is in the valid names set.
 *
 * @returns The resolved agent name.
 */
export function resolveSessionAgent(
  store: AgentStore,
  sessionID: string,
  defaultAgent: string,
  names: Set<string>,
): string {
  // Explicit user selection wins
  const explicit = store.agentSelections[sessionID]
  if (explicit) return explicit
  // Recovered continuity state — only if valid in current agent catalog
  const recovered = store.sessionRecoveredAgents[sessionID]
  if (recovered && names.has(recovered)) return recovered
  return defaultAgent
}
