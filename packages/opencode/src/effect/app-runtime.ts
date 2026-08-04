import { Layer, ManagedRuntime } from "effect"
import { attach } from "./run-service"
import * as Observability from "@opencode-ai/core/effect/observability"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Ripgrep } from "@opencode-ai/core/filesystem/ripgrep"
import { Storage } from "@/storage/storage"
import { Snapshot } from "@/snapshot"
import { Plugin } from "@/plugin"
import { ModelsDev as CoreModelsDev } from "@opencode-ai/core/models-dev" // kilocode_change - provide core ModelsDev for direct CLI consumers
import * as KiloModelsDev from "@/provider/models" // kilocode_change - use Kilo wrapper for defect protection
import { ModelCache } from "@/provider/model-cache" // kilocode_change
import { Provider } from "@/provider/provider"
import { ProviderAuth } from "@/provider/auth"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionProcessor } from "@/session/processor"
import { SessionCompaction } from "@/session/compaction"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionPrompt } from "@/session/prompt"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Command } from "@/command"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Format } from "@/format"
import { InstanceLayer } from "@/project/instance-layer"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { Reference } from "@/reference/reference"
import { Workspace } from "@/control-plane/workspace"
import { Worktree } from "@/worktree"
import { Installation } from "@/installation"
import { MemoryService } from "@kilocode/kilo-memory/effect/service" // kilocode_change
import { ShareNext } from "@/share/share-next"
import { SessionShare } from "@/share/session"
import { Npm } from "@opencode-ai/core/npm"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Notebook } from "@/kilocode/notebook/service" // kilocode_change
import { AgentManager } from "@/kilocode/agent-manager/service" // kilocode_change
import { KiloViewers } from "@/kilocode/presence/service" // kilocode_change
import { EventV2Bridge } from "@/event-v2-bridge"
import * as CoreEvent from "@opencode-ai/core/event" // kilocode_change
import { ProjectV2 } from "@opencode-ai/core/project" // kilocode_change - listener routes are provided by AppLayer
import { ProjectCopy } from "@opencode-ai/core/project/copy" // kilocode_change - listener routes are provided by AppLayer
import { MoveSession } from "@opencode-ai/core/control-plane/move-session" // kilocode_change - listener routes are provided by AppLayer
import { PtyTicket } from "@opencode-ai/core/pty/ticket" // kilocode_change - listener routes are provided by AppLayer
import { GenerationGate } from "@/kilocode/server/generation-gate" // kilocode_change
import { ControlLease } from "@/kilocode/server/control-lease" // kilocode_change
import { ConfigConvergence } from "@/kilocode/server/config-convergence" // kilocode_change - canonical cold-mutation coordinator

// kilocode_change start - LOCK-001/LOCK-002: canonical defaults shared with feature layers
type ModelsLayer = Layer.Layer<CoreModelsDev.Service | KiloModelsDev.Service, never, never>
type ProviderLayer = Layer.Layer<Provider.Service, never, never>
type ModelCacheLayer = typeof ModelCache.defaultLayer // kilocode_change - LOCK-005: injectable for cache-failure coverage

const buildCoreLayer = (
  models: ModelsLayer = Provider.defaultModels,
  provider: ProviderLayer = Provider.defaultLayer,
  modelCache: ModelCacheLayer = ModelCache.defaultLayer, // kilocode_change - LOCK-005: test substitution boundary
) =>
  // kilocode_change end
  Layer.mergeAll(
    // kilocode_change
    Npm.defaultLayer,
    GenerationGate.defaultLayer, // kilocode_change - one process-wide writer gate
    ConfigConvergence.defaultLayer, // kilocode_change - one process-wide cold-mutation convergence coordinator
    ControlLease.defaultLayer, // kilocode_change - one process-wide control lifetime lease coordinator
    FSUtil.defaultLayer,
    Database.defaultLayer,
    Auth.defaultLayer,
    Account.defaultLayer,
    Config.defaultLayer,
    Git.defaultLayer,
    Ripgrep.defaultLayer, // kilocode_change - canonical AppLayer service
    Storage.defaultLayer, // kilocode_change - canonical AppLayer service
    Snapshot.defaultLayer, // kilocode_change - canonical AppLayer service
    Plugin.defaultLayer,
    modelCache, // kilocode_change - canonical ModelCache layer (LOCK-005 injectable)
    models, // kilocode_change - canonical combined models layer (Provider.defaultModels)
    provider, // kilocode_change - canonical Provider.defaultLayer identity shared with feature layers
    ProviderAuth.layer, // kilocode_change - canonical AppLayer service; consumes the same Auth/Plugin graph (LOCK-001)
    Agent.defaultLayer, // kilocode_change - canonical AppLayer service
    Skill.defaultLayer, // kilocode_change - canonical AppLayer service
    Discovery.defaultLayer, // kilocode_change - canonical AppLayer service
    // kilocode_change start - LOCK-001: resolve ProviderAuth.layer's Auth/Plugin
    // and ConfigConvergence's GenerationGate requirements against the canonical
    // defaults already in this merge — the same layer nodes, so no duplicate
    // service instances are constructed.
  ).pipe(
    Layer.provideMerge(Auth.defaultLayer),
    Layer.provideMerge(Plugin.defaultLayer),
    Layer.provideMerge(GenerationGate.defaultLayer), // kilocode_change - ConfigConvergence depends on the canonical gate
    // kilocode_change end
  ) // kilocode_change

