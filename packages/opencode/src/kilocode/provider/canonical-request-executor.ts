// kilocode_change - canonical-only RequestExecutor adapter over ProviderHttpExecuteBroker
/**
 * Canonical-only adapter that satisfies `@opencode-ai/llm` `RequestExecutor.Service`
 * for a single immutable canonical context. It consumes the typed
 * `ProviderHttpExecuteBroker.stream` and exposes an `HttpClientResponse`
 * whose body `ReadableStream` is incrementally pumped from the broker `Stream`.
 * The adapter owns a fresh `Scope` per request and binds closing that `Scope`
 * exactly once to the body stream's completion, cancel, or error. It never
 * wraps `broker.stream` in `Effect.scoped` before returning the response.
 *
 * Validation is deterministic and fail-closed:
 * - POST only, JSON text/Uint8Array body only, non-empty and valid JSON.
 * - Headers are normalized to `Record<string,string>`, duplicates/multi-values
 *   and all forbidden/sensitive names are rejected (except transport-owned
 *   `content-length`/`host` which are excluded). Comma-containing single
 *   values are allowed and forwarded; wire validation is authoritative.
 * - Request URL is validated against the captured `record`/`protocol` endpoint
 *   and fixed route; the caller URL is never sent to the host.
 * - Body is validated via `ProviderHttpExecuteWire` with the captured
 *   `providerId`/`modelId`/`record` (exact model, duplicate-key rules).
 *
 * HTTP status >=400 is consumed before exposing as SSE, mapped into the
 * existing `LLMError` taxonomy with retry-after/rate-limit semantics.
 */

import { Cause, Effect, Exit, Fiber, Layer, Random, Scope, Stream } from "effect"
import * as Option from "effect/Option"
import { HttpBody, HttpClientRequest, HttpClientResponse, UrlParams } from "effect/unstable/http"
import { RequestExecutor } from "@opencode-ai/llm/route"
import {
  AuthenticationReason,
  ContentPolicyReason,
  HttpContext,
  HttpRateLimitDetails,
  HttpRequestDetails,
  HttpResponseDetails,
  InvalidProviderOutputReason,
  InvalidRequestReason,
  LLMError,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  TransportReason,
  UnknownProviderReason,
} from "@opencode-ai/llm"
import * as Broker from "@/kilocode/server/provider-http-execute-broker"
import { ProviderHttpExecuteWire, isForbiddenHeaderName } from "@opencode-ai/core/kilocode/provider-http-execute"

export type Context = {
  readonly providerId: string
  readonly modelId: string
  readonly record: unknown
}

const BODY_LIMIT = 16_384
const REDACTED = "<redacted>"
const SENSITIVE_NAME_SOURCE =
  "authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|credential|signature|x-amz-signature"
const SENSITIVE_NAME = new RegExp(SENSITIVE_NAME_SOURCE, "i")
const SHORT_QUERY_NAME = /^(key|sig)$/i
const SENSITIVE_BODY_FIELD = new RegExp(`(?:${SENSITIVE_NAME_SOURCE}|key)`, "i")
const REDACT_JSON_FIELD = new RegExp(`("(?:${SENSITIVE_BODY_FIELD.source})"\\s*:\\s*)"[^"]*"`, "gi")
const REDACT_QUERY_FIELD = new RegExp(`((?:${SENSITIVE_BODY_FIELD.source})=)[^&\\s"]+`, "gi")

const deepClone = <T>(value: T): T => {
  const maybeClone = (globalThis as unknown as { structuredClone?: (v: T) => T }).structuredClone
  if (typeof maybeClone === "function") {
    try {
      return maybeClone(value)
    } catch {}
  }
  return JSON.parse(JSON.stringify(value)) as T
}

const deepFreeze = (value: unknown): unknown => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v)
  }
  return value
}

const invalid = (message: string): Effect.Effect<never, LLMError> =>
  Effect.fail(
    new LLMError({
      module: "CanonicalRequestExecutor",
      method: "execute",
      reason: new InvalidRequestReason({ message }),
    }),
  )

