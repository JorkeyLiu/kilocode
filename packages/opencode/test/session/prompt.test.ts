import { NodeFileSystem } from "@effect/platform-node"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Bus } from "@/bus" // kilocode_change - ToolRegistry retains the Kilo bus dependency
import { FetchHttpClient } from "effect/unstable/http"
// kilocode_change start
import { expect, spyOn } from "bun:test"
import { Telemetry } from "@kilocode/kilo-telemetry"
import { legacyReviewMessage } from "../../src/kilocode/review/command"
// kilocode_change end
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Auth } from "../../src/auth" // kilocode_change
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
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt, UNKNOWN_FINISH_CONTINUE_INSTRUCTION } from "../../src/session/prompt"
import { CONTINUE_FROM_KEY } from "../../src/session/prompt/auto-continue" // kilocode_change - LOCK-005 marker key for the bounded continuation tests
import { GenerationGate } from "../../src/kilocode/server/generation-gate" // kilocode_change - admission required by withGenerationAdmission
import { KiloSessionPromptQueue } from "../../src/kilocode/session/prompt-queue" // kilocode_change - LOCK-008 queued superseding prompt gate
import { KiloSession } from "../../src/kilocode/session" // kilocode_change - single busy owner turn ordering assertion
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@opencode-ai/core/session"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "../../src/shell/shell"
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
import { reply, TestLLMServer } from "../lib/llm-server"
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

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErrorToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

function completedTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
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
const infra = Layer.mergeAll(JournalMemory,
    Ownership.layer,
NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

// kilocode_change start
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

const processorCreateStarted: Deferred.Deferred<void>[] = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () =>
      Effect.gen(function* () {
        const started = processorCreateStarted.shift()
        if (started) yield* Deferred.succeed(started, undefined).pipe(Effect.ignore)
        return yield* Effect.never
      }),
  }),
)
// kilocode_change end

function makePrompt(input?: { processor?: "blocking" }) {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    input?.processor === "blocking" ? fastAgents : AgentSvc.defaultLayer, // kilocode_change
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
    Bus.layer, // kilocode_change - satisfy the Kilo ToolRegistry dependency
    GenerationGate.defaultLayer, // kilocode_change - admission required by withGenerationAdmission
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
    Layer.provide(Auth.defaultLayer), // kilocode_change
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc =
    input?.processor === "blocking"
      ? blockingProcessor
      : SessionProcessor.layer.pipe(
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
    Layer.provideMerge(question), // kilocode_change - SessionPrompt dismisses pending questions
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(SystemPrompt.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(deps),
    Layer.provide(summary),
  )
}

function makeHttp(input?: { processor?: "blocking" }) {
  return Layer.mergeAll(TestLLMServer.layer, makePrompt(input))
}

function makeHttpNoLLMServer(input?: { processor?: "blocking" }) {
  return makePrompt(input)
}

const it = testEffect(makeHttp())
const noLLMServer = testEffect(makeHttpNoLLMServer())
const raceNoLLMServer = testEffect(makeHttpNoLLMServer({ processor: "blocking" }))
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
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
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const ensureDir = Effect.fn("test.ensureDir")(function* (dir: string) {
  const fs = yield* FSUtil.Service
  yield* fs.ensureDir(dir)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, ".kilo", "kilo.jsonc"),
    JSON.stringify({ $schema: "https://app.kilo.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// kilocode_change start - wait for the runner state that cancel observes instead of session status
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const run = yield* SessionRunState.Service
      const exit = yield* run.assertNotBusy(sessionID).pipe(Effect.exit)
      return Exit.isFailure(exit) ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )
// kilocode_change end

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { config: cfg },
)

it.instance("loop exits without an LLM request for interrupted orphan tool calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: seeded.assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "interrupted-call",
      tool: "edit",
      state: {
        status: "error",
        input: {},
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 2 },
      },
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.id).toBe(seeded.assistant.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
  10_000, // kilocode_change - infra flake
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

// kilocode_change start - replacement prompts unblock pending Question service requests
noLLMServer.instance(
  "new prompt dismisses a pending question",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const question = yield* Question.Service
      const chat = yield* sessions.create({ title: "Question unblock regression" })
      const pending = yield* question
        .ask({
          sessionID: chat.id,
          questions: [
            {
              header: "Continue?",
              question: "Should I continue?",
              options: [
                { label: "Yes", description: "Go ahead" },
                { label: "No", description: "Stop" },
              ],
            },
          ],
        })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        question.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === chat.id))),
        "timed out waiting for pending question",
      )

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "replacement prompt" }],
        noReply: true,
      })

      const exit = yield* Fiber.await(pending)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Question.RejectedError)
      expect(yield* question.list()).toEqual([])
    }),
  { config: cfg },
)
// kilocode_change end

// kilocode_change start - cover user image normalization before persistence
noLLMServer.instance(
  "normalizes user data images before persistence",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "User image" })
      const url = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"

      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "file", mime: "image/webp", filename: "pixel.webp", url }],
      })

      expect(result.parts).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "file", mime: "image/webp", url })]),
      )
      const saved = yield* sessions.messages({ sessionID: chat.id })
      expect(saved.flatMap((message) => message.parts)).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "file", mime: "image/webp", url })]),
      )
    }),
  { config: cfg },
)

