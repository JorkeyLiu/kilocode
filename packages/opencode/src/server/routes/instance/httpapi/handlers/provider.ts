import { ProviderAuth } from "@/provider/auth"
import { Config } from "@/config/config"
import * as ModelsDev from "@/provider/models" // kilocode_change - use Kilo wrapper for defect protection
import { Provider } from "@/provider/provider"

import { mapValues, pickBy } from "remeda" // kilocode_change
import { ModelCache } from "@/provider/model-cache" // kilocode_change
import {
  invalidateAfterProviderAuthChange, // kilocode_change
  invalidatePresence,
} from "@/kilocode/server/provider-auth-lifecycle" // kilocode_change
import { filterPromptTrainingModels } from "@/kilocode/provider/model-filter" // kilocode_change
import { overlay as overlayAnacondaDesktop } from "@/kilocode/anaconda-desktop/provider" // kilocode_change
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderAuthApiError } from "../groups/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"

function mapProviderAuthError<A, R>(self: Effect.Effect<A, ProviderAuth.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => {
      if (error instanceof ProviderAuth.OauthMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCodeMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCallbackFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: {} })
      }
      if (error instanceof ProviderAuth.ValidationFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: { field: error.field, message: error.message } })
      }
      return new ProviderAuthApiError({ name: "BadRequest", data: { message: error.message } }) // kilocode_change
    }),
  )
}

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "provider", (handlers) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const provider = yield* Provider.Service
    const svc = yield* ProviderAuth.Service
    const cache = yield* ModelCache.Service // kilocode_change

    const list = Effect.fn("ProviderHttpApi.list")(function* () {
      const config = yield* cfg.get()
      // kilocode_change start - catalog comes from the Kilo ModelsDev wrapper which
      // already catches core service defects (timeout, network, etc.) and falls
      // back to an empty catalog.  No defense-in-depth catchDefect needed here.
      const all = yield* ModelsDev.Service.use((s) => s.get())
      const overlaid = overlayAnacondaDesktop(all)
      // kilocode_change end
      const disabled = new Set(config.disabled_providers ?? [])
      const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
      const filtered: Record<string, (typeof overlaid)[string]> = {}
      for (const [key, value] of Object.entries(overlaid)) {
        if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) filtered[key] = value
      }
      const connected = yield* provider.list()
      // kilocode_change start
      const providers = filterPromptTrainingModels(
        Object.assign(
          mapValues(filtered, (item) => Provider.fromModelsDevProvider(item)),
          connected,
        ),
        config.hide_prompt_training_models === true,
      )
      // kilocode_change end
      // kilocode_change start
      const failed = yield* cache.failedProviders()
      // Note: connected only contains providers with non-empty models after Provider.Service.list(),
      // so failed must be checked explicitly for providers whose fetch returned an error.
      const failedSet = new Set(failed)
      const validProviders = pickBy(
        providers,
        (item, id) => Object.keys(item.models).length > 0 || id in connected || failedSet.has(id),
      )
      return {
        all: Object.values(validProviders).map((item) => Provider.toPublicInfo(item)),
        default: Provider.defaultModelIDs(pickBy(validProviders, (item) => Object.keys(item.models).length > 0)),
        connected: Object.keys(connected),
        failed,
      }
      // kilocode_change end
    })

    const auth = Effect.fn("ProviderHttpApi.auth")(function* () {
      return yield* svc.methods()
    })

    const authorize = Effect.fn("ProviderHttpApi.authorize")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.AuthorizeInput
    }) {
      return yield* mapProviderAuthError(
        svc.authorize({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          inputs: ctx.payload.inputs,
        }),
      )
    })

    const authorizeRaw = Effect.fn("ProviderHttpApi.authorizeRaw")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderAuth.AuthorizeInput))(body).pipe(
        Effect.mapError(() => new ProviderAuthApiError({ name: "BadRequest", data: {} })),
      )
      // Match legacy route behavior: when authorize() resolves without a
      // result (e.g. no further redirect), serialize as JSON `null` instead
      // of an empty body so clients can `.json()` parse the response.
      const result = yield* authorize({ params: ctx.params, payload })
      return HttpServerResponse.jsonUnsafe(result ?? null)
    })

    const callback = Effect.fn("ProviderHttpApi.callback")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.CallbackInput
    }) {
      // kilocode_change start - OAuth persistence + invalidation under one canonical gate ticket
      yield* invalidateAfterProviderAuthChange(
        ctx.params.providerID,
        Effect.gen(function* () {
          yield* mapProviderAuthError(
            svc.callback({
              providerID: ctx.params.providerID,
              method: ctx.payload.method,
              code: ctx.payload.code,
            }),
          )
          if (ctx.params.providerID === "kilo") yield* invalidatePresence()
        }),
        // kilocode_change - LOCK-003: the OAuth callback (connect) also removes
        // the target ID from disabled_providers under the same ticket/lifecycle —
        // one backend mutation, exactly one rebuild/event.
        { cleanupDisabled: true },
      )
      // kilocode_change end
      return true
    })

    return handlers
      .handle("list", list)
      .handle("auth", auth)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
  }),
)
