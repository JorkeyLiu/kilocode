import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Slug } from "@opencode-ai/core/util/slug"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import path from "path"
import { BackgroundJob } from "@/background/job"
import { Decimal } from "decimal.js"
import type { ProviderMetadata, Usage } from "@opencode-ai/llm"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Database } from "@opencode-ai/core/database/database"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV2 } from "@opencode-ai/core/session"

import { NotFoundError, Storage } from "@/storage/storage"
import { eq, and, gte, isNull, desc, like, sql, inArray, lt, or } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SandboxStore } from "@/kilocode/sandbox/store"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import * as Artifact from "@opencode-ai/core/retention/artifact"
import * as Retention from "@opencode-ai/core/retention/retention"
import * as Ownership from "@/retention/ownership"
import { SessionChangefeedTable, RetentionObligationTable } from "@opencode-ai/core/retention/sql"
import { Log } from "@opencode-ai/core/util/log"
import { MessageV2 } from "./message-v2"
import type { InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { ProjectV2 } from "@opencode-ai/core/project"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SessionID, MessageID, PartID, BusyError as SchemaBusyError } from "./schema"
import { SessionRunState } from "./run-state"

import type { Provider } from "@/provider/provider"
import { Permission } from "@/permission"
import { Global } from "@opencode-ai/core/global"
// kilocode_change start - Kilo session behavior extensions
import { BackgroundProcess } from "@/kilocode/background-process"
import * as SandboxInheritance from "@/kilocode/sandbox/inheritance"
import { InteractiveTerminal } from "@/kilocode/interactive-terminal"
import { KiloSession } from "@/kilocode/session"
import { kiloSessionFork } from "@/kilocode/session/fork-command"
import { KiloSessionEvent } from "@/kilocode/session/event"
import { SessionExport } from "@/kilocode/session-export"
import * as SandboxPolicy from "@/kilocode/sandbox/policy"
import { carryForkDiff } from "@/kilocode/session-portability/cumulative-diff" // kilocode_change
import { BlockedError as AgentRequirementError } from "@/kilocode/agent-requirements"
// kilocode_change end
import { Effect, Layer, Option, Context, Schema, Types } from "effect"
import { NonNegativeInt, optionalOmitUndefined } from "@opencode-ai/core/schema"
import { AbsolutePath } from "@opencode-ai/core/schema" // kilocode_change
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import {
  cloneMessageDataForFork,
  clonePartDataForFork,
  filterMessagesForFork,
  getForkedTitle,
  resolveForkModelAtCheckpoint,
  sessionPath,
} from "@/kilocode/session/fork"
import fs from "node:fs/promises"
import { ForkSeam } from "@/kilocode/session/fork-seam"
import { baseKey, cumulativeSessionDiff } from "@/kilocode/session-portability/cumulative-diff"
import { isClaimedWriteError, storageFileForKey, writeExclusiveJson } from "@/storage/claimed-file"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"

const log = Log.create({ service: "session" })
const runtime = makeRuntime(Database.Service, Database.defaultLayer)

