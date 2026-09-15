import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import type { Tool as AITool, ToolExecutionOptions } from "ai"
import { jsonSchema } from "ai"
import path from "node:path"
import fs from "node:fs/promises"
import { Agent } from "../../src/agent/agent"
import { AgentCapability } from "../../src/agent/capability"
import { Permission } from "../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Plugin } from "../../src/plugin"
import { MCP } from "../../src/mcp"
import { Session } from "../../src/session/session"
import { SessionTools } from "../../src/session/tools"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { resolveTools as debugResolveTools } from "../../src/cli/cmd/debug/agent.handler"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import * as Tool from "../../src/tool/tool"
import { WriteTool } from "../../src/tool/write"
import { ShellTool } from "../../src/tool/shell"
import { TaskTool } from "../../src/tool/task"
import { repair, repairToolCall } from "../../src/session/llm/repair"
import { LLMNativeRuntime } from "../../src/session/llm/native-runtime"
import { Config } from "../../src/config/config"
import { Auth } from "../../src/auth"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceRef } from "../../src/effect/instance-ref"
import type { InstanceContext } from "../../src/project/instance-context"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Bus } from "../../src/bus"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp/lsp"
import * as ToolNetwork from "../../src/kilocode/sandbox/network"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { JournalMemory } from "../fixture/journal"
import { ProviderTest } from "../fake/provider"
import { BackgroundJob } from "../../src/background/job"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"

afterEach(async () => {
  await disposeAllInstances()
})

describe("AgentCapability pure semantics", () => {
  test("fromToolsConfig expands edit/write/patch aliases", () => {
    const seen = AgentCapability.fromToolsConfig({ write: false })
    expect(seen.disabled.sort()).toEqual(["apply_patch", "edit", "write"])
    expect(AgentCapability.isDisabled({ name: "code", disabledTools: seen.disabled }, "edit")).toBe(true)
    expect(AgentCapability.isDisabled({ name: "code", disabledTools: seen.disabled }, "write")).toBe(true)
    expect(AgentCapability.isDisabled({ name: "code", disabledTools: seen.disabled }, "apply_patch")).toBe(true)
    expect(AgentCapability.isDisabled({ name: "code", disabledTools: seen.disabled }, "bash")).toBe(false)
  })

  test("patch key normalizes to apply_patch", () => {
    const seen = AgentCapability.fromToolsConfig({ patch: false })
    expect(seen.disabled.sort()).toEqual(["apply_patch", "edit", "write"])
    expect(AgentCapability.isDisabled({ name: "code", disabledTools: seen.disabled }, "apply_patch")).toBe(true)
  })

  test("wildcard disables all unless explicitly re-enabled", () => {
    const seen = AgentCapability.fromToolsConfig({ "*": false, "github-triage": true })
    expect(seen.disabled).toContain("*")
    expect(seen.enabled).toContain("github-triage")
    const agent = { name: "triage", disabledTools: seen.disabled, enabledTools: seen.enabled }
    expect(AgentCapability.isDisabled(agent, "bash")).toBe(true)
    expect(AgentCapability.isDisabled(agent, "github-triage")).toBe(false)
    expect(AgentCapability.isDisabled(agent, "invalid")).toBe(true)
  })

  test("invalid remains available unless explicitly disabled", () => {
    const agent = { name: "code", disabledTools: ["bash"] }
    expect(AgentCapability.isDisabled(agent, "invalid")).toBe(false)
    const blocked = { name: "code", disabledTools: ["invalid"] }
    expect(AgentCapability.isDisabled(blocked, "invalid")).toBe(true)
  })

  test("merge keeps base disables unless same tool explicitly re-enabled", () => {
    const merged = AgentCapability.merge(["bash", "read"], [], { read: true })
    expect(merged.disabled).toContain("bash")
    expect(merged.disabled).not.toContain("read")
    const wildcard = AgentCapability.merge(["bash"], [], { "*": true })
    expect(wildcard.disabled).toContain("bash")
  })

  test("merge expands aliases on both sides", () => {
    const merged = AgentCapability.merge([], [], { write: false })
    expect(merged.disabled.sort()).toEqual(["apply_patch", "edit", "write"])
    const reopened = AgentCapability.merge(merged.disabled, merged.enabled, { edit: true })
    expect(reopened.disabled).toEqual([])
  })

  test("DisabledError is distinct from permission errors with stable message", () => {
    const err = new AgentCapability.DisabledError({ tool: "bash", agent: "code" })
    expect(err._tag).toBe("AgentToolDisabledError")
    expect(err).not.toBeInstanceOf(PermissionV1.DeniedError)
    expect(err).not.toBeInstanceOf(PermissionV1.RejectedError)
    expect(err.message).toContain("bash")
    expect(err.message).toContain("code")
    expect(err.message).toContain("cannot be re-enabled")
  })

  test("filterTools derives presentation from enforcement", () => {
    const agent = { name: "code", disabledTools: ["bash"] }
    const out = AgentCapability.filterTools(agent, { bash: 1, read: 2, invalid: 3 })
    expect(out).toEqual({ read: 2, invalid: 3 })
  })

  test("repair maps disabled/unknown tools to invalid without side effects", () => {
    const tools = { read: {}, invalid: {} }
    expect(repair("bash", {}, tools).name).toBe("invalid")
    expect(repair("read", {}, tools).name).toBe("read")
    const failed = { toolCall: { toolName: "bash", input: "{}" }, error: { message: "no such tool" } } as any
    expect(repairToolCall(failed, tools).toolName).toBe("invalid")
  })

  test("native bridge reuses prepared execute (single source)", () => {
    const tools = {
      read: {
        description: "r",
        inputSchema: { jsonSchema: { type: "object", properties: {} } },
        execute: async () => ({ output: "ok" }),
      },
    } as unknown as Record<string, AITool>
    const bridged = LLMNativeRuntime.nativeTools(tools, { messages: [], abort: new AbortController().signal })
    expect(Object.keys(bridged)).toEqual(["read"])
  })
})

const agentLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Agent.layer.pipe(
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(Layer.mock(MCP.Service)({})),
    Layer.provide(RuntimeFlags.layer(flags)),
  )

const agentIt = testEffect(agentLayer())

describe("agent normalization and merge", () => {
  agentIt.instance(
    "tools:false survives as capability set alongside permission deny",
    () =>
      Effect.gen(function* () {
        const build = yield* Agent.Service.use((svc) => svc.get("build"))
        expect(build?.disabledTools ?? []).toContain("bash")
        expect(build?.disabledTools ?? []).toContain("read")
        // compatibility/presentation permission still denies
        expect(build?.permission.some((r) => r.permission === "bash" && r.action === "deny")).toBe(true)
        expect(AgentCapability.isDisabled(build!, "bash")).toBe(true)
        expect(AgentCapability.isDisabled(build!, "read")).toBe(true)
        expect(AgentCapability.isDisabled(build!, "edit")).toBe(false)
      }),
    {
      config: {
        agent: {
          build: {
            tools: {
              bash: false,
              read: false,
            },
          },
        },
      },
    },
  )

  agentIt.instance(
    "write:false disables the full edit group",
    () =>
      Effect.gen(function* () {
        const build = yield* Agent.Service.use((svc) => svc.get("build"))
        expect(AgentCapability.isDisabled(build!, "edit")).toBe(true)
        expect(AgentCapability.isDisabled(build!, "write")).toBe(true)
        expect(AgentCapability.isDisabled(build!, "apply_patch")).toBe(true)
      }),
    {
      config: {
        agent: {
          build: {
            tools: {
              write: false,
            },
          },
        },
      },
    },
  )

  agentIt.instance(
    "agent.permission allow cannot reopen a disabled tool",
    () =>
      Effect.gen(function* () {
        const build = yield* Agent.Service.use((svc) => svc.get("build"))
        expect(AgentCapability.isDisabled(build!, "bash")).toBe(true)
      }),
    {
      config: {
        agent: {
          build: {
            tools: {
              bash: false,
            },
            permission: {
              bash: "allow",
            },
          },
        },
      },
    },
  )

  agentIt.instance(
    "wildcard disable with single re-enable survives normalization",
    () =>
      Effect.gen(function* () {
        const triage = yield* Agent.Service.use((svc) => svc.get("triage"))
        expect(AgentCapability.isDisabled(triage!, "bash")).toBe(true)
        expect(AgentCapability.isDisabled(triage!, "github-triage")).toBe(false)
      }),
    {
      config: {
        agent: {
          triage: {
            tools: {
              "*": false,
              "github-triage": true,
            },
          } as any,
        },
      },
    },
  )
})

