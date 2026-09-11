import { NodeFileSystem } from "@effect/platform-node"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Bus } from "@/bus"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
import { Telemetry } from "@kilocode/kilo-telemetry"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
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
import { KiloSessionPromptQueue } from "../../src/kilocode/session/prompt-queue"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, SessionID } from "../../src/session/schema"
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
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { JournalMemory } from "../fixture/journal" // kilocode_change - file tools require canonical journal
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
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
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
const infra = Layer.mergeAll(JournalMemory, Ownership.layer, NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

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

function makePrompt() {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
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

function makeHttp() {
  return Layer.mergeAll(TestLLMServer.layer, makePrompt())
}

const it = testEffect(makeHttp())

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

// First-writer-wins is narrow: the first accepted durable message is
// authoritative and later payload reuse is not compared and never overwrites.
it.instance("sequential same-ID replay after noReply returns original parts without overwrite", () =>
  Effect.gen(function* () {
    yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    const id = MessageID.ascending()
    const first = yield* prompt.prompt({
      sessionID: chat.id,
      messageID: id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "first" }],
    })
    expect(first.info.id).toBe(id)
    const second = yield* prompt.prompt({
      sessionID: chat.id,
      messageID: id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "second different payload" }],
    })
    expect(second.info.id).toBe(id)
    expect(second.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text)).toEqual(
      first.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text),
    )
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: id }).pipe(
      Effect.provideService(Database.Service, yield* Database.Service),
    )
    expect(stored.parts).toHaveLength(first.parts.length)
    expect(stored.parts.every((p) => (p as { text?: string }).text !== "second different payload")).toBe(true)
    void sessions
  }),
)

it.instance("concurrent same-ID non-noReply shares one user write and one generation", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    yield* llm.text("hello")
    const id = MessageID.ascending()
    const input = {
      sessionID: chat.id,
      messageID: id,
      agent: "build",
      parts: [{ type: "text" as const, text: "concurrent" }],
    }
    const [a, b] = yield* Effect.all([prompt.prompt(input), prompt.prompt(input)], { concurrency: 2 })
    expect(a.info.id).toBe(b.info.id)
    expect(yield* llm.hits).toHaveLength(1)
    const all = yield* sessions.messages({ sessionID: chat.id })
    expect(all.filter((m) => m.info.id === id)).toHaveLength(1)
    void sessions
  }),
  30_000,
)

it.instance("durable user without lineage reattaches exactly one generation under concurrency", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    const id = MessageID.ascending()
    yield* prompt.prompt({ sessionID: chat.id, messageID: id, agent: "build", noReply: true, parts: [{ type: "text", text: "restart me" }] })
    expect(KiloSessionPromptQueue.isOwned(chat.id, id)).toBe(false)
    yield* llm.text("reattached")
    const input = { sessionID: chat.id, messageID: id, agent: "build", parts: [{ type: "text" as const, text: "restart me" }] }
    const [a, b] = yield* Effect.all([prompt.prompt(input), prompt.prompt(input)], { concurrency: 2 })
    expect(a.info.id).toBe(b.info.id)
    expect(yield* llm.hits).toHaveLength(1)
    const all = yield* sessions.messages({ sessionID: chat.id })
    const children = all.filter((m) => m.info.role !== "user" && (m.info as unknown as { parentID?: string }).parentID === id)
    expect(children).toHaveLength(1)
  }),
  30_000,
)

