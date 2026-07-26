import type { AgentConfig, Config } from "../../types/messages"

/**
 * Build a minimal config patch that targets a single agent.
 *
 * Every edit/create/import path must route through this helper so the draft
 * never contains a full effective-agent or full-agent-map spread — only the
 * delta for the named agent. Tests import the same helper to guarantee the
 * shape is coupled to production, not duplicated.
 */
export function agentPatch(name: string, fragment: Partial<AgentConfig>): Partial<Config> {
  return { agent: { [name]: fragment } }
}

export function selectedDefaultAgentValue(value: string): string | null {
  return value || null
}

export function selectedAgentTextOverrideValue(value: string): string | null {
  return value === "" ? null : value
}

export function selectedAgentNumberOverrideValue(
  value: string,
  parse: (value: string) => number,
): number | null | undefined {
  if (value.trim() === "") return null
  const parsed = parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

export function shouldClearDefaultAgentWhenAgentBecomesUnavailable(
  nextValue: boolean,
  currentDefaultAgent: string | null | undefined,
  agentName: string,
): boolean {
  return nextValue && currentDefaultAgent === agentName
}
