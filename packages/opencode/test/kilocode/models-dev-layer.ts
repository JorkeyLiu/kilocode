import { ModelsDev as Core } from "@opencode-ai/core/models-dev"
import { Layer } from "effect"
import * as Kilo from "../../src/provider/models"

export const modelsDevLayer = Kilo.layer.pipe(Layer.provideMerge(Core.defaultLayer))
