import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { NamedError } from "@opencode-ai/core/util/error"
import { APICallError } from "ai"
import { setTimeout as sleep } from "node:timers/promises"
import { Clock, Duration, Effect, Exit, Layer, Schedule, Schema } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderError } from "../../src/provider/error"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { it as bareIt, testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"

const providerID = ProviderV2.ID.make("test")
const retryProvider = "test"
const it = testEffect(Layer.mergeAll(SessionStatus.defaultLayer, CrossSpawnSpawner.defaultLayer))

function apiError(headers?: Record<string, string>): SessionV1.APIError {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message: "boom",
      isRetryable: true,
      responseHeaders: headers,
    }).toObject(),
  )
}

function wrap(message: unknown): ReturnType<NamedError["toObject"]> {
  return { name: "", data: { message } }
}

describe("session.retry.delay", () => {
  test("caps delay at 30 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("caps delay at 30 seconds when headers present but no usable retry-after", () => {
    const error = apiError({ "content-type": "application/json" })
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("caps later attempts at 30 seconds when retry-after is unparseable", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(700000)
  })

  test("caps oversized header delays to the runtime timer limit", () => {
    const error = apiError({ "retry-after-ms": "999999999999" })
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_MAX_DELAY)
  })

  it.instance("policy updates retry status and increments attempts", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("session-retry-test")
      const error = apiError({ "retry-after-ms": "0" })
      const status = yield* SessionStatus.Service

      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: (info) =>
            status.set(sessionID, {
              type: "retry",
              attempt: info.attempt,
              message: info.message,
              next: info.next,
            }),
        }),
      )
      yield* step(error)
      yield* step(error)

      expect(yield* status.get(sessionID)).toMatchObject({
        type: "retry",
        attempt: 2,
        message: "boom",
      })
    }),
  )
})

