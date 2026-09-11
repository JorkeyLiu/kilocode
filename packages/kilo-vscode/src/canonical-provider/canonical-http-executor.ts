/**
 * Bounded canonical provider HTTP streaming executor.
 *
 * Extension Host only. Takes an already-authored canonical provider record
 * (exact name/endpoint/protocol/models/credential keys) plus verified
 * provider/model ids, the exact JSON body and non-sensitive headers, selects
 * the fixed POST route by protocol, resolves the exact owned credential ref,
 * injects the secret, and streams the HTTP response as correlated $/event
 * events via the peer emit.
 *
 * Closure rules match canonical-executor: endpoint/protocol/credential/model
 * preserve granular codes; validated record is closed; secret never leaks.
 */

import { isValidCanonicalProviderEntry, isValidModelEntry, parseOwnedCredentialRef, type CanonicalProviderProtocol } from "../config/types"
import { isProviderExecuteProtocol, PROVIDER_EXECUTE_PATH_BY_PROTOCOL } from "@opencode-ai/core/kilocode/provider-execute"
import {
  HTTP_BODY_MAX_BYTES,
  HTTP_CHUNK_MAX_BYTES,
  HTTP_TOTAL_MAX_BYTES,
  HTTP_MAX_CHUNKS,
  type ProviderHttpExecuteResult,
  hasDuplicateTopLevelModelKey,
  isForbiddenHeaderName,
} from "@opencode-ai/core/kilocode/provider-http-execute"

export class CanonicalHttpExecuteError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "CanonicalHttpExecuteError"
    this.code = code
  }
}

export interface CanonicalHttpExecuteInput {
  readonly providerId: string
  readonly modelId: string
  readonly record: unknown
  readonly body: string
  readonly headers?: Record<string, string>
}

export interface CanonicalHttpDeps {
  readonly resolveSecret: (ref: string) => Promise<string | undefined>
}

const PATH_BY_PROTOCOL: Record<CanonicalProviderProtocol, string> = PROVIDER_EXECUTE_PATH_BY_PROTOCOL as unknown as Record<CanonicalProviderProtocol, string>

const REDACTED = "[REDACTED]"

const patterns = (secret: string): readonly string[] => {
  if (secret.length === 0) return []
  const encoded = encodeURIComponent(secret)
  if (encoded === secret) return [secret]
  return encoded.length >= secret.length ? [encoded, secret] : [secret, encoded]
}

const redactText = (secret: string, text: string): string => {
  let out = text
  for (const p of patterns(secret)) out = out.split(p).join(REDACTED)
  return out
}

interface Materialized {
  readonly protocol: CanonicalProviderProtocol
  readonly endpoint: string
  readonly ref: string
}

