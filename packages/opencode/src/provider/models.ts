// kilocode_change - P4.4-T7: static catalog only, no kilo/apertis dynamic injection
import * as Core from "@opencode-ai/core/models-dev"
import { Context, Effect, Layer } from "effect"
import { AI_SDK_PROVIDERS, PROMPTS } from "@kilocode/kilo-gateway"
import { overlay } from "@/kilocode/anaconda-desktop/provider"
import { Log } from "@opencode-ai/core/util/log"

const log = Log.create({ service: "models-dev" })

export const Model = Core.Model
export type Model = Core.Model
export const Provider = Core.Provider
export type Provider = Core.Provider
export const CatalogModelStatus = Core.CatalogModelStatus
export type CatalogModelStatus = Core.CatalogModelStatus

export interface Interface extends Core.Interface {}

export class Service extends Context.Service<Service, Interface>()("@kilocode/ModelsDev") {}

export const layer: Layer.Layer<Service, never, Core.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const core = yield* Core.Service

    const get = Effect.fn("ModelsDev.get")(function* () {
      const coreProviders = yield* core.get().pipe(
        Effect.catchDefect((defect) => {
          log.warn("models.dev catalog unavailable, using empty catalog", {
            category: "catalog-fetch",
            errorClass: defect?.constructor?.name ?? "Unknown",
          })
          return Effect.succeed({} as Record<string, Core.Provider>)
        }),
      )
      const providers = overlay(coreProviders)
      return providers
    })

    return Service.of({ get, refresh: core.refresh })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Core.defaultLayer))

// kilocode_change start - LOCK-001: canonical combined models layer
export const combinedLayer = (
  coreLayer: Layer.Layer<Core.Service, never, never> = Core.defaultLayer,
): Layer.Layer<Core.Service | Service, never, never> =>
  Layer.merge(coreLayer, layer.pipe(Layer.provide(coreLayer)))
// kilocode_change end

export { AI_SDK_PROVIDERS, PROMPTS }
export * as ModelsDev from "./models"