// kilocode_change start
describe("session.retry.policy offline", () => {
  const disconnected = () => new Error("fetch failed")
  const parseDisconnected = (e: unknown) => MessageV2.fromError(e, { providerID })

  type StatusCall = { attempt: number; message: string; next: number }

  function retryOut(exit: Exit.Exit<unknown, unknown>): [number, Duration.Duration] | undefined {
    if (Exit.isSuccess(exit)) {
      return Array.isArray(exit.value) ? (exit.value as [number, Duration.Duration]) : undefined
    }
    return undefined
  }

  function retry(exit: Exit.Exit<unknown, unknown>): [number, Duration.Duration] {
    const out = retryOut(exit)
    if (!out) throw new Error("expected a retry step, got a done step")
    return out
  }

  function policy(opts: {
    offline: (info: { error: unknown; message: string }) => Effect.Effect<"retry" | "blocked" | "aborted">
    set?: (info: StatusCall) => Effect.Effect<void>
    limit?: number
  }) {
    const calls: StatusCall[] = []
    const order: string[] = []
    const schedule = SessionRetry.policy({
      provider: retryProvider,
      parse: parseDisconnected,
      set: (info) => {
        calls.push(info)
        order.push(`set:${info.attempt}`)
        return opts.set ? opts.set(info) : Effect.void
      },
      offline: (info) => {
        order.push(`offline:${info.message}`)
        return opts.offline(info)
      },
      limit: opts.limit,
    })
    return { schedule, calls, order }
  }

  bareIt.effect("invokes the offline handler before scheduling status and retries with backoff", () =>
    Effect.gen(function* () {
      const p = policy({ offline: () => Effect.succeed("retry") })
      const step = yield* Schedule.toStep(p.schedule)

      const before = yield* Clock.currentTimeMillis
      const [attempt, wait] = retry(yield* step(0, disconnected()).pipe(Effect.exit))

      expect(attempt).toBe(1)
      expect(Duration.toMillis(wait)).toBe(2000)
      expect(p.calls).toEqual([{ attempt: 1, message: "Network request failed", next: before + 2000 }])
      expect(p.order).toEqual(["offline:Network request failed", "set:1"])
    }),
  )

  bareIt.effect("repeats disconnected retries with increasing capped backoff and attempts", () =>
    Effect.gen(function* () {
      const p = policy({ offline: () => Effect.succeed("retry") })
      const step = yield* Schedule.toStep(p.schedule)

      const out: Array<[number, number]> = []
      for (const index of Array.from({ length: 5 }, (_, index) => index)) {
        const [attempt, wait] = retry(yield* step(0, disconnected()).pipe(Effect.exit))
        out.push([attempt, Duration.toMillis(wait)])
      }

      expect(out).toEqual([
        [1, 2000],
        [2, 4000],
        [3, 8000],
        [4, 16000],
        [5, 30000],
      ])
      expect(p.calls.map((c) => c.attempt)).toEqual([1, 2, 3, 4, 5])
      expect(p.calls.every((c) => c.attempt > 0)).toBe(true)
      expect(p.calls.every((c) => c.message !== "Reconnected")).toBe(true)
    }),
  )

  bareIt.effect("does not reset the attempt counter when a non-disconnected retry follows", () =>
    Effect.gen(function* () {
      const p = policy({ offline: () => Effect.succeed("retry") })
      const step = yield* Schedule.toStep(p.schedule)

      yield* step(0, disconnected()).pipe(Effect.exit)
      const [attempt, wait] = retry(yield* step(0, new ProviderError.HeaderTimeoutError(10000)).pipe(Effect.exit))

      expect(attempt).toBe(2)
      expect(Duration.toMillis(wait)).toBe(4000)
      expect(p.calls.map((c) => c.attempt)).toEqual([1, 2])
      expect(p.order).toEqual(["offline:Network request failed", "set:1", "set:2"])
    }),
  )

  bareIt.effect("stops immediately when the offline handler returns blocked", () =>
    Effect.gen(function* () {
      const p = policy({ offline: () => Effect.succeed("blocked") })
      const step = yield* Schedule.toStep(p.schedule)

      const exit = yield* step(0, disconnected()).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(retryOut(exit)).toBeUndefined()
      expect(p.order).toEqual(["offline:Network request failed"])
      expect(p.calls).toEqual([])
    }),
  )

  bareIt.effect("stops immediately when the offline handler returns aborted", () =>
    Effect.gen(function* () {
      const p = policy({ offline: () => Effect.succeed("aborted") })
      const step = yield* Schedule.toStep(p.schedule)

      const exit = yield* step(0, disconnected()).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(retryOut(exit)).toBeUndefined()
      expect(p.order).toEqual(["offline:Network request failed"])
      expect(p.calls).toEqual([])
    }),
  )

  bareIt.effect("enforces the configured retry limit for disconnected retries", () =>
    Effect.gen(function* () {
      const p = policy({ offline: () => Effect.succeed("retry"), limit: 2 })
      const step = yield* Schedule.toStep(p.schedule)

      const [a1, w1] = retry(yield* step(0, disconnected()).pipe(Effect.exit))
      const [a2, w2] = retry(yield* step(0, disconnected()).pipe(Effect.exit))
      const exit = yield* step(0, disconnected()).pipe(Effect.exit)

      expect(a1).toBe(1)
      expect(a2).toBe(2)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(retryOut(exit)).toBeUndefined()
      expect(p.calls.map((c) => c.attempt)).toEqual([1, 2])
      expect(p.order).toEqual(["offline:Network request failed", "set:1", "offline:Network request failed", "set:2"])
      expect(p.order.filter((o) => o.startsWith("offline:"))).toHaveLength(2)
    }),
  )

  bareIt.effect("honors retry-after headers when a disconnected error carries them", () =>
    Effect.gen(function* () {
      const input = new SessionV1.APIError({
        message: "fetch failed",
        isRetryable: true,
        responseHeaders: { "retry-after-ms": "1500" },
      })
      const calls: StatusCall[] = []
      const schedule = SessionRetry.policy({
        provider: retryProvider,
        parse: (e) => e as SessionV1.APIError,
        set: (info) => {
          calls.push(info)
          return Effect.void
        },
        offline: () => Effect.succeed("retry"),
      })
      const step = yield* Schedule.toStep(schedule)

      const before = yield* Clock.currentTimeMillis
      const [attempt, wait] = retry(yield* step(0, input).pipe(Effect.exit))

      expect(attempt).toBe(1)
      expect(Duration.toMillis(wait)).toBe(1500)
      expect(calls).toEqual([{ attempt: 1, message: "fetch failed", next: before + 1500 }])
    }),
  )

  bareIt.effect("passes the original disconnected error and message to the offline handler", () =>
    Effect.gen(function* () {
      const err = disconnected()
      const seen: Array<{ error: unknown; message: string }> = []
      const schedule = SessionRetry.policy({
        provider: retryProvider,
        parse: parseDisconnected,
        set: () => Effect.void,
        offline: (info) => {
          seen.push(info)
          return Effect.succeed("blocked")
        },
      })
      const step = yield* Schedule.toStep(schedule)

      yield* step(0, err).pipe(Effect.exit)

      expect(seen).toEqual([{ error: err, message: "Network request failed" }])
    }),
  )
})
// kilocode_change end