const extractBody = (request: HttpClientRequest.HttpClientRequest): Effect.Effect<string, LLMError> =>
  Effect.gen(function* () {
    const body = request.body as HttpBody.HttpBody & { readonly _tag: string; readonly body?: unknown }
    if (body._tag === "Empty") return yield* invalid("empty body")
    if (body._tag === "Uint8Array") {
      const arr = (body as unknown as { readonly body: Uint8Array }).body
      const text = new TextDecoder().decode(arr)
      if (text.length === 0) return yield* invalid("empty body")
      return text
    }
    if (body._tag === "Raw") {
      const raw = (body as unknown as { readonly body: unknown }).body
      if (typeof raw === "string") {
        if (raw.length === 0) return yield* invalid("empty body")
        return raw
      }
      if (raw instanceof Uint8Array) {
        const text = new TextDecoder().decode(raw)
        if (text.length === 0) return yield* invalid("empty body")
        return text
      }
      return yield* invalid("unsupported body form")
    }
    return yield* invalid("unsupported body form")
  })

const normalizeHeaders = (request: HttpClientRequest.HttpClientRequest): Effect.Effect<Record<string, string>, LLMError> =>
  Effect.gen(function* () {
    const out: Record<string, string> = {}
    const rec = request.headers as unknown as Record<string, string>
    const keys = Object.keys(rec)
    for (const key of keys) {
      const value = rec[key] as string
      if (typeof key !== "string" || typeof value !== "string") continue
      const lower = key.toLowerCase()
      if (key !== lower) return yield* invalid(`header name must be lowercase: ${key}`)
      if (lower === "content-length" || lower === "host") continue
      if (isForbiddenHeaderName(lower)) return yield* invalid(`forbidden header: ${lower}`)
      if (value.includes("\0") || /[\r\n]/.test(value) || /[\r\n]/.test(lower)) return yield* invalid(`invalid header: ${lower}`)
      if (lower.length === 0) return yield* invalid("invalid header name")
      out[lower] = value
    }
    return out
  })

