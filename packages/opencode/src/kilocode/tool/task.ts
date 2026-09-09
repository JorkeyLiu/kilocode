// kilocode_change - new file
import { Effect, Schema } from "effect"
import path from "path"
import { Permission } from "@/permission"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { Session } from "../../session/session"
import type { Agent } from "../../agent/agent"
import type { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import z from "zod"

const log = Log.create({ service: "kilocode-task-model" })

// RATIONALE: Mirror narrow state slice Task tool consumes and ignore unrelated TUI fields.
const ModelState = z
  .object({
    model: z
      .record(
        z.string(),
        z.object({
          providerID: z.custom<ProviderV2.ID>(Schema.is(ProviderV2.ID)),
          modelID: z.custom<ModelV2.ID>(Schema.is(ModelV2.ID)),
        }),
      )
      .optional(),
    variant: z.record(z.string(), z.string().optional()).optional(),
  })
  .passthrough()

export namespace KiloTask {
  /** Reject primary agents used as subagents */
  export function validate(info: Agent.Info, name: string) {
    if (info.mode === "primary") throw new Error(`Agent "${name}" is a primary agent and cannot be used as a subagent`)
  }

  /** Kilo keeps delegation one level deep to avoid recursive subagent chains. */
  export function nestedTask(): false {
    return false
  }

  /**
   * Build inherited permission ceilings from the calling agent.
   * Merges the static agent definition with the session's accumulated permissions
   * so denials survive multi-hop chains (plan → general → explore) without
   * overriding the selected subagent's own allowlist with parent ask/allow rules.
   *
   * OpenCode removed parent-agent inheritance entirely in anomalyco/opencode#31696.
   * Kilo intentionally differs: parent denials remain hard ceilings for Plan Mode
   * and MCP restrictions, while parent ask/allow rules must not replace the
   * selected subagent's policy.
   *
   * The caller must resolve `caller` (Agent.Info) and `session` (Session.Info)
   * before calling. This function is pure/synchronous.
   */
  export function inherited(input: {
    caller: Agent.Info
    session: Session.Info
    mcp: Config.Info["mcp"]
  }): Permission.Ruleset {
    const rules = Permission.merge(input.caller.permission ?? [], input.session.permission ?? [])
    const prefixes = Object.keys(input.mcp ?? {}).map((k) => k.replace(/[^a-zA-Z0-9_-]/g, "_") + "_")
    const isMcp = (p: string) => prefixes.some((prefix) => p.startsWith(prefix))
    return rules.filter(
      (r: Permission.Rule) =>
        r.action === "deny" && (r.permission === "edit" || r.permission === "bash" || isMcp(r.permission)),
    )
  }

  /** Extra permission rules appended to subagent sessions */
  export function permissions(rules: Permission.Ruleset): Permission.Ruleset {
    return [
      { permission: "task", pattern: "*", action: "deny" },
      { permission: "question", pattern: "*", action: "deny" },
      { permission: "interactive_terminal", pattern: "*", action: "deny" },
      ...rules,
    ]
  }

  export function merge(...rulesets: Permission.Ruleset[]): Permission.Rule[] {
    const result: Permission.Rule[] = []
    const seen = new Set<string>()
    for (const rule of rulesets.flat()) {
      const key = `${rule.permission}\u0000${rule.pattern}\u0000${rule.action}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(rule)
    }
    return result
  }

  type Model = { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  type Saved = {
    model?: Model
    /** Usage-memory variant for an exact agent+model: agent+model key first, then the model-only legacy key. */
    variantFor: (model: Model) => string | undefined
  }
  type Choice = { model: Model; explicit?: string; sticky?: boolean }

  function key(model: Model) {
    return `${model.providerID}/${model.modelID}`
  }

  function parse(value: string | null | undefined): Model | undefined {
    if (!value) return undefined
    const [providerID, ...parts] = value.split("/")
    return {
      providerID: ProviderV2.ID.make(providerID),
      modelID: ModelV2.ID.make(parts.join("/")),
    }
  }

  const saved = Effect.fn("KiloTask.savedModel")(function* (name: string) {
    // Shared state file is read by clients that run the same backend binary
    // against the same state dir: the CLI TUI and the VS Code-spawned backend
    // (KILO_CLIENT=vscode). Unknown clients stay out.
    if (Flag.KILO_CLIENT !== "cli" && Flag.KILO_CLIENT !== "vscode") return undefined
    const file = path.join(Global.Path.state, "model.json")
    const state = yield* Effect.tryPromise({
      try: () =>
        Bun.file(file)
          .text()
          .then((raw) => ModelState.safeParse(JSON.parse(raw)))
          .then((result) => (result.success ? result.data : undefined))
          .catch(() => undefined),
      catch: () => undefined,
    })
    if (!state) return undefined
    return {
      model: state.model?.[name],
      // Variant usage memory is looked up per exact (agent, model) pair and
      // does not require the agent to have a saved model entry: a legacy
      // model-only variant applies to the finally selected model even when
      // that model came from configured or parent fallback.
      variantFor: (model: Model) => state.variant?.[`agent/${name}/${key(model)}`] ?? state.variant?.[key(model)],
    }
  })

  /** Resolve the task subagent model while discarding stale unavailable overrides. */
  export const resolveModel = Effect.fn("KiloTask.resolveModel")(function* (input: {
    name: string
    agent: Pick<Agent.Info, "model" | "variant">
    config: Pick<Config.Info, "subagent_model" | "subagent_variant" | "subagent_variant_overrides">
    parent: Model
    variant?: string
    provider: Provider.Interface
  }) {
    const state = yield* saved(input.name)
    const cfg = parse(input.config.subagent_model)
    const override = (model: Model) => input.config.subagent_variant_overrides?.[key(model)] ?? undefined
    // Explicit agent model is a pin, not a fallible candidate: when available
    // it wins and its variant validates as usual; when unavailable it is
    // preserved so the child prompt fails visibly instead of silently
    // inheriting the parent. Configured subagent default and saved
    // usage-memory models remain fallible and fall back to the parent.
    const explicit: Choice | undefined = input.agent.model
      ? { model: input.agent.model, explicit: input.agent.variant }
      : undefined
    if (explicit) {
      const available = yield* input.provider.getModel(explicit.model.providerID, explicit.model.modelID).pipe(
        Effect.catchTag("ProviderModelNotFoundError", (err) =>
          Effect.sync(() => {
            log.debug("preserving unavailable explicit task subagent model", {
              providerID: explicit.model.providerID,
              modelID: explicit.model.modelID,
              err,
            })
            return undefined
          }),
        ),
      )
      // Without provider metadata the variant cannot be safely validated.
      if (!available) return { model: explicit.model, variant: undefined }
    }
    // Fallible candidates in precedence order: configured subagent default →
    // saved usage-memory model → parent.
    const candidates: Array<Choice | undefined> = [
      cfg ? { model: cfg, explicit: input.config.subagent_variant ?? undefined } : undefined,
      state?.model ? { model: state.model, sticky: true } : undefined,
    ]

    // Resolve the final model first; the variant is resolved for that exact
    // agent+model afterwards (see below).
    let winner: Choice | undefined = explicit
    for (const choice of candidates) {
      if (winner) break
      if (!choice) continue
      const full = yield* input.provider.getModel(choice.model.providerID, choice.model.modelID).pipe(
        Effect.catchTag("ProviderModelNotFoundError", (err) =>
          Effect.sync(() => {
            log.debug("skipping unavailable task subagent model", {
              providerID: choice.model.providerID,
              modelID: choice.model.modelID,
              err,
            })
            return undefined
          }),
        ),
      )
      if (!full) continue
      winner = choice
      break
    }
    const model = winner?.model ?? input.parent
    const full = yield* input.provider.getModel(model.providerID, model.modelID).pipe(
      Effect.catchTag("ProviderModelNotFoundError", () => Effect.succeed(undefined)),
    )
    const usable = (value?: string) => (value && full?.variants?.[value] ? value : undefined)
    const withSticky = (variant?: string) =>
      winner?.sticky && variant ? { ...model, variant } : model

    // Resolve the variant for that exact agent+model: per-model configured
    // override → explicit/configured strength from the winning start →
    // agent+model usage memory → model-only usage memory → applicable parent
    // fallback. Exact-agent/global configured starts beat memory; memory
    // applies even when the agent has no saved model entry.
    const overrideV = usable(override(model))
    if (overrideV) return { model: withSticky(overrideV), variant: overrideV }
    const explicitV = usable(winner?.explicit)
    if (explicitV) return { model, variant: explicitV }
    const memoryV = state ? usable(state.variantFor(model)) : undefined
    if (memoryV) return { model: withSticky(memoryV), variant: memoryV }
    const inheritedV = !winner ? usable(input.variant) : undefined
    if (inheritedV) return { model, variant: inheritedV }
    return { model, variant: undefined }
  })
}
