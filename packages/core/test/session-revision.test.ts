import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTodo } from "@opencode-ai/core/session/todo"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionRevision } from "@opencode-ai/core/session/revision"
import { SessionV1 } from "@opencode-ai/core/v1/session"
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
const todos = SessionTodo.layer.pipe(Layer.provide(database), Layer.provide(events))
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projects),
  Layer.provide(SessionExecution.noopLayer),
)
const it = testEffect(
  Layer.mergeAll(database, events, projects, projector, store, SessionExecution.noopLayer, sessions, todos),
)
const location = { directory: AbsolutePath.make("/project") }
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }

async function getRevision(db: Database.Interface["db"], sessionID: string) {
  const row = await Effect.runPromise(
    db
      .select({ revision: SessionTable.revision })
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionV2.ID.make(sessionID)))
      .get()
      .pipe(Effect.orDie),
  )
  return row?.revision ?? -1
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
})

describe("Session revision (P4.2a S1)", () => {
  it.effect("create initializes revision at 0", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      expect(yield* Effect.promise(() => getRevision(db, created.id))).toBe(0)
    }),
  )

  it.effect("agent switch advances revision", () =>
    Effect.gen(function* () {
      yield* setup
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })

      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID: created.id,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(0),
        agent: "build",
      })

      expect(yield* Effect.promise(() => getRevision(db, created.id))).toBe(1)
    }),
  )

  it.effect("model switch advances revision", () =>
    Effect.gen(function* () {
      yield* setup
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })

      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID: created.id,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(0),
        model: ModelV2.Ref.make({ id: ModelV2.ID.make("other"), providerID: ProviderV2.ID.make("prov") }),
      })

      expect(yield* Effect.promise(() => getRevision(db, created.id))).toBe(1)
    }),
  )

  it.effect("context mutation advances revision", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      yield* events.publish(SessionEvent.Synthetic, {
        sessionID: created.id,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(0),
        text: "synthetic",
      })

      expect(yield* Effect.promise(() => getRevision(db, created.id))).toBe(1)
    }),
  )

  it.effect("todo mutation advances revision atomically", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const todoService = yield* SessionTodo.Service
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })

      yield* todoService.update({
        sessionID: created.id,
        todos: [{ content: "task1", status: "pending", priority: "high" }],
      })

      const revision = yield* Effect.promise(() => getRevision(db, created.id))
      expect(revision).toBe(1)

      const result = yield* todoService.get(created.id)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe("task1")
    }),
  )

  it.effect("revision is monotonic across repeated mutations", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      for (let i = 0; i < 5; i++) {
        yield* events.publish(SessionEvent.Synthetic, {
          sessionID: created.id,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(i),
          text: `iteration ${i}`,
        })
      }

      const revision = yield* Effect.promise(() => getRevision(db, created.id))
      expect(revision).toBe(5)
    }),
  )

  it.effect("failed transaction leaves revision unchanged", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const before = yield* Effect.promise(() => getRevision(db, created.id))

      // First event should succeed
      yield* events.publish(SessionEvent.Prompted, {
        sessionID: created.id,
        messageID: SessionMessage.ID.make("msg_first_fail"),
        timestamp: DateTime.makeUnsafe(0),
        prompt: new Prompt({ text: "first" }),
        delivery: "steer",
      })

      // Same message ID again should fail (PromptAlreadyProjected)
      const exit = yield* events
        .publish(SessionEvent.Prompted, {
          sessionID: created.id,
          messageID: SessionMessage.ID.make("msg_first_fail"),
          timestamp: DateTime.makeUnsafe(0),
          prompt: new Prompt({ text: "duplicate" }),
          delivery: "steer",
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")

      // Revision should be 1 from the first successful event, not 2
      const after = yield* Effect.promise(() => getRevision(db, created.id))
      expect(after).toBe(1)
    }),
  )

  it.effect("prompted advances revision exactly once and writes session_input", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const msgID = SessionMessage.ID.make("msg_prompted_rev")
      const prompt = new Prompt({ text: "hello" })

      const before = yield* Effect.promise(() => getRevision(db, created.id))
      expect(before).toBe(0)

      yield* events.publish(SessionEvent.Prompted, {
        sessionID: created.id,
        messageID: msgID,
        timestamp: DateTime.makeUnsafe(0),
        prompt,
        delivery: "steer",
      })

      const after = yield* Effect.promise(() => getRevision(db, created.id))
      expect(after).toBe(1)

      const row = yield* db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.id, msgID))
        .get()
        .pipe(Effect.orDie)
      expect(row).toBeDefined()
      expect(row!.session_id).toBe(created.id)
      expect(row!.delivery).toBe("steer")
      expect(row!.promoted_seq).not.toBeNull()
    }),
  )

  it.effect("prompted duplicate fails without partial write or revision advance", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const msgID = SessionMessage.ID.make("msg_prompted_dup")

      yield* events.publish(SessionEvent.Prompted, {
        sessionID: created.id,
        messageID: msgID,
        timestamp: DateTime.makeUnsafe(0),
        prompt: new Prompt({ text: "first" }),
        delivery: "steer",
      })
      expect(yield* Effect.promise(() => getRevision(db, created.id))).toBe(1)

      const exit = yield* events
        .publish(SessionEvent.Prompted, {
          sessionID: created.id,
          messageID: msgID,
          timestamp: DateTime.makeUnsafe(0),
          prompt: new Prompt({ text: "duplicate" }),
          delivery: "steer",
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(yield* Effect.promise(() => getRevision(db, created.id))).toBe(1)
    }),
  )

  it.effect("concurrent mutations produce distinct revisions", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      yield* Effect.all(
        [
          events.publish(SessionEvent.Synthetic, {
            sessionID: created.id,
            messageID: SessionMessage.ID.make("msg_conc_1"),
            timestamp: DateTime.makeUnsafe(0),
            text: "first",
          }),
          events.publish(SessionEvent.Synthetic, {
            sessionID: created.id,
            messageID: SessionMessage.ID.make("msg_conc_2"),
            timestamp: DateTime.makeUnsafe(0),
            text: "second",
          }),
        ],
        { concurrency: "unbounded" },
      )

      const revision = yield* Effect.promise(() => getRevision(db, created.id))
      expect(revision).toBe(2)
    }),
  )

  it.effect("retried event advances revision", () =>
    Effect.gen(function* () {
      yield* setup
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })

      yield* events.publish(SessionEvent.Retried, {
        sessionID: created.id,
        timestamp: DateTime.makeUnsafe(0),
        attempt: 1,
        error: { message: "rate limited", isRetryable: true },
      })

      expect(yield* Effect.promise(() => getRevision(db, created.id))).toBe(1)
    }),
  )

  it.effect("todo empty replacement advances revision", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const todoService = yield* SessionTodo.Service
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })

      // First: populate todos
      yield* todoService.update({
        sessionID: created.id,
        todos: [{ content: "task1", status: "pending", priority: "high" }],
      })
      expect(yield* Effect.promise(() => getRevision(db, created.id))).toBe(1)

      // Replace with empty list — should still advance revision
      yield* todoService.update({ sessionID: created.id, todos: [] })
      expect(yield* Effect.promise(() => getRevision(db, created.id))).toBe(2)

      const result = yield* todoService.get(created.id)
      expect(result).toHaveLength(0)
    }),
  )

  it.effect("delete removes session row entirely (absence)", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const now = Date.now()

      // Verify session exists
      expect(yield* Effect.promise(() => getRevision(db, created.id))).toBe(0)

      // Publish delete event — projector removes the row
      yield* events.publish(SessionV1.Event.Deleted, {
        sessionID: created.id,
        info: {
          id: created.id,
          projectID: Project.ID.global,
          slug: "del-test",
          directory: "/project",
          title: "to-delete",
          version: "v1",
          time: { created: now, updated: now },
        },
      })

      // Verify session row is gone (hard delete, no tombstone)
      const row = yield* Effect.promise(() =>
        Effect.runPromise(
          db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, SessionV2.ID.make(created.id)))
            .get()
            .pipe(Effect.orDie),
        ),
      )
      expect(row).toBeUndefined()
    }),
  )

  it.effect("advance rolls back on zero-row (nonexistent session)", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const fakeID = SessionV2.ID.make("ses_nonexistent_adv_" + Date.now())
      const exit = yield* db.transaction((tx) => SessionRevision.advanceTx(fakeID, tx)).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("advance proves exactly one affected row on success", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const before = yield* Effect.promise(() => getRevision(db, created.id))
      expect(before).toBe(0)
      yield* db.transaction((tx) => SessionRevision.advanceTx(created.id, tx)).pipe(Effect.orDie)
      const after = yield* Effect.promise(() => getRevision(db, created.id))
      expect(after).toBe(1)
    }),
  )

  it.effect("todo update on missing session fails atomically (empty replacement)", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const session = yield* SessionV2.Service
      const todoService = yield* SessionTodo.Service
      const created = yield* session.create({ location })

      // Delete the session so the row no longer exists.
      const now = Date.now()
      yield* events.publish(SessionV1.Event.Deleted, {
        sessionID: created.id,
        info: {
          id: created.id,
          projectID: Project.ID.global,
          slug: "del-todo",
          directory: "/project",
          title: "to-delete",
          version: "v1",
          time: { created: now, updated: now },
        },
      })

      // Verify session row is gone.
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, created.id)).get().pipe(Effect.orDie)
      expect(row).toBeUndefined()

      // Empty todo update on missing session must fail atomically.
      const exit = yield* todoService.update({ sessionID: created.id, todos: [] }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )
})
