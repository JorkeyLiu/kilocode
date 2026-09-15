/**
 * Active-fallback availability probe (vscode-free).
 *
 * A real low-token generation probe against one canonical custom-provider
 * record: maxTokens 1, no tools, deterministic short prompt. It runs in the
 * extension host where the SecretStorage secret lives; the secret is held in
 * memory only and never crosses to the webview, JSONC, or logs, and response
 * bodies are classified without being returned or logged.
 *
 * `/models` discovery stays the model-choice source only: a successful models
 * list never marks a fallback usable. This probe sends exactly one generation
 * request per explicit invocation (Check button or fallback activation) and
 * never polls.
 */

import {
  isProviderExecuteProtocol,
  PROVIDER_EXECUTE_PATH_BY_PROTOCOL,
  type ProviderExecuteProtocol,
} from "@opencode-ai/core/kilocode/provider-execute"
import { parseFallbackModelRef } from "@opencode-ai/core/kilocode/canonical-record"

export type FallbackProbeReason = "auth" | "rate-limit" | "invalid-model" | "invalid-config" | "network" | "upstream"

export type FallbackProbeResult =
  | { readonly usable: true }
  | { readonly usable: false; readonly reason: FallbackProbeReason; readonly message: string }

export const FALLBACK_PROBE_TIMEOUT_MS = 15_000
export const FALLBACK_PROBE_MAX_BODY_BYTES = 65_536
export const FALLBACK_PROBE_PROMPT = "ok"

export function parseFallbackSelection(value: unknown): { providerID: string; modelID: string } | undefined {
  return parseFallbackModelRef(value)
}

/**
 * Effective single active fallback across scopes. Project shadows global
 * exactly like the ordinary `model` preference; the ordinary primary
 * selection is never read here so the fallback stays purely additive.
 */
export function effectiveFallbackSelection(
  project: unknown,
  global: unknown,
): { providerID: string; modelID: string } | undefined {
  return parseFallbackSelection(typeof project === "string" ? project : global)
}

/** Strict endpoint shape: plain http(s) origin plus optional path, no credentials/query/fragment. */
export function strictProbeEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
  if (parsed.username || parsed.password) return undefined
  if (parsed.search || parsed.hash) return undefined
  return trimmed.replace(/\/+$/, "")
}

export function probeUrl(endpoint: string, protocol: ProviderExecuteProtocol): string | undefined {
  const base = strictProbeEndpoint(endpoint)
  if (!base) return undefined
  return `${base}${PROVIDER_EXECUTE_PATH_BY_PROTOCOL[protocol]}`
}

/** Minimal one-token generation body per protocol. No tools, deterministic prompt. */
export function probeBody(protocol: ProviderExecuteProtocol, modelID: string): Record<string, unknown> {
  if (protocol === "openai/responses") {
    return { model: modelID, input: FALLBACK_PROBE_PROMPT, max_output_tokens: 1, temperature: 0, stream: false }
  }
  if (protocol === "anthropic/messages") {
    return {
      model: modelID,
      messages: [{ role: "user", content: FALLBACK_PROBE_PROMPT }],
      max_tokens: 1,
      temperature: 0,
      stream: false,
    }
  }
  return {
    model: modelID,
    messages: [{ role: "user", content: FALLBACK_PROBE_PROMPT }],
    max_tokens: 1,
    temperature: 0,
    stream: false,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** A 2xx body counts as usable only when it carries the protocol's generation shape. */
export function isGenerationShape(protocol: ProviderExecuteProtocol, body: unknown): boolean {
  if (!isRecord(body)) return false
  if (protocol === "openai/completions") return Array.isArray(body.choices)
  if (protocol === "openai/responses")
    return Array.isArray(body.output) || typeof body.id === "string" || body.object === "response"
  return Array.isArray(body.content) || body.type === "message"
}

const INVALID_MODEL_STATUS = new Set([400, 404, 422])

export function classifyProbeStatus(status: number): FallbackProbeResult {
  if (status === 401 || status === 403)
    return { usable: false, reason: "auth", message: "Stored credential failed authentication" }
  if (status === 429)
    return { usable: false, reason: "rate-limit", message: "Provider is rate limited or out of quota" }
  if (INVALID_MODEL_STATUS.has(status))
    return { usable: false, reason: "invalid-model", message: "Provider rejected the model or request" }
  if (status >= 300 && status < 400)
    return { usable: false, reason: "upstream", message: "Provider redirect was not followed" }
  if (status >= 500) return { usable: false, reason: "upstream", message: "Provider request failed" }
  return { usable: false, reason: "upstream", message: "Provider request failed" }
}

export function probeFailure(reason: FallbackProbeReason, message: string): FallbackProbeResult {
  return { usable: false, reason, message }
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length")
  if (declared !== null) {
    const size = Number(declared)
    if (!Number.isInteger(size) || size < 0 || size > FALLBACK_PROBE_MAX_BODY_BYTES) {
      throw probeFailure("upstream", "Provider returned an oversized response")
    }
  }
  const body = response.body
  if (!body) throw probeFailure("upstream", "Provider returned an empty response")
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > FALLBACK_PROBE_MAX_BODY_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // Best-effort release only.
        }
        throw probeFailure("upstream", "Provider returned an oversized response")
      }
      chunks.push(next.value)
    }
  } catch (error) {
    if (isRecord(error) && error.usable === false) throw error
    try {
      await reader.cancel()
    } catch {
      // Best-effort release only.
    }
    throw probeFailure("network", "Provider request failed")
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

/**
 * Run one bounded generation probe. The secret is injected as a Bearer token
 * on the fixed protocol route only and never leaves this call. Redirects are
 * never followed with the credential; every failure is a fixed redacted
 * message with no response body, URL, or secret content.
 */
export async function probeFallbackProvider(input: {
  endpoint: unknown
  protocol: unknown
  modelID: unknown
  secret: unknown
  fetchFn?: typeof fetch
}): Promise<FallbackProbeResult> {
  if (!isProviderExecuteProtocol(input.protocol)) return probeFailure("invalid-config", "Provider protocol is invalid")
  if (typeof input.modelID !== "string" || !input.modelID.trim())
    return probeFailure("invalid-config", "Provider model is invalid")
  const url = probeUrl(typeof input.endpoint === "string" ? input.endpoint : "", input.protocol)
  if (!url) return probeFailure("invalid-config", "Provider endpoint is invalid")
  if (typeof input.secret !== "string" || !input.secret)
    return probeFailure("auth", "No stored credential for this provider")
  const run = input.fetchFn ?? fetch
  let response: Response
  try {
    response = await run(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.secret}` },
      body: JSON.stringify(probeBody(input.protocol, input.modelID.trim())),
      redirect: "manual",
      signal: AbortSignal.timeout(FALLBACK_PROBE_TIMEOUT_MS),
    })
  } catch {
    return probeFailure("network", "Provider request failed")
  }
  if (response.status < 200 || response.status >= 300) {
    try {
      const body = response.body
      if (body) await body.cancel()
    } catch {
      // Best-effort release only.
    }
    return classifyProbeStatus(response.status)
  }
  let text: string
  try {
    text = await readBoundedText(response)
  } catch (error) {
    if (isRecord(error) && error.usable === false) return error as FallbackProbeResult
    return probeFailure("network", "Provider request failed")
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return probeFailure("upstream", "Provider returned an invalid response")
  }
  if (!isGenerationShape(input.protocol, body)) return probeFailure("upstream", "Provider returned an invalid response")
  return { usable: true }
}
