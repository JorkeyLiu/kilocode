import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionRevision } from "@opencode-ai/core/session/revision"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projects = Layer.succeed(
  Project.Service,
  Project.Service.of({
    resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projects),
  Layer.provide(SessionExecution.noopLayer),
)
const it = testEffect(Layer.mergeAll(database, events, projects, projector, store, SessionExecution.noopLayer, sessions))
const location = { directory: AbsolutePath.make("/project") }
const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run().pipe(Effect.orDie)
})

describe("SessionRevision B0", () => {
  it.effect("get returns 0 initially and typed missing error for unknown session", () =>
    Effect.gen(function* () {
      yield* setup
      const svc = yield* SessionV2.Service
      const s = yield* svc.create({ location })
      const { db } = yield* Database.Service
      const rev = yield* SessionRevision.get(db, s.id)
      expect(rev).toBe(0)
      const missing = SessionSchema.ID.make("ses_missing_12345678901234567890")
      const exit = yield* SessionRevision.get(db, missing).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const err = (exit.cause as unknown as { _tag: string })._tag
        // Should be RevisionNotFoundError
        expect(String(exit.cause)).toContain("Session not found")
      }
    }),
  )

  it.effect("advance increments and getTx inside transaction shows same", () =>
    Effect.gen(function* () {
      yield* setup
      const svc = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const s = yield* svc.create({ location })
      const before = yield* SessionRevision.get(db, s.id)
      expect(before).toBe(0)
      yield* db.transaction((tx) => SessionRevision.advanceTx(s.id, tx as unknown as typeof db))
      const after = yield* SessionRevision.get(db, s.id)
      expect(after).toBe(1)
      const txRev = yield* db.transaction((tx) => SessionRevision.getTx(tx as unknown as typeof db, s.id))
      expect(txRev).toBe(1)
    }),
  )
})
