/**
 * Bounded canonical provider host-side materializer/executor.
 *
 * Extension Host only. Takes an already-authored canonical provider record
 * (exact name/endpoint/protocol/models/credential keys) plus verified
 * provider/model ids, selects the shared `packages/llm` protocol route
 * directly by protocol, resolves the exact owned credential ref through the
 * host-only resolver on every execution, and runs one normalized generation.
 *
 * Closure rules:
 * - Protocols only: openai/completions -> chat route, openai/responses ->
 *   responses route, anthropic/messages -> messages route. No npm field.
 * - Credential ref must be the exact record-authored owned ref bound to
 *   kind "provider" and this provider id. Missing/illegal/mismatched refs
 *   and absent secrets fail closed. No id-derived fallback ref.
 * - Auth comes from the route: OpenAI bearer, Anthropic x-api-key plus the
 *   route's fixed version header. No authored headers.
 * - Plaintext secrets never enter logs, env, files, or the public surface.
 *   Shared LLM redaction covers transport errors; this seam additionally
 *   deep-redacts every successful output (text plus nested event strings,
 *   arrays, and object keys/values, shape-preserving) and scrubs surfaced
 *   error messages, so a provider-echoed credential cannot leak.
 *   Raw and URL-encoded forms are both replaced with [REDACTED].
 * - Host execution seam only. No UI, no session runtime wiring.
 */

import { Effect, Layer } from "effect"
import { Auth, LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { LLM } from "@opencode-ai/llm"
import type { LLMEvent } from "@opencode-ai/llm"
import { route as chat } from "@opencode-ai/llm/protocols/openai-chat"
import { route as responses } from "@opencode-ai/llm/protocols/openai-responses"
import { route as messages } from "@opencode-ai/llm/protocols/anthropic-messages"
import {
  isValidModelEntry,
  parseCanonicalProviderRecord,
  parseOwnedCredentialRef,
  type CanonicalProviderProtocol,
} from "../config/types"
import type { CanonicalFailureCode as SharedFailureCode } from "@opencode-ai/core/kilocode/provider-execute"
import { CANONICAL_FAILURE_CODES as SHARED_CODES } from "@opencode-ai/core/kilocode/provider-execute"

// Re-export the shared canonical failure codes; `aborted` lives only in the
// cross-process wire (host maps AbortError to `aborted`) and is not a
// host-side materialization code, so it is omitted from this host-specific
// surface.
export type CanonicalFailureCode = Exclude<SharedFailureCode, "aborted">
export const CANONICAL_FAILURE_CODES = SHARED_CODES.filter((c) => c !== "aborted") as unknown as readonly CanonicalFailureCode[]

export class CanonicalExecuteError extends Error {
  readonly code: CanonicalFailureCode
  constructor(code: CanonicalFailureCode, message: string) {
    super(message)
    this.name = "CanonicalExecuteError"
    this.code = code
  }
}

export interface CanonicalExecuteInput {
  readonly providerId: string
  readonly modelId: string
  readonly record: unknown
  readonly prompt: string
}

export interface CanonicalHostDeps {
  /** Host-only SecretStorage resolver. Called with the exact authored ref on every execution. */
  readonly resolveSecret: (ref: string) => Promise<string | undefined>
}

export interface CanonicalSuccess {
  readonly providerId: string
  readonly modelId: string
  readonly protocol: CanonicalProviderProtocol
  readonly endpoint: string
  readonly path: string
  readonly text: string
  readonly events: readonly LLMEvent[]
}

const PATH_BY_PROTOCOL: Record<CanonicalProviderProtocol, string> = {
  "openai/completions": "/chat/completions",
  "openai/responses": "/responses",
  "anthropic/messages": "/messages",
}

const REDACTED = "[REDACTED]"

/**
 * Replacement patterns for one secret, longest first. Raw and URL-encoded
 * forms are both covered; split/join replacement is loop-free and needs no
 * regex escaping, and longest-first ordering keeps an earlier pass from
 * corrupting the [REDACTED] markers left by a later one. Every non-empty
 * secret is redacted, including 1-3 character ones; empty input redacts
 * nothing (splitting on "" would interleave markers between every char).
 */
const patterns = (secret: string): readonly string[] => {
  if (secret.length === 0) return []
  const encoded = encodeURIComponent(secret)
  if (encoded === secret) return [secret]
  return encoded.length >= secret.length ? [encoded, secret] : [secret, encoded]
}

const redactText = (secret: string, text: string): string => {
  let out = text
  for (const pattern of patterns(secret)) out = out.split(pattern).join(REDACTED)
  return out
}

/**
 * Shape-preserving deep redaction of normalized success output. Walks
 * strings, arrays, and objects (including class instances, via a
 * prototype-preserving copy); keys and values are both covered. The
 * original response is never mutated.
 */
const redactDeep = (secret: string, value: unknown): unknown => {
  if (typeof value === "string") return redactText(secret, value)
  if (Array.isArray(value)) return value.map((item) => redactDeep(secret, item))
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[redactText(secret, key)] = redactDeep(secret, item)
    Object.setPrototypeOf(out, Object.getPrototypeOf(value))
    return out
  }
  return value
}

