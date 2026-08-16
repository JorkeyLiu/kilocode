import {
  GatewayError,
  fetchKiloImageModels,
  getOrganizationId,
  getToken,
} from "@kilocode/kilo-gateway"
import {
  HEADER_FEATURE,
  HEADER_ORGANIZATIONID,
  KILO_API_BASE,
  clearModesCache,
  fetchBalance,
  fetchKilocodeNotifications,
  fetchKiloPassState,
  fetchOrganizationModes,
  fetchProfile,
} from "@kilocode/kilo-gateway"
import { DIRECT_FIM_ENV, requestMistralFim, resolveFimTarget } from "@kilocode/kilo-gateway/fim"
import { DIRECT_EDIT_ENV, extractFencedBody, resolveEditTarget } from "@kilocode/kilo-gateway/edit"
import { buildMercuryEditPrompt } from "@kilocode/kilo-gateway/edit-prompt"
import { buildKiloHeaders } from "@kilocode/kilo-gateway"
import { Effect, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as Log from "@opencode-ai/core/util/log"
import { Flag } from "@opencode-ai/core/flag/flag"
import { KilocodeConfig } from "@/kilocode/config/config"
import { Auth } from "@/auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Instance } from "@/kilocode/instance"
import { invalidateAfterProviderAuthChange } from "@/kilocode/server/provider-auth-lifecycle"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Session } from "@/session/session"
import { AudioTranscriptionsBody, EditBody, FimBody } from "../groups/kilo-gateway"

const FIM_TIMEOUT_MS = 30_000
const log = Log.create({ service: "kilo-gateway" })

function jsonError(error: string, status: number) {
  return HttpServerResponse.jsonUnsafe({ error }, { status })
}

function logError(route: string, err: unknown) {
  log.error("unhandled error", { route, err })
}

