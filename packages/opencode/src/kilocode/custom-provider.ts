/**
 * Exact CLI custom-provider package predicate (LOCK-003).
 *
 * Mirrors the product semantics used by the VS Code extension
 * (`packages/kilo-vscode/src/shared/provider-model.ts`): an entry is a custom
 * provider only when its `npm` field is one of the accepted AI SDK packages.
 * The deletion service validates each canonical global/project overlay scope
 * independently with this predicate.
 */
export const CUSTOM_PROVIDER_PACKAGES = [
  "@ai-sdk/openai-compatible",
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
] as const

export type CustomProviderPackage = (typeof CUSTOM_PROVIDER_PACKAGES)[number]

export function isCustomProviderPackage(value: unknown): value is CustomProviderPackage {
  return CUSTOM_PROVIDER_PACKAGES.includes(value as CustomProviderPackage)
}

/**
 * Provider ID contract shared by every custom-provider mutation (LOCK-002).
 *
 * Matches the VS Code extension predicate
 * (`packages/kilo-vscode/src/shared/provider-model.ts` PROVIDER_ID_PATTERN):
 * lowercase alphanumeric start, then lowercase alphanumeric / `-` / `_`. The
 * backend save and delete services reject IDs outside this pattern with a
 * structured 400 before any ticket/lock/auth/cache/config mutation; slashed
 * IDs never route and remain 404.
 */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/

export function isProviderID(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_ID_PATTERN.test(value)
}