// kilocode_change start - LOCK-002/LOCK-003: zero-arg defaults or a matching models+provider pair
export function makeCoreLayer(): ReturnType<typeof buildCoreLayer>
export function makeCoreLayer(models: ModelsLayer, provider: ProviderLayer): ReturnType<typeof buildCoreLayer>
export function makeCoreLayer(
  models: ModelsLayer,
  provider: ProviderLayer,
  modelCache: ModelCacheLayer,
): ReturnType<typeof buildCoreLayer>
export function makeCoreLayer(
  models: ModelsLayer = Provider.defaultModels,
  provider: ProviderLayer = Provider.defaultLayer,
  modelCache: ModelCacheLayer = ModelCache.defaultLayer,
) {
  return buildCoreLayer(models, provider, modelCache)
}
// kilocode_change end

const SessionLayer = Layer.mergeAll(
  AgentManager.defaultLayer, // kilocode_change
  KiloViewers.defaultLayer, // kilocode_change - canonical presence service
  Question.defaultLayer,
  Notebook.defaultLayer, // kilocode_change
  Permission.defaultLayer,
  Todo.defaultLayer,
  Session.defaultLayer,
  SessionStatus.defaultLayer,
  BackgroundJob.defaultLayer,
  RuntimeFlags.defaultLayer,
  EventV2Bridge.defaultLayer,
  CoreEvent.defaultLayer, // kilocode_change - canonical legacy event service
  SessionRunState.defaultLayer,
  SessionProcessor.defaultLayer,
  SessionCompaction.defaultLayer,
  SessionRevert.defaultLayer,
  SessionSummary.defaultLayer,
  SessionPrompt.defaultLayer,
  Instruction.defaultLayer,
  LLM.defaultLayer,
  LSP.defaultLayer,
  MCP.defaultLayer,
  McpAuth.defaultLayer,
  Command.defaultLayer,
  Truncate.defaultLayer,
 ) // kilocode_change

const FeatureLayer = Layer.mergeAll(
  ToolRegistry.defaultLayer,
  Format.defaultLayer,
  Project.defaultLayer,
  ProjectV2.defaultLayer, // kilocode_change - satisfy listener route handlers through AppLayer
  ProjectCopy.defaultLayer, // kilocode_change - satisfy listener route handlers through AppLayer
  MoveSession.defaultLayer, // kilocode_change - satisfy listener route handlers through AppLayer
  PtyTicket.defaultLayer, // kilocode_change - satisfy listener route handlers through AppLayer
  Vcs.defaultLayer,
  Reference.defaultLayer,
  Workspace.defaultLayer,
  Worktree.appLayer, // kilocode_change - canonical AppLayer service
  Installation.defaultLayer, // kilocode_change - canonical AppLayer service
  MemoryService.layer, // kilocode_change
  ShareNext.defaultLayer, // kilocode_change - canonical AppLayer service
  SessionShare.defaultLayer, // kilocode_change - canonical AppLayer service
  // kilocode_change - canonical feature service layer
 ) // kilocode_change - canonical feature service layer

// kilocode_change start - LOCK-003: makeAppLayer shares canonical defaults
const buildAppLayer = (
  models: ModelsLayer = Provider.defaultModels,
  provider: ProviderLayer = Provider.defaultLayer,
  modelCache: ModelCacheLayer = ModelCache.defaultLayer,
) =>
  Layer.mergeAll(buildCoreLayer(models, provider, modelCache), SessionLayer, FeatureLayer).pipe(
    Layer.provideMerge(InstanceLayer.layer),
    Layer.provideMerge(Observability.layer),
  )
// kilocode_change end

// kilocode_change start - LOCK-002/LOCK-003: zero-arg defaults or a matching models+provider pair
export function makeAppLayer(): ReturnType<typeof buildAppLayer>
export function makeAppLayer(models: ModelsLayer, provider: ProviderLayer): ReturnType<typeof buildAppLayer>
export function makeAppLayer(
  models: ModelsLayer,
  provider: ProviderLayer,
  modelCache: ModelCacheLayer,
): ReturnType<typeof buildAppLayer>
export function makeAppLayer(
  models: ModelsLayer = Provider.defaultModels,
  provider: ProviderLayer = Provider.defaultLayer,
  modelCache: ModelCacheLayer = ModelCache.defaultLayer,
) {
  return buildAppLayer(models, provider, modelCache)
}

export const AppLayer = makeAppLayer() // kilocode_change
export type AppLayer = ReturnType<typeof makeAppLayer> // kilocode_change

const rt = ManagedRuntime.make(AppLayer, { memoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">

/** Services provided by AppRuntime — i.e. what an Effect run via AppRuntime.runPromise can yield. */
export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof rt>
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

export const AppRuntime: Runtime = {
  runSync(effect) {
    return rt.runSync(wrap(effect))
  },
  runPromise(effect, options) {
    return rt.runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    return rt.runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    return rt.runFork(wrap(effect))
  },
  runCallback(effect) {
    return rt.runCallback(wrap(effect))
  },
  dispose: () => rt.dispose(),
}
