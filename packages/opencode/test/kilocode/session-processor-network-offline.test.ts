// kilocode_change - new file
import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect, spyOn } from "bun:test"
import { Context, Effect, Fiber, Layer } from "effect"
import * as Stream from "effect/Stream"
import { LLMEvent, type LLMEvent as Event } from "@opencode-ai/llm"
import { Database } from "@opencode-ai/core/database/database"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Image } from "../../src/image/image"
import { KiloSessionProcessor } from "../../src/kilocode/session/processor"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import type { Provider } from "../../src/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Reference } from "../../src/reference/reference"
import { Session } from "../../src/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionNetwork } from "../../src/session/network"
import { SessionProcessor } from "../../src/session/processor"
import { SessionRetry } from "../../src/session/retry"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { SyncEvent } from "../../src/sync"
import * as Log from "@opencode-ai/core/util/log"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirProject } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

Log.init({ print: false })

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

type Script = Stream.Stream<Event, unknown>

class TestLLM extends Context.Service<
  TestLLM,
  {
    readonly push: (stream: Script) => Effect.Effect<void>
  }
>()("@test/OfflineLLM") {}

function model(): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
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
    api: { npm: "@ai-sdk/openai" },
    options: {},
  } as Provider.Model
}

function usage() {
  return {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  }
}

