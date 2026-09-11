// kilocode_change - new file
/**
 * CLI canonical provider execution service.
 *
 * Composes the existing `CanonicalResolver` (typed provenance resolution under
 * the active config/generation snapshot) with the existing
 * `ProviderExecuteBroker` (typed unary reverse `provider/execute` over the
 * process-owned `PrivatePeer` registry).
 *
 * - Accepts `{providerId, modelId, prompt}` and returns the existing
 *   `ProviderExecuteSuccess` shape.
 * - Resolve through `CanonicalResolver` first; on resolver failure the broker
 *   is never called.
 * - Call `ProviderExecuteBroker` with the exact resolved `record` object (no
 *   copy, no enrichment) plus the caller prompt.
 * - Preserve Effect interruption/cancellation: the broker's own
 *   `restore` region owns the `drop` → `$/cancelRequest` mapping, and this
 *   composition never catches or wraps interruption.
 * - Typed error boundary is the exact union of the existing resolver and
 *   broker failure categories; sanitized host `CanonicalFailureCode` + message
 *   from `ProviderExecuteFailure` is preserved. No credential values are ever
 *   placed in an error or log.
 */

import { Context, Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { CanonicalResolver } from "./canonical-resolver"
import type { CanonicalResolveError } from "./canonical-resolver"
import * as BrokerModule from "@/kilocode/server/provider-execute-broker"
import type { ProviderExecuteSuccess } from "@opencode-ai/core/kilocode/provider-execute"

export type Input = {
  readonly providerId: string
  readonly modelId: string
  readonly prompt: string
}

export type Success = ProviderExecuteSuccess

export type BrokerError = BrokerModule.BrokerError

export type CanonicalProviderExecuteError = CanonicalResolveError | BrokerError

export interface Executor {
  readonly execute: (input: Input) => Effect.Effect<Success, CanonicalProviderExecuteError>
}

export class Service extends Context.Service<Service, Executor>()("@kilocode/CanonicalProviderExecute") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const broker = yield* BrokerModule.Service
    const execute: Executor["execute"] = (input) =>
      Effect.gen(function* () {
        const resolved = yield* CanonicalResolver.resolve(input.providerId, input.modelId).pipe(
          Effect.provideService(Config.Service, cfg),
        )
        return yield* broker.execute({
          providerId: resolved.providerId,
          modelId: resolved.modelId,
          record: resolved.record,
          prompt: input.prompt,
        })
      })
    return Service.of({ execute })
  }),
)

export const defaultLayer = layer

export * as CanonicalProviderExecute from "./canonical-provider-execute"