describe("session.retry.retryable", () => {
  test("maps too_many_requests json messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Too Many Requests" })
  })

  test("maps overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Provider is overloaded" })
  })

  test("does not retry unknown json messages", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = SessionRetry.retryable(error, retryProvider)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries plain text rate limit errors from Alibaba", () => {
    const msg =
      "Upstream error from Alibaba: Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time."
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries plain text rate limit errors", () => {
    const msg = "Rate limit exceeded, please try again later"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries too many requests in plain text", () => {
    const msg = "Too many requests, please slow down"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries transport timeout errors", () => {
    const request = MessageV2.fromError(new ProviderError.HeaderTimeoutError(10000), { providerID })
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({
      message: "Provider response headers timed out after 10000ms",
    })
  })

  test("retries websocket stream transport errors", () => {
    const request = MessageV2.fromError(
      new ProviderError.ResponseStreamError("WebSocket closed before response.completed (code 1006: Connection ended)"),
      { providerID },
    )
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({
      message: "WebSocket closed before response.completed (code 1006: Connection ended)",
    })
  })

  test("does not retry context overflow errors", () => {
    const error = new SessionV1.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject()

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries 500 errors even when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Internal server error",
        isRetryable: false,
        statusCode: 500,
        responseBody: '{"type":"api_error","message":"Internal server error"}',
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Internal server error" })
  })

  test("retries 502 bad gateway errors", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Bad gateway",
        isRetryable: false,
        statusCode: 502,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Bad gateway" })
  })

  test("retries 503 service unavailable errors", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Service unavailable",
        isRetryable: false,
        statusCode: 503,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Service unavailable" })
  })

  test("does not retry 4xx errors when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Bad request",
        isRetryable: false,
        statusCode: 400,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries ZlibError decompression failures", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Response decompression failed",
        isRetryable: true,
        metadata: { code: "ZlibError" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Response decompression failed" })
  })

  // kilocode_change start - Kilo does not support OpenCode Go upsells
  test("does not retry free usage limits", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Free usage exceeded",
        isRetryable: true,
        statusCode: 429,
        responseBody: JSON.stringify({
          type: "error",
          error: { type: "FreeUsageLimitError", message: "Free usage exceeded" },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "kilo")).toBeUndefined()
  })
  // kilocode_change end
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(_req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID })

      expect(SessionV1.APIError.isInstance(result)).toBe(true)
      if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
      expect(result.data.isRetryable).toBe(true)
      expect(result.data.message).toBe("Connection reset by server")
      expect(result.data.metadata?.code).toBe("ECONNRESET")
      expect(result.data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Connection reset by server",
        isRetryable: true,
        metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Connection reset by server" })
  })

  // kilocode_change start
  test("ECONNREFUSED socket error is retryable", () => {
    const result = MessageV2.fromError(
      {
        code: "ECONNREFUSED",
        syscall: "connect",
        message: "connect ECONNREFUSED 127.0.0.1:3000",
      },
      { providerID: ProviderV2.ID.make("test") },
    ) as MessageV2.APIError

    expect(result.data.isRetryable).toBe(true)
    expect(result.data.message).toBe("Connection refused")
    expect(result.data.metadata?.code).toBe("ECONNREFUSED")
  })
  // kilocode_change end

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: ProviderV2.ID.make("openai") })
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
  })

  test("converts OpenAI server_error stream chunks to retryable APIError", () => {
    const result = MessageV2.fromError(
      {
        message: JSON.stringify({
          type: "error",
          sequence_number: 2,
          error: {
            type: "server_error",
            code: "server_error",
            message: "An error occurred while processing your request.",
            param: null,
          },
        }),
      },
      { providerID: ProviderV2.ID.make("openai") },
    )

    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(SessionRetry.retryable(result, retryProvider)).toEqual({
      message: "An error occurred while processing your request.",
    })
  })

  // kilocode_change start
  test("converts the exact unknown certificate verification error to a retryable APIError", () => {
    const error = new Error("request failed", { cause: new Error("unknown certificate verification error") })
    const result = MessageV2.fromError(error, { providerID })

    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(SessionRetry.retryable(result, retryProvider)).toEqual({
      message: "Network connection failed",
    })
  })

  test("recognizes the certificate message case-insensitively through nested causes", () => {
    const error = { message: "upstream failed", cause: { message: "Unknown Certificate Verification Error" } }
    const result = MessageV2.fromError(error, { providerID })

    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(SessionRetry.retryable(result, retryProvider)).toEqual({
      message: "Network connection failed",
    })
  })

  test("does not retry neighboring certificate messages", () => {
    for (const message of [
      "certificate has expired",
      "certificate verification failed",
      "TLS handshake failed",
      "self-signed certificate",
    ]) {
      const result = MessageV2.fromError(new Error(message), { providerID })
      expect(SessionV1.APIError.isInstance(result)).toBe(false)
      expect(result.data).toMatchObject({ message })
    }
  })

  test("retries first-chunk startup timeouts as retryable APIErrors", () => {
    const request = MessageV2.fromError(
      new ProviderError.ResponseStreamError("Provider response timed out waiting for the first chunk"),
      { providerID },
    )
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    if (!SessionV1.APIError.isInstance(request)) throw new Error("expected APIError")
    expect(request.data.isRetryable).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({
      message: "Provider response timed out waiting for the first chunk",
    })
  })
  // kilocode_change end
})