it.instance("durable user with assistant lineage does not reenqueue", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    yield* llm.text("one")
    const id = MessageID.ascending()
    const first = yield* prompt.prompt({ sessionID: chat.id, messageID: id, agent: "build", parts: [{ type: "text", text: "turn" }] })
    expect(first.info.role).toBe("assistant")
    expect((first.info as unknown as { parentID?: string }).parentID).toBe(id)
    expect(yield* llm.hits).toHaveLength(1)
    // Lineage exists: replay returns the existing durable user without a second generation.
    const replay = yield* prompt.prompt({ sessionID: chat.id, messageID: id, agent: "build", parts: [{ type: "text", text: "turn again" }] })
    expect(replay.info.id).toBe(id)
    expect(replay.info.role).toBe("user")
    expect(yield* llm.hits).toHaveLength(1)
    const all = yield* sessions.messages({ sessionID: chat.id })
    const children = all.filter((m) => m.info.role !== "user" && (m.info as unknown as { parentID?: string }).parentID === id)
    expect(children).toHaveLength(1)
    // Failed lineage also suppresses reattach.
    const failedID = MessageID.ascending()
    yield* prompt.prompt({ sessionID: chat.id, messageID: failedID, agent: "build", noReply: true, parts: [{ type: "text", text: "will fail" }] })
    const failedAssistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: failedID,
      sessionID: chat.id,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now(), completed: Date.now() },
      error: MessageV2.fromError(new Error("boom"), { providerID: ref.providerID }),
    } satisfies SessionV1.Assistant)
    void failedAssistant
    const hitsBefore = (yield* llm.hits).length
    const failedReplay = yield* prompt.prompt({ sessionID: chat.id, messageID: failedID, agent: "build", parts: [{ type: "text", text: "will fail retry" }] })
    expect(failedReplay.info.id).toBe(failedID)
    expect((yield* llm.hits).length).toBe(hitsBefore)
  }),
  30_000,
)

it.instance("per-ID ownership suppresses only the owned target", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    const ownedID = MessageID.ascending()
    yield* prompt.prompt({ sessionID: chat.id, messageID: ownedID, agent: "build", noReply: true, parts: [{ type: "text", text: "owned" }] })
    // Hold the owned target in the queue with slow work, then replay must return
    // immediately without a new generation.
    const slow = yield* KiloSessionPromptQueue.enqueue(chat.id, ownedID, Effect.sleep("500 millis"), Effect.void).pipe(Effect.forkChild)
    yield* pollWithTimeout(
      Effect.sync(() => (KiloSessionPromptQueue.isOwned(chat.id, ownedID) ? (true as const) : undefined)),
      "owned target never became queue-owned",
    )
    const unrelatedID = MessageID.ascending()
    expect(KiloSessionPromptQueue.isOwned(chat.id, unrelatedID)).toBe(false)
    const hitsBefore = (yield* llm.hits).length
    const replay = yield* prompt.prompt({ sessionID: chat.id, messageID: ownedID, agent: "build", parts: [{ type: "text", text: "owned retry" }] })
    expect(replay.info.id).toBe(ownedID)
    expect((yield* llm.hits).length).toBe(hitsBefore)
    yield* Fiber.interrupt(slow).pipe(Effect.ignore)
    // Unrelated queued work does not suppress reattach: fresh ID with no lineage
    // still generates exactly once.
    const freshID = MessageID.ascending()
    yield* prompt.prompt({ sessionID: chat.id, messageID: freshID, agent: "build", noReply: true, parts: [{ type: "text", text: "fresh" }] })
    yield* llm.text("fresh reply")
    const fresh = yield* prompt.prompt({ sessionID: chat.id, messageID: freshID, agent: "build", parts: [{ type: "text", text: "fresh" }] })
    expect(fresh.info.role).toBe("assistant")
    void sessions
  }),
  30_000,
)

it.instance("cross-session messageID reuse fails safely without overwrite", () =>
  Effect.gen(function* () {
    yield* useServerConfig(providerCfg)
    const { prompt, sessions } = yield* boot()
    const chatA = yield* sessions.create({ title: "A" })
    const chatB = yield* sessions.create({ title: "B" })
    const id = MessageID.ascending()
    yield* prompt.prompt({ sessionID: chatA.id, messageID: id, agent: "build", noReply: true, parts: [{ type: "text", text: "session a" }] })
    const exit = yield* prompt.prompt({ sessionID: chatB.id, messageID: id, agent: "build", noReply: true, parts: [{ type: "text", text: "session b" }] }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    const missing = yield* MessageV2.get({ sessionID: chatB.id, messageID: id }).pipe(
      Effect.provideService(Database.Service, yield* Database.Service),
      Effect.exit,
    )
    expect(Exit.isFailure(missing)).toBe(true)
    const kept = yield* MessageV2.get({ sessionID: chatA.id, messageID: id }).pipe(
      Effect.provideService(Database.Service, yield* Database.Service),
    )
    expect(kept.info.sessionID).toBe(chatA.id)
    void sessions
  }),
)

it.instance("SessionPrompt service same-ID replay succeeds with one generation and no conflict contract", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    yield* llm.text("async reply")
    const id = MessageID.ascending()
    const input = { sessionID: chat.id, messageID: id, agent: "build", parts: [{ type: "text" as const, text: "async" }] }
    const first = yield* prompt.prompt(input)
    expect(first.info.role).toBe("assistant")
    // Equivalent retry/replay through the SessionPrompt service is success:
    // existing durable user, no second generation, no 409-style failure.
    // This never traverses HTTP; handlers stay unchanged.
    const second = yield* prompt.prompt(input)
    expect(second.info.id).toBe(id)
    expect(second.info.role).toBe("user")
    expect(yield* llm.hits).toHaveLength(1)
    void sessions
  }),
  30_000,
)

