import {
  fetchKiloImageModels,
  getOrganizationId,
  getToken,
} from "@kilocode/kilo-gateway"
import {
  HEADER_FEATURE,
  KILO_API_BASE,
  clearModesCache,
  fetchBalance,
  fetchKilocodeNotifications,
  fetchKiloPassState,
  fetchOrganizationModes,
  fetchProfile,
} from "@kilocode/kilo-gateway"
import { buildKiloHeaders } from "@kilocode/kilo-gateway"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as Log from "@opencode-ai/core/util/log"
import { Auth } from "@/auth"
import { invalidateAfterProviderAuthChange } from "@/kilocode/server/provider-auth-lifecycle"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { AudioTranscriptionsBody } from "../groups/kilo-gateway"

const log = Log.create({ service: "kilo-gateway" })

export const kiloGatewayHandlers = HttpApiBuilder.group(InstanceHttpApi, "kilo", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const profile = Effect.fn("KiloGatewayHttpApi.profile")(function* () {
      const info = yield* auth.get("kilo").pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      if (!info || info.type !== "oauth") return yield* Effect.fail(new HttpApiError.Unauthorized({}))

      const currentOrgId = info.accountId ?? null
      const [profile, balance, kiloPass] = yield* Effect.tryPromise({
        try: () =>
          Promise.all([
            fetchProfile(info.access),
            fetchBalance(info.access, currentOrgId ?? undefined),
            fetchKiloPassState(info.access),
          ]),
        catch: () => new HttpApiError.BadRequest({}),
      })
      return { profile, balance, kiloPass, currentOrgId }
    })

    const authStatus = Effect.fn("KiloGatewayHttpApi.authStatus")(function* () {
      const info = yield* auth.get("kilo").pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      const type = getToken(info) && (info?.type === "api" || info?.type === "oauth") ? info.type : undefined
      if (!type) return { authenticated: false }
      return { authenticated: true, type }
    })

    const proxyAuth = Effect.fn("KiloGatewayHttpApi.proxyAuth")(function* () {
      const info = yield* auth.get("kilo").pipe(Effect.mapError(() => new HttpApiError.Unauthorized({})))
      return {
        auth: info,
        token: getToken(info),
        organizationId: getOrganizationId(info),
      }
    })

    const modes = Effect.fn("KiloGatewayHttpApi.modes")(function* () {
      const info = yield* auth.get("kilo").pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!info || info.type !== "oauth" || !info.access || !info.accountId) return { modes: [] }

      const org = info.accountId
      return yield* Effect.promise(() => fetchOrganizationModes(info.access, org)).pipe(
        Effect.map((modes) => ({ modes })),
        Effect.catch(() => Effect.succeed({ modes: [] })),
      )
    })

    const audioTranscriptions = Effect.fn("KiloGatewayHttpApi.audioTranscriptions")(function* (ctx: {
      payload: typeof AudioTranscriptionsBody.Type
    }) {
      const info = yield* proxyAuth()
      if (!info.auth) return yield* Effect.fail(new HttpApiError.Unauthorized({}))
      if (!info.token) return yield* Effect.fail(new HttpApiError.Unauthorized({}))

      const request = yield* HttpServerRequest.HttpServerRequest
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(`${KILO_API_BASE}/api/gateway/v1/audio/transcriptions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${info.token}`,
              ...buildKiloHeaders(undefined, { kilocodeOrganizationId: info.organizationId }),
              [HEADER_FEATURE]: "vscode-extension",
            },
            signal: request.source instanceof Request ? request.source.signal : undefined,
            body: JSON.stringify(ctx.payload),
          }),
        catch: () => new HttpApiError.BadRequest({}),
      })
      const text = yield* Effect.promise(() => response.text())
      return HttpServerResponse.raw(text, {
        status: response.status,
        contentType: response.headers.get("Content-Type") ?? "application/json",
      })
    })

    const notifications = Effect.fn("KiloGatewayHttpApi.notifications")(function* () {
      const info = yield* auth.get("kilo").pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      const token = getToken(info)
      if (!token) return []

      const cloud = yield* Effect.promise(() =>
        fetchKilocodeNotifications({
          kilocodeToken: token,
          kilocodeOrganizationId: getOrganizationId(info),
        }),
      )
      return cloud
    })

    const organization = Effect.fn("KiloGatewayHttpApi.organization")(function* (ctx) {
      // kilocode_change start - LOCK-002: read the current kilo auth record
      // INSIDE the coordinator mutate, under the convergence fence and
      // immediately before the set, so a concurrent newer credential can never
      // be overwritten by a pre-fence snapshot. The unauthorized response
      // behavior and the modes-cache clear are unchanged; the coordinator
      // restores the exact auth artifact if the set fails.
      yield* invalidateAfterProviderAuthChange(
        "kilo",
        Effect.gen(function* () {
          const info = yield* auth.get("kilo").pipe(Effect.mapError(() => new HttpApiError.Unauthorized({})))
          if (!info || info.type !== "oauth") return yield* Effect.fail(new HttpApiError.Unauthorized({}))

          yield* auth
            .set("kilo", {
              type: "oauth",
              refresh: info.refresh,
              access: info.access,
              expires: info.expires,
              ...(ctx.payload.organizationId && { accountId: ctx.payload.organizationId }),
            })
            .pipe(Effect.mapError(() => new HttpApiError.Unauthorized({})))
          yield* Effect.sync(() => clearModesCache())
        }),
      )
      // kilocode_change end
      return true
    })

    const imageModels = Effect.fn("KiloGatewayHttpApi.imageModels")(function* () {
      const info = yield* proxyAuth()
      if (!info.auth) return yield* Effect.fail(new HttpApiError.Unauthorized({}))
      if (!info.token) return yield* Effect.fail(new HttpApiError.Unauthorized({}))

      const result = yield* Effect.tryPromise({
        try: () =>
          fetchKiloImageModels({
            kilocodeToken: info.token,
            kilocodeOrganizationId: info.organizationId,
          }),
        catch: () => new HttpApiError.BadRequest({}),
      })

      if (result.error) {
        const err =
          result.error.kind === "unauthorized" ? new HttpApiError.Unauthorized({}) : new HttpApiError.BadRequest({})
        return yield* Effect.fail(err)
      }

      return result.models
    })

    return handlers
      .handle("profile", profile)
      .handle("authStatus", authStatus)
      .handle("modes", modes)
      .handle("audioTranscriptions", audioTranscriptions)
      .handle("imageModels", imageModels)
      .handle("notifications", notifications)
      .handle("organization", organization)
  }),
)
