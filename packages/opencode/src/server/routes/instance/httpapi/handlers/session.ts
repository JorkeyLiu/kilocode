import { Image } from "@/image/image" // kilocode_change - classify user image validation defects
import { KiloSessionHttpApi } from "@/kilocode/server/httpapi/session-fork" // kilocode_change
import { BlockedError as AgentRequirementError } from "@/kilocode/agent-requirements" // kilocode_change
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { KiloViewers } from "@/kilocode/presence/service" // kilocode_change
import { CancelQueuedDispatchService, type CancelQueuedResult } from "@/kilocode/session/cancel-queued-dispatch" // kilocode_change - P4.4-G3-B0
import { SessionUpdateDispatchService, type SessionUpdateResult } from "@/kilocode/session/session-update-dispatch" // kilocode_change - P4.4-G3-B2 durable title
import { SessionForkDispatchService, type SessionForkResult } from "@/kilocode/session/session-fork-dispatch" // kilocode_change - P4.4-G3-B3 fork
import { SessionCreateDispatchService, type SessionCreateResult } from "@/kilocode/session/session-create-dispatch" // kilocode_change - P4.4-G3-B4 create
import { SessionDeleteDispatchService } from "@/kilocode/session/session-delete-dispatch" // kilocode_change - P4.4-G3-B5 delete
import { canonicalDirectory } from "@/kilocode/session/canonical-directory" // kilocode_change - P4.4-G3 double directory contract
import { forkTargetDirectory } from "@/kilocode/server/routes/fork-routing" // kilocode_change - P4.4-G3 double directory contract
import { WorkspaceRouteContext } from "../middleware/workspace-routing" // kilocode_change - P4.4-G3-B4 effective directory
import { SessionOperation } from "@opencode-ai/core/session/operation" // kilocode_change - LOCK-201 canonical opId
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Command } from "@/command"
import { Permission } from "@/permission"
import { SessionShare } from "@/share/session"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { NamedError } from "@opencode-ai/core/util/error"
import { Cause, Effect, Option, Schema, Scope } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  CommandPayload,
  DeletePayload,
  DiffQuery,
  ForkPayload,
  InitPayload,
  ListQuery,
  MessagesQuery,
  PermissionResponsePayload,
  PromptPayload,
  RevertPayload,
  ShellPayload,
  UpdatePayload,
  ViewedPayload, // kilocode_change
} from "../groups/session"
import { ApiNotFoundError, PermissionNotFoundError } from "../errors"
import * as SessionError from "./session-errors"

const tryParseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new HttpApiError.BadRequest({}),
  })

