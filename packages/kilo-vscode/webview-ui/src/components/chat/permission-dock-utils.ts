import type { PermissionRule } from "../../types/messages"

export type RuleDecision = "approved" | "denied" | "pending"

/**
 * Check which rules are already saved in the user's config and return
 * their initial toggle states (approved/denied). Rules not found in
 * the config are omitted (they default to "pending").
 */
export function savedRuleStates(rules: string[], saved: PermissionRule | undefined): Record<number, RuleDecision> {
  const result: Record<number, RuleDecision> = {}
  for (let i = 0; i < rules.length; i++) {
    const pattern = rules[i]
    const action = typeof saved === "string" ? (pattern === "*" ? saved : undefined) : saved?.[pattern]
    if (action === "allow") result[i] = "approved"
    if (action === "deny") result[i] = "denied"
  }
  return result
}

// ---------------------------------------------------------------------------
// Protected config-file approval scoping
//
// Backend metadata (ConfigProtection keys) marks a permission request as a
// protected config-file access (`configProtected`) and carries the session
// layer's authoritative agent name (`protectedAgent`). Persistence for these
// requests is scoped to that exact agent and the exact request paths, never
// to ordinary global edit auto-approval. These helpers only read that
// metadata for display; the backend owns the persistence contract.
// ---------------------------------------------------------------------------

/** True when the request is a protected config-file request. */
export function isConfigProtected(args: Record<string, unknown> | undefined): boolean {
  return args?.configProtected === true
}

/** Authoritative agent name from request metadata, if the session layer set it. */
export function protectedAgentName(args: Record<string, unknown> | undefined): string | undefined {
  const val = args?.protectedAgent
  return typeof val === "string" && val.length > 0 ? val : undefined
}

/**
 * Exact paths of a protected request. For real requests the backend fills
 * `args.protectedPaths` (ConfigProtection.PATHS_KEY) with the canonical
 * persisted identities — already filtered to protected paths, unioned across
 * patterns + metadata, globs skipped, deduped — and this function displays that
 * list verbatim (LOCK-003). When the field is absent (stale backend, fixtures,
 * stories), it falls back to a browser-safe mirror of the backend's
 * ProtectedFiles.requestPathForms: relative protected forms from request
 * patterns and metadata (filepath / files[].filePath / files[].movePath),
 * unioned, glob syntax skipped, deduped. Absolute/global-config paths resolve
 * through the machine's config directories via realpath on the backend and are
 * unverifiable in the webview, so the fallback omits them rather than risk
 * showing a path the backend would not persist.
 */
export function protectedRequestPaths(request: { patterns: string[]; args?: Record<string, unknown> }): string[] {
  const persisted = request.args?.protectedPaths
  if (Array.isArray(persisted)) {
    return Array.from(new Set(persisted.filter((p): p is string => typeof p === "string")))
  }
  const out: string[] = []
  const push = (p: unknown) => {
    if (typeof p !== "string") return
    if (hasGlobSyntax(p)) return
    if (!isProtectedForm(p)) return
    out.push(p)
  }
  for (const p of request.patterns) push(p)
  const fp = request.args?.filepath
  if (typeof fp === "string") {
    for (const part of fp.includes(", ") ? fp.split(", ") : [fp]) push(part)
  }
  const files = request.args?.files
  if (Array.isArray(files)) {
    for (const file of files) {
      if (!file || typeof file !== "object") continue
      for (const key of ["filePath", "movePath"] as const) {
        push((file as Record<string, unknown>)[key])
      }
    }
  }
  return Array.from(new Set(out))
}

// ---------------------------------------------------------------------------
// Browser-safe mirror of the backend's protected-path checks. Kept in sync with
// ConfigProtection.isProtectedPath / hasGlobSyntax for the relative forms the
// webview can verify without a filesystem.
// ---------------------------------------------------------------------------

/** Same glob-syntax set the backend skips (LOCK-002): a glob is not an exact file identity. */
function hasGlobSyntax(p: string): boolean {
  return /[*?\[\]{}]/.test(p)
}

/** Config dir prefixes (relative, posix-normalized) — matches the backend. */
const CONFIG_DIRS = [".kilo/"]

/** Subdirectories under CONFIG_DIRS that are not config files — matches the backend. */
const EXCLUDED_SUBDIRS = ["plans/"]

/** Root-level config files — matches the backend. */
const CONFIG_ROOT_FILES = new Set(["kilo.json", "kilo.jsonc", "AGENTS.md"])

