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
  isValidCanonicalProviderEntry,
  parseCanonicalProviderRecord,
  parseOwnedCredentialRef,
  type CanonicalProviderPayload,
  type CanonicalProviderProtocol,
} from "../config/types"

export type CanonicalFailureCode =
  | "invalid-record"
  | "invalid-endpoint"
  | "unknown-protocol"
  | "unknown-model"
  | "missing-credential-ref"
  | "invalid-credential-ref"
  | "missing-secret"
  | "provider"

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
  readonly record: CanonicalProviderPayload
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
const materialize = (input: CanonicalExecuteInput): Materialized => {
  if (input.providerId.length === 0 || input.modelId.length === 0)
    throw new CanonicalExecuteError("invalid-record", "Invalid canonical provider entry")
  if (!isValidCanonicalProviderEntry(input.record, input.providerId))
    throw new CanonicalExecuteError("invalid-record", "Invalid canonical provider entry")
  const endpoint = input.record.endpoint
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
  const protocol = input.record.protocol
  if (protocol !== "openai/completions" && protocol !== "openai/responses" && protocol !== "anthropic/messages")
    throw new CanonicalExecuteError("unknown-protocol", "Unsupported canonical provider protocol")
  const models = input.record.models
  if (!models || !(input.modelId in models))
    throw new CanonicalExecuteError("unknown-model", "Unknown canonical provider model")
  const ref = input.record.credential
  if (typeof ref !== "string" || ref.length === 0)
    throw new CanonicalExecuteError("missing-credential-ref", "Canonical provider credential is missing")
  const parsed = parseOwnedCredentialRef(ref)
  if (!parsed || parsed.kind !== "provider" || parsed.id !== input.providerId)
    throw new CanonicalExecuteError("invalid-credential-ref", "Invalid canonical provider credential reference")
  return { protocol, endpoint, ref }
}

const run = (
  input: CanonicalExecuteInput,
  secret: string,
  endpoint: string,
  protocol: CanonicalProviderProtocol,
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
  return Effect.runPromise(program)
}

/**
 * Execute one canonical provider generation against its authored endpoint.
 * Resolves the exact authored credential ref on every call; rotated secrets
 * take effect on the next execution with no caching here.
 */
export const execute = async (input: CanonicalExecuteInput, deps: CanonicalHostDeps): Promise<CanonicalSuccess> => {
  const built = materialize(input)
  let secret: string | undefined
  try {
    secret = await deps.resolveSecret(built.ref)
  } catch {
    throw new CanonicalExecuteError("missing-secret", "Canonical provider credential is unavailable")
  }
  if (typeof secret !== "string" || secret.length === 0)
    throw new CanonicalExecuteError("missing-secret", "Canonical provider credential is unavailable")
  try {
    return await run(input, secret, built.endpoint, built.protocol)
  } catch (err) {
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
