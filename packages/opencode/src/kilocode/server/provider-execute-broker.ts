// kilocode_change - new file
/**
 * CLI-side typed unary private provider broker for `provider/execute`.
 *
 * Caller supplies `{providerId, modelId, record, prompt}`; the broker never
 * selects scope/provider or reads VS Code config. Timeout is caller-owned
 * through the Effect fiber lifecycle: on fiber interruption the broker drops
 * the exact `PrivatePeer` call so `$/cancelRequest` reaches the extension
 * host. No detached fibers, no second PrivatePeer owner.
 *
 * Validation is wire-envelope-only at this boundary: closed-shape checks
 * for `providerId`/`modelId`/`prompt` and safe plain-object/prototype
 * checks for `record`. The full `CanonicalProviderPayload` AST stays in the
 * host. Success shape is validated sufficiently, including canonical
 * protocol and `LLMEvent` shape via the shared `ProviderExecuteWire`
 * contract (which itself uses `@opencode-ai/llm`'s `LLMEvent`).
 *
 * Errors:
 * - `PrivatePeerUnavailable` -> `ProviderExecuteUnavailable`
 * - `PrivatePeerUnsupported` -> `ProviderExecuteUnsupported`
 * - Host canonical failure codes (including `aborted`) -> `ProviderExecuteFailure` preserving sanitized message and exact code
 * - Unexpected JSON-RPC failures or malformed success results -> `ProviderExecuteProtocolError`
 */

import { Context, Data, Effect, Layer } from "effect"
import * as PrivatePeer from "@/kilocode/server/private-peer-registry"
import {
  PROVIDER_EXECUTE_METHOD,
  ProviderExecuteWire,
  type CanonicalFailureCode,
  type ProviderExecuteSuccess,
} from "@opencode-ai/core/kilocode/provider-execute"

export type Input = {
  readonly providerId: string
  readonly modelId: string
  readonly record: unknown
  readonly prompt: string
}

export class ProviderExecuteUnavailable extends Data.TaggedError("ProviderExecuteUnavailable")<{
  readonly message: string
}> {}

export class ProviderExecuteUnsupported extends Data.TaggedError("ProviderExecuteUnsupported")<{
  readonly capability: string
  readonly message: string
}> {}

export class ProviderExecuteFailure extends Data.TaggedError("ProviderExecuteFailure")<{
  readonly code: CanonicalFailureCode
  readonly message: string
}> {}

export class ProviderExecuteProtocolError extends Data.TaggedError("ProviderExecuteProtocolError")<{
  readonly message: string
  readonly cause?: unknown
  readonly code?: number
}> {}

export type BrokerError =
  | ProviderExecuteUnavailable
  | ProviderExecuteUnsupported
  | ProviderExecuteFailure
  | ProviderExecuteProtocolError

export interface Broker {
  readonly execute: (input: Input) => Effect.Effect<ProviderExecuteSuccess, BrokerError>
}

export class Service extends Context.Service<Service, Broker>()("@kilocode/ProviderExecuteBroker") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const peer = yield* PrivatePeer.Service

    const execute: Broker["execute"] = (input) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          let params: ReturnType<typeof ProviderExecuteWire.validateRequest>
          try {
            params = ProviderExecuteWire.validateRequest(input as unknown as Record<string, unknown>)
          } catch (e) {
            return yield* Effect.fail(
              new ProviderExecuteProtocolError({
                message: e instanceof Error ? e.message : String(e),
                cause: e,
              }),
            )
          }

          const call = yield* peer.request(PROVIDER_EXECUTE_METHOD, params).pipe(
            Effect.mapError((e) => {
              if (e instanceof PrivatePeer.Unavailable) return new ProviderExecuteUnavailable({ message: "Private peer unavailable" })
              if (e instanceof PrivatePeer.Unsupported)
                return new ProviderExecuteUnsupported({ capability: e.capability, message: `Unsupported capability: ${e.capability}` })
              return new ProviderExecuteProtocolError({ message: String(e), cause: e })
            }),
          )

          const raw = yield* restore(
            Effect.tryPromise({
              try: () => call.done as Promise<unknown>,
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((err: unknown): Effect.Effect<never, BrokerError> => {
                const extracted = ProviderExecuteWire.extractFailure(err)
                if (extracted) return Effect.fail(new ProviderExecuteFailure({ code: extracted.code, message: extracted.message }))
                const msg = err instanceof Error ? err.message : String(err)
                const code = (err as { code?: number })?.code
                return Effect.fail(new ProviderExecuteProtocolError({ message: msg, cause: err, code }))
              }),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  try {
                    call.drop()
                  } catch {}
                }),
              ),
            ),
          )

          let validated: ProviderExecuteSuccess
          try {
            validated = ProviderExecuteWire.validateSuccess(raw)
          } catch (e) {
            return yield* Effect.fail(
              new ProviderExecuteProtocolError({
                message: e instanceof Error ? e.message : String(e),
                cause: e,
              }),
            )
          }

          if (validated.providerId !== params.providerId || validated.modelId !== params.modelId) {
            return yield* Effect.fail(
              new ProviderExecuteProtocolError({ message: "Result provider/model mismatch", cause: validated }),
            )
          }

          return validated
        }),
      )

    return Service.of({ execute })
  }),
)

export const defaultLayer = layer
export * as ProviderExecuteBroker from "./provider-execute-broker"
