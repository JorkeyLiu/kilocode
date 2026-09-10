// kilocode_change - shared provider/execute wire primitives
/**
 * Genuinely shared cross-process contract for the reverse capability
 * `provider/execute`. This module is the single source of truth for the
 * method name, result envelope, and failure codes. The full
 * `CanonicalProviderPayload` AST stays in `packages/kilo-vscode/src/config/types.ts`
 * and in the host executor; the CLI keeps `record` opaque (plain-object
 * prototype checks only) per the locked semantics.
 *
 * Both `packages/opencode` (CLI broker) and `packages/kilo-vscode`
 * (host handler) import from `@opencode-ai/core/kilocode/provider-execute`.
 * This avoids defining the request/result/failure contract twice while
 * keeping the full config schema out of the shared boundary. If a future
 * change would force the full schema into this module, the boundary
 * decision should be revisited rather than widening this file.
 */

import { Schema } from "effect"
import { LLMEvent } from "@opencode-ai/llm"

export const PROVIDER_EXECUTE_METHOD = "provider/execute" as const

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

export interface ProviderExecuteRequest {
  readonly providerId: string
  readonly modelId: string
  readonly record: unknown
  readonly prompt: string
}

export interface ProviderExecuteSuccess {
  readonly providerId: string
  readonly modelId: string
  readonly protocol: ProviderExecuteProtocol
  readonly endpoint: string
  readonly path: string
  readonly text: string
  readonly events: readonly LLMEvent[]
}

const ALLOWED_REQUEST_KEYS = new Set(["providerId", "modelId", "record", "prompt"])
const ALLOWED_SUCCESS_KEYS = new Set(["providerId", "modelId", "protocol", "endpoint", "path", "text", "events"])

export const PROVIDER_EXECUTE_PATH_BY_PROTOCOL: Record<ProviderExecuteProtocol, string> = {
  "openai/completions": "/chat/completions",
  "openai/responses": "/responses",
  "anthropic/messages": "/messages",
}

const PATH_BY_PROTOCOL = PROVIDER_EXECUTE_PATH_BY_PROTOCOL

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function isPlainObject(v: unknown): boolean {
  if (!isRecord(v)) return false
  if (Object.getPrototypeOf(v) !== Object.prototype) return false
  if (Object.prototype.hasOwnProperty.call(v, "__proto__")) return false
  if (Object.prototype.hasOwnProperty.call(v, "constructor")) return false
  return true
}

export function isCanonicalFailureCode(v: unknown): v is CanonicalFailureCode {
  return typeof v === "string" && FAILURE_SET.has(v)
}

export function isProviderExecuteProtocol(v: unknown): v is ProviderExecuteProtocol {
  return typeof v === "string" && PROTOCOL_SET.has(v)
}

/**
 * Minimal wire validation for the CLI broker's outbound request.
 * Keeps `record` opaque except safe plain-object/prototype checks needed
 * before sending. Closed-shape enforcement (no extra keys, required fields,
 * no NULs) mirrors the host's `validateProviderExecuteParams` but does not
 * expand the full `CanonicalProviderPayload` AST.
 */
export function validateProviderExecuteRequest(raw: unknown): ProviderExecuteRequest {
  if (!isRecord(raw)) throw new Error("Invalid params: request must be object")
  for (const key of Object.keys(raw)) if (!ALLOWED_REQUEST_KEYS.has(key)) throw new Error(`Invalid params: unexpected field ${key}`)
  const providerId = raw.providerId
  const modelId = raw.modelId
  const record = raw.record
  const prompt = raw.prompt
  if (typeof providerId !== "string" || providerId.length === 0) throw new Error("Invalid params: providerId must be non-empty string")
  if (providerId.includes("\0")) throw new Error("Invalid params: providerId invalid")
  if (typeof modelId !== "string" || modelId.length === 0) throw new Error("Invalid params: modelId must be non-empty string")
  if (modelId.includes("\0")) throw new Error("Invalid params: modelId invalid")
  if (typeof prompt !== "string") throw new Error("Invalid params: prompt must be string")
  if (prompt.includes("\0")) throw new Error("Invalid params: prompt invalid")
  if (!isRecord(record)) throw new Error("Invalid params: record must be object")
  if (!isPlainObject(raw as Record<string, unknown>) || !isPlainObject(record as Record<string, unknown>)) {
    throw new Error("Invalid params: record invalid")
  }
  return { providerId, modelId, record, prompt }
}

/**
 * Validate the host's success envelope. Uses canonical protocol/path
 * mapping and the shared LLMEvent contract for `events`. The broker calls
 * this after a successful JSON-RPC response to detect malformed
 * success results as protocol errors.
 */