function isEnoentLocal(err: unknown): boolean {
  const c = (err as unknown as { code?: string })?.code
  if (c === "ENOENT") return true
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes("ENOENT")
}
function isEexistLocal(err: unknown): boolean {
  const c = (err as unknown as { code?: string })?.code
  if (c === "EEXIST") return true
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes("EEXIST")
}
function isUniqueViolationLocal(err: unknown): boolean {
  const code = (err as unknown as { code?: string })?.code
  if (code === "SQLITE_CONSTRAINT" || code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE")
    return true
  const msg = err instanceof Error ? err.message : String(err)
  return (
    msg.includes("UNIQUE constraint") ||
    msg.includes("unique constraint") ||
    msg.includes("UNIQUE") ||
    msg.includes("SQLITE_CONSTRAINT")
  )
}

const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "

export function isDefaultTitle(title: string) {
  return new RegExp(
    `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
  ).test(title)
}

type SessionRow = typeof SessionTable.$inferSelect

export function fromRow(row: SessionRow): Info {
  const summary =
    row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
      ? {
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0,
          files: row.summary_files ?? 0,
          diffs: row.summary_diffs ?? undefined,
        }
      : undefined
  const share = row.share_url ? { url: row.share_url } : undefined
  const revert = row.revert ?? undefined
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    directory: row.directory,
    path: row.path ?? undefined,
    parentID: row.parent_id ?? undefined,
    title: row.title,
    agent: row.agent ?? undefined,
    model: row.model
      ? {
          id: ModelV2.ID.make(row.model.id),
          providerID: ProviderV2.ID.make(row.model.providerID),
          variant: row.model.variant,
        }
      : undefined,
    version: row.version,
    summary,
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    share,
    metadata: row.metadata ?? undefined,
    revert,
    permission: row.permission ? [...row.permission] : undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: row.time_compacting ?? undefined,
      archived: row.time_archived ?? undefined,
    },
  }
}

export function toRow(info: Info) {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? EmptyTokens).input,
    tokens_output: (info.tokens ?? EmptyTokens).output,
    tokens_reasoning: (info.tokens ?? EmptyTokens).reasoning,
    tokens_cache_read: (info.tokens ?? EmptyTokens).cache.read,
    tokens_cache_write: (info.tokens ?? EmptyTokens).cache.write,
    revert: info.revert ?? null,
    permission: info.permission,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

const Summary = Schema.Struct({
  additions: Schema.Finite,
  deletions: Schema.Finite,
  files: Schema.Finite,
  diffs: optionalOmitUndefined(Schema.Array(Snapshot.SummaryFileDiff)), // kilocode_change - lightweight diff without patch
})

const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
})

const EmptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const Share = Schema.Struct({
  url: Schema.String,
})

// Legacy HTTP accepted negative values here. Keep archive timestamps permissive
// while excluding non-finite values that cannot round-trip through JSON.
export const ArchivedTimestamp = Schema.Finite

const Time = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  compacting: optionalOmitUndefined(NonNegativeInt),
  archived: optionalOmitUndefined(ArchivedTimestamp),
})

const Revert = Schema.Struct({
  messageID: MessageID,
  partID: optionalOmitUndefined(PartID),
  snapshot: optionalOmitUndefined(Schema.String),
  diff: optionalOmitUndefined(Schema.String),
})

const Model = Schema.Struct({
  id: ModelV2.ID,
  providerID: ProviderV2.ID,
  variant: optionalOmitUndefined(Schema.String),
})

export const Metadata = Schema.Record(Schema.String, Schema.Any)

export const Info = Schema.Struct({
  id: SessionID,
  slug: Schema.String,
  projectID: ProjectV2.ID,
  workspaceID: optionalOmitUndefined(WorkspaceV2.ID),
  directory: Schema.String,
  path: optionalOmitUndefined(Schema.String),
  parentID: optionalOmitUndefined(SessionID),
  summary: optionalOmitUndefined(Summary),
  cost: optionalOmitUndefined(Schema.Finite),
  tokens: optionalOmitUndefined(Tokens),
  share: optionalOmitUndefined(Share),
  title: Schema.String,
  agent: optionalOmitUndefined(Schema.String),
  model: optionalOmitUndefined(Model),
  version: Schema.String,
  metadata: optionalOmitUndefined(Metadata),
  time: Time,
  permission: optionalOmitUndefined(PermissionV1.Ruleset),
  revert: optionalOmitUndefined(Revert),
}).annotate({ identifier: "Session" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const ProjectInfo = Schema.Struct({
  id: ProjectV2.ID,
  name: optionalOmitUndefined(Schema.String),
  worktree: Schema.String,
}).annotate({ identifier: "ProjectSummary" })
export type ProjectInfo = Types.DeepMutable<Schema.Schema.Type<typeof ProjectInfo>>

export const GlobalInfo = Schema.Struct({
  ...Info.fields,
  project: Schema.NullOr(ProjectInfo),
}).annotate({ identifier: "GlobalSession" })
export type GlobalInfo = Types.DeepMutable<Schema.Schema.Type<typeof GlobalInfo>>

export const CreateInput = Schema.optional(
  Schema.Struct({
    parentID: Schema.optional(SessionID),
    title: Schema.optional(Schema.String),
    agent: Schema.optional(Schema.String),
    model: Schema.optional(Model),
    metadata: Schema.optional(Metadata),
    permission: Schema.optional(PermissionV1.Ruleset),
    platform: Schema.optional(Schema.String), // kilocode_change - per-session platform override for telemetry attribution
    // kilocode_change start - server-issued sandbox inheritance grant
    workspaceID: Schema.optional(WorkspaceV2.ID),
    sandboxInheritanceToken: Schema.optional(Schema.String),
    // kilocode_change end
    // kilocode_change - P4.4-G3-B4 durable create lane (optional) — finite safe integers; HTTP handler enforces strict unknown-field rejection for OpenAPI `additionalProperties: false` parity
    idempotencyKey: Schema.optional(Schema.String),
    requestId: Schema.optional(Schema.String),
    opId: Schema.optional(Schema.String),
    context: Schema.optional(
      Schema.Struct({
        directory: Schema.String,
        parentSessionId: Schema.optional(Schema.NullOr(SessionID)),
        configVersion: Schema.optional(
          Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
        ),
      }),
    ),
  }),
)
export type CreateInput = Types.DeepMutable<Schema.Schema.Type<typeof CreateInput>>

export const ForkInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export const GetInput = SessionID
export const ChildrenInput = SessionID
export const RemoveInput = SessionID
export const SetTitleInput = Schema.Struct({ sessionID: SessionID, title: Schema.String })
export const SetArchivedInput = Schema.Struct({
  sessionID: SessionID,
  time: Schema.optional(ArchivedTimestamp),
})
export const SetMetadataInput = Schema.Struct({
  sessionID: SessionID,
  metadata: Metadata,
})
export const SetPermissionInput = Schema.Struct({
  sessionID: SessionID,
  permission: PermissionV1.Ruleset,
})
export const SetRevertInput = Schema.Struct({
  sessionID: SessionID,
  revert: Schema.optional(Revert),
  summary: Schema.optional(Summary),
})
export const MessagesInput = Schema.Struct({
  sessionID: SessionID,
  limit: Schema.optional(NonNegativeInt),
})
export type ListInput = {
  directory?: string
  scope?: "project"
  path?: string
  workspaceID?: WorkspaceV2.ID
  roots?: boolean
  start?: number
  search?: string
  limit?: number
}

export type GlobalListInput = {
  projectID?: string
  directory?: string
  roots?: boolean
  start?: number
  cursor?: string
  search?: string
  limit?: number
  archived?: boolean
}

const CreatedEventSchema = Schema.Struct({
  sessionID: SessionID,
  info: Info,
})

const UpdatedShare = Schema.Struct({
  url: Schema.optional(Schema.NullOr(Schema.String)),
})

const UpdatedTime = Schema.Struct({
  created: Schema.optional(Schema.NullOr(NonNegativeInt)),
  updated: Schema.optional(Schema.NullOr(NonNegativeInt)),
  compacting: Schema.optional(Schema.NullOr(NonNegativeInt)),
  archived: Schema.optional(Schema.NullOr(ArchivedTimestamp)),
})

const UpdatedInfo = Schema.Struct({
  id: Schema.optional(Schema.NullOr(SessionID)),
  slug: Schema.optional(Schema.NullOr(Schema.String)),
  projectID: Schema.optional(Schema.NullOr(ProjectV2.ID)),
  workspaceID: Schema.optional(Schema.NullOr(WorkspaceV2.ID)),
  directory: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.optional(Schema.NullOr(Schema.String)),
  parentID: Schema.optional(Schema.NullOr(SessionID)),
  summary: Schema.optional(Schema.NullOr(Summary)),
  cost: Schema.optional(Schema.Finite),
  tokens: Schema.optional(Tokens),
  share: Schema.optional(UpdatedShare),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  agent: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.NullOr(Model)),
  version: Schema.optional(Schema.NullOr(Schema.String)),
  metadata: Schema.optional(Schema.NullOr(Metadata)),
  time: Schema.optional(UpdatedTime),
  permission: Schema.optional(Schema.NullOr(PermissionV1.Ruleset)),
  revert: Schema.optional(Schema.NullOr(Revert)),
})

const UpdatedEventSchema = Schema.Struct({
  sessionID: SessionID,
  info: UpdatedInfo,
})

export const Event = {
  Created: SessionV1.Event.Created,
  Updated: SessionV1.Event.Updated,
  Deleted: SessionV1.Event.Deleted,
  Diff: EventV2.define({
    type: "session.diff",
    schema: {
      sessionID: SessionID,
      diff: Schema.Array(Snapshot.FileDiff),
    },
  }),
  Error: EventV2.define({
    type: "session.error",
    schema: {
      sessionID: Schema.optional(SessionID),
      // Reuses SessionV1.Assistant.fields.error (already Schema.optional) so
      // the derived schema keeps the same discriminated-union shape on the event stream.
      // kilocode_change - carry pre-message requirement failures over session.error
      error: Schema.optional(Schema.Union([SessionV1.Assistant.fields.error, AgentRequirementError.EffectSchema])),
    },
  }),
  // kilocode_change start
  TurnOpen: KiloSessionEvent.TurnOpen,
  TurnClose: KiloSessionEvent.TurnClose,
  // kilocode_change end
}

export function plan(input: { slug: string; time: { created: number } }, instance: InstanceContext) {
  const base = instance.project.vcs
    ? path.join(instance.worktree, ".kilo", "plans") // kilocode_change
    : path.join(Global.Path.data, "plans")
  return path.join(base, [input.time.created, input.slug].join("-") + ".md")
}

export const getUsage = (input: {
  model: Provider.Model
  usage: Usage
  metadata?: ProviderMetadata
  provider?: Provider.Info // kilocode_change
}) => {
  const safe = (value: number) => {
    if (!Number.isFinite(value)) return 0
    return Math.max(0, value)
  }
  const inputTokens = safe(input.usage.inputTokens ?? 0)
  const outputTokens = safe(input.usage.outputTokens ?? 0)
  const reasoningTokens = safe(input.usage.reasoningTokens ?? 0)

  const cacheReadInputTokens = safe(input.usage.cacheReadInputTokens ?? 0)
  const meta = input.metadata as Record<string, unknown> | undefined
  const bedrockUsage = (meta?.["bedrock"] as Record<string, unknown> | undefined)?.["usage"] as
    | Record<string, unknown>
    | undefined
  const veniceUsage = (meta?.["venice"] as Record<string, unknown> | undefined)?.["usage"] as
    | Record<string, unknown>
    | undefined
  const cacheWriteInputTokens = safe(
    Number(
      input.usage.cacheWriteInputTokens ??
        (meta?.["anthropic"] as Record<string, unknown> | undefined)?.["cacheCreationInputTokens"] ??
        (meta?.["vertex"] as Record<string, unknown> | undefined)?.["cacheCreationInputTokens"] ??
        (bedrockUsage?.["cacheWriteInputTokens"] as number | undefined) ??
        (veniceUsage?.["cacheCreationInputTokens"] as number | undefined) ??
        0,
    ),
  )

  // AI SDK v6 normalized inputTokens to include cached tokens across all providers
  // (including Anthropic/Bedrock which previously excluded them). Always subtract cache
  // tokens to get the non-cached input count for separate cost calculation.
  const adjustedInputTokens = safe(inputTokens - cacheReadInputTokens - cacheWriteInputTokens)

  const total = input.usage.totalTokens

  const tokens = {
    total,
    input: adjustedInputTokens,
    output: safe(outputTokens - reasoningTokens),
    reasoning: reasoningTokens,
    cache: {
      write: cacheWriteInputTokens,
      read: cacheReadInputTokens,
    },
  }

  // kilocode_change start - Use provider-reported cost when available for OpenRouter/Kilo
  const reported = KiloSession.providerCost({
    metadata: input.metadata,
    usage: input.usage,
    provider: input.provider,
    providerID: input.model.providerID,
  })
  if (reported !== undefined) return { cost: safe(reported), tokens }
  // kilocode_change end

  const contextTokens = inputTokens
  const costInfo =
    input.model.cost?.tiers
      ?.filter((item) => item.tier.type === "context" && contextTokens > item.tier.size)
      .sort((a, b) => b.tier.size - a.tier.size)[0] ??
    (input.model.cost?.experimentalOver200K && contextTokens > 200_000
      ? input.model.cost.experimentalOver200K
      : input.model.cost)
  const totalNanoAiu = input.metadata?.["copilot"]?.["totalNanoAiu"]
  return {
    cost:
      typeof totalNanoAiu === "number" && Number.isFinite(totalNanoAiu) && totalNanoAiu >= 0
        ? new Decimal(totalNanoAiu).div(100_000_000_000).toNumber()
        : safe(
            new Decimal(0)
              .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
              .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
              .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
              .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
              // charge reasoning tokens at the same rate as output tokens
              .add(new Decimal(tokens.reasoning).mul(costInfo?.output ?? 0).div(1_000_000))
              .toNumber(),
          ),
    tokens,
  }
}

export const BusyError = SchemaBusyError
export type BusyError = InstanceType<typeof SchemaBusyError>

export type NotFound = NotFoundError

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<Info[]>
  // kilocode_change start - session create metadata and sandbox inheritance extensions
  readonly listGlobal: (input?: GlobalListInput) => Effect.Effect<GlobalInfo[]>
  readonly create: (input?: {
    parentID?: SessionID
    title?: string
    agent?: string
    model?: Schema.Schema.Type<typeof Model>
    metadata?: typeof Metadata.Type
    permission?: PermissionV1.Ruleset
    platform?: string // kilocode_change - per-session platform override for telemetry attribution
    workspaceID?: WorkspaceV2.ID
    sandboxInheritanceToken?: string
  }) => Effect.Effect<Info>
  // kilocode_change end
  readonly fork: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Info, NotFound>
  readonly touch: (sessionID: SessionID) => Effect.Effect<void>
  readonly get: (id: SessionID) => Effect.Effect<Info, NotFound>
  readonly setTitle: (input: { sessionID: SessionID; title: string }) => Effect.Effect<void>
  readonly setArchived: (input: { sessionID: SessionID; time?: number }) => Effect.Effect<void>
  readonly setMetadata: (input: typeof SetMetadataInput.Type) => Effect.Effect<void>
  readonly setPermission: (input: { sessionID: SessionID; permission: PermissionV1.Ruleset }) => Effect.Effect<void>
  readonly setRevert: (input: {
    sessionID: SessionID
    revert: Info["revert"]
    summary: Info["summary"]
  }) => Effect.Effect<void>
  readonly clearRevert: (sessionID: SessionID) => Effect.Effect<void>
  readonly setSummary: (input: { sessionID: SessionID; summary: Info["summary"] }) => Effect.Effect<void>
  readonly setShare: (input: { sessionID: SessionID; share: Info["share"] }) => Effect.Effect<void>
  readonly setWorkspace: (input: { sessionID: SessionID; workspaceID: Info["workspaceID"] }) => Effect.Effect<void>
  readonly diff: (sessionID: SessionID) => Effect.Effect<Snapshot.FileDiff[]>
  readonly messages: (input: { sessionID: SessionID; limit?: number }) => Effect.Effect<SessionV1.WithParts[], NotFound>
  readonly children: (parentID: SessionID) => Effect.Effect<Info[]>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, NotFound>
  readonly updateMessage: <T extends SessionV1.Info>(msg: T) => Effect.Effect<T>
  readonly removeMessage: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<MessageID>
  readonly removePart: (input: { sessionID: SessionID; messageID: MessageID; partID: PartID }) => Effect.Effect<PartID>
  readonly getPart: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
  }) => Effect.Effect<SessionV1.Part | undefined>
  readonly updatePart: <T extends SessionV1.Part>(part: T) => Effect.Effect<T>
  readonly updatePartDelta: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
    field: string
    delta: string
  }) => Effect.Effect<void>
  /** Finds the first message matching the predicate, searching newest-first. */
  readonly findMessage: (
    sessionID: SessionID,
    predicate: (msg: SessionV1.WithParts) => boolean,
  ) => Effect.Effect<Option.Option<SessionV1.WithParts>, NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Session") {}

export const use = serviceUse(Service)

export type Patch = Omit<Partial<Info>, "time" | "share" | "summary" | "revert" | "permission"> & {
  time?: Partial<Info["time"]>
  share?: Partial<NonNullable<Info["share"]>> | null
  summary?: Info["summary"] | null
  revert?: Info["revert"] | null
  permission?: Info["permission"] | null
}

export const layer: Layer.Layer<
  Service,
  never,
  | BackgroundJob.Service
  | RuntimeFlags.Service
  | Database.Service
  | EventV2Bridge.Service
  | Storage.Service
  | Ownership.Service
  | SessionRunState.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const database = yield* Database.Service
    const background = yield* BackgroundJob.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const storage = yield* Storage.Service
    const ownership = yield* Ownership.Service
    const runState = yield* SessionRunState.Service

    // kilocode_change start - inherited sandbox policy source
    const createNext = Effect.fn("Session.createNext")(function* (input: {
      id?: SessionID
      title?: string
      agent?: string
      model?: Schema.Schema.Type<typeof Model>
      parentID?: SessionID
      workspaceID?: WorkspaceV2.ID
      directory: string
      path?: string
      metadata?: typeof Metadata.Type
      permission?: PermissionV1.Ruleset
      platform?: string // kilocode_change - per-session platform override for telemetry attribution
      sourceID?: SessionID // kilocode_change - inherited sandbox policy source
      sourceDirectory?: string
      sandboxFallback?: SandboxPolicy.Snapshot // kilocode_change - confinement to seed when source state lives in another directory
    }) {
      const ctx = yield* InstanceState.context
      const result: Info = {
        id: SessionID.descending(input.id),
        slug: Slug.create(),
        version: InstallationVersion,
        projectID: ctx.project.id,
        directory: input.directory,
        path: input.path,
        workspaceID: input.workspaceID,
        parentID: input.parentID,
        title: input.title ?? (input.parentID ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString(),
        agent: input.agent,
        model: input.model,
        metadata: input.metadata,
        permission: input.permission ? [...input.permission] : undefined,
        cost: 0,
        tokens: EmptyTokens,
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      }
      log.info("created", result)
      // kilocode_change end

      // kilocode_change start - legacy sessions must satisfy the upstream project foreign key
      yield* db
        .insert(ProjectTable)
        .values({
          id: ctx.project.id,
          worktree: AbsolutePath.make(ctx.project.worktree),
          vcs: ctx.project.vcs ?? null,
          time_created: ctx.project.time.created,
          time_updated: ctx.project.time.updated,
          sandboxes: ctx.project.sandboxes.map((sandbox) => AbsolutePath.make(sandbox)),
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      // kilocode_change end

      // kilocode_change start - initialize inherited state before session.created subscribers run
      KiloSession.register({ id: result.id, parentID: result.parentID, platform: input.platform })
      const source = input.sourceID ?? result.parentID
      if (source) yield* SandboxPolicy.inherit(source, result.id, input.sandboxFallback, input.sourceDirectory)
      // kilocode_change end

      yield* events.publish(SessionV1.Event.Created, { sessionID: result.id, info: result })

      return result
    })

    const get = Effect.fn("Session.get")(function* (id: SessionID) {
      const release = yield* ownership.acquireLease(id)
      const row = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, id))
        .get()
        .pipe(Effect.orDie, Effect.ensuring(release))
      if (!row) return yield* Effect.fail(new NotFoundError({ message: `Session not found: ${id}` }))
      return fromRow(row)
    })

    const list = Effect.fn("Session.list")(function* (input?: ListInput) {
      const ctx = yield* InstanceState.context
      return yield* listByProject(db, {
        projectID: ctx.project.id,
        experimentalWorkspaces: flags.experimentalWorkspaces,
        ...input,
      })
    })

    // kilocode_change start - delegate cross-project listing to KiloSession.listGlobal
    const listGlobal = Effect.fn("Session.listGlobal")((input?: GlobalListInput) =>
      KiloSession.listGlobal<GlobalInfo>({ ...input, fromRow }).pipe(Effect.provideService(Database.Service, database)),
    )
    // kilocode_change end

    // kilocode_change start - scope children by persisted parent project_id
    const children = Effect.fn("Session.children")(function* (parentID: SessionID) {
      const parent = yield* db
        .select({ projectID: SessionTable.project_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, parentID))
        .get()
        .pipe(Effect.orDie)
      const conditions = [eq(SessionTable.parent_id, parentID)]
      if (parent) conditions.push(eq(SessionTable.project_id, parent.projectID))
      const rows = yield* db
        .select()
        .from(SessionTable)
        .where(and(...conditions))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })
    // kilocode_change end

    const remove: Interface["remove"] = Effect.fnUntraced(function* (sessionID: SessionID) {
      const session = yield* get(sessionID)
      try {
        const hasInstance = yield* InstanceState.directory.pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        )

        if (hasInstance) yield* cancelBackgroundJobs(background, sessionID)

        // kilocode_change start
        yield* SandboxPolicy.dispose(
          sessionID,
          Effect.gen(function* () {
            yield* Effect.promise(() => KiloSession.removeSession(sessionID)).pipe(Effect.ignore)
            KiloSession.clearPlatformOverride(sessionID)
            if (hasInstance) {
              yield* Effect.promise(() => BackgroundProcess.stopSession(sessionID)).pipe(Effect.ignore)
              yield* Effect.promise(() => InteractiveTerminal.stopSession(sessionID)).pipe(Effect.ignore)
              yield* runState
                .cancel(sessionID)
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Session.remove runState cancel failed", { sessionID, cause }).pipe(
                      Effect.asVoid,
                    ),
                  ),
                )
            }
            const workspaceKey = hasInstance ? yield* InstanceState.directory : undefined
            yield* Effect.promise(() => SessionExport.onSessionClose(sessionID, workspaceKey))
            yield* events.remove(sessionID)
            const now = Date.now()
            const familyIDs = yield* Retention.deleteFamilyUnprotected(db, sessionID, now).pipe(Effect.orDie)
            if (familyIDs.length > 0) {
              const keys = Artifact.familyArtifactsForFamily(familyIDs)
              const delExit = yield* Effect.forEach(keys, (key) => storage.remove(key), { discard: true }).pipe(
                Effect.exit,
              )
              if (delExit._tag === "Failure") {
                yield* Effect.logWarning("Session.remove artifact delete failed, obligation retained", {
                  sessionID,
                  cause: String(delExit.cause),
                })
                yield* db
                  .run(sql`UPDATE retention_obligation SET attempts = attempts + 1 WHERE family_root_id = ${sessionID}`)
                  .pipe(
                    Effect.orDie,
                    Effect.catchCause((cause) =>
                      Effect.logWarning("Session.remove obligation attempt bump failed", {
                        sessionID,
                        cause: String(cause),
                      }).pipe(Effect.asVoid),
                    ),
                  )
              } else {
                const obligationExit = yield* db
                  .delete(RetentionObligationTable)
                  .where(eq(RetentionObligationTable.family_root_id, sessionID))
                  .run()
                  .pipe(Effect.exit)
                if (obligationExit._tag === "Failure") {
                  yield* Effect.logWarning("Session.remove obligation delete failed", {
                    sessionID,
                    cause: String(obligationExit.cause),
                  })
                  yield* db
                    .run(
                      sql`UPDATE retention_obligation SET attempts = attempts + 1 WHERE family_root_id = ${sessionID}`,
                    )
                    .pipe(
                      Effect.orDie,
                      Effect.catchCause((cause) =>
                        Effect.logWarning("Session.remove obligation attempt bump after delete failure failed", {
                          sessionID,
                          cause: String(cause),
                        }).pipe(Effect.asVoid),
                      ),
                    )
                }
              }
            } else {
              const directExit = yield* Effect.forEach(Artifact.familyArtifactsForSession(sessionID), (key) =>
                storage.remove(key).pipe(Effect.catch(() => Effect.void)),
              ).pipe(Effect.exit)
              if (directExit._tag === "Failure") {
                yield* Effect.logWarning("Session.remove direct artifact cleanup failed", {
                  sessionID,
                  cause: String(directExit.cause),
                })
              }
            }
          }),
        )
        // kilocode_change end
      } catch (e) {
        log.error(e)
      }
    })

    const updateMessage = <T extends SessionV1.Info>(msg: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        // kilocode_change start - ignore FK errors when session was deleted while processor was still running
        yield* KiloSession.runSyncSafe(
          events.publish(SessionV1.Event.MessageUpdated, { sessionID: msg.sessionID, info: msg }),
          { type: "message update", id: msg.id, sessionID: msg.sessionID },
        )
        // kilocode_change end
        return msg
      }).pipe(Effect.withSpan("Session.updateMessage"))

    const updatePart = <T extends SessionV1.Part>(part: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        // kilocode_change start - ignore FK errors when session was deleted while processor was still running
        yield* KiloSession.runSyncSafe(
          events.publish(SessionV1.Event.PartUpdated, {
            sessionID: part.sessionID,
            part: structuredClone(part),
            time: Date.now(),
          }),
          { type: "part update", id: part.id, sessionID: part.sessionID },
        )
        // kilocode_change end
        return part
      }).pipe(Effect.withSpan("Session.updatePart"))

    const getPart: Interface["getPart"] = Effect.fn("Session.getPart")(function* (input) {
      const row = yield* db
        .select()
        .from(PartTable)
        .where(
          and(
            eq(PartTable.session_id, input.sessionID),
            eq(PartTable.message_id, input.messageID),
            eq(PartTable.id, input.partID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return {
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      } as SessionV1.Part
    })

    // kilocode_change start - session create metadata and sandbox inheritance extensions
    const create = Effect.fn("Session.create")(function* (input?: {
      parentID?: SessionID
      title?: string
      agent?: string
      model?: Schema.Schema.Type<typeof Model>
      metadata?: typeof Metadata.Type
      permission?: PermissionV1.Ruleset
      platform?: string // kilocode_change - per-session platform override for telemetry attribution
      workspaceID?: WorkspaceV2.ID
      sandboxInheritanceToken?: string
    }) {
      const ctx = yield* InstanceState.context
      const workspace = yield* InstanceState.workspaceID
      const grant = SandboxInheritance.consume(input?.sandboxInheritanceToken)
      if (input?.sandboxInheritanceToken && !grant) yield* Effect.die(new Error("Invalid sandbox inheritance token"))
      // kilocode_change end
      // kilocode_change start - propagate trusted sandbox inheritance grant
      const session = yield* createNext({
        parentID: input?.parentID,
        directory: ctx.directory,
        path: sessionPath(ctx.worktree, ctx.directory),
        title: input?.title,
        agent: input?.agent,
        model: input?.model,
        metadata: input?.metadata,
        permission: input?.permission,
        platform: input?.platform, // kilocode_change
        sourceID: grant?.sessionID, // kilocode_change
        sourceDirectory: grant?.directory, // kilocode_change
        workspaceID: input?.workspaceID ?? workspace,
      })
      // kilocode_change end
      return session
    })

    const fork = Effect.fn("Session.fork")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const ctx = yield* InstanceState.context
      const original = yield* get(input.sessionID)
      const title = getForkedTitle(original.title)
      const sandboxFallback = yield* SandboxPolicy.peek(original.directory, input.sessionID)
      const msgs = yield* messages({ sessionID: input.sessionID })
      const model = resolveForkModelAtCheckpoint({
        sourceModel: original.model as unknown as { id: string; providerID: string; variant?: string } | null,
        checkpointId: input.messageID as unknown as string | null,
        orderedMessages: msgs.map((m) => ({
          id: m.info.id,
          role: m.info.role,
          model: (m.info as unknown as { model?: unknown }).model,
        })),
      }) as unknown as typeof original.model

      // Establish target identity before any filesystem effects (strict IDs, no overwrite)
      const newIdStr = ForkSeam.nextId ? ForkSeam.nextId : SessionID.descending()
      if (ForkSeam.nextId) ForkSeam.nextId = undefined
      const newId = newIdStr as unknown as SessionID

      // Probe SessionTable occupancy before effects
      const idOccupied = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, newId))
        .get()
        .pipe(
          Effect.map((v) => !!v),
          Effect.orDie,
        )
      if (idOccupied)
        return yield* Effect.fail(new NotFoundError({ message: `fork target already exists ${newIdStr}` }))

      // Probe filesystem artifacts before effects - fail closed on probe errors other than ENOENT
      const existingSandbox = yield* Effect.promise(() => SandboxStore.read(ctx.directory, newId)).pipe(
        Effect.map((v) => v !== undefined),
        Effect.catch((e) => (isEnoentLocal(e) ? Effect.succeed(false) : Effect.fail(e))),
        Effect.catchDefect((e) => Effect.fail(e)),
      )
      const baseExists = yield* Effect.promise(() =>
        fs
          .stat(storageFileForKey(baseKey(newIdStr), Global.Path.data))
          .then(() => true)
          .catch((e: unknown) => {
            if (isEnoentLocal(e)) return false
            throw e
          }),
      )
      const diffExists = yield* Effect.promise(() =>
        fs
          .stat(storageFileForKey(["session_diff", newIdStr], Global.Path.data))
          .then(() => true)
          .catch((e: unknown) => {
            if (isEnoentLocal(e)) return false
            throw e
          }),
      )
      // Preflight target event aggregate occupancy before effects (strict IDs, no global deletion)
      const eventSeqExists = yield* db
        .select()
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, newIdStr))
        .get()
        .pipe(
          Effect.map((v) => !!v),
          Effect.orDie,
        )
      const eventExists = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, newIdStr))
        .get()
        .pipe(
          Effect.map((v) => !!v),
          Effect.orDie,
        )
      if (existingSandbox || baseExists || diffExists || eventSeqExists || eventExists)
        return yield* Effect.fail(new NotFoundError({ message: `fork target already exists ${newIdStr}` }))

      let ownedSession = false
      let ownedSandbox = false
      let ownedBase = false
      let ownedDiff = false
      let createdSession: Info | undefined

      const doFork = Effect.gen(function* () {
        // Create session with explicit ID, without automatic sandbox inherit (exclusive handling below)
        const session = yield* createNext({
          id: newIdStr as unknown as SessionID,
          directory: ctx.directory,
          path: sessionPath(ctx.worktree, ctx.directory),
          workspaceID: original.workspaceID,
          title,
          metadata: structuredClone(original.metadata),
          model,
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              ownedSession = true
            }),
          ),
          Effect.catch((e) =>
            isUniqueViolationLocal(e)
              ? Effect.fail(new NotFoundError({ message: `fork target already exists ${newIdStr}` }))
              : Effect.fail(e as unknown as NotFoundError),
          ),
          Effect.catchDefect((d) =>
            isUniqueViolationLocal(d)
              ? Effect.fail(new NotFoundError({ message: `fork target already exists ${newIdStr}` }))
              : Effect.fail(new NotFoundError({ message: String(d) }) as unknown as NotFoundError),
          ),
        )
        createdSession = session

        // Sandbox exclusive inherit
        const sourceDir = original.directory
        let parentSnap: SandboxStore.Snapshot | undefined
        if (sandboxFallback) {
          parentSnap = sandboxFallback as unknown as SandboxStore.Snapshot
        } else {
          parentSnap = yield* Effect.promise(() => SandboxStore.read(sourceDir, input.sessionID)).pipe(
            Effect.map((v) => v as SandboxStore.Snapshot | undefined),
            Effect.catch((e) => (isEnoentLocal(e) ? Effect.succeed(undefined) : Effect.fail(e))),
            Effect.catchDefect((e) => Effect.fail(e)),
          )
        }
        if (parentSnap) {
          if (ForkSeam.failSandboxWrite) return yield* Effect.fail(new Error("injected sandbox write failure"))
          const nextSnap: SandboxStore.Snapshot = { ...parentSnap, version: 0 }
          try {
            yield* Effect.promise(() => SandboxStore.writeExclusive(ctx.directory, newId, nextSnap))
            ownedSandbox = true
          } catch (e) {
            if (isEexistLocal(e))
              return yield* Effect.fail(new NotFoundError({ message: `fork target already exists ${newIdStr}` }))
            return yield* Effect.fail(e as unknown as NotFoundError)
          }
        }

        // Clone messages/parts
        const idMap = new Map<string, MessageID>()
        const filtered = filterMessagesForFork(
          msgs as unknown as Array<{ id: string }>,
          input.messageID as unknown as string | null,
        ) as unknown as typeof msgs
        for (const msg of filtered) {
          const newMID = MessageID.ascending()
          idMap.set(msg.info.id, newMID)
          const data = cloneMessageDataForFork(
            msg.info as unknown as Record<string, unknown>,
            idMap as unknown as Map<string, string>,
          )
          const cloned = yield* updateMessage({
            ...data,
            sessionID: session.id,
            id: newMID,
          } as unknown as typeof msg.info & { sessionID: string; id: string })
          for (const part of msg.parts) {
            const prepared = KiloSession.prepareForkedPart(part)
            if (!prepared) continue
            const mappedPartData = clonePartDataForFork(
              prepared as unknown as MessageV2.Part,
              idMap as unknown as Map<string, string>,
            )
            const p: SessionV1.Part = {
              ...(mappedPartData as unknown as SessionV1.Part),
              id: PartID.ascending(),
              messageID: cloned.id,
              sessionID: session.id,
            }
            yield* updatePart(p)
          }
        }

        // Diff carry with claimed-file exclusive and ownership tracking
        const storageRuntime = makeRuntime(Storage.Service, Storage.defaultLayer)
        const localForDiff = yield* Effect.promise(() =>
          storageRuntime.runPromise((s) =>
            s.read<any>(["session_diff", String(input.sessionID)]).pipe(
              Effect.catchIf(
                (err: unknown) =>
                  err instanceof NotFoundError || (err as unknown as { _tag?: string })?._tag === "NotFoundError",
                () => Effect.succeed([] as any),
              ),
            ),
          ),
        ).pipe(
          Effect.map((v) => v as unknown[]),
          Effect.catch((e) => Effect.fail(e)),
          Effect.catchDefect((e) => Effect.fail(e)),
        )
        const baseForDiff = yield* Effect.promise(() =>
          storageRuntime.runPromise((s) => cumulativeSessionDiff(s, input.sessionID, localForDiff as any)),
        )
        const hasDiff = baseForDiff.length > 0
        if (hasDiff) {
          const firstKey = baseKey(newIdStr)
          const secondKey = ["session_diff", newIdStr] as unknown as string[]
          if (ForkSeam.failFirstDiffWrite) return yield* Effect.fail(new Error("injected first diff write failure"))
          try {
            yield* Effect.promise(() => writeExclusiveJson(storageFileForKey(firstKey, Global.Path.data), baseForDiff))
            ownedBase = true
          } catch (e) {
            if (isClaimedWriteError(e)) {
              const claimed = e as unknown as {
                handle: { cleanup: () => Promise<boolean> }
                cause: unknown
                target: string
              }
              ownedBase = true
              const original = claimed.cause ?? e
              const ok = yield* Effect.promise(() => claimed.handle.cleanup()).pipe(
                Effect.map((v) => v as boolean),
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork claimed cleanup failed", {
                    target: claimed.target,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork claimed cleanup defect", {
                    target: claimed.target,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
              )
              if (ok) ownedBase = false
              else
                yield* Effect.logWarning("legacy fork claimed file retained", {
                  target: claimed.target,
                  cause: String(original),
                })
              if (isEexistLocal(original) || isUniqueViolationLocal(original))
                return yield* Effect.fail(new NotFoundError({ message: `fork target already exists ${newIdStr}` }))
              return yield* Effect.fail(original as unknown as NotFoundError)
            }
            if (isEexistLocal(e) || isUniqueViolationLocal(e))
              return yield* Effect.fail(new NotFoundError({ message: `fork target already exists ${newIdStr}` }))
            return yield* Effect.fail(e as unknown as NotFoundError)
          }
          if (ForkSeam.failSecondDiffWrite) {
            const ok = yield* Effect.promise(() =>
              fs.rm(storageFileForKey(firstKey, Global.Path.data), { force: true }),
            ).pipe(
              Effect.map(() => true as const),
              Effect.catch((err) =>
                Effect.logWarning("legacy fork second diff cleanup failed", {
                  target: newIdStr,
                  cause: String(err),
                }).pipe(Effect.as(false as const)),
              ),
              Effect.catchDefect((err) =>
                Effect.logWarning("legacy fork second diff cleanup defect", {
                  target: newIdStr,
                  cause: String(err),
                }).pipe(Effect.as(false as const)),
              ),
            )
            if (ok) ownedBase = false
            return yield* Effect.fail(new Error("injected second diff write failure"))
          }
          try {
            yield* Effect.promise(() => writeExclusiveJson(storageFileForKey(secondKey, Global.Path.data), baseForDiff))
            ownedDiff = true
          } catch (e) {
            if (isClaimedWriteError(e)) {
              const claimed = e as unknown as {
                handle: { cleanup: () => Promise<boolean> }
                cause: unknown
                target: string
              }
              ownedDiff = true
              const original = claimed.cause ?? e
              const ok2 = yield* Effect.promise(() => claimed.handle.cleanup()).pipe(
                Effect.map((v) => v as boolean),
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork claimed second cleanup failed", {
                    target: claimed.target,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork claimed second cleanup defect", {
                    target: claimed.target,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
              )
              if (ok2) ownedDiff = false
              else
                yield* Effect.logWarning("legacy fork claimed second retained", {
                  target: claimed.target,
                  cause: String(original),
                })
              // also clean owned first as before
              const ok = yield* Effect.promise(() =>
                fs.rm(storageFileForKey(firstKey, Global.Path.data), { force: true }),
              ).pipe(
                Effect.map(() => true as const),
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork second diff partial cleanup failed", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork second diff partial cleanup defect", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
              )
              if (ok) ownedBase = false
              if (isEexistLocal(original) || isUniqueViolationLocal(original))
                return yield* Effect.fail(new NotFoundError({ message: `fork target already exists ${newIdStr}` }))
              return yield* Effect.fail(original as unknown as NotFoundError)
            }
            const ok = yield* Effect.promise(() =>
              fs.rm(storageFileForKey(firstKey, Global.Path.data), { force: true }),
            ).pipe(
              Effect.map(() => true as const),
              Effect.catch((err) =>
                Effect.logWarning("legacy fork second diff partial cleanup failed", {
                  target: newIdStr,
                  cause: String(err),
                }).pipe(Effect.as(false as const)),
              ),
              Effect.catchDefect((err) =>
                Effect.logWarning("legacy fork second diff partial cleanup defect", {
                  target: newIdStr,
                  cause: String(err),
                }).pipe(Effect.as(false as const)),
              ),
            )
            if (ok) ownedBase = false
            if (isEexistLocal(e) || isUniqueViolationLocal(e))
              return yield* Effect.fail(new NotFoundError({ message: `fork target already exists ${newIdStr}` }))
            return yield* Effect.fail(e as unknown as NotFoundError)
          }
        }

        return session
      })

      const compensated = doFork.pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            if (ownedBase) {
              const okFs = yield* Effect.promise(() =>
                fs.rm(storageFileForKey(baseKey(newIdStr), Global.Path.data), { force: true }),
              ).pipe(
                Effect.map(() => true as const),
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork cleanup base fs failed", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork cleanup base fs defect", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
              )
              const okStorage = yield* storage.remove(baseKey(newIdStr)).pipe(
                Effect.map(() => true as const),
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork cleanup base storage failed", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork cleanup base storage defect", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
              )
              if (okFs && okStorage) ownedBase = false
            }
            if (ownedDiff) {
              const okFs = yield* Effect.promise(() =>
                fs.rm(storageFileForKey(["session_diff", newIdStr], Global.Path.data), { force: true }),
              ).pipe(
                Effect.map(() => true as const),
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork cleanup diff fs failed", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork cleanup diff fs defect", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
              )
              const okStorage = yield* storage.remove(["session_diff", newIdStr]).pipe(
                Effect.map(() => true as const),
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork cleanup diff storage failed", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork cleanup diff storage defect", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
              )
              if (okFs && okStorage) ownedDiff = false
            }
            if (ownedSandbox) {
              const okRemove = yield* Effect.promise(() => SandboxStore.remove(ctx.directory, newId)).pipe(
                Effect.map(() => true as const),
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork cleanup sandbox remove failed", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork cleanup sandbox remove defect", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
              )
              const okEvict = yield* Effect.sync(() => SandboxPolicy.evict(ctx.directory, newId)).pipe(
                Effect.map(() => true as const),
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork cleanup sandbox evict failed", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork cleanup sandbox evict defect", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
              )
              if (okRemove && okEvict) ownedSandbox = false
            }
            if (createdSession) {
              yield* Effect.promise(() => KiloSession.removeSession(newIdStr)).pipe(
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork cleanup KiloSession remove failed", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.asVoid),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork cleanup KiloSession remove defect", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.asVoid),
                ),
              )
              KiloSession.clearPlatformOverride(newIdStr)
              yield* db
                .delete(SessionTable)
                .where(eq(SessionTable.id, newId))
                .run()
                .pipe(
                  Effect.catch((err) =>
                    Effect.logWarning("legacy fork cleanup session delete failed", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                  Effect.catchDefect((err) =>
                    Effect.logWarning("legacy fork cleanup session delete defect", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                )
              yield* db
                .delete(MessageTable)
                .where(eq(MessageTable.session_id, newId))
                .run()
                .pipe(
                  Effect.catch((err) =>
                    Effect.logWarning("legacy fork cleanup message delete failed", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                  Effect.catchDefect((err) =>
                    Effect.logWarning("legacy fork cleanup message delete defect", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                )
              yield* db
                .delete(PartTable)
                .where(eq(PartTable.session_id, newId))
                .run()
                .pipe(
                  Effect.catch((err) =>
                    Effect.logWarning("legacy fork cleanup part delete failed", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                  Effect.catchDefect((err) =>
                    Effect.logWarning("legacy fork cleanup part delete defect", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                )
              // Event aggregate scoped to forked session ID only — preserves unrelated aggregates
              yield* db
                .delete(EventTable)
                .where(eq(EventTable.aggregate_id, newIdStr))
                .run()
                .pipe(
                  Effect.catch((err) =>
                    Effect.logWarning("legacy fork cleanup event table delete failed", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                  Effect.catchDefect((err) =>
                    Effect.logWarning("legacy fork cleanup event table delete defect", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                )
              yield* db
                .delete(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, newIdStr))
                .run()
                .pipe(
                  Effect.catch((err) =>
                    Effect.logWarning("legacy fork cleanup event sequence delete failed", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                  Effect.catchDefect((err) =>
                    Effect.logWarning("legacy fork cleanup event sequence delete defect", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                )
            } else {
              yield* Effect.promise(() => KiloSession.removeSession(newIdStr)).pipe(
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork cleanup KiloSession ghost remove failed", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.asVoid),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork cleanup KiloSession ghost remove defect", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.asVoid),
                ),
              )
              KiloSession.clearPlatformOverride(newIdStr)
            }
            return yield* Effect.fail(cause as unknown as NotFoundError)
          }),
        ),
        Effect.catchDefect((defect) =>
          Effect.gen(function* () {
            if (ownedBase) {
              const okFs = yield* Effect.promise(() =>
                fs.rm(storageFileForKey(baseKey(newIdStr), Global.Path.data), { force: true }),
              ).pipe(
                Effect.map(() => true as const),
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork cleanup base fs failed", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork cleanup base fs defect", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
              )
              const okStorage = yield* storage.remove(baseKey(newIdStr)).pipe(
                Effect.map(() => true as const),
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork cleanup base storage failed", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork cleanup base storage defect", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
              )
              if (okFs && okStorage) ownedBase = false
            }
            if (ownedDiff) {
              const okFs = yield* Effect.promise(() =>
                fs.rm(storageFileForKey(["session_diff", newIdStr], Global.Path.data), { force: true }),
              ).pipe(
                Effect.map(() => true as const),
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork cleanup diff fs failed", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork cleanup diff fs defect", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
              )
              const okStorage = yield* storage.remove(["session_diff", newIdStr]).pipe(
                Effect.map(() => true as const),
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork cleanup diff storage failed", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork cleanup diff storage defect", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
              )
              if (okFs && okStorage) ownedDiff = false
            }
            if (ownedSandbox) {
              const okRemove = yield* Effect.promise(() => SandboxStore.remove(ctx.directory, newId)).pipe(
                Effect.map(() => true as const),
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork cleanup sandbox remove failed", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork cleanup sandbox remove defect", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
              )
              const okEvict = yield* Effect.sync(() => SandboxPolicy.evict(ctx.directory, newId)).pipe(
                Effect.map(() => true as const),
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork cleanup sandbox evict failed", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork cleanup sandbox evict defect", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.as(false as const)),
                ),
              )
              if (okRemove && okEvict) ownedSandbox = false
            }
            if (createdSession) {
              yield* Effect.promise(() => KiloSession.removeSession(newIdStr)).pipe(
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork cleanup KiloSession remove failed", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.asVoid),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork cleanup KiloSession remove defect", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.asVoid),
                ),
              )
              KiloSession.clearPlatformOverride(newIdStr)
              yield* db
                .delete(SessionTable)
                .where(eq(SessionTable.id, newId))
                .run()
                .pipe(
                  Effect.catch((err) =>
                    Effect.logWarning("legacy fork cleanup session delete failed", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                  Effect.catchDefect((err) =>
                    Effect.logWarning("legacy fork cleanup session delete defect", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                )
              yield* db
                .delete(MessageTable)
                .where(eq(MessageTable.session_id, newId))
                .run()
                .pipe(
                  Effect.catch((err) =>
                    Effect.logWarning("legacy fork cleanup message delete failed", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                  Effect.catchDefect((err) =>
                    Effect.logWarning("legacy fork cleanup message delete defect", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                )
              yield* db
                .delete(PartTable)
                .where(eq(PartTable.session_id, newId))
                .run()
                .pipe(
                  Effect.catch((err) =>
                    Effect.logWarning("legacy fork cleanup part delete failed", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                  Effect.catchDefect((err) =>
                    Effect.logWarning("legacy fork cleanup part delete defect", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                )
              yield* db
                .delete(EventTable)
                .where(eq(EventTable.aggregate_id, newIdStr))
                .run()
                .pipe(
                  Effect.catch((err) =>
                    Effect.logWarning("legacy fork cleanup event table delete failed", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                  Effect.catchDefect((err) =>
                    Effect.logWarning("legacy fork cleanup event table delete defect", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                )
              yield* db
                .delete(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, newIdStr))
                .run()
                .pipe(
                  Effect.catch((err) =>
                    Effect.logWarning("legacy fork cleanup event sequence delete failed", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                  Effect.catchDefect((err) =>
                    Effect.logWarning("legacy fork cleanup event sequence delete defect", {
                      target: newIdStr,
                      cause: String(err),
                    }).pipe(Effect.asVoid),
                  ),
                )
            } else {
              yield* Effect.promise(() => KiloSession.removeSession(newIdStr)).pipe(
                Effect.catch((err) =>
                  Effect.logWarning("legacy fork cleanup KiloSession ghost remove failed", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.asVoid),
                ),
                Effect.catchDefect((err) =>
                  Effect.logWarning("legacy fork cleanup KiloSession ghost remove defect", {
                    target: newIdStr,
                    cause: String(err),
                  }).pipe(Effect.asVoid),
                ),
              )
              KiloSession.clearPlatformOverride(newIdStr)
            }
            return yield* Effect.fail(new NotFoundError({ message: String(defect) }) as unknown as NotFoundError)
          }),
        ),
      )
      const result = yield* compensated as unknown as Effect.Effect<Info, NotFoundError>
      return result
    }) as unknown as Interface["fork"]

    const patch = (sessionID: SessionID, info: Patch) =>
      Effect.gen(function* () {
        const current = yield* get(sessionID)
        const next = {
          ...current,
          ...info,
          time: info.time ? { ...current.time, ...info.time } : current.time,
          share: info.share === null ? undefined : info.share ? { ...current.share, ...info.share } : current.share,
          summary: info.summary === null ? undefined : (info.summary ?? current.summary),
          revert: info.revert === null ? undefined : (info.revert ?? current.revert),
          permission: info.permission === null ? undefined : (info.permission ?? current.permission),
        } as Info
        yield* events.publish(SessionV1.Event.Updated, { sessionID, info: next })
      })

    const touch = Effect.fn("Session.touch")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setTitle = Effect.fn("Session.setTitle")(function* (input: { sessionID: SessionID; title: string }) {
      yield* patch(input.sessionID, { title: input.title }).pipe(Effect.orDie)
    })

    const setArchived = Effect.fn("Session.setArchived")(function* (input: { sessionID: SessionID; time?: number }) {
      yield* patch(input.sessionID, { time: { archived: input.time } }).pipe(Effect.orDie)
    })

    const setMetadata = Effect.fn("Session.setMetadata")(function* (input: typeof SetMetadataInput.Type) {
      yield* patch(input.sessionID, { metadata: input.metadata, time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setPermission = Effect.fn("Session.setPermission")(function* (input: {
      sessionID: SessionID
      permission: PermissionV1.Ruleset
    }) {
      yield* patch(input.sessionID, { permission: [...input.permission], time: { updated: Date.now() } }).pipe(
        Effect.orDie,
      )
    })

    const setRevert = Effect.fn("Session.setRevert")(function* (input: {
      sessionID: SessionID
      revert: Info["revert"]
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, {
        summary: input.summary,
        time: { updated: Date.now() },
        revert: input.revert,
      }).pipe(Effect.orDie)
    })

    const clearRevert = Effect.fn("Session.clearRevert")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() }, revert: null }).pipe(Effect.orDie)
    })

    const setSummary = Effect.fn("Session.setSummary")(function* (input: {
      sessionID: SessionID
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, { time: { updated: Date.now() }, summary: input.summary }).pipe(Effect.orDie)
    })

    const setShare = Effect.fn("Session.setShare")(function* (input: { sessionID: SessionID; share: Info["share"] }) {
      yield* patch(input.sessionID, { share: input.share ?? null, time: { updated: Date.now() } }).pipe(Effect.orDie)
    })

    const setWorkspace = Effect.fn("Session.setWorkspace")(function* (input: {
      sessionID: SessionID
      workspaceID: Info["workspaceID"]
    }) {
      yield* patch(input.sessionID, { workspaceID: input.workspaceID, time: { updated: Date.now() } }).pipe(
        Effect.orDie,
      )
    })

    const diff = Effect.fn("Session.diff")(function* (sessionID: SessionID) {
      void sessionID
      return [] as Snapshot.FileDiff[]
    })

    const messages: Interface["messages"] = Effect.fn("Session.messages")(function* (input) {
      const release = yield* ownership.acquireLease(input.sessionID)
      return yield* Effect.gen(function* () {
        if (input.limit) {
          return (yield* MessageV2.page({ sessionID: input.sessionID, limit: input.limit }).pipe(
            Effect.provideService(Database.Service, database),
          )).items
        }

        const size = 50
        const result = [] as SessionV1.WithParts[]
        let before: string | undefined
        while (true) {
          const page = yield* MessageV2.page({ sessionID: input.sessionID, limit: size, before }).pipe(
            Effect.provideService(Database.Service, database),
          )
          if (page.items.length === 0) break
          for (let i = page.items.length - 1; i >= 0; i--) {
            const item = page.items[i]
            if (item) result.push(item)
          }
          if (!page.more || !page.cursor) break
          before = page.cursor
        }
        return result.reverse()
      }).pipe(Effect.ensuring(release))
    })

    const removeMessage = Effect.fn("Session.removeMessage")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      yield* events.publish(SessionV1.Event.MessageRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return input.messageID
    })

    const removePart = Effect.fn("Session.removePart")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
    }) {
      yield* events.publish(SessionV1.Event.PartRemoved, {
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })
      return input.partID
    })

    const updatePartDelta = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
      field: string
      delta: string
    }) {
      yield* events.publish(MessageV2.Event.PartDelta, input)
    })

    /** Finds the first message matching the predicate, searching newest-first. */
    const findMessage: Interface["findMessage"] = Effect.fn("Session.findMessage")(function* (sessionID, predicate) {
      const size = 50
      let before: string | undefined
      while (true) {
        const page = yield* MessageV2.page({ sessionID, limit: size, before }).pipe(
          Effect.provideService(Database.Service, database),
        )
        if (page.items.length === 0) break
        for (let i = page.items.length - 1; i >= 0; i--) {
          const item = page.items[i]
          if (item && predicate(item)) return Option.some(item)
        }
        if (!page.more || !page.cursor) break
        before = page.cursor
      }
      return Option.none<SessionV1.WithParts>()
    })

    return Service.of({
      list,
      listGlobal,
      create,
      fork,
      touch,
      get,
      setTitle,
      setArchived,
      setMetadata,
      setPermission,
      setRevert,
      clearRevert,
      setSummary,
      setShare,
      setWorkspace,
      diff,
      messages,
      children,
      remove,
      updateMessage,
      removeMessage,
      removePart,
      updatePart,
      getPart,
      updatePartDelta,
      findMessage,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionRunState.defaultLayer),
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(SessionV2.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(Ownership.layer),
)

const cancelBackgroundJobs = Effect.fn("Session.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  yield* Effect.forEach(
    jobs.filter((job) => {
      if (job.status !== "running") return false
      if (job.id === sessionID) return true
      if (job.metadata?.sessionId === sessionID) return true
      return job.metadata?.parentSessionId === sessionID
    }),
    (job) => background.cancel(job.id),
    { concurrency: "unbounded", discard: true },
  )
})

function listByProject(
  db: Database.Interface["db"],
  input: ListInput & {
    projectID: ProjectV2.ID
    experimentalWorkspaces: boolean
  },
) {
  // kilocode_change start - KiloSession.filters keeps sessions visible across project_id changes
  // (see PR #8875). That directory-anchored filter conflicts with upstream's path-prefix filter,
  // so bypass it when input.path is provided and fall back to the plain project_id base.
  const conditions =
    input.path !== undefined
      ? [eq(SessionTable.project_id, input.projectID)]
      : KiloSession.filters({ projectID: input.projectID, directory: input.directory })
  // kilocode_change end

  if (input.workspaceID) {
    conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
  }
  if (input.path !== undefined) {
    if (input.path) {
      const conds = [
        eq(SessionTable.path, input.path),
        like(SessionTable.path, sql.param(`${input.path}/%`, SessionTable.path)),
      ]

      conditions.push(
        input.directory
          ? or(...conds, and(isNull(SessionTable.path), eq(SessionTable.directory, input.directory))!)!
          : or(...conds)!,
      )
    }
  } else if (input.scope !== "project" && !input.experimentalWorkspaces) {
    // kilocode_change start - directory filtering handled by KiloSession.filters above
    // if (input.directory) {
    //   conditions.push(eq(SessionTable.directory, input.directory))
    // }
    // kilocode_change end
  }
  if (input.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input.search) {
    conditions.push(like(SessionTable.title, `%${input.search}%`))
  }

  const limit = input.limit ?? 100

  return db
    .select()
    .from(SessionTable)
    .where(and(...conditions))
    .orderBy(desc(SessionTable.time_updated))
    .limit(limit)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(fromRow)),
    )
}

// kilocode_change start - delegate to KiloSession.listGlobal
export function listGlobal(input?: {
  projectID?: string
  directory?: string
  roots?: boolean
  start?: number
  cursor?: string
  search?: string
  limit?: number
  archived?: boolean
}) {
  return KiloSession.listGlobal<GlobalInfo>({ ...input, fromRow })
}
// kilocode_change end

// kilocode_change - delegate the exported Promise facade to the Kilo session runtime
export const fork = kiloSessionFork

export * as Session from "./session"
