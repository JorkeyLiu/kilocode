/**
 * Agent markdown credential rule — single shared source for host validation
 * (`src/config/validate.ts`) and webview import/export
 * (`webview-ui/src/components/settings/mode-io.ts`).
 *
 * This module is vscode-free and dependency-free so both sides consume the
 * identical rule without duplicating patterns.
 *
 * Norm: agent markdown files have NO credential mechanism. Any
 * credential-bearing key holding non-empty/non-null content is a violation —
 * plaintext AND SecretStorage refs alike. (Provider/MCP config is different:
 * it requires exact owned `secret:` refs; that allowance lives in
 * `src/config/parse.ts` and must never be applied to agent markdown.)
 *
 * Key matching is anchored and case/separator-normalized, so control-ish
 * keys like `credentialRequested` never match. Object traversal is
 * read-only; merge paths must additionally skip `isUnsafeKey` keys to stay
 * prototype-pollution safe.
 */

/**
 * Case-insensitive credential key patterns (anchored). Covers the historic
 * provider/MCP set plus the agent-mandated additions: credential,
 * cookie(s), header(s).
 */
const CREDENTIAL_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /^api[_-]?key$/i,
  /^api[_-]?secret$/i,
  /^token$/i,
  /^access[_-]?token$/i,
  /^refresh[_-]?token$/i,
  /^secret$/i,
  /^secret[_-]?key$/i,
  /^private[_-]?key$/i,
  /^password$/i,
  /^passwd$/i,
  /^credential$/i,
  /^credentials$/i,
  /^cookie$/i,
  /^cookies$/i,
  /^header$/i,
  /^headers$/i,
  /^authorization$/i,
  /^bearer$/i,
  /^auth[_-]?token$/i,
  /^client[_-]?id$/i,
  /^client[_-]?secret$/i,
]

/**
 * Test whether a key name matches a credential pattern (case/format-variant
 * aware). Anchored patterns never match longer control-ish names such as
 * `credentialRequested`.
 */
export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY_PATTERNS.some((p) => p.test(key))
}

const UNSAFE_MERGE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"])

/**
 * Keys that must never be assigned into a live object during merges
 * (prototype-pollution defense). Validation rejects them; merge paths skip
 * them.
 */
export function isUnsafeKey(key: string): boolean {
  return UNSAFE_MERGE_KEYS.has(key)
}

export interface AgentCredentialViolation {
  readonly path: ReadonlyArray<string>
  readonly key: string
  readonly kind: "credential" | "unsafe-key"
}

function hasCredentialContent(val: unknown): boolean {
  return val !== undefined && val !== null && val !== ""
}

/**
 * Recursively find agent-markdown credential violations. Any
 * credential-bearing key with non-empty/non-null content violates — string
 * values (plaintext or `secret:` refs), numbers, booleans, objects, arrays
 * alike. Benign keys (description, prompt, mode, …) are never flagged
 * regardless of their values. Read-only traversal: safe on hostile input.
 */
export function findAgentCredentialViolations(
  data: unknown,
  pathPrefix: ReadonlyArray<string> = [],
): AgentCredentialViolation[] {
  const violations: AgentCredentialViolation[] = []
  if (!data || typeof data !== "object") return violations
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const el = (data as ReadonlyArray<unknown>)[i]
      if (el && typeof el === "object") {
        violations.push(...findAgentCredentialViolations(el, [...pathPrefix, String(i)]))
      }
    }
    return violations
  }
  for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
    if (isUnsafeKey(key)) {
      violations.push({ path: [...pathPrefix, key], key, kind: "unsafe-key" })
      continue
    }
    if (isCredentialKey(key)) {
      if (hasCredentialContent(val)) violations.push({ path: [...pathPrefix, key], key, kind: "credential" })
      continue
    }
    if (val && typeof val === "object") {
      violations.push(...findAgentCredentialViolations(val, [...pathPrefix, key]))
    }
  }
  return violations
}
