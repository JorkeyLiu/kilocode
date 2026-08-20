import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { Session as SessionNs } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as Ownership from "@/retention/ownership"

void Log.init({ print: false })

const ownership = Ownership.layer
const status = SessionStatus.defaultLayer
const bg = BackgroundJob.defaultLayer
const runState = SessionRunState.layer.pipe(Layer.provide(status), Layer.provide(bg), Layer.provide(ownership))
const sessionLayer = SessionNs.layer.pipe(
  Layer.provide(runState),
  Layer.provideMerge(Storage.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
  Layer.provide(SessionProjector.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
  Layer.provide(ownership),
  Layer.provide(bg),
)

const it = testEffect(
  Layer.mergeAll(
    sessionLayer,
    runState,
    status,
    bg,
    ownership,
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)

// The seeded storage files live in the real global storage dir (Session/Storage use
// Storage.defaultLayer), so clean them on scope close even when the assertion fails;
// Storage.remove is idempotent on already-removed keys.
const seeded = (storage: Storage.Interface, sessionID: SessionID) =>
  Effect.addFinalizer(() =>
    Effect.all(
      [storage.remove(["session_diff", sessionID]), storage.remove(["session_diff_base", sessionID])],
      { discard: true },
    ).pipe(Effect.ignore),
  )

describe("Session.remove storage cleanup", () => {
  it.instance("removes session_diff and session_diff_base files", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const storage = yield* Storage.Service
      const session = yield* sessions.create({ title: "remove-storage" })
      yield* seeded(storage, session.id)

      yield* storage.write(["session_diff", session.id], [{ file: "a.ts", additions: 1, deletions: 0 }])
      yield* storage.write(["session_diff_base", session.id], [{ file: "a.ts", additions: 1, deletions: 0 }])

      yield* sessions.remove(session.id)

      expect(Exit.isFailure(yield* storage.read(["session_diff", session.id]).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* storage.read(["session_diff_base", session.id]).pipe(Effect.exit))).toBe(true)
    }),
  )

  it.instance("succeeds when either diff file is already absent", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const storage = yield* Storage.Service
      const session = yield* sessions.create({ title: "remove-storage-missing" })
      yield* seeded(storage, session.id)

      // Only session_diff exists; session_diff_base never did.
      yield* storage.write(["session_diff", session.id], [{ file: "b.ts", additions: 2, deletions: 1 }])

      yield* sessions.remove(session.id)

      expect(Exit.isFailure(yield* storage.read(["session_diff", session.id]).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* storage.read(["session_diff_base", session.id]).pipe(Effect.exit))).toBe(true)
    }),
  )

  it.instance("recursively removes child session diff artifacts", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const storage = yield* Storage.Service
      const parent = yield* sessions.create({ title: "remove-storage-parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "remove-storage-child" })
      yield* seeded(storage, parent.id)
      yield* seeded(storage, child.id)

      yield* storage.write(["session_diff", parent.id], [{ file: "a.ts", additions: 1, deletions: 0 }])
      yield* storage.write(["session_diff_base", parent.id], [{ file: "a.ts", additions: 1, deletions: 0 }])
      yield* storage.write(["session_diff", child.id], [{ file: "b.ts", additions: 2, deletions: 1 }])
      yield* storage.write(["session_diff_base", child.id], [{ file: "b.ts", additions: 2, deletions: 1 }])

      yield* sessions.remove(parent.id)

      // remove recurses into children first, so both the parent's and the child's
      // orphaned artifacts are cleaned up together.
      for (const id of [parent.id, child.id]) {
        expect(Exit.isFailure(yield* storage.read(["session_diff", id]).pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* storage.read(["session_diff_base", id]).pipe(Effect.exit))).toBe(true)
      }
    }),
  )

  it.instance("leaves other sessions' diff artifacts intact", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const storage = yield* Storage.Service
      const a = yield* sessions.create({ title: "remove-storage-a" })
      const b = yield* sessions.create({ title: "remove-storage-b" })
      yield* seeded(storage, a.id)
      yield* seeded(storage, b.id)

      yield* storage.write(["session_diff", a.id], [{ file: "a.ts", additions: 1, deletions: 0 }])
      yield* storage.write(["session_diff", b.id], [{ file: "b.ts", additions: 2, deletions: 1 }])
      yield* storage.write(["session_diff_base", b.id], [{ file: "b.ts", additions: 2, deletions: 1 }])

      yield* sessions.remove(a.id)

      expect(Exit.isFailure(yield* storage.read(["session_diff", a.id]).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* storage.read(["session_diff_base", a.id]).pipe(Effect.exit))).toBe(true)
      // Retained sessions stay lossless (LOCK-002): B's artifacts are untouched.
      expect(yield* storage.read(["session_diff", b.id])).toEqual([{ file: "b.ts", additions: 2, deletions: 1 }])
      expect(yield* storage.read(["session_diff_base", b.id])).toEqual([{ file: "b.ts", additions: 2, deletions: 1 }])
    }),
  )

  it.instance("completes and keeps the DB deletion when artifact removal genuinely fails", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const storage = yield* Storage.Service
      const session = yield* sessions.create({ title: "remove-storage-failure" })
      yield* seeded(storage, session.id)

      // Turn the artifact into a non-empty directory so Storage.remove hits a
      // genuine non-ENOENT error (fs.rm without recursive on a non-empty dir),
      // which the implementation logs and absorbs without invalidating the
      // already-completed DB deletion (LOCK-004). The log line itself is not
      // asserted here: the custom Log util writes through rotating-file-stream
      // with no in-process capture hook, so asserting it would be brittle logger
      // interception.
      yield* storage.write(["session_diff", session.id], [{ file: "a.ts", additions: 1, deletions: 0 }])
      const target = path.join(Global.Path.data, "storage", "session_diff", session.id + ".json")
      yield* Effect.promise(async () => {
        await fs.rm(target)
        await fs.mkdir(target)
        await Bun.write(path.join(target, "nested"), "x")
      })
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(target, { recursive: true, force: true })).pipe(Effect.ignore),
      )

      expect(Exit.isSuccess(yield* sessions.remove(session.id).pipe(Effect.exit))).toBe(true)
      // The DB deletion completed despite the storage failure.
      expect(Exit.isFailure(yield* sessions.get(session.id).pipe(Effect.exit))).toBe(true)
      // The failed artifact is observable: it is still present after remove — a
      // real deletion, or ENOENT-as-success, would have removed the path.
      expect(yield* Effect.promise(() => fs.stat(target).then(() => true).catch(() => false))).toBe(true)
    }),
  )
})