// SessionTools wrapper tests with real temp files and counters.
const projectID = ProjectV2.ID.make("capability-tools")
const sessionID = SessionID.make("ses_capability-tools")
const model = ProviderTest.model()

function session(directory: string): Session.Info {
  return {
    id: sessionID,
    slug: "capability-tools",
    projectID,
    directory,
    title: "capability",
    version: "test",
    permission: Permission.fromConfig({ "*": "allow" }),
    time: { created: 0, updated: 0 },
  }
}

function message(ctx: InstanceContext): MessageV2.Assistant {
  return {
    id: MessageID.make("msg_capability-tools"),
    role: "assistant",
    parentID: MessageID.make("msg_capability-parent"),
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: ctx.directory, root: ctx.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.id,
    providerID: model.providerID,
    time: { created: 0 },
  }
}

function context(directory: string): InstanceContext {
  return {
    directory,
    worktree: directory,
    project: { id: projectID, worktree: directory, vcs: "git", time: { created: 0, updated: 0 }, sandboxes: [] },
  }
}

function wrapperLayer(agent: Agent.Info, mcpTools: Record<string, AITool>, hooks: string[], asks: string[]) {
  const config = TestConfig.layer({ get: () => Effect.succeed({ sandbox: { enabled: false } }) })
  const agents = Layer.mock(Agent.Service)({ get: () => Effect.succeed(agent) })
  const sessions = Layer.mock(Session.Service)({ get: () => Effect.succeed(session("/tmp")) })
  const permission = Layer.mock(Permission.Service)({
    ask: (input: any) => Effect.sync(() => void asks.push(input.permission)),
  })
  const plugin = Layer.mock(Plugin.Service)({
    trigger: (name: any, input: any, output: any) =>
      Effect.sync(() => {
        hooks.push(`${String(name)}:${input.tool}`)
        return output
      }),
  })
  const mcp = Layer.mock(MCP.Service)({ tools: () => Effect.succeed(mcpTools) })
  const lsp = Layer.mock(LSP.Service)({ touchFile: () => Effect.void, diagnostics: () => Effect.succeed({}) })
  const format = Layer.mock(Format.Service)({ file: () => Effect.succeed(false) })
  const truncate = Layer.mock(Truncate.Service)({
    output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
    limits: () => Effect.succeed({ maxLines: Truncate.MAX_LINES, maxBytes: Truncate.MAX_BYTES }),
  })
  const base = Layer.mergeAll(
    JournalMemory,
    config,
    agents,
    sessions,
    permission,
    plugin,
    mcp,
    lsp,
    format,
    truncate,
    Bus.layer,
    EventV2Bridge.defaultLayer,
    Database.defaultLayer,
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    RuntimeFlags.layer(),
  )
  return Layer.effect(
    ToolRegistry.Service,
    Effect.gen(function* () {
      const write = yield* WriteTool.pipe(Effect.flatMap(Tool.init))
      const shell = yield* ShellTool.pipe(Effect.flatMap(Tool.init))
      const list = [ToolNetwork.builtin(write), ToolNetwork.builtin(shell)]
      return ToolRegistry.Service.of({
        ids: () => Effect.succeed(list.map((item) => item.id)),
        all: () => Effect.succeed(list),
        named: () => Effect.die(new Error("not used")),
        tools: () => Effect.succeed(list),
      })
    }),
  ).pipe(Layer.provideMerge(base))
}

function resolve(agent: Agent.Info, ctx: InstanceContext) {
  return SessionTools.resolve({
    agent,
    model,
    session: session(ctx.directory),
    processor: {
      message: message(ctx),
      metadata: () => Effect.void,
      completeToolCall: () => Effect.void,
    },
    bypassAgentCheck: false,
    messages: [],
    promptOps: {
      cancel: () => Effect.die(new Error("not used")),
      resolvePromptParts: () => Effect.die(new Error("not used")),
      prompt: () => Effect.die(new Error("not used")),
    },
  }).pipe(Effect.provideService(InstanceRef, ctx))
}

