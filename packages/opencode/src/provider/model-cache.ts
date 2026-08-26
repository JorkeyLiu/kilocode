// kilocode_change - P4.4-T7-correction: invalidation-only, no kilo/apertis network, no Map
import { Context, Effect, Layer } from "effect"

export interface Interface {
  readonly clear: (providerID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@kilocode/ModelCache") {}

export const layer: Layer.Layer<Service, never, never> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const clear: Interface["clear"] = () => Effect.void

    return Service.of({ clear })
  }),
)

export const defaultLayer = layer

export * as ModelCache from "./model-cache"
