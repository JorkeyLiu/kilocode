import { NodeFileSystem } from "@effect/platform-node"
import { afterEach, describe, expect, spyOn } from "bun:test"
import { APICallError } from "ai"
import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { Usage, type LLMEvent } from "@opencode-ai/llm"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Image } from "../../src/image/image"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import type { Provider } from "../../src/provider/provider"
import { Reference } from "../../src/reference/reference"
import { Session } from "../../src/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionRetry } from "../../src/session/retry"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { SyncEvent } from "../../src/sync"
import * as Log from "@opencode-ai/core/util/log"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Admission } from "../../../llm/src/route/admission"
import { KiloSessionFallback } from "../../src/kilocode/session/fallback"
import { provideTmpdirProject } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const kilo = {
  providerID: ProviderV2.ID.make("kilo"),
  modelID: ModelV2.ID.make("kilo-model"),
}

const target = { providerID: "fb", modelID: "fb-model" }

type Script = Stream.Stream<LLMEvent, unknown>

class TestLLM extends Context.Service<
  TestLLM,
  {
    readonly push: (stream: Script) => Effect.Effect<void>
    readonly calls: Effect.Effect<number>
  }
>()("@test/FallbackLLM") {}

function stubModel(providerID: string, id: string): Provider.Model {
  return {
    id,
    providerID,
    name: "Test",
    limit: { context: 128000, output: 4096 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/openai-compatible" },
    options: {},
  } as Provider.Model
}

function fail429(body?: unknown) {
  return new APICallError({
    message: "429 status code",
    url: "https://gateway.test/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: { "content-type": "application/json" },
    responseBody: body === undefined ? JSON.stringify({ error: { type: "too_many_requests" } }) : JSON.stringify(body),
    isRetryable: true,
  })
}

function failQuota429() {
  return fail429({ error: { code: "insufficient_quota", message: "Quota exceeded. Check your plan and billing." } })
}

function failAuth() {
  return new APICallError({
    message: "401 status code",
    url: "https://gateway.test/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 401,
    responseHeaders: { "content-type": "application/json" },
    responseBody: JSON.stringify({ error: { code: "invalid_api_key", message: "Incorrect API key" } }),
    isRetryable: false,
  })
}

function failInvalidModel() {
  return new APICallError({
    message: "404 status code",
    url: "https://gateway.test/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 404,
    responseHeaders: { "content-type": "application/json" },
    responseBody: JSON.stringify({ error: { code: "model_not_found", message: "Model not found" } }),
    isRetryable: false,
  })
}

function successText(text: string) {
  return Stream.fromIterable([
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text },
    { type: "text-end", id: "t1" },
    {
      type: "step-finish",
      index: 0,
      reason: "stop",
      usage: new Usage({ inputTokens: 7, outputTokens: 9 }),
    },
  ] as unknown as LLMEvent[])
}

function partialThen429() {
  return Stream.concat(
    Stream.fromIterable([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "partial" },
      { type: "text-end", id: "t1" },
    ] as unknown as LLMEvent[]),
    Stream.fail(fail429()),
  )
}

const llm = Layer.unwrap(
  Effect.gen(function* () {
    const queue: Script[] = []
    let calls = 0
    const push = (item: Script) => {
      queue.push(item)
      return Effect.void
    }
    return Layer.mergeAll(
      Layer.succeed(
        LLM.Service,
        LLM.Service.of({
          stream: () => {
            calls += 1
            const item = queue.shift() ?? Stream.fail(new Error("unexpected extra llm call"))
            // Mirror the real executor contract: consume the admission slot
            // once per attempt so provider operations finalize per attempt.
            return Stream.fromEffect(Admission.consume()).pipe(Stream.flatMap(() => item)) as Script
          },
        }),
      ),
      Layer.succeed(TestLLM, TestLLM.of({ push, calls: Effect.sync(() => calls) })),
    )
  }),
)

