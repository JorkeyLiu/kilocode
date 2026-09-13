import {
  fetchKiloImageModels,
  getOrganizationId,
  getToken,
} from "@kilocode/kilo-gateway"
import {
  HEADER_FEATURE,
  KILO_API_BASE,
  fetchKilocodeNotifications,
  fetchOrganizationModes,
} from "@kilocode/kilo-gateway"
import { buildKiloHeaders } from "@kilocode/kilo-gateway"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as Log from "@opencode-ai/core/util/log"
import { Auth } from "@/auth"
import {
  KiloProfileUnauthorized,
  fetchKiloProfileData,
} from "@/kilocode/kilo-profile"
import { organizationSetMutate } from "@/kilocode/organization-set-private"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { AudioTranscriptionsBody } from "../groups/kilo-gateway"

const log = Log.create({ service: "kilo-gateway" })

export const kiloGatewayHandlers = HttpApiBuilder.group(InstanceHttpApi, "kilo", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const profile = Effect.fn("KiloGatewayHttpApi.profile")(function* () {
      // kilocode_change: shared `fetchKiloProfileData` body (same Auth +
      // gateway fetches as the private `kilo/profile` op). External
      // behavior/error mapping is unchanged: only explicit local
      // missing/non-oauth stays `Unauthorized`; auth-store failure, gateway
      // shape failure, and every gateway fetch failure (including the
      // gateway's own invalid-token 401/403) stay `BadRequest`.
      const data = yield* fetchKiloProfileData().pipe(
        Effect.mapError((e: unknown) =>
          e instanceof KiloProfileUnauthorized ? new HttpApiError.Unauthorized({}) : new HttpApiError.BadRequest({}),
        ),
        Effect.catchDefect(() => new HttpApiError.BadRequest({})),
      )
      return data
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
      // kilocode_change start - LOCK-002: the organization mutation body lives
      // in the shared `organizationSetMutate` (fence-internal `Auth.get`,
      // credential preservation, `clearModesCache` in mutate) so the HTTP and
      // private `kilo/organization/set` transports cannot drift. The
      // unauthorized response behavior is unchanged; the coordinator restores
      // the exact auth artifact if the set fails.
      yield* organizationSetMutate(ctx.payload.organizationId).pipe(
        Effect.mapError(() => new HttpApiError.Unauthorized({})),
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
