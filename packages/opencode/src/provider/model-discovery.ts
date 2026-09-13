/**
 * Runtime-owned OpenAI-compatible model discovery for legacy providers.
 *
 * Runs inside the CLI backend only. The caller supplies the stored backend
 * credential; this module never reads provider state, persists, or logs
 * secrets. Parsing mirrors the extension `fetchOpenAIModels` semantics
 * (trim, dedupe, name fallback, id sort) with added runtime bounds.
 */

export const MODEL_DISCOVERY_TIMEOUT_MS = 15_000
export const MODEL_DISCOVERY_MAX_BODY_BYTES = 1_000_000
export const MODEL_DISCOVERY_MAX_MODELS = 500
export const MODEL_DISCOVERY_MAX_ID_LENGTH = 256

export interface DiscoveredModel {
  id: string
  name: string
}

export type DiscoveryFailure =
  | { kind: "auth"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "upstream"; message: string }

export class ModelDiscoveryError extends Error {
  readonly kind: DiscoveryFailure["kind"]
  constructor(failure: DiscoveryFailure) {
    super(failure.message)
    this.name = "ModelDiscoveryError"
    this.kind = failure.kind
  }
}

export function normalizeBaseURL(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

/**
 * Strict baseURL shape for model discovery. Only plain `http:`/`https:`
 * origins with an optional path are accepted: embedded credentials, query
 * strings, and fragments are rejected so a stored key can never be aimed
 * by a crafted URL. Exact-match comparison still uses `normalizeBaseURL`
 * (trim plus trailing-slash tolerance) and never widens across origins.
 */
export function isStrictBaseURL(value: string): boolean {
  if (typeof value !== "string") return false
  const trimmed = value.trim()
  if (!trimmed) return false
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  if (parsed.username || parsed.password) return false
  if (parsed.search || parsed.hash) return false
  return true
}

/**
 * Runtime credential gate for model discovery: exact provider only, kilo
 * rejected, `api`/`custom` with non-empty key allowed, `config` only with
 * non-empty key and empty env (explicitly stored, not env-derived).
 */
export function isDiscoveryCredentialAllowed(input: {
  providerID: string
  source: unknown
  key: unknown
  env: unknown
}): boolean {
  if (!input.providerID || input.providerID === "kilo") return false
  const hasKey = typeof input.key === "string" && input.key.length > 0
  if (!hasKey) return false
  if (input.source === "api") return true
  if (input.source === "custom") return true
  if (input.source === "config" && Array.isArray(input.env) && input.env.length === 0) return true
  return false
}

function toEntry(item: unknown): DiscoveredModel | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined
  const record = item as Record<string, unknown>
  const id = typeof record.id === "string" ? record.id.trim() : ""
  if (!id || id.length > MODEL_DISCOVERY_MAX_ID_LENGTH) return undefined
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id
  return { id, name }
}

/** Strict, bounded parse of an OpenAI `/models` body. Redacted errors only. */
export function parseModelsBody(body: unknown): DiscoveredModel[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ModelDiscoveryError({ kind: "invalid", message: "Provider returned an invalid models response" })
  }
  const data = (body as Record<string, unknown>).data
  if (!Array.isArray(data)) {
    throw new ModelDiscoveryError({ kind: "invalid", message: "Provider returned an invalid models response" })
  }
  if (data.length > MODEL_DISCOVERY_MAX_MODELS) {
    throw new ModelDiscoveryError({ kind: "invalid", message: "Provider returned too many models" })
  }
  const seen = new Set<string>()
  const result: DiscoveredModel[] = []
  for (const item of data) {
    const entry = toEntry(item)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    result.push(entry)
  }
  result.sort((a, b) => a.id.localeCompare(b.id))
  return result
}

export async function fetchModelsWithKey(input: {
  baseURL: string
  key: string
  fetchFn?: typeof fetch
}): Promise<DiscoveredModel[]> {
  const base = normalizeBaseURL(input.baseURL)
  if (!isStrictBaseURL(base)) {
    throw new ModelDiscoveryError({ kind: "invalid", message: "Provider model discovery request is invalid" })
  }
  const run = input.fetchFn ?? fetch
  let response: Response
  try {
    response = await run(`${base}/models`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.key}`,
      },
      // Never follow redirects carrying the stored credential: any 3xx
      // below fails as a redacted upstream error instead.
      redirect: "manual",
      signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
    })
  } catch {
    throw new ModelDiscoveryError({ kind: "upstream", message: "Provider models request failed" })
  }
  if (response.status === 401 || response.status === 403) {
    await cancelBody(response)
    throw new ModelDiscoveryError({
      kind: "auth",
      message: `Stored credential failed authentication (HTTP ${response.status})`,
    })
  }
  if (response.status >= 300 && response.status < 400) {
    await cancelBody(response)
    throw new ModelDiscoveryError({ kind: "upstream", message: "Provider models request failed" })
  }
  if (!response.ok) {
    await cancelBody(response)
    throw new ModelDiscoveryError({ kind: "upstream", message: "Provider models request failed" })
  }
  const text = await readBoundedText(response)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new ModelDiscoveryError({ kind: "invalid", message: "Provider returned an invalid models response" })
  }
  return parseModelsBody(body)
}

/** Best-effort body release for early exits. Never throws, never reads. */
async function cancelBody(response: Response): Promise<void> {
  try {
    const body = response.body
    if (body) await body.cancel()
  } catch {
    // Best-effort release only.
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // Best-effort release only.
  }
  try {
    reader.releaseLock()
  } catch {
    // Best-effort release only.
  }
}

/**
 * Bounded body read counted in bytes, not characters. A declared
 * content-length over the bound rejects before any byte is consumed;
 * missing/chunked bodies accumulate through the reader and cancel the
 * moment the bound is exceeded. Read timeouts/aborts surface as upstream
 * failures. Errors are fixed strings with no key, body, or URL content.
 */
async function readBoundedText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length")
  if (declared !== null) {
    const size = Number(declared)
    if (!Number.isInteger(size) || size < 0 || size > MODEL_DISCOVERY_MAX_BODY_BYTES) {
      await cancelBody(response)
      throw new ModelDiscoveryError({ kind: "invalid", message: "Provider returned an oversized models response" })
    }
  }
  const body = response.body
  if (!body) {
    throw new ModelDiscoveryError({ kind: "invalid", message: "Provider returned an invalid models response" })
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MODEL_DISCOVERY_MAX_BODY_BYTES) {
        await cancelReader(reader)
        throw new ModelDiscoveryError({ kind: "invalid", message: "Provider returned an oversized models response" })
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof ModelDiscoveryError) throw error
    await cancelReader(reader)
    throw new ModelDiscoveryError({ kind: "upstream", message: "Provider models request failed" })
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}
