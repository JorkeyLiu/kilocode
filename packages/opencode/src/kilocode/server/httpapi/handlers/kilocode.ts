import { Effect } from "effect"
import { HttpEffect } from "effect/unstable/http" // kilocode_change - LOCK-003 response-boundary events
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as KiloAgent from "@/kilocode/agent"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { HeapSnapshot } from "@/kilocode/cli/heap-snapshot"
import type { RequestID as NotebookRequestID } from "@/kilocode/notebook/protocol"
import { Notebook } from "@/kilocode/notebook/service"
import { ModelUsage } from "@/kilocode/session/model-usage"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import type { SessionID } from "@/session/schema"
import { withColdMutation } from "@/kilocode/server/config-convergence"
import {
  execute as executeCustomProviderDelete,
  CustomProviderDeleteError as CustomProviderDeleteFailureDomain,
} from "@/kilocode/server/custom-provider-delete"
import {
  execute as executeCustomProviderSave,
  CustomProviderSaveError as CustomProviderSaveFailureDomain,
} from "@/kilocode/server/custom-provider-save"
import { ProviderV2 } from "@opencode-ai/core/provider"
import {
  CustomProviderDeleteFailure,
  CustomProviderSaveBody,
  CustomProviderSaveFailure,
  NotebookRejectPayload,
  NotebookReplyPayload,
  RemoveAgentPayload,
} from "../groups/kilocode"

