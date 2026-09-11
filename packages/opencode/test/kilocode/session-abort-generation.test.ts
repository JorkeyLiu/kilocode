import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionCompaction } from "@/session/compaction"
import { SessionProcessor } from "@/session/processor"
import { SessionSummary } from "@/session/summary"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Bus } from "@/bus"
import { KiloSessionEvent } from "@/kilocode/session/event"
import { KiloSessionPromptQueue } from "@/kilocode/session/prompt-queue"
import { KiloSessionPrompt } from "@/kilocode/session/prompt"
import { KiloSessionProcessor } from "@/kilocode/session/processor"
import { KiloSession } from "@/kilocode/session"
import { BackgroundJob } from "@/background/job"
import { SessionRevert } from "@/session/revert"
import { Instruction } from "@/session/instruction"
import { SystemPrompt } from "@/session/system"
import { LLM } from "@/session/llm"
import { Agent as AgentSvc } from "@/agent/agent"
import { Config } from "@/config/config"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Question } from "@/question"
import { Image } from "@/image/image"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Command } from "@/command"
import { Env } from "@/env"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Reference } from "@/reference/reference"
import { RepositoryCache } from "@/reference/repository-cache"
import { Ripgrep } from "@opencode-ai/core/filesystem/ripgrep"
import { Format } from "@/format"
import { Skill } from "@/skill"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { FetchHttpClient } from "effect/unstable/http"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import * as Ownership from "@/retention/ownership"
import { Todo } from "@/session/todo"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { provideTmpdirServer, testInstanceStoreLayer } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { JournalMemory } from "../fixture/journal" // kilocode_change - file tools require canonical journal
import { reply, TestLLMServer } from "../lib/llm-server"
import * as Log from "@opencode-ai/core/util/log"
import { Auth } from "@/auth"
import { Server } from "@/server/server"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
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

const status = Layer.mergeAll(JournalMemory, Ownership.layer, SessionStatus.defaultLayer, Bus.layer)
const runLayer = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const flags = RuntimeFlags.layer({ experimentalBackgroundSubagents: true })

function makeHttp() {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    BackgroundJob.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    flags,
    ProviderSvc.defaultLayer,
    lsp,
    MCP.defaultLayer,
    Skill.defaultLayer,
    Git.defaultLayer,
    FSUtil.defaultLayer,
    Reference.defaultLayer,
    EventV2Bridge.defaultLayer,
    Database.defaultLayer,
    status,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(RepositoryCache.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(Command.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(flags),
    Layer.provideMerge(deps),
  )
  const compact = SessionCompaction.layer.pipe(Layer.provide(flags), Layer.provideMerge(proc), Layer.provideMerge(deps))
  return Layer.mergeAll(
    TestLLMServer.layer,
    testInstanceStoreLayer,
    SessionPrompt.layer.pipe(
      Layer.provideMerge(SessionRevert.defaultLayer),
      Layer.provideMerge(GenerationGate.defaultLayer),
      Layer.provide(Image.defaultLayer),
      Layer.provide(summary),
      Layer.provide(Reference.defaultLayer),
      Layer.provideMerge(runLayer),
      Layer.provideMerge(compact),
      Layer.provideMerge(proc),
      Layer.provideMerge(registry),
      Layer.provideMerge(trunc),
      Layer.provideMerge(question),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(SystemPrompt.defaultLayer),
      Layer.provide(flags),
      Layer.provideMerge(deps),
    ),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        summary,
        deps,
        Config.defaultLayer,
        flags,
        BackgroundJob.defaultLayer,
        Bus.layer,
        infra,
        Storage.defaultLayer,
        Reference.defaultLayer,
      ),
    ),
  )
}

const it = testEffect(makeHttp())

