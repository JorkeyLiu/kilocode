import { NodeFileSystem } from "@effect/platform-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { Image } from "@/image/image"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import * as Log from "@opencode-ai/core/util/log"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionGeneration } from "@opencode-ai/core/session/generation"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { KiloRetryBudget } from "@/kilocode/session/retry-budget"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import * as Ownership from "@/retention/ownership"
import { SessionSchema } from "@opencode-ai/core/session/schema"

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
  return { ...cfg, provider: { ...cfg.provider, test: { ...cfg.provider.test, options: { apiKey: "test-key", baseURL: url } } } }
}

function agent(): Agent.Info {
  return { name: "build", mode: "primary", options: {}, permission: [{ permission: "*", pattern: "*", action: "allow" }] }
}

const status = SessionStatus.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer))
const infra = Layer.mergeAll(Ownership.layer, NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  status,
  Database.defaultLayer,
  EventV2Bridge.defaultLayer,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(
  (await import("../lib/llm-server")).TestLLMServer.layer,
  SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: false })),
    Layer.provideMerge(deps),
  ),
)

const it = testEffect(env)

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (sessionID: SessionID, parentID: MessageID, root: string) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

function toSid(value: string): SessionSchema.ID {
  return SessionSchema.ID.make(value)
}

it.live("strict durable owner persists provider link, memory does not", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const database = yield* Database.Service
        const db = database.db
        yield* llm.text("hello")
        // strict generation with accepted prompt + owner
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const promptOp = SessionOperation.promptId(parent.id)
        yield* SessionOperation.ensurePromptInFlight(db, toSid(chat.id), promptOp)
        const gen = "genprocstrict"
        yield* SessionGeneration.begin(db, toSid(chat.id), gen, parent.id, 2)
        const strict: KiloRetryBudget.Binding = { db: db as never, sessionID: toSid(chat.id) as never, genID: gen, kind: "strict" }
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const input = {
          user: { id: parent.id, sessionID: chat.id, role: "user", time: parent.time, agent: parent.agent, model: { providerID: ref.providerID, modelID: ref.modelID } } satisfies SessionV1.User,
          sessionID: chat.id, model: mdl, agent: agent(), system: [], messages: [{ role: "user" as const, content: "hi" }], tools: {},
        }
        const value = yield* handle.process(input).pipe(
          Effect.provideService(KiloRetryBudget.Owner, KiloRetryBudget.make()),
          Effect.provideService(KiloRetryBudget.Durable, strict),
        )
        expect(value).toBe("continue")
        const opId = SessionOperation.providerId(msg.id, 0)
        expect(yield* SessionOperation.getProviderGen(db, opId)).toBe(gen)
        // memory binding on a second session never fabricates a link
        yield* llm.text("second")
        const chat2 = yield* session.create({})
        const parent2 = yield* user(chat2.id, "hi2")
        const msg2 = yield* assistant(chat2.id, parent2.id, path.resolve(dir))
        const handle2 = yield* processors.create({ assistantMessage: msg2, sessionID: chat2.id, model: mdl })
        const memory: KiloRetryBudget.Binding = { db: db as never, sessionID: toSid(chat2.id) as never, genID: "genmemory", kind: "memory" }
        const value2 = yield* handle2.process({
          user: { id: parent2.id, sessionID: chat2.id, role: "user", time: parent2.time, agent: parent2.agent, model: { providerID: ref.providerID, modelID: ref.modelID } } satisfies SessionV1.User,
          sessionID: chat2.id, model: mdl, agent: agent(), system: [], messages: [{ role: "user" as const, content: "hi2" }], tools: {},
        }).pipe(
          Effect.provideService(KiloRetryBudget.Owner, KiloRetryBudget.make()),
          Effect.provideService(KiloRetryBudget.Durable, memory),
        )
        expect(value2).toBe("continue")
        expect(yield* SessionOperation.getProviderGen(db, SessionOperation.providerId(msg2.id, 0))).toBeNull()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("strict session mismatch fails closed with no network and no row", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const database = yield* Database.Service
        const db = database.db
        yield* llm.text("should never run")
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const other = yield* session.create({})
        const bad: KiloRetryBudget.Binding = { db: db as never, sessionID: toSid(other.id) as never, genID: "genbad", kind: "strict" }
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const exit = yield* handle.process({
          user: { id: parent.id, sessionID: chat.id, role: "user", time: parent.time, agent: parent.agent, model: { providerID: ref.providerID, modelID: ref.modelID } } satisfies SessionV1.User,
          sessionID: chat.id, model: mdl, agent: agent(), system: [], messages: [{ role: "user" as const, content: "hi" }], tools: {},
        }).pipe(
          Effect.provideService(KiloRetryBudget.Owner, KiloRetryBudget.make()),
          Effect.provideService(KiloRetryBudget.Durable, bad),
          Effect.exit,
        )
        // Fail-closed per context: strict mismatch must never reach the
        // network, never write a provider row, and never guess a link from
        // parentID. The outer shape is `stop` via halt (Success) when the
        // request dies before admission; a defect Failure is also closed.
        // Either way calls stay 0 and no row/link exists.
        if (exit._tag === "Failure") {
          expect(yield* llm.calls).toBe(0)
        } else {
          expect(exit.value).toBe("stop")
          expect(yield* llm.calls).toBe(0)
        }
        expect(yield* SessionOperation.get(db, SessionOperation.providerId(msg.id, 0))).toBeUndefined()
        expect(yield* SessionOperation.getProviderGen(db, SessionOperation.providerId(msg.id, 0))).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("strict durable retryable 429 then success links both provider attempts", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const database = yield* Database.Service
        const db = database.db
        // Real transport failure then real success: no mocks, two actual
        // provider networks through the true Effect.retry attempt lifecycle.
        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("recovered")
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const promptOp = SessionOperation.promptId(parent.id)
        yield* SessionOperation.ensurePromptInFlight(db, toSid(chat.id), promptOp)
        const gen = "genretrylink"
        yield* SessionGeneration.begin(db, toSid(chat.id), gen, parent.id, 2)
        const strict: KiloRetryBudget.Binding = { db: db as never, sessionID: toSid(chat.id) as never, genID: gen, kind: "strict" }
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const value = yield* handle.process({
          user: { id: parent.id, sessionID: chat.id, role: "user", time: parent.time, agent: parent.agent, model: { providerID: ref.providerID, modelID: ref.modelID } } satisfies SessionV1.User,
          sessionID: chat.id, model: mdl, agent: agent(), system: [], messages: [{ role: "user" as const, content: "hi" }], tools: {},
        }).pipe(
          Effect.provideService(KiloRetryBudget.Owner, KiloRetryBudget.make()),
          Effect.provideService(KiloRetryBudget.Durable, strict),
        )
        expect(value).toBe("continue")
        // Two actual provider networks: retryable first attempt then success.
        expect(yield* llm.calls).toBe(2)
        expect(handle.message.error).toBeUndefined()
        // Each actual attempt owns a distinct opId consistent with
        // providerId(assistantID, retries.provider); terminals must not mismatch.
        const op0 = SessionOperation.providerId(msg.id, 0)
        const op1 = SessionOperation.providerId(msg.id, 1)
        const rec0 = yield* SessionOperation.get(db, op0)
        const rec1 = yield* SessionOperation.get(db, op1)
        expect(rec0?.outcome).toBe("failed")
        expect(rec0?.code).toBe("provider.failed")
        expect(rec1?.outcome).toBe("succeeded")
        expect(rec1?.code).toBe("provider.succeeded")
        // Strict durable link present on both attempts, no error.
        expect(yield* SessionOperation.getProviderGen(db, op0)).toBe(gen)
        expect(yield* SessionOperation.getProviderGen(db, op1)).toBe(gen)
      }),
    { config: (url) => providerCfg(url) },
  ),
)
