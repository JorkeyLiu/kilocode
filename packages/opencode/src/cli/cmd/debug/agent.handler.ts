import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EOL } from "os"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { basename } from "path"
import { Cause, Effect } from "effect"
import { Agent } from "../../../agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import type { MessageV2 } from "../../../session/message-v2"
import { MessageID, PartID } from "../../../session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Permission } from "../../../permission"
import * as Evaluator from "../../../permission/evaluator"
import { iife } from "../../../util/iife"
import { fail } from "../../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { registerDisposer } from "@/effect/instance-registry"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "debug.agent" })

const debugStore = new Map<string, Evaluator.Provenance>()
registerDisposer(async (dir) => {
  for (const key of [...debugStore.keys()]) {
    if (key.startsWith(dir + ":")) debugStore.delete(key)
  }
})

export const getDebugProvenance = Effect.fn(function* (id: string) {
  const ctx = yield* InstanceRef
  if (!ctx) return undefined
  return debugStore.get(`${ctx.directory}:${id}`)
})

export function getDebugProvenanceSync(id: string, directory?: string): Evaluator.Provenance | undefined {
  let dir = directory
  if (!dir) {
    try {
      // Attempt to get current instance via global Instance if available
      const { Instance } = require("@/kilocode/instance") as any
      const cur = Instance.current as InstanceContext | undefined
      dir = cur?.directory
    } catch (err) {
      log.warn("getDebugProvenanceSync: no directory and no instance context", { err, id })
      return undefined
    }
  }
  if (!dir) return undefined
  return debugStore.get(`${dir}:${id}`)
}

export const clearDebugProvenanceEffect = Effect.fn(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) {
    debugStore.clear()
    return
  }
  for (const key of [...debugStore.keys()]) {
    if (key.startsWith(ctx.directory + ":")) debugStore.delete(key)
  }
})

export function clearDebugProvenance(directory?: string): void {
  if (!directory) {
    try {
      const { Instance } = require("@/kilocode/instance") as any
      const cur = Instance.current as InstanceContext | undefined
      if (cur?.directory) {
        for (const key of [...debugStore.keys()]) {
          if (key.startsWith(cur.directory + ":")) debugStore.delete(key)
        }
        return
      }
    } catch (err) {
      log.warn("clearDebugProvenance: failed to get instance", { err })
    }
    debugStore.clear()
    return
  }
  for (const key of [...debugStore.keys()]) {
    if (key.startsWith(directory + ":")) debugStore.delete(key)
  }
}

export const debugAgent = Effect.fn("Cli.debug.agent")(function* (args: {
  name: string
  tool?: string
  params?: string
}) {
  const ctx = yield* InstanceRef
  if (!ctx) return
  return yield* run(args, ctx)
})

const run = Effect.fn("Cli.debug.agent.body")(function* (
  args: { name: string; tool?: string; params?: string },
  ctx: InstanceContext,
) {
  const agentName = args.name
  const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
  if (!agent) {
    process.stderr.write(
      `Agent ${agentName} not found, run '${basename(process.execPath)} agent list' to get an agent list` + EOL,
    )
    return yield* fail("", 1)
  }
  const availableTools = yield* getAvailableTools(agent)
  const resolvedTools = resolveTools(agent, availableTools)
  const toolID = args.tool
  if (toolID) {
    const tool = availableTools.find((item) => item.id === toolID)
    if (!tool) {
      process.stderr.write(`Tool ${toolID} not found for agent ${agentName}` + EOL)
      return yield* fail("", 1)
    }
    if (resolvedTools[toolID] === false) {
      process.stderr.write(`Tool ${toolID} is disabled for agent ${agentName}` + EOL)
      return yield* fail("", 1)
    }
    const params = parseToolParams(args.params)
    const toolCtx = yield* createToolContext(agent, ctx)
    const result = yield* tool.execute(params, toolCtx)
    process.stdout.write(JSON.stringify({ tool: toolID, input: params, result }, null, 2) + EOL)
    return
  }

  const output = {
    ...agent,
    tools: resolvedTools,
  }
  process.stdout.write(JSON.stringify(output, null, 2) + EOL)
})