const llm = Layer.unwrap(
  Effect.gen(function* () {
    const queue: Script[] = []
    const push = (item: Script) => {
      queue.push(item)
      return Effect.void
    }
    return Layer.mergeAll(
      Layer.succeed(
        LLM.Service,
        LLM.Service.of({
          stream: () => {
            const item = queue.shift() ?? Stream.empty
            return item
          },
        }),
      ),
      Layer.succeed(TestLLM, TestLLM.of({ push })),
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

function retry() {
  return Stream.make(
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.stepFinish({ index: 0, reason: "stop", usage: usage() }),
    LLMEvent.finish({ reason: "stop", usage: usage() }),
  )
}

const setup = Effect.fn("SessionProcessorOfflineTest.setup")(function* (dir: string) {
  const test = yield* TestLLM
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const chat = yield* session.create({})
  const parent = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "code",
    model: ref,
    time: { created: Date.now() },
  })
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: chat.id,
    parentID: parent.id,
    mode: "code",
    agent: "code",
    path: { cwd: path.resolve(dir), root: path.resolve(dir) },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(msg)
  const mdl = model()
  const handle = yield* processors.create({
    assistantMessage: msg,
    sessionID: chat.id,
    model: mdl,
  })
  const input: LLM.StreamInput = {
    user: parent as MessageV2.User,
    sessionID: chat.id,
    model: mdl,
    agent: { name: "code", mode: "primary", permission: [], options: {} } as any,
    system: [],
    messages: [],
    tools: {},
  }
  return { test, chat, handle, input }
})

describe("session processor network offline", () => {
  it.effect("enters the offline ask lifecycle when generic connectivity is down", () =>
    provideTmpdirProject(
      (dir) =>
        Effect.gen(function* () {
          const ctx = yield* setup(dir)
          const err = new Error("Unable to connect. Is the computer able to access the url?")

          // First call: network error via Stream.fail; second call: success
          yield* ctx.test.push(Stream.fail(err))
          yield* ctx.test.push(retry())

          // Auto-reply to network reconnect request
          const offAsk = Bus.subscribe(SessionNetwork.Event.Asked, (event) => {
            void SessionNetwork.reply({ requestID: event.properties.id })
          })
          // Confirmed generic offline: the bounded probe reports no connectivity
          // before the ask is created.
          const online = spyOn(SessionNetwork, "online").mockResolvedValue(false)
          const ask = spyOn(SessionNetwork, "ask")
          // The unified backoff makes the retry wait 2s under TestClock, which
          // never advances; the delay/backoff shape is covered by policy tests.
          const delay = spyOn(SessionRetry, "delay").mockReturnValue(0)

          try {
            const result = yield* ctx.handle.process(ctx.input)
            expect(result).toBe("continue")
            expect(online).toHaveBeenCalled()
            expect(ask).toHaveBeenCalledTimes(1)
            // Verify the offline handler was invoked with the correct message
            const call = ask.mock.calls[0]
            expect(call[0]).toMatchObject({
              sessionID: ctx.chat.id,
              message: err.message,
            })
            // The auto-reply removed the pending wait; no orphan remains.
            expect(yield* Effect.promise(() => SessionNetwork.list())).toHaveLength(0)
          } finally {
            offAsk()
            online.mockRestore()
            ask.mockRestore()
            delay.mockRestore()
          }
        }),
      { git: true },
    ),
  )

  it.effect("skips the offline ask and retries normally when generic connectivity is available", () =>
    provideTmpdirProject(
      (dir) =>
        Effect.gen(function* () {
          const ctx = yield* setup(dir)

          // Provider-scoped disconnect leaves the general internet reachable.
          yield* ctx.test.push(Stream.fail(new Error("Unable to connect. Is the computer able to access the url?")))
          yield* ctx.test.push(retry())

          const seen: string[] = []
          const offAsked = Bus.subscribe(SessionNetwork.Event.Asked, () => seen.push("asked"))
          const online = spyOn(SessionNetwork, "online").mockResolvedValue(true)
          const ask = spyOn(SessionNetwork, "ask")
          const delay = spyOn(SessionRetry, "delay").mockReturnValue(0)

          try {
            const result = yield* ctx.handle.process(ctx.input)
            expect(result).toBe("continue")
            expect(online).toHaveBeenCalledTimes(1)
            // No ask, no offline status, no Asked event; the retry fell through
            // to the normal policy backoff path (delay ran for the next attempt).
            expect(ask).not.toHaveBeenCalled()
            expect(seen).toEqual([])
            expect(delay).toHaveBeenCalled()
            expect(yield* Effect.promise(() => SessionNetwork.list())).toHaveLength(0)
          } finally {
            offAsked()
            online.mockRestore()
            ask.mockRestore()
            delay.mockRestore()
          }
        }),
      { git: true },
    ),
  )

  it.effect("returns aborted without probing when the session is already aborted", () =>
    provideTmpdirProject(
      (dir) =>
        Effect.gen(function* () {
          const abort = new AbortController()
          const online = spyOn(SessionNetwork, "online")
          const ask = spyOn(SessionNetwork, "ask")
          abort.abort()

          try {
            const result = yield* KiloSessionProcessor.handleOffline({
              error: new Error("fetch failed"),
              sessionID: SessionID.make("ses_offline_abort_before"),
              abort: abort.signal,
              set: () => Effect.void,
            })
            expect(result).toBe("aborted")
            expect(online).not.toHaveBeenCalled()
            expect(ask).not.toHaveBeenCalled()
            expect(yield* Effect.promise(() => SessionNetwork.list())).toHaveLength(0)
          } finally {
            online.mockRestore()
            ask.mockRestore()
          }
        }),
      { git: true },
    ),
  )

  it.live("abort during the connectivity probe never creates an ask or pending wait", () =>
    provideTmpdirProject(
      (dir) =>
        Effect.gen(function* () {
          const abort = new AbortController()
          const seen: string[] = []
          const offAsked = Bus.subscribe(SessionNetwork.Event.Asked, () => seen.push("asked"))
          const offRejected = Bus.subscribe(SessionNetwork.Event.Rejected, () => seen.push("rejected"))
          let settle!: (value: boolean) => void
          // Probe stays in flight until the test settles it.
          const online = spyOn(SessionNetwork, "online").mockReturnValue(
            new Promise<boolean>((resolve) => {
              settle = resolve
            }),
          )
          const ask = spyOn(SessionNetwork, "ask")

          try {
            const fiber = yield* KiloSessionProcessor.handleOffline({
              error: new Error("fetch failed"),
              sessionID: SessionID.make("ses_offline_abort_probe"),
              abort: abort.signal,
              set: () => Effect.void,
            }).pipe(Effect.forkScoped)

            // Wait for the probe to actually start, then abort mid-probe.
            yield* pollWithTimeout(
              Effect.sync(() => (online.mock.calls.length > 0 ? (true as const) : undefined)),
              "probe never started",
            )
            abort.abort()
            settle(false) // probe would have reported offline

            expect(yield* Fiber.join(fiber)).toBe("aborted")
            expect(online).toHaveBeenCalledTimes(1)
            expect(ask).not.toHaveBeenCalled()
            expect(seen).toEqual([])
            expect(yield* Effect.promise(() => SessionNetwork.list())).toHaveLength(0)
          } finally {
            offAsked()
            offRejected()
            online.mockRestore()
            ask.mockRestore()
          }
        }),
      { git: true },
    ),
  )
})
