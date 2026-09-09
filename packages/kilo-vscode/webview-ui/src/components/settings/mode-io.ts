import type { AgentConfig, PermissionConfig } from "../../types/messages"
import { findAgentCredentialViolations, isUnsafeKey } from "../../../../src/shared/agent-credentials"

/** Maximum import file size in bytes (1 MB). */
export const MAX_IMPORT_SIZE = 1_048_576

const NAME_RE = /^[a-z][a-z0-9-]*$/
const MODES = ["subagent", "primary", "all"] as const
const LEVELS = new Set(["allow", "ask", "deny"])

export type ImportError = "invalidJson" | "invalidName" | "nameTaken" | "tooLarge" | "invalidField"

export type ImportResult = { ok: true; name: string; config: AgentConfig } | { ok: false; error: ImportError }

/** Check if a value is a valid permission level string or null delete sentinel. */
function isLevel(v: unknown): boolean {
  return (typeof v === "string" && LEVELS.has(v)) || v === null
}

/**
 * Strictly validate one permission rule: an action level (or null sentinel)
 * or a non-empty per-pattern map where EVERY level is valid. Partial maps
 * are rejected, not filtered — the CLI loader drops the whole file on any
 * invalid entry, so a filtered import would lie about what was imported.
 */
function parsePermissionRule(val: unknown): PermissionConfig[string] | undefined {
  if (isLevel(val)) return val as PermissionConfig[string]
  if (typeof val === "object" && val !== null && !Array.isArray(val)) {
    // Nested per-pattern rules like { "*": "ask", "uname": "allow" }
    const entries = Object.entries(val)
    if (entries.length === 0 || !entries.every(([, lev]) => isLevel(lev))) return undefined
    const nested: Record<string, string | null> = {}
    for (const [pat, lev] of entries) nested[pat] = lev as string
    return nested as PermissionConfig[string]
  }
  return undefined
}

/**
 * Strictly validate a permission value mirroring the actual CLI loader
 * behavior (probed): records where EVERY rule is fully valid pass;
 * top-level null passes (the CLI decodes it); scalar strings fail because
 * the CLI loader rejects them. Returns undefined for anything invalid —
 * callers surface `invalidField` instead of silently dropping the value.
 */
export function parsePermission(raw: unknown): PermissionConfig | null | undefined {
  if (raw === null) return null
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: PermissionConfig = {}
  for (const [key, val] of Object.entries(raw)) {
    const rule = parsePermissionRule(val)
    if (rule === undefined) return undefined
    out[key] = rule
  }
  return out
}

const REQUIREMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function isRequirementName(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= 128 && /\S/.test(v)
}

function isRequirementId(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= 128 && REQUIREMENT_ID_RE.test(v)
}

function isExtensionEntry(v: unknown): v is { name: string; id: string } {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    isRequirementName((v as Record<string, unknown>).name) &&
    isRequirementId((v as Record<string, unknown>).id)
  )
}

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length
}

function takeNameGroup(
  raw: Record<string, unknown>,
  clean: Record<string, unknown>,
  key: "skills" | "mcps",
): boolean {
  const val = raw[key]
  if (val === undefined) return true
  if (!Array.isArray(val) || val.length < 1 || val.length > 20) return false
  if (!val.every(isRequirementName) || hasDuplicates(val as string[])) return false
  clean[key] = val
  return true
}

function takeExtensionGroup(raw: Record<string, unknown>, clean: Record<string, unknown>): boolean {
  const val = raw.vscode_extensions
  if (val === undefined) return true
  if (!Array.isArray(val) || val.length < 1 || val.length > 20) return false
  if (!val.every(isExtensionEntry)) return false
  if (hasDuplicates(val.map((entry) => (entry as { id: string }).id))) return false
  clean.vscode_extensions = val
  return true
}

/**
 * Strictly validate a requirements object against the CLI Requirements norm
 * (non-array object, at least one 1..20 group, valid names/ids, no
 * duplicates). Returns undefined for anything invalid — callers surface
 * `invalidField` instead of silently dropping requirements the CLI needs.
 */
export function parseRequirements(raw: unknown): AgentConfig["requirements"] | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const req = raw as Record<string, unknown>
  if (req.skills === undefined && req.mcps === undefined && req.vscode_extensions === undefined) return undefined
  const clean: Record<string, unknown> = {}
  if (!takeNameGroup(req, clean, "skills")) return undefined
  if (!takeNameGroup(req, clean, "mcps")) return undefined
  if (!takeExtensionGroup(req, clean)) return undefined
  return clean as AgentConfig["requirements"]
}

const MANAGED_KEYS = new Set([
  "name",
  "description",
  "prompt",
  "model",
  "variant",
  "mode",
  "temperature",
  "top_p",
  "steps",
  "hidden",
  "disable",
  "displayName",
  "source",
  "color",
  "maxSteps",
  "options",
  "tools",
  "permission",
  "requirements",
])

