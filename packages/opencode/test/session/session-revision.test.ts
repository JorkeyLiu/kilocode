import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database as CoreDatabase } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable, SessionContextEpochTable } from "@opencode-ai/core/session/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Deferred, Effect, DateTime, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Session as SessionNs } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import * as SandboxState from "@/kilocode/sandbox/state"
import { Todo } from "@/session/todo"
import * as Ownership from "@/retention/ownership"

/** Read the raw revision column for a session. */
function readRevision(db: CoreDatabase.Interface["db"], id: SessionID) {
  return db
    .select({ revision: SessionTable.revision })
    .from(SessionTable)
    .where(eq(SessionTable.id, id))
    .get()
    .pipe(Effect.orDie)
    .pipe(Effect.map((row) => row?.revision))
}

const ownership = Ownership.layer
const status = SessionStatus.defaultLayer
const bg = BackgroundJob.defaultLayer
const runState = SessionRunState.layer.pipe(Layer.provide(status), Layer.provide(bg), Layer.provide(ownership))
const sessionLayer = SessionNs.layer.pipe(
  Layer.provide(runState),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(CoreDatabase.defaultLayer),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
  Layer.provide(SessionProjector.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
  Layer.provide(ownership),
  Layer.provide(bg),
)

const it = testEffect(
  Layer.mergeAll(
    CoreDatabase.defaultLayer,
    EventV2.defaultLayer,
    sessionLayer,
    runState,
    status,
    bg,
    ownership,
    Todo.layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provide(CoreDatabase.defaultLayer)),
    testInstanceStoreLayer,
  ),
)

