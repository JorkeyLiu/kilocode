import type { Ruleset } from "@/kilocode/permission/rule"

export namespace ExternalDirectoryPermission {
  /**
   * Non-authorizing predicate: does ruleset contain an exact allow rule for this
   * skill pattern? No Wildcard matching, no deny/allow decision — boolean only.
   * Used for skill-trust classification, not final authorization.
   */
  export function isTrustedSkill(skill: string, permission: string, ruleset: Ruleset): boolean {
    if (permission !== "external_directory") return false
    return ruleset.some((r) => r.permission === permission && r.pattern === skill && r.action === "allow")
  }

  export function hasExactAllow(permission: string, pattern: string, ruleset?: Ruleset): boolean {
    if (!ruleset) return false
    return ruleset.some((r) => r.permission === permission && r.pattern === pattern && r.action === "allow")
  }
}
