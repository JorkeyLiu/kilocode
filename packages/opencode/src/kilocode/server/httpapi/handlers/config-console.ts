import { Config } from "@/config/config"
import * as InstanceState from "@/effect/instance-state"
import { isHotPatch } from "@/kilocode/config/hot-keys"
import { KilocodeConfigOverlay } from "@/kilocode/config/overlay"
import { KilocodeModelState } from "@/kilocode/config/model-state"
import { ConfigRules } from "@/kilocode/server/routes/config-rules"
import { KilocodeKeybinds } from "@/kilocode/tui/keybinds"
import { KilocodeTuiConfig } from "@/kilocode/tui/config"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { withColdMutation } from "@/kilocode/server/config-convergence"
import { configFailure } from "@/kilocode/server/config-failure"
import { executeTransaction } from "@/kilocode/server/config-transaction"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  ConfigModelStatePatch,
  ConfigOverlayPatch,
  ConfigOverlayQuery,
  ConfigRulesPatch,
  ConfigTransactionPatch,
  TuiConfigPatch,
  TuiConfigQuery,
} from "../groups/config-console"

export const configConsoleHandlers = HttpApiBuilder.group(InstanceHttpApi, "config-console", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service

    const overlay = Effect.fn("ConfigConsoleHttpApi.overlay")(function* (ctx: {
      query: typeof ConfigOverlayQuery.Type
    }) {
      const instance = yield* InstanceState.context
      const [base, global] = yield* Effect.all([config.get(), config.getGlobal()], { concurrency: 2 })
      return yield* Effect.promise(() =>
        KilocodeConfigOverlay.resolve({
          directory: instance.directory,
          worktree: instance.worktree,
          scope: ctx.query.scope ?? "project",
          effective: base,
          global,
        }),
      )
    })

    const overlayUpdate = Effect.fn("ConfigConsoleHttpApi.overlayUpdate")(function* (ctx: {
      payload: typeof ConfigOverlayPatch.Type
    }) {
      const body = {
        ...ctx.payload,
        scope: ctx.payload.scope ?? "project",
        set: ctx.payload.set ? { ...ctx.payload.set } : undefined,
        unset: ctx.payload.unset?.map((item) => [...item]),
      }
      const patch = KilocodeConfigOverlay.patch(body)
      if (Object.keys(patch).length === 0) {
        if (body.scope === "global") return yield* config.getGlobal()
        return yield* config.get()
      }
      if (body.scope === "global") {
        const hot = isHotPatch(patch)
        if (hot) return (yield* configFailure(config.updateGlobal(patch, { dispose: false }))).info
        return yield* withColdMutation({
          scope: "global",
          run: () =>
            Effect.gen(function* () {
              // emit:false defers the ConfigUpdated publish so withColdMutation
              // emits it only after the convergence rebuild registration owns
              // the fence (LOCK-002/003).
              const exit = yield* configFailure(config.updateGlobal(patch, { emit: false })).pipe(Effect.exit)
              if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause)
              return {
                changed: exit.value.changed,
                value: exit.value.info,
                event: exit.value.changed ? config.emitUpdated("global") : undefined,
              }
            }),
        })
      }
      const hot = isHotPatch(patch)
      const instance = yield* InstanceState.context
      if (hot) {
        yield* configFailure(config.update(patch))
        return yield* config.get()
      }
      return yield* withColdMutation({
        scope: { directory: instance.directory },
        run: () =>
          Effect.gen(function* () {
            // emit:false defers the ConfigUpdated publish so withColdMutation
            // emits it only after the convergence rebuild registration owns
            // the fence (LOCK-002/003).
            const exit = yield* configFailure(config.update(patch, { emit: false })).pipe(Effect.exit)
            if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause)
            return {
              changed: exit.value.changed,
              value: yield* config.get(),
              event: exit.value.changed ? config.emitUpdated(instance.directory) : undefined,
            }
          }),
      })
    })

    const effective = Effect.fn("ConfigConsoleHttpApi.effective")(function* () {
      return yield* config.get()
    })

    const rules = Effect.fn("ConfigConsoleHttpApi.rules")(function* () {
      const instance = yield* InstanceState.context
      return yield* Effect.promise(() =>
        ConfigRules.read({ directory: instance.directory, worktree: instance.worktree }),
      )
    })

    const rulesUpdate = Effect.fn("ConfigConsoleHttpApi.rulesUpdate")(function* (ctx: {
      payload: typeof ConfigRulesPatch.Type
    }) {
      const instance = yield* InstanceState.context
      return yield* Effect.promise(() =>
        ConfigRules.update({
          directory: instance.directory,
          worktree: instance.worktree,
          content: ctx.payload.content,
        }),
      )
    })

    const modelState = Effect.fn("ConfigConsoleHttpApi.modelState")(function* () {
      return yield* Effect.promise(() => KilocodeModelState.get())
    })

    const modelStateUpdate = Effect.fn("ConfigConsoleHttpApi.modelStateUpdate")(function* (ctx: {
      payload: typeof ConfigModelStatePatch.Type
    }) {
      return yield* Effect.promise(() =>
        KilocodeModelState.update({ favorite: ctx.payload.favorite?.map((item) => ({ ...item })) }),
      )
    })

    const tuiConfigGet = Effect.fn("ConfigConsoleHttpApi.tuiConfigGet")(function* () {
      const instance = yield* InstanceState.context
      return yield* Effect.promise(() => KilocodeTuiConfig.get({ directory: instance.directory }))
    })

    const tuiKeybindList = Effect.fn("ConfigConsoleHttpApi.tuiKeybindList")(function* () {
      return { keybinds: KilocodeKeybinds.list() }
    })

    const tuiConfigUpdate = Effect.fn("ConfigConsoleHttpApi.tuiConfigUpdate")(function* (ctx: {
      query: typeof TuiConfigQuery.Type
      payload: typeof TuiConfigPatch.Type
    }) {
      const instance = yield* InstanceState.context
      const patch = {
        ...ctx.payload,
        keybinds: ctx.payload.keybinds ? { ...ctx.payload.keybinds } : undefined,
        plugin: ctx.payload.plugin?.map((item) => {
          if (!Array.isArray(item)) return item
          return [item[0], { ...item[1] }] as [string, { readonly [x: string]: unknown }]
        }),
        plugin_enabled: ctx.payload.plugin_enabled ? { ...ctx.payload.plugin_enabled } : undefined,
      }
      return yield* Effect.promise(() =>
        KilocodeTuiConfig.update({
          directory: instance.directory,
          worktree: instance.worktree,
          scope: ctx.query.scope ?? "project",
          patch,
        }),
      )
    })

    // combined global+project config transaction handler (LOCK-002/005)
    const configTransaction = Effect.fn("ConfigConsoleHttpApi.configTransaction")(function* (ctx: {
      payload: typeof ConfigTransactionPatch.Type
    }) {
      return yield* executeTransaction(ctx.payload)
    })

    return handlers
      .handle("overlay", overlay)
      .handle("overlayUpdate", overlayUpdate)
      .handle("configTransaction", configTransaction)
      .handle("effective", effective)
      .handle("rules", rules)
      .handle("rulesUpdate", rulesUpdate)
      .handle("modelState", modelState)
      .handle("modelStateUpdate", modelStateUpdate)
      .handle("tuiConfigGet", tuiConfigGet)
      .handle("tuiKeybindList", tuiKeybindList)
      .handle("tuiConfigUpdate", tuiConfigUpdate)
  }),
)
