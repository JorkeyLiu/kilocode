import { Wildcard } from "../../src/util/wildcard"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ReadPermission } from "../../src/kilocode/permission/read"

export function legacyEvaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    (rulesets.flat().findLast((r) => Wildcard.match(permission, r.permission) && Wildcard.match(pattern, r.pattern)) as PermissionV1.Rule | undefined) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export function legacyResolve(permission: string, pattern: string, ruleset: any, ...overrides: any[]): any {
  const base = ReadPermission.harden(permission, pattern, legacyEvaluate(permission, pattern, ruleset))
  const saved = ReadPermission.harden(permission, pattern, legacyEvaluate(permission, pattern, ...overrides))
  if (base.action === "deny") return base
  if (saved.action === "deny") return saved
  if (base.action === "ask") {
    if (saved.action === "allow" && Wildcard.match(saved.pattern, base.pattern)) return saved
    return base
  }
  if (saved.action === "allow") return saved
  return base
}