export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const shareSvc = yield* SessionShare.Service
    const promptSvc = yield* SessionPrompt.Service
    const revertSvc = yield* SessionRevert.Service
    const runState = yield* SessionRunState.Service
    const permissionSvc = yield* Permission.Service
    const statusSvc = yield* SessionStatus.Service
    const todoSvc = yield* Todo.Service
    const summary = yield* SessionSummary.Service
    const events = yield* EventV2Bridge.Service
    const viewers = yield* KiloViewers.Service // kilocode_change
    const scope = yield* Scope.Scope

    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      return yield* session.list({
        directory: ctx.query.scope === "project" ? undefined : ctx.query.directory,
        scope: ctx.query.scope,
        path: ctx.query.path,
        roots: ctx.query.roots,
        start: ctx.query.start,
        search: ctx.query.search,
        limit: ctx.query.limit,
      })
    })

    const status = Effect.fn("SessionHttpApi.status")(function* () {
      return Object.fromEntries(yield* statusSvc.list())
    })

    const requireSession = Effect.fn("SessionHttpApi.requireSession")(function* (sessionID: SessionID) {
      return yield* SessionError.mapStorageNotFound(session.get(sessionID))
    })

    const get = Effect.fn("SessionHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* requireSession(ctx.params.sessionID)
    })

    const children = Effect.fn("SessionHttpApi.children")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* session.children(ctx.params.sessionID)
    })

    const todo = Effect.fn("SessionHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* todoSvc.get(ctx.params.sessionID)
    })

    const diff = Effect.fn("SessionHttpApi.diff")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffQuery.Type
    }) {
      return yield* summary.diff({ sessionID: ctx.params.sessionID, messageID: ctx.query.messageID })
    })

    const messages = Effect.fn("SessionHttpApi.messages")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MessagesQuery.Type
    }) {
      if (ctx.query.before && ctx.query.limit === undefined) return yield* new HttpApiError.BadRequest({})
      if (ctx.query.before) {
        const before = ctx.query.before
        yield* Effect.try({
          try: () => MessageV2.cursor.decode(before),
          catch: () => new HttpApiError.BadRequest({}),
        })
      }
      yield* requireSession(ctx.params.sessionID)
      if (ctx.query.limit === undefined || ctx.query.limit === 0) {
        return yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      }

      const page = yield* SessionError.mapStorageNotFound(
        MessageV2.page({
          sessionID: ctx.params.sessionID,
          limit: ctx.query.limit,
          before: ctx.query.before,
        }),
      )
      if (!page.cursor) return page.items

      const request = yield* HttpServerRequest.HttpServerRequest
      // toURL() honors the Host + x-forwarded-proto headers, so the Link
      // header echoes the real origin instead of a hard-coded localhost.
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      url.searchParams.set("limit", ctx.query.limit.toString())
      url.searchParams.set("before", page.cursor)
      return HttpServerResponse.jsonUnsafe(page.items, {
        headers: {
          "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
          Link: `<${url.toString()}>; rel="next"`,
          "X-Next-Cursor": page.cursor,
        },
      })
    })

    const message = Effect.fn("SessionHttpApi.message")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      return yield* SessionError.mapStorageNotFound(
        MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
      )
    })

    const sessionCreateDispatch = yield* SessionCreateDispatchService // kilocode_change - P4.4-G3-B4
    const create = Effect.fn("SessionHttpApi.create")(function* (ctx: { payload?: Session.CreateInput }) {
      // durable create path: if payload contains durable identity, route to dispatch
      const p = ctx.payload as unknown as Record<string, unknown> | undefined
      const isDurable = p && (p.idempotencyKey !== undefined || p.requestId !== undefined || p.opId !== undefined || p.context !== undefined)
      if (isDurable) {
        const pp = p as Record<string, unknown>
        const context = pp.context as Record<string, unknown> | undefined
        // double-directory fail-closed: route directory vs body directory must canonical-equivalent
        // Effective directory is the middleware-bound WorkspaceRouteContext (default/workspace-resolved), not just explicit query/header.
        {
          const routeOpt = yield* Effect.serviceOption(WorkspaceRouteContext)
          const reqOpt = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
          let effectiveDir: string | undefined
          if (Option.isSome(routeOpt)) {
            effectiveDir = routeOpt.value.directory
          } else if (Option.isSome(reqOpt)) {
            const httpReq = reqOpt.value
            const url = new URL(httpReq.url, "http://localhost")
            const rawRoute = url.searchParams.get("directory") || (httpReq.headers as Record<string, string | undefined>)["x-kilo-directory"]
            if (rawRoute) {
              const tryDecode = (v: string) => {
                try {
                  return v.includes("%") ? decodeURIComponent(v) : v
                } catch {
                  return v
                }
              }
              effectiveDir = tryDecode(rawRoute)
            } else {
              effectiveDir = process.cwd()
            }
          } else {
            effectiveDir = process.cwd()
          }
          if (context?.directory && effectiveDir) {
            try {
              const canonRoute = canonicalDirectory(effectiveDir)
              const canonBody = canonicalDirectory(context.directory as string)
              if (canonRoute !== canonBody) return yield* Effect.fail(new HttpApiError.BadRequest({}))
            } catch {
              return yield* Effect.fail(new HttpApiError.BadRequest({}))
            }
          } else if (context?.directory) {
            return yield* Effect.fail(new HttpApiError.BadRequest({}))
          }
        }
        const req = {
          v: 1 as const,
          requestId: pp.requestId as string,
          opId: pp.opId as string,
          op: "session/create" as const,
          idempotencyKey: pp.idempotencyKey as string,
          context: {
            directory: context?.directory as string,
            parentSessionId: (context?.parentSessionId ?? null) as string | null,
            configVersion: context?.configVersion as number | undefined,
          },
          payload: {
            title: (pp.title as string | null) ?? null,
            parentID: (pp.parentID as string | null) ?? null,
            agent: (pp.agent as string | null) ?? null,
            model: (pp.model as { id: string; providerID: string; variant?: string } | null) ?? null,
            metadata: (pp.metadata as Record<string, unknown> | null) ?? null,
            permission: (pp.permission as unknown | null) ?? null,
            platform: (pp.platform as string | null) ?? null,
            workspaceID: (pp.workspaceID as string | null) ?? null,
            sandboxInheritanceToken: (pp.sandboxInheritanceToken as string | null) ?? null,
          },
        }
        const result = yield* (sessionCreateDispatch.dispatch(req).pipe(
          Effect.catchDefect(() => Effect.fail(new HttpApiError.InternalServerError({}))),
          Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({}))),
        ) as Effect.Effect<SessionCreateResult, HttpApiError.InternalServerError>)
        if (result.status === "succeeded") return result.data
        if (result.status === "failed") {
          if (result.failure.code === "validation.failed") return yield* Effect.fail(new HttpApiError.BadRequest({}))
          if (result.failure.code === "scope_mismatch") return yield* Effect.fail(new HttpApiError.BadRequest({}))
          if (result.failure.code === "stale" || result.failure.code === "conflict") return yield* Effect.fail(new HttpApiError.Conflict({}))
          if (result.failure.code === "InstanceUnavailableDuringConfigRebuild") return yield* Effect.fail(new HttpApiError.Conflict({}))
          if (result.failure.code === "internal") return yield* Effect.fail(new HttpApiError.InternalServerError({}))
          return yield* Effect.fail(new HttpApiError.InternalServerError({}))
        }
        return yield* Effect.fail(new HttpApiError.InternalServerError({}))
      }
      return yield* shareSvc.create(ctx.payload)
    })

    const createRaw = Effect.fn("SessionHttpApi.createRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* create({})

      const json = yield* tryParseJson(body)
      // strict unknown-field rejection for OpenAPI additionalProperties:false parity
      if (json !== null && typeof json === "object" && !Array.isArray(json)) {
        const j = json as Record<string, unknown>
        const hasDurable = "idempotencyKey" in j || "requestId" in j || "opId" in j || "context" in j
        if (hasDurable) {
          const allowedRoot = new Set(["parentID", "title", "agent", "model", "metadata", "permission", "platform", "workspaceID", "sandboxInheritanceToken", "idempotencyKey", "requestId", "opId", "context"])
          for (const k of Object.keys(j)) if (!allowedRoot.has(k)) return yield* new HttpApiError.BadRequest({})
          const c = j.context as unknown
          if (c !== null && typeof c === "object" && !Array.isArray(c)) {
            const allowedCtx = new Set(["directory", "parentSessionId", "configVersion"])
            for (const k of Object.keys(c as Record<string, unknown>)) if (!allowedCtx.has(k)) return yield* new HttpApiError.BadRequest({})
          }
        }
      }
      const decoded = yield* Schema.decodeUnknownEffect(Session.CreateInput as unknown as Schema.Schema<unknown>)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      // If durable fields present, bypass Schema strictness and pass raw with those fields (handler create will dispatch)
      const rawObj = json as Record<string, unknown>
      const hasDurableRaw = rawObj && (rawObj.idempotencyKey !== undefined || rawObj.requestId !== undefined || rawObj.opId !== undefined || rawObj.context !== undefined)
      if (hasDurableRaw) {
        const merged = { ...(decoded as unknown as Record<string, unknown>), idempotencyKey: rawObj.idempotencyKey, requestId: rawObj.requestId, opId: rawObj.opId, context: rawObj.context } as unknown as Session.CreateInput
        return yield* create({ payload: merged })
      }
      const payload = decoded
        ? {
            ...decoded,
            permission: (decoded as unknown as { permission?: unknown }).permission ? [...(decoded as unknown as { permission: unknown[] }).permission] : undefined,
          }
        : decoded
      return yield* create({ payload: payload as unknown as Session.CreateInput })
    })

    const sessionDeleteDispatch = yield* SessionDeleteDispatchService
    const remove = Effect.fn("SessionHttpApi.remove")(function* (ctx: { params: { sessionID: SessionID }; payload?: typeof DeletePayload.Type }) {
      const p = ctx.payload as unknown as Record<string, unknown> | undefined
      const isDurable = p && (p.opId !== undefined || p.idempotencyKey !== undefined || p.requestId !== undefined || p.context !== undefined || p.directory !== undefined)
      if (isDurable) {
        if (p.opId === undefined || p.idempotencyKey === undefined || p.requestId === undefined || p.context === undefined) return yield* new HttpApiError.BadRequest({})
        const c = p.context as Record<string, unknown>
        if (typeof c.directory !== "string" || c.directory.length === 0) return yield* new HttpApiError.BadRequest({})
        if (typeof c.sessionId !== "string" || c.sessionId !== ctx.params.sessionID) return yield* new HttpApiError.BadRequest({})
        {
          const routeOpt = yield* Effect.serviceOption(WorkspaceRouteContext)
          const reqOpt = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
          let effectiveDir: string | undefined
          if (Option.isSome(routeOpt)) effectiveDir = routeOpt.value.directory
          else if (Option.isSome(reqOpt)) {
            const httpReq = reqOpt.value
            const url = new URL(httpReq.url, "http://localhost")
            const rawRoute = url.searchParams.get("directory") || (httpReq.headers as Record<string, string | undefined>)["x-kilo-directory"]
            if (rawRoute) {
              const tryDecode = (v: string) => {
                try { return v.includes("%") ? decodeURIComponent(v) : v } catch { return v }
              }
              effectiveDir = tryDecode(rawRoute)
            } else effectiveDir = process.cwd()
          } else effectiveDir = process.cwd()
          if (effectiveDir) {
            try {
              const canonRoute = canonicalDirectory(effectiveDir)
              const canonBody = canonicalDirectory(c.directory as string)
              if (canonRoute !== canonBody) return yield* new HttpApiError.BadRequest({})
            } catch { return yield* new HttpApiError.BadRequest({}) }
          }
        }
        const req = {
          v: 1 as const,
          requestId: p.requestId as string,
          opId: p.opId as string,
          op: "session/delete" as const,
          idempotencyKey: p.idempotencyKey as string,
          context: {
            directory: c.directory as string,
            sessionId: c.sessionId as string,
            parentSessionId: (c.parentSessionId ?? null) as string | null,
            configVersion: c.configVersion as number | undefined,
            sessionRevision: c.sessionRevision as number | undefined,
          },
          payload: {},
        }
        const result = yield* (sessionDeleteDispatch.dispatch(req).pipe(
          Effect.catchDefect(() => Effect.fail(new HttpApiError.InternalServerError({}))),
          Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({}))),
        ) as Effect.Effect<import("@/kilocode/session/session-delete-dispatch").SessionDeleteResult, HttpApiError.InternalServerError>)
        if (result.status === "succeeded") return true
        if (result.status === "failed") {
          if (result.failure.code === "session.not_found") return yield* Effect.fail(new ApiNotFoundError({ name: "NotFoundError", data: { message: result.failure.message } }))
          if (result.failure.code === "validation.failed") return yield* new HttpApiError.BadRequest({})
          if (result.failure.code === "scope_mismatch") return yield* new HttpApiError.BadRequest({})
          if (result.failure.code === "stale" || result.failure.code === "conflict") return yield* new HttpApiError.Conflict({})
          if (result.failure.code === "InstanceUnavailableDuringConfigRebuild") return yield* new HttpApiError.Conflict({})
          if (result.failure.code === "internal") return yield* new HttpApiError.InternalServerError({})
          return yield* new HttpApiError.InternalServerError({})
        }
        return yield* new HttpApiError.InternalServerError({})
      }
      yield* SessionError.mapStorageNotFound(session.remove(ctx.params.sessionID))
      return true
    })

    const removeRaw = Effect.fn("SessionHttpApi.removeRaw")(function* (ctx: { params: { sessionID: SessionID }; request: HttpServerRequest.HttpServerRequest }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* SessionError.mapStorageNotFound(session.remove(ctx.params.sessionID)).pipe(Effect.map(() => true as const))
      const json = yield* tryParseJson(body)
      if (json !== null && typeof json === "object" && !Array.isArray(json)) {
        const j = json as Record<string, unknown>
        const hasDurable = "opId" in j || "idempotencyKey" in j || "requestId" in j || "context" in j || "directory" in j
        if (hasDurable) {
          const allowedRoot = new Set(["directory", "opId", "idempotencyKey", "requestId", "context"])
          for (const k of Object.keys(j)) if (!allowedRoot.has(k)) return yield* new HttpApiError.BadRequest({})
          const c = j.context as unknown
          if (c !== null && typeof c === "object" && !Array.isArray(c)) {
            const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
            for (const k of Object.keys(c as Record<string, unknown>)) if (!allowedCtx.has(k)) return yield* new HttpApiError.BadRequest({})
          }
          const decoded = { ...j } as unknown as typeof DeletePayload.Type
          return yield* remove({ params: ctx.params, payload: decoded })
        }
      }
      const decoded = yield* Schema.decodeUnknownEffect(DeletePayload)(json).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return yield* remove({ params: ctx.params, payload: decoded })
    })

    const sessionUpdateDispatch = yield* SessionUpdateDispatchService // kilocode_change - P4.4-G3-B2
    const updateCore = (sessionID: SessionID, payload: typeof UpdatePayload.Type) =>
      Effect.gen(function* () {
        const current = yield* requireSession(sessionID)
        const isDurable =
          payload.idempotencyKey !== undefined ||
          payload.requestId !== undefined ||
          payload.opId !== undefined ||
          payload.context !== undefined
        if (isDurable) {
          if (payload.title === undefined) return yield* new HttpApiError.BadRequest({})
          if (payload.idempotencyKey === undefined || payload.requestId === undefined || payload.opId === undefined)
            return yield* new HttpApiError.BadRequest({})
          if (payload.context === undefined) return yield* new HttpApiError.BadRequest({})
          if (payload.context.sessionId !== sessionID) return yield* new HttpApiError.BadRequest({})
          const dir = payload.context.directory
          const requestId = payload.requestId
          const opId = payload.opId
          const idempotencyKey = payload.idempotencyKey
          const req = {
            v: 1 as const,
            requestId,
            opId,
            op: "session/update" as const,
            idempotencyKey,
            context: {
              directory: dir,
              sessionId: sessionID,
              parentSessionId: (payload.context.parentSessionId ?? null) as string | null,
              configVersion: payload.context.configVersion,
              sessionRevision: payload.context.sessionRevision,
            },
            payload: { title: payload.title as string },
          }
          const result = yield* (sessionUpdateDispatch.dispatch(req).pipe(
            Effect.catchDefect(() => Effect.fail(new HttpApiError.InternalServerError({}))),
            Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({}))),
          ) as Effect.Effect<SessionUpdateResult, HttpApiError.InternalServerError>)
          if (result.status === "succeeded") return result.data
          if (result.status === "failed") {
            if (result.failure.code === "session.not_found") {
              return yield* Effect.fail(new ApiNotFoundError({ name: "NotFoundError", data: { message: result.failure.message } }))
            }
            if (result.failure.code === "validation.failed") {
              return yield* Effect.fail(new HttpApiError.BadRequest({}))
            }
            if (result.failure.code === "scope_mismatch") {
              return yield* Effect.fail(new HttpApiError.BadRequest({}))
            }
            if (result.failure.code === "stale" || result.failure.code === "conflict") {
              return yield* Effect.fail(new HttpApiError.Conflict({}))
            }
            if (result.failure.code === "InstanceUnavailableDuringConfigRebuild") {
              return yield* Effect.fail(new HttpApiError.Conflict({}))
            }
            if (result.failure.code === "internal") {
              return yield* Effect.fail(new HttpApiError.InternalServerError({}))
            }
            return yield* Effect.fail(new HttpApiError.InternalServerError({}))
          }
          return yield* Effect.fail(new HttpApiError.InternalServerError({}))
        }
        if (payload.title !== undefined) {
          yield* session.setTitle({ sessionID: sessionID, title: payload.title })
        }
        if (payload.metadata !== undefined) {
          yield* session.setMetadata({ sessionID: sessionID, metadata: payload.metadata })
        }
        if (payload.permission !== undefined) {
          yield* session.setPermission({
            sessionID: sessionID,
            permission: Permission.merge(current.permission ?? [], payload.permission),
          })
        }
        if (payload.time?.archived !== undefined) {
          yield* session.setArchived({ sessionID: sessionID, time: payload.time.archived })
        }
        return yield* requireSession(sessionID)
      })

    const update = Effect.fn("SessionHttpApi.update")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof UpdatePayload.Type
    }) {
      return yield* updateCore(ctx.params.sessionID, ctx.payload)
    })

    const updateRaw = Effect.fn("SessionHttpApi.updateRaw")(function* (ctx: {
      params: { sessionID: SessionID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* new HttpApiError.BadRequest({})
      const json = yield* tryParseJson(body)
      // strict unknown-field rejection for OpenAPI additionalProperties:false parity (finite integers already via Schema)
      if (json !== null && typeof json === "object" && !Array.isArray(json)) {
        const j = json as Record<string, unknown>
        const allowedRoot = new Set(["title", "metadata", "permission", "time", "idempotencyKey", "requestId", "opId", "context"])
        for (const k of Object.keys(j)) if (!allowedRoot.has(k)) return yield* new HttpApiError.BadRequest({})
        const c = j.context as unknown
        if (c !== null && typeof c === "object" && !Array.isArray(c)) {
          const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
          for (const k of Object.keys(c as Record<string, unknown>)) if (!allowedCtx.has(k)) return yield* new HttpApiError.BadRequest({})
        }
        const timeRaw = j.time as unknown
        if (timeRaw !== null && typeof timeRaw === "object" && !Array.isArray(timeRaw)) {
          const allowedTime = new Set(["archived"])
          for (const k of Object.keys(timeRaw as Record<string, unknown>)) if (!allowedTime.has(k)) return yield* new HttpApiError.BadRequest({})
        }
        const permRaw = j.permission as unknown
        if (permRaw !== undefined && permRaw !== null) {
          if (!Array.isArray(permRaw)) return yield* new HttpApiError.BadRequest({})
          const allowedRule = new Set(["permission", "pattern", "action"])
          for (const el of permRaw as unknown[]) {
            if (el === null || typeof el !== "object" || Array.isArray(el)) return yield* new HttpApiError.BadRequest({})
            for (const k of Object.keys(el as Record<string, unknown>)) if (!allowedRule.has(k)) return yield* new HttpApiError.BadRequest({})
          }
        }
      }
      const decoded = yield* Schema.decodeUnknownEffect(UpdatePayload)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return yield* updateCore(ctx.params.sessionID, decoded)
    })

    const forkDispatch = yield* SessionForkDispatchService // kilocode_change - P4.4-G3-B3 fork
    const fork = Effect.fn("SessionHttpApi.fork")(function* (ctx: {
      params: { sessionID: SessionID }
      payload?: typeof ForkPayload.Type
    }) {
      const p = ctx.payload as unknown as { idempotencyKey?: string; requestId?: string; opId?: string; context?: unknown; messageID?: string }
      const isDurable =
        p?.idempotencyKey !== undefined || p?.requestId !== undefined || p?.opId !== undefined || p?.context !== undefined
      if (isDurable) {
        if (p?.idempotencyKey === undefined || p?.requestId === undefined || p?.opId === undefined)
          return yield* new HttpApiError.BadRequest({})
        if (p?.context === undefined) return yield* new HttpApiError.BadRequest({})
        const c = p.context as Record<string, unknown>
        if (typeof c.sessionId !== "string" || c.sessionId !== ctx.params.sessionID) return yield* new HttpApiError.BadRequest({})
        if (typeof c.directory !== "string" || c.directory.length === 0) return yield* new HttpApiError.BadRequest({})
        // kilocode_change - P4.4-G3 double-directory fail-closed: route directory vs body directory must canonical-equivalent
        const reqOpt = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
        if (Option.isSome(reqOpt)) {
          const httpReq = reqOpt.value
          const url = new URL(httpReq.url, "http://localhost")
          const routeDirectory = forkTargetDirectory(httpReq.method, url, httpReq.headers as Record<string, string | undefined>)
          if (routeDirectory !== undefined) {
            try {
              const canonRoute = canonicalDirectory(routeDirectory)
              const canonBody = canonicalDirectory(c.directory as string)
              if (canonRoute !== canonBody) return yield* new HttpApiError.BadRequest({})
            } catch {
              return yield* new HttpApiError.BadRequest({})
            }
          }
        }
        const req = {
          v: 1 as const,
          requestId: p.requestId as string,
          opId: p.opId as string,
          op: "session/fork" as const,
          idempotencyKey: p.idempotencyKey as string,
          context: {
            directory: c.directory as string,
            sessionId: ctx.params.sessionID,
            parentSessionId: (c.parentSessionId ?? null) as string | null,
            configVersion: c.configVersion as number | undefined,
            sessionRevision: c.sessionRevision as number | undefined,
          },
          payload: { messageId: (p.messageID as string | undefined) ?? null },
        }
        const result = yield* (forkDispatch.dispatch(req).pipe(
          Effect.catchDefect(() => Effect.fail(new HttpApiError.InternalServerError({}))),
          Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({}))),
        ) as Effect.Effect<SessionForkResult, HttpApiError.InternalServerError>)
        if (result.status === "succeeded") return result.data
        if (result.status === "failed") {
          if (result.failure.code === "session.not_found") {
            return yield* Effect.fail(new ApiNotFoundError({ name: "NotFoundError", data: { message: result.failure.message } }))
          }
          if (result.failure.code === "validation.failed") {
            return yield* Effect.fail(new HttpApiError.BadRequest({}))
          }
          if (result.failure.code === "scope_mismatch") {
            return yield* Effect.fail(new HttpApiError.BadRequest({}))
          }
          if (result.failure.code === "stale" || result.failure.code === "conflict") {
            return yield* Effect.fail(new HttpApiError.Conflict({}))
          }
          if (result.failure.code === "InstanceUnavailableDuringConfigRebuild") {
            return yield* Effect.fail(new HttpApiError.Conflict({}))
          }
          if (result.failure.code === "internal") {
            return yield* Effect.fail(new HttpApiError.InternalServerError({}))
          }
          return yield* Effect.fail(new HttpApiError.InternalServerError({}))
        }
        return yield* Effect.fail(new HttpApiError.InternalServerError({}))
      }
      return yield* SessionError.mapStorageNotFound(
        session.fork({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload?.messageID,
        }),
      )
    })

    const forkRaw = KiloSessionHttpApi.forkRaw(fork) // kilocode_change - carry upstream bodyless full-session fork support

    const abort = Effect.fn("SessionHttpApi.abort")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* promptSvc.cancel(ctx.params.sessionID)
      return true
    })

    const init = Effect.fn("SessionHttpApi.init")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof InitPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* promptSvc
        .command({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload.messageID,
          model: `${ctx.payload.providerID}/${ctx.payload.modelID}`,
          command: Command.Default.INIT,
          arguments: "",
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return true
    })

    // share/unshare errors aren't all client-induced — storage and network
    // failures from SessionShare are real possibilities. Map to a typed 500
    // (matches the legacy route behavior which routed any failure through
    // ErrorMiddleware → NamedError.Unknown 500) instead of blanket-mapping
    // every failure to a 400 BadRequest.
    const share = Effect.fn("SessionHttpApi.share")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc.share(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const unshare = Effect.fn("SessionHttpApi.unshare")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc
        .unshare(ctx.params.sessionID)
        .pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const message = yield* promptSvc
        .prompt({ ...ctx.payload, sessionID: ctx.params.sessionID } as unknown as SessionPrompt.PromptInput) // kilocode_change
        .pipe(
          // kilocode_change start - reject only typed user image validation defects as request errors
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause)
            if (
              error instanceof Image.InvalidDataUrlError ||
              error instanceof Image.DecodeError ||
              error instanceof Image.SizeError
            )
              return Effect.fail(new HttpApiError.BadRequest({}))
            return Effect.die(error)
          }),
          // kilocode_change end
        )
      return HttpServerResponse.stream(Stream.make(JSON.stringify(message)).pipe(Stream.encodeText), {
        contentType: "application/json",
      })
    })

    const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* promptSvc
        .prompt({ ...ctx.payload, sessionID: ctx.params.sessionID } as unknown as SessionPrompt.PromptInput)
        .pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.void // kilocode_change - Stop is not an error
            return Effect.gen(function* () {
              yield* Effect.logError("prompt_async failed").pipe(
                Effect.annotateLogs({ sessionID: ctx.params.sessionID, cause }),
              )
              const error = Cause.squash(cause)
              yield* events.publish(Session.Event.Error, {
                sessionID: ctx.params.sessionID,
                error: AgentRequirementError.isInstance(error)
                  ? error.toObject()
                  : new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
              })
            })
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      return HttpApiSchema.NoContent.make()
    })

    const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CommandPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* promptSvc
        .command({ ...ctx.payload, sessionID: ctx.params.sessionID })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShellPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(promptSvc.shell({ ...ctx.payload, sessionID: ctx.params.sessionID }))
    })

    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapRevert(revertSvc.revert({ sessionID: ctx.params.sessionID, ...ctx.payload }))
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapRevert(revertSvc.unrevert({ sessionID: ctx.params.sessionID }))
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { sessionID: SessionID; permissionID: PermissionV1.ID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response }).pipe(
        Effect.catchTag("Permission.NotFoundError", (error) =>
          Effect.fail(
            new PermissionNotFoundError({
              requestID: String(error.requestID),
              message: `Permission request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
      yield* session.removeMessage(ctx.params)
      return true
    })

    const deletePart = Effect.fn("SessionHttpApi.deletePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* session.removePart(ctx.params)
      return true
    })

    const updatePart = Effect.fn("SessionHttpApi.updatePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
      payload: typeof SessionV1.Part.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const payload = ctx.payload as SessionV1.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        return yield* new HttpApiError.BadRequest({})
      }
      return yield* session.updatePart(payload)
    })

    // kilocode_change start - P4.4-G3-B0: delegate to backend-owned CancelQueuedDispatch (boolean legacy)
    const cancelQueuedDispatch = yield* CancelQueuedDispatchService
    const cancelQueued = Effect.fn("SessionHttpApi.cancelQueued")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      const info = yield* requireSession(ctx.params.sessionID)
      const directory = (info as unknown as { directory: string }).directory
      const requestId = `legacy:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
      const opId = SessionOperation.cancelQueuedId(ctx.params.sessionID, ctx.params.messageID)
      const idempotencyKey = `legacy:${ctx.params.sessionID}:${ctx.params.messageID}`
      const req = {
        v: 1 as const,
        requestId,
        opId,
        op: "session/cancelQueued" as const,
        idempotencyKey,
        context: { directory, sessionId: ctx.params.sessionID, parentSessionId: null as string | null },
        payload: { messageId: ctx.params.messageID },
      }
      const result = yield* (cancelQueuedDispatch.dispatch(req).pipe(
        Effect.catchDefect((_) => Effect.fail(new HttpApiError.InternalServerError({}))),
        Effect.catch((_) => Effect.fail(new HttpApiError.InternalServerError({}))),
      ) as Effect.Effect<CancelQueuedResult, HttpApiError.InternalServerError>)
      if (result.status === "succeeded") return result.data.cancelled
      if (result.status === "ambiguous") {
        return yield* Effect.fail(new HttpApiError.Conflict({}))
      }
      if (result.status === "failed") {
        if (result.failure.code === "session.not_found") {
          return yield* Effect.fail(new ApiNotFoundError({ name: "NotFoundError", data: { message: result.failure.message } }))
        }
        if (result.failure.code === "validation.failed") {
          return yield* Effect.fail(new HttpApiError.BadRequest({}))
        }
        if (result.failure.code === "scope_mismatch") {
          return yield* Effect.fail(new HttpApiError.BadRequest({}))
        }
        if (result.failure.code === "stale" || result.failure.code === "conflict") {
          return yield* Effect.fail(new HttpApiError.Conflict({}))
        }
        if (result.failure.code === "InstanceUnavailableDuringConfigRebuild") {
          return yield* Effect.fail(new HttpApiError.Conflict({}))
        }
        if (result.failure.code === "internal") {
          return yield* Effect.fail(new HttpApiError.InternalServerError({}))
        }
        return yield* Effect.fail(new HttpApiError.InternalServerError({}))
      }
      return yield* Effect.fail(new HttpApiError.InternalServerError({}))
    })

    const viewed = Effect.fn("SessionHttpApi.viewed")(function* (ctx: { payload: typeof ViewedPayload.Type }) {
      yield* viewers.update(ctx.payload)
      return true
    })
    // kilocode_change end

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("get", get)
      .handle("children", children)
      .handle("todo", todo)
      .handle("diff", diff)
      .handle("messages", messages)
      .handle("message", message)
      .handleRaw("create", createRaw)
      .handleRaw("remove", removeRaw)
      .handleRaw("update", updateRaw)
      .handleRaw("fork", forkRaw) // kilocode_change - carry upstream bodyless full-session fork support
      .handle("abort", abort)
      .handle("init", init)
      .handle("share", share)
      .handle("unshare", unshare)
      .handle("prompt", prompt)
      .handle("promptAsync", promptAsync)
      .handle("command", command)
      .handle("shell", shell)
      .handle("revert", revert)
      .handle("unrevert", unrevert)
      .handle("permissionRespond", permissionRespond)
      .handle("deleteMessage", deleteMessage)
      .handle("deletePart", deletePart)
      .handle("updatePart", updatePart)
      .handle("cancelQueued", cancelQueued) // kilocode_change - P4.4-G3-B0 backend-owned boolean via dispatch
      .handle("viewed", viewed) // kilocode_change
  }),
)
