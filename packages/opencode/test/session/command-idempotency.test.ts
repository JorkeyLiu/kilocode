import { NodeFileSystem } from "@effect/platform-node"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Bus } from "@/bus"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Auth } from "../../src/auth"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { GenerationGate } from "../../src/kilocode/server/generation-gate"
import { MessageID } from "../../src/session/schema"
import { SessionRunState } from "../../src/session/run-state"
import { SessionRevert } from "../../src/session/revert"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import * as Log from "@opencode-ai/core/util/log"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/filesystem/ripgrep"
import { Format } from "../../src/format"
import { Reference } from "../../src/reference/reference"
import { RepositoryCache } from "../../src/reference/repository-cache"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import * as Ownership from "@/retention/ownership"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in command-idempotency tests"),
    authenticate: () => Effect.die("unexpected MCP auth in command-idempotency tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in command-idempotency tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(Ownership.layer, NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

const agent: AgentSvc.Info = {
  name: "build",
  mode: "primary",
  native: true,
  permission: Permission.fromConfig({ "*": "allow" }),
  model: ref,
  options: {},
}
const fastAgents = Layer.mock(AgentSvc.Service)({
  get: () => Effect.succeed(agent),
  list: () => Effect.succeed([agent]),
  defaultInfo: () => Effect.succeed(agent),
  defaultAgent: () => Effect.succeed(agent.name),
  guardRequirements: () => Effect.void,
})

function countingPlugin(counter: { before: number }) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name === "command.execute.before") counter.before++
      return Effect.succeed(output)
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

function makePrompt(pluginLayer: Layer.Layer<Plugin.Service>) {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    pluginLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    FSUtil.defaultLayer,
    BackgroundJob.defaultLayer,
    status,
    Database.defaultLayer,
    EventV2Bridge.defaultLayer,
    Bus.layer,
    GenerationGate.defaultLayer,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(RepositoryCache.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provide(Auth.defaultLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(deps),
  )
  const compact = SessionCompaction.layer.pipe(
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(proc),
    Layer.provideMerge(deps),
  )
  return SessionPrompt.layer.pipe(
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(summary),
    Layer.provideMerge(run),
    Layer.provideMerge(compact),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    Layer.provideMerge(question),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(SystemPrompt.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(deps),
    Layer.provide(summary),
  )
}

function makeHttp(counter: { before: number }) {
  return Layer.mergeAll(TestLLMServer.layer, makePrompt(countingPlugin(counter)))
}

const counter = { before: 0 }
const it = testEffect(makeHttp(counter))

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: { ...cfg.provider, test: { ...cfg.provider.test, options: { apiKey: "test-key", baseURL: url } } },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})
const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(path.join(dir, ".kilo", "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json", ...config }))
})
const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})
const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, sessions, chat }
})

const readMarkerLines = Effect.fn("test.readMarkerLines")(function* (file: string) {
  const raw = yield* Effect.promise(() =>
    Bun.file(file)
      .exists()
      .then(async (ok) => (ok ? Bun.file(file).text() : "")),
  ).pipe(Effect.orElseSucceed(() => ""))
  return raw.split("\n").filter((line) => line.includes("shell-hit")).length
})

it.instance("supplied command sequential replay runs shell and plugin once", () =>
  Effect.gen(function* () {
    counter.before = 0
    const { directory: dir } = yield* TestInstance
    const marker = path.join(dir, "shell-marker.txt")
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      command: {
        probe: { template: `Probe says hi. Shell says !\`echo shell-hit >> ${marker} && echo ok\`` },
      },
    }))
    const { prompt, sessions, chat } = yield* boot()
    yield* llm.text("cmd reply")
    const id = MessageID.ascending()
    const first = yield* prompt.command({ sessionID: chat.id, messageID: id, command: "probe", arguments: "" })
    expect(first.info.role).toBe("assistant")
    const second = yield* prompt.command({ sessionID: chat.id, messageID: id, command: "probe", arguments: "" })
    expect(second.info.id).toBe(id)
    expect(second.info.role).toBe("user")
    expect(yield* llm.hits).toHaveLength(1)
    expect(counter.before).toBe(1)
    expect(yield* readMarkerLines(marker)).toBe(1)
    const all = yield* sessions.messages({ sessionID: chat.id })
    expect(all.filter((m) => m.info.id === id)).toHaveLength(1)
    const children = all.filter(
      (m) => m.info.role !== "user" && (m.info as unknown as { parentID?: string }).parentID === id,
    )
    expect(children).toHaveLength(1)
    void sessions
  }),
  30_000,
)

