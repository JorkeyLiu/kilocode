// kilocode_change - new file
/**
 * CLI-side typed streaming private provider HTTP broker for `provider/httpExecute`.
 *
 * Incremental streaming: returns status/headers immediately after valid metadata seq0
 * and exposes Stream<Uint8Array> for chunks. Uses Scope + bounded Queue; the stream/scope
 * owns the exact PrivatePeer.Call. Early finalization, scope close, interruption,
 * protocol error, terminal mismatch, peer close all shut queue and drop exactly once.
 */

import { Cause, Context, Data, Deferred, Effect, Layer, Queue, Scope, Stream } from "effect"
import * as PrivatePeer from "@/kilocode/server/private-peer-registry"
import {
  PROVIDER_HTTP_EXECUTE_METHOD,
  ProviderHttpExecuteWire,
  type ProviderHttpExecuteRequest,
  type ProviderHttpExecuteResult,
  HTTP_TOTAL_MAX_BYTES,
  HTTP_MAX_CHUNKS,
  HTTP_CHUNK_MAX_BYTES,
} from "@opencode-ai/core/kilocode/provider-http-execute"

export type Input = {
  readonly providerId: string
  readonly modelId: string
  readonly record: unknown
  readonly body: string
  readonly headers?: Record<string, string>
}

export class ProviderHttpUnavailable extends Data.TaggedError("ProviderHttpUnavailable")<{
  readonly message: string
}> {}

export class ProviderHttpUnsupported extends Data.TaggedError("ProviderHttpUnsupported")<{
  readonly capability: string
  readonly message: string
}> {}

export class ProviderHttpFailure extends Data.TaggedError("ProviderHttpFailure")<{
  readonly code: string
  readonly message: string
}> {}

