// kilocode_change - shared owned credential ref parser/validator
// Single source for opaque SecretStorage reference syntax:
// `secret:kilo.credentials.<global|project>.<provider|mcp>.<id>`
// Both `packages/core` schemas and `packages/kilo-vscode` validators import from here
// (vscode re-exports for compat). No secret resolution or logging occurs here.

import { Schema } from "effect"

export const CREDENTIAL_REF_PREFIX = "secret:kilo.credentials." as const

export type CredentialScope = "global" | "project"
export type CredentialKind = "provider" | "mcp"

export interface ParsedCredentialRef {
  readonly scope: CredentialScope
  readonly kind: CredentialKind
  readonly id: string
}

/**
 * Parse an exact extension-owned SecretStorage ref into its components.
 * Returns null for any ref that is not the exact owned format.
 *
 * Rules enforced:
 * - exact prefix `secret:kilo.credentials.`
 * - legal scope ("global" | "project") and kind ("provider" | "mcp")
 * - a non-empty stable id whose dot segments are all non-empty
 *   (rejects empty ids, delimiter-only ids, and leading/trailing/
 *   consecutive empty dot segments such as "..", ".id", "id.")
 */
export function parseOwnedCredentialRef(ref: string): ParsedCredentialRef | null {
  if (!ref.startsWith(CREDENTIAL_REF_PREFIX)) return null
  const rest = ref.slice(CREDENTIAL_REF_PREFIX.length)
  const parts = rest.split(".")
  if (parts.length < 3) return null
  const [scope, kind, ...idParts] = parts
  if (scope !== "global" && scope !== "project") return null
  if (kind !== "provider" && kind !== "mcp") return null
  if (idParts.length === 0) return null
  for (const part of idParts) {
    if (part.length === 0) return null
  }
  return { scope: scope as CredentialScope, kind: kind as CredentialKind, id: idParts.join(".") }
}

export function isOwnedCredentialRef(ref: string): boolean {
  return parseOwnedCredentialRef(ref) !== null
}

export function isOwnedProviderCredentialRef(ref: string, expectedId?: string): boolean {
  const parsed = parseOwnedCredentialRef(ref)
  if (!parsed) return false
  if (parsed.kind !== "provider") return false
  if (expectedId !== undefined && parsed.id !== expectedId) return false
  return true
}

export function isOwnedMcpCredentialRef(ref: string, expectedId?: string): boolean {
  const parsed = parseOwnedCredentialRef(ref)
  if (!parsed) return false
  if (parsed.kind !== "mcp") return false
  if (expectedId !== undefined && parsed.id !== expectedId) return false
  return true
}

export const PROVIDER_CREDENTIAL_REF_PATTERN = /^secret:kilo\.credentials\.(global|project)\.provider\.[^.]+(\.[^.]+)*$/

export const ProviderCredentialRef = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((s: string) => (PROVIDER_CREDENTIAL_REF_PATTERN.test(s) ? undefined : "Invalid credential reference")).annotate({
      expected: `a string matching the RegExp ${PROVIDER_CREDENTIAL_REF_PATTERN.source}`,
      // Preserve OpenAPI pattern and arbitrary generation metadata (mirrors Schema.isPattern)
      meta: { _tag: "isPattern", regExp: PROVIDER_CREDENTIAL_REF_PATTERN },
      toArbitraryConstraint: { string: { patterns: [PROVIDER_CREDENTIAL_REF_PATTERN.source] } },
    } as never),
  ),
  Schema.check(Schema.makeFilter((s: string) => (isOwnedProviderCredentialRef(s) ? undefined : "Invalid credential reference"))),
)