noLLMServer.instance(
  "rejects malformed user data images before persistence",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Invalid user image" })
      const exit = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [
            {
              type: "file",
              mime: "image/png",
              filename: "invalid.png",
              url: `data:image/png;base64,${Buffer.from("not an image").toString("base64")}`,
            },
          ],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      const saved = yield* sessions.messages({ sessionID: chat.id })
      expect(saved.flatMap((message) => message.parts).some((part) => part.type === "file")).toBe(false)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "normalizes user image file URLs after reading them",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "User image file" })
      const data = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"
      const file = path.join(test.directory, "pixel.webp")
      yield* Effect.promise(() => Bun.write(file, Buffer.from(data, "base64")))

      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "file", mime: "image/webp", filename: "pixel.webp", url: pathToFileURL(file).href }],
      })

      expect(result.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "file", mime: "image/webp", url: `data:image/webp;base64,${data}` }),
        ]),
      )
    }),
  { config: cfg },
)

noLLMServer.instance(
  "leaves non-image data parts untouched",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "User data" })
      const url = "data:application/octet-stream;base64,bm90IGFuIGltYWdl"

      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "file", mime: "application/octet-stream", filename: "data.bin", url }],
      })

      expect(result.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "file", url })]))
    }),
  { config: cfg },
)
// kilocode_change end

it.instance(
  "automatic overflow recovery still runs when compaction.auto is configured off",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        compaction: { auto: false },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      // Provider overflow. Compaction is an invisible safeguard: config cannot disable it.
      yield* llm.error(413, { error: { message: "request entity too large" } })
      // The loop recovers past the overflow on the retry.
      yield* llm.text("recovered")
      yield* user(chat.id, "hello")

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(result.info.role).toBe("assistant")
      // The configured `auto: false` is ignored — the overflow is not surfaced as a
      // hard ContextOverflowError stop (the removed escape hatch).
      if (result.info.role === "assistant") {
        expect(result.info.error?.name).not.toBe("ContextOverflowError")
        expect(result.info.finish).not.toBe("error")
      }
    }),
  { timeout: 60_000 },
)

noLLMServer.instance.skip(
  "prompt emits v2 prompted and synthetic events (v2 projector disabled)",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(SessionV2.defaultLayer),
      )
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, chat.id))
        .get()
        .pipe(Effect.orDie)
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

// kilocode_change - single busy owner: one multi-step epoch carries one TurnOpen/TurnClose
// pair with TurnOpen -> busy -> TurnClose -> idle ordering and no per-iteration epoch flap.
it.instance("multi-step epoch projects a single busy transition with turn ordering", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const statusSvc = yield* SessionStatus.Service
    const bridge = yield* EventV2Bridge.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const turn: string[] = []
    const offOpen = Bus.subscribe(KiloSession.Event.TurnOpen, (event) => {
      if (event.properties.sessionID === session.id) turn.push(`open:${event.properties.generationID}`)
    })
    const offClose = Bus.subscribe(KiloSession.Event.TurnClose, (event) => {
      if (event.properties.sessionID === session.id) turn.push(`close:${event.properties.generationID}`)
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        offOpen()
        offClose()
      }),
    )
    // kilocode_change - conditional busy recovery: count normal busy
    // projections; a two-step epoch must emit exactly one.
    let busyCount = 0
    const offStatus = yield* bridge.listen((evt) => {
      if (evt.type === SessionStatus.Event.Status.type) {
        const data = evt.data as { sessionID: string; status: { type: string } }
        if (data.sessionID === session.id && data.status.type === "busy") busyCount += 1
      }
      return Effect.void
    })
    yield* Effect.addFinalizer(() => offStatus)

    expect((yield* statusSvc.get(session.id)).type).toBe("idle")
    const fiber = yield* prompt.loop({ sessionID: session.id }).pipe(Effect.forkChild)
    yield* waitForBusy(session.id)
    expect((yield* statusSvc.get(session.id)).type).toBe("busy")
    const result = yield* Fiber.join(fiber)
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    expect(turn.filter((t) => t.startsWith("open:"))).toHaveLength(1)
    expect(turn.filter((t) => t.startsWith("close:"))).toHaveLength(1)
    const openGen = turn.find((t) => t.startsWith("open:"))!.slice("open:".length)
    const closeGen = turn.find((t) => t.startsWith("close:"))!.slice("close:".length)
    expect(openGen.length).toBeGreaterThan(0)
    expect(closeGen).toBe(openGen)
    expect(busyCount).toBe(1)
    expect((yield* statusSvc.get(session.id)).type).toBe("idle")
  }),
)