interface Materialized {
  readonly protocol: CanonicalProviderProtocol
  readonly endpoint: string
  readonly ref: string
}

/** Validate static authored fields and the exact credential-ref binding. No secret I/O. */
// Ordering preserves granular classifications: endpoint/protocol/credential/model keep exact codes;
// all other malformed provider/model fields, closed-shape violations, and nested
// reasoning/modalities/variants errors become `invalid-record`. Reuses
// `isValidModelEntry` for the full model AST rather than duplicating it.
// eslint-disable-next-line complexity
const materialize = (input: CanonicalExecuteInput): Materialized => {
  if (typeof input.providerId !== "string" || input.providerId.length === 0 || typeof input.modelId !== "string" || input.modelId.length === 0)
    throw new CanonicalExecuteError("invalid-record", "Invalid canonical provider entry")
  if (typeof input.prompt !== "string") throw new CanonicalExecuteError("invalid-record", "Invalid canonical provider entry")
  const raw = input.record
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new CanonicalExecuteError("invalid-record", "Invalid canonical provider entry")
  const rec = raw as Record<string, unknown>
  if (Object.getPrototypeOf(rec) !== Object.prototype) throw new CanonicalExecuteError("invalid-record", "Invalid canonical provider entry")
  if (Object.prototype.hasOwnProperty.call(rec, "__proto__") || Object.prototype.hasOwnProperty.call(rec, "constructor"))
    throw new CanonicalExecuteError("invalid-record", "Invalid canonical provider entry")

  const allowed = new Set(["name", "endpoint", "protocol", "models", "credential"])
  for (const key of Object.keys(rec)) if (!allowed.has(key)) throw new CanonicalExecuteError("invalid-record", "Invalid canonical provider entry")
  if (rec.name !== undefined && (typeof rec.name !== "string" || rec.name.length === 0))
    throw new CanonicalExecuteError("invalid-record", "Invalid canonical provider entry")

  // Endpoint/protocol/credential/model keep exact codes before generic invalid-record.
  const endpoint = rec.endpoint
  if (typeof endpoint !== "string" || endpoint.length === 0)
    throw new CanonicalExecuteError("invalid-endpoint", "Invalid canonical provider endpoint")
  try {
    const url = new URL(endpoint)
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new CanonicalExecuteError("invalid-endpoint", "Invalid canonical provider endpoint")
  } catch (err) {
    if (err instanceof CanonicalExecuteError) throw err
    throw new CanonicalExecuteError("invalid-endpoint", "Invalid canonical provider endpoint")
  }

  const protocol = rec.protocol
  if (protocol !== "openai/completions" && protocol !== "openai/responses" && protocol !== "anthropic/messages")
    throw new CanonicalExecuteError("unknown-protocol", "Unsupported canonical provider protocol")

  // Full model AST validation via shared helper: any closed-shape violation or
  // nested reasoning/modalities/variants error is `invalid-record` before `unknown-model`.
  const models = rec.models
  if (models === undefined) throw new CanonicalExecuteError("unknown-model", "Unknown canonical provider model")
  if (typeof models !== "object" || models === null || Array.isArray(models))
    throw new CanonicalExecuteError("invalid-record", "Invalid canonical provider entry")
  if (Object.getPrototypeOf(models as object) !== Object.prototype)
    throw new CanonicalExecuteError("invalid-record", "Invalid canonical provider entry")
  const entries = Object.entries(models as Record<string, unknown>)
  if (entries.length === 0) throw new CanonicalExecuteError("invalid-record", "Invalid canonical provider entry")
  for (const [mid, value] of entries) {
    if (typeof mid !== "string" || mid.length === 0 || mid.includes("\0"))
      throw new CanonicalExecuteError("invalid-record", "Invalid canonical provider entry")
    if (!isValidModelEntry(value)) throw new CanonicalExecuteError("invalid-record", "Invalid canonical provider entry")
  }
  if (!Object.prototype.hasOwnProperty.call(models as Record<string, unknown>, input.modelId))
    throw new CanonicalExecuteError("unknown-model", "Unknown canonical provider model")

  const ref = rec.credential
  if (typeof ref !== "string" || ref.length === 0)
    throw new CanonicalExecuteError("missing-credential-ref", "Canonical provider credential is missing")
  const parsed = parseOwnedCredentialRef(ref)
  if (!parsed || parsed.kind !== "provider" || parsed.id !== input.providerId)
    throw new CanonicalExecuteError("invalid-credential-ref", "Invalid canonical provider credential reference")
  return { protocol: protocol as CanonicalProviderProtocol, endpoint: endpoint as string, ref: ref as string }
}