const validateUrl = (request: HttpClientRequest.HttpClientRequest, record: unknown): Effect.Effect<void, LLMError> =>
  Effect.gen(function* () {
    const rec = record as Record<string, unknown>
    const endpoint = rec.endpoint
    const protocol = rec.protocol
    if (typeof endpoint !== "string" || typeof protocol !== "string") return yield* invalid("invalid canonical record")
    let endpointUrl: URL
    try {
      endpointUrl = new URL(endpoint)
    } catch {
      return yield* invalid("invalid canonical endpoint")
    }
    if (endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:") return yield* invalid("invalid endpoint protocol")
    if (endpointUrl.username || endpointUrl.password) return yield* invalid("endpoint userinfo not allowed")
    if (endpointUrl.search || endpointUrl.hash) return yield* invalid("endpoint query/hash not allowed")
    if (!ProviderHttpExecuteWire.isProtocol(protocol)) return yield* invalid("unknown protocol")
    const path = ProviderHttpExecuteWire.PATH_BY_PROTOCOL[protocol as keyof typeof ProviderHttpExecuteWire.PATH_BY_PROTOCOL] as
      | string
      | undefined
    if (!path) return yield* invalid("unknown protocol")
    const basePath = endpointUrl.pathname.replace(/\/+$/, "")
    const expectedPath = `${basePath}${path}`
    const expectedOrigin = endpointUrl.origin
    if (Option.isSome(request.hash)) return yield* invalid("hash not allowed")
    if ((request.urlParams as UrlParams.UrlParams).params.length > 0) return yield* invalid("query not allowed")
    const opt = HttpClientRequest.toUrl(request)
    if (Option.isNone(opt)) return yield* invalid("invalid request url")
    const url = opt.value
    if (url.protocol !== "http:" && url.protocol !== "https:") return yield* invalid("invalid request protocol")
    if (url.username || url.password) return yield* invalid("userinfo not allowed")
    if (url.search) return yield* invalid("query not allowed")
    if (url.hash) return yield* invalid("hash not allowed")
    if (url.origin !== expectedOrigin) return yield* invalid(`origin mismatch expected ${expectedOrigin} got ${url.origin}`)
    if (url.pathname !== expectedPath) return yield* invalid(`path mismatch expected ${expectedPath} got ${url.pathname}`)
  })

const mapBrokerError = (err: Broker.BrokerError): LLMError => {
  const module = "CanonicalRequestExecutor"
  const method = "execute"
  if (err._tag === "ProviderHttpUnavailable") {
    return new LLMError({
      module,
      method,
      reason: new TransportReason({ message: err.message, kind: "Unavailable" }),
    })
  }
  if (err._tag === "ProviderHttpUnsupported") {
    return new LLMError({
      module,
      method,
      reason: new TransportReason({ message: err.message, kind: "Unsupported" }),
    })
  }
  if (err._tag === "ProviderHttpFailure") {
    const code = (err as unknown as { readonly code: string }).code
    const message = (err as unknown as { readonly message: string }).message
    if (code === "missing-secret") {
      return new LLMError({
        module,
        method,
        reason: new AuthenticationReason({
          message,
          kind: "missing",
          providerMetadata: { canonical: { code } } as unknown as never,
        }),
      })
    }
    if (code === "aborted") {
      return new LLMError({
        module,
        method,
        reason: new TransportReason({ message, kind: "Aborted" }),
      })
    }
    if (code === "provider") {
      return new LLMError({
        module,
        method,
        reason: new ProviderInternalReason({
          message,
          status: 502,
          providerMetadata: { canonical: { code } } as unknown as never,
        }),
      })
    }
    if (
      code === "invalid-record" ||
      code === "invalid-endpoint" ||
      code === "unknown-protocol" ||
      code === "unknown-model" ||
      code === "missing-credential-ref" ||
      code === "invalid-credential-ref"
    ) {
      return new LLMError({
        module,
        method,
        reason: new InvalidRequestReason({ message, providerMetadata: { canonical: { code } } as unknown as never }),
      })
    }
    return new LLMError({
      module,
      method,
      reason: new UnknownProviderReason({
        message,
        status: 500,
        providerMetadata: { canonical: { code } } as unknown as never,
      }),
    })
  }
  const msg = (err as unknown as { readonly message: string }).message
  const cause = (err as unknown as { readonly cause?: unknown }).cause
  return new LLMError({
    module,
    method,
    reason: new InvalidProviderOutputReason({
      message: msg,
      route: "canonical",
      raw: cause !== undefined ? String(cause) : msg,
    }),
  })
}

// -- status mapping helpers (reuse executor conventions locally) --
const isSensitiveHeaderName = (name: string) => SENSITIVE_NAME.test(name)
const isSensitiveQueryName = (name: string) => isSensitiveHeaderName(name) || SHORT_QUERY_NAME.test(name)

const redactHeaders = (headers: Record<string, string>) => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) out[k] = isSensitiveHeaderName(k) ? REDACTED : String(v)
  return out
}

const redactUrl = (value: string) => {
  if (!URL.canParse(value)) return REDACTED
  const url = new URL(value)
  url.searchParams.forEach((_, key) => {
    if (isSensitiveQueryName(key)) url.searchParams.set(key, REDACTED)
  })
  return url.toString()
}

const normalizedHeaders = (headers: Record<string, string>) =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]))

const requestId = (headers: Record<string, string>) =>
  headers["x-request-id"] ??
  headers["request-id"] ??
  headers["x-amzn-requestid"] ??
  headers["x-amz-request-id"] ??
  headers["x-goog-request-id"] ??
  headers["cf-ray"]