// kilocode_change start - bounded auto-continuation for truncated (unknown finish) responses
it.instance(
  "auto-continues once when a partial response ends with unknown finish",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.push(reply().text("partial answer").finish("unknown"))
      yield* llm.text("completed answer")

      const result = yield* prompt.loop({ sessionID: session.id })
      // Original truncated step + exactly one auto-continuation.
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.finish).toBe("stop")
        // The caller sees the continuation result, not the partial output.
        expect(result.parts.some((part) => part.type === "text" && part.text === "completed answer")).toBe(true)
      }
      // The continuation instruction reaches the model in the follow-up request.
      const hits = yield* llm.hits
      expect(JSON.stringify(hits.at(-1)?.body)).toContain(UNKNOWN_FINISH_CONTINUE_INSTRUCTION)
      // The partial output stays in persisted history for the model to continue from.
      const msgs = yield* sessions.messages({ sessionID: session.id })
      expect(
        msgs.some(
          (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text === "partial answer"),
        ),
      ).toBe(true)
    }),
  10_000, // kilocode_change - infra flake; multi-step LLM flow
)

it.instance(
  "does not loop when the auto-continuation also ends with unknown finish",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.push(reply().text("partial one").finish("unknown"))
      yield* llm.push(reply().text("partial two").finish("unknown"))

      const result = yield* prompt.loop({ sessionID: session.id })
      // Original truncated step + one continuation; a second unknown finish stops.
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.finish).toBe("unknown")
        expect(result.parts.some((part) => part.type === "text" && part.text === "partial two")).toBe(true)
      }
    }),
  10_000, // kilocode_change - infra flake; multi-step LLM flow
)

it.instance(
  "does not auto-continue when a response ends with length finish",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.push(reply().text("partial due to limit").finish("length"))

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(1)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.finish).toBe("length")
      }
    }),
  10_000, // kilocode_change - infra flake
)

it.instance(
  "does not auto-continue a truncated assistant with an interrupted tool part",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const seeded = yield* seed(chat.id, { finish: "unknown" })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: seeded.assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "interrupted-call",
        tool: "edit",
        state: {
          status: "error",
          input: {},
          error: "Tool execution aborted",
          metadata: { interrupted: true },
          time: { start: 1, end: 2 },
        },
      })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.id).toBe(seeded.assistant.id)
      expect(yield* llm.hits).toHaveLength(0)
    }),
  10_000, // kilocode_change - infra flake
)

it.instance(
  "does not auto-continue a truncated assistant with a pending tool part",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const seeded = yield* seed(chat.id, { finish: "unknown" })
      // kilocode_change - a provider-executed pending tool reaches the finish
      // gate (not counted as a local tool call) and must still block per LOCK-003.
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: seeded.assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "pending-call",
        tool: "edit",
        state: {
          status: "pending",
          input: {},
          raw: "{}",
        },
        metadata: { providerExecuted: true },
      })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.id).toBe(seeded.assistant.id)
      expect(yield* llm.hits).toHaveLength(0)
    }),
  10_000, // kilocode_change - infra flake
)

it.instance(
  "does not auto-continue a truncated assistant with a running tool part",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const seeded = yield* seed(chat.id, { finish: "unknown" })
      // kilocode_change - same as pending: provider-side execution does not
      // resolve local tool state, so an unresolved running tool blocks.
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: seeded.assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "running-call",
        tool: "edit",
        state: {
          status: "running",
          input: {},
          time: { start: 1 },
        },
        metadata: { providerExecuted: true },
      })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.id).toBe(seeded.assistant.id)
      expect(yield* llm.hits).toHaveLength(0)
    }),
  10_000, // kilocode_change - infra flake
)

it.instance(
  "does not auto-continue a truncated assistant that carries an error",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const seeded = yield* seed(chat.id, { finish: "unknown" })
      yield* sessions.updateMessage({
        ...seeded.assistant,
        error: new MessageV2.APIError({ message: "provider refused", isRetryable: true }).toObject(),
      })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.id).toBe(seeded.assistant.id)
      expect(yield* llm.hits).toHaveLength(0)
    }),
  10_000, // kilocode_change - infra flake
)

it.instance(
  "task tool child report uses the auto-continuation text after an unknown child finish",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      // Child session: truncated response, then the auto-continuation completes it.
      yield* llm.push(reply().text("child partial").finish("unknown"))
      yield* llm.text("child completed report")
      // Parent finishes after the tool result returns.
      yield* llm.text("parent done")
      yield* user(chat.id, "hello")

      const result = yield* prompt.loop({ sessionID: chat.id })
      // parent tool call + child truncated + child continuation + parent done
      expect(yield* llm.calls).toBe(4)
      expect(result.parts.some((part) => part.type === "text" && part.text === "parent done")).toBe(true)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const part = msgs
        .flatMap((msg) => msg.parts)
        .find(
          (part): part is CompletedToolPart =>
            part.type === "tool" && part.tool === "task" && part.state.status === "completed",
        )
      expect(part).toBeDefined()
      if (!part) return
      // LOCK-004: the parent sees the full logical child report — the
      // pre-truncation partial text followed by the auto-continuation text, in
      // order — and never the hidden continuation instruction.
      expect(part.state.output).toContain("<task_result>")
      const partialAt = part.state.output.indexOf("child partial")
      const completedAt = part.state.output.indexOf("child completed report")
      expect(partialAt).toBeGreaterThanOrEqual(0)
      expect(completedAt).toBeGreaterThan(partialAt)
      expect(part.state.output).not.toContain(UNKNOWN_FINISH_CONTINUE_INSTRUCTION)
    }),
  30_000,
)
// kilocode_change end

