import { Config } from "@/config/config"
// kilocode_change start - preserve Kilo API default model overlay
import { fetchDefaultModel } from "@kilocode/kilo-gateway"
import { Auth } from "@/auth"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { filterPromptTrainingModels, nonEmptyProviders } from "@/kilocode/provider/model-filter"
// kilocode_change end
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi" // kilocode_change
import { InstanceHttpApi } from "../api"
import { GenerationGate } from "@/kilocode/server/generation-gate" // kilocode_change
import { ConfigRebuild } from "@/kilocode/server/config-rebuild" // kilocode_change
import { withWriteTicket } from "@/kilocode/server/config-ticket" // kilocode_change
import { configFailure } from "@/kilocode/server/config-failure" // kilocode_change
import { isHotPatch } from "@/kilocode/config/hot-keys" // kilocode_change
import { InstanceStore } from "@/project/instance-store" // kilocode_change

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service
    const gate = Option.getOrElse(yield* Effect.serviceOption(GenerationGate.Service), () => GenerationGate.noop) // kilocode_change
    const store = yield* InstanceStore.Service // kilocode_change

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      const instance = yield* InstanceState.context
      const hot = isHotPatch(ctx.payload as unknown as Record<string, unknown>)
      if (hot) {
        yield* configFailure(configSvc.update(ctx.payload))
        return ctx.payload
      }
      return yield* withWriteTicket({
        acquire: gate.beginWrite(instance.directory),
        run: (ticket) =>
          Effect.gen(function* () {
            const old = yield* store.snapshot(instance.directory)
            // kilocode_change start - emit:false defers the ConfigUpdated publish
            // so withWriteTicket emits it only after the rebuild registration
            // handoff owns the writer ticket (LOCK-002).
            const exit = yield* configFailure(configSvc.update(ctx.payload, { emit: false })).pipe(Effect.exit)
            // kilocode_change end
            if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause)
            return {
              changed: exit.value.changed,
              value: ctx.payload,
              rebuild: exit.value.changed ? ConfigRebuild.rebuildInstance(ticket, old) : undefined,
              event: exit.value.changed ? configSvc.emitUpdated(instance.directory) : undefined, // kilocode_change
            }
          }),
      })
    })

    // kilocode_change start
    const warnings = Effect.fn("ConfigHttpApi.warnings")(function* () {
      return yield* configSvc.warnings()
    })
    // kilocode_change end

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      // kilocode_change start
      const config = yield* configSvc.get()
      const providers = filterPromptTrainingModels(
        yield* providerSvc.list(),
        config.hide_prompt_training_models === true,
      )
      const defaults = Provider.defaultModelIDs(nonEmptyProviders(providers))
      // kilocode_change end

      // kilocode_change start - Fetch default model from Kilo API when the kilo provider is available.
      if (providers[ProviderV2.ID.kilo]) {
        const auth = yield* Auth.Service
        const info = yield* auth.get("kilo").pipe(Effect.mapError(() => new HttpApiError.Unauthorized({}))) // kilocode_change
        const token = info?.type === "oauth" ? info.access : info?.key
        const organizationId = info?.type === "oauth" ? info.accountId : undefined
        const model = yield* Effect.promise(() => fetchDefaultModel(token, organizationId))
        if (model && providers[ProviderV2.ID.kilo]?.models[model]) defaults[ProviderV2.ID.kilo] = ModelV2.ID.make(model)
      }
      // kilocode_change end

      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: defaults,
      }
    })

    return handlers
      .handle("get", get)
      .handle("update", update)
      .handle("warnings", warnings)
      .handle("providers", providers) // kilocode_change
  }),
)
