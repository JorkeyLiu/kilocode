import { NodeFileSystem } from "@effect/platform-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Effect, Exit, Fiber, Layer, Stream } from "effect"
import { eq, asc } from "drizzle-orm"
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
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { KiloSessionOverflow } from "@/kilocode/session/overflow"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirServer, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import * as Ownership from "@/retention/ownership"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Admission } from "../../../llm/src/route/admission"
import { ProviderError } from "../../src/provider/error"

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

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
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
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(deps),
  ),
)

const preflightLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () => Stream.fail(new KiloSessionOverflow.PreflightError()),
  }),
)
const preflightEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
  Layer.provide(preflightLLM),
  Layer.provideMerge(deps),
)
const itPreflight = testEffect(preflightEnv)

const incompleteEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: false })),
  Layer.provideMerge(deps),
)
const itIncomplete = testEffect(Layer.mergeAll(TestLLMServer.layer, incompleteEnv))

const validationLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () => Stream.fail(new Error("body validation failed: invalid request")),
  }),
)
const validationEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: false })),
  Layer.provide(validationLLM),
  Layer.provideMerge(deps),
)
const itValidation = testEffect(validationEnv)

const admittedThenPreflightLLM = (() => {
  let calls = 0
  return Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      stream: () => {
        calls += 1
        if (calls === 1)
          return Stream.fromEffect(Admission.consume()).pipe(
            Stream.flatMap(() => Stream.fail(new ProviderError.ResponseStreamError("admitted attempt failed"))),
          )
        return Stream.fail(new KiloSessionOverflow.PreflightError())
      },
    }),
  )
})()
const admittedThenPreflightEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: false })),
  Layer.provide(admittedThenPreflightLLM),
  Layer.provideMerge(deps),
)
const itAdmittedThenPreflight = testEffect(admittedThenPreflightEnv)

const it = testEffect(env)

const nativeRef = {
  providerID: ProviderV2.ID.make("openai"),
  modelID: ModelV2.ID.make("test-model"),
}

function nativeProviderCfg(url: string) {
  return {
    provider: {
      openai: {
        name: "OpenAI",
        id: "openai",
        env: [],
        npm: "@ai-sdk/openai-compatible" as const,
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
          baseURL: url,
        },
      },
    },
  }
}

const nativeEnv = Layer.mergeAll(
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: false, experimentalNativeLlm: true })),
    Layer.provideMerge(deps),
  ),
)
const itNative = testEffect(nativeEnv)

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
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

function toSessionId(value: string): SessionSchema.ID {
  return SessionSchema.ID.make(value)
}