it.instance(
  "does not auto-continue again when a fresh loop resumes a turn whose last user message is the persisted continuation marker",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      // The original turn was truncated and already auto-continued once: the
      // synthetic continuation user message (with its LOCK-005 marker) persists
      // in history as if the run was interrupted right after injection.
      const seeded = yield* seed(session.id, { finish: "unknown" })
      const continuation = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: continuation.id,
        sessionID: session.id,
        type: "text",
        synthetic: true,
        text: UNKNOWN_FINISH_CONTINUE_INSTRUCTION,
        metadata: { [CONTINUE_FROM_KEY]: seeded.assistant.id },
      })
      // The continuation's own assistant was also cut off.
      const continued = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: continuation.id,
        sessionID: session.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
        finish: "unknown",
      })

      // A fresh runLoop (re-entry after interruption) must treat the persisted
      // marker as the turn's one continuation and break without a second
      // injection or any LLM call.
      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.hits).toHaveLength(0)
      expect(result.info.id).toBe(continued.id)
      const msgs = yield* sessions.messages({ sessionID: session.id })
      const markers = msgs.filter(
        (m) =>
          m.info.role === "user" &&
          m.parts.some((p) => p.type === "text" && p.synthetic && p.metadata?.[CONTINUE_FROM_KEY]),
      )
      expect(markers).toHaveLength(1)
    }),
  10_000, // kilocode_change - infra flake
)

it.instance(
  "persists the continuation marker before exposing the continuation to the prompt queue scope",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Pinned" })
      const seeded = yield* seed(session.id, { finish: "unknown" })
      // Run the loop inside a queue slot so the target is active and retarget()
      // controls whether the injected continuation is visible to scope().
      const cancelled = Effect.succeed({
        info: {
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        },
        parts: [],
      } satisfies MessageV2.WithParts)
      // Hold the marker part persistence so the loop suspends in the exact
      // window between persisting the continuation message and retargeting the
      // queue (LOCK-007 write-order window). A marker-less continuation must
      // never be visible to scope() at that moment, or an interrupt could hand
      // it to a fresh runLoop that would inject a second continuation.
      const blocker = yield* Deferred.make<SessionV1.Part>()
      let held: SessionV1.Part | undefined
      const updatePart = sessions.updatePart
      const spy = spyOn(sessions, "updatePart").mockImplementation(<T extends SessionV1.Part>(part: T) => {
        if (
          part.type === "text" &&
          part.synthetic === true &&
          part.metadata?.[CONTINUE_FROM_KEY] === seeded.assistant.id
        ) {
          held = part
          // Hold the write, then persist the original part once released so the
          // loop continues with the real storage write.
          return Deferred.await(blocker).pipe(Effect.andThen(() => updatePart(part)))
        }
        return updatePart(part)
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
      yield* llm.text("continued answer")
      const loop = yield* KiloSessionPromptQueue.enqueue(
        session.id,
        seeded.user.id,
        prompt.loop({ sessionID: session.id }),
        cancelled,
      ).pipe(Effect.forkScoped)

      // The loop reached the marker persistence and is suspended there.
      yield* pollWithTimeout(
        Effect.sync(() => (held ? (true as const) : undefined)),
        "loop never reached the continuation marker persistence",
      )
      const marker = held
      if (!marker) return
      const msgs = yield* sessions.messages({ sessionID: session.id })
      const continuation = msgs.find((m) => m.info.role === "user" && m.info.id !== seeded.user.id)
      expect(continuation).toBeDefined()
      if (!continuation) return
      // LOCK-007: while the marker is not yet persisted, scope() must hide the
      // continuation (retarget has not run yet) so an interrupt cannot expose
      // a marker-less continuation message to a fresh runLoop.
      const scoped = KiloSessionPromptQueue.scope(session.id, msgs)
      expect(scoped.some((m) => m.info.role === "user" && m.info.id === continuation.info.id)).toBe(false)

      // Release the persistence; the loop continues with exactly one more LLM
      // step for the continuation and the persisted marker stays in history.
      yield* Deferred.succeed(blocker, marker)
      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(yield* llm.calls).toBe(1)
      const after = yield* sessions.messages({ sessionID: session.id })
      expect(
        after.some(
          (m) =>
            m.info.role === "user" &&
            m.parts.some((p) => p.type === "text" && p.synthetic && p.metadata?.[CONTINUE_FROM_KEY]),
        ),
      ).toBe(true)
      expect(KiloSessionPromptQueue._hasInternalState(session.id)).toBe(false)
    }),
  10_000, // kilocode_change - infra flake; queue + loop path
)

