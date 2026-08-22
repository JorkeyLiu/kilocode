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
  /** Backend session records — child sessions carry their delegated subagent here. */
  sessions?: Record<string, { agent?: string }>
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
 * LOCK-002: a session whose backend record carries a delegated agent (e.g. a
 * child session created by the task tool with a subagent) resolves to that
 * agent when it is in the full agent catalog (`allNames`, visible + subagents)
 * and no explicit/recovered-visible selection applies. The recovered check
 * stays validated against the VISIBLE `names` set (LOCK-004), so a recovered
 * visible agent still beats the delegated subagent.
 *
 * @returns The resolved agent name.
 */
export function resolveSessionAgent(
  store: AgentStore,
  sessionID: string,
  defaultAgent: string,
  names: Set<string>,
  allNames?: Set<string>,
): string {
  // Explicit user selection wins
  const explicit = store.agentSelections[sessionID]
  if (explicit) return explicit
  // Recovered continuity state — only if valid in current agent catalog
  const recovered = store.sessionRecoveredAgents[sessionID]
  if (recovered && names.has(recovered)) return recovered
  // Delegated agent stored on the backend session — only if still in the
  // full catalog (the agent may have been removed from config).
  const sessionAgent = store.sessions?.[sessionID]?.agent
  if (sessionAgent && allNames?.has(sessionAgent)) return sessionAgent
  return defaultAgent
}

/**
 * LOCK-004: Preserve an explicitly selected session/pending-draft agent in the
 * outbound prompt even when it equals the served default agent. An explicit
 * selection must not be erased merely because it equals the default; an
 * unselected/default-only path may still omit the agent if that is the
 * existing contract.
 *
 * Explicitness is determined by stored selection state, not by value equality:
 * - for a scoped send (draftID or real sessionID): `store.agentSelections[scope]` present
 * - for an unscoped pending composer: `pending !== null`
 *
 * Recovered continuity (`sessionRecoveredAgents`) is not explicit and does not
 * force a send.
 *
 * @returns agent name to send, or undefined when the established contract omits
 *   the default agent for a genuinely unselected path.
 */
export function resolvePromptAgent(
  store: AgentStore,
  pending: string | null,
  defaultAgent: string,
  names: Set<string>,
  allNames: Set<string> | undefined,
  scope: string | undefined,
): string | undefined {
  const resolved =
    scope !== undefined
      ? resolveSessionAgent(store, scope, defaultAgent, names, allNames)
      : (pending ?? defaultAgent)
  const explicit = scope !== undefined ? store.agentSelections[scope] !== undefined : pending !== null
  if (explicit) return resolved
  return resolved !== defaultAgent ? resolved : undefined
}
