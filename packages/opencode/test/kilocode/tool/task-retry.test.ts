import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Cause, Duration, Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Provider } from "@/provider/provider"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { KiloTaskRetry } from "@/kilocode/tool/task-retry"
import { NotFoundError } from "@/storage/storage"
import { disposeAllInstances } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = Layer.mergeAll(
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
  ToolRegistry.defaultLayer,
  Database.defaultLayer,
  RuntimeFlags.layer({}),
)

const it = testEffect(layer)

const zero = () => Duration.zero

const transient = () => new SessionV1.APIError({ message: "Provider is Overloaded", isRetryable: true }).toObject()
const aborted = () => new SessionV1.AbortedError({ message: "aborted" }).toObject()
const auth = () => new SessionV1.AuthError({ providerID: "test", message: "invalid key" }).toObject()

const seed = Effect.fn("KiloTaskRetryTest.seed")(function* (title = "Parent") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function failed(input: SessionPrompt.PromptInput, error: NonNullable<SessionV1.Assistant["error"]>) {
  const rep = reply(input, "partial")
  if (rep.info.role !== "assistant") return rep
  return { ...rep, info: { ...rep.info, error } }
}

const stub = (input: { sessionID: SessionID }) =>
  ({
    messageID: MessageID.ascending(),
    sessionID: input.sessionID,
    agent: "general",
    parts: [{ type: "text" as const, text: "continue" }],
  }) as SessionPrompt.PromptInput

const child = Effect.fn("KiloTaskRetryTest.child")(function* (parentID: SessionID) {
  const sessions = yield* Session.Service
  return yield* sessions.create({ parentID, title: "child" })
})

const seedTool = Effect.fn("KiloTaskRetryTest.seedTool")(function* (sessionID: SessionID, state: SessionV1.ToolState) {
  const sessions = yield* Session.Service
  const message = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: MessageID.ascending(),
    sessionID,
    mode: "general",
    agent: "general",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: message.id,
    sessionID,
    type: "tool",
    callID: "call_1",
    tool: "bash",
    state,
  })
})