export const kiloGatewayHandlers = HttpApiBuilder.group(InstanceHttpApi, "kilo", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const events = yield* EventV2Bridge.Service

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

    const fim = Effect.fn("KiloGatewayHttpApi.fim")(function* (ctx: { payload: typeof FimBody.Type }) {
      const target = resolveFimTarget(ctx.payload.provider, ctx.payload.model)
      const info = target.provider === "kilo" ? yield* proxyAuth() : undefined
      const token = yield* Effect.gen(function* () {
        if (target.provider === "kilo") return info?.token
        const item = yield* auth.get(target.provider).pipe(Effect.mapError(() => new HttpApiError.Unauthorized({})))
        if (item?.type === "api") return item.key
        return DIRECT_FIM_ENV[target.provider].map((key) => process.env[key]).find(Boolean)
      })

      if (target.provider === "kilo" && !info?.auth) return yield* Effect.fail(new HttpApiError.Unauthorized({}))
      if (!token) return yield* Effect.fail(new HttpApiError.Unauthorized({}))

      const request = yield* HttpServerRequest.HttpServerRequest
      const signal =
        request.source instanceof Request
          ? AbortSignal.any([request.source.signal, AbortSignal.timeout(FIM_TIMEOUT_MS)])
          : AbortSignal.timeout(FIM_TIMEOUT_MS)
      const response = yield* Effect.promise(async () => {
        try {
          const run = async (url: string): Promise<Response> => {
            console.info(`[FIM] request provider=${target.provider} model=${target.model} url=${url}`)
            return fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
                ...(target.provider === "kilo"
                  ? buildKiloHeaders(undefined, { kilocodeOrganizationId: info?.organizationId })
                  : {}),
                ...(target.provider === "kilo" ? { [HEADER_FEATURE]: "autocomplete" } : {}),
              },
              signal,
              body: JSON.stringify({
                model: target.model,
                prompt: ctx.payload.prefix,
                suffix: ctx.payload.suffix,
                max_tokens: ctx.payload.maxTokens ?? 256,
                temperature: ctx.payload.temperature ?? 0.2,
                stream: true,
              }),
            })
          }
          if (target.provider === "mistral") return requestMistralFim(run)
          return run(target.url)
        } catch (err) {
          if (err instanceof DOMException && err.name === "TimeoutError")
            return Response.json({ error: "FIM request timed out" }, { status: 504 })
          if (signal.aborted) return Response.json({ error: "FIM request canceled" }, { status: 499 })
          throw err
        }
      })
      if (!response.ok) {
        const text = yield* Effect.promise(() => response.text())
        return HttpServerResponse.jsonUnsafe(
          { error: `FIM request failed: ${response.status} ${text}` },
          { status: response.status },
        )
      }
      if (!response.body) return HttpServerResponse.raw(null, { status: response.status })

      return HttpServerResponse.stream(
        Stream.fromReadableStream({
          evaluate: () => response.body!,
          onError: (err) => err,
        }),
        {
          contentType: "text/event-stream",
          headers: {
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        },
      )
    })

    const edit = Effect.fn("KiloGatewayHttpApi.edit")(function* (ctx: { payload: typeof EditBody.Type }) {
      const target = resolveEditTarget(ctx.payload.provider, ctx.payload.model)
      if (target.provider === "kilo" && !target.url) {
        return yield* Effect.fail(new HttpApiError.BadRequest({}))
      }
      const proxy = target.provider === "kilo" ? yield* proxyAuth() : undefined
      const token = yield* Effect.gen(function* () {
        if (target.provider === "kilo") return proxy?.token
        const item = yield* auth.get(target.provider).pipe(Effect.mapError(() => new HttpApiError.Unauthorized({})))
        if (item?.type === "api") return item.key
        return DIRECT_EDIT_ENV[target.provider].map((key) => process.env[key]).find(Boolean)
      })
      if (target.provider === "kilo" && !proxy?.auth) return yield* Effect.fail(new HttpApiError.Unauthorized({}))
      if (!token) return yield* Effect.fail(new HttpApiError.Unauthorized({}))

      const request = yield* HttpServerRequest.HttpServerRequest
      const signal =
        request.source instanceof Request
          ? AbortSignal.any([request.source.signal, AbortSignal.timeout(FIM_TIMEOUT_MS)])
          : AbortSignal.timeout(FIM_TIMEOUT_MS)

      // Assemble the Mercury sentinel prompt from the structured context the
      // client sent — same builder every editor frontend shares.
      const content = buildMercuryEditPrompt({
        currentFilePath: ctx.payload.currentFilePath,
        currentFileContent: ctx.payload.currentFileContent,
        cursorLine: ctx.payload.cursorLine,
        cursorCharacter: ctx.payload.cursorCharacter,
        editableRegionStartLine: ctx.payload.editableRegionStartLine,
        editableRegionEndLine: ctx.payload.editableRegionEndLine,
        recentlyViewedSnippets: [...ctx.payload.recentlyViewedSnippets],
        editDiffHistory: [...ctx.payload.editDiffHistory],
      })

      const response = yield* Effect.promise(async () => {
        try {
          return await fetch(target.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
              ...(target.provider === "kilo"
                ? buildKiloHeaders(undefined, { kilocodeOrganizationId: proxy?.organizationId })
                : {}),
              ...(target.provider === "kilo" ? { [HEADER_FEATURE]: "autocomplete" } : {}),
            },
            signal,
            body: JSON.stringify({
              model: target.model,
              max_tokens: ctx.payload.maxTokens ?? 512,
              // Mercury rejects role:"system" on this endpoint — must be a single user message.
              messages: [{ role: "user", content }],
            }),
          })
        } catch (err) {
          if (err instanceof DOMException && err.name === "TimeoutError")
            return Response.json({ error: "Edit request timed out" }, { status: 504 })
          if (signal.aborted) return Response.json({ error: "Edit request canceled" }, { status: 499 })
          throw err
        }
      })

      if (!response.ok) {
        // Pass the upstream status through (mirrors the FIM handler) so the
        // client can distinguish auth/credit/rate-limit/server failures
        // instead of collapsing everything to 400.
        const text = yield* Effect.promise(async () => {
          try {
            return await response.text()
          } catch {
            return "<unreadable>"
          }
        })
        return HttpServerResponse.jsonUnsafe(
          { error: `Edit request failed: ${response.status} ${text}` },
          { status: response.status },
        )
      }

      const json = yield* Effect.promise(
        () =>
          response.json() as Promise<{
            choices?: Array<{ message?: { content?: string } }>
            usage?: { prompt_tokens?: number; completion_tokens?: number }
          }>,
      )
      const raw = json.choices?.[0]?.message?.content ?? ""
      const body = extractFencedBody(raw)
      return {
        content: body,
        usage: json.usage
          ? {
              prompt_tokens: json.usage.prompt_tokens,
              completion_tokens: json.usage.completion_tokens,
            }
          : undefined,
      }
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
      // Locally-detected notice about leftover opencode config; appended so it reuses each client's dismissal path.
      const notice = KilocodeConfig.opencodeConfigNotification({
        directory: Instance.directory,
        worktree: Instance.worktree,
        scanProject: !Flag.KILO_DISABLE_PROJECT_CONFIG,
      })
      const append = <T>(list: T[]) => (notice ? [...list, notice] : list)

      const info = yield* auth.get("kilo").pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      const token = getToken(info)
      if (!token) return append([])

      const cloud = yield* Effect.promise(() =>
        fetchKilocodeNotifications({
          kilocodeToken: token,
          kilocodeOrganizationId: getOrganizationId(info),
        }),
      )
      return append(cloud)
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
      .handle("fim", fim)
      .handle("edit", edit)
      .handle("audioTranscriptions", audioTranscriptions)
      .handle("imageModels", imageModels)
      .handle("notifications", notifications)
      .handle("organization", organization)
  }),
)
