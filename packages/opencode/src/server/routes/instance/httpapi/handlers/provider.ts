import { ProviderAuth } from "@/provider/auth"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { fetchProviderCatalogData } from "@/kilocode/provider-catalog"
import {
  ModelDiscoveryError,
  fetchModelsWithKey,
  isDiscoveryCredentialAllowed,
  isStrictBaseURL,
  normalizeBaseURL,
} from "@/provider/model-discovery"

import { pickBy } from "remeda" // kilocode_change
import { invalidateAfterProviderAuthChange } from "@/kilocode/server/provider-auth-lifecycle" // kilocode_change
import { filterPromptTrainingModels } from "@/kilocode/provider/model-filter" // kilocode_change
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderAuthApiError, ProviderModelsApiError } from "../groups/provider"
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

    const list = Effect.fn("ProviderHttpApi.list")(function* () {
      const config = yield* cfg.get()
      const connected = yield* provider.list()
      const providers = filterPromptTrainingModels(connected, config.hide_prompt_training_models === true)
      const failed: string[] = []
      const validProviders = pickBy(
        providers,
        (item, id) => Object.keys(item.models).length > 0 || id in connected,
      )
      return {
        all: Object.values(validProviders).map((item) => Provider.toPublicInfo(item)),
        default: Provider.defaultModelIDs(pickBy(validProviders, (item) => Object.keys(item.models).length > 0)),
        connected: Object.keys(connected),
        failed,
      }
    })

    const catalog = Effect.fn("ProviderHttpApi.catalog")(function* () {
      return yield* fetchProviderCatalogData()
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
      const result = yield* authorize({ params: ctx.params, payload })
      return HttpServerResponse.jsonUnsafe(result ?? null)
    })

    const callback = Effect.fn("ProviderHttpApi.callback")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.CallbackInput
    }) {
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
        }),
        { cleanupDisabled: true },
      )
      return true
    })

    const models = Effect.fn("ProviderHttpApi.models")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: { baseURL: string }
    }) {
      const fail = (name: "BadRequest" | "Unauthorized" | "InvalidResponse" | "UpstreamError", message: string) =>
        new ProviderModelsApiError({ name, data: { providerID: ctx.params.providerID, message } })
      const providerID = String(ctx.params.providerID ?? "").trim()
      const requestedBaseURL = typeof ctx.payload.baseURL === "string" ? ctx.payload.baseURL : ""
      if (!providerID) return yield* Effect.fail(fail("BadRequest", "Provider model discovery request is invalid"))
      // Strict URL shape on the request URL first: plain http(s) only, no
      // embedded credentials, query, or fragment.
      if (!isStrictBaseURL(requestedBaseURL)) {
        return yield* Effect.fail(fail("BadRequest", "Provider model discovery request is invalid"))
      }
      const connected = yield* provider.list()
      const target = connected[providerID as keyof typeof connected]
      if (!target) return yield* Effect.fail(fail("BadRequest", "Provider model discovery request is invalid"))
      const raw = target as unknown as Record<string, unknown>
      const allowed = isDiscoveryCredentialAllowed({
        providerID,
        source: raw.source,
        key: raw.key,
        env: raw.env,
      })
      if (!allowed) return yield* Effect.fail(fail("BadRequest", "Provider model discovery request is invalid"))
      const storedBaseURL =
        raw.options && typeof raw.options === "object" && !Array.isArray(raw.options)
          ? (raw.options as Record<string, unknown>).baseURL
          : undefined
      // Stored URL must satisfy the same strict shape; the request itself is
      // served from the stored URL, never from request text.
      if (typeof storedBaseURL !== "string" || !isStrictBaseURL(storedBaseURL)) {
        return yield* Effect.fail(fail("BadRequest", "Provider model discovery request is invalid"))
      }
      // Exact stored baseURL match keeps the stored key from being sent to an
      // arbitrary host (e.g. after the user edits the URL field). User input
      // headers are never accepted here, so no stored key injection is possible.
      if (normalizeBaseURL(storedBaseURL) !== normalizeBaseURL(requestedBaseURL)) {
        return yield* Effect.fail(fail("BadRequest", "Provider model discovery request is invalid"))
      }
      const key = raw.key as string
      const discovered = yield* Effect.tryPromise({
        try: () => fetchModelsWithKey({ baseURL: normalizeBaseURL(storedBaseURL), key }),
        catch: (cause) => {
          if (cause instanceof ModelDiscoveryError) {
            if (cause.kind === "auth") return fail("Unauthorized", cause.message)
            if (cause.kind === "invalid") return fail("InvalidResponse", cause.message)
            return fail("UpstreamError", cause.message)
          }
          return fail("UpstreamError", "Provider models request failed")
        },
      })
      return { models: discovered }
    })

    return handlers
      .handle("list", list)
      .handle("catalog", catalog)
      .handle("auth", auth)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
      .handle("models", models)
  }),
)
