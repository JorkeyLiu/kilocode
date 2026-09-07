import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import * as Changefeed from "@opencode-ai/core/retention/changefeed"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
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
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

describe("creation changefeed - ordinary projector", () => {
  it.effect("successful SessionV2.create emits exactly one durable changed@0", () =>
    Effect.gen(function* () {
      const svc = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const s = yield* svc.create({ location })
      const feed = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, s.id)).all().pipe(Effect.orDie)
      expect(feed.length).toBe(1)
      expect(feed[0]!.session_id).toBe(s.id)
      expect(feed[0]!.revision).toBe(0)
      expect(feed[0]!.kind).toBe("changed")
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, s.id)).get().pipe(Effect.orDie)
      expect(row!.revision).toBe(0)
    }),
  )

  it.effect("failed insert rolled back emits none", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sid = SessionV2.ID.create()
      const before = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie)
      expect(before.length).toBe(0)
      const exit = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(SessionTable)
              .values({
                id: sid,
                project_id: ProjectV2.ID.global,
                slug: "test",
                directory: "/project",
                title: "rollback",
                version: "v2",
                time_created: Date.now(),
                time_updated: Date.now(),
                revision: 0,
              } as any)
              .run()
              .pipe(Effect.orDie)
            yield* Changefeed.appendTx(tx as any, { session_id: sid, revision: 0, kind: "changed", time: Date.now() })
            yield* Effect.die(new Error("forced rollback"))
          }),
        )
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      const after = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid)).all().pipe(Effect.orDie)
      expect(after.length).toBe(0)
      const sess = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sid)).get().pipe(Effect.orDie)
      expect(sess).toBeUndefined()
    }),
  )

  it.effect("idempotent replay does not consume another sequence", () =>
    Effect.gen(function* () {
      const svc = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const id = SessionV2.ID.create()
      const first = yield* svc.create({ id, location })
      const feed1 = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, id)).all().pipe(Effect.orDie)
      expect(feed1.length).toBe(1)
      const seq1 = feed1[0]!.seq
      const second = yield* svc.create({ id, location })
      expect(second.id).toBe(first.id)
      const feed2 = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, id)).all().pipe(Effect.orDie)
      expect(feed2.length).toBe(1)
      expect(feed2[0]!.seq).toBe(seq1)
      // next distinct session must be exactly +1, proving no seq consumed
      const other = yield* svc.create({ location })
      const otherFeed = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, other.id)).all().pipe(Effect.orDie)
      expect(otherFeed[0]!.seq).toBe(seq1 + 1)
    }),
  )

  it.effect("duplicate appendTx directly is idempotent without gap", () =>
    Effect.gen(function* () {
      const svc = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const s = yield* svc.create({ location })
      const existing = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, s.id)).all().pipe(Effect.orDie)
      expect(existing.length).toBe(1)
      const dup = yield* Changefeed.appendTx(db as any, { session_id: s.id, revision: 0, kind: "changed", time: Date.now() })
      expect(dup.seq).toBe(existing[0]!.seq)
      const after = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, s.id)).all().pipe(Effect.orDie)
      expect(after.length).toBe(1)
    }),
  )
})