it.instance(
  "queued superseding prompt suppresses the auto-continuation of the truncated response",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      // A truncated turn is already persisted; its queue slot is about to re-run
      // the loop. Hold that slot before the loop so the superseding prompt can be
      // queued first (LOCK-008: it must already be waiting when the unknown gate
      // fires, otherwise queue adoption would fold it in before the gate).
      const seeded = yield* seed(session.id, { finish: "unknown" })
      const started = yield* Deferred.make<void>()
      const cancelled = Effect.succeed({
        info: {
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        },
        parts: [],
      } satisfies MessageV2.WithParts)
      const first = yield* KiloSessionPromptQueue.enqueue(
        session.id,
        seeded.user.id,
        Deferred.await(started).pipe(Effect.andThen(prompt.loop({ sessionID: session.id }))),
        cancelled,
      ).pipe(Effect.forkScoped)
      yield* pollWithTimeout(
        Effect.sync(() => (KiloSessionPromptQueue.active(session.id) === seeded.user.id ? true : undefined)),
        "first queue slot never started",
      )
      const second = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "superseding prompt" }],
        })
        .pipe(Effect.forkScoped)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* sessions.messages({ sessionID: session.id })
          const queued = msgs.some(
            (m) =>
              m.info.role === "user" &&
              m.parts.some((p) => p.type === "text" && p.text === "superseding prompt") &&
              KiloSessionPromptQueue._isQueued(session.id, m.info.id),
          )
          return queued ? true : undefined
        }),
        "superseding prompt never queued",
      )
      yield* llm.text("superseding answer")
      yield* Deferred.succeed(started, void 0)

      const firstExit = yield* Fiber.await(first)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(firstExit)).toBe(true)
      expect(Exit.isSuccess(secondExit)).toBe(true)
      if (!Exit.isSuccess(firstExit) || !Exit.isSuccess(secondExit)) return
      // The truncated turn breaks at the unknown gate instead of injecting a
      // continuation: exactly one LLM step, for the superseding prompt only, and
      // the continuation instruction never reaches a request body.
      expect(yield* llm.calls).toBe(1)
      const bodies = yield* llm.inputs
      expect(JSON.stringify(bodies)).not.toContain(UNKNOWN_FINISH_CONTINUE_INSTRUCTION)
      expect(secondExit.value.parts.some((p) => p.type === "text" && p.text === "superseding answer")).toBe(true)
      // No continuation marker user message was injected for the old turn.
      const msgs = yield* sessions.messages({ sessionID: session.id })
      const markers = msgs.filter(
        (m) =>
          m.info.role === "user" &&
          m.parts.some((p) => p.type === "text" && p.synthetic && p.metadata?.[CONTINUE_FROM_KEY]),
      )
      expect(markers).toHaveLength(0)
      expect(KiloSessionPromptQueue._hasInternalState(session.id)).toBe(false)
    }),
  10_000, // kilocode_change - infra flake; queue + loop path
)

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    expect(tool.state.output).toContain(file)
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

it.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("failed subtask preserves metadata on error tool state", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: {
        general: {
          model: "test/missing-model",
        },
      },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") return

    const tool = errorTool(taskMsg.parts)
    if (!tool) return

    expect(tool.state.error).toContain("Tool execution failed")
    expect(tool.state.metadata).toBeDefined()
    expect(tool.state.metadata?.sessionId).toBeDefined()
    expect(tool.state.metadata?.model).toEqual({
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("missing-model"),
    })
  }),
)

it.instance(
  "running subtask preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running subtask metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBeDefined()
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  5_000,
)

it.instance(
  "running task tool preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "code") // kilocode_change
          const tool = assistant?.parts.find(
            (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task",
          )
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running task metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBe("inspect bug")
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  10_000,
)

// kilocode_change start - child task failures stay tool errors so the parent can recover
it.instance(
  "failed task tool preserves metadata and lets the parent follow up",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.error(400, { error: { message: "child prompt failed" } })
      yield* llm.text("parent recovered")
      yield* user(chat.id, "hello")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(yield* llm.calls).toBe(3)
      expect(result.parts.some((part) => part.type === "text" && part.text === "parent recovered")).toBe(true)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const part = msgs
        .flatMap((msg) => msg.parts)
        .find(
          (part): part is ErrorToolPart =>
            part.type === "tool" && part.tool === "task" && part.state.status === "error",
        )
      expect(part).toBeDefined()
      if (!part) return
      expect(part.state.error).toContain("child prompt failed")
      expect(part.state.metadata?.sessionId).toBeDefined()

      const hits = yield* llm.hits
      expect(hits).toHaveLength(3)
      expect(JSON.stringify(hits.at(-1)?.body)).toContain("child prompt failed")
    }),
  10_000,
)
// kilocode_change end

it.instance(
  "loop sets status to busy then idle",
  () =>
    // kilocode_change start - hold the model response instead of cancelling an infinite stream
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service

      yield* llm.push(reply().wait(deferredAsPromise(gate)).text("done").stop())

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* Deferred.succeed(gate, void 0)
      yield* Fiber.await(fiber)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  // kilocode_change end
  10_000, // kilocode_change
)

// Cancel semantics

it.instance(
  "cancel interrupts loop and resolves with an assistant message",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id)

      yield* llm.hang

      yield* user(chat.id, "more")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
      }
    }),
  10_000, // kilocode_change - Windows CI can take longer to cancel the live loop
)