it.live("provider operation succeeds with revision and payload-free feed", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const database = yield* Database.Service
        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const beforeRev = yield* database.db
          .select({ rev: SessionTable.revision })
          .from(SessionTable)
          .where(eq(SessionTable.id, chat.id))
          .get()
          .pipe(Effect.orDie)
        const beforeFeed = yield* database.db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, chat.id)).all().pipe(Effect.orDie)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })
        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })
        expect(value).toBe("continue")
        // exactly one callback/admission before the single concrete provider invocation
        expect(yield* llm.calls).toBe(1)
        const opId = SessionOperation.providerId(msg.id, 0)
        const rec = yield* SessionOperation.get(database.db, opId)
        expect(rec).toBeDefined()
        expect(rec!.outcome).toBe("succeeded")
        expect(rec!.opKind).toBe("provider")
        expect(rec!.code.length).toBeGreaterThan(0)
        expect(rec!.message.length).toBeGreaterThan(0)
        expect(rec!.time).toBeGreaterThan(0)
        const afterRev = yield* database.db
          .select({ rev: SessionTable.revision })
          .from(SessionTable)
          .where(eq(SessionTable.id, chat.id))
          .get()
          .pipe(Effect.orDie)
        expect(afterRev!.rev).toBeGreaterThanOrEqual((beforeRev!.rev ?? 0) + 2)
        const afterFeed = yield* database.db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, chat.id)).orderBy(asc(SessionChangefeedTable.seq)).all().pipe(Effect.orDie)
        expect(afterFeed.length).toBeGreaterThanOrEqual(beforeFeed.length + 2)
        for (const row of afterFeed.slice(beforeFeed.length)) {
          expect(row.kind).toBe("changed")
          expect(row.session_id).toBe(chat.id)
          const keys = Object.keys(row).sort()
          expect(keys).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
          expect(typeof row.time).toBe("number")
          expect(typeof row.revision).toBe("number")
        }
        const opRow = yield* database.db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, opId)).get().pipe(Effect.orDie)
        expect(opRow).toBeDefined()
        expect(afterFeed.some((r) => r.revision === opRow!.revision)).toBe(true)
        const newRevisions = afterFeed.slice(beforeFeed.length).map((r) => r.revision)
        for (let i = 1; i < newRevisions.length; i++) expect(newRevisions[i]!).toBeGreaterThan(newRevisions[i - 1]!)
        // idempotent duplicate terminal write is no-op (no revision bump, no feed)
        if (!rec) return yield* Effect.fail(new Error("missing succeeded record"))
        const dup = yield* SessionOperation.put(database.db, toSessionId(chat.id), rec)
        expect(dup).toEqual(rec)
        const afterDupRev = yield* database.db
          .select({ rev: SessionTable.revision })
          .from(SessionTable)
          .where(eq(SessionTable.id, chat.id))
          .get()
          .pipe(Effect.orDie)
        expect(afterDupRev!.rev).toBe(afterRev!.rev)
        const afterDupFeed = yield* database.db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, chat.id)).all().pipe(Effect.orDie)
        expect(afterDupFeed.length).toBe(afterFeed.length)
        // exactly one provider operation equals exactly one concrete invocation
        const listed = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(listed.length).toBe(1)
        expect(listed.length).toBe(yield* llm.calls)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("provider operation fails with redacted and capped error", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const database = yield* Database.Service
        const secret = "apiKey=sk-secret123"
        const longMsg = "x".repeat(600) + " token=leak123"
        yield* llm.error(400, { error: { message: `${secret} ${longMsg}` } })
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const beforeRev = yield* database.db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, chat.id)).get().pipe(Effect.orDie)
        const beforeFeed = yield* database.db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, chat.id)).all().pipe(Effect.orDie)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })
        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })
        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        const opId = SessionOperation.providerId(msg.id, 0)
        const rec = yield* SessionOperation.get(database.db, opId)
        expect(rec).toBeDefined()
        expect(rec!.outcome).toBe("failed")
        expect(rec!.code.length).toBeGreaterThan(0)
        expect(rec!.message).not.toContain("sk-secret123")
        expect(rec!.message).not.toContain("leak123")
        expect(rec!.message).toContain("[redacted]")
        expect(rec!.message.length).toBeLessThanOrEqual(501)
        const afterRev = yield* database.db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, chat.id)).get().pipe(Effect.orDie)
        expect(afterRev!.rev).toBeGreaterThanOrEqual((beforeRev!.rev ?? 0) + 2)
        const afterFeed = yield* database.db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, chat.id)).all().pipe(Effect.orDie)
        expect(afterFeed.length).toBeGreaterThanOrEqual(beforeFeed.length + 2)
        for (const row of afterFeed.slice(beforeFeed.length)) {
          const keys = Object.keys(row).sort()
          expect(keys).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
        }
        const listed = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(listed.length).toBe(1)
        expect(listed.length).toBe(yield* llm.calls)
        expect(listed[0]!.opId).toBe(opId)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("provider operation abandoned on cancellation", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const database = yield* Database.Service
        yield* llm.hang
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })
        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* Fiber.interrupt(run)
        const exit = yield* Fiber.await(run)
        expect(Exit.isFailure(exit)).toBe(true)
        const opId = SessionOperation.providerId(msg.id, 0)
        const rec = yield* SessionOperation.get(database.db, opId)
        expect(rec).toBeDefined()
        expect(rec!.outcome).toBe("abandoned")
        expect(rec!.cancel).toEqual({ source: "user_stop" })
        expect(rec!.code.length).toBeGreaterThan(0)
        expect(rec!.message.length).toBeGreaterThan(0)
        expect(rec!.outcome).not.toBe("in-flight")
        const all = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(all.length).toBe(1)
        expect(yield* llm.calls).toBe(1)
        expect(all.length).toBe(yield* llm.calls)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("retry uses distinct provider op ids and no in-flight remains", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const database = yield* Database.Service
        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after retry")
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })
        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })
        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        const op0 = yield* SessionOperation.get(database.db, SessionOperation.providerId(msg.id, 0))
        const op1 = yield* SessionOperation.get(database.db, SessionOperation.providerId(msg.id, 1))
        expect(op0).toBeDefined()
        expect(op1).toBeDefined()
        expect(op0!.outcome).toBe("failed")
        expect(op1!.outcome).toBe("succeeded")
        expect(op0!.code).toBe("provider.failed")
        expect(op1!.code).toBe("provider.succeeded")
        expect(op0!.opId).not.toBe(op1!.opId)
        const all = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(all.length).toBe(2)
        expect(all.length).toBe(yield* llm.calls)
        for (const r of all) expect(r.outcome).not.toBe("in-flight")
        const rev = yield* database.db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, chat.id)).get().pipe(Effect.orDie)
        expect(rev!.rev).toBeGreaterThanOrEqual(4)
        const feed = yield* database.db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, chat.id)).all().pipe(Effect.orDie)
        expect(feed.length).toBeGreaterThanOrEqual(4)
        for (const row of feed.slice(-4)) {
          const keys = Object.keys(row).sort()
          expect(keys).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
        }
        // distinct attempt ids are exactly one per concrete invocation
        const feedForOps = yield* database.db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, toSessionId(chat.id))).all().pipe(Effect.orDie)
        expect(feedForOps.length).toBe(2)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("no operation on deleted session early return", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const database = yield* Database.Service
        yield* llm.text("hello")
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        // capture feed before deletion — strictly no operation/revision/feed mutation on deleted-session early return
        const beforeFeed = yield* database.db
          .select()
          .from(SessionChangefeedTable)
          .where(eq(SessionChangefeedTable.session_id, chat.id))
          .all()
          .pipe(Effect.orDie)
        const beforeOps = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(beforeOps.length).toBe(0)
        yield* database.db.delete(SessionTable).where(eq(SessionTable.id, chat.id)).run().pipe(Effect.orDie)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })
        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })
        expect(value).toBe("stop")
        const op0 = yield* SessionOperation.get(database.db, SessionOperation.providerId(msg.id, 0))
        expect(op0).toBeUndefined()
        const all = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(all.length).toBe(0)
        expect(beforeOps.length).toBe(0)
        expect(all.length).toBe(0)
        // strict zero-feed: no admission means no changefeed mutation
        const afterFeed = yield* database.db
          .select()
          .from(SessionChangefeedTable)
          .where(eq(SessionChangefeedTable.session_id, chat.id))
          .all()
          .pipe(Effect.orDie)
        expect(afterFeed.length).toBe(beforeFeed.length)
        for (const row of afterFeed.slice(beforeFeed.length)) {
          const keys = Object.keys(row).sort()
          expect(keys).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
        }
        expect(yield* llm.calls).toBe(0)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itIncomplete.live("incomplete-response recovery uses distinct provider attempt ids", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const database = yield* Database.Service
        yield* llm.push(reply().finish("unknown"))
        yield* llm.text("recovered")
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const beforeRev = yield* database.db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, chat.id)).get().pipe(Effect.orDie)
        const beforeFeed = yield* database.db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, chat.id)).all().pipe(Effect.orDie)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })
        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })
        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        const op0 = yield* SessionOperation.get(database.db, SessionOperation.providerId(msg.id, 0))
        const op1 = yield* SessionOperation.get(database.db, SessionOperation.providerId(msg.id, 1))
        expect(op0).toBeDefined()
        expect(op1).toBeDefined()
        expect(op0!.opId).not.toBe(op1!.opId)
        // exact terminal outcomes for recovery: first failed, second succeeded
        expect(op0!.outcome).toBe("failed")
        expect(op0!.code).toBe("provider.failed")
        expect(op1!.outcome).toBe("succeeded")
        expect(op1!.code).toBe("provider.succeeded")
        const all = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(all.length).toBe(2)
        expect(all.length).toBe(yield* llm.calls)
        for (const r of all) expect(r.outcome).not.toBe("in-flight")
        const afterFeed = yield* database.db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, chat.id)).orderBy(asc(SessionChangefeedTable.seq)).all().pipe(Effect.orDie)
        expect(afterFeed.length).toBeGreaterThanOrEqual(beforeFeed.length + 4)
        for (const row of afterFeed.slice(beforeFeed.length)) {
          const keys = Object.keys(row).sort()
          expect(keys).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
        }
        const op1Row = yield* database.db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, SessionOperation.providerId(msg.id, 1))).get().pipe(Effect.orDie)
        expect(op1Row).toBeDefined()
        expect(afterFeed.some((r) => r.revision === op1Row!.revision)).toBe(true)
        const op0Row = yield* database.db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, SessionOperation.providerId(msg.id, 0))).get().pipe(Effect.orDie)
        expect(op0Row).toBeDefined()
        expect(afterFeed.some((r) => r.revision === op0Row!.revision)).toBe(true)
        const afterRev = yield* database.db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, chat.id)).get().pipe(Effect.orDie)
        expect(afterRev!.rev).toBeGreaterThanOrEqual((beforeRev!.rev ?? 0) + 4)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itPreflight.live("preflight compaction produces no provider operation", () =>
  provideTmpdirInstance(
    (dir: string) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const database = yield* Database.Service
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const beforeOps = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(beforeOps.length).toBe(0)
        const beforeFeed = yield* database.db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, chat.id)).all().pipe(Effect.orDie)
        const beforeRev = yield* database.db
          .select({ rev: SessionTable.revision })
          .from(SessionTable)
          .where(eq(SessionTable.id, chat.id))
          .get()
          .pipe(Effect.orDie)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })
        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })
        expect(value).toBe("compact")
        const op0 = yield* SessionOperation.get(database.db, SessionOperation.providerId(msg.id, 0))
        expect(op0).toBeUndefined()
        const all = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(all.length).toBe(0)
        // strict zero-revision/zero-feed: no admission before preflight, so no revision bump and no feed
        const afterFeed = yield* database.db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, chat.id)).all().pipe(Effect.orDie)
        expect(afterFeed.length).toBe(beforeFeed.length)
        const afterRev = yield* database.db
          .select({ rev: SessionTable.revision })
          .from(SessionTable)
          .where(eq(SessionTable.id, chat.id))
          .get()
          .pipe(Effect.orDie)
        expect(afterRev!.rev).toBe(beforeRev!.rev)
        expect(beforeOps.length).toBe(0)
        expect(all.length).toBe(0)
      }),
    { config: cfg },
  ),
)

