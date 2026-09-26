// kilocode_change - owner-scoped retry budget: provider, incomplete-response,
// and broker retries share one finite budget per accepted generation.
import { NodeFileSystem } from "@effect/platform-node"
import { afterEach, describe, expect, spyOn } from "bun:test"
import { APICallError } from "ai"
import { Cause, Context, Duration, Effect, Exit, Layer, Schedule, Schema } from "effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import { HttpBody, HttpClientRequest } from "effect/unstable/http"
import type { LLMEvent } from "@opencode-ai/llm"
import { LLMError } from "@opencode-ai/llm"
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
import type { Session as SessionSvc } from "../../src/session/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionRetry } from "../../src/session/retry"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { SyncEvent } from "../../src/sync"
import * as Log from "@opencode-ai/core/util/log"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import * as Broker from "@/kilocode/server/provider-http-execute-broker"
import { make as makeExecutor } from "@/kilocode/provider/canonical-request-executor"
import { KiloRetryBudget } from "@/kilocode/session/retry-budget"
import { KiloTaskRetry } from "@/kilocode/tool/task-retry"
import { provideTmpdirProject } from "../fixture/fixture"
import { it as bareIt, testEffect } from "../lib/effect"

Log.init({ print: false })

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

afterEach(() => {
  delete process.env.KILO_SESSION_RETRY_LIMIT
})

function retryable(): SessionV1.APIError {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message: "boom",
      isRetryable: true,
      responseHeaders: { "retry-after-ms": "0" },
    }).toObject(),
  )
}

describe("retry budget owner", () => {
  bareIt.effect("defaults to a finite bound and charges retries first", () =>
    Effect.gen(function* () {
      delete process.env.KILO_SESSION_RETRY_LIMIT
      expect(KiloRetryBudget.resolveLimit()).toBe(KiloRetryBudget.DEFAULT_LIMIT)
      expect(KiloRetryBudget.DEFAULT_LIMIT).toBeGreaterThan(0)
      const owner = KiloRetryBudget.make()
      expect(owner.limit).toBe(2)
      expect(KiloRetryBudget.charge(owner)).toBe(true)
      expect(KiloRetryBudget.charge(owner)).toBe(true)
      expect(KiloRetryBudget.exhausted(owner)).toBe(true)
      expect(KiloRetryBudget.charge(owner)).toBe(false)
      expect(owner.used).toBe(2)
    }),
  )

  bareIt.effect("honors an explicit configured limit", () =>
    Effect.gen(function* () {
      process.env.KILO_SESSION_RETRY_LIMIT = "1"
      try {
        expect(KiloRetryBudget.resolveLimit()).toBe(1)
        const owner = KiloRetryBudget.make()
        expect(KiloRetryBudget.charge(owner)).toBe(true)
        expect(KiloRetryBudget.charge(owner)).toBe(false)
      } finally {
        delete process.env.KILO_SESSION_RETRY_LIMIT
      }
    }),
  )
})

describe("session retry policy with owner budget", () => {
  const step = (budget?: KiloRetryBudget.Budget) =>
    Effect.gen(function* () {
      const calls: number[] = []
      const schedule = SessionRetry.policy({
        provider: "test",
        parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
        set: (info) => {
          calls.push(info.attempt)
          return Effect.void
        },
        ...(budget ? { budget } : {}),
      })
      return { step: yield* Schedule.toStep(schedule), calls }
    })

  bareIt.effect("schedules retries while the owner has budget", () =>
    Effect.gen(function* () {
      const owner = KiloRetryBudget.make(2)
      const { step: next, calls } = yield* step(owner)
      const err = retryable()
      const first = yield* next(0, err).pipe(Effect.exit)
      const second = yield* next(0, err).pipe(Effect.exit)
      const third = yield* next(0, err).pipe(Effect.exit)
      expect(Exit.isSuccess(first)).toBe(true)
      expect(Exit.isSuccess(second)).toBe(true)
      expect(Exit.isFailure(third)).toBe(true)
      expect(calls).toEqual([1, 2])
      expect(owner.used).toBe(2)
    }),
  )

  bareIt.effect("fails closed with no status update when the owner is exhausted", () =>
    Effect.gen(function* () {
      const owner = KiloRetryBudget.make(1)
      expect(KiloRetryBudget.charge(owner)).toBe(true)
      const { step: next, calls } = yield* step(owner)
      const exit = yield* next(0, retryable()).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toEqual([])
    }),
  )
})

