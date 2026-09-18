// kilocode_change - shared pure Review/Autonomous permission presets (host-compatible)
// Single source for the canonical global permission preset rule content and
// the semantic preset classifier. No imports, only pure checks. Used by the
// CLI `config/ui-defaults` projection (global-only classification, so rule
// content never crosses the private transport) and by VS Code (preset-owned
// writes plus effective-config draft derivation; the webview already holds
// full rule content via the canonical config service).

export type PermissionMainLevel = "review" | "autonomous"
export type PermissionPresetClassification = PermissionMainLevel | "custom" | "absent"

const BASH_REVIEW: Record<string, string> = {
  "*": "ask",
  "cat *": "allow",
  "head *": "allow",
  "tail *": "allow",
  "less *": "allow",
  "ls *": "allow",
  "tree *": "allow",
  "pwd *": "allow",
  "echo *": "allow",
  "wc *": "allow",
  "which *": "allow",
  "type *": "allow",
  "file *": "allow",
  "diff *": "allow",
  "du *": "allow",
  "df *": "allow",
  "date *": "allow",
  "uname *": "allow",
  "whoami *": "allow",
  "printenv *": "allow",
  "man *": "allow",
  "grep *": "allow",
  "rg *": "allow",
  "ag *": "allow",
  "uniq *": "allow",
  "cut *": "allow",
  "tr *": "allow",
  "jq *": "allow",
  "*>*": "ask",
}

export const REVIEW_PERMISSION_PRESET: Record<string, unknown> = {
  "*": "ask",
  read: {
    "*": "allow",
    "*.env": "ask",
    "*.env.*": "ask",
    "*.env.example": "allow",
  },
  grep: "allow",
  glob: "allow",
  list: "allow",
  question: "allow",
  webfetch: "allow",
  websearch: "allow",
  codesearch: "allow",
  external_directory: "ask",
  edit: "ask",
  bash: BASH_REVIEW,
  task: "ask",
  recall: "ask",
  notebook_edit: "ask",
  notebook_execute: "ask",
  doom_loop: "ask",
}

export const AUTONOMOUS_PERMISSION_PRESET: Record<string, unknown> = {
  "*": "allow",
}

export function presetForLevel(level: PermissionMainLevel): Record<string, unknown> {
  return level === "review" ? REVIEW_PERMISSION_PRESET : AUTONOMOUS_PERMISSION_PRESET
}

function isRecord(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

type NormalizedRule = string | Record<string, string>

function normalizeRuleValue(rule: unknown): NormalizedRule | undefined {
  if (rule === null || rule === undefined) return undefined
  if (typeof rule === "string") return rule
  if (isRecord(rule)) {
    const out: Record<string, string> = {}
    for (const [pattern, action] of Object.entries(rule)) {
      if (action === null || action === undefined) continue
      if (typeof action !== "string") return undefined
      out[pattern] = action
    }
    return out
  }
  return undefined
}

function normalizePermissionConfig(permission: unknown): Record<string, NormalizedRule> | undefined {
  if (permission === null || permission === undefined) return undefined
  if (typeof permission === "string") return { "*": permission }
  if (!isRecord(permission)) return undefined
  const out: Record<string, NormalizedRule> = {}
  for (const [key, rule] of Object.entries(permission)) {
    const norm = normalizeRuleValue(rule)
    if (norm === undefined) continue
    out[key] = norm
  }
  return out
}

function rulesEqual(a: NormalizedRule, b: NormalizedRule): boolean {
  if (typeof a === "string" || typeof b === "string") {
    if (typeof a === "string" && typeof b === "string") return a === b
    // Scalar "ask" is semantically identical to { "*": "ask" } (the CLI
    // normalizes scalar rulesets). Never order-sensitive.
    const obj = typeof a === "string" ? b : a
    const scalar = typeof a === "string" ? a : (b as string)
    if (typeof obj !== "object" || obj === null) return false
    const keys = Object.keys(obj)
    return keys.length === 1 && keys[0] === "*" && (obj as Record<string, string>)["*"] === scalar
  }
  const ao = a as Record<string, string>
  const bo = b as Record<string, string>
  const ka = Object.keys(ao).sort()
  const kb = Object.keys(bo).sort()
  if (ka.length !== kb.length) return false
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false
    if (ao[ka[i]] !== bo[ka[i]]) return false
  }
  return true
}

/** Semantic preset comparison: scalar vs `{"*":...}` equivalent, empty/null absent. */
export function permissionMatchesPreset(permission: unknown, preset: Record<string, unknown>): boolean {
  const a = normalizePermissionConfig(permission) ?? {}
  const b = normalizePermissionConfig(preset) ?? {}
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.length !== kb.length) return false
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false
    if (!rulesEqual(a[ka[i]], b[ka[i]])) return false
  }
  return true
}

function permissionIsEmpty(permission: unknown): boolean {
  if (permission === null || permission === undefined) return true
  if (typeof permission === "string") return permission.length === 0
  if (isRecord(permission)) return Object.keys(permission).length === 0
  return true
}

/**
 * Classify global raw config into the main-surface state. A present level
 * counts only when the global permission semantically matches that level's
 * owned preset — external hand-edits that leave a stale level behind read
 * as custom. Without a canonical level, present permission reads as custom
 * and absent permission reads as absent. Never persisted.
 */
export function classifyPermissionPreset(input: {
  permissionLevel?: unknown
  permission?: unknown
}): PermissionPresetClassification {
  const level = input.permissionLevel
  if (level === "review" || level === "autonomous") {
    if (permissionMatchesPreset(input.permission, presetForLevel(level))) return level
    return "custom"
  }
  if (!permissionIsEmpty(input.permission)) return "custom"
  return "absent"
}