function isRecordValue(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isToolsRecord(v: unknown): v is Record<string, boolean> {
  return isRecordValue(v) && Object.values(v).every((entry) => typeof entry === "boolean")
}

function putField(partial: Partial<AgentConfig>, key: string, val: unknown): void {
  ;(partial as Record<string, unknown>)[key] = val
}

function takeNullableStrings(obj: Record<string, unknown>, partial: Partial<AgentConfig>): boolean {
  for (const key of ["description", "prompt", "model", "variant"] as const) {
    if (key in obj) {
      const val = obj[key]
      if (typeof val !== "string" && val !== null) return false
      putField(partial, key, val)
    }
  }
  return true
}

function takeNullableNumbers(obj: Record<string, unknown>, partial: Partial<AgentConfig>): boolean {
  for (const key of ["temperature", "top_p"] as const) {
    if (key in obj) {
      const val = obj[key]
      if (typeof val !== "number" && val !== null) return false
      putField(partial, key, val)
    }
  }
  if ("steps" in obj) {
    const val = obj.steps
    if (val !== null && !(typeof val === "number" && Number.isInteger(val) && val > 0)) return false
    putField(partial, "steps", val)
  }
  return true
}

function takeBooleans(obj: Record<string, unknown>, partial: Partial<AgentConfig>): boolean {
  for (const key of ["hidden", "disable"] as const) {
    if (key in obj) {
      if (typeof obj[key] !== "boolean") return false
      putField(partial, key, obj[key])
    }
  }
  return true
}

function takeMetadata(obj: Record<string, unknown>, partial: Partial<AgentConfig>): boolean {
  for (const key of ["displayName", "source"] as const) {
    if (key in obj) {
      if (typeof obj[key] !== "string") return false
      putField(partial, key, obj[key])
    }
  }
  if ("color" in obj) {
    if (typeof obj.color !== "string" || (!COLOR_RE.test(obj.color) && !COLOR_LITERALS.has(obj.color))) return false
    putField(partial, "color", obj.color)
  }
  if ("maxSteps" in obj) {
    if (typeof obj.maxSteps !== "number" || !Number.isInteger(obj.maxSteps) || obj.maxSteps <= 0) return false
    putField(partial, "maxSteps", obj.maxSteps)
  }
  if ("options" in obj) {
    if (!isRecordValue(obj.options)) return false
    putField(partial, "options", obj.options)
  }
  if ("tools" in obj) {
    // Legacy record<boolean> round-trip only; string[] and other shapes
    // would make the CLI reject the file.
    if (!isToolsRecord(obj.tools)) return false
    putField(partial, "tools", obj.tools)
  }
  return true
}

function takeMode(obj: Record<string, unknown>, partial: Partial<AgentConfig>): boolean {
  if (!("mode" in obj)) return true
  if (typeof obj.mode !== "string" || !(MODES as readonly string[]).includes(obj.mode)) return false
  partial.mode = obj.mode as AgentConfig["mode"]
  return true
}

function takePermission(obj: Record<string, unknown>, partial: Partial<AgentConfig>): boolean {
  if (!("permission" in obj)) return true
  const perms = parsePermission(obj.permission)
  if (perms === undefined) return false
  putField(partial, "permission", perms)
  return true
}

function takeRequirements(obj: Record<string, unknown>, partial: Partial<AgentConfig>): boolean {
  if (!("requirements" in obj)) return true
  const reqs = parseRequirements(obj.requirements)
  if (reqs === undefined) return false
  partial.requirements = reqs
  return true
}

function takeUnknownKeys(obj: Record<string, unknown>, partial: Partial<AgentConfig>): void {
  // Unknown top-level keys are CLI rest/options: preserve verbatim so the
  // written file round-trips exactly and the CLI merges them into options.
  // Unsafe keys are never merged into live objects (prototype-pollution
  // defense); validation rejects them at the trust boundary instead.
  for (const [key, val] of Object.entries(obj)) {
    if (key === "name" || MANAGED_KEYS.has(key) || isUnsafeKey(key)) continue
    ;(partial as Record<string, unknown>)[key] = val
  }
}

/**
 * Parse a raw JSON string into a validated agent name + config.
 * Returns an error tag (matching the i18n key suffix) on failure.
 *
 * Strictness mirrors the CLI loader: the CLI drops a whole file on any
 * illegal value, so a present-but-illegal value returns `invalidField`
 * instead of being silently dropped. Omitted fields keep their defaults.
 * CLI-legal known fields and unknown top-level keys (CLI rest/options) are
 * preserved verbatim for an exact round-trip.
 */
export function parseImport(json: string, taken: string[]): ImportResult {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return { ok: false, error: "invalidJson" }
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "invalidJson" }
  }
  const obj = data as Record<string, unknown>

  const name = typeof obj.name === "string" ? obj.name.trim() : ""
  if (!name || !NAME_RE.test(name)) {
    return { ok: false, error: "invalidName" }
  }
  if (taken.includes(name)) {
    return { ok: false, error: "nameTaken" }
  }

  const partial: Partial<AgentConfig> = {}
  if (
    !takeNullableStrings(obj, partial) ||
    !takeNullableNumbers(obj, partial) ||
    !takeBooleans(obj, partial) ||
    !takeMetadata(obj, partial) ||
    !takeMode(obj, partial) ||
    !takePermission(obj, partial) ||
    !takeRequirements(obj, partial)
  ) {
    return { ok: false, error: "invalidField" }
  }
  takeUnknownKeys(obj, partial)

  // Agent markdown has no credential mechanism (shared rule with host
  // validation): reject the import instead of writing secrets to disk.
  // Benign keys/values (description text mentioning headers, etc.) never
  // match — only credential-bearing keys are checked.
  if (findAgentCredentialViolations(partial).length > 0) {
    return { ok: false, error: "invalidField" }
  }

  return {
    ok: true,
    name,
    config: { ...partial, mode: partial.mode ?? "primary" },
  }
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/
const COLOR_LITERALS = new Set(["primary", "secondary", "accent", "success", "warning", "error", "info"])