export const kilocodeHandlers = HttpApiBuilder.group(InstanceHttpApi, "kilocode", (handlers) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const notebook = yield* Notebook.Service

    const heapSnapshot = Effect.fn("KilocodeHttpApi.heapSnapshot")(function* () {
      return yield* Effect.sync(() => HeapSnapshot.write())
    })

    const agentRequirements = Effect.fn("KilocodeHttpApi.agentRequirements")(function* (ctx: {
      query: { agent: string }
    }) {
      return yield* agents.requirementStatus(ctx.query.agent)
    })

    // LOCK-005/007: durable agent removal routed through withColdMutation. A
    // custom agent can live in any config directory, so the removal is
    // GLOBAL-scoped — every loaded directory converges to the post-removal
    // registry. The response returns after the durable removal and rebuild
    // registration, before any generation drain; the convergence pass owns
    // seal/drain/dispose/boot (LOCK-007 — no direct store.dispose here). A
    // RemoveError stays a structured 400 and releases the fence via the
    // ensuring-abort (LOCK-007), registering no rebuild.
    const removeAgent = Effect.fn("KilocodeHttpApi.removeAgent")(function* (ctx: {
      payload: typeof RemoveAgentPayload.Type
    }) {
      const instance = yield* InstanceState.context
      const agent = yield* agents.get(ctx.payload.name)
      const dirs = yield* config.directories()
      return yield* withColdMutation({
        scope: "global",
        run: () =>
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () =>
                KiloAgent.remove({
                  name: ctx.payload.name,
                  agent,
                  dirs,
                  directory: instance.directory,
                  worktree: instance.worktree,
                }),
              catch: (err) => err,
            }).pipe(
              Effect.catch((err) => {
                if (KiloAgent.RemoveError.isInstance(err)) return Effect.fail(new HttpApiError.BadRequest({}))
                return Effect.die(err)
              }),
            )
            return { changed: true as const, value: true as const }
          }),
      })
    })

    const notebookList = Effect.fn("KilocodeHttpApi.notebookList")(function* () {
      return yield* notebook.list()
    })

    const notebookReply = Effect.fn("KilocodeHttpApi.notebookReply")(function* (ctx: {
      params: { requestID: NotebookRequestID }
      payload: typeof NotebookReplyPayload.Type
    }) {
      yield* notebook.reply({ requestID: ctx.params.requestID, result: ctx.payload.result }).pipe(
        Effect.catchTag("Notebook.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        Effect.catchTag("Notebook.InvalidReplyError", () => Effect.fail(new HttpApiError.BadRequest({}))),
      )
      return true
    })

    const notebookReject = Effect.fn("KilocodeHttpApi.notebookReject")(function* (ctx: {
      params: { requestID: NotebookRequestID }
      payload: typeof NotebookRejectPayload.Type
    }) {
      yield* notebook
        .reject({ requestID: ctx.params.requestID, error: ctx.payload.error })
        .pipe(Effect.catchTag("Notebook.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))))
      return true
    })

    const sessionModelUsage = Effect.fn("KilocodeHttpApi.sessionModelUsage")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      const usage = yield* ModelUsage.get(ctx.params.sessionID)
      if (!usage) return yield* new HttpApiError.NotFound({})
      return usage
    })

    // LOCK-001/003/004: canonical deletion handler. The request directory and
    // worktree come from the trusted InstanceRef provided by
    // InstanceContextMiddleware — never from a raw query value. Only the
    // declared domain failure maps to the structured 400; auth/cache/rollback
    // defects stay defects and surface as generic 500s (never false 200).
    //
    // LOCK-003 event ordering: the service result carries DEFERRED final
    // ConfigUpdated events. They are emitted at the response acknowledgement
    // boundary via HttpEffect.appendPreResponseHandler — after persistence,
    // rebuild registration, and this success result are all finalized, and
    // immediately before the framework sends the response bytes. This is the
    // truthful maximum the Effect HttpApi supports: `HttpEffect.toHandled`
    // runs pre-response handlers before `handleResponse` sends bytes and has
    // no post-send hook on the web-handler path, so byte-on-wire
    // response-before-event is not achievable without request lifecycle
    // support.
    const customProviderDelete = Effect.fn("KilocodeHttpApi.customProviderDelete")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      const ref = yield* InstanceRef
      const result = yield* executeCustomProviderDelete({
        providerID: ctx.params.providerID,
        directory: ref?.directory,
        worktree: ref?.worktree,
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof CustomProviderDeleteFailureDomain) {
            return Effect.fail(
              new CustomProviderDeleteFailure({
                code: error.code,
                message: error.message,
                detail: `providerID: ${error.providerID}`,
              }),
            )
          }
          return Effect.die(error)
        }),
      )
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        result.events.pipe(Effect.as(response)),
      )
      return { success: true }
    })

    // LOCK-001/003/005: canonical save handler — one backend mutation replacing
    // the extension's split global-config + auth calls. The request directory
    // and worktree come from the trusted InstanceRef provided by
    // InstanceContextMiddleware — never from a raw query value. Only the
    // declared domain failures (validation / not-custom) map to the structured
    // 400; auth/cache/rollback defects stay defects and surface as generic 500s
    // (never false 200). LOCK-003: the deferred ConfigUpdated event is emitted
    // at the response acknowledgement boundary via
    // HttpEffect.appendPreResponseHandler — after persistence, rebuild
    // registration, and this success result are all finalized.
    const customProviderSave = Effect.fn("KilocodeHttpApi.customProviderSave")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: typeof CustomProviderSaveBody.Type
    }) {
      const ref = yield* InstanceRef
      const result = yield* executeCustomProviderSave({
        providerID: ctx.params.providerID,
        config: ctx.payload.config,
        auth: ctx.payload.auth,
        directory: ref?.directory,
        worktree: ref?.worktree,
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof CustomProviderSaveFailureDomain) {
            return Effect.fail(
              new CustomProviderSaveFailure({
                code: error.code,
                message: error.message,
                detail: `providerID: ${error.providerID}`,
              }),
            )
          }
          return Effect.die(error)
        }),
      )
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        result.events.pipe(Effect.as(response)),
      )
      return { success: true }
    })

    return handlers
      .handle("heapSnapshot", heapSnapshot)
      .handle("agentRequirements", agentRequirements)
      .handle("removeAgent", removeAgent)
      .handle("notebookList", notebookList)
      .handle("notebookReply", notebookReply)
      .handle("notebookReject", notebookReject)
      .handle("sessionModelUsage", sessionModelUsage)
      .handle("customProviderDelete", customProviderDelete)
      .handle("customProviderSave", customProviderSave)
  }),
)