it.instance("busy session reattach queues same-ID behind unrelated owner exactly once", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const { prompt, sessions, chat } = yield* boot()
    const aid = MessageID.ascending()
    const bid = MessageID.ascending()
    yield* prompt.prompt({ sessionID: chat.id, messageID: bid, agent: "build", noReply: true, parts: [{ type: "text", text: "reattach me" }] })
    expect(KiloSessionPromptQueue.isOwned(chat.id, bid)).toBe(false)
    const started = yield* Deferred.make<void>()
    const gate = yield* Deferred.make<void>()
    const hold = Deferred.succeed(started, void 0).pipe(Effect.andThen(Deferred.await(gate)))
    const owner = yield* KiloSessionPromptQueue.enqueue(chat.id, aid, hold, Effect.void).pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(started), "unrelated queue owner never started")
    yield* pollWithTimeout(
      Effect.sync(() => (KiloSessionPromptQueue.isOwned(chat.id, aid) ? (true as const) : undefined)),
      "unrelated owner never became queue-owned",
    )
    yield* llm.text("behind busy")
    const input = { sessionID: chat.id, messageID: bid, agent: "build", parts: [{ type: "text" as const, text: "reattach me" }] }
    const first = yield* Effect.all([prompt.prompt(input), prompt.prompt(input)], { concurrency: 2 }).pipe(
      Effect.forkChild,
    )
    yield* pollWithTimeout(
      Effect.sync(() => (KiloSessionPromptQueue.isOwned(chat.id, bid) ? (true as const) : undefined)),
      "reattach never queued behind busy owner",
    )
    yield* Deferred.succeed(gate, void 0)
    const [a, b] = yield* Fiber.join(first)
    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    expect(yield* llm.hits).toHaveLength(1)
    const all = yield* sessions.messages({ sessionID: chat.id })
    const lineage = all.filter(
      (m) => m.info.role !== "user" && (m.info as unknown as { parentID?: string }).parentID === bid,
    )
    expect(lineage).toHaveLength(1)
    const stray = all.filter(
      (m) => m.info.role !== "user" && (m.info as unknown as { parentID?: string }).parentID === aid,
    )
    expect(stray).toHaveLength(0)
    yield* Fiber.interrupt(owner).pipe(Effect.ignore)
  }),
  30_000,
)

it.instance("no-messageID prompts stay distinct and supplied command reuses first writer", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      command: { probe: { template: "Probe says hi" } },
    }))
    const { prompt, sessions, chat } = yield* boot()
    const a = yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: "a" }] })
    const b = yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: "b" }] })
    expect(a.info.id === b.info.id).toBe(false)
    // Supplied command messageID is first-writer-wins like prompt: replay
    // returns the durable user without a second generation.
    yield* llm.text("cmd one")
    const cmdID = MessageID.ascending()
    const one = yield* prompt.command({ sessionID: chat.id, messageID: cmdID, command: "probe", arguments: "" })
    const two = yield* prompt.command({ sessionID: chat.id, messageID: cmdID, command: "probe", arguments: "" })
    expect(one.info.role).toBe("assistant")
    expect(two.info.id).toBe(cmdID)
    expect(two.info.role).toBe("user")
    expect((yield* llm.hits).length).toBe(1)
    void sessions
    void SessionID
    void Cause
    void Deferred
    void Telemetry
  }),
  30_000,
)
