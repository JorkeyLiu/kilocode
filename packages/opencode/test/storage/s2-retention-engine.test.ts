import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import * as Artifact from "@opencode-ai/core/retention/artifact"
import * as Retention from "@opencode-ai/core/retention/retention"
import * as Accounting from "@/retention/accounting"
import { Session as SessionNs } from "@/session/session"
import { Storage } from "@/storage/storage"
import { SessionStatus } from "@/session/status"
import * as LeaseModule from "@/retention/lease"
import * as Ownership from "@/retention/ownership"
import { testEffect } from "../lib/effect"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { sql } from "drizzle-orm"
import * as Maintenance from "@/retention/maintenance"

const baseLayer = Layer.mergeAll(
  Database.defaultLayer,
  SessionNs.defaultLayer,
  Storage.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionStatus.defaultLayer,
  LeaseModule.layer,
  Ownership.layer,
  Accounting.layer,
  testInstanceStoreLayer,
)
const it = testEffect(baseLayer)

describe("S2 retention engine opencode", () => {
  it.instance("accounting includes WAL", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const session = yield* SessionNs.Service
      const info = yield* session.create({ title: "acct-wal" })
      yield* storage.write(["session_diff", info.id], [{ file: "a.ts", additions: 100, deletions: 0 }])
      const { main, wal } = Accounting.dbPaths()
      const storageDir = `${Global.Path.data}/storage`
      const bytes = Accounting.physicalBytesWith(main, storageDir)
      const manual = Accounting.safeStat(main) + Accounting.safeStat(wal) + Accounting.artifactBytes(storageDir)
      expect(bytes).toBe(manual)
      expect(bytes).toBeGreaterThanOrEqual(Accounting.artifactBytes(storageDir))
      yield* session.remove(info.id)
    }),
  )

  it.instance("registry deletion excludes snapshot", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const storage = yield* Storage.Service
      const info = yield* session.create({ title: "snapshot-excl" })
      yield* storage.write(["session_diff", info.id], [{ file: "a.ts", additions: 1, deletions: 0 }])
      const snapDir = `${Global.Path.data}/snapshot`
      mkdirSync(snapDir, { recursive: true })
      const snapFile = join(snapDir, `test-snap-${info.id}`)
      writeFileSync(snapFile, "snap content")
      const keys = Artifact.familyArtifactsForFamily([info.id])
      expect(keys.some((k) => k[0] === "snapshot")).toBe(false)
      expect(keys.some((k) => k[0] === "session_diff")).toBe(true)
      yield* Effect.forEach(keys, (k) => storage.remove(k).pipe(Effect.catch(() => Effect.void)), { discard: true })
      expect(existsSync(snapFile)).toBe(true)
      rmSync(snapFile, { force: true })
      yield* session.remove(info.id)
    }),
  )

  it.instance("unregistered write fails closed", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const exit = yield* storage.write(["unregistered_kind", "ses_test"], { foo: "bar" }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("diagnostics structure after below-high run", () =>
    Effect.gen(function* () {
      const lowAccounting = Layer.succeed(
        Accounting.Service,
        Accounting.Service.of({
          physicalBytes: () => Effect.succeed(1024),
          physicalBytesWith: (_a: string, _b: string) => Effect.succeed(1024),
        }),
      )
      const dbLayer = Database.layerFromPath(":memory:")
      const base = Layer.mergeAll(
        dbLayer,
        Storage.defaultLayer,
        Ownership.layer,
        LeaseModule.layer,
        lowAccounting,
        SessionStatus.defaultLayer,
        CrossSpawnSpawner.defaultLayer,
        testInstanceStoreLayer,
      )
      const withMaintenance = Layer.mergeAll(base, Maintenance.layer.pipe(Layer.provide(base)))
      const diag = yield* Effect.gen(function* () {
        const svc = yield* Maintenance.Service
        return yield* svc.runOnce("test-below-high")
      }).pipe(Effect.provide(withMaintenance), Effect.scoped)
      expect(diag.trigger).toBe("test-below-high")
      expect(typeof diag.beforeBytes).toBe("number")
      expect(typeof diag.afterBytes).toBe("number")
      expect(diag.beforeBytes).toBe(1024)
      expect(diag.afterBytes).toBe(1024)
      expect(typeof diag.selected).toBe("number")
      expect(typeof diag.deleted).toBe("number")
      expect(diag.deleted).toBe(0)
      expect(diag.checkpoint).toBe("skipped-below-high")
      expect(diag.vacuum).toBe("skipped-below-high")
      expect(Array.isArray(diag.failures)).toBe(true)
      expect(diag.failures.length).toBe(0)
      expect(diag.skipReasons).toBeDefined()
      expect(diag.rowsReclaimed).toBe(0)
      expect(diag.artifactBytesReclaimed).toBe(0)
    }),
  )

  it.instance("reclamation checkpoint and vacuum after pruning attempt", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const cp = yield* db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`).pipe(Effect.exit)
      expect(cp._tag).toBe("Success")
      const vac = yield* db.run(sql`PRAGMA incremental_vacuum(10)`).pipe(Effect.exit)
      expect(vac._tag).toBe("Success")
    }),
  )

  it.instance("lease protection via isLeased", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const lease = yield* LeaseModule.Service
      const { db } = yield* Database.Service
      const info = yield* session.create({ title: "lease-prot" })
      const release = yield* lease.acquire(info.id)
      expect(lease.isLeased(info.id)).toBe(true)
      const now = Date.now()
      yield* db.update(SessionTable).set({ time_updated: 0 }).where(eq(SessionTable.id, info.id)).run().pipe(Effect.orDie)
      const { eligible } = yield* Retention.eligibleFamilies(db, now, () => false, (id) => lease.isLeased(id))
      expect(eligible.find((f) => f.rootID === info.id)).toBeUndefined()
      yield* release
      expect(lease.isLeased(info.id)).toBe(false)
      yield* session.remove(info.id)
    }),
  )
})
