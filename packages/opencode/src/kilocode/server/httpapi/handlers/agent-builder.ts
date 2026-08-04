import * as InstanceState from "@/effect/instance-state"
import { AgentBuilder } from "@/kilocode/agent/builder"
import { withColdMutation } from "@/kilocode/server/config-convergence"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AgentBuilderID, AgentBuilderInput, AgentBuilderSaveInput } from "../groups/agent-builder"

export const agentBuilderHandlers = HttpApiBuilder.group(InstanceHttpApi, "agent-builder", (handlers) =>
  Effect.gen(function* () {
    const preview = Effect.fn("AgentBuilderHttpApi.preview")(function* (ctx: {
      payload: typeof AgentBuilderInput.Type
    }) {
      const instance = yield* InstanceState.context
      return yield* Effect.promise(() => AgentBuilder.preview(instance, normalize(ctx.payload)))
    })

    // LOCK-005/007: the save is a durable cold mutation routed through
    // withColdMutation. Scope follows the mutation — a project save fences only
    // the request directory, a global save fences every loaded directory. The
    // response returns after the durable write and rebuild registration, before
    // any generation drain; the convergence pass owns seal/drain/dispose/boot,
    // so there is no direct store.dispose here and no write-before-dispose or
    // stale-sibling window for the runtime (LOCK-002).
    const save = Effect.fn("AgentBuilderHttpApi.save")(function* (ctx: {
      params: { id: typeof AgentBuilderID.Type }
      payload: typeof AgentBuilderSaveInput.Type
    }) {
      const instance = yield* InstanceState.context
      const input = normalize({ ...ctx.payload, id: ctx.params.id })
      return yield* withColdMutation({
        scope: input.scope === "global" ? "global" : { directory: instance.directory },
        run: () =>
          Effect.gen(function* () {
            const output = yield* Effect.promise(() => AgentBuilder.save(instance, input))
            return { changed: true as const, value: output }
          }),
      })
    })

    return handlers.handle("preview", preview).handle("save", save)
  }),
)

function normalize(input: typeof AgentBuilderInput.Type): AgentBuilder.Input {
  return {
    ...input,
    scope: input.scope ?? "project",
    mode: input.mode ?? "primary",
    prompt: input.prompt.trim(),
    tools: input.tools ? [...input.tools] : undefined,
  }
}
