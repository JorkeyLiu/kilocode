import { ModelsDev as Core } from "@opencode-ai/core/models-dev"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { ModelCache } from "../../src/provider/model-cache"
import * as Kilo from "../../src/provider/models"

const cache = Layer.mock(ModelCache.Service)({
  clear: () => Effect.void,
})

export const modelsDevLayer = Kilo.layer.pipe(
  Layer.provideMerge(Core.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(cache),
)