it.live("admission executes once immediately before concrete provider invocation", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const database = yield* Database.Service
        // single provider call
        yield* llm.text("one")
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const beforeOps = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(beforeOps.length).toBe(0)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })
        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })
        expect(value).toBe("continue")
        // callback ran exactly once before the single provider invocation
        expect(yield* llm.calls).toBe(1)
        const listed = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(listed.length).toBe(1)
        expect(listed.length).toBe(yield* llm.calls)
        expect(listed[0]!.outcome).toBe("succeeded")
        // second session: retry path proves exactly one callback per actual attempt
        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after retry")
        const chat2 = yield* session.create({})
        const parent2 = yield* user(chat2.id, "hi2")
        const msg2 = yield* assistant(chat2.id, parent2.id, path.resolve(dir))
        const mdl2 = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle2 = yield* processors.create({
          assistantMessage: msg2,
          sessionID: chat2.id,
          model: mdl2,
        })
        const value2 = yield* handle2.process({
          user: {
            id: parent2.id,
            sessionID: chat2.id,
            role: "user",
            time: parent2.time,
            agent: parent2.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat2.id,
          model: mdl2,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi2" }],
          tools: {},
        })
        expect(value2).toBe("continue")
        // two concrete invocations => two admissions
        const totalCalls = yield* llm.calls
        // 1 from first session + 2 from second = 3 total
        expect(totalCalls).toBe(3)
        const listed2 = yield* SessionOperation.list(database.db, toSessionId(chat2.id))
        expect(listed2.length).toBe(2)
        expect(listed2[0]!.outcome).toBe("failed")
        expect(listed2[1]!.outcome).toBe("succeeded")
        for (const r of listed2) expect(r.outcome).not.toBe("in-flight")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

const nativeAssistant = Effect.fn("TestSession.nativeAssistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
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
    modelID: nativeRef.modelID,
    providerID: nativeRef.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

itNative.live("native path provider operation succeeds with payload-free feed parity", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const database = yield* Database.Service
        yield* llm.text("hello native")
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* nativeAssistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(nativeRef.providerID, nativeRef.modelID)
        const beforeRev = yield* database.db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, chat.id)).get().pipe(Effect.orDie)
        const beforeFeed = yield* database.db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, chat.id)).all().pipe(Effect.orDie)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const typed: SessionV1.User = {
          id: parent.id,
          sessionID: chat.id,
          role: "user",
          time: parent.time,
          agent: parent.agent,
          model: { providerID: nativeRef.providerID, modelID: nativeRef.modelID },
        }
        const value = yield* handle.process({
          user: typed,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi native" }],
          tools: {},
        })
        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        const opId = SessionOperation.providerId(msg.id, 0)
        const rec = yield* SessionOperation.get(database.db, opId)
        expect(rec).toBeDefined()
        expect(rec!.outcome).toBe("succeeded")
        expect(rec!.opKind).toBe("provider")
        const afterRev = yield* database.db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, chat.id)).get().pipe(Effect.orDie)
        expect(afterRev!.rev).toBeGreaterThanOrEqual((beforeRev!.rev ?? 0) + 2)
        const afterFeed = yield* database.db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, chat.id)).orderBy(asc(SessionChangefeedTable.seq)).all().pipe(Effect.orDie)
        expect(afterFeed.length).toBeGreaterThanOrEqual(beforeFeed.length + 2)
        for (const row of afterFeed.slice(beforeFeed.length)) {
          expect(row.kind).toBe("changed")
          const keys = Object.keys(row).sort()
          expect(keys).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
        }
        const opRow = yield* database.db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, opId)).get().pipe(Effect.orDie)
        expect(opRow).toBeDefined()
        expect(afterFeed.some((r) => r.revision === opRow!.revision)).toBe(true)
        const listed: SessionOperation.FailureRecord[] = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(listed.length).toBe(1)
        expect(listed.length).toBe(yield* llm.calls)
      }),
    { config: (url) => nativeProviderCfg(url) },
  ),
)