const getAvailableTools = Effect.fn("Cli.debug.agent.getAvailableTools")(function* (agent: Agent.Info) {
  const provider = yield* Provider.Service
  const registry = yield* ToolRegistry.Service
  const model =
    agent.model ??
    (yield* provider.defaultModel().pipe(
      Effect.matchCauseEffect({
        onSuccess: Effect.succeed,
        onFailure: (cause) => {
          const error = Cause.squash(cause) as Provider.DefaultModelError
          if (error instanceof Provider.ModelNotFoundError) {
            return fail(`Model not found: ${error.providerID}/${error.modelID}`)
          }
          if (error instanceof Provider.NoModelsError) return fail(`No models found for provider ${error.providerID}`)
          return fail("No providers found")
        },
      }),
    ))
  return yield* registry.tools({ ...model, agent })
})

function resolveTools(agent: Agent.Info, availableTools: { id: string }[]) {
  const disabled = Permission.disabled(
    availableTools.map((tool) => tool.id),
    agent.permission,
  )
  const resolved: Record<string, boolean> = {}
  for (const tool of availableTools) {
    resolved[tool.id] = !disabled.has(tool.id)
  }
  return resolved
}

function parseToolParams(input?: string) {
  if (!input) return {}
  const trimmed = input.trim()
  if (trimmed.length === 0) return {}

  const parsed = iife(() => {
    try {
      return JSON.parse(trimmed)
    } catch (jsonError) {
      try {
        return new Function(`return (${trimmed})`)()
      } catch (evalError) {
        log.warn("parseToolParams: failed to parse params", { jsonError, evalError, input })
        throw new Error(
          `Failed to parse --params. Use JSON or a JS object literal. JSON error: ${jsonError}. Eval error: ${evalError}.`,
          { cause: evalError },
        )
      }
    }
  })

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool params must be an object.")
  }
  return parsed as Record<string, unknown>
}

export const createToolContext = Effect.fn("Cli.debug.agent.createToolContext")(function* (
  agent: Agent.Info,
  ctx: InstanceContext,
) {
  const sessionSvc = yield* Session.Service
  const permission = yield* Effect.serviceOption(Permission.Service)
  const session = yield* sessionSvc.create({ title: `Debug tool run (${agent.name})` })
  const messageID = MessageID.ascending()
  const model = agent.model
    ? agent.model
    : yield* Effect.gen(function* () {
        const provider = yield* Provider.Service
        return yield* provider.defaultModel().pipe(
          Effect.matchCauseEffect({
            onSuccess: Effect.succeed,
            onFailure: (cause) => {
              const error = Cause.squash(cause) as Provider.DefaultModelError
              if (error instanceof Provider.ModelNotFoundError) {
                return fail(`Model not found: ${error.providerID}/${error.modelID}`)
              }
              if (error instanceof Provider.NoModelsError)
                return fail(`No models found for provider ${error.providerID}`)
              return fail("No providers found")
            },
          }),
        )
      })
  const now = Date.now()
  const message: SessionV1.Assistant = {
    id: messageID,
    sessionID: session.id,
    role: "assistant",
    time: { created: now },
    parentID: messageID,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: "debug",
    agent: agent.name,
    path: {
      cwd: ctx.directory,
      root: ctx.worktree,
    },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  yield* sessionSvc.updateMessage(message)

  return {
    sessionID: session.id,
    messageID,
    callID: PartID.ascending(),
    agent: agent.name,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask(req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">): any {
      return Effect.gen(function* () {
        // LOCK-001: debug uses the same complete evaluator context as Permission.Service via shared builder (no duplicate policy composition)
        if (permission._tag === "Some") {
          const isHardMode = ["ask", "plan", "architect"].includes(agent.name.toLowerCase())
          const out = yield* permission.value.evaluateForDebug({
            permission: req.permission,
            patterns: [...req.patterns],
            metadata: req.metadata as any,
            sessionID: String(session.id),
            agent: agent.name,
            agentPermission: (agent as any).permission as any,
            hardRuleset: isHardMode && (agent as any).permission && (agent as any).permission.length > 0 ? [...(agent as any).permission] as any : undefined,
            sessionPermission: (session as any).permission as any,
            trustedReadCapability: (req as any).trustedReadCapability,
          })
          const key = `${ctx.directory}:${out.provenance.request.permissionRequestId}`
          debugStore.set(key, out.provenance)
          if (out.result === "deny") {
            return yield* Effect.fail(new PermissionV1.DeniedError({ ruleset: agent.permission }))
          }
          if (out.result !== "allow") {
            return yield* Effect.fail(new PermissionV1.RejectedError())
          }
          return
        }
        // Fallback when Permission service unavailable (should not happen in production): fail closed
        return yield* Effect.fail(new PermissionV1.RejectedError())
      })
    },
  }
})
