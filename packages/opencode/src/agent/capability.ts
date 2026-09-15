// kilocode_change - per-agent tool capability gate independent of permission rules.
// An authored `tools: {tool:false}` entry disables the tool as runtime capability.
// Presets, agent.permission allow rules, session approvals, and allowEverything
// can never re-enable it. Presentation (tool-list filtering) derives from this
// set; Permission.disabled() remains a presentation-only predicate.
import { Effect, Schema } from "effect"

export const WILDCARD = "*"

const EDIT_GROUP = ["edit", "write", "apply_patch"] as const

function canonicalKey(key: string): string {
  return key === "patch" ? "apply_patch" : key
}

function expandKey(key: string): string[] {
  const canon = canonicalKey(key)
  if (canon === WILDCARD) return [WILDCARD]
  if ((EDIT_GROUP as readonly string[]).includes(canon)) return [...EDIT_GROUP]
  return [canon]
}

export interface Carrier {
  readonly name?: string
  readonly disabledTools?: readonly string[]
  readonly enabledTools?: readonly string[]
}

export class DisabledError extends Schema.TaggedErrorClass<DisabledError>()("AgentToolDisabledError", {
  tool: Schema.String,
  agent: Schema.String,
}) {
  override get message() {
    return `Tool '${this.tool}' is disabled for agent '${this.agent}' and cannot be re-enabled by permissions or approvals.`
  }
}

export function fromToolsConfig(tools?: Record<string, boolean>): { disabled: string[]; enabled: string[] } {
  const disabled = new Set<string>()
  const enabled = new Set<string>()
  for (const [key, value] of Object.entries(tools ?? {})) {
    if (value === false) for (const id of expandKey(key)) disabled.add(id)
    else if (value === true) for (const id of expandKey(key)) enabled.add(id)
  }
  return { disabled: [...disabled], enabled: [...enabled] }
}

export function merge(
  baseDisabled: readonly string[] | undefined,
  baseEnabled: readonly string[] | undefined,
  explicit?: Record<string, boolean>,
): { disabled: string[]; enabled: string[] } {
  const seen = fromToolsConfig(explicit)
  const disabled = new Set<string>([...(baseDisabled ?? []), ...seen.disabled])
  const enabled = new Set<string>([...(baseEnabled ?? []), ...seen.enabled])
  // Explicit specific re-enables punch out inherited disables. An explicit
  // wildcard enable never clears specific disables (restrictive safety).
  for (const id of seen.enabled) {
    if (id === WILDCARD) continue
    disabled.delete(id)
  }
  return { disabled: [...disabled], enabled: [...enabled] }
}

export function isDisabled(agent: Carrier | undefined, tool: string): boolean {
  if (!agent) return false
  const id = canonicalKey(tool)
  const disabled = new Set(agent.disabledTools ?? [])
  const enabled = new Set(agent.enabledTools ?? [])
  if (disabled.has(id)) return !enabled.has(id)
  if (disabled.has(WILDCARD)) return !enabled.has(id)
  return false
}

export const assert = Effect.fn("AgentCapability.assert")(function* (agent: Carrier, tool: string) {
  if (isDisabled(agent, tool)) {
    return yield* Effect.fail(new DisabledError({ tool: canonicalKey(tool), agent: agent.name ?? "unknown" }))
  }
})

export function filterTools<T>(agent: Carrier, tools: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [key, value] of Object.entries(tools)) {
    if (isDisabled(agent, key)) continue
    out[key] = value
  }
  return out
}

export * as AgentCapability from "./capability"