itNative.live("native path retry uses distinct ops at final seam", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const database = yield* Database.Service
        // 429 is retryable by both inner RequestExecutor and outer SessionRetry.
        // Outer retry creates 2 distinct operations; inner retry adds extra http hits without extra ops.
        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after native retry")
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* nativeAssistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(nativeRef.providerID, nativeRef.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const typed: SessionV1.User = {
          id: parent.id,
          sessionID: chat.id,
          role: "user",
          time: parent.time,
          agent: parent.agent,
          model: { providerID: nativeRef.providerID, modelID: nativeRef.modelID },
        }
        const value = yield* handle.process({
          user: typed,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })
        expect(value).toBe("continue")
        const calls = yield* llm.calls
        expect(calls).toBeGreaterThanOrEqual(2)
        const listed: SessionOperation.FailureRecord[] = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(listed.length).toBe(2)
        expect(listed.length).toBeLessThanOrEqual(calls)
        for (const r of listed) expect(r.outcome).not.toBe("in-flight")
        expect(listed[0]!.outcome).toBe("failed")
        expect(listed[0]!.code).toBe("provider.failed")
        expect(listed[1]!.outcome).toBe("succeeded")
        expect(listed[1]!.code).toBe("provider.succeeded")
        expect(listed[0]!.opId).not.toBe(listed[1]!.opId)
        expect(listed[0]!.opId).toBe(SessionOperation.providerId(msg.id, 0))
        expect(listed[1]!.opId).toBe(SessionOperation.providerId(msg.id, 1))
      }),
    { config: (url) => nativeProviderCfg(url) },
  ),
)

