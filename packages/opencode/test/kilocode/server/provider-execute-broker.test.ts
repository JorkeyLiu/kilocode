import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { Cause, Duration, Effect, Exit, Fiber, Layer } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { LLMEvent } from "@opencode-ai/llm"
import * as PrivatePeer from "../../../src/kilocode/server/private-peer-registry"
import * as Broker from "../../../src/kilocode/server/provider-execute-broker"
import {
  PROVIDER_EXECUTE_METHOD,
  CANONICAL_FAILURE_CODES,
  type CanonicalFailureCode,
} from "@opencode-ai/core/kilocode/provider-execute"

function pairWithHandler(
  handler: (method: string, params: unknown, ctx: { id: unknown; signal: AbortSignal }) => unknown | Promise<unknown>,
) {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = new JsonRpcPeer({ reader: bToA, writer: aToB })
  const b = new JsonRpcPeer({
    reader: aToB,
    writer: bToA,
    onRequest: handler as unknown as (method: string, params: unknown, ctx: unknown) => unknown,
  })
  return { a, b, aToB, bToA }
}

function closeAll(...peers: JsonRpcPeer[]) {
  for (const p of peers) try { p.dispose() } catch {}
}

function makeSuccess(providerId: string, modelId: string, protocol: "openai/completions" | "openai/responses" | "anthropic/messages" = "openai/completions") {
  const text = "Hello"
  const event = LLMEvent.textDelta({ id: "c1", text })
  return {
    providerId,
    modelId,
    protocol,
    endpoint: "https://api.example.com/v1",
    path: protocol === "openai/completions" ? "/chat/completions" : protocol === "openai/responses" ? "/responses" : "/messages",
    text,
    events: [event, LLMEvent.finish({ reason: "stop" })],
  }
}

const TestLayer = Broker.layer.pipe(Layer.provideMerge(PrivatePeer.defaultLayer))

const runWith = <A, E>(eff: Effect.Effect<A, E, Broker.Service | PrivatePeer.Service>) =>
  Effect.runPromise(eff.pipe(Effect.provide(TestLayer)))