function cfg(url: string) {
  return {
    agent: {
      build: { model: "test/test-model", description: "test agent" },
    },
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
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
}

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

describe("session abort generation prerequisite", () => {
  it.live("generation is shared within epoch and changes after idle", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service

        const s = yield* sessions.create({ title: "gen-share" })

        const dummy = {
          info: {
            id: "dummy",
            role: "assistant",
            sessionID: s.id,
            parentID: "dummy-parent",
            mode: "build",
            agent: "build",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            time: { created: Date.now() },
            path: { cwd: "/tmp", root: "/tmp" },
          },
          parts: [],
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.WithParts
        const fiber = yield* run.ensureRunning(s.id, Effect.succeed(dummy), Effect.never).pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const g = yield* run.activeGeneration(s.id)
            return g ? (true as const) : undefined
          }),
          "generation never minted",
        )

        const gen1 = yield* run.activeGeneration(s.id)
        expect(gen1).toBeDefined()
        expect(gen1!.startsWith("gen_")).toBeTrue()

        const genJoin = yield* run.activeGeneration(s.id)
        expect(genJoin).toBe(gen1)

        const activeConcurrent = yield* Effect.all(
          [run.activeGeneration(s.id), run.activeGeneration(s.id)],
          { concurrency: 2 },
        )
        expect(activeConcurrent[0]).toBe(gen1!)
        expect(activeConcurrent[1]).toBe(gen1!)

        const cancelRes = yield* KiloSessionPrompt.cancelTree({ sessionID: s.id, sessions, cancel: run.cancel })
        expect(cancelRes.generations.find((g) => g.sessionID === s.id)?.generationID).toBe(gen1)
        expect(cancelRes.generations.find((g) => g.sessionID === s.id)?.wasBusy).toBeTrue()

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const st = yield* (yield* SessionStatus.Service).get(s.id)
            const g = yield* run.activeGeneration(s.id)
            return st.type === "idle" && !g ? (true as const) : undefined
          }),
          "session never returned to idle after cancel",
        )

        const fiber2 = yield* run.ensureRunning(s.id, Effect.succeed(dummy), Effect.never).pipe(Effect.forkChild)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const g = yield* run.activeGeneration(s.id)
            return g && g !== gen1 ? (true as const) : undefined
          }),
          "new generation not minted or not changed",
        )
        const genNew = yield* run.activeGeneration(s.id)
        expect(genNew).toBeDefined()
        expect(genNew).not.toBe(gen1)

        yield* prompt.cancel(s.id).pipe(Effect.ignore)
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
        yield* Fiber.interrupt(fiber2).pipe(Effect.ignore)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const st = yield* (yield* SessionStatus.Service).get(s.id)
            return st.type === "idle" ? (true as const) : undefined
          }),
          "cleanup idle",
        )
      }),
      { git: true, config: cfg },
    ),
  )

  it.live("turn open/close share generation and interrupted close is attributable", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service

        const s = yield* sessions.create({ title: "turn-gen" })
        const seedUser = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: s.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.User)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: seedUser.id,
          sessionID: s.id,
          type: "text",
          text: "seed",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.TextPart)
        const seedAssistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: seedUser.id,
          sessionID: s.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
          finish: "stop",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.Assistant)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: seedAssistant.id,
          sessionID: s.id,
          type: "text",
          text: "seed assistant",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.TextPart)
        const uTurn = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: s.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.User)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: uTurn.id,
          sessionID: s.id,
          type: "text",
          text: "hello turn",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.TextPart)

        const run = yield* SessionRunState.Service
        const openDeferred = yield* Deferred.make<string | undefined>()
        const closeDeferred = yield* Deferred.make<{ generationID?: string; reason: string }>()
        const unsubOpen = Bus.subscribe(KiloSessionEvent.TurnOpen, (event) => {
          if (event.properties.sessionID === s.id) {
            Effect.runFork(Deferred.succeed(openDeferred, event.properties.generationID))
          }
        })
        const unsubClose = Bus.subscribe(KiloSessionEvent.TurnClose, (event) => {
          if (event.properties.sessionID === s.id) {
            Effect.runFork(Deferred.succeed(closeDeferred, { generationID: event.properties.generationID, reason: event.properties.reason }))
          }
        })
        // Ensure Bus subscriptions are fully registered before generation lifecycle starts
        yield* Effect.yieldNow

        try {
          yield* llm.hang
          const fiber = yield* Effect.forkChild(prompt.loop({ sessionID: s.id }))

          yield* pollWithTimeout(
            Effect.gen(function* () {
              const g = yield* run.activeGeneration(s.id)
              const done = yield* Deferred.isDone(openDeferred)
              return g && done ? (true as const) : undefined
            }),
            "generation never minted before open",
          )

          const openGen = yield* Deferred.await(openDeferred).pipe(Effect.timeout("10 seconds"))
          expect(openGen).toBeDefined()
          expect(openGen!.startsWith("gen_")).toBeTrue()

          const activeGen = yield* run.activeGeneration(s.id)
          expect(activeGen).toBe(openGen!)

          const cancelRes = yield* KiloSessionPrompt.cancelTree({ sessionID: s.id, sessions, cancel: run.cancel })
          expect(cancelRes.generations[0].generationID).toBe(openGen)
          expect(cancelRes.generations[0].wasBusy).toBeTrue()
          expect(cancelRes.generations[0].interruptRequested).toBeTrue()

          const close = yield* Deferred.await(closeDeferred).pipe(Effect.timeout("5 seconds"))
          expect(close.generationID).toBe(openGen)
          expect(close.reason).toBe("interrupted")

          yield* pollWithTimeout(
            Effect.gen(function* () {
              const st = yield* (yield* SessionStatus.Service).get(s.id)
              const closed = yield* Deferred.isDone(closeDeferred)
              return st.type === "idle" && closed ? (true as const) : undefined
            }),
            "turn close never published",
          )

          yield* Fiber.join(fiber).pipe(Effect.catch(() => Effect.void))
        } finally {
          unsubOpen()
          unsubClose()
        }
      }),
      { git: true, config: cfg },
    ),
    { timeout: 30_000 },
  )

  it.live("cancelTree reports root+descendants and honest queue/intake/background fields", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm, dir }) {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const jobs = yield* BackgroundJob.Service

        const root = yield* sessions.create({ title: "root" })
        const child = yield* sessions.create({ parentID: root.id } as unknown as Parameters<typeof sessions.create>[0])
        const grand = yield* sessions.create({ parentID: child.id } as unknown as Parameters<typeof sessions.create>[0])

        const kids = yield* sessions.children(root.id)
        expect(kids.map((k) => k.id)).toContain(child.id)

        const uRoot = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: root.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.User)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: uRoot.id,
          sessionID: root.id,
          type: "text",
          text: "hello root",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.TextPart)

        yield* llm.hang
        const fiber = yield* Effect.forkChild(prompt.loop({ sessionID: root.id }))
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const g = yield* run.activeGeneration(root.id)
            return g ? (true as const) : undefined
          }),
          "root never busy",
        )

        const hangTarget = MessageID.ascending()
        const hangDeferred = yield* Deferred.make<void>()
        const hangFiber = yield* Effect.forkChild(
          KiloSessionPromptQueue.enqueue(root.id, hangTarget, Deferred.await(hangDeferred), Effect.void),
        )
        // hangTarget becomes the running slot (pending removed on start), so it is not counted as waiting
        const waitingTarget = MessageID.ascending()
        const waitFiber = yield* Effect.forkChild(KiloSessionPromptQueue.enqueue(root.id, waitingTarget, Effect.void, Effect.void))
        yield* pollWithTimeout(
          Effect.gen(function* () {
            return KiloSessionPromptQueue.waitingCount(root.id) >= 1 ? (true as const) : undefined
          }),
          "waiting target never queued",
        )

        const intakeReady = yield* Deferred.make<void>()
        const intakeDeferred = yield* Deferred.make<void>()
        const intakeFiber = yield* Effect.forkChild(
          KiloSessionPrompt.intake(
            root.id,
            Effect.gen(function* () {
              yield* Deferred.succeed(intakeReady, undefined)
              yield* Deferred.await(intakeDeferred)
            }),
          ),
        )
        yield* Deferred.await(intakeReady).pipe(Effect.timeout("5 seconds"))

        const runningJob = yield* jobs.start({
          type: "test",
          run: Effect.never,
          metadata: { sessionId: root.id },
        })
        expect(runningJob.status).toBe("running")

        const completedJob = yield* jobs.start({
          type: "test",
          run: Effect.succeed("done"),
          metadata: { sessionId: root.id },
        })
        yield* jobs.wait({ id: completedJob.id })
        const completedInfo = yield* jobs.get(completedJob.id)
        expect(completedInfo?.status).toBe("completed")

        const res = yield* KiloSessionPrompt.cancelTree({ sessionID: root.id, sessions, cancel: run.cancel })

        expect(res.targetSessionIDs[0]).toBe(root.id)
        expect(res.targetSessionIDs).toContain(child.id)
        expect(res.targetSessionIDs).toContain(grand.id)
        expect(res.generations.map((g) => g.sessionID)).toEqual([...res.targetSessionIDs])
        expect(res.queue.perTarget.map((p) => p.sessionID)).toEqual([...res.targetSessionIDs])
        expect(res.intake.perTarget.map((p) => p.sessionID)).toEqual([...res.targetSessionIDs])
        expect(res.planFollowup.perTarget.map((p) => p.sessionID)).toEqual([...res.targetSessionIDs])

        const rootGen = res.generations.find((g) => g.sessionID === root.id)
        expect(rootGen?.generationID).toBeDefined()
        expect(rootGen?.wasBusy).toBeTrue()
        expect(rootGen?.interruptRequested).toBeTrue()
        const childGen = res.generations.find((g) => g.sessionID === child.id)
        expect(childGen?.wasBusy).toBeFalse()

        expect(res.queue.cancelSignalledCount).toBeGreaterThanOrEqual(1)
        expect(res.queue.waitingCount).toBeGreaterThanOrEqual(1)
        expect(res.queue.perTarget.find((p) => p.sessionID === root.id)?.waitingCount).toBeGreaterThanOrEqual(1)
        expect((res.queue as unknown as { succeeded: unknown }).succeeded).toBeUndefined()
        expect((res.queue as unknown as { not_affected: unknown }).not_affected).toBeUndefined()

        expect(res.intake.interruptRequestedCount).toBeGreaterThanOrEqual(1)
        expect(res.intake.perTarget.find((p) => p.sessionID === root.id)?.interruptRequestedCount).toBeGreaterThanOrEqual(1)

        expect((res.planFollowup as unknown as { succeeded: unknown }).succeeded).toBeUndefined()
        expect(typeof res.planFollowup.abortSignalledCount).toBe("number")

        // No invented background collection: result carries only observed facts.
        expect("background" in res).toBe(false)

        // Verify deterministic order is preserved on second call as well
        const secondRes = yield* KiloSessionPrompt.cancelTree({ sessionID: root.id, sessions, cancel: run.cancel })
        expect(secondRes.generations.map((g) => g.sessionID)).toEqual([...secondRes.targetSessionIDs])

        yield* Deferred.succeed(hangDeferred, undefined).pipe(Effect.ignore)
        yield* Deferred.succeed(intakeDeferred, undefined).pipe(Effect.ignore)
        yield* Fiber.interrupt(hangFiber).pipe(Effect.ignore)
        yield* Fiber.interrupt(waitFiber).pipe(Effect.ignore)
        yield* Fiber.interrupt(intakeFiber).pipe(Effect.ignore)
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
        const after = yield* jobs.get(runningJob.id).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (after) expect(after.status).not.toBe("running")
        void dir
      }),
      { git: true, config: cfg },
    ),
    { timeout: 30_000 },
  )

  it.live("HTTP abort still returns boolean true", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm, dir }) {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const s = yield* sessions.create({ title: "http-abort" })
        const uHttp = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: s.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.User)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: uHttp.id,
          sessionID: s.id,
          type: "text",
          text: "hello http",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.TextPart)
        yield* llm.hang
        const fiber = yield* Effect.forkChild(prompt.loop({ sessionID: s.id }))
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const run = yield* SessionRunState.Service
            const g = yield* run.activeGeneration(s.id)
            return g ? (true as const) : undefined
          }),
          "not busy",
        )
        const response = yield* Effect.promise(() =>
          Promise.resolve(Server.Default().app.request(`/session/${s.id}/abort?directory=${encodeURIComponent(dir)}`, { method: "POST" })),
        )
        expect(response.status).toBe(200)
        const body = yield* Effect.promise(() => response.json() as Promise<boolean>)
        expect(body).toBe(true)
        const res = yield* prompt.cancel(s.id).pipe(Effect.orElseSucceed(() => undefined))
        void res
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const st = yield* (yield* SessionStatus.Service).get(s.id)
            return st.type === "idle" ? (true as const) : undefined
          }),
          "cleanup idle after http abort",
        )
      }),
      { git: true, config: cfg },
    ),
    { timeout: 15_000 },
  )