// kilocode_change start
unix(
  // kilocode_change end
  "cancel records MessageAbortedError on interrupted process",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const info = exit.value.info
        if (info.role === "assistant") {
          expect(info.error?.name).toBe("MessageAbortedError")
        }
      }
    }),
  10_000, // kilocode_change - upstream's 3s deadline flakes under CI shard load (observed 3048ms on macOS)
)

raceNoLLMServer.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      // kilocode_change start
      const firstCreate = yield* Deferred.make<void>()
      processorCreateStarted.push(firstCreate)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(firstCreate), "processor.create did not start for first turn")
      // kilocode_change end

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      // kilocode_change start
      const secondCreate = yield* Deferred.make<void>()
      processorCreateStarted.push(secondCreate)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(secondCreate), "processor.create did not start for second turn")
      // kilocode_change end

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
    }),
  { config: cfg },
  10_000, // kilocode_change - cancellation tree cleanup can exceed 3s under macOS CI shard load
)

noLLMServer.instance(
  "cancel finalizes subtask tool state",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const registry = yield* ToolRegistry.Service
      const { task } = yield* registry.named()
      const original = task.execute
      task.execute = (_args, ctx) =>
        Effect.callback<never>((_resume) => {
          ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
          if (ctx.abort.aborted) succeedVoid(aborted)
          succeedVoid(ready)
          return Effect.sync(() => succeedVoid(aborted))
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      const { prompt, chat } = yield* boot()
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for task tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* awaitWithTimeout(Deferred.await(aborted), "timed out waiting for task tool abort", "10 seconds")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = toolPart(taskMsg.parts)
      expect(tool?.type).toBe("tool")
      if (!tool) return

      expect(tool.state.status).not.toBe("running")
      expect(taskMsg.info.time.completed).toBeDefined()
      expect(taskMsg.info.finish).toBeDefined()
    }),
  { config: cfg },
  30_000,
)

// kilocode_change start - handleSubtask propagates child session cost to wrapper (#6321)
it.instance(
  "handleSubtask propagates subagent cost to wrapper message",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const registry = yield* ToolRegistry.Service
      const { task } = yield* registry.named()
      const original = task.execute
      // Simulate task tool: create a child session, persist an assistant with cost, return metadata.
      task.execute = (_args, ctx) =>
        Effect.gen(function* () {
          const child = yield* sessions.create({ parentID: ctx.sessionID, title: "subagent" })
          const childAssistant: MessageV2.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            parentID: ctx.messageID,
            sessionID: child.id,
            mode: "general",
            agent: "general",
            cost: 0.42,
            path: { cwd: "/tmp", root: "/tmp" },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            time: { created: Date.now(), completed: Date.now() },
            finish: "stop",
          }
          yield* sessions.updateMessage(childAssistant)
          yield* ctx.metadata({
            title: "done",
            metadata: { parentSessionId: ctx.sessionID, sessionId: child.id, model: ref, variant: undefined },
          })
          return {
            title: "done",
            metadata: { parentSessionId: ctx.sessionID, sessionId: child.id, model: ref, variant: undefined },
            output: "done",
          }
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      const chat = yield* sessions.create({ title: "Pinned" })
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)
      // The loop continues past handleSubtask into a normal LLM step; provide one response to exit.
      yield* llm.text("wrapped")

      yield* prompt.loop({ sessionID: chat.id })

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const wrapper = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(wrapper?.info.role).toBe("assistant")
      if (!wrapper || wrapper.info.role !== "assistant") return
      expect(wrapper.info.cost).toBeCloseTo(0.42, 6)
    }),
  30_000,
)
// kilocode_change end

it.instance(
  "cancel propagates from slash command subtask to child session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
      const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")
    }),
  10_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.yieldNow // kilocode_change - let the queued caller join without a wall-clock race

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  10_000, // kilocode_change - Windows CI can take longer to cancel queued live loops
)

// Queue semantics

noLLMServer.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    yield* seed(chat.id, { finish: "stop" })

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    yield* run.assertNotBusy(chat.id)
  }),
)

it.instance(
  "concurrent loop callers all receive same error result",
  () =>
    // kilocode_change start - gate the failing stream so both callers join the same run
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.push(reply().wait(deferredAsPromise(gate)).streamError("boom"))
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.yieldNow // kilocode_change - let the queued caller join without a wall-clock race
      yield* Deferred.succeed(gate, void 0)

      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (!Exit.isSuccess(ea) || !Exit.isSuccess(eb)) return
      expect(ea.value.info.id).toBe(eb.value.info.id)
      expect(ea.value.info.role).toBe("assistant")
    }),
  // kilocode_change end
  10_000, // kilocode_change
)

it.instance(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.hold("first", deferredAsPromise(gate))
      yield* llm.text("second")

      const a = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "first" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)

      const id = MessageID.ascending()
      const b = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "second" }],
        })
        .pipe(Effect.forkChild)

      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((msgs) =>
              msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined,
            ),
          ),
        "timed out waiting for second prompt to save",
      )

      yield* Deferred.succeed(gate, void 0)

      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      expect(yield* llm.calls).toBe(2)

      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const assistants = msgs.filter((msg) => msg.info.role === "assistant")
      expect(assistants).toHaveLength(2)
      const last = assistants.at(-1)
      if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
      expect(last.info.parentID).toBe(id)
      expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("second")
    }),
  10_000, // kilocode_change - loaded CI runners can exceed 3s for two prompt turns
)