/**
 * Build the JSON-serialisable export payload for a mode.
 * Only CLI-legal fields are written (ConfigAgentV1 KNOWN_KEYS subset used by
 * the UI); string[] tools, bare-array requirements, non-CLI modes, invalid
 * colors/permissions, and legacy `disabled` are dropped rather than silently
 * producing files the CLI rejects or discards.
 */
function copyScalar(out: Record<string, unknown>, cfg: AgentConfig, key: "description" | "prompt" | "model" | "variant" | "temperature" | "top_p" | "steps" | "hidden" | "disable"): void {
  const val = cfg[key]
  if (val !== undefined) out[key] = val
}

function exportMetadata(out: Record<string, unknown>, raw: Record<string, unknown>): void {
  if (typeof raw.displayName === "string") out.displayName = raw.displayName
  if (typeof raw.source === "string") out.source = raw.source
  if (typeof raw.color === "string" && (COLOR_RE.test(raw.color) || COLOR_LITERALS.has(raw.color))) out.color = raw.color
  if (typeof raw.maxSteps === "number" && Number.isInteger(raw.maxSteps) && (raw.maxSteps as number) > 0) out.maxSteps = raw.maxSteps
  if (typeof raw.options === "object" && raw.options !== null && !Array.isArray(raw.options)) out.options = raw.options
}

function exportTools(out: Record<string, unknown>, raw: Record<string, unknown>): void {
  if (typeof raw.tools !== "object" || raw.tools === null || Array.isArray(raw.tools)) return
  const tools = raw.tools as Record<string, unknown>
  if (Object.values(tools).every((v) => typeof v === "boolean")) out.tools = tools
}

function exportPermission(out: Record<string, unknown>, raw: Record<string, unknown>): void {
  const permission = raw.permission
  if (permission === undefined) return
  // Null passes through (CLI decodes it); validated records pass through;
  // scalar strings are dropped because the CLI loader rejects them.
  const parsed = parsePermission(permission)
  if (parsed !== undefined) out.permission = parsed
}

export function buildExport(name: string, cfg: AgentConfig): Record<string, unknown> {
  const raw = cfg as Record<string, unknown>
  // Refuse to export credentials: agent files must not contain them, so an
  // export carrying them is never written. Shared rule with host validation.
  // Unsafe keys are not credentials — they are skipped below, never merged.
  const credential = findAgentCredentialViolations(raw).find((v) => v.kind === "credential")
  if (credential) {
    throw new Error(
      `Refusing to export agent "${name}": frontmatter must not contain credentials ("${credential.key}")`,
    )
  }
  const out: Record<string, unknown> = { name }
  copyScalar(out, cfg, "description")
  copyScalar(out, cfg, "prompt")
  copyScalar(out, cfg, "model")
  copyScalar(out, cfg, "variant")
  if (cfg.mode !== undefined && (MODES as readonly string[]).includes(cfg.mode)) out.mode = cfg.mode
  copyScalar(out, cfg, "temperature")
  copyScalar(out, cfg, "top_p")
  copyScalar(out, cfg, "steps")
  copyScalar(out, cfg, "hidden")
  copyScalar(out, cfg, "disable")
  exportMetadata(out, raw)
  exportTools(out, raw)
  exportPermission(out, raw)
  const reqs = parseRequirements(raw.requirements)
  if (reqs) out.requirements = reqs
  // Unknown keys (CLI rest/options) pass through verbatim so an export of a
  // file-carried agent round-trips exactly. `name` stays the payload id and
  // `prompt` carries the body; neither is duplicated from frontmatter.
  // Unsafe keys are never assigned into the output object.
  for (const [key, val] of Object.entries(raw)) {
    if (key === "name" || MANAGED_KEYS.has(key) || val === undefined || isUnsafeKey(key)) continue
    out[key] = val
  }
  return out
}