const run = (
  input: CanonicalExecuteInput,
  secret: string,
  endpoint: string,
  protocol: CanonicalProviderProtocol,
  signal?: AbortSignal,
): Promise<CanonicalSuccess> => {
  const base = endpoint.replace(/\/+$/, "")
  const route =
    protocol === "openai/completions"
      ? chat.with({ endpoint: { baseURL: base }, auth: Auth.bearer(secret) })
      : protocol === "openai/responses"
        ? responses.with({ endpoint: { baseURL: base }, auth: Auth.bearer(secret) })
        : messages.with({ endpoint: { baseURL: base }, auth: Auth.header("x-api-key", secret) })
  const model = route.model({ id: input.modelId })
  const request = LLM.request({ model, prompt: input.prompt })
  const layer = LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer))
  const program = Effect.gen(function* () {
    const response = yield* LLMClient.generate(request)
    return {
      providerId: input.providerId,
      modelId: input.modelId,
      protocol,
      endpoint: base,
      path: PATH_BY_PROTOCOL[protocol],
      text: redactText(secret, response.text),
      events: redactDeep(secret, [...response.events]) as readonly LLMEvent[],
    } satisfies CanonicalSuccess
  }).pipe(Effect.provide(layer))
  if (!signal) return Effect.runPromise(program)
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"))
  return Effect.runPromise(program, { signal }).catch((err) => {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError")
    if (err instanceof Error && (err.name === "InterruptError" || err.message.includes("interrupted") || err.message.includes("Interrupted"))) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError")
    }
    throw err
  })
}

/**
 * Execute one canonical provider generation against its authored endpoint.
 * Resolves the exact authored credential ref on every call; rotated secrets
 * take effect on the next execution with no caching here.
 */
export const execute = async (
  input: CanonicalExecuteInput,
  deps: CanonicalHostDeps,
  signal?: AbortSignal,
): Promise<CanonicalSuccess> => {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
  const built = materialize(input)
  let secret: string | undefined
  try {
    secret = await deps.resolveSecret(built.ref)
  } catch {
    throw new CanonicalExecuteError("missing-secret", "Canonical provider credential is unavailable")
  }
  if (typeof secret !== "string" || secret.length === 0)
    throw new CanonicalExecuteError("missing-secret", "Canonical provider credential is unavailable")
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
  try {
    return await run(input, secret, built.endpoint, built.protocol, signal)
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    if (err instanceof Error && err.name === "InterruptError" && signal) throw new DOMException("Aborted", "AbortError")
    // Only the scrubbed message is surfaced: no cause, no diagnostics, no
    // public properties carry the secret. String(err) derives from this
    // same message plus the fixed class name.
    const message = err instanceof Error ? err.message : "Canonical provider request failed"
    throw new CanonicalExecuteError("provider", redactText(secret, message))
  }
}

export interface CanonicalServiceDeps {
  readonly getScopeConfig: (scope: "global" | "project") => Record<string, unknown>
  readonly resolveSecret: (ref: string) => Promise<string | undefined>
}

/**
 * Read the exact provider record from CanonicalConfigService and execute.
 * The record is validated with id-bound credential rules; no ref is rebuilt.
 */
export const executeFromService = async (
  service: CanonicalServiceDeps,
  scope: "global" | "project",
  providerId: string,
  modelId: string,
  prompt: string,
): Promise<CanonicalSuccess> => {
  const scopeConfig = service.getScopeConfig(scope)
  const parsed = parseCanonicalProviderRecord(scopeConfig.provider)
  const record = parsed?.[providerId]
  if (!record) throw new CanonicalExecuteError("invalid-record", "Invalid canonical provider entry")
  return execute({ providerId, modelId, record, prompt }, { resolveSecret: service.resolveSecret })
}