it.instance(
  "assertNotBusy fails with BusyError when loop running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const run = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
      }

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  10_000, // kilocode_change
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Shell semantics

it.instance(
  "shell rejects with BusyError when loop running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
      }

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  10_000, // kilocode_change - Windows CI can take longer to enter and cancel the live loop
)

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    ),
  { config: cfg },
)

// kilocode_change start - verify shell v2 events correlate with the persisted tool part
unixNoLLMServer(
  "shell correlates the persisted tool part with its completed v2 record",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "printf correlated",
        })
        const tool = completedTool(result.parts)
        if (!tool) return

        const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
          Effect.provide(SessionV2.defaultLayer), // kilocode_change - use the complete upstream v2 session layer
        )
        const shell = messages.find((message) => message.type === "shell")

        expect(shell).toMatchObject({
          type: "shell",
          callID: tool.callID,
          command: "printf correlated",
          time: { completed: expect.anything() },
        })
        expect(String((shell as unknown as { output?: unknown })?.output ?? "")).toContain("correlated")
      }),
    ),
  { config: cfg },
)
// kilocode_change end

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)

it.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.yieldNow // kilocode_change - give the queued loop a scheduler turn instead of a wall-clock window

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  30_000, // kilocode_change - Windows CI process startup can exceed 3s
)

it.instance(
  "shell completion resumes queued loop callers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("done")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.yieldNow // kilocode_change - give the queued loops a scheduler turn instead of a wall-clock window

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
        expect(ea.value.info.id).toBe(eb.value.info.id)
        expect(ea.value.info.role).toBe("assistant")
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  30_000, // kilocode_change - Windows CI process startup can exceed 3s
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)

unixNoLLMServer(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { dir, llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Interrupted bash truncation",
          permission: [
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "*", action: "allow" },
          ],
        })

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "run bash" }],
        })

        yield* llm.tool("bash", {
          command:
            'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; printf truncation-ready; sleep 30',
          description: "Print many lines",
          timeout: 30_000,
          workdir: path.resolve(dir),
        })

        const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        // kilocode_change - deterministic host shell with explicit poll bound for large output
        yield* pollWithTimeout(
          sessions.messages({ sessionID: chat.id }).pipe(
            Effect.map((msgs) => {
              const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
              if (part?.type !== "tool") return
              if (part.state.status !== "running") return
              if (!String(part.state.metadata?.output ?? "").includes("03999")) return
              return part
            }),
          ),
          "timed out waiting for large bash output",
          "20 seconds",
        )
        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(run)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isFailure(exit)) return

        const tool = completedTool(exit.value.parts)
        if (!tool) return

        expect(tool.state.metadata.truncated).toBe(true)
        expect(typeof tool.state.metadata.outputPath).toBe("string")
        expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
        expect(tool.state.output).not.toContain("Tool execution aborted")
      }),
    ),
  { git: true },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, sessions, chat } = yield* boot()

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)
      // kilocode_change start - busy is set before shell persistence completes
      yield* pollWithTimeout(
        sessions.messages({ sessionID: chat.id }).pipe(
          Effect.map((messages) =>
            messages.some((message) =>
              message.parts.some((part) => part.type === "tool" && part.state.status === "running"),
            )
              ? true
              : undefined,
          ),
        ),
        `session ${chat.id} never persisted its running shell tool`,
      )
      // kilocode_change end

      // Queued loop behind shell must not publish TurnOpen before promotion;
      // the handoff is ShellThenRun admission, observed via scheduler turns.
      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      yield* prompt.cancel(chat.id)

      const exitLoop = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exitLoop)).toBe(true)
      const exitShell = yield* Fiber.await(sh)
      expect(Exit.isSuccess(exitShell)).toBe(true)
      if (Exit.isSuccess(exitShell)) {
        const tool = completedTool(exitShell.value.parts)
        expect(tool?.state.output).toContain("User aborted the command")
      }
    }),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "resolves configured reference mentions to one root directory attachment",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const docs = path.join(dir, "external-docs")
      yield* ensureDir(path.join(docs, "guide"))
      yield* ensureDir(path.join(dir, "docs"))
      yield* writeText(path.join(docs, "README.md"), "reference readme")
      yield* writeText(path.join(docs, "guide", "intro.md"), "reference intro")
      yield* writeText(path.join(dir, "docs", "README.md"), "workspace readme")

      const prompt = yield* SessionPrompt.Service
      const parts = yield* prompt.resolvePromptParts(
        "Use @docs and @docs/README.md and @docs/guide and @docs/missing.md and @docs/README.md and @build",
      )
      const files = parts.filter((part): part is SessionV1.FilePartInput => part.type === "file")
      const agents = parts.filter((part): part is SessionV1.AgentPartInput => part.type === "agent")
      const text = parts.find((part): part is SessionV1.TextPartInput => part.type === "text" && !part.synthetic)

      expect(text?.text).toContain("@docs")
      expect(files).toHaveLength(1)
      expect(files[0]).toMatchObject({
        filename: "docs",
        mime: "application/x-directory",
        source: { type: "file", path: "docs", text: { value: "@docs" } },
      })
      expect(fileURLToPath(files[0].url)).toBe(docs)
      expect(agents.map((agent) => agent.name)).toEqual(["code"]) // kilocode_change
    }),
  {
    config: {
      ...cfg,
      reference: {
        docs: "./external-docs",
      },
    },
  },
)