const retryAfterMs = (headers: Record<string, string>) => {
  const millis = Number(headers["retry-after-ms"])
  if (Number.isFinite(millis)) return Math.max(0, millis)
  const value = headers["retry-after"]
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

const addRateLimitValue = (target: Record<string, string>, key: string, value: string) => {
  if (key.length > 0) target[key] = value
}
const rateLimitDetails = (headers: Record<string, string>, retryAfter: number | undefined) => {
  const limit: Record<string, string> = {}
  const remaining: Record<string, string> = {}
  const reset: Record<string, string> = {}
  Object.entries(headers).forEach(([name, value]) => {
    const openaiLimit = /^x-ratelimit-limit-(.+)$/.exec(name)?.[1]
    if (openaiLimit) return addRateLimitValue(limit, openaiLimit, value)
    const openaiRemaining = /^x-ratelimit-remaining-(.+)$/.exec(name)?.[1]
    if (openaiRemaining) return addRateLimitValue(remaining, openaiRemaining, value)
    const openaiReset = /^x-ratelimit-reset-(.+)$/.exec(name)?.[1]
    if (openaiReset) return addRateLimitValue(reset, openaiReset, value)
    const anthropic = /^anthropic-ratelimit-(.+)-(limit|remaining|reset)$/.exec(name)
    if (!anthropic) return
    if (anthropic[2] === "limit") return addRateLimitValue(limit, anthropic[1], value)
    if (anthropic[2] === "remaining") return addRateLimitValue(remaining, anthropic[1], value)
    return addRateLimitValue(reset, anthropic[1], value)
  })
  if (
    retryAfter === undefined &&
    Object.keys(limit).length === 0 &&
    Object.keys(remaining).length === 0 &&
    Object.keys(reset).length === 0
  )
    return undefined
  return new HttpRateLimitDetails({
    retryAfterMs: retryAfter,
    limit: Object.keys(limit).length === 0 ? undefined : limit,
    remaining: Object.keys(remaining).length === 0 ? undefined : remaining,
    reset: Object.keys(reset).length === 0 ? undefined : reset,
  })
}

const secretValues = (request: HttpClientRequest.HttpClientRequest) => {
  const values = new Set<string>()
  const add = (value: string) => {
    if (value.length < 4) return
    values.add(value)
    values.add(encodeURIComponent(value))
  }
  Object.entries(request.headers as Record<string, string>).forEach(([name, value]) => {
    if (!isSensitiveHeaderName(name)) return
    add(String(value))
    const bearer = /^Bearer\s+(.+)$/i.exec(String(value))?.[1]
    if (bearer) add(bearer)
  })
  const urlStr = (() => {
    const opt = HttpClientRequest.toUrl(request)
    return Option.isSome(opt) ? opt.value.toString() : undefined
  })()
  if (urlStr && URL.canParse(urlStr)) {
    new URL(urlStr).searchParams.forEach((value, key) => {
      if (isSensitiveQueryName(key)) add(value)
    })
  }
  return values
}

const redactBody = (body: string, request: HttpClientRequest.HttpClientRequest) =>
  Array.from(secretValues(request)).reduce(
    (text, secret) => text.split(secret).join(REDACTED),
    body.replace(REDACT_JSON_FIELD, `$1"${REDACTED}"`).replace(REDACT_QUERY_FIELD, `$1${REDACTED}`),
  )

const responseBody = (body: string | void, request: HttpClientRequest.HttpClientRequest) => {
  if (body === undefined) return {}
  const redacted = redactBody(body, request)
  if (redacted.length <= BODY_LIMIT) return { body: redacted }
  return { body: redacted.slice(0, BODY_LIMIT), bodyTruncated: true }
}

const providerMessage = (status: number, body: { readonly body?: string }) => {
  if (body.body && body.body.length <= 500) return `Provider request failed with HTTP ${status}: ${body.body}`
  return `Provider request failed with HTTP ${status}`
}

const requestDetails = (request: HttpClientRequest.HttpClientRequest) =>
  new HttpRequestDetails({
    method: request.method,
    url: redactUrl(
      Option.match(HttpClientRequest.toUrl(request), {
        onNone: () => String(request.url),
        onSome: (u) => u.toString(),
      }),
    ),
    headers: redactHeaders(normalizedHeaders(request.headers as unknown as Record<string, string>)),
  })

const responseDetails = (status: number, headers: Record<string, string>) =>
  new HttpResponseDetails({
    status,
    headers: redactHeaders(normalizedHeaders(headers)),
  })

const responseHttp = (input: {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: ReturnType<typeof responseBody>
  readonly rateLimit?: HttpRateLimitDetails | undefined
  readonly requestId?: string | undefined
}) =>
  new HttpContext({
    request: requestDetails(input.request),
    response: responseDetails(input.status, input.headers),
    ...input.body,
    requestId: input.requestId,
    rateLimit: input.rateLimit,
  })

const statusReason = (input: {
  readonly status: number
  readonly message: string
  readonly retryAfterMs?: number | undefined
  readonly rateLimit?: HttpRateLimitDetails | undefined
  readonly http: HttpContext
}) => {
  const body = input.http.body ?? ""
  if (/content[-_\s]?policy|content_filter|safety/i.test(body)) {
    return new ContentPolicyReason({ message: input.message, http: input.http })
  }
  if (input.status === 401) {
    return new AuthenticationReason({ message: input.message, kind: "invalid", http: input.http })
  }
  if (input.status === 403) {
    return new AuthenticationReason({ message: input.message, kind: "insufficient-permissions", http: input.http })
  }
  if (input.status === 429) {
    if (/insufficient[-_\s]?quota|quota[-_\s]?exceeded/i.test(body)) {
      return new QuotaExceededReason({ message: input.message, http: input.http })
    }
    return new RateLimitReason({
      message: input.message,
      retryAfterMs: input.retryAfterMs,
      rateLimit: input.rateLimit,
      http: input.http,
    })
  }
  if (input.status === 400 || input.status === 404 || input.status === 409 || input.status === 422) {
    return new InvalidRequestReason({ message: input.message, http: input.http })
  }
  if (input.status >= 500) {
    return new ProviderInternalReason({
      message: input.message,
      status: input.status,
      retryAfterMs: input.retryAfterMs,
      http: input.http,
    })
  }
  return new UnknownProviderReason({ message: input.message, status: input.status, http: input.http })
}

const makeStatusError = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  headers: Record<string, string>,
  bodyText: string,
): LLMError => {
  const normalized = normalizedHeaders(headers)
  const retryAfter = retryAfterMs(normalized)
  const rateLimit = rateLimitDetails(normalized, retryAfter)
  const details = responseBody(bodyText, request)
  const message = providerMessage(status, details)
  const http = responseHttp({
    request,
    status,
    headers: normalized,
    body: details,
    rateLimit,
    requestId: requestId(normalized),
  })
  return new LLMError({
    module: "CanonicalRequestExecutor",
    method: "execute",
    reason: statusReason({ status, message, retryAfterMs: retryAfter, rateLimit, http }),
  })
}