const reference = Layer.mock(Reference.Service)({
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  get: () => Effect.succeed(undefined),
  ensure: () => Effect.void,
  contains: () => Effect.succeed(false),
})
const status = Layer.mergeAll(SessionStatus.defaultLayer, Bus.layer)
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  RuntimeFlags.layer(),
  reference,
  SessionSummary.defaultLayer,
  Image.defaultLayer,
  SyncEvent.defaultLayer,
  EventV2Bridge.defaultLayer,
  Database.defaultLayer,
  status,
  llm,
).pipe(Layer.provideMerge(infra))
const env = SessionProcessor.layer.pipe(Layer.provideMerge(deps), Layer.provide(reference))

const it = testEffect(env)

afterEach(() => {
  delete process.env.KILO_SESSION_RETRY_LIMIT
})

function agent() {
  return { name: "code", mode: "primary", permission: [], options: {} } as never
}

const seedUser = Effect.fn("TestFallback.user")(function* (
  sessionID: SessionID,
  model: { providerID: ProviderV2.ID; modelID: ModelV2.ID },
) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "code",
    model,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text: "hi",
  })
  return msg
})

const seedAssistant = Effect.fn("TestFallback.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  model: { providerID: ProviderV2.ID; modelID: ModelV2.ID },
  opts?: { finish?: boolean; text?: string },
) {
  const session = yield* Session.Service
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    parentID,
    mode: "code",
    agent: "code",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.modelID,
    providerID: model.providerID,
    time: { created: Date.now() },
    ...(opts?.finish === false ? {} : { finish: "stop" }),
  }
  yield* session.updateMessage(msg)
  if (opts?.text !== undefined) {
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text",
      text: opts.text,
    })
  }
  return msg
})

function processInput(sessionID: string, user: { id: string }, mdl: Provider.Model) {
  return {
    user: {
      id: user.id,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "code",
      model: { providerID: kilo.providerID, modelID: kilo.modelID },
    },
    sessionID,
    model: mdl,
    agent: agent(),
    system: [],
    messages: [{ role: "user", content: "hi" }],
    tools: {},
  } as unknown as LLM.StreamInput
}