noLLMServer.instance(
  "stores raw reference mentions alongside directory attachments",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const docs = path.join(dir, "external-docs")
      yield* ensureDir(docs)

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const message = yield* prompt.prompt({
        sessionID: session.id,
        noReply: true,
        parts: [{ type: "text", text: "Use @docs for context" }],
      })

      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const synthetic = stored.parts.filter(
        (part): part is SessionV1.TextPart => part.type === "text" && part.synthetic === true,
      )
      const files = stored.parts.filter((part): part is SessionV1.FilePart => part.type === "file")
      const text = stored.parts.find((part): part is SessionV1.TextPart => part.type === "text" && !part.synthetic)

      expect(text?.text).toBe("Use @docs for context")
      expect(synthetic.some((part) => part.text.includes("Called the Read tool"))).toBe(true) // kilocode_change
      expect(files).toHaveLength(1) // kilocode_change - directory attachment is expanded, not denied

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      reference: {
        docs: "./external-docs",
      },
    },
  },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/opencode/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance(
  "records aborted errors when prompt is cancelled mid-stream",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Prompt cancel regression" })

      yield* llm.hang

      const fiber = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "Cancel me" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)
      yield* prompt.cancel(session.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        if (exit.value.info.role === "assistant") {
          expect(exit.value.info.error?.name).toBe("MessageAbortedError")
        }
      }

      const msgs = yield* sessions.messages({ sessionID: session.id })
      const last = msgs.findLast((msg) => msg.info.role === "assistant")
      expect(last?.info.role).toBe("assistant")
      if (last?.info.role === "assistant") {
        expect(last.info.error?.name).toBe("MessageAbortedError")
      }
    }),
  10_000, // kilocode_change
)

// Agent variant

// kilocode_change start - Agent Manager records a model-less synthetic prompt after forking
noLLMServer.instance(
  "preserves the session variant through a model-less handoff",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        model: {
          id: ref.modelID,
          providerID: ref.providerID,
          variant: "high",
        },
      })

      const handoff = yield* prompt.prompt({
        sessionID: session.id,
        noReply: true,
        parts: [{ type: "text", text: "fork handoff", synthetic: true }],
      })
      if (handoff.info.role !== "user") throw new Error("expected user message")

      expect(handoff.info.model).toEqual({
        providerID: ref.providerID,
        modelID: ref.modelID,
        variant: "high",
      })

      const saved = yield* sessions.get(session.id)
      expect(saved.model?.variant).toBe("high")
    }),
  { config: cfg },
)
// kilocode_change end

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("opencode"), modelID: ModelV2.ID.make("kimi-k2.5-free") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// kilocode_change start - Kilo review command behavior
noLLMServer.instance(
  "deprecated review alias returns static message without LLM",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const text = legacyReviewMessage("local-review-uncommitted")!

      const result = yield* prompt.command({
        sessionID: session.id,
        command: "local-review-uncommitted",
        arguments: "focus on tests",
        model: "test/test-model",
      })

      expect(result.info.role).toBe("assistant")
      expect(result.parts).toHaveLength(1)
      expect(result.parts[0].type).toBe("text")
      if (result.parts[0].type === "text") expect(result.parts[0].text).toBe(text)

      const msgs = yield* sessions.messages({ sessionID: session.id })
      const user = msgs.find((msg) => msg.info.role === "user")
      expect(
        user?.parts.some((part) => part.type === "text" && part.text === "/local-review-uncommitted focus on tests"),
      ).toBe(true)
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "review command marks child completions with review telemetry",
  () =>
    Effect.gen(function* () {
      const trackSpy = spyOn(Telemetry, "trackLlmCompletion")
      yield* Effect.addFinalizer(() => Effect.sync(() => trackSpy.mockRestore()))
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Review telemetry",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // child subagent's first LLM step needs non-zero usage so trackStep fires
      yield* llm.text("review done", { usage: { input: 100, output: 50 } })

      yield* prompt.command({
        sessionID: chat.id,
        command: "review",
        arguments: "",
        agent: "general",
      })

      const tagged = trackSpy.mock.calls
        .map((args) => args[0] as Parameters<typeof Telemetry.trackLlmCompletion>[0])
        .find((p) => p.mode === "review" && p.feature === "code_reviews" && p.command === "review")
      expect(tagged).toBeDefined()
    }),
  30_000,
)
// kilocode_change end

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("code") // kilocode_change - "build" renamed to "code"
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)