export type Options = {
  readonly timeoutMs?: number
}

const normalizeTimeoutMs = (opts?: Options | number): number | undefined => {
  const raw = typeof opts === "number" ? opts : opts?.timeoutMs
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined
  return raw
}

const MAX_RETRIES = 2
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 10_000

const retryDelay = (error: LLMError, attempt: number) => {
  if (error.retryAfterMs !== undefined) return Effect.succeed(Math.min(error.retryAfterMs, MAX_DELAY_MS))
  return Random.nextBetween(
    Math.min(BASE_DELAY_MS * 2 ** attempt * 0.8, MAX_DELAY_MS),
    Math.min(BASE_DELAY_MS * 2 ** attempt * 1.2, MAX_DELAY_MS),
  ).pipe(Effect.map((delay) => Math.round(delay)))
}

const idleTimeoutError = (timeoutMs: number): LLMError =>
  new LLMError({
    module: "CanonicalRequestExecutor",
    method: "execute",
    reason: new TransportReason({ message: `Provider response timed out after ${timeoutMs}ms without data`, kind: "Timeout" }),
  })

export const make = (ctx: Context, broker: Broker.Broker, opts?: Options | number): RequestExecutor.Interface => {
  const providerId = ctx.providerId
  const modelId = ctx.modelId
  const record = deepFreeze(deepClone(ctx.record)) as unknown
  const timeoutMs = normalizeTimeoutMs(opts)

  const singleAttempt = (
    request: HttpClientRequest.HttpClientRequest,
    bodyText: string,
    headers: Record<string, string>,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, LLMError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        let pump: Fiber.Fiber<void, unknown> | undefined
        let watch: Fiber.Fiber<void, unknown> | undefined
        let closed = false
        let closePromise: Promise<void> | undefined

        const doClose = (): Promise<void> => {
          if (closed) return closePromise!
          closed = true
          closePromise = Effect.runPromise(
            Effect.gen(function* () {
              // Closing the child scope interrupts pump/watch fibers when they
              // are scoped to it (forkIn). Keep manual interrupt as fallback.
              if (pump) {
                yield* Fiber.interrupt(pump).pipe(Effect.ignore)
                yield* Fiber.await(pump).pipe(Effect.ignore)
              }
              if (watch) {
                yield* Fiber.interrupt(watch).pipe(Effect.ignore)
                yield* Fiber.await(watch).pipe(Effect.ignore)
              }
              yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
            }),
          )
          return closePromise
        }

        // Link child scope lifetime to outer Stream consumption scope so
        // interruption/closing of outer LLM Stream closes broker scope even
        // when no further ReadableStream pull/cancel occurs (no pull/cancel
        // yet). No second Abort protocol — the existing broker Scope owns Call
        // drop → $/cancelRequest. Only link when an ambient Scope is present
        // (Stream.scoped execution); direct `execute` calls outside a Stream
        // have no ambient scope and must not fail.
        const ambientOpt = yield* Effect.serviceOption(Scope.Scope)
        if (Option.isSome(ambientOpt)) {
          yield* Scope.addFinalizer(ambientOpt.value, Scope.close(scope, Exit.void).pipe(Effect.ignore))
        }

        const acquireExit = yield* Effect.exit(
          restore(
            broker
              .stream({
                providerId,
                modelId,
                record,
                body: bodyText,
                ...(Object.keys(headers).length > 0 ? { headers } : {}),
              })
              .pipe(Effect.provideService(Scope.Scope, scope)),
          ),
        )

        if (Exit.isFailure(acquireExit)) {
          const cause = (acquireExit as Exit.Failure<unknown, Broker.BrokerError>).cause
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
          if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause as unknown as Cause.Cause<LLMError>)
          const failureOpt = Cause.findErrorOption(cause)
          if (Option.isSome(failureOpt)) {
            return yield* Effect.fail(mapBrokerError(failureOpt.value as Broker.BrokerError))
          }
          return yield* Effect.failCause(cause as unknown as Cause.Cause<LLMError>)
        }

        const httpStream = (acquireExit as Exit.Success<Broker.HttpStream>).value

        if (httpStream.status >= 400) {
          const bodyExit = yield* Effect.exit(
            restore(
              Effect.gen(function* () {
                const collected = yield* httpStream.stream.pipe(Stream.runCollect)
                let total = 0
                for (const c of collected as Iterable<Uint8Array>) total += c.length
                const out = new Uint8Array(total)
                let off = 0
                for (const c of collected as Iterable<Uint8Array>) {
                  out.set(c, off)
                  off += c.length
                }
                return new TextDecoder().decode(out)
              }),
            ),
          )
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
          if (Exit.isFailure(bodyExit) && Cause.hasInterruptsOnly((bodyExit as Exit.Failure<unknown, unknown>).cause)) {
            return yield* Effect.failCause((bodyExit as unknown as Exit.Failure<unknown, LLMError>).cause as Cause.Cause<LLMError>)
          }
          const bodyTextVal = Exit.isSuccess(bodyExit) ? (bodyExit as Exit.Success<string>).value : ""
          const llmErr = makeStatusError(request, httpStream.status, httpStream.headers, bodyTextVal)
          return yield* Effect.fail(llmErr)
        }

        // Success path: demand-safe bridge. Idle timer (when configured)
        // watches broker BYTE arrival into the adapter, not ReadableStream
        // pull timing, so buffered-but-unconsumed chunks shield a slow
        // consumer from false timeouts.
        const buffer: Uint8Array[] = []
        const pending: Array<() => void> = []
        let done = false
        let pumpError: unknown | undefined
        let cancelled = false
        const controllerRef: { current?: ReadableStreamDefaultController<Uint8Array> } = {}
        const arrivals = { count: 0, seen: 0 }

        const tryDeliver = () => {
          if (cancelled) return
          while (pending.length > 0 && buffer.length > 0) {
            const chunk = buffer.shift()!
            const resolve = pending.shift()!
            if (controllerRef.current) {
              try {
                controllerRef.current.enqueue(chunk)
              } catch {}
            }
            resolve()
          }
          if (pending.length > 0) {
            if (pumpError !== undefined) {
              if (controllerRef.current) {
                try {
                  controllerRef.current.error(pumpError)
                } catch {}
              }
              const toResolve = pending.splice(0)
              for (const r of toResolve) r()
              void doClose()
              return
            }
            if (done && buffer.length === 0) {
              if (controllerRef.current) {
                try {
                  controllerRef.current.close()
                } catch {}
              }
              const toResolve = pending.splice(0)
              for (const r of toResolve) r()
              void doClose()
              return
            }
          }
        }

        pump = yield* Effect.forkIn(scope)(
          Effect.gen(function* () {
            yield* httpStream.stream.pipe(
              Stream.runForEach((chunk: Uint8Array) =>
                Effect.sync(() => {
                  if (cancelled) return
                  arrivals.count += 1
                  buffer.push(chunk)
                  tryDeliver()
                }),
              ),
            )
            done = true
            tryDeliver()
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                if (Cause.hasInterruptsOnly(cause)) {
                  done = true
                } else {
                  pumpError = Cause.squash(cause)
                }
                tryDeliver()
              }),
            ),
          ),
        )

        if (timeoutMs !== undefined) {
          const activeMs = timeoutMs
          watch = yield* Effect.forkIn(scope)(
            Effect.gen(function* () {
              while (true) {
                yield* Effect.sleep(activeMs)
                const action = yield* Effect.sync(() => {
                  if (cancelled || done || pumpError !== undefined) return "exit" as const
                  if (buffer.length > 0) {
                    arrivals.seen = arrivals.count
                    return "continue" as const
                  }
                  if (arrivals.count !== arrivals.seen) {
                    arrivals.seen = arrivals.count
                    return "continue" as const
                  }
                  return "timeout" as const
                })
                if (action === "exit") return
                if (action === "continue") continue
                const timedOut = yield* Effect.sync(() => {
                  if (cancelled || done || pumpError !== undefined) return false
                  if (buffer.length > 0) {
                    arrivals.seen = arrivals.count
                    return false
                  }
                  if (arrivals.count !== arrivals.seen) {
                    arrivals.seen = arrivals.count
                    return false
                  }
                  pumpError = idleTimeoutError(activeMs)
                  if (controllerRef.current) {
                    try {
                      controllerRef.current.error(pumpError)
                    } catch {}
                  }
                  const toResolve = pending.splice(0)
                  for (const r of toResolve) r()
                  return true
                })
                if (timedOut) {
                  yield* Effect.sync(() => {
                    void doClose()
                  })
                  return
                }
              }
            }),
          )
        }

        const readable = new ReadableStream<Uint8Array>({
          start(controller) {
            controllerRef.current = controller
            // If pump already completed synchronously, deliver
            tryDeliver()
          },
          pull() {
            if (cancelled) return Promise.resolve()
            if (buffer.length > 0) {
              const chunk = buffer.shift()!
              try {
                controllerRef.current!.enqueue(chunk)
              } catch {}
              if (pumpError !== undefined && buffer.length === 0) {
                try {
                  controllerRef.current!.error(pumpError)
                } catch {}
                void doClose()
              } else if (done && buffer.length === 0 && pumpError === undefined) {
                // Close will be handled on next pull or immediately if no pending; we can close after delivering last chunk
                // To avoid waiting for extra pull, check if done and empty: close now
                // But ensure pending empty
                if (pending.length === 0) {
                  try {
                    controllerRef.current!.close()
                  } catch {}
                  void doClose()
                }
              }
              return Promise.resolve()
            }
            if (pumpError !== undefined) {
              try {
                controllerRef.current!.error(pumpError)
              } catch {}
              void doClose()
              return Promise.resolve()
            }
            if (done) {
              try {
                controllerRef.current!.close()
              } catch {}
              void doClose()
              return Promise.resolve()
            }
            return new Promise<void>((resolve) => {
              pending.push(resolve)
            })
          },
          cancel() {
            cancelled = true
            while (pending.length > 0) {
              const r = pending.shift()!
              r()
            }
            return doClose()
          },
        })

        const response = new Response(readable as unknown as ReadableStream, {
          status: httpStream.status,
          headers: httpStream.headers as unknown as HeadersInit,
        })
        return HttpClientResponse.fromWeb(request, response)
      }),
    )

  const execute: RequestExecutor.Interface["execute"] = (request) =>
    Effect.gen(function* () {
      if (request.method !== "POST") return yield* invalid(`method must be POST, got ${request.method}`)
      const bodyText = yield* extractBody(request)
      const headers = yield* normalizeHeaders(request)
      yield* validateUrl(request, record)
      try {
        ProviderHttpExecuteWire.validateRequest({
          providerId,
          modelId,
          record,
          body: bodyText,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        } as unknown as Record<string, unknown>)
      } catch (e) {
        return yield* invalid(e instanceof Error ? e.message : String(e))
      }

      // Pre-exposure retry only: broker start failures mapped to retryable
      // LLMError and HTTP >=400 status failures. Never retry after a 2xx
      // response is exposed — success bytes may have been consumed. Each
      // failed attempt closes its own Scope/call before delay/next attempt.
      let attempt = 0
      while (true) {
        const exit = yield* Effect.exit(singleAttempt(request, bodyText, headers))
        if (Exit.isSuccess(exit)) return (exit as Exit.Success<HttpClientResponse.HttpClientResponse>).value
        const cause = (exit as Exit.Failure<unknown, LLMError>).cause
        if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause)
        const errOpt = Cause.findErrorOption(cause)
        if (Option.isNone(errOpt) || !(errOpt.value instanceof LLMError)) return yield* Effect.failCause(cause)
        const err = errOpt.value as LLMError
        if (!err.retryable || attempt >= MAX_RETRIES) return yield* Effect.fail(err)
        const delay = yield* retryDelay(err, attempt)
        if (delay > 0) {
          const sleepExit = yield* Effect.exit(Effect.sleep(delay))
          if (Exit.isFailure(sleepExit)) return yield* Effect.failCause((sleepExit as Exit.Failure<unknown, LLMError>).cause)
        } else {
          yield* Effect.yieldNow
        }
        attempt += 1
      }
    }) as unknown as Effect.Effect<HttpClientResponse.HttpClientResponse, LLMError>

  return { execute }
}

export const layer = (ctx: Context, opts?: Options | number): Layer.Layer<RequestExecutor.Service, never, Broker.Service> =>
  Layer.effect(
    RequestExecutor.Service,
    Effect.gen(function* () {
      const broker = yield* Broker.Service
      const frozenCtx: Context = {
        providerId: ctx.providerId,
        modelId: ctx.modelId,
        record: deepFreeze(deepClone(ctx.record)) as unknown,
      }
      return RequestExecutor.Service.of(make(frozenCtx, broker, opts))
    }),
  )
