import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SnapshotJournal } from "@/snapshot/journal"

// Memory-backed Database + SnapshotJournal for tool tests. The journal rows
// carry a session FK, so tests must seed their fake session IDs via
// ensureJournalSession before executing edit/write/apply_patch.
const memory = Database.layerFromPath(":memory:")

export const JournalMemory = Layer.mergeAll(
  memory,
  SnapshotJournal.layer.pipe(Layer.provide(memory), Layer.provide(FSUtil.defaultLayer)),
)

export const ensureJournalSession = (sessionID: string, projectID = "proj_journal-test", dir = "/tmp/journal-test") =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: projectID as never, worktree: "/tmp/journal-test" as never, sandboxes: [] as never, vcs: "git" as never })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID as never,
        project_id: projectID as never,
        slug: "journal-test",
        directory: dir as never,
        title: "journal-test",
        version: "1",
      })
      .onConflictDoNothing()
      .run()
  }).pipe(Effect.orDie)
