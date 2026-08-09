// kilocode_change - new file
import { ConfigProtection } from "@/kilocode/permission/config-paths"

/**
 * Explicit user approvals for protected config files, persisted under the
 * top-level global config field `protected_files: { [agent]: { [path]: "allow" | "deny" } }`.
 *
 * Security model (LOCK-001/002/003):
 * - Only the global config is read for this trust; project kilo.json / AGENTS.md
 *   content is inert and can never grant protected access.
 * - Rules are scoped to the exact agent name (carried via metadata AGENT_KEY by
 *   the session layer) plus the exact canonical protected file identity
 *   (LOCK-002): keys are canonical absolute paths, so an approval never crosses
 *   worktree/project boundaries and never broadens to same-named files elsewhere.
 *   Glob/directory patterns are not file identities and are never persisted or
 *   consulted — requests carrying them keep requiring approval (LOCK-003).
 * - Ordinary `permission.edit` rules, agent config permissions, allowEverything,
 *   and wildcard rules never grant protected access: evaluation only ever
 *   consults this store for protected requests.
 *
 * Compatibility (fail-closed): legacy relative keys (e.g. `AGENTS.md`) written
 * by earlier builds carry no project identity and are unreachable — lookups are
 * always canonical absolute, so legacy relative keys match nothing and never
 * grant or deny. Legacy absolute global-config keys still match when the stored
 * string canonicalizes to the same identity.
 */
export namespace ProtectedFiles {
  export type Action = "allow" | "deny"
  export type Rules = Record<string, Action>

  /** Authoritative agent name from the request metadata, if the session layer set it. */
  export function agent(request: { metadata?: Record<string, unknown> }): string | undefined {
    const value = request.metadata?.[ConfigProtection.AGENT_KEY]
    return typeof value === "string" && value.length > 0 ? value : undefined
  }

  /**
   * Request-side project base for resolving relative protected paths: the
   * worktree root (patterns are `path.relative(worktree, ...)`), falling back
   * to the project directory for non-git instances where worktree is "/".
   */
  export function base(ctx: { directory: string; worktree: string }): string {
    return ctx.worktree === "/" ? ctx.directory : ctx.worktree
  }

  /** Normalized per-agent rules from a global config Info. */
  export function rules(global: { protected_files?: unknown }, agent: string): Rules {
    const all = global.protected_files
    if (!all || typeof all !== "object" || Array.isArray(all)) return {}
    const perAgent = (all as Record<string, unknown>)[agent]
    if (!perAgent || typeof perAgent !== "object" || Array.isArray(perAgent)) return {}
    const out: Rules = {}
    for (const [raw, action] of Object.entries(perAgent as Record<string, unknown>)) {
      if (action === "allow" || action === "deny") out[ConfigProtection.normalizePath(raw)] = action
    }
    return out
  }

  /** Action for one canonical protected key, or undefined when no rule matches. */
  export function actionFor(rules: Rules, key: string): Action | undefined {
    return rules[ConfigProtection.normalizePath(key)]
  }

  /**
   * Raw protected path forms of a request (deduped, unresolved): every pattern,
   * metadata.filepath part, and files[].filePath/movePath entry that targets a
   * literal protected config path. Glob/directory patterns are skipped exactly
   * as in requestPaths, so the UI confirmation enumerates precisely the set the
   * backend will persist for an "always" approval (LOCK-002) — never broader,
   * and in the request's own path forms.
   */
  export function requestPathForms(request: {
    patterns: readonly string[]
    metadata?: Record<string, unknown>
  }): string[] {
    const out: string[] = []
    const push = (p: unknown) => {
      if (typeof p !== "string") return
      if (ConfigProtection.hasGlobSyntax(p)) return
      if (ConfigProtection.isProtectedPath(p)) out.push(p)
    }
    for (const p of request.patterns) push(p)
    const fp = request.metadata?.filepath
    if (typeof fp === "string") {
      for (const part of fp.includes(", ") ? fp.split(", ") : [fp]) push(part)
    }
    const files = request.metadata?.files
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

  /**
   * Canonical protected identities of a request (deduped): every protected
   * requestPathForms entry resolved to the same canonical absolute key via
   * ConfigProtection.canonicalKey, so persistence and lookup always converge on
   * one identity per file. Used to translate the UI wildcard "*" to the real
   * protected paths when persisting, so multi-file requests never broaden
   * approval to unrelated paths.
   *
   * Glob/directory patterns (anything carrying glob syntax, e.g. `~/.config/kilo/*`)
   * are skipped: a glob is not an exact file identity (LOCK-002), so it is never
   * persisted as a broad `protected_files` key and never consulted on lookup —
   * glob protected requests keep asking (LOCK-003). A mixed request persists only
   * its literal protected paths.
   */
  export function requestPaths(
    request: {
      patterns: readonly string[]
      metadata?: Record<string, unknown>
    },
    base: string,
  ): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const p of requestPathForms(request)) {
      const key = ConfigProtection.canonicalKey(p, base)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(key)
    }
    return out
  }

  /** Persistence shape for a single agent: { [path]: action } merged into `protected_files`. */
  export function forAgent(
    agent: string,
    paths: readonly string[],
    action: Action,
  ): Record<string, Record<string, Action>> {
    const perPath: Record<string, Action> = {}
    for (const p of paths) perPath[ConfigProtection.normalizePath(p)] = action
    return { [agent]: perPath }
  }
}