describe("canonical broker inner retries with owner budget", () => {
  const ctx = {
    providerId: "acme",
    modelId: "m1",
    record: {
      name: "Acme",
      endpoint: "https://api.example.com/v1",
      protocol: "openai/completions" as const,
      models: { m1: { name: "M1" } },
      credential: "secret:kilo.credentials.global.provider.acme",
    },
  }
  const body = JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] })
  const request = () => {
    const base = HttpClientRequest.post("https://api.example.com/v1/chat/completions")
    return HttpClientRequest.setBody(base, HttpBody.text(body, "application/json"))
  }
  const failingBroker = (status: number, counter: { count: number }): Broker.Broker => ({
    stream: () => {
      counter.count += 1
      const headers: Record<string, string> = status === 429 ? { "retry-after-ms": "0" } : {}
      return Effect.succeed({
        status,
        headers,
        stream: Stream.succeed(new TextEncoder().encode("limited")),
      })
    },
    execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "unused" })),
  })
  const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const err = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(err)).toBe(true)
      if (Option.isSome(err)) return err.value as LLMError
    }
    throw new Error("expected failure")
  }

  bareIt.effect("charges the owner per inner retry and stops at the shared bound", () =>
    Effect.gen(function* () {
      const counter = { count: 0 }
      const owner = KiloRetryBudget.make(1)
      const executor = makeExecutor(ctx, failingBroker(429, counter))
      const exit = yield* Effect.provideService(executor.execute(request()), KiloRetryBudget.Owner, owner).pipe(
        Effect.exit,
      )
      const err = failureOf(exit)
      expect(err.retryable).toBe(true)
      // Initial attempt + exactly one charged inner retry.
      expect(counter.count).toBe(2)
      expect(owner.used).toBe(1)
    }),
  )

  bareIt.effect("starts no broker call when the owner is already exhausted", () =>
    Effect.gen(function* () {
      const counter = { count: 0 }
      const owner = KiloRetryBudget.make(1)
      expect(KiloRetryBudget.charge(owner)).toBe(true)
      const executor = makeExecutor(ctx, failingBroker(429, counter))
      const exit = yield* Effect.provideService(executor.execute(request()), KiloRetryBudget.Owner, owner).pipe(
        Effect.exit,
      )
      failureOf(exit)
      expect(counter.count).toBe(1)
      expect(owner.used).toBe(1)
    }),
  )

  bareIt.effect("keeps the static bound without an ambient owner and never charges it", () =>
    Effect.gen(function* () {
      const counter = { count: 0 }
      const executor = makeExecutor(ctx, failingBroker(429, counter))
      const exit = yield* executor.execute(request()).pipe(Effect.exit)
      failureOf(exit)
      expect(counter.count).toBe(3)
    }),
  )

  bareIt.effect("does not charge the owner for non-retryable failures", () =>
    Effect.gen(function* () {
      const counter = { count: 0 }
      const owner = KiloRetryBudget.make(2)
      const executor = makeExecutor(ctx, failingBroker(400, counter))
      const exit = yield* Effect.provideService(executor.execute(request()), KiloRetryBudget.Owner, owner).pipe(
        Effect.exit,
      )
      const err = failureOf(exit)
      expect(err.retryable).toBe(false)
      expect(counter.count).toBe(1)
      expect(owner.used).toBe(0)
    }),
  )

  bareIt.effect("never replays after a 2xx exposure", () =>
    Effect.gen(function* () {
      const counter = { count: 0 }
      const owner = KiloRetryBudget.make(2)
      const broker: Broker.Broker = {
        stream: () => {
          counter.count += 1
          return Effect.succeed({
            status: 200,
            headers: {},
            stream: Stream.fail(new Broker.ProviderHttpUnavailable({ message: "mid-stream" })),
          })
        },
        execute: () => Effect.fail(new Broker.ProviderHttpUnavailable({ message: "unused" })),
      }
      const executor = makeExecutor(ctx, broker)
      const exit = yield* Effect.provideService(executor.execute(request()), KiloRetryBudget.Owner, owner).pipe(
        Effect.exit,
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(counter.count).toBe(1)
      expect(owner.used).toBe(0)
    }),
  )
})