describe("session revision lifecycle", () => {
  describe("created event", () => {
    it.instance("inserts session with revision 0", () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { db } = yield* CoreDatabase.Service
        const info = yield* Effect.acquireRelease(session.create({ title: "rev-test" }), (s) =>
          session.remove(s.id).pipe(Effect.ignore),
        )
        const rev = yield* readRevision(db, info.id)
        expect(rev).toBe(0)
      }),
    )
  })

  describe("updated event", () => {
    it.instance("advances revision on setTitle", () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { db } = yield* CoreDatabase.Service
        const info = yield* Effect.acquireRelease(session.create({ title: "initial" }), (s) =>
          session.remove(s.id).pipe(Effect.ignore),
        )
        const before = yield* readRevision(db, info.id)
        yield* session.setTitle({ sessionID: info.id, title: "updated" })
        const after = yield* readRevision(db, info.id)
        expect(after).toBe(before! + 1)
        const fetched = yield* session.get(info.id)
        expect(fetched.title).toBe("updated")
      }),
    )

    it.instance("advances revision on setMetadata", () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { db } = yield* CoreDatabase.Service
        const info = yield* Effect.acquireRelease(session.create({ title: "meta-test" }), (s) =>
          session.remove(s.id).pipe(Effect.ignore),
        )
        const before = yield* readRevision(db, info.id)
        yield* session.setMetadata({ sessionID: info.id, metadata: { key: "value" } })
        const after = yield* readRevision(db, info.id)
        expect(after).toBe(before! + 1)
        const fetched = yield* session.get(info.id)
        expect(fetched.metadata).toEqual({ key: "value" })
      }),
    )

    it.instance("advances revision on setArchived", () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { db } = yield* CoreDatabase.Service
        const info = yield* Effect.acquireRelease(session.create({ title: "archive-test" }), (s) =>
          session.remove(s.id).pipe(Effect.ignore),
        )
        const before = yield* readRevision(db, info.id)
        yield* session.setArchived({ sessionID: info.id, time: Date.now() })
        const after = yield* readRevision(db, info.id)
        expect(after).toBe(before! + 1)
        const fetched = yield* session.get(info.id)
        expect(fetched.time.archived).toBeDefined()
      }),
    )

    it.instance("advances revision on touch", () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { db } = yield* CoreDatabase.Service
        const info = yield* Effect.acquireRelease(session.create({ title: "touch-test" }), (s) =>
          session.remove(s.id).pipe(Effect.ignore),
        )
        const before = yield* readRevision(db, info.id)
        yield* Effect.sleep("5 millis")
        yield* session.touch(info.id)
        const after = yield* readRevision(db, info.id)
        expect(after).toBe(before! + 1)
      }),
    )
  })

  describe("message events", () => {
    it.instance("advances revision on MessageUpdated", () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { db } = yield* CoreDatabase.Service
        const info = yield* Effect.acquireRelease(session.create({ title: "msg-test" }), (s) =>
          session.remove(s.id).pipe(Effect.ignore),
        )
        const before = yield* readRevision(db, info.id)
        const msgID = MessageID.ascending()
        yield* session.updateMessage({
          id: msgID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)
        const after = yield* readRevision(db, info.id)
        expect(after).toBe(before! + 1)
        const msgs = yield* session.messages({ sessionID: info.id })
        expect(msgs.length).toBeGreaterThanOrEqual(1)
      }),
    )

    it.instance("advances revision on MessageRemoved", () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { db } = yield* CoreDatabase.Service
        const info = yield* Effect.acquireRelease(session.create({ title: "msg-remove" }), (s) =>
          session.remove(s.id).pipe(Effect.ignore),
        )
        const msgID = MessageID.ascending()
        yield* session.updateMessage({
          id: msgID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)
        const before = yield* readRevision(db, info.id)
        yield* session.removeMessage({ sessionID: info.id, messageID: msgID })
        const after = yield* readRevision(db, info.id)
        expect(after).toBe(before! + 1)
        const msgs = yield* session.messages({ sessionID: info.id })
        expect(msgs.length).toBe(0)
      }),
    )

    it.instance("advances revision on PartUpdated", () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { db } = yield* CoreDatabase.Service
        const info = yield* Effect.acquireRelease(session.create({ title: "part-test" }), (s) =>
          session.remove(s.id).pipe(Effect.ignore),
        )
        const msgID = MessageID.ascending()
        yield* session.updateMessage({
          id: msgID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)
        const before = yield* readRevision(db, info.id)
        const partID = PartID.ascending()
        yield* session.updatePart({
          id: partID,
          messageID: msgID,
          sessionID: info.id,
          type: "text",
          text: "hello",
        } as unknown as SessionV1.Part)
        const after = yield* readRevision(db, info.id)
        expect(after).toBe(before! + 1)
        const part = yield* session.getPart({ sessionID: info.id, messageID: msgID, partID })
        expect(part).toBeDefined()
      }),
    )

    it.instance("advances revision on PartRemoved", () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { db } = yield* CoreDatabase.Service
        const info = yield* Effect.acquireRelease(session.create({ title: "part-remove" }), (s) =>
          session.remove(s.id).pipe(Effect.ignore),
        )
        const msgID = MessageID.ascending()
        yield* session.updateMessage({
          id: msgID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)
        const partID = PartID.ascending()
        yield* session.updatePart({
          id: partID,
          messageID: msgID,
          sessionID: info.id,
          type: "text",
          text: "hello",
        } as unknown as SessionV1.Part)
        const before = yield* readRevision(db, info.id)
        yield* session.removePart({ sessionID: info.id, messageID: msgID, partID })
        const after = yield* readRevision(db, info.id)
        expect(after).toBe(before! + 1)
        const part = yield* session.getPart({ sessionID: info.id, messageID: msgID, partID })
        expect(part).toBeUndefined()
      }),
    )

    it.instance("advances revision on Retried event", () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { db } = yield* CoreDatabase.Service
        const events = yield* EventV2.Service
        const info = yield* Effect.acquireRelease(session.create({ title: "retried-test" }), (s) =>
          session.remove(s.id).pipe(Effect.ignore),
        )
        const before = yield* readRevision(db, info.id)
        yield* events.publish(SessionEvent.Retried, {
          sessionID: info.id,
          timestamp: DateTime.makeUnsafe(Date.now()),
          attempt: 1,
          error: { message: "test error", isRetryable: true },
        })
        const after = yield* readRevision(db, info.id)
        expect(after).toBe(before! + 1)
      }),
    )
  })

  describe("delete semantics", () => {
    it.instance("delete removes session row entirely", () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const info = yield* Effect.acquireRelease(session.create({ title: "delete-test" }), (s) =>
          session.remove(s.id).pipe(Effect.ignore),
        )
        yield* session.setTitle({ sessionID: info.id, title: "before-delete" })
        const before = yield* session.get(info.id)
        expect(before.title).toBe("before-delete")
        yield* session.remove(info.id)
        const exit = yield* session.get(info.id).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    )
  })

  describe("monotonic revision", () => {
    it.instance("repeated mutations produce strictly increasing revision", () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { db } = yield* CoreDatabase.Service
        const info = yield* Effect.acquireRelease(session.create({ title: "mono-test" }), (s) =>
          session.remove(s.id).pipe(Effect.ignore),
        )
        const revisions: number[] = []
        revisions.push((yield* readRevision(db, info.id))!)
        for (let i = 0; i < 5; i++) {
          yield* Effect.sleep("2 millis")
          yield* session.setTitle({ sessionID: info.id, title: `title-${i}` })
          revisions.push((yield* readRevision(db, info.id))!)
        }
        for (let i = 1; i < revisions.length; i++) {
          expect(revisions[i]).toBe(revisions[i - 1] + 1)
        }
      }),
    )
  })

  describe("sandbox metadata writer", () => {
    it.instance("SandboxState.write persists metadata and advances revision", () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { db } = yield* CoreDatabase.Service
        const info = yield* Effect.acquireRelease(session.create({ title: "sandbox-rev" }), (s) =>
          session.remove(s.id).pipe(Effect.ignore),
        )
        const before = yield* readRevision(db, info.id)
        yield* SandboxState.write(info.id, { enabled: true, version: 1 })
        const value = yield* SandboxState.read(info.id)
        expect(value).toEqual({ enabled: true, version: 1 })
        const after = yield* readRevision(db, info.id)
        expect(after).toBe(before! + 1)
      }),
    )

    it.instance("SandboxState.clear removes sandbox key and advances revision", () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { db } = yield* CoreDatabase.Service
        const info = yield* Effect.acquireRelease(session.create({ title: "sandbox-clear" }), (s) =>
          session.remove(s.id).pipe(Effect.ignore),
        )
        yield* SandboxState.write(info.id, { enabled: true, version: 1 })
        const before = yield* readRevision(db, info.id)
        yield* SandboxState.clear(info.id)
        const value = yield* SandboxState.read(info.id)
        expect(value).toBeUndefined()
        const after = yield* readRevision(db, info.id)
        expect(after).toBe(before! + 1)
      }),
    )
  })

  describe("todo writer revision", () => {
    it.instance("Todo.update advances revision (including empty replacement)", () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const { db } = yield* CoreDatabase.Service
        const todo = yield* Todo.Service
        const info = yield* Effect.acquireRelease(session.create({ title: "todo-rev" }), (s) =>
          session.remove(s.id).pipe(Effect.ignore),
        )
        const before0 = yield* readRevision(db, info.id)
        // Insert initial todos
        yield* todo.update({
          sessionID: info.id,
          todos: [
            { content: "task1", status: "pending", priority: "high" },
            { content: "task2", status: "in_progress", priority: "medium" },
          ],
        })
        const after1 = yield* readRevision(db, info.id)
        expect(after1).toBe(before0! + 1)
        // Replace with empty list (empty replacement must still advance revision)
        const before2 = yield* readRevision(db, info.id)
        yield* todo.update({ sessionID: info.id, todos: [] })
        const after2 = yield* readRevision(db, info.id)
        expect(after2).toBe(before2! + 1)
        // Verify todos are cleared
        const result = yield* todo.get(info.id)
        expect(result.length).toBe(0)
      }),
    )
  })

  describe("missing session rollback", () => {
    it.effect("SandboxState.write fails when session does not exist", () =>
      Effect.gen(function* () {
        const fakeID = SessionID.make("ses_nonexistent_" + Date.now())
        const exit = yield* SandboxState.write(fakeID, { enabled: true, version: 1 }).pipe(Effect.exit)
        // The transaction returns early (no session found), but revision advance
        // still runs and fails because the session doesn't exist.
        // The outer Effect.orDie converts this to a Die/Failure.
        expect(exit._tag).toBe("Failure")
      }),
    )

    it.effect("SandboxState.clear fails when session does not exist", () =>
      Effect.gen(function* () {
        const fakeID = SessionID.make("ses_nonexistent_clear_" + Date.now())
        const exit = yield* SandboxState.clear(fakeID).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    )
  })

  describe("post-projector fault injection", () => {
    it.effect("injected failure after Moved projector leaves all Moved-affected fields unchanged", () =>
      Effect.gen(function* () {
        const { db } = yield* CoreDatabase.Service
        const events = yield* EventV2.Service

        const projectID = ProjectV2.ID.make("proj_test")
        yield* db
          .insert(ProjectTable)
          .values({ id: projectID, worktree: "/test" as never, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)

        const sessionID = SessionID.make("ses_fault_" + Date.now())
        const now = Date.now()
        yield* events.publish(SessionV1.Event.Created, {
          sessionID,
          info: {
            id: sessionID,
            projectID,
            slug: "fault-test",
            directory: "/test",
            title: "rollback-test",
            version: "v1",
            time: { created: now, updated: now },
          },
        })

        const preRow = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID as never))
          .get()
          .pipe(Effect.orDie)
        expect(preRow).toBeDefined()
        expect(preRow!.revision).toBe(0)
        expect(preRow!.title).toBe("rollback-test")
        expect(preRow!.directory).toBe("/test")
        expect(preRow!.path).toBeNull()
        expect(preRow!.workspace_id).toBeNull()

        const mergedLayer = Layer.mergeAll(
          Layer.succeed(CoreDatabase.Service, yield* CoreDatabase.Service),
          Layer.succeed(EventV2.Service, events),
        )
        const publishEffect = events
          .publish(
            SessionEvent.Moved,
            {
              sessionID,
              timestamp: DateTime.makeUnsafe(now + 1000),
              location: { directory: "/new/path" as never, workspaceID: "ws_new" as never },
              subdirectory: "sub" as never,
            },
            {
              commit: () => Effect.die("injected fault after projectors"),
            },
          )
          .pipe(Effect.provide(mergedLayer))
        const exit = yield* Effect.promise(() => Effect.runPromiseExit(publishEffect))
        expect(exit._tag).toBe("Failure")

        const postRow = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID as never))
          .get()
          .pipe(Effect.orDie)
        expect(postRow).toBeDefined()
        expect(postRow!.revision).toBe(0)
        expect(postRow!.title).toBe("rollback-test")
        expect(postRow!.directory).toBe("/test")
        expect(postRow!.path).toBeNull()
        expect(postRow!.workspace_id).toBeNull()
        expect(postRow!.time_updated).toBe(now)

        const eventRows = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID as never))
          .all()
          .pipe(Effect.orDie)
        expect(eventRows.length).toBe(1)
        expect(eventRows[0].type).toBe("session.created.1")

        const seqRow = yield* db
          .select()
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, sessionID as never))
          .get()
          .pipe(Effect.orDie)
        expect(seqRow).toBeDefined()
        expect(seqRow!.seq).toBe(0)

        const epochRow = yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID as never))
          .get()
          .pipe(Effect.orDie)
        expect(epochRow).toBeUndefined()
      }),
    )
  })
})

describe("migration backfill", () => {
  it.instance("fresh insert gets revision 0", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const { db } = yield* CoreDatabase.Service
      const info = yield* session.create({ title: "migration-backfill" })
      const rev = yield* readRevision(db, info.id)
      expect(rev).toBe(0)
      yield* session.remove(info.id)
    }),
  )
})
