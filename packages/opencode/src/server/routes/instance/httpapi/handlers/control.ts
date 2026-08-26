import { Auth } from "@/auth"
import { invalidateAfterProviderAuthChange } from "@/kilocode/server/provider-auth-lifecycle" // kilocode_change
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { LogInput } from "../groups/control"
import { ProviderV2 } from "@opencode-ai/core/provider"

export const controlHandlers = HttpApiBuilder.group(RootHttpApi, "control", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const authSet = Effect.fn("ControlHttpApi.authSet")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: Auth.Info
    }) {
      // kilocode_change start - persist + invalidate under one canonical gate ticket
      yield* invalidateAfterProviderAuthChange(
        ctx.params.providerID,
        Effect.gen(function* () {
          yield* auth.set(ctx.params.providerID, ctx.payload).pipe(Effect.orDie)
        }),
        // kilocode_change - LOCK-003: auth set (connect) also removes the
        // target ID from disabled_providers under the same ticket/lifecycle —
        // one backend mutation, exactly one rebuild/event. authRemove below
        // intentionally does not request cleanup.
        { cleanupDisabled: true },
      )
      // kilocode_change end
      return true
    })

    const authRemove = Effect.fn("ControlHttpApi.authRemove")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      // kilocode_change start - persist + invalidate under one canonical gate ticket
      yield* invalidateAfterProviderAuthChange(
        ctx.params.providerID,
        Effect.gen(function* () {
          yield* auth.remove(ctx.params.providerID).pipe(Effect.orDie)
        }),
      )
      // kilocode_change end
      return true
    })

    // kilocode_change - renamed from `log` so the chain reads `logHandler` next to the Kilo deletion handler
    const logHandler = Effect.fn("ControlHttpApi.log")(function* (ctx: { payload: typeof LogInput.Type }) { // kilocode_change
      const logger = Log.create({ service: ctx.payload.service })
      logger[ctx.payload.level](ctx.payload.message, ctx.payload.extra)
      return true
    })

    // kilocode_change start - chain references the Kilo-renamed logHandler
    return handlers
      .handle("authSet", authSet)
      .handle("authRemove", authRemove)
      .handle("log", logHandler)
    // kilocode_change end
  }),
)