describe("kilocode.tool.task-retry", () => {
  describe("recover", () => {
    it.instance("retries a transient failure in the same child session and returns the success", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat } = yield* seed()
        const kid = yield* child(chat.id)
        const inputs: SessionPrompt.PromptInput[] = []

        const result = yield* KiloTaskRetry.recover({
          error: transient(),
          sessions,
          sessionID: kid.id,
          wait: zero,
          attempt: () =>
            Effect.sync(() => {
              const input = stub({ sessionID: kid.id })
              inputs.push(input)
              return reply(input, "recovered")
            }),
        })

        expect(inputs).toHaveLength(1)
        expect(inputs[0]?.sessionID).toBe(kid.id)
        expect(result?.parts.findLast((item) => item.type === "text")?.text).toBe("recovered")
      }),
    )

    it.instance("stops after the maximum of 2 retries and returns the last failed attempt", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat } = yield* seed()
        const kid = yield* child(chat.id)
        let attempts = 0

        const result = yield* KiloTaskRetry.recover({
          error: transient(),
          sessions,
          sessionID: kid.id,
          wait: zero,
          attempt: () =>
            Effect.sync(() => {
              attempts++
              return failed(stub({ sessionID: kid.id }), transient())
            }),
        })

        expect(attempts).toBe(KiloTaskRetry.MAX)
        expect(attempts).toBe(2)
        expect(result?.info.role === "assistant" ? result.info.error?.name : undefined).toBe("APIError")
      }),
    )

    it.instance("does not retry aborted or auth errors", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat } = yield* seed()
        const kid = yield* child(chat.id)
        let attempts = 0
        const attempt = () =>
          Effect.sync(() => {
            attempts++
            return reply(stub({ sessionID: kid.id }), "never")
          })

        const one = yield* KiloTaskRetry.recover({ error: aborted(), sessions, sessionID: kid.id, wait: zero, attempt })
        const two = yield* KiloTaskRetry.recover({ error: auth(), sessions, sessionID: kid.id, wait: zero, attempt })

        expect(attempts).toBe(0)
        expect(one).toBeUndefined()
        expect(two).toBeUndefined()
      }),
    )

    it.instance("does not retry when the child history contains committed or ambiguous tool parts", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat } = yield* seed()
        const now = Date.now()
        const states: SessionV1.ToolState[] = [
          {
            status: "completed",
            input: {},
            output: "ok",
            title: "bash",
            metadata: {},
            time: { start: now, end: now },
          },
          { status: "running", input: {}, time: { start: now } },
          {
            status: "error",
            input: {},
            error: "Tool execution aborted",
            metadata: { interrupted: true },
            time: { start: now, end: now },
          },
        ]

        for (const state of states) {
          const kid = yield* child(chat.id)
          yield* seedTool(kid.id, state)
          let attempts = 0

          const result = yield* KiloTaskRetry.recover({
            error: transient(),
            sessions,
            sessionID: kid.id,
            wait: zero,
            attempt: () =>
              Effect.sync(() => {
                attempts++
                return reply(stub({ sessionID: kid.id }), "never")
              }),
          })

          expect(attempts).toBe(0)
          expect(result).toBeUndefined()
        }
      }),
    )

    it.instance("still retries when the child only has a plain (non-interrupted) errored tool part", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat } = yield* seed()
        const kid = yield* child(chat.id)
        const now = Date.now()
        yield* seedTool(kid.id, {
          status: "error",
          input: {},
          error: "permission denied",
          time: { start: now, end: now },
        })
        let attempts = 0

        const result = yield* KiloTaskRetry.recover({
          error: transient(),
          sessions,
          sessionID: kid.id,
          wait: zero,
          attempt: () =>
            Effect.sync(() => {
              attempts++
              return reply(stub({ sessionID: kid.id }), "recovered")
            }),
        })

        expect(attempts).toBe(1)
        expect(result?.parts.findLast((item) => item.type === "text")?.text).toBe("recovered")
      }),
    )

    it.instance("still retries when the child only has a pending tool part", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat } = yield* seed()
        const kid = yield* child(chat.id)
        yield* seedTool(kid.id, { status: "pending", input: {}, raw: "" })
        let attempts = 0

        const result = yield* KiloTaskRetry.recover({
          error: transient(),
          sessions,
          sessionID: kid.id,
          wait: zero,
          attempt: () =>
            Effect.sync(() => {
              attempts++
              return reply(stub({ sessionID: kid.id }), "recovered")
            }),
        })

        expect(attempts).toBe(1)
        expect(result?.parts.findLast((item) => item.type === "text")?.text).toBe("recovered")
      }),
    )

    it.instance("blocks retry when the child history lookup fails with the expected NotFoundError", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat } = yield* seed()
        const kid = yield* child(chat.id)
        const failing: Session.Interface = {
          ...sessions,
          messages: () => Effect.fail(new NotFoundError({ message: "gone" })),
        }
        let attempts = 0

        const result = yield* KiloTaskRetry.recover({
          error: transient(),
          sessions: failing,
          sessionID: kid.id,
          wait: zero,
          attempt: () =>
            Effect.sync(() => {
              attempts++
              return reply(stub({ sessionID: kid.id }), "never")
            }),
        })

        expect(attempts).toBe(0)
        expect(result).toBeUndefined()
      }),
    )

    it.instance("propagates interruption from the retry attempt without further retries", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat } = yield* seed()
        const kid = yield* child(chat.id)
        let attempts = 0

        const exit = yield* KiloTaskRetry.recover({
          error: transient(),
          sessions,
          sessionID: kid.id,
          wait: zero,
          attempt: () =>
            Effect.suspend(() => {
              attempts++
              return Effect.interrupt
            }),
        }).pipe(Effect.exit)

        expect(attempts).toBe(1)
        expect(Exit.hasInterrupts(exit)).toBe(true)
      }),
    )
  })

  describe("task tool wiring", () => {
    const context = (chat: SessionID, message: MessageID, promptOps: TaskPromptOps) => ({
      sessionID: chat,
      messageID: message,
      agent: "build",
      abort: new AbortController().signal,
      extra: { promptOps },
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    })

    it.instance(
      "retries the same child session after a transient terminal failure",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const { chat, assistant } = yield* seed()
          const tool = yield* TaskTool
          const def = yield* tool.init()
          const inputs: SessionPrompt.PromptInput[] = []
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (input) =>
              Effect.sync(() => {
                inputs.push(input)
                if (inputs.length === 1) return failed(input, transient())
                return reply(input, "recovered")
              }),
          }

          const result = yield* def.execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
            },
            context(chat.id, assistant.id, promptOps),
          )

          expect(inputs).toHaveLength(2)
          expect(inputs[0]?.sessionID).toBe(inputs[1]?.sessionID)
          expect(inputs[0]?.messageID).not.toBe(inputs[1]?.messageID)
          const kids = yield* sessions.children(chat.id)
          expect(kids).toHaveLength(1)
          expect(inputs[1]?.sessionID).toBe(kids[0]?.id)
          expect(result.output).toContain("recovered")
          expect(result.output).toContain(`state="completed"`)
        }),
      15_000,
    )

    it.instance(
      "exhausts transient retries after the initial attempt plus 2 retries and surfaces the resume hint",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const { chat, assistant } = yield* seed()
          const tool = yield* TaskTool
          const def = yield* tool.init()
          let attempts = 0
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (input) =>
              Effect.sync(() => {
                attempts++
                return failed(input, transient())
              }),
          }

          const exit = yield* def
            .execute(
              {
                description: "inspect bug",
                prompt: "look into the cache key path",
                subagent_type: "general",
              },
              context(chat.id, assistant.id, promptOps),
            )
            .pipe(Effect.exit)

          expect(attempts).toBe(1 + KiloTaskRetry.MAX)
          expect(attempts).toBe(3)
          expect(Exit.isFailure(exit)).toBe(true)
          const kids = yield* sessions.children(chat.id)
          expect(kids).toHaveLength(1)
          const squashed = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
          const message = squashed instanceof Error ? squashed.message : String(squashed)
          expect(message).toContain(`task_id="${kids[0]?.id}"`)
          expect(message).toContain("can be resumed")
        }),
      30_000,
    )

    it.instance("surfaces permanent child errors immediately with the resume hint", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let attempts = 0
        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.sync(() => {
              attempts++
              return failed(input, auth())
            }),
        }

        const exit = yield* def
          .execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
            },
            context(chat.id, assistant.id, promptOps),
          )
          .pipe(Effect.exit)

        expect(attempts).toBe(1)
        expect(Exit.isFailure(exit)).toBe(true)
        const kids = yield* sessions.children(chat.id)
        const squashed = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        const message = squashed instanceof Error ? squashed.message : String(squashed)
        expect(message).toContain(`task_id="${kids[0]?.id}"`)
        expect(message).toContain("can be resumed")
      }),
    )

    it.instance("does not retry a resumed child whose history has committed tool side effects", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const kid = yield* sessions.create({ parentID: chat.id, title: "resumable" })
        const now = Date.now()
        yield* seedTool(kid.id, {
          status: "completed",
          input: {},
          output: "ok",
          title: "bash",
          metadata: {},
          time: { start: now, end: now },
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let attempts = 0
        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.sync(() => {
              attempts++
              return failed(input, transient())
            }),
        }

        const exit = yield* def
          .execute(
            {
              description: "continue work",
              prompt: "continue",
              subagent_type: "general",
              task_id: kid.id,
            },
            context(chat.id, assistant.id, promptOps),
          )
          .pipe(Effect.exit)

        expect(attempts).toBe(1)
        expect(Exit.isFailure(exit)).toBe(true)
        const squashed = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        const message = squashed instanceof Error ? squashed.message : String(squashed)
        expect(message).toContain(`task_id="${kid.id}"`)
      }),
    )
  })
})