describe("provider-execute-broker", () => {
  test("unavailable when no peer installed", async () => {
    await runWith(
      Effect.gen(function* () {
        const broker = yield* Broker.Service
        const result = yield* broker.execute({ providerId: "p1", modelId: "m1", record: {}, prompt: "hi" }).pipe(Effect.flip)
        expect(result).toBeInstanceOf(Broker.ProviderExecuteUnavailable)
        expect(result._tag).toBe("ProviderExecuteUnavailable")
      }),
    )
  })

  test("unsupported when capability not negotiated", async () => {
    const { a, b } = pairWithHandler(async (method) => {
      if (method === PROVIDER_EXECUTE_METHOD) return makeSuccess("p1", "m1")
      const err = new Error(`Method not found: ${method}`) as Error & { code?: number }
      err.code = ErrorCode.MethodNotFound
      throw err
    })
    try {
      a.markInitialized()
      await runWith(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a)
          // negotiate without provider/execute
          yield* lease.negotiate(["other/cap"])
          const result = yield* broker.execute({ providerId: "p1", modelId: "m1", record: {}, prompt: "hi" }).pipe(Effect.flip)
          expect(result).toBeInstanceOf(Broker.ProviderExecuteUnsupported)
          expect(result._tag).toBe("ProviderExecuteUnsupported")
          if (result._tag === "ProviderExecuteUnsupported") expect(result.capability).toBe(PROVIDER_EXECUTE_METHOD)
          expect(a.getPendingCount()).toBe(0)
          yield* lease.release
        }),
      )
    } finally {
      closeAll(a, b)
    }
  })

  test("exact request/result round-trip", async () => {
    let seen: unknown = null
    const { a, b } = pairWithHandler(async (method, params) => {
      seen = params
      const p = params as Record<string, unknown>
      // Validate exact shape forwarded by broker
      expect(p.providerId).toBe("acme")
      expect(p.modelId).toBe("m1")
      expect(p.prompt).toBe("Say hello.")
      expect(p.record).toEqual({ name: "Acme", endpoint: "https://x", protocol: "openai/completions", models: { m1: { name: "M1" } } })
      return makeSuccess("acme", "m1", "openai/completions")
    })
    try {
      a.markInitialized()
      await runWith(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a)
          yield* lease.negotiate([PROVIDER_EXECUTE_METHOD])
          const record = { name: "Acme", endpoint: "https://x", protocol: "openai/completions", models: { m1: { name: "M1" } } }
          const out = yield* broker.execute({ providerId: "acme", modelId: "m1", record, prompt: "Say hello." })
          expect(out.providerId).toBe("acme")
          expect(out.modelId).toBe("m1")
          expect(out.protocol).toBe("openai/completions")
          expect(out.endpoint).toBe("https://api.example.com/v1")
          expect(out.path).toBe("/chat/completions")
          expect(out.text).toBe("Hello")
          expect(Array.isArray(out.events) && out.events.some((e: unknown) => (e as { type?: string }).type === "text-delta")).toBeTrue()
          expect(seen).not.toBeNull()
          expect(a.getPendingCount()).toBe(0)
          expect(a.getPendingIds().length).toBe(0)
          yield* lease.release
        }),
      )
    } finally {
      closeAll(a, b)
    }
  })

  test("malformed input fails before sending (protocol error) and drains", async () => {
    let called = false
    const { a, b } = pairWithHandler(async () => {
      called = true
      return makeSuccess("p1", "m1")
    })
    try {
      a.markInitialized()
      await runWith(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a)
          yield* lease.negotiate([PROVIDER_EXECUTE_METHOD])
          const badCases: unknown[] = [
            { providerId: "", modelId: "m1", record: {}, prompt: "hi" },
            { providerId: "p1", modelId: "", record: {}, prompt: "hi" },
            { providerId: "p1", modelId: "m1", record: null, prompt: "hi" },
            { providerId: "p1", modelId: "m1", record: {}, prompt: "hi", extra: 1 },
            // prototype pollution
            (() => {
              const r = Object.create(null) as Record<string, unknown>
              r.providerId = "p1"
              r.modelId = "m1"
              r.record = {}
              r.prompt = "hi"
              return r
            })(),
            { providerId: "p1\0", modelId: "m1", record: {}, prompt: "hi" },
          ]
          for (const raw of badCases) {
            const input = raw as { providerId: string; modelId: string; record: unknown; prompt: string }
            const failed = yield* broker.execute(input).pipe(Effect.flip)
            expect(failed).toBeInstanceOf(Broker.ProviderExecuteProtocolError)
            expect(failed._tag).toBe("ProviderExecuteProtocolError")
            expect(called).toBeFalse()
            expect(a.getPendingCount()).toBe(0)
          }
          yield* lease.release
        }),
      )
    } finally {
      closeAll(a, b)
    }
  })

  test("malformed success result is protocol error", async () => {
    const { a, b } = pairWithHandler(async () => {
      // Missing protocol, events not LLMEvent
      return { providerId: "p1", modelId: "m1", protocol: "bad", endpoint: "https://x", path: "/bad", text: "hi", events: [{ type: "bad" }] }
    })
    try {
      a.markInitialized()
      await runWith(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a)
          yield* lease.negotiate([PROVIDER_EXECUTE_METHOD])
          const failed = yield* broker.execute({ providerId: "p1", modelId: "m1", record: {}, prompt: "hi" }).pipe(Effect.flip)
          expect(failed).toBeInstanceOf(Broker.ProviderExecuteProtocolError)
          expect(a.getPendingCount()).toBe(0)
          yield* lease.release
        }),
      )
    } finally {
      closeAll(a, b)
    }
  })

  test("every canonical failure code and abort mapping preserves code/message", async () => {
    for (const code of CANONICAL_FAILURE_CODES) {
      const expectedCode = code as CanonicalFailureCode
      const isInvalidParam = new Set(["invalid-record", "invalid-endpoint", "unknown-protocol", "unknown-model", "missing-credential-ref", "invalid-credential-ref"]).has(code)
      const jsonCode = isInvalidParam ? ErrorCode.InvalidParams : ErrorCode.InternalError
      const message = `failure ${code}`
      const { a, b } = pairWithHandler(async () => {
        const err = new Error(message) as Error & { code?: number; data?: unknown }
        err.code = jsonCode
        err.data = { code: expectedCode }
        throw err
      })
      try {
        a.markInitialized()
        await runWith(
          Effect.gen(function* () {
            const peer = yield* PrivatePeer.Service
            const broker = yield* Broker.Service
            const lease = yield* peer.install(a)
            yield* lease.negotiate([PROVIDER_EXECUTE_METHOD])
            const failed = yield* broker.execute({ providerId: "p1", modelId: "m1", record: {}, prompt: "hi" }).pipe(Effect.flip)
            expect(failed).toBeInstanceOf(Broker.ProviderExecuteFailure)
            expect(failed._tag).toBe("ProviderExecuteFailure")
            if (failed._tag === "ProviderExecuteFailure") {
              expect(failed.code).toBe(expectedCode)
              expect(failed.message).toBe(message)
            }
            expect(a.getPendingCount()).toBe(0)
            yield* lease.release
          }),
        )
      } finally {
        closeAll(a, b)
      }
    }
  })

  test("unexpected JSON-RPC failures are protocol errors", async () => {
    const cases: Array<() => Error & { code?: number; data?: unknown }> = [
      () => {
        const e = new Error("not found") as Error & { code?: number }
        e.code = ErrorCode.MethodNotFound
        return e
      },
      () => {
        const e = new Error("parse") as Error & { code?: number }
        e.code = ErrorCode.ParseError
        return e
      },
      () => {
        const e = new Error("internal without code") as Error & { code?: number }
        e.code = ErrorCode.InternalError
        return e
      },
      () => {
        const e = new Error("internal with wrong data") as Error & { code?: number; data?: unknown }
        e.code = ErrorCode.InternalError
        e.data = { code: "not-a-canonical-code" }
        return e
      },
    ]
    for (const make of cases) {
      const { a, b } = pairWithHandler(async () => {
        throw make()
      })
      try {
        a.markInitialized()
        await runWith(
          Effect.gen(function* () {
            const peer = yield* PrivatePeer.Service
            const broker = yield* Broker.Service
            const lease = yield* peer.install(a)
            yield* lease.negotiate([PROVIDER_EXECUTE_METHOD])
            const failed = yield* broker.execute({ providerId: "p1", modelId: "m1", record: {}, prompt: "hi" }).pipe(Effect.flip)
            expect(failed).toBeInstanceOf(Broker.ProviderExecuteProtocolError)
            expect(a.getPendingCount()).toBe(0)
            yield* lease.release
          }),
        )
      } finally {
        closeAll(a, b)
      }
    }
  })

  test("adversarial: MethodNotFound and wrong-family codes are protocol errors, not trusted failures", async () => {
    const cases: Array<{ outer: number; inner: CanonicalFailureCode; label: string }> = [
      { outer: ErrorCode.MethodNotFound, inner: "invalid-record", label: "MethodNotFound with invalid-record" },
      { outer: ErrorCode.MethodNotFound, inner: "provider", label: "MethodNotFound with provider" },
      { outer: ErrorCode.MethodNotFound, inner: "aborted", label: "MethodNotFound with aborted" },
      { outer: ErrorCode.InternalError, inner: "invalid-record", label: "InternalError with invalid-record (wrong family)" },
      { outer: ErrorCode.InternalError, inner: "invalid-endpoint", label: "InternalError with invalid-endpoint (wrong family)" },
      { outer: ErrorCode.InternalError, inner: "unknown-protocol", label: "InternalError with unknown-protocol (wrong family)" },
      { outer: ErrorCode.InternalError, inner: "missing-credential-ref", label: "InternalError with missing-credential-ref (wrong family)" },
      { outer: ErrorCode.InvalidParams, inner: "provider", label: "InvalidParams with provider (wrong family)" },
      { outer: ErrorCode.InvalidParams, inner: "missing-secret", label: "InvalidParams with missing-secret (wrong family)" },
      { outer: ErrorCode.InvalidParams, inner: "aborted", label: "InvalidParams with aborted (wrong family)" },
    ]
    for (const c of cases) {
      // direct data.code
      {
        const { a, b } = pairWithHandler(async () => {
          const err = new Error(`forged ${c.label}`) as Error & { code?: number; data?: unknown }
          err.code = c.outer
          err.data = { code: c.inner }
          throw err
        })
        try {
          a.markInitialized()
          await runWith(
            Effect.gen(function* () {
              const peer = yield* PrivatePeer.Service
              const broker = yield* Broker.Service
              const lease = yield* peer.install(a)
              yield* lease.negotiate([PROVIDER_EXECUTE_METHOD])
              const failed = yield* broker.execute({ providerId: "p1", modelId: "m1", record: {}, prompt: "hi" }).pipe(Effect.flip)
              expect(failed, c.label).toBeInstanceOf(Broker.ProviderExecuteProtocolError)
              expect((failed as Broker.ProviderExecuteProtocolError).code, c.label).toBe(c.outer)
              expect(a.getPendingCount()).toBe(0)
              yield* lease.release
            }),
          )
        } finally {
          closeAll(a, b)
        }
      }
      // double-wrapped data.data.code
      {
        const { a, b } = pairWithHandler(async () => {
          const err = new Error(`forged ${c.label} double`) as Error & { code?: number; data?: unknown }
          err.code = c.outer
          err.data = { data: { code: c.inner } }
          throw err
        })
        try {
          a.markInitialized()
          await runWith(
            Effect.gen(function* () {
              const peer = yield* PrivatePeer.Service
              const broker = yield* Broker.Service
              const lease = yield* peer.install(a)
              yield* lease.negotiate([PROVIDER_EXECUTE_METHOD])
              const failed = yield* broker.execute({ providerId: "p1", modelId: "m1", record: {}, prompt: "hi" }).pipe(Effect.flip)
              expect(failed, `${c.label} double`).toBeInstanceOf(Broker.ProviderExecuteProtocolError)
              expect(a.getPendingCount()).toBe(0)
              yield* lease.release
            }),
          )
        } finally {
          closeAll(a, b)
        }
      }
    }
    // Malformed envelope: numeric code but no data.code → protocol error
    {
      const { a, b } = pairWithHandler(async () => {
        const err = new Error("no data") as Error & { code?: number; data?: unknown }
        err.code = ErrorCode.InvalidParams
        err.data = { notCode: "invalid-record" }
        throw err
      })
      try {
        a.markInitialized()
        await runWith(
          Effect.gen(function* () {
            const peer = yield* PrivatePeer.Service
            const broker = yield* Broker.Service
            const lease = yield* peer.install(a)
            yield* lease.negotiate([PROVIDER_EXECUTE_METHOD])
            const failed = yield* broker.execute({ providerId: "p1", modelId: "m1", record: {}, prompt: "hi" }).pipe(Effect.flip)
            expect(failed).toBeInstanceOf(Broker.ProviderExecuteProtocolError)
            expect(a.getPendingCount()).toBe(0)
            yield* lease.release
          }),
        )
      } finally {
        closeAll(a, b)
      }
    }
  })

  test("fiber interruption emits $/cancelRequest and aborts remote request", async () => {
    let signalAborted = false
    let signalAtAbort: AbortSignal | null = null
    const { a, b } = pairWithHandler(async (_method, _params, ctx) => {
      const sig = ctx.signal
      signalAtAbort = sig
      // Hang until abort
      await new Promise<void>((resolve, reject) => {
        if (sig.aborted) {
          signalAborted = true
          reject(new DOMException("Aborted", "AbortError"))
          return
        }
        sig.addEventListener("abort", () => {
          signalAborted = true
          reject(new DOMException("Aborted", "AbortError"))
        }, { once: true })
      })
      const err = new Error("Request cancelled") as Error & { code?: number; data?: unknown }
      err.code = ErrorCode.InternalError
      err.data = { code: "aborted" }
      throw err
    })
    try {
      a.markInitialized()
      await runWith(
        Effect.gen(function* () {
          const peer = yield* PrivatePeer.Service
          const broker = yield* Broker.Service
          const lease = yield* peer.install(a)
          yield* lease.negotiate([PROVIDER_EXECUTE_METHOD])
          const fiber = yield* Effect.forkChild(broker.execute({ providerId: "p1", modelId: "m1", record: {}, prompt: "hi" }))
          let attempts = 0
          while (a.getPendingCount() === 0 && attempts < 20) {
            yield* Effect.sleep(Duration.millis(10))
            attempts++
          }
          expect(a.getPendingCount()).toBe(1)
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          expect(Exit.isFailure(exit)).toBeTrue()
          const cause = (exit as Exit.Failure<unknown, unknown>).cause
          expect(Cause.hasInterrupts(cause)).toBeTrue()
          yield* Effect.sleep(Duration.millis(20))
          expect(a.getPendingCount()).toBe(0)
          expect(a.getPendingIds().length).toBe(0)
          expect(signalAborted).toBeTrue()
          expect(signalAtAbort?.aborted).toBeTrue()
          expect(a.getPendingCount()).toBe(0)
          yield* lease.release
        }),
      )
    } finally {
      closeAll(a, b)
    }
  })
})
