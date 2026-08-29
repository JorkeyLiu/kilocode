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
import * as RetentionMaintenance from "@/retention/maintenance"
import * as RetentionOwnership from "@/retention/ownership"
import * as RetentionLease from "@/retention/lease"
import * as RetentionAccounting from "@/retention/accounting"
import { InstanceLayer } from "@/project/instance-layer"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { Reference } from "@/reference/reference"
import { Workspace } from "@/control-plane/workspace"
import { Installation } from "@/installation"
import { ShareNext } from "@/share/share-next"
import { SessionShare } from "@/share/session"
import { Npm } from "@opencode-ai/core/npm"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Notebook } from "@/kilocode/notebook/service" // kilocode_change
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
import { ConfigRebuild } from "@/kilocode/server/config-rebuild" // kilocode_change - explicit-dispose rebuild owner
import * as CancelQueuedDispatch from "@/kilocode/session/cancel-queued-dispatch" // kilocode_change - P4.4-G3-B0 backend dispatch
import * as P0Perf from "@/kilocode/perf/instrument" // kilocode_change - P0 instrumentation

// kilocode_change start - LOCK-001/LOCK-002: canonical defaults shared with feature layers
type ModelsLayer = Layer.Layer<CoreModelsDev.Service | KiloModelsDev.Service, never, never>
type ProviderLayer = Layer.Layer<Provider.Service, never, never>

const buildCoreLayer = (
  models: ModelsLayer = Provider.defaultModels,
  provider: ProviderLayer = Provider.defaultLayer,
) =>
  // kilocode_change end
  Layer.mergeAll(
    // kilocode_change
    Npm.defaultLayer,
    GenerationGate.defaultLayer, // kilocode_change - one process-wide writer gate
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
  models: ModelsLayer = Provider.defaultModels,
  provider: ProviderLayer = Provider.defaultLayer,
) {
  return buildCoreLayer(models, provider)
}
// kilocode_change end

const SessionLayer = Layer.mergeAll(
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
  Installation.defaultLayer, // kilocode_change - canonical AppLayer service
  ShareNext.defaultLayer, // kilocode_change - canonical AppLayer service
  SessionShare.defaultLayer, // kilocode_change - canonical AppLayer service
  // kilocode_change - canonical feature service layer
) // kilocode_change - canonical feature service layer

// kilocode_change start - LOCK-003: makeAppLayer shares canonical defaults
const buildAppLayer = (
  models: ModelsLayer = Provider.defaultModels,
  provider: ProviderLayer = Provider.defaultLayer,
) => {
  const base = Layer.mergeAll(
    buildCoreLayer(models, provider),
    SessionLayer,
    FeatureLayer,
    RetentionOwnership.layer,
    RetentionLease.layer,
    RetentionAccounting.layer,
    InstanceLayer.layer,
    Observability.layer,
  )
  // Config lifecycle services depend on the complete application base. This
  // makes their scope a dependent of InstanceLayer, so their finalizers
  // interrupt/join owned rebuild work before InstanceStore is torn down.
  const lifecycle = Layer.mergeAll(ConfigConvergence.defaultLayer, ConfigRebuild.defaultLayer).pipe(
    Layer.provideMerge(base),
  )
  const cancelQueued = CancelQueuedDispatch.layer.pipe(Layer.provideMerge(lifecycle), Layer.provideMerge(base))
  const maintenance = RetentionMaintenance.layer.pipe(Layer.provide(base))
  return Layer.mergeAll(lifecycle, cancelQueued, maintenance)
}
// kilocode_change end

// kilocode_change start - LOCK-002/LOCK-003: zero-arg defaults or a matching models+provider pair
export function makeAppLayer(): ReturnType<typeof buildAppLayer>
export function makeAppLayer(models: ModelsLayer, provider: ProviderLayer): ReturnType<typeof buildAppLayer>
export function makeAppLayer(
  models: ModelsLayer = Provider.defaultModels,
  provider: ProviderLayer = Provider.defaultLayer,
) {
  return buildAppLayer(models, provider)
}

/**
 * P0 span around a synchronous AppLayer/runtime construction step. The build
 * runs once at module load (`makeAppLayer()` / `ManagedRuntime.make`), so the
 * records are module-load-time spans: p0.start/p0.end with the synchronous
 * wall-clock duration. When `KILO_P0_PERF` is off `span()` is a no-op.
 */
function measure<T>(stage: string, build: () => T): T {
  const timer = P0Perf.span(stage)
  const out = build()
  timer.end()
  return out
}

// kilocode_change start - LOCK-002/LOCK-003: zero-arg defaults or a matching models+provider pair
export const AppLayer = measure("app_layer_define", makeAppLayer) // kilocode_change
export type AppLayer = ReturnType<typeof makeAppLayer> // kilocode_change

const rt = measure("app_runtime_make", () => ManagedRuntime.make(AppLayer, { memoMap }))
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
