// kilocode_change - shared provider/httpExecute wire primitives
/**
 * Genuinely shared cross-process contract for the reverse capability
 * `provider/httpExecute`. Single source of truth for method, capability,
 * request/response event shapes, size bounds, and validators.
 *
 * CLI owns messages/tools/protocol parsing; host is only the secret-bearing
 * HTTP executor. Plaintext secrets never leave host.
 *
 * Both packages/opencode (CLI broker) and packages/kilo-vscode (host handler)
 * import from `@opencode-ai/core/kilocode/provider-http-execute`.
 */

import { isProviderExecuteProtocol, PROVIDER_EXECUTE_PATH_BY_PROTOCOL, type ProviderExecuteProtocol } from "./provider-execute"

export const PROVIDER_HTTP_EXECUTE_METHOD = "provider/httpExecute" as const
export const PROVIDER_HTTP_EXECUTE_CAPABILITY = PROVIDER_HTTP_EXECUTE_METHOD

export const PROVIDER_HTTP_PROTOCOLS = ["openai/completions", "openai/responses", "anthropic/messages"] as const
export type ProviderHttpProtocol = ProviderExecuteProtocol

export const HTTP_BODY_MAX_BYTES = 4 * 1024 * 1024
export const HTTP_HEADER_MAX_COUNT = 32
export const HTTP_HEADER_NAME_MAX = 128
export const HTTP_HEADER_VALUE_MAX = 4096
export const HTTP_HEADERS_MAX_BYTES = 8192
export const HTTP_CHUNK_MAX_BYTES = 64 * 1024
export const HTTP_TOTAL_MAX_BYTES = 16 * 1024 * 1024
export const HTTP_MAX_CHUNKS = 8192

export interface ProviderHttpExecuteRequest {
  readonly providerId: string
  readonly modelId: string
  readonly record: unknown
  readonly body: string
  readonly headers?: Record<string, string>
}

export interface ProviderHttpExecuteMetadataEvent {
  readonly seq: 0
  readonly status: number
  readonly headers: Record<string, string>
}

export interface ProviderHttpExecuteChunkEvent {
  readonly seq: number
  readonly bytes: string
}

export type ProviderHttpExecuteEvent = ProviderHttpExecuteMetadataEvent | ProviderHttpExecuteChunkEvent

export interface ProviderHttpExecuteResult {
  readonly seq: number
  readonly chunks: number
  readonly bytes: number
}

const ALLOWED_REQUEST_KEYS = new Set(["providerId", "modelId", "record", "body", "headers"])

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

const FORBIDDEN_EXACT = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "www-authenticate",
  "signature",
  "x-signature",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "expect",
  "upgrade",
  "forwarded",
  "via",
])

const FORBIDDEN_SUBSTRINGS = ["api-key", "apikey", "cookie", "proxy", "signature", "authorization"]

export function isForbiddenHeaderName(lower: string): boolean {
  if (FORBIDDEN_EXACT.has(lower)) return true
  for (const sub of FORBIDDEN_SUBSTRINGS) if (lower.includes(sub)) return true
  if (lower.includes("auth") && lower !== "authorization") {
    return true
  }
  if (lower.includes("forwarded")) return true
  return false
}

const HEADER_NAME_RE = /^[a-z0-9-]+$/

function validateHeaders(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new Error("Invalid params: headers must be object")
  const keys = Object.keys(raw)
  if (keys.length > HTTP_HEADER_MAX_COUNT) throw new Error("Invalid params: too many headers")
  let total = 0
  const out: Record<string, string> = {}
  for (const k of keys) {
    if (typeof k !== "string" || k.length === 0 || k.length > HTTP_HEADER_NAME_MAX) throw new Error(`Invalid params: header name invalid ${k}`)
    const lower = k.toLowerCase()
    if (lower !== k) throw new Error(`Invalid params: header name must be lowercase ${k}`)
    if (!HEADER_NAME_RE.test(lower)) throw new Error(`Invalid params: header name invalid ${k}`)
    if (isForbiddenHeaderName(lower)) throw new Error(`Invalid params: forbidden header ${k}`)
    const v = (raw as Record<string, unknown>)[k]
    if (typeof v !== "string") throw new Error(`Invalid params: header value must be string ${k}`)
    if (v.length > HTTP_HEADER_VALUE_MAX) throw new Error(`Invalid params: header value too long ${k}`)
    if (v.includes("\0") || /[\r\n]/.test(v)) throw new Error(`Invalid params: header value invalid ${k}`)
    total += k.length + v.length
    if (total > HTTP_HEADERS_MAX_BYTES) throw new Error("Invalid params: headers too large")
    out[lower] = v
  }
  return out
}