export function validateProviderExecuteSuccess(raw: unknown): ProviderExecuteSuccess {
  if (!isRecord(raw)) throw new Error("Invalid result: must be object")
  for (const key of Object.keys(raw)) if (!ALLOWED_SUCCESS_KEYS.has(key)) throw new Error(`Invalid result: unexpected field ${key}`)
  const { providerId, modelId, protocol, endpoint, path, text, events } = raw as Record<string, unknown>
  if (typeof providerId !== "string" || providerId.length === 0) throw new Error("Invalid result: providerId must be non-empty string")
  if (typeof modelId !== "string" || modelId.length === 0) throw new Error("Invalid result: modelId must be non-empty string")
  if (!isProviderExecuteProtocol(protocol)) throw new Error("Invalid result: protocol invalid")
  if (typeof endpoint !== "string" || endpoint.length === 0) throw new Error("Invalid result: endpoint must be non-empty string")
  try {
    const url = new URL(endpoint)
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid result: endpoint must be http(s)")
  } catch {
    throw new Error("Invalid result: endpoint must be URL")
  }
  const expectedPath = PATH_BY_PROTOCOL[protocol as ProviderExecuteProtocol]
  if (typeof path !== "string" || path.length === 0) throw new Error("Invalid result: path must be non-empty string")
  if (path !== expectedPath) throw new Error(`Invalid result: path must be ${expectedPath}`)
  if (typeof text !== "string") throw new Error("Invalid result: text must be string")
  if (!Array.isArray(events)) throw new Error("Invalid result: events must be array")
  // Validate each event against the shared LLMEvent schema; malformed events are protocol errors.
  const isEvent = Schema.is(LLMEvent) as unknown as (v: unknown) => boolean
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (!isRecord(ev) || typeof (ev as Record<string, unknown>).type !== "string") throw new Error(`Invalid result: events[${i}] invalid`)
    // Use shared contract when available; fall back to type-only if schema check fails to avoid false positives across versions.
    try {
      if (!isEvent(ev)) throw new Error(`Invalid result: events[${i}] not LLMEvent`)
    } catch {
      throw new Error(`Invalid result: events[${i}] not LLMEvent`)
    }
  }
  return {
    providerId,
    modelId,
    protocol: protocol as ProviderExecuteProtocol,
    endpoint,
    path,
    text,
    events: events as readonly LLMEvent[],
  }
}

const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603
const METHOD_NOT_FOUND = -32601

const INVALID_PARAMS_FAMILY = new Set<string>([
  "invalid-record",
  "invalid-endpoint",
  "unknown-protocol",
  "unknown-model",
  "missing-credential-ref",
  "invalid-credential-ref",
])
const INTERNAL_ERROR_FAMILY = new Set<string>(["missing-secret", "provider", "aborted"])

/**
 * Extract the canonical failure code from a JSON-RPC error's `data`
 * payload. Host preserves the code in `error.data.code` (or
 * `error.data.data.code` for double-wrapped paths) and leaks no secrets.
 * Returns the exact code and sanitized message when present **and** the
 * outer JSON-RPC numeric code matches the host contract family:
 * - InvalidParams (-32602) for validation failures
 * - InternalError (-32603) for execution/lifecycle failures
 * MethodNotFound, mismatched families, or malformed envelopes are not
 * trusted and return undefined so callers map to protocol errors.
 */
export function extractCanonicalFailure(err: unknown): { code: CanonicalFailureCode; message: string } | undefined {
  const rec = err as { code?: number; message?: string; data?: unknown }
  const outer = rec?.code
  if (typeof outer !== "number") return undefined
  if (outer === METHOD_NOT_FOUND) return undefined
  if (outer !== INVALID_PARAMS && outer !== INTERNAL_ERROR) return undefined
  const message = typeof rec?.message === "string" ? rec.message : "Request failed"
  const data = rec?.data as unknown
  const codes: unknown[] = []
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>
    if (typeof o.code === "string") codes.push(o.code)
    if (o.data && typeof o.data === "object") {
      const inner = o.data as Record<string, unknown>
      if (typeof inner.code === "string") codes.push(inner.code)
    }
    // Some transports wrap as { data: { code } } via peer's makePeerError
    if ((o as { error?: unknown })?.error && typeof (o as { error: unknown }).error === "object") {
      const wrapper = (o as { error: Record<string, unknown> }).error
      if (typeof wrapper.code === "string") codes.push(wrapper.code)
    }
  }
  // Direct data.code shape from host's makeError data (duplicate path for robustness)
  if (data && typeof data === "object" && typeof (data as Record<string, unknown>).code === "string") {
    const direct = (data as Record<string, unknown>).code as string
    if (!codes.includes(direct)) codes.push(direct)
  }
  for (const c of codes) {
    if (!isCanonicalFailureCode(c)) continue
    const code = c as CanonicalFailureCode
    if (outer === INVALID_PARAMS && INVALID_PARAMS_FAMILY.has(code)) return { code, message }
    if (outer === INTERNAL_ERROR && INTERNAL_ERROR_FAMILY.has(code)) return { code, message }
    // Canonical code present but family mismatched → do not trust (forged or wrong-family).
    return undefined
  }
  return undefined
}

export const ProviderExecuteWire = {
  METHOD: PROVIDER_EXECUTE_METHOD,
  PROTOCOLS: PROVIDER_EXECUTE_PROTOCOLS,
  FAILURE_CODES: CANONICAL_FAILURE_CODES,
  validateRequest: validateProviderExecuteRequest,
  validateSuccess: validateProviderExecuteSuccess,
  isFailureCode: isCanonicalFailureCode,
  isProtocol: isProviderExecuteProtocol,
  extractFailure: extractCanonicalFailure,
}