itNative.live("native path incomplete recovery distinct terminal outcomes", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const database = yield* Database.Service
        yield* llm.push(reply().finish("unknown"))
        yield* llm.text("recovered native")
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* nativeAssistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(nativeRef.providerID, nativeRef.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const typed: SessionV1.User = {
          id: parent.id,
          sessionID: chat.id,
          role: "user",
          time: parent.time,
          agent: parent.agent,
          model: { providerID: nativeRef.providerID, modelID: nativeRef.modelID },
        }
        const value = yield* handle.process({
          user: typed,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })
        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        const op0 = yield* SessionOperation.get(database.db, SessionOperation.providerId(msg.id, 0))
        const op1 = yield* SessionOperation.get(database.db, SessionOperation.providerId(msg.id, 1))
        expect(op0).toBeDefined()
        expect(op1).toBeDefined()
        expect(op0!.outcome).toBe("failed")
        expect(op0!.code).toBe("provider.failed")
        expect(op1!.outcome).toBe("succeeded")
        expect(op1!.code).toBe("provider.succeeded")
        const listed: SessionOperation.FailureRecord[] = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(listed.length).toBe(2)
        for (const r of listed) expect(r.outcome).not.toBe("in-flight")
      }),
    { config: (url) => nativeProviderCfg(url) },
  ),
)