/**
 * Bounded duplicate top-level "model" key scanner.
 * Counts occurrences of the key "model" at depth 1 (direct children of the top-level object).
 * Handles escaped strings, nested objects, and string values containing "model".
 * Returns true if more than one top-level model key is found.
 */
export function hasDuplicateTopLevelModelKey(body: string): boolean {
  let depth = 0
  let inString = false
  let escape = false
  let count = 0
  // we track whether we are inside string and need to capture it
  let stringStart = -1
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === "\\") {
        escape = true
        continue
      }
      if (ch === '"') {
        inString = false
        // decode the string content between stringStart and i
        // Use JSON.parse on the slice to correctly handle escapes
        let decoded: string
        try {
          decoded = JSON.parse(body.slice(stringStart - 1, i + 1)) as string
        } catch {
          // malformed json string, treat as not model
          continue
        }
        // check if this string is a key at depth 1
        // need to peek next non-whitespace char after the closing quote
        let j = i + 1
        while (j < body.length) {
          const c = body[j]!
          if (c === " " || c === "\t" || c === "\n" || c === "\r") j++
          else break
        }
        if (j < body.length && body[j] === ":" && depth === 1 && decoded === "model") {
          count++
          if (count > 1) return true
        }
        continue
      }
      continue
    }
    // not in string
    if (ch === '"') {
      inString = true
      escape = false
      stringStart = i + 1
      continue
    }
    if (ch === "{") {
      depth++
      continue
    }
    if (ch === "}") {
      depth--
      if (depth < 0) depth = 0
      continue
    }
    if (ch === "[") {
      depth++
      continue
    }
    if (ch === "]") {
      depth--
      if (depth < 0) depth = 0
      continue
    }
  }
  return false
}

export function validateProviderHttpExecuteRequest(raw: unknown): ProviderHttpExecuteRequest {
  if (!isRecord(raw)) throw new Error("Invalid params: request must be object")
  for (const key of Object.keys(raw)) if (!ALLOWED_REQUEST_KEYS.has(key)) throw new Error(`Invalid params: unexpected field ${key}`)
  const providerId = (raw as Record<string, unknown>).providerId
  const modelId = (raw as Record<string, unknown>).modelId
  const record = (raw as Record<string, unknown>).record
  const body = (raw as Record<string, unknown>).body
  const headersRaw = (raw as Record<string, unknown>).headers
  if (typeof providerId !== "string" || providerId.length === 0) throw new Error("Invalid params: providerId must be non-empty string")
  if (providerId.includes("\0")) throw new Error("Invalid params: providerId invalid")
  if (typeof modelId !== "string" || modelId.length === 0) throw new Error("Invalid params: modelId must be non-empty string")
  if (modelId.includes("\0")) throw new Error("Invalid params: modelId invalid")
  if (!isRecord(record)) throw new Error("Invalid params: record must be object")
  if (!isPlainObject(raw as Record<string, unknown>) || !isPlainObject(record as Record<string, unknown>)) throw new Error("Invalid params: record invalid")
  if (typeof body !== "string") throw new Error("Invalid params: body must be string")
  if (body.length === 0) throw new Error("Invalid params: body must be non-empty string")
  const bodyBytes = Buffer.byteLength(body, "utf8")
  if (bodyBytes > HTTP_BODY_MAX_BYTES) throw new Error("Invalid params: body too large")
  if (hasDuplicateTopLevelModelKey(body)) throw new Error("Invalid params: duplicate top-level model key")
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error("Invalid params: body must be valid JSON")
  }
  if (!isRecord(parsed)) throw new Error("Invalid params: body JSON must be object")
  const modelField = (parsed as Record<string, unknown>).model
  if (typeof modelField !== "string" || modelField !== modelId) throw new Error("Invalid params: body.model must equal modelId")
  const headers = validateHeaders(headersRaw)
  return { providerId, modelId, record, body, ...(headers !== undefined ? { headers } : {}) }
}