const materialize = (input: CanonicalHttpExecuteInput): Materialized => {
  if (typeof input.providerId !== "string" || input.providerId.length === 0 || typeof input.modelId !== "string" || input.modelId.length === 0)
    throw new CanonicalHttpExecuteError("invalid-record", "Invalid canonical provider entry")
  if (typeof input.body !== "string") throw new CanonicalHttpExecuteError("invalid-record", "Invalid canonical provider entry")
  if (Buffer.byteLength(input.body, "utf8") > HTTP_BODY_MAX_BYTES) throw new CanonicalHttpExecuteError("invalid-record", "Invalid canonical provider entry")
  if (hasDuplicateTopLevelModelKey(input.body)) throw new CanonicalHttpExecuteError("invalid-record", "Duplicate top-level model key")
  let parsed: unknown
  try {
    parsed = JSON.parse(input.body)
  } catch {
    throw new CanonicalHttpExecuteError("invalid-record", "Invalid JSON body")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CanonicalHttpExecuteError("invalid-record", "Invalid canonical provider entry")
  const modelField = (parsed as Record<string, unknown>).model
  if (typeof modelField !== "string" || modelField !== input.modelId) throw new CanonicalHttpExecuteError("invalid-record", "Invalid body model")
  const raw = input.record
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CanonicalHttpExecuteError("invalid-record", "Invalid canonical provider entry")
  const rec = raw as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(rec, "__proto__") || Object.prototype.hasOwnProperty.call(rec, "constructor"))
    throw new CanonicalHttpExecuteError("invalid-record", "Invalid canonical provider entry")
  const endpoint = rec.endpoint
  if (typeof endpoint !== "string" || endpoint.length === 0) throw new CanonicalHttpExecuteError("invalid-endpoint", "Invalid canonical provider endpoint")
  try {
    const url = new URL(endpoint)
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new CanonicalHttpExecuteError("invalid-endpoint", "Invalid canonical provider endpoint")
    if (url.username || url.password) throw new CanonicalHttpExecuteError("invalid-endpoint", "Invalid canonical provider endpoint")
    if (url.search || url.hash) throw new CanonicalHttpExecuteError("invalid-endpoint", "Invalid canonical provider endpoint")
  } catch (err) {
    if (err instanceof CanonicalHttpExecuteError) throw err
    throw new CanonicalHttpExecuteError("invalid-endpoint", "Invalid canonical provider endpoint")
  }
  const protocol = rec.protocol
  if (!isProviderExecuteProtocol(protocol)) throw new CanonicalHttpExecuteError("unknown-protocol", "Unsupported canonical provider protocol")
  const models = rec.models
  if (models === undefined) throw new CanonicalHttpExecuteError("unknown-model", "Unknown canonical provider model")
  if (typeof models !== "object" || models === null || Array.isArray(models)) throw new CanonicalHttpExecuteError("invalid-record", "Invalid canonical provider entry")
  const entries = Object.entries(models as Record<string, unknown>)
  if (entries.length === 0) throw new CanonicalHttpExecuteError("invalid-record", "Invalid canonical provider entry")
  for (const [mid, value] of entries) {
    if (typeof mid !== "string" || mid.length === 0 || mid.includes("\0")) throw new CanonicalHttpExecuteError("invalid-record", "Invalid canonical provider entry")
    if (!isValidModelEntry(value)) throw new CanonicalHttpExecuteError("invalid-record", "Invalid canonical provider entry")
  }
  if (!Object.prototype.hasOwnProperty.call(models as Record<string, unknown>, input.modelId))
    throw new CanonicalHttpExecuteError("unknown-model", "Unknown canonical provider model")
  const ref = rec.credential
  if (typeof ref !== "string" || ref.length === 0) throw new CanonicalHttpExecuteError("missing-credential-ref", "Canonical provider credential is missing")
  const parsedRef = parseOwnedCredentialRef(ref)
  if (!parsedRef || parsedRef.kind !== "provider" || parsedRef.id !== input.providerId) throw new CanonicalHttpExecuteError("invalid-credential-ref", "Invalid canonical provider credential reference")
  if (!isValidCanonicalProviderEntry(rec, { providerId: input.providerId })) throw new CanonicalHttpExecuteError("invalid-record", "Invalid canonical provider entry")
  if (input.headers) {
    for (const k of Object.keys(input.headers)) {
      const lower = k.toLowerCase()
      if (isForbiddenHeaderName(lower)) {
        throw new CanonicalHttpExecuteError("invalid-record", "Forbidden header")
      }
    }
  }
  return { protocol: protocol as CanonicalProviderProtocol, endpoint: endpoint as string, ref: ref as string }
}

function sanitizeResponseHeaders(input: Headers, secret: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of input.entries()) {
    const lower = k.toLowerCase()
    if (isForbiddenHeaderName(lower)) continue
    if (lower.length > 128 || v.length > 4096) continue
    if (lower.includes("\0") || v.includes("\0") || /[\r\n]/.test(lower) || /[\r\n]/.test(v)) continue
    const redacted = redactText(secret, v)
    // re-check after redaction length bound
    if (redacted.length > 4096) continue
    if (redacted.includes("\0") || /[\r\n]/.test(redacted)) continue
    out[lower] = redacted
  }
  return out
}