describe("child task retry with parent budget", () => {
  const sessions = {
    messages: () => Effect.succeed([]),
  } as unknown as SessionSvc.Interface
  const childID = SessionID.make("ses_child_budget")

  bareIt.effect("charges the parent owner per child re-invocation", () =>
    Effect.gen(function* () {
      const owner = KiloRetryBudget.make(1)
      let attempts = 0
      const ok = { info: { role: "assistant" } } as unknown as SessionV1.WithParts
      const out = yield* KiloTaskRetry.recover({
        error: retryable(),
        sessions,
        sessionID: childID,
        attempt: () =>
          Effect.sync(() => {
            attempts += 1
            return ok
          }),
        wait: () => Duration.millis(0),
        budget: owner,
      })
      expect(out).toBe(ok)
      expect(attempts).toBe(1)
      expect(owner.used).toBe(1)
    }),
  )

  bareIt.effect("starts no child attempt when the parent owner is exhausted", () =>
    Effect.gen(function* () {
      const owner = KiloRetryBudget.make(1)
      expect(KiloRetryBudget.charge(owner)).toBe(true)
      let attempts = 0
      const out = yield* KiloTaskRetry.recover({
        error: retryable(),
        sessions,
        sessionID: childID,
        attempt: () =>
          Effect.sync(() => {
            attempts += 1
            return { info: { role: "assistant" } } as unknown as SessionV1.WithParts
          }),
        wait: () => Duration.millis(0),
        budget: owner,
      })
      expect(out).toBeUndefined()
      expect(attempts).toBe(0)
    }),
  )
})

// Processor-level proof through the real SessionProcessor stack: production
// default (no env) is bounded, and an explicit lower limit is honored.
type Script = Stream.Stream<LLMEvent, unknown>

class TestLLM extends Context.Service<
  TestLLM,
  {
    readonly push: (stream: Script) => Effect.Effect<void>
    readonly calls: Effect.Effect<number>
  }
>()("@test/RetryBudgetLLM") {}

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

function retryable429() {
  return new APICallError({
    message: "429 status code (no body)",
    url: "https://api.openai.com/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: { "content-type": "application/json" },
    isRetryable: true,
  })
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
            return item
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

describe("session processor owner budget", () => {
  const run = (failures: number) =>
    provideTmpdirProject(
      (dir) =>
        Effect.gen(function* () {
          const test = yield* TestLLM
          const processors = yield* SessionProcessor.Service
          const session = yield* Session.Service
          for (let i = 0; i < failures; i++) yield* test.push(Stream.fail(retryable429()))

          const delay = spyOn(SessionRetry, "delay").mockReturnValue(0)
          try {
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
            const result = yield* handle.process({
              user: parent as MessageV2.User,
              sessionID: chat.id,
              model: mdl,
              agent: { name: "code", mode: "primary", permission: [], options: {} } as any,
              system: [],
              messages: [],
              tools: {},
            })
            return { result, calls: yield* test.calls, error: handle.message.error }
          } finally {
            delay.mockRestore()
          }
        }),
      { git: true },
    )

  it.live("production default is bounded without env configuration", () =>
    Effect.gen(function* () {
      delete process.env.KILO_SESSION_RETRY_LIMIT
      const out = yield* run(5)
      expect(out.result).toBe("stop")
      // Default owner budget allows exactly two retries past the initial attempt.
      expect(out.calls).toBe(3)
      expect(MessageV2.APIError.isInstance(out.error)).toBe(true)
    }),
  )

  it.live("an explicit lower limit is honored and never relaxed", () =>
    Effect.gen(function* () {
      process.env.KILO_SESSION_RETRY_LIMIT = "1"
      try {
        const out = yield* run(5)
        expect(out.result).toBe("stop")
        expect(out.calls).toBe(2)
        expect(MessageV2.APIError.isInstance(out.error)).toBe(true)
      } finally {
        delete process.env.KILO_SESSION_RETRY_LIMIT
      }
    }),
  )
})