/** Browser-safe mirror of path.posix.normalize for the relative check. */
function normalizePosix(p: string): string {
  const parts: string[] = []
  for (const segment of p.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") parts.pop()
    else parts.push(segment)
  }
  return parts.join("/")
}

/**
 * True for a relative protected config path (.kilo/ at any depth minus plans/,
 * or a root config file), mirroring the backend's isRelative.
 * Absolute-looking paths are routed to the backend-computed metadata list only:
 * the webview cannot verify them against the machine's config directories.
 */
function isProtectedForm(p: string): boolean {
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(p)) return false
  const normalized = normalizePosix(p)
  for (const dir of CONFIG_DIRS) {
    const bare = dir.slice(0, -1) // e.g. ".kilo"
    // Match at root (e.g. ".kilo/foo") or nested (e.g. "packages/sub/.kilo/foo")
    if (normalized === bare || normalized.endsWith("/" + bare)) return true
    if (normalized.startsWith(dir)) {
      if (isExcluded(normalized.slice(dir.length))) continue
      return true
    }
    const nested = normalized.indexOf("/" + dir)
    if (nested !== -1) {
      if (isExcluded(normalized.slice(nested + 1 + dir.length))) continue
      return true
    }
  }
  return CONFIG_ROOT_FILES.has(normalized)
}

function isExcluded(remainder: string): boolean {
  return EXCLUDED_SUBDIRS.some((sub) => remainder.startsWith(sub))
}

// ---------------------------------------------------------------------------
// Human-readable permission descriptions
// ---------------------------------------------------------------------------

/** Maps tool names to their i18n key for the human-readable label. */
export const TOOL_LABEL_KEYS: Record<string, string> = {
  read: "ui.permission.toolLabel.read",
  edit: "ui.permission.toolLabel.edit",
  write: "ui.permission.toolLabel.write",
  patch: "ui.permission.toolLabel.patch",
  multiedit: "ui.permission.toolLabel.edit",
  glob: "ui.permission.toolLabel.globSearch",
  grep: "ui.permission.toolLabel.grepSearch",
  list: "ui.permission.toolLabel.list",
  bash: "ui.permission.toolLabel.bash",
  external_directory: "ui.permission.toolLabel.externalDirectory",
  webfetch: "ui.permission.toolLabel.webFetch",
  websearch: "ui.permission.toolLabel.webSearch",
  codesearch: "ui.permission.toolLabel.codeSearch",
  todoread: "ui.permission.toolLabel.todoRead",
  todowrite: "ui.permission.toolLabel.todoWrite",
  task: "ui.permission.toolLabel.task",
  skill: "ui.permission.toolLabel.skill",
  lsp: "ui.permission.toolLabel.lsp",
}

export type PatternDescription = { kind: "single"; text: string } | { kind: "multi"; title: string; paths: string[] }

/** Resolve the human-readable label for a tool (e.g. "Read", "Web Fetch"). */
export function resolveLabel(tool: string, t: (key: string) => string): string {
  const key = TOOL_LABEL_KEYS[tool]
  return key ? t(key) : tool
}

export function describeRule(
  tool: string,
  rule: string,
  t: (key: string, params?: Record<string, string>) => string,
): string {
  if (tool === "doom_loop") {
    return t("ui.permission.doomLoop.rule", { tool: resolveLabel(rule, t) })
  }
  return rule === "*" ? resolveLabel(tool, t) : `${resolveLabel(tool, t)} ${rule}`
}

/**
 * Build a human-readable description for a permission request's patterns.
 *
 * Returns null when there are no meaningful patterns to display (e.g. only "*").
 * For a single pattern: "Read src/app.ts"
 * For multiple patterns: { title: "Read:", paths: ["src/app.ts", "src/index.ts"] }
 */
export function describePatterns(
  tool: string,
  patterns: string[],
  t: (key: string, params?: Record<string, string>) => string,
): PatternDescription | null {
  const filtered = patterns.filter((p) => p !== "*")
  if (filtered.length === 0) return null

  // doom-loop requests always contain one repeated tool pattern.
  if (tool === "doom_loop") {
    return {
      kind: "single",
      text: t("ui.permission.doomLoop.prompt", { tool: resolveLabel(filtered[0], t) }),
    }
  }

  const label = resolveLabel(tool, t)
  if (filtered.length === 1) return { kind: "single", text: `${label} ${filtered[0]}` }
  return { kind: "multi", title: `${label}:`, paths: filtered }
}
