import { isUnsafeKey } from "../../../../src/shared/agent-credentials"

/**
 * Per-agent tool capability editing (runtime AgentCapability, not permissions).
 *
 * The UI only reads/writes the selected agent frontmatter `tools` boolean
 * record: `false` disables a tool, removing the key restores it. Other
 * authored entries (`true` or custom plugin/MCP names) are preserved verbatim
 * and never overwritten by a single-tool toggle. Allow/ask/deny permission
 * state is never read or written here.
 *
 * Display and mutation mirror the backend
 * (`packages/opencode/src/agent/capability.ts`):
 * - `patch` is an alias of `apply_patch`. `build`/`code` are independent
 *   custom tool ids (the `build`->`code` mapping elsewhere is an agent
 *   identity alias, not a tool alias).
 * - `edit`/`write`/`apply_patch` (plus `patch`) expand as one execution
 *   group: disabling any disables all three, and a same-definition specific
 *   `true` punches through the group/wildcard disable.
 * - `"*": false` disables every tool unless that tool is explicitly enabled
 *   in the same authored record. It is surfaced as its own row so an
 *   existing wildcard disable stays visible and recoverable.
 * Toggles are surgical: only keys that directly decide the operated tool
 * change; untouched authored `true`/unknown keys are preserved verbatim.
 */

export const KNOWN_AGENT_TOOLS = [
  "bash",
  "edit",
  "write",
  "apply_patch",
  "read",
  "grep",
  "glob",
  "task",
  "skill",
  "webfetch",
  "websearch",
  "todowrite",
] as const

const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const EDIT_GROUP = ["edit", "write", "apply_patch"] as const

function canon(raw: string): string {
  if (raw === "patch") return "apply_patch"
  return raw
}

function expand(raw: string): string[] {
  const id = canon(raw)
  if (id === "*") return ["*"]
  if ((EDIT_GROUP as readonly string[]).includes(id)) return [...EDIT_GROUP]
  return [id]
}

function split(tools: Record<string, unknown>): { disabled: Set<string>; enabled: Set<string> } {
  const disabled = new Set<string>()
  const enabled = new Set<string>()
  for (const [key, val] of Object.entries(tools)) {
    if (val === false) for (const id of expand(key)) disabled.add(id)
    else if (val === true) for (const id of expand(key)) enabled.add(id)
  }
  return { disabled, enabled }
}

function blocked(tools: Record<string, unknown>, name: string): boolean {
  const { disabled, enabled } = split(tools)
  const id = name === "*" ? "*" : canon(name)
  if (disabled.has(id)) return !enabled.has(id)
  if (id !== "*" && disabled.has("*")) return !enabled.has(id)
  return false
}

export function normalizeToolName(raw: string): string | null {
  const name = raw.trim()
  if (name.length < 1 || name.length > 128) return null
  if (!TOOL_NAME_RE.test(name)) return null
  if (isUnsafeKey(name)) return null
  return name
}

export function isToolEnabled(tools: Record<string, unknown> | undefined, name: string): boolean {
  if (!tools) return true
  return !blocked(tools, name)
}

/** Union of known tools plus any authored keys carried by frontmatter. */
export function listAgentTools(tools: Record<string, unknown> | undefined): string[] {
  const seen = new Set<string>(KNOWN_AGENT_TOOLS as readonly string[])
  const custom: string[] = []
  const wild = !!tools && Object.prototype.hasOwnProperty.call(tools, "*")
  if (tools) {
    for (const key of Object.keys(tools)) {
      if (isUnsafeKey(key)) continue
      if (key === "*") continue
      const id = canon(key)
      if (id === "*") continue
      if (seen.has(id)) continue
      if (normalizeToolName(id) === null && normalizeToolName(key) === null) continue
      seen.add(id)
      custom.push(id)
    }
  }
  custom.sort((a, b) => a.localeCompare(b))
  const base = [...(KNOWN_AGENT_TOOLS as readonly string[]), ...custom]
  return wild ? ["*", ...base] : base
}

/**
 * Toggle a single tool without touching other authored entries.
 * Disabling sets `false`; restoring deletes the key. Returns `undefined`
 * when no disabled/authored entries remain so callers can clear frontmatter.
 *
 * Alias/group/wildcard aware: enabling removes every `false` key whose
 * expansion covers the target (including the `patch` alias); `build` and
 * `code` are independent so neither covers the other; when a
 * wildcard disable remains, enabling adds an explicit `true` for the target
 * instead of clearing the wildcard. Disabling removes same-definition
 * `true` keys that would otherwise keep the target enabled, then sets the
 * canonical `false` unless the wildcard already holds the disable.
 */
export function toggleAgentTool(
  current: Record<string, unknown> | undefined,
  name: string,
  enabled: boolean,
): Record<string, unknown> | undefined {
  const next: Record<string, unknown> = { ...(current ?? {}) }
  if (name === "*") {
    if (enabled) delete next["*"]
    else next["*"] = false
    return Object.keys(next).length === 0 ? undefined : next
  }
  const cur: Record<string, unknown> = current ?? {}
  const id = canon(name)
  if (enabled) {
    if (isToolEnabled(cur, name)) return Object.keys(next).length === 0 ? undefined : next
    const causes = Object.keys(cur).filter(
      (key) => cur[key] === false && key !== "*" && expand(key).includes(id),
    )
    const wild = cur["*"] === false
    for (const key of causes) delete next[key]
    if (wild) next[id] = true
    return Object.keys(next).length === 0 ? undefined : next
  }
  if (!isToolEnabled(cur, name)) return Object.keys(next).length === 0 ? undefined : next
  const keeps = Object.keys(cur).filter((key) => cur[key] === true && expand(key).includes(id))
  for (const key of keeps) delete next[key]
  if (cur["*"] === false) return Object.keys(next).length === 0 ? undefined : next
  next[id] = false
  return Object.keys(next).length === 0 ? undefined : next
}