it.instance("supplied command concurrent replay shares one execution", () =>
  Effect.gen(function* () {
    counter.before = 0
    const { directory: dir } = yield* TestInstance
    const marker = path.join(dir, "shell-concurrent.txt")
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      command: {
        probe: { template: `Probe concurrent !\`echo shell-hit >> ${marker} && echo ok\`` },
      },
    }))
    const { prompt, sessions, chat } = yield* boot()
    yield* llm.text("concurrent reply")
    const id = MessageID.ascending()
    const input = { sessionID: chat.id, messageID: id, command: "probe", arguments: "" }
    const [a, b] = yield* Effect.all([prompt.command(input), prompt.command(input)], { concurrency: 2 })
    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    expect(yield* llm.hits).toHaveLength(1)
    expect(counter.before).toBe(1)
    expect(yield* readMarkerLines(marker)).toBe(1)
    const all = yield* sessions.messages({ sessionID: chat.id })
    expect(all.filter((m) => m.info.id === id)).toHaveLength(1)
    void sessions
  }),
  30_000,
)

it.instance("legacy review command replay writes one user and one static assistant", () =>
  Effect.gen(function* () {
    counter.before = 0
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      command: { "local-review": { template: "unused", description: "deprecated" } },
    }))
    const { prompt, sessions, chat } = yield* boot()
    const id = MessageID.ascending()
    const first = yield* prompt.command({ sessionID: chat.id, messageID: id, command: "local-review", arguments: "" })
    expect(first.info.role).toBe("assistant")
    const second = yield* prompt.command({ sessionID: chat.id, messageID: id, command: "local-review", arguments: "" })
    expect(second.info.id).toBe(id)
    expect(second.info.role).toBe("user")
    expect(yield* llm.hits).toHaveLength(0)
    expect(counter.before).toBe(0)
    const all = yield* sessions.messages({ sessionID: chat.id })
    expect(all.filter((m) => m.info.id === id)).toHaveLength(1)
    const children = all.filter(
      (m) => m.info.role !== "user" && (m.info as unknown as { parentID?: string }).parentID === id,
    )
    expect(children).toHaveLength(1)
    void sessions
  }),
  30_000,
)

it.instance("command cross-session reuse and non-user occupancy fail safely", () =>
  Effect.gen(function* () {
    counter.before = 0
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      command: { probe: { template: "Probe says hi" } },
    }))
    const { prompt, sessions } = yield* boot()
    const chatA = yield* sessions.create({ title: "A" })
    const chatB = yield* sessions.create({ title: "B" })
    yield* llm.text("a reply")
    const id = MessageID.ascending()
    yield* prompt.command({ sessionID: chatA.id, messageID: id, command: "probe", arguments: "" })
    const cross = yield* prompt.command({ sessionID: chatB.id, messageID: id, command: "probe", arguments: "" }).pipe(
      Effect.exit,
    )
    expect(Exit.isFailure(cross)).toBe(true)
    const missing = yield* MessageV2.get({ sessionID: chatB.id, messageID: id }).pipe(
      Effect.provideService(Database.Service, yield* Database.Service),
      Effect.exit,
    )
    expect(Exit.isFailure(missing)).toBe(true)
    const kept = yield* MessageV2.get({ sessionID: chatA.id, messageID: id }).pipe(
      Effect.provideService(Database.Service, yield* Database.Service),
    )
    expect(kept.info.sessionID).toBe(chatA.id)
    const taken = MessageID.ascending()
    yield* sessions.updateMessage({
      id: taken,
      role: "assistant",
      parentID: taken,
      sessionID: chatA.id,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now(), completed: Date.now() },
      finish: "stop",
    } satisfies SessionV1.Assistant)
    const occupied = yield* prompt.command({ sessionID: chatA.id, messageID: taken, command: "probe", arguments: "" }).pipe(
      Effect.exit,
    )
    expect(Exit.isFailure(occupied)).toBe(true)
    void sessions
    void Fiber
  }),
  30_000,
)

it.instance("missing messageID keeps two independent command executions", () =>
  Effect.gen(function* () {
    counter.before = 0
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      command: { probe: { template: "Probe says hi" } },
    }))
    const { prompt, sessions, chat } = yield* boot()
    yield* llm.text("one")
    yield* llm.text("two")
    const one = yield* prompt.command({ sessionID: chat.id, command: "probe", arguments: "" })
    const two = yield* prompt.command({ sessionID: chat.id, command: "probe", arguments: "" })
    expect(one.info.role).toBe("assistant")
    expect(two.info.role).toBe("assistant")
    expect(one.info.id === two.info.id).toBe(false)
    expect(yield* llm.hits).toHaveLength(2)
    expect(counter.before).toBe(2)
    void sessions
  }),
  30_000,
)