describe("session fallback takeover", () => {
  it.live(
    "unset flag arms a single same-channel retry before takeover when eligible",
    () =>
      provideTmpdirProject(
        (dir) =>
          Effect.gen(function* () {
            delete process.env.KILO_SESSION_RETRY_LIMIT
            const test = yield* TestLLM
            const processors = yield* SessionProcessor.Service
            const session = yield* Session.Service
            const database = yield* Database.Service
            yield* test.push(Stream.fail(fail429()))
            yield* test.push(Stream.fail(fail429()))
            yield* test.push(successText("via fallback"))
            const delay = spyOn(SessionRetry, "delay").mockReturnValue(0)
            try {
              const chat = yield* session.create({})
              const oldUser = yield* seedUser(chat.id, {
                providerID: kilo.providerID,
                modelID: ModelV2.ID.make("kilo-old"),
              })
              yield* seedAssistant(
                chat.id,
                oldUser.id,
                {
                  providerID: kilo.providerID,
                  modelID: ModelV2.ID.make("kilo-old"),
                },
                { text: "old" },
              )
              const parent = yield* seedUser(chat.id, kilo)
              const msg = yield* seedAssistant(chat.id, parent.id, kilo, { finish: false })
              const mdl = stubModel("kilo", "kilo-model")
              const handle = yield* processors.create({
                assistantMessage: msg,
                sessionID: chat.id,
                model: mdl,
                resolveModel: (providerID, modelID) => Effect.succeed(stubModel(String(providerID), String(modelID))),
              })
              const result = yield* handle.process(processInput(chat.id, parent, mdl))
              expect(result).toBe("continue")
              // Armed default: initial attempt plus one same-channel retry,
              // then the fallback attempt. No explicit flag was set.
              expect(process.env.KILO_SESSION_RETRY_LIMIT).toBeUndefined()
              expect(yield* test.calls).toBe(3)
              expect((yield* session.get(chat.id)).fallback).toEqual(target)
              const listed = yield* SessionOperation.list(database.db, SessionSchema.ID.make(chat.id))
              expect(listed.map((r) => r.opId)).toEqual([
                SessionOperation.providerId(msg.id, 0),
                SessionOperation.providerId(msg.id, 1),
                SessionOperation.providerId(msg.id, 2),
              ])
              expect(path.resolve(dir)).toBeTruthy()
            } finally {
              delay.mockRestore()
            }
          }),
        { git: true, config: { fallback_model: "fb/fb-model" } },
      ),
    30000,
  )

  it.live(
    "takes over exhausted pre-output 429 after prior Kilo success",
    () =>
      provideTmpdirProject(
        (dir) =>
          Effect.gen(function* () {
            process.env.KILO_SESSION_RETRY_LIMIT = "1"
            const test = yield* TestLLM
            const processors = yield* SessionProcessor.Service
            const session = yield* Session.Service
            const database = yield* Database.Service
            yield* test.push(Stream.fail(fail429()))
            yield* test.push(Stream.fail(fail429()))
            yield* test.push(successText("via fallback"))
            const delay = spyOn(SessionRetry, "delay").mockReturnValue(0)
            try {
              const chat = yield* session.create({})
              const oldUser = yield* seedUser(chat.id, {
                providerID: kilo.providerID,
                modelID: ModelV2.ID.make("kilo-old"),
              })
              yield* seedAssistant(
                chat.id,
                oldUser.id,
                {
                  providerID: kilo.providerID,
                  modelID: ModelV2.ID.make("kilo-old"),
                },
                { text: "old" },
              )
              const parent = yield* seedUser(chat.id, kilo)
              const msg = yield* seedAssistant(chat.id, parent.id, kilo, { finish: false })
              const mdl = stubModel("kilo", "kilo-model")
              const seen: Array<{ providerID: string; modelID: string }> = []
              const handle = yield* processors.create({
                assistantMessage: msg,
                sessionID: chat.id,
                model: mdl,
                resolveModel: (providerID, modelID) => {
                  seen.push({ providerID: String(providerID), modelID: String(modelID) })
                  return Effect.succeed(stubModel(String(providerID), String(modelID)))
                },
              })
              const result = yield* handle.process(processInput(chat.id, parent, mdl))
              expect(result).toBe("continue")
              expect(yield* test.calls).toBe(3)
              // Fallback attempted exactly once through the active channel.
              // The resolver is consulted twice: the pre-turn arming trial
              // (read-only) plus the actual takeover resolution.
              expect(seen).toEqual([
                { providerID: "fb", modelID: "fb-model" },
                { providerID: "fb", modelID: "fb-model" },
              ])
              // Fresh provider operation identity per attempt.
              const listed = yield* SessionOperation.list(database.db, SessionSchema.ID.make(chat.id))
              expect(listed.map((r) => r.opId)).toEqual([
                SessionOperation.providerId(msg.id, 0),
                SessionOperation.providerId(msg.id, 1),
                SessionOperation.providerId(msg.id, 2),
              ])
              expect(listed[0]!.outcome).toBe("failed")
              expect(listed[1]!.outcome).toBe("failed")
              expect(listed[2]!.outcome).toBe("succeeded")
              // Sticky takeover persisted at session level.
              expect((yield* session.get(chat.id)).fallback).toEqual(target)
              // Attribution follows the actual fallback model, no duplication.
              const after = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
              if (after.info.role !== "assistant") return yield* Effect.die(new Error("expected assistant"))
              expect(String(after.info.providerID)).toBe("fb")
              expect(String(after.info.modelID)).toBe("fb-model")
              expect(after.info.tokens.input).toBe(7)
              expect(after.info.tokens.output).toBe(9)
              const texts = after.parts.filter((p) => p.type === "text" && !p.synthetic)
              expect(texts.map((p) => (p as { text: string }).text)).toEqual(["via fallback"])
              expect(path.resolve(dir)).toBeTruthy()
            } finally {
              delay.mockRestore()
            }
          }),
        { git: true, config: { fallback_model: "fb/fb-model" } },
      ),
    30000,
  )

  it.live(
    "no prior success preserves failure without takeover",
    () =>
      provideTmpdirProject(
        () =>
          Effect.gen(function* () {
            process.env.KILO_SESSION_RETRY_LIMIT = "1"
            const test = yield* TestLLM
            const processors = yield* SessionProcessor.Service
            const session = yield* Session.Service
            const database = yield* Database.Service
            yield* test.push(Stream.fail(fail429()))
            yield* test.push(Stream.fail(fail429()))
            const delay = spyOn(SessionRetry, "delay").mockReturnValue(0)
            try {
              const chat = yield* session.create({})
              const parent = yield* seedUser(chat.id, kilo)
              const msg = yield* seedAssistant(chat.id, parent.id, kilo, { finish: false })
              const mdl = stubModel("kilo", "kilo-model")
              const seen: Array<unknown> = []
              const handle = yield* processors.create({
                assistantMessage: msg,
                sessionID: chat.id,
                model: mdl,
                resolveModel: (providerID, modelID) => {
                  seen.push({ providerID: String(providerID), modelID: String(modelID) })
                  return Effect.succeed(stubModel(String(providerID), String(modelID)))
                },
              })
              const result = yield* handle.process(processInput(chat.id, parent, mdl))
              expect(result).toBe("stop")
              expect(yield* test.calls).toBe(2)
              expect(seen).toEqual([])
              expect((yield* session.get(chat.id)).fallback).toBeUndefined()
              const listed = yield* SessionOperation.list(database.db, SessionSchema.ID.make(chat.id))
              expect(listed.length).toBe(2)
              for (const r of listed) expect(r.outcome).toBe("failed")
              expect(handle.message.error).toBeDefined()
            } finally {
              delay.mockRestore()
            }
          }),
        { git: true, config: { fallback_model: "fb/fb-model" } },
      ),
    30000,
  )

  it.live(
    "prior non-Kilo success preserves failure without takeover",
    () =>
      provideTmpdirProject(
        () =>
          Effect.gen(function* () {
            process.env.KILO_SESSION_RETRY_LIMIT = "1"
            const test = yield* TestLLM
            const processors = yield* SessionProcessor.Service
            const session = yield* Session.Service
            yield* test.push(Stream.fail(fail429()))
            yield* test.push(Stream.fail(fail429()))
            const delay = spyOn(SessionRetry, "delay").mockReturnValue(0)
            try {
              const chat = yield* session.create({})
              const other = { providerID: ProviderV2.ID.make("other"), modelID: ModelV2.ID.make("other-model") }
              const oldUser = yield* seedUser(chat.id, other)
              yield* seedAssistant(chat.id, oldUser.id, other, { text: "old" })
              const parent = yield* seedUser(chat.id, kilo)
              const msg = yield* seedAssistant(chat.id, parent.id, kilo, { finish: false })
              const mdl = stubModel("kilo", "kilo-model")
              const seen: Array<unknown> = []
              const handle = yield* processors.create({
                assistantMessage: msg,
                sessionID: chat.id,
                model: mdl,
                resolveModel: (providerID, modelID) => {
                  seen.push(1)
                  return Effect.succeed(stubModel(String(providerID), String(modelID)))
                },
              })
              const result = yield* handle.process(processInput(chat.id, parent, mdl))
              expect(result).toBe("stop")
              expect(yield* test.calls).toBe(2)
              expect(seen).toEqual([])
              expect((yield* session.get(chat.id)).fallback).toBeUndefined()
            } finally {
              delay.mockRestore()
            }
          }),
        { git: true, config: { fallback_model: "fb/fb-model" } },
      ),
    30000,
  )

  it.live(
    "quota 429 preserves failure without takeover",
    () =>
      provideTmpdirProject(
        () =>
          Effect.gen(function* () {
            process.env.KILO_SESSION_RETRY_LIMIT = "1"
            const test = yield* TestLLM
            const processors = yield* SessionProcessor.Service
            const session = yield* Session.Service
            yield* test.push(Stream.fail(failQuota429()))
            yield* test.push(Stream.fail(failQuota429()))
            const delay = spyOn(SessionRetry, "delay").mockReturnValue(0)
            try {
              const chat = yield* session.create({})
              const oldUser = yield* seedUser(chat.id, kilo)
              yield* seedAssistant(chat.id, oldUser.id, kilo, { text: "old" })
              const parent = yield* seedUser(chat.id, kilo)
              const msg = yield* seedAssistant(chat.id, parent.id, kilo, { finish: false })
              const mdl = stubModel("kilo", "kilo-model")
              const seen: Array<unknown> = []
              const handle = yield* processors.create({
                assistantMessage: msg,
                sessionID: chat.id,
                model: mdl,
                resolveModel: (providerID, modelID) => {
                  seen.push(1)
                  return Effect.succeed(stubModel(String(providerID), String(modelID)))
                },
              })
              const result = yield* handle.process(processInput(chat.id, parent, mdl))
              expect(result).toBe("stop")
              expect(yield* test.calls).toBe(2)
              // Read-only arming trial only: no takeover attempt, no sticky.
              expect(seen).toEqual([1])
              expect((yield* session.get(chat.id)).fallback).toBeUndefined()
            } finally {
              delay.mockRestore()
            }
          }),
        { git: true, config: { fallback_model: "fb/fb-model" } },
      ),
    30000,
  )

  it.live(
    "auth and invalid-model errors preserve failure without takeover",
    () =>
      provideTmpdirProject(
        () =>
          Effect.gen(function* () {
            const test = yield* TestLLM
            const processors = yield* SessionProcessor.Service
            const session = yield* Session.Service
            yield* test.push(Stream.fail(failAuth()))
            const chat = yield* session.create({})
            const oldUser = yield* seedUser(chat.id, kilo)
            yield* seedAssistant(chat.id, oldUser.id, kilo, { text: "old" })
            const parent = yield* seedUser(chat.id, kilo)
            const msg = yield* seedAssistant(chat.id, parent.id, kilo, { finish: false })
            const mdl = stubModel("kilo", "kilo-model")
            const seen: Array<unknown> = []
            const handle = yield* processors.create({
              assistantMessage: msg,
              sessionID: chat.id,
              model: mdl,
              resolveModel: (providerID, modelID) => {
                seen.push(1)
                return Effect.succeed(stubModel(String(providerID), String(modelID)))
              },
            })
            const result = yield* handle.process(processInput(chat.id, parent, mdl))
            expect(result).toBe("stop")
            expect(yield* test.calls).toBe(1)
            // Read-only arming trial only: no takeover attempt, no sticky.
            expect(seen).toEqual([1])
            expect((yield* session.get(chat.id)).fallback).toBeUndefined()
            yield* test.push(Stream.fail(failInvalidModel()))
            const parent2 = yield* seedUser(chat.id, kilo)
            const msg2 = yield* seedAssistant(chat.id, parent2.id, kilo, { finish: false })
            const handle2 = yield* processors.create({
              assistantMessage: msg2,
              sessionID: chat.id,
              model: mdl,
              resolveModel: (providerID, modelID) => {
                seen.push(1)
                return Effect.succeed(stubModel(String(providerID), String(modelID)))
              },
            })
            const result2 = yield* handle2.process(processInput(chat.id, parent2, mdl))
            expect(result2).toBe("stop")
            // Second read-only arming trial; still no takeover attempt.
            expect(seen).toEqual([1, 1])
            expect((yield* session.get(chat.id)).fallback).toBeUndefined()
          }),
        { git: true, config: { fallback_model: "fb/fb-model" } },
      ),
    30000,
  )

  it.live(
    "post-output 429 preserves failure without takeover",
    () =>
      provideTmpdirProject(
        () =>
          Effect.gen(function* () {
            const test = yield* TestLLM
            const processors = yield* SessionProcessor.Service
            const session = yield* Session.Service
            yield* test.push(partialThen429())
            const chat = yield* session.create({})
            const oldUser = yield* seedUser(chat.id, kilo)
            yield* seedAssistant(chat.id, oldUser.id, kilo, { text: "old" })
            const parent = yield* seedUser(chat.id, kilo)
            const msg = yield* seedAssistant(chat.id, parent.id, kilo, { finish: false })
            const mdl = stubModel("kilo", "kilo-model")
            const seen: Array<unknown> = []
            const handle = yield* processors.create({
              assistantMessage: msg,
              sessionID: chat.id,
              model: mdl,
              resolveModel: (providerID, modelID) => {
                seen.push(1)
                return Effect.succeed(stubModel(String(providerID), String(modelID)))
              },
            })
            const result = yield* handle.process(processInput(chat.id, parent, mdl))
            expect(result).toBe("stop")
            // No same-channel retry after output and no fallback attempt.
            expect(yield* test.calls).toBe(1)
            // Read-only arming trial only: the exposed output blocks takeover.
            expect(seen).toEqual([1])
            expect((yield* session.get(chat.id)).fallback).toBeUndefined()
            const after = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
            if (after.info.role !== "assistant") return yield* Effect.die(new Error("expected assistant"))
            const texts = after.parts.filter((p) => p.type === "text" && !p.synthetic)
            expect(texts.map((p) => (p as { text: string }).text)).toEqual(["partial"])
          }),
        { git: true, config: { fallback_model: "fb/fb-model" } },
      ),
    30000,
  )

  it.live(
    "unresolvable fallback target preserves the original failure",
    () =>
      provideTmpdirProject(
        () =>
          Effect.gen(function* () {
            process.env.KILO_SESSION_RETRY_LIMIT = "1"
            const test = yield* TestLLM
            const processors = yield* SessionProcessor.Service
            const session = yield* Session.Service
            yield* test.push(Stream.fail(fail429()))
            yield* test.push(Stream.fail(fail429()))
            const delay = spyOn(SessionRetry, "delay").mockReturnValue(0)
            try {
              const chat = yield* session.create({})
              const oldUser = yield* seedUser(chat.id, kilo)
              yield* seedAssistant(chat.id, oldUser.id, kilo, { text: "old" })
              const parent = yield* seedUser(chat.id, kilo)
              const msg = yield* seedAssistant(chat.id, parent.id, kilo, { finish: false })
              const mdl = stubModel("kilo", "kilo-model")
              const handle = yield* processors.create({
                assistantMessage: msg,
                sessionID: chat.id,
                model: mdl,
                resolveModel: () => Effect.die(new Error("removed")),
              })
              const result = yield* handle.process(processInput(chat.id, parent, mdl))
              expect(result).toBe("stop")
              expect(yield* test.calls).toBe(2)
              expect((yield* session.get(chat.id)).fallback).toBeUndefined()
              expect(handle.message.error).toBeDefined()
            } finally {
              delay.mockRestore()
            }
          }),
        { git: true, config: { fallback_model: "fb/fb-model" } },
      ),
    30000,
  )

  it.live(
    "sticky session routes the next turn through the persisted target",
    () =>
      provideTmpdirProject(
        () =>
          Effect.gen(function* () {
            const processors = yield* SessionProcessor.Service
            const session = yield* Session.Service
            void processors
            const chat = yield* session.create({})
            yield* session.setFallback({ sessionID: chat.id, fallback: { ...target } })
            const sticky = (yield* session.get(chat.id)).fallback
            expect(sticky).toEqual(target)
            // The persisted target wins even when the request names Kilo;
            // Kilo resolution would fail closed here instead of routing.
            const out = yield* KiloSessionFallback.turn({
              sticky,
              requested: { providerID: kilo.providerID, modelID: kilo.modelID },
              resolve: (providerID, modelID) => {
                if (String(providerID) === "kilo") return Effect.die(new Error("must not route Kilo"))
                return Effect.succeed(stubModel(String(providerID), String(modelID)))
              },
            })
            expect(String(out.providerID)).toBe("fb")
            expect(String(out.id)).toBe("fb-model")
          }),
        { git: true },
      ),
    30000,
  )
})
