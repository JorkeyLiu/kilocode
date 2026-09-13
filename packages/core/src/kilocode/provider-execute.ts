// kilocode_change - shared canonical provider protocol/path/failure primitives
/**
 * Shared canonical provider primitives consumed by streaming
 * `provider/httpExecute` (`@opencode-ai/core/kilocode/provider-http-execute`),
 * canonical record validation (`canonical-record.ts`), config preservation
 * (`v1/config/provider.ts`), and VS Code authored/config types plus the
 * streaming host executor. The legacy canonical unary `provider/execute`
 * request/result envelope has been removed: session generation runs only
 * over streaming `provider/httpExecute`.
 *
 * This module remains the single source of truth for the protocol set,
 * fixed path by protocol, and failure codes. The full
 * `CanonicalProviderPayload` AST stays in `packages/kilo-vscode/src/config/types.ts`
 * and in the host executor; the CLI keeps `record` opaque (plain-object
 * prototype checks only) per the locked semantics.
 */

export const CANONICAL_FAILURE_CODES = [
  "invalid-record",
  "invalid-endpoint",
  "unknown-protocol",
  "unknown-model",
  "missing-credential-ref",
  "invalid-credential-ref",
  "missing-secret",
  "provider",
  "aborted",
] as const

export type CanonicalFailureCode = (typeof CANONICAL_FAILURE_CODES)[number]

export const PROVIDER_EXECUTE_PROTOCOLS = [
  "openai/completions",
  "openai/responses",
  "anthropic/messages",
] as const

export type ProviderExecuteProtocol = (typeof PROVIDER_EXECUTE_PROTOCOLS)[number]

const PROTOCOL_SET = new Set<string>(PROVIDER_EXECUTE_PROTOCOLS)
const FAILURE_SET = new Set<string>(CANONICAL_FAILURE_CODES)

export const PROVIDER_EXECUTE_PATH_BY_PROTOCOL: Record<ProviderExecuteProtocol, string> = {
  "openai/completions": "/chat/completions",
  "openai/responses": "/responses",
  "anthropic/messages": "/messages",
}

export function isCanonicalFailureCode(v: unknown): v is CanonicalFailureCode {
  return typeof v === "string" && FAILURE_SET.has(v)
}

export function isProviderExecuteProtocol(v: unknown): v is ProviderExecuteProtocol {
  return typeof v === "string" && PROTOCOL_SET.has(v)
}