it.live("cancelTree target ordering is deterministic and per-target arrays align", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const sessions = yield* Session.Service
        const run = yield* SessionRunState.Service
        const root = yield* sessions.create({ title: "order-root" })
        // Create children in reverse lexicographic order; cancelTree should sort siblings by ID
        const childB = yield* sessions.create({ parentID: root.id } as unknown as Parameters<typeof sessions.create>[0])
        const childA = yield* sessions.create({ parentID: root.id } as unknown as Parameters<typeof sessions.create>[0])
        const grandB1 = yield* sessions.create({ parentID: childB.id } as unknown as Parameters<typeof sessions.create>[0])
        const grandA1 = yield* sessions.create({ parentID: childA.id } as unknown as Parameters<typeof sessions.create>[0])
        const ids = [childB.id, childA.id, grandB1.id, grandA1.id]
        // Ensure IDs are distinct
        expect(new Set(ids).size).toBe(4)

        const res = yield* KiloSessionPrompt.cancelTree({ sessionID: root.id, sessions, cancel: run.cancel })
        // Root first
        expect(res.targetSessionIDs[0]).toBe(root.id)
        // All descendants present
        for (const id of ids) expect(res.targetSessionIDs).toContain(id)
        // Deterministic: sorted siblings at each level -> children of root sorted, then their children sorted
        const sortedChildren = [childA.id, childB.id].sort((a, b) => a.localeCompare(b))
        // Since DFS: root, sortedChildren[0] + its descendants sorted, sortedChildren[1] + its descendants sorted
        const expectedOrder = [root.id, sortedChildren[0], sortedChildren[1]] as string[]
        // Check that child order respects sort (allow grands interleaving but children themselves sorted)
        const childIndices = sortedChildren.map((id) => res.targetSessionIDs.indexOf(id))
        expect(childIndices[0] < childIndices[1]).toBeTrue()
        // All per-target arrays must align with targetSessionIDs exactly
        expect(res.generations.map((g) => g.sessionID)).toEqual([...res.targetSessionIDs])
        expect(res.queue.perTarget.map((p) => p.sessionID)).toEqual([...res.targetSessionIDs])
        expect(res.intake.perTarget.map((p) => p.sessionID)).toEqual([...res.targetSessionIDs])
        expect(res.planFollowup.perTarget.map((p) => p.sessionID)).toEqual([...res.targetSessionIDs])
        expect("background" in res).toBe(false)

        const res2 = yield* KiloSessionPrompt.cancelTree({ sessionID: root.id, sessions, cancel: run.cancel })
        expect(res2.targetSessionIDs).toEqual([...res.targetSessionIDs])
        expect(res2.generations.map((g) => g.sessionID)).toEqual([...res2.targetSessionIDs])
      }),
      { git: true, config: cfg },
    ),
    { timeout: 15_000 },
  )

  it.live("cancel-before-first-op produces paired interrupted open/close with same generation", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const s = yield* sessions.create({ title: "cancel-before-op" })
        const seedUser = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: s.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.User)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: seedUser.id,
          sessionID: s.id,
          type: "text",
          text: "seed",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.TextPart)
        const seedAssistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: seedUser.id,
          sessionID: s.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
          finish: "stop",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.Assistant)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: seedAssistant.id,
          sessionID: s.id,
          type: "text",
          text: "seed assistant",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.TextPart)
        const uTurn = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: s.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.User)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: uTurn.id,
          sessionID: s.id,
          type: "text",
          text: "hello before-first-op",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.TextPart)

        const run = yield* SessionRunState.Service
        const openDeferred = yield* Deferred.make<string | undefined>()
        const closeDeferred = yield* Deferred.make<{ generationID?: string; reason: string }>()
        const unsubOpen = Bus.subscribe(KiloSessionEvent.TurnOpen, (event) => {
          if (event.properties.sessionID === s.id) Effect.runFork(Deferred.succeed(openDeferred, event.properties.generationID))
        })
        const unsubClose = Bus.subscribe(KiloSessionEvent.TurnClose, (event) => {
          if (event.properties.sessionID === s.id)
            Effect.runFork(Deferred.succeed(closeDeferred, { generationID: event.properties.generationID, reason: event.properties.reason }))
        })
        yield* Effect.yieldNow
        try {
          yield* llm.hang
          const fiber = yield* Effect.forkChild(prompt.loop({ sessionID: s.id }))
          // Wait only for generation minted (Runner committed Running) — do not wait for open
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const g = yield* run.activeGeneration(s.id)
              return g ? (true as const) : undefined
            }),
            "generation never minted",
          )
          const genSnapshot = yield* run.activeGeneration(s.id)
          expect(genSnapshot).toBeDefined()
          // Cancel immediately after runner commit, before first turn operation would have drained without uninterruptible prelude
          const cancelRes = yield* KiloSessionPrompt.cancelTree({ sessionID: s.id, sessions, cancel: run.cancel })
          expect(cancelRes.generations.find((g) => g.sessionID === s.id)?.generationID).toBe(genSnapshot)
          // Even though cancel raced before TurnOpen, the uninterruptible prelude must still produce paired events
          const openGen = yield* Deferred.await(openDeferred).pipe(Effect.timeout("5 seconds"))
          expect(openGen).toBe(genSnapshot)
          const close = yield* Deferred.await(closeDeferred).pipe(Effect.timeout("5 seconds"))
          expect(close.generationID).toBe(genSnapshot)
          expect(close.reason).toBe("interrupted")
          // No defect: fiber should not die
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("5 seconds"))
          expect(exit).toBeDefined()
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const st = yield* (yield* SessionStatus.Service).get(s.id)
              return st.type === "idle" ? (true as const) : undefined
            }),
            "session never idle after paired close",
          )
        } finally {
          unsubOpen()
          unsubClose()
        }
      }),
      { git: true, config: cfg },
    ),
    { timeout: 30_000 },
  )

  it.live("replacement generation admitted after abort linearization survives with new ID", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const s = yield* sessions.create({ title: "replacement-survives" })
        const dummy = {
          info: {
            id: "dummy",
            role: "assistant",
            sessionID: s.id,
            parentID: "dummy-parent",
            mode: "build",
            agent: "build",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            time: { created: Date.now() },
            path: { cwd: "/tmp", root: "/tmp" },
          },
          parts: [],
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.WithParts
        // Start first generation (hang)
        const f1 = yield* run.ensureRunning(s.id, Effect.succeed(dummy), Effect.never).pipe(Effect.forkChild)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const g = yield* run.activeGeneration(s.id)
            return g ? (true as const) : undefined
          }),
          "first generation never minted",
        )
        const gen1 = yield* run.activeGeneration(s.id)
        expect(gen1).toBeDefined()
        // Single-owner cancel: captures gen1, moves to Stopping, finalizer owns Idle
        const cancelRes = yield* run.cancel(s.id)
        expect(cancelRes.generationID).toBe(gen1)
        expect(cancelRes.wasBusy).toBeTrue()
        expect(cancelRes.interruptRequested).toBeTrue()
        // Admission while Stopping joins old epoch and does not mint (Runner-level join covered in unit tests).
        // Wait for finalizer Idle before admitting replacement — replacement only after idle projection.
        yield* Fiber.await(f1).pipe(Effect.ignore)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const g = yield* run.activeGeneration(s.id)
            return !g ? (true as const) : undefined
          }),
          "session not idle after cancel",
        )
        // Admit replacement generation after Idle — must get new ID and survive
        const gate = yield* Deferred.make<void>()
        const f2 = yield* run.ensureRunning(s.id, Effect.succeed(dummy), Deferred.await(gate).pipe(Effect.as(dummy))).pipe(Effect.forkChild)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const g = yield* run.activeGeneration(s.id)
            return g && g !== gen1 ? (true as const) : undefined
          }),
          "replacement generation not minted or reused old id",
        )
        const gen2 = yield* run.activeGeneration(s.id)
        expect(gen2).toBeDefined()
        expect(gen2).not.toBe(gen1)
        expect(gen2!.startsWith("gen_")).toBeTrue()
        // Replacement must remain alive until we release it — old abort must not have interrupted it
        const stillGen = yield* run.activeGeneration(s.id)
        expect(stillGen).toBe(gen2)
        yield* Deferred.succeed(gate, undefined)
        const res = yield* Fiber.join(f2).pipe(Effect.timeout("5 seconds"))
        expect(res).toBeDefined()
        yield* Fiber.interrupt(f1).pipe(Effect.ignore)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const cur = yield* run.activeGeneration(s.id)
            return !cur ? (true as const) : undefined
          }),
          "session not idle after replacement completes",
        )
      }),
      { git: true, config: cfg },
    ),
    { timeout: 30_000 },
  )

  it.live("pre-body cancel without assistant returns interrupted fallback with paired turn events", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const statusSvc = yield* SessionStatus.Service
        const s = yield* sessions.create({ title: "pre-body-fallback" })
        const u = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: s.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.User)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: u.id,
          sessionID: s.id,
          type: "text",
          text: "hello pre-body",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.TextPart)

        const openDeferred = yield* Deferred.make<string | undefined>()
        const closeDeferred = yield* Deferred.make<{ generationID?: string; reason: string }>()
        const unsubOpen = Bus.subscribe(KiloSessionEvent.TurnOpen, (event) => {
          if (event.properties.sessionID === s.id) {
            Effect.runFork(Deferred.succeed(openDeferred, event.properties.generationID))
          }
        })
        const unsubClose = Bus.subscribe(KiloSessionEvent.TurnClose, (event) => {
          if (event.properties.sessionID === s.id) {
            Effect.runFork(
              Deferred.succeed(closeDeferred, {
                generationID: event.properties.generationID,
                reason: event.properties.reason,
              }),
            )
          }
        })
        yield* Effect.yieldNow
        try {
          yield* llm.hang
          // Multiple joined prompt.loop callers share one epoch: the
          // once-per-epoch fallback must produce exactly one interrupted
          // assistant row with the same message ID/result for all joiners.
          // Fork directly (not via Effect.all) so joiners stay supervised by
          // the test scope and are not interrupted by the fork batch scope.
          const fibers = []
          for (let i = 0; i < 3; i++) fibers.push(yield* Effect.forkChild(prompt.loop({ sessionID: s.id })))
          const openGen = yield* Deferred.await(openDeferred).pipe(Effect.timeout("5 seconds"))
          expect(openGen).toBeDefined()
          expect(openGen!.startsWith("gen_")).toBeTrue()
          const active = yield* run.activeGeneration(s.id)
          expect(active).toBe(openGen!)
          const cancelRes = yield* KiloSessionPrompt.cancelTree({ sessionID: s.id, sessions, cancel: run.cancel })
          expect(cancelRes.generations.find((g) => g.sessionID === s.id)?.generationID).toBe(openGen)
          const close = yield* Deferred.await(closeDeferred).pipe(Effect.timeout("5 seconds"))
          expect(close.generationID).toBe(openGen)
          expect(close.reason).toBe("interrupted")
          const exits = []
          for (const f of fibers) exits.push(yield* Fiber.await(f).pipe(Effect.timeout("10 seconds")))
          for (const exit of exits) expect(Exit.isSuccess(exit)).toBeTrue()
          const ids = exits.flatMap((exit) =>
            Exit.isSuccess(exit) && exit.value.info.role === "assistant" ? [exit.value.info.id] : [],
          )
          expect(ids).toHaveLength(3)
          expect(new Set(ids).size).toBe(1)
          for (const exit of exits) {
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              if (exit.value.info.role === "assistant") {
                expect(exit.value.info.parentID).toBe(u.id)
                expect(exit.value.info.error?.name).toBe("MessageAbortedError")
                expect(exit.value.info.time.completed).toBeDefined()
              }
            }
          }
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const st = yield* statusSvc.get(s.id)
              const g = yield* run.activeGeneration(s.id)
              return st.type === "idle" && !g ? (true as const) : undefined
            }),
            "session never converged to idle after pre-body cancel",
          )
          const msgs = yield* sessions.messages({ sessionID: s.id })
          const last = msgs.at(-1)
          expect(last?.info.role).toBe("assistant")
          if (last?.info.role === "assistant") {
            expect(last.info.parentID).toBe(u.id)
            expect(last.info.error?.name).toBe("MessageAbortedError")
            expect(last.info.time.completed).toBeDefined()
          }
          // Once-per-epoch fallback: exactly one interrupted assistant row for
          // the shared generation, and all joiners observed the same ID.
          const assistants = msgs.filter((m) => m.info.role === "assistant")
          expect(assistants).toHaveLength(1)
          if (assistants[0]?.info.role === "assistant") expect(assistants[0].info.id).toBe(ids[0])
        } finally {
          unsubOpen()
          unsubClose()
        }
      }),
      { git: true, config: cfg },
    ),
    { timeout: 30_000 },
  )

  it.live("current-turn fallback never reuses prior turn assistant", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const statusSvc = yield* SessionStatus.Service
        const s = yield* sessions.create({ title: "current-turn-fallback" })
        const priorUser = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: s.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.User)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: priorUser.id,
          sessionID: s.id,
          type: "text",
          text: "prior turn",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.TextPart)
        const priorAssistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: priorUser.id,
          sessionID: s.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
          finish: "stop",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.Assistant)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: priorAssistant.id,
          sessionID: s.id,
          type: "text",
          text: "prior assistant",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.TextPart)
        const currentUser = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: s.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.User)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: currentUser.id,
          sessionID: s.id,
          type: "text",
          text: "current turn",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.TextPart)

        const openDeferred = yield* Deferred.make<string | undefined>()
        const closeDeferred = yield* Deferred.make<{ generationID?: string; reason: string }>()
        const unsubOpen = Bus.subscribe(KiloSessionEvent.TurnOpen, (event) => {
          if (event.properties.sessionID === s.id) {
            Effect.runFork(Deferred.succeed(openDeferred, event.properties.generationID))
          }
        })
        const unsubClose = Bus.subscribe(KiloSessionEvent.TurnClose, (event) => {
          if (event.properties.sessionID === s.id) {
            Effect.runFork(
              Deferred.succeed(closeDeferred, {
                generationID: event.properties.generationID,
                reason: event.properties.reason,
              }),
            )
          }
        })
        yield* Effect.yieldNow
        try {
          yield* llm.hang
          const fibers = []
          for (let i = 0; i < 3; i++) fibers.push(yield* Effect.forkChild(prompt.loop({ sessionID: s.id })))
          const openGen = yield* Deferred.await(openDeferred).pipe(Effect.timeout("5 seconds"))
          expect(openGen).toBeDefined()
          expect(openGen!.startsWith("gen_")).toBeTrue()
          const active = yield* run.activeGeneration(s.id)
          expect(active).toBe(openGen!)
          const cancelRes = yield* KiloSessionPrompt.cancelTree({ sessionID: s.id, sessions, cancel: run.cancel })
          expect(cancelRes.generations.find((g) => g.sessionID === s.id)?.generationID).toBe(openGen)
          const close = yield* Deferred.await(closeDeferred).pipe(Effect.timeout("5 seconds"))
          expect(close.generationID).toBe(openGen)
          expect(close.reason).toBe("interrupted")
          const exits = []
          for (const f of fibers) exits.push(yield* Fiber.await(f).pipe(Effect.timeout("10 seconds")))
          for (const exit of exits) expect(Exit.isSuccess(exit)).toBeTrue()
          const ids = exits.flatMap((exit) =>
            Exit.isSuccess(exit) && exit.value.info.role === "assistant" ? [exit.value.info.id] : [],
          )
          expect(ids).toHaveLength(3)
          expect(new Set(ids).size).toBe(1)
          // All joiners share the newly created current-turn aborted assistant.
          expect(ids[0]).not.toBe(priorAssistant.id)
          for (const exit of exits) {
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              if (exit.value.info.role === "assistant") {
                expect(exit.value.info.parentID).toBe(currentUser.id)
                expect(exit.value.info.error?.name).toBe("MessageAbortedError")
                expect(exit.value.info.time.completed).toBeDefined()
              }
            }
          }
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const st = yield* statusSvc.get(s.id)
              const g = yield* run.activeGeneration(s.id)
              return st.type === "idle" && !g ? (true as const) : undefined
            }),
            "session never converged to idle after current-turn cancel",
          )
          const msgs = yield* sessions.messages({ sessionID: s.id })
          const assistants = msgs.filter((m) => m.info.role === "assistant")
          // Prior assistant plus exactly one new current-turn assistant.
          expect(assistants).toHaveLength(2)
          const storedPrior = assistants.find((m) => m.info.id === priorAssistant.id)
          expect(storedPrior).toBeDefined()
          if (storedPrior?.info.role === "assistant") {
            expect(storedPrior.info.parentID).toBe(priorUser.id)
            expect(storedPrior.info.finish).toBe("stop")
          }
          const currentTurn = assistants.filter(
            (m) => m.info.role === "assistant" && m.info.parentID === currentUser.id,
          )
          expect(currentTurn).toHaveLength(1)
          if (currentTurn[0]?.info.role === "assistant") {
            expect(currentTurn[0].info.id).toBe(ids[0])
            expect(currentTurn[0].info.error?.name).toBe("MessageAbortedError")
          }
        } finally {
          unsubOpen()
          unsubClose()
        }
      }),
      { git: true, config: cfg },
    ),
    { timeout: 30_000 },
  )

  it.live("provider finish error projects single idle after TurnClose", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const sessions = yield* Session.Service
        const run = yield* SessionRunState.Service
        const statusSvc = yield* SessionStatus.Service
        const bridge = yield* EventV2Bridge.Service
        const events = yield* EventV2Bridge.Service
        const s = yield* sessions.create({ title: "finish-error-single-idle" })
        const u = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: s.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.User)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: u.id,
          sessionID: s.id,
          type: "text",
          text: "hello finish error",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.TextPart)
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: u.id,
          sessionID: s.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
          finish: "error",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.Assistant)

        const order: string[] = []
        const openDeferred = yield* Deferred.make<string | undefined>()
        const closeDeferred = yield* Deferred.make<{ generationID?: string; reason: string }>()
        const unsubOpen = Bus.subscribe(KiloSessionEvent.TurnOpen, (event) => {
          if (event.properties.sessionID === s.id) {
            order.push("open")
            Effect.runFork(Deferred.succeed(openDeferred, event.properties.generationID))
          }
        })
        const unsubClose = Bus.subscribe(KiloSessionEvent.TurnClose, (event) => {
          if (event.properties.sessionID === s.id) {
            order.push("close")
            Effect.runFork(
              Deferred.succeed(closeDeferred, {
                generationID: event.properties.generationID,
                reason: event.properties.reason,
              }),
            )
          }
        })
        const off = yield* bridge.listen((evt) => {
          if (evt.type === SessionStatus.Event.Status.type) {
            const data = evt.data as { sessionID: string; status: { type: string } }
            if (data.sessionID === s.id && data.status.type === "idle") order.push("idle")
          }
          return Effect.void
        })
        yield* Effect.yieldNow
        try {
          const dummy = {
            info: assistant,
            parts: [],
          } as unknown as import("@opencode-ai/core/v1/session").SessionV1.WithParts
          const fiber = yield* Effect.forkChild(
            run.ensureRunning(s.id, Effect.succeed(dummy), {
              prelude: (gen) => KiloSession.publishTurnOpen({ sessionID: s.id, generationID: gen }),
              body: (gen) =>
                Effect.gen(function* () {
                  const current = (yield* sessions.messages({ sessionID: s.id }).pipe(Effect.orDie)).findLast(
                    (m) => m.info.role === "assistant",
                  )
                  if (current?.info.role !== "assistant") return dummy
                  const err = KiloSessionProcessor.providerFinishError(current.info)
                  if (err) {
                    yield* events.publish(Session.Event.Error, { sessionID: s.id, error: err })
                  }
                  yield* sessions.updateMessage(current.info)
                  return { info: current.info, parts: current.parts } as unknown as import(
                    "@opencode-ai/core/v1/session"
                  ).SessionV1.WithParts
                }).pipe(
                  Effect.orDie,
                  Effect.onExit(() =>
                    KiloSession.publishTurnClose({ sessionID: s.id, reason: "error", generationID: gen }),
                  ),
                ),
            }),
          )
          const openGen = yield* Deferred.await(openDeferred).pipe(Effect.timeout("5 seconds"))
          expect(openGen).toBeDefined()
          const close = yield* Deferred.await(closeDeferred).pipe(Effect.timeout("5 seconds"))
          expect(close.generationID).toBe(openGen)
          expect(close.reason).toBe("error")
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("5 seconds"))
          expect(Exit.isSuccess(exit)).toBeTrue()
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const st = yield* statusSvc.get(s.id)
              const g = yield* run.activeGeneration(s.id)
              return st.type === "idle" && !g ? (true as const) : undefined
            }),
            "session never idle after finish error",
          )
          yield* pollWithTimeout(
            Effect.gen(function* () {
              return order.includes("idle") ? (true as const) : undefined
            }),
            "idle projection never observed after finish error",
          )
          expect(order[0]).toBe("open")
          expect(order).toContain("close")
          expect(order).toContain("idle")
          expect(order.indexOf("close") < order.indexOf("idle")).toBeTrue()
          expect(order.filter((item) => item === "idle")).toHaveLength(1)
          const stored = (yield* sessions.messages({ sessionID: s.id })).findLast((m) => m.info.role === "assistant")
          expect(stored?.info.role).toBe("assistant")
          if (stored?.info.role === "assistant") {
            expect(stored.info.finish).toBe("error")
            expect(stored.info.error).toBeDefined()
          }
        } finally {
          unsubOpen()
          unsubClose()
          yield* off
        }
      }),
      { git: true, config: cfg },
    ),
    { timeout: 30_000 },
  )

  it.live("processor halt projects single idle after TurnClose", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const statusSvc = yield* SessionStatus.Service
        const bridge = yield* EventV2Bridge.Service
        const s = yield* sessions.create({ title: "halt-single-idle" })
        const u = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: s.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.User)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: u.id,
          sessionID: s.id,
          type: "text",
          text: "hello halt",
        } as unknown as import("@opencode-ai/core/v1/session").SessionV1.TextPart)

        const order: string[] = []
        const openDeferred = yield* Deferred.make<string | undefined>()
        const closeDeferred = yield* Deferred.make<{ generationID?: string; reason: string }>()
        const unsubOpen = Bus.subscribe(KiloSessionEvent.TurnOpen, (event) => {
          if (event.properties.sessionID === s.id) {
            order.push("open")
            Effect.runFork(Deferred.succeed(openDeferred, event.properties.generationID))
          }
        })
        const unsubClose = Bus.subscribe(KiloSessionEvent.TurnClose, (event) => {
          if (event.properties.sessionID === s.id) {
            order.push("close")
            Effect.runFork(
              Deferred.succeed(closeDeferred, {
                generationID: event.properties.generationID,
                reason: event.properties.reason,
              }),
            )
          }
        })
        const off = yield* bridge.listen((evt) => {
          if (evt.type === SessionStatus.Event.Status.type) {
            const data = evt.data as { sessionID: string; status: { type: string } }
            if (data.sessionID === s.id && data.status.type === "idle") order.push("idle")
          }
          return Effect.void
        })
        yield* Effect.yieldNow
        try {
          yield* llm.error(400, { error: { message: "halt-boom", type: "invalid_request" } })
          const fiber = yield* Effect.forkChild(prompt.loop({ sessionID: s.id }))
          const openGen = yield* Deferred.await(openDeferred).pipe(Effect.timeout("5 seconds"))
          expect(openGen).toBeDefined()
          const close = yield* Deferred.await(closeDeferred).pipe(Effect.timeout("10 seconds"))
          expect(close.generationID).toBe(openGen)
          expect(close.reason).toBe("error")
          const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("10 seconds"))
          expect(Exit.isSuccess(exit)).toBeTrue()
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const st = yield* statusSvc.get(s.id)
              const g = yield* run.activeGeneration(s.id)
              return st.type === "idle" && !g ? (true as const) : undefined
            }),
            "session never idle after halt",
          )
          yield* pollWithTimeout(
            Effect.gen(function* () {
              return order.includes("idle") ? (true as const) : undefined
            }),
            "idle projection never observed after halt",
          )
          expect(order[0]).toBe("open")
          expect(order).toContain("close")
          expect(order).toContain("idle")
          expect(order.indexOf("close") < order.indexOf("idle")).toBeTrue()
          expect(order.filter((item) => item === "idle")).toHaveLength(1)
        } finally {
          unsubOpen()
          unsubClose()
          yield* off
        }
      }),
      { git: true, config: cfg },
    ),
    { timeout: 30_000 },
  )
})