const builtinAgent = (disabled: string[]): Agent.Info => ({
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
  disabledTools: disabled,
  enabledTools: [],
})

describe("SessionTools capability enforcement", () => {
  test("allowed tool executes with side effects", async () => {
    const hooks: string[] = []
    const asks: string[] = []
    const agent = builtinAgent([])
    const layer = wrapperLayer(agent, {}, hooks, asks)
    const root = await fs.mkdtemp(path.join(import.meta.dir, "cap-"))
    try {
      const ctx = context(root)
      const file = path.join(root, "allowed.txt")
      await Effect.runPromise(
        Effect.gen(function* () {
          const tools = yield* resolve(agent, ctx)
          expect(tools.bash).toBeDefined()
          const options: ToolExecutionOptions = {
            toolCallId: "call-allowed",
            messages: [],
            abortSignal: new AbortController().signal,
          }
          const out = (yield* Effect.tryPromise({
            try: () =>
              Promise.resolve(
                tools.bash!.execute!({ command: `echo ok > ${JSON.stringify(file)}`, description: "write file" }, options),
              ),
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          })) as { output: string }
          void out
          expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toContain("ok")
        }).pipe(Effect.scoped, Effect.provide(layer)) as Effect.Effect<void>,
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("builtin disabled is filtered with typed error and no side effects", async () => {
    const hooks: string[] = []
    const asks: string[] = []
    const agent = builtinAgent(["write", "edit", "apply_patch"])
    const layer = wrapperLayer(agent, {}, hooks, asks)
    const root = await fs.mkdtemp(path.join(import.meta.dir, "cap-"))
    try {
      const ctx = context(root)
      await Effect.runPromise(
        Effect.gen(function* () {
          const tools = yield* resolve(agent, ctx)
          expect(tools.write).toBeUndefined()
          expect(tools.bash).toBeDefined()
          const exit = yield* Effect.exit(AgentCapability.assert(agent, "write"))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const defect = Cause.squash(exit.cause)
            expect(defect).toBeInstanceOf(AgentCapability.DisabledError)
            expect(String((defect as Error).message)).toContain("disabled")
          }
          expect(hooks.filter((h) => h.includes("write"))).toEqual([])
          expect(asks).toEqual([])
        }).pipe(Effect.scoped, Effect.provide(layer)) as Effect.Effect<void>,
      )
      expect(await fs.access(path.join(root, "blocked.txt")).then(() => true).catch(() => false)).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("mcp disabled is filtered before ask/execute", async () => {
    const hooks: string[] = []
    const asks: string[] = []
    const executed: string[] = []
    const agent = builtinAgent(["mcp__tool"])
    const mcpTools = {
      mcp__tool: {
        description: "mcp",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => {
          executed.push("mcp__tool")
          return { content: [{ type: "text", text: "mcp" }] }
        },
      },
    } as unknown as Record<string, AITool>
    const layer = wrapperLayer(agent, mcpTools, hooks, asks)
    const root = await fs.mkdtemp(path.join(import.meta.dir, "cap-"))
    try {
      const ctx = context(root)
      await Effect.runPromise(
        Effect.gen(function* () {
          const tools = yield* resolve(agent, ctx)
          expect(tools.mcp__tool).toBeUndefined()
          expect(executed).toEqual([])
          expect(asks).toEqual([])
          const exit = yield* Effect.exit(AgentCapability.assert(agent, "mcp__tool"))
          expect(Exit.isFailure(exit)).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(layer)) as Effect.Effect<void>,
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("allow rule in permission cannot reopen capability", async () => {
    const agent: Agent.Info = {
      name: "build",
      mode: "primary",
      permission: Permission.fromConfig({ bash: "allow", "*": "allow" }),
      options: {},
      disabledTools: ["bash"],
      enabledTools: [],
    }
    expect(AgentCapability.isDisabled(agent, "bash")).toBe(true)
    const exit = await Effect.runPromise(Effect.exit(AgentCapability.assert(agent, "bash")))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("debug visibility derives from the same capability set", () => {
    const agent: Agent.Info = {
      name: "build",
      mode: "primary",
      permission: Permission.fromConfig({ "*": "allow" }),
      options: {},
      disabledTools: ["bash"],
      enabledTools: [],
    }
    const available = [{ id: "bash" }, { id: "read" }, { id: "invalid" }]
    expect(debugResolveTools(agent, available)).toEqual({ bash: false, read: true, invalid: true })
  })

  test("disabled builtin rejects through real wrapper before hooks/ask/execute", async () => {
    const hooks: string[] = []
    const asks: string[] = []
    const agent = builtinAgent([])
    const layer = wrapperLayer(agent, {}, hooks, asks)
    const root = await fs.mkdtemp(path.join(import.meta.dir, "cap-"))
    try {
      const ctx = context(root)
      const file = path.join(root, "blocked-wrapper.txt")
      await Effect.runPromise(
        Effect.gen(function* () {
          const tools = yield* resolve(agent, ctx)
          const handle = tools.bash
          expect(handle?.execute).toBeDefined()
          agent.disabledTools = ["bash"]
          hooks.length = 0
          asks.length = 0
          const options: ToolExecutionOptions = {
            toolCallId: "call-blocked-wrapper",
            messages: [],
            abortSignal: new AbortController().signal,
          }
          const exit = yield* Effect.exit(
            Effect.promise(() =>
              handle!.execute!({ command: `echo pwn > ${JSON.stringify(file)}`, description: "blocked" }, options),
            ),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const defect = Cause.squash(exit.cause)
            expect(defect).toBeInstanceOf(AgentCapability.DisabledError)
            expect((defect as Error).message).toContain("bash")
            expect((defect as Error).message).toContain("cannot be re-enabled")
          }
          expect(hooks).toEqual([])
          expect(asks).toEqual([])
        }).pipe(Effect.scoped, Effect.provide(layer)) as Effect.Effect<void>,
      )
      expect(await fs.access(file).then(() => true).catch(() => false)).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("disabled MCP rejects through real wrapper with no ask/network execute", async () => {
    const hooks: string[] = []
    const asks: string[] = []
    const executed: string[] = []
    const agent = builtinAgent([])
    const mcpTools = {
      mcp__tool: {
        description: "mcp",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => {
          executed.push("mcp__tool")
          return { content: [{ type: "text", text: "mcp" }] }
        },
      },
    } as unknown as Record<string, AITool>
    const layer = wrapperLayer(agent, mcpTools, hooks, asks)
    const root = await fs.mkdtemp(path.join(import.meta.dir, "cap-"))
    try {
      const ctx = context(root)
      await Effect.runPromise(
        Effect.gen(function* () {
          const tools = yield* resolve(agent, ctx)
          const handle = (tools as Record<string, AITool>).mcp__tool
          expect(handle?.execute).toBeDefined()
          agent.disabledTools = ["mcp__tool"]
          hooks.length = 0
          asks.length = 0
          executed.length = 0
          const exit = yield* Effect.exit(
            Effect.promise(() =>
              (handle as AITool).execute!({}, { toolCallId: "call-mcp-blocked", messages: [], abortSignal: new AbortController().signal }),
            ),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.squash(exit.cause)).toBeInstanceOf(AgentCapability.DisabledError)
          }
          expect(hooks).toEqual([])
          expect(asks).toEqual([])
          expect(executed).toEqual([])
        }).pipe(Effect.scoped, Effect.provide(layer)) as Effect.Effect<void>,
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("debug direct execution gate shares assertion before execute", async () => {
    const source = await fs.readFile(path.join(import.meta.dir, "../../src/cli/cmd/debug/agent.handler.ts"), "utf8")
    const gate = source.indexOf("AgentCapability.assert(agent, toolID)")
    if (gate === -1) throw new Error("debug handler missing shared AgentCapability.assert")
    const contextAt = source.indexOf("createToolContext(agent", gate)
    const executeAt = source.indexOf("tool.execute(params, toolCtx)", gate)
    expect(gate).toBeGreaterThan(-1)
    expect(contextAt).toBeGreaterThan(gate)
    expect(executeAt).toBeGreaterThan(gate)
  })
})

const taskLayer = () =>
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    EventV2Bridge.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    Provider.defaultLayer,
    ToolRegistry.defaultLayer.pipe(Layer.provide(JournalMemory)),
    Database.defaultLayer,
    RuntimeFlags.layer(),
  )

const taskIt = testEffect(taskLayer())

function taskReply(input: { sessionID: SessionID; messageID: MessageID; agent: string }): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID,
      sessionID: input.sessionID,
      mode: input.agent,
      agent: input.agent,
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as any,
      providerID: "test" as any,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text: "done" }],
  } as unknown as MessageV2.WithParts
}

describe("task capability bypass closed", () => {
  taskIt.instance(
    "direct TaskTool execution fails before ask/prompt side effects when task is disabled",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "capability-task" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: { providerID: "test" as any, modelID: "test-model" as any },
          time: { created: Date.now() },
        })
        const assistant: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user.id,
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "test-model" as any,
          providerID: "test" as any,
          time: { created: Date.now() },
        }
        yield* sessions.updateMessage(assistant)
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let prompted = false
        let asks = 0
        const exit = yield* def
          .execute(
            { description: "blocked", prompt: "do work", subagent_type: "general" },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: {
                promptOps: {
                  cancel: () => Effect.void,
                  resolvePromptParts: (template: string) =>
                    Effect.succeed([{ type: "text" as const, text: template }]),
                  prompt: () => Effect.sync(() => void (prompted = true)).pipe(Effect.as(undefined as never)),
                },
              },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.sync(() => void asks++),
            },
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const defect = Cause.squash(exit.cause)
          expect(defect).toBeInstanceOf(AgentCapability.DisabledError)
          expect((defect as Error).message).toContain("task")
          expect((defect as Error).message).toContain("cannot be re-enabled")
        }
        expect(asks).toBe(0)
        expect(prompted).toBe(false)
        expect(yield* sessions.children(chat.id)).toHaveLength(0)
      }),
    {
      config: {
        agent: {
          build: {
            tools: {
              task: false,
            },
          },
        },
      },
    },
  )

  taskIt.instance(
    "bypassAgentCheck does not bypass caller task capability",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "capability-task-bypass" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: { providerID: "test" as any, modelID: "test-model" as any },
          time: { created: Date.now() },
        })
        const assistant: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user.id,
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "test-model" as any,
          providerID: "test" as any,
          time: { created: Date.now() },
        }
        yield* sessions.updateMessage(assistant)
        const def = yield* (yield* TaskTool).init()
        let prompted = false
        const exit = yield* def
          .execute(
            { description: "blocked", prompt: "do work", subagent_type: "general" },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: {
                bypassAgentCheck: true,
                promptOps: {
                  cancel: () => Effect.void,
                  resolvePromptParts: (template: string) =>
                    Effect.succeed([{ type: "text" as const, text: template }]),
                  prompt: () => Effect.sync(() => void (prompted = true)).pipe(Effect.as(undefined as never)),
                },
              },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(AgentCapability.DisabledError)
        }
        expect(prompted).toBe(false)
        expect(yield* sessions.children(chat.id)).toHaveLength(0)
      }),
    {
      config: {
        agent: {
          build: {
            tools: {
              task: false,
            },
          },
        },
      },
    },
  )

  taskIt.instance(
    "parent caller task capability controls dispatch, not target child flag",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "capability-task-caller" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: { providerID: "test" as any, modelID: "test-model" as any },
          time: { created: Date.now() },
        })
        const assistant: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user.id,
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "test-model" as any,
          providerID: "test" as any,
          time: { created: Date.now() },
        }
        yield* sessions.updateMessage(assistant)
        const def = yield* (yield* TaskTool).init()
        let prompted = false
        let asks = 0
        const result = yield* def.execute(
          { description: "allowed", prompt: "do work", subagent_type: "general" },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                cancel: () => Effect.void,
                resolvePromptParts: (template: string) =>
                  Effect.succeed([{ type: "text" as const, text: template }]),
                prompt: (input: any) =>
                  Effect.sync(() => void (prompted = true)).pipe(
                    Effect.as(taskReply({ sessionID: input.sessionID, messageID: input.messageID, agent: "general" }) as never),
                  ),
              },
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => void asks++),
          },
        )
        expect(prompted).toBe(true)
        expect(result.title).toBe("allowed")
        expect(yield* sessions.children(chat.id)).toHaveLength(1)
      }),
    {
      config: {
        agent: {
          general: {
            tools: {
              task: false,
            },
          },
        },
      },
    },
  )
})