function buildUrl(endpoint: string, protocol: CanonicalProviderProtocol): string {
  const url = new URL(endpoint)
  // already validated no username/password/search/hash, but re-check for safety
  if (url.username || url.password) throw new CanonicalHttpExecuteError("invalid-endpoint", "Invalid canonical provider endpoint")
  if (url.search || url.hash) throw new CanonicalHttpExecuteError("invalid-endpoint", "Invalid canonical provider endpoint")
  const path = PATH_BY_PROTOCOL[protocol]
  const basePath = url.pathname.replace(/\/+$/, "")
  const fullPath = `${basePath}${path}`
  url.pathname = fullPath
  url.search = ""
  url.hash = ""
  return url.toString()
}

export const executeHttp = async (
  input: CanonicalHttpExecuteInput,
  deps: CanonicalHttpDeps,
  signal: AbortSignal,
  emit: (event: unknown) => boolean,
): Promise<ProviderHttpExecuteResult> => {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError")
  const built = materialize(input)
  let secret: string | undefined
  try {
    secret = await deps.resolveSecret(built.ref)
  } catch {
    throw new CanonicalHttpExecuteError("missing-secret", "Canonical provider credential is unavailable")
  }
  if (typeof secret !== "string" || secret.length === 0) throw new CanonicalHttpExecuteError("missing-secret", "Canonical provider credential is unavailable")
  if (signal.aborted) throw new DOMException("Aborted", "AbortError")

  const url = buildUrl(built.endpoint, built.protocol)

  // Build headers
  const headers: Record<string, string> = {}
  headers["content-type"] = "application/json"
  headers["accept"] = "*/*"
  // Caller headers (already validated)
  if (input.headers) {
    for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v
  }
  // Protocol fixed headers
  if (built.protocol === "anthropic/messages") {
    headers["anthropic-version"] = "2023-06-01"
    headers["x-api-key"] = secret
  } else {
    headers["authorization"] = `Bearer ${secret}`
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: input.body,
      signal,
      redirect: "manual",
    } as RequestInit)
  } catch (err) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError")
    const msg = err instanceof Error ? err.message : "Canonical provider request failed"
    throw new CanonicalHttpExecuteError("provider", redactText(secret, msg))
  }

  if (signal.aborted) {
    try {
      response.body?.cancel()
    } catch {}
    throw new DOMException("Aborted", "AbortError")
  }

  // Redirect fail-closed: do not follow, do not leak secret
  if (response.status >= 300 && response.status < 400) {
    try {
      response.body?.cancel()
    } catch {}
    throw new CanonicalHttpExecuteError("provider", "Redirect not allowed")
  }

  const status = response.status
  const sanitizedHeaders = sanitizeResponseHeaders(response.headers, secret)

  // Emit metadata seq 0
  const metadataOk = emit({ seq: 0, status, headers: sanitizedHeaders })
  if (!metadataOk) {
    try {
      response.body?.cancel()
    } catch {}
    throw new DOMException("Aborted", "AbortError")
  }

  // Stream body with stream-aware redaction
  let seq = 0
  let chunks = 0
  let totalBytes = 0

  const reader = response.body?.getReader()
  if (!reader) {
    return { seq, chunks, bytes: totalBytes }
  }

  const abortHandler = () => {
    try {
      reader.cancel()
    } catch {}
  }
  if (signal.aborted) abortHandler()
  signal.addEventListener("abort", abortHandler, { once: true })

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const pats = patterns(secret)
  let carry = ""

  const flushEmit = async (textToEmit: string): Promise<void> => {
    if (textToEmit.length === 0) return
    const bytes = encoder.encode(textToEmit)
    for (let off = 0; off < bytes.length; off += HTTP_CHUNK_MAX_BYTES) {
      const slice = bytes.subarray(off, Math.min(off + HTTP_CHUNK_MAX_BYTES, bytes.length))
      totalBytes += slice.length
      if (totalBytes > HTTP_TOTAL_MAX_BYTES) {
        throw new CanonicalHttpExecuteError("provider", "Total bytes too large")
      }
      chunks += 1
      if (chunks > HTTP_MAX_CHUNKS) throw new CanonicalHttpExecuteError("provider", "Too many chunks")
      seq += 1
      const b64 = Buffer.from(slice).toString("base64")
      const ok = emit({ seq, bytes: b64 })
      if (!ok) throw new DOMException("Aborted", "AbortError")
    }
  }

  const longestKeep = (text: string): number => {
    let best = 0
    for (const pat of pats) {
      const maxK = Math.min(text.length, pat.length - 1)
      for (let k = maxK; k > 0; k--) {
        if (text.endsWith(pat.slice(0, k))) {
          if (k > best) best = k
          break
        }
      }
    }
    return best
  }

  const processPiece = (piece: string, isFinal: boolean): string | null => {
    const pending = carry + piece
    if (!isFinal) {
      const keep = longestKeep(pending)
      if (keep > 0 && pending.length <= keep) {
        carry = pending
        return null
      }
      if (keep === 0) {
        // No prefix suffix, safe to emit all but keep 0; but to avoid holding unbounded, we can emit all
        // However we must ensure we don't emit partial that is prefix of pattern that hasn't been detected due to keep 0?
        // Since keep 0 means no suffix is prefix, it's safe to emit all.
        carry = ""
        return redactText(secret, pending)
      }
      const toProcess = pending.slice(0, pending.length - keep)
      carry = pending.slice(pending.length - keep)
      return redactText(secret, toProcess)
    }
    const redacted = redactText(secret, pending)
    carry = ""
    return redacted
  }

  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError")
      let read: ReadableStreamReadResult<Uint8Array>
      try {
        read = await reader.read()
      } catch (err) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError")
        const msg = err instanceof Error ? err.message : String(err)
        throw new CanonicalHttpExecuteError("provider", redactText(secret, msg))
      }
      if (read.done) break
      const value = read.value
      if (!value || value.length === 0) continue
      if (value.length > HTTP_CHUNK_MAX_BYTES) throw new CanonicalHttpExecuteError("provider", "Chunk too large")
      if (signal.aborted) throw new DOMException("Aborted", "AbortError")
      let textPiece: string
      try {
        textPiece = decoder.decode(value, { stream: true })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new CanonicalHttpExecuteError("provider", redactText(secret, msg))
      }
      const toEmit = processPiece(textPiece, false)
      if (toEmit !== null) {
        try {
          await flushEmit(toEmit)
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") throw err
          if (err instanceof CanonicalHttpExecuteError) throw err
          const msg = err instanceof Error ? err.message : String(err)
          throw new CanonicalHttpExecuteError("provider", redactText(secret, msg))
        }
      }
    }
    // flush decoder remainder
    let finalPiece = ""
    try {
      finalPiece = decoder.decode()
    } catch {}
    const finalToEmit = processPiece(finalPiece, true)
    if (finalToEmit && finalToEmit.length > 0) {
      await flushEmit(finalToEmit)
    } else if (carry.length > 0) {
      // already flushed via processPiece true
    }
  } catch (err) {
    // Ensure reader cancelled on any non-success path
    try {
      await reader.cancel()
    } catch {}
    if (err instanceof DOMException && err.name === "AbortError") throw err
    if (signal.aborted) throw new DOMException("Aborted", "AbortError")
    if (err instanceof CanonicalHttpExecuteError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new CanonicalHttpExecuteError("provider", redactText(secret, msg))
  } finally {
    signal.removeEventListener("abort", abortHandler)
    try {
      reader.releaseLock()
    } catch {}
    // If we exited due to emit false (abort), ensure body cancelled
    if (signal.aborted) {
      try {
        response.body?.cancel()
      } catch {}
    }
  }

  return { seq, chunks, bytes: totalBytes }
}