export function validateMetadataEvent(raw: unknown): ProviderHttpExecuteMetadataEvent {
  if (!isRecord(raw)) throw new Error("Invalid event: metadata must be object")
  const rec = raw as Record<string, unknown>
  if (rec.seq !== 0) throw new Error("Invalid event: metadata seq must be 0")
  if (typeof rec.status !== "number" || !Number.isInteger(rec.status) || rec.status < 100 || rec.status > 599) throw new Error("Invalid event: status invalid")
  const headers = rec.headers
  if (!isRecord(headers)) throw new Error("Invalid event: headers must be object")
  const keys = Object.keys(headers)
  if (keys.length > HTTP_HEADER_MAX_COUNT) throw new Error("Invalid event: too many headers")
  let total = 0
  for (const k of keys) {
    if (typeof k !== "string" || k.length === 0) throw new Error("Invalid event: header name invalid")
    const lower = k.toLowerCase()
    if (lower !== k) throw new Error("Invalid event: header name must be lowercase")
    if (!HEADER_NAME_RE.test(lower)) throw new Error("Invalid event: header name invalid")
    if (isForbiddenHeaderName(lower)) throw new Error("Invalid event: forbidden header in response")
    const v = (headers as Record<string, unknown>)[k]
    if (typeof v !== "string") throw new Error("Invalid event: header value must be string")
    if (v.length > HTTP_HEADER_VALUE_MAX) throw new Error("Invalid event: header value too long")
    if (v.includes("\0") || /[\r\n]/.test(v)) throw new Error("Invalid event: header value invalid")
    total += k.length + v.length
    if (total > HTTP_HEADERS_MAX_BYTES) throw new Error("Invalid event: headers too large")
  }
  const allowedKeys = new Set(["seq", "status", "headers"])
  for (const k of Object.keys(rec)) if (!allowedKeys.has(k)) throw new Error(`Invalid event: unexpected field ${k}`)
  return { seq: 0, status: rec.status as number, headers: headers as Record<string, string> }
}

export function validateChunkEvent(raw: unknown): ProviderHttpExecuteChunkEvent {
  if (!isRecord(raw)) throw new Error("Invalid event: chunk must be object")
  const rec = raw as Record<string, unknown>
  if (typeof rec.seq !== "number" || !Number.isInteger(rec.seq) || rec.seq <= 0 || rec.seq > HTTP_MAX_CHUNKS) throw new Error("Invalid event: seq invalid")
  if (typeof rec.bytes !== "string") throw new Error("Invalid event: bytes must be string")
  const b64 = rec.bytes as string
  if (b64.length > HTTP_CHUNK_MAX_BYTES * 1.4 + 4) throw new Error("Invalid event: chunk too large")
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) throw new Error("Invalid event: bytes not valid base64")
  const decoded = Buffer.from(b64, "base64")
  if (decoded.length > HTTP_CHUNK_MAX_BYTES) throw new Error("Invalid event: chunk bytes too large")
  const allowedKeys = new Set(["seq", "bytes"])
  for (const k of Object.keys(rec)) if (!allowedKeys.has(k)) throw new Error(`Invalid event: unexpected field ${k}`)
  return { seq: rec.seq as number, bytes: b64 }
}

export function validateProviderHttpExecuteResult(raw: unknown): ProviderHttpExecuteResult {
  if (!isRecord(raw)) throw new Error("Invalid result: must be object")
  const rec = raw as Record<string, unknown>
  const allowed = new Set(["seq", "chunks", "bytes"])
  for (const k of Object.keys(rec)) if (!allowed.has(k)) throw new Error(`Invalid result: unexpected field ${k}`)
  const seq = rec.seq
  const chunks = rec.chunks
  const bytes = rec.bytes
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > HTTP_MAX_CHUNKS) throw new Error("Invalid result: seq invalid")
  if (typeof chunks !== "number" || !Number.isInteger(chunks) || chunks < 0 || chunks > HTTP_MAX_CHUNKS) throw new Error("Invalid result: chunks invalid")
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0 || bytes > HTTP_TOTAL_MAX_BYTES) throw new Error("Invalid result: bytes invalid")
  if (seq !== chunks) throw new Error("Invalid result: seq must equal chunks when chunks >0 or 0")
  if (chunks === 0 && seq !== 0) throw new Error("Invalid result: seq must be 0 when no chunks")
  if (chunks > 0 && seq !== chunks) throw new Error("Invalid result: seq must equal chunks")
  return { seq, chunks, bytes }
}

export function isProviderHttpExecuteMethod(v: unknown): boolean {
  return v === PROVIDER_HTTP_EXECUTE_METHOD
}

export const ProviderHttpExecuteWire = {
  METHOD: PROVIDER_HTTP_EXECUTE_METHOD,
  CAPABILITY: PROVIDER_HTTP_EXECUTE_CAPABILITY,
  PATH_BY_PROTOCOL: PROVIDER_EXECUTE_PATH_BY_PROTOCOL,
  isProtocol: isProviderExecuteProtocol,
  validateRequest: validateProviderHttpExecuteRequest,
  validateMetadata: validateMetadataEvent,
  validateChunk: validateChunkEvent,
  validateResult: validateProviderHttpExecuteResult,
  LIMITS: {
    BODY_MAX: HTTP_BODY_MAX_BYTES,
    CHUNK_MAX: HTTP_CHUNK_MAX_BYTES,
    TOTAL_MAX: HTTP_TOTAL_MAX_BYTES,
    MAX_CHUNKS: HTTP_MAX_CHUNKS,
  },
}
