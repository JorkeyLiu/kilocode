import fs from "fs/promises"
import path from "path"
import os from "os"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../database/database"
import { collectBaseline } from "./baseline"
import type { BaselineReport } from "./baseline"
import { Global } from "../global"

export type FixtureFamily = {
  rootID: string
  sessionIDs: string[]
  activity: number
}

export type S0Fixture = {
  dir: string
  dbPath: string
  storageDir: string
  retained: FixtureFamily
  active: FixtureFamily & { release: () => void; isActive: boolean }
  leased: FixtureFamily & { release: () => void; isLeased: boolean }
  isActive: (id: string) => boolean
  isLeased: (id: string) => boolean
  baseline: () => Promise<BaselineReport>
  cleanup: () => Promise<void>
}

async function writeArtifact(storageDir: string, kind: string, sessionID: string, content: unknown) {
  const dir = path.join(storageDir, kind)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sessionID}.json`), JSON.stringify(content, null, 2), "utf8")
}

export async function createS0Fixture(opts?: { dir?: string }): Promise<S0Fixture> {
  const dir = opts?.dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "kilo-s0-")))
  const realDir = await fs.realpath(dir)
  const dbPath = path.join(realDir, "kilo.db")
  const storageDir = path.join(realDir, "storage")
  const prod = path.resolve(Global.Path.data)
  if (path.resolve(realDir) === prod) throw new Error("S0 fixture must not use production data dir")
  const layer = Database.layerFromPath(dbPath)
  const now = Date.now()
  const old = now - 8 * 24 * 60 * 60 * 1000
  const retainedRoot = "ses_retained_root"
  const retainedChild = "ses_retained_child"
  const activeRoot = "ses_active_root"
  const leasedRoot = "ses_leased_root"
  const msgData = JSON.stringify({
    role: "user",
    time: { created: old },
    agent: "build",
    model: { providerID: "test", modelID: "test" },
  })
  const partData = JSON.stringify({ type: "text", text: "hello" })
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .run(
          sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('proj_global', '/tmp', '[]', 1, 1)`,
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, revision) VALUES (${retainedRoot}, 'proj_global', 'retained', '/tmp', 'Retained', 'v1', ${old}, ${old}, 0)`,
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          sql`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, revision) VALUES (${retainedChild}, 'proj_global', ${retainedRoot}, 'retained-child', '/tmp', 'Retained Child', 'v1', ${old}, ${old}, 0)`,
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, revision) VALUES (${activeRoot}, 'proj_global', 'active', '/tmp', 'Active', 'v1', ${old}, ${old}, 0)`,
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, revision) VALUES (${leasedRoot}, 'proj_global', 'leased', '/tmp', 'Leased', 'v1', ${old}, ${old}, 0)`,
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_retained', ${retainedRoot}, ${old}, ${old}, ${msgData})`,
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_retained', 'msg_retained', ${retainedRoot}, ${old}, ${old}, ${partData})`,
        )
        .pipe(Effect.orDie)
      yield* db
        .run(
          sql`INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (${retainedRoot}, 't1', 'pending', 'high', 0, ${old}, ${old})`,
        )
        .pipe(Effect.orDie)
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
  )
  await writeArtifact(storageDir, "session_diff", retainedRoot, [{ file: "a.ts", additions: 10, deletions: 1 }])
  await writeArtifact(storageDir, "session_diff", retainedChild, [{ file: "b.ts", additions: 5, deletions: 0 }])
  await writeArtifact(storageDir, "session_diff", activeRoot, [{ file: "c.ts", additions: 1, deletions: 0 }])
  await writeArtifact(storageDir, "session_diff", leasedRoot, [{ file: "d.ts", additions: 1, deletions: 0 }])
  await writeArtifact(storageDir, "session_diff_base", retainedRoot, [{ file: "a.ts", additions: 10, deletions: 1 }])
  await writeArtifact(storageDir, "session_share", retainedRoot, { url: "https://example.com/share" })
  const snapDir = path.join(realDir, "snapshot", "proj_global", "hash")
  await fs.mkdir(snapDir, { recursive: true })
  await fs.writeFile(path.join(snapDir, "snapshot.bin"), "snapshot content", "utf8")
  const activeSet = new Set<string>([activeRoot])
  const leasedSet = new Set<string>([leasedRoot])
  const isActive = (id: string) => activeSet.has(id)
  const isLeased = (id: string) => leasedSet.has(id)
  const retained: FixtureFamily = { rootID: retainedRoot, sessionIDs: [retainedRoot, retainedChild], activity: old }
  const active: FixtureFamily & { release: () => void; isActive: boolean } = {
    rootID: activeRoot,
    sessionIDs: [activeRoot],
    activity: old,
    isActive: true,
    release: () => {
      activeSet.delete(activeRoot)
      ;(active as any).isActive = false
    },
  }
  const leased: FixtureFamily & { release: () => void; isLeased: boolean } = {
    rootID: leasedRoot,
    sessionIDs: [leasedRoot],
    activity: old,
    isLeased: true,
    release: () => {
      leasedSet.delete(leasedRoot)
      ;(leased as any).isLeased = false
    },
  }
  const runBaseline = async () => {
    const nl = Database.layerNoLease(dbPath)
    return Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* collectBaseline(realDir, db)
      }).pipe(Effect.provide(nl), Effect.scoped, Effect.orDie),
    )
  }
  const cleanup = async () => {
    activeSet.clear()
    leasedSet.clear()
    try {
      await fs.rm(realDir, { recursive: true, force: true })
    } catch {}
  }
  return {
    dir: realDir,
    dbPath,
    storageDir,
    retained,
    active: active as any,
    leased: leased as any,
    isActive,
    isLeased,
    baseline: runBaseline,
    cleanup,
  }
}

export async function withS0Fixture<T>(fn: (fix: S0Fixture) => Promise<T>): Promise<T> {
  const fix = await createS0Fixture()
  try {
    return await fn(fix)
  } finally {
    await fix.cleanup()
  }
}