itValidation.live("setup validation failure produces no session mutation after snapshot opportunity", () =>
  provideTmpdirInstance(
    (dir: string) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const database = yield* Database.Service
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const beforeAssistant = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const beforeOps = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(beforeOps.length).toBe(0)
        const beforeFeed = yield* database.db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, chat.id)).all().pipe(Effect.orDie)
        const beforeRev = yield* database.db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, chat.id)).get().pipe(Effect.orDie)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        yield* Effect.promise(() => Bun.write(path.join(dir, "pre-admission.txt"), "workspace mutation"))
        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })
        expect(value).toBe("stop")
        const op0 = yield* SessionOperation.get(database.db, SessionOperation.providerId(msg.id, 0))
        expect(op0).toBeUndefined()
        const all = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(all.length).toBe(0)
        const afterFeed = yield* database.db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, chat.id)).all().pipe(Effect.orDie)
        expect(afterFeed.length).toBe(beforeFeed.length)
        for (const row of afterFeed.slice(beforeFeed.length)) {
          const keys = Object.keys(row).sort()
          expect(keys).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
        }
        const afterRev = yield* database.db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, chat.id)).get().pipe(Effect.orDie)
        expect(afterRev!.rev).toBe(beforeRev!.rev)
        const afterAssistant = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        expect(afterAssistant).toEqual(beforeAssistant)
      }),
    { config: cfg, git: true },
  ),
)

itAdmittedThenPreflight.live("admitted attempt keeps cleanup obligation across non-admitted retry", () =>
  provideTmpdirInstance(
    (dir: string) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service
        const database = yield* Database.Service
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        yield* Effect.promise(() => Bun.write(path.join(dir, "admitted-before-retry.txt"), "workspace mutation"))
        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })
        expect(value).toBe("compact")
        const operations = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(operations.length).toBe(1)
        expect(operations[0]!.outcome).toBe("failed")
        const parts = yield* MessageV2.parts(msg.id)
        expect(parts.some((part) => part.type === "patch" && part.files.some((file) => file.endsWith("admitted-before-retry.txt")))).toBe(true)
        const after = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        expect("completed" in after.info.time).toBe(true)
      }),
    { config: cfg, git: true },
  ),
  { timeout: 20_000 },
)

it.live("inner AI SDK retry memoization — one outer attempt stays one operation despite inner retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const database = yield* Database.Service
        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after inner retry")
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const beforeFeed = yield* database.db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, chat.id)).all().pipe(Effect.orDie)
        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
          retries: 1,
        })
        expect(value).toBe("continue")
        const calls = yield* llm.calls
        expect(calls).toBe(2)
        const listed = yield* SessionOperation.list(database.db, toSessionId(chat.id))
        expect(listed.length).toBe(1)
        expect(listed[0]!.opId).toBe(SessionOperation.providerId(msg.id, 0))
        expect(listed[0]!.outcome).toBe("succeeded")
        expect(listed[0]!.code).toBe("provider.succeeded")
        for (const r of listed) expect(r.outcome).not.toBe("in-flight")
        const afterFeed = yield* database.db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, chat.id)).all().pipe(Effect.orDie)
        expect(afterFeed.length).toBeGreaterThanOrEqual(beforeFeed.length + 2)
        for (const row of afterFeed.slice(beforeFeed.length)) {
          const keys = Object.keys(row).sort()
          expect(keys).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
        }
        const opRow = yield* database.db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, SessionOperation.providerId(msg.id, 0))).get().pipe(Effect.orDie)
        expect(opRow).toBeDefined()
        expect(afterFeed.some((r) => r.revision === opRow!.revision)).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)