export class ProviderHttpProtocolError extends Data.TaggedError("ProviderHttpProtocolError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type BrokerError = ProviderHttpUnavailable | ProviderHttpUnsupported | ProviderHttpFailure | ProviderHttpProtocolError

export interface HttpResult {
  readonly status: number
  readonly headers: Record<string, string>
  readonly bytes: Uint8Array
}

export interface HttpStream {
  readonly status: number
  readonly headers: Record<string, string>
  readonly stream: Stream.Stream<Uint8Array, BrokerError>
}

export interface Broker {
  readonly stream: (input: Input) => Effect.Effect<HttpStream, BrokerError, Scope.Scope>
  readonly execute: (input: Input) => Effect.Effect<HttpResult, BrokerError>
}

export class Service extends Context.Service<Service, Broker>()("@kilocode/ProviderHttpExecuteBroker") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const peer = yield* PrivatePeer.Service

    const stream: Broker["stream"] = (input) =>
      Effect.gen(function* () {
        let params: ProviderHttpExecuteRequest
        try {
          params = ProviderHttpExecuteWire.validateRequest(input as unknown as Record<string, unknown>)
        } catch (e) {
          return yield* Effect.fail(
            new ProviderHttpProtocolError({
              message: e instanceof Error ? e.message : String(e),
              cause: e,
            }),
          )
        }

        const queue = yield* Queue.bounded<Uint8Array, BrokerError>(32)
        const metaDeferred = yield* Deferred.make<{ status: number; headers: Record<string, string> }, BrokerError>()

        let gotMeta = false
        let expected = 1
        let totalBytes = 0
        let chunks = 0
        let lastSeq = 0
        let protocolError: BrokerError | null = null
        let dropped = false
        let callRef: PrivatePeer.Call | null = null
        let pendingError: BrokerError | null = null

        const doDropOnce = () => {
          if (dropped) return
          if (!callRef) return
          dropped = true
          try {
            callRef.drop()
          } catch {}
        }

        const failAll = (err: BrokerError) => {
          if (protocolError) return
          protocolError = err
          // Fail deferred if not already completed
          Deferred.doneUnsafe(metaDeferred, Effect.fail(err))
          // Fail queue
          Queue.failCauseUnsafe(queue, Cause.fail(err))
          if (callRef) doDropOnce()
          else pendingError = err
        }

        const onEvent = (ev: unknown) => {
          if (protocolError) return
          try {
            if (!gotMeta) {
              const m = ProviderHttpExecuteWire.validateMetadata(ev)
              gotMeta = true
              Deferred.doneUnsafe(metaDeferred, Effect.succeed({ status: m.status, headers: m.headers }))
              return
            }
            const c = ProviderHttpExecuteWire.validateChunk(ev)
            if (c.seq !== expected) throw new Error(`seq mismatch expected ${expected} got ${c.seq}`)
            const decoded = Buffer.from(c.bytes, "base64")
            if (decoded.length > HTTP_CHUNK_MAX_BYTES) throw new Error("chunk too large")
            totalBytes += decoded.length
            if (totalBytes > HTTP_TOTAL_MAX_BYTES) throw new Error("total too large")
            if (chunks >= HTTP_MAX_CHUNKS) throw new Error("too many chunks")
            const offered = Queue.offerUnsafe(queue, decoded as Uint8Array)
            if (!offered) throw new Error("queue full")
            expected += 1
            lastSeq = c.seq
            chunks += 1
          } catch (e) {
            const err = new ProviderHttpProtocolError({ message: e instanceof Error ? e.message : String(e), cause: e })
            failAll(err)
          }
        }

        // Acquire Call scoped to the caller's Scope
        const call = yield* Effect.acquireRelease(
          peer
            .requestWithEvents(PROVIDER_HTTP_EXECUTE_METHOD, params as unknown, onEvent)
            .pipe(
              Effect.mapError(
                (e): BrokerError => {
                  if (e instanceof PrivatePeer.Unavailable) return new ProviderHttpUnavailable({ message: "Private peer unavailable" })
                  if (e instanceof PrivatePeer.Unsupported)
                    return new ProviderHttpUnsupported({ capability: e.capability, message: `Unsupported capability: ${e.capability}` })
                  return new ProviderHttpProtocolError({ message: String(e), cause: e })
                },
              ),
            ),
          (acquired, _exit) =>
            Effect.sync(() => {
              if (!dropped) {
                dropped = true
                try {
                  acquired.drop()
                } catch {}
              }
              // If metadata never arrived, fail it so caller doesn't hang
              Deferred.doneUnsafe(metaDeferred, Effect.fail(new ProviderHttpProtocolError({ message: "peer closed before metadata" })))
              // End queue gracefully; if already failed/ended this is no-op
              ;(Queue.endUnsafe as unknown as (q: unknown) => boolean)(queue)
            }),
        )

        callRef = call
        if (pendingError) {
          doDropOnce()
        }

        // Scoped terminal watcher – validates terminal counts before ending queue
        yield* Effect.forkScoped(
          Effect.tryPromise({
            try: () => call.done as Promise<unknown>,
            catch: (cause) => cause,
          }).pipe(
            Effect.flatMap((raw) =>
              Effect.gen(function* () {
                if (protocolError) return
                let validated: ProviderHttpExecuteResult
                try {
                  validated = ProviderHttpExecuteWire.validateResult(raw)
                } catch (e) {
                  const err = new ProviderHttpProtocolError({ message: e instanceof Error ? e.message : String(e), cause: e })
                  Deferred.doneUnsafe(metaDeferred, Effect.fail(err))
                  Queue.failCauseUnsafe(queue, Cause.fail(err))
                  return
                }
                if (chunks === 0) {
                  if (validated.seq !== 0 || validated.chunks !== 0 || validated.bytes !== 0) {
                    const err = new ProviderHttpProtocolError({ message: "terminal count mismatch empty" })
                    Deferred.doneUnsafe(metaDeferred, Effect.fail(err))
                    Queue.failCauseUnsafe(queue, Cause.fail(err))
                    return
                  }
                } else {
                  if (validated.seq !== lastSeq || validated.chunks !== chunks || validated.bytes !== totalBytes) {
                    const err = new ProviderHttpProtocolError({ message: "terminal count mismatch" })
                    Deferred.doneUnsafe(metaDeferred, Effect.fail(err))
                    Queue.failCauseUnsafe(queue, Cause.fail(err))
                    return
                  }
                }
                ;(Queue.endUnsafe as unknown as (q: unknown) => boolean)(queue)
              }),
            ),
            Effect.catch((err: unknown) => {
              const maybe = extractFailure(err)
              const brokerErr: BrokerError = maybe
                ? new ProviderHttpFailure({ code: maybe.code, message: maybe.message })
                : new ProviderHttpProtocolError({ message: err instanceof Error ? err.message : String(err), cause: err })
              if (!protocolError) {
                Deferred.doneUnsafe(metaDeferred, Effect.fail(brokerErr))
                Queue.failCauseUnsafe(queue, Cause.fail(brokerErr))
              }
              return Effect.void
            }),
          ),
        )

        // Await metadata (fails if protocol error or terminal failure before metadata)
        const meta = yield* Deferred.await(metaDeferred)

        const outStream = Stream.fromQueue(queue).pipe(
          Stream.mapError((e) => e as BrokerError),
        )

        return { status: meta.status, headers: meta.headers, stream: outStream }
      })

    const execute: Broker["execute"] = (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { status, headers, stream: s } = yield* stream(input)
          const collected = yield* Stream.runCollect(s)
          const arr = collected as unknown as Uint8Array[]
          let total = 0
          for (const c of arr) total += c.length
          const out = new Uint8Array(total)
          let off = 0
          for (const c of arr) {
            out.set(c, off)
            off += c.length
          }
          return { status, headers, bytes: out }
        }),
      )

    return Service.of({ stream, execute })
  }),
)

function extractFailure(err: unknown): { code: string; message: string } | undefined {
  const rec = err as { code?: number; message?: string; data?: unknown }
  const outer = rec?.code
  if (typeof outer !== "number") return undefined
  const message = typeof rec?.message === "string" ? rec.message : "Request failed"
  const data = rec?.data as unknown
  let code: string | undefined
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>
    if (typeof o.code === "string") code = o.code
    else if (o.data && typeof o.data === "object" && typeof (o.data as Record<string, unknown>).code === "string")
      code = (o.data as Record<string, unknown>).code as string
  }
  if (!code) return undefined
  return { code, message }
}

export const defaultLayer = layer
export * as ProviderHttpExecuteBroker from "./provider-http-execute-broker"
