import type { ModelSelection, Provider } from "../types/messages"
import { resolveModelSelection } from "./model-selection"

/**
 * Pure-logic helpers for per-session and global model selection.
 *
 * The SessionProvider delegates to these so the core state transitions
 * can be tested without SolidJS reactivity.
 */

export interface ModelStore {
  /** agentName -> model (global, extension-lifetime) */
  modelSelections: Record<string, ModelSelection | null>
  /** sessionID -> per-session model override (explicit user selection) */
  sessionOverrides: Record<string, ModelSelection>
  /** sessionID -> recovered model from message history (continuity, not override) */
  sessionRecoveredModels: Record<string, ModelSelection>
  /** sessionID -> agent name (explicit user selection) */
  agentSelections: Record<string, string>
  /** sessionID -> recovered agent from message history (continuity, not override) */
  sessionRecoveredAgents: Record<string, string>
  /** sessionID -> recovered variant bound to recovered model (continuity).
   *  `variant` is undefined when the session actually ran with no explicit
   *  variant (provider default) — the record's existence still blocks
   *  fall-through to configured/legacy memory (LOCK-003). */
  sessionRecoveredVariants: Record<string, { variant: string | undefined; model: ModelSelection }>
  recentModels: ModelSelection[]
}

export interface ResolveEnv {
  providers: Record<string, Provider>
  connected: string[]
  fallback: ModelSelection | null
  getModeModel: (agentName: string) => ModelSelection | null
  getGlobalModel: () => ModelSelection | null
}

function resolveModel(
  env: ResolveEnv,
  agentName: string,
  override?: ModelSelection | null,
  recents?: ModelSelection[],
  memory?: ModelSelection | null,
): ModelSelection | null {
  return resolveModelSelection({
    providers: env.providers,
    connected: env.connected,
    override,
    mode: env.getModeModel(agentName),
    global: env.getGlobalModel(),
    memory,
    recent: recents,
    fallback: env.fallback,
  })
}

/**
 * Returns the model for a specific session, honoring per-session overrides
 * and recovered continuity state.
 *
 * LOCK-003/LOCK-004 precedence:
 * explicit sessionOverride > [explicit agent: target agent chain] >
 * recovered continuity > agent normal chain.
 *
 * LOCK-004: when an explicit agent is selected, the target agent's configured
 * model (mode then global) resolves first, then that agent's remembered model,
 * then model memory. Recovered state is only continuity for sessions without
 * explicit selections.
 *
 * LOCK-002: the agent normal chain resolves configured model before per-agent
 * usage memory, so memory only applies when no configured value is present.
 *
 * Both explicit overrides and recovered state are validated against the
 * current provider catalog. Invalid values fall through to the next
 * precedence level so raw IDs are never surfaced in the UI.
 */
export function getSessionModel(
  store: ModelStore,
  env: ResolveEnv,
  sessionID: string,
  defaultAgent: string,
): ModelSelection | null {
  // LOCK-001/LOCK-005: explicit agent > recovered agent > default
  const agentName = store.agentSelections[sessionID] ?? store.sessionRecoveredAgents[sessionID] ?? defaultAgent
  const hasExplicitAgent = !!store.agentSelections[sessionID]
  // Explicit override — validated against catalog
  const explicit = store.sessionOverrides[sessionID]
  if (explicit) {
    const resolved = resolveModel(env, agentName, explicit)
    // Valid explicit wins: resolved matches the candidate → use it.
    // Invalid explicit: fall through to recovered > normal chain.
    if (resolved && resolved.providerID === explicit.providerID && resolved.modelID === explicit.modelID) {
      return resolved
    }
  }
  // LOCK-004: explicit agent → the target agent's configured model first,
  // then its remembered model — recovery is only continuity for sessions
  // without explicit selections.
  if (hasExplicitAgent) {
    return resolveModel(env, agentName, undefined, store.recentModels, store.modelSelections[agentName])
  }
  // No explicit agent — recovered continuity state may apply
  const recovered = store.sessionRecoveredModels[sessionID]
  if (recovered) {
    const resolved = resolveModel(env, agentName, recovered)
    // If the resolved model matches recovered, it was valid — use it.
    // Otherwise it fell through (invalid) — consult the normal chain.
    if (resolved && resolved.providerID === recovered.providerID && resolved.modelID === recovered.modelID) {
      return resolved
    }
  }
  // Normal chain (LOCK-002): configured per-agent/global model > usage memory
  return resolveModel(env, agentName, undefined, store.recentModels, store.modelSelections[agentName])
}

/**
 * Returns the model for the "current" view (model picker display).
 *
 * LOCK-003/LOCK-002 precedence: explicit sessionOverride > recovered
 * continuity > configured per-agent/global model > per-agent usage memory >
 * recent model memory.
 */
export function getSelected(
  store: ModelStore,
  env: ResolveEnv,
  sessionID: string | undefined,
  agentName: string,
): ModelSelection | null {
  if (sessionID) {
    // Explicit override — validated against catalog
    const explicit = store.sessionOverrides[sessionID]
    if (explicit) {
      const resolved = resolveModel(env, agentName, explicit)
      if (resolved && resolved.providerID === explicit.providerID && resolved.modelID === explicit.modelID) {
        return resolved
      }
      // Invalid explicit — fall through to recovered > normal chain
    }
    // Recovered continuity state — validated as override hint
    const recovered = store.sessionRecoveredModels[sessionID]
    if (recovered) {
      const resolved = resolveModel(env, agentName, recovered)
      if (resolved && resolved.providerID === recovered.providerID && resolved.modelID === recovered.modelID) {
        return resolved
      }
    }
  }
  // LOCK-002: configured model > usage memory > model memory
  return resolveModel(env, agentName, undefined, store.recentModels, store.modelSelections[agentName])
}

export interface ApplyResult {
  modelSelections: Record<string, ModelSelection | null>
  sessionOverrides: Record<string, ModelSelection>
}

/**
 * Apply a user-initiated model selection.
 *
 * Session-scoped selections write only to the per-session override.
 * No-session selections write to the global modelSelections map so sidebar
 * default picks still mirror CLI TUI's model.json behavior.
 */
export function applyModel(
  store: ModelStore,
  agentName: string,
  selection: ModelSelection,
  sessionID: string | undefined,
): ApplyResult {
  const modelSelections = sessionID
    ? { ...store.modelSelections }
    : { ...store.modelSelections, [agentName]: selection }
  const sessionOverrides = { ...store.sessionOverrides }

  if (sessionID) {
    sessionOverrides[sessionID] = selection
  }

  return { modelSelections, sessionOverrides }
}
