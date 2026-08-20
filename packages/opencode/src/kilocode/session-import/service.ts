import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { SessionRevision } from "@opencode-ai/core/session/revision"
import * as Changefeed from "@opencode-ai/core/retention/changefeed"
import { SessionID, MessageID, PartID } from "../../session/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SessionImportType } from "./types"
import { Project } from "../../project/project"
import { AppRuntime } from "../../effect/app-runtime"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { isDeepStrictEqual } from "node:util"

const key = (input: unknown) => [input] as never
const target = (input: unknown) => input as never

export namespace SessionImportService {
  export async function project(input: SessionImportType.Project): Promise<SessionImportType.Result> {
    // Do not resolve an empty legacy worktree, because that would fall back to the current
    // process directory and silently attach the migrated session to the wrong project.
    if (!input.worktree.trim()) {
      throw new Error("Legacy project import requires a non-empty worktree")
    }

    const result = await AppRuntime.runPromise(Project.Service.use((svc) => svc.fromDirectory(input.worktree)))
    return { ok: true, id: result.project.id }
  }

  export async function session(input: SessionImportType.Session): Promise<SessionImportType.Result> {
    return AppRuntime.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service

        // One atomic semantic mutation: read, conditionally delete, insert/upsert
        // with a single revision advance. Force replacement preserves monotonicity
        // by deriving new revision from the prior row.
        const result = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // Validate parent exists and belongs to the same project BEFORE any
              // early-return or mutation. An invalid parent is an atomic rejection
              // with no state or revision change.
              if (input.parentID) {
                const parent = yield* tx
                  .select()
                  .from(SessionTable)
                  .where(eq(target(SessionTable.id), input.parentID))
                  .get()
                if (!parent) {
                  throw new SessionImportType.ValidationError(`Parent session ${input.parentID} not found`)
                }
                if (parent.project_id !== input.projectID) {
                  throw new SessionImportType.ValidationError(
                    `Parent session ${input.parentID} belongs to a different project`,
                  )
                }
              }

              const row = yield* tx
                .select()
                .from(SessionTable)
                .where(eq(target(SessionTable.id), input.id))
                .get()

              if (row && !input.force) return { ok: true, id: input.id, skipped: true as const }

              if (row && input.force) {
                yield* tx
                  .delete(SessionTable)
                  .where(eq(target(SessionTable.id), input.id))
                  .run()
              }

              const revert = input.revert
                ? {
                    ...input.revert,
                    messageID: MessageID.make(input.revert.messageID),
                    partID: input.revert.partID ? PartID.make(input.revert.partID) : undefined,
                  }
                : undefined

              const revision = row ? row.revision + 1 : 0

              const inserted = yield* tx
                .insert(SessionTable)
                .values({
                  id: SessionID.make(input.id),
                  project_id: ProjectV2.ID.make(input.projectID),
                  workspace_id: input.workspaceID ? WorkspaceV2.ID.make(input.workspaceID) : undefined,
                  parent_id: input.parentID ? SessionID.make(input.parentID) : undefined,
                  slug: input.slug,
                  directory: input.directory,
                  title: input.title,
                  version: input.version,
                  share_url: input.shareURL,
                  summary_additions: input.summary?.additions,
                  summary_deletions: input.summary?.deletions,
                  summary_files: input.summary?.files,
                  summary_diffs: input.summary?.diffs as never,
                  revert,
                  permission: input.permission as never,
                  time_created: input.timeCreated,
                  time_updated: input.timeUpdated,
                  time_compacting: input.timeCompacting,
                  time_archived: input.timeArchived,
                  revision,
                })
                .onConflictDoUpdate({
                  target: key(SessionTable.id),
                  set: {
                    project_id: ProjectV2.ID.make(input.projectID),
                    workspace_id: input.workspaceID ? WorkspaceV2.ID.make(input.workspaceID) : undefined,
                    parent_id: input.parentID ? SessionID.make(input.parentID) : undefined,
                    slug: input.slug,
                    directory: input.directory,
                    title: input.title,
                    version: input.version,
                    share_url: input.shareURL,
                    summary_additions: input.summary?.additions,
                    summary_deletions: input.summary?.deletions,
                    summary_files: input.summary?.files,
                    summary_diffs: input.summary?.diffs as never,
                    revert,
                    permission: input.permission as never,
                    time_created: input.timeCreated,
                    time_updated: input.timeUpdated,
                    time_compacting: input.timeCompacting,
                    time_archived: input.timeArchived,
                    revision: sql`${SessionTable.revision} + 1`,
                  },
                })
                .returning({ id: SessionTable.id })
                .all()
                .pipe(Effect.orDie)

              if (inserted.length !== 1) {
                throw new SessionImportType.ValidationError(
                  `Session write affected ${inserted.length} rows, expected exactly 1 for session ${input.id}`,
                )
              }

              if (row) {
                const newRev = row.revision + 1
                yield* Changefeed.appendTx(tx, { session_id: input.id, revision: newRev, kind: "changed", time: Date.now() })
              }

              return { ok: true, id: input.id } as SessionImportType.Result
            }),
          )
          .pipe(Effect.orDie)

        return result
      }),
    )
  }

  export async function message(input: SessionImportType.Message): Promise<SessionImportType.Result> {
    return AppRuntime.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const result = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // Validate the target session exists (reject revision bump for missing sessions).
              const session = yield* tx
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionID.make(input.sessionID)))
                .get()
              if (!session) {
                throw new SessionImportType.ValidationError(`Session ${input.sessionID} not found`)
              }

              // Check whether this message ID already exists.
              const existing = yield* tx
                .select()
                .from(MessageTable)
                .where(eq(MessageTable.id, MessageID.make(input.id)))
                .get()

              if (existing) {
                // Cross-session ownership: reject without any state change.
                if (existing.session_id !== input.sessionID) {
                  throw new SessionImportType.ValidationError(
                    `Message ${input.id} belongs to session ${existing.session_id}, not ${input.sessionID}`,
                  )
                }
                // Same session, identical data → no-op, must not advance revision.
                if (isDeepStrictEqual(existing.data, input.data)) {
                  return { ok: true, id: input.id, skipped: true as const }
                }
                // Same session, different data → update in place.
                yield* tx
                  .update(MessageTable)
                  .set({ data: input.data as never })
                  .where(eq(MessageTable.id, MessageID.make(input.id)))
                  .run()
              } else {
                // New message → insert.
                yield* tx
                  .insert(MessageTable)
                  .values({
                    id: MessageID.make(input.id),
                    session_id: SessionID.make(input.sessionID),
                    time_created: input.timeCreated,
                    data: input.data as never,
                  })
                  .run()
              }

              // Advance revision exactly once for a real mutation.
              yield* SessionRevision.advanceTx(SessionID.make(input.sessionID), tx)

              return { ok: true, id: input.id } as SessionImportType.Result
            }),
          )
          .pipe(Effect.orDie)
        return result
      }),
    )
  }

  export async function part(input: SessionImportType.Part): Promise<SessionImportType.Result> {
    return AppRuntime.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const result = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // Validate the target session exists (reject revision bump for missing sessions).
              const session = yield* tx
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionID.make(input.sessionID)))
                .get()
              if (!session) {
                throw new SessionImportType.ValidationError(`Session ${input.sessionID} not found`)
              }

              // Validate the referenced message exists and belongs to this session.
              const msgRow = yield* tx
                .select()
                .from(MessageTable)
                .where(eq(MessageTable.id, MessageID.make(input.messageID)))
                .get()
              if (!msgRow) {
                throw new SessionImportType.ValidationError(`Message ${input.messageID} not found`)
              }
              if (msgRow.session_id !== input.sessionID) {
                throw new SessionImportType.ValidationError(
                  `Message ${input.messageID} belongs to session ${msgRow.session_id}, not ${input.sessionID}`,
                )
              }

              // Check whether this part ID already exists.
              const existing = yield* tx
                .select()
                .from(PartTable)
                .where(eq(PartTable.id, PartID.make(input.id)))
                .get()

              if (existing) {
                // Cross-message ownership: reject without any state change.
                if (existing.message_id !== MessageID.make(input.messageID)) {
                  throw new SessionImportType.ValidationError(
                    `Part ${input.id} belongs to message ${existing.message_id}, not ${input.messageID}`,
                  )
                }
                // Existing part must also belong to the requested session.
                if (existing.session_id !== input.sessionID) {
                  throw new SessionImportType.ValidationError(
                    `Part ${input.id} belongs to session ${existing.session_id}, not ${input.sessionID}`,
                  )
                }
                // Same message, identical data → no-op, must not advance revision.
                if (isDeepStrictEqual(existing.data, input.data)) {
                  return { ok: true, id: input.id, skipped: true as const }
                }
                // Same message, different data → update in place.
                yield* tx
                  .update(PartTable)
                  .set({ data: input.data as never })
                  .where(eq(PartTable.id, PartID.make(input.id)))
                  .run()
              } else {
                // New part → insert.
                yield* tx
                  .insert(PartTable)
                  .values({
                    id: PartID.make(input.id),
                    message_id: MessageID.make(input.messageID),
                    session_id: SessionID.make(input.sessionID),
                    time_created: input.timeCreated,
                    data: input.data as never,
                  })
                  .run()
              }

              // Advance revision exactly once for a real mutation.
              yield* SessionRevision.advanceTx(SessionID.make(input.sessionID), tx)

              return { ok: true, id: input.id } as SessionImportType.Result
            }),
          )
          .pipe(Effect.orDie)
        return result
      }),
    )
  }
}
