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
  /** sessionID -> recovered variant bound to recovered model (continuity) */
  sessionRecoveredVariants: Record<string, { variant: string; model: ModelSelection }>
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
): ModelSelection | null {
  return resolveModelSelection({
    providers: env.providers,
    connected: env.connected,
    override,
    mode: env.getModeModel(agentName),
    global: env.getGlobalModel(),
    recent: recents,
    fallback: env.fallback,
  })
}

/**
 * Returns the model for a specific session, honoring per-session overrides
 * and recovered continuity state.
 *
 * Precedence: explicit sessionOverride > per-agent normal chain (when explicit
 * agent selected) > recovered continuity > config/default.
 *
 * When an explicit agent is selected, the agent's configured/default model
 * takes precedence over recovered state — recovery is only continuity for
 * sessions without explicit selections.
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
  // When an explicit agent is selected, the agent's configured/default model
  // takes precedence over recovered state — recovery is only continuity
  // for sessions without explicit selections.
  if (hasExplicitAgent) {
    return resolveModel(env, agentName, store.modelSelections[agentName], store.recentModels)
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
  // Normal chain: per-agent global > config/default
  return resolveModel(env, agentName, store.modelSelections[agentName], store.recentModels)
}

/**
 * Returns the model for the "current" view (model picker display).
 *
 * Precedence: explicit sessionOverride > recovered continuity >
 *             global modelSelections[agent] > config/default.
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
  return resolveModel(env, agentName, store.modelSelections[agentName], store.recentModels)
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
